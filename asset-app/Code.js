// ═══════════════════════════════════════════════════════════════
// IT Asset Management — Apps Script Backend (RuamsinthaiGroup)
// เวอร์ชันความปลอดภัย v5 : PIN ตรวจที่ Server + Token (HMAC-SHA256)
// v5.1 : ลายเซ็นเบิก/โอน/คืน บันทึกแบบต่อท้ายบน Server (trAck / trComment / trDecide / trGet)
// ───────────────────────────────────────────────────────────────
// ใช้โค้ดไฟล์นี้ชุดเดียวกันทั้ง 3 โปรเจกต์ (Asset / Ticket / Transfer)
//
// ★ ตั้งค่าครั้งแรก (ทำในแต่ละโปรเจกต์) ★
//   1) แก้ค่าใน SETUP ด้านล่าง (PIN ใหม่ + AUTH_SECRET ชุดเดียวกันทั้ง 3 โปรเจกต์)
//      และ SCRIPT_KIND ให้ตรงกับโปรเจกต์นั้น ('asset' | 'ticket' | 'transfer')
//   2) เลือกฟังก์ชัน setupSecurity แล้วกด ▶ Run (อนุญาตสิทธิ์ครั้งแรก)
//   3) ลบ PIN / SECRET ใน SETUP ออก (เหลือ '') แล้ว Save — ค่าจริงอยู่ใน Script Properties แล้ว
//   4) Deploy → Manage deployments → Edit → Version: New version → Deploy
//
// ฟังก์ชันเสริม (Run จาก Editor):
//   revokeAllSessions()  — บังคับทุกเครื่อง Logout ทันที (เช่น เมื่อเปลี่ยน PIN / มีคนลาออก)
//   unlockLogin()        — ปลดล็อกหลังกรอก PIN ผิดเกินกำหนด
//   securityStatus()     — ดูสถานะการตั้งค่า (ไม่แสดง PIN)
// ═══════════════════════════════════════════════════════════════

var SETUP = {
  SCRIPT_KIND: 'asset',          // 'asset' | 'ticket' | 'transfer'
  AUTH_SECRET: '',               // ข้อความลับยาว ≥ 32 ตัว — ต้อง "เหมือนกัน" ทั้ง 3 โปรเจกต์ (ปล่อยว่าง = สุ่มให้, แล้วคัดลอกจาก Log ไปใส่โปรเจกต์อื่น)
  PIN_ADMIN:   '',               // PIN ตัวเลข 6 หลัก
  PIN_MANAGER: '',
  PIN_STAFF:   '',
  SESSION_HOURS: 10              // อายุ Token (ชั่วโมง)
};

var PIN_LENGTH       = 6;
var MAX_FAIL_DEVICE  = 5;        // ผิดได้กี่ครั้ง / เครื่อง
var MAX_FAIL_GLOBAL  = 30;       // ผิดรวมทุกเครื่อง
var LOCK_SECONDS     = 15 * 60;  // ล็อก 15 นาที
var ROLES            = ['admin', 'manager', 'staff'];

function props() { return PropertiesService.getScriptProperties(); }

