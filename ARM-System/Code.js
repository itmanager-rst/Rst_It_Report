/**
 * ARM-System — บันทึกรถยึด / รับรถเทิร์น (แทนสมุดบันทึก)
 * Backend: Google Apps Script + Google Sheets
 * CODE_VERSION: r03-2026-11-09-user-admin
 * Dev: tana.pittayatanadol
 *
 * ใช้ได้ 2 แบบ
 *  1) เปิดผ่าน URL ของ Web App (doGet ส่ง index.html → หน้าเว็บเรียก google.script.run.api(...))
 *  2) เปิด index.html จาก Live Server / GitHub Pages → หน้าเว็บ fetch POST มาที่ doPost (Content-Type: text/plain)
 */

const CODE_VERSION = 'r03-2026-11-09-user-admin';

// ถ้าสคริปต์ผูกกับชีต (Extensions > Apps Script) ปล่อยว่างได้
// ถ้าเป็นสคริปต์แยก ให้ใส่ ID ของ Google Sheet (ส่วนกลางของ URL .../d/<ID>/edit)
const SPREADSHEET_ID = '1UmnuH1pTy6IOZL8Twq5uertwHumIB2lsMfVeew-4dTA'; // ARM-System DB (รับรถยึด-รถเทิร์น)

const SHEET_USERS = 'Users';
const SHEET_RECORDS = 'Records';
const TOKEN_TTL_SEC = 6 * 60 * 60; // 6 ชั่วโมง (CacheService สูงสุด 6 ชม.)
const TZ = 'Asia/Bangkok';

const USER_HEADERS = ['Username', 'Password', 'Role', 'DisplayName', 'Active'];

// คอลัมน์ตามสเปกเดิม + คอลัมน์เพิ่มให้ตรงกับสมุดจริง (หน้าซ้าย = รับเข้า, หน้าขวา = เบิกออก/ขาย)
const RECORD_HEADERS = [
  'ID',           // รหัสภายในระบบ (อัตโนมัติ)
  'DocNo',        // เลขที่เอกสาร เช่น A69/093, B69/25
  'TxType',       // ยึด | เทิร์น
  'TxDate',       // ว/ด/ป ที่ทำรายการ
  'CustomerCode', // รหัสลูกค้า/สัญญา เช่น ML097, YN193, CG42
  'CustomerName', // ชื่อ-สกุล ลูกค้า / เจ้าของเดิม
  'AssetType',    // รถแทรกเตอร์, รถเกี่ยวข้าว ...
  'Model',        // รุ่น เช่น EF393T, L50, AW82V
  'ItemCount',    // จำนวน
  'Unit',         // หน่วย (คัน/ชุด)
  'BladeOrPart',  // อุปกรณ์พ่วง (หลายบรรทัด) เช่น "ใบมีด 1.60 x1 ชุด"
  'SerialNo',     // หมายเลขเครื่อง / ตัวถัง
  'ReceiveDate',  // ว/ด/ป ตรวจรับ (คอลัมน์ขวาสุดของหน้าซ้าย)
  'ReceivedBy',   // ผู้ตรวจรับ / ผู้เซ็นรับ
  'ReceiveChecklist', // เช็กลิสต์ของที่ได้รับเข้าคลัง บรรทัดละรายการ "[✓] ชื่อ" / "[ ] ชื่อ"
  'OutDate',      // ว/ด/ป เบิกออก (หน้าขวา)
  'OutItems',     // รายการที่เบิกออก
  'OutDocNo',     // เลขที่ใบเบิก เช่น D07/02
  'Withdrawer',   // ผู้เบิก
  'Buyer',        // ผู้ซื้อ
  'Status',       // สถานะ
  'Remark',       // หมายเหตุ
  'Username',     // ผู้บันทึก (อัตโนมัติ)
  'Timestamp',    // เวลาที่บันทึก (อัตโนมัติ)
  'UpdatedBy',
  'UpdatedAt'
];

const STATUSES = ['รอตรวจรับ', 'อยู่ในคลัง', 'เบิกออก/ส่งซ่อม', 'ขายแล้ว', 'คืนลูกค้า', 'ยกเลิก'];

// สิทธิ์: admin = ทั้งหมด, staff = เพิ่ม + แก้ไขรายการของตัวเอง, viewer = ดูอย่างเดียว
const ROLES = ['admin', 'staff', 'viewer'];
const CAN_CREATE = ['admin', 'staff'];
const CAN_EDIT_ALL = ['admin'];
const CAN_EDIT_OWN = ['staff'];
const CAN_DELETE = ['admin'];

