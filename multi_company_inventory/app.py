import os
import asyncio
import re
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from google.cloud import bigquery
from dotenv import load_dotenv
import requests

# นำเข้าฟังก์ชันดึงข้อมูลจาก sync_worker เพื่อทำ Auto-sync สต็อกและใบสั่งซื้อ
try:
    from sync_worker import fetch_all_company_data, fetch_all_company_po, SYNC_INTERVAL_SECONDS
except ImportError:
    fetch_all_company_data = None
    fetch_all_company_po = None
    SYNC_INTERVAL_SECONDS = 1800

load_dotenv()

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "rst-ecount-sync-py").strip()
DATASET_ID = "multi_company_inventory"

COMPANIES = [
    {
        "id": "ASIA",
        "code": os.getenv("ASIA_COM_CODE", os.getenv("COM_CODE", "915297")).strip(),
        "user_id": os.getenv("ASIA_USER_ID", os.getenv("USER_ID", "ITRST01")).strip(),
        "api_key": os.getenv("ASIA_API_KEY", os.getenv("ECOUNT_API_KEY", "")).strip(),
        "zone": os.getenv("ASIA_ZONE", os.getenv("ZONE", "IA")).strip(),
    },
    {
        "id": "ROBOTICS",
        "code": os.getenv("ROBOTICS_COM_CODE", "").strip(),
        "user_id": os.getenv("ROBOTICS_USER_ID", "").strip(),
        "api_key": os.getenv("ROBOTICS_API_KEY", "").strip(),
        "zone": os.getenv("ROBOTICS_ZONE", "IA").strip(),
    },
    {
        "id": "RUAMSINTHAI",
        "code": os.getenv("RUAMSINTHAI_COM_CODE", "").strip(),
        "user_id": os.getenv("RUAMSINTHAI_USER_ID", "").strip(),
        "api_key": os.getenv("RUAMSINTHAI_API_KEY", "").strip(),
        "zone": os.getenv("RUAMSINTHAI_ZONE", "IA").strip(),
    },
]
ECOUNT_SESSIONS = {}

ECOUNT_API_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
}


def ecount_api_url(host_url, endpoint):
    return f"https://{host_url.rstrip('/')}/OAPI/V2/{endpoint.lstrip('/')}"


# --- ECOUNT Authentication (Read-Only Use) ---

def get_ecount_session(company, force_refresh: bool = False):
    company_id = company["id"]
    if force_refresh:
        ECOUNT_SESSIONS.pop(company_id, None)

    if company_id in ECOUNT_SESSIONS and not force_refresh:
        sess = ECOUNT_SESSIONS[company_id]
        return sess[0], sess[1]

    api_key = company.get("api_key")
    if not api_key:
        return None, None

    s = requests.Session()
    s.headers.update(ECOUNT_API_HEADERS)
    login_url = f"https://oapi{company['zone'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    login_payload = {
        "API_CERT_KEY": api_key,
        "COM_CODE": company["code"],
        "LAN_TYPE": "th-TH",
        "USER_ID": company["user_id"],
        "ZONE": company["zone"].upper()
    }
    try:
        response = s.post(login_url, json=login_payload, timeout=30)
        res = response.json()
        
        if str(res.get("Status")) == "200":
            datas = res.get("Data", {}).get("Datas", {})
            session_id = datas.get("SESSION_ID")
            host_url = datas.get("HOST_URL")
            if session_id and host_url:
                ECOUNT_SESSIONS[company_id] = (session_id, host_url, s)
                return session_id, host_url
        return None, None
    except Exception as e:
        print(f"[ECOUNT LOGIN EXCEPTION - {company_id}]: {e}")
        return None, None


def get_ecount_client(company_id):
    sess = ECOUNT_SESSIONS.get(company_id)
    if sess and len(sess) >= 3:
        return sess[2]
    return None


# --- Background Auto-Sync Task ---

async def start_auto_sync():
    await asyncio.sleep(5)
    while True:
        if fetch_all_company_data:
            try:
                print("\n⏰ Render Background Task: เริ่มกระบวนการ Auto Sync Stock...")
                await asyncio.to_thread(fetch_all_company_data)
                print("🎉 Auto Sync Stock สำเร็จ!")
            except Exception as exc:
                print(f"❌ Auto Sync Error: {exc}")
        else:
            print("⚠️ ไม่พบฟังก์ชัน fetch_all_company_data ใน sync_worker.py")
        
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    sync_task = asyncio.create_task(start_auto_sync())
    yield
    sync_task.cancel()


