import sys
import requests
import time
import math
from datetime import datetime, timedelta

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

CONFIG = {
    "COM_CODE": "915297",
    "USER_ID": "ITRST01",
    "API_CERT_KEY": "5b3c2d9aa2f7d4fc4a5f4dd9ce78fd0b47", 
    "LAN_TYPE": "th-TH",
    "ZONE": "IA",
    "GOOGLE_WEBAPP_URL": "https://script.google.com/macros/s/AKfycbx5zng-rK_Z4902jMfnb3oJqIaGU_iVdX_kn1K1ymnnY9khSi51GzqnvYVPe9x1WJMNhA/exec"
}

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

def calculate_minmax_by_daily_stock():
    print(f"[{datetime.now().strftime('%H:%M:%S')}] 🎬 เริ่มระบบวิเคราะห์เกณฑ์ Min-Max...")
    session_id = get_ecount_session()
    if not session_id: return
    
    today_str = datetime.now().strftime("%Y%m%d")
    stock_url = f"https://oapi{CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation?SESSION_ID={session_id}"
    
    try:
        stock_response = requests.post(stock_url, json={"PROD_CD": "", "WH_CD": "", "BASE_DATE": today_str, "BAL_FLAG": "N"}, timeout=60)
        raw_list = stock_response.json().get("Data", {}).get("Result") or []
    except: return

    past_date_str = (datetime.now() - timedelta(days=30)).strftime("%Y%m%d")
    past_stock_map = {}
    try:
        past_response = requests.post(stock_url, json={"PROD_CD": "", "WH_CD": "", "BASE_DATE": past_date_str, "BAL_FLAG": "N"}, timeout=60)
        past_list = past_response.json().get("Data", {}).get("Result") or []
        for item in past_list:
            p_code = clean_code(item.get("PROD_CD"))
            wh_code = clean_code(item.get("WH_CD"))
            qty = float(item.get("BAL_QTY") or 0)
            if p_code: past_stock_map[f"{p_code}_{wh_code}"] = qty
    except: pass

    wh_map = {"00001": "สำนักงานใหญ่", "00002": "กุฉินารายณ์", "00003": "เดชอุดม", "00004": "ตระการพืชผล", "00005": "ศรีเมือง", "00006": "ศรีสะเกษ", "00007": "เบญจลักษ์", "00008": "ขุขันธ์", "00014": "โกดังบ้านดอน"}
    minmax_rows = []

    for item in raw_list:
        p_code = str(item.get("PROD_CD") or "").strip()
        p_name = str(item.get("PROD_DES") or "").strip()
        wh_code = clean_code(item.get("WH_CD"))
        wh_name = str(item.get("WH_DES") or "").strip()
        current_qty = float(item.get("BAL_QTY") or 0)
        if not p_code: continue
        
        if not wh_name and wh_code: wh_name = wh_map.get(wh_code, f"คลังย่อย {wh_code}")
        full_name = f"{p_name} ({wh_name})"
        
        past_qty = past_stock_map.get(f"{clean_code(p_code)}_{wh_code}", current_qty)
        estimated_sales = past_qty - current_qty
        
        if estimated_sales > 0:
            avg_daily = estimated_sales / 30
            safety_stock = avg_daily * 10
            min_val = math.ceil((avg_daily * 5) + safety_stock)
            max_val = math.ceil(min_val + estimated_sales)
        else:
            min_val = 1
            max_val = 5

        minmax_rows.append([str(p_code), str(full_name), int(min_val), int(max_val)])

    total_records = len(minmax_rows)
    chunk_size = 1000
    for i in range(0, total_records, chunk_size):
        chunk_data = minmax_rows[i:i + chunk_size]
        payload = { 
            "action": "sync_minmax", # 🎯 ล็อคเป้าหมายให้ยิงเข้าแท็บเกณฑ์มินแมกซ์เซฟโซน
            "is_first": (i == 0), 
            "data": chunk_data 
        }
        for retry in range(3):
            try:
                res = requests.post(CONFIG["GOOGLE_WEBAPP_URL"], json=payload, timeout=90)
                if res.status_code == 200: break
            except: time.sleep(1.0)
    print(f"🎉 ซิงค์เกณฑ์ Min-Max ลงแท็บ Product_MinMax เรียบร้อย!")

if __name__ == "__main__":
    calculate_minmax_by_daily_stock()