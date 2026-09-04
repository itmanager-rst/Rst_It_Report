import os
import asyncio
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from google.cloud import bigquery
from dotenv import load_dotenv
import requests

# นำเข้าฟังก์ชันดึงข้อมูลจาก sync_worker เพื่อทำ Auto-sync สต็อก
try:
    from sync_worker import fetch_all_company_data, SYNC_INTERVAL_SECONDS
except ImportError:
    fetch_all_company_data = None
    SYNC_INTERVAL_SECONDS = 1800

load_dotenv()

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "rst-ecount-sync-py").strip()
DATASET_ID = "multi_company_inventory"

# ECOUNT credentials and sessions are kept separately for each company.
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


# --- ECOUNT Authentication (Read-Only Use) ---

def get_ecount_session(company, force_refresh: bool = False):
    company_id = company["id"]
    if force_refresh:
        ECOUNT_SESSIONS.pop(company_id, None)

    if company_id in ECOUNT_SESSIONS:
        return ECOUNT_SESSIONS[company_id]

    api_key = company["api_key"]
    if not api_key:
        return None, None

    login_url = f"https://oapi{company['zone'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    login_payload = {
        "API_CERT_KEY": api_key,
        "COM_CODE": company["code"],
        "LAN_TYPE": "th-TH",
        "USER_ID": company["user_id"],
        "ZONE": company["zone"].upper()
    }
    try:
        response = requests.post(login_url, json=login_payload, timeout=30)
        res = response.json()
        
        if str(res.get("Status")) == "200":
            datas = res.get("Data", {}).get("Datas", {})
            session = (datas.get("SESSION_ID"), datas.get("HOST_URL"))
            if session[0] and session[1]:
                ECOUNT_SESSIONS[company_id] = session
            return session
        return None, None
    except Exception as e:
        print(f"[ECOUNT LOGIN EXCEPTION - {company_id}]: {e}")
        return None, None


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


# --- MODULE 1: READ-ONLY INVENTORY API ( BigQuery) ---