app = FastAPI(title="Multi-Company Enterprise Hub API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_bigquery_client():
    try:
        return bigquery.Client(project=PROJECT_ID)
    except Exception as exc:
        print(f"⚠️ BigQuery client init failed: {exc}")
        return None


client = get_bigquery_client()


# --- Main Web UI ---

@app.get("/", response_class=HTMLResponse)
def serve_dashboard():
    with open("index.html", "r", encoding="utf-8") as f:
        return f.read()


@app.get("/health")
@app.get("/api/health-check")
def health_check():
    company_status = {}
    for company in COMPANIES:
        session_id, host_url = get_ecount_session(company, force_refresh=True)
        company_status[company["id"]] = bool(session_id and host_url)

    return {
        "status": "ok",
        "project_id": PROJECT_ID,
        "bigquery_ready": client is not None,
        "ecount_ready": any(company_status.values()),
        "ecount_companies": company_status,
        "dataset": DATASET_ID,
    }


# --- MODULE 1: READ-ONLY INVENTORY API (BigQuery) ---

@app.get("/api/inventory")
def get_inventory(company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL")):
    if client is None:
        raise HTTPException(
            status_code=503,
            detail=f"BigQuery client unavailable. Check GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID='{PROJECT_ID}'.",
        )

    where_clause = ""
    if company_id != "ALL":
        where_clause = f"WHERE UPPER(TRIM(b.company_id)) = '{company_id.upper()}'"

    query = f"""
        SELECT 
            b.company_id,
            b.company_code,
            b.prod_cd,
            COALESCE(
                NULLIF(TRIM(CAST(m.prod_des AS STRING)), ''),
                NULLIF(TRIM(CAST(b.prod_cd AS STRING)), ''),
                '-'
            ) AS prod_des,
            COALESCE(NULLIF(TRIM(CAST(m.size_des AS STRING)), ''), '') AS size_des,
            COALESCE(
                NULLIF(TRIM(CAST(b.wh_cd AS STRING)), ''), 
                '-'
            ) AS wh_cd,
            COALESCE(
                NULLIF(TRIM(CAST(b.wh_cd AS STRING)), ''),
                '-'
            ) AS wh_des,
            b.bal_qty,
            b.updated_at
        FROM `{PROJECT_ID}.{DATASET_ID}.inventory_balance` b
        LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.master_products` m
            ON UPPER(TRIM(CAST(b.company_id AS STRING))) = UPPER(TRIM(CAST(m.company_id AS STRING)))
            AND LOWER(TRIM(CAST(b.prod_cd AS STRING))) = LOWER(TRIM(CAST(m.prod_cd AS STRING)))
        {where_clause}
        ORDER BY b.company_id, b.prod_cd
    """

    try:
        query_job = client.query(query)
        results = query_job.result()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"BigQuery query failed: {exc}") from exc

    data = []
    for row in results:
        data.append({
            "company_id": row.company_id,
            "company_code": row.company_code,
            "prod_cd": row.prod_cd,
            "prod_des": row.prod_des,
            "size_des": row.size_des,
            "wh_cd": row.wh_cd,
            "wh_des": row.wh_des,
            "bal_qty": float(row.bal_qty) if row.bal_qty is not None else 0.0,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None
        })

    return {"total": len(data), "items": data}


# --- MODULE 2: MASTER PRODUCTS API (BigQuery) ---

@app.get("/api/products")
def get_products(company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL")):
    """ดึงข้อมูลรายการสินค้าทั้งหมด (Master Products) จาก BigQuery"""
    if client is None:
        raise HTTPException(
            status_code=503,
            detail=f"BigQuery client unavailable. Check GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID='{PROJECT_ID}'.",
        )

    where_clause = ""
    if company_id != "ALL":
        where_clause = f"WHERE UPPER(TRIM(company_id)) = '{company_id.upper()}'"

    query = f"""
        SELECT 
            company_id,
            prod_cd,
            COALESCE(NULLIF(TRIM(CAST(prod_des AS STRING)), ''), '-') AS prod_des,
            COALESCE(NULLIF(TRIM(CAST(size_des AS STRING)), ''), '') AS size_des,
            updated_at
        FROM `{PROJECT_ID}.{DATASET_ID}.master_products`
        {where_clause}
        ORDER BY company_id, prod_cd
    """

    try:
        query_job = client.query(query)
        results = query_job.result()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"BigQuery query failed: {exc}") from exc

    data = []
    for row in results:
        data.append({
            "company_id": row.company_id,
            "prod_cd": row.prod_cd,
            "prod_des": row.prod_des,
            "size_des": row.size_des,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None
        })

    return {"success": True, "total": len(data), "items": data}


# --- MODULE 3: SAFETY STOCK ALERT API (BigQuery) ---

@app.get("/api/get-safety-stock")
@app.post("/api/get-safety-stock")
@app.get("/api/safety-stock")
@app.post("/api/safety-stock")
def get_safety_stock(
    company_id: Optional[str] = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL"),
    DATE: Optional[str] = Query(None)
):
    """ดึงข้อมูลรายการสินค้าที่มีจำนวนคงเหลือต่ำกว่าหรือเท่ากับขั้นต่ำ (Safety Stock)"""
    if client is None:
        raise HTTPException(
            status_code=503,
            detail=f"BigQuery client unavailable. Check GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID='{PROJECT_ID}'.",
        )

    where_conditions = ["b.bal_qty <= 0"]
    if company_id and company_id != "ALL":
        where_conditions.append(f"UPPER(TRIM(b.company_id)) = '{company_id.upper()}'")

    where_clause = f"WHERE {' AND '.join(where_conditions)}"

    query = f"""
        SELECT 
            b.company_id,
            b.company_code,
            b.prod_cd,
            COALESCE(
                NULLIF(TRIM(CAST(m.prod_des AS STRING)), ''),
                NULLIF(TRIM(CAST(b.prod_cd AS STRING)), ''),
                '-'
            ) AS prod_des,
            COALESCE(NULLIF(TRIM(CAST(m.size_des AS STRING)), ''), '') AS size_des,
            COALESCE(
                NULLIF(TRIM(CAST(b.wh_cd AS STRING)), ''), 
                '-'
            ) AS wh_cd,
            COALESCE(
                NULLIF(TRIM(CAST(b.wh_cd AS STRING)), ''),
                '-'
            ) AS wh_des,
            b.bal_qty,
            b.updated_at
        FROM `{PROJECT_ID}.{DATASET_ID}.inventory_balance` b
        LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.master_products` m
            ON UPPER(TRIM(CAST(b.company_id AS STRING))) = UPPER(TRIM(CAST(m.company_id AS STRING)))
            AND LOWER(TRIM(CAST(b.prod_cd AS STRING))) = LOWER(TRIM(CAST(m.prod_cd AS STRING)))
        {where_clause}
        ORDER BY b.company_id, b.bal_qty ASC, b.prod_cd
    """

    try:
        query_job = client.query(query)
        results = query_job.result()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"BigQuery query failed: {exc}") from exc

    data = []
    affected_companies = set()

    for row in results:
        bal_qty_val = float(row.bal_qty) if row.bal_qty is not None else 0.0
        
        if bal_qty_val < 0:
            status_text = "สินค้าติดลบ"
        elif bal_qty_val == 0:
            status_text = "สินค้าหมด"
        else:
            status_text = "สต็อกต่ำกว่าขั้นต่ำ"

        data.append({
            "company_id": row.company_id,
            "company_code": row.company_code,
            "prod_cd": row.prod_cd,
            "prod_des": row.prod_des,
            "size_des": row.size_des,
            "wh_cd": row.wh_cd,
            "wh_des": row.wh_des,
            "bal_qty": bal_qty_val,
            "status": status_text,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None
        })
        affected_companies.add(row.company_id)

    return {
        "success": True,
        "total": len(data),
        "data": data,
        "summary": {
            "total_items": len(data),
            "critical_negative": len([i for i in data if i["bal_qty"] < 0]),
            "affected_companies_count": len(affected_companies)
        }
    }