/* ===================================================================== */
/*  Entry points                                                          */
/* ===================================================================== */

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'checkStatus') {
    return json_({ ok: true, codeVersion: CODE_VERSION, time: now_() });
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('ARM-System | บันทึกรถยึด/รถเทิร์น')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'รูปแบบคำขอไม่ถูกต้อง' });
  }
  return json_(api(req));
}

/**
 * จุดรวมทุกคำสั่ง — เรียกได้ทั้งจาก google.script.run.api(req) และ doPost
 * req = { action, token, ...payload }
 */
function api(req) {
  try {
    req = req || {};
    switch (req.action) {
      case 'checkStatus': return { ok: true, codeVersion: CODE_VERSION };
      case 'login':       return checkLogin(req.username, req.password);
      case 'logout':      return logout_(req.token);
      case 'me':          return { ok: true, user: requireUser_(req.token) };
      case 'list':        return listRecords_(requireUser_(req.token));
      case 'save':        return saveRecord(req.record, requireUser_(req.token));
      case 'delete':      return deleteRecord_(req.id, requireUser_(req.token));
      case 'listUsers':   return listUsers_(requireAdmin_(req.token));
      case 'saveUser':    return saveUser_(req.member, !!req.isNew, requireAdmin_(req.token));
      case 'deleteUser':  return deleteUser_(req.username, requireAdmin_(req.token));
      default:            return { ok: false, error: 'ไม่รู้จักคำสั่ง: ' + req.action };
    }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), auth: !!(err && err.auth) };
  }
}

/* ===================================================================== */
/*  Login / Session                                                       */
/* ===================================================================== */

function checkLogin(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!username || !password) return { ok: false, error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' };

  const sh = getSheet_(SHEET_USERS, USER_HEADERS);
  const data = sh.getDataRange().getValues();
  const h = headerIndex_(data[0]);

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (String(row[h.Username]).trim().toLowerCase() !== username.toLowerCase()) continue;

    const active = h.Active === undefined ? true : String(row[h.Active]).trim().toUpperCase() !== 'FALSE';
    if (!active) return { ok: false, error: 'บัญชีนี้ถูกปิดใช้งาน' };
    if (!passwordMatches_(password, String(row[h.Password]))) break;

    let role = String(row[h.Role] || 'staff').trim().toLowerCase();
    if (ROLES.indexOf(role) === -1) role = 'viewer';

    const user = {
      username: String(row[h.Username]).trim(),
      role: role,
      displayName: h.DisplayName !== undefined && row[h.DisplayName] ? String(row[h.DisplayName]) : String(row[h.Username]).trim()
    };
    const token = Utilities.getUuid();
    CacheService.getScriptCache().put('tok_' + token, JSON.stringify(user), TOKEN_TTL_SEC);
    return { ok: true, token: token, user: user, perms: perms_(user.role) };
  }
  Utilities.sleep(400); // ชะลอการเดารหัสผ่าน
  return { ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
}

/** รองรับรหัสผ่านแบบข้อความธรรมดา หรือ "sha256:<hex>" (สร้างด้วย hashPassword('รหัส')) */
function passwordMatches_(input, stored) {
  if (stored.indexOf('sha256:') === 0) return 'sha256:' + sha256_(input) === stored;
  return input === stored;
}

