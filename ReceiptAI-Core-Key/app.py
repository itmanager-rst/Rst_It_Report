import os
import io
import json
import logging
import pandas as pd
import time
import requests
from datetime import datetime
from fastapi import FastAPI, Request, BackgroundTasks, HTTPException
from dotenv import load_dotenv
from PIL import Image
import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

# --- Import LINE Bot SDK v3 ---
from linebot.v3.webhook import WebhookHandler
from linebot.v3.webhooks import MessageEvent, ImageMessageContent, TextMessageContent
from linebot.v3.messaging import (
    Configuration,
    ApiClient,
    MessagingApi,
    MessagingApiBlob,
    ReplyMessageRequest,
    TextMessage
)

# --- Import Google GenAI SDK ---
from google import genai
from google.genai import types

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load this project's .env as the source of truth.  ``override=True`` is
# important on Windows because a stale key in the parent PowerShell process
# would otherwise win over the production key stored in this file.
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
load_dotenv(dotenv_path=ENV_FILE, override=True)

LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# --- ECOUNT ERP Configurations ---
ECOUNT_COM_CODE = os.getenv("ECOUNT_COM_CODE", "915297")
ECOUNT_USER_ID = os.getenv("ECOUNT_USER_ID", "ITRST01")
ECOUNT_API_KEY = os.getenv("ECOUNT_API_KEY", "")
ECOUNT_ZONE = os.getenv("ECOUNT_ZONE", "IA")
ECOUNT_LAN_TYPE = os.getenv("ECOUNT_LAN_TYPE", "th-TH")
ECOUNT_API_DOMAIN = os.getenv("ECOUNT_API_DOMAIN", "oapi").strip().lower() or "oapi"
ECOUNT_TAX_GUBUN = os.getenv("ECOUNT_TAX_GUBUN", "").strip()
ECOUNT_USE_RECEIPT_DATE = os.getenv("ECOUNT_USE_RECEIPT_DATE", "false").strip().lower() in {
    "1", "true", "yes", "on"
}
ECOUNT_DIRECT_SAVE_ENABLED = os.getenv(
    "ECOUNT_DIRECT_SAVE_ENABLED", "false"
).strip().lower() in {"1", "true", "yes", "on"}

# --- Configuration IDs ---
GOOGLE_SHEET_ID = os.getenv(
    "GOOGLE_SHEET_ID", "1A9xYtD4h-AEhMC_DI371BrVO7nXe50fKgFA0P3UgdYc"
).strip()
GOOGLE_DRIVE_FOLDER_ID = os.getenv(
    "GOOGLE_DRIVE_FOLDER_ID", "1fHXxUAdT31VUYvyPFd714TfKI2JhJsuT"
).strip()
ECOUNT_FINANCE = os.getenv("ECOUNT_FINANCE", "")
ECOUNT_WITHDRAW_ACCOUNT = os.getenv("ECOUNT_WITHDRAW_ACCOUNT", "1019")
ECOUNT_EXPENSE_ACCOUNT = os.getenv("ECOUNT_EXPENSE_ACCOUNT", "8490")
ECOUNT_CUSTOMER_CODE = os.getenv("ECOUNT_CUSTOMER_CODE", "00001") or "00001"
ECOUNT_PROJECT = os.getenv("ECOUNT_PROJECT", "")
ECOUNT_DEPARTMENT = os.getenv("ECOUNT_DEPARTMENT", "00006") or "00006"

# Reuse the ECOUNT login session so receipts submitted close together do not
# repeatedly hit the production login endpoint.
ECOUNT_SESSION_ID = ""
ECOUNT_SESSION_CREATED_AT = 0.0
ECOUNT_SESSION_CACHE_SECONDS = 600

ECOUNT_HEADERS = [
    "วันที่", "ลำดับ", "เลขที่ใบสำคัญบัญชี", "การเงิน", "รหัสบัญชีเงินถอน",
    "รหัสบัญชี", "รหัสลูกค้า/ผู้ขาย", "ชื่อลูกค้า/ผู้ขาย", "จำนวนเงิน",
    "หัก ณ ที่จ่าย", "ค่าธรรมเนียม", "หมายเหตุ", "โครงการ", "แผนก"
]

# Initialize FastAPI
app = FastAPI()

# Initialize LINE API
configuration = Configuration(access_token=LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

# Initialize Gemini Client
gemini_client = genai.Client(api_key=GEMINI_API_KEY)

# Scope สำหรับควบคุม Spreadsheets และ Drive File
SCOPE = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file"
]

