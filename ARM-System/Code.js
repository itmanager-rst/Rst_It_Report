/**
 * ARM-System — บันทึกรถยึด / รับรถเทิร์น (แทนสมุดบันทึก)
 * Backend: Google Apps Script + Google Sheets
 * CODE_VERSION: r07-2026-11-19-follow-auto-import
 * Dev: tana.pittayatanadol
 *
 * ใช้ได้ 2 แบบ
 *  1) เปิดผ่าน URL ของ Web App (doGet ส่ง index.html → หน้าเว็บเรียก google.script.run.api(...))
 *  2) เปิด index.html จาก Live Server / GitHub Pages → หน้าเว็บ fetch POST มาที่ doPost (Content-Type: text/plain)
 */

const CODE_VERSION = 'r07-2026-11-19-follow-auto-import';

// ถ้าสคริปต์ผูกกับชีต (Extensions > Apps Script) ปล่อยว่างได้
// ถ้าเป็นสคริปต์แยก ให้ใส่ ID ของ Google Sheet (ส่วนกลางของ URL .../d/<ID>/edit)
const SPREADSHEET_ID = '1UmnuH1pTy6IOZL8Twq5uertwHumIB2lsMfVeew-4dTA'; // ARM-System DB (รับรถยึด-รถเทิร์น)

const SHEET_USERS = 'Users';
const SHEET_RECORDS = 'Records';
const SHEET_EC_BATCH = 'EcountBatches'; // 1 แถว = ไฟล์ที่นำเข้า 1 ครั้ง (หัวคอลัมน์ของไฟล์นั้น)
const SHEET_EC_ROWS = 'EcountRows';     // 1 แถว = ข้อมูล 1 แถวจากไฟล์ Ecount (เก็บเป็น JSON array ตามหัวคอลัมน์)
const EC_BATCH_HEADERS = ['BatchID', 'Title', 'FileName', 'Headers', 'RowCount', 'ImportedBy', 'ImportedAt'];
const EC_ROW_HEADERS = ['RowID', 'BatchID', 'RowNo', 'RowKey', 'Data'];
const EC_MAX_ROWS = 5000;   // ต่อการนำเข้า 1 ครั้ง
const EC_MAX_COLS = 60;
// สมุดติดตามหนี้ · โทรนัด
const SHEET_FOLLOW = 'Follow';       // หน้าซ้าย: ลูกหนี้ 1 แถว / 1 รหัสลูกค้า
const SHEET_FOLLOW_LOG = 'FollowLog'; // หน้าขวา: บันทึกการโทร / นัด
const FOLLOW_HEADERS = ['Code', 'ContractNo', 'PayType', 'CustomerName', 'Address', 'District', 'Province', 'Phones',
  'Items', 'SerialNo', 'DueDate', 'Overdue', 'Installment', 'Collector', 'Branch', 'Remark', 'Source', 'Active',
  'ImportedAt', 'CreatedBy', 'UpdatedBy', 'UpdatedAt'];
const FOLLOW_LOG_HEADERS = ['LogID', 'Code', 'Kind', 'LogDate', 'PromiseDate', 'Amount', 'Note', 'DocNo', 'Username', 'Timestamp'];
const FOLLOW_EDIT_FIELDS = ['ContractNo', 'PayType', 'CustomerName', 'Address', 'District', 'Province', 'Phones',
  'Items', 'SerialNo', 'DueDate', 'Overdue', 'Installment', 'Collector', 'Branch', 'Remark'];
const FOLLOW_IMPORT_FIELDS = FOLLOW_EDIT_FIELDS.filter(k => k !== 'Remark' && k !== 'Phones'); // หมายเหตุไม่ถูกทับ, เบอร์รวมกัน
const FOLLOW_KINDS = ['นัดชำระ', 'ชำระแล้ว', 'ไม่รับสาย', 'ติดต่อได้', 'ส่งติดตาม', 'ปิดบัญชี', 'บันทึก', 'ยึดรถ'];
const FOLLOW_MAX_IMPORT = 10000;

