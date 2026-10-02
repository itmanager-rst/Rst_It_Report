import os
import sys
import re
import time
import requests
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation
from google.cloud import bigquery
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

load_dotenv()

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "rst-ecount-sync-py").strip()
DATASET_ID = "multi_company_inventory"
LOCATION = "asia-southeast1"
SYNC_INTERVAL_SECONDS = 1800
ECOUNT_API_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
}

# ตัวแปรสำหรับ Cache Session ID ในหน่วยความจำ เพื่อลดการยิง Login ซ้ำซ้อน
ECOUNT_SESSIONS = {}


def get_bigquery_client():
    try:
        return bigquery.Client(project=PROJECT_ID)
    except Exception as exc:
        print(f"⚠️ BigQuery client init failed: {exc}")
        return None


client = get_bigquery_client()

COMPANIES = [
    {
        "id": "ASIA",
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
    }
]


def get_ecount_session(com, force_refresh: bool = False):
    """จัดการเข้าสู่ระบบ ECOUNT พร้อมระบบ Cache / Force Refresh เพื่อแก้ปัญหา HTTP 412"""
    com_id = com["id"]
    if force_refresh:
        ECOUNT_SESSIONS.pop(com_id, None)

    if com_id in ECOUNT_SESSIONS and not force_refresh:
        return ECOUNT_SESSIONS[com_id]

    if not com["api_key"] or not com["code"]:
        return None, None

    login_url = f"https://oapi{com['zone'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    payload = {
        "API_CERT_KEY": com["api_key"],
        "COM_CODE": com["code"],
        "LAN_TYPE": "th-TH",
        "USER_ID": com["user_id"],
        "ZONE": com["zone"].upper()
    }
    try:
        res = requests.post(login_url, json=payload, headers=ECOUNT_API_HEADERS, timeout=20)
        if res.status_code == 200:
            res_json = res.json()
            if str(res_json.get("Status")) == "200":
                datas = res_json.get("Data", {}).get("Datas", {})
                session = (datas.get("SESSION_ID"), datas.get("HOST_URL"))
                if session[0] and session[1]:
                    ECOUNT_SESSIONS[com_id] = session
                    return session
    except Exception as e:
        print(f"  ❌ Login Exception ({com['id']}): {e}")
    return None, None


def ecount_post(url, payload, timeout=30):
    return requests.post(url, json=payload, headers=ECOUNT_API_HEADERS, timeout=timeout)


def ecount_api_url(host_url, endpoint):
    return f"https://{host_url.rstrip('/')}/ECERP/OAPI/V2/{endpoint.lstrip('/')}"


def get_ecount_result(response):
    try:
        data = response.json()
    except ValueError:
        return []

    if str(data.get("Status")) != "200":
        return []

    result_data = data.get("Data", {}) or {}
    return result_data.get("Result", []) or result_data.get("Datas", []) or []


def fetch_warehouse_dict(com, session_id, host_url):
    """ดึง Dict ของรหัสคลังและชื่อคลังสินค้า {WH_CD: WH_DES} พร้อม Retry เมื่อเจอ 412"""
    wh_dict = {}
    current_session = session_id
    current_host = host_url

    for attempt in range(3):
        url = f"{ecount_api_url(current_host, 'InventoryBasic/GetListWarehouse')}?SESSION_ID={current_session}"
        payload = {"WH_CD": "", "DEL_GUBUN": "N"}
        try:
            res = ecount_post(url, payload, timeout=20)
            if res.status_code == 412:
                print(f"  ⚠️ Fetch Warehouse [{com['id']}]: HTTP 412 — ลองขอ Session ใหม่ (รอบที่ {attempt + 1})")
                time.sleep(3)
                current_session, current_host = get_ecount_session(com, force_refresh=True)
                if not current_session:
                    break
                continue

            if res.status_code == 200:
                for item in get_ecount_result(res):
                    wh_cd = first_nonempty(item, "WH_CD", "WH", "WAREHOUSE_CD", "WAREHOUSE", "LOCATION_CD", "LOCATION")
                    wh_des = first_nonempty(item, "WH_DES", "WH_NAME", "WAREHOUSE_DES", "LOCATION_DES", "LOCATION_NAME")
                    if wh_cd:
                        wh_dict[wh_cd] = wh_des
                break
        except Exception as exc:
            print(f"  ⚠️ Fetch Warehouse Master Failed ({com['id']}): {exc}")
            break
    return wh_dict


def fetch_inventory_by_location(com, session_id, host_url, wh_cd=""):
    """ดึงรายงานสต็อกแยกตามคลังสินค้า รองรับ Retry 412"""
    current_session = session_id
    current_host = host_url

    for attempt in range(3):
        url = f"{ecount_api_url(current_host, 'InventoryBalance/GetListInventoryBalanceStatusByLocation')}?SESSION_ID={current_session}"
        payload = {
            "PROD_CD": "",
            "WH_CD": wh_cd,
            "BASE_DATE": datetime.now().strftime("%Y%m%d"),
            "BAL_FLAG": "N",
            "DEL_GUBUN": "N",
            "DEL_LOCATION_YN": "N",
        }
        try:
            res = ecount_post(url, payload)
            if res.status_code == 412:
                print(f"  ⚠️ Inventory Balance Status By Location [{com['id']}]: HTTP 412 — กำลัง Re-login (รอบที่ {attempt + 1})")
                time.sleep(3)
                current_session, current_host = get_ecount_session(com, force_refresh=True)
                if not current_session:
                    break
                continue

            if res.status_code != 200:
                return []
            return get_ecount_result(res)
        except Exception as exc:
            print(f"  ⚠️ GetListInventoryBalanceStatusByLocation failed ({com['id']}): {exc}")
            break
    return []


