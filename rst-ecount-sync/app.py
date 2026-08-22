from datetime import datetime, timezone, timedelta
import os
import sys
import requests
import time
from flask import Flask, request, jsonify
from flask_cors import CORS

# โหลดไลบรารี Google Cloud BigQuery & Service Account Authentication
try:
    from google.cloud import bigquery
    from google.oauth2 import service_account
    HAS_BIGQUERY = True
except ImportError:
    HAS_BIGQUERY = False

# ตั้งค่าการแสดงผลภาษาไทยสำหรับ Terminal
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

CONFIG = {
    "COM_CODE": "915297",
    "USER_ID": "ITRST01",
    "API_CERT_KEY": "5b3c2d9aa2f7d4fc4a5f4dd9ce78fd0b47", 
    "LAN_TYPE": "th-TH",
    "ZONE": "IA",
    "PORT": 8000,  # 📌 รันด้วย Port 8000 ตรงตาม ngrok http 8000
    
    # 📌 ชื่อไฟล์ JSON Credentials
    "KEY_FILE": "credentials.json", 
    
    # 📌 การตั้งค่า Google BigQuery
    "GCP_PROJECT": "rst-ecount-sync-py",
    "BQ_DATASET": "rst_ecount_py",
    "BQ_TABLE": "Stock_Data",
    "BQ_MASTER_TABLE": "master_products",
    "BQ_MINMAX_TABLE": "Product_MinMax"
}

# ตั้งค่า Environment Variable สำหรับ Google Credentials
if os.path.exists(CONFIG["KEY_FILE"]):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = CONFIG["KEY_FILE"]

app = Flask(__name__)
CORS(app)  # รองรับการเรียกจาก app.js / GitHub Pages / Localhost

def get_bq_client():
    """สร้าง Client สำหรับเชื่อมต่อ BigQuery โดยใช้ Service Account JSON Key"""
    if not HAS_BIGQUERY:
        print("⚠️ ไม่พบไลบรารี google-cloud-bigquery")
        return None
    try:
        key_path = CONFIG.get("KEY_FILE", "credentials.json")
        if key_path and os.path.exists(key_path):
            credentials = service_account.Credentials.from_service_account_file(key_path)
            return bigquery.Client(project=CONFIG["GCP_PROJECT"], credentials=credentials)
        return bigquery.Client(project=CONFIG["GCP_PROJECT"])
    except Exception as e:
        print(f"⚠️ ไม่สามารถเชื่อมต่อ BigQuery Client ได้: {e}")
        return None

def clean_code(code_str):
    """ทำความสะอาดรหัสสินค้า ตัด .0 และช่องว่าง"""
    if code_str is None: return ""
    s = str(code_str).strip()
    if s.endswith('.0'): s = s[:-2]
    if '.' in s:
        try: s = str(int(float(s)))
        except: pass
    return s.upper()

def get_ecount_session():
    """ขอ SESSION_ID จาก ECOUNT API"""
    login_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    login_payload = {
        "API_CERT_KEY": CONFIG["API_CERT_KEY"].strip(), 
        "COM_CODE": CONFIG["COM_CODE"],
        "LAN_TYPE": CONFIG["LAN_TYPE"], 
        "USER_ID": CONFIG["USER_ID"], 
        "ZONE": CONFIG["ZONE"].upper()
    }
    try:
        response = requests.post(login_url, json=login_payload, timeout=30)
        return response.json().get("Data", {}).get("Datas", {}).get("SESSION_ID")
    except Exception as e:
        print(f"❌ ขอ Session ECOUNT ล้มเหลว: {e}")
        return None

