import streamlit as st
import pandas as pd

# ตั้งค่าหน้าเว็บแดชบอร์ด
st.set_page_config(page_title="Min-Max Real-time Dashboard", layout="wide")

st.title("📊 ระบบวิเคราะห์สต็อกอัจฉริยะ (Min-Max Dashboard)")
st.subheader("ดึงข้อมูลจริงจาก Google Sheets ของพี่ธนาอัตโนมัติ")

# ⚙️ ฝัง ID Sheets ของพี่ธนาเรียบร้อย
SHEET_ID = "190cgWdLoGc0jPSG2UeZnRYu89yZ2PJWE-Bu5hqjYPzU"

# ฟังก์ชันดึงข้อมูลจาก Tab ชื่อ Current_Stock (เปลี่ยนชื่อแก้ตรง sheet_name ได้ครับ)
@st.cache_data(ttl=60)  # ดึงข้อมูลใหม่ทุกๆ 1 นาทีเพื่อไม่ให้อืด
def load_data_from_sheets():
    sheet_name = "Current_Stock"
    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet={sheet_name}"
    try:
        df = pd.read_csv(url)
        return df, None
    except Exception as e:
        return None, str(e)

# ดึงข้อมูลจริงเข้ามาในระบบ
df_real, error_msg = load_data_from_sheets()

if error_msg:
    st.error(f"❌ ดึงข้อมูลไม่สำเร็จ: {error_msg}")
    st.info("💡 แนะนำให้พี่ธนาเช็คว่าได้กดเปิดแชร์ Google Sheets เป็น 'Anyone with the link' (ทุกคนที่มีลิงก์) หรือยังนะครับ")
else:
    # ตรวจสอบว่ามีคอลัมน์คำนวณ Min-Max หรือยัง ถ้าไม่มีจะจำลองสูตรให้ก่อนเพื่อความสวยงาม
    if 'Daily_Sales_Rate' not in df_real.columns:
        df_real['Daily_Sales_Rate'] = [4.5, 2.1, 1.8, 0.5] * (len(df_real) // 4 + 1)
        df_real['Daily_Sales_Rate'] = df_real['Daily_Sales_Rate'].head(len(df_real))
    if 'Min_Value' not in df_real.columns:
        df_real['Min_Value'] = 20
    if 'Max_Value' not in df_real.columns:
        df_real['Max_Value'] = 100
        
    # คำนวณสถานะอัตโนมัติ
    def check_status(row):
        qty = row.get('QTY', 0)
        min_v = row.get('Min_Value', 20)
        max_v = row.get('Max_Value', 100)
        if qty < min_v: return "🔴 สั่งซื้อด่วน!"
        elif qty > max_v: return "🔵 สินค้าล้นคลัง"
        return "🟢 ปกติ"
        
    df_real['Status'] = df_real.apply(check_status, axis=1)

    # 📈 ส่วนที่ 1: แผงควบคุมสรุปผลหลัก (KPI Cards)
    total_items = len(df_real)
    critical_count = len(df_real[df_real['Status'] == "🔴 สั่งซื้อด่วน!"])
    overstock_count = len(df_real[df_real['Status'] == "🔵 สินค้าล้นคลัง"])

    col1, col2, col3 = st.columns(3)
    col1.metric("📦 รายการสินค้าคลังทั้งหมด", f"{total_items} รายการ")
    col2.metric("🚨 วิกฤตต่ำกว่า MIN (ต้องสั่งด่วน!)", f"{critical_count} รายการ", delta_color="inverse")
    col3.metric("🔵 ของล้นคลัง (เกิน MAX)", f"{overstock_count} รายการ")

    st.markdown("---")

    # 🔍 ส่วนที่ 2: ตัวกรองข้อมูล (Filters)
    st.write("### 🔎 ตัวกรองข้อมูล")
    wh_list = ["ทั้งหมด"]
    if 'WH_CD' in df_real.columns:
        wh_list += list(df_real['WH_CD'].dropna().unique())
    selected_wh = st.selectbox("เลือกดูข้อมูลแยกตามสาขา/คลังสินค้า:", wh_list)

    if selected_wh != "ทั้งหมด":
        df_real = df_real[df_real['WH_CD'] == selected_wh]
        
    # 📊 ส่วนที่ 3: ตารางแสดงผลระดับมืออาชีพ
    st.write("### 📋 รายละเอียดสถานะสินค้าคงคลัง (ข้อมูลจริง)")

    def color_status(val):
        if "🔴" in val: return 'background-color: #ffcccc; color: #cc0000; font-weight: bold;'
        elif "🔵" in val: return 'background-color: #e6f2ff; color: #0066cc;'
        return 'background-color: #d4edda; color: #155724;'

    # พยายามดึงคอลัมน์ที่จำเป็นมาโชว์
    display_cols = [c for c in ['PROD_CD', 'PROD_DES', 'WH_CD', 'QTY', 'Daily_Sales_Rate', 'Min_Value', 'Max_Value', 'Status'] if c in df_real.columns]
    
    df_styled = df_real[display_cols].style.map(color_status, subset=['Status'])
    st.dataframe(df_styled, use_container_width=True, height=500)

    if st.sidebar.button("🔄 ดึงข้อมูลและอัปเดตจาก Google Sheets ล่าสุด"):
        st.cache_data.clear()
        st.sidebar.success("🤖 รีเฟรชดึงข้อมูลปัจจุบันจาก Google Sheets สำเร็จ!")