function hashPassword(plain) {
  const out = 'sha256:' + sha256_(plain || '');
  Logger.log(out);
  return out;
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function logout_(token) {
  if (token) CacheService.getScriptCache().remove('tok_' + token);
  return { ok: true };
}

function requireUser_(token) {
  const raw = token ? CacheService.getScriptCache().get('tok_' + token) : null;
  if (!raw) {
    const e = new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    e.auth = true;
    throw e;
  }
  CacheService.getScriptCache().put('tok_' + token, raw, TOKEN_TTL_SEC); // ต่ออายุ
  return JSON.parse(raw);
}

function perms_(role) {
  return {
    create: CAN_CREATE.indexOf(role) > -1,
    editAll: CAN_EDIT_ALL.indexOf(role) > -1,
    editOwn: CAN_EDIT_OWN.indexOf(role) > -1,
    del: CAN_DELETE.indexOf(role) > -1
  };
}

/* ===================================================================== */
/*  Records                                                               */
/* ===================================================================== */

function listRecords_(user) {
  const sh = getSheet_(SHEET_RECORDS, RECORD_HEADERS);
  const data = sh.getDataRange().getValues();
  const head = data[0];
  const out = [];
  for (let r = 1; r < data.length; r++) {
    if (!data[r].join('')) continue;
    const o = {};
    head.forEach((k, i) => { if (k) o[k] = cellOut_(data[r][i], k); });
    if (!o.ID) continue;
    out.push(o);
  }
  out.sort((a, b) => (b.TxDate || '').localeCompare(a.TxDate || '') || (b.Timestamp || '').localeCompare(a.Timestamp || ''));
  return { ok: true, records: out, perms: perms_(user.role), statuses: STATUSES };
}

/** บันทึก (เพิ่มใหม่ถ้าไม่มี ID, แก้ไขถ้ามี ID) */
function saveRecord(rec, user) {
  rec = rec || {};
  const p = perms_(user.role);
  const clean = sanitize_(rec);

  if (!clean.DocNo) throw new Error('กรุณากรอกเลขที่เอกสาร');
  if (!clean.TxDate) throw new Error('กรุณาระบุวันที่ทำรายการ');
  if (!clean.CustomerName) throw new Error('กรุณากรอกชื่อ-สกุล ลูกค้า');
  if (!clean.AssetType) throw new Error('กรุณาระบุประเภทรถ/ทรัพย์สิน');
  if (!clean.Status) clean.Status = autoStatus_(clean);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = getSheet_(SHEET_RECORDS, RECORD_HEADERS);
    const data = sh.getDataRange().getValues();
    const head = data[0];
    const h = headerIndex_(head);

    // เลขที่เอกสารห้ามซ้ำ
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][h.DocNo]).trim().toUpperCase() === clean.DocNo.toUpperCase() &&
          String(data[r][h.ID]) !== String(rec.ID || '')) {
        throw new Error('เลขที่เอกสาร ' + clean.DocNo + ' มีอยู่แล้วในระบบ');
      }
    }

    if (!rec.ID) {
      if (!p.create) throw new Error('สิทธิ์ของคุณไม่สามารถเพิ่มข้อมูลได้');
      clean.ID = 'R' + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
      clean.Username = user.username;
      clean.Timestamp = now_();
      clean.UpdatedBy = '';
      clean.UpdatedAt = '';
      sh.appendRow(head.map(k => cellIn_(clean[k], k)));
      return { ok: true, id: clean.ID, message: 'บันทึกเรียบร้อย' };
    }

    // แก้ไข
    let rowIdx = -1;
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][h.ID]) === String(rec.ID)) { rowIdx = r; break; }
    }
    if (rowIdx < 0) throw new Error('ไม่พบรายการที่ต้องการแก้ไข');
    const owner = String(data[rowIdx][h.Username]);
    if (!(p.editAll || (p.editOwn && owner === user.username))) {
      throw new Error('สิทธิ์ของคุณแก้ไขได้เฉพาะรายการที่ตนเองบันทึก');
    }
    clean.ID = rec.ID;
    clean.Username = owner;
    clean.Timestamp = cellOut_(data[rowIdx][h.Timestamp], 'Timestamp');
    clean.UpdatedBy = user.username;
    clean.UpdatedAt = now_();
    sh.getRange(rowIdx + 1, 1, 1, head.length).setValues([head.map(k => cellIn_(clean[k], k))]);
    return { ok: true, id: clean.ID, message: 'แก้ไขเรียบร้อย' };
  } finally {
    lock.releaseLock();
  }
}

function deleteRecord_(id, user) {
  if (!perms_(user.role).del) throw new Error('เฉพาะผู้ดูแลระบบ (admin) เท่านั้นที่ลบได้');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = getSheet_(SHEET_RECORDS, RECORD_HEADERS);
    const data = sh.getDataRange().getValues();
    const h = headerIndex_(data[0]);
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][h.ID]) === String(id)) {
        sh.deleteRow(r + 1);
        return { ok: true, message: 'ลบรายการเรียบร้อย' };
      }
    }
    throw new Error('ไม่พบรายการ');
  } finally {
    lock.releaseLock();
  }
}

/* ===================================================================== */
/*  จัดการสมาชิก (เฉพาะ admin)                                           */
/* ===================================================================== */

function requireAdmin_(token) {
  const u = requireUser_(token);
  if (u.role !== 'admin') throw new Error('เฉพาะผู้ดูแลระบบ (admin) เท่านั้น');
  return u;
}

