// ═══════════════════════════════════════════════════════════════
// IT Asset Management — Apps Script Backend (RuamsinthaiGroup)
// เวอร์ชันความปลอดภัย v5 : PIN ตรวจที่ Server + Token (HMAC-SHA256)
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
    if (action === 'update') {
      var cur = findRowByKey(sheet, key);
      if (!cur) return false;
      // ห้าม staff เปลี่ยนสถานะอนุมัติ / ผู้อนุมัติ / เวลาอนุมัติ
      return String(cur.values[10]) === String(row[10]) &&
             String(cur.values[13] || '') === String(row[13] || '') &&
             String(cur.values[14] || '') === String(row[14] || '');
    }
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