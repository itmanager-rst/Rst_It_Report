/**
 * RST Tractor & Harvester Photos — Apps Script backend (bound to a Google Sheet)
 * CODE_VERSION: r14-2026-10-17-price-fill
 *
 * r14: ราคาขายครบขึ้น
 *      - อ่านราคาทนรูปแบบ: ฿ / บาท / ช่องว่าง / วงเล็บ ฯลฯ (เดิม "฿1,200,000" กลายเป็นว่าง)
 *      - ราคา 0 ถือว่า "ไม่มีราคา" และ Serial ซ้ำหลายแถว (โอนย้ายสาขา) จะเอาราคาจากแถวอื่นมาเติม
 *      - ไฟล์ใหม่ไม่มีราคา → ใช้ราคา Ecount ครั้งก่อนต่อ (ไม่ลบราคาเดิมทิ้ง) เก็บวันที่ของราคาไว้ใน priceDate
 *      - ใส่ราคาเองได้จากหน้ารายละเอียดรถ (setPrice ต้องใช้ PIN) เก็บใน priceM / priceBy / priceAt
 *      - ยังไม่มีราคาเลย → ใช้ ราคาขาย จากชีต Legacy_Data (ระบบเก่า) ให้อัตโนมัติ
 *      ลำดับที่ใช้: Ecount ไฟล์ล่าสุด > ใส่เอง > Ecount ครั้งก่อน > ระบบเก่า  (ส่ง priceSrc ไปให้หน้าเว็บแสดงที่มา)
 *
 * r13: เพิ่มช่อง เล่มทะเบียน (reg) จากคอลัมน์ "เล่มทะเบียน" ในรายงาน Ecount ต่อท้ายชีต Tractors
 *      นำเข้าไฟล์ใหม่ครั้งถัดไปจะเติมค่าให้ ไฟล์เก่าที่ไม่มีคอลัมน์นี้ยังนำเข้าได้ (ช่องจะว่าง)
 *
 * r12: เครื่องอัดฟางมือสอง / สาธิต นำเข้าได้แม้ไม่ได้อยู่ใน หมวดรถมือสอง (ใน Ecount เครื่องอัดฟางอยู่หมวดอื่น)
 *      เงื่อนไข: ชื่อมีคำว่า อัดฟาง หรือ Baler และ มือสอง หรือ สาธิต  เครื่องใหม่/เช่า ยังไม่นำเข้า
 *
 * r11: เพิ่มประเภท เครื่องอัดฟาง (ชื่อสินค้ามี เครื่องอัดฟาง / อัดฟาง / Baler)
 *      รถที่เคยถูกจัดเป็น อื่นๆ จะถูกจัดประเภทใหม่ทันทีตอนโหลด (ไม่ต้องนำเข้าไฟล์ใหม่)
 *      เพิ่ม ปีรถ (year, yearBy, yearAt ต่อท้ายชีต Tractors) ใส่เองได้จากหน้ารายละเอียดรถ (setYear ต้องใช้ PIN)
 *      ถ้ายังไม่ได้ใส่เอง และชีต Legacy_Data มีคอลัมน์ปี (ปีรถ / ปีผลิต / ปี / Year ฯลฯ) จะใช้ปีจากระบบเก่าให้อัตโนมัติ
 *      เก็บปีเป็น ค.ศ. ถ้าใส่ พ.ศ. มา (มากกว่า 2400) จะแปลงให้ การนำเข้าไฟล์ใหม่ไม่ลบปีที่ใส่ไว้
 *
 * r10: ใช้หมวดสินค้าใน Ecount เป็นตัวตัดสิน: แถวที่อยู่ "หมวดรถมือสอง" นำเข้าทั้งหมด (รถตู้ ฯลฯ)
 *      แม้ชื่อสินค้าไม่มีคำว่า มือสอง ส่วนมือสองในหมวดอื่นไม่นำเข้า
 *      หน้าเว็บส่ง r.usedCat มา: '1' = อยู่หมวดรถมือสอง, '0' = ไฟล์มีหมวดแต่ไม่ใช่, '' = ไฟล์ไม่มีคอลัมน์หมวด
 *      รถสาธิตนอกหมวดรถมือสอง และไฟล์ที่ไม่มีคอลัมน์หมวด → ใช้กฎตามชื่อแบบเดิม (เฉพาะประเภทรถที่รู้จัก)
 *
 * r09: ดึงทรัพย์สิน มือสอง / รถสาธิต "ทุกรายการ" ที่มี Serial เข้ามา ไม่จำกัดแค่ 3 ประเภทแล้ว
 *      เพิ่มประเภท รถตู้ (ชื่อมี รถตู้ หรือ Van) และ อื่นๆ (มือสองที่ไม่ใช่ แทรกเตอร์/เกี่ยวข้าว/ขุด/ตู้)
 *      รถใหม่/รถเช่า ยังไม่นำเข้าเหมือนเดิม
 *
 * r08: เพิ่มประเภท รถขุด: ชื่อสินค้าต้อง "ขึ้นต้น" ด้วย รถขุด / รถแบคโฮ / Excavator (ยอมให้มี (รถสาธิต) นำหน้า)
 *      อะไหล่ที่มีคำว่า รถขุด อยู่กลางชื่อ เช่น กรองน้ำมันไฮโดรลิก (รถขุด) จะไม่ถูกนับเป็นรถ
 *      รุ่นรถขุดตัดรหัสตัวถัง (CCTH-QMJB1 ฯลฯ) ออก เหลือรุ่นหลัก เช่น ViO35-6B ชื่อสินค้าเต็มยังเก็บใน name
 *
 * r07: แสดงข้อมูลจากระบบเก่า (AppSheet) ในหน้ารายละเอียดรถ อ่านจากชีต Legacy_Data (จับคู่ด้วยคอลัมน์ newKey)
 *      ชีตนี้อ่านอย่างเดียว แอปไม่แก้ไข ดูข้อมูลต้องใส่ PIN ทีม เพราะมีชื่อเจ้าของเก่าและค่าใช้จ่าย
 *
 * r06: เพิ่มรถสาธิต (kindOf_ === 'รถสาธิต') เข้าฐานข้อมูลด้วย แอปเก็บ มือสอง + รถสาธิต (ดู KEEP_KINDS)
 *      รถใหม่/รถเช่า ยังไม่นำเข้าและไม่แสดงเหมือนเดิม
 *
 * r05: ผู้บริหารให้แอปนี้เก็บเฉพาะรถ มือสอง (kindOf_ === 'มือสอง') รถใหม่/รถเช่า/รถสาธิต ไม่นำเข้าและไม่แสดง
 *      แถวรถใหม่ที่นำเข้าไว้ก่อน r05 ยังอยู่ในชีตตามเดิม (รูปไม่หาย) แค่ถูกซ่อนและไม่ถูกแตะตอนนำเข้า
 *
 * แหล่งข้อมูล: Ecount รายงาน "สถานะสินค้าคงคลังตามหมายเลข Serial/Lot" (ยอดคงเหลือ ณ วันที่ส่งออก)
 * เก็บเฉพาะประเภทรถ รถแทรกเตอร์ และ รถเกี่ยวข้าว (ชื่อสินค้ามีคำว่า "รถแทรกเตอร์" หรือ "รถเกี่ยว")
 *
 * Sheets (created by setup()):
 *   Tractors   รถ 1 แถวต่อคัน (key = เลขตัวรถ) นำเข้าไฟล์ใหม่ = แทนยอดคงเหลือทั้งหมด
 *              รถที่เคยอยู่แต่ไม่มีในไฟล์ใหม่ → status "out" (ไม่อยู่ในสต็อก) แถวไม่ถูกลบ รูปยังอยู่
 *   Photos     รายการรูป ไฟล์จริงอยู่ใน Google Drive โฟลเดอร์ "RST Tractor Photos/<เลขตัวรถ>"
 *   ImportLog  ประวัติการนำเข้า
 *   Legacy_Data ข้อมูลจากระบบเก่า (นำเข้าเองครั้งเดียว ไม่ได้สร้างโดย setup) คอลัมน์ newKey = key ใน Tractors
 *   (ชีต Movements จากเวอร์ชันก่อน r04 ไม่ใช้แล้ว ลบทิ้งได้)
 */