def get_google_credentials():
    return Credentials.from_service_account_file("credentials.json", scopes=SCOPE)

def get_google_sheet():
    creds = get_google_credentials()
    client = gspread.authorize(creds)
    sheet = client.open_by_key(GOOGLE_SHEET_ID).worksheet("Receipt")
    return sheet


def normalize_ecount_code(value, default: str = "", width: int = 5) -> str:
    code = str(value or default).strip()
    return code.zfill(width) if code.isdigit() else code


def format_ecount_date(value) -> str:
    raw_value = str(value or "").strip()
    parsed_date = None

    for date_format in ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%d-%m-%Y", "%Y%m%d"):
        try:
            parsed_date = datetime.strptime(raw_value, date_format)
            break
        except ValueError:
            continue

    if parsed_date is None:
        logger.warning("Invalid or missing receipt date %r; using today's date", raw_value)
        parsed_date = datetime.now()

    # Thai receipts sometimes contain a Buddhist Era year.
    if parsed_date.year >= 2400:
        parsed_date = parsed_date.replace(year=parsed_date.year - 543)

    return parsed_date.strftime("%Y%m%d")


def parse_amount(value, default: float = 0.0) -> float:
    try:
        return max(float(str(value).replace(",", "").strip()), 0.0)
    except (TypeError, ValueError):
        return default


def generate_customer_code(vendor_name: str, tax_id: str) -> str:
    if ECOUNT_CUSTOMER_CODE:
        code = ECOUNT_CUSTOMER_CODE
    elif tax_id and tax_id != "-":
        code = tax_id[:5]
    elif vendor_name and vendor_name != "-":
        words = vendor_name.split()
        code = "".join([w[0].upper() for w in words if w])[:5]
    else:
        code = "OTHER"
    
    return normalize_ecount_code(code[:5])


def validate_ecount_config() -> dict:
    config = {
        "finance": ECOUNT_FINANCE,
        "withdraw_account": ECOUNT_WITHDRAW_ACCOUNT,
        "expense_account": ECOUNT_EXPENSE_ACCOUNT,
        "project": ECOUNT_PROJECT,
        "department": ECOUNT_DEPARTMENT
    }
    return config


def build_ecount_row(extracted_data: dict, sequence: int, drive_link: str = "") -> list:
    ecount_config = validate_ecount_config()
    # The Payment Voucher upload template leaves this blank so ECOUNT assigns
    # the current accounting date.
    ecount_date = ""
    
    try:
        amount = float(extracted_data.get("total", 0))
        if amount < 0:
            amount = 0
    except (TypeError, ValueError):
        amount = 0.0
    
    vendor_name = extracted_data.get("vendor_name", "-")
    tax_id = extracted_data.get("tax_id", "-")
    # Keep ECOUNT identifiers as strings so leading zeroes survive Google
    # Sheets and Web Upload (for example 00001 and 00006).
    customer_code = normalize_ecount_code(
        generate_customer_code(vendor_name, tax_id), width=5
    )
    department_code = normalize_ecount_code(
        ecount_config["department"], width=5
    )
    
    receipt_no = extracted_data.get("receipt_no", "")
    category = extracted_data.get("category", "")
    items = extracted_data.get("items", "")
    
    remark_parts = []
    if items and items != "-":
        remark_parts.append(items)
    elif vendor_name and vendor_name != "-":
        remark_parts.append(vendor_name)
    
    if category and category != "-":
        remark_parts.append(f"({category})")
    
    if receipt_no and receipt_no != "-":
        remark_parts.append(f"[{receipt_no}]")

    if drive_link and drive_link != "-":
        remark_parts.append(f"Drive: {drive_link}")
    
    remark = " ".join(remark_parts) if remark_parts else f"{vendor_name} - "
    
    return [
        ecount_date,                          
        sequence,                             
        receipt_no,                           
        ecount_config["finance"],             
        ecount_config["withdraw_account"],    
        ecount_config["expense_account"],     
        customer_code,                        
        vendor_name,                          
        amount,                               
        0,                                    
        0,                                    
        remark,                               
        ecount_config["project"],             
        department_code,
    ]


