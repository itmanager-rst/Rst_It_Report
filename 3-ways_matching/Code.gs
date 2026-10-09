/**
 * RST 3-Way Matching — Google Apps Script (Code.gs)
 * ฐานข้อมูลและรายงานของระบบ 3-Way Matching บน Google Sheet
 *
 * วิธีติดตั้ง
 *   1. เปิด Google Sheet > Extensions > Apps Script
 *   2. ลบโค้ดเดิม วางไฟล์นี้ทั้งหมด แล้วกด Save
 *   3. Deploy > New deployment > Web app
 *      Execute as: Me   |   Who has access: Anyone
 *   4. นำ URL ที่ลงท้ายด้วย /exec ไปวางในแท็บ "ตั้งค่า" ของหน้าเว็บ
 *
 * โครงสร้างไฟล์
 *   1. CONFIG          ค่าคงที่ของระบบ
 *   2. ENTRY POINTS    doGet / doPost ที่หน้าเว็บเรียก
 *   3. DATABASE        อ่าน เขียน ลบ ข้อมูลในแท็บ DB
 *   4. REPORT          เขียนแท็บรายงานที่อ่านได้
 *   5. UTILITIES       ฟังก์ชันช่วย
 *   6. MANUAL TOOLS    ฟังก์ชันที่กด Run เองจากหน้า Apps Script
 *
 * รูปแบบแท็บ DB (ห้ามแก้ด้วยมือ)
 *   คอลัมน์ A = ชุดข้อมูล (pos, dels, invs, appr, promos, promosets, meta)
 *   คอลัมน์ B = รหัสเอกสาร
 *   คอลัมน์ C = เวลาที่บันทึกล่าสุด
 *   คอลัมน์ D เป็นต้นไป = ข้อมูล JSON ตัดเป็นท่อนละไม่เกิน 45,000 ตัวอักษร
 */

/* ============================================================
 * 1. CONFIG
 * ============================================================ */
var CONFIG = {
  DB_SHEET: 'DB',     // ชื่อแท็บฐานข้อมูล
  CHUNK: 45000,       // ความยาวสูงสุดต่อเซลล์ (Google Sheet จำกัด 50,000)
  META_COLS: 3,       // จำนวนคอลัมน์ก่อนถึงข้อมูล JSON
  LOCK_MS: 25000      // เวลารอคิวเมื่อมีหลายคนบันทึกพร้อมกัน
};

/* ============================================================
 * DATA HUB (อ่านอย่างเดียว)
 * อ่านแท็บ PO_LINES และ PURCHASE_LINES (ถ้าไม่มี ใช้ ECOUNT_PURCHASE) จากไฟล์ RST GROUP Data Hub เฉพาะแถวตั้งแต่วันที่เริ่ม
 * ครั้งแรกหลังเพิ่มส่วนนี้ ต้อง Deploy เวอร์ชันใหม่และอนุญาตสิทธิ์อ่าน Google Sheet อีกครั้ง
 * ============================================================ */
function hubRead_(id, from, company) {
  // ไม่ได้ส่งรหัสไฟล์มา: หาไฟล์ชื่อ "RST GROUP Data Hub" ใน Google Drive ของบัญชีที่ติดตั้งสคริปต์
  if (!id) {
    var it = DriveApp.getFilesByName('RST GROUP Data Hub');
    if (it.hasNext()) id = it.next().getId();
    else return { ok: false, error: 'hub: missing file id — ใส่รหัสไฟล์ Data Hub ที่แท็บตั้งค่า' };
  }
  var ss = SpreadsheetApp.openById(id), tz = ss.getSpreadsheetTimeZone(), tabs = {}, names = [];
  var sheets = ss.getSheets(), hasLines = sheets.some(function (sh) { return sh.getName() === 'PURCHASE_LINES' && sh.getLastRow() > 1; });
  sheets.forEach(function (sh) {
    var n = sh.getName(); names.push(n);
    // PO_LINES และ PURCHASE_LINES เป็นหลัก ECOUNT_PURCHASE อ่านเฉพาะเมื่อไม่มี PURCHASE_LINES
    if (!(/_LINES$/i.test(n) || (n === 'ECOUNT_PURCHASE' && !hasLines)) || sh.getLastRow() < 1) return;
    var v = sh.getDataRange().getValues(), h = v[0].map(function (x) { return String(x).trim(); });
    var ci = h.indexOf('COMPANY'), di = ['PO_DATE', 'RECEIVE_DATE', 'DOC_DATE'].map(function (k) { return h.indexOf(k); }).filter(function (k) { return k >= 0; })[0];
    var rows = [];
    for (var r = 1; r < v.length; r++) {
      var row = v[r];
      for (var c = 0; c < row.length; c++) if (row[c] instanceof Date) row[c] = Utilities.formatDate(row[c], tz, 'yyyy-MM-dd');
      if (row.join('') === '') continue;
      if (company && ci >= 0 && String(row[ci]).trim() !== company) continue;
      // ส่งเฉพาะแถวตั้งแต่วันที่เริ่ม (ลดขนาดข้อมูล) รับเข้าย้อนหลัง 3 เดือนเผื่อ PO ข้ามเดือน
      if (from && di != null && di >= 0) { var d = String(row[di]).slice(0, 10); if (d && d < (n === 'PO_LINES' ? from : shift_(from, -92))) continue; }
      rows.push(row);
    }
    tabs[n] = { headers: v[0], rows: rows };
  });
  return { ok: true, id: id, names: names, tabs: tabs };
}
function shift_(iso, days) { var t = new Date(iso + 'T00:00:00Z'); if (isNaN(t)) return iso; t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10); }