// BigQuery (ยอดขาย ECOUNT) — ใช้กับปุ่ม "ประวัติซื้อ" และ "เติมรุ่น/เลขเครื่อง"
// ต้องเพิ่ม Service: BigQuery API ใน Apps Script (Services → + → BigQuery API) และใส่ค่าด้านล่าง
// เว้นว่างไว้ = ปุ่มจะแจ้งว่ายังไม่ได้ตั้งค่า (ส่วนอื่นใช้งานได้ปกติ)
const BQ_PROJECT = '';            // เช่น 'rst-crm-123456'
const BQ_DATASET = '';            // เช่น 'crm'
const BQ_SALES_TABLE = 'sales_transactions';

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
      case 'ecList':      return ecList_(requireUser_(req.token));
      case 'ecImport':    return ecImport_(req, requireUser_(req.token));
      case 'ecDeleteBatch': return ecDeleteBatch_(req.batchId, requireAdmin_(req.token));
      case 'followList':      return followList_(requireUser_(req.token));
      case 'followSave':      return followSave_(req.item, !!req.isNew, requireUser_(req.token));
      case 'followLog':       return followLog_(req.code, req.entry, requireUser_(req.token));
      case 'followDeleteLog': return followDeleteLog_(req.logId, requireUser_(req.token));
      case 'followImport':    return followImport_(req.rows, !!req.markMissing, requireUser_(req.token));
      case 'bqInfo':          requireUser_(req.token); return bqInfo_();
      case 'bqSales':         requireUser_(req.token); return bqSales_(req.code, req.name);
      case 'bqEnrich':        return bqEnrich_(requireAdmin_(req.token));
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

/* ===================================================================== */
/*  นำเข้าข้อมูลจาก Ecount (ไฟล์ Excel/CSV แปลงเป็นตารางที่หน้าเว็บ)      */
/*  เก็บแบบยืดหยุ่น: หัวคอลัมน์ตามไฟล์จริง จึงใช้ได้กับทุกรายงานของ Ecount */
/* ===================================================================== */

function ecList_(user) {
  const bs = getSheet_(SHEET_EC_BATCH, EC_BATCH_HEADERS).getDataRange().getValues();
  const bh = headerIndex_(bs[0]);
  const batches = [];
  for (let r = 1; r < bs.length; r++) {
    const id = String(bs[r][bh.BatchID] || '');
    if (!id) continue;
    let headers = [];
    try { headers = JSON.parse(String(bs[r][bh.Headers] || '[]')); } catch (e) {}
    batches.push({
      id: id,
      title: String(bs[r][bh.Title] || ''),
      fileName: String(bs[r][bh.FileName] || ''),
      headers: headers,
      rowCount: Number(bs[r][bh.RowCount]) || 0,
      by: String(bs[r][bh.ImportedBy] || ''),
      at: cellOut_(bs[r][bh.ImportedAt], 'ImportedAt')
    });
  }
  batches.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const rs = getSheet_(SHEET_EC_ROWS, EC_ROW_HEADERS).getDataRange().getValues();
  const rh = headerIndex_(rs[0]);
  const rows = [];
  for (let r = 1; r < rs.length; r++) {
    const id = String(rs[r][rh.RowID] || '');
    if (!id) continue;
    let v = [];
    try { v = JSON.parse(String(rs[r][rh.Data] || '[]')); } catch (e) {}
    rows.push({ id: id, b: String(rs[r][rh.BatchID]), n: Number(rs[r][rh.RowNo]) || 0, v: v });
  }
  return { ok: true, batches: batches, rows: rows, canImport: perms_(user.role).create, canDelete: user.role === 'admin' };
}

function ecKey_(vals) {
  return sha256_(vals.map(v => String(v).trim()).join('\u0001')).slice(0, 20);
}

