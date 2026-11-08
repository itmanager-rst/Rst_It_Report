// ═══════════════════════════════════════════════════════════════
// IT Asset Management — Apps Script Backend (RuamsinthaiGroup)
// เวอร์ชันความปลอดภัย v5 : PIN ตรวจที่ Server + Token (HMAC-SHA256)
// v5.1 : ลายเซ็นเบิก/โอน/คืน บันทึกแบบต่อท้ายบน Server (trAck / trComment / trDecide / trGet)
// v5.3 : เชื่อม SiteAsset-Tracker — อนุมัติ/ไม่อนุมัติใบคืนจากสาขา อัปเดตชีตสาขาอัตโนมัติ (siteSyncDecision_)
// v5.4 : KPI รายเดือน (IT) — คำนวณจาก Ticket + ส่งเข้า Rst-Kpi-Mtd อัตโนมัติทุกต้นเดือน (handleKpi_ / kpiMonthlyJob)
//        หลังวางโค้ดในโปรเจกต์ Ticket ให้ Run kpiSetup 1 ครั้ง (อนุญาตสิทธิ์ ScriptApp + เปิดไฟล์ KPI)
// v5.2 : อ่าน/เขียนไฟล์ใน SHEET_FILES โดยตรง (IT Assets / IT Tickets / IT Transfers) — หลังวางโค้ดให้ Run checkFiles 1 ครั้ง
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

