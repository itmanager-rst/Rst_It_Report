import os
import json
import requests
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional
from dotenv import load_dotenv
from google.cloud import bigquery

load_dotenv()

app = FastAPI(title="ECOUNT PO Web Form System")

# Global Variables สำหรับเก็บ Cache Session ของ ECOUNT
ECOUNT_SESSION_ID = None
ECOUNT_HOST_URL = None

# --- อนุญาต CORS ให้รองรับ Live Server, Localhost, GitHub Pages และ Render ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ตั้งค่า Google Application Credentials (กรณีใช้งาน BigQuery)
if os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON"):
    from google.oauth2 import service_account
    info = json.loads(os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON"))
    credentials = service_account.Credentials.from_service_account_info(info)
    bq_client = bigquery.Client(credentials=credentials, project=info.get("project_id"))
else:
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "credentials.json")
    try:
        bq_client = bigquery.Client()
    except Exception as e:
        print(f"BigQuery Init Warning: {e}")
        bq_client = None

PROJECT_ID = "po-asia"
DATASET_ID = "po_asia"

CONFIG = {
    "COM_CODE": os.getenv("COM_CODE", "915297"),
    "USER_ID": os.getenv("USER_ID", "ITRST01"),
    "ECOUNT_API_KEY": os.getenv("ECOUNT_API_KEY", "5b3c2d9aa2f7d4fc4a5f4dd9ce78fd0b47").strip(),
    "LAN_TYPE": os.getenv("LAN_TYPE", "th-TH"),
    "ZONE": os.getenv("ZONE", "IA"),
    "ALLOW_ECOUNT_PO_LIST": str(os.getenv("ALLOW_ECOUNT_PO_LIST", "true")).strip().lower() in {"1", "true", "yes", "y"}
}

# 💡 ฟังก์ชันจัดการ Login และขอ Session ECOUNT
def get_ecount_session(force_refresh: bool = False):
    global ECOUNT_SESSION_ID, ECOUNT_HOST_URL

    if force_refresh:
        ECOUNT_SESSION_ID = None
        ECOUNT_HOST_URL = None

    if ECOUNT_SESSION_ID and ECOUNT_HOST_URL:
        return ECOUNT_SESSION_ID, ECOUNT_HOST_URL

    api_key = CONFIG["ECOUNT_API_KEY"]
    if not api_key:
        print("[ECOUNT DEBUG] ECOUNT_API_KEY is missing or empty!")
        return None, None

    login_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    login_payload = {
        "API_CERT_KEY": api_key,
        "COM_CODE": CONFIG["COM_CODE"],
        "LAN_TYPE": CONFIG["LAN_TYPE"],
        "USER_ID": CONFIG["USER_ID"],
        "ZONE": CONFIG["ZONE"].upper()
    }
    try:
        response = requests.post(login_url, json=login_payload, timeout=30)
        res = response.json()
        print(f"[ECOUNT LOGIN RESPONSE]: Status={res.get('Status')}, Errors={res.get('Errors')}")
        
        if str(res.get("Status")) == "200":
            datas = res.get("Data", {}).get("Datas", {})
            ECOUNT_SESSION_ID = datas.get("SESSION_ID")
            ECOUNT_HOST_URL = datas.get("HOST_URL")
            return ECOUNT_SESSION_ID, ECOUNT_HOST_URL
        else:
            ECOUNT_SESSION_ID = None
            ECOUNT_HOST_URL = None
            print(f"[ECOUNT LOGIN FAILED]: {res.get('Errors')}")
            return None, None
    except Exception as e:
        ECOUNT_SESSION_ID = None
        ECOUNT_HOST_URL = None
        print(f"[ECOUNT LOGIN EXCEPTION]: {e}")
        return None, None

# --- Pydantic Schemas ---

class ItemSchema(BaseModel):
    prod_cd: str = Field(..., min_length=1)
    prod_des: str = Field("")
    size_des: Optional[str] = Field("")       # ข้อมูลจำเพาะ
    qty: float = Field(1, gt=0)
    price: float = Field(0, ge=0)
    supply_amt: float = Field(0, ge=0)
    vat_amt: float = Field(0, ge=0)
    remarks: Optional[str] = Field("")        # หมายเหตุรายการ
    remark: Optional[str] = Field("-")        # รองรับ Backward Compatibility