def fetch_asia_inventory(com, session_id, host_url):
    items = fetch_inventory_by_location(com, session_id, host_url)
    if any(first_nonempty(item, "PROD_DES") or first_nonempty(item, "WH_DES") for item in items):
        return items
    return []


COMPANY_FIELD_MAP = {
    "ASIA": {
        "prod_cd": ["PROD_CD", "ITEM_CD", "SKU", "PRODUCT_CD"],
        "prod_des": ["PROD_DES", "PROD_NAME", "ITEM_NAME", "ITEM_DES", "DESCRIPTION", "DESC", "PRODUCT_NAME", "PROD_DSC"],
        "size_des": ["SIZE_DES", "SIZE", "UNIT_DES", "UNIT", "PROD_SIZE_DES"],
        "wh_cd": ["WH_CD", "WH", "WAREHOUSE_CD", "WAREHOUSE", "LOCATION_CD", "LOCATION"],
        "wh_des": ["WH_DES", "WAREHOUSE_DES", "LOCATION_DES", "LOCATION_NAME", "WH_NAME"],
        "bal_qty": ["BAL_QTY", "QTY", "STOCK_QTY", "AVAILABLE_QTY"],
    },
    "ROBOTICS": {
        "prod_cd": ["PROD_CD", "ITEM_CD", "SKU", "PRODUCT_CD"],
        "prod_des": ["PROD_DES", "PROD_NAME", "ITEM_NAME", "ITEM_DES", "DESCRIPTION", "DESC", "PRODUCT_NAME", "PROD_DSC"],
        "size_des": ["SIZE_DES", "SIZE", "UNIT_DES", "UNIT", "PROD_SIZE_DES"],
        "wh_cd": ["WH_CD", "WH", "WAREHOUSE_CD", "WAREHOUSE", "LOCATION_CD", "LOCATION"],
        "wh_des": ["WH_DES", "WAREHOUSE_DES", "LOCATION_DES", "LOCATION_NAME", "WH_NAME"],
        "bal_qty": ["BAL_QTY", "QTY", "STOCK_QTY", "AVAILABLE_QTY"],
    },
    "RUAMSINTHAI": {
        "prod_cd": ["PROD_CD", "ITEM_CD", "SKU", "PRODUCT_CD"],
        "prod_des": ["PROD_DES", "PROD_NAME", "ITEM_NAME", "ITEM_DES", "DESCRIPTION", "DESC", "PRODUCT_NAME", "PROD_DSC"],
        "size_des": ["SIZE_DES", "SIZE", "UNIT_DES", "UNIT", "PROD_SIZE_DES"],
        "wh_cd": ["WH_CD", "WH", "WAREHOUSE_CD", "WAREHOUSE", "LOCATION_CD", "LOCATION"],
        "wh_des": ["WH_DES", "WAREHOUSE_DES", "LOCATION_DES", "LOCATION_NAME", "WH_NAME"],
        "bal_qty": ["BAL_QTY", "QTY", "STOCK_QTY", "AVAILABLE_QTY"],
    },
}


def first_nonempty(item, *keys):
    normalized_item = {
        str(item_key).strip().upper(): value
        for item_key, value in item.items()
    }
    for key in keys:
        value = normalized_item.get(str(key).strip().upper())
        if value is None:
            continue
        value = str(value).strip()
        if value:
            return value
    return ""


def parse_float(value):
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        try:
            return float(Decimal(text))
        except (InvalidOperation, ValueError):
            return 0.0


def normalize_wh(value):
    if value is None:
        return ""
    value = str(value).strip()
    if not value:
        return ""
    return value


def normalize_inventory_item(company_id, item):
    company_map = COMPANY_FIELD_MAP.get(company_id.upper(), COMPANY_FIELD_MAP["ASIA"])
    prod_cd = first_nonempty(item, *company_map["prod_cd"]) or ""
    prod_des = first_nonempty(item, *company_map["prod_des"]) or prod_cd
    size_des = first_nonempty(item, *company_map["size_des"]) or ""
    wh_cd = first_nonempty(item, *company_map["wh_cd"]) or "-"
    wh_des = first_nonempty(item, *company_map["wh_des"]) or ""

    bal_qty = parse_float(first_nonempty(item, *company_map["bal_qty"]))

    return {
        "prod_cd": prod_cd,
        "prod_des": prod_des,
        "size_des": size_des,
        "wh_cd": wh_cd,
        "wh_des": wh_des,
        "bal_qty": bal_qty,
    }


