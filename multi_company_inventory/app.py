import os
import io
import asyncio
import time
import re
import types
import calendar
from datetime import datetime, timedelta, date, timezone
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
import threading
from google.cloud import bigquery
from dotenv import load_dotenv
import requests
import openpyxl

# นำเข้าฟังก์ชันดึงข้อมูลจาก sync_worker เพื่อทำ Auto-sync สต็อกและใบสั่งซื้อ
try:
    from sync_worker import fetch_all_company_data, fetch_all_company_po, SYNC_INTERVAL_SECONDS
except ImportError:
    fetch_all_company_data = None
    fetch_all_company_po = None
    SYNC_INTERVAL_SECONDS = 1800

try:
    from sync_worker import LAST_PO_SYNC_REPORT
except ImportError:
    LAST_PO_SYNC_REPORT = {}

load_dotenv()

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "rst-ecount-sync-py").strip()
DATASET_ID = "multi_company_inventory"

COMPANIES = [
    {
        "id": "ASIA",
        # อ่านเฉพาะตัวแปร ASIA_* เท่านั้น — เดิม fallback ไป COM_CODE=915297 ซึ่งเป็นรหัสของ RUAMSINTHAI
        # ถ้า ASIA_COM_CODE ไม่ได้ตั้งไว้ ยอด "ASIA" ในโหมดดึงสดจะกลายเป็นข้อมูลของ RUAMSINTHAI
        "code": os.getenv("ASIA_COM_CODE", "").strip(),
        "user_id": os.getenv("ASIA_USER_ID", "").strip(),
        "api_key": os.getenv("ASIA_API_KEY", "").strip(),
        "zone": os.getenv("ASIA_ZONE", "IA").strip(),
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


# --- Shared input validation (ป้องกัน SQL injection ผ่าน query param ก่อนนำไปต่อ SQL) ---

_VALID_COMPANY_IDS = {c["id"] for c in COMPANIES}


def validate_company_id(company_id: Optional[str]) -> str:
    """ตรวจสอบว่า company_id เป็นค่าที่รู้จักเท่านั้น (ASIA/ROBOTICS/RUAMSINTHAI/ALL)
    ก่อนนำไปประกอบ SQL — ป้องกันไม่ให้ query param ที่รับจากผู้ใช้หลุดเข้าไปเป็นส่วนหนึ่งของคำสั่ง SQL ตรงๆ"""
    normalized = (company_id or "ALL").strip().upper()
    if normalized != "ALL" and normalized not in _VALID_COMPANY_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown company_id '{company_id}'. Expected one of: {', '.join(sorted(_VALID_COMPANY_IDS))} or ALL.",
        )
    return normalized


_DATE_YYYYMMDD_RE = re.compile(r"^\d{8}$")


def validate_date_yyyymmdd(value: Optional[str], field_name: str) -> Optional[str]:
    """ตรวจสอบวันที่ในรูปแบบ YYYYMMDD (หลังตัด '-' และ '/' ออกแล้ว) ก่อนนำไปต่อ SQL"""
    if not value:
        return None
    cleaned = str(value).replace("-", "").replace("/", "").strip()
    if not _DATE_YYYYMMDD_RE.match(cleaned):
        raise HTTPException(status_code=400, detail=f"Invalid {field_name}: '{value}'. Expected format YYYYMMDD.")
    return cleaned


# เวลาไทย (UTC+7) — เซิร์ฟเวอร์ Render ใช้ UTC ถ้าใช้ datetime.now() ตรงๆ ช่วงเช้ามืดวันที่ 1 ม.ค. จะได้ปีเก่า
BANGKOK_TZ = timezone(timedelta(hours=7))


def default_expense_date_range(date_from: Optional[str], date_to: Optional[str]):
    """ค่าเริ่มต้นช่วงวันที่ของยอดค่าใช้จ่าย: ตั้งแต่ 1 ม.ค. ของปีปัจจุบัน ถึง วันนี้ (YYYYMMDD)"""
    today = datetime.now(BANGKOK_TZ)
    return (date_from or f"{today.year}0101", date_to or today.strftime("%Y%m%d"))


# วันที่ใน BigQuery เทียบแบบตัวเลขล้วน (YYYYMMDD) เสมอ — ถ้าคอลัมน์ ord_date เคยถูก autodetect เป็น DATE
# CAST เป็น STRING จะได้ '2026-01-15' ซึ่งเทียบกับ '20260101' แบบ string แล้วผิด (ทุกแถวหลุดช่วงวันที่)
ORD_DATE_SQL = "REGEXP_REPLACE(CAST(ord_date AS STRING), r'[^0-9]', '')"

UNASSIGNED_PROJECT_LABEL = "ไม่ระบุโครงการ"

# คีย์โครงการ/แผนก: ชื่อ (ยุบช่องว่างซ้ำ) -> ถ้าไม่มีชื่อใช้ 'รหัสแผนก <รหัส>' -> ถ้าไม่มีทั้งคู่ใช้ 'ไม่ระบุโครงการ'
# (เดิม PO ที่ไม่มีทั้งชื่อและรหัสโครงการถูกตัดทิ้ง ไม่ปรากฏในแผนกไหนเลย ยอดจึงไม่ครบ)
DEPT_KEY_SQL = r"""CASE
    WHEN TRIM(COALESCE(CAST(pjt_des AS STRING), '')) != ''
        THEN REGEXP_REPLACE(TRIM(CAST(pjt_des AS STRING)), r'\s+', ' ')
    WHEN TRIM(COALESCE(CAST(pjt_cd AS STRING), '')) != ''
        THEN CONCAT('รหัสแผนก ', REGEXP_REPLACE(TRIM(CAST(pjt_cd AS STRING)), r'\.0+$', ''))
    ELSE 'ไม่ระบุโครงการ'
END"""

# ยอดรวมต่อแถว: ใช้ total_amt ถ้า > 0 ไม่งั้น supply + vat (สูตรเดียวกับที่ endpoint ค่าใช้จ่ายใช้)
ROW_TOTAL_SQL = "IF(COALESCE(total_amt, 0) > 0, total_amt, COALESCE(supply_amt, 0) + COALESCE(vat_amt, 0))"


def po_sync_coverage_warnings(company_filter, date_from):
    """เตือนเมื่อช่วงวันที่ที่เลือกเริ่มก่อนช่วงที่ซิงค์ไว้ใน BigQuery หรือรอบซิงค์ล่าสุดของบริษัทนั้นไม่ครบ"""
    warnings = []
    companies = (LAST_PO_SYNC_REPORT or {}).get("companies") or {}
    for cid, rep_ in companies.items():
        if company_filter != "ALL" and cid != company_filter:
            continue
        cov_from = rep_.get("coverage_from")
        if date_from and cov_from and str(date_from) < str(cov_from) and rep_.get("used") == "new":
            warnings.append(f"{cid}: ข้อมูลใน BigQuery เริ่มที่ {cov_from} — ยอดก่อนวันนั้นไม่ได้ถูกซิงค์มา")
        if rep_.get("used") in ("previous", "partial"):
            warnings.append(f"{cid}: รอบซิงค์ล่าสุดดึงจาก ECOUNT ไม่ครบ ({'ใช้ข้อมูลรอบก่อน' if rep_.get('used') == 'previous' else 'ข้อมูลบางช่วงขาด'})")
        elif rep_.get("error") and not rep_.get("ok"):
            warnings.append(f"{cid}: {rep_.get('error')}")
    return warnings


# --- ECOUNT Authentication (Read-Only Use) ---

# เก็บ error ล่าสุดของแต่ละบริษัทไว้ (ไม่ใช่แค่ print ลง log เฉยๆ) เพื่อให้ /api/health-check
# และ /api/reconnect-ecount ส่งข้อความที่ชัดเจนกลับไปแสดงผลที่หน้าเว็บได้ (เช่น ถูกบล็อก IP, Cert Key ผิด ฯลฯ)
ECOUNT_LAST_ERROR = {}


def _set_ecount_error(company_id, code, message):
    ECOUNT_LAST_ERROR[company_id] = {"code": code, "message": message}


def _clear_ecount_error(company_id):
    ECOUNT_LAST_ERROR.pop(company_id, None)


def get_ecount_session(company, force_refresh: bool = False):
    company_id = company["id"]
    if force_refresh:
        ECOUNT_SESSIONS.pop(company_id, None)

    if company_id in ECOUNT_SESSIONS and not force_refresh:
        sess = ECOUNT_SESSIONS[company_id]
        return sess[0], sess[1]

    missing = [
        name for name, val in
        [("COM_CODE", company.get("code")), ("API_KEY", company.get("api_key")), ("USER_ID", company.get("user_id"))]
        if not val
    ]
    if missing:
        msg = f"ไม่ได้ตั้งค่า {', '.join(missing)} ใน Environment Variables (ค่าว่าง)"
        print(f"[ECOUNT LOGIN SKIPPED - {company_id}]: {msg}")
        _set_ecount_error(company_id, "MISSING_CONFIG", msg)
        return None, None

    s = requests.Session()
    s.headers.update(ECOUNT_API_HEADERS)
    login_url = f"https://oapi{company['zone'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    login_payload = {
        "API_CERT_KEY": company["api_key"],
        "COM_CODE": company["code"],
        "LAN_TYPE": "th-TH",
        "USER_ID": company["user_id"],
        "ZONE": company["zone"].upper()
    }
    try:
        response = s.post(login_url, json=login_payload, timeout=30)
        if response.status_code != 200:
            msg = f"HTTP {response.status_code}: {response.text[:300]}"
            print(f"[ECOUNT LOGIN HTTP ERROR - {company_id}]: {msg}")
            _set_ecount_error(company_id, str(response.status_code), msg)
            return None, None

        res = response.json()
        status_code = str(res.get("Status"))

        if status_code == "200":
            datas = res.get("Data", {}).get("Datas", {})
            session_id = datas.get("SESSION_ID")
            host_url = datas.get("HOST_URL")
            if session_id and host_url:
                ECOUNT_SESSIONS[company_id] = (session_id, host_url, s)
                _clear_ecount_error(company_id)
                return session_id, host_url
            msg = f"Status 200 แต่ไม่มี SESSION_ID/HOST_URL: {res}"
            print(f"[ECOUNT LOGIN NO SESSION - {company_id}]: {msg}")
            _set_ecount_error(company_id, "NO_SESSION", msg)
        else:
            err_detail = res.get("Error") or res.get("Message") or res
            # โค้ด 205 (ตามที่ ECOUNT ใช้แจ้งในระบบนี้) = IP เครื่องที่เรียกไม่ได้อยู่ใน whitelist ของ Ecount
            if status_code == "205":
                msg = f"IP นี้ยังไม่ได้รับอนุญาตให้เรียก ECOUNT API (ต้องนำ Outbound IP ไป whitelist ใน Ecount OAPI Cert Key ก่อน): {err_detail}"
            else:
                msg = f"Status={status_code}: {err_detail}"
            print(f"[ECOUNT LOGIN REJECTED - {company_id}]: {msg}")
            _set_ecount_error(company_id, status_code, msg)
        return None, None
    except requests.exceptions.Timeout:
        msg = "เซิร์ฟเวอร์ ECOUNT ไม่ตอบสนองภายในเวลาที่กำหนด"
        print(f"[ECOUNT LOGIN TIMEOUT - {company_id}]: {msg}")
        _set_ecount_error(company_id, "TIMEOUT", msg)
        return None, None
    except requests.exceptions.ConnectionError as e:
        msg = f"อาจถูก ECOUNT บล็อก IP หรือเน็ตเวิร์กมีปัญหา: {e}"
        print(f"[ECOUNT LOGIN CONNECTION ERROR - {company_id}]: {msg}")
        _set_ecount_error(company_id, "CONNECTION_ERROR", msg)
        return None, None
    except Exception as e:
        msg = str(e)
        print(f"[ECOUNT LOGIN EXCEPTION - {company_id}]: {msg}")
        _set_ecount_error(company_id, "EXCEPTION", msg)
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
                clear_bq_cache()
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
# บีบอัด response (JSON รายการ PO/สต็อกหลายพันแถว เล็กลงมาก ส่งถึงเบราว์เซอร์เร็วขึ้น)
app.add_middleware(GZipMiddleware, minimum_size=1024)


# --- BigQuery read cache ---
# ทุกครั้งที่สลับแท็บ/เปลี่ยนตัวกรอง หน้าเว็บยิง query เดิมซ้ำ (BigQuery ใช้เวลา ~1-3 วินาทีต่อ query)
# จึงเก็บผลของ SELECT ไว้ในหน่วยความจำ BQ_CACHE_TTL_SECONDS วินาที และล้างทันทีเมื่อมีการเขียนข้อมูล
# (DELETE/INSERT/โหลดไฟล์/ซิงค์ ECOUNT) เพื่อไม่ให้เห็นข้อมูลเก่าหลังอัปเดต
BQ_CACHE_TTL_SECONDS = int(os.getenv("BQ_CACHE_TTL_SECONDS", "120"))
BQ_CACHE_MAX_ENTRIES = 128
_bq_cache = {}
_bq_cache_lock = threading.Lock()


def clear_bq_cache():
    with _bq_cache_lock:
        _bq_cache.clear()


class _CachedQueryJob:
    def __init__(self, rows):
        self._rows = rows

    def result(self, *args, **kwargs):
        return self._rows


class CachedBigQueryClient:
    """ห่อ bigquery.Client: cache เฉพาะ query อ่านอย่างเดียว (SELECT/WITH) ส่วนอื่นส่งผ่านตามปกติ"""

    def __init__(self, inner):
        self._inner = inner

    @staticmethod
    def _cache_key(query, job_config):
        params = getattr(job_config, "query_parameters", None) or []
        return (query, tuple(
            (p.name, getattr(p, "type_", None), repr(getattr(p, "value", getattr(p, "values", None))))
            for p in params
        ))

    def query(self, query, job_config=None, **kwargs):
        head = query.lstrip().upper()
        if not (head.startswith("SELECT") or head.startswith("WITH")) or BQ_CACHE_TTL_SECONDS <= 0:
            clear_bq_cache()  # DML/DDL -> ข้อมูลเปลี่ยน
            return self._inner.query(query, job_config=job_config, **kwargs)

        key = self._cache_key(query, job_config)
        now = time.monotonic()
        with _bq_cache_lock:
            hit = _bq_cache.get(key)
            if hit and now - hit[0] < BQ_CACHE_TTL_SECONDS:
                return _CachedQueryJob(hit[1])

        rows = list(self._inner.query(query, job_config=job_config, **kwargs).result())
        with _bq_cache_lock:
            if len(_bq_cache) >= BQ_CACHE_MAX_ENTRIES:
                oldest = min(_bq_cache, key=lambda k: _bq_cache[k][0])
                _bq_cache.pop(oldest, None)
            _bq_cache[key] = (now, rows)
        return _CachedQueryJob(rows)

    def __getattr__(self, name):
        attr = getattr(self._inner, name)
        if name.startswith(("load_table", "insert_rows", "delete_table", "create_table", "update_table")):
            def wrapper(*args, **kwargs):
                clear_bq_cache()
                return attr(*args, **kwargs)
            return wrapper
        return attr


def get_bigquery_client():
    try:
        return CachedBigQueryClient(bigquery.Client(project=PROJECT_ID))
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
    # ใช้ session ที่ cache ไว้ (login เฉพาะบริษัทที่ยังไม่มี session) — เดิม force login ใหม่ทั้ง 3 บริษัททุกครั้ง
    # ทำให้เปิดหน้าเว็บช้า และทำให้ session ที่ request อื่นกำลังใช้อยู่หมดอายุกลางทาง
    # (ต้องการทดสอบ login ใหม่จริงๆ ใช้ปุ่ม 🔌 /api/reconnect-ecount)
    company_status = {}
    for company in COMPANIES:
        session_id, host_url = get_ecount_session(company)
        company_status[company["id"]] = bool(session_id and host_url)

    return {
        "status": "ok",
        "project_id": PROJECT_ID,
        "bigquery_ready": client is not None,
        "ecount_ready": any(company_status.values()),
        "ecount_companies": company_status,
        "ecount_errors": dict(ECOUNT_LAST_ERROR),
        "dataset": DATASET_ID,
    }


# --- Manual reconnect buttons (BigQuery / Ecount) ---

@app.post("/api/reconnect-bigquery")
def reconnect_bigquery():
    """ลองสร้าง BigQuery client ใหม่อีกครั้ง (ใช้เมื่อแก้ credentials/Secret File บน Render แล้วอยากเชื่อมต่อทันทีโดยไม่ต้อง redeploy)"""
    global client
    clear_bq_cache()
    client = get_bigquery_client()
    connected = client is not None
    return {
        "success": connected,
        "connected": connected,
        "project_id": PROJECT_ID,
        "message": (
            "เชื่อมต่อ BigQuery สำเร็จ"
            if connected
            else f"เชื่อมต่อ BigQuery ไม่สำเร็จ ตรวจสอบ GOOGLE_APPLICATION_CREDENTIALS และ GCP_PROJECT_ID='{PROJECT_ID}'"
        ),
    }