var CODE_VERSION = 'r14-2026-10-17-price-fill';

var SH = { TRACTORS: 'Tractors', PHOTOS: 'Photos', LOG: 'ImportLog' };
var HEAD = {
  Tractors: ['key', 'serial', 'chassis', 'engine', 'tag', 'code', 'name', 'series', 'type', 'kind', 'branch', 'spot', 'qty', 'price', 'cond', 'hours', 'status', 'firstSeen', 'lastSeen', 'outDate', 'updatedAt', 'year', 'yearBy', 'yearAt', 'reg', 'priceDate', 'priceM', 'priceBy', 'priceAt'],
  Photos: ['photoId', 'key', 'fileId', 'thumbId', 'label', 'cover', 'uploadedAt', 'uploadedBy'],
  ImportLog: ['at', 'by', 'fileName', 'rowsRead', 'rowsMatched', 'newCars', 'dupRows', 'tractors', 'goneCars', 'format']
};
var PHOTO_FOLDER_NAME = 'RST Tractor Photos';

/* ================= entry ================= */
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'checkStatus') {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, codeVersion: CODE_VERSION }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('RST รูปรถและทรัพย์สิน มือสอง · รถสาธิต')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ================= API gateway =================
 * ทุกคำสั่งจากหน้าเว็บผ่าน call() ที่เดียว
 *   - เปิดจากลิงก์ Web App: google.script.run.call(fn, args, pin)
 *   - เปิดจาก Live Server:  POST ไปที่ /exec เป็น text/plain {"fn","args","pin"} (เข้า doPost)
 * คำสั่งที่แก้ข้อมูล (WRITE) ต้องมี PIN ทีม ตรงกับ Script Property "TEAM_PIN"
 */
var API = {
  getBoot: getBoot, getPhotos: getPhotos, getCovers: getCovers, getPhotoFull: getPhotoFull,
  importStock: importStock, uploadPhoto: uploadPhoto, setCover: setCover, deletePhoto: deletePhoto,
  getLegacy: getLegacy, setYear: setYear, setPrice: setPrice
};
var WRITE = { importStock: 1, uploadPhoto: 1, setCover: 1, deletePhoto: 1, getLegacy: 1, setYear: 1, setPrice: 1 }; // getLegacy อ่านอย่างเดียว แต่ต้องใช้ PIN (ข้อมูลภายใน)