// ═══════════════════ SETUP / ADMIN (Run จาก Editor) ═══════════════════
function setupSecurity() {
  var p = props();
  if (['asset', 'ticket', 'transfer'].indexOf(SETUP.SCRIPT_KIND) < 0) throw new Error('SCRIPT_KIND ต้องเป็น asset / ticket / transfer');
  var secret = String(SETUP.AUTH_SECRET || '').trim();
  if (!secret) secret = p.getProperty('AUTH_SECRET') || (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  if (secret.length < 32) throw new Error('AUTH_SECRET ต้องยาวอย่างน้อย 32 ตัวอักษร');

  var pins = { admin: SETUP.PIN_ADMIN, manager: SETUP.PIN_MANAGER, staff: SETUP.PIN_STAFF };
  var hashes = {};
  try { hashes = JSON.parse(p.getProperty('PIN_HASHES') || '{}'); } catch (e) {}
  var salt = p.getProperty('PIN_SALT') || Utilities.getUuid();
  var seen = {};
  ROLES.forEach(function (r) {
    var pin = String(pins[r] || '').trim();
    if (!pin) { if (!hashes[r]) throw new Error('ยังไม่ได้กำหนด PIN ของ ' + r); return; }
    if (!new RegExp('^\\d{' + PIN_LENGTH + '}$').test(pin)) throw new Error('PIN ของ ' + r + ' ต้องเป็นตัวเลข ' + PIN_LENGTH + ' หลัก');
    if (/^(\d)\1+$/.test(pin) || '0123456789'.indexOf(pin) > -1 || '9876543210'.indexOf(pin) > -1) throw new Error('PIN ของ ' + r + ' เดาง่ายเกินไป');
    if (seen[pin]) throw new Error('PIN ของแต่ละบทบาทต้องไม่ซ้ำกัน');
    seen[pin] = 1;
    hashes[r] = hashPin(pin, salt);
  });

  p.setProperties({
    SCRIPT_KIND: SETUP.SCRIPT_KIND,
    AUTH_SECRET: secret,
    PIN_SALT: salt,
    PIN_HASHES: JSON.stringify(hashes),
    SESSION_HOURS: String(SETUP.SESSION_HOURS || 10),
    TOKEN_VERSION: p.getProperty('TOKEN_VERSION') || '1'
  });
  Logger.log('✓ ตั้งค่าความปลอดภัยเรียบร้อย (' + SETUP.SCRIPT_KIND + ')');
  Logger.log('AUTH_SECRET (คัดลอกไปใส่ SETUP.AUTH_SECRET ของอีก 2 โปรเจกต์): ' + secret);
  Logger.log('⚠ อย่าลืมลบ PIN / SECRET ออกจาก SETUP แล้ว Save และ Deploy New version');
}

function revokeAllSessions() {
  var v = parseInt(props().getProperty('TOKEN_VERSION') || '1', 10) + 1;
  props().setProperty('TOKEN_VERSION', String(v));
  Logger.log('✓ ยกเลิก Session ทั้งหมดแล้ว (TOKEN_VERSION=' + v + ') — ทำแบบเดียวกันในอีก 2 โปรเจกต์ด้วย');
}
function unlockLogin() {
  CacheService.getScriptCache().removeAll(['LF_GLOBAL']);
  Logger.log('✓ ปลดล็อกการ Login (ล็อกรายเครื่องจะหมดเองใน 15 นาที)');
}
function securityStatus() {
  var p = props(), h = {};
  try { h = JSON.parse(p.getProperty('PIN_HASHES') || '{}'); } catch (e) {}
  Logger.log(JSON.stringify({
    kind: p.getProperty('SCRIPT_KIND'), hasSecret: !!p.getProperty('AUTH_SECRET'),
    pins: ROLES.map(function (r) { return r + ':' + (h[r] ? 'ตั้งแล้ว' : 'ยังไม่ตั้ง'); }),
    sessionHours: p.getProperty('SESSION_HOURS'), tokenVersion: p.getProperty('TOKEN_VERSION')
  }, null, 2));
}

// ═══════════════════ CRYPTO HELPERS ═══════════════════
function b64(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function hashPin(pin, salt) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  for (var i = 0; i < 300; i++) d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d.concat(Utilities.newBlob(salt).getBytes()));
  return b64(d);
}
function hmac(data, secret) { return b64(Utilities.computeHmacSha256Signature(data, secret, Utilities.Charset.UTF_8)); }
function safeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function issueToken(role) {
  var p = props();
  var hours = parseFloat(p.getProperty('SESSION_HOURS') || '10');
  var payload = { r: role, exp: Date.now() + hours * 3600 * 1000, v: p.getProperty('TOKEN_VERSION') || '1', n: Utilities.getUuid().slice(0, 8) };
  var body = b64(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  return { token: body + '.' + hmac(body, p.getProperty('AUTH_SECRET')), exp: payload.exp };
}

// คืนค่า role ถ้า token ถูกต้อง, ไม่งั้น null
function verifyToken(token) {
  var p = props(), secret = p.getProperty('AUTH_SECRET');
  if (!secret || !token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2 || !safeEq(hmac(parts[0], secret), parts[1])) return null;
  try {
    var pl = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0] + '===='.slice((parts[0].length % 4) || 4))).getDataAsString());
    if (!pl || ROLES.indexOf(pl.r) < 0) return null;
    if (Date.now() > pl.exp) return null;
    if (String(pl.v) !== String(p.getProperty('TOKEN_VERSION') || '1')) return null;
    return pl.r;
  } catch (e) { return null; }
}

