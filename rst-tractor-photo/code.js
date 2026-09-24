/**
 * RST Yanmar Tractor Photos — Apps Script backend (bound to a Google Sheet)
 * CODE_VERSION: r03-2026-09-23-live-real-data
 *
 * Sheets (created by setup()):
 *   Movements  รายการจาก Ecount (สมุดสินค้าหมายเลข Serial/Lot) กันซ้ำด้วย uid นำเข้าไฟล์เดิมซ้ำได้
 *   Tractors   สรุปรถ 1 แถวต่อคัน สร้างใหม่ทุกครั้งที่นำเข้า (key = เลขตัวรถ)
 *   Photos     รายการรูป ไฟล์จริงอยู่ใน Google Drive โฟลเดอร์ "RST Tractor Photos/<เลขตัวรถ>"
 *   ImportLog  ประวัติการนำเข้า
 */
var CODE_VERSION = 'r03-2026-09-23-live-real-data';

var SH = { MOVES: 'Movements', TRACTORS: 'Tractors', PHOTOS: 'Photos', LOG: 'ImportLog' };
var HEAD = {
  Movements: ['uid', 'key', 'serial', 'date', 'seq', 'docRef', 'type', 'branch', 'product', 'project', 'qty', 'importedAt'],
  Tractors: ['key', 'serial', 'chassis', 'engine', 'tag', 'model', 'series', 'cond', 'origin', 'branch', 'status', 'receivedDate', 'soldDate', 'lastDate', 'updatedAt'],
  Photos: ['photoId', 'key', 'fileId', 'thumbId', 'label', 'cover', 'uploadedAt', 'uploadedBy'],
  ImportLog: ['at', 'by', 'fileName', 'rowsRead', 'rowsMatched', 'newMoves', 'dupMoves', 'tractors']
};
var PHOTO_FOLDER_NAME = 'RST Tractor Photos';

/* ================= entry ================= */
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'checkStatus') {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, codeVersion: CODE_VERSION }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('รูปรถแทรกเตอร์ยันม่าร์ RST')
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
  importMoves: importMoves, finishImport: finishImport, uploadPhoto: uploadPhoto, setCover: setCover, deletePhoto: deletePhoto
};
var WRITE = { importMoves: 1, finishImport: 1, uploadPhoto: 1, setCover: 1, deletePhoto: 1 };

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
  var s = ss_().getSheetByName(name);
  if (!s) {
    s = ss_().insertSheet(name);
    var h = HEAD[name];
    s.getRange(1, 1, s.getMaxRows(), h.length).setNumberFormat('@');
    s.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}