def post_to_ecount_erp(extracted_data: dict, sequence: int) -> dict:
    global ECOUNT_SESSION_ID, ECOUNT_SESSION_CREATED_AT

    try:
        missing_login_config = [
            name
            for name, value in {
                "ECOUNT_COM_CODE": ECOUNT_COM_CODE,
                "ECOUNT_USER_ID": ECOUNT_USER_ID,
                "ECOUNT_API_KEY": ECOUNT_API_KEY,
                "ECOUNT_ZONE": ECOUNT_ZONE,
            }.items()
            if not str(value or "").strip()
        ]
        if missing_login_config:
            return {
                "success": False,
                "message": "ECOUNT config ไม่ครบ: " + ", ".join(missing_login_config),
            }

        session_id = ECOUNT_SESSION_ID
        session_age = time.time() - ECOUNT_SESSION_CREATED_AT

        if not session_id or session_age >= ECOUNT_SESSION_CACHE_SECONDS:
            login_url = f"https://{ECOUNT_API_DOMAIN}{ECOUNT_ZONE.lower()}.ecount.com/OAPI/V2/OAPILogin"
            login_payload = {
                "API_CERT_KEY": ECOUNT_API_KEY.strip(),
                "COM_CODE": ECOUNT_COM_CODE,
                "LAN_TYPE": ECOUNT_LAN_TYPE,
                "USER_ID": ECOUNT_USER_ID,
                "ZONE": ECOUNT_ZONE.upper()
            }

            login_res = requests.post(login_url, json=login_payload, timeout=15)
            login_res.raise_for_status()
            login_json = login_res.json()
            login_data = login_json.get("Data") or {}
            session_id = (login_data.get("Datas") or {}).get("SESSION_ID")

            if not session_id:
                logger.error(f"❌ ECOUNT Login Failed: {login_res.text}")
                error_code = login_data.get("Code") or "unknown"
                if str(error_code) == "204" and ECOUNT_API_DOMAIN == "oapi":
                    return {
                        "success": False,
                        "message": (
                            "ECOUNT ปฏิเสธคีย์: ค่านี้เป็น Test Key แต่ระบบตั้งเป็น "
                            "Production (oapi); กรุณาออก Production API Key"
                        ),
                    }
                return {
                    "success": False,
                    "message": f"Login ECOUNT ไม่สำเร็จ (Code {error_code})",
                }

            ECOUNT_SESSION_ID = session_id
            ECOUNT_SESSION_CREATED_AT = time.time()

        ecount_config = validate_ecount_config()
        vendor_name = extracted_data.get("vendor_name", "-")
        tax_id = extracted_data.get("tax_id", "-")
        customer_code = generate_customer_code(vendor_name, tax_id)
        
        total_amount = parse_amount(extracted_data.get("total"))
        trx_date = format_ecount_date(extracted_data.get("date"))
        receipt_no = extracted_data.get("receipt_no", "")
        remark = extracted_data.get("items") or vendor_name

        invoice_url = f"https://{ECOUNT_API_DOMAIN}{ECOUNT_ZONE.lower()}.ecount.com/OAPI/V2/InvoiceAuto/SaveInvoiceAuto?SESSION_ID={session_id}"
        
        invoice_payload = {
            "InvoiceAutoList": [{
                "BulkDatas": {
                    # This ECOUNT company currently rejects an explicit API date.
                    # Blank lets ECOUNT use its current document date.
                    "TRX_DATE": trx_date if ECOUNT_USE_RECEIPT_DATE else "",
                    "ACCT_DOC_NO": receipt_no,                          
                    "TAX_GUBUN": ECOUNT_TAX_GUBUN,
                    "S_NO": "",
                    "CUST": customer_code,                              
                    "CUST_DES": vendor_name,                            
                    # Payment Vouchers in this company are saved without a
                    # tax type; the full receipt total is the voucher amount.
                    "SUPPLY_AMT": f"{total_amount:.2f}",
                    "VAT_AMT": "0",
                    "ACCT_NO": ecount_config["withdraw_account"],       
                    "CR_CODE": "",
                    "DR_CODE": ecount_config["expense_account"],        
                    "REMARKS": remark,                                  
                    "SITE_CD": normalize_ecount_code(ecount_config["department"]) 
                }
            }]
        }

        inv_res = requests.post(invoice_url, json=invoice_payload, timeout=15)
        inv_res.raise_for_status()
        res_json = inv_res.json()
        
        success_cnt = res_json.get("Data", {}).get("SuccessCnt", 0)
        slip_nos = res_json.get("Data", {}).get("SlipNos", [])
        
        if success_cnt > 0:
            slip_no_str = ", ".join(slip_nos) if slip_nos else "สำเร็จ"
            logger.info(f"✅ ECOUNT Saved Successfully: SlipNo {slip_no_str}")
            return {"success": True, "slip_no": slip_no_str}
        else:
            details = res_json.get("Data", {}).get("ResultDetails", [])
            err_msg = details[0].get("TotalError") if details else "Unknown Error"
            logger.error(f"❌ ECOUNT Save Failed: {err_msg}")
            return {"success": False, "message": err_msg}

    except Exception as e:
        logger.error(f"❌ Exception in post_to_ecount_erp: {e}")
        return {"success": False, "message": str(e)}


