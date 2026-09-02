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


def fetch_warehouse_list(session_id, host_url):
    """ดึงรายชื่อคลังสินค้าทั้งหมดเพื่อใช้อ้างอิงการดึงแยกรายคลังเมื่อข้อมูลเกิน 10,000 รายการ"""
    url = f"https://{host_url}/OAPI/V2/InventoryBasic/GetListWarehouse?SESSION_ID={session_id}"
    payload = {"WH_CD": "", "DEL_GUBUN": "N"}
    try:
        res = requests.post(url, json=payload, timeout=20)
        if res.status_code == 200:
            data = res.json()
            if str(data.get("Status")) == "200":
                items = data.get("Data", {}).get("Result", []) or data.get("Data", {}).get("Datas", [])
                return [str(item.get("WH_CD")).strip() for item in items if item.get("WH_CD")]
    except Exception:
        pass
    return []


def fetch_inventory_by_location(session_id, host_url, wh_cd=""):
    url = f"https://{host_url}/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation?SESSION_ID={session_id}"
    payload = {
        "PROD_CD": "",
        "WH_CD": wh_cd,
        "BASE_DATE": datetime.now().strftime("%Y%m%d"),
        "BAL_FLAG": "N",
        "DEL_GUBUN": "N",
        "DEL_LOCATION_YN": "N",
    }
    try:
        res = requests.post(url, json=payload, timeout=30)
        if res.status_code != 200:
            return []
        data = res.json()
        if str(data.get("Status")) != "200":
            return []
        return data.get("Data", {}).get("Result", []) or []
    except Exception as exc:
        print(f"  ⚠️ GetListInventoryBalanceStatusByLocation failed: {exc}")
        return []


COMPANY_FIELD_MAP = {
    "ASIA": {
        "prod_cd": ["PROD_CD", "ITEM_CD", "SKU", "PRODUCT_CD"],
        "prod_des": ["PROD_DES", "PROD_NAME", "ITEM_NAME", "DESCRIPTION", "DESC", "PRODUCT_NAME"],
        "size_des": ["SIZE_DES", "SIZE", "UNIT_DES", "UNIT", "PROD_SIZE_DES"],
        "wh_cd": ["WH_CD", "WH", "WAREHOUSE_CD", "WAREHOUSE", "LOCATION_CD", "LOCATION"],
        "wh_des": ["WH_DES", "WAREHOUSE_DES", "LOCATION_DES", "WH_NAME"],
        "bal_qty": ["BAL_QTY", "QTY", "STOCK_QTY", "AVAILABLE_QTY"],
    },
    "ROBOTICS": {
        "prod_cd": ["PROD_CD", "ITEM_CD", "SKU", "PRODUCT_CD"],
        "prod_des": ["PROD_DES", "PROD_NAME", "ITEM_NAME", "DESCRIPTION", "DESC", "PROD_SIZE_DES"],
        "size_des": ["SIZE_DES", "SIZE", "UNIT_DES", "UNIT", "PROD_SIZE_DES"],
        "wh_cd": ["WH_CD", "WH", "WAREHOUSE_CD", "WAREHOUSE", "LOCATION_CD", "LOCATION"],
        "wh_des": ["WH_DES", "WAREHOUSE_DES", "LOCATION_DES", "WH_NAME"],
        "bal_qty": ["BAL_QTY", "QTY", "STOCK_QTY", "AVAILABLE_QTY"],
    },
    "RUAMSINTHAI": {
        "prod_cd": ["PROD_CD", "ITEM_CD", "SKU", "PRODUCT_CD"],
        "prod_des": ["PROD_DES", "PROD_NAME", "ITEM_NAME", "DESCRIPTION", "DESC"],
        "size_des": ["SIZE_DES", "SIZE", "UNIT_DES", "UNIT", "PROD_SIZE_DES"],
        "wh_cd": ["WH_CD", "WH", "WAREHOUSE_CD", "WAREHOUSE", "LOCATION_CD", "LOCATION"],
        "wh_des": ["WH_DES", "WAREHOUSE_DES", "LOCATION_DES", "WH_NAME"],
        "bal_qty": ["BAL_QTY", "QTY", "STOCK_QTY", "AVAILABLE_QTY"],
    },
}