function readAll_(name) {
  var s = sheet_(name), n = s.getLastRow(), h = HEAD[name];
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, h.length).getDisplayValues().map(function (r) {
    var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o;
  });
}
function toRow_(name, o) { return HEAD[name].map(function (k) { return o[k] == null ? '' : String(o[k]); }); }
function writeAt_(s, start, rows) {
  if (!rows.length) return;
  var need = start + rows.length - 1 - s.getMaxRows();
  if (need > 0) s.insertRowsAfter(s.getMaxRows(), need);
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

function seriesOf_(model) {
  var x = String(model).replace(/^\(.*?\)\s*/, '');
  var m = x.match(/รุ่น\s*(.+)$/);
  x = (m ? m[1] : x).replace(/\((มือสอง|เช่า)\)/g, '').replace(/VIN.*$/i, '').replace(/^Yanmar\s*/i, '').trim();
  return x.replace(/\s*-\s*45th$/i, ' 45th').replace(/^(\d{3}[A-Z]?)$/, 'YM$1');
}
var USED_PROJ = { 'รับยึด': 1, 'รถมือ 2': 1, 'รับตีเทิร์น': 1, 'ซื้อคืน': 1, 'ขายคืนรถยึด': 1, 'ปรับสภาพมือสอง': 1 };
function condOf_(model, mv) {
  if (/สาธิต/.test(model)) return 'รถสาธิต';
  if (/เช่า/.test(model)) return 'รถเช่า';
  if (/มือสอง/.test(model)) return 'มือสอง';
  for (var i = 0; i < mv.length; i++) if (mv[i].type === 'ซื้อ' && USED_PROJ[mv[i].project]) return 'มือสอง';
  return 'รถใหม่';
}

function summarize_(moves, nowIso) {
  var by = {};
  moves.forEach(function (m) { if (m.key) (by[m.key] = by[m.key] || []).push(m); });
  return Object.keys(by).map(function (key) {
    var mv = by[key].sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : (Number(a.seq) || 0) - (Number(b.seq) || 0);
    });
    var bal = 0; mv.forEach(function (m) { bal += Number(m.qty) || 0; });
    var last = mv[mv.length - 1], buy = null, sale = null;
    for (var i = mv.length - 1; i >= 0; i--) {
      if (!buy && Number(mv[i].qty) > 0) buy = mv[i];
      if (!sale && mv[i].type === 'ขาย') sale = mv[i];
    }
    var inStock = bal > 0;
    var serial = (buy || last).serial, sp = splitSerial_(serial);
    var tag = mv.some(function (m) { return /\(\s*GPS\s*\)/i.test(m.serial); }) ? 'GPS' : '';
    var model = (buy || last).product;
    return {
      key: key, serial: serial, chassis: sp.ch, engine: sp.en, tag: tag, model: model, series: seriesOf_(model),
      cond: condOf_(model, mv), origin: buy ? buy.project : '',
      branch: (inStock ? (buy || last) : last).branch,
      status: inStock ? 'stock' : 'sold', receivedDate: buy ? buy.date : '',
      soldDate: !inStock && sale ? sale.date : '', lastDate: last.date, updatedAt: nowIso
    };
  });
}
function rebuildTractors_() {
  var list = summarize_(readAll_(SH.MOVES), new Date().toISOString());
  var s = sheet_(SH.TRACTORS), h = HEAD.Tractors;
  if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, h.length).clearContent();
  writeAt_(s, 2, list.map(function (t) { return toRow_(SH.TRACTORS, t); }));
  return list.length;
}

/* ================= API ================= */
function getBoot() {
  var photos = {};
  readAll_(SH.PHOTOS).forEach(function (p) { photos[p.key] = (photos[p.key] || 0) + 1; });
  var logs = readAll_(SH.LOG), email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { }
  return { version: CODE_VERSION, email: email, tractors: readAll_(SH.TRACTORS), photos: photos, lastImport: logs.length ? logs[logs.length - 1] : null };
}

/** rows: [{serial,date,seq,docRef,type,branch,product,project,qty}] ส่งมาทีละชุด */
function importMoves(rows) {
  return withLock_(function () {
    var s = sheet_(SH.MOVES), n = s.getLastRow(), seen = {};
    if (n > 1) s.getRange(2, 1, n - 1, 1).getDisplayValues().forEach(function (r) { seen[r[0]] = 1; });
    var now = new Date().toISOString(), out = [], dup = 0;
    (rows || []).forEach(function (m) {
      if (!m || !m.serial) return;
      var uid = [m.serial, m.docRef, m.type, m.qty, m.branch].join('|');
      if (seen[uid]) { dup++; return; }
      seen[uid] = 1;
      m.uid = uid; m.key = keyOf_(m.serial); m.importedAt = now;
      out.push(toRow_(SH.MOVES, m));
    });
    appendRows_(s, out);
    return { added: out.length, dup: dup };
  });
}
function finishImport(meta) {
  return withLock_(function () {
    var count = rebuildTractors_();
    meta = meta || {};
    appendRows_(sheet_(SH.LOG), [toRow_(SH.LOG, {
      at: new Date().toISOString(), by: who_(meta.by), fileName: meta.fileName, rowsRead: meta.rowsRead,
      rowsMatched: meta.rowsMatched, newMoves: meta.added, dupMoves: meta.dup, tractors: count
    })]);
    return { tractors: count };
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