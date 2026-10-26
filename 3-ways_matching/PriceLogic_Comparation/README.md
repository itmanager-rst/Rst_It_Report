# RST GROUP · PriceLogic Procurement (v5.5)

ระบบจัดซื้อครบวงจรของ RST GROUP:
ดึงสถานะใบขอซื้อจาก ECOUNT (ผ่าน RST GROUP Data Hub) → ขอใบเสนอราคา (RFQ) → เปรียบเทียบราคา → อนุมัติ → ออกใบสั่งซื้อ (PO) เข้า ECOUNT

## ไฟล์ใน repo

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `index.html` | ตัวแอป สำหรับเปิดผ่าน GitHub Pages |
| `apps-script/Index.html` | ตัวแอปเดียวกัน สำหรับวางใน Google Apps Script |
| `apps-script/Code.gs` | โค้ดฝั่ง Google Apps Script (v5.2): ฐานข้อมูลแอป + สถานะใบขอซื้อใน Data Hub + ออก PO ผ่าน ECOUNT OpenAPI |

## ติดตั้งใน Google Apps Script

1. เปิด Google Sheet **PriceLogic** → ส่วนขยาย → Apps Script
2. วาง `apps-script/Code.gs` ในไฟล์ `Code.gs` และ `apps-script/Index.html` ในไฟล์ `Index.html` → บันทึก
3. ครั้งแรกเท่านั้น: เลือกฟังก์ชัน `setupPRDataHub` → เรียกใช้ → อนุญาตสิทธิ์
4. การทำให้ใช้งานได้ → จัดการการทำให้ใช้งานได้ → ✏️ → เวอร์ชันใหม่ → ทำให้ใช้งานได้

## ตั้งค่าการออกใบสั่งซื้อเข้า ECOUNT

Apps Script → ⚙️ Project Settings → Script Properties → เพิ่ม:

| Property | ค่า |
|---|---|
| `PO_PASSCODE` | รหัสทีมที่ต้องกรอกก่อนส่ง PO |
| `ECOUNT_TEST` | `true` = ระบบทดสอบของ ECOUNT, `false` = ระบบจริง |
| `ECOUNT_RUAMSINTHAI` | `{"COM_CODE":"...","USER_ID":"...","API_CERT_KEY":"..."}` |
| `ECOUNT_RST ASIA PACIFIC` | รูปแบบเดียวกัน |
| `ECOUNT_RST ROBOTICS` | รูปแบบเดียวกัน |

จากนั้นรันฟังก์ชัน `testEcountLogin` เพื่อตรวจการเข้าสู่ระบบ — **ห้ามใส่ API Key ลงในไฟล์ใดใน repo นี้**

## เปิดผ่าน GitHub Pages

1. Settings → Pages → Source: Deploy from a branch → `main` / `(root)`
2. เปิดหน้าเว็บ กด **🔗 Google Sheet** แล้ววาง Web App URL (ลงท้าย `/exec`) — ต้องทำครั้งแรกในแต่ละเครื่อง/เบราว์เซอร์

## ข้อควรระวัง

- **ห้าม commit Web App URL ของ PriceLogic** ลงในไฟล์ใดๆ ใครที่มีลิงก์นี้อ่านและเขียนทับข้อมูลในระบบได้
- ถ้า repo เป็นสาธารณะ ลิงก์คลังโปรโมชั่น (ระบบ 3-Way Matching) ที่ฝังใน `index.html` จะเปิดเผยด้วย