// ═══════════════════ LOGIN + RATE LIMIT ═══════════════════
function handleLogin(param, cb) {
  var p = props(), cache = CacheService.getScriptCache();
  if (!p.getProperty('AUTH_SECRET') || !p.getProperty('PIN_HASHES')) {
    return out({ status: 'error', code: 'not_setup', msg: 'Server ยังไม่ได้ตั้งค่าความปลอดภัย (Run setupSecurity)' }, cb);
  }
  var dev = String(param.dev || 'unknown').replace(/[^\w-]/g, '').slice(0, 40) || 'unknown';
  var kDev = 'LF_' + dev;
  var fDev = parseInt(cache.get(kDev) || '0', 10), fAll = parseInt(cache.get('LF_GLOBAL') || '0', 10);
  if (fDev >= MAX_FAIL_DEVICE || fAll >= MAX_FAIL_GLOBAL) {
    return out({ status: 'error', code: 'locked', msg: 'กรอก PIN ผิดหลายครั้ง — ระบบล็อกชั่วคราว 15 นาที' }, cb);
  }
  var pin = String(param.pin || '');
  var hashes = JSON.parse(p.getProperty('PIN_HASHES'));
  var h = hashPin(pin, p.getProperty('PIN_SALT'));
  var role = null;
  ROLES.forEach(function (r) { if (hashes[r] && safeEq(hashes[r], h)) role = r; });

  if (!role) {
    cache.put(kDev, String(fDev + 1), LOCK_SECONDS);
    cache.put('LF_GLOBAL', String(fAll + 1), LOCK_SECONDS);
    Utilities.sleep(600);   // หน่วงเวลา กันเดารัว ๆ
    return out({ status: 'error', code: 'bad_pin', msg: 'PIN ไม่ถูกต้อง', left: Math.max(0, MAX_FAIL_DEVICE - fDev - 1) }, cb);
  }
  cache.remove(kDev);
  var t = issueToken(role);
  return out({ status: 'ok', role: role, token: t.token, exp: t.exp }, cb);
}

// ═══════════════════ PERMISSIONS ═══════════════════
// asset  : เพิ่ม/แก้/ลบ ทรัพย์สิน = admin, manager
// ticket : แจ้งซ่อม (add) = ทุกบทบาท · แก้/ลบ = admin, manager
// transfer: สร้าง/แก้ (ลงนามรับทราบ) = ทุกบทบาท · เปลี่ยนสถานะอนุมัติ / ลบ = admin, manager
function sheetKind(sheetName) {
  if (/transfer|โอน|เบิก/i.test(sheetName)) return 'transfer';
  return props().getProperty('SCRIPT_KIND') || 'asset';
}
function isMgr(role) { return role === 'admin' || role === 'manager'; }
function checkWrite(role, action, sheet, row, key) {
  var kind = sheetKind(sheet.getName());
  if (action === 'delete') return isMgr(role);
  if (isMgr(role)) return true;
  // staff
  if (kind === 'asset') return false;
  if (kind === 'ticket') return action === 'add';
  if (kind === 'transfer') {
    if (action === 'add') return String(row[10] || 'pending') === 'pending';  // สร้างใหม่ต้องเป็น "รออนุมัติ"
    // staff แก้ได้ แต่ Server จะคงค่า สถานะ / ผู้อนุมัติ / เวลาอนุมัติ เดิมไว้เสมอ (ดู mergeTransferRow)
    if (action === 'update') return !!findRowByKey(sheet, key);
  }
  return false;
}
function findRowByKey(sheet, key) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var keys = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = keys.length - 1; i >= 0; i--) {
    if (String(keys[i][0]) === String(key)) {
      return { row: i + 2, values: sheet.getRange(i + 2, 1, 1, sheet.getLastColumn()).getValues()[0] };
    }
  }
  return null;
}

// ═══════════════════ ENTRY POINTS ═══════════════════
function doGet(e) { return main(e); }

function doPost(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      var contents = e.postData.contents;
      if (contents.indexOf('"events"') > -1 || contents.indexOf('destination') > -1) return lineWebhook(e);
    }
    return main(e);
  } catch (err) {
    return ContentService.createTextOutput('OK');
  }
}