@app.post("/api/reconnect-ecount")
def reconnect_ecount():
    """บังคับ login ใหม่กับ Ecount ทุกบริษัท (force refresh session) แล้วรายงานสถานะรายบริษัท"""
    company_status = {}
    for company in COMPANIES:
        session_id, host_url = get_ecount_session(company, force_refresh=True)
        company_status[company["id"]] = bool(session_id and host_url)

    return {
        "success": any(company_status.values()),
        "ecount_ready": any(company_status.values()),
        "companies": company_status,
        "errors": dict(ECOUNT_LAST_ERROR),
    }


# --- MODULE 1: READ-ONLY INVENTORY API (BigQuery) ---

@app.get("/api/inventory")
def get_inventory(company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL")):
    if client is None:
        raise HTTPException(
            status_code=503,
            detail=f"BigQuery client unavailable. Check GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID='{PROJECT_ID}'.",
        )

    company_filter = validate_company_id(company_id)
    where_clause = ""
    query_params = []
    if company_filter != "ALL":
        where_clause = "WHERE UPPER(TRIM(b.company_id)) = @company_id"
        query_params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_filter))

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
        query_job = client.query(query, job_config=bigquery.QueryJobConfig(query_parameters=query_params))
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

    company_filter = validate_company_id(company_id)
    where_clause = ""
    query_params = []
    if company_filter != "ALL":
        where_clause = "WHERE UPPER(TRIM(company_id)) = @company_id"
        query_params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_filter))

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
        query_job = client.query(query, job_config=bigquery.QueryJobConfig(query_parameters=query_params))
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

    company_filter = validate_company_id(company_id)
    where_conditions = ["b.bal_qty <= 0"]
    query_params = []
    if company_filter != "ALL":
        where_conditions.append("UPPER(TRIM(b.company_id)) = @company_id")
        query_params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_filter))

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
        query_job = client.query(query, job_config=bigquery.QueryJobConfig(query_parameters=query_params))
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
    # ตรวจสอบ input ก่อนเสมอ (นอก try/except ของ BigQuery) เพื่อไม่ให้ค่าที่ไม่ถูกต้อง
    # หลุดไปเป็น "BigQuery ล้มเหลว" แล้วถูกกลืนไปเงียบๆ ตอน fallback ไป Ecount
    company_filter = validate_company_id(company_id)
    date_from_clean = validate_date_yyyymmdd(DATE_FROM, "DATE_FROM")
    date_to_clean = validate_date_yyyymmdd(DATE_TO, "DATE_TO")

    if client is not None:
        try:
            where_conditions = []
            query_params = []
            if company_filter != "ALL":
                where_conditions.append("UPPER(TRIM(company_id)) = @company_id")
                query_params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_filter))
            if date_from_clean:
                where_conditions.append(f"{ORD_DATE_SQL} >= @date_from")
                query_params.append(bigquery.ScalarQueryParameter("date_from", "STRING", date_from_clean))
            if date_to_clean:
                where_conditions.append(f"{ORD_DATE_SQL} <= @date_to")
                query_params.append(bigquery.ScalarQueryParameter("date_to", "STRING", date_to_clean))

            where_clause = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""
            query = f"""
                SELECT
                    company_id, po_no, CAST(ord_date AS STRING) AS ord_date, wh_cd, wh_des,
                    pjt_cd, pjt_des, cust_cd, cust_des, prod_des, size_des,
                    qty, price, supply_amt, vat_amt, total_amt, pic, p_flag, status_name,
                    seq, updated_at
                FROM `{PROJECT_ID}.{DATASET_ID}.purchase_orders`
                {where_clause}
                ORDER BY ord_date DESC
            """
            results = client.query(
                query, job_config=bigquery.QueryJobConfig(query_parameters=query_params)
            ).result()
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
                    "status_name": getattr(row, 'status_name', None),
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


@app.get("/api/po-items")
async def get_po_items(
    company_id: str = Query(..., description="ASIA, ROBOTICS หรือ RUAMSINTHAI (ต้องระบุบริษัทเดียว ไม่รับ ALL)"),
    po_no: str = Query(..., description="เลขที่ PO ที่ต้องการดูรายการสินค้าทุกบรรทัด"),
    ord_date: Optional[str] = Query(None, description="วันที่สั่งซื้อของ PO นี้ (YYYYMMDD หรือ YYYY-MM-DD) ถ้ามี จะช่วยให้ค้นหาเร็ว/แม่นยำขึ้น"),
):
    """
    ดึงรายการสินค้าทุกบรรทัดของ PO เดียว โดยเรียกสดจาก ECOUNT OAPI ผ่าน fetch_company_po()
    (เหตุผล: ตาราง `purchase_orders` ใน BigQuery เก็บข้อมูลแบบรวบยอด 1 แถวต่อ 1 PO อยู่แล้ว — prod_des เป็นข้อความสรุป
    เช่น "... และอีก N รายการ" และ qty/total_amt เป็นผลรวมทั้ง PO — จึงไม่มีรายละเอียดแยกบรรทัดอยู่ใน BigQuery
    ให้ query ตรงๆ ได้ ต้องไปดึงจาก ECOUNT ตรงๆ ซึ่ง GetPurchasesOrderList คืนค่ามาแบบไม่รวบยอด คือ 1 แถวต่อ 1 บรรทัดสินค้า
    พร้อม seq/line number อยู่แล้ว — fetch_company_po() ที่มีอยู่แล้วในไฟล์นี้จึงนำมาใช้ซ้ำได้เลย)
    """
    company_filter = validate_company_id(company_id)
    if company_filter == "ALL":
        raise HTTPException(status_code=400, detail="ต้องระบุ company_id เป็น ASIA, ROBOTICS หรือ RUAMSINTHAI (ไม่รับ ALL สำหรับ endpoint นี้)")
    if not po_no or not po_no.strip():
        raise HTTPException(status_code=400, detail="ต้องระบุ po_no")
    po_no_clean = po_no.strip()

    company = next((c for c in COMPANIES if c["id"].upper() == company_filter.upper()), None)
    if not company:
        raise HTTPException(status_code=400, detail=f"ไม่พบข้อมูลบริษัท '{company_id}'")

    # จำกัดช่วงวันที่ค้นหาให้แคบที่สุดเท่าที่ทำได้เพื่อความเร็ว: ถ้ามี ord_date ใช้ ±3 วัน, ถ้าไม่มีใช้ 365 วันล่าสุด (fallback กว้างสุด)
    today = datetime.now()
    if ord_date:
        cleaned_date = str(ord_date).replace("-", "").replace("/", "").strip()
        try:
            center = datetime.strptime(cleaned_date, "%Y%m%d")
            from_date = (center - timedelta(days=3)).strftime("%Y%m%d")
            to_date = (center + timedelta(days=3)).strftime("%Y%m%d")
        except ValueError:
            from_date = (today - timedelta(days=365)).strftime("%Y%m%d")
            to_date = today.strftime("%Y%m%d")
    else:
        from_date = (today - timedelta(days=365)).strftime("%Y%m%d")
        to_date = today.strftime("%Y%m%d")

    items, error = await asyncio.to_thread(fetch_company_po, company, from_date, to_date)

    if error and not items:
        return {"success": False, "message": error, "po_no": po_no_clean, "company_id": company_filter, "data": []}

    matched = [it for it in items if str(it.get("po_no", "")).strip() == po_no_clean]

    return {
        "success": True,
        "po_no": po_no_clean,
        "company_id": company_filter,
        "total_items": len(matched),
        "data": matched,
        "warnings": [error] if error else None,
        "source": "ecount_live",
    }


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
    # ต้องเป็นคำว่า IT เดี่ยวๆ — เดิม "IT" in name ทำให้ชื่ออย่าง UNIT / CREDIT / PROFIT ถูกนับเป็น IT
    return normalized_code == expected_code or bool(re.search(r"(?<![A-Z])IT(?![A-Z])", str(project_name or "").upper()))


def _fetch_po_raw_windows(company, from_date, to_date, page_size=100):
    """ดึง GetPurchasesOrderList ดิบจาก ECOUNT ทีละช่วงไม่เกิน 30 วัน ครบทุกหน้า

    คืนค่า (items, warnings): ช่วง/หน้าไหนล้มเหลวจะถูกบันทึกใน warnings แทนที่จะหยุดเงียบๆ
    (เดิม fallback ของค่าใช้จ่ายแผนก break ออกจากลูปทันทีที่ช่วงใดล้ม ทำให้ช่วงที่เหลือทั้งหมดหายไปโดยไม่เตือน)
    """
    warnings = []
    if not company.get("api_key"):
        return [], [f"ไม่สามารถโหลดข้อมูล {company['id']}: ไม่ได้ตั้งค่า API KEY"]

    session_id, host_url = get_ecount_session(company)
    if not session_id or not host_url:
        session_id, host_url = get_ecount_session(company, force_refresh=True)
    if not session_id or not host_url:
        return [], [f"ไม่สามารถเข้าสู่ระบบบริษัท {company['id']} ได้"]

    def request_page(page, range_from, range_to):
        url = f"{ecount_api_url(host_url, 'Purchases/GetPurchasesOrderList')}?SESSION_ID={session_id}"
        payload = {
            "PROD_CD": "",
            "CUST_CD": "",
            "ListParam": {
                "PAGE_CURRENT": page,
                "PAGE_SIZE": page_size,
                "BASE_DATE_FROM": range_from,
                "BASE_DATE_TO": range_to,
            },
        }
        return requests.post(url, json=payload, headers=ECOUNT_API_HEADERS, timeout=30)

    start_date = datetime.strptime(from_date, "%Y%m%d").date()
    end_date = datetime.strptime(to_date, "%Y%m%d").date()
    items = []
    current_date = start_date
    while current_date <= end_date:
        range_end = min(current_date + timedelta(days=29), end_date)
        range_from, range_to = current_date.strftime("%Y%m%d"), range_end.strftime("%Y%m%d")
        window_items = []
        page = 1
        while page <= 200:
            body, ok, last_err = {}, False, ""
            for attempt in range(3):
                try:
                    response = request_page(page, range_from, range_to)
                    try:
                        body = response.json()
                    except ValueError:
                        body = {}
                    if response.status_code == 200 and str(body.get("Status")) == "200":
                        ok = True
                        break
                    last_err = str(body.get("Error") or body.get("Errors") or f"HTTP {response.status_code}")[:200]
                except requests.RequestException as exc:
                    last_err = str(exc)[:200]
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    new_sid, new_host = get_ecount_session(company, force_refresh=True)
                    if new_sid and new_host:
                        session_id, host_url = new_sid, new_host
            if not ok:
                warnings.append(f"{company['id']} ช่วง {range_from}-{range_to} หน้า {page} ดึงไม่สำเร็จ: {last_err}")
                break

            data = body.get("Data", {}) or {}
            page_items = data.get("Result") or data.get("Datas") or data.get("List") or []
            if isinstance(page_items, dict):
                page_items = [page_items]
            if not isinstance(page_items, list):
                page_items = []
            window_items.extend(page_items)
            if not page_items:
                break
            total_raw = data.get("TotalCnt", data.get("TOTAL_CNT"))
            try:
                total_count = int(total_raw) if total_raw not in (None, "") else None
            except (TypeError, ValueError):
                total_count = None
            if total_count is not None:
                if len(window_items) >= total_count:
                    break
            elif len(page_items) < page_size:
                break
            page += 1
        items.extend(window_items)
        current_date = range_end + timedelta(days=1)

    unique_items, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            continue
        marker = repr(sorted((str(k), str(v)) for k, v in item.items()))
        if marker not in seen:
            seen.add(marker)
            unique_items.append(item)
    return unique_items, warnings


def fetch_company_it_po(company, from_date, to_date):
    """ดึงข้อมูลใบสั่งซื้อแผนก IT โดยแบ่งช่วงค้นหาไม่เกิน 31 วันตามข้อจำกัด ECOUNT"""
    try:
        items, fetch_warnings = _fetch_po_raw_windows(company, from_date, to_date)
        if not items and fetch_warnings:
            return [], "; ".join(fetch_warnings)

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

            # แมปสถานะให้ตรงกับ sync_worker.py (รองรับรหัส ECOUNT ทั้งแบบตัวอักษรและตัวเลข 9)
            p_flag_val = str(pick(item, "P_FLAG") or "").strip().upper()
            if p_flag_val in ("Y", "9", "COMPLETED", "CLOSED"):
                status_name_val = "ดำเนินการเสร็จแล้ว"
            elif p_flag_val in ("N", "0", "1", "PROGRESS", "PENDING"):
                status_name_val = "กำลังดำเนินการ"
            else:
                status_name_val = pick(item, "STATUS_DES", "CONFIRM_YN") or (f"สถานะ {p_flag_val}" if p_flag_val else "ไม่ระบุ")

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
                "p_flag": p_flag_val,
                "status_name": status_name_val,
            })

        return normalized, "; ".join(fetch_warnings)
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
    company_filter = validate_company_id(company_id)
    date_from_clean = validate_date_yyyymmdd(DATE_FROM, "DATE_FROM")
    date_to_clean = validate_date_yyyymmdd(DATE_TO, "DATE_TO")
    # ไม่ระบุวันที่ -> คำนวณยอดตั้งแต่ต้นปีปัจจุบัน (ทั้ง BigQuery และ fallback ECOUNT)
    date_from_clean, date_to_clean = default_expense_date_range(date_from_clean, date_to_clean)
    DATE_FROM, DATE_TO = date_from_clean, date_to_clean

    if client is not None:
        try:
            where_conditions = []
            query_params = []
            if company_filter != "ALL":
                where_conditions.append("UPPER(TRIM(company_id)) = @company_id")
                query_params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_filter))
            if date_from_clean:
                where_conditions.append(f"{ORD_DATE_SQL} >= @date_from")
                query_params.append(bigquery.ScalarQueryParameter("date_from", "STRING", date_from_clean))
            if date_to_clean:
                where_conditions.append(f"{ORD_DATE_SQL} <= @date_to")
                query_params.append(bigquery.ScalarQueryParameter("date_to", "STRING", date_to_clean))

            where_clause = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""
            
            query = f"""
                SELECT
                    company_id, po_no, CAST(ord_date AS STRING) AS ord_date,
                    pjt_cd, pjt_des, cust_cd, cust_des, prod_des,
                    qty, buy_amt, vat_amt, total_amt, pic_name, p_flag, status_name, updated_at
                FROM `{PROJECT_ID}.{DATASET_ID}.it_expenses`
                {where_clause}
                ORDER BY ord_date DESC
            """
            results = client.query(
                query, job_config=bigquery.QueryJobConfig(query_parameters=query_params)
            ).result()
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
                    "status_name": getattr(row, 'status_name', None),
                    "updated_at": row.updated_at.isoformat() if row.updated_at else None,
                })
            coverage_warnings = po_sync_coverage_warnings(company_filter, date_from_clean)
            return {
                "success": True,
                "total_items": len(items),
                "total_expense_amt": total_amount,
                "data": items,
                "warnings": coverage_warnings or None,
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


# --- MODULE 6: DEPARTMENT EXPENSES API (ค่าใช้จ่ายแยกตามแผนกใดก็ได้ ไม่ผูกตายตัวเหมือน IT) ---
#
# ต่างจาก IT Expenses (Module 5) ตรงที่ไม่ผูกรหัสแผนกตายตัวต่อบริษัท (IT_PROJECT_CODES) เพราะแต่ละ
# บริษัทมีรหัสแผนก (PJT_CD) ไม่ตรงกัน แต่ "ชื่อแผนก" (PJT_DES) ที่ผู้ใช้เห็นในเมนูใบสั่งซื้อของ ECOUNT
# มักสะกดตรงกันข้ามบริษัท จึงใช้จับคู่ด้วยชื่อแผนก (case-insensitive, trim) แทนรหัส ทำให้เลือกได้ทุกแผนก
# และรวมข้ามบริษัทได้เมื่อเลือก "ALL" โดยไม่ต้อง hardcode รหัสใหม่ทุกครั้งที่มีแผนกเพิ่ม

def _normalize_dept_name(name):
    return re.sub(r"\s+", " ", str(name or "").strip()).upper()


def _dept_key(pjt_cd, pjt_des):
    """คำนวณ 'คีย์แผนก' ตัวเดียวกับที่ /api/departments และ /api/department-expenses ใช้กลุ่ม/จับคู่:
    ถ้ามีชื่อแผนก (PJT_DES) ใช้ชื่อ, ถ้าไม่มีแต่มีรหัส (PJT_CD) ใช้ 'รหัสแผนก <รหัส>' แทน
    เพื่อไม่ให้ PO ที่ ECOUNT ไม่ได้ส่งชื่อแผนกมาด้วยหายไปจากรายการทั้งหมด"""
    des = str(pjt_des or "").strip()
    if des:
        return des
    cd = re.sub(r"\.0+$", "", str(pjt_cd or "").strip())
    if cd:
        return f"รหัสแผนก {cd}"
    return UNASSIGNED_PROJECT_LABEL


@app.get("/api/departments")
def get_departments(company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL")):
    """คืนรายชื่อแผนก (PJT_DES) ที่พบจริงในข้อมูลใบสั่งซื้อ ใช้ประกอบ dropdown เลือกแผนกในหน้าค่าใช้จ่ายแผนก"""
    if client is None:
        raise HTTPException(
            status_code=503,
            detail=f"BigQuery client unavailable. Check GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID='{PROJECT_ID}'.",
        )

    valid_ids = {c["id"] for c in COMPANIES}
    company_filter = (company_id or "ALL").upper().strip()
    if company_filter != "ALL" and company_filter not in valid_ids:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown company_id '{company_id}'. Expected one of: {', '.join(sorted(valid_ids))} or ALL.",
        )

    where_clause = ""
    query_params = []
    if company_filter != "ALL":
        where_clause = "WHERE UPPER(TRIM(company_id)) = @company_id"
        query_params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_filter))

    # หลาย PO ในระบบจริงไม่มี PJT_DES (ชื่อแผนก) จาก ECOUNT ติดมาด้วย มีแค่ PJT_CD (รหัส)
    # ถ้าไม่ fallback ไปใช้รหัสแทน แผนกเหล่านี้จะหายไปจาก dropdown ทั้งหมด (ดูเหมือน "ไม่มีแผนกให้เลือก")
    query = f"""
        WITH base AS (
            SELECT
                company_id,
                NULLIF(REGEXP_REPLACE(TRIM(CAST(pjt_cd AS STRING)), r'\\.0+$', ''), '') AS pjt_cd,
                {DEPT_KEY_SQL} AS dept_key
            FROM `{PROJECT_ID}.{DATASET_ID}.purchase_orders`
            {where_clause}
        ),
        keyed AS (
            SELECT *, UPPER(dept_key) AS dept_norm FROM base
        )
        SELECT
            dept_norm,
            ANY_VALUE(dept_key) AS department,
            ARRAY_AGG(DISTINCT company_id IGNORE NULLS) AS companies,
            ARRAY_AGG(DISTINCT pjt_cd IGNORE NULLS) AS codes,
            COUNT(*) AS po_count
        FROM keyed
        GROUP BY dept_norm
        ORDER BY IF(dept_norm = '{UNASSIGNED_PROJECT_LABEL}', 1, 0), department
    """
    try:
        job_config = bigquery.QueryJobConfig(query_parameters=query_params)
        results = client.query(query, job_config=job_config).result()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"BigQuery query failed: {exc}") from exc

    departments = [
        {
            "department": row.department,
            "companies": list(row.companies or []),
            "codes": list(row.codes or []),
            "po_count": row.po_count,
        }
        for row in results
    ]
    return {"success": True, "total": len(departments), "departments": departments}