def fetch_all_company_data():
    all_master_rows = []
    all_bal_rows = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for idx, com in enumerate(COMPANIES):
        com_id = com["id"]
        com_code = com["code"]
        if not com_code or not com["api_key"]:
            print(f"⚠️ ข้ามบริษัท {com_id} (ยังไม่ได้ใส่ Credentials ใน .env)")
            continue

        # เว้นระยะห่างก่อนเริ่มดึงข้อมูลบริษัทถัดไป เพื่อป้องกัน Rate Limit / HTTP 412
        if idx > 0:
            time.sleep(2)

        print(f"\n🔄 ดึงข้อมูลจาก Ecount บริษัท: {com_id} (COM_CODE: {com_code})")
        session_id, host_url = get_ecount_session(com)
        if not session_id:
            print(f"❌ ไม่สามารถเข้าสู่ระบบบริษัท {com_id} ได้")
            continue

        # ดึง Master รายชื่อคลังสินค้าประจำบริษัท
        wh_dict = fetch_warehouse_dict(com, session_id, host_url)

        # 1. Fetch Master Products
        master_dict = {}
        try:
            url_master = f"{ecount_api_url(host_url, 'InventoryBasic/GetListProduct')}?SESSION_ID={session_id}"
            payload_master = {
                "PROD_CD": "",
                "DEL_GUBUN": "N",
                "REQUEST_TYPE": "M"
            }
            res_master = ecount_post(url_master, payload_master, timeout=20)
            if res_master.status_code == 412:
                print(f"  ⚠️ Fetch Master Products [{com_id}]: HTTP 412 — กำลัง Re-login")
                session_id, host_url = get_ecount_session(com, force_refresh=True)
                if session_id:
                    url_master = f"{ecount_api_url(host_url, 'InventoryBasic/GetListProduct')}?SESSION_ID={session_id}"
                    res_master = ecount_post(url_master, payload_master, timeout=20)

            if res_master and res_master.status_code == 200:
                for item in get_ecount_result(res_master):
                    p_cd = first_nonempty(item, *COMPANY_FIELD_MAP[com_id]["prod_cd"])
                    if p_cd:
                        p_des = first_nonempty(item, *COMPANY_FIELD_MAP[com_id]["prod_des"]) or p_cd
                        s_des = first_nonempty(item, *COMPANY_FIELD_MAP[com_id]["size_des"])
                        master_dict[p_cd] = {"prod_des": p_des, "size_des": s_des}
        except Exception:
            pass

        # 2. Fetch Inventory Balance
        try:
            if com_id == "ASIA":
                items = fetch_asia_inventory(com, session_id, host_url)
            else:
                items = fetch_inventory_by_location(com, session_id, host_url)

            if len(items) >= 10000:
                print(f"  ⚠️ ข้อมูลแตะ Limit 10,000 รายการ ({com_id}) -> สลับไปวนดึงแยกรายคลังสินค้า...")
                wh_list = list(wh_dict.keys())
                if wh_list:
                    items = []
                    for wh in wh_list:
                        wh_items = fetch_inventory_by_location(com, session_id, host_url, wh_cd=wh)
                        items.extend(wh_items)

            if not items:
                for attempt in range(3):
                    base_date = datetime.now().strftime("%Y%m%d")
                    url_bal = f"{ecount_api_url(host_url, 'InventoryBalance/GetListInventoryBalanceStatus')}?SESSION_ID={session_id}"
                    payload_bal = {
                        "BASE_DATE": base_date,
                        "ZERO_FLAG": "N",
                        "BAL_FLAG": "N",
                        "DEL_GUBUN": "N",
                        "SAFE_FLAG": "N"
                    }
                    res_bal = ecount_post(url_bal, payload_bal)

                    if res_bal.status_code == 412:
                        print(f"  ⚠️ Inventory Balance ({com_id}): HTTP 412 ชั่วคราว — ลองรีเฟรช Session ใหม่ (รอบที่ {attempt + 1})")
                        time.sleep(3)
                        session_id, host_url = get_ecount_session(com, force_refresh=True)
                        if not session_id:
                            print(f"  ❌ Inventory Balance ({com_id}): รีเฟรช Session ไม่สำเร็จ")
                            break
                        continue

                    if res_bal.status_code == 200:
                        result_items = get_ecount_result(res_bal)
                        if result_items:
                            items = result_items
                            break
                        else:
                            print(f"  ⚠️ Inventory Balance ({com_id}): API ไม่ส่งรายการข้อมูลกลับมา")
                            break
                    else:
                        print(f"  ⚠️ Inventory Balance ({com_id}): Server HTTP Code {res_bal.status_code}")
                        break

            count_bal = 0
            for item in items:
                normalized = normalize_inventory_item(com_id, item)
                p_cd = normalized["prod_cd"].strip()
                if not p_cd:
                    continue

                wh_cd = normalize_wh(normalized["wh_cd"])
                if normalized["wh_des"] and wh_cd != "-":
                    wh_dict.setdefault(wh_cd, normalized["wh_des"])
                
                # ประกบชื่อคลังสินค้า: ถ้ามีชื่อใน Master ให้แสดง "รหัสคลัง - ชื่อคลัง"
                wh_name_from_master = wh_dict.get(wh_cd, normalized["wh_des"])
                if wh_name_from_master and wh_name_from_master != wh_cd:
                    full_wh_label = f"{wh_cd} - {wh_name_from_master}"
                else:
                    full_wh_label = wh_cd

                p_des = normalized["prod_des"] or p_cd
                s_des = normalized["size_des"]
                bal_qty = normalized["bal_qty"]

                all_bal_rows.append({
                    "company_id": com_id,
                    "company_code": str(com_code),
                    "prod_cd": p_cd,
                    "wh_cd": full_wh_label, # นำชื่อคลังต่อท้ายรหัสคลัง
                    "bal_qty": bal_qty,
                    "updated_at": now_iso
                })
                count_bal += 1

                if p_cd not in master_dict:
                    master_dict[p_cd] = {"prod_des": p_des, "size_des": s_des}

            print(f"  📊 Inventory Balance ({com_id}): ดึงสำเร็จ {count_bal} รายการ")
        except Exception as e:
            print(f"  ❌ Inventory Balance Error ({com_id}): {e}")

        for p_cd, m_info in master_dict.items():
            all_master_rows.append({
                "company_id": com_id,
                "company_code": str(com_code),
                "prod_cd": p_cd,
                "prod_des": m_info["prod_des"],
                "size_des": m_info["size_des"],
                "updated_at": now_iso
            })
        print(f"  📦 Master Products ({com_id}): รวบรวมสำเร็จ {len(master_dict)} รายการ")

    if client is None:
        print("\n⚠️ ข้ามการอัปเดต BigQuery เพราะ client ไม่สามารถเริ่มต้นได้")
        return

    job_config = bigquery.LoadJobConfig(write_disposition="WRITE_TRUNCATE")

    if all_master_rows:
        table_ref = f"{PROJECT_ID}.{DATASET_ID}.master_products"
        client.load_table_from_json(all_master_rows, table_ref, location=LOCATION, job_config=job_config).result()
        print(f"\n✅ อัปเดต master_products ลง BigQuery รวมสำเร็จ: {len(all_master_rows)} รายการ")

    if all_bal_rows:
        table_ref = f"{PROJECT_ID}.{DATASET_ID}.inventory_balance"
        client.load_table_from_json(all_bal_rows, table_ref, location=LOCATION, job_config=job_config).result()
        print(f"✅ อัปเดต inventory_balance ลง BigQuery รวมสำเร็จ: {len(all_bal_rows)} รายการ")

    # ซิงค์ข้อมูลใบสั่งซื้อ (PO) และค่าใช้จ่าย IT ตั้งแต่ 1 ม.ค. ปีที่แล้ว ถึงวันนี้
    try:
        fetch_all_company_po()
    except Exception as exc:
        print(f"⚠️ ซิงค์ PO ไม่สำเร็จ: {exc}")