function call(fn, args, pin) {
  if (!Object.prototype.hasOwnProperty.call(API, fn)) throw new Error('ไม่รู้จักคำสั่ง ' + fn);
  if (WRITE[fn]) checkPin_(pin);
  return API[fn].apply(null, args || []);
}
function checkPin_(pin) {
  var want = PropertiesService.getScriptProperties().getProperty('TEAM_PIN');
  if (!want) throw new Error('PIN: ยังไม่ได้ตั้ง TEAM_PIN ให้รัน setup() ใน Apps Script ก่อน');
  if (String(pin || '').trim() !== want) throw new Error('PIN: PIN ทีมไม่ถูกต้อง');
}
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = { ok: true, result: call(req.fn, req.args, req.pin) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** รันครั้งแรกครั้งเดียวจาก editor */
function setup() {
  Object.keys(HEAD).forEach(sheet_);
  var ss = ss_();
  ['Sheet1', 'แผ่น1', 'ชีต1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  folder_();
  var props = PropertiesService.getScriptProperties(), pin = props.getProperty('TEAM_PIN');
  if (!pin) { pin = String(Math.floor(100000 + Math.random() * 900000)); props.setProperty('TEAM_PIN', pin); }
  var msg = 'setup done ' + CODE_VERSION + ' | TEAM_PIN = ' + pin + ' (เปลี่ยนได้ที่ Project Settings > Script Properties)';
  Logger.log(msg);
  return msg;
}

/* ================= sheet helpers ================= */
function ss_() { return SpreadsheetApp.getActive(); }
function sheet_(name) {
  var s = ss_().getSheetByName(name), h = HEAD[name];
  if (!s) {
    s = ss_().insertSheet(name);
    ensureCols_(s, h.length);
    s.getRange(1, 1, s.getMaxRows(), h.length).setNumberFormat('@');
    s.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    s.setFrozenRows(1);
  } else if (name !== SH.TRACTORS) {
    // อัปเกรดหัวตารางของชีตเดิม (Tractors จะเขียนใหม่ทั้งชีตตอนนำเข้า)
    var cur = headerOf_(s);
    if (cur.join('|') !== h.join('|')) {
      ensureCols_(s, h.length);
      s.getRange(1, 1, 1, h.length).setNumberFormat('@').setValues([h]).setFontWeight('bold');
    }
  }
  return s;
}
function ensureCols_(s, n) { var need = n - s.getMaxColumns(); if (need > 0) s.insertColumnsAfter(s.getMaxColumns(), need); }
function headerOf_(s) {
  var c = s.getLastColumn();
  if (!c) return [];
  return s.getRange(1, 1, 1, c).getDisplayValues()[0].map(function (v) { return String(v).trim(); });
}
/** อ่านตามหัวตารางจริงในชีต (รองรับข้อมูลรูปแบบเก่า) */
function readAll_(name) {
  var s = sheet_(name), n = s.getLastRow(), h = headerOf_(s);
  if (n < 2 || !h.length) return [];
  return s.getRange(2, 1, n - 1, h.length).getDisplayValues().map(function (r) {
    var o = {}; h.forEach(function (k, i) { if (k) o[k] = r[i]; }); return o;
  });
}
function toRow_(name, o) { return HEAD[name].map(function (k) { return o[k] == null ? '' : String(o[k]); }); }
function writeAt_(s, start, rows) {
  if (!rows.length) return;
  var need = start + rows.length - 1 - s.getMaxRows();
  if (need > 0) s.insertRowsAfter(s.getMaxRows(), need);
  ensureCols_(s, rows[0].length);
  s.getRange(start, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}
function appendRows_(s, rows) { writeAt_(s, s.getLastRow() + 1, rows); }
function findRow_(s, val) {
  if (s.getLastRow() < 2) return 0;
  var hit = s.getRange(2, 1, s.getLastRow() - 1, 1).createTextFinder(String(val)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function who_(by) {
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { }
  return String(by || '').trim() || email || 'ไม่ระบุ';
}

/* ================= tractor derivation ================= */
function splitSerial_(s) {
  var tag = '';
  var t = String(s).replace(/\(\s*GPS\s*\)/i, function () { tag = 'GPS'; return ''; }).trim();
  var i = t.indexOf('/');
  return { ch: (i < 0 ? t : t.slice(0, i)).trim(), en: i < 0 ? '' : t.slice(i + 1).trim(), tag: tag };
}
/** key = เลขตัวรถ ตัวพิมพ์ใหญ่ ไม่มีช่องว่าง */
function keyOf_(serial) { return splitSerial_(serial).ch.toUpperCase().replace(/\s+/g, ''); }

var EXC_RE = /^\s*(?:\([^)]*\)\s*)?(?:รถขุด|รถแบ็?คโฮ|excavator)/i;
/** รุ่นรถขุด: ViO ของ Yanmar เขียนหลายแบบใน Ecount (VIO-35-6B, VI0356B, VIO3-6B) → ViO35-6B, ViO30-6B */
function excSeries_(name) {
  var x = String(name).replace(/^\s*\([^)]*\)\s*/, '').replace(/^(?:รถขุด|รถแบ็?คโฮ|excavator)\s*/i, '')
    .replace(/\((?:รถ)?(มือสอง|เช่า|สาธิต)\)/g, '').replace(/(?:รถ)?สาธิต/g, '').replace(/^Yanmar\s*/i, '').replace(/รุ่น\s*/g, '').trim();
  var m = x.match(/V[I1]?[O0]\s*-?\s*(\d{1,2})\s*-?\s*(\d{1,2}[A-Z]?)/i);
  if (m) { var n = m[1].length === 1 ? m[1] + '0' : m[1]; return 'ViO' + n + '-' + m[2].toUpperCase(); }
  return x.replace(/\s+/g, ' ');
}
function seriesOf_(name) {
  if (EXC_RE.test(String(name || ''))) return excSeries_(name);
  if (BALER_RE.test(String(name || '')) && !/รถเกี่ยว|รถแทรกเตอร์/.test(String(name))) { // r11: รุ่นเครื่องอัดฟาง ตัดคำนำหน้าออก
    var b = String(name).replace(/^\s*\([^)]*\)\s*/, '').replace(/(?:เครื่อง)?อัดฟาง|\bbaler\b/ig, '')
      .replace(/\((?:รถ)?(มือสอง|เช่า|สาธิต)\)/g, '').replace(/(?:รถ)?สาธิต|มือสอง/g, '').replace(/Yanmar/i, '').replace(/รุ่น\s*/g, '').replace(/\s+/g, ' ').trim();
    return b || 'เครื่องอัดฟาง';
  }
  var x = String(name).replace(/^\(.*?\)\s*/, '');
  var m = x.match(/รุ่น\s*(.+)$/);
  x = (m ? m[1] : x).replace(/\((?:รถ)?(มือสอง|เช่า|สาธิต)\)/g, '').replace(/(?:รถ)?สาธิต/g, '').replace(/VIN.*$/i, '').replace(/^Yanmar\s*/i, '').trim();
  return x.replace(/\s*-\s*45th$/i, ' 45th').replace(/^(\d{3}[A-Z]?)$/, 'YM$1');
}
/** ประเภทรถ (ตรงกับ carType ใน index.html)
 *  ตรวจรถแทรกเตอร์ก่อนรถขุด: รถแทรกเตอร์ที่ติดชุดแบคโฮยังนับเป็นรถแทรกเตอร์
 *  r09: ไม่ตรงประเภทไหนเลย → 'อื่นๆ' (ทรัพย์สินมือสองทุกอย่างถูกนำเข้า ตัวกรองมือสอง/สาธิต อยู่ที่ isKept_) */
var VAN_RE = /รถตู้|\bvan\b/i;
/** r11: เครื่องอัดฟาง ตรวจหลังรถแทรกเตอร์ (ชื่อรถแทรกเตอร์ที่พ่วงเครื่องอัดฟางยังนับเป็นรถแทรกเตอร์) */
var BALER_RE = /อัดฟาง|\bbaler\b/i;
function typeOf_(name) {
  var n = String(name || '');
  if (!n.trim()) return '';
  if (/รถเกี่ยว/.test(n)) return 'รถเกี่ยวข้าว';
  if (/รถแทรกเตอร์/.test(n)) return 'รถแทรกเตอร์';
  if (BALER_RE.test(n)) return 'เครื่องอัดฟาง';
  if (EXC_RE.test(n)) return 'รถขุด';
  if (VAN_RE.test(n)) return 'รถตู้';
  return 'อื่นๆ';
}
function kindOf_(name) {
  var n = String(name || '');
  if (/สาธิต/.test(n)) return 'รถสาธิต';
  if (/เช่า/.test(n)) return 'รถเช่า';
  if (/มือสอง/.test(n)) return 'มือสอง';
  return 'รถใหม่';
}
/** r06: แอปนี้เก็บรถ มือสอง และ รถสาธิต (รถใหม่/รถเช่า ไม่เก็บ) */
var KEEP_KINDS = { 'มือสอง': 1, 'รถสาธิต': 1 };
function isKeptKind_(kind) { return KEEP_KINDS.hasOwnProperty(kind); }
function isKept_(name) { return isKeptKind_(kindOf_(name)); }
/** r10: ประเภทการเก็บของแถวนำเข้า: อยู่หมวดรถมือสอง = มือสอง (หรือ รถสาธิต ถ้าชื่อบอก) */
function rowKind_(r) {
  var k = kindOf_(r.name);
  if (String(r.usedCat || '') === '1') return k === 'รถสาธิต' ? k : 'มือสอง';
  return k;
}
/** r10: นำเข้าแถวนี้ไหม (ตรงกับ keepRow ใน index.html) */
function keepRow_(r) {
  var t = typeOf_(r.name), c = String(r.usedCat || '');
  if (!t) return false;
  if (c === '1') return true;
  if (t === 'อื่นๆ' || !isKept_(r.name)) return false;
  if (t === 'เครื่องอัดฟาง') return true; // r12: เครื่องอัดฟางมือสอง/สาธิต ทุกหมวด
  return c === '' || kindOf_(r.name) === 'รถสาธิต';
}
function num_(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
function numStr_(v) { var t = String(v == null ? '' : v).replace(/,/g, '').trim(); return t === '' || isNaN(parseFloat(t)) ? '' : String(parseFloat(t)); }
/** r14: ราคา → ตัวเลขล้วน ตัด ฿ / บาท / ช่องว่าง / , ออก  ราคา 0 หรือติดลบ = ไม่มีราคา ('') */
function priceStr_(v) {
  var t = String(v == null ? '' : v).replace(/[,\s฿]|บาท|THB/gi, '').trim();
  if (/^\(.*\)$/.test(t)) return ''; // (1,000) = ติดลบแบบบัญชี
  var m = t.match(/^-?\d+(?:\.\d+)?/);
  if (!m) return '';
  var n = parseFloat(m[0]);
  return isNaN(n) || n <= 0 ? '' : String(Math.round(n * 100) / 100);
}
/** r11: ปีรถเป็น ค.ศ. 4 หลัก รับ พ.ศ. ได้ (แปลงให้) ค่าว่าง = ล้างปี คืน null ถ้าใช้ไม่ได้ */
function yearOf_(v) {
  var t = String(v == null ? '' : v).trim();
  if (!t) return '';
  var m = t.match(/(\d{4})/);
  if (!m) return null;
  var y = +m[1];
  if (y > 2400) y -= 543;
  var max = new Date().getFullYear() + 1;
  return y >= 1950 && y <= max ? String(y) : null;
}
function today_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }

/** แปลงแถว Tractors (รวมรูปแบบเก่า r03) ให้มีฟิลด์ครบตาม HEAD.Tractors */
function normCar_(o) {
  if (!o.name && o.model) { // r03: model/cond(รถใหม่/มือสอง)/receivedDate/soldDate
    o.name = o.model; o.kind = o.cond || kindOf_(o.model); o.cond = '';
    o.firstSeen = o.receivedDate || ''; o.outDate = o.soldDate || '';
    o.status = o.status === 'stock' ? 'stock' : 'out';
  }
  if (!o.type || o.type === 'อื่นๆ') { // r11: อื่นๆ เดิมอาจเป็นเครื่องอัดฟาง จัดประเภทและรุ่นใหม่
    var t = typeOf_(o.name);
    if (o.type && t !== o.type) o.series = seriesOf_(o.name);
    o.type = t;
  }
  if (!o.kind) o.kind = kindOf_(o.name);
  if (!o.series) o.series = seriesOf_(o.name);
  var c = {}; HEAD.Tractors.forEach(function (k) { c[k] = o[k] == null ? '' : String(o[k]); });
  return c;
}

/* ================= Legacy_Data (ระบบเก่า AppSheet) ================= */
var LEGACY_SHEET = 'Legacy_Data';
var LEGACY_SKIP = { newKey: 1, matchBy: 1, 'แถว': 1, 'รูป': 1, 'Front': 1, 'Back': 1, 'VDO-File': 1, 'test lo': 1 };
/** เทียบ key แบบทน Google Sheets ตัดเลข 0 นำหน้า (เช่น 000125 → 125) และช่องว่าง */
function legacyNorm_(k) { return String(k == null ? '' : k).toUpperCase().replace(/\s+/g, '').replace(/^0+(?=.)/, ''); }
function legacyRead_() {
  var s = ss_().getSheetByName(LEGACY_SHEET);
  if (!s || s.getLastRow() < 2) return { h: [], ki: -1, rows: [] };
  var h = headerOf_(s), ki = h.indexOf('newKey');
  if (ki < 0) return { h: [], ki: -1, rows: [] };
  return { h: h, ki: ki, rows: s.getRange(2, 1, s.getLastRow() - 1, h.length).getDisplayValues() };
}
/** r11: คอลัมน์ปีรถใน Legacy_Data ชื่อตรงก่อน (ปีรถ ปีผลิต ปี Year ...) ถ้าไม่มี ใช้คอลัมน์แรกที่ขึ้นต้นด้วย ปี */
var LEGACY_YEAR_EXACT = /^(ปีรถ|ปีผลิต|ปีที่ผลิต|ปีรุ่น|รุ่นปี|ปี|year|model\s*year|ปีรถ\s*\(.*\))$/i;
function legacyYearCol_(h) {
  for (var i = 0; i < h.length; i++) if (LEGACY_YEAR_EXACT.test(h[i])) return i;
  for (var j = 0; j < h.length; j++) if (/^ปี/.test(h[j]) && !/ที่ขาย|ที่ซื้อ|ภาษี/.test(h[j])) return j;
  return -1;
}
/** r14: คอลัมน์ราคาขายใน Legacy_Data (ราคาขาย / ราคา / Price) ไม่เอา ราคาทุน / ราคาซื้อ */
function legacyPriceCol_(h) {
  for (var i = 0; i < h.length; i++) if (/^(ราคาขาย|ราคา|price|sale\s*price)$/i.test(h[i])) return i;
  for (var j = 0; j < h.length; j++) if (/ราคาขาย/.test(h[j])) return j;
  return -1;
}
/** {n:{key: จำนวนระเบียนเก่า}, y:{key: ปีรถ}, p:{key: ราคาขาย}} จากระบบเก่า ส่งไปกับ getBoot (cache 10 นาที) */
function legacyCount_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('legacy_count3');
  if (hit) return JSON.parse(hit);
  var d = legacyRead_(), out = { n: {}, y: {}, p: {} }, yi = legacyYearCol_(d.h), pi = legacyPriceCol_(d.h);
  d.rows.forEach(function (r) {
    var k = legacyNorm_(r[d.ki]); if (!k) return;
    out.n[k] = (out.n[k] || 0) + 1;
    if (yi >= 0 && !out.y[k]) { var y = yearOf_(r[yi]); if (y) out.y[k] = y; }
    if (pi >= 0) { var p = priceStr_(r[pi]); if (p) out.p[k] = p; } // ระเบียนหลังสุดชนะ (ราคาล่าสุดในระบบเก่า)
  });
  try { cache.put('legacy_count3', JSON.stringify(out), 600); } catch (e) { }
  return out;
}
/** ระเบียนจากระบบเก่าของรถคันนี้ เป็น [[ชื่อช่อง, ค่า], ...] ต่อระเบียน (รถ 1 คันอาจมีหลายระเบียน) */
function getLegacy(key) {
  var d = legacyRead_(), want = legacyNorm_(key);
  if (!want) return [];
  return d.rows.filter(function (r) { return legacyNorm_(r[d.ki]) === want; }).map(function (r) {
    var fields = [];
    d.h.forEach(function (k, i) {
      var v = String(r[i] == null ? '' : r[i]).trim();
      if (k && !LEGACY_SKIP[k] && v && v !== '-') fields.push([k, v]);
    });
    return fields;
  });
}

/* ================= API ================= */
function getBoot() {
  var photos = {};
  readAll_(SH.PHOTOS).forEach(function (p) { photos[p.key] = (photos[p.key] || 0) + 1; });
  var logs = readAll_(SH.LOG), email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { }
  var cars = readAll_(SH.TRACTORS).map(normCar_).filter(function (c) { return c.key && c.type && isKeptKind_(c.kind); });
  var legacy = {}, lc = { n: {}, y: {}, p: {} };
  cars.forEach(function (c) { c.yearSrc = c.year ? 'manual' : ''; });
  try { lc = legacyCount_(); } catch (e) { }
  cars.forEach(function (c) {
    var lk = legacyNorm_(c.key), n = lc.n[lk], y = lc.y[lk];
    if (n) legacy[c.key] = n;
    if (!c.year && y) { c.year = y; c.yearSrc = 'legacy'; } // r11: ปีจากระบบเก่า (ยังไม่ได้บันทึกลงชีต)
    applyPrice_(c, lc.p[lk]);
  });
  return { version: CODE_VERSION, email: email, tractors: cars, photos: photos, legacy: legacy, lastImport: logs.length ? logs[logs.length - 1] : null };
}

/**
 * rows: [{branch,spot,code,name,serial,gps,qty,price,cond,hours,reg}] ทั้งไฟล์ในครั้งเดียว (ทุกรายการ มือสอง / รถสาธิต)
 * แทนยอดคงเหลือทั้งหมดด้วยไฟล์นี้ รถเดิมที่ไม่มีในไฟล์ → status out
 * Serial เดียวกันหลายแถว (เช่น โอนย้ายสาขา +1/-1) → รวมจำนวน ใช้ข้อมูลแถวบวกล่าสุด เติมช่องว่างจากแถวอื่น
 */
function importStock(rows, meta) {
  meta = meta || {};
  return withLock_(function () {
    var now = new Date().toISOString(), today = today_(), old = {};
    readAll_(SH.TRACTORS).forEach(function (o) { o = normCar_(o); if (o.key) old[o.key] = o; });

    var groups = {}, order = [], matched = 0;
    (rows || []).forEach(function (r) {
      if (!r || !r.serial || !keepRow_(r)) return;
      var key = keyOf_(r.serial); if (!key) return;
      matched++;
      r.price = priceStr_(r.price); // r14: 0 / ข้อความ = ว่าง เพื่อให้ FILL เติมจากแถวอื่นได้
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(r);
    });

    var out = [], fresh = 0, dupRows = 0, gone = 0, FILL = ['branch', 'spot', 'code', 'price', 'cond', 'hours', 'gps', 'reg'];
    order.forEach(function (key) {
      var g = groups[key], qty = 0, pick = null;
      dupRows += g.length - 1;
      g.forEach(function (r) { qty += num_(r.qty); if (num_(r.qty) > 0) pick = r; });
      var r = {}; Object.keys(pick || g[g.length - 1]).forEach(function (k) { r[k] = (pick || g[g.length - 1])[k]; });
      FILL.forEach(function (k) {
        if (String(r[k] || '').trim()) return;
        for (var i = g.length - 1; i >= 0; i--) if (String(g[i][k] || '').trim()) { r[k] = g[i][k]; break; }
      });
      var sp = splitSerial_(r.serial), prev = old[key], inStock = qty > 0;
      if (!prev) fresh++;
      out.push(normCar_({
        key: key, serial: r.serial, chassis: sp.ch, engine: sp.en,
        tag: (sp.tag || /gps/i.test(String(r.gps || ''))) ? 'GPS' : '',
        code: r.code, name: r.name, series: seriesOf_(r.name), type: typeOf_(r.name), kind: rowKind_(r),
        branch: r.branch, spot: r.spot, qty: String(qty), cond: String(r.cond || '').trim(),
        // r14: ไฟล์นี้ไม่มีราคา → ใช้ราคา Ecount ครั้งก่อนต่อ (priceDate = วันที่ของไฟล์ที่ให้ราคานั้น)
        price: r.price || (prev ? priceStr_(prev.price) : ''),
        priceDate: r.price ? today : (prev && priceStr_(prev.price) ? (prev.priceDate || prev.lastSeen || '') : ''),
        priceM: prev ? prev.priceM : '', priceBy: prev ? prev.priceBy : '', priceAt: prev ? prev.priceAt : '',
        hours: numStr_(r.hours), reg: String(r.reg || '').trim(), status: inStock ? 'stock' : 'out',
        firstSeen: (prev && prev.firstSeen) || today, lastSeen: today,
        outDate: inStock ? '' : ((prev && prev.status === 'out' && prev.outDate) || today), updatedAt: now,
        year: prev ? prev.year : '', yearBy: prev ? prev.yearBy : '', yearAt: prev ? prev.yearAt : ''
      }));
      delete old[key];
    });
    Object.keys(old).forEach(function (key) {
      var o = old[key];
      if (!isKeptKind_(o.kind)) { out.push(o); return; } // รถใหม่/รถเช่าจากก่อน r05: เก็บไว้เฉยๆ ไม่แตะ
      if (o.status === 'stock') { gone++; o.status = 'out'; o.outDate = today; o.qty = '0'; o.updatedAt = now; }
      out.push(o);
    });

    var s = sheet_(SH.TRACTORS), h = HEAD.Tractors;
    s.clear();
    ensureCols_(s, h.length);
    s.getRange(1, 1, 1, h.length).setNumberFormat('@').setValues([h]).setFontWeight('bold');
    s.setFrozenRows(1);
    writeAt_(s, 2, out.map(function (c) { return toRow_(SH.TRACTORS, c); }));

    var inStock = out.filter(function (c) { return c.status === 'stock' && isKeptKind_(c.kind); }).length;
    appendRows_(sheet_(SH.LOG), [toRow_(SH.LOG, {
      at: now, by: who_(meta.by), fileName: meta.fileName, rowsRead: meta.rowsRead, rowsMatched: matched,
      newCars: fresh, dupRows: dupRows, tractors: inStock, goneCars: gone, format: 'stock-snapshot'
    })]);
    return { tractors: inStock, total: out.length, fresh: fresh, gone: gone, dupRows: dupRows };
  });
}

/* ================= ปีรถ (r11) ================= */
/** ใส่/แก้/ล้าง ปีรถ ของรถ 1 คัน year ว่าง = ล้าง (กลับไปใช้ปีจากระบบเก่าถ้ามี) */
function setYear(key, year, by) {
  var y = yearOf_(year);
  if (y === null) throw new Error('ปีรถไม่ถูกต้อง ใส่เป็นตัวเลข 4 หลัก ค.ศ. หรือ พ.ศ. เช่น 2018 หรือ 2561');
  return withLock_(function () {
    var s = sheet_(SH.TRACTORS), row = findRow_(s, key);
    if (!row) throw new Error('ไม่พบรถคันนี้ในชีต Tractors');
    var h = headerOf_(s);
    ['year', 'yearBy', 'yearAt'].forEach(function (k) { // ชีตจากก่อน r11 ยังไม่มีคอลัมน์ปี: เติมหัวตารางต่อท้าย
      if (h.indexOf(k) < 0) { ensureCols_(s, h.length + 1); h.push(k); s.getRange(1, h.length).setNumberFormat('@').setValue(k).setFontWeight('bold'); }
    });
    var at = new Date().toISOString(), who = y ? who_(by) : '';
    [['year', y], ['yearBy', who], ['yearAt', y ? at : '']].forEach(function (x) {
      s.getRange(row, h.indexOf(x[0]) + 1).setNumberFormat('@').setValue(x[1]);
    });
    var out = { key: key, year: y, yearBy: who, yearAt: y ? at : '', yearSrc: y ? 'manual' : '' };
    if (!y) { try { var ly = legacyCount_().y[legacyNorm_(key)]; if (ly) { out.year = ly; out.yearSrc = 'legacy'; } } catch (e) { } }
    return out;
  });
}

/* ================= ราคาขาย (r14) ================= */
/** เลือกราคาที่จะแสดง: Ecount ไฟล์ล่าสุด > ใส่เอง > Ecount ครั้งก่อน > ระบบเก่า
 *  c.price = ราคาที่ใช้, c.priceEc = ราคาจาก Ecount (ถ้ามี), c.priceSrc = ecount | ecount-old | manual | legacy | '' */
function applyPrice_(c, legacyPrice) {
  var ec = priceStr_(c.price), man = priceStr_(c.priceM), fresh = ec && (!c.priceDate || c.priceDate === c.lastSeen);
  c.priceEc = ec; c.priceLegacy = legacyPrice || '';
  if (fresh) { c.price = ec; c.priceSrc = 'ecount'; }
  else if (man) { c.price = man; c.priceSrc = 'manual'; }
  else if (ec) { c.price = ec; c.priceSrc = 'ecount-old'; }
  else if (legacyPrice) { c.price = legacyPrice; c.priceSrc = 'legacy'; }
  else { c.price = ''; c.priceSrc = ''; }
  return c;
}
/** เติมหัวคอลัมน์ที่ยังไม่มีในชีต Tractors (ชีตจากเวอร์ชันก่อน) คืนหัวตารางล่าสุด */
function ensureHead_(s, keys) {
  var h = headerOf_(s);
  keys.forEach(function (k) {
    if (h.indexOf(k) < 0) { ensureCols_(s, h.length + 1); h.push(k); s.getRange(1, h.length).setNumberFormat('@').setValue(k).setFontWeight('bold'); }
  });
  return h;
}
/** ใส่/แก้/ล้าง ราคาขายของรถ 1 คัน price ว่าง = ล้างราคาที่ใส่เอง (กลับไปใช้ Ecount / ระบบเก่า) */
function setPrice(key, price, by) {
  var raw = String(price == null ? '' : price).trim(), p = priceStr_(raw);
  if (raw && !p) throw new Error('ราคาไม่ถูกต้อง ใส่เป็นตัวเลขมากกว่า 0 เช่น 450000');
  return withLock_(function () {
    var s = sheet_(SH.TRACTORS), row = findRow_(s, key);
    if (!row) throw new Error('ไม่พบรถคันนี้ในชีต Tractors');
    var h = ensureHead_(s, ['priceM', 'priceBy', 'priceAt']);
    var at = new Date().toISOString(), who = p ? who_(by) : '';
    [['priceM', p], ['priceBy', who], ['priceAt', p ? at : '']].forEach(function (x) {
      s.getRange(row, h.indexOf(x[0]) + 1).setNumberFormat('@').setValue(x[1]);
    });
    var vals = s.getRange(row, 1, 1, h.length).getDisplayValues()[0], c = {};
    h.forEach(function (k, i) { if (k) c[k] = vals[i]; });
    var lp = ''; try { lp = legacyCount_().p[legacyNorm_(key)] || ''; } catch (e) { }
    applyPrice_(c, lp);
    return { key: key, price: c.price, priceSrc: c.priceSrc, priceEc: c.priceEc, priceLegacy: c.priceLegacy, priceDate: c.priceDate || '', priceM: p, priceBy: who, priceAt: p ? at : '' };
  });
}

/* ================= photos ================= */
function folder_() {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { } }
  var f = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  p.setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}
