# แผนนำเข้าเพื่อลดต้นทุน — RST GROUP

ระบบวางแผนสั่งซื้อจากต่างประเทศเพื่อลดต้นทุนของ RST GROUP (RST ASIA PACIFIC, RUAMSINTHAI, RST ROBOTICS)
ฐานข้อมูลเก็บใน Google Sheet และเข้าถึงผ่าน Google Apps Script Web App

## โครงสร้าง

```
apps-script/
  Code.gs               API อ่าน/เขียน Google Sheet + เมนู RST GROUP
  appsscript.json       ค่าโปรเจกต์ (เขตเวลา Asia/Bangkok, Web App)
  .clasp.json.example   ตัวอย่างสำหรับ clasp (คัดลอกเป็น .clasp.json)
dashboard/
  index.html            หน้าแดชบอร์ด (แท็บภาพรวม รายการสินค้า ประวัติราคา สินค้านำเข้า ประวัติ RFQ แผนสั่งซื้อ ตั้งค่า)
data/
  (ไฟล์ข้อมูล .xlsx/.csv ไม่ขึ้น GitHub — ดู .gitignore)
```

## แท็บใน Google Sheet

| แท็บ | เก็บอะไร |
|---|---|
| PO_HISTORY | บรรทัดใบสั่งซื้อ RST ASIA PACIFIC จากไฟล์ ECOUNT |
| ITEM_TR | ชื่อสินค้าภาษาอังกฤษ/จีน สำหรับ RFQ |
| CATS | กลุ่มวัสดุสิ้นเปลือง ระดับความเหมาะสมนำเข้า ข้อพิจารณา |
| IMPORTED | บรรทัดสินค้านำเข้า พร้อมราคาในประเทศที่ใช้เทียบ |
| IMPORT_COSTS | ค่าใช้จ่ายนำเข้า (Shipping / ภาษีอากร / D/O) |
| COST_SUMMARY | สรุปค่าใช้จ่ายนำเข้า รวม / ภาษี / ค่าบริการ (สูตร) |
| SETTINGS | รายละเอียดบริษัทและผู้ติดต่อบนใบ RFQ |
| PLAN | รายการในแผนสั่งซื้อต่างประเทศ + ค่าตั้งต้น (I2 เดือน, I3 ส่วนลด %, I4 ภาษา) |
| RFQ_LOG / RFQ_ITEMS | ประวัติการขอใบเสนอราคา (หัวเอกสาร / รายการ) |

ข้อมูล RUAMSINTHAI และ RST ROBOTICS อยู่ใน **RST GROUP Data Hub** (แท็บ PO_LINES) ไม่ได้ทำสำเนาไว้ใน Sheet นี้

## ติดตั้ง

1. อัปโหลด `RST_GROUP_Import_Plan_DB.xlsx` เข้า Google Drive → เปิดไฟล์ → **ไฟล์ → บันทึกเป็น Google ชีต**
2. ในชีตที่ได้: **ส่วนขยาย → Apps Script** → ลบโค้ดเดิม วางโค้ดจาก `apps-script/Code.gs` → บันทึก
3. เลือกฟังก์ชัน `setup` → **เรียกใช้** → อนุญาตสิทธิ์ (ครั้งแรกครั้งเดียว)
4. กลับไปที่ชีต รีเฟรช จะมีเมนู **RST GROUP** → **ดู API token** (เก็บไว้ อย่าแชร์)
5. Apps Script → **การทำให้ใช้งานได้ → การทำให้ใช้งานได้รายการใหม่ → เว็บแอป**
   - เรียกใช้ในฐานะ: ฉัน · ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน
   - คัดลอก URL ของเว็บแอป (ลงท้ายด้วย `/exec`)

## ใช้งาน API

อ่าน
```
GET  <WEB_APP_URL>?token=<API_TOKEN>&table=PLAN
GET  <WEB_APP_URL>?token=<API_TOKEN>&table=ALL
```

เขียน (POST, body เป็น JSON)
```json
{ "token": "<API_TOKEN>", "action": "saveRfq",
  "rfq": { "rfq_no": "RFQ-20261015-1216", "created": "2026-10-15T05:19:38Z", "lang": "zh", "currency": "CNY",
           "status": "ส่งแล้ว", "files": ["pdf"], "items": [{ "code": "RM00141", "name": "สกรูมิลดำ M12 x 40", "qty": 1000 }] } }
```
action อื่น: `append`, `upsert`, `replace`, `deleteWhere`, `setSettings`, `setPlan` (รายละเอียดในหัวไฟล์ `Code.gs`)

## นำขึ้น GitHub

```bash
git init
git add .
git commit -m "RST GROUP import plan: Apps Script API + dashboard"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

ใช้ [clasp](https://github.com/google/clasp) เพื่อส่งโค้ดจาก repo ขึ้น Apps Script:
```bash
npm i -g @google/clasp && clasp login
cd apps-script && cp .clasp.json.example .clasp.json   # ใส่ scriptId
clasp push
```

## ความปลอดภัย
- ไม่มี token หรือข้อมูลธุรกิจใน repo — token อยู่ใน Script Properties ของ Apps Script เท่านั้น
- ถ้า token หลุด: เมนู **RST GROUP → สร้าง API token ใหม่**
- ตั้ง repo เป็น **Private** เพราะมีชื่อผู้ขายและโครงสร้างข้อมูลจัดซื้อ