function main(e) {
  var param = e && e.parameter ? e.parameter : {};
  // ชื่อ callback ของ JSONP ต้องเป็นชื่อฟังก์ชันเท่านั้น (กันฝังสคริปต์)
  var cb = /^[A-Za-z_$][\w$]{0,63}$/.test(param.cb || '') ? param.cb : '';
  try {
    var action = param.action || '';

    if (action === 'ping')  return out({ status: 'ok', msg: 'alive', secured: !!props().getProperty('AUTH_SECRET') }, cb);
    if (action === 'login') return handleLogin(param, cb);

    // ── ทุกคำสั่งหลังจากนี้ต้องมี Token ที่ถูกต้อง ──
    var role = verifyToken(param.token);
    if (!role) return out({ status: 'error', code: 'auth', msg: 'กรุณาเข้าสู่ระบบใหม่ (Session หมดอายุหรือไม่ถูกต้อง)' }, cb);

    if (action === 'whoami') return out({ status: 'ok', role: role }, cb);

    if (action === 'test') {
      var names = SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); });
      return out({ status: 'ok', msg: 'connected', sheets: names, role: role }, cb);
    }

    if (action.indexOf('line') === 0) return handleLine(action, param, cb, role);

    var sheetName = param.sheet || '';
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getActiveSheet();
    if (!sheet) return out({ status: 'error', msg: 'Sheet not found: ' + sheetName }, cb);

    // ── ใบเบิก/โอน: ลงนาม / ความเห็น / อนุมัติ แบบ "ต่อท้าย" บน Server (ลายเซ็นไม่หาย ไม่ทับกัน) ──
    if (action === 'trGet' || action === 'trAck' || action === 'trComment' || action === 'trDecide') {
      return out(handleTransferOp(action, param, role, sheet), cb);
    }

    if (action === 'getAll') {
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return out({ status: 'ok', rows: [] }, cb);
      var lastCol = Math.max(sheet.getLastColumn(), 1);
      var vals = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      var rows = [];
      for (var i = 0; i < vals.length; i++) {
        var first = vals[i][0];
        if (first !== '' && first !== null && first !== undefined) rows.push(vals[i]);
      }
      return out({ status: 'ok', rows: rows }, cb);
    }

    if (action === 'add' || action === 'update' || action === 'delete') {
      var key = String(param.key || '');
      var row = action === 'delete' ? [] : JSON.parse(param.row || '[]').map(function (v) { return v === null || v === undefined ? '' : v; });
      if (action !== 'delete' && !row.length) return out({ status: 'error', msg: 'empty row' }, cb);
      if (action === 'add') key = String(row[0]);

      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        if (!checkWrite(role, action, sheet, row, key)) {
          return out({ status: 'error', code: 'forbidden', msg: 'สิทธิ์ของคุณ (' + role + ') ทำรายการนี้ไม่ได้' }, cb);
        }
        var found = findRowByKey(sheet, key);

        if (action === 'add') {
          var target = found ? found.row : sheet.getLastRow() + 1;   // Sync ซ้ำ → เขียนทับแถวเดิม
          sheet.getRange(target, 1, 1, Math.min(2, row.length)).setNumberFormat('@');
          sheet.getRange(target, 1, 1, row.length).setValues([row]);
        } else if (action === 'update') {
          if (!found) return out({ status: 'error', msg: 'key not found: ' + key }, cb);
          if (sheetKind(sheet.getName()) === 'transfer') row = mergeTransferRow(found.values, row, role, param.replaceAcks === '1');
          sheet.getRange(found.row, 1, 1, row.length).setValues([row]);
        } else {
          if (!found) return out({ status: 'error', msg: 'key not found: ' + key }, cb);
          sheet.deleteRow(found.row);
        }
        SpreadsheetApp.flush();
      } finally {
        lock.releaseLock();
      }
      return out({ status: 'ok' }, cb);
    }

    return out({ status: 'error', msg: 'unknown action: ' + action }, cb);
  } catch (err) {
    return out({ status: 'error', msg: err.message || String(err) }, cb);
  }
}