function ecImport_(req, user) {
  if (!perms_(user.role).create) throw new Error('สิทธิ์ของคุณไม่สามารถนำเข้าข้อมูลได้');
  const headers = (Array.isArray(req.headers) ? req.headers : []).map(h => String(h || '').trim().slice(0, 100));
  let rows = Array.isArray(req.rows) ? req.rows : [];
  if (!headers.length) throw new Error('ไม่พบหัวคอลัมน์');
  if (headers.length > EC_MAX_COLS) throw new Error('คอลัมน์มากเกินไป (สูงสุด ' + EC_MAX_COLS + ')');
  if (!rows.length) throw new Error('ไม่มีแถวข้อมูลให้นำเข้า');
  if (rows.length > EC_MAX_ROWS) throw new Error('นำเข้าได้ครั้งละไม่เกิน ' + EC_MAX_ROWS + ' แถว');
  rows = rows.map(r => headers.map((_, i) => {
    const v = Array.isArray(r) && r[i] !== undefined && r[i] !== null ? String(r[i]) : '';
    return v.length > 1000 ? v.slice(0, 1000) : v;
  }));

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rsh = getSheet_(SHEET_EC_ROWS, EC_ROW_HEADERS);
    const bsh = getSheet_(SHEET_EC_BATCH, EC_BATCH_HEADERS);

    // โหมดแทนที่: ลบชุดข้อมูลเดิมที่เป็นรายงานรูปแบบเดียวกัน (หัวคอลัมน์ตรงกันทุกช่อง) ก่อนนำเข้า
    // เหมาะกับการ export ทั้งช่วงตั้งแต่ต้นทุกครั้ง — ข้อมูลที่แก้ใน Ecount ภายหลังจะอัปเดตตาม
    let replaced = 0;
    if (req.mode === 'replace') {
      const sig = JSON.stringify(headers);
      const bd = bsh.getDataRange().getValues();
      const bh = headerIndex_(bd[0]);
      const old = [];
      for (let i = 1; i < bd.length; i++) {
        let hs = [];
        try { hs = JSON.parse(String(bd[i][bh.Headers] || '[]')); } catch (e) {}
        if (JSON.stringify(hs) === sig) old.push(String(bd[i][bh.BatchID]));
      }
      if (old.length) replaced = ecRemoveBatches_(old);
    }

    // ข้ามแถวที่เคยนำเข้าแล้ว (ข้อมูลเหมือนกันทุกช่อง) — กันนำเข้าไฟล์ช่วงเวลาซ้อนกันซ้ำ
    let skipped = 0;
    if (req.mode !== 'replace' && req.skipDup !== false) {
      const data = rsh.getDataRange().getValues();
      const h = headerIndex_(data[0]);
      const seen = {};
      for (let r = 1; r < data.length; r++) seen[String(data[r][h.RowKey])] = 1;
      rows = rows.filter(v => {
        const k = ecKey_(v);
        if (seen[k]) { skipped++; return false; }
        seen[k] = 1;
        return true;
      });
    }
    if (!rows.length) return { ok: true, added: 0, skipped: skipped, message: 'ข้อมูลทั้งหมดเคยนำเข้าแล้ว (' + skipped + ' แถว)' };

    const batchId = 'E' + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
    const title = String(req.title || '').trim().slice(0, 150) || String(req.fileName || 'Ecount');
    const fileName = String(req.fileName || '').slice(0, 150);

    const out = rows.map((v, i) => [batchId + '-' + (i + 1), batchId, i + 1, ecKey_(v), JSON.stringify(v)]);
    const head = rsh.getRange(1, 1, 1, rsh.getLastColumn()).getValues()[0].map(String);
    const order = EC_ROW_HEADERS.map(k => head.indexOf(k));
    const width = head.length;
    const block = out.map(o => { const row = new Array(width).fill(''); order.forEach((c, j) => { if (c > -1) row[c] = o[j]; }); return row; });
    const start = rsh.getLastRow() + 1;
    const rng = rsh.getRange(start, 1, block.length, width);
    rng.setNumberFormat('@');
    rng.setValues(block);

    const bhead = bsh.getRange(1, 1, 1, bsh.getLastColumn()).getValues()[0].map(String);
    const bval = { BatchID: batchId, Title: title, FileName: fileName, Headers: JSON.stringify(headers),
      RowCount: rows.length, ImportedBy: user.username, ImportedAt: now_() };
    const brow = bhead.map(k => bval.hasOwnProperty(k) ? bval[k] : '');
    const bstart = bsh.getLastRow() + 1;
    bsh.getRange(bstart, 1, 1, brow.length).setNumberFormat('@').setValues([brow.map(String)]);

    return { ok: true, batchId: batchId, added: rows.length, skipped: skipped,
      replaced: replaced,
      message: 'นำเข้า ' + rows.length + ' แถวเรียบร้อย' + (skipped ? ' (ข้ามแถวซ้ำ ' + skipped + ')' : '') +
        (replaced ? ' · แทนที่ข้อมูลเดิม ' + replaced + ' แถว' : '') };
  } finally {
    lock.releaseLock();
  }
}

function ecDeleteBatch_(batchId, admin) {
  batchId = String(batchId || '');
  if (!batchId) throw new Error('ไม่พบชุดข้อมูล');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const removed = ecRemoveBatches_([batchId]);
    return { ok: true, message: 'ลบชุดข้อมูลเรียบร้อย (' + removed + ' แถว)' };
  } finally {
    lock.releaseLock();
  }
}