# --- MODULE 4: READ-ONLY PURCHASE ORDERS (PO) API (ECOUNT) ---

async def get_po_list_legacy(
    DATE_FROM: Optional[str] = Query(None),
    DATE_TO: Optional[str] = Query(None),
    company_id: Optional[str] = Query("ALL")
):
    """ดึงรายการใบสั่งซื้อ (PO) จาก ECOUNT แบบ Read-Only เท่านั้น"""
    
    def fetch_from_ecount(session_id, host_url, f_date, t_date, page_current):
        url = f"{ecount_api_url(host_url, 'Purchases/GetPurchasesOrderList')}?SESSION_ID={session_id}"
        payload = {
            "PROD_CD": "",
            "CUST_CD": "",
            "ListParam": {
                "PAGE_CURRENT": page_current,
                "PAGE_SIZE": 200,
                "BASE_DATE_FROM": f_date,
                "BASE_DATE_TO": t_date,
            },
        }
        return requests.post(
            url,
            json=payload,
            headers=ECOUNT_API_HEADERS,
            timeout=30,
        )

    try:
        today = datetime.now()
        f_date = (DATE_FROM or (today - timedelta(days=365)).strftime("%Y%m%d")).replace("-", "").replace("/", "")
        t_date = (DATE_TO or today.strftime("%Y%m%d")).replace("-", "").replace("/", "")

        session_id, host_url = get_ecount_session(COMPANIES[0])
        if not session_id or not host_url:
            return {"success": False, "message": "ไม่สามารถเข้าสู่ระบบ ECOUNT ได้", "data": []}

        res = fetch_from_ecount(session_id, host_url, f_date, t_date, 1)

        content_type = res.headers.get("Content-Type", "").lower()
        if res.status_code in [412, 401, 500] or "application/json" not in content_type:
            session_id, host_url = get_ecount_session(COMPANIES[0], force_refresh=True)
            if session_id and host_url:
                res = fetch_from_ecount(session_id, host_url, f_date, t_date, 1)

        try:
            response_data = res.json()
        except Exception:
            return {"success": False, "message": "ECOUNT Session หมดอายุ กรุณารีเฟรชอีกครั้ง", "data": []}

        if str(response_data.get("Status")) != "200":
            session_id, host_url = get_ecount_session(COMPANIES[0], force_refresh=True)
            if session_id and host_url:
                retry_response = fetch_from_ecount(session_id, host_url, f_date, t_date, 1)
                try:
                    response_data = retry_response.json()
                except Exception:
                    response_data = {}

        if str(response_data.get("Status")) == "200":
            raw_data = response_data.get("Data", {})
            data_list = raw_data.get("Result") or raw_data.get("Datas") or raw_data.get("List") or []
            if isinstance(data_list, dict):
                data_list = [data_list]

            all_data = list(data_list)
            total_count = int(raw_data.get("TotalCnt") or raw_data.get("TOTAL_CNT") or 0)
            page_current = 1
            while len(all_data) < total_count and data_list:
                page_current += 1
                page_response = fetch_from_ecount(
                    session_id, host_url, f_date, t_date, page_current
                )
                page_json = page_response.json()
                if str(page_json.get("Status")) != "200":
                    break
                page_data = page_json.get("Data", {})
                page_items = page_data.get("Result") or page_data.get("Datas") or page_data.get("List") or []
                if isinstance(page_items, dict):
                    page_items = [page_items]
                if not page_items:
                    break
                all_data.extend(page_items)

            data_list = all_data

            normalized = []
            for item in data_list:
                if not isinstance(item, dict):
                    continue

                def pick(*keys):
                    for key in keys:
                        if key in item and item[key] not in (None, "", "-"):
                            return item[key]
                    return ""

                raw_po = pick("IO_NO", "SLIP_NO", "DOC_NO", "PO_NO", "PO_NUM")
                order_no = pick("ORD_NO", "ORDER_NO", "SEQ")
                io_date_val = pick("IO_DATE", "ORD_DATE", "DATE", "BASE_DATE", "PROD_DATE", "TIME_DATE", "WRITE_DT")
                seq_val = pick("UPLOAD_SER_NO", "LINE_NO", "IO_SEQ", "SEQ")

                if raw_po and str(raw_po) not in ("0", "0.0"):
                    po_number = str(raw_po)
                elif order_no:
                    po_number = f"PO-{io_date_val}-{order_no}" if io_date_val else str(order_no)
                else:
                    po_number = "-"

                comp_id = pick("COMPANY_ID", "COM_CODE") or "ASIA"

                if company_id != "ALL" and comp_id.upper() != company_id.upper():
                    continue

                row = {
                    "company_id": comp_id,
                    "po_no": po_number,
                    "pjt_cd": pick("PJT_CD", "PROJECT_CD", "PROJECT_CODE"),
                    "pjt_des": pick("PJT_DES", "PROJECT_DES", "PROJECT_NAME"),
                    "pr_no": pick("REL_NO", "PR_NO", "PUR_REQ_NO", "REQ_NO"),
                    "ref_no": pick("U_MEMO1", "REF_NO", "REFER_NO", "REMARKS"),
                    "io_date": io_date_val,
                    "cust_des": pick("CUST_DES", "CUST_NAME", "CUSTOMER_NAME"),
                    "cust_cd": pick("CUST", "CUST_CD"),
                    "prod_des": pick("PROD_DES", "ITEM_DES", "PROD_NAME"),
                    "prod_cd": pick("PROD_CD", "ITEM_CD"),
                    "size_des": pick("SIZE_DES", "SIZE", "SPEC"),
                    "qty": float(pick("QTY", "QUANTITY") or 0),
                    "price": float(pick("PRICE") or 0),
                    "supply_amt": float(str(pick("SUPPLY_AMT", "SUPPLY_AMOUNT") or 0).replace(",", "")),
                    "total_amt": float(str(pick("TOTAL_AMT", "TOTAL_AMOUNT", "PO_AMT", "BUY_AMT") or 0).replace(",", "")),
                    "pic": pick("PIC_NAME", "PIC_ID", "EMP_DES", "EMP_NAME", "EMP_CD", "EMP_ID", "WRITER_NAME", "WRITER_ID", "WRITE_ID", "PIC") or "0000",
                    "emp_des": pick("PIC_NAME", "PIC_ID", "EMP_DES", "EMP_NAME", "EMP_CD", "EMP_ID", "WRITER_NAME", "WRITER_ID", "WRITE_ID", "PIC") or "0000",
                    "seq": seq_val
                }
                normalized.append(row)

            return {"success": True, "total": len(normalized), "data": normalized}
        else:
            return {"success": False, "message": f"ECOUNT Error: {response_data.get('Errors')}", "data": []}

    except Exception as e:
        return {"success": False, "message": f"Server Error: {str(e)}", "data": []}