// ═══════════════════ TRANSFER: ลายเซ็น / ความเห็น / อนุมัติ ═══════════════════
// คอลัมน์: K(10) status | L(11) updated | M(12) comments | N(13) decidedBy | O(14) decidedAt | P(15) acks
var TR_APPROVER_ROLES = ['ผู้อนุมัติ', 'ผู้อนุมัติเบิก'];   // ลายเซ็นบทบาทนี้ต้องเป็น admin / manager
var TR_CELL_MAX = 49000;                                   // ขีดจำกัดเซลล์ Google Sheets = 50,000 ตัวอักษร

function trParse(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  try { var x = JSON.parse(String(v)); return Array.isArray(x) ? x : []; } catch (e) { return []; }
}
function trItemKey(x) {
  return [x.at || '', x.name || x.by || '', x.role || '', x.kind || ''].map(String).join('|');
}
// รวมรายการ 2 ชุด (ไม่ซ้ำ) เรียงตามเวลา
function trMerge(a, b) {
  var seen = {}, res = [];
  a.concat(b).forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    var k = trItemKey(x);
    if (seen[k]) return;
    seen[k] = 1; res.push(x);
  });
  res.sort(function (p, q) { return String(p.at || '') < String(q.at || '') ? -1 : String(p.at || '') > String(q.at || '') ? 1 : 0; });
  return res;
}
function trIso(v) {
  if (v instanceof Date) return v.toISOString();
  return v === null || v === undefined ? '' : String(v);
}
// เวลาที่ Client ส่งมา (ใช้ได้ถ้าห่างจากเวลา Server ไม่เกิน 2 วัน — ใช้เป็น key กันซ้ำ)
function trAt(v) {
  var d = new Date(String(v || ''));
  if (isNaN(d.getTime()) || Math.abs(d.getTime() - Date.now()) > 2 * 864e5) d = new Date();
  return d.toISOString();
}
function trCleanAck(raw, role) {
  var a = raw;
  if (typeof raw === 'string') { try { a = JSON.parse(raw); } catch (e) { a = null; } }
  if (!a || typeof a !== 'object') throw new Error('ข้อมูลลายเซ็นไม่ถูกต้อง');
  var name = String(a.name || '').trim().slice(0, 120);
  var r = String(a.role || '').trim().slice(0, 60);
  var sig = String(a.sig || '');
  if (!name) throw new Error('กรุณาระบุชื่อผู้ลงนาม');
  if (!r) throw new Error('กรุณาระบุบทบาทผู้ลงนาม');
  if (!sig || sig.length > 9000 || !/^[MLml0-9 .,\-]+$/.test(sig)) throw new Error('ลายเซ็นไม่ถูกต้องหรือยาวเกินไป');
  if (TR_APPROVER_ROLES.indexOf(r) > -1 && !isMgr(role)) {
    var e = new Error('ลายเซ็นในฐานะ "' + r + '" ต้องเข้าสู่ระบบด้วยสิทธิ์ผู้จัดการ/แอดมิน'); e.code = 'forbidden'; throw e;
  }
  return { name: name, role: r, at: trAt(a.at), sig: sig, sys: role };   // sys = สิทธิ์ที่ใช้ลงนามจริง (ตรวจจาก Token)
}

// ใช้ตอน update ทั้งแถว: รวมความเห็น/ลายเซ็นกับของเดิม และกัน staff เปลี่ยนผลอนุมัติ
function mergeTransferRow(cur, row, role, replaceAcks) {
  row = row.slice();
  while (row.length < 16) row.push('');
  row[12] = JSON.stringify(trMerge(trParse(cur[12]), trParse(row[12])));
  if (!(replaceAcks && isMgr(role))) row[15] = JSON.stringify(trMerge(trParse(cur[15]), trParse(row[15])));
  if (!isMgr(role)) { row[10] = cur[10]; row[13] = cur[13]; row[14] = trIso(cur[14]); }
  return row;
}