def fetch_company_department_po(company, from_date, to_date, department):
    """เหมือน fetch_company_it_po แต่ match ด้วยชื่อแผนก (PJT_DES) แบบใดก็ได้ ไม่ผูกรหัสตายตัว"""
    target = _normalize_dept_name(department)

    try:
        items, fetch_warnings = _fetch_po_raw_windows(company, from_date, to_date)
        if not items and fetch_warnings:
            return [], "; ".join(fetch_warnings)

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

            pjt_cd = pick(item, "PJT_CD", "PROJECT_CD", "PROJECT_CODE", "PROJECT_NO")
            pjt_des = pick(item, "PJT_DES", "PROJECT_DES", "PROJECT_NAME", "PROJECT_NM")

            if _normalize_dept_name(_dept_key(pjt_cd, pjt_des)) != target:
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

            p_flag_val = str(pick(item, "P_FLAG") or "").strip().upper()
            if p_flag_val in ("Y", "9", "COMPLETED", "CLOSED"):
                status_name_val = "ดำเนินการเสร็จแล้ว"
            elif p_flag_val in ("N", "0", "1", "PROGRESS", "PENDING"):
                status_name_val = "กำลังดำเนินการ"
            else:
                status_name_val = pick(item, "STATUS_DES", "CONFIRM_YN") or (f"สถานะ {p_flag_val}" if p_flag_val else "ไม่ระบุ")

            normalized.append({
                "company_id": company["id"],
                "po_no": str(raw_po),
                "ord_date": po_date,
                "pjt_cd": pjt_cd,
                "pjt_des": pjt_des or (department if not (str(department).startswith("รหัสแผนก") or department == UNASSIGNED_PROJECT_LABEL) else ""),
                "cust_cd": pick(item, "CUST"),
                "cust_des": pick(item, "CUST_DES"),
                "prod_des": pick(item, "PROD_DES", "TTL_CTT"),
                "qty": number_value(pick(item, "QTY")),
                "buy_amt": number_value(pick(item, "BUY_AMT")),
                "vat_amt": number_value(pick(item, "VAT_AMT")),
                "total_amt": number_value(pick(item, "TOTAL_AMT")) or (number_value(pick(item, "BUY_AMT")) + number_value(pick(item, "VAT_AMT"))),
                "pic_name": pic_val,
                "p_flag": p_flag_val,
                "status_name": status_name_val,
            })

        return normalized, "; ".join(fetch_warnings)
    except Exception as e:
        return [], f"Exception [{company['id']}]: {str(e)}"


@app.get("/api/department-expenses")
@app.post("/api/department-expenses")
async def get_department_expenses(
    department: str = Query(..., description="ชื่อแผนกตรงตาม PJT_DES เช่น 'แผนกบัญชี'"),
    DATE_FROM: Optional[str] = Query(None),
    DATE_TO: Optional[str] = Query(None),
    company_id: Optional[str] = Query("ALL"),
):
    """เหมือน /api/it-expenses แต่เลือกแผนกได้เอง (จับคู่ด้วยชื่อแผนก ไม่ใช่รหัสตายตัว)"""
    if not department or not department.strip():
        raise HTTPException(status_code=400, detail="ต้องระบุพารามิเตอร์ department")
    company_id = validate_company_id(company_id)
    # ไม่ระบุวันที่ -> คำนวณยอดตั้งแต่ต้นปีปัจจุบัน (ทั้ง BigQuery และ fallback ECOUNT)
    DATE_FROM, DATE_TO = default_expense_date_range(
        validate_date_yyyymmdd(DATE_FROM, "DATE_FROM"),
        validate_date_yyyymmdd(DATE_TO, "DATE_TO"),
    )

    if client is not None:
        try:
            # ต้องใช้คีย์แผนกแบบเดียวกับ /api/departments (ชื่อแผนก ถ้ามี, ไม่งั้น fallback เป็น 'รหัสแผนก <รหัส>')
            # ไม่งั้น PO ที่ ECOUNT ไม่ได้ส่งชื่อแผนก (PJT_DES ว่าง) มาด้วยจะไม่ถูกจับคู่เลย แม้จะเลือกแผนกนั้นจาก dropdown แล้วก็ตาม
            where_conditions = ["UPPER(dept_key) = @department"]
            query_params = [bigquery.ScalarQueryParameter("department", "STRING", _normalize_dept_name(department))]
            if company_id and company_id != "ALL":
                where_conditions.append("UPPER(TRIM(company_id)) = @company_id")
                query_params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_id.upper().strip()))
            if DATE_FROM:
                clean_from = str(DATE_FROM).replace("-", "").replace("/", "")
                where_conditions.append(f"{ORD_DATE_SQL} >= @date_from")
                query_params.append(bigquery.ScalarQueryParameter("date_from", "STRING", clean_from))
            if DATE_TO:
                clean_to = str(DATE_TO).replace("-", "").replace("/", "")
                where_conditions.append(f"{ORD_DATE_SQL} <= @date_to")
                query_params.append(bigquery.ScalarQueryParameter("date_to", "STRING", clean_to))

            where_clause = f"WHERE {' AND '.join(where_conditions)}"
            query = f"""
                WITH base AS (
                    SELECT
                        company_id, po_no, ord_date,
                        pjt_cd, pjt_des, cust_cd, cust_des, prod_des,
                        qty, supply_amt, vat_amt, total_amt, pic, p_flag, status_name, updated_at,
                        UPPER({DEPT_KEY_SQL}) AS dept_key
                    FROM `{PROJECT_ID}.{DATASET_ID}.purchase_orders`
                )
                SELECT
                    company_id, po_no, CAST(ord_date AS STRING) AS ord_date,
                    pjt_cd, pjt_des, cust_cd, cust_des, prod_des,
                    qty, supply_amt, vat_amt, total_amt, pic, p_flag, status_name, updated_at
                FROM base
                {where_clause}
                ORDER BY ord_date DESC
            """
            job_config = bigquery.QueryJobConfig(query_parameters=query_params)
            results = client.query(query, job_config=job_config).result()
            items = []
            total_amount = 0.0
            for row in results:
                b_amt = float(row.supply_amt or 0)
                v_amt = float(row.vat_amt or 0)
                tot = float(row.total_amt or 0) if (row.total_amt and float(row.total_amt) > 0) else (b_amt + v_amt)
                total_amount += tot
                items.append({
                    "company_id": row.company_id,
                    "po_no": row.po_no,
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
                    "pic_name": row.pic,
                    "pic": row.pic,
                    "p_flag": row.p_flag,
                    "status_name": getattr(row, 'status_name', None),
                    "updated_at": row.updated_at.isoformat() if row.updated_at else None,
                })
            coverage_warnings = po_sync_coverage_warnings(company_id, DATE_FROM)
            return {
                "success": True,
                "total_items": len(items),
                "total_expense_amt": total_amount,
                "data": items,
                "warnings": coverage_warnings or None,
                "source": "bigquery",
            }
        except Exception as bq_err:
            print(f"⚠️ BigQuery Department Expenses query failed, falling back: {bq_err}")

    # Fallback: ดึงสดจาก ECOUNT (กรณี BigQuery ใช้งานไม่ได้)
    today = datetime.now()
    from_date = (DATE_FROM or (today - timedelta(days=365)).strftime("%Y%m%d")).replace("-", "").replace("/", "")
    to_date = (DATE_TO or today.strftime("%Y%m%d")).replace("-", "").replace("/", "")

    selected = [comp for comp in COMPANIES if company_id == "ALL" or comp["id"].upper() == company_id.upper()]

    tasks = [
        asyncio.to_thread(fetch_company_department_po, comp, from_date, to_date, department)
        for comp in selected
    ]
    results = await asyncio.gather(*tasks)

    all_items = []
    errors = []
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

    total_amount = sum(item.get("total_amt", 0.0) for item in all_items)
    return {
        "success": True,
        "total_items": len(all_items),
        "total_expense_amt": total_amount,
        "data": all_items,
        "warnings": errors if errors else None,
        "source": "ecount",
    }


@app.post("/api/sync-po")
@app.get("/api/sync-po")
async def sync_po_to_bigquery(days_back: Optional[int] = Query(None, ge=1, le=1500, description="ไม่ระบุ = ตั้งแต่ 1 ม.ค. ปีที่แล้ว")):
    """สั่งซิงค์ข้อมูลใบสั่งซื้อและค่าใช้จ่าย IT จาก ECOUNT ลง BigQuery ทันที"""
    if not fetch_all_company_po:
        raise HTTPException(status_code=500, detail="ฟังก์ชัน fetch_all_company_po ไม่พร้อมใช้งาน")
    try:
        res = await asyncio.to_thread(fetch_all_company_po, days_back=days_back)
        clear_bq_cache()
        warnings = res.get("warnings") or []
        message = f"ซิงค์ข้อมูลสำเร็จ (PO: {res.get('po_total', 0)} รายการ, IT: {res.get('it_total', 0)} รายการ)"
        if warnings:
            message += "\n⚠️ " + "\n⚠️ ".join(warnings)
        return {
            "success": True,
            "message": message,
            "warnings": warnings or None,
            "result": res
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ซิงค์ข้อมูลไม่สำเร็จ: {exc}")


@app.get("/api/project-expense-audit")
def project_expense_audit(
    company_id: str = Query("ALL"),
    DATE_FROM: Optional[str] = Query(None),
    DATE_TO: Optional[str] = Query(None),
):
    """ตรวจสอบยอดค่าใช้จ่ายรายโครงการ: ยอดรวมต่อบริษัท/โครงการ, ช่วงวันที่ที่มีข้อมูล, แถวที่ยอดเป็น 0,
    แถวที่อาจซ้ำ และผลการซิงค์ ECOUNT รอบล่าสุด — ใช้เทียบกับรายงานใบสั่งซื้อใน ECOUNT ได้ตรงๆ"""
    if client is None:
        raise HTTPException(status_code=503, detail="BigQuery client unavailable")
    company_filter = validate_company_id(company_id)
    date_from, date_to = default_expense_date_range(
        validate_date_yyyymmdd(DATE_FROM, "DATE_FROM"),
        validate_date_yyyymmdd(DATE_TO, "DATE_TO"),
    )

    conds = [f"{ORD_DATE_SQL} >= @date_from", f"{ORD_DATE_SQL} <= @date_to"]
    params = [
        bigquery.ScalarQueryParameter("date_from", "STRING", date_from),
        bigquery.ScalarQueryParameter("date_to", "STRING", date_to),
    ]
    if company_filter != "ALL":
        conds.append("UPPER(TRIM(company_id)) = @company_id")
        params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_filter))
    where_clause = "WHERE " + " AND ".join(conds)
    table = f"`{PROJECT_ID}.{DATASET_ID}.purchase_orders`"

    project_query = f"""
        WITH base AS (
            SELECT
                UPPER(TRIM(company_id)) AS company_id,
                {DEPT_KEY_SQL} AS dept_key,
                NULLIF(REGEXP_REPLACE(TRIM(CAST(pjt_cd AS STRING)), r'\\.0+$', ''), '') AS pjt_cd,
                po_no,
                COALESCE(supply_amt, 0) AS supply_amt,
                COALESCE(vat_amt, 0) AS vat_amt,
                {ROW_TOTAL_SQL} AS row_total
            FROM {table}
            {where_clause}
        ),
        keyed AS (
            SELECT *, UPPER(dept_key) AS dept_norm FROM base
        )
        SELECT
            company_id,
            dept_norm,
            ANY_VALUE(dept_key) AS project,
            ARRAY_AGG(DISTINCT pjt_cd IGNORE NULLS) AS codes,
            COUNT(*) AS row_count,
            COUNT(DISTINCT po_no) AS po_count,
            SUM(supply_amt) AS supply_amt,
            SUM(vat_amt) AS vat_amt,
            SUM(row_total) AS total_amt,
            COUNTIF(row_total = 0) AS zero_amount_rows
        FROM keyed
        GROUP BY company_id, dept_norm
        ORDER BY company_id, total_amt DESC
    """
    company_query = f"""
        WITH base AS (
            SELECT
                UPPER(TRIM(company_id)) AS company_id,
                {ORD_DATE_SQL} AS d,
                po_no, prod_des, qty, {ROW_TOTAL_SQL} AS row_total, updated_at
            FROM {table}
            {where_clause}
        ),
        dups AS (
            SELECT company_id, COUNT(*) AS dup_groups, SUM(c - 1) AS dup_extra_rows, SUM((c - 1) * row_total) AS dup_extra_amt
            FROM (
                SELECT company_id, po_no, d, prod_des, qty, row_total, COUNT(*) AS c
                FROM base GROUP BY company_id, po_no, d, prod_des, qty, row_total
            )
            WHERE c > 1
            GROUP BY company_id
        )
        SELECT
            b.company_id AS company_id,
            MIN(b.d) AS min_date,
            MAX(b.d) AS max_date,
            COUNT(*) AS row_count,
            SUM(b.row_total) AS total_amt,
            MAX(b.updated_at) AS last_updated,
            ANY_VALUE(x.dup_groups) AS dup_groups,
            ANY_VALUE(x.dup_extra_rows) AS dup_extra_rows,
            ANY_VALUE(x.dup_extra_amt) AS dup_extra_amt
        FROM base b
        LEFT JOIN dups x ON x.company_id = b.company_id
        GROUP BY b.company_id
        ORDER BY company_id
    """
    try:
        job_config = bigquery.QueryJobConfig(query_parameters=params)
        project_rows = list(client.query(project_query, job_config=job_config).result())
        company_rows = list(client.query(company_query, job_config=job_config).result())
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"BigQuery query failed: {exc}") from exc

    projects = [
        {
            "company_id": r.company_id,
            "project": r.project,
            "codes": list(r.codes or []),
            "row_count": r.row_count,
            "po_count": r.po_count,
            "supply_amt": float(r.supply_amt or 0),
            "vat_amt": float(r.vat_amt or 0),
            "total_amt": float(r.total_amt or 0),
            "zero_amount_rows": r.zero_amount_rows,
        }
        for r in project_rows
    ]
    companies = [
        {
            "company_id": r.company_id,
            "min_date": r.min_date,
            "max_date": r.max_date,
            "row_count": r.row_count,
            "total_amt": float(r.total_amt or 0),
            "last_updated": (r.last_updated.isoformat() if hasattr(r.last_updated, "isoformat") else str(r.last_updated)) if r.last_updated else None,
            "dup_groups": int(r.dup_groups or 0),
            "dup_extra_rows": int(r.dup_extra_rows or 0),
            "dup_extra_amt": float(r.dup_extra_amt or 0),
        }
        for r in company_rows
    ]
    sync_report = dict(LAST_PO_SYNC_REPORT or {})
    warnings = po_sync_coverage_warnings(company_filter, date_from)
    for c in companies:
        if c["dup_groups"]:
            warnings.append(
                f"{c['company_id']}: พบ {c['dup_groups']} กลุ่มแถวที่ข้อมูลเหมือนกันทุกอย่าง (PO/วันที่/สินค้า/จำนวน/ยอด) "
                f"รวม {c['dup_extra_rows']} แถวเกิน — ตรวจใน ECOUNT ว่าเป็นบรรทัดจริงหรือซ้ำ"
            )
    selected_ids = [c["id"] for c in COMPANIES if company_filter == "ALL" or c["id"] == company_filter]
    found_ids = {c["company_id"] for c in companies}
    for cid in selected_ids:
        if cid not in found_ids:
            warnings.append(f"{cid}: ไม่มีข้อมูล PO ใน BigQuery ช่วง {date_from}-{date_to}")

    return {
        "success": True,
        "date_from": date_from,
        "date_to": date_to,
        "grand_total_amt": sum(p["total_amt"] for p in projects),
        "projects": projects,
        "companies": companies,
        "last_sync": sync_report or None,
        "warnings": warnings or None,
    }