def save_min_max_to_ecount(items_to_update, passed_session_id=None):
    """บันทึกสต็อกปลอดภัย (Safety Stock) กลับไปยัง ECOUNT"""
    session_id = passed_session_id if passed_session_id else get_ecount_session()
    if not session_id:
        return {"status": "FAIL", "message": "ยืนยันสิทธิ์ระบบ ECOUNT ล้มเหลว"}

    save_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/InventoryBasic/RequestSafetyStock/U?SESSION_ID={session_id}"
    
    safety_stock_list = []
    for item in items_to_update:
        prod_cd = clean_code(item.get("PROD_CD") or item.get("item_code") or item.get("prod_cd") or "")
        wh_cd = clean_code(item.get("WH_CD") or item.get("wh_cd") or "00001")
        
        try: min_val = float(item.get("MIN_QTY") or item.get("min_qty") or 0)
        except: min_val = 0.0

        if not prod_cd: continue

        safety_stock_list.append({
            "BulkDatas": {
                "PROD_CD": prod_cd,
                "WH_CD": wh_cd,
                "SAFETY_QTY": min_val  
            }
        })

    if not safety_stock_list:
        return {"status": "FAIL", "message": "ข้อมูลรายการสินค้าหรือรหัสคลังไม่ถูกต้อง"}

    payload = {"SafetyStockList": safety_stock_list}

    try:
        response = requests.post(save_url, json=payload, timeout=60)
        res_json = response.json()
        
        if str(res_json.get("Status", "")) == "200" and not res_json.get("Errors"):
            return {"status": "SUCCESS", "message": "อัปเดตสต็อกปลอดภัยรายสาขาสำเร็จ"}
        
        err_msg = res_json.get("Error", {}).get("Message", "ECOUNT ไม่สามารถบันทึกสต็อกรายคลังได้")
        return {"status": "FAIL", "message": err_msg}
    except Exception as e:
        return {"status": "FAIL", "message": str(e)}

# =====================================================================
# 🌐 API ENDPOINTS
# =====================================================================