IT_PROJECT_CODES = {
    "ASIA": "24",
    "RUAMSINTHAI": "21",
    "ROBOTICS": "20",
}


IT_NAME_PATTERN = re.compile(r"(?<![A-Z])IT(?![A-Z])")


def is_it_project(company_id, project_code, project_name):
    code = str(project_code or "").strip().upper()
    numeric_code = re.fullmatch(r"0*(\d+)(?:\.0+)?", code)
    normalized_code = numeric_code.group(1) if numeric_code else re.sub(r"^0+(?=\d)", "", code)
    expected_code = IT_PROJECT_CODES.get(str(company_id or "").strip().upper())
    # เดิมใช้ "IT" in name -> ชื่อโครงการภาษาอังกฤษที่มีตัวอักษร IT อยู่ข้างใน (UNIT, CREDIT, PROFIT, EDIT ฯลฯ)
    # ถูกนับเป็นค่าใช้จ่าย IT ด้วย ทำให้ยอด IT เกินจริง -> ตอนนี้ต้องเป็นคำว่า IT เดี่ยวๆ (ไม่ติดตัวอักษรอังกฤษอื่น)
    return normalized_code == expected_code or bool(IT_NAME_PATTERN.search(str(project_name or "").upper()))


def get_ecount_session_client(com):
    s = requests.Session()
    s.headers.update({
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    })
    login_url = f"https://oapi{com['zone'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    payload = {
        "API_CERT_KEY": com["api_key"],
        "COM_CODE": com["code"],
        "LAN_TYPE": "th-TH",
        "USER_ID": com["user_id"],
        "ZONE": com["zone"].upper(),
    }
    try:
        res = s.post(login_url, json=payload, timeout=25)
    except requests.RequestException as exc:
        print(f"  ❌ Login Exception ({com['id']}): {exc}")
        return None, None, None
    if res.status_code == 200:
        try:
            res_json = res.json()
        except ValueError:
            return None, None, None
        if str(res_json.get("Status")) == "200":
            datas = res_json.get("Data", {}).get("Datas", {})
            session_id = datas.get("SESSION_ID")
            host_url = datas.get("HOST_URL")
            if session_id and host_url:
                return s, session_id, host_url
    return None, None, None


# --- PO sync settings ---
PO_PAGE_SIZE = 100
PO_WINDOW_DAYS = 30                     # ช่วงค้นหาต่อครั้ง (รวมวันแรกและวันสุดท้าย) ไม่เกิน 30 วัน
PO_REQUEST_DELAY_SECONDS = float(os.getenv("PO_REQUEST_DELAY_SECONDS", "1.0"))
PO_MAX_ATTEMPTS = 4
PO_MAX_PAGES_PER_WINDOW = 200