function readUsers_() {
  const sh = getSheet_(SHEET_USERS, USER_HEADERS);
  const data = sh.getDataRange().getValues();
  return { sh: sh, data: data, h: headerIndex_(data[0]) };
}

function isActive_(row, h) {
  return h.Active === undefined ? true : String(row[h.Active]).trim().toUpperCase() !== 'FALSE';
}

/** รายชื่อสมาชิก — ไม่ส่งรหัสผ่านกลับไปที่หน้าเว็บ */
function listUsers_(admin) {
  const u = readUsers_(), out = [];
  for (let r = 1; r < u.data.length; r++) {
    const row = u.data[r], name = String(row[u.h.Username] || '').trim();
    if (!name) continue;
    out.push({
      username: name,
      role: String(row[u.h.Role] || 'viewer').trim().toLowerCase(),
      displayName: u.h.DisplayName !== undefined ? String(row[u.h.DisplayName] || '') : '',
      active: isActive_(row, u.h),
      hashed: String(row[u.h.Password] || '').indexOf('sha256:') === 0
    });
  }
  return { ok: true, users: out, me: admin.username };
}

function saveUser_(m, isNew, admin) {
  m = m || {};
  const username = String(m.username || '').trim();
  const role = String(m.role || '').trim().toLowerCase();
  const displayName = String(m.displayName || '').trim().slice(0, 60);
  const active = m.active !== false;
  const password = String(m.password || '');

  if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) throw new Error('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - ยาว 3-30 ตัวอักษร');
  if (ROLES.indexOf(role) === -1) throw new Error('สิทธิ์ไม่ถูกต้อง');
  if (isNew && !password) throw new Error('กรุณาตั้งรหัสผ่าน');
  if (password && password.length < 6) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');

  const isSelf = username.toLowerCase() === String(admin.username).toLowerCase();
  if (isSelf && (role !== 'admin' || !active)) throw new Error('ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const u = readUsers_(), head = u.data[0], h = u.h;
    let idx = -1, activeAdmins = 0;
    for (let r = 1; r < u.data.length; r++) {
      const row = u.data[r], name = String(row[h.Username] || '').trim();
      if (name.toLowerCase() === username.toLowerCase()) idx = r;
      else if (name && isActive_(row, h) && String(row[h.Role]).trim().toLowerCase() === 'admin') activeAdmins++;
    }
    if (isNew && idx > -1) throw new Error('มีชื่อผู้ใช้ "' + username + '" อยู่แล้ว');
    if (!isNew && idx < 0) throw new Error('ไม่พบสมาชิก');
    if (!(role === 'admin' && active) && activeAdmins === 0) throw new Error('ต้องมี admin ที่ใช้งานได้อย่างน้อย 1 คน');

    const old = idx > -1 ? u.data[idx] : [];
    const val = {
      Username: idx > -1 ? String(old[h.Username]).trim() : username,
      Password: password ? 'sha256:' + sha256_(password) : old[h.Password],
      Role: role,
      DisplayName: displayName,
      Active: active
    };
    const row = head.map((k, i) => val.hasOwnProperty(k) ? (k === 'Active' ? val[k] : cellIn_(val[k], k)) : (idx > -1 ? old[i] : ''));
    if (idx > -1) u.sh.getRange(idx + 1, 1, 1, head.length).setValues([row]);
    else u.sh.appendRow(row);
    return { ok: true, message: isNew ? 'เพิ่มสมาชิกเรียบร้อย' : 'บันทึกข้อมูลสมาชิกเรียบร้อย' };
  } finally {
    lock.releaseLock();
  }
}

function deleteUser_(username, admin) {
  username = String(username || '').trim();
  if (username.toLowerCase() === String(admin.username).toLowerCase()) throw new Error('ไม่สามารถลบบัญชีของตัวเองได้');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const u = readUsers_(), h = u.h;
    let idx = -1, otherAdmins = 0;
    for (let r = 1; r < u.data.length; r++) {
      const row = u.data[r], name = String(row[h.Username] || '').trim();
      if (name.toLowerCase() === username.toLowerCase()) idx = r;
      else if (name && isActive_(row, h) && String(row[h.Role]).trim().toLowerCase() === 'admin') otherAdmins++;
    }
    if (idx < 0) throw new Error('ไม่พบสมาชิก');
    if (otherAdmins === 0) throw new Error('ต้องมี admin ที่ใช้งานได้อย่างน้อย 1 คน');
    u.sh.deleteRow(idx + 1);
    return { ok: true, message: 'ลบสมาชิกเรียบร้อย' };
  } finally {
    lock.releaseLock();
  }
}