@app.route('/api/get-stock', methods=['GET'])
def handle_get_stock():
    """ดึงข้อมูล สต็อก + Min/Max + วันที่เคลื่อนไหว/วันขายล่าสุดจาก BigQuery"""
    bq_client = get_bq_client()
    
    if bq_client:
        try:
            # ใช้ SAFE_CAST ป้องกัน Crash กรณี Schema บน BigQuery ไม่ตรง
            query = f"""
                WITH Cleaned_MinMax AS (
                    SELECT 
                        TRIM(CAST(item_code AS STRING)) AS exact_code,
                        UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(CAST(item_code AS STRING)), r'\\.0+$', ''), r'[^a-zA-Z0-9]', '')) AS norm_code,
                        MAX(SAFE_CAST(min_qty AS INT64)) AS min_qty,
                        MAX(SAFE_CAST(max_qty AS INT64)) AS max_qty
                    FROM `{CONFIG['GCP_PROJECT']}.{CONFIG['BQ_DATASET']}.{CONFIG['BQ_MINMAX_TABLE']}`
                    WHERE item_code IS NOT NULL AND TRIM(CAST(item_code AS STRING)) != ''
                    GROUP BY exact_code, norm_code
                )
                SELECT 
                    SAFE_CAST(s.item_code AS STRING) AS PROD_CD, 
                    COALESCE(SAFE_CAST(s.item_name AS STRING), SAFE_CAST(p.item_name AS STRING), '') AS PROD_NM, 
                    COALESCE(SAFE_CAST(s.stock_qty AS FLOAT64), 0.0) AS QTY, 
                    COALESCE(SAFE_CAST(s.updated_at AS STRING), '') AS UPDATE_TIME, 
                    COALESCE(m1.min_qty, m2.min_qty, SAFE_CAST(s.min_qty AS INT64), 0) AS MIN_QTY, 
                    COALESCE(m1.max_qty, m2.max_qty, SAFE_CAST(s.max_qty AS INT64), 0) AS MAX_QTY,
                    '' AS LAST_SALE_DATE,
                    0.0 AS MOVEMENT_QTY,
                    '' AS LAST_MOVE_DATE,
                    COALESCE(SAFE_CAST(s.wh_cd AS STRING), '') AS WH_CD,
                    COALESCE(SAFE_CAST(s.wh_nm AS STRING), '') AS WH_NM
                FROM `{CONFIG['GCP_PROJECT']}.{CONFIG['BQ_DATASET']}.{CONFIG['BQ_TABLE']}` s
                LEFT JOIN `{CONFIG['GCP_PROJECT']}.{CONFIG['BQ_DATASET']}.{CONFIG['BQ_MASTER_TABLE']}` p
                    ON UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(CAST(s.item_code AS STRING)), r'\\.0+$', ''), r'[^a-zA-Z0-9]', '')) 
                     = UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(CAST(p.item_code AS STRING)), r'\\.0+$', ''), r'[^a-zA-Z0-9]', ''))
                LEFT JOIN Cleaned_MinMax m1 
                    ON TRIM(CAST(s.item_code AS STRING)) = m1.exact_code
                LEFT JOIN Cleaned_MinMax m2 
                    ON UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(CAST(s.item_code AS STRING)), r'\\.0+$', ''), r'[^a-zA-Z0-9]', '')) = m2.norm_code
            """
            query_job = bq_client.query(query)
            results = query_job.result()
            
            stock_data = []
            for row in results:
                prod_cd = str(row.PROD_CD) if row.PROD_CD else ""
                prod_nm = str(row.PROD_NM) if row.PROD_NM else ""
                qty = float(row.QTY) if row.QTY is not None else 0.0
                update_time = str(row.UPDATE_TIME) if row.UPDATE_TIME else ""
                min_val = int(row.MIN_QTY) if row.MIN_QTY is not None else 0
                max_val = int(row.MAX_QTY) if row.MAX_QTY is not None else 0

                stock_data.append({
                    "PROD_CD": prod_cd,
                    "prod_cd": prod_cd,
                    "item_code": prod_cd,
                    "PROD_NM": prod_nm,
                    "prod_nm": prod_nm,
                    "item_name": prod_nm,
                    "QTY": qty,
                    "qty": qty,
                    "stock_qty": qty,
                    "UPDATE_TIME": update_time,
                    "update_time": update_time,
                    "MIN_QTY": min_val,
                    "min_qty": min_val,
                    "MAX_QTY": max_val,
                    "max_qty": max_val,
                    "LAST_SALE_DATE": "",
                    "last_sale_date": "",
                    "MOVEMENT_QTY": 0.0,
                    "movement_qty": 0.0,
                    "LAST_MOVE_DATE": "",
                    "last_move_date": "",
                    "WH_CD": str(row.WH_CD or ""),
                    "WH_NM": str(row.WH_NM or "")
                })
            return jsonify(stock_data), 200
        except Exception as e:
            print(f"❌ เกิดข้อผิดพลาดในการ Query BigQuery: {e}")
            return jsonify({"status": "ERROR", "message": str(e)}), 500

    return jsonify([]), 200