// ── ไฟล์ Google Sheets ที่ใช้จริง (โฟลเดอร์ Drive: it report / asset-app) ──
// ทุกโปรเจกต์อ่าน/เขียนไฟล์เหล่านี้โดยตรง ไม่ขึ้นกับว่าสคริปต์ผูกอยู่กับไฟล์ไหน
var SHEET_FILES = {
  asset:    '14GL3BP6oYWtp5ewE-Z8tOVvY2pT2Jyl19B2-0Ip9th0',   // IT Assets
  ticket:   '1C4__MYNtzIohekmbm6xMVoRnYCEl4f34SVgyC3_zDbU',   // IT Tickets
  transfer: '1YhRbb3mTJmeWcy6H9vubv_oLpcryFa-gwcfzuFgbOd8'    // IT Transfers
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
// เลือกไฟล์ตามชื่อชีตที่ขอ (ถ้าไม่ระบุ ใช้ตาม SCRIPT_KIND ของโปรเจกต์)
function kindOfSheetName(name) {
  name = String(name || '');
  if (/transfer|โอน|เบิก/i.test(name)) return 'transfer';
  if (/ticket/i.test(name)) return 'ticket';
  if (name) return 'asset';
  return props().getProperty('SCRIPT_KIND') || SETUP.SCRIPT_KIND || 'asset';
}
var _ssCache = {};
function getSS(kind) {
  kind = SHEET_FILES[kind] ? kind : 'asset';
  if (!_ssCache[kind]) _ssCache[kind] = SpreadsheetApp.openById(SHEET_FILES[kind]);
  return _ssCache[kind];
}
// Run จาก Editor ครั้งแรกหลังวางโค้ด (เพื่ออนุญาตสิทธิ์เปิดไฟล์) — แสดงชื่อไฟล์และจำนวนแถวของแต่ละชีต
function checkFiles() {
  Object.keys(SHEET_FILES).forEach(function (k) {
    var ss = getSS(k);
    Logger.log(k + ' → ' + ss.getName() + ' : ' + ss.getSheets().map(function (sh) { return sh.getName() + ' (' + Math.max(sh.getLastRow() - 1, 0) + ' แถว)'; }).join(', '));
  });
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
      var names = getSS(kindOfSheetName(param.sheet)).getSheets().map(function (s) { return s.getName(); });
      return out({ status: 'ok', msg: 'connected', sheets: names, role: role }, cb);
    }

    if (action.indexOf('line') === 0) return handleLine(action, param, cb, role);
    if (action.indexOf('kpi') === 0) return out(handleKpi_(action, param, role), cb);

    var sheetName = param.sheet || '';
    var ss = getSS(kindOfSheetName(sheetName));
    var sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getSheets()[0];
    if (!sheet) return out({ status: 'error', msg: 'Sheet not found: ' + sheetName }, cb);

    // ── ใบเบิก/โอน: ลงนาม / ความเห็น / อนุมัติ แบบ "ต่อท้าย" บน Server (ลายเซ็นไม่หาย ไม่ทับกัน) ──
    if (action === 'trGet' || action === 'trAck' || action === 'trComment' || action === 'trDecide') {
      return out(handleTransferOp(action, param, role, sheet), cb);
    }

    // ── ย้ายข้อมูล (Admin เท่านั้น): ส่งแถวเป็นชิ้น ๆ เพื่อไม่ให้ URL ยาวเกิน แล้วประกอบที่ Server ──
    if (action === 'importChunk') {
      if (role !== 'admin') return out({ status: 'error', code: 'forbidden', msg: 'เฉพาะ IT Admin เท่านั้น' }, cb);
      return out(handleImportChunk(param, sheet), cb);
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
          if (sheetKind(sheet.getName()) === 'transfer' && String(found.values[10]) !== String(row[10])) {
            var vv = row.slice(); while (vv.length < 21) vv.push(''); vv[20] = found.values[20];
            siteSyncDecision_(sheet, found.row, vv);
          }
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

// ═══════════════════ เชื่อมกับ SiteAsset-Tracker (ใบคืนที่สาขาแจ้งเข้ามา) ═══════════════════
// ใบคืนจากสาขามีข้อมูลต้นทางในคอลัมน์ U (JSON: app='site', assetId, origId, fromBranch, qty ...)
// เมื่อสำนักงานใหญ่ "อนุมัติ" → ชีตสาขาเปลี่ยนสถานะเป็น "รับคืนแล้ว"
// เมื่อ "ไม่อนุมัติ" → คืนสาขาเดิม / รวมจำนวนกลับแถวเดิม (กรณีแจ้งคืนบางส่วน)
var SITE_SYNC = {
  FILE_ID: '1J8W9s20WIwSOnteSyVg-OywoXqycKKbp578hoE4nhLU',   // ระบบบันทึกสินทรัพย์สาขา
  SHEET: 'Assets', HQ: 'สำนักงานใหญ่',
  ST_DONE: 'รับคืนแล้ว', ST_BACK: 'ปกติ'
};
function siteSyncDecision_(trSheet, rowNum, v) {
  var src;
  try { src = JSON.parse(String(v[20] || '')); } catch (e) { return; }
  if (!src || src.app !== 'site') return;
  var st = String(v[10]);
  if ((st !== 'approved' && st !== 'rejected') || src.done === st) return;
  try {
    var sh = SpreadsheetApp.openById(SITE_SYNC.FILE_ID).getSheetByName(SITE_SYNC.SHEET);
    var data = sh.getDataRange().getValues(), H = {};
    data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
    var find = function (id) { for (var i = 1; i < data.length; i++) if (String(data[i][H.assetId]) === String(id)) return i; return -1; };
    var r = find(src.assetId);
    var stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
    var who = String(v[13] || '');
    var addNote = function (row, txt) {
      if (H.note === undefined) return;
      var old = String(data[row][H.note] || '').trim();
      sh.getRange(row + 1, H.note + 1).setValue(old ? old + '\n' + txt : txt);
    };
    if (r < 0) { src.done = st; src.err = 'ไม่พบรายการ ' + src.assetId + ' ในชีตสาขา'; }
    else if (st === 'approved') {
      sh.getRange(r + 1, H.branch + 1).setValue(SITE_SYNC.HQ);
      sh.getRange(r + 1, H.status + 1).setValue(SITE_SYNC.ST_DONE);
      addNote(r, '[สนญ. รับคืนแล้ว ' + stamp + ' โดย ' + who + ' · ใบ ' + v[1] + ']');
      src.done = st;
    } else {   // rejected
      var o = src.origId && src.origId !== src.assetId ? find(src.origId) : -1;
      if (o > -1) {   // แจ้งคืนบางส่วน → รวมจำนวนกลับแถวเดิม แล้วลบแถวที่แยกออกมา
        var q = (parseInt(data[o][H.quantity], 10) || 0) + (parseInt(data[r][H.quantity], 10) || 0);
        sh.getRange(o + 1, H.quantity + 1).setValue(q);
        addNote(o, '[สนญ. ไม่อนุมัติการคืน ' + stamp + ' · ใบ ' + v[1] + ']');
        sh.deleteRow(r + 1);
      } else {
        sh.getRange(r + 1, H.branch + 1).setValue(src.fromBranch || '');
        sh.getRange(r + 1, H.status + 1).setValue(SITE_SYNC.ST_BACK);
        addNote(r, '[สนญ. ไม่อนุมัติการคืน ' + stamp + ' · ใบ ' + v[1] + ']');
      }
      src.done = st;
    }
    SpreadsheetApp.flush();
  } catch (err) {
    src.err = err.message || String(err);
  }
  v[20] = JSON.stringify(src);
  trSheet.getRange(rowNum, 21).setNumberFormat('@').setValue(v[20]);
}

// ═══════════════════ IMPORT (ย้ายข้อมูลจากระบบเดิม) ═══════════════════
// param: id (รหัสงาน), i (ลำดับชิ้น 0..n-1), n (จำนวนชิ้น), part (ข้อความ), mode ('missing' = เพิ่มเฉพาะที่ยังไม่มี | 'overwrite')
function handleImportChunk(param, sheet) {
  var id = String(param.id || '').replace(/[^\w-]/g, '').slice(0, 40);
  var i = parseInt(param.i, 10), n = parseInt(param.n, 10);
  if (!id || isNaN(i) || isNaN(n) || n < 1 || n > 60 || i < 0 || i >= n) return { status: 'error', msg: 'bad chunk' };
  var cache = CacheService.getScriptCache();
  cache.put('IMP_' + id + '_' + i, String(param.part || ''), 900);
  if (i < n - 1) return { status: 'ok', partial: true };
  var keys = [], parts;
  for (var k = 0; k < n; k++) keys.push('IMP_' + id + '_' + k);
  parts = cache.getAll(keys);
  var json = '';
  for (var k2 = 0; k2 < n; k2++) {
    if (parts[keys[k2]] === undefined || parts[keys[k2]] === null) return { status: 'error', msg: 'missing chunk ' + k2 };
    json += parts[keys[k2]];
  }
  cache.removeAll(keys);
  var row;
  try { row = JSON.parse(json); } catch (e) { return { status: 'error', msg: 'bad json' }; }
  if (!Array.isArray(row) || !row.length || !String(row[0] || '').trim()) return { status: 'error', msg: 'empty row' };
  row = row.map(function (v) { return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v); });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findRowByKey(sheet, row[0]);
    if (found && param.mode !== 'overwrite') return { status: 'ok', skipped: true };
    var target = found ? found.row : sheet.getLastRow() + 1;
    sheet.getRange(target, 1, 1, Math.min(2, row.length)).setNumberFormat('@');
    if (sheetKind(sheet.getName()) === 'transfer' && row.length > 15) sheet.getRange(target, 11, 1, 6).setNumberFormat('@');
    sheet.getRange(target, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();
    return { status: 'ok', written: true, row: target };
  } finally { lock.releaseLock(); }
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
    if (action === 'trDecide') siteSyncDecision_(sheet, f.row, v);
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
// ═══════════════════════════════════════════════════════════════
// KPI รายเดือน (IT) → Rst-Kpi-Mtd   (v5.4)
// ───────────────────────────────────────────────────────────────
// • รายการหัวข้อ KPI เก็บในชีต "KPI Config" (ไฟล์ IT Tickets) — เพิ่ม/แก้/ลบได้จากหน้าเว็บ
// • ค่าที่กรอกเอง/แก้ทับ เก็บในชีต "KPI Monthly"   • ตั้งค่า (บริษัท/แผนก/ส่งอัตโนมัติ) ในชีต "KPI Settings"
// • ส่งผลเข้า Rst-Kpi-Mtd-db (KPI_Data + KPI_Master) ด้วย openById — เจ้าของไฟล์คนเดียวกัน ไม่ต้องผ่าน HTTP
// • ส่งอัตโนมัติ: Trigger วันที่ 1 ของทุกเดือน 06:00 (เวลาไทย) ส่งผลของ "เดือนที่แล้ว"
//
// แหล่งข้อมูล (source) ของแต่ละหัวข้อ:
//   manual          กรอกเองทุกเดือน
//   tk_none         ไม่พบ Ticket หมวดนี้ในเดือน = 1, พบ = 0           (เช่น ตรวจพบโปรแกรมละเมิดลิขสิทธิ์)
//   tk_success      Ticket หมวดนี้ที่ปิดงานและ "สำเร็จ" / ที่ปิดงานทั้งหมด (เช่น กู้คืนข้อมูล, สร้าง/ลบ User)
//   tk_response     Ticket ที่ IT เริ่มดำเนินการภายใน N นาที / ทั้งหมด  (param = N นาที, หมวดว่าง = ทุกหมวด)
//   tk_uptime       1 − (นาทีที่ระบบล่ม / นาทีทั้งเดือน)  จาก Ticket หมวด Downtime
//   tk_satisfaction คะแนนความพึงพอใจรวม / (5 × จำนวน Ticket ที่ให้คะแนน)
// ═══════════════════════════════════════════════════════════════
var KPI_DST = {
  FILE_ID: '1UF_HlJKmgR81OMqwvgU0l0iQtRyOndRck7wy_KjejTE',   // Rst-Kpi-Mtd-db
  DATA: 'KPI_Data', MASTER: 'KPI_Master', LOG: 'Log'
};
var KPI_SH = { CONFIG: 'KPI Config', MONTHLY: 'KPI Monthly', SETTINGS: 'KPI Settings', TICKETS: 'IT Tickets' };
var KPI_CFG_HEAD = ['code', 'topic', 'method', 'direction', 'target', 'source', 'category', 'param', 'active', 'order', 'updatedAt'];
var KPI_MON_HEAD = ['key', 'ym', 'code', 'actual', 'note', 'by', 'updatedAt', 'pushedAt', 'pushedActual'];
var KPI_TK_EXTRA = ['responded', 'downMin', 'outcome', 'score'];   // คอลัมน์ O..R ของชีต IT Tickets
var KPI_SOURCES = ['manual', 'tk_none', 'tk_success', 'tk_response', 'tk_uptime', 'tk_satisfaction'];
var KPI_NA = 'N.A.';
var KPI_TXT = { PASS: 'ผ่านเป้า', LOW: 'ต่ำกว่าเป้า', FAIL: 'ไม่ผ่านเป้า', NONE: 'ยังไม่ได้ประเมิน' };
var KPI_BY = 'asset-app';
var KPI_MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var KPI_DEFAULTS = [
  ['OFC-IT-01', 'ตรวจพบการใช้โปรแกรมที่ละเมิดลิขสิทธิ์จากภายนอก', '', 'HIGHER', 1, 'tk_none', 'ตรวจพบโปรแกรมละเมิดลิขสิทธิ์', ''],
  ['OFC-IT-02', 'อัตราความสำเร็จของกู้คืนข้อมูล', '', 'HIGHER', 1, 'tk_success', 'กู้คืนข้อมูล', ''],
  ['OFC-IT-03', 'ระยะเวลาในการเข้าดำเนินการตรวจสอบและซ่อมต่อคำขอ IT ภายใน 30 นาที', '', 'HIGHER', 1, 'tk_response', '', 30],
  ['OFC-IT-04', 'ความถูกต้องของการสร้าง/ลบ user ใน microsoft teams, google workspace, bluehost, ecount', '(จำนวนพนักงานลาออกแล้วไม่ได้ลบ user / จำนวนพนักงานทั้งหมด) * 100', 'HIGHER', 1, 'tk_success', 'สร้าง/ลบ User (Teams/Google/Bluehost/Ecount)', ''],
  ['OFC-IT-05', 'Downtime: server', '', 'HIGHER', 0.97, 'tk_uptime', 'Downtime: Server', ''],
  ['OFC-IT-06', 'Downtime: Internet', '', 'HIGHER', 0.97, 'tk_uptime', 'Downtime: Internet', ''],
  ['OFC-IT-07', 'Downtime: กล้อง', '', 'HIGHER', 0.97, 'tk_uptime', 'Downtime: กล้อง CCTV', ''],
  ['OFC-IT-08', 'Downtime: Bluehost', '', 'HIGHER', 0.97, 'tk_uptime', 'Downtime: Bluehost', ''],
  ['OFC-IT-09', 'Downtime: GPS', '', 'HIGHER', 0.97, 'tk_uptime', 'Downtime: GPS', ''],
  ['OFC-IT-10', 'ผู้ใช้มีความพึงพอใจในการเข้าซ่อม และการแก้ไขปัญหา', '(คะแนนที่ผู้ใช้มีความพึงพอใจ / คะแนนทั้งหมด) * 100', 'HIGHER', 0.95, 'tk_satisfaction', '', '']
];

// ── Run จาก Editor ครั้งแรก (ในโปรเจกต์ Ticket) ──
function kpiSetup() {
  kpiConfig_();
  kpiTicketSheet_();
  var dst = SpreadsheetApp.openById(KPI_DST.FILE_ID);
  ScriptApp.getProjectTriggers();   // ขอสิทธิ์สร้าง Trigger
  Logger.log('✓ KPI พร้อมใช้งาน — ปลายทาง: ' + dst.getName() + ' · หัวข้อ ' + kpiConfig_().length + ' รายการ');
  Logger.log('เปิด "ส่งอัตโนมัติทุกเดือน" ได้จากหน้าเว็บ (KPI รายเดือน) หรือ Run kpiEnableAuto');
}
function kpiEnableAuto() { Logger.log(JSON.stringify(kpiSetAuto_(true))); }
function kpiDisableAuto() { Logger.log(JSON.stringify(kpiSetAuto_(false))); }
function kpiPushLastMonth() { Logger.log(JSON.stringify(kpiPush_(kpiPrevYm_(), false, 'editor'))); }

// ── Trigger: วันที่ 1 ของทุกเดือน ──
function kpiMonthlyJob() {
  var st = kpiSettings_();
  if (st.autoPush !== 'Y') return;
  var ym = kpiPrevYm_(), res;
  try { res = kpiPush_(ym, false, KPI_BY + ':auto'); }
  catch (err) { res = { status: 'error', msg: err.message || String(err) }; }
  kpiSaveSetting_('lastAuto', kpiStamp_() + ' · ' + ym + ' · ' + (res.status === 'ok' ? res.summary : 'ERROR ' + res.msg));
  try {   // แจ้ง LINE (ถ้าตั้งค่าไว้ในโปรเจกต์นี้)
    var cfg = lineGetConfig();
    if (cfg.token && cfg.targets.length) {
      linePushAll(cfg.token, cfg.targets, '📊 KPI IT เดือน ' + kpiYmTH_(ym) + '\nส่งเข้า Rst-Kpi-Mtd อัตโนมัติ: ' +
        (res.status === 'ok' ? res.summary + (res.lines ? '\n' + res.lines.join('\n') : '') : 'ไม่สำเร็จ — ' + res.msg));
    }
  } catch (e) {}
}

// ═══════════════════ ROUTER ═══════════════════
function handleKpi_(action, param, role) {
  try {
    var ym = kpiYm_(param.ym);
    if (action === 'kpiGet') return kpiGet_(ym);

    if (!isMgr(role)) return { status: 'error', code: 'forbidden', msg: 'เฉพาะผู้จัดการ/แอดมินเท่านั้น' };
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (action === 'kpiSaveItem') return kpiSaveItem_(JSON.parse(param.item || '{}'), String(param.orig || ''));
      if (action === 'kpiDelItem') return kpiDelItem_(String(param.code || ''));
      if (action === 'kpiSeed') return kpiSeed_();
      if (action === 'kpiSaveValues') return kpiSaveValues_(ym, JSON.parse(param.vals || '[]'), role);
      if (action === 'kpiPush') return kpiPush_(ym, param.force === '1', KPI_BY + ':' + role);
      if (action === 'kpiSettings') {
        if (role !== 'admin') return { status: 'error', code: 'forbidden', msg: 'เฉพาะ IT Admin เท่านั้น' };
        if (param.company !== undefined) kpiSaveSetting_('company', String(param.company).trim().slice(0, 60) || 'RST-OFFICE');
        if (param.dept !== undefined) kpiSaveSetting_('dept', String(param.dept).trim().slice(0, 60) || 'IT');
        if (param.autoPush !== undefined) kpiSetAuto_(param.autoPush === 'Y');
        return { status: 'ok', settings: kpiSettings_(), trigger: kpiTriggerOn_() };
      }
    } finally { lock.releaseLock(); }
    return { status: 'error', msg: 'unknown kpi action: ' + action };
  } catch (err) {
    return { status: 'error', msg: err.message || String(err) };
  }
}

function kpiGet_(ym) {
  var cfg = kpiConfig_(), vals = kpiValues_(ym, cfg);
  var cats = {};
  cfg.forEach(function (c) { kpiCats_(c.category).forEach(function (x) { cats[x] = 1; }); });
  return {
    status: 'ok', ym: ym, config: cfg, rows: vals, settings: kpiSettings_(),
    trigger: kpiTriggerOn_(), kpiCats: Object.keys(cats), dstUrl: 'https://docs.google.com/spreadsheets/d/' + KPI_DST.FILE_ID + '/edit'
  };
}

// ═══════════════════ STORAGE (ไฟล์ IT Tickets) ═══════════════════
function kpiSheet_(name, head) {
  var ss = getSS('ticket'), sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(head); sh.setFrozenRows(1); }
  return sh;
}
function kpiSettings_() {
  var sh = kpiSheet_(KPI_SH.SETTINGS, ['key', 'value']), o = { company: 'RST-OFFICE', dept: 'IT', autoPush: 'N', seeded: '', lastPush: '', lastAuto: '' };
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0]) o[String(r[0])] = String(r[1]); });
  return o;
}
function kpiSaveSetting_(k, v) {
  var sh = kpiSheet_(KPI_SH.SETTINGS, ['key', 'value']), n = sh.getLastRow();
  if (n > 1) {
    var keys = sh.getRange(2, 1, n - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) if (String(keys[i][0]) === k) { sh.getRange(i + 2, 2).setNumberFormat('@').setValue(v); return; }
  }
  sh.appendRow([k, String(v)]);
}
function kpiConfig_() {
  var sh = kpiSheet_(KPI_SH.CONFIG, KPI_CFG_HEAD);
  if (sh.getLastRow() < 2 && kpiSettings_().seeded !== 'Y') {
    var stamp = kpiStamp_();
    var rows = KPI_DEFAULTS.map(function (d, i) { return d.concat(['Y', i + 1, stamp]); });
    sh.getRange(2, 1, rows.length, KPI_CFG_HEAD.length).setValues(rows);
    kpiSaveSetting_('seeded', 'Y');
  }
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, KPI_CFG_HEAD.length).getValues()
    .filter(function (r) { return String(r[0]).trim(); })
    .map(function (r, i) {
      return {
        code: String(r[0]).trim(), topic: String(r[1]), method: String(r[2]),
        direction: String(r[3]).toUpperCase() === 'LOWER' ? 'LOWER' : 'HIGHER',
        target: kpiNum_(r[4]), source: KPI_SOURCES.indexOf(String(r[5])) > -1 ? String(r[5]) : 'manual',
        category: String(r[6] || ''), param: kpiNum_(r[7]), active: String(r[8] || 'Y') !== 'N',
        order: kpiNum_(r[9]) === null ? i + 1 : kpiNum_(r[9])
      };
    })
    .sort(function (a, b) { return a.order - b.order || (a.code < b.code ? -1 : 1); });
}
function kpiSaveItem_(it, orig) {
  var code = String(it.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_\-]{1,29}$/.test(code)) return { status: 'error', msg: 'รหัส KPI ใช้ได้เฉพาะ A-Z 0-9 - _ (2–30 ตัว)' };
  var topic = String(it.topic || '').trim().slice(0, 500);
  if (!topic) return { status: 'error', msg: 'กรุณาระบุหัวข้อ' };
  var target = kpiNum_(it.target);
  if (target === null) return { status: 'error', msg: 'Target ต้องเป็นตัวเลข (เช่น 0.97 = 97%)' };
  var src = KPI_SOURCES.indexOf(it.source) > -1 ? it.source : 'manual';
  var sh = kpiSheet_(KPI_SH.CONFIG, KPI_CFG_HEAD), n = sh.getLastRow();
  var keys = n > 1 ? sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return String(r[0]).trim().toUpperCase(); }) : [];
  if (!orig && keys.indexOf(code) > -1) return { status: 'error', msg: 'รหัส ' + code + ' มีอยู่แล้ว' };
  var at = orig ? keys.indexOf(orig.toUpperCase()) : -1;
  if (keys.indexOf(code) > -1 && keys.indexOf(code) !== at) return { status: 'error', msg: 'รหัส ' + code + ' มีอยู่แล้ว' };
  var order = kpiNum_(it.order);
  if (order === null) order = at > -1 ? kpiNum_(sh.getRange(at + 2, 10).getValue()) : keys.length + 1;
  var row = [code, topic, String(it.method || '').slice(0, 500), it.direction === 'LOWER' ? 'LOWER' : 'HIGHER', target, src,
    String(it.category || '').trim().slice(0, 200), kpiNum_(it.param) === null ? '' : kpiNum_(it.param), it.active === false || it.active === 'N' ? 'N' : 'Y', order || keys.length + 1, kpiStamp_()];
  var r = at > -1 ? at + 2 : n + 1;
  sh.getRange(r, 1, 1, 1).setNumberFormat('@');
  sh.getRange(r, 1, 1, row.length).setValues([row]);
  return { status: 'ok', config: kpiConfig_() };
}
function kpiDelItem_(code) {
  var sh = kpiSheet_(KPI_SH.CONFIG, KPI_CFG_HEAD), n = sh.getLastRow();
  if (n < 2) return { status: 'error', msg: 'ไม่พบรายการ' };
  var keys = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = keys.length - 1; i >= 0; i--) if (String(keys[i][0]).trim().toUpperCase() === code.toUpperCase()) { sh.deleteRow(i + 2); return { status: 'ok', config: kpiConfig_() }; }
  return { status: 'error', msg: 'ไม่พบรหัส ' + code };
}
function kpiSeed_() {   // เติมหัวข้อเริ่มต้นที่ยังไม่มี (ไม่ทับของเดิม)
  var have = {}; kpiConfig_().forEach(function (c) { have[c.code] = 1; });
  var add = KPI_DEFAULTS.filter(function (d) { return !have[d[0]]; });
  var sh = kpiSheet_(KPI_SH.CONFIG, KPI_CFG_HEAD), stamp = kpiStamp_();
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, KPI_CFG_HEAD.length).setValues(add.map(function (d) { return d.concat(['Y', parseInt(d[0].slice(-2), 10) || 99, stamp]); }));
  return { status: 'ok', added: add.length, config: kpiConfig_() };
}
function kpiMonthly_(ym) {
  var sh = kpiSheet_(KPI_SH.MONTHLY, KPI_MON_HEAD), n = sh.getLastRow(), o = {};
  if (n < 2) return o;
  sh.getRange(2, 1, n - 1, KPI_MON_HEAD.length).getValues().forEach(function (r, i) {
    if (String(r[1]) !== ym) return;
    o[String(r[2])] = { row: i + 2, actual: r[3] === '' ? '' : String(r[3]), note: String(r[4] || ''), by: String(r[5] || ''), updatedAt: String(r[6] || ''), pushedAt: String(r[7] || ''), pushedActual: String(r[8] === undefined ? '' : r[8]) };
  });
  return o;
}
function kpiMonUpsert_(ym, code, patch) {
  var sh = kpiSheet_(KPI_SH.MONTHLY, KPI_MON_HEAD), cur = kpiMonthly_(ym)[code];
  var base = cur ? [ym + '|' + code, ym, code, cur.actual, cur.note, cur.by, cur.updatedAt, cur.pushedAt, cur.pushedActual] : [ym + '|' + code, ym, code, '', '', '', '', '', ''];
  Object.keys(patch).forEach(function (k) { var i = KPI_MON_HEAD.indexOf(k); if (i > -1) base[i] = patch[k]; });
  var r = cur ? cur.row : sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, base.length).setNumberFormat('@').setValues([base.map(String)]);
}
function kpiSaveValues_(ym, vals, role) {
  if (!Array.isArray(vals)) return { status: 'error', msg: 'bad vals' };
  var stamp = kpiStamp_();
  vals.forEach(function (v) {
    var code = String(v.code || '').trim(); if (!code) return;
    var a = String(v.actual === null || v.actual === undefined ? '' : v.actual).trim();
    if (a && a.toUpperCase().replace(/\s/g, '') !== 'N.A.' && a.toUpperCase() !== 'NA') {
      var num = kpiNum_(a); if (num === null) return; a = String(num);
    } else if (a) a = KPI_NA;
    kpiMonUpsert_(ym, code, { actual: a, note: String(v.note || '').slice(0, 500), by: role, updatedAt: stamp });
  });
  return kpiGet_(ym);
}