class POSchema(BaseModel):
    doc_no: Optional[str] = Field("")          # หมายเลขการซื้อ
    po_no: Optional[str] = Field("")           # เลขที่ใบสั่งซื้อ
    pr_no: Optional[str] = Field("")           # เลขที่ใบขอซื้อ
    cust_cd: str = Field(...)                  # ลูกค้า/ผู้ขาย
    io_date: str                               # วันที่
    req_date: Optional[str] = Field("")        # วันที่ต้องการ/กำหนดส่ง
    wh_cd: str = Field("00005")                # สถานที่รับเข้า
    emp_cd: str = Field("00028")                # PIC / ผู้รับผิดชอบ
    pjt_cd: str = Field("00032")                # โครงการ
    io_type: Optional[str] = Field("")         # ประเภทธุรกรรม
    exchange_type: Optional[str] = Field("")  # สกุลเงิน
    ord_no: Optional[str] = Field("")          # ใบสั่งซื้อเดิม
    u_memo1: Optional[str] = Field("")         # วัตถุประสงค์
    u_txt02: Optional[str] = Field("-")        # ข้อความเพิ่มเติม 2
    items: List[ItemSchema]

def to_ecount_yyyymmdd(value: str, field_name: str) -> str:
    """แปลงวันที่ให้เป็นรูปแบบ ECOUNT ที่ต้องใช้: DD/MM/YYYY (พ.ศ.)"""
    if not value:
        return ""
    try:
        clean_val = str(value).split("T")[0].strip()

        if clean_val.count("/") == 2:
            parts = clean_val.split("/")
            if len(parts) == 3:
                if len(parts[2]) == 4 and parts[2].isdigit():
                    day, month, year = parts[0], parts[1], parts[2]
                    if int(year) >= 2400:
                        return f"{int(day):02d}/{int(month):02d}/{int(year)}"
                    return f"{int(day):02d}/{int(month):02d}/{int(year) + 543}"

        digits_only = clean_val.replace("-", "").replace("/", "")
        if len(digits_only) == 8 and digits_only.isdigit():
            try:
                parsed = datetime.strptime(clean_val, "%Y%m%d")
                return f"{parsed.day:02d}/{parsed.month:02d}/{parsed.year + 543}"
            except ValueError:
                pass

        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d"):
            try:
                parsed = datetime.strptime(clean_val, fmt)
                return f"{parsed.day:02d}/{parsed.month:02d}/{parsed.year + 543}"
            except ValueError:
                continue

        try:
            parsed = datetime.fromisoformat(clean_val)
            return f"{parsed.day:02d}/{parsed.month:02d}/{parsed.year + 543}"
        except ValueError:
            pass

        raise ValueError
    except Exception:
        raise HTTPException(
            status_code=422,
            detail=f"{field_name} ต้องเป็นวันที่รูปแบบ YYYY-MM-DD หรือ DD/MM/YYYY",
        )

# --- System Status Health Check API ---

@app.get("/api/health-check")
def health_check():
    bq_status = False
    if bq_client:
        try:
            bq_client.query("SELECT 1").result()
            bq_status = True
        except Exception as e:
            print(f"Health Check BigQuery Error: {e}")
            bq_status = False

    ecount_status = False
    try:
        session_id, host_url = get_ecount_session(force_refresh=True)
        if session_id and host_url:
            ecount_status = True
    except Exception as e:
        print(f"Health Check ECOUNT Error: {e}")
        ecount_status = False

    return {
        "bigquery": bq_status,
        "ecount": ecount_status
    }

# --- API ดึงรายการสั่งซื้อ ECOUNT (ปรับปรุงการขยาย Field Keys สำหรับ PR และ Ref No.) ---