function handleTransferOp(action, param, role, sheet) {
  if (sheetKind(sheet.getName()) !== 'transfer') return { status: 'error', msg: 'ชีตนี้ไม่ใช่ชีตเบิก/โอน' };
  var key = String(param.key || '');
  if (!key) return { status: 'error', msg: 'missing key' };

  if (action === 'trGet') {
    var f0 = findRowByKey(sheet, key);
    if (!f0) return { status: 'error', msg: 'key not found: ' + key };
    return { status: 'ok', row: f0.values.map(trIso) };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var f = findRowByKey(sheet, key);
    if (!f) return { status: 'error', msg: 'key not found: ' + key };
    var v = f.values.map(trIso);
    while (v.length < 16) v.push('');
    var comments = trParse(v[12]), acks = trParse(v[15]);

    try {
      if (action === 'trAck') {
        acks = trMerge(acks, [trCleanAck(param.ack, role)]);
      } else if (action === 'trComment') {
        var c = {};
        try { c = JSON.parse(param.c || '{}'); } catch (e) {}
        var text = String(c.text || '').trim().slice(0, 2000), by = String(c.by || '').trim().slice(0, 120);
        if (!text || !by) return { status: 'error', msg: 'ข้อมูลความเห็นไม่ครบ' };
        comments = trMerge(comments, [{ by: by, role: String(c.role || '').slice(0, 60), at: trAt(c.at), text: text, kind: 'comment' }]);
      } else if (action === 'trDecide') {
        if (!isMgr(role)) return { status: 'error', code: 'forbidden', msg: 'เฉพาะผู้จัดการ/แอดมินเท่านั้นที่อนุมัติได้' };
        var st = String(param.st || '');
        if (st !== 'approved' && st !== 'rejected') return { status: 'error', msg: 'สถานะไม่ถูกต้อง' };
        var dby = String(param.by || '').trim().slice(0, 120);
        if (!dby) return { status: 'error', msg: 'กรุณาระบุชื่อผู้อนุมัติ' };
        var at = trAt(param.at);
        var dtext = String(param.text || '').trim().slice(0, 2000) || (st === 'approved' ? 'อนุมัติ' : 'ไม่อนุมัติ');
        if (st === 'rejected' && !String(param.text || '').trim()) return { status: 'error', msg: 'กรุณาระบุเหตุผลที่ไม่อนุมัติ' };
        v[10] = st; v[13] = dby; v[14] = at;
        comments = trMerge(comments, [{ by: dby, role: String(param.roleLabel || '').slice(0, 60), at: at, text: dtext, kind: st === 'approved' ? 'approve' : 'reject' }]);
        if (param.ack) acks = trMerge(acks, [trCleanAck(param.ack, role)]);
      }
    } catch (err) {
      return { status: 'error', code: err.code || '', msg: err.message || String(err) };
    }

    var jc = JSON.stringify(comments), ja = JSON.stringify(acks);
    if (ja.length > TR_CELL_MAX || jc.length > TR_CELL_MAX) return { status: 'error', msg: 'พื้นที่เก็บลายเซ็น/ความเห็นของใบนี้เต็มแล้ว' };
    v[11] = new Date().toLocaleDateString('th-TH');
    v[12] = jc; v[15] = ja;
    var rg = sheet.getRange(f.row, 11, 1, 6);          // K..P
    rg.setNumberFormat('@');                            // เก็บเป็นข้อความ (กัน Sheets แปลงเวลาเป็น Date)
    rg.setValues([[v[10], v[11], v[12], v[13], v[14], v[15]]]);
    SpreadsheetApp.flush();
    return { status: 'ok', row: v };
  } finally {
    lock.releaseLock();
  }
}

function out(obj, cb) {
  var json = JSON.stringify(obj);
  var body = cb ? cb + '(' + json + ')' : json;
  var mime = cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON;
  return ContentService.createTextOutput(body).setMimeType(mime);
}

// ═══════════════════════════════════════════════════
// LINE Messaging API — IT Asset (RuamsinthaiGroup)
// ═══════════════════════════════════════════════════
var LINE_DEFAULT_EVENTS = { ticket: true, close: true, asset: true, transfer: false };
var APP_URL = 'https://itmanager-rst.github.io/Rst_It_Report/asset-app/index.html';

function lineProps() { return props(); }

function lineGetConfig() {
  var p = lineProps();
  var events = LINE_DEFAULT_EVENTS;
  try { events = JSON.parse(p.getProperty('LINE_EVENTS') || 'null') || LINE_DEFAULT_EVENTS; } catch (err) {}
  var targets = String(p.getProperty('LINE_TARGETS') || '').split(/[\s,;]+/).filter(function (x) { return x; });
  return { token: p.getProperty('LINE_TOKEN') || '', targets: targets, events: events };
}

