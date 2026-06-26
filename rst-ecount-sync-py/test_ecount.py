import sys
import requests
import time
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

TEST_CONFIG = {
    "COM_CODE": "915297",
    "USER_ID": "ITRST01",
    "TEST_API_KEY": "3f16d6ea95f9a4c7ca25fe89fe38e75ec0", 
    "LAN_TYPE": "th-TH",
    "ZONE": "IA"
}

def get_test_session():
    login_url = f"https://sboapi{TEST_CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/OAPILogin"
    login_payload = {
        "API_CERT_KEY": TEST_CONFIG["TEST_API_KEY"].strip(),
        "COM_CODE": TEST_CONFIG["COM_CODE"],
        "LAN_TYPE": TEST_CONFIG["LAN_TYPE"],
        "USER_ID": TEST_CONFIG["USER_ID"],
        "ZONE": TEST_CONFIG["ZONE"].upper()
    }
    try:
        response = requests.post(login_url, json=login_payload, timeout=30)
        return response.json().get("Data", {}).get("Datas", {}).get("SESSION_ID")
    except:
        return None

def activate_menu(session_id, endpoint_path, menu_name):
    """ ฟังก์ชันส่งสัญญาณจำลอง 3 รอบรายเมนู """
    test_url = f"https://sboapi{TEST_CONFIG['ZONE'].lower()}.ecount.com/OAPI/V2/{endpoint_path}?SESSION_ID={session_id}"
    today_str = datetime.now().strftime("%Y%m%d")
    test_payload = {"CUST": "", "PROD_CD": "", "S_DATE": today_str, "E_DATE": today_str}

    print(f"\n🚀 เริ่มยิงปลดล็อกเมนู: [{menu_name}]")
    print("-" * 50)
    for count in range(1, 4):
        try:
            response = requests.post(test_url, json=test_payload, timeout=30)
            res_json = response.json()
            print(f"⏳ [รอบที่ {count}/3] -> ส่งสัญญาณไปที่ {endpoint_path} | Status จาก ECOUNT: {res_json.get('Status')}")
        except Exception as e:
            print(f"❌ รอบที่ {count} ขัดข้อง: {str(e)}")
        time.sleep(1.5)

def run_all_activations():
    print(f"[{datetime.now().strftime('%H:%M:%S')}] ⚙️ เริ่มต้นโปรแกรมยิงปลดล็อกระบบรายงานยอดขาย...")
    
    session_id = get_test_session()
    if not session_id:
        print("❌ ล็อกอินไม่สำเร็จ กรุณาตรวจสอบการลงทะเบียน IP บน ECOUNT ครับ")
        return
        
    print(f"✅ เชื่อมต่อฐานข้อมูลทดสอบสำเร็จ (Session ID: {session_id})")

    # 1. ยิงปลดล็อกเมนู "รายการใบขาย" (GetListSale)
    activate_menu(session_id, "SaleInquire/GetListSale", "ดูสถานะ -> รายการใบขาย")
    
    # 2. ยิงปลดล็อกเมนู "รายงานสถานะการขาย" (GetListSalesStatus)
    activate_menu(session_id, "SaleInquire/GetListSalesStatus", "ดูสถานะ -> รายงานสถานะการขาย")

    print("\n==================================================")
    print("🎉 ยิงคำขอจำลองครบทั้ง 2 เมนูดึงยอดขายเรียบร้อยแล้วครับพี่ธนา!")
    print("👉 ตอนนี้ให้พี่กด รีเฟรช (Refresh) หน้าเว็บ ECOUNT ดูอีกครั้งได้เลยครับ")
    print("==================================================")

if __name__ == "__main__":
    run_all_activations()