@app.get("/api/inventory")
def get_inventory(company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL")):
    if client is None:
        raise HTTPException(
            status_code=503,
            detail=f"BigQuery client unavailable. Check GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID='{PROJECT_ID}'.",
        )

    where_clause = ""
    if company_id != "ALL":
        where_clause = f"WHERE UPPER(b.company_id) = '{company_id.upper()}'"

    query = f"""
        SELECT 
            b.company_id,
            b.company_code,
            b.prod_cd,
            COALESCE(
                CASE
                    WHEN UPPER(b.company_id) = 'RUAMSINTHAI'
                        AND TRIM(CAST(m.prod_des AS STRING)) = TRIM(CAST(b.prod_cd AS STRING))
                    THEN NULL
                    ELSE NULLIF(TRIM(CAST(m.prod_des AS STRING)), '')
                END,
                CASE WHEN UPPER(b.company_id) = 'RUAMSINTHAI' THEN '-' ELSE b.prod_cd END
            ) AS prod_des,
            COALESCE(NULLIF(TRIM(CAST(m.size_des AS STRING)), ''), '') AS size_des,
            COALESCE(NULLIF(TRIM(CAST(b.wh_cd AS STRING)), ''), '-') AS wh_cd,
            COALESCE(NULLIF(TRIM(CAST(b.wh_cd AS STRING)), ''), '-') AS wh_des,
            b.bal_qty,
            b.updated_at
        FROM `{PROJECT_ID}.{DATASET_ID}.inventory_balance` b
        LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.master_products` m
            ON b.company_id = m.company_id AND b.prod_cd = m.prod_cd
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


# --- MODULE 2: READ-ONLY PURCHASE ORDERS (PO) API ( ECOUNT) ---

async def get_po_list_legacy(
    DATE_FROM: Optional[str] = Query(None),
    DATE_TO: Optional[str] = Query(None),
    company_id: Optional[str] = Query("ALL")
):
    """ดึงรายการใบสั่งซื้อ (PO) จาก ECOUNT แบบ Read-Only เท่านั้น"""
    
    def fetch_from_ecount(session_id, host_url, f_date, t_date, page_current):
        url = f"https://{host_url}/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID={session_id}"
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
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
            },
            timeout=30,
        )

    try:
        today = datetime.now()
        f_date = (DATE_FROM or (today - timedelta(days=29)).strftime("%Y%m%d")).replace("-", "").replace("/", "")
        t_date = (DATE_TO or today.strftime("%Y%m%d")).replace("-", "").replace("/", "")

        session_id, host_url = get_ecount_session()
        if not session_id or not host_url:
            return {"success": False, "message": "ไม่สามารถเข้าสู่ระบบ ECOUNT ได้", "data": []}

        res = fetch_from_ecount(session_id, host_url, f_date, t_date, 1)

        content_type = res.headers.get("Content-Type", "").lower()
        if res.status_code in [412, 401, 500] or "application/json" not in content_type:
            session_id, host_url = get_ecount_session(force_refresh=True)
            if session_id and host_url:
                res = fetch_from_ecount(session_id, host_url, f_date, t_date, 1)

        try:
            response_data = res.json()
        except Exception:
            return {"success": False, "message": "ECOUNT Session หมดอายุ กรุณารีเฟรชอีกครั้ง", "data": []}

        # ECOUNT may return an expired-session error with HTTP 200.
        if str(response_data.get("Status")) != "200":
            session_id, host_url = get_ecount_session(force_refresh=True)
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

                # แมปบริษัทจากข้อมูล
                comp_id = pick("COMPANY_ID", "COM_CODE") or "ASIA"

                # รองรับการ Filter แยกบริษัท
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

    session_id, host_url = get_ecount_session(company)
    if not session_id or not host_url:
        return [], f"ไม่สามารถเข้าสู่ระบบบริษัท {company['id']} ได้"

    for attempt in range(2):
        try:
            response = request_page(session_id, host_url, 1)
            body = response.json()
            if str(body.get("Status")) == "200":
                break
        except (ValueError, requests.RequestException):
            body = {}
        session_id, host_url = get_ecount_session(company, force_refresh=True)
    else:
        return [], f"ไม่สามารถโหลด PO บริษัท {company['id']} ได้"

    data = body.get("Data", {})
    items = data.get("Result") or data.get("Datas") or data.get("List") or []
    if isinstance(items, dict):
        items = [items]
    all_items = list(items)
    total_count = int(data.get("TotalCnt") or data.get("TOTAL_CNT") or len(all_items))
    page = 1
    while len(all_items) < total_count and items:
        page += 1
        try:
            page_body = request_page(session_id, host_url, page).json()
        except (ValueError, requests.RequestException):
            break
        if str(page_body.get("Status")) != "200":
            break
        page_data = page_body.get("Data", {})
        items = page_data.get("Result") or page_data.get("Datas") or page_data.get("List") or []
        if isinstance(items, dict):
            items = [items]
        if not items:
            break
        all_items.extend(items)

    def pick(item, *keys):
        for key in keys:
            value = item.get(key)
            if value not in (None, "", "-"):
                return value
        return ""

    normalized = []
    for item in all_items:
        if not isinstance(item, dict):
            continue
        po_date = pick(item, "IO_DATE", "ORD_DATE", "DATE", "BASE_DATE", "TIME_DATE", "WRITE_DT")
        raw_po = pick(item, "IO_NO", "SLIP_NO", "DOC_NO", "PO_NO", "PO_NUM")
        order_no = pick(item, "ORD_NO", "ORDER_NO", "SEQ")
        if not raw_po or str(raw_po) in ("0", "0.0"):
            raw_po = f"PO-{po_date}-{order_no}" if po_date and order_no else str(order_no or "-")
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
            "qty": float(str(pick(item, "QTY", "QUANTITY") or 0).replace(",", "")),
            "price": float(str(pick(item, "PRICE") or 0).replace(",", "")),
            "supply_amt": float(str(pick(item, "SUPPLY_AMT", "SUPPLY_AMOUNT") or 0).replace(",", "")),
            "total_amt": float(str(pick(item, "TOTAL_AMT", "TOTAL_AMOUNT", "PO_AMT", "BUY_AMT") or 0).replace(",", "")),
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
    today = datetime.now()
    from_date = (DATE_FROM or (today - timedelta(days=29)).strftime("%Y%m%d")).replace("-", "").replace("/", "")
    to_date = (DATE_TO or today.strftime("%Y%m%d")).replace("-", "").replace("/", "")
    selected = [company for company in COMPANIES if company_id == "ALL" or company["id"] == company_id.upper()]
    all_items = []
    errors = []
    for company in selected:
        items, error = fetch_company_po(company, from_date, to_date)
        all_items.extend(items)
        if error:
            errors.append(error)
    if not all_items and errors:
        return {"success": False, "message": "; ".join(errors), "data": []}
    return {"success": True, "total": len(all_items), "data": all_items, "warnings": errors}