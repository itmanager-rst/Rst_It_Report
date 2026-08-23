from apscheduler.schedulers.background import BackgroundScheduler
from datetime import datetime, timezone, timedelta
import sys
import os
import requests
import time
from flask import Flask, request, jsonify
from flask_cors import CORS

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
    "PORT": int(os.environ.get("PORT", 5000)),  # ดึง PORT จาก Render Environment
    
    # 📌 วาง URL Web App ของ Google Apps Script ที่ Deploy มาตรงนี้
    "GAS_WEB_APP_URL": "https://script.google.com/macros/s/AKfycbxMj8VyyNo9rNnPtCnX3ev2DkHhAlURj8VjUUPwSMhzAFvO3XeY2tg272da0MgqGoPb/exec"
}

app = Flask(__name__)
CORS(app)  

# ตัวแปรสำหรับ Cache สต็อกล่าสุดไว้ตอบสนอง API หน้าเว็บแบบรวดเร็ว
LATEST_STOCK_CACHE = []

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

def send_stock_to_google_sheet(stock_map):
    """ยิงข้อมูลสต็อกอัปเดตตรงไปยัง Google Apps Script (Code.gs)"""
    gas_url = CONFIG.get("GAS_WEB_APP_URL", "").strip()
    if not gas_url or "YOUR_DEPLOYMENT_ID" in gas_url:
        print("⚠️ ข้ามการซิงค์: ยังไม่ได้ระบุ GAS_WEB_APP_URL ใน CONFIG")
        return

    payload = {
        "action": "updateMasterStock",
        "stockMap": stock_map
    }
    
    try:
        print(f"📡 กำลังส่งข้อมูลสต็อกจำนวน {len(stock_map)} รายการ ไปยัง Google Sheets...")
        res = requests.post(gas_url, json=payload, timeout=60)
        res_json = res.json()
        if res_json.get("status") == "SUCCESS":
            print(f"✅ ซิงค์ข้อมูลลง Google Sheets สำเร็จ ({res_json.get('updatedRows', 0)} แถว)")
        else:
            print(f"⚠️ Google Sheets ตอบกลับ: {res_json.get('message')}")
    except Exception as e:
        print(f"❌ ซิงค์ข้อมูลลง Google Sheets ขัดข้อง: {e}")

# =====================================================================
# 🎯 ฟังก์ชันบันทึกสต็อกปลอดภัย (Safety Stock) กลับไปยัง ECOUNT
# =====================================================================
def save_min_max_to_ecount(items_to_update, passed_session_id=None):
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

@app.route('/', methods=['GET'])
def health_check():
    """Health check endpoint สำหรับ Render"""
    return jsonify({
        "status": "online",
        "service": "rst-ecount-sync",
        "time": datetime.now(timezone(timedelta(hours=7))).strftime("%Y-%m-%d %H:%M:%S")
    }), 200

@app.route('/api/get-stock', methods=['GET'])
def handle_get_stock():
    """ดึงข้อมูลสต็อกปัจจุบัน (ดึงจาก Cache หรือ Google Sheets)"""
    global LATEST_STOCK_CACHE
    if LATEST_STOCK_CACHE:
        return jsonify(LATEST_STOCK_CACHE)
    
    # หากยังไม่มี Cache ให้ลองดึงข้อมูลจาก Google Sheet Direct
    gas_url = CONFIG.get("GAS_WEB_APP_URL", "").strip()
    if gas_url and "YOUR_DEPLOYMENT_ID" not in gas_url:
        try:
            res = requests.get(gas_url, timeout=30)
            return jsonify(res.json())
        except Exception as e:
            print(f"⚠️ ดึงสต็อกผ่าน Google Apps Script ขัดข้อง: {e}")

    return jsonify([])

