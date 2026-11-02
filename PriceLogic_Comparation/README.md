# RST GROUP · PriceLogic Procurement (v5.9.30)

ระบบจัดซื้อครบวงจรของ RST GROUP (RUAMSINTHAI / ASIA / ROBOTICS)

ดึงสถานะใบขอซื้อจาก ECOUNT ผ่าน RST GROUP Data Hub → ขอใบเสนอราคา (RFQ) → เปรียบเทียบราคา → อนุมัติ → ออกใบสั่งซื้อ (PO YANMAR / PO ECOUNT) → ตรวจรับสินค้า (RE เทียบ PO)

## ไฟล์ใน repo

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `index.html` | ตัวแอป สำหรับเปิดผ่าน GitHub Pages |
| `apps-script/Index.html` | ตัวแอปเดียวกัน สำหรับวางในไฟล์ `Index.html` ของ Google Apps Script |
| `apps-script/Code.gs` | โค้ดฝั่ง Apps Script: ฐานข้อมูลแอป, อ่าน/จัดข้อมูลใน Data Hub, ส่ง PO เข้า ECOUNT OpenAPI |
| `apps-script/appsscript.json` | Manifest ของ Apps Script (time zone และสิทธิ์ที่ต้องใช้) |

## ติดตั้ง / อัปเดตใน Google Apps Script

1. เปิด Apps Script ของ PriceLogic
2. วาง `apps-script/Code.gs` แทนของเดิมทั้งหมดในไฟล์ `Code.gs` (หรือ `รหัส.gs`)
3. วาง `apps-script/Index.html` แทนของเดิมทั้งหมดในไฟล์ `Index.html`
4. ⚙️ Project Settings → เปิด "Show appsscript.json" → วาง `apps-script/appsscript.json`
5. Deploy → Manage deployments → ✏️ → Version: New version → Deploy
6. เปิด PriceLogic แล้วกด Ctrl + F5

ถ้า Apps Script ขอสิทธิ์ใหม่ (เช่นหลังเพิ่ม `script.scriptapp`) ให้เลือกฟังก์ชันใดก็ได้ เช่น `testEcountLogin` → Run → อนุญาตสิทธิ์ แล้ว Deploy ใหม่

### ฟังก์ชันที่รันเองจากหน้า Apps Script (ครั้งเดียว ถ้าต้องการ)

| ฟังก์ชัน | ใช้ทำอะไร |
|---|---|
| `setupPRDataHub` | สร้างชีต `ECOUNT_PR` ใน Data Hub (ครั้งแรก) |
| `testEcountLogin` | ทดสอบเข้าสู่ระบบ ECOUNT API |
| `installDhReplaceTrigger` | จัดข้อมูล Data Hub แบบ "แทนที่ตามเลขที่เอกสาร" ทุก 30 นาที แม้ไม่ได้เปิด PriceLogic |

## Script Properties (⚙️ Project Settings → Script Properties)

| Property | ค่า |
|---|---|
| `PO_PASSCODE` | รหัสทีม ที่ต้องกรอกก่อนส่ง PO / ลบข้อมูล / ตั้งค่า API (ถ้ายังไม่มี รหัสที่กรอกครั้งแรกในหน้า 🔑 ECOUNT API จะถูกตั้งเป็นรหัสทีม) |
| `ECOUNT_TEST` | `true` = ระบบทดสอบ (sboapi), `false` = ระบบจริง (oapi) |
| `ECOUNT_RUAMSINTHAI` / `ECOUNT_ASIA` / `ECOUNT_ROBOTICS` | `{"COM_CODE":"...","USER_ID":"...","API_CERT_KEY":"...","ZONE":""}` — ตั้งผ่านหน้า 🔑 ตั้งค่า ECOUNT API ในแอปได้ |
| `DH_DUP_OK` | ระบบเขียนเอง — รายการ RE ที่ยืนยันแล้วว่าไม่ใช่ข้อมูลซ้ำ |

**ห้ามใส่ API Key, รหัสทีม หรือรหัสผ่านใดๆ ลงในไฟล์ของ repo นี้** เก็บไว้ใน Script Properties เท่านั้น