@app.get("/api/get-po-list")
async def get_po_list(
    DATE_FROM: Optional[str] = Query(None),
    DATE_TO: Optional[str] = Query(None)
):
    if not CONFIG["ALLOW_ECOUNT_PO_LIST"]:
        return {
            "success": False,
            "message": "ระบบปิดการดึงข้อมูลจาก ECOUNT ตามการตั้งค่า",
            "disabled_by_config": True,
        }

    def fetch_from_ecount(session_id, host_url, from_date, to_date):
        url = f"https://{host_url}/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID={session_id}"
        payload = {
            "PROD_CD": "",
            "CUST_CD": "",
            "ListParam": {
                "PAGE_CURRENT": 1,
                "PAGE_SIZE": 200,
                "BASE_DATE_FROM": from_date,
                "BASE_DATE_TO": to_date,
            },
        }
        return requests.post(url, json=payload, timeout=30)

    try:
        today = datetime.now()
        from_date = (DATE_FROM or (today - timedelta(days=29)).strftime("%Y%m%d")).replace("-", "").replace("/", "")
        to_date = (DATE_TO or today.strftime("%Y%m%d")).replace("-", "").replace("/", "")

        # 1. ขอ Session ปัจจุบัน
        session_id, host_url = get_ecount_session()
        if not session_id or not host_url:
            return {"success": False, "message": "ไม่สามารถเข้าสู่ระบบ ECOUNT ได้"}

        # 2. ยิง Request ครั้งแรก
        res = fetch_from_ecount(session_id, host_url, from_date, to_date)

        # 3. ตรวจสอบว่าโดน 412 หรือ Response ไม่ใช่ JSON หรือไม่ หากใช่ ให้บังคับ Re-login ใหม่ทันที (Force Refresh)
        content_type = res.headers.get("Content-Type", "").lower()
        if res.status_code in [412, 401, 500] or "application/json" not in content_type:
            print("[ECOUNT] Session Expired หรือได้รับ Response ที่ไม่ใช่ JSON -> พยายาม Re-login ใหม่...")
            session_id, host_url = get_ecount_session(force_refresh=True)
            if session_id and host_url:
                res = fetch_from_ecount(session_id, host_url, from_date, to_date)

        # 4. แปลงผลลัพธ์เป็น JSON
        try:
            response_data = res.json()
        except Exception as json_err:
            print(f"[ECOUNT Error] ไม่สามารถแปลง JSON ได้ Raw Content: {res.text[:200]}")
            return {
                "success": False, 
                "message": f"ECOUNT Session หมดอายุ กรุณากดปุ่ม 'โหลดรายการใหม่' อีกครั้ง (HTTP Status: {res.status_code})"
            }

        if str(response_data.get("Status")) == "200":
            raw_data = response_data.get("Data", {})
            data_list = raw_data.get("Result") or raw_data.get("Datas") or raw_data.get("List") or []
            if isinstance(data_list, dict):
                data_list = [data_list]

            normalized = []
            for item in data_list:
                if not isinstance(item, dict):
                    continue

                def pick(*keys):
                    for key in keys:
                        if key in item and item[key] not in (None, "", "-"):
                            return item[key]
                    return ""

                # ดึงเลขที่ใบสั่งซื้อ และตรวจสอบไม่ให้หยิบตัวเลขลำดับสั้นๆ
                raw_po = pick("IO_NO", "SLIP_NO", "DOC_NO", "PO_NO", "ORD_NO", "PO_NUM")
                io_date_val = pick("IO_DATE", "ORD_DATE", "DATE", "BASE_DATE", "PROD_DATE")
                seq_val = pick("UPLOAD_SER_NO", "LINE_NO", "IO_SEQ", "SEQ")

                if not raw_po or (str(raw_po).isdigit() and len(str(raw_po)) <= 3):
                    po_number = pick("SLIP_NO", "DOC_NO") or (f"PO-{io_date_val}-{seq_val}" if io_date_val else "-")
                else:
                    po_number = str(raw_po)

                # 💡 ขยายตัวเลือก Keys ครอบคลุมฟิลด์ทั้งหมดของ ECOUNT ERP
                pr_number = pick(
                    "REL_NO", "PR_NO", "PUR_REQ_NO", "REQ_NO", "U_MEMO2", 
                    "ORDER_REQ_NO", "PURCHASE_REQ_NO", "ADD_TXT_01", "U_TXT01"
                )
                
                ref_number = pick(
                    "U_MEMO1", "REF_NO", "REFER_NO", "REFERENCE_NO", "REMARKS", 
                    "REMARK", "ADD_TXT_02", "U_TXT02", "MEMO"
                )

                row = {
                    "IO_NO": po_number,
                    "PO_NO": po_number,
                    "PR_NO": pr_number,
                    "REF_NO": ref_number,
                    "IO_DATE": io_date_val,
                    "PJT_DES": pick("PJT_DES", "PJT_NAME", "PROJECT_DES"),
                    "PJT_CD": pick("PJT_CD", "PROJECT_CD"),
                    "CUST_DES": pick("CUST_DES", "CUST_NAME", "CUSTOMER_NAME"),
                    "CUST": pick("CUST", "CUST_CD"),
                    "EMP_DES": pick("EMP_DES", "EMP_NAME", "PIC_NAME"),
                    "EMP_CD": pick("EMP_CD", "PIC_CD"),
                    "PROD_DES": pick("PROD_DES", "ITEM_DES", "PROD_NAME"),
                    "PROD_CD": pick("PROD_CD", "ITEM_CD"),
                    "SIZE_DES": pick("SIZE_DES", "SIZE", "SPEC"),
                    "DELIVERY_DATE": pick("TIME_DATE", "DELIVERY_DATE", "REQ_DATE", "DUE_DATE"),
                    "QTY": pick("QTY", "QUANTITY"),
                    "TOTAL_AMT": pick(
                        "TOTAL_AMT", "TOTAL_AMOUNT", "PO_AMT", "PO_AMOUNT", "BUY_AMT",
                        "BUY_AMT_F", "NET_AMT", "NET_AMOUNT", "SUPPLY_AMT", "SUPPLY_AMOUNT",
                        "TOTAL_PRICE", "TOTAL_PRICE_VAT", "TOTAL_AMT_VAT", "AMT", "AMOUNT",
                        "SUM_AMT", "SUM_AMOUNT", "OUT_AMT", "PROD_AMT", "EXCH_BUY_AMT", "AMT_F"
                    ),
                    "VAT_AMT": pick("VAT_AMT", "VAT_AMOUNT", "TAX_AMT", "TAX_AMOUNT"),
                    "CONFIRM_TYPE": pick("CONFIRM_TYPE", "STATUS", "APPROVAL_STATUS"),
                    "SEQ": seq_val
                }
                normalized.append(row)

            return {"success": True, "data": normalized}
        elif str(response_data.get("Status")) == "412":
            get_ecount_session(force_refresh=True)
            return {"success": False, "message": "ECOUNT Session หมดอายุ ระบบได้ทำการเคลียร์ Session แล้ว กรุณากด 'โหลดรายการใหม่'"}
        else:
            return {"success": False, "message": f"ECOUNT Error: {response_data.get('Errors', 'ไม่ทราบสาเหตุ')}"}

    except Exception as e:
        return {"success": False, "message": f"Server Error: {str(e)}"}