function linePush(token, to, text) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  return { ok: code === 200, code: code, body: code === 200 ? '' : res.getContentText().slice(0, 300) };
}

function linePushAll(token, targets, text) {
  var sent = 0, errors = [];
  targets.forEach(function (to) {
    try {
      var r = linePush(token, to, text);
      if (r.ok) sent++; else errors.push(to.slice(0, 6) + '…: HTTP ' + r.code + ' ' + r.body);
    } catch (err) { errors.push(to.slice(0, 6) + '…: ' + err.message); }
  });
  return { status: errors.length ? (sent ? 'partial' : 'error') : 'ok', sent: sent, failed: errors.length, errors: errors };
}

function lineReply(token, replyToken, text) {
  if (!token || !replyToken) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
}

function handleLine(action, p, cb, role) {
  var pr = lineProps();
  var cfg = lineGetConfig();

  if (action === 'lineStatus') {
    var res = { status: 'ok', configured: !!(cfg.token && cfg.targets.length), events: cfg.events };
    if (role === 'admin') {   // รายละเอียดผู้รับแสดงเฉพาะ Admin
      res.hasToken = !!cfg.token;
      res.tokenHint = cfg.token ? '••••' + cfg.token.slice(-4) : '';
      res.targets = cfg.targets;
      res.hasAdminKey = true;
      res.lastSource = pr.getProperty('LINE_LAST_SOURCE') || '';
    }
    return out(res, cb);
  }

  if (action === 'lineSetConfig') {
    if (role !== 'admin') return out({ status: 'error', code: 'forbidden', msg: 'เฉพาะ IT Admin เท่านั้น' }, cb);
    if (p.token) pr.setProperty('LINE_TOKEN', String(p.token).trim());
    if (p.targets !== undefined) pr.setProperty('LINE_TARGETS', String(p.targets));
    if (p.events) { try { pr.setProperty('LINE_EVENTS', JSON.stringify(JSON.parse(p.events))); } catch (err) {} }
    return out({ status: 'ok', msg: 'saved' }, cb);
  }

  if (action === 'lineNotify') {
    if (!cfg.token || !cfg.targets.length) return out({ status: 'error', msg: 'not_configured' }, cb);
    var ev = String(p.event || '');
    if (ev && cfg.events[ev] === false) return out({ status: 'skipped', msg: 'ปิดแจ้งเตือนประเภท ' + ev }, cb);
    if (!p.msg) return out({ status: 'error', msg: 'empty message' }, cb);
    // กันส่งรัว: ไม่เกิน 30 ข้อความ / 10 นาที
    var c = CacheService.getScriptCache(), n = parseInt(c.get('LINE_RATE') || '0', 10);
    if (n >= 30) return out({ status: 'error', msg: 'ส่งแจ้งเตือนถี่เกินไป ลองใหม่ภายหลัง' }, cb);
    c.put('LINE_RATE', String(n + 1), 600);
    var text = String(p.msg).slice(0, 4400) + '\n\n🔗 เข้าสู่ระบบเพื่อตรวจสอบ/อนุมัติ:\n' + APP_URL;
    return out(linePushAll(cfg.token, cfg.targets, text), cb);
  }

  return out({ status: 'error', msg: 'unknown line action: ' + action }, cb);
}

// ── Webhook จาก LINE: ตอบรับ HTTP 200 ทุกกรณี ──
function lineWebhook(e) {
  var cfg = lineGetConfig();
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  if (body.events && Array.isArray(body.events)) {
    body.events.forEach(function (ev) {
      var src = ev.source || {};
      var id = src.groupId || src.roomId || src.userId;
      if (!id) return;
      lineProps().setProperty('LINE_LAST_SOURCE', id + '|' + (src.type || '') + '|' + new Date().toISOString());
      var txt = ev.message && ev.message.type === 'text' ? String(ev.message.text).trim().toLowerCase() : '';
      if (ev.type === 'join' || ev.type === 'follow' || txt === 'id' || txt === 'ไอดี') {
        lineReply(cfg.token, ev.replyToken, 'ID สำหรับรับแจ้งเตือน IT Asset:\n' + id + '\n\nนำไปใส่ในหน้า ตั้งค่า → แจ้งเตือน LINE');
      }
    });
  }
  return ContentService.createTextOutput('OK');
}