/** ลบชุดข้อมูล (ต้องถือ lock อยู่แล้ว) — คืนจำนวนแถวที่ลบ */
function ecRemoveBatches_(ids) {
  const want = {};
  ids.forEach(id => { want[String(id)] = 1; });
  const rsh = getSheet_(SHEET_EC_ROWS, EC_ROW_HEADERS);
  const data = rsh.getDataRange().getValues();
  const h = headerIndex_(data[0]);
  // ลบเป็นช่วงต่อเนื่อง จากล่างขึ้นบน (เร็วกว่าลบทีละแถว)
  let r = data.length - 1, removed = 0;
  while (r >= 1) {
    if (!want[String(data[r][h.BatchID])]) { r--; continue; }
    let s = r;
    while (s - 1 >= 1 && want[String(data[s - 1][h.BatchID])]) s--;
    rsh.deleteRows(s + 1, r - s + 1);
    removed += r - s + 1;
    r = s - 1;
  }
  const bsh = getSheet_(SHEET_EC_BATCH, EC_BATCH_HEADERS);
  const bd = bsh.getDataRange().getValues();
  const bh = headerIndex_(bd[0]);
  for (let i = bd.length - 1; i >= 1; i--) {
    if (want[String(bd[i][bh.BatchID])]) bsh.deleteRow(i + 1);
  }
  return removed;
}

/* ===================================================================== */
/*  สมุดติดตามหนี้ · โทรนัด                                               */
/*  ชีต Follow    = หน้าซ้ายของสมุด (ลูกหนี้ 1 แถว / 1 รหัสลูกค้า)          */
/*  ชีต FollowLog = หน้าขวา (บันทึกการโทร / นัดชำระ / ยึดรถ ทุกครั้ง)      */
/* ===================================================================== */

function flStr_(v, max) {
  let s = v === undefined || v === null ? '' : String(v).replace(/\r/g, '').trim();
  return s.length > (max || 1000) ? s.slice(0, max || 1000) : s;
}
function flDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const s = flStr_(v, 20);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง: ' + s);
  return s;
}
function flMoney_(v) {
  const s = flStr_(v, 30).replace(/[,\s฿]/g, '');
  if (s === '') return '';
  const n = Number(s);
  if (isNaN(n)) throw new Error('จำนวนเงินไม่ถูกต้อง: ' + v);
  return String(Math.round(n * 100) / 100);
}
function flRead_(name, headers) {
  const sh = getSheet_(name, headers);
  const data = sh.getDataRange().getValues();
  const head = data[0].map(k => String(k).trim());
  return { sh: sh, data: data, head: head, h: headerIndex_(head) };
}
function flObj_(row, head) {
  const o = {};
  head.forEach((k, i) => {
    if (!k) return;
    let v = row[i];
    if (v instanceof Date) v = /Date$/.test(k) ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
    o[k] = v === null || v === undefined ? '' : String(v);
  });
  if ('Active' in o) o.Active = o.Active.toUpperCase() !== 'FALSE';
  return o;
}
/** เขียนข้อมูลทั้งตาราง (ยกเว้นหัว) กลับในครั้งเดียว */
function flWriteAll_(t, rows) {
  if (!rows.length) return;
  const width = t.head.length;
  const block = rows.map(r => { const a = r.slice(0, width); while (a.length < width) a.push(''); return a.map(v => v === true ? 'TRUE' : v === false ? 'FALSE' : String(v == null ? '' : v)); });
  const rng = t.sh.getRange(2, 1, block.length, width);
  rng.setNumberFormat('@');
  rng.setValues(block);
}

function followList_(user) {
  const f = flRead_(SHEET_FOLLOW, FOLLOW_HEADERS);
  const follows = [];
  for (let r = 1; r < f.data.length; r++) {
    const o = flObj_(f.data[r], f.head);
    if (o.Code) follows.push(o);
  }
  const l = flRead_(SHEET_FOLLOW_LOG, FOLLOW_LOG_HEADERS);
  const logs = [];
  for (let r = 1; r < l.data.length; r++) {
    const o = flObj_(l.data[r], l.head);
    if (o.LogID && o.Code) logs.push(o);
  }
  return { ok: true, follows: follows, logs: logs, perms: perms_(user.role) };
}