function carFolder_(key) {
  var root = folder_(), name = String(key).replace(/[\/\\]/g, '_');
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}
function blobFromDataUrl_(u, name) {
  var m = String(u).match(/^data:(.+?);base64,(.*)$/);
  if (!m) throw new Error('รูปแบบไฟล์รูปไม่ถูกต้อง');
  return Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name);
}
function dataUrlOf_(fileId) {
  var b = DriveApp.getFileById(fileId).getBlob();
  return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
}
function thumbUrl_(thumbId) {
  var cache = CacheService.getScriptCache(), k = 'th_' + thumbId, hit = cache.get(k);
  if (hit) return hit;
  var u = dataUrlOf_(thumbId);
  if (u.length < 95000) { try { cache.put(k, u, 21600); } catch (e) { } }
  return u;
}

/** p = {key,label,main,thumb,by} main/thumb เป็น data URL ที่ย่อจากหน้าเว็บแล้ว */
function uploadPhoto(p) {
  var f = carFolder_(p.key), stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var base = (p.label || 'photo') + '_' + stamp;
  var main = f.createFile(blobFromDataUrl_(p.main, base + '.jpg'));
  var thumb = f.createFile(blobFromDataUrl_(p.thumb, base + '_thumb.jpg'));
  return withLock_(function () {
    var hasCover = readAll_(SH.PHOTOS).some(function (x) { return x.key === p.key && x.cover === '1'; });
    var o = {
      photoId: Utilities.getUuid(), key: p.key, fileId: main.getId(), thumbId: thumb.getId(),
      label: p.label || '', cover: hasCover ? '' : '1', uploadedAt: new Date().toISOString(), uploadedBy: who_(p.by)
    };
    appendRows_(sheet_(SH.PHOTOS), [toRow_(SH.PHOTOS, o)]);
    o.thumb = p.thumb;
    return o;
  });
}
function getPhotos(key) {
  return readAll_(SH.PHOTOS).filter(function (p) { return p.key === key; }).map(function (p) {
    try { p.thumb = thumbUrl_(p.thumbId); } catch (e) { p.thumb = ''; }
    return p;
  });
}
/** รูปปกของรถหลายคันในครั้งเดียว ใช้กับหน้ารายการ */
function getCovers(keys) {
  var want = {}; (keys || []).forEach(function (k) { want[k] = 1; });
  var pick = {};
  readAll_(SH.PHOTOS).forEach(function (p) {
    if (!want[p.key]) return;
    if (!pick[p.key] || p.cover === '1') pick[p.key] = p;
  });
  var out = {};
  Object.keys(pick).forEach(function (k) { try { out[k] = thumbUrl_(pick[k].thumbId); } catch (e) { } });
  return out;
}
function getPhotoFull(photoId) {
  var s = sheet_(SH.PHOTOS), row = findRow_(s, photoId);
  if (!row) throw new Error('ไม่พบรูปนี้');
  var fileId = s.getRange(row, 3).getDisplayValues()[0][0];
  return { src: dataUrlOf_(fileId), url: 'https://drive.google.com/file/d/' + fileId + '/view' };
}
function setCover(photoId) {
  return withLock_(function () {
    var s = sheet_(SH.PHOTOS), row = findRow_(s, photoId);
    if (!row) throw new Error('ไม่พบรูปนี้');
    var key = s.getRange(row, 2).getDisplayValues()[0][0], n = s.getLastRow();
    var col = s.getRange(2, 1, n - 1, 6).getDisplayValues();
    var vals = col.map(function (r) { return [r[1] === key ? (r[0] === photoId ? '1' : '') : r[5]]; });
    s.getRange(2, 6, n - 1, 1).setNumberFormat('@').setValues(vals);
    return { ok: true };
  });
}
function deletePhoto(photoId) {
  return withLock_(function () {
    var s = sheet_(SH.PHOTOS), row = findRow_(s, photoId);
    if (!row) return { ok: true };
    var r = s.getRange(row, 1, 1, HEAD.Photos.length).getDisplayValues()[0];
    [r[2], r[3]].forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { } });
    s.deleteRow(row);
    if (r[5] === '1') { // ย้ายรูปปกไปที่รูปแรกที่เหลือ
      var rest = readAll_(SH.PHOTOS).filter(function (x) { return x.key === r[1]; });
      if (rest.length) { var rr = findRow_(s, rest[0].photoId); s.getRange(rr, 6).setNumberFormat('@').setValue('1'); }
    }
    return { ok: true };
  });
}