def fetch_company_po(company, from_date, to_date):
    def request_page(session_id, host_url, page):
        url = f"https://{host_url}/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID={session_id}"
        payload = {
            "PROD_CD": "",
            "CUST_CD": "",
            "ListParam": {
                "PAGE_CURRENT": page,
                "PAGE_SIZE": 200,
                "BASE_DATE_FROM": from_date,
                "BASE_DATE_TO": to_date,
            },
        }
        return requests.post(
            url,
            json=payload,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
            },
            timeout=30,
        )

    if not company.get("api_key"):
        return [], f"ไม่สามารถโหลด PO บริษัท {company['id']} ได้: ไม่ได้ตั้งค่า API KEY"

    session_id, host_url = get_ecount_session(company)
    if not session_id or not host_url:
        session_id, host_url = get_ecount_session(company, force_refresh=True)

    if not session_id or not host_url:
        return [], f"ไม่สามารถเข้าสู่ระบบบริษัท {company['id']} ได้"

    def response_items(response_body):
        data = response_body.get("Data", {}) or {}
        items = data.get("Result") or data.get("Datas") or data.get("List") or []
        if isinstance(items, dict):
            return [items], data
        return items if isinstance(items, list) else [], data

    body = {}
    for attempt in range(2):
        try:
            response = request_page(session_id, host_url, 1)
            body = response.json()
            if response.status_code == 200 and str(body.get("Status")) == "200":
                break
        except (ValueError, requests.RequestException):
            body = {}
        if attempt == 0:
            session_id, host_url = get_ecount_session(company, force_refresh=True)
            if not session_id or not host_url:
                return [], f"ไม่สามารถโหลด PO บริษัท {company['id']} ได้: session หมดอายุ"
    else:
        return [], f"ไม่สามารถโหลด PO บริษัท {company['id']} ได้"

    items, data = response_items(body)
    all_items = list(items)
    total_count = int(data.get("TotalCnt") or data.get("TOTAL_CNT") or len(all_items))
    page = 1
    while len(all_items) < total_count and items:
        page += 1
        page_body = {}
        for page_attempt in range(2):
            try:
                page_resp = request_page(session_id, host_url, page)
                page_body = page_resp.json()
                if page_resp.status_code == 200 and str(page_body.get("Status")) == "200":
                    break
            except (ValueError, requests.RequestException):
                page_body = {}
            if page_attempt == 0:
                session_id, host_url = get_ecount_session(company, force_refresh=True)
                if not session_id or not host_url:
                    page_body = {}
                    break
        if str(page_body.get("Status")) != "200":
            break

        items, _ = response_items(page_body)
        if not items:
            break
        all_items.extend(items)

    def pick(item, *keys):
        for key in keys:
            value = item.get(key)
            if value not in (None, "", "-"):
                return value
        return ""

    def number_value(value):
        try:
            return float(str(value or 0).replace(",", ""))
        except (TypeError, ValueError):
            return 0.0

    normalized = []
    for item in all_items:
        if not isinstance(item, dict):
            continue
        po_date = pick(item, "IO_DATE", "ORD_DATE", "DATE", "BASE_DATE", "TIME_DATE", "WRITE_DT")
        raw_po = pick(item, "IO_NO", "SLIP_NO", "DOC_NO", "PO_NO", "PO_NUM")
        order_no = pick(item, "ORD_NO", "ORDER_NO", "SEQ")
        if not raw_po or str(raw_po) in ("0", "0.0"):
            raw_po = f"PO-{po_date}-{order_no}" if po_date and order_no else str(order_no or "-")
        
        pic_val = pick(item, "PIC_NAME", "PIC_ID", "EMP_DES", "EMP_NAME", "EMP_CD", "EMP_ID", "WRITER_NAME", "WRITER_ID", "WRITE_ID", "PIC") or "0000"

        normalized.append({
            "company_id": company["id"],
            "po_no": str(raw_po),
            "pjt_cd": pick(item, "PJT_CD", "PROJECT_CD", "PROJECT_CODE"),
            "pjt_des": pick(item, "PJT_DES", "PROJECT_DES", "PROJECT_NAME"),
            "pr_no": pick(item, "REL_NO", "PR_NO", "PUR_REQ_NO", "REQ_NO"),
            "ref_no": pick(item, "U_MEMO1", "REF_NO", "REFER_NO", "REMARKS"),
            "io_date": po_date,
            "cust_des": pick(item, "CUST_DES", "CUST_NAME", "CUSTOMER_NAME"),
            "cust_cd": pick(item, "CUST", "CUST_CD"),
            "prod_des": pick(item, "PROD_DES", "ITEM_DES", "PROD_NAME"),
            "prod_cd": pick(item, "PROD_CD", "ITEM_CD"),
            "size_des": pick(item, "SIZE_DES", "SIZE", "SPEC"),
            "qty": number_value(pick(item, "QTY", "QUANTITY")),
            "price": number_value(pick(item, "PRICE")),
            "supply_amt": number_value(pick(item, "SUPPLY_AMT", "SUPPLY_AMOUNT")),
            "total_amt": number_value(pick(item, "TOTAL_AMT", "TOTAL_AMOUNT", "PO_AMT", "BUY_AMT")),
            "pic": pic_val,
            "emp_des": pic_val,
            "seq": pick(item, "UPLOAD_SER_NO", "LINE_NO", "IO_SEQ", "SEQ"),
        })
    return normalized, ""