# รายงานผลการซิงค์ PO ล่าสุด (ให้ app.py นำไปแสดงใน /api/project-expense-audit และ /api/sync-po)
LAST_PO_SYNC_REPORT = {}

PO_TABLE_SCHEMA = [
    bigquery.SchemaField("company_id", "STRING"),
    bigquery.SchemaField("po_no", "STRING"),
    bigquery.SchemaField("ord_no", "STRING"),
    bigquery.SchemaField("ord_date", "STRING"),
    bigquery.SchemaField("wh_cd", "STRING"),
    bigquery.SchemaField("wh_des", "STRING"),
    bigquery.SchemaField("pjt_cd", "STRING"),
    bigquery.SchemaField("pjt_des", "STRING"),
    bigquery.SchemaField("cust_cd", "STRING"),
    bigquery.SchemaField("cust_des", "STRING"),
    bigquery.SchemaField("prod_des", "STRING"),
    bigquery.SchemaField("size_des", "STRING"),
    bigquery.SchemaField("qty", "FLOAT"),
    bigquery.SchemaField("price", "FLOAT"),
    bigquery.SchemaField("supply_amt", "FLOAT"),
    bigquery.SchemaField("vat_amt", "FLOAT"),
    bigquery.SchemaField("total_amt", "FLOAT"),
    bigquery.SchemaField("pic", "STRING"),
    bigquery.SchemaField("p_flag", "STRING"),
    bigquery.SchemaField("status_name", "STRING"),
    bigquery.SchemaField("ref_des", "STRING"),
    bigquery.SchemaField("seq", "STRING"),
    bigquery.SchemaField("updated_at", "TIMESTAMP"),
]

IT_TABLE_SCHEMA = [
    bigquery.SchemaField("company_id", "STRING"),
    bigquery.SchemaField("po_no", "STRING"),
    bigquery.SchemaField("ord_no", "STRING"),
    bigquery.SchemaField("ord_date", "STRING"),
    bigquery.SchemaField("pjt_cd", "STRING"),
    bigquery.SchemaField("pjt_des", "STRING"),
    bigquery.SchemaField("cust_cd", "STRING"),
    bigquery.SchemaField("cust_des", "STRING"),
    bigquery.SchemaField("prod_des", "STRING"),
    bigquery.SchemaField("qty", "FLOAT"),
    bigquery.SchemaField("buy_amt", "FLOAT"),
    bigquery.SchemaField("vat_amt", "FLOAT"),
    bigquery.SchemaField("total_amt", "FLOAT"),
    bigquery.SchemaField("pic_name", "STRING"),
    bigquery.SchemaField("p_flag", "STRING"),
    bigquery.SchemaField("status_name", "STRING"),
    bigquery.SchemaField("updated_at", "TIMESTAMP"),
]


def default_po_sync_start():
    """ค่าเริ่มต้นช่วงซิงค์ PO: ตั้งแต่ 1 ม.ค. ของปีที่แล้ว (เวลาไทย) ถึงวันนี้
    เดิมใช้ 365 วันย้อนหลัง ทำให้ข้อมูลก่อนหน้านั้นหายจาก BigQuery ทุกรอบที่ซิงค์ (เพราะ WRITE_TRUNCATE)
    เช่น เลือกดูยอดทั้งปีที่แล้วจะได้ยอดไม่ครบโดยไม่มีอะไรเตือน"""
    today = datetime.now(timezone(timedelta(hours=7))).date()
    return datetime(today.year - 1, 1, 1).date(), today


def _po_items_from_body(body):
    data = body.get("Data", {}) or {}
    items = data.get("Result") or data.get("Datas") or data.get("List") or []
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        items = []
    total_raw = data.get("TotalCnt", data.get("TOTAL_CNT"))
    try:
        total_cnt = int(total_raw) if total_raw not in (None, "") else None
    except (TypeError, ValueError):
        total_cnt = None
    return items, total_cnt


def _ecount_error_text(r, body):
    if body:
        err = body.get("Error") or body.get("Errors")
        if err:
            return f"Status={body.get('Status')} {str(err)[:300]}"
        return f"Status={body.get('Status')}"
    return f"HTTP {getattr(r, 'status_code', '?')}"


