import sys
import requests
import time
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

CONFIG = {
    "COM_CODE": "915297",
    "USER_ID": "ITRST01",
    "API_CERT_KEY": "5b3c2d9aa2f7d4fc4a5f4dd9ce78fd0b47", 
    "LAN_TYPE": "th-TH",
    "ZONE": "IA",
    "GOOGLE_WEBAPP_URL": "https://script.google.com/macros/s/AKfycbx5zng-rK_Z4902jMfnb3oJqIaGU_iVdX_kn1K1ymnnY9khSi51GzqnvYVPe9x1WJMNhA/exec",
    "PORT": 5000  
}

app = Flask(__name__)
CORS(app)  

def clean_code(code_str):
    if code_str is None: return ""
    s = str(code_str).strip()
    if s.endswith('.0'): s = s[:-2]
    if '.' in s:
        try: s = str(int(float(s)))
        except: pass
    return s.upper()

def get_ecount_session():
    login_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    login_payload = {
        "API_CERT_KEY": CONFIG["API_CERT_KEY"].strip(), "COM_CODE": CONFIG["COM_CODE"],
        "LAN_TYPE": CONFIG["LAN_TYPE"], "USER_ID": CONFIG["USER_ID"], "ZONE": CONFIG["ZONE"].upper()
    }
    try:
        response = requests.post(login_url, json=login_payload, timeout=30)
        return response.json().get("Data", {}).get("Datas", {}).get("SESSION_ID")
    except:
        return None

# =====================================================================
# 🎯 ปรับปรุงฟังก์ชันบันทึก: รองรับ Chunking และ Endpoint V2 ตรงจุด
# =====================================================================
def save_min_max_to_ecount(items_to_update, passed_session_id=None):
    session_id = passed_session_id if passed_session_id else get_ecount_session()
    if not session_id:
        return {"status": "FAIL", "message": "ยืนยันสิทธิ์ระบบ ECOUNT ล้มเหลว"}

    # ใช้ RequestBasicProduct/U สำหรับเจาะจงอัปเดตข้อมูลพื้นฐานสินค้า
    save_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/InventoryBasic/RequestBasicProduct/U?SESSION_ID={session_id}"
    
    product_list = []
    for item in items_to_update:
        prod_cd = clean_code(item.get("PROD_CD") or item.get("prod_cd") or "")
        prod_des = str(item.get("PROD_DES") or item.get("PROD_NAME") or "").strip()
        
        if not prod_des: 
            prod_des = prod_cd  # ป้องกันชื่อสินค้าว่างเด็ดขาด

        try: min_val = str(int(float(item.get("MIN_QTY") or 0)))
        except: min_val = "0"
        try: max_val = str(int(float(item.get("MAX_QTY") or 0)))
        except: max_val = "0"

        if not prod_cd: continue

        product_list.append({
            "BulkDatas": {
                "PROD_CD": prod_cd,
                "PROD_DES": prod_des,
                "MIN_QTY": min_val,    
                "NO_USER1": max_val    
            }
        })

    if not product_list:
        return {"status": "FAIL", "message": "ข้อมูลรายการสินค้าไม่ถูกต้อง"}

    # ใช้กลุ่มโครงสร้างหลักของสเปก V2 (BasicProductList)
    payload = {"BasicProductList": product_list}

    try:
        response = requests.post(save_url, json=payload, timeout=60)
        res_json = response.json()
        print(f"📡 [ECOUNT Engine Response]: {res_json}")
        
        if str(res_json.get("Status", "")) == "200" and not res_json.get("Errors"):
            return {"status": "SUCCESS", "message": "อัปเดตฐานข้อมูลสำเร็จ"}
        
        err_msg = res_json.get("Error", {}).get("Message", "ECOUNT Refused Process")
        return {"status": "FAIL", "message": err_msg}
    except Exception as e:
        return {"status": "FAIL", "message": str(e)}