def upload_image_to_drive(image_bytes: bytes, filename: str) -> str:
    try:
        creds = get_google_credentials()
        drive_service = build('drive', 'v3', credentials=creds)
        file_metadata = {'name': filename, 'parents': [GOOGLE_DRIVE_FOLDER_ID]}
        media = MediaIoBaseUpload(io.BytesIO(image_bytes), mimetype='image/jpeg')
        file = drive_service.files().create(body=file_metadata, media_body=media, fields='id, webViewLink', supportsAllDrives=True).execute()
        drive_service.permissions().create(fileId=file.get('id'), body={'type': 'anyone', 'role': 'reader'}, supportsAllDrives=True).execute()
        return file.get('webViewLink', '-')
    except Exception as e:
        logger.error(f"Error uploading to Drive: {e}")
        return "-"


def generate_tax_report_summary() -> str:
    try:
        sheet = get_google_sheet()
        records = sheet.get_all_records()
        if not records:
            return "📊 ยังไม่มีรายการบันทึกใบกำกับภาษีในระบบครับ"
            
        total_sum = 0.0
        total_items = len(records)
        for row in records:
            try:
                total_sum += float(str(row.get("จำนวนเงิน", 0)).replace(",", ""))
            except ValueError:
                continue

        return (
            "📑 **สรุปรายงานภาษีซื้อ (สำหรับยื่น ภ.พ.30)**\n"
            f"--------------------------------\n"
            f"จำนวนเอกสารทั้งหมด: {total_items} ใบ\n"
            f"💰 ยอดรวมสุทธิทั้งสิ้น: {total_sum:,.2f} บาท\n"
            f"--------------------------------\n"
            f"💡 สามารถดูรูปภาพใบกำกับภาษีฉบับจริงได้จากลิงก์ใน Google Sheet ครับ"
        )
    except Exception as e:
        return f"เกิดข้อผิดพลาดในการดึงรายงานภาษี: {str(e)}"


def extract_receipt_data(image_bytes: bytes) -> dict:
    image = Image.open(io.BytesIO(image_bytes))
    prompt = """
    คุณคือผู้เชี่ยวชาญด้านการบัญชีและภาษีอากร โปรดสกัดข้อมูลจากรูปภาพใบเสร็จ/ใบกำกับภาษีนี้ (ภาษาไทย):
    - date: วันที่ตามใบเสร็จ ฟอร์แมต YYYY-MM-DD
    - vendor_name: ชื่อร้านค้า/ผู้ขาย/สถานประกอบการ
    - tax_id: เลขประจำตัวผู้เสียภาษี 13 หลัก (ถ้ามี หากไม่มีให้ระบุ "-")
    - receipt_no: เลขที่ใบเสร็จ/เลขที่ใบกำกับภาษี (ถ้ามี)
    - items: รายการสินค้า/บริการที่ซื้อ สรุปให้อยู่ในบรรทัดเดียว
    - subtotal: ยอดเงินก่อน VAT 7% (ตัวเลข float)
    - vat: ภาษีมูลค่าเพิ่ม 7% (ตัวเลข float)
    - total: ยอดรวมสุทธิ (ตัวเลข float)
    - category: หมวดหมู่รายจ่าย

    ตอบกลับเฉพาะ JSON structure นี้เท่านั้น:
    {
        "date": "YYYY-MM-DD",
        "vendor_name": "...",
        "tax_id": "...",
        "receipt_no": "...",
        "items": "...",
        "subtotal": 0.0,
        "vat": 0.0,
        "total": 0.0,
        "category": "..."
    }
    """
    response = gemini_client.models.generate_content(
        model='gemini-3.6-flash',
        contents=[image, prompt],
        config=types.GenerateContentConfig(response_mime_type="application/json")
    )
    return json.loads(response.text.strip())