def fetch_pos_for_company(com, days_back=None, start_date=None, end_date=None):
    """ดึง PO ของบริษัทเดียว แบ่งช่วงละไม่เกิน 30 วัน

    คืนค่า (items, report) โดย report บอกว่าช่วงไหนดึงไม่สำเร็จ — เดิมถ้า ECOUNT ตอบ HTTP 200 แต่ Status != 200
    (เช่น session หมดอายุ / เรียกถี่เกิน) โค้ดจะได้รายการว่างแล้ว break ออกเงียบๆ ทำให้ทั้งช่วง 30 วันนั้นหายไป
    จาก BigQuery โดยไม่มี log เตือน และถ้า TotalCnt ไม่ได้ส่งมาจะหยุดที่หน้าแรก (100 รายการแรก) เสมอ
    """
    report = {
        "company_id": com["id"],
        "ok": False,
        "rows": 0,
        "windows_total": 0,
        "windows_failed": [],
        "error": "",
    }

    default_end = None
    if start_date is None:
        if days_back:
            default_end = datetime.now(timezone(timedelta(hours=7))).date()
            start_date = default_end - timedelta(days=int(days_back))
        else:
            start_date, default_end = default_po_sync_start()
    if end_date is None:
        end_date = default_end or datetime.now(timezone(timedelta(hours=7))).date()
    report["coverage_from"] = start_date.strftime("%Y%m%d")
    report["coverage_to"] = end_date.strftime("%Y%m%d")

    session, session_id, host_url = get_ecount_session_client(com)
    if not session:
        report["error"] = "ไม่สามารถ Login ECOUNT ได้"
        print(f"  ❌ ไม่สามารถ Login บริษัท {com['id']} ได้")
        return [], report

    windows = []
    curr = start_date
    while curr <= end_date:
        w_end = min(curr + timedelta(days=PO_WINDOW_DAYS - 1), end_date)
        windows.append((curr.strftime("%Y%m%d"), w_end.strftime("%Y%m%d")))
        curr = w_end + timedelta(days=1)
    report["windows_total"] = len(windows)

    all_items = []
    for f_date, t_date in windows:
        window_items = []
        page = 1
        window_error = ""
        while page <= PO_MAX_PAGES_PER_WINDOW:
            payload = {
                "PROD_CD": "",
                "CUST_CD": "",
                "ListParam": {
                    "PAGE_CURRENT": page,
                    "PAGE_SIZE": PO_PAGE_SIZE,
                    "BASE_DATE_FROM": f_date,
                    "BASE_DATE_TO": t_date,
                },
            }
            body, r, page_ok = {}, None, False
            for attempt in range(1, PO_MAX_ATTEMPTS + 1):
                url = f"https://{host_url}/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID={session_id}"
                try:
                    r = session.post(url, json=payload, timeout=30)
                    try:
                        body = r.json()
                    except ValueError:
                        body = {}
                    if r.status_code == 200 and str(body.get("Status")) == "200":
                        page_ok = True
                        break
                except requests.RequestException as exc:
                    body = {"Status": "EXC", "Error": str(exc)}

                window_error = _ecount_error_text(r, body)
                if attempt < PO_MAX_ATTEMPTS:
                    # รอแบบทวีคูณ แล้ว login ใหม่ (รองรับทั้ง 412, session หมดอายุ, และเรียกถี่เกิน)
                    time.sleep(2 * attempt)
                    new_session, new_sid, new_host = get_ecount_session_client(com)
                    if new_session:
                        session, session_id, host_url = new_session, new_sid, new_host

            if not page_ok:
                break
            window_error = ""  # หน้านี้สำเร็จหลัง retry แล้ว ไม่ถือเป็นข้อผิดพลาด

            items, total_cnt = _po_items_from_body(body)
            window_items.extend(items)
            time.sleep(PO_REQUEST_DELAY_SECONDS)

            if not items:
                break
            if total_cnt is not None:
                if len(window_items) >= total_cnt:
                    break
            elif len(items) < PO_PAGE_SIZE:
                # ไม่มี TotalCnt -> หน้าไม่เต็มแปลว่าหน้าสุดท้าย
                break
            page += 1
        else:
            window_error = f"เกิน {PO_MAX_PAGES_PER_WINDOW} หน้า"

        if window_error and not window_items:
            report["windows_failed"].append({"from": f_date, "to": t_date, "error": window_error})
            print(f"  ⚠️ PO {com['id']} ช่วง {f_date}-{t_date} ดึงไม่สำเร็จ: {window_error}")
        elif window_error:
            # ได้มาบางหน้าแล้วหน้าถัดไปล้ม -> ข้อมูลช่วงนี้ไม่ครบ ถือว่าล้มเหลวเช่นกัน
            report["windows_failed"].append({"from": f_date, "to": t_date, "error": f"ได้ {len(window_items)} รายการแล้วหน้าถัดไปล้ม: {window_error}"})
            print(f"  ⚠️ PO {com['id']} ช่วง {f_date}-{t_date} ได้ไม่ครบ ({len(window_items)} รายการ): {window_error}")
        all_items.extend(window_items)

    # ตัดเฉพาะแถวที่ซ้ำกันทุกฟิลด์ (เกิดได้เฉพาะตอน ECOUNT ส่งหน้าซ้ำ) — เดิมใช้ key แค่ วันที่/เลขที่/สินค้า/จำนวน
    # ซึ่งจะรวมบรรทัดที่สินค้าและจำนวนเหมือนกันแต่ราคาหรือโครงการต่างกันให้เหลือแถวเดียว ทำให้ยอดขาดหาย
    unique_items = []
    seen = set()
    for item in all_items:
        if not isinstance(item, dict):
            continue
        key = repr(sorted((str(k), str(v)) for k, v in item.items()))
        if key not in seen:
            seen.add(key)
            unique_items.append(item)

    report["rows"] = len(unique_items)
    report["ok"] = not report["windows_failed"]
    flag = "สำเร็จ" if report["ok"] else f"ไม่ครบ ({len(report['windows_failed'])}/{len(windows)} ช่วงล้มเหลว)"
    print(f"  📄 ดึงใบสั่งซื้อ {com['id']}: {flag} {len(unique_items)} รายการ ({report['coverage_from']}-{report['coverage_to']})")
    return unique_items, report