@app.route('/api/save-minmax-item', methods=['POST'])
def handle_save_minmax_item():
    """รับค่าการอัปเดต Min/Max สินค้าแบบรายชิ้น"""
    req_data = request.json or {}
    prod_cd = clean_code(req_data.get("PROD_CD") or req_data.get("item_code") or req_data.get("prod_cd"))
    min_qty = req_data.get("MIN_QTY", req_data.get("min_qty", 0))

    if not prod_cd:
        return jsonify({"status": "FAIL", "message": "ไม่พบรหัสสินค้า (PROD_CD)"}), 400

    print(f"📡 บันทึก Min/Max รายชิ้น: {prod_cd} -> Min: {min_qty}")

    # บันทึกกลับลง ECOUNT
    ecount_res = save_min_max_to_ecount([{"PROD_CD": prod_cd, "MIN_QTY": min_qty, "WH_CD": "00001"}])
    
    # ซิงค์ข้อมูลสต็อกล่าสุดเข้า Google Sheet อีกรอบเพื่อปรับปรุงค่าทันที
    sync_current_stock()

    return jsonify({"status": "SUCCESS", "message": f"อัปเดต Min/Max ของ {prod_cd} เรียบร้อยแล้ว", "ecount": ecount_res})

@app.route('/api/save-minmax-bulk', methods=['POST'])
def handle_save_minmax_bulk():
    """รับค่าการอัปเดต Min/Max สินค้าแบบกลุ่ม"""
    req_data = request.json
    if not req_data or "items" not in req_data:
        return jsonify({"status": "FAIL", "message": "ไม่พบข้อมูลรายการสินค้าส่งมา"}), 400
        
    items_to_update = req_data["items"]
    print(f"📡 ได้รับคำสั่งบันทึกกลุ่มจากหน้าเว็บ จำนวน {len(items_to_update)} รายการ...")
    
    session_id = get_ecount_session()
    if not session_id:
        return jsonify({"status": "FAIL", "message": "ยืนยันสิทธิ์ ECOUNT ล้มเหลว"}), 401

    chunk_size = 100
    success_count = 0
    
    for i in range(0, len(items_to_update), chunk_size):
        chunk = items_to_update[i:i + chunk_size]
        res = save_min_max_to_ecount(chunk, passed_session_id=session_id)
        if res["status"] == "SUCCESS":
            success_count += len(chunk)
        time.sleep(0.3)
        
    # อัปเดตสต็อกเข้า Google Sheets หลังจบบัคล์
    sync_current_stock()
        
    return jsonify({"status": "SUCCESS", "message": f"ดำเนินการเสร็จสิ้นสำเร็จ {success_count}/{len(items_to_update)} รายการ"})