// ═══════════════════ คำนวณจาก Ticket ═══════════════════
function kpiTicketSheet_() {
  var ss = getSS('ticket'), sh = ss.getSheetByName(KPI_SH.TICKETS) || ss.getSheets()[0];
  var head = sh.getRange(1, 15, 1, 4).getValues()[0];
  if (head.join('') === '') sh.getRange(1, 15, 1, 4).setValues([KPI_TK_EXTRA]);
  return sh;
}
function kpiTickets_() {
  var sh = kpiTicketSheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, Math.max(18, sh.getLastColumn())).getValues()
    .filter(function (r) { return String(r[0]).trim(); })
    .map(function (r) {
      return {
        id: String(r[1]), category: String(r[4]).trim(), status: String(r[7]),
        created: kpiDate_(r[11]), closed: kpiDate_(r[12]), responded: kpiDate_(r[14]),
        downMin: kpiNum_(r[15]), outcome: String(r[16] || '').toLowerCase(), score: kpiNum_(r[17])
      };
    });
}
function kpiCats_(s) { return String(s || '').split('|').map(function (x) { return x.trim(); }).filter(String); }
function kpiInCat_(t, cats) {
  if (!cats.length) return true;
  var c = t.category.toLowerCase();
  return cats.some(function (x) { return x.toLowerCase() === c; });
}
// ช่วงเวลาของเดือน (เวลาไทย UTC+7)
function kpiWindow_(ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7), off = 7 * 3600e3;
  return { start: Date.UTC(y, m - 1, 1) - off, end: Date.UTC(y, m, 1) - off };
}
function kpiCompute_(c, ym, tks) {
  if (c.source === 'manual') return { actual: '', detail: 'กรอกเอง' };
  var w = kpiWindow_(ym), now = Date.now(), cats = kpiCats_(c.category);
  var inMonth = tks.filter(function (t) { return t.created && t.created.getTime() >= w.start && t.created.getTime() < w.end && kpiInCat_(t, cats); });
  var r4 = function (x) { return Math.round(x * 10000) / 10000; };

  if (c.source === 'tk_none') {
    return { actual: inMonth.length ? 0 : 1, detail: inMonth.length ? 'พบ ' + inMonth.length + ' ครั้ง (' + inMonth.map(function (t) { return t.id; }).join(', ') + ')' : 'ไม่พบในเดือนนี้' };
  }
  if (c.source === 'tk_success') {
    var done = inMonth.filter(function (t) { return t.status === 'closed'; });
    if (!done.length) return { actual: KPI_NA, detail: inMonth.length ? 'ยังไม่ปิดงาน ' + inMonth.length + ' ใบ' : 'ไม่มีคำขอในเดือนนี้' };
    var ok = done.filter(function (t) { return t.outcome !== 'fail'; }).length;
    return { actual: r4(ok / done.length), detail: 'สำเร็จ ' + ok + '/' + done.length + ' ใบ' + (inMonth.length > done.length ? ' · ค้าง ' + (inMonth.length - done.length) : '') };
  }
  if (c.source === 'tk_response') {
    var lim = (c.param || 30) * 60e3, okR = 0, tot = 0, late = [];
    inMonth.forEach(function (t) {
      var at = t.responded || t.closed;
      if (!at) { if (now - t.created.getTime() > lim) { tot++; late.push(t.id); } return; }   // ยังไม่เริ่มและเกินเวลาแล้ว = ไม่ผ่าน
      tot++;
      if (at.getTime() - t.created.getTime() <= lim) okR++; else late.push(t.id);
    });
    if (!tot) return { actual: KPI_NA, detail: 'ไม่มี Ticket ในเดือนนี้' };
    return { actual: r4(okR / tot), detail: 'ทันเวลา ' + okR + '/' + tot + ' ใบ (≤ ' + (c.param || 30) + ' นาที)' + (late.length ? ' · เกิน: ' + late.slice(0, 8).join(', ') : '') };
  }
  if (c.source === 'tk_uptime') {
    var total = (w.end - w.start) / 60e3, down = 0, ids = [];
    tks.forEach(function (t) {
      if (!t.created || !kpiInCat_(t, cats)) return;
      var mins = 0;
      if (t.downMin !== null && t.downMin >= 0) {   // กรอกนาทีเอง → นับในเดือนที่แจ้ง
        if (t.created.getTime() >= w.start && t.created.getTime() < w.end) mins = t.downMin;
      } else {
        var s = Math.max(t.created.getTime(), w.start), e = Math.min((t.closed ? t.closed.getTime() : now), w.end);
        if (e > s) mins = (e - s) / 60e3;
      }
      if (mins > 0) { down += mins; ids.push(t.id); }
    });
    var up = Math.max(0, 1 - down / total);
    return { actual: r4(up), detail: down ? 'ล่มรวม ' + kpiDur_(down) + ' (' + ids.join(', ') + ')' : 'ไม่มีระบบล่ม' };
  }
  if (c.source === 'tk_satisfaction') {
    var sc = tks.filter(function (t) { return t.score !== null && t.score >= 1 && t.score <= 5 && kpiInCat_(t, cats) && (t.closed || t.created) && (t.closed || t.created).getTime() >= w.start && (t.closed || t.created).getTime() < w.end; });
    if (!sc.length) return { actual: KPI_NA, detail: 'ยังไม่มีการให้คะแนน' };
    var sum = sc.reduce(function (a, t) { return a + t.score; }, 0);
    return { actual: r4(sum / (5 * sc.length)), detail: 'คะแนน ' + sum + '/' + (5 * sc.length) + ' จาก ' + sc.length + ' ใบ' };
  }
  return { actual: '', detail: '' };
}
function kpiValues_(ym, cfg) {
  var tks = kpiTickets_(), mon = kpiMonthly_(ym);
  return cfg.map(function (c) {
    var auto = kpiCompute_(c, ym, tks), m = mon[c.code];
    var ovr = m && m.actual !== '' ? m.actual : '';
    var fin = ovr !== '' ? (ovr === KPI_NA ? KPI_NA : +ovr) : auto.actual;
    return {
      code: c.code, auto: auto, override: ovr, note: m ? m.note : '', actual: fin,
      eval: kpiEval_(fin, c.target, c.direction), pushedAt: m ? m.pushedAt : '', pushedActual: m ? m.pushedActual : ''
    };
  });
}
function kpiEval_(a, t, dir) {
  if (a === '' || a === null || a === undefined) return { achieved: '', result: KPI_TXT.NONE, status: KPI_TXT.NONE };
  if (a === KPI_NA) return { achieved: '', result: KPI_NA, status: KPI_NA };
  a = +a; t = +t;
  var ach = dir === 'LOWER' ? (a === 0 ? 1 : t / a) : (t === 0 ? 1 : a / t);
  var pass = dir === 'LOWER' ? a <= t : a >= t;
  return { achieved: (ach * 100).toFixed(1) + '%', result: pass ? KPI_TXT.PASS : KPI_TXT.LOW, status: pass ? KPI_TXT.PASS : KPI_TXT.FAIL };
}