# --- Duplicate Check API ---

@app.get("/api/check-po-duplicate")
@app.get("/api/check-pr-duplicate")
def check_po_duplicate(po_no: str = "", pr_no: str = ""):
    doc_no = po_no or pr_no
    if not doc_no:
        return {"success": False, "is_duplicate": False, "message": "ไม่ได้ระบุเลขที่เอกสาร"}

    if bq_client:
        try:
            query = f"""
                SELECT COUNT(1) as cnt 
                FROM `{PROJECT_ID}.{DATASET_ID}.po_header` 
                WHERE io_no = '{doc_no}' OR slip_no = '{doc_no}'
            """
            results = list(bq_client.query(query).result())
            if results and results[0].cnt > 0:
                return {"success": True, "is_duplicate": True, "message": "พบเลขที่เอกสารซ้ำในระบบ"}
        except Exception as e:
            print(f"Check Duplicate Error: {e}")

    return {"success": True, "is_duplicate": False, "message": "เลขที่เอกสารสามารถใช้ได้"}

# --- Master Data Search API ---

@app.get("/api/search/customer")
def search_customer():
    if bq_client:
        try:
            query = f"""
                SELECT 
                    CAST(code AS STRING) AS code, 
                    CAST(name AS STRING) AS name 
                FROM `{PROJECT_ID}.{DATASET_ID}.cust_cd`
                WHERE code IS NOT NULL
                ORDER BY code ASC
            """
            results = bq_client.query(query).result()
            customers = []
            for row in results:
                raw_code = getattr(row, 'code', None) or ''
                raw_name = getattr(row, 'name', None) or '-'
                if raw_code != '':
                    clean_code = str(raw_code).strip()
                    formatted_code = clean_code.zfill(5) if clean_code.isdigit() else clean_code
                    customers.append({
                        "code": formatted_code,
                        "name": str(raw_name).strip()
                    })
            if customers:
                return {"success": True, "data": customers}
        except Exception as e:
            print(f"BigQuery Customer Error: {e}")

    session_id, host_url = get_ecount_session()
    if session_id and host_url:
        try:
            url = f"https://{host_url}/OAPI/V2/Customer/GetBasicCustomerList?SESSION_ID={session_id}"
            payload = {"PARAM": {"CUST_CD": ""}}
            res = requests.post(url, json=payload, timeout=30).json()
            
            if res.get("Status") == "200" or res.get("Status") == 200:
                result_data = res.get("Data", {})
                items = result_data.get("Result") or result_data.get("Datas") or []
                
                customers = []
                for item in items:
                    cust_cd = item.get("BUSINESS_NO") or item.get("CUST_CD") or ""
                    cust_name = item.get("CUST_DES") or item.get("BUSINESS_NO_DES") or ""
                    if cust_cd:
                        clean_code = str(cust_cd).strip()
                        formatted_code = clean_code.zfill(5) if clean_code.isdigit() else clean_code
                        customers.append({
                            "code": formatted_code,
                            "name": str(cust_name).strip()
                        })
                if customers:
                    return {"success": True, "data": customers}
        except Exception as e:
            print(f"ECOUNT Customer API Error: {e}")

    return {"success": True, "data": [
        {"code": "00001", "name": "คุณวาสนา (ผจก.โรงงาน)"},
        {"code": "00010", "name": "คุณกชกร (จัดซื้อ)"}
    ]}