def _po_row_from_item(com_id, item, now_iso):
    pick = lambda *keys: first_nonempty(item, *keys)
    pjt_cd = pick("PJT_CD", "PROJECT_CD", "PROJECT_CODE")
    pjt_cd = re.sub(r"\.0+$", "", pjt_cd)  # 24.0 -> 24
    pjt_des = re.sub(r"\s+", " ", pick("PJT_DES", "PROJECT_DES", "PROJECT_NAME"))
    ord_date_raw = pick("ORD_DATE", "IO_DATE")
    ord_date_digits = re.sub(r"[^0-9]", "", ord_date_raw)
    ord_date = ord_date_digits[:8] if len(ord_date_digits) >= 8 else ord_date_raw
    ord_no = pick("ORD_NO")
    io_no = pick("IO_NO")
    raw_po = io_no if io_no and io_no not in ("0", "0.0") else f"PO-{ord_date}-{ord_no}"
    qty = parse_float(pick("QTY"))
    buy_amt = parse_float(pick("BUY_AMT", "SUPPLY_AMT"))
    vat_amt = parse_float(pick("VAT_AMT"))
    total_amt = parse_float(pick("TOTAL_AMT")) or (buy_amt + vat_amt)
    p_flag = pick("P_FLAG").upper()

    # Map สถานะ ECOUNT P_FLAG (รวมถึงรหัสตัวเลข 9 จาก API)
    if p_flag in ("Y", "9", "COMPLETED", "CLOSED"):
        status_name = "ดำเนินการเสร็จแล้ว"
    elif p_flag in ("N", "0", "1", "PROGRESS", "PENDING"):
        status_name = "กำลังดำเนินการ"
    else:
        status_name = pick("STATUS_DES", "CONFIRM_YN") or (f"สถานะ {p_flag}" if p_flag else "ไม่ระบุ")

    return {
        "company_id": com_id,
        "po_no": raw_po,
        "ord_no": ord_no,
        "ord_date": ord_date,
        "wh_cd": pick("WH_CD"),
        "wh_des": pick("WH_DES"),
        "pjt_cd": pjt_cd,
        "pjt_des": pjt_des,
        "cust_cd": pick("CUST", "CUST_CD"),
        "cust_des": pick("CUST_DES"),
        "prod_des": pick("PROD_DES", "TTL_CTT"),
        "size_des": "",
        "qty": qty,
        "price": (buy_amt / qty) if qty > 0 else 0.0,
        "supply_amt": buy_amt,
        "vat_amt": vat_amt,
        "total_amt": total_amt,
        "pic": pick("CUST_NAME", "EMP_CD", "WRITER_ID") or "-",
        "p_flag": p_flag,
        "status_name": status_name,
        "ref_des": pick("REF_DES"),
        "seq": ord_no,
        "updated_at": now_iso,
    }


def _it_row_from_po_row(row):
    return {
        "company_id": row["company_id"],
        "po_no": row["po_no"],
        "ord_no": row["ord_no"],
        "ord_date": row["ord_date"],
        "pjt_cd": row["pjt_cd"] or IT_PROJECT_CODES.get(row["company_id"], ""),
        "pjt_des": row["pjt_des"] or "แผนก IT",
        "cust_cd": row["cust_cd"],
        "cust_des": row["cust_des"],
        "prod_des": row["prod_des"],
        "qty": row["qty"],
        "buy_amt": row["supply_amt"],
        "vat_amt": row["vat_amt"],
        "total_amt": row["total_amt"],
        "pic_name": row["pic"],
        "p_flag": row["p_flag"],
        "status_name": row["status_name"],
        "updated_at": row["updated_at"],
    }