@app.get("/api/get-po-list")
@app.get("/api/get-bq-po-list")
async def get_po_list(
    DATE_FROM: Optional[str] = Query(None),
    DATE_TO: Optional[str] = Query(None),
    company_id: Optional[str] = Query("ALL"),  
):
    """ดึงรายการใบสั่งซื้อ (PO) จาก BigQuery (หรือ Fallback ดึงสดจาก ECOUNT)"""
    if client is not None:
        try:
            where_conditions = []
            if company_id and company_id != "ALL":
                where_conditions.append(f"UPPER(TRIM(company_id)) = '{company_id.upper()}'")
            if DATE_FROM:
                clean_from = str(DATE_FROM).replace("-", "").replace("/", "")
                where_conditions.append(f"CAST(ord_date AS STRING) >= '{clean_from}'")
            if DATE_TO:
                clean_to = str(DATE_TO).replace("-", "").replace("/", "")
                where_conditions.append(f"CAST(ord_date AS STRING) <= '{clean_to}'")

            where_clause = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""
            query = f"""
                SELECT 
                    company_id, po_no, CAST(ord_date AS STRING) AS ord_date, wh_cd, wh_des,
                    pjt_cd, pjt_des, cust_cd, cust_des, prod_des, size_des,
                    qty, price, supply_amt, vat_amt, total_amt, pic, p_flag,
                    seq, updated_at
                FROM `{PROJECT_ID}.{DATASET_ID}.purchase_orders`
                {where_clause}
                ORDER BY ord_date DESC
            """
            results = client.query(query).result()
            items = []
            for row in results:
                items.append({
                    "company_id": row.company_id,
                    "po_no": row.po_no,
                    "ord_no": getattr(row, 'ord_no', ''),
                    "ord_date": str(row.ord_date),
                    "wh_cd": row.wh_cd,
                    "wh_des": row.wh_des,
                    "pjt_cd": row.pjt_cd,
                    "pjt_des": row.pjt_des,
                    "cust_cd": row.cust_cd,
                    "cust_des": row.cust_des,
                    "prod_des": row.prod_des,
                    "size_des": row.size_des,
                    "qty": float(row.qty or 0),
                    "price": float(row.price or 0),
                    "supply_amt": float(row.supply_amt or 0),
                    "vat_amt": float(row.vat_amt or 0),
                    "total_amt": float(row.total_amt or 0),
                    "pic": row.pic,
                    "p_flag": row.p_flag,
                    "ref_des": getattr(row, 'ref_des', ''),
                    "seq": row.seq,
                    "updated_at": row.updated_at.isoformat() if row.updated_at else None,
                })
            return {"success": True, "total": len(items), "data": items, "source": "bigquery"}
        except Exception as bq_err:
            print(f"⚠️ BigQuery PO query failed, falling back to direct fetch: {bq_err}")

    # Fallback กรณี BigQuery ใช้งานไม่ได้
    today = datetime.now()
    from_date = (DATE_FROM or (today - timedelta(days=365)).strftime("%Y%m%d")).replace("-", "").replace("/", "")
    to_date = (DATE_TO or today.strftime("%Y%m%d")).replace("-", "").replace("/", "")
    
    selected = [
        company for company in COMPANIES 
        if company_id == "ALL" or company["id"].upper() == company_id.upper()
    ]
    
    if not selected:
        return {"success": True, "total": 0, "data": [], "warnings": ["ไม่พบบริษัทที่เลือก"]}

    tasks = [
        asyncio.to_thread(fetch_company_po, company, from_date, to_date)
        for company in selected
    ]
    results = await asyncio.gather(*tasks)

    all_items = []
    errors = []
    for items, error in results:
        all_items.extend(items)
        if error:
            errors.append(error)

    if not all_items and errors:
        return {"success": False, "message": "; ".join(errors), "data": []}
        
    return {"success": True, "total": len(all_items), "data": all_items, "warnings": errors if errors else None, "source": "ecount"}