function followSave_(item, isNew, user) {
  if (!perms_(user.role).create) throw new Error('สิทธิ์ของคุณไม่สามารถแก้ไขข้อมูลลูกหนี้ได้');
  item = item || {};
  const code = flStr_(item.Code, 50).toUpperCase();
  if (!code) throw new Error('กรุณากรอกรหัสลูกค้า');
  if (!flStr_(item.CustomerName)) throw new Error('กรุณากรอกชื่อ-สกุล');
  const val = {};
  FOLLOW_EDIT_FIELDS.forEach(k => { val[k] = flStr_(item[k], k === 'Phones' || k === 'Items' || k === 'Remark' ? 2000 : 500); });
  val.DueDate = flDate_(item.DueDate);
  val.Overdue = flMoney_(item.Overdue);
  val.Installment = flMoney_(item.Installment);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = flRead_(SHEET_FOLLOW, FOLLOW_HEADERS), h = t.h;
    let idx = -1;
    for (let r = 1; r < t.data.length; r++) if (String(t.data[r][h.Code]).trim().toUpperCase() === code) { idx = r; break; }
    if (isNew && idx > -1) throw new Error('มีรหัสลูกค้า ' + code + ' อยู่แล้ว');
    if (!isNew && idx < 0) throw new Error('ไม่พบรหัสลูกค้า ' + code);
    const row = idx > -1 ? t.data[idx].slice() : t.head.map(() => '');
    while (row.length < t.head.length) row.push('');
    const set = (k, v) => { if (h[k] !== undefined) row[h[k]] = v; };
    Object.keys(val).forEach(k => set(k, val[k]));
    if (idx < 0) {
      set('Code', code); set('Source', 'manual'); set('Active', 'TRUE');
      set('CreatedBy', user.username); set('UpdatedAt', now_());
    } else {
      if (item.Active === true || item.Active === false) set('Active', item.Active ? 'TRUE' : 'FALSE');
      set('UpdatedBy', user.username); set('UpdatedAt', now_());
    }
    const out = row.map(v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v == null ? '' : v));
    const rn = idx > -1 ? idx + 1 : t.sh.getLastRow() + 1;
    t.sh.getRange(rn, 1, 1, out.length).setNumberFormat('@').setValues([out]);
    return { ok: true, message: idx > -1 ? 'บันทึกข้อมูลลูกค้าเรียบร้อย' : 'เพิ่มลูกค้า ' + code + ' เรียบร้อย' };
  } finally {
    lock.releaseLock();
  }
}

function followLog_(code, entry, user) {
  if (!perms_(user.role).create) throw new Error('สิทธิ์ของคุณไม่สามารถบันทึกการโทรได้');
  entry = entry || {};
  code = flStr_(code, 50).toUpperCase();
  const kind = flStr_(entry.Kind, 30);
  if (!code) throw new Error('ไม่พบรหัสลูกค้า');
  if (FOLLOW_KINDS.indexOf(kind) === -1) throw new Error('ประเภทบันทึกไม่ถูกต้อง: ' + kind);
  const log = {
    LogID: 'L' + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 900 + 100),
    Code: code, Kind: kind,
    LogDate: flDate_(entry.LogDate) || Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'),
    PromiseDate: kind === 'นัดชำระ' ? flDate_(entry.PromiseDate) : '',
    Amount: kind === 'นัดชำระ' || kind === 'ชำระแล้ว' ? flMoney_(entry.Amount) : '',
    Note: flStr_(entry.Note, 1000),
    DocNo: flStr_(entry.DocNo, 50).toUpperCase(),
    Username: user.username, Timestamp: now_()
  };
  if (kind === 'นัดชำระ' && !log.PromiseDate) throw new Error('กรุณาเลือกวันที่นัดชำระ');
  if (kind === 'บันทึก' && !log.Note) throw new Error('กรุณากรอกรายละเอียด');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const f = flRead_(SHEET_FOLLOW, FOLLOW_HEADERS);
    let found = false;
    for (let r = 1; r < f.data.length; r++) if (String(f.data[r][f.h.Code]).trim().toUpperCase() === code) { found = true; break; }
    if (!found) throw new Error('ไม่พบรหัสลูกค้า ' + code + ' ในสมุดติดตาม');
    const t = flRead_(SHEET_FOLLOW_LOG, FOLLOW_LOG_HEADERS);
    const row = t.head.map(k => log.hasOwnProperty(k) ? log[k] : '');
    t.sh.getRange(t.sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    return { ok: true, log: log, message: 'บันทึก “' + kind + '” เรียบร้อย' };
  } finally {
    lock.releaseLock();
  }
}

function followDeleteLog_(logId, user) {
  logId = flStr_(logId, 50);
  if (!logId) throw new Error('ไม่พบบันทึก');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = flRead_(SHEET_FOLLOW_LOG, FOLLOW_LOG_HEADERS);
    for (let r = 1; r < t.data.length; r++) {
      if (String(t.data[r][t.h.LogID]) !== logId) continue;
      const owner = String(t.data[r][t.h.Username]);
      if (!(user.role === 'admin' || (perms_(user.role).create && owner === user.username))) {
        throw new Error('ลบได้เฉพาะบันทึกที่ตนเองบันทึก (admin ลบได้ทั้งหมด)');
      }
      t.sh.deleteRow(r + 1);
      return { ok: true, message: 'ลบบันทึกเรียบร้อย' };
    }
    throw new Error('ไม่พบบันทึก');
  } finally {
    lock.releaseLock();
  }
}