@app.route('/api/save-minmax-item', methods=['POST'])
def handle_save_minmax_item():
    """อัปเดต Min/Max สินค้ารายชิ้น (อัปเดตทั้ง ECOUNT และ BigQuery)"""
    req_data = request.json or {}
    prod_cd = clean_code(req_data.get("PROD_CD") or req_data.get("item_code") or req_data.get("prod_cd"))
    prod_nm = str(req_data.get("PROD_NM") or req_data.get("item_name") or "").strip()
    min_qty = float(req_data.get("MIN_QTY", req_data.get("min_qty", 0)))
    max_qty = float(req_data.get("MAX_QTY", req_data.get("max_qty", 0)))

    if not prod_cd:
        return jsonify({"status": "FAIL", "message": "ไม่พบรหัสสินค้า (PROD_CD)"}), 400

    print(f"📡 บันทึก Min/Max รายชิ้น: {prod_cd} -> Min: {min_qty}, Max: {max_qty}")

    # 1. บันทึกลง ECOUNT
    ecount_res = save_min_max_to_ecount([{"PROD_CD": prod_cd, "MIN_QTY": min_qty, "WH_CD": "00001"}])

    # 2. บันทึกลง BigQuery
    bq_client = get_bq_client()
    if bq_client:
        try:
            clean_cd_str = prod_cd.replace("'", "\\'")
            clean_nm_str = prod_nm.replace("'", "\\'")

            merge_minmax_query = f"""
                MERGE `{CONFIG['GCP_PROJECT']}.{CONFIG['BQ_DATASET']}.{CONFIG['BQ_MINMAX_TABLE']}` T
                USING (SELECT '{clean_cd_str}' AS item_code, '{clean_nm_str}' AS item_name, {int(min_qty)} AS min_qty, {int(max_qty)} AS max_qty) S
                ON UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(CAST(T.item_code AS STRING)), r'\\.0+$', ''), r'[^a-zA-Z0-9]', '')) 
                 = UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(S.item_code), r'\\.0+$', ''), r'[^a-zA-Z0-9]', ''))
                WHEN MATCHED THEN
                  UPDATE SET min_qty = S.min_qty, max_qty = S.max_qty
                WHEN NOT MATCHED THEN
                  INSERT (item_code, item_name, min_qty, max_qty) VALUES (S.item_code, S.item_name, S.min_qty, S.max_qty)
            """
            bq_client.query(merge_minmax_query).result()

            update_stock_query = f"""
                UPDATE `{CONFIG['GCP_PROJECT']}.{CONFIG['BQ_DATASET']}.{CONFIG['BQ_TABLE']}`
                SET min_qty = {int(min_qty)}, max_qty = {int(max_qty)}, updated_at = CURRENT_TIMESTAMP()
                WHERE UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(CAST(item_code AS STRING)), r'\\.0+$', ''), r'[^a-zA-Z0-9]', '')) 
                    = UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM('{clean_cd_str}'), r'\\.0+$', ''), r'[^a-zA-Z0-9]', ''))
            """
            bq_client.query(update_stock_query).result()
            
            print(f"✅ บันทึก BigQuery สำหรับสินค้า {prod_cd} เรียบร้อย")
        except Exception as e:
            print(f"❌ บันทึกลง BigQuery ไม่สำเร็จ: {e}")

    return jsonify({"status": "SUCCESS", "message": f"อัปเดต Min/Max ของ {prod_cd} เรียบร้อยแล้ว", "ecount": ecount_res}), 200

@app.route('/api/save-minmax-bulk', methods=['POST'])
def handle_save_minmax_bulk():
    """อัปเดต Min/Max สินค้าแบบกลุ่ม (อัปเดตทั้ง ECOUNT และ BigQuery แบบ Batch)"""
    req_data = request.json or {}
    items_to_update = req_data.get("items", [])
    
    if not items_to_update:
        return jsonify({"status": "SUCCESS", "message": "ไม่มีรายการต้องอัปเดต"}), 200

    print(f"📡 บันทึกกลุ่มจำนวน {len(items_to_update)} รายการ...")

    # 1. บันทึกลง ECOUNT
    session_id = get_ecount_session()
    chunk_size = 100
    success_count = 0
    
    if session_id:
        for i in range(0, len(items_to_update), chunk_size):
            chunk = items_to_update[i:i + chunk_size]
            res = save_min_max_to_ecount(chunk, passed_session_id=session_id)
            if res["status"] == "SUCCESS":
                success_count += len(chunk)
            time.sleep(0.3)

    # 2. บันทึกลง BigQuery แบบ Batch (UPDATE CASE WHEN)
    bq_client = get_bq_client()
    if bq_client:
        try:
            min_cases = []
            max_cases = []
            codes = []

            for item in items_to_update:
                p_cd = clean_code(item.get("PROD_CD") or item.get("item_code") or "").replace("'", "\\'")
                mn_q = float(item.get("MIN_QTY", 0))
                mx_q = float(item.get("MAX_QTY", 0))

                if p_cd:
                    min_cases.append(f"WHEN item_code = '{p_cd}' THEN {int(mn_q)}")
                    max_cases.append(f"WHEN item_code = '{p_cd}' THEN {int(mx_q)}")
                    codes.append(f"'{p_cd}'")

            if codes:
                min_sql = " ".join(min_cases)
                max_sql = " ".join(max_cases)
                codes_sql = ", ".join(codes)

                batch_query = f"""
                    UPDATE `{CONFIG['GCP_PROJECT']}.{CONFIG['BQ_DATASET']}.{CONFIG['BQ_TABLE']}`
                    SET 
                        min_qty = CASE {min_sql} ELSE min_qty END,
                        max_qty = CASE {max_sql} ELSE max_qty END,
                        updated_at = CURRENT_TIMESTAMP()
                    WHERE item_code IN ({codes_sql})
                """
                bq_client.query(batch_query).result()
                print("✅ บันทึก BigQuery แบบ Bulk สำเร็จ")
        except Exception as e:
            print(f"❌ บันทึก Bulk ลง BigQuery ไม่สำเร็จ: {e}")

    return jsonify({"status": "SUCCESS", "message": f"อัปเดตสำเร็จ {len(items_to_update)} รายการ"}), 200