# ============================================================================
# MODULE: MTD & YTD SALE (นำเข้าไฟล์ Excel รายงานยอดขายจาก ECOUNT แล้ว "วางทับ"
# ข้อมูลเดิมของบริษัทนั้นใน BigQuery โดยอัตโนมัติ)
# ============================================================================

SALES_TABLE = "sales_transactions"

THAI_MONTHS = {
    "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
    "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
}

SALES_TABLE_SCHEMA = [
    bigquery.SchemaField("company_id", "STRING"),
    bigquery.SchemaField("transaction_date", "DATE"),
    bigquery.SchemaField("invoice_no", "STRING"),
    bigquery.SchemaField("product_group", "STRING"),
    bigquery.SchemaField("prod_cd", "STRING"),
    bigquery.SchemaField("prod_des", "STRING"),
    bigquery.SchemaField("vehicle_models", "STRING", mode="REPEATED"),
    bigquery.SchemaField("serial_lot", "STRING"),
    bigquery.SchemaField("customer_cd", "STRING"),
    bigquery.SchemaField("customer_name", "STRING"),
    bigquery.SchemaField("address", "STRING"),
    bigquery.SchemaField("qty", "FLOAT"),
    bigquery.SchemaField("unit", "STRING"),
    bigquery.SchemaField("unit_price", "FLOAT"),
    bigquery.SchemaField("amount", "FLOAT"),
    bigquery.SchemaField("technician", "STRING"),
    bigquery.SchemaField("project_name", "STRING"),
    bigquery.SchemaField("credit", "STRING"),
    bigquery.SchemaField("delivery_date", "DATE"),
    bigquery.SchemaField("warehouse_name", "STRING"),
    bigquery.SchemaField("location_name", "STRING"),
    bigquery.SchemaField("doc_type", "STRING"),      # ประเภทเอกสาร/ประเภทการขาย จากไฟล์ (ถ้ามีคอลัมน์นี้)
    bigquery.SchemaField("is_return", "BOOLEAN"),    # True = ใบลดหนี้ / รับคืนสินค้า (ดู classify_sales_return)
    bigquery.SchemaField("source_file", "STRING"),
    bigquery.SchemaField("uploaded_at", "TIMESTAMP"),
]

# ----------------------------------------------------------------------
# การแยกรายการ "ใบลดหนี้ / รับคืนสินค้า" (Credit Note / Sales Return)
# ----------------------------------------------------------------------
# ยอดขาย MTD/YTD แยกเป็น:
#   gross   = ยอดขายก่อนหักรับคืน (รวมเฉพาะรายการขายปกติ)
#   returns = ยอดรับคืน/ลดหนี้ (เก็บเป็นค่าบวกเสมอ ไม่ว่าในไฟล์จะเป็นเลขบวกหรือติดลบ)
#   net     = gross - returns
# ตัวเลขหลักที่แสดง (amount) = gross เพื่อไม่ให้ยอด MTD ติดลบช่วงต้นเดือนเมื่อมีใบลดหนี้ของเดือนก่อนเข้ามา
# รายการถือเป็นรับคืนถ้า: จำนวนเงินติดลบ / จำนวนติดลบ / หรือคอลัมน์ประเภทเอกสาร-เลขที่ใบขายมีคำด้านล่าง
SALES_RETURN_KEYWORDS = ["ลดหนี้", "รับคืน", "คืนสินค้า", "ส่งคืน", "CREDIT NOTE", "CREDIT-NOTE", "SALES RETURN"]


def classify_sales_return(amount, qty, doc_type=None, invoice_no=None):
    """ตัดสินว่ารายการขายนี้เป็นใบลดหนี้/รับคืนหรือไม่ (ใช้ตอนอ่านไฟล์ Excel)"""
    if (amount or 0) < 0 or (qty or 0) < 0:
        return True
    text = f"{doc_type or ''} {invoice_no or ''}".upper()
    return any(k.upper() in text for k in SALES_RETURN_KEYWORDS)


def sales_return_sql_expr(table_obj):
    """นิพจน์ SQL (BOOL) ว่าแถวไหนเป็นรายการรับคืน — ทนทานกับตารางเก่าที่ยังไม่มีคอลัมน์ is_return
    (คอลัมน์จะถูกเพิ่มอัตโนมัติเมื่ออัปโหลดไฟล์ใหม่ทับ ระหว่างนี้ใช้เกณฑ์ยอด/จำนวนติดลบแทน)"""
    has_is_return = any(f.name == "is_return" for f in table_obj.schema)
    expr = "(IFNULL(amount, 0) < 0 OR IFNULL(qty, 0) < 0"
    if has_is_return:
        expr += " OR IFNULL(is_return, FALSE)"
    return expr + ")"


def sales_amount_sql(ret_expr, cond="TRUE"):
    """คืน SQL 3 ตัว (gross, returns, net) ของ amount ภายใต้เงื่อนไข cond"""
    gross = f"IFNULL(SUM(IF(({cond}) AND NOT {ret_expr}, amount, 0)), 0)"
    returns = f"IFNULL(SUM(IF(({cond}) AND {ret_expr}, ABS(amount), 0)), 0)"
    return gross, returns, f"({gross} - {returns})"

# ตัวอย่างชื่อสินค้าที่มีรุ่นรถฝังอยู่ในวงเล็บ: "ใบมีดตัดดิน 1.60 ม. (มีสอง) รุ่น EF [EF393T ,EF352T]"
# ดึงรหัสรุ่นทุกตัวที่อยู่ในวงเล็บ [...] ออกมาเป็นลิสต์ (สินค้าหนึ่งตัวอาจใช้ได้กับหลายรุ่น)
VEHICLE_MODEL_PATTERN = re.compile(r"\[([^\]]+)\]")


def extract_vehicle_models(prod_des):
    """ดึงรหัสรุ่นรถที่ฝังอยู่ในวงเล็บ [] ของชื่อสินค้า เช่น '...รุ่น EF [EF393T ,EF352T]' -> ['EF393T', 'EF352T']"""
    if not prod_des:
        return []
    models = []
    for bracket_group in VEHICLE_MODEL_PATTERN.findall(prod_des):
        for code in re.split(r"[,/]", bracket_group):
            code = code.strip()
            if code:
                models.append(code)
    # เอาตัวซ้ำออกแต่คงลำดับเดิมไว้
    seen = set()
    unique_models = []
    for m in models:
        if m not in seen:
            seen.add(m)
            unique_models.append(m)
    return unique_models