# --- MODULE 5: IT EXPENSES PURCHASE ORDERS API (แผนก IT แยกตามบริษัท) ---

IT_PROJECT_CODES = {
    "ASIA": "24",
    "RUAMSINTHAI": "21",
    "ROBOTICS": "20",
}


def is_it_project(company_id, project_code, project_name):
    """Match each company's IT project even when numeric codes lose leading zeros."""
    code = str(project_code or "").strip().upper()
    numeric_code = re.fullmatch(r"0*(\d+)(?:\.0+)?", code)
    normalized_code = numeric_code.group(1) if numeric_code else re.sub(r"^0+(?=\d)", "", code)
    expected_code = IT_PROJECT_CODES.get(str(company_id or "").strip().upper())
    return normalized_code == expected_code or "IT" in str(project_name or "").upper()

def fetch_company_it_po(company, from_date, to_date):
    """ดึงข้อมูลใบสั่งซื้อแผนก IT โดยแบ่งช่วงค้นหาไม่เกิน 31 วันตามข้อจำกัด ECOUNT"""
    def request_page(session_id, host_url, page, range_from, range_to):
        url = f"{ecount_api_url(host_url, 'Purchases/GetPurchasesOrderList')}?SESSION_ID={session_id}"
        payload = {
            "PROD_CD": "",
            "CUST_CD": "",
            "ListParam": {
                "PAGE_CURRENT": page,
                "PAGE_SIZE": 100,
                "BASE_DATE_FROM": range_from,
                "BASE_DATE_TO": range_to,
            },
        }
        return requests.post(
            url,
            json=payload,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
            },
            timeout=30,
        )

    if not company.get("api_key"):
        return [], f"ไม่สามารถโหลดข้อมูล {company['id']}: ไม่ได้ตั้งค่า API KEY"

    session_id, host_url = get_ecount_session(company)
    if not session_id or not host_url:
        session_id, host_url = get_ecount_session(company, force_refresh=True)

    if not session_id or not host_url:
        return [], f"ไม่สามารถเข้าสู่ระบบบริษัท {company['id']} ได้"

    try:
        start_date = datetime.strptime(from_date, "%Y%m%d").date()
        end_date = datetime.strptime(to_date, "%Y%m%d").date()
        items = []
        current_date = start_date

        while current_date <= end_date:
            range_end = min(current_date + timedelta(days=30), end_date)
            range_from = current_date.strftime("%Y%m%d")
            range_to = range_end.strftime("%Y%m%d")
            body = {}
            last_status = None

            for attempt in range(3):
                try:
                    response = request_page(session_id, host_url, 1, range_from, range_to)
                    last_status = response.status_code
                    body = response.json()
                    if response.status_code == 200 and str(body.get("Status")) == "200":
                        break
                except (ValueError, requests.RequestException):
                    body = {}

                if attempt < 2:
                    session_id, host_url = get_ecount_session(company, force_refresh=True)
                    if not session_id or not host_url:
                        break

            if str(body.get("Status")) != "200":
                error_detail = body.get("Error") or body.get("Errors") or f"HTTP {last_status}: ไม่สามารถอ่าน response จาก ECOUNT ได้"
                return [], f"ECOUNT Error [{company['id']}]: {error_detail}"

            data = body.get("Data", {}) or {}
            page_items = data.get("Result") or data.get("Datas") or data.get("List") or []
            if isinstance(page_items, dict):
                page_items = [page_items]
            items.extend(page_items)

            total_count = int(data.get("TotalCnt") or data.get("TOTAL_CNT") or len(page_items))
            page = 1
            while len(page_items) < total_count:
                page += 1
                try:
                    page_response = request_page(session_id, host_url, page, range_from, range_to)
                    page_body = page_response.json()
                except (ValueError, requests.RequestException):
                    break
                if str(page_body.get("Status")) != "200":
                    break
                page_data = page_body.get("Data", {}) or {}
                page_items = page_data.get("Result") or page_data.get("Datas") or page_data.get("List") or []
                if isinstance(page_items, dict):
                    page_items = [page_items]
                if not page_items:
                    break
                items.extend(page_items)

            current_date = range_end + timedelta(days=1)

        unique_items = []
        seen_items = set()
        for item in items:
            marker = repr(sorted(item.items())) if isinstance(item, dict) else repr(item)
            if marker not in seen_items:
                seen_items.add(marker)
                unique_items.append(item)
        items = unique_items

        def pick(item, *keys):
            for key in keys:
                val = item.get(key)
                if val not in (None, "", "-"):
                    return val
            return ""

        def number_value(val):
            try:
                return float(str(val or 0).replace(",", ""))
            except (TypeError, ValueError):
                return 0.0

        normalized = []
        for item in items:
            if not isinstance(item, dict):
                continue

            pjt_cd = pick(
                item,
                "PJT_CD", "PROJECT_CD", "PROJECT_CODE", "PROJECT_NO",
                "DEPT_CD", "DEPT_CODE", "DEPARTMENT_CD", "DEPARTMENT_CODE",
            )
            pjt_des = pick(
                item,
                "PJT_DES", "PROJECT_DES", "PROJECT_NAME", "PROJECT_NM",
                "DEPT_DES", "DEPT_NAME", "DEPARTMENT_DES", "DEPARTMENT_NAME",
            )

            if not is_it_project(company["id"], pjt_cd, pjt_des):
                continue

            po_date = pick(item, "IO_DATE", "ORD_DATE", "DATE", "BASE_DATE", "WRITE_DT")
            normalized_date = re.sub(r"[^0-9]", "", str(po_date or ""))
            if len(normalized_date) == 8 and not (from_date <= normalized_date <= to_date):
                continue
            raw_po = pick(item, "IO_NO", "SLIP_NO", "DOC_NO", "PO_NO")
            order_no = pick(item, "ORD_NO", "ORDER_NO", "SEQ")
            if not raw_po or str(raw_po) in ("0", "0.0"):
                raw_po = f"PO-{po_date}-{order_no}" if po_date and order_no else str(order_no or "-")

            pic_val = pick(item, "CUST_NAME", "PIC_NAME", "EMP_DES", "EMP_NAME", "WRITER_ID") or "-"

            normalized.append({
                "company_id": company["id"],
                "po_no": str(raw_po),
                "ord_no": pick(item, "ORD_NO"),
                "ord_date": po_date,
                "pjt_cd": pjt_cd or IT_PROJECT_CODES.get(company["id"], ""),
                "pjt_des": pjt_des or "แผนก IT",
                "cust_cd": pick(item, "CUST"),
                "cust_des": pick(item, "CUST_DES"),
                "prod_des": pick(item, "PROD_DES", "TTL_CTT"),
                "qty": number_value(pick(item, "QTY")),
                "buy_amt": number_value(pick(item, "BUY_AMT")),
                "vat_amt": number_value(pick(item, "VAT_AMT")),
                "total_amt": number_value(pick(item, "TOTAL_AMT")) or (number_value(pick(item, "BUY_AMT")) + number_value(pick(item, "VAT_AMT"))),
                "pic_name": pic_val,
                "p_flag": pick(item, "P_FLAG"),
            })

        return normalized, ""
    except Exception as e:
        return [], f"Exception [{company['id']}]: {str(e)}"