@app.get("/api/search/warehouse")
def search_warehouse():
    if bq_client:
        try:
            query = f"SELECT wh_cd, wh_des FROM `{PROJECT_ID}.{DATASET_ID}.wh_des`"
            results = bq_client.query(query).result()
            warehouses = []
            for row in results:
                raw_code = getattr(row, 'wh_cd', None) or getattr(row, 'WH_CD', None) or ''
                raw_name = getattr(row, 'wh_des', None) or getattr(row, 'WH_DES', None) or '-'
                if raw_code != '':
                    clean_code = str(raw_code).strip()
                    formatted_code = clean_code.zfill(5) if clean_code.isdigit() else clean_code
                    warehouses.append({
                        "code": formatted_code,
                        "name": str(raw_name).strip()
                    })
            if warehouses:
                return {"success": True, "data": warehouses}
        except Exception as e:
            print(f"BigQuery WH Error: {e}")
            
    return {"success": True, "data": [
        {"code": "00005", "name": "คลังสินค้าหลัก / สำนักงานใหญ่"},
        {"code": "00001", "name": "คลังวัตถุดิบ"}
    ]}

@app.get("/api/search/employee")
def search_employee():
    if bq_client:
        try:
            query = f"SELECT emp_cd, emp_name FROM `{PROJECT_ID}.{DATASET_ID}.pic`"
            results = bq_client.query(query).result()
            employees = []
            for row in results:
                raw_code = getattr(row, 'emp_cd', None) or getattr(row, 'EMP_CD', None) or ''
                raw_name = getattr(row, 'emp_name', None) or getattr(row, 'EMP_NAME', None) or '-'
                if raw_code != '':
                    clean_code = str(raw_code).strip()
                    formatted_code = clean_code.zfill(5) if clean_code.isdigit() else clean_code
                    employees.append({
                        "code": formatted_code,
                        "name": str(raw_name).strip()
                    })
            if employees:
                return {"success": True, "data": employees}
        except Exception as e:
            print(f"BigQuery Emp Error: {e}")

    return {"success": True, "data": [
        {"code": "00027", "name": "คุณผู้ขอซื้อ (PIC 00028)"},
        {"code": "00028", "name": "เจ้าหน้าที่ฝ่ายจัดซื้อ"}
    ]}

@app.get("/api/search/project")
def search_project():
    if bq_client:
        try:
            query = f"SELECT pjt_cd, pjt_des FROM `{PROJECT_ID}.{DATASET_ID}.pjt_des`"
            results = bq_client.query(query).result()
            projects = []
            for row in results:
                raw_code = getattr(row, 'pjt_cd', None) or getattr(row, 'PJT_CD', None) or ''
                raw_name = getattr(row, 'pjt_des', None) or getattr(row, 'PJT_DES', None) or '-'
                if raw_code != '':
                    clean_code = str(raw_code).strip()
                    formatted_code = clean_code.zfill(5) if clean_code.isdigit() else clean_code
                    projects.append({
                        "code": formatted_code,
                        "name": str(raw_name).strip()
                    })
            if projects:
                return {"success": True, "data": projects}
        except Exception as e:
            print(f"BigQuery Project Error: {e}")

    return {"success": True, "data": [
        {"code": "00032", "name": "โครงการ 00032 (Default Project)"}
    ]}