function sanitize_(rec) {
  const editable = ['DocNo', 'TxType', 'TxDate', 'CustomerCode', 'CustomerName', 'AssetType', 'Model',
    'ItemCount', 'Unit', 'BladeOrPart', 'SerialNo', 'ReceiveDate', 'ReceivedBy', 'ReceiveChecklist', 'OutDate', 'OutItems',
    'OutDocNo', 'Withdrawer', 'Buyer', 'Status', 'Remark'];
  const o = {};
  editable.forEach(k => {
    let v = rec[k] === undefined || rec[k] === null ? '' : String(rec[k]).trim();
    if (v.length > 2000) v = v.slice(0, 2000);
    o[k] = v;
  });
  o.DocNo = o.DocNo.toUpperCase();
  o.TxType = o.TxType === 'เทิร์น' ? 'เทิร์น' : 'ยึด';
  o.ItemCount = o.ItemCount === '' ? 1 : Number(o.ItemCount) || 1;
  if (STATUSES.indexOf(o.Status) === -1) o.Status = '';
  ['TxDate', 'ReceiveDate', 'OutDate'].forEach(k => {
    if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) throw new Error('รูปแบบวันที่ไม่ถูกต้อง: ' + k);
  });
  return o;
}

function autoStatus_(r) {
  if (r.Buyer) return 'ขายแล้ว';
  if (r.OutDate) return 'เบิกออก/ส่งซ่อม';
  if (r.ReceiveDate) return 'อยู่ในคลัง';
  return 'รอตรวจรับ';
}

/* ===================================================================== */
/*  Sheet helpers                                                         */
/* ===================================================================== */

function ss_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

/** คืนชีต ถ้าไม่มีจะสร้างพร้อมหัวตาราง และเติมคอลัมน์ที่ขาดต่อท้ายให้อัตโนมัติ */
function getSheet_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = headers.filter(x => current.indexOf(x) === -1);
  if (missing.length) {
    const start = current.filter(String).length ? lastCol + 1 : 1;
    sh.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return sh;
}

function headerIndex_(row) {
  const m = {};
  row.forEach((k, i) => { if (k !== '') m[String(k).trim()] = i; });
  return m;
}

const DATE_KEYS = ['TxDate', 'ReceiveDate', 'OutDate'];

function cellOut_(v, key) {
  if (v instanceof Date) {
    return DATE_KEYS.indexOf(key) > -1
      ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd')
      : Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  }
  return v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v));
}

/** บันทึกวันที่/เลขเอกสารเป็นข้อความ เพื่อไม่ให้ Sheets แปลงรูปแบบเอง (เช่น 'A69/093) */
function cellIn_(v, key) {
  if (v === undefined || v === null) return '';
  if (key === 'ItemCount') return Number(v) || '';
  const s = String(v);
  return s && /^[=+\-@]|^\d|\//.test(s) ? "'" + s : s;
}

function now_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ===================================================================== */
/*  ติดตั้งครั้งแรก — กด Run ฟังก์ชันนี้ 1 ครั้งใน Apps Script editor     */
/* ===================================================================== */

function setupSheets() {
  const users = getSheet_(SHEET_USERS, USER_HEADERS);
  if (users.getLastRow() < 2) {
    users.appendRow(['admin', 'admin1234', 'admin', 'ผู้ดูแลระบบ', 'TRUE']);
    users.appendRow(['staff01', 'staff1234', 'staff', 'พนักงาน 01', 'TRUE']);
  }
  const rec = getSheet_(SHEET_RECORDS, RECORD_HEADERS);
  rec.getRange('A:Z').setNumberFormat('@'); // เก็บเป็นข้อความทั้งหมด
  rec.getRange(1, RECORD_HEADERS.indexOf('BladeOrPart') + 1, rec.getMaxRows(), 1).setWrap(true);
  rec.getRange(1, RECORD_HEADERS.indexOf('OutItems') + 1, rec.getMaxRows(), 1).setWrap(true);
  Logger.log('ตั้งค่าชีตเรียบร้อย — อย่าลืมเปลี่ยนรหัสผ่านเริ่มต้นในชีต Users');
}