// ═══════════════════ ส่งเข้า Rst-Kpi-Mtd ═══════════════════
function kpiPush_(ym, force, by) {
  var st = kpiSettings_(), cfg = kpiConfig_().filter(function (c) { return c.active; });
  if (!cfg.length) return { status: 'error', msg: 'ยังไม่มีหัวข้อ KPI ที่เปิดใช้งาน' };
  var vals = kpiValues_(ym, cfg), byCode = {};
  vals.forEach(function (v) { byCode[v.code] = v; });
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7), yBE = y + 543, mm = ('0' + m).slice(-2), ymBE = yBE + '-' + mm;
  var stamp = kpiStamp_();

  var dss = SpreadsheetApp.openById(KPI_DST.FILE_ID);
  var sh = dss.getSheetByName(KPI_DST.DATA);
  if (!sh) return { status: 'error', msg: 'ไม่พบชีต ' + KPI_DST.DATA + ' ใน Rst-Kpi-Mtd-db' };
  var data = sh.getDataRange().getValues(), head = data[0].map(function (h) { return String(h).trim(); }), H = {};
  head.forEach(function (h, i) { H[h] = i; });
  ['ID', 'KPI_Code', 'Actual'].forEach(function (k) { if (H[k] === undefined) throw new Error('ชีต KPI_Data ไม่มีคอลัมน์ ' + k); });
  var idx = {};
  for (var i = 1; i < data.length; i++) idx[String(data[i][H.ID])] = i;

  var ins = [], upd = 0, skip = [], lines = [];
  cfg.forEach(function (c) {
    var v = byCode[c.code], id = c.code + '_' + yBE + '_' + mm;
    var r = idx[id], cur = r !== undefined ? data[r].slice() : head.map(function () { return ''; });
    while (cur.length < head.length) cur.push('');
    var hasActual = r !== undefined && String(cur[H.Actual]).trim() !== '';
    var ours = r === undefined || /^asset-app/.test(String(H.UpdatedBy !== undefined ? cur[H.UpdatedBy] : ''));
    if (r !== undefined && v.actual === '') { skip.push(c.code + ' (ยังไม่มีค่า)'); return; }
    if (hasActual && !ours && !force) { skip.push(c.code + ' (กรอกใน Rst-Kpi-Mtd แล้ว)'); return; }
    var set = function (k, val) { if (H[k] !== undefined) cur[H[k]] = val; };
    set('ID', id); set('KPI_Code', c.code); set('Company', st.company); set('Dept', st.dept);
    set('Year', yBE); set('Month', m); set('MonthName', KPI_MONTH_EN[m - 1]);
    set('Topic', c.topic); set('Method', c.method); set('Direction', c.direction); set('Target', c.target);
    set('Actual', v.actual); set('Achieved', v.eval.achieved); set('Result', v.eval.result); set('Status', v.eval.status);
    var oldNote = H.Note !== undefined ? String(cur[H.Note] || '') : '';
    if (!oldNote || /^\[asset-app\]/.test(oldNote)) set('Note', '[asset-app] ' + (v.note || v.auto.detail || ''));
    set('SrcNo', 'asset-app'); set('UpdatedAt', stamp); set('UpdatedBy', by);
    if (r !== undefined) { sh.getRange(r + 1, 1, 1, head.length).setValues([cur]); upd++; }
    else ins.push(cur);
    lines.push('• ' + c.code + ': ' + (v.actual === '' ? '-' : v.actual) + ' → ' + v.eval.status);
  });
  if (ins.length) sh.getRange(sh.getLastRow() + 1, 1, ins.length, head.length).setValues(ins);

  kpiMasterUpsert_(dss, cfg, st, ymBE);
  try {
    var lg = dss.getSheetByName(KPI_DST.LOG);
    if (lg) lg.appendRow([Utilities.formatDate(new Date(), 'Asia/Bangkok', 'd/M/yyyy, HH:mm:ss'), by, 'upsert', ins.length + upd, ins.length, upd, 0, 'asset-app ' + ym + (skip.length ? ' · ข้าม ' + skip.length : '')]);
  } catch (e) {}
  SpreadsheetApp.flush();

  cfg.forEach(function (c) {
    if (skip.some(function (s) { return s.indexOf(c.code + ' ') === 0; })) return;
    kpiMonUpsert_(ym, c.code, { pushedAt: stamp, pushedActual: String(byCode[c.code].actual) });
  });
  var summary = 'เพิ่ม ' + ins.length + ' · อัปเดต ' + upd + (skip.length ? ' · ข้าม ' + skip.length : '');
  kpiSaveSetting_('lastPush', stamp + ' · ' + ym + ' · ' + summary + ' · ' + by);
  return { status: 'ok', ym: ym, inserted: ins.length, updated: upd, skipped: skip, summary: summary, lines: lines };
}
function kpiMasterUpsert_(dss, cfg, st, ymBE) {
  var sh = dss.getSheetByName(KPI_DST.MASTER);
  if (!sh) return;
  var data = sh.getDataRange().getValues(), H = {};
  data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
  if (H.KPI_Code === undefined) return;
  var idx = {};
  for (var i = 1; i < data.length; i++) idx[String(data[i][H.KPI_Code])] = i;
  var add = [];
  cfg.forEach(function (c) {
    var r = idx[c.code];
    if (r === undefined) {
      var row = data[0].map(function () { return ''; });
      var set = function (k, v) { if (H[k] !== undefined) row[H[k]] = v; };
      set('KPI_Code', c.code); set('Company', st.company); set('Dept', st.dept); set('Topic', c.topic); set('Method', c.method);
      set('Direction', c.direction); set('DefaultTarget', c.target); set('FirstYM', ymBE); set('LastYM', ymBE); set('Active', 'Y');
      add.push(row);
    } else {
      if (H.LastYM !== undefined && String(data[r][H.LastYM]) < ymBE) sh.getRange(r + 1, H.LastYM + 1).setNumberFormat('@').setValue(ymBE);
      if (H.FirstYM !== undefined && (!String(data[r][H.FirstYM]) || String(data[r][H.FirstYM]) > ymBE)) sh.getRange(r + 1, H.FirstYM + 1).setNumberFormat('@').setValue(ymBE);
    }
  });
  if (add.length) {
    var rg = sh.getRange(sh.getLastRow() + 1, 1, add.length, data[0].length);
    if (H.FirstYM !== undefined) sh.getRange(sh.getLastRow() + 1, H.FirstYM + 1, add.length, 2).setNumberFormat('@');
    rg.setValues(add);
  }
}