def first_nonempty(item, *keys):
    for key in keys:
        value = item.get(key)
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

    qty_field = next((key for key in company_map["bal_qty"] if key in item), "BAL_QTY")
    bal_qty = parse_float(item.get(qty_field, 0))

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

        # 1. Fetch Master Products (ลองดึงจาก Direct API ก่อน)
        master_dict = {}
        try:
            url_master = f"https://{host_url}/OAPI/V2/InventoryBasic/GetListProduct?SESSION_ID={session_id}"
            payload_master = {
                "PROD_CD": "",
                "DEL_GUBUN": "N",
                "REQUEST_TYPE": "M"
            }
            res_master = requests.post(url_master, json=payload_master, timeout=20)
            if res_master.status_code == 200:
                res_json = res_master.json()
                if str(res_json.get("Status")) == "200":
                    items = res_json.get("Data", {}).get("Result", []) or res_json.get("Data", {}).get("Datas", [])
                    for item in items:
                        p_cd = str(item.get("PROD_CD") or "").strip()
                        if p_cd:
                            p_des = first_nonempty(item, "PROD_DES", "PROD_NAME", "ITEM_NAME", "ITEM_DES", "DESCRIPTION", "DESC", "PROD_DSC") or p_cd
                            s_des = first_nonempty(item, "SIZE_DES", "SIZE", "UNIT_DES", "UNIT")
                            master_dict[p_cd] = {"prod_des": p_des, "size_des": s_des}
        except Exception:
            pass

        # 2. Fetch Inventory Balance + Auto-Extract Master Data (primary: by-location endpoint)
        try:
            items = fetch_inventory_by_location(session_id, host_url)

            # หากได้ข้อมูลแตะเพดาน Limit 10,000 รายการ ให้สลับไปดึงแบบวนแยกตามรายคลังสินค้า
            if len(items) >= 10000:
                print(f"  ⚠️ ข้อมูลแตะ Limit 10,000 รายการ ({com_id}) -> สลับไปวนดึงแยกรายคลังสินค้า...")
                wh_list = fetch_warehouse_list(session_id, host_url)
                if wh_list:
                    items = []
                    for wh in wh_list:
                        wh_items = fetch_inventory_by_location(session_id, host_url, wh_cd=wh)
                        items.extend(wh_items)

            if not items:
                for attempt in range(2):
                    base_date = datetime.now().strftime("%Y%m%d")
                    url_bal = f"https://{host_url}/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus?SESSION_ID={session_id}"
                    payload_bal = {
                        "BASE_DATE": base_date,
                        "ZERO_FLAG": "N",
                        "BAL_FLAG": "N",
                        "DEL_GUBUN": "N",
                        "SAFE_FLAG": "N"
                    }
                    res_bal = requests.post(url_bal, json=payload_bal, timeout=30)

                    if res_bal.status_code == 200:
                        res_json = res_bal.json()
                        if str(res_json.get("Status")) == "200":
                            items = res_json.get("Data", {}).get("Result", [])
                            break
                        else:
                            print(f"  ⚠️ Inventory Balance ({com_id}): API ตอบกลับ Status {res_json.get('Status')}")
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
                p_des = normalized["prod_des"] or p_cd
                s_des = normalized["size_des"]
                bal_qty = normalized["bal_qty"]

                all_bal_rows.append({
                    "company_id": com_id,
                    "company_code": str(com_code),
                    "prod_cd": p_cd,
                    "wh_cd": wh_cd,
                    "wh_des": normalized["wh_des"] or wh_cd,
                    "bal_qty": bal_qty,
                    "updated_at": now_iso
                })
                count_bal += 1

                if p_cd not in master_dict:
                    master_dict[p_cd] = {"prod_des": p_des, "size_des": s_des}

            print(f"  📊 Inventory Balance ({com_id}): ดึงสำเร็จ {count_bal} รายการ")
        except Exception as e:
            print(f"  ❌ Inventory Balance Error ({com_id}): {e}")

        # รวบรวม Master Rows ของบริษัทนี้
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

    try:
        table_ref = f"{PROJECT_ID}.{DATASET_ID}.inventory_balance"
        table = client.get_table(table_ref)
        has_wh_des = "wh_des" in {field.name for field in table.schema}
    except Exception as exc:
        print(f"\n⚠️ ไม่สามารถตรวจสอบ schema inventory_balance ได้: {exc}")
        has_wh_des = False

    if not has_wh_des:
        for row in all_bal_rows:
            row.pop("wh_des", None)

    # อัปเดตลง BigQuery
    job_config = bigquery.LoadJobConfig(write_disposition="WRITE_TRUNCATE")

    if all_master_rows:
        table_ref = f"{PROJECT_ID}.{DATASET_ID}.master_products"
        client.load_table_from_json(all_master_rows, table_ref, location=LOCATION, job_config=job_config).result()
        print(f"\n✅ อัปเดต master_products ลง BigQuery รวมสำเร็จ: {len(all_master_rows)} รายการ")
    else:
        print("\n⚠️ ไม่มีข้อมูล master_products ให้อัปเดต")

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