@app.get("/api/it-expenses")
@app.post("/api/it-expenses")
async def get_it_expenses(
    DATE_FROM: Optional[str] = Query(None),
    DATE_TO: Optional[str] = Query(None),
    company_id: Optional[str] = Query("ALL")
):
    """API สำหรับดึงรายการค่าใช้จ่าย/ใบสั่งซื้อแผนก IT จาก BigQuery (หรือ Fallback ดึงสดจาก ECOUNT)"""
    if client is not None:
        try:
            where_conditions = []
            if company_id and company_id != "ALL":
                where_conditions.append(f"UPPER(TRIM(company_id)) = '{company_id.upper()}'")
            if DATE_FROM:
                clean_from = str(DATE_FROM).replace("-", "").replace("/", "")
                where_conditions.append(f"CAST(ord_date AS STRING) >= '{clean_from}'")
            if DATE_TO:
                clean_to = str(DATE_TO).replace("-", "").replace("/", "")
                where_conditions.append(f"CAST(ord_date AS STRING) <= '{clean_to}'")

            where_clause = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""
            
            query = f"""
                SELECT 
                    company_id, po_no, CAST(ord_date AS STRING) AS ord_date,
                    pjt_cd, pjt_des, cust_cd, cust_des, prod_des,
                    qty, buy_amt, vat_amt, total_amt, pic_name, p_flag, updated_at
                FROM `{PROJECT_ID}.{DATASET_ID}.it_expenses`
                {where_clause}
                ORDER BY ord_date DESC
            """
            results = client.query(query).result()
            items = []
            total_amount = 0.0
            for row in results:
                b_amt = float(row.buy_amt or 0)
                v_amt = float(row.vat_amt or 0)
                tot = float(row.total_amt or 0) if (row.total_amt and float(row.total_amt) > 0) else (b_amt + v_amt)
                
                total_amount += tot
                items.append({
                    "company_id": row.company_id,
                    "po_no": row.po_no,
                    "ord_no": "",
                    "ord_date": str(row.ord_date),
                    "pjt_cd": row.pjt_cd,
                    "pjt_des": row.pjt_des,
                    "cust_cd": row.cust_cd,
                    "cust_des": row.cust_des,
                    "prod_des": row.prod_des,
                    "qty": float(row.qty or 0),
                    "buy_amt": b_amt,
                    "supply_amt": b_amt,
                    "vat_amt": v_amt,
                    "total_amt": tot,
                    "pic_name": row.pic_name,
                    "pic": row.pic_name,
                    "p_flag": row.p_flag,
                    "updated_at": row.updated_at.isoformat() if row.updated_at else None,
                })
            return {
                "success": True,
                "total_items": len(items),
                "total_expense_amt": total_amount,
                "data": items,
                "source": "bigquery"
            }
        except Exception as bq_err:
            print(f"⚠️ BigQuery IT Expenses query failed, falling back: {bq_err}")

    # Fallback กรณี BigQuery ไม่พร้อมใช้งาน (ปรับเพิ่มย้อนหลัง default เป็น 365 วันให้ดึงข้อมูล IT Expenses ครบทั้งหมด)
    today = datetime.now()
    from_date = (DATE_FROM or (today - timedelta(days=365)).strftime("%Y%m%d")).replace("-", "").replace("/", "")
    to_date = (DATE_TO or today.strftime("%Y%m%d")).replace("-", "").replace("/", "")

    selected = [
        comp for comp in COMPANIES 
        if company_id == "ALL" or comp["id"].upper() == company_id.upper()
    ]

    tasks = [
        asyncio.to_thread(fetch_company_it_po, comp, from_date, to_date)
        for comp in selected
    ]
    results = await asyncio.gather(*tasks)

    all_items = []
    errors = []
    total_amount = 0.0

    for items, error in results:
        all_items.extend(items)
        if error:
            errors.append(error)

    if not all_items and errors:
        return {
            "success": False,
            "message": "; ".join(errors),
            "total_items": 0,
            "total_expense_amt": 0.0,
            "data": [],
            "warnings": errors,
        }

    for item in all_items:
        total_amount += item.get("total_amt", 0.0)

    return {
        "success": True,
        "total_items": len(all_items),
        "total_expense_amt": total_amount,
        "data": all_items,
        "warnings": errors if errors else None,
        "source": "ecount"
    }


@app.post("/api/sync-po")
@app.get("/api/sync-po")
async def sync_po_to_bigquery(days_back: int = Query(365)):
    """สั่งซิงค์ข้อมูลใบสั่งซื้อและค่าใช้จ่าย IT จาก ECOUNT ลง BigQuery ทันที"""
    if not fetch_all_company_po:
        raise HTTPException(status_code=500, detail="ฟังก์ชัน fetch_all_company_po ไม่พร้อมใช้งาน")
    try:
        res = await asyncio.to_thread(fetch_all_company_po, days_back=days_back)
        return {
            "success": True,
            "message": f"ซิงค์ข้อมูลสำเร็จ (PO: {res.get('po_total', 0)} รายการ, IT: {res.get('it_total', 0)} รายการ)",
            "result": res
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ซิงค์ข้อมูลไม่สำเร็จ: {exc}")