def _load_existing_po_rows(company_id):
    """อ่านแถว PO เดิมของบริษัทนี้จาก BigQuery (ใช้เก็บข้อมูลเดิมไว้ ถ้ารอบนี้ดึงจาก ECOUNT ไม่สำเร็จ/ไม่ครบ)"""
    fields = [f.name for f in PO_TABLE_SCHEMA]
    query = f"""
        SELECT * FROM `{PROJECT_ID}.{DATASET_ID}.purchase_orders`
        WHERE UPPER(TRIM(company_id)) = @company_id
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("company_id", "STRING", company_id)]
    )
    rows = []
    for r in client.query(query, job_config=job_config, location=LOCATION).result():
        d = dict(r.items())
        out = {}
        for name in fields:
            v = d.get(name)
            if name in ("qty", "price", "supply_amt", "vat_amt", "total_amt"):
                out[name] = parse_float(v)
            elif name == "updated_at":
                out[name] = v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else None)
            else:
                out[name] = "" if v is None else (v.strftime("%Y%m%d") if hasattr(v, "strftime") else str(v))
        rows.append(out)
    return rows


def fetch_all_company_po(days_back=None):
    """ดึงข้อมูล PO และค่าใช้จ่าย IT จากทุกบริษัท แล้วบันทึกลง BigQuery

    ป้องกันข้อมูลหาย: ถ้าบริษัทใดดึงไม่สำเร็จ/ไม่ครบ จะใช้ข้อมูลเดิมของบริษัทนั้นใน BigQuery ต่อไป
    (เดิม WRITE_TRUNCATE ทับทั้งตาราง ทำให้บริษัทที่ login ไม่ผ่านรอบนั้นมียอดเป็น 0 ทันที)
    """
    if client is None:
        print("⚠️ BigQuery client ไม่พร้อมใช้งาน ข้ามการซิงค์ PO")
        return {"po_total": 0, "it_total": 0, "companies": {}, "warnings": ["BigQuery client ไม่พร้อมใช้งาน"]}

    label = f"ย้อนหลัง {days_back} วัน" if days_back else "ตั้งแต่ 1 ม.ค. ปีที่แล้ว"
    print(f"\n🔄 เริ่มกระบวนการซิงค์ใบสั่งซื้อ (PO) {label}...")
    now_iso = datetime.now(timezone.utc).isoformat()
    all_po_rows = []
    companies_report = {}
    warnings = []

    for idx, com in enumerate(COMPANIES):
        if not com["code"] or not com["api_key"]:
            companies_report[com["id"]] = {"company_id": com["id"], "ok": False, "rows": 0, "error": "ไม่ได้ตั้งค่า COM_CODE/API_KEY", "windows_failed": []}
            continue
        if idx > 0:
            time.sleep(2)

        items, report = fetch_pos_for_company(com, days_back=days_back)
        new_rows = [_po_row_from_item(com["id"], item, now_iso) for item in items]

        if report["ok"]:
            all_po_rows.extend(new_rows)
            report["used"] = "new"
        else:
            existing = []
            try:
                existing = _load_existing_po_rows(com["id"])
            except Exception as exc:
                print(f"  ⚠️ อ่านข้อมูล PO เดิมของ {com['id']} ไม่ได้: {exc}")
            if existing:
                all_po_rows.extend(existing)
                report["used"] = "previous"
                msg = f"{com['id']}: ดึงจาก ECOUNT ไม่ครบ ใช้ข้อมูลเดิม {len(existing)} รายการแทน ({report.get('error') or str(len(report['windows_failed'])) + ' ช่วงล้มเหลว'})"
            else:
                all_po_rows.extend(new_rows)
                report["used"] = "partial"
                msg = f"{com['id']}: ดึงจาก ECOUNT ไม่ครบ และไม่มีข้อมูลเดิม ใช้ข้อมูลที่ได้ {len(new_rows)} รายการ ({report.get('error') or str(len(report['windows_failed'])) + ' ช่วงล้มเหลว'})"
            warnings.append(msg)
            print(f"  ⚠️ {msg}")
        companies_report[com["id"]] = report

    it_expense_rows = [
        _it_row_from_po_row(row) for row in all_po_rows
        if is_it_project(row["company_id"], row["pjt_cd"], row["pjt_des"])
    ]

    if all_po_rows:
        job_config = bigquery.LoadJobConfig(write_disposition="WRITE_TRUNCATE", schema=PO_TABLE_SCHEMA)
        t_ref = f"{PROJECT_ID}.{DATASET_ID}.purchase_orders"
        client.load_table_from_json(all_po_rows, t_ref, location=LOCATION, job_config=job_config).result()
        print(f"✅ อัปเดต purchase_orders ลง BigQuery สำเร็จ: {len(all_po_rows)} รายการ")

    if it_expense_rows:
        job_config_it = bigquery.LoadJobConfig(write_disposition="WRITE_TRUNCATE", schema=IT_TABLE_SCHEMA)
        t_ref_it = f"{PROJECT_ID}.{DATASET_ID}.it_expenses"
        client.load_table_from_json(it_expense_rows, t_ref_it, location=LOCATION, job_config=job_config_it).result()
        print(f"✅ อัปเดต it_expenses ลง BigQuery สำเร็จ: {len(it_expense_rows)} รายการ")

    LAST_PO_SYNC_REPORT.clear()
    LAST_PO_SYNC_REPORT.update({
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "companies": companies_report,
        "warnings": warnings,
        "po_total": len(all_po_rows),
        "it_total": len(it_expense_rows),
    })
    return {"po_total": len(all_po_rows), "it_total": len(it_expense_rows), "companies": companies_report, "warnings": warnings}


if __name__ == "__main__":
    print("🚀 เริ่มต้นระบบ Multi-Company Inventory Sync Worker (Auto Loop)...")
    while True:
        try:
            current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            print(f"\n==========================================")
            print(f"⏰ รอบการ Sync อัตโนมัติ: {current_time}")
            print(f"==========================================")

            fetch_all_company_data()

            print(f"\n🎉 ซิงค์ข้อมูลสำเร็จ! กำลังรอรอบถัดไปในอีก {SYNC_INTERVAL_SECONDS // 60} นาที...")
        except KeyboardInterrupt:
            print("\n🛑 หยุดการทำงานของ Worker โดยผู้ใช้")
            break
        except Exception as e:
            print(f"\n❌ เกิดข้อผิดพลาดระหว่างกระบวนการ Sync: {e}")

        time.sleep(SYNC_INTERVAL_SECONDS)