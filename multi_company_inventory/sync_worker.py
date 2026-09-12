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

    # ซิงค์ข้อมูลใบสั่งซื้อ (PO) และค่าใช้จ่าย IT ย้อนหลังทั้งปี (365 วัน)
    try:
        fetch_all_company_po(days_back=365)
    except Exception as exc:
        print(f"⚠️ ซิงค์ PO ไม่สำเร็จ: {exc}")


IT_PROJECT_CODES = {
    "ASIA": "24",
    "RUAMSINTHAI": "21",
    "ROBOTICS": "20",
}


def is_it_project(company_id, project_code, project_name):
    code = str(project_code or "").strip().upper()
    numeric_code = re.fullmatch(r"0*(\d+)(?:\.0+)?", code)
    normalized_code = numeric_code.group(1) if numeric_code else re.sub(r"^0+(?=\d)", "", code)
    expected_code = IT_PROJECT_CODES.get(str(company_id or "").strip().upper())
    return normalized_code == expected_code or "IT" in str(project_name or "").upper()


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
    res = s.post(login_url, json=payload, timeout=25)
    if res.status_code == 200:
        res_json = res.json()
        if str(res_json.get("Status")) == "200":
            datas = res_json.get("Data", {}).get("Datas", {})
            session_id = datas.get("SESSION_ID")
            host_url = datas.get("HOST_URL")
            if session_id and host_url:
                return s, session_id, host_url
    return None, None, None


def fetch_pos_for_company(com, days_back=365):
    """ดึงข้อมูล PO ย้อนหลังแยกช่วงละ 30 วัน เพื่อไม่ให้ติด Limit ของ ECOUNT API"""
    session, session_id, host_url = get_ecount_session_client(com)
    if not session:
        print(f"  ❌ ไม่สามารถ Login บริษัท {com['id']} ได้")
        return []

    today = datetime.now().date()
    start_date = today - timedelta(days=days_back)

    windows = []
    curr = start_date
    while curr <= today:
        w_end = min(curr + timedelta(days=29), today)
        windows.append((curr.strftime("%Y%m%d"), w_end.strftime("%Y%m%d")))
        curr = w_end + timedelta(days=1)

    all_items = []
    for f_date, t_date in windows:
        page = 1
        retries = 0
        while True:
            url = f"https://{host_url}/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID={session_id}"
            payload = {
                "PROD_CD": "",
                "CUST_CD": "",
                "ListParam": {
                    "PAGE_CURRENT": page,
                    "PAGE_SIZE": 100,
                    "BASE_DATE_FROM": f_date,
                    "BASE_DATE_TO": t_date,
                },
            }
            try:
                r = session.post(url, json=payload, timeout=30)
                if r.status_code == 412:
                    retries += 1
                    if retries > 3:
                        break
                    time.sleep(2)
                    session, session_id, host_url = get_ecount_session_client(com)
                    if not session:
                        break
                    continue

                if r.status_code != 200:
                    break

                body = r.json()
                data = body.get("Data", {}) or {}
                items = data.get("Result", []) or []
                all_items.extend(items)

                total_cnt = int(data.get("TotalCnt") or 0)
                if len(items) == 0 or page * 100 >= total_cnt:
                    break
                page += 1
            except Exception as e:
                print(f"  ⚠️ Fetch PO error ({com['id']} p.{page}): {e}")
                break

    unique_items = []
    seen = set()
    for item in all_items:
        key = (item.get("ORD_DATE"), item.get("ORD_NO"), item.get("IO_NO"), item.get("PROD_DES"), item.get("QTY"))
        if key not in seen:
            seen.add(key)
            unique_items.append(item)

    print(f"  📄 ดึงใบสั่งซื้อ {com['id']}: สำเร็จ {len(unique_items)} รายการ (ย้อนหลัง {days_back} วัน)")
    return unique_items