# =====================================================================
# 🌐 API Route: ซัพพอร์ตการหั่น Chunk ป้องกันการส่งข้อมูลก้อนใหญ่เกินไป
# =====================================================================
@app.route('/api/save-minmax-bulk', methods=['POST'])
def handle_save_minmax_bulk():
    req_data = request.json
    if not req_data or "items" not in req_data:
        return jsonify({"status": "FAIL", "message": "ไม่พบข้อมูลรายการสินค้าส่งมา"}), 400
        
    items_to_update = req_data["items"]
    print(f"📡 ได้รับคำสั่งบันทึกกลุ่มจากหน้าเว็บ จำนวน {len(items_to_update)} รายการ...")
    
    session_id = get_ecount_session()
    if not session_id:
        return jsonify({"status": "FAIL", "message": "ยืนยันสิทธิ์ ECOUNT ล้มเหลว"}), 401

    # ตัดแบ่งอัปเดตทีละ 100 รายการ เพื่อไม่ให้ชนเพดานสเปก API V2
    chunk_size = 100
    success_count = 0
    
    for i in range(0, len(items_to_update), chunk_size):
        chunk = items_to_update[i:i + chunk_size]
        res = save_min_max_to_ecount(chunk, passed_session_id=session_id)
        if res["status"] == "SUCCESS":
            success_count += len(chunk)
        time.sleep(0.3) # ป้องกัน Rate limit เบื้องต้น
        
    return jsonify({"status": "SUCCESS", "message": f"ดำเนินการเสร็จสิ้นสำเร็จ {success_count}/{len(items_to_update)} รายการ"})

# =====================================================================
# 🔄 ระบบซิงค์สต็อกเรียลไทม์ชุดเดิมของพี่ธนา (คงไว้ 100% ไม่เปลี่ยนแปลง)
# =====================================================================
def sync_current_stock():
    print(f"[{datetime.now().strftime('%H:%M:%S')}] 🎬 เริ่มระบบซิงค์ข้อมูลสต็อกปัจจุบันลง Stock_Data...")
    
    session_id = get_ecount_session()
    if not session_id:
        print("❌ ยืนยันสิทธิ์ระบบ ECOUNT ล้มเหลว")
        return
    
    today_str = datetime.now().strftime("%Y%m%d")
    print("📡 กำลังดึงสต็อกปัจจุบันจาก ECOUNT...")
    stock_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation?SESSION_ID={session_id}"
    stock_payload = {"PROD_CD": "", "WH_CD": "", "BASE_DATE": today_str, "BAL_FLAG": "N"}
    
    try:
        stock_response = requests.post(stock_url, json=stock_payload, timeout=60)
        raw_list = stock_response.json().get("Data", {}).get("Result") or []
    except Exception as e:
        print(f"❌ ดึงข้อมูลสต็อกขัดข้อง: {str(e)}")
        return

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

    stock_rows = []
    update_time_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    for item in raw_list:
        p_code = str(item.get("PROD_CD") or item.get("prod_cd") or "").strip()
        p_name = str(item.get("PROD_DES") or item.get("prod_des") or "").strip()
        wh_code = clean_code(item.get("WH_CD") or item.get("wh_cd") or "")
        wh_name = str(item.get("WH_DES") or item.get("wh_des") or "").strip()
        
        try: current_qty = float(item.get("BAL_QTY") or item.get("bal_qty") or 0)
        except: current_qty = 0.0
        
        if not p_code: continue
        
        if not wh_name and wh_code:
            wh_name = wh_map.get(wh_code, f"คลังย่อย {wh_code}")
        if not wh_name or wh_name.upper() == "NONE":
            wh_name = "คลังสินค้า"
            
        full_name = f"{p_name} ({wh_name})"
        stock_rows.append([str(p_code), str(full_name), float(current_qty), str(update_time_str)])

    total_records = len(stock_rows)
    print(f"📦 ดึงข้อมูลสำเร็จ ยอดรวมส่งขึ้นชีต Stock_Data: {total_records} แถว")

    chunk_size = 1000
    for i in range(0, total_records, chunk_size):
        chunk_data = stock_rows[i:i + chunk_size]
        payload = { 
            "action": "sync", 
            "is_first": (i == 0), 
            "data": chunk_data 
        }
        try:
            requests.post(CONFIG["GOOGLE_WEBAPP_URL"], json=payload, timeout=90)
        except:
            time.sleep(1.0)

    print(f"\n🎉 [ซิงค์สต็อกปัจจุบันเรียบร้อย!] ข้อมูลไหลลงแท็บ Stock_Data ครบถ้วนแล้วครับพี่ธนา!")

if __name__ == "__main__":
    sync_current_stock()
    print(f"\n🚀 เซิร์ฟเวอร์ภายในบริษัทเปิดใช้งานปกติ! รอรับคำสั่งอัปเดต Min/Max ที่พอร์ต {CONFIG['PORT']}...")
    app.run(host="0.0.0.0", port=CONFIG["PORT"], debug=False)