@app.get("/api/search/product")
def search_product():
    if bq_client:
        try:
            query = f"SELECT prod_cd, prod_des FROM `{PROJECT_ID}.{DATASET_ID}.prod`"
            results = bq_client.query(query).result()
            products = []
            for row in results:
                raw_code = getattr(row, 'prod_cd', None) or getattr(row, 'PROD_CD', None) or ''
                raw_name = getattr(row, 'prod_des', None) or getattr(row, 'PROD_DES', None) or '-'
                
                if raw_code != '' and raw_code != 'รหัสสินค้า':
                    products.append({
                        "code": str(raw_code).strip(),
                        "name": str(raw_name).strip()
                    })
            if products:
                return {"success": True, "data": products}
        except Exception as e:
            print(f"BigQuery Product Error: {e}")

    return {"success": True, "data": [
        {"code": "AS00654", "name": "ชุดซีลปากกระบอก"}
    ]}

@app.get("/", response_class=FileResponse)
def po_web_form():
    return FileResponse("index.html")

# --- Save Purchase Order API ---

@app.post("/api/save-po")
def save_po_api(data: POSchema):
    if not CONFIG["ECOUNT_API_KEY"]:
        raise HTTPException(
            status_code=503,
            detail="ยังไม่ได้ตั้งค่า ECOUNT_API_KEY ในไฟล์ .env",
        )

    session_id, host_url = get_ecount_session()
    if not session_id or not host_url:
        raise HTTPException(status_code=500, detail="ไม่สามารถติดต่อ Login ECOUNT ได้")

    io_date_str = to_ecount_yyyymmdd(data.io_date, "วันที่เอกสาร")

    po_list = []
    for item in data.items:
        item_remark = item.remarks or item.remark or ""
        target_po_no = data.po_no or data.doc_no or ""
        add_txt_02 = data.u_txt02 or "-"
        
        bulk_data = {
            "IO_DATE": io_date_str,
            "UPLOAD_SER_NO": "1",
            "ORD_NO": target_po_no,
            "DOC_NO": target_po_no,
            "CUST": data.cust_cd,
            "EMP_CD": data.emp_cd.zfill(5),
            "WH_CD": data.wh_cd.zfill(5),
            "PJT_CD": data.pjt_cd.zfill(5),
            "U_MEMO1": data.u_memo1 or "",
            "U_TXT02": add_txt_02,
            "ADD_TXT_02_T": add_txt_02,
            "PROD_CD": item.prod_cd,
            "PROD_DES": item.prod_des,
            "SIZE_DES": item.size_des or "",
            "QTY": str(item.qty),
            "PRICE": str(item.price),
            "SUPPLY_AMT": str(item.supply_amt),
            "VAT_AMT": str(item.vat_amt),
            "REMARKS": item_remark,
        }

        if data.pr_no:
            bulk_data["REL_NO"] = data.pr_no

        if data.io_type and data.io_type not in ["00", "VAT"]:
            bulk_data["IO_TYPE"] = data.io_type

        if data.req_date:
            req_date_str = to_ecount_yyyymmdd(data.req_date, "วันที่ส่งมอบ")
            if req_date_str:
                bulk_data["TIME_DATE"] = req_date_str
                bulk_data["ADD_DATE_01_T"] = req_date_str
                bulk_data["REQ_DATE"] = req_date_str

        po_list.append({"BulkDatas": bulk_data})

    def send_save_request(s_id, h_url):
        url = f"https://{h_url}/OAPI/V2/Purchases/SavePurchaseOrder?SESSION_ID={s_id}"
        return requests.post(url, json={"PurchaseOrderList": po_list}, timeout=30)

    try:
        res = send_save_request(session_id, host_url)

        if res.status_code in [412, 500, 401] or "json" not in res.headers.get("Content-Type", "").lower():
            session_id, host_url = get_ecount_session(force_refresh=True)
            if session_id and host_url:
                res = send_save_request(session_id, host_url)

        res_data = res.json().get("Data", {})
        
        if res_data and isinstance(res_data, dict) and res_data.get("SuccessCnt", 0) > 0:
            return {
                "success": True,
                "slip_nos": res_data.get("SlipNos"),
                "count": res_data.get("SuccessCnt")
            }
        else:
            return {
                "success": False,
                "details": res_data.get("ResultDetails", []) if res_data else res.text
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"เกิดข้อผิดพลาดในการเชื่อมต่อ ECOUNT: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)