def process_image_event(event: MessageEvent):
    reply_token = event.reply_token
    message_id = event.message.id
    
    with ApiClient(configuration) as api_client:
        line_bot_blob_api = MessagingApiBlob(api_client)
        line_bot_api = MessagingApi(api_client)
        
        try:
            image_bytes = line_bot_blob_api.get_message_content(message_id=message_id)
            
            # 1. Drive
            drive_filename = f"receipt_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg"
            drive_link = upload_image_to_drive(image_bytes, drive_filename)
            
            # 2. Gemini
            extracted_data = extract_receipt_data(image_bytes)
            
            # 3. Google Sheet
            sheet = get_google_sheet()
            existing_headers = sheet.row_values(1)
            if existing_headers[:len(ECOUNT_HEADERS)] != ECOUNT_HEADERS:
                sheet.update("A1:N1", [ECOUNT_HEADERS])

            existing_rows = sheet.get_all_values()[1:]
            sequence_values = []
            for existing_row in existing_rows:
                if len(existing_row) > 1 and str(existing_row[1]).strip().isdigit():
                    sequence_values.append(int(existing_row[1]))
            next_sequence = max(sequence_values, default=0) + 1
            
            row = build_ecount_row(extracted_data, next_sequence, drive_link)
            next_row = len(existing_rows) + 2
            sheet.format(f"G{next_row}", {"numberFormat": {"type": "TEXT"}})
            sheet.format(f"N{next_row}", {"numberFormat": {"type": "TEXT"}})
            sheet.append_row(row, value_input_option="RAW")
            logger.info(f"✅ Saved row {next_sequence} to Google Sheet")
            
            if ECOUNT_DIRECT_SAVE_ENABLED:
                ecount_result = post_to_ecount_erp(extracted_data, next_sequence)

                if ecount_result.get("success"):
                    ecount_status_str = (
                        "✅ บันทึก ECOUNT สมุดบัญชีรายวันแล้ว "
                        f"(เลขที่สลิป: {ecount_result.get('slip_no')})"
                    )
                else:
                    ecount_status_str = (
                        "⚠️ บันทึก Google Sheet แล้ว แต่ ECOUNT ไม่สำเร็จ: "
                        f"{ecount_result.get('message')}"
                    )
            else:
                ecount_status_str = (
                    "✅ บันทึก Google Sheet รูปแบบใบสำคัญจ่ายแล้ว "
                    "พร้อมนำเข้าที่ ECOUNT → เว็บอัปโหลด → ใบสำคัญทั่วไป"
                )

            reply_text = (
                f"🟢 **บันทึกรายการที่ {next_sequence} เรียบร้อยครับ!**\n\n"
                f"ร้านค้า: {extracted_data.get('vendor_name')}\n"
                f"📦 สินค้า: {extracted_data.get('items', '-')}\n"
                f"รหัสลูกค้า: {row[6]} (สำหรับ ECOUNT)\n"
                f"ยอดรวมสุทธิ: {extracted_data.get('total'):,.2f} บาท\n\n"
                f"{ecount_status_str}"
            )
            
        except Exception as e:
            logger.error(f"❌ Error processing image: {e}", exc_info=True)
            reply_text = f"❌ เกิดข้อผิดพลาด: {str(e)[:100]}"
            
        line_bot_api.reply_message(
            ReplyMessageRequest(
                reply_token=reply_token,
                messages=[TextMessage(text=reply_text)]
            )
        )


def process_text_event(event: MessageEvent):
    reply_token = event.reply_token
    user_text = event.message.text.strip().lower()
    
    if any(keyword in user_text for keyword in ["ภาษี", "ภาษีซื้อ", "สรุป"]):
        reply_text = generate_tax_report_summary()
    else:
        reply_text = (
            "💡 **ส่งรูปใบเสร็จเพื่อบันทึก Google Sheet และสมุดบัญชีรายวัน ECOUNT**"
        )

    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)
        line_bot_api.reply_message(ReplyMessageRequest(reply_token=reply_token, messages=[TextMessage(text=reply_text)]))


@app.post("/callback")
async def callback(request: Request, background_tasks: BackgroundTasks):
    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    
    try:
        events = handler.parser.parse(body.decode("utf-8"), signature)
        for event in events:
            if isinstance(event, MessageEvent):
                if isinstance(event.message, ImageMessageContent):
                    background_tasks.add_task(process_image_event, event)
                elif isinstance(event.message, TextMessageContent):
                    background_tasks.add_task(process_text_event, event)
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid signature")
        
    return "OK"


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