/**
 * นำเข้า/อัปเดตลูกหนี้จาก Excel ECOUNT (หน้าเว็บจับคู่คอลัมน์และรวมรหัสซ้ำให้แล้ว)
 * - รหัสเดิม: อัปเดตเฉพาะช่องที่ไฟล์มีค่า · เบอร์โทรรวมกับที่จดเพิ่มเอง · หมายเหตุและประวัติโทรไม่ถูกแตะ
 * - markMissing: รหัสจาก ECOUNT ที่ไม่มีในไฟล์นี้ → Active = FALSE (เช่น ชำระครบแล้ว)
 */
function followImport_(rows, markMissing, user) {
  if (!perms_(user.role).create) throw new Error('สิทธิ์ของคุณไม่สามารถนำเข้าข้อมูลได้');
  rows = Array.isArray(rows) ? rows : [];
  if (!rows.length) throw new Error('ไม่มีข้อมูลให้นำเข้า');
  if (rows.length > FOLLOW_MAX_IMPORT) throw new Error('นำเข้าได้ครั้งละไม่เกิน ' + FOLLOW_MAX_IMPORT + ' ราย');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const t = flRead_(SHEET_FOLLOW, FOLLOW_HEADERS), h = t.h, width = t.head.length;
    const body = t.data.slice(1).map(r => { const a = r.slice(); while (a.length < width) a.push(''); return a; });
    const idx = {};
    body.forEach((r, i) => { const c = String(r[h.Code]).trim().toUpperCase(); if (c) idx[c] = i; });
    const now = now_(), seen = {};
    let added = 0, updated = 0, bad = 0;

    rows.forEach(src => {
      src = src || {};
      const code = flStr_(src.Code, 50).toUpperCase();
      if (!code || seen[code]) { if (!code) bad++; return; }
      seen[code] = 1;
      const v = {};
      FOLLOW_IMPORT_FIELDS.forEach(k => { v[k] = flStr_(src[k], k === 'Items' ? 2000 : 500); });
      try { v.DueDate = flDate_(src.DueDate); } catch (e) { v.DueDate = ''; }
      try { v.Overdue = flMoney_(src.Overdue); } catch (e) { v.Overdue = ''; }
      try { v.Installment = flMoney_(src.Installment); } catch (e) { v.Installment = ''; }
      const phones = flStr_(src.Phones, 2000).split('\n').map(s => s.trim()).filter(Boolean);

      let i = idx[code];
      if (i === undefined) {
        const r = t.head.map(() => '');
        body.push(r); i = body.length - 1; idx[code] = i; added++;
        r[h.Code] = code; r[h.CreatedBy] = user.username;
      } else updated++;
      const r = body[i];
      Object.keys(v).forEach(k => { if (h[k] !== undefined && v[k] !== '') r[h[k]] = v[k]; });
      const old = String(r[h.Phones] || '').split('\n').map(s => s.trim()).filter(Boolean);
      const digits = s => s.replace(/\D/g, '');
      phones.forEach(p => { if (!old.some(o => digits(o) && digits(o) === digits(p))) old.push(p); });
      r[h.Phones] = old.join('\n');
      const rm = flStr_(src.Remark, 1000);   // คอลัมน์ "โทรนัด"/หมายเหตุ ในไฟล์ → ใส่เฉพาะเมื่อยังว่าง (ไม่ทับที่พิมพ์เอง)
      if (rm && !String(r[h.Remark] || '').trim()) r[h.Remark] = rm;
      r[h.Source] = 'ecount'; r[h.Active] = 'TRUE'; r[h.ImportedAt] = now;
      r[h.UpdatedBy] = user.username; r[h.UpdatedAt] = now;
    });

    let hidden = 0;
    if (markMissing) {
      body.forEach(r => {
        const c = String(r[h.Code]).trim().toUpperCase();
        if (c && !seen[c] && String(r[h.Source]) === 'ecount' && String(r[h.Active]).toUpperCase() !== 'FALSE') { r[h.Active] = 'FALSE'; hidden++; }
      });
    }
    flWriteAll_(t, body.map(r => r.map(x => x instanceof Date ? Utilities.formatDate(x, TZ, 'yyyy-MM-dd') : x)));
    return { ok: true, added: added, updated: updated, hidden: hidden,
      message: 'นำเข้า ' + (added + updated) + ' ราย (ใหม่ ' + added + ' · อัปเดต ' + updated + ')' +
        (hidden ? ' · ย้าย ' + hidden + ' รายที่ไม่อยู่ในไฟล์ไปไว้ “ไม่อยู่ในรายงานล่าสุด”' : '') + (bad ? ' · ข้าม ' + bad + ' แถวไม่มีรหัส' : '') };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- BigQuery: ยอดขาย ECOUNT (อ่านอย่างเดียว) ---------------- */

function bqReady_() {
  return !!(BQ_PROJECT && BQ_DATASET && typeof BigQuery !== 'undefined');
}
function bqInfo_() {
  return { ok: true, ready: bqReady_(), project: BQ_PROJECT, dataset: BQ_DATASET, table: BQ_SALES_TABLE };
}
function bqRequire_() {
  if (!BQ_PROJECT || !BQ_DATASET) throw new Error('ยังไม่ได้ตั้งค่า BQ_PROJECT / BQ_DATASET ใน Code.js');
  if (typeof BigQuery === 'undefined') throw new Error('ยังไม่ได้เพิ่ม Service “BigQuery API” ใน Apps Script');
}
/** หาชื่อคอลัมน์ในตาราง sales_transactions (รองรับชื่อไทย/อังกฤษ) */
function bqCols_() {
  const cache = CacheService.getScriptCache(), key = 'bqcols_' + BQ_PROJECT + BQ_DATASET + BQ_SALES_TABLE;
  let names = null;
  const c = cache.get(key);
  if (c) names = JSON.parse(c);
  else {
    const tb = BigQuery.Tables.get(BQ_PROJECT, BQ_DATASET, BQ_SALES_TABLE);
    names = ((tb.schema && tb.schema.fields) || []).map(f => f.name);
    cache.put(key, JSON.stringify(names), 21600);
  }
  const pick = res => { for (const re of res) { const n = names.find(x => re.test(x)); if (n) return n; } return ''; };
  return {
    all: names,
    code: pick([/^(customer|cust|client)_?(code|id|no)$/i, /รหัส.*ลูกค้า/, /(customer|cust).*(code|id)/i]),
    name: pick([/^(customer|cust|client)_?name$/i, /ชื่อ.*ลูกค้า/, /(customer|cust).*name/i]),
    date: pick([/^(sale|tx|doc|invoice|trans(action)?)?_?date$/i, /^วันที่$/, /date/i]),
    item: pick([/^(product|item)_?name$/i, /ชื่อสินค้า/, /(product|item|model)/i, /description/i]),
    serial: pick([/serial/i, /lot/i, /หมายเลข.*(เครื่อง|serial)/i]),
    addr: pick([/^address$/i, /ที่อยู่/, /address/i])
  };
}
function bqQuery_(sql, params) {
  const req = { query: sql, useLegacySql: false, timeoutMs: 30000, parameterMode: 'NAMED', queryParameters: params || [] };
  let res = BigQuery.Jobs.query(req, BQ_PROJECT);
  const jobId = res.jobReference.jobId, loc = res.jobReference.location;
  let wait = 0;
  while (!res.jobComplete && wait < 20) { Utilities.sleep(1000); wait++; res = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { location: loc }); }
  if (!res.jobComplete) throw new Error('BigQuery ใช้เวลานานเกินไป ลองใหม่อีกครั้ง');
  const fields = ((res.schema && res.schema.fields) || []).map(f => f.name);
  let rows = res.rows || [];
  let token = res.pageToken;
  while (token && rows.length < 20000) {
    const p = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { pageToken: token, location: loc });
    rows = rows.concat(p.rows || []); token = p.pageToken;
  }
  return { fields: fields, rows: rows.map(r => { const o = {}; fields.forEach((f, i) => { const v = r.f[i].v; o[f] = v === null || v === undefined ? '' : String(v); }); return o; }) };
}
const bqQ_ = n => '`' + String(n).replace(/`/g, '') + '`';
function bqTable_() { return '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + BQ_SALES_TABLE + '`'; }

/** ประวัติซื้อ 3 ปีล่าสุด: จับคู่ด้วยรหัสลูกค้าก่อน ไม่พบจึงใช้ชื่อ */
function bqSales_(code, name) {
  bqRequire_();
  const c = bqCols_();
  if (!c.code && !c.name) throw new Error('ไม่พบคอลัมน์รหัส/ชื่อลูกค้าในตาราง ' + BQ_SALES_TABLE);
  const order = c.date ? ' ORDER BY CAST(' + bqQ_(c.date) + ' AS STRING) DESC' : '';
  const s = v => ({ parameterType: { type: 'STRING' }, parameterValue: { value: String(v) } });
  let out = { fields: [], rows: [] }, by = '';
  code = flStr_(code, 50).toUpperCase(); name = flStr_(name, 200);
  if (c.code && code) {
    out = bqQuery_('SELECT * FROM ' + bqTable_() + ' WHERE UPPER(TRIM(CAST(' + bqQ_(c.code) + ' AS STRING))) = @code' + order + ' LIMIT 500',
      [Object.assign({ name: 'code' }, s(code))]);
    by = 'code';
  }
  if (!out.rows.length && c.name && name) {
    out = bqQuery_('SELECT * FROM ' + bqTable_() + ' WHERE TRIM(CAST(' + bqQ_(c.name) + ' AS STRING)) = @name' + order + ' LIMIT 500',
      [Object.assign({ name: 'name' }, s(name))]);
    by = 'name';
  }
  // ย้อนหลัง 3 ปี (กรองฝั่งสคริปต์ — รองรับวันที่ทั้งแบบ DATE, 'yyyy-mm-dd' และ 'yyyymmdd')
  if (c.date) {
    const from = Utilities.formatDate(new Date(Date.now() - 3 * 365.25 * 864e5), TZ, 'yyyyMMdd');
    out.rows = out.rows.filter(o => { const d = String(o[c.date]).replace(/\D/g, '').slice(0, 8); return d.length < 8 || d >= from; });
  }
  return { ok: true, fields: out.fields, rows: out.rows, matchedBy: by };
}

/** เติม สินค้า/รุ่น · หมายเลขเครื่อง · ที่อยู่ ให้ลูกหนี้ที่ช่องยังว่าง จากรายการขายล่าสุดของรหัสนั้น */
function bqEnrich_(admin) {
  bqRequire_();
  const c = bqCols_();
  if (!c.code) throw new Error('ไม่พบคอลัมน์รหัสลูกค้าในตาราง ' + BQ_SALES_TABLE);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const t = flRead_(SHEET_FOLLOW, FOLLOW_HEADERS), h = t.h, width = t.head.length;
    const body = t.data.slice(1).map(r => { const a = r.slice(); while (a.length < width) a.push(''); return a; });
    const need = body.filter(r => r[h.Code] && (!String(r[h.Items]).trim() || !String(r[h.SerialNo]).trim() || !String(r[h.Address]).trim()));
    if (!need.length) return { ok: true, message: 'ลูกหนี้ทุกรายมีข้อมูลครบแล้ว' };
    const codes = need.map(r => String(r[h.Code]).trim().toUpperCase()).slice(0, 5000);
    const sel = [c.code, c.item, c.serial, c.addr, c.date].filter(Boolean).map(bqQ_).join(', ');
    const res = bqQuery_('SELECT ' + sel + ' FROM ' + bqTable_() + ' WHERE UPPER(TRIM(CAST(' + bqQ_(c.code) + ' AS STRING))) IN UNNEST(@codes)' +
      (c.date ? ' ORDER BY CAST(' + bqQ_(c.date) + ' AS STRING) DESC' : ''),
      [{ name: 'codes', parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: codes.map(v => ({ value: v })) } }]);
    const latest = {};
    res.rows.forEach(o => { const k = String(o[c.code]).trim().toUpperCase(); if (!latest[k]) latest[k] = o; });
    let filled = 0;
    need.forEach(r => {
      const o = latest[String(r[h.Code]).trim().toUpperCase()];
      if (!o) return;
      let any = false;
      const fill = (k, col) => { if (col && !String(r[h[k]]).trim() && String(o[col] || '').trim()) { r[h[k]] = String(o[col]).trim(); any = true; } };
      fill('Items', c.item); fill('SerialNo', c.serial); fill('Address', c.addr);
      if (any) { filled++; r[h.UpdatedBy] = admin.username; r[h.UpdatedAt] = now_(); }
    });
    if (filled) flWriteAll_(t, body.map(r => r.map(x => x instanceof Date ? Utilities.formatDate(x, TZ, 'yyyy-MM-dd') : x)));
    return { ok: true, message: 'เติมข้อมูลจาก BigQuery ให้ ' + filled + ' ราย (จาก ' + need.length + ' รายที่ข้อมูลยังไม่ครบ)' };
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
  getSheet_(SHEET_EC_BATCH, EC_BATCH_HEADERS).getRange('A:G').setNumberFormat('@');
  getSheet_(SHEET_EC_ROWS, EC_ROW_HEADERS).getRange('A:E').setNumberFormat('@');
  getSheet_(SHEET_FOLLOW, FOLLOW_HEADERS).getRange('A:V').setNumberFormat('@');
  getSheet_(SHEET_FOLLOW_LOG, FOLLOW_LOG_HEADERS).getRange('A:J').setNumberFormat('@');
  Logger.log('ตั้งค่าชีตเรียบร้อย — อย่าลืมเปลี่ยนรหัสผ่านเริ่มต้นในชีต Users');
} 