# RST 3-Way Matching

ระบบตรวจใบสั่งซื้อเทียบโปรโมชั่น ใบส่งสินค้า และใบกำกับภาษี สำหรับ RST GROUP

## โครงสร้างไฟล์

```
index.html            หน้าเว็บหลัก โหลดโมดูลตามลำดับ
css/style.css         รูปแบบการแสดงผล
js/                   โมดูลของระบบ (19 ไฟล์)
gas/Code.gs           Google Apps Script สำหรับฐานข้อมูลบน Google Sheet
```

## โมดูลและฟังก์ชัน

| ไฟล์ | หน้าที่ | ฟังก์ชันหลัก |
|---|---|---|
| `js/01-core.js` | ค่าคงที่ ค่าเริ่มต้นของเกณฑ์ และฟังก์ชันพื้นฐาน (แปลงตัวเลข เทียบรหัส เทียบชื่อ) | `sim`, `num`, `kc`, `nk`, `isHalf`, `snap5`, `projOK`, `worst`, `memOf` |
| `js/02-matching.js` | ตรรกะการจับคู่ทั้งหมด: อ้างอิงเอกสาร โปรโมชั่นและส่วนลด ขั้น ① ② ③ ตรวจใบกำกับ และสรุปราย PO | `aggLines`, `resolveLine`, `findDO`, `docRef`, `docRef0`, `inheritRefs`, `poIdx`, `vendorName`, `poDateFix`, `applyDC`, `step1`, `matchPO`, `docMatch`, `invLines`, `dateIn`, `tally`, `recv`, `m1of`, `step2`, `step3`, `invComp`, `invBreak`, `invChecks`, `summary`, `hubDocs`, `reCheck`, `poRefs`, `findPO`, `isInvDoc`, `refTok`, `doNoPO`, `docPO`, `linePO`, `docPOs0`, `docPOs`, `addDays`, `dueOf`, `inRange`, `invDisc`, `MONTHS`, `isRE`, `m1key`, `r1map` |
| `js/03-doc-parser.js` | แยกข้อมูลจากข้อความของ PDF/OCR เป็นหัวเอกสารและรายการสินค้า (ตัวอ่านในเครื่อง) | `parseDocText`, `lastNum` |
| `js/04-sample-data.js` | ข้อมูลตัวอย่างที่แสดงเมื่อยังไม่มีข้อมูลจริง | `SAMPLE` |
| `js/05-ui-helpers.js` | ฟังก์ชันจัดรูปแบบตัวเลข วันที่ ป้ายสถานะ และข้อความแจ้งเตือน | `$`, `esc`, `fm`, `fq`, `idOf`, `fd`, `fp`, `fdisc`, `pill`, `brkHtml` |
| `js/06-store.js` | ฐานข้อมูลในเบราว์เซอร์ การตั้งค่า สิทธิ์ผู้ดูแล และการซิงก์กับ Google Sheet | `refreshAdmin`, `settings`, `DATA`, `hubSet`, `loadHub`, `saveLocal`, `enqueue`, `put`, `rm`, `gsPost`, `flush`, `gsLoad`, `pushAll`, `chip`, `wErr`, `init`, `saveCfg`, `hubOn`, `realEmpty`, `isDemo`, `wait` |
| `js/07-view-core.js` | แท็บ ตัวกรอง และฟังก์ชัน render หลัก | `render`, `vendors`, `projects`, `months`, `mLabel`, `filt`, `tools` |
| `js/08-view-overview.js` | ตารางสถานะทุก PO และการอนุมัติ | `vOverview` |
| `js/09-view-po-promo.js` | ตารางเทียบราคาหลังหักส่วนลดกับ NP_Promotion | `vPromo` |
| `js/10-view-promo-library.js` | รายการโปรโมชั่น ส่วนลด DC / ส่วนลดพิเศษ ตาม Part Type และตารางรายการสินค้า | `vPromos`, `invVerdict`, `verdictHtml`, `poSteps` |
| `js/11-view-delivery.js` | ปุ่มนำเข้าไฟล์ ตารางใบส่งสินค้า และผลเทียบรายบรรทัด | `upPanel`, `docTable`, `vDelivery`, `reState`, `reSection`, `sendRE`, `priceDetail`, `reDocs`, `reCan`, `drvErr`, `reBad` |
| `js/12-view-invoice.js` | ตารางใบกำกับภาษี ตารางเทียบแบบเจาะลึกราย PO และผลตรวจหัวเอกสาร | `vInvoice` |
| `js/13-view-docs.js` | หน้านำเข้า PO / โปรโมชั่น และรายการเอกสาร | `vDocs` |
| `js/14-view-settings.js` | เกณฑ์การตรวจ Google Sheet ผู้ดูแลระบบ และการอ่านเอกสาร | `vSettings` |
| `js/15-import-excel.js` | จับคู่คอลัมน์และนำเข้ารายงานสถานะการซื้อ / ไฟล์โปรโมชั่น | `autoMap`, `readXlsx`, `netPrice`, `promoPrice`, `importGo`, `hn`, `dstr` |
| `js/16-doc-reader.js` | อ่าน PDF และไฟล์สแกนด้วยข้อความในไฟล์ OCR หรือ Claude API | `loadScript`, `pdfLib`, `filePages`, `ocr`, `aiRead`, `scan`, `isPdf`, `b64`, `PROMPT` |
| `js/17-doc-editor.js` | หน้าตรวจทานใบส่งสินค้า / ใบกำกับภาษีก่อนบันทึก | `splitDocs`, `scanOpen`, `scanPick`, `scanNext`, `sqAfter`, `sqStop`, `finDoc`, `fillDiscount`, `openEditor`, `edDelVal`, `edHints`, `edMatch`, `edWarns`, `renderEd`, `edRefresh`, `edDoc`, `edTotals`, `edPreview`, `edSave`, `sqPdf`, `sqName`, `sqMore`, `sqBar`, `edDelCell` |
| `js/18-export.js` | ส่งออก Excel และส่งรายงานไป Google Sheet | `buildWB`, `exportX`, `report`, `stamp` |
| `js/19-app.js` | ตัวจัดการปุ่มและช่องกรอกทั้งหมด และการเริ่มทำงานของระบบ | - |

