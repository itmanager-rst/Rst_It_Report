/**
 * RST Tractor & Harvester Photos — Apps Script backend (bound to a Google Sheet)
 * CODE_VERSION: r06-2026-09-25-used-and-demo
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
 *   (ชีต Movements จากเวอร์ชันก่อน r04 ไม่ใช้แล้ว ลบทิ้งได้)
 */
var CODE_VERSION = 'r06-2026-09-25-used-and-demo';

var SH = { TRACTORS: 'Tractors', PHOTOS: 'Photos', LOG: 'ImportLog' };
var HEAD = {
  Tractors: ['key', 'serial', 'chassis', 'engine', 'tag', 'code', 'name', 'series', 'type', 'kind', 'branch', 'spot', 'qty', 'price', 'cond', 'hours', 'status', 'firstSeen', 'lastSeen', 'outDate', 'updatedAt'],
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
    .setTitle('RST รูปรถแทรกเตอร์ · รถเกี่ยวข้าว มือสอง · รถสาธิต')
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
  importStock: importStock, uploadPhoto: uploadPhoto, setCover: setCover, deletePhoto: deletePhoto
};
var WRITE = { importStock: 1, uploadPhoto: 1, setCover: 1, deletePhoto: 1 };

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

function seriesOf_(name) {
  var x = String(name).replace(/^\(.*?\)\s*/, '');
  var m = x.match(/รุ่น\s*(.+)$/);
  x = (m ? m[1] : x).replace(/\((?:รถ)?(มือสอง|เช่า|สาธิต)\)/g, '').replace(/(?:รถ)?สาธิต/g, '').replace(/VIN.*$/i, '').replace(/^Yanmar\s*/i, '').trim();
  return x.replace(/\s*-\s*45th$/i, ' 45th').replace(/^(\d{3}[A-Z]?)$/, 'YM$1');
}
/** ประเภทรถ: เก็บเฉพาะ 2 ประเภทนี้ */
function typeOf_(name) {
  var n = String(name || '');
  if (/รถเกี่ยว/.test(n)) return 'รถเกี่ยวข้าว';
  if (/รถแทรกเตอร์/.test(n)) return 'รถแทรกเตอร์';
  return '';
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
function num_(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
function numStr_(v) { var t = String(v == null ? '' : v).replace(/,/g, '').trim(); return t === '' || isNaN(parseFloat(t)) ? '' : String(parseFloat(t)); }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }

/** แปลงแถว Tractors (รวมรูปแบบเก่า r03) ให้มีฟิลด์ครบตาม HEAD.Tractors */
function normCar_(o) {
  if (!o.name && o.model) { // r03: model/cond(รถใหม่/มือสอง)/receivedDate/soldDate
    o.name = o.model; o.kind = o.cond || kindOf_(o.model); o.cond = '';
    o.firstSeen = o.receivedDate || ''; o.outDate = o.soldDate || '';
    o.status = o.status === 'stock' ? 'stock' : 'out';
  }
  if (!o.type) o.type = typeOf_(o.name);
  if (!o.kind) o.kind = kindOf_(o.name);
  if (!o.series) o.series = seriesOf_(o.name);
  var c = {}; HEAD.Tractors.forEach(function (k) { c[k] = o[k] == null ? '' : String(o[k]); });
  return c;
}

/* ================= API ================= */
function getBoot() {
  var photos = {};
  readAll_(SH.PHOTOS).forEach(function (p) { photos[p.key] = (photos[p.key] || 0) + 1; });
  var logs = readAll_(SH.LOG), email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { }
  var cars = readAll_(SH.TRACTORS).map(normCar_).filter(function (c) { return c.key && c.type && isKeptKind_(c.kind); });
  return { version: CODE_VERSION, email: email, tractors: cars, photos: photos, lastImport: logs.length ? logs[logs.length - 1] : null };
}

/**
 * rows: [{branch,spot,code,name,serial,gps,qty,price,cond,hours}] ทั้งไฟล์ในครั้งเดียว (เฉพาะรถแทรกเตอร์/รถเกี่ยวข้าว)
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
      if (!r || !r.serial || !typeOf_(r.name) || !isKept_(r.name)) return;
      var key = keyOf_(r.serial); if (!key) return;
      matched++;
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(r);
    });

    var out = [], fresh = 0, dupRows = 0, gone = 0, FILL = ['branch', 'spot', 'code', 'price', 'cond', 'hours', 'gps'];
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
        code: r.code, name: r.name, series: seriesOf_(r.name), type: typeOf_(r.name), kind: kindOf_(r.name),
        branch: r.branch, spot: r.spot, qty: String(qty), price: numStr_(r.price), cond: String(r.cond || '').trim(),
        hours: numStr_(r.hours), status: inStock ? 'stock' : 'out',
        firstSeen: (prev && prev.firstSeen) || today, lastSeen: today,
        outDate: inStock ? '' : ((prev && prev.status === 'out' && prev.outDate) || today), updatedAt: now
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