def fetch_all_company_po(days_back=365):
    """ดึงข้อมูล PO และค่าใช้จ่าย IT จากทุกบริษัท แล้วบันทึกลง BigQuery"""
    if client is None:
        print("⚠️ BigQuery client ไม่พร้อมใช้งาน ข้ามการซิงค์ PO")
        return {"po_total": 0, "it_total": 0}

    print(f"\n🔄 เริ่มกระบวนการซิงค์ใบสั่งซื้อ (PO) ย้อนหลัง {days_back} วัน (ทั้งปี)...")
    now_iso = datetime.now(timezone.utc).isoformat()
    all_po_rows = []
    it_expense_rows = []

    for idx, com in enumerate(COMPANIES):
        if not com["code"] or not com["api_key"]:
            continue
        if idx > 0:
            time.sleep(2)

        items = fetch_pos_for_company(com, days_back=days_back)
        for item in items:
            pjt_cd = str(item.get("PJT_CD") or "").strip()
            pjt_des = str(item.get("PJT_DES") or "").strip()
            ord_date = str(item.get("ORD_DATE") or item.get("IO_DATE") or "").strip()
            ord_no = str(item.get("ORD_NO") or "").strip()
            io_no = str(item.get("IO_NO") or "").strip()
            raw_po = io_no if io_no and io_no not in ("0", "0.0") else f"PO-{ord_date}-{ord_no}"
            cust_cd = str(item.get("CUST") or "").strip()
            cust_des = str(item.get("CUST_DES") or "").strip()
            prod_des = str(item.get("PROD_DES") or item.get("TTL_CTT") or "").strip()
            qty = parse_float(item.get("QTY"))
            buy_amt = parse_float(item.get("BUY_AMT"))
            vat_amt = parse_float(item.get("VAT_AMT"))
            total_amt = parse_float(item.get("TOTAL_AMT")) or (buy_amt + vat_amt)
            pic_name = str(item.get("CUST_NAME") or item.get("EMP_CD") or item.get("WRITER_ID") or "-").strip()
            p_flag = str(item.get("P_FLAG") or "").strip().upper()
            
            # Map สถานะ ECOUNT P_FLAG (รวมถึงรหัสตัวเลข 9 จาก API)
            if p_flag in ("Y", "9", "COMPLETED", "CLOSED"):
                status_name = "ดำเนินการเสร็จแล้ว"
            elif p_flag in ("N", "0", "1", "PROGRESS", "PENDING"):
                status_name = "กำลังดำเนินการ"
            else:
                status_name = str(item.get("STATUS_DES") or item.get("CONFIRM_YN") or (f"สถานะ {p_flag}" if p_flag else "ไม่ระบุ")).strip()

            wh_cd = str(item.get("WH_CD") or "").strip()
            wh_des = str(item.get("WH_DES") or "").strip()
            ref_des = str(item.get("REF_DES") or "").strip()

            all_po_rows.append({
                "company_id": com["id"],
                "po_no": raw_po,
                "ord_no": ord_no,
                "ord_date": ord_date,
                "wh_cd": wh_cd,
                "wh_des": wh_des,
                "pjt_cd": pjt_cd,
                "pjt_des": pjt_des,
                "cust_cd": cust_cd,
                "cust_des": cust_des,
                "prod_des": prod_des,
                "size_des": "",
                "qty": qty,
                "price": (buy_amt / qty) if qty > 0 else 0.0,
                "supply_amt": buy_amt,
                "vat_amt": vat_amt,
                "total_amt": total_amt,
                "pic": pic_name,
                "p_flag": p_flag,
                "status_name": status_name,
                "ref_des": ref_des,
                "seq": ord_no,
                "updated_at": now_iso,
            })

            if is_it_project(com["id"], pjt_cd, pjt_des):
                it_expense_rows.append({
                    "company_id": com["id"],
                    "po_no": raw_po,
                    "ord_no": ord_no,
                    "ord_date": ord_date,
                    "pjt_cd": pjt_cd or IT_PROJECT_CODES.get(com["id"], ""),
                    "pjt_des": pjt_des or "แผนก IT",
                    "cust_cd": cust_cd,
                    "cust_des": cust_des,
                    "prod_des": prod_des,
                    "qty": qty,
                    "buy_amt": buy_amt,
                    "vat_amt": vat_amt,
                    "total_amt": total_amt,
                    "pic_name": pic_name,
                    "p_flag": p_flag,
                    "status_name": status_name,
                    "updated_at": now_iso,
                })

    job_config = bigquery.LoadJobConfig(write_disposition="WRITE_TRUNCATE")

    if all_po_rows:
        t_ref = f"{PROJECT_ID}.{DATASET_ID}.purchase_orders"
        client.load_table_from_json(all_po_rows, t_ref, location=LOCATION, job_config=job_config).result()
        print(f"✅ อัปเดต purchase_orders ลง BigQuery สำเร็จ: {len(all_po_rows)} รายการ")

    if it_expense_rows:
        t_ref_it = f"{PROJECT_ID}.{DATASET_ID}.it_expenses"
        client.load_table_from_json(it_expense_rows, t_ref_it, location=LOCATION, job_config=job_config).result()
        print(f"✅ อัปเดต it_expenses ลง BigQuery สำเร็จ: {len(it_expense_rows)} รายการ")

    return {"po_total": len(all_po_rows), "it_total": len(it_expense_rows)}

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