# =====================================================================
# 🔄 ระบบซิงค์ข้อมูลจาก ECOUNT ลง BigQuery
# =====================================================================
def sync_current_stock():
    """ดึงข้อมูลสต็อกและสต็อกปลอดภัยจาก ECOUNT แล้วเขียนทับเข้า BigQuery"""
    print(f"[{datetime.now().strftime('%H:%M:%S')}] 🎬 เริ่มกระบวนการดึงข้อมูลจาก ECOUNT...")
    
    session_id = get_ecount_session()
    if not session_id:
        print("❌ ยืนยันสิทธิ์ระบบ ECOUNT ล้มเหลว")
        return
    
    today_str = datetime.now().strftime("%Y%m%d")
    
    # STEP 1: ดึงสต็อกคงเหลือปัจจุบันรายคลัง
    print("📡 1/2 กำลังโหลดสต็อกคงเหลือปัจจุบัน...")
    stock_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation?SESSION_ID={session_id}"
    stock_payload = {"PROD_CD": "", "WH_CD": "", "BASE_DATE": today_str, "BAL_FLAG": "N"}
    
    try:
        stock_response = requests.post(stock_url, json=stock_payload, timeout=60)
        raw_stock_list = stock_response.json().get("Data", {}).get("Result") or []
    except Exception as e:
        print(f"❌ ดึงข้อมูลสต็อกขัดข้อง: {str(e)}")
        return

    # STEP 2: ดึงตารางค่าตั้ง Min (Safety Stock)
    print("📡 2/2 กำลังดึงตารางค่าสต็อกปลอดภัย (Safety Qty) ย่อยรายสาขา...")
    safety_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/InventoryBasic/GetListSafetyStock?SESSION_ID={session_id}"
    safety_payload = {"PROD_CD": "", "WH_CD": ""}
    
    safety_map = {}
    try:
        safety_response = requests.post(safety_url, json=safety_payload, timeout=60)
        raw_safety_list = safety_response.json().get("Data", {}).get("Result") or []
        
        for s_item in raw_safety_list:
            s_prod = clean_code(s_item.get("PROD_CD") or "")
            s_wh = clean_code(s_item.get("WH_CD") or "")
            s_qty = int(float(s_item.get("SAFETY_QTY") or 0))
            if s_prod and s_wh:
                safety_map[f"{s_prod}_{s_wh}"] = s_qty
    except Exception as e:
        print(f"⚠️ คำเตือน: ดึงตารางสต็อกปลอดภัยขัดข้อง ({str(e)}) ระบบจะให้ค่าเริ่มต้นเป็น 0")

    wh_map = {
        "00001": "สำนักงานใหญ่", "00002": "กุฉินารายณ์", "00003": "เดชอุดม",
        "00004": "ตระการพืชผล", "00005": "ศรีเมือง", "00006": "ศรีสะเกษ",
        "00007": "เบญจลักษณ์", "00008": "ขุขันธ์", "00010": "ยืมงานกิจกรรม",
        "00012": "อำนาจเจริญ", "00014": "โกดังปานตัน", "00016": "ลูกค้ายืมรถ",
        "00017": "ริมมูล", "00018": "คลังรถมือสอง", "00020": "งานโครงการช่างวิศิษฎ์",
        "00021": "งานโครงการช่างธวัชชัย", "00022": "ยกเลิกโกดังบางจาก",
        "00023": "คลังรถยนต์/รถบรรทุก", "00024": "ซ่อมรถยนต์/รถบรรทุก",
        "00025": "งานโครงการช่างธรรมสรรณ์", "00026": "Shipto", "00027": "ASSET",
        "00028": "ซอยเทคโน", "00029": "ซอยเทคโน", "00030": "ซอยเทคโน",
        "00031": "ศรีปรีชา(หนองบังลำภู)", "00032": "สาขาทดลอง คุณบอส",
        "00033": "งานโครงการช่างเจษฎา", "00034": "โชว์รูมแจ้งสนิท"
    }

    bq_json_rows = []
    thai_tz = timezone(timedelta(hours=7))
    update_time_str = datetime.now(thai_tz).strftime("%Y-%m-%d %H:%M:%S")

    # STEP 3: แปลงข้อมูลสร้าง JSON Row
    for item in raw_stock_list:
        p_code = clean_code(item.get("PROD_CD") or item.get("prod_cd") or "")
        p_name = str(item.get("PROD_DES") or item.get("prod_des") or "").strip()
        wh_code = clean_code(item.get("WH_CD") or item.get("wh_cd") or "")
        wh_name = str(item.get("WH_DES") or item.get("wh_des") or "").strip()
        
        try: current_qty = float(item.get("BAL_QTY") or item.get("bal_qty") or 0)
        except: current_qty = 0.0
        
        if not p_code: continue
        
        if wh_code in wh_map:
            wh_name = wh_map[wh_code]
        elif not wh_name and wh_code:
            wh_name = f"คลังย่อย {wh_code}"
        if not wh_name or wh_name.upper() == "NONE":
            wh_name = "คลังสินค้า"
            
        full_name = f"{p_name} ({wh_name})"
        min_qty_val = safety_map.get(f"{p_code}_{wh_code}", 0)
        max_qty_val = 0

        bq_json_rows.append({
            "item_code": str(p_code),
            "item_name": str(full_name),
            "stock_qty": float(current_qty),
            "updated_at": str(update_time_str),
            "min_qty": int(min_qty_val),
            "max_qty": int(max_qty_val),
            "wh_cd": str(wh_code),
            "wh_nm": str(wh_name)
        })

    total_records = len(bq_json_rows)
    print(f"📦 ประกอบก้อนข้อมูลเสร็จแล้ว ยอดรวมทั้งสิ้น: {total_records} แถว")

    # STEP 4: อัปเดตข้อมูลลง BigQuery
    bq_client = get_bq_client()
    if bq_client:
        try:
            table_id = f"{CONFIG['GCP_PROJECT']}.{CONFIG['BQ_DATASET']}.{CONFIG['BQ_TABLE']}"
            job_config = bigquery.LoadJobConfig(
                write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE
            )
            load_job = bq_client.load_table_from_json(bq_json_rows, table_id, job_config=job_config)
            load_job.result()
            print(f"✅ บันทึกข้อมูลเข้า BigQuery ({table_id}) สำเร็จแล้ว {total_records} แถว!")
        except Exception as e:
            print(f"⚠️ บันทึกลง BigQuery ขัดข้อง: {e}")

    print(f"\n🎉 [เสร็จสิ้นเรียบร้อย!] ข้อมูลพร้อมใช้งานบน BigQuery แล้ว")

if __name__ == "__main__":
    print(f"\n🚀 เซิร์ฟเวอร์เปิดใช้งานปกติ! รอรับคำสั่งที่พอร์ต {CONFIG['PORT']}...")
    app.run(host="0.0.0.0", port=CONFIG["PORT"], debug=True)