# =====================================================================
# 🔄 ระบบซิงค์ข้อมูลจาก ECOUNT ลง Google Sheets Direct
# =====================================================================
def sync_current_stock():
    """ดึงข้อมูลสต็อกและสต็อกปลอดภัยจาก ECOUNT แล้วเขียนลง Google Sheets โดยตรง"""
    global LATEST_STOCK_CACHE
    tz_thai = timezone(timedelta(hours=7))
    now_thai = datetime.now(tz_thai)
    
    print(f"[{now_thai.strftime('%H:%M:%S')}] 🎬 เริ่มกระบวนการดึงข้อมูลจาก ECOUNT...")
    
    session_id = get_ecount_session()
    if not session_id:
        print("❌ ยืนยันสิทธิ์ระบบ ECOUNT ล้มเหลว")
        return
    
    today_str = now_thai.strftime("%Y%m%d")
    
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

    stock_map_for_gas = {}
    cache_list = []
    update_time_str = now_thai.strftime("%Y-%m-%d %H:%M:%S")

    # STEP 3: ประมวลผลแยกสต็อกรายสาขา (เดชอุดม, ตระการพืชผล, เบญจลักษณ์, ฉนารายณ์, ศรีเมืองใหม่, ขุขันธ์, สำนักงานใหญ่)
    for item in raw_stock_list:
        p_code = clean_code(item.get("PROD_CD") or item.get("prod_cd") or "")
        p_name = str(item.get("PROD_DES") or item.get("prod_des") or "").strip()
        wh_code = clean_code(item.get("WH_CD") or item.get("wh_cd") or "")
        wh_name = str(item.get("WH_DES") or item.get("wh_des") or "").strip()
        
        try: current_qty = float(item.get("BAL_QTY") or item.get("bal_qty") or 0)
        except: current_qty = 0.0
        
        if not p_code: continue

        min_qty_val = safety_map.get(f"{p_code}_{wh_code}", 0)

        # จัดเตรียม stockMap เพื่อส่งต่อไปยัง Google Sheets (Code.gs) ตามหัวคอลัมน์ใหม่
        if p_code not in stock_map_for_gas:
            stock_map_for_gas[p_code] = {
                "stockBranch": 0,
                "stockHQ": 0,
                "minHQ": 0,
                "stockDechudom": 0,
                "stockTrakan": 0,
                "stockBenjalak": 0,
                "stockChanarai": 0,
                "stockSriMueang": 0,
                "stockKhukhan": 0
            }
            
        # Map ข้อมูลตามรหัสคลัง หรือชื่อคลังของ Ecount เข้ากับแต่ละสาขา
        if wh_code == "00001" or "สำนักงานใหญ่" in wh_name:
            stock_map_for_gas[p_code]["stockHQ"] = current_qty
            stock_map_for_gas[p_code]["minHQ"] = min_qty_val
        else:
            stock_map_for_gas[p_code]["stockBranch"] += current_qty
            
            if "เดชอุดม" in wh_name:
                stock_map_for_gas[p_code]["stockDechudom"] += current_qty
            elif "ตระการ" in wh_name:
                stock_map_for_gas[p_code]["stockTrakan"] += current_qty
            elif "เบญจลักษณ์" in wh_name:
                stock_map_for_gas[p_code]["stockBenjalak"] += current_qty
            elif "ฉนารายณ์" in wh_name:
                stock_map_for_gas[p_code]["stockChanarai"] += current_qty
            elif "ศรีเมืองใหม่" in wh_name:
                stock_map_for_gas[p_code]["stockSriMueang"] += current_qty
            elif "ขุขันธ์" in wh_name:
                stock_map_for_gas[p_code]["stockKhukhan"] += current_qty

        cache_list.append({
            "PROD_CD": p_code,
            "PROD_NM": p_name,
            "QTY": current_qty,
            "MIN_QTY": min_qty_val,
            "WH_CD": wh_code,
            "WH_NM": wh_name,
            "UPDATE_TIME": update_time_str
        })

    LATEST_STOCK_CACHE = cache_list
    print(f"📦 รวมรายการสินค้าเสร็จสิ้น: {len(stock_map_for_gas)} รหัสสินค้า")

    # STEP 4: ส่งข้อมูลเข้า Google Sheets Direct
    send_stock_to_google_sheet(stock_map_for_gas)

    print(f"🎉 [เสร็จสิ้นเรียบร้อย!] ข้อมูลซิงค์เข้า Google Sheets พร้อมใช้งานแล้ว")

if __name__ == "__main__":
    # 🔄 1. รันดึงข้อมูลรอบแรกทันทีตอนเปิดเซิร์ฟเวอร์
    print("🚀 กำลังเริ่มซิงค์ข้อมูลสต็อกรอบแรกทันที...")
    try:
        sync_current_stock()
    except Exception as e:
        print(f"⚠️ การซิงค์รอบแรกขัดข้อง: {e}")

    # ⏰ 2. ตั้งเวลา Auto-Sync ทุกๆ 15 นาที
    scheduler = BackgroundScheduler(timezone="Asia/Bangkok")
    scheduler.add_job(func=sync_current_stock, trigger="interval", minutes=15)
    scheduler.start()
    print("⏰ [Auto Sync] ตั้งเวลาดึงสต็อกอัตโนมัติทุก 15 นาทีเรียบร้อยแล้ว...")

    # 🌐 3. เปิดใช้งาน Flask API Server
    print(f"\n🚀 เซิร์ฟเวอร์พร้อมทำงาน! พอร์ต {CONFIG['PORT']}...")
    try:
        app.run(host="0.0.0.0", port=CONFIG["PORT"], debug=False)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()