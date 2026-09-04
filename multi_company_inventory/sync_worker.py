import os
import time
import requests
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from google.cloud import bigquery
from dotenv import load_dotenv

load_dotenv()

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "multi-compan-inventory").strip()
DATASET_ID = "multi_company_inventory"
LOCATION = "asia-southeast1"
SYNC_INTERVAL_SECONDS = 1800
ECOUNT_API_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
}


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


def get_ecount_session(com):
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
        res = requests.post(login_url, json=payload, timeout=20)
        if res.status_code == 200:
            res_json = res.json()
            if str(res_json.get("Status")) == "200":
                datas = res_json.get("Data", {}).get("Datas", {})
                return datas.get("SESSION_ID"), datas.get("HOST_URL")
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


def fetch_warehouse_dict(session_id, host_url):
    """ดึง Dict ของรหัสคลังและชื่อคลังสินค้า {WH_CD: WH_DES}"""
    url = f"{ecount_api_url(host_url, 'InventoryBasic/GetListWarehouse')}?SESSION_ID={session_id}"
    payload = {"WH_CD": "", "DEL_GUBUN": "N"}
    wh_dict = {}
    try:
        res = ecount_post(url, payload, timeout=20)
        if res.status_code == 200:
            for item in get_ecount_result(res):
                wh_cd = first_nonempty(item, "WH_CD", "WH", "WAREHOUSE_CD", "WAREHOUSE", "LOCATION_CD", "LOCATION")
                wh_des = first_nonempty(item, "WH_DES", "WH_NAME", "WAREHOUSE_DES", "LOCATION_DES", "LOCATION_NAME")
                if wh_cd:
                    wh_dict[wh_cd] = wh_des
    except Exception as exc:
        print(f"  ⚠️ Fetch Warehouse Master Failed: {exc}")
    return wh_dict


def fetch_inventory_by_location(session_id, host_url, wh_cd=""):
    url = f"{ecount_api_url(host_url, 'InventoryBalance/GetListInventoryBalanceStatusByLocation')}?SESSION_ID={session_id}"
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
        if res.status_code != 200:
            return []
        return get_ecount_result(res)
    except Exception as exc:
        print(f"  ⚠️ GetListInventoryBalanceStatusByLocation failed: {exc}")
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

    for com in COMPANIES:
        com_id = com["id"]
        com_code = com["code"]
        if not com_code or not com["api_key"]:
            print(f"⚠️ ข้ามบริษัท {com_id} (ยังไม่ได้ใส่ Credentials ใน .env)")
            continue

        print(f"\n🔄 ดึงข้อมูลจาก Ecount บริษัท: {com_id} (COM_CODE: {com_code})")
        session_id, host_url = get_ecount_session(com)
        if not session_id:
            print(f"❌ ไม่สามารถเข้าสู่ระบบบริษัท {com_id} ได้")
            continue

        # ดึง Master รายชื่อคลังสินค้าประจำบริษัท
        wh_dict = fetch_warehouse_dict(session_id, host_url)

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
            if res_master.status_code == 200:
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
            items = fetch_inventory_by_location(session_id, host_url)

            if len(items) >= 10000:
                print(f"  ⚠️ ข้อมูลแตะ Limit 10,000 รายการ ({com_id}) -> สลับไปวนดึงแยกรายคลังสินค้า...")
                wh_list = list(wh_dict.keys())
                if wh_list:
                    items = []
                    for wh in wh_list:
                        wh_items = fetch_inventory_by_location(session_id, host_url, wh_cd=wh)
                        items.extend(wh_items)

            if not items:
                for attempt in range(2):
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

                    if res_bal.status_code == 200:
                        result_items = get_ecount_result(res_bal)
                        if result_items:
                            items = result_items
                            break
                        else:
                            print(f"  ⚠️ Inventory Balance ({com_id}): API ไม่ส่งรายการข้อมูลกลับมา")
                            break
                    elif res_bal.status_code in (412, 429, 500) and attempt == 0:
                        print(f"  ⚠️ Inventory Balance ({com_id}): HTTP {res_bal.status_code} ชั่วคราว — ลองรีเฟรช Session ใหม่")
                        session_id, host_url = get_ecount_session(com)
                        if not session_id:
                            print(f"  ❌ Inventory Balance ({com_id}): รีเฟรช Session ไม่สำเร็จ")
                            break
                        continue
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