/* ============================================================
 * 2. ENTRY POINTS
 * ============================================================ */

/** GET  ?action=hub&id=<รหัสไฟล์ Data Hub>  อ่านแท็บ *_LINES ของ RST GROUP Data Hub
 *  GET  ?action=load  ส่งข้อมูลทั้งหมดกลับไปให้หน้าเว็บ
 *  GET  ?action=ping  ใช้ทดสอบว่าเชื่อมต่อได้ */
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'load';
    if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });
    if (action === 'hub') return json_(hubRead_(e.parameter.id, e.parameter.from, e.parameter.company));
    return json_({ ok: true, rows: dbReadAll_() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** POST {action:'save',   rows:[{coll,id,json}], deletes:[{coll,id}]}
 *  POST {action:'report', sheets:{ชื่อแท็บ: [[แถว]]}} */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_MS);
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'save') {
      dbSave_(body.rows || [], body.deletes || []);
      return json_({ ok: true });
    }
    if (body.action === 'report') {
      reportWrite_(body.sheets || {});
      return json_({ ok: true });
    }
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * 3. DATABASE
 * ============================================================ */

/** คืนแท็บ DB ถ้ายังไม่มีให้สร้างและตั้งรูปแบบเป็นข้อความ */
function dbSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.DB_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.DB_SHEET);
    sheet.getRange('A:Z').setNumberFormat('@');
  }
  return sheet;
}

/** อ่านทุกแถวเป็น [{coll, id, json}] */
function dbReadAll_() {
  var values = dbSheet_().getDataRange().getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (!values[i][0]) continue;
    rows.push({
      coll: String(values[i][0]),
      id: String(values[i][1]),
      json: values[i].slice(CONFIG.META_COLS).join('')
    });
  }
  return rows;
}

/** สร้างดัชนี "ชุดข้อมูล/รหัส" -> เลขแถว */
function dbIndex_(sheet) {
  var values = sheet.getDataRange().getValues();
  var index = {};
  for (var i = 0; i < values.length; i++) {
    if (values[i][0]) index[values[i][0] + '/' + values[i][1]] = i + 1;
  }
  return index;
}

/** แปลงเอกสารหนึ่งรายการเป็นหนึ่งแถว โดยตัด JSON เป็นท่อน */
function dbToRow_(doc) {
  var row = [doc.coll, doc.id, new Date().toISOString()];
  var json = String(doc.json || '');
  for (var p = 0; p < json.length; p += CONFIG.CHUNK) row.push(json.slice(p, p + CONFIG.CHUNK));
  return row;
}

/** เขียนหนึ่งแถวลงตำแหน่งที่กำหนด */
function dbWriteRow_(sheet, rowNumber, row) {
  ensureColumns_(sheet, row.length);
  sheet.getRange(rowNumber, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}

/** บันทึกและลบเอกสาร: แก้แถวเดิม > ลบแถว > ต่อท้ายแถวใหม่ */
function dbSave_(rows, deletes) {
  var sheet = dbSheet_();
  var index = dbIndex_(sheet);
  var toAppend = [];
  var toDelete = [];

  rows.forEach(function (doc) {
    var row = dbToRow_(doc);
    var at = index[doc.coll + '/' + doc.id];
    if (at) {
      sheet.getRange(at, 1, 1, sheet.getMaxColumns()).clearContent();
      dbWriteRow_(sheet, at, row);
    } else {
      toAppend.push(row);
    }
  });

  deletes.forEach(function (doc) {
    var at = index[doc.coll + '/' + doc.id];
    if (at) toDelete.push(at);
  });
  toDelete.sort(function (a, b) { return b - a; }).forEach(function (at) { sheet.deleteRow(at); });

  toAppend.forEach(function (row) { dbWriteRow_(sheet, sheet.getLastRow() + 1, row); });
}

/* ============================================================
 * 4. REPORT
 * ============================================================ */

/** เขียนทับแท็บรายงานตามชื่อที่หน้าเว็บส่งมา (ไม่แตะแท็บ DB) */
function reportWrite_(sheets) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(sheets).forEach(function (name) {
    if (name === CONFIG.DB_SHEET) return;
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var rows = sheets[name] || [];
    sheet.clearContents();
    if (!rows.length) return;
    var width = 1;
    rows.forEach(function (r) { if (r.length > width) width = r.length; });
    rows.forEach(function (r) { while (r.length < width) r.push(''); });
    ensureColumns_(sheet, width);
    sheet.getRange(1, 1, rows.length, width).setValues(rows);
  });
}

/* ============================================================
 * 5. UTILITIES
 * ============================================================ */

/** ตอบกลับเป็น JSON */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** เพิ่มคอลัมน์ให้พอสำหรับข้อมูล */
function ensureColumns_(sheet, needed) {
  var have = sheet.getMaxColumns();
  if (have < needed) sheet.insertColumnsAfter(have, needed - have);
}

/* ============================================================
 * 6. MANUAL TOOLS  (เลือกชื่อฟังก์ชันแล้วกด Run ในหน้า Apps Script)
 * ============================================================ */

/** สร้างแท็บ DB ล่วงหน้า และขอสิทธิ์ครั้งแรก */
function setup() {
  dbSheet_();
  Logger.log('พร้อมใช้งาน แท็บ ' + CONFIG.DB_SHEET + ' ถูกสร้างแล้ว');
}

/** นับจำนวนเอกสารในแต่ละชุดข้อมูล ดูผลที่ Execution log */
function dbStats() {
  var count = {};
  dbReadAll_().forEach(function (r) { count[r.coll] = (count[r.coll] || 0) + 1; });
  Logger.log(JSON.stringify(count));
  return count;
}