// ═══════════════════ TRIGGER ═══════════════════
function kpiTriggerOn_() {
  try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'kpiMonthlyJob'; }); }
  catch (e) { return false; }
}
function kpiSetAuto_(on) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'kpiMonthlyJob') ScriptApp.deleteTrigger(t); });
  if (on) ScriptApp.newTrigger('kpiMonthlyJob').timeBased().onMonthDay(1).atHour(6).inTimezone('Asia/Bangkok').create();
  kpiSaveSetting_('autoPush', on ? 'Y' : 'N');
  kpiSaveSetting_('autoProject', props().getProperty('SCRIPT_KIND') || SETUP.SCRIPT_KIND);
  return { status: 'ok', autoPush: on ? 'Y' : 'N', trigger: kpiTriggerOn_() };
}

// ═══════════════════ HELPERS ═══════════════════
function kpiNum_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var s = String(v).trim().replace(/,/g, ''), pct = /%$/.test(s);
  var n = parseFloat(s.replace(/%$/, ''));
  if (isNaN(n) || !/^-?[\d.]+%?$/.test(s)) return null;
  return pct ? n / 100 : n;
}
function kpiDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}
function kpiYm_(v) {
  v = String(v || '');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : kpiPrevYm_();
}
function kpiPrevYm_() {
  var d = new Date(Date.now() + 7 * 3600e3);   // เวลาไทย
  var y = d.getUTCFullYear(), m = d.getUTCMonth();   // m = เดือนที่แล้ว (1-based)
  if (m === 0) { y--; m = 12; }
  return y + '-' + ('0' + m).slice(-2);
}
function kpiYmTH_(ym) { return KPI_MONTH_EN[+ym.slice(5, 7) - 1] + ' ' + (+ym.slice(0, 4) + 543); }
function kpiStamp_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'); }
function kpiDur_(min) {
  min = Math.round(min);
  var d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), mm = min % 60;
  return (d ? d + ' วัน ' : '') + (h ? h + ' ชม. ' : '') + mm + ' นาที';
}