def parse_thai_date(value):
    """แปลงวันที่ให้เป็น date แบบ ค.ศ. ให้ทนทานต่อรูปแบบที่ ECOUNT export ออกมาไม่เหมือนกันในแต่ละครั้ง
       รองรับทุกรูปแบบที่เคยเจอ (และรูปแบบใกล้เคียงที่อาจเจอในอนาคต):
       1) Excel date object / datetime ตรงๆ (กรณีคอลัมน์ถูก format เป็นวันที่ในไฟล์)
       2) เลข serial date ของ Excel (กรณีคอลัมน์เป็น General แต่เก็บเป็นตัวเลขวันที่)
       3) ตัวเลขล้วน 8 หลัก แบบ ค.ศ. เช่น '20260102' (YYYYMMDD)
       4) รูปแบบ YYYY-MM-DD หรือ YYYY/MM/DD (ค.ศ.)
       5) รูปแบบ DD/MM/YYYY หรือ DD-MM-YYYY (ตรวจสอบเองว่าปีเป็น พ.ศ. หรือ ค.ศ. จากขนาดของปี)
       6) ข้อความไทยแบบเดือนย่อ เช่น '01 ม.ค. 2569' (พ.ศ. เต็ม 4 หลัก) หรือ '01 ม.ค. 69' (พ.ศ. 2 หลัก)
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    # กรณีคอลัมน์เก็บเป็นตัวเลข serial date ของ Excel (epoch 1899-12-30)
    if isinstance(value, (int, float)):
        try:
            return (datetime(1899, 12, 30) + timedelta(days=float(value))).date()
        except (OverflowError, ValueError, OSError):
            return None

    text = str(value).strip()
    if not text:
        return None

    def _resolve_year(y):
        # ปี พ.ศ. เต็ม 4 หลัก (>2400) แปลงเป็น ค.ศ. / ปี พ.ศ. แบบ 2 หลัก (เช่น 69 = พ.ศ. 2569) แปลงเป็น ค.ศ. / อื่นๆ ถือว่าเป็น ค.ศ. อยู่แล้ว
        if y > 2400:
            return y - 543
        if y < 100:
            return 1957 + y  # สมมติฐาน: ปี พ.ศ. 2 หลักอยู่ในช่วง พ.ศ. 2500-2599 (ค.ศ. 1957-2056)
        return y

    # รูปแบบ 3: ตัวเลขล้วน 8 หลัก (ค.ศ.) เช่น 20260102
    if re.fullmatch(r"\d{8}", text):
        try:
            return datetime.strptime(text, "%Y%m%d").date()
        except ValueError:
            return None

    # รูปแบบ 4: YYYY-MM-DD หรือ YYYY/MM/DD
    m = re.fullmatch(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", text)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return date(y, mo, d)
        except ValueError:
            return None

    # รูปแบบ 5: DD-MM-YYYY หรือ DD/MM/YYYY (พ.ศ. หรือ ค.ศ. ก็ได้)
    m = re.fullmatch(r"(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})", text)
    if m:
        d, mo, y_raw = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return date(_resolve_year(y_raw), mo, d)
        except ValueError:
            return None

    # รูปแบบ 6: ข้อความไทยแบบเดือนย่อ เช่น '01 ม.ค. 2569' หรือ '01 ม.ค. 69'
    parts = text.split()
    if len(parts) >= 3:
        try:
            day = int(parts[0])
            year_raw = int(parts[2])
        except ValueError:
            return None
        month = THAI_MONTHS.get(parts[1].strip())
        if not month:
            return None
        try:
            return date(_resolve_year(year_raw), month, day)
        except ValueError:
            return None

    return None


def _cell_str(value):
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def _cell_float(value):
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        pass
    try:
        return float(str(value).replace(",", "").replace("\u200b", "").strip())
    except (TypeError, ValueError):
        return None


def _normalize_header(text):
    """ทำความสะอาดข้อความหัวตาราง (ตัด zero-width space / เว้นวรรคหัวท้ายออก) เพื่อเทียบชื่อคอลัมน์ได้แม่นยำ"""
    if text is None:
        return ""
    return str(text).replace("\u200b", "").strip()


def _find_header_column(header_map, must_contain=None, must_not_contain=None, exact=None):
    """หา column index จาก header_map ({col_index: normalized_header_text}) ด้วยชื่อคอลัมน์ที่ยืดหยุ่น
    (contains แทน exact match) เพื่อให้ทนทานต่อไฟล์ ECOUNT ที่แต่ละบริษัท/แต่ละครั้ง export
    โครงสร้างคอลัมน์ไม่เหมือนกันทุกตัวอักษร"""
    if exact:
        for idx, h in header_map.items():
            if h == exact:
                return idx
    if must_contain:
        for idx, h in header_map.items():
            if all(token in h for token in must_contain):
                if must_not_contain and any(token in h for token in must_not_contain):
                    continue
                return idx
    return None


# ======================================================================
# รูปแบบไฟล์ยอดขาย "แยกตามบริษัท" (Sales file profiles)
# ----------------------------------------------------------------------
# แต่ละบริษัท export รายงานสถานะการขายจาก ECOUNT ออกมาไม่เหมือนกัน จึงกำหนดรูปแบบแยกกันชัดเจน:
#   - ASIA        : 8 คอลัมน์ตายตัว  A=วันที่-ลำดับ (หัวคอลัมน์ ECOUNT ตั้งชื่อว่า 'เก็บเงินปลายทาง-No.'
#                   ค่าเป็น '20260105-1'), B=ชื่อสินค้า, C=ชื่อลูกค้า/ผู้ขาย, D=จำนวน, E=ราคาต่อหน่วย,
#                   F=จำนวนเงิน, G=ภาษี, H=ยอดรวม  (ไม่มีรหัสสินค้า/เลขที่ใบขาย/กลุ่มสินค้า)
#   - RUAMSINTHAI : ~20 คอลัมน์ อ่านตามชื่อหัวตาราง (รูปแบบเดิมที่ใช้งานได้อยู่แล้ว)
#   - ROBOTICS    : อ่านตามชื่อหัวตาราง (ยังไม่มีไฟล์ตัวอย่าง — ถ้า format ต่างออกไป ให้เพิ่ม fixed_columns)
#
# fixed_columns  = ตำแหน่งคอลัมน์ตายตัว (1-based) ใช้ก่อนเสมอ ถ้าหัวคอลัมน์ตรงกับ fixed_header_check
#                  ถ้าไม่ตรง (ECOUNT เปลี่ยนลำดับคอลัมน์) จะ fallback ไปอ่านตามชื่อหัวตารางอัตโนมัติ
# header_aliases = ชื่อหัวคอลัมน์เพิ่มเติมเฉพาะบริษัทนั้น (เทียบแบบ contains หลังตัด zero-width space)
# company_name_keywords = คำที่ต้องเจอในชื่อบริษัทแถวที่ 1 ของไฟล์ ใช้กันอัปโหลดไฟล์ผิดบริษัท
#                  (การอัปโหลดจะ "วางทับ" ข้อมูลเดิมของบริษัทที่เลือก ถ้าเลือกผิดข้อมูลจะหายทั้งบริษัท)
# ======================================================================
SALES_PARSER_VERSION = "sales-parser-2026-10-01-returns-v3"

SALES_FILE_PROFILES = {
    "ASIA": {
        "label": "ASIA (8 คอลัมน์ตายตัว)",
        "header_row": 2,
        "company_name_keywords": ["เอเชีย", "ASIA"],
        "fixed_columns": {
            "date_seq": 1,
            "prod_des": 2,
            "customer_name": 3,
            "qty": 4,
            "unit_price": 5,
            "amount": 6,
        },
        "fixed_header_check": {2: "ชื่อสินค้า", 3: "ลูกค้า", 4: "จำนวน", 6: "จำนวนเงิน"},
        "header_aliases": {
            "date_seq": ["เก็บเงินปลายทาง-No", "-No"],
        },
    },
    "RUAMSINTHAI": {
        "label": "RUAMSINTHAI (อ่านตามหัวตาราง)",
        "header_row": 2,
        "company_name_keywords": ["รวมสินไทย", "RUAMSINTHAI"],
        "fixed_columns": None,
        "fixed_header_check": None,
        "header_aliases": {},
    },
    "ROBOTICS": {
        "label": "ROBOTICS (อ่านตามหัวตาราง)",
        "header_row": 2,
        "company_name_keywords": ["โรโบ", "ROBOTIC"],
        "fixed_columns": None,
        "fixed_header_check": None,
        "header_aliases": {},
    },
}

# ค่าในคอลัมน์ "วันที่-ลำดับ" เช่น '20260105-1' หรือ '01 ม.ค. 2569 -1'
DATE_SEQ_VALUE_PATTERN = re.compile(r"^\s*(\d{8}|\d{1,2}\s+\S+\s+\d{2,4})\s*-\s*\d+\s*$")


def _read_header_map(ws, header_row):
    header_map = {}
    for c in range(1, ws.max_column + 1):
        text = _normalize_header(ws.cell(row=header_row, column=c).value)
        if text:
            header_map[c] = text
    return header_map


def build_sales_column_map(ws, header_row=2, header_aliases=None):
    """สแกนหัวตารางแล้วจับคู่ชื่อคอลัมน์ที่พบจริงเข้ากับฟิลด์มาตรฐาน (โหมดอัตโนมัติ)
    ใช้กับบริษัทที่ไม่มี fixed_columns และเป็น fallback ของบริษัทที่มี fixed_columns"""
    header_map = _read_header_map(ws, header_row)

    col_map = {
        "date_seq": _find_header_column(header_map, must_contain=["วันที่-ลำดับ"]),
        "date": (
            _find_header_column(header_map, exact="วันที่")
            or _find_header_column(header_map, must_contain=["วันที่"], must_not_contain=["ลำดับ", "ส่งมอบ"])
        ),
        "invoice_no": _find_header_column(header_map, must_contain=["เลขที่ใบขาย"]),
        "product_group": _find_header_column(header_map, must_contain=["กลุ่มสินค้า"]),
        "prod_cd": _find_header_column(header_map, must_contain=["รหัส", "สินค้า"], must_not_contain=["ลูกค้า", "ผู้ขาย"]),
        "prod_des": _find_header_column(header_map, must_contain=["ชื่อสินค้า"]),
        "serial_lot": (
            _find_header_column(header_map, must_contain=["Serial"])
            or _find_header_column(header_map, must_contain=["Lot"])
        ),
        "customer_cd": _find_header_column(header_map, must_contain=["รหัส", "ลูกค้า"]),
        "customer_name": (
            _find_header_column(header_map, must_contain=["ชื่อลูกค้า"])
            or _find_header_column(header_map, must_contain=["ลูกค้า", "ผู้ขาย"], must_not_contain=["รหัส"])
        ),
        "address": _find_header_column(header_map, must_contain=["ที่อยู่"]),
        "qty": (
            _find_header_column(header_map, exact="จำนวน")
            or _find_header_column(header_map, must_contain=["จำนวน"], must_not_contain=["เงิน"])
        ),
        "unit": _find_header_column(header_map, exact="หน่วย"),
        "unit_price": _find_header_column(header_map, must_contain=["ราคา", "หน่วย"]),
        "amount": _find_header_column(header_map, must_contain=["จำนวนเงิน"]),
        "technician": _find_header_column(header_map, must_contain=["ผู้รับผิดชอบ"]),
        "project_name": _find_header_column(header_map, must_contain=["ชื่อโครงการ"]),
        "credit": _find_header_column(header_map, must_contain=["สินเชื่อ"]),
        "delivery_date": _find_header_column(header_map, must_contain=["วันที่ส่งมอบ"]),
        "warehouse_name": (
            _find_header_column(header_map, must_contain=["คลังเบิกขาย"])
            or _find_header_column(header_map, must_contain=["คลัง"])
        ),
        "location_name": _find_header_column(header_map, must_contain=["ชื่อสถานที่"]),
        "doc_type": (
            _find_header_column(header_map, must_contain=["ประเภท"], must_not_contain=["สินค้า", "ลูกค้า", "ภาษี"])
            or _find_header_column(header_map, must_contain=["ชนิดเอกสาร"])
        ),
    }

    # ชื่อหัวคอลัมน์เพิ่มเติมเฉพาะบริษัท (ใช้เติมเฉพาะฟิลด์ที่ยังหาไม่เจอ)
    for field, aliases in (header_aliases or {}).items():
        if col_map.get(field):
            continue
        for alias in aliases:
            idx = _find_header_column(header_map, must_contain=[alias])
            if idx:
                col_map[field] = idx
                break

    return col_map


def _detect_date_seq_column_by_content(ws, header_row, sample_rows=30):
    """กันพลาดขั้นสุดท้าย: ถ้าหาคอลัมน์วันที่จากชื่อหัวตารางไม่เจอ ให้ดูจาก "ค่าในเซลล์" แทน
    คอลัมน์ไหนมีค่ารูปแบบ '20260105-1' มากที่สุด ถือว่าเป็นคอลัมน์วันที่-ลำดับ"""
    best_col, best_hits = None, 0
    last_row = min(ws.max_row, header_row + sample_rows)
    for c in range(1, ws.max_column + 1):
        hits = 0
        for r in range(header_row + 1, last_row + 1):
            v = ws.cell(row=r, column=c).value
            if v is not None and DATE_SEQ_VALUE_PATTERN.match(str(v)):
                hits += 1
        if hits > best_hits:
            best_col, best_hits = c, hits
    return best_col if best_hits >= 3 else None


def resolve_sales_column_map(ws, company_id):
    """เลือกวิธีอ่านคอลัมน์ตาม profile ของบริษัท คืน (col_map, header_row, mode_label)"""
    profile = SALES_FILE_PROFILES.get(company_id) or {}
    header_row = profile.get("header_row", 2)
    label = profile.get("label", company_id)

    fixed = profile.get("fixed_columns")
    if fixed:
        header_map = _read_header_map(ws, header_row)
        checks = profile.get("fixed_header_check") or {}
        if all(token in header_map.get(col, "") for col, token in checks.items()):
            col_map = {key: None for key in (
                "date_seq", "date", "invoice_no", "product_group", "prod_cd", "prod_des", "serial_lot",
                "customer_cd", "customer_name", "address", "qty", "unit", "unit_price", "amount",
                "technician", "project_name", "credit", "delivery_date", "warehouse_name", "location_name", "doc_type",
            )}
            col_map.update(fixed)
            return col_map, header_row, f"{label}"
        label = f"{label} → หัวคอลัมน์ไม่ตรงรูปแบบตายตัว ใช้การอ่านตามหัวตารางแทน"

    col_map = build_sales_column_map(ws, header_row=header_row, header_aliases=profile.get("header_aliases"))
    if not col_map.get("date") and not col_map.get("date_seq"):
        col_map["date_seq"] = _detect_date_seq_column_by_content(ws, header_row)
    return col_map, header_row, label


def check_sales_file_company(detected_company_name, company_id):
    """กันอัปโหลดไฟล์ผิดบริษัท: ถ้าชื่อบริษัทในไฟล์ตรงกับบริษัทอื่นชัดเจน (และไม่ตรงกับบริษัทที่เลือก) ให้ปฏิเสธ
    เพราะการอัปโหลดจะลบข้อมูลยอดขายเดิมของบริษัทที่เลือกทิ้งทั้งหมด"""
    if not detected_company_name:
        return
    name_upper = detected_company_name.upper()

    def _matches(cid):
        keywords = (SALES_FILE_PROFILES.get(cid) or {}).get("company_name_keywords") or []
        return any(k.upper() in name_upper for k in keywords)

    if _matches(company_id):
        return
    other = [cid for cid in SALES_FILE_PROFILES if cid != company_id and _matches(cid)]
    if other:
        raise ValueError(
            f"ไฟล์นี้เป็นของบริษัท '{detected_company_name}' (ตรงกับ {', '.join(other)}) "
            f"แต่เลือกบริษัท {company_id} ไว้ — กรุณาเลือกบริษัทให้ตรงกับไฟล์ก่อนอัปโหลด "
            f"(ระบบหยุดไว้ก่อนเพื่อไม่ให้ข้อมูลยอดขายของ {company_id} ถูกวางทับผิดบริษัท)"
        )


def _col_val(ws, row, col_map, key):
    """อ่านค่าเซลล์ตามคอลัมน์ที่ map ไว้ คืน None ถ้าไม่มีคอลัมน์นี้ในไฟล์ (บริษัทนั้นไม่มีข้อมูลฟิลด์นี้)"""
    col = col_map.get(key)
    if not col:
        return None
    return ws.cell(row=row, column=col).value


def parse_date_seq(value):
    """แปลงค่าคอลัมน์ 'วันที่-ลำดับ' (เช่น '20260105-1' หรือ '01 ม.ค. 2569 -1') เป็นวันที่
    โดยตัดเลขลำดับท้ายสุด (-N) ออกก่อน แล้วส่งส่วนวันที่ไปให้ parse_thai_date ตามปกติ"""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    m = re.match(r"^(.*?)-(\d+)$", text)
    date_part = m.group(1).strip() if m else text
    return parse_thai_date(date_part)


def parse_sales_excel(file_bytes: bytes, company_id: str, source_filename: str):
    """
    อ่านไฟล์ 'รายงานสถานะการขาย' ที่ Export จาก ECOUNT (.xlsx) ตามรูปแบบของแต่ละบริษัท (SALES_FILE_PROFILES)

    แถวหัวตาราง, แถวสรุปยอดรายเดือน ("... รวม") และแถวสรุปทั้งหมด/timestamp ท้ายไฟล์
    จะไม่มี "ชื่อสินค้า" จึงใช้เป็นตัวกรองแถวข้อมูลจริง
    """
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
    ws = wb[wb.sheetnames[0]]

    detected_company_name = None
    header_text = ws.cell(row=1, column=1).value
    if header_text:
        detected_company_name = str(header_text).split("/")[0].replace("ชื่อบริษัท", "").strip(" :")

    check_sales_file_company(detected_company_name, company_id)

    col_map, header_row, profile_label = resolve_sales_column_map(ws, company_id)

    if not col_map.get("prod_des") or not col_map.get("amount"):
        raise ValueError(
            f"ไม่พบคอลัมน์ 'ชื่อสินค้า' หรือ 'จำนวนเงิน' ในไฟล์นี้ (รูปแบบ {profile_label}) — "
            f"กรุณาตรวจสอบว่าแถวที่ {header_row} ของไฟล์เป็นหัวตารางจริงหรือไม่"
        )
    if not col_map.get("date") and not col_map.get("date_seq"):
        raise ValueError(
            f"ไม่พบคอลัมน์วันที่ในไฟล์นี้ (รูปแบบ {profile_label}) — ไฟล์ต้องมีคอลัมน์ 'วันที่' "
            f"หรือคอลัมน์ 'วันที่-ลำดับ' ที่มีค่าแบบ 20260105-1"
        )

    now_iso = datetime.utcnow().isoformat()
    rows = []
    skipped_structure = 0   # แถวหัวตาราง / แถวสรุปยอด(รวม) / แถว timestamp ท้ายไฟล์ — ปกติ ไม่ใช่ปัญหา
    skipped_date_error = 0  # แถวข้อมูลขายจริง (มีชื่อสินค้า+จำนวนเงิน) แต่แปลงวันที่ไม่ได้ — ผิดปกติ ต้องแจ้งเตือน
    unparsed_date_samples = []

    for r in range(header_row + 1, ws.max_row + 1):
        prod_des_raw = _col_val(ws, r, col_map, "prod_des")
        amount_raw = _col_val(ws, r, col_map, "amount")
        if not prod_des_raw or amount_raw in (None, ""):
            skipped_structure += 1
            continue

        # หาวันที่: ใช้คอลัมน์ "วันที่" โดยตรงถ้ามี ไม่งั้น derive จาก "วันที่-ลำดับ"
        date_val = _col_val(ws, r, col_map, "date")
        if date_val is not None:
            tdate = parse_thai_date(date_val)
            raw_date_display = date_val
        else:
            date_seq_val = _col_val(ws, r, col_map, "date_seq")
            tdate = parse_date_seq(date_seq_val)
            raw_date_display = date_seq_val

        if not tdate:
            skipped_date_error += 1
            if len(unparsed_date_samples) < 5:
                unparsed_date_samples.append(f"แถว {r}: '{raw_date_display}'")
            continue

        # เลขที่ใบขาย: ใช้คอลัมน์ตรงถ้ามี ไม่งั้นใช้ "วันที่-ลำดับ" ทั้งสตริงเป็นรหัสอ้างอิงใบขายแทน
        invoice_no_val = _col_val(ws, r, col_map, "invoice_no")
        if not invoice_no_val:
            invoice_no_val = _col_val(ws, r, col_map, "date_seq")

        delivery_date_val = parse_thai_date(_col_val(ws, r, col_map, "delivery_date"))
        amount_val = _cell_float(amount_raw)
        qty_val = _cell_float(_col_val(ws, r, col_map, "qty"))
        doc_type_val = _cell_str(_col_val(ws, r, col_map, "doc_type"))

        rows.append({
            "company_id": company_id,
            "transaction_date": tdate.isoformat(),
            "invoice_no": _cell_str(invoice_no_val),
            "product_group": _cell_str(_col_val(ws, r, col_map, "product_group")),
            "prod_cd": _cell_str(_col_val(ws, r, col_map, "prod_cd")),
            "prod_des": _cell_str(prod_des_raw),
            "vehicle_models": extract_vehicle_models(_cell_str(prod_des_raw)),
            "serial_lot": _cell_str(_col_val(ws, r, col_map, "serial_lot")),
            "customer_cd": _cell_str(_col_val(ws, r, col_map, "customer_cd")),
            "customer_name": _cell_str(_col_val(ws, r, col_map, "customer_name")),
            "address": _cell_str(_col_val(ws, r, col_map, "address")),
            "qty": qty_val,
            "unit": _cell_str(_col_val(ws, r, col_map, "unit")),
            "unit_price": _cell_float(_col_val(ws, r, col_map, "unit_price")),
            "amount": amount_val,
            "technician": _cell_str(_col_val(ws, r, col_map, "technician")),
            "project_name": _cell_str(_col_val(ws, r, col_map, "project_name")),
            "credit": _cell_str(_col_val(ws, r, col_map, "credit")),
            "delivery_date": (delivery_date_val.isoformat() if delivery_date_val else None),
            "warehouse_name": _cell_str(_col_val(ws, r, col_map, "warehouse_name")),
            "location_name": _cell_str(_col_val(ws, r, col_map, "location_name")),
            "doc_type": doc_type_val,
            "is_return": classify_sales_return(amount_val, qty_val, doc_type_val, _cell_str(invoice_no_val)),
            "source_file": source_filename,
            "uploaded_at": now_iso,
        })

    return rows, detected_company_name, skipped_structure, skipped_date_error, unparsed_date_samples, profile_label


@app.get("/api/sales/parser-info")
def get_sales_parser_info():
    """เช็คว่าเซิร์ฟเวอร์รันโค้ดอ่านไฟล์ยอดขายเวอร์ชันไหนอยู่ (ใช้ยืนยันหลัง deploy/restart)"""
    return {
        "parser_version": SALES_PARSER_VERSION,
        "profiles": {cid: p.get("label") for cid, p in SALES_FILE_PROFILES.items()},
    }


@app.post("/api/sales/upload")
async def upload_sales_excel(
    company_id: str = Form(..., description="ASIA, ROBOTICS หรือ RUAMSINTHAI"),
    file: UploadFile = File(...),
):
    """
    รับไฟล์ Excel รายงานยอดขาย (Export จาก ECOUNT) แล้ว "วางทับ" ข้อมูลเดิมของบริษัทนี้
    ใน BigQuery ทั้งหมดด้วยข้อมูลชุดใหม่ (ลบของเดิมเฉพาะบริษัทนี้ทิ้ง แล้วโหลดชุดใหม่เข้าไปแทน)
    """
    valid_ids = [c["id"] for c in COMPANIES]
    if company_id not in valid_ids:
        raise HTTPException(status_code=400, detail=f"company_id ต้องเป็นหนึ่งใน {valid_ids}")

    if client is None:
        raise HTTPException(status_code=500, detail="BigQuery client ไม่พร้อมใช้งาน กรุณากดปุ่มเชื่อมต่อ BigQuery ใหม่")

    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="รองรับเฉพาะไฟล์ .xlsx ที่ Export จาก ECOUNT เท่านั้น")

    content = await file.read()

    try:
        rows, detected_company_name, skipped_structure, skipped_date_error, unparsed_samples, profile_label = await asyncio.to_thread(
            parse_sales_excel, content, company_id, file.filename
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"ไม่สามารถอ่านไฟล์ Excel ได้: {exc}")

    if not rows:
        detail = f"ไม่พบแถวข้อมูลรายการขายที่อ่านได้ในไฟล์นี้ (รูปแบบ {profile_label}, {SALES_PARSER_VERSION}) กรุณาตรวจสอบรูปแบบไฟล์"
        if skipped_date_error > 0:
            detail += f" (พบ {skipped_date_error} แถวที่มีข้อมูลขายแต่แปลงวันที่ไม่ได้ เช่น {'; '.join(unparsed_samples)})"
        raise HTTPException(status_code=400, detail=detail)

    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{SALES_TABLE}"

    # 1) ลบข้อมูลเก่าของบริษัทนี้ทิ้งก่อน (ถ้าตารางมีอยู่แล้ว) เพื่อ "วางทับ" ด้วยข้อมูลชุดใหม่
    try:
        client.get_table(table_ref)
        client.query(
            f"DELETE FROM `{table_ref}` WHERE company_id = @company_id",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("company_id", "STRING", company_id)]
            ),
        ).result()
    except Exception:
        pass  # ตารางยังไม่เคยถูกสร้าง จะถูกสร้างใหม่จากการโหลดข้อมูลรอบนี้เลย

    # 2) โหลดข้อมูลชุดใหม่เข้าไปแทน
    # ใส่ schema_update_options=ALLOW_FIELD_ADDITION เพื่อให้ BigQuery เพิ่มคอลัมน์ใหม่ให้ตารางเดิมได้อัตโนมัติ
    # (เช่น vehicle_models ที่เพิ่มเข้ามาทีหลัง) ไม่งั้น WRITE_APPEND จะ error ถ้า schema ไม่ตรงกับตารางเดิมเป๊ะ
    job_config = bigquery.LoadJobConfig(
        write_disposition="WRITE_APPEND",
        schema=SALES_TABLE_SCHEMA,
        schema_update_options=[bigquery.SchemaUpdateOption.ALLOW_FIELD_ADDITION],
    )
    try:
        client.load_table_from_json(rows, table_ref, job_config=job_config).result()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"บันทึกข้อมูลลง BigQuery ไม่สำเร็จ: {exc}")

    total_amount = sum(r["amount"] or 0 for r in rows)
    return_rows = [r for r in rows if r.get("is_return")]
    total_returns = sum(abs(r["amount"] or 0) for r in return_rows)
    total_gross = sum(r["amount"] or 0 for r in rows if not r.get("is_return"))
    dates = [r["transaction_date"] for r in rows if r["transaction_date"]]

    warning = None
    if skipped_date_error > 0:
        warning = (
            f"⚠️ พบ {skipped_date_error} แถวที่มีเลขที่ใบขาย/รหัสสินค้า แต่ไม่สามารถแปลงวันที่ได้ "
            f"จึงถูกข้ามไป (ระบบไม่รู้จักรูปแบบวันที่นี้) ตัวอย่าง: {'; '.join(unparsed_samples)} "
            f"— กรุณาแจ้งทีมพัฒนาให้เพิ่มรูปแบบวันที่นี้ในโค้ด"
        )

    return {
        "success": True,
        "message": (
            f"นำเข้าข้อมูลสำเร็จ {len(rows):,} รายการ (บริษัท {company_id}) "
            f"— วางทับข้อมูลยอดขายเดิมของบริษัทนี้เรียบร้อยแล้ว [รูปแบบไฟล์: {profile_label}]"
        ),
        "file_profile": profile_label,
        "parser_version": SALES_PARSER_VERSION,
        "rows_imported": len(rows),
        "rows_skipped_structure": skipped_structure,
        "rows_skipped_date_error": skipped_date_error,
        "warning": warning,
        "total_amount": total_amount,
        "total_gross": total_gross,
        "total_returns": total_returns,
        "total_net": total_gross - total_returns,
        "rows_return": len(return_rows),
        "date_range": {"min": min(dates), "max": max(dates)} if dates else None,
        "company_id": company_id,
        "detected_company_name": detected_company_name,
        "source_file": file.filename,
    }


@app.get("/api/sales/summary")
def get_sales_summary(company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL")):
    """สรุปยอดขาย MTD (เดือนล่าสุดที่มีข้อมูล), YTD (ปีของเดือนล่าสุดที่มีข้อมูล) และแนวโน้มรายเดือนสำหรับกราฟ

    หมายเหตุ: คำนวณอิงจาก "วันที่ล่าสุดที่มีอยู่จริงในข้อมูล" ไม่ใช่วันที่ปัจจุบันของเครื่องเซิร์ฟเวอร์
    เพราะไฟล์ที่นำเข้าอาจเป็นข้อมูลย้อนหลัง การอิงวันที่จริงบนเครื่องจะทำให้ MTD/YTD ว่างเปล่าผิดพลาด
    """
    if client is None:
        raise HTTPException(status_code=500, detail="BigQuery client ไม่พร้อมใช้งาน")

    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{SALES_TABLE}"
    try:
        table_obj = client.get_table(table_ref)
    except Exception:
        return {
            "success": True,
            "has_data": False,
            "message": "ยังไม่มีข้อมูลยอดขายในระบบ กรุณาอัปโหลดไฟล์ Excel จาก ECOUNT ก่อน",
        }

    # เช็คว่าตารางจริงใน BigQuery มีคอลัมน์ vehicle_models หรือยัง (ตารางเก่าที่สร้างไว้ก่อนเพิ่มฟีเจอร์นี้จะยังไม่มี
    # การแก้ schema ในโค้ดไม่ได้เปลี่ยนตารางที่มีอยู่แล้วโดยอัตโนมัติ ต้องรออัปโหลดไฟล์ใหม่ทับก่อนคอลัมน์นี้ถึงจะมีจริง)
    has_vehicle_models_column = any(f.name == "vehicle_models" for f in table_obj.schema)

    company_clause = "" if company_id == "ALL" else "AND company_id = @company_id"
    company_param = (
        [] if company_id == "ALL"
        else [bigquery.ScalarQueryParameter("company_id", "STRING", company_id)]
    )

    # 1) หาวันที่ล่าสุดที่มีข้อมูลจริง (ตามขอบเขตบริษัทที่เลือก) ใช้เป็นจุดอ้างอิงแทน "วันนี้"
    ref_sql = f"""
        SELECT MAX(transaction_date) AS max_date, MIN(transaction_date) AS min_date
        FROM `{table_ref}`
        WHERE 1=1 {company_clause}
    """
    ref_row = list(client.query(
        ref_sql, job_config=bigquery.QueryJobConfig(query_parameters=company_param)
    ).result())[0]

    if ref_row.max_date is None:
        return {
            "success": True,
            "has_data": False,
            "message": "ยังไม่มีข้อมูลยอดขายของบริษัทที่เลือก กรุณาอัปโหลดไฟล์ Excel ก่อน",
        }

    reference_date = ref_row.max_date
    month_start = reference_date.replace(day=1)
    year_start = reference_date.replace(month=1, day=1)
    trend_start = month_start.replace(year=month_start.year - 1)

    # ช่วงเปรียบเทียบ "วันต่อวัน" (Same Period Last Month): วันที่ 1 ถึงวันเดียวกันของเดือนก่อน
    # ถ้าเดือนก่อนสั้นกว่า (เช่น 31 มี.ค. → ก.พ. มีแค่ 28/29 วัน) ให้ตัดที่วันสุดท้ายของเดือนก่อน
    prev_month_end = month_start - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    prev_same_day = min(reference_date.day, calendar.monthrange(prev_month_start.year, prev_month_start.month)[1])
    prev_same_end = prev_month_start.replace(day=prev_same_day)

    ret = sales_return_sql_expr(table_obj)
    mtd_g, mtd_r, mtd_n = sales_amount_sql(ret, "transaction_date >= @month_start")
    ytd_g, ytd_r, ytd_n = sales_amount_sql(ret, "transaction_date >= @year_start")
    gross_all, returns_all, net_all = sales_amount_sql(ret)

    base_params = [
        bigquery.ScalarQueryParameter("month_start", "DATE", month_start),
        bigquery.ScalarQueryParameter("year_start", "DATE", year_start),
    ] + company_param

    totals_sql = f"""
        SELECT
          {mtd_g} AS mtd_gross, {mtd_r} AS mtd_returns, {mtd_n} AS mtd_net,
          IFNULL(SUM(IF(transaction_date >= @month_start AND NOT {ret}, qty, 0)), 0) AS mtd_qty,
          IFNULL(SUM(IF(transaction_date >= @month_start AND {ret}, ABS(qty), 0)), 0) AS mtd_return_qty,
          {ytd_g} AS ytd_gross, {ytd_r} AS ytd_returns, {ytd_n} AS ytd_net,
          IFNULL(SUM(IF(transaction_date >= @year_start AND NOT {ret}, qty, 0)), 0) AS ytd_qty,
          IFNULL(SUM(IF(transaction_date >= @year_start AND {ret}, ABS(qty), 0)), 0) AS ytd_return_qty,
          COUNT(DISTINCT IF(transaction_date >= @month_start, transaction_date, NULL)) AS mtd_days_with_data,
          COUNT(DISTINCT IF(NOT {ret}, invoice_no, NULL)) AS total_invoices,
          COUNT(DISTINCT IF({ret}, invoice_no, NULL)) AS total_return_docs
        FROM `{table_ref}`
        WHERE 1=1 {company_clause}
    """
    totals_row = list(client.query(totals_sql, job_config=bigquery.QueryJobConfig(query_parameters=base_params)).result())[0]

    # ยอดเดือนก่อน: ช่วงเดียวกัน (วันต่อวัน) และทั้งเดือน — ใช้ gross เทียบ gross
    prev_g_same, prev_r_same, prev_n_same = sales_amount_sql(ret, "transaction_date <= @prev_same_end")
    prev_g_full, _, prev_n_full = sales_amount_sql(ret)
    prev_sql = f"""
        SELECT {prev_g_same} AS same_gross, {prev_n_same} AS same_net,
               {prev_g_full} AS full_gross, {prev_n_full} AS full_net,
               COUNT(DISTINCT transaction_date) AS days_with_data
        FROM `{table_ref}`
        WHERE transaction_date BETWEEN @prev_month_start AND @prev_month_end {company_clause}
    """
    prev_row = list(client.query(
        prev_sql,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("prev_month_start", "DATE", prev_month_start),
            bigquery.ScalarQueryParameter("prev_month_end", "DATE", prev_month_end),
            bigquery.ScalarQueryParameter("prev_same_end", "DATE", prev_same_end),
        ] + company_param),
    ).result())[0]

    MIN_DAYS_FOR_MOM = 3
    mtd_days = int(totals_row.mtd_days_with_data or 0)
    prev_same_gross = float(prev_row.same_gross or 0)
    prev_has_data = int(prev_row.days_with_data or 0) > 0
    mom_pct = None
    if mtd_days < MIN_DAYS_FOR_MOM:
        mom_show, mom_reason = False, (
            f"ข้อมูลเดือนนี้มีเพียง {mtd_days} วัน (ต้องมีอย่างน้อย {MIN_DAYS_FOR_MOM} วัน) จึงยังไม่เทียบกับเดือนก่อน"
        )
    elif not prev_has_data:
        mom_show, mom_reason = False, "ไม่มีข้อมูลเดือนก่อนให้เปรียบเทียบ"
    elif prev_same_gross <= 0:
        mom_show, mom_reason = False, "เดือนก่อนช่วงเดียวกันไม่มียอดขาย จึงคำนวณ % ไม่ได้"
    else:
        mom_show, mom_reason = True, None
        mom_pct = (float(totals_row.mtd_gross) / prev_same_gross - 1) * 100

    mom_comparison = {
        "method": "same_period_last_month",
        "show": mom_show,
        "reason": mom_reason,
        "min_days_required": MIN_DAYS_FOR_MOM,
        "current_period": {"start": month_start.isoformat(), "end": reference_date.isoformat(),
                           "days_with_data": mtd_days},
        "previous_period": {"start": prev_month_start.isoformat(), "end": prev_same_end.isoformat()},
        "current_gross": totals_row.mtd_gross,
        "previous_gross": prev_same_gross,
        "previous_net": prev_row.same_net,
        "previous_full_month_gross": prev_row.full_gross,
        "previous_full_month_net": prev_row.full_net,
        "pct_change": round(mom_pct, 2) if mom_pct is not None else None,
    }

    by_company_sql = f"""
        SELECT company_id,
          {mtd_g} AS mtd_gross, {mtd_r} AS mtd_returns, {mtd_n} AS mtd_net,
          {ytd_g} AS ytd_gross, {ytd_r} AS ytd_returns, {ytd_n} AS ytd_net,
          MAX(transaction_date) AS last_date
        FROM `{table_ref}`
        GROUP BY company_id
        ORDER BY company_id
    """
    by_company_rows = client.query(
        by_company_sql,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("month_start", "DATE", month_start),
            bigquery.ScalarQueryParameter("year_start", "DATE", year_start),
        ]),
    ).result()

    monthly_sql = f"""
        SELECT FORMAT_DATE('%Y-%m', transaction_date) AS ym,
               {gross_all} AS gross, {returns_all} AS returns, {net_all} AS net
        FROM `{table_ref}`
        WHERE transaction_date >= @trend_start {company_clause}
        GROUP BY ym
        ORDER BY ym
    """
    monthly_rows = client.query(
        monthly_sql,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("trend_start", "DATE", trend_start)
        ] + company_param),
    ).result()

    # สินค้าขายดี / กลุ่มสินค้า / รุ่นรถ: นับเฉพาะรายการขายปกติ (ไม่เอารายการรับคืนมาหักจนติดลบ)
    # หมายเหตุ: กรองยอด > 0 ที่ชั้นนอกของ subquery เพราะ alias "amount" ชื่อซ้ำกับคอลัมน์ amount
    # ถ้ากรองด้วย SUM(amount) ในชั้นเดียวกัน BigQuery จะมองเป็น SUM(SUM(amount)) → Error "Aggregations of aggregations"
    top_products_sql = f"""
        SELECT * FROM (
            SELECT IFNULL(NULLIF(TRIM(prod_cd), ''), prod_des) AS prod_key,
                   ANY_VALUE(NULLIF(TRIM(prod_cd), '')) AS prod_cd, ANY_VALUE(prod_des) AS prod_des,
                   SUM(qty) AS qty, SUM(amount) AS amount
            FROM `{table_ref}`
            WHERE transaction_date >= @month_start AND NOT {ret} {company_clause}
            GROUP BY prod_key
        )
        WHERE amount > 0
        ORDER BY amount DESC
        LIMIT 15
    """
    top_products_rows = client.query(
        top_products_sql,
        job_config=bigquery.QueryJobConfig(query_parameters=base_params),
    ).result()

    # สัดส่วนยอดขายตามกลุ่มสินค้า (เดือนนี้) สำหรับกราฟโดนัท — ตัดกลุ่มที่ยอด <= 0 ทิ้ง เพราะกราฟวงกลมแสดงค่าติดลบไม่ได้
    by_group_sql = f"""
        SELECT * FROM (
            SELECT IFNULL(NULLIF(product_group, ''), 'ไม่ระบุกลุ่ม') AS product_group,
                   SUM(amount) AS amount
            FROM `{table_ref}`
            WHERE transaction_date >= @month_start AND NOT {ret} {company_clause}
            GROUP BY product_group
        )
        WHERE amount > 0
        ORDER BY amount DESC
    """
    by_group_rows = list(client.query(
        by_group_sql, job_config=bigquery.QueryJobConfig(query_parameters=base_params)
    ).result())

    TOP_GROUPS_LIMIT = 7
    by_product_group = [
        {"group": r.product_group, "amount": r.amount} for r in by_group_rows[:TOP_GROUPS_LIMIT]
    ]
    if len(by_group_rows) > TOP_GROUPS_LIMIT:
        others_amount = sum(r.amount for r in by_group_rows[TOP_GROUPS_LIMIT:])
        by_product_group.append({"group": "อื่นๆ", "amount": others_amount})

    # สัดส่วนยอดขายตามรุ่นรถ (เดือนนี้) — ดึงจากรหัสรุ่นที่ฝังในวงเล็บของชื่อสินค้า (vehicle_models)
    # สินค้าหนึ่งตัวอาจใช้ได้กับหลายรุ่น จึงต้อง UNNEST ก่อน group
    # ข้าม query นี้ถ้าตารางจริงยังไม่มีคอลัมน์ vehicle_models (ตารางเก่าก่อนเพิ่มฟีเจอร์ ยังไม่เคยอัปโหลดไฟล์ใหม่)
    by_vehicle_model = []
    if has_vehicle_models_column:
        by_model_sql = f"""
            SELECT * FROM (
                SELECT model, SUM(amount) AS amount
                FROM `{table_ref}`, UNNEST(vehicle_models) AS model
                WHERE transaction_date >= @month_start AND NOT {ret} {company_clause}
                GROUP BY model
            )
            WHERE amount > 0
            ORDER BY amount DESC
        """
        by_model_rows = list(client.query(
            by_model_sql, job_config=bigquery.QueryJobConfig(query_parameters=base_params)
        ).result())

        TOP_MODELS_LIMIT = 7
        by_vehicle_model = [
            {"model": r.model, "amount": r.amount} for r in by_model_rows[:TOP_MODELS_LIMIT]
        ]
        if len(by_model_rows) > TOP_MODELS_LIMIT:
            others_amount = sum(r.amount for r in by_model_rows[TOP_MODELS_LIMIT:])
            by_vehicle_model.append({"model": "อื่นๆ", "amount": others_amount})

    def _period(gross, returns, net, qty, return_qty):
        # amount = gross (ยอดขายก่อนหักรับคืน) คงชื่อฟิลด์เดิมไว้ให้หน้าเว็บ/ส่วนอื่นที่ใช้อยู่ไม่พัง
        return {"amount": gross, "gross": gross, "returns": returns, "net": net,
                "qty": qty, "return_qty": return_qty}

    return {
        "success": True,
        "has_data": True,
        "company_id": company_id,
        "as_of": reference_date.isoformat(),
        "mtd": _period(totals_row.mtd_gross, totals_row.mtd_returns, totals_row.mtd_net,
                       totals_row.mtd_qty, totals_row.mtd_return_qty),
        "ytd": _period(totals_row.ytd_gross, totals_row.ytd_returns, totals_row.ytd_net,
                       totals_row.ytd_qty, totals_row.ytd_return_qty),
        "mom_comparison": mom_comparison,
        "total_invoices": totals_row.total_invoices,
        "total_return_docs": totals_row.total_return_docs,
        "date_range": {
            "first": ref_row.min_date.isoformat() if ref_row.min_date else None,
            "last": ref_row.max_date.isoformat() if ref_row.max_date else None,
        },
        "by_company": [
            {
                "company_id": r.company_id,
                "mtd_amount": r.mtd_gross, "mtd_returns": r.mtd_returns, "mtd_net": r.mtd_net,
                "ytd_amount": r.ytd_gross, "ytd_returns": r.ytd_returns, "ytd_net": r.ytd_net,
                "last_date": r.last_date.isoformat() if r.last_date else None,
            }
            for r in by_company_rows
        ],
        "monthly_trend": [
            {"ym": r.ym, "amount": r.gross, "gross": r.gross, "returns": r.returns, "net": r.net}
            for r in monthly_rows
        ],
        "by_product_group": by_product_group,
        "by_vehicle_model": by_vehicle_model,
        "top_products": [
            {"prod_key": r.prod_key, "prod_cd": r.prod_cd, "prod_des": r.prod_des, "qty": r.qty, "amount": r.amount}
            for r in top_products_rows
        ],
    }

@app.get("/api/sales/product-lookup")
def get_sales_product_lookup(
    q: str = Query(..., min_length=1, description="คำค้นหา: รหัสสินค้า หรือ ชื่อ/รุ่นสินค้า (ค้นหาบางส่วนได้)"),
    company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL"),
):
    """ค้นหายอดขาย MTD/YTD ของสินค้า/รุ่นที่ต้องการโดยเฉพาะ (ค้นจากรหัสสินค้าหรือชื่อสินค้าบางส่วน)"""
    if client is None:
        raise HTTPException(status_code=500, detail="BigQuery client ไม่พร้อมใช้งาน")

    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{SALES_TABLE}"
    try:
        table_obj = client.get_table(table_ref)
    except Exception:
        return {
            "success": True,
            "has_data": False,
            "message": "ยังไม่มีข้อมูลยอดขายในระบบ กรุณาอัปโหลดไฟล์ Excel จาก ECOUNT ก่อน",
        }

    company_clause = "" if company_id == "ALL" else "AND company_id = @company_id"
    company_param = (
        [] if company_id == "ALL"
        else [bigquery.ScalarQueryParameter("company_id", "STRING", company_id)]
    )

    # ใช้วันที่ล่าสุดที่มีข้อมูลจริงเป็นจุดอ้างอิง MTD/YTD เหมือน endpoint สรุปหลัก เพื่อให้ตัวเลขตรงกัน
    ref_sql = f"""
        SELECT MAX(transaction_date) AS max_date
        FROM `{table_ref}`
        WHERE 1=1 {company_clause}
    """
    ref_row = list(client.query(
        ref_sql, job_config=bigquery.QueryJobConfig(query_parameters=company_param)
    ).result())[0]

    if ref_row.max_date is None:
        return {
            "success": True,
            "has_data": False,
            "message": "ยังไม่มีข้อมูลยอดขายของบริษัทที่เลือก กรุณาอัปโหลดไฟล์ Excel ก่อน",
        }

    reference_date = ref_row.max_date
    month_start = reference_date.replace(day=1)
    year_start = reference_date.replace(month=1, day=1)

    like_pattern = f"%{q.strip().lower()}%"
    ret = sales_return_sql_expr(table_obj)
    mtd_g, _, mtd_n = sales_amount_sql(ret, "transaction_date >= @month_start")
    ytd_g, _, ytd_n = sales_amount_sql(ret, "transaction_date >= @year_start")
    search_params = [
        bigquery.ScalarQueryParameter("month_start", "DATE", month_start),
        bigquery.ScalarQueryParameter("year_start", "DATE", year_start),
        bigquery.ScalarQueryParameter("like_pattern", "STRING", like_pattern),
    ] + company_param

    lookup_sql = f"""
        SELECT
          IFNULL(NULLIF(TRIM(prod_cd), ''), prod_des) AS prod_key,
          ANY_VALUE(NULLIF(TRIM(prod_cd), '')) AS prod_cd,
          ANY_VALUE(prod_des) AS prod_des,
          IFNULL(SUM(IF(transaction_date >= @month_start AND NOT {ret}, qty, 0)), 0) AS mtd_qty,
          {mtd_g} AS mtd_amount, {mtd_n} AS mtd_net,
          IFNULL(SUM(IF(transaction_date >= @year_start AND NOT {ret}, qty, 0)), 0) AS ytd_qty,
          {ytd_g} AS ytd_amount, {ytd_n} AS ytd_net
        FROM `{table_ref}`
        WHERE (LOWER(IFNULL(prod_cd, '')) LIKE @like_pattern OR LOWER(IFNULL(prod_des, '')) LIKE @like_pattern)
              {company_clause}
        GROUP BY prod_key
        ORDER BY ytd_amount DESC
        LIMIT 50
    """
    rows = list(client.query(
        lookup_sql, job_config=bigquery.QueryJobConfig(query_parameters=search_params)
    ).result())

    products = [
        {
            "prod_key": r.prod_key,
            "prod_cd": r.prod_cd,
            "prod_des": r.prod_des,
            "mtd_qty": r.mtd_qty,
            "mtd_amount": r.mtd_amount,
            "mtd_net": r.mtd_net,
            "ytd_qty": r.ytd_qty,
            "ytd_amount": r.ytd_amount,
            "ytd_net": r.ytd_net,
        }
        for r in rows
    ]

    return {
        "success": True,
        "has_data": True,
        "query": q,
        "company_id": company_id,
        "as_of": reference_date.isoformat(),
        "match_count": len(products),
        "products": products,
        "total": {
            "mtd_qty": sum(p["mtd_qty"] for p in products),
            "mtd_amount": sum(p["mtd_amount"] for p in products),
            "ytd_qty": sum(p["ytd_qty"] for p in products),
            "ytd_amount": sum(p["ytd_amount"] for p in products),
        },
    }


@app.get("/api/sales/transactions")
def get_sales_transactions(
    company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL"),
    prod_cd: Optional[str] = Query(None, description="กรองเฉพาะรหัสสินค้านี้ (เว้นว่างเพื่อดูทุกสินค้า)"),
    product_group: Optional[str] = Query(None, description="กรองเฉพาะกลุ่มสินค้านี้ (ใช้ค่าเดียวกับที่ได้จาก by_product_group)"),
    exclude_groups: Optional[str] = Query(None, description="รายชื่อกลุ่มสินค้าที่ไม่เอา คั่นด้วย , (ใช้ตอนคลิกกลุ่ม 'อื่นๆ')"),
    vehicle_model: Optional[str] = Query(None, description="กรองเฉพาะรุ่นรถนี้ (ใช้ค่าเดียวกับที่ได้จาก by_vehicle_model)"),
    exclude_vehicle_models: Optional[str] = Query(None, description="รายชื่อรุ่นรถที่ไม่เอา คั่นด้วย , (ใช้ตอนคลิกรุ่น 'อื่นๆ')"),
    period: str = Query("mtd", description="mtd (เดือนนี้) หรือ ytd (ปีนี้)"),
    limit: int = Query(300, ge=1, le=1000, description="จำนวนแถวสูงสุดที่จะแสดง"),
):
    """ดึงรายการขายรายตัว (invoice-level) เพื่อ 'คลิกดูรายละเอียด' ว่ายอดรวมประกอบด้วยรายการอะไรบ้าง"""
    if client is None:
        raise HTTPException(status_code=500, detail="BigQuery client ไม่พร้อมใช้งาน")

    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{SALES_TABLE}"
    try:
        table_obj = client.get_table(table_ref)
    except Exception:
        return {"success": True, "has_data": False, "message": "ยังไม่มีข้อมูลยอดขายในระบบ", "rows": [], "total_matched": 0}

    has_vehicle_models_column = any(f.name == "vehicle_models" for f in table_obj.schema)
    if (vehicle_model or exclude_vehicle_models) and not has_vehicle_models_column:
        # ตารางเก่ายังไม่มีคอลัมน์นี้ (ยังไม่เคยอัปโหลดไฟล์ใหม่หลังเพิ่มฟีเจอร์รุ่นรถ)
        return {
            "success": True,
            "has_data": False,
            "message": "ยังไม่มีข้อมูลรุ่นรถในระบบ กรุณาอัปโหลดไฟล์ Excel ใหม่อีกครั้งเพื่อให้ระบบประมวลผลรุ่นรถ",
            "rows": [],
            "total_matched": 0,
        }

    company_clause = "" if company_id == "ALL" else "AND company_id = @company_id"
    company_param = (
        [] if company_id == "ALL"
        else [bigquery.ScalarQueryParameter("company_id", "STRING", company_id)]
    )

    ref_sql = f"SELECT MAX(transaction_date) AS max_date FROM `{table_ref}` WHERE 1=1 {company_clause}"
    ref_row = list(client.query(
        ref_sql, job_config=bigquery.QueryJobConfig(query_parameters=company_param)
    ).result())[0]

    if ref_row.max_date is None:
        return {"success": True, "has_data": False, "message": "ยังไม่มีข้อมูลยอดขายของบริษัทที่เลือก", "rows": [], "total_matched": 0}

    reference_date = ref_row.max_date
    if period == "ytd":
        start_date = reference_date.replace(month=1, day=1)
    else:
        start_date = reference_date.replace(day=1)

    prod_clause = "AND IFNULL(NULLIF(TRIM(prod_cd), ''), prod_des) = @prod_cd" if prod_cd else ""  # ASIA ไม่มีรหัสสินค้า จึงใช้ชื่อสินค้าเป็น key แทน
    params = [
        bigquery.ScalarQueryParameter("start_date", "DATE", start_date),
    ] + company_param
    if prod_cd:
        params.append(bigquery.ScalarQueryParameter("prod_cd", "STRING", prod_cd))

    # กรองตามกลุ่มสินค้า (คลิกจากกราฟวงกลม/รายการกลุ่มสินค้า)
    group_clause = ""
    if product_group:
        group_clause = "AND IFNULL(NULLIF(product_group, ''), 'ไม่ระบุกลุ่ม') = @product_group"
        params.append(bigquery.ScalarQueryParameter("product_group", "STRING", product_group))
    elif exclude_groups:
        names = [g.strip() for g in exclude_groups.split(",") if g.strip()]
        if names:
            group_clause = "AND IFNULL(NULLIF(product_group, ''), 'ไม่ระบุกลุ่ม') NOT IN UNNEST(@exclude_groups)"
            params.append(bigquery.ArrayQueryParameter("exclude_groups", "STRING", names))

    # กรองตามรุ่นรถ (คลิกจากกราฟวงกลม/รายการรุ่นรถ) — vehicle_models เป็นฟิลด์ REPEATED จึงต้องเช็คแบบ IN UNNEST
    model_clause = ""
    if vehicle_model:
        model_clause = "AND @vehicle_model IN UNNEST(vehicle_models)"
        params.append(bigquery.ScalarQueryParameter("vehicle_model", "STRING", vehicle_model))
    elif exclude_vehicle_models:
        names = [m.strip() for m in exclude_vehicle_models.split(",") if m.strip()]
        if names:
            model_clause = "AND NOT EXISTS (SELECT 1 FROM UNNEST(vehicle_models) AS vm WHERE vm IN UNNEST(@exclude_vehicle_models))"
            params.append(bigquery.ArrayQueryParameter("exclude_vehicle_models", "STRING", names))

    count_sql = f"""
        SELECT COUNT(*) AS total
        FROM `{table_ref}`
        WHERE transaction_date >= @start_date {company_clause} {prod_clause} {group_clause} {model_clause}
    """
    total_matched = list(client.query(
        count_sql, job_config=bigquery.QueryJobConfig(query_parameters=params)
    ).result())[0].total

    rows_sql = f"""
        SELECT transaction_date, invoice_no, company_id, prod_cd, prod_des,
               customer_name, qty, unit, unit_price, amount, warehouse_name, technician,
               {sales_return_sql_expr(table_obj)} AS is_return
        FROM `{table_ref}`
        WHERE transaction_date >= @start_date {company_clause} {prod_clause} {group_clause} {model_clause}
        ORDER BY transaction_date DESC, invoice_no DESC
        LIMIT @limit_val
    """
    params_with_limit = params + [bigquery.ScalarQueryParameter("limit_val", "INT64", limit)]
    rows = client.query(
        rows_sql, job_config=bigquery.QueryJobConfig(query_parameters=params_with_limit)
    ).result()

    return {
        "success": True,
        "has_data": True,
        "as_of": reference_date.isoformat(),
        "period": period,
        "start_date": start_date.isoformat(),
        "company_id": company_id,
        "prod_cd": prod_cd,
        "total_matched": total_matched,
        "rows": [
            {
                "transaction_date": r.transaction_date.isoformat() if r.transaction_date else None,
                "invoice_no": r.invoice_no,
                "company_id": r.company_id,
                "prod_cd": r.prod_cd,
                "prod_des": r.prod_des,
                "customer_name": r.customer_name,
                "qty": r.qty,
                "unit": r.unit,
                "unit_price": r.unit_price,
                "amount": r.amount,
                "warehouse_name": r.warehouse_name,
                "technician": r.technician,
                "is_return": bool(r.is_return),
            }
            for r in rows
        ],
    }


# ============================================================================
# MODULE: ใบแจ้งหนี้ & สถานะกระทบบัญชีขาย (Sales Invoice & Account Sync Status)
# นำเข้าไฟล์ Excel รายงาน "สถานะใบกำกับภาษีขาย" ที่ Export จาก ECOUNT -> BigQuery ตาราง sales_invoices
#
# โครงสร้างไฟล์ (ตัวอย่างจาก RUAMSINTHAI, 30 ก.ย. 2569):
#   แถว 1 : "ชื่อบริษัท : <ชื่อ> / 01 ม.ค. 2569 ~ 30 ก.ย. 2569 / สถานะใบกำกับภาษีขาย"
#   แถว 2 : วันที่-ลำดับ | เลขที่ใบสำคัญบัญชี | ชื่อลูกค้า/ผู้ขาย | จำนวนเงิน | ภาษีขาย | หัก ณ ที่จ่าย | ยอดขายรวม | ดูประวัติธุรกรรม
#   ท้ายไฟล์: แถว "ยอดรวม" และแถว timestamp (ถูกข้ามอัตโนมัติ)
#   ROBOTICS: รูปแบบเดียวกัน แต่มีแถวสรุปรายเดือน "ก.พ. 2569  รวม" คั่น (ถูกข้ามอัตโนมัติ)
#   ASIA    : หัวตารางต่างออกไป —  เปลี่ยนลำดับ | วันที่ | เลขที่ใบสำคัญบัญชี | ชื่อลูกค้า/ผู้ขาย | จำนวนเงิน |
#             ภาษีขาย | ยอดขายรวม | หมายเหตุ | ดูประวัติธุรกรรม  (ไม่มีคอลัมน์ "วันที่-ลำดับ" และ "หัก ณ ที่จ่าย")
#
# กติกาสถานะ: มี "เลขที่ใบสำคัญบัญชี" = กระทบบัญชีแล้ว (MATCHED) / ช่องว่าง = รอตั้งหนี้ (PENDING)
# ============================================================================

SALES_INVOICE_TABLE = "sales_invoices"
INVOICE_PARSER_VERSION = "invoice-parser-2026-09-30-v2-asia-layout"
_VALID_MATCH_STATUSES = {"ALL", "MATCHED", "PENDING"}
INVOICE_MATCH_LABELS = {"MATCHED": "กระทบบัญชีแล้ว", "PENDING": "รอตั้งหนี้"}

SALES_INVOICE_SCHEMA = [
    bigquery.SchemaField("company_id", "STRING"),
    bigquery.SchemaField("invoice_date", "DATE"),
    bigquery.SchemaField("date_seq", "STRING"),          # ค่าดิบ "01 ม.ค. 2569 -2" ใช้เป็นเลขที่อ้างอิงของใบขายใน ECOUNT
    bigquery.SchemaField("acct_voucher_no", "STRING"),   # เลขที่ใบสำคัญบัญชี เช่น IV2026010080 (ว่าง = ยังไม่ลงบัญชี)
    bigquery.SchemaField("customer_name", "STRING"),
    bigquery.SchemaField("supply_amt", "FLOAT"),         # จำนวนเงิน (ก่อนภาษี)
    bigquery.SchemaField("vat_amt", "FLOAT"),            # ภาษีขาย
    bigquery.SchemaField("wht_amt", "FLOAT"),            # หัก ณ ที่จ่าย
    bigquery.SchemaField("total_amt", "FLOAT"),          # ยอดขายรวม
    bigquery.SchemaField("is_credit_note", "BOOLEAN"),   # ยอดติดลบ = ลดหนี้ / รับคืน
    bigquery.SchemaField("remarks", "STRING"),           # หมายเหตุ (ASIA) — เก็บเฉพาะเมื่อไม่ซ้ำกับเลขที่ใบสำคัญบัญชี
    bigquery.SchemaField("account_match_status", "STRING"),
    bigquery.SchemaField("account_match_label", "STRING"),
    bigquery.SchemaField("source_file", "STRING"),
    bigquery.SchemaField("uploaded_at", "TIMESTAMP"),
]

# ชื่อหัวคอลัมน์ (เทียบแบบ contains) — ถ้าบริษัทอื่นตั้งชื่อต่างไปเล็กน้อย เพิ่มคำใน list ได้เลย
INVOICE_HEADER_ALIASES = {
    "date_seq": ["วันที่-ลำดับ", "วันที่-No", "-No"],
    "voucher": ["เลขที่ใบสำคัญบัญชี", "ใบสำคัญบัญชี", "ใบสำคัญ"],
    "customer": ["ชื่อลูกค้า", "ลูกค้า"],
    "supply": ["จำนวนเงิน"],
    "vat": ["ภาษีขาย", "ภาษี"],
    "wht": ["หัก ณ ที่จ่าย", "ณ ที่จ่าย"],
    "total": ["ยอดขายรวม", "ยอดรวม"],
    "remarks": ["หมายเหตุ"],
}
# คอลัมน์ที่ต้องเทียบชื่อแบบตรงตัว (ไม่ใช่ contains) เพราะคำว่า "วันที่" / "ลำดับ" ไปซ้อนอยู่ในหัว "วันที่-ลำดับ" ด้วย
INVOICE_EXACT_HEADERS = {
    "date": ["วันที่"],
    "seq_no": ["เปลี่ยนลำดับ", "ลำดับ", "No.", "No"],
}


def _find_invoice_header(ws, max_scan_rows=6):
    """หาแถวหัวตาราง (มีคอลัมน์ 'ใบสำคัญ' + 'วันที่-ลำดับ' หรือ 'วันที่') แล้วคืน (header_row, col_map)"""
    for r in range(1, min(ws.max_row, max_scan_rows) + 1):
        header_map = _read_header_map(ws, r)
        col_map = {}
        for key, names in INVOICE_EXACT_HEADERS.items():
            for name in names:
                col = _find_header_column(header_map, exact=name)
                if col:
                    col_map[key] = col
                    break
        for key, aliases in INVOICE_HEADER_ALIASES.items():
            for alias in aliases:
                col = _find_header_column(header_map, must_contain=[alias])
                if col and col not in col_map.values():
                    col_map[key] = col
                    break
        if col_map.get("voucher") and (col_map.get("date_seq") or col_map.get("date")):
            return r, col_map
    return None, {}


def _parse_invoice_period(title_text):
    """ดึงช่วงวันที่ของรายงานจากแถวแรก เช่น '... / 01 ม.ค. 2569  ~ 30 ก.ย. 2569  / ...' -> (date, date)"""
    if not title_text or "~" not in str(title_text):
        return None, None
    for part in str(title_text).split("/"):
        if "~" in part:
            left, right = part.split("~", 1)
            return parse_thai_date(left.strip()), parse_thai_date(right.strip())
    return None, None


def parse_invoice_excel(file_bytes: bytes, company_id: str, source_filename: str):
    # ห้ามใช้ read_only=True: ไฟล์ที่ ECOUNT export บันทึกขนาดชีตผิด (A1:A1) ทำให้โหมด read_only อ่านได้แค่แถวแรก
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
    ws = wb[wb.sheetnames[0]]
    all_rows = [list(r) for r in ws.iter_rows(values_only=True)]

    class _Sheet:  # ตัวห่อบางๆ ให้ใช้ helper เดิม (_read_header_map) ได้
        def __init__(self, rows):
            self.rows = rows
            self.max_row = len(rows)
            self.max_column = max((len(x) for x in rows), default=0)

        def cell(self, row, column):
            vals = self.rows[row - 1] if 0 < row <= len(self.rows) else []
            return types.SimpleNamespace(value=vals[column - 1] if 0 < column <= len(vals) else None)

    sheet = _Sheet(all_rows)
    title = all_rows[0][0] if all_rows and all_rows[0] else None

    detected_company_name = None
    if title:
        detected_company_name = str(title).split("/")[0].replace("ชื่อบริษัท", "").strip(" :")
    check_sales_file_company(detected_company_name, company_id)

    header_row, col_map = _find_invoice_header(sheet)
    if not header_row:
        raise ValueError(
            "ไฟล์นี้ไม่ใช่รายงาน 'สถานะใบกำกับภาษีขาย' — ไม่พบคอลัมน์ 'เลขที่ใบสำคัญบัญชี' และ 'วันที่-ลำดับ' (หรือ 'วันที่') "
            "(ถ้าเป็นไฟล์รายงานสถานะการขายรายสินค้า ให้นำเข้าที่เมนู MTD&YTD&SALE แทน)"
        )
    if not (col_map.get("supply") or col_map.get("total")):
        raise ValueError("ไม่พบคอลัมน์ 'จำนวนเงิน' หรือ 'ยอดขายรวม' ในไฟล์นี้")

    period_from, period_to = _parse_invoice_period(title)
    now_iso = datetime.now(timezone.utc).isoformat()
    rows, skipped_no_amount, date_errors = [], 0, []

    def val(r, key):
        col = col_map.get(key)
        return sheet.cell(r, col).value if col else None

    for r in range(header_row + 1, sheet.max_row + 1):
        if col_map.get("date_seq"):
            # RUAMSINTHAI / ROBOTICS: "01 ม.ค. 2569 -2"
            date_seq = _cell_str(val(r, "date_seq"))
            if not date_seq or not DATE_SEQ_VALUE_PATTERN.match(date_seq):
                continue  # แถว "ยอดรวม", "ก.พ. 2569 รวม", timestamp ท้ายไฟล์, แถวว่าง
            invoice_date = parse_date_seq(date_seq)
            date_text = date_seq
        else:
            # ASIA: คอลัมน์ "วันที่" แยก (แถวสรุป/ยอดรวม/timestamp จะไม่มีค่าในคอลัมน์นี้)
            date_text = _cell_str(val(r, "date"))
            if not date_text:
                continue
            invoice_date = parse_thai_date(date_text)
            seq_no = _cell_str(val(r, "seq_no"))
            # "เปลี่ยนลำดับ" เป็นแค่ลำดับแถวในรายงาน ไม่ใช่เลขที่เอกสาร ECOUNT จึงใช้ "#" กันสับสนกับรูปแบบ "-N"
            date_seq = f"{date_text} #{seq_no}" if seq_no else date_text

        if invoice_date is None:
            if len(date_errors) < 5:
                date_errors.append(date_text)
            continue

        supply = _cell_float(val(r, "supply"))
        vat = _cell_float(val(r, "vat")) or 0.0
        wht = _cell_float(val(r, "wht")) or 0.0
        total = _cell_float(val(r, "total"))
        if supply is None and total is None:
            skipped_no_amount += 1   # ใบที่ ECOUNT ไม่มียอดเงิน (มักเป็นใบยกเลิก) — ไม่นับรวม
            continue
        if supply is None:
            supply = total - vat + wht
        if total is None:
            total = supply + vat - wht

        voucher = _cell_str(val(r, "voucher"))
        status = "MATCHED" if voucher else "PENDING"
        remarks = _cell_str(val(r, "remarks"))
        if remarks and remarks == voucher:
            remarks = None
        rows.append({
            "company_id": company_id,
            "invoice_date": invoice_date.isoformat(),
            "date_seq": date_seq,
            "acct_voucher_no": voucher,
            "customer_name": _cell_str(val(r, "customer")),
            "supply_amt": round(supply, 2),
            "vat_amt": round(vat, 2),
            "wht_amt": round(wht, 2),
            "total_amt": round(total, 2),
            "is_credit_note": total < 0,
            "remarks": remarks,
            "account_match_status": status,
            "account_match_label": INVOICE_MATCH_LABELS[status],
            "source_file": source_filename,
            "uploaded_at": now_iso,
        })

    if rows and not (period_from and period_to):
        dates = [r["invoice_date"] for r in rows]
        period_from, period_to = date.fromisoformat(min(dates)), date.fromisoformat(max(dates))

    return {
        "rows": rows,
        "detected_company_name": detected_company_name,
        "period_from": period_from,
        "period_to": period_to,
        "skipped_no_amount": skipped_no_amount,
        "date_errors": date_errors,
    }


@app.post("/api/sales-invoices/upload")
async def upload_sales_invoice_excel(
    company_id: str = Form(..., description="ASIA, ROBOTICS หรือ RUAMSINTHAI"),
    file: UploadFile = File(...),
):
    """นำเข้าไฟล์ 'สถานะใบกำกับภาษีขาย' แล้ววางทับข้อมูลเดิมของบริษัทนี้ "เฉพาะช่วงวันที่ของไฟล์"
    (เช่นไฟล์ 01 ม.ค.–30 ก.ย. จะแทนที่ข้อมูลช่วงนั้นเท่านั้น ข้อมูลนอกช่วงยังอยู่ครบ)"""
    company_id = validate_company_id(company_id)
    if company_id == "ALL":
        raise HTTPException(status_code=400, detail="กรุณาเลือกบริษัทของไฟล์ (ASIA / ROBOTICS / RUAMSINTHAI)")
    if client is None:
        raise HTTPException(status_code=500, detail="BigQuery client ไม่พร้อมใช้งาน กรุณากดปุ่มเชื่อมต่อ BigQuery ใหม่")
    if not (file.filename or "").lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="รองรับเฉพาะไฟล์ .xlsx ที่ Export จาก ECOUNT เท่านั้น")

    content = await file.read()
    try:
        parsed = await asyncio.to_thread(parse_invoice_excel, content, company_id, file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"ไม่สามารถอ่านไฟล์ Excel ได้: {exc}")

    rows = parsed["rows"]
    if not rows:
        raise HTTPException(status_code=400, detail="ไม่พบรายการใบแจ้งหนี้ที่อ่านได้ในไฟล์นี้")

    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{SALES_INVOICE_TABLE}"

    # 1) ลบข้อมูลเดิมของบริษัทนี้เฉพาะช่วงวันที่ของไฟล์ — ถ้าตารางยังไม่มีให้ข้ามไป
    #    error อื่น (เช่นสิทธิ์ DML) ต้องหยุด ไม่งั้นการ APPEND ต่อจะทำให้ข้อมูลซ้ำซ้อน
    table_exists = True
    try:
        client.get_table(table_ref)
    except Exception as exc:
        if "Not found" in str(exc) or "404" in str(exc):
            table_exists = False
        else:
            raise HTTPException(status_code=500, detail=f"ตรวจสอบตาราง BigQuery ไม่สำเร็จ: {exc}")
    if table_exists:
        try:
            client.query(
                f"DELETE FROM `{table_ref}` WHERE company_id = @company_id "
                f"AND invoice_date BETWEEN @date_from AND @date_to",
                job_config=bigquery.QueryJobConfig(query_parameters=[
                    bigquery.ScalarQueryParameter("company_id", "STRING", company_id),
                    bigquery.ScalarQueryParameter("date_from", "DATE", parsed["period_from"]),
                    bigquery.ScalarQueryParameter("date_to", "DATE", parsed["period_to"]),
                ]),
            ).result()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"ลบข้อมูลช่วงเดิมไม่สำเร็จ (ยังไม่ได้นำเข้าอะไร): {exc}")

    # 2) โหลดชุดใหม่เข้าไป
    job_config = bigquery.LoadJobConfig(
        write_disposition="WRITE_APPEND",
        schema=SALES_INVOICE_SCHEMA,
        schema_update_options=[bigquery.SchemaUpdateOption.ALLOW_FIELD_ADDITION] if table_exists else None,
    )
    try:
        client.load_table_from_json(rows, table_ref, job_config=job_config).result()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"บันทึกข้อมูลลง BigQuery ไม่สำเร็จ: {exc}")

    matched = sum(1 for r in rows if r["account_match_status"] == "MATCHED")
    pending = len(rows) - matched
    warnings = []
    if parsed["skipped_no_amount"]:
        warnings.append(f"ข้าม {parsed['skipped_no_amount']} ใบที่ไม่มียอดเงินในไฟล์ (มักเป็นใบที่ถูกยกเลิก)")
    if parsed["date_errors"]:
        warnings.append(f"มีแถวที่แปลงวันที่ไม่ได้ เช่น {'; '.join(parsed['date_errors'])}")

    p_from, p_to = parsed["period_from"], parsed["period_to"]
    return {
        "success": True,
        "message": (
            f"นำเข้าใบแจ้งหนี้สำเร็จ {len(rows):,} ใบ (บริษัท {company_id}, "
            f"ช่วง {p_from.isoformat()} ถึง {p_to.isoformat()}) — กระทบบัญชีแล้ว {matched:,} / รอตั้งหนี้ {pending:,}"
        ),
        "warning": " • ".join(warnings) or None,
        "rows_imported": len(rows),
        "matched_count": matched,
        "pending_count": pending,
        "period": {"from": p_from.isoformat(), "to": p_to.isoformat()},
        "detected_company_name": parsed["detected_company_name"],
        "parser_version": INVOICE_PARSER_VERSION,
    }


@app.get("/api/sales-invoices")
def get_sales_invoices(
    company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL"),
    start_date: Optional[str] = Query(None, description="YYYY-MM-DD หรือ YYYYMMDD (ไม่ระบุ = 1 ม.ค. ปีนี้)"),
    end_date: Optional[str] = Query(None, description="YYYY-MM-DD หรือ YYYYMMDD (ไม่ระบุ = วันนี้)"),
    match_status: str = Query("ALL", description="ALL, MATCHED (กระทบบัญชีแล้ว), PENDING (รอตั้งหนี้)"),
):
    company_id = validate_company_id(company_id)
    match_status = (match_status or "ALL").strip().upper()
    if match_status not in _VALID_MATCH_STATUSES:
        raise HTTPException(status_code=400, detail=f"match_status ต้องเป็นหนึ่งใน {sorted(_VALID_MATCH_STATUSES)}")
    date_from, date_to = default_expense_date_range(
        validate_date_yyyymmdd(start_date, "start_date"),
        validate_date_yyyymmdd(end_date, "end_date"),
    )
    if date_from > date_to:
        raise HTTPException(status_code=400, detail="start_date ต้องไม่เกิน end_date")
    if client is None:
        return {"success": False, "message": "BigQuery ไม่พร้อมใช้งาน กรุณากดปุ่มเชื่อมต่อ BigQuery ใหม่", "data": []}

    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{SALES_INVOICE_TABLE}"
    where = ["invoice_date BETWEEN @date_from AND @date_to"]
    params = [
        bigquery.ScalarQueryParameter("date_from", "DATE", datetime.strptime(date_from, "%Y%m%d").date()),
        bigquery.ScalarQueryParameter("date_to", "DATE", datetime.strptime(date_to, "%Y%m%d").date()),
    ]
    if company_id != "ALL":
        where.append("company_id = @company_id")
        params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_id))
    if match_status != "ALL":
        where.append("account_match_status = @match_status")
        params.append(bigquery.ScalarQueryParameter("match_status", "STRING", match_status))

    query = f"""
        SELECT company_id, invoice_date, date_seq, acct_voucher_no, customer_name,
               supply_amt, vat_amt, wht_amt, total_amt, is_credit_note, remarks,
               account_match_status, source_file, uploaded_at
        FROM `{table_ref}`
        WHERE {' AND '.join(where)}
        ORDER BY invoice_date DESC, date_seq DESC
    """
    try:
        results = client.query(query, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    except Exception as exc:
        if "Not found" in str(exc):
            return {
                "success": True, "table_missing": True, "data": [],
                "message": "ยังไม่มีข้อมูลใบแจ้งหนี้ — กดปุ่ม 'นำเข้าไฟล์' แล้วอัปโหลดรายงานสถานะใบกำกับภาษีขายจาก ECOUNT",
            }
        print(f"⚠️ BigQuery sales_invoices query failed: {exc}")
        return {"success": False, "message": f"ดึงข้อมูลใบแจ้งหนี้จาก BigQuery ไม่สำเร็จ: {exc}", "data": []}

    items, uploads = [], {}
    for row in results:
        items.append({
            "company_id": row.company_id,
            "invoice_date": row.invoice_date.isoformat() if row.invoice_date else None,
            "date_seq": row.date_seq,
            "acct_voucher_no": row.acct_voucher_no,
            "customer_name": row.customer_name,
            "supply_amt": float(row.supply_amt or 0),
            "vat_amt": float(row.vat_amt or 0),
            "wht_amt": float(row.wht_amt or 0),
            "total_amt": float(row.total_amt or 0),
            "is_credit_note": bool(row.is_credit_note),
            "remarks": getattr(row, "remarks", None),
            "account_match_status": row.account_match_status or "PENDING",
        })
        prev = uploads.get(row.company_id)
        if row.uploaded_at and (prev is None or row.uploaded_at > prev["at"]):
            uploads[row.company_id] = {"at": row.uploaded_at, "file": row.source_file}

    return {
        "success": True,
        "source": "bigquery",
        "filters": {"company_id": company_id, "start_date": date_from, "end_date": date_to, "match_status": match_status},
        "total_items": len(items),
        "last_uploads": {cid: {"uploaded_at": u["at"].isoformat(), "source_file": u["file"]} for cid, u in uploads.items()},
        "data": items,
    }


# --- Local server entrypoint (คอมบริษัท / VS Code) ---
# รันได้ทั้งสองแบบ:
#   1) python app.py                (ใช้ค่านี้)
#   2) uvicorn app:app --host 0.0.0.0 --port 8000 --reload   (สำหรับ dev ที่อยากได้ auto-reload)
if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    reload_enabled = os.getenv("RELOAD", "false").strip().lower() in ("1", "true", "yes")

    print(f"🚀 Starting Multi-Company Enterprise Hub API on http://{host}:{port}")
    print(f"   (เครื่องอื่นในวง LAN เดียวกันเข้าใช้งานผ่าน http://<IP เครื่องนี้>:{port})")

    uvicorn.run("app:app", host=host, port=port, reload=reload_enabled)