## ลำดับการทำงานของข้อมูล

1. `15-import-excel.js` นำเข้า PO และโปรโมชั่น แล้วเก็บผ่าน `06-store.js`
2. `16-doc-reader.js` อ่าน PDF / ไฟล์สแกน ส่งต่อให้ `17-doc-editor.js` ตรวจทานและบันทึก
3. `06-store.js` เก็บข้อมูลในเบราว์เซอร์ และซิงก์กับ Google Sheet ผ่าน `gas/Code.gs`
4. `02-matching.js` คำนวณผลการจับคู่ทั้ง 3 ขั้นจากข้อมูลใน store ทุกครั้งที่แสดงผล
5. `07`–`14` แสดงผลแต่ละแท็บ และ `19-app.js` รับคำสั่งจากปุ่มและช่องกรอก
6. `18-export.js` ส่งออก Excel และส่งรายงานไป Google Sheet

## การแก้ไข

- แก้กฎการจับคู่หรือการคำนวณส่วนลด: `js/02-matching.js`
- แก้หน้าจอของแท็บใด: ไฟล์ `js/08` ถึง `js/14` ของแท็บนั้น
- แก้การอ่านเอกสาร: `js/03-doc-parser.js` และ `js/16-doc-reader.js`
- แก้ฐานข้อมูลฝั่ง Google Sheet: `gas/Code.gs` แล้ว Deploy เวอร์ชันใหม่
- ไฟล์ทั้งหมดใช้ตัวแปรร่วมกันแบบ global และต้องโหลดตามลำดับเลข ห้ามสลับลำดับใน `index.html`

## การติดตั้ง Google Sheet

ดูขั้นตอนที่หัวไฟล์ `gas/Code.gs` หรือแท็บ "ตั้งค่า" ในหน้าเว็บ