## RST GROUP Data Hub ที่ระบบอ่าน

| ชีต | ข้อมูล |
|---|---|
| `DH_PR_STATUS` / `ECOUNT_PR` | สถานะใบขอซื้อ |
| `DH_PO_STATUS` (หรือ `สถานะใบสั่งซื้อ`) | สถานะใบสั่งซื้อ — ใช้จับคู่ PR ↔ PO, YDS NO., กำหนดส่งมอบ, ราคาหลังหักส่วนลด |
| `DH_PURCHASE_STATUS` | สถานะการซื้อ (RE) — เลขที่จาก "หมายเลขการซื้อ" จับคู่ RE ↔ PO ทีละบรรทัด |
| `DH_PARTNER_MASTER`, `DH_VENDOR` | ลูกค้า/ผู้ขาย, เลขผู้เสียภาษี, เงื่อนไขการชำระเงิน |
| `DH_LOCATION` | สถานที่ (รหัส + ชื่อ) แยกตามบริษัท |

ทุกครั้งที่แอปอ่านข้อมูล Code.gs จะจัดชีตแบบ "แทนที่ตามเลขที่เอกสาร" — เลข PR / PO / RE ที่ถูกดึงซ้ำจะเหลือชุดล่าสุด เอกสารที่ไม่อยู่ในการดึงรอบหลังไม่ถูกแตะ

## เปิดผ่าน GitHub Pages

1. Settings → Pages → Source: Deploy from a branch → `main` / `(root)`
2. เปิดหน้าเว็บ กด **🔗 Google Sheet** แล้ววาง Web App URL ของ PriceLogic (ลงท้าย `/exec`) — ต้องทำครั้งแรกในแต่ละเครื่อง/เบราว์เซอร์

ทีมงานใช้งานจริงผ่านลิงก์ `/exec` ของ Apps Script — GitHub Pages ใช้สำหรับสำรอง/ทดลอง

## ข้อควรระวัง

- **ห้าม commit Web App URL ของ PriceLogic** ลงในไฟล์ใดๆ ใครที่มีลิงก์นี้อ่านและเขียนข้อมูลในระบบได้
- `index.html` มีลิงก์ Web App ของระบบคลังโปรโมชั่น (RST 3-Way Matching) ฝังเป็นค่าเริ่มต้น — ถ้าตั้ง repo เป็นสาธารณะ ลิงก์นี้จะเปิดเผยด้วย ควรตั้ง repo เป็น **Private**
- `Code.gs` มี ID ของ Google Sheet "RST GROUP Data Hub" (ไม่ใช่รหัสผ่าน แต่ระบุไฟล์ได้) — เข้าถึงได้เฉพาะบัญชีที่มีสิทธิ์ในไฟล์นั้น

## เวอร์ชันล่าสุด (v5.9.x)

- สถานะใบขอซื้อ: สถานะ PR / สถานะ PO (รอเปิด PO X รายการ / เสร็จสิ้น), ลบ PR หรือบางรายการออกจากระบบ (กู้คืนได้)
- ฟอร์มสร้างใบสั่งซื้อ ECOUNT แบบเต็มจอ เลือกบริษัทที่เปิด PO ได้, Excel ตาม template ของแต่ละบริษัท
- ประวัติ PO YANMAR / ประวัติ PO ทั้งหมด (KPI, กำหนดส่งมอบ, รอส่งมอบ / ค้างส่ง / เสร็จสิ้น, ตัดจบ PO, ตรวจเลขที่ซ้ำ)
- ประวัติ RE รับสินค้า: ตรวจรายการ / จำนวน / ราคา / มูลค่า RE เทียบ PO ทีละบรรทัด, ออกใบรับ RE (ร่าง + Excel)
- ข้อมูลบริษัท (ที่อยู่ เลขผู้เสียภาษี ผู้ติดต่อ โลโก้) แสดงบนใบขอราคา
- อัปเดตอัตโนมัติเมื่อ Data Hub เปลี่ยน (เช็กทุก 1 นาที), ตรวจ/ยืนยัน/ลบข้อมูลซ้ำใน Data Hub
