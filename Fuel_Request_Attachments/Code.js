/**
 * RST-FUEL : ระบบบันทึกขอเติมน้ำมันสาขา & สถิติการเดินรถ
 * Backend : Google Apps Script (Web App) + Google Sheets + Google Drive
 * Dev: tana.pittayatanadol
 *
 * CODE_VERSION: r06-2026-11-20-two-level-approval-billing
 *
 * ─────────────────────────────────────────────────────────────
 * ① จุดที่ต้องตั้งค่า
 * ─────────────────────────────────────────────────────────────
 *  DRIVE_FOLDER_ID : ID ของโฟลเดอร์ Google Drive สำหรับเก็บรูปหลักฐาน
 *                    มาจาก URL https://drive.google.com/drive/folders/<<ID ตรงนี้>>
 *  SPREADSHEET_ID  : ID ของ Google Sheets
 *                    มาจาก URL https://docs.google.com/spreadsheets/d/<<ID ตรงนี้>>/edit
 *  APP_URL         : ลิงก์หน้าเว็บที่แนบในอีเมลแจ้งผู้อนุมัติ (เว้นว่าง = URL /exec ของ Web App นี้)
 *
 * ② ผู้ใช้เริ่มต้น (สร้างโดยฟังก์ชัน setup) : admin / admin1234  → เข้าระบบแล้วเปลี่ยนรหัสผ่านทันที
 */
const CODE_VERSION    = 'r06-2026-11-20-two-level-approval-billing';
const DRIVE_FOLDER_ID = '1KOthLdot3HMDwBxash_G3nMOKpaPd6P0'; // โฟลเดอร์ Fuel_Request_Attachments
const SPREADSHEET_ID  = '13R0CkQ8LItQ4UpiMVEyoZ_nifBc1NSxkPgJ0cp5EWmM'; // ชีต RST-FUEL Database
const APP_URL         = '';
const NOTIFY_EMAIL    = true;   // ส่งอีเมลแจ้งผู้อนุมัติเมื่อมีคำขอใหม่

const SHEET_DATA   = 'FuelRequests';
const SHEET_CONFIG = 'Config';
const SHEET_USERS  = 'Users';
const TZ           = 'Asia/Bangkok';
const MAX_FILE_MB  = 8;
const SESSION_SECONDS = 6 * 60 * 60;   // อายุการล็อกอิน 6 ชั่วโมง (สูงสุดของ CacheService)

/* ─────────── สถานะคำขอ (flow) ───────────
 *  สาขาส่งคำขอ → [S_L1] ขั้นที่ 1 ตรวจสอบ+ระบุลิตร/ระดับน้ำมัน → [S_L2] ผู้อนุมัติสูงสุดเซ็น
 *  → [S_OK] สาขาเข้าเติมได้ → สาขาบันทึกลิตร/ยอดเงิน/บิล → [S_DONE]      (ปฏิเสธได้ทุกขั้น → [S_NO]) */
const S_L1   = 'รออนุมัติขั้นที่ 1';
const S_L2   = 'รออนุมัติขั้นสุดท้าย';
const S_OK   = 'อนุมัติแล้ว รอเติม';
const S_DONE = 'เติมแล้ว';
const S_NO   = 'ไม่อนุมัติ';
const LEGACY_STATUS = { 'รออนุมัติ': S_L1, 'อนุมัติ': S_OK };   // ข้อมูลจากเวอร์ชันก่อน

const FUEL_TYPES  = ['ดีเซล', 'แก๊สโซฮอล์'];               // แก้/เพิ่มได้ในชีต Config คอลัมน์หัว "FuelTypes"
const TANK_LEVELS = ['ขีดแดง', '1/4', '1/2', '3/4', 'เต็มถัง'];

/* ─────────── สิทธิ์ (RBAC) ─────────── */
const ROLES = ['admin', 'reviewer', 'approver', 'branch'];
const ROLE_LABEL = { admin: 'ผู้ดูแลระบบ', reviewer: 'ผู้อนุมัติขั้นที่ 1', approver: 'ผู้อนุมัติสูงสุด', branch: 'ผู้ใช้สาขา' };
const REVIEW_ROLES  = ['admin', 'reviewer'];   // อนุมัติขั้นที่ 1 (ระบุลิตร + ระดับน้ำมัน)
const APPROVE_ROLES = ['admin', 'approver'];   // อนุมัติขั้นสุดท้าย (เซ็นอนุมัติ)
const FILL_ROLES    = ['admin', 'branch'];     // บันทึกผลการเติม
const MEMBER_ROLES  = ['admin'];               // เพิ่ม/ลบ/แก้ไขสมาชิก

/** หัวตารางคำขอ (ลำดับต้องตรงกับ buildRow_ และ rowToObj_) */
const HEADERS = [
  'Timestamp',            // A  เวลาที่บันทึก
  'RefID',                // B  รหัสอ้างอิง FUEL-YYYYMMDD-####
  'RequestDate',          // C  วันที่ขอเติมน้ำมัน
  'Branch',               // D  สาขา
  'DriverName',           // E  ชื่อผู้ขับ
  'RecorderName',         // F  ชื่อผู้ลงข้อมูล
  'MileageBefore',        // G  เลขไมล์ก่อนเติม
  'LicensePlate',         // H  ทะเบียนรถ (หรือ "อื่นๆ")
  'LicensePlateOther',    // I  ทะเบียนรถอื่นๆ
  'GallonPurpose',        // J  กรณีนำแกลลอนไปเติม
  'MainDestination',      // K  จุดหมายหลัก
  'Destination1', 'Destination2', 'Destination3', 'Destination4',   // L–O
  'Destination5', 'Destination6', 'Destination7', 'Destination8',   // P–S
  'TotalDistanceKm',      // T  ระยะทางรวม (กม.)
  'MileagePhotoURL',      // U  ลิงก์รูปเลขไมล์
  'ReceiptPhotoURL',      // V  ลิงก์รูปบิล
  'Vehicle',              // W  ทะเบียนที่ใช้จริง
  'Status',               // X  รออนุมัติ / อนุมัติ / ไม่อนุมัติ
  'ApproverName',         // Y  ชื่อผู้อนุมัติ
  'ApprovedAt',           // Z  วันเวลาที่พิจารณา
  'ApprovalNote',         // AA หมายเหตุ / เหตุผล
  'SignatureURL',         // AB ลิงก์ลายเซ็นผู้อนุมัติสูงสุด
  'CreatedBy',            // AC username ผู้ส่งคำขอ
  'FuelType',             // AD ประเภทน้ำมัน
  'Origin',               // AE ต้นทาง
  'RequesterSignatureURL',// AF ลายเซ็นผู้ขอ
  'ReviewerName',         // AG ผู้อนุมัติขั้นที่ 1
  'ReviewedAt',           // AH วันเวลาอนุมัติขั้นที่ 1
  'ApprovedLiters',       // AI จำนวนลิตรที่อนุมัติให้เติม
  'TankLevel',            // AJ ระดับน้ำมันในถังก่อนเติม
  'ReviewerSignatureURL', // AK ลายเซ็นผู้อนุมัติขั้นที่ 1
  'ReviewNote',           // AL หมายเหตุขั้นที่ 1
  'FilledDate',           // AM วันที่เติมจริง
  'FilledLiters',         // AN ลิตรที่เติมจริง
  'FilledAmount',         // AO ยอดเงิน (บาท)
  'PricePerLiter',        // AP ราคาต่อลิตร (คำนวณ)
  'FilledBy',             // AQ username ผู้บันทึกผลการเติม
  'FilledAt'              // AR เวลาบันทึกผลการเติม
];
const COL = {}; HEADERS.forEach((h, i) => COL[h] = i + 1);

/** หัวตารางสมาชิก */
const USER_HEADERS = ['Username', 'FullName', 'Role', 'Branches', 'Email', 'Active', 'PasswordHash', 'Salt', 'MustChangePassword', 'CreatedAt', 'UpdatedAt', 'LastLogin'];
const UCOL = {}; USER_HEADERS.forEach((h, i) => UCOL[h] = i + 1);

const DEFAULT_BRANCHES = ['สำนักงานใหญ่อุบลราชธานี', 'เดชอุดม', 'ขุขันธ์', 'เบญจลักษ์', 'ศรีสะเกษ', 'ตระการพืชผล', 'ศรีเมืองใหม่', 'กุฉินารายณ์', 'อำนาจเจริญ'];
const DEFAULT_PLATES = ['ผธ9412อบ', 'ผน1056อบ', 'ผบ4158อบ', 'ผบ122อบ', 'ผค7701อบ', 'ผพ2961อบ', 'ผบ5053อบ', 'ผบ2961อบ', 'ผบ2960อบ', 'ผน3524อบ', 'บว5797อบ', 'ผธ8867อบ', 'บธ5829อบ', '81-4331 (รถหกล้อ)', '82-7430 (รถหกล้อ)', '83-9399 (รถหกล้อ)', '84-3992 (รถหกล้อ)'];

/* ═════════════════════ ENTRY POINTS ═════════════════════ */

/**
 * GET (ไม่มี action)     → หน้าเว็บ RST-FUEL (ไฟล์ Index.html ในโปรเจกต์ Apps Script)
 * GET ?action=checkStatus → ตรวจเวอร์ชันโค้ดที่ deploy อยู่
 * ข้อมูลอื่นทั้งหมดต้องเรียกผ่าน POST พร้อม token
 */
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (!action) {
    let page;
    try { page = HtmlService.createHtmlOutputFromFile('Index'); }
    catch (_) { page = HtmlService.createHtmlOutputFromFile('index'); }
    return page.setTitle('RST-FUEL | ระบบบันทึกขอเติมน้ำมันสาขา')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')   // viewport-fit=cover: เมนูล่างหลบขอบ iPhone
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  if (action === 'checkStatus') return json_({ ok: true, data: { codeVersion: CODE_VERSION, time: new Date().toISOString() } });
  return json_({ ok: false, error: 'กรุณาเรียกผ่าน POST' });
}

/** POST body (Content-Type: text/plain): { action, token, ... } */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_({ ok: true, data: route_(body) });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err), code: err.code || '' });
  }
}

/** เรียกจากหน้าเว็บที่โฮสต์บน Apps Script ผ่าน google.script.run */
function apiPost(body) {
  try { return { ok: true, data: route_(body || {}) }; }
  catch (err) { return { ok: false, error: String(err.message || err), code: err.code || '' }; }
}

function route_(body) {
  const action = body.action;
  if (action === 'login') return login_(body.username, body.password);
  if (action === 'checkStatus') return { codeVersion: CODE_VERSION };

  const user = requireUser_(body.token);
  switch (action) {
    case 'logout':         CacheService.getScriptCache().remove('sess_' + body.token); return { done: true };
    case 'me':             return publicUser_(user);
    case 'changePassword': return changePassword_(user, body.oldPassword, body.newPassword);
    case 'all': {
      const records = scopeRecords_(user, getRecords_());
      return { config: getConfig_(), records: records, stats: buildStats_(records), me: publicUser_(user) };
    }
    case 'signature':      return getSignature_(user, body.refId, body.kind);
    case 'create':         return handleCreate_(user, body);
    case 'review':         requireRole_(user, REVIEW_ROLES); return handleReview_(user, body);
    case 'decide':         requireRole_(user, APPROVE_ROLES); return handleDecide_(user, body);
    case 'fill':           requireRole_(user, FILL_ROLES); return handleFill_(user, body);
    case 'listUsers':      requireRole_(user, MEMBER_ROLES); return listUsers_();
    case 'saveUser':       requireRole_(user, MEMBER_ROLES); return saveUser_(user, body.user || {});
    case 'deleteUser':     requireRole_(user, MEMBER_ROLES); return deleteUser_(user, body.username);
    default: throw new Error('Unknown action: ' + action);
  }
}

/* ═════════════════════ AUTH ═════════════════════ */

function authError_(msg) { const e = new Error(msg); e.code = 'AUTH'; return e; }

function hash_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + password, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function login_(username, password) {
  username = str_(username, 50).toLowerCase(); password = String(password || '');
  if (!username || !password) throw new Error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
  const cache = CacheService.getScriptCache();
  const failKey = 'loginfail_' + Utilities.base64EncodeWebSafe(username);
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('เข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาที');

  const found = findUser_(username);
  if (!found || found.user.active !== true || hash_(password, found.raw[UCOL.Salt - 1]) !== found.raw[UCOL.PasswordHash - 1]) {
    cache.put(failKey, String(fails + 1), 900);
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  cache.remove(failKey);
  const token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  cache.put('sess_' + token, username, SESSION_SECONDS);
  try { usersSheet_().getRange(found.row, UCOL.LastLogin).setValue(new Date()); } catch (_) {}
  return { token: token, user: publicUser_(found.user) };
}

function requireUser_(token) {
  if (!token) throw authError_('กรุณาเข้าสู่ระบบ');
  const cache = CacheService.getScriptCache();
  const username = cache.get('sess_' + token);
  if (!username) throw authError_('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่');
  const found = findUser_(username);
  if (!found || found.user.active !== true) { cache.remove('sess_' + token); throw authError_('บัญชีถูกปิดการใช้งาน'); }
  cache.put('sess_' + token, username, SESSION_SECONDS); // ต่ออายุ session
  return found.user;
}

function requireRole_(user, roles) {
  if (roles.indexOf(user.role) < 0) throw new Error('คุณไม่มีสิทธิ์ใช้งานส่วนนี้');
}

/** สาขาที่ผู้ใช้เห็น/จัดการได้ (null = ทุกสาขา) */
function userBranches_(user) {
  if (user.role === 'admin') return null;
  return user.branches.length ? user.branches : (user.role === 'approver' || user.role === 'reviewer' ? null : []);
}
function canBranch_(user, branch) { const b = userBranches_(user); return !b || b.indexOf(branch) >= 0; }

function changePassword_(user, oldPw, newPw) {
  const found = findUser_(user.username);
  if (hash_(String(oldPw || ''), found.raw[UCOL.Salt - 1]) !== found.raw[UCOL.PasswordHash - 1]) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  checkPasswordPolicy_(newPw);
  const salt = Utilities.getUuid();
  const sh = usersSheet_();
  sh.getRange(found.row, UCOL.PasswordHash, 1, 3).setValues([[hash_(String(newPw), salt), salt, false]]);
  sh.getRange(found.row, UCOL.UpdatedAt).setValue(new Date());
  return { done: true };
}

function checkPasswordPolicy_(pw) {
  pw = String(pw || '');
  if (pw.length < 6) throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
}

/* ═════════════════════ USERS (สมาชิก) ═════════════════════ */

function usersSheet_() {
  const ss = getSS_();
  let sh = ss.getSheetByName(SHEET_USERS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_USERS);
    sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS])
      .setFontWeight('bold').setBackground('#171717').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
  }
  return sh;
}

function rowToUser_(r) {
  return {
    username: String(r[UCOL.Username - 1]).trim().toLowerCase(),
    fullName: String(r[UCOL.FullName - 1] || ''),
    role: ROLES.indexOf(String(r[UCOL.Role - 1])) >= 0 ? String(r[UCOL.Role - 1]) : 'branch',
    branches: String(r[UCOL.Branches - 1] || '').split(',').map(s => s.trim()).filter(Boolean),
    email: String(r[UCOL.Email - 1] || ''),
    active: r[UCOL.Active - 1] === true || String(r[UCOL.Active - 1]).toUpperCase() === 'TRUE',
    mustChangePassword: r[UCOL.MustChangePassword - 1] === true || String(r[UCOL.MustChangePassword - 1]).toUpperCase() === 'TRUE',
    createdAt: fmtTs_(r[UCOL.CreatedAt - 1]),
    updatedAt: fmtTs_(r[UCOL.UpdatedAt - 1]),
    lastLogin: fmtTs_(r[UCOL.LastLogin - 1])
  };
}

function publicUser_(u) {
  return { username: u.username, fullName: u.fullName, role: u.role, roleLabel: ROLE_LABEL[u.role],
           branches: u.branches, email: u.email, mustChangePassword: u.mustChangePassword };
}

function allUsers_() {
  const sh = usersSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, USER_HEADERS.length).getValues()
    .map((r, i) => ({ row: i + 2, raw: r, user: rowToUser_(r) }))
    .filter(x => x.user.username);
}

function findUser_(username) {
  username = String(username || '').trim().toLowerCase();
  return allUsers_().find(x => x.user.username === username) || null;
}

function listUsers_() {
  return allUsers_().map(x => {
    const u = x.user;
    return { username: u.username, fullName: u.fullName, role: u.role, branches: u.branches, email: u.email,
             active: u.active, mustChangePassword: u.mustChangePassword, createdAt: u.createdAt, lastLogin: u.lastLogin };
  });
}

/** เพิ่ม (isNew=true) หรือแก้ไขสมาชิก */
function saveUser_(admin, u) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const username = str_(u.username, 50).toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - ยาว 3–30 ตัว');
    const role = ROLES.indexOf(u.role) >= 0 ? u.role : '';
    if (!role) throw new Error('กรุณาเลือกบทบาท');
    const fullName = str_(u.fullName, 100);
    if (!fullName) throw new Error('กรุณากรอกชื่อ-นามสกุล');
    const validBranches = getConfig_().branches;
    const branches = (Array.isArray(u.branches) ? u.branches : []).map(b => str_(b, 100)).filter(b => validBranches.indexOf(b) >= 0);
    if (role === 'branch' && !branches.length) throw new Error('ผู้ใช้สาขาต้องเลือกอย่างน้อย 1 สาขา');
    const email = str_(u.email, 120);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('รูปแบบอีเมลไม่ถูกต้อง');
    const active = u.active !== false;

    const sh = usersSheet_();
    const found = findUser_(username);
    const now = new Date();

    if (u.isNew) {
      if (found) throw new Error('มีชื่อผู้ใช้ "' + username + '" อยู่แล้ว');
      checkPasswordPolicy_(u.password);
      const salt = Utilities.getUuid();
      sh.appendRow([username, fullName, role, branches.join(', '), email, active, hash_(String(u.password), salt), salt, true, now, now, '']);
    } else {
      if (!found) throw new Error('ไม่พบผู้ใช้ ' + username);
      if (username === admin.username && (role !== 'admin' || !active)) throw new Error('ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้');
      if (found.user.role === 'admin' && (role !== 'admin' || !active)) ensureAnotherAdmin_(username);
      sh.getRange(found.row, UCOL.FullName, 1, 5).setValues([[fullName, role, branches.join(', '), email, active]]);
      sh.getRange(found.row, UCOL.UpdatedAt).setValue(now);
      if (u.password) {
        checkPasswordPolicy_(u.password);
        const salt = Utilities.getUuid();
        sh.getRange(found.row, UCOL.PasswordHash, 1, 3).setValues([[hash_(String(u.password), salt), salt, true]]);
      }
    }
    return listUsers_();
  } finally { lock.releaseLock(); }
}

function deleteUser_(admin, username) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    username = String(username || '').toLowerCase();
    if (username === admin.username) throw new Error('ไม่สามารถลบบัญชีของตัวเองได้');
    const found = findUser_(username);
    if (!found) throw new Error('ไม่พบผู้ใช้ ' + username);
    if (found.user.role === 'admin') ensureAnotherAdmin_(username);
    usersSheet_().deleteRow(found.row);
    return listUsers_();
  } finally { lock.releaseLock(); }
}

function ensureAnotherAdmin_(exceptUsername) {
  const others = allUsers_().filter(x => x.user.role === 'admin' && x.user.active && x.user.username !== exceptUsername);
  if (!others.length) throw new Error('ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คน');
}

/* ═════════════════════ SETUP (รันใน Editor) ═════════════════════ */

/** รันครั้งแรก และทุกครั้งหลังอัปเดตโค้ด: สร้าง/อัปเกรดชีต, สร้าง admin เริ่มต้น, ขอสิทธิ์ Drive/อีเมล */
function setup() {
  const ss = getSS_();
  getDataSheet_();

  let cfg = ss.getSheetByName(SHEET_CONFIG);
  if (!cfg) {
    cfg = ss.insertSheet(SHEET_CONFIG);
    cfg.getRange(1, 1, 1, 2).setValues([['Branches', 'LicensePlates']]).setFontWeight('bold');
    const n = Math.max(DEFAULT_BRANCHES.length, DEFAULT_PLATES.length);
    const rows = [];
    for (let i = 0; i < n; i++) rows.push([DEFAULT_BRANCHES[i] || '', DEFAULT_PLATES[i] || '']);
    cfg.getRange(2, 1, n, 2).setValues(rows);
    cfg.setFrozenRows(1);
  }

  const head = cfg.getRange(1, 1, 1, Math.max(1, cfg.getLastColumn())).getDisplayValues()[0];
  if (head.indexOf('FuelTypes') < 0) {
    const c = cfg.getLastColumn() + 1;
    cfg.getRange(1, c).setValue('FuelTypes').setFontWeight('bold');
    cfg.getRange(2, c, FUEL_TYPES.length, 1).setValues(FUEL_TYPES.map(f => [f]));
  }

  usersSheet_();
  if (!allUsers_().some(x => x.user.role === 'admin')) {
    const salt = Utilities.getUuid(), now = new Date();
    usersSheet_().appendRow(['admin', 'ผู้ดูแลระบบ', 'admin', '', '', true, hash_('admin1234', salt), salt, true, now, now, '']);
    Logger.log('สร้างผู้ใช้ admin / admin1234 แล้ว — เข้าระบบแล้วเปลี่ยนรหัสผ่านทันที');
  }
  DriveApp.getFolderById(DRIVE_FOLDER_ID).getName();   // ขอสิทธิ์ Drive
  if (NOTIFY_EMAIL) MailApp.getRemainingDailyQuota();   // ขอสิทธิ์ส่งอีเมล
  Logger.log('Setup เรียบร้อย (' + CODE_VERSION + '): ' + ss.getUrl());
}

/* ═════════════════════ REQUESTS ═════════════════════ */

function handleCreate_(user, body) {
  const p = validate_(body.payload || {});
  if (!canBranch_(user, p.branch)) throw new Error('คุณไม่มีสิทธิ์ส่งคำขอของสาขา ' + p.branch);
  const files = body.files || {};
  if (!files.mileage) throw new Error('กรุณาแนบรูปเข็มไมล์');
  const sig = parseSignature_(body.signature);
  if (!sig) throw new Error('กรุณาลงชื่อผู้ขอ (เซ็นชื่อ)');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let row, refId;
  try {
    const sheet = getDataSheet_();
    refId = nextRefId_(sheet);
    const mileageUrl = saveFile_(files.mileage, refId + '_mileage', p.requestDate);
    const receiptUrl = files.receipt ? saveFile_(files.receipt, refId + '_receipt', p.requestDate) : '';
    const sigUrl = saveFile_(sig, refId + '_sig_requester', p.requestDate);
    row = buildRow_(refId, p, mileageUrl, receiptUrl, user.username, sigUrl);
    sheet.appendRow(row);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  const r = rowToObj_(row);
  notify_(usersFor_(['reviewer'], r.branch), r, 'คำขอเติมน้ำมันใหม่ รออนุมัติขั้นที่ 1', 'เปิดหน้าอนุมัติ', '#approve');
  return { refId: refId, status: S_L1 };
}

/** โหลดแถวคำขอ + ตรวจสถานะ/สาขา (ใช้ภายใต้ lock) */
function loadRequest_(sh, user, refId, expectStatus) {
  const rowNo = findRowByRef_(sh, refId);
  if (!rowNo) throw new Error('ไม่พบรายการ ' + refId);
  const cur = sh.getRange(rowNo, 1, 1, HEADERS.length).getValues()[0];
  const rec = rowToObj_(cur);
  if (rec.status !== expectStatus) throw new Error('รายการนี้อยู่ในสถานะ "' + rec.status + '" แล้ว');
  if (!canBranch_(user, rec.branch)) throw new Error('คุณไม่มีสิทธิ์ในสาขา ' + rec.branch);
  return { rowNo: rowNo, rec: rec };
}

function parseSignature_(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/png|image\/jpeg);base64,(.+)$/);
  return m ? { name: 'sig.png', mimeType: m[1], data: m[2] } : null;
}

function setCols_(sh, rowNo, obj) {
  Object.keys(obj).forEach(k => sh.getRange(rowNo, COL[k]).setValue(obj[k]));
}

/** ขั้นที่ 1: ตรวจสอบ + ระบุจำนวนลิตรที่ให้เติม + ระดับน้ำมันในถัง */
function handleReview_(user, body) {
  const refId = str_(body.refId, 40);
  const approve = body.decision === 'approve';
  const note = str_(body.note, 500);
  const liters = Number(body.liters);
  const tank = str_(body.tankLevel, 20);
  if (!approve && !note) throw new Error('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
  if (approve && !(liters > 0 && liters <= 2000)) throw new Error('กรุณาระบุจำนวนลิตรที่อนุมัติให้เติม');
  if (approve && TANK_LEVELS.indexOf(tank) < 0) throw new Error('กรุณาเลือกระดับน้ำมันในถัง');
  const sig = parseSignature_(body.signature);
  if (approve && !sig) throw new Error('กรุณาเซ็นชื่อก่อนอนุมัติ');

  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  let rec;
  try {
    const sh = getDataSheet_();
    const x = loadRequest_(sh, user, refId, S_L1); rec = x.rec;
    const sigUrl = sig ? saveFile_(sig, refId + '_sig_reviewer', rec.requestDate) : '';
    const name = user.fullName || user.username, now = new Date();
    setCols_(sh, x.rowNo, {
      Status: approve ? S_L2 : S_NO, ReviewerName: name, ReviewedAt: now, ReviewNote: note, ReviewerSignatureURL: sigUrl,
      ApprovedLiters: approve ? liters : '', TankLevel: approve ? tank : ''
    });
    SpreadsheetApp.flush();
    Object.assign(rec, { status: approve ? S_L2 : S_NO, reviewerName: name, reviewedAt: fmtTs_(now), reviewNote: note,
      approvedLiters: approve ? liters : 0, tankLevel: approve ? tank : '', hasReviewerSignature: !!sigUrl });
  } finally { lock.releaseLock(); }

  if (approve) notify_(usersFor_(['approver'], rec.branch), rec, 'รออนุมัติขั้นสุดท้าย (ผ่านขั้นที่ 1 แล้ว · ' + rec.approvedLiters + ' ลิตร)', 'เปิดหน้าอนุมัติ', '#approve');
  else notify_(requesterEmails_(rec), rec, 'คำขอไม่ได้รับอนุมัติ (ขั้นที่ 1): ' + note, 'ดูรายละเอียด', '#track');
  return rec;
}

/** ขั้นสุดท้าย: ผู้อนุมัติสูงสุดเซ็นอนุมัติ → สาขาเข้าเติมได้ */
function handleDecide_(user, body) {
  const refId = str_(body.refId, 40);
  const approve = body.decision === 'approve';
  const note = str_(body.note, 500);
  if (!approve && !note) throw new Error('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
  const sig = parseSignature_(body.signature);
  if (approve && !sig) throw new Error('กรุณาเซ็นชื่อก่อนอนุมัติ');

  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  let rec;
  try {
    const sh = getDataSheet_();
    const x = loadRequest_(sh, user, refId, S_L2); rec = x.rec;
    const sigUrl = sig ? saveFile_(sig, refId + '_sig_approver', rec.requestDate) : '';
    const name = user.fullName || user.username, now = new Date();
    setCols_(sh, x.rowNo, { Status: approve ? S_OK : S_NO, ApproverName: name, ApprovedAt: now, ApprovalNote: note, SignatureURL: sigUrl });
    SpreadsheetApp.flush();
    Object.assign(rec, { status: approve ? S_OK : S_NO, approverName: name, approvedAt: fmtTs_(now), approvalNote: note, hasSignature: !!sigUrl });
  } finally { lock.releaseLock(); }

  notify_(requesterEmails_(rec), rec, approve ? 'อนุมัติแล้ว — สาขาเข้าเติมน้ำมันได้ไม่เกิน ' + rec.approvedLiters + ' ลิตร' : 'คำขอไม่ได้รับอนุมัติ: ' + note, 'เปิดใบอนุมัติ', '#track');
  return rec;
}

/** สาขาบันทึกผลการเติมจริง: วันที่ ลิตร ยอดเงิน รูปบิล */
function handleFill_(user, body) {
  const refId = str_(body.refId, 40);
  const date = str_(body.filledDate, 10);
  const liters = Math.round(Number(body.liters) * 100) / 100;
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('กรุณาระบุวันที่เติม');
  if (!(liters > 0)) throw new Error('กรุณาระบุจำนวนลิตรที่เติม');
  if (!(amount > 0)) throw new Error('กรุณาระบุยอดเงิน (บาท)');

  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  let rec;
  try {
    const sh = getDataSheet_();
    const x = loadRequest_(sh, user, refId, S_OK); rec = x.rec;
    if (rec.approvedLiters && liters > rec.approvedLiters + 0.5) throw new Error('เติมเกินจำนวนที่อนุมัติ (' + rec.approvedLiters + ' ลิตร)');
    if (!body.receipt && !rec.receiptPhotoUrl) throw new Error('กรุณาแนบรูปบิลน้ำมัน');
    const receiptUrl = body.receipt ? saveFile_(body.receipt, refId + '_receipt', rec.requestDate) : rec.receiptPhotoUrl;
    const ppl = Math.round(amount / liters * 100) / 100;
    setCols_(sh, x.rowNo, { Status: S_DONE, FilledDate: date, FilledLiters: liters, FilledAmount: amount, PricePerLiter: ppl,
      ReceiptPhotoURL: receiptUrl, FilledBy: user.username, FilledAt: new Date() });
    SpreadsheetApp.flush();
    Object.assign(rec, { status: S_DONE, filledDate: date, filledLiters: liters, filledAmount: amount, pricePerLiter: ppl, receiptPhotoUrl: receiptUrl, filledBy: user.username });
  } finally { lock.releaseLock(); }
  return rec;
}

/* ─────────── อีเมลแจ้งเตือน ─────────── */
/** ผู้ใช้ที่ active + มีอีเมล + บทบาทตรง + ดูแลสาขานั้น (ถ้าไม่มีเลย ส่งหา admin แทน) */
function usersFor_(roles, branch) {
  const all = allUsers_().map(x => x.user).filter(u => u.active && u.email && canBranch_(u, branch));
  let to = all.filter(u => roles.indexOf(u.role) >= 0);
  if (!to.length) to = all.filter(u => u.role === 'admin');
  return to.map(u => u.email);
}
function requesterEmails_(r) {
  return allUsers_().map(x => x.user)
    .filter(u => u.active && u.email && (u.username === r.createdBy || (u.role === 'branch' && u.branches.indexOf(r.branch) >= 0)))
    .map(u => u.email);
}

function notify_(to, r, headline, buttonLabel, hash) {
  if (!NOTIFY_EMAIL || !to || !to.length) return;
  try {
    to = to.filter((v, i, a) => a.indexOf(v) === i);
    const url = (APP_URL || ScriptApp.getService().getUrl() || '') + (hash || '');
    const row = (k, v) => '<tr><td style="padding:6px 12px;color:#666;white-space:nowrap">' + k + '</td><td style="padding:6px 12px"><b>' + esc_(v || '-') + '</b></td></tr>';
    const html =
      '<div style="font-family:Tahoma,sans-serif;max-width:560px;border:1px solid #eee;border-radius:12px;overflow:hidden">' +
      '<div style="background:#171717;color:#fff;padding:14px 18px;border-bottom:4px solid #e60012"><b>RST-FUEL</b> · ' + esc_(headline) + '</div>' +
      '<table style="font-size:14px;margin:8px 6px">' +
      row('รหัสอ้างอิง', r.refId) + row('สถานะ', r.status) + row('วันที่เข้าเติม', r.requestDate) + row('สาขา', r.branch) +
      row('ทะเบียนรถ', r.vehicle) + row('ประเภทน้ำมัน', r.fuelType) + row('เลขไมล์ก่อนเติม', String(r.mileageBefore)) +
      row('ต้นทาง → ปลายทาง', [r.origin].concat(r.destinations).filter(Boolean).join(' → ')) +
      row('ระยะทางรวม', r.totalDistanceKm ? r.totalDistanceKm + ' กม.' : '') +
      (r.approvedLiters ? row('ลิตรที่อนุมัติ', r.approvedLiters + ' ลิตร') + row('ระดับน้ำมันในถัง', r.tankLevel) : '') +
      row('ผู้ขอ', r.recorderName) +
      '</table>' +
      (url.indexOf('http') === 0 ? '<div style="padding:8px 18px 20px"><a href="' + url + '" style="background:#e60012;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;display:inline-block">' + esc_(buttonLabel) + '</a></div>' : '') +
      '<div style="padding:10px 18px;font-size:11px;color:#999;border-top:1px solid #eee">อีเมลนี้ส่งอัตโนมัติจากระบบ RST-FUEL · Dev: tana.pittayatanadol</div></div>';
    MailApp.sendEmail({ to: to.join(','), subject: '[RST-FUEL] ' + headline + ' · ' + r.refId + ' · ' + r.branch, htmlBody: html, name: 'RST-FUEL' });
  } catch (err) {
    console.warn('notify_ failed: ' + err);
  }
}

function scopeRecords_(user, records) {
  const b = userBranches_(user);
  return b ? records.filter(r => b.indexOf(r.branch) >= 0) : records;
}

function findRowByRef_(sh, refId) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, COL.RefID, last - 1, 1).getDisplayValues();
  for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0] === refId) return i + 2;
  return 0;
}

/** ส่งรูปลายเซ็นเป็น data URL (kind: requester / reviewer / approver) อ่านด้วยสิทธิ์เจ้าของสคริปต์ */
function getSignature_(user, refId, kind) {
  const colName = { requester: 'RequesterSignatureURL', reviewer: 'ReviewerSignatureURL', approver: 'SignatureURL' }[kind || 'approver'];
  if (!colName) return '';
  const sh = getDataSheet_();
  const rowNo = findRowByRef_(sh, str_(refId, 40));
  if (!rowNo) return '';
  if (!canBranch_(user, String(sh.getRange(rowNo, COL.Branch).getValue()))) return '';
  const url = String(sh.getRange(rowNo, COL[colName]).getValue() || '');
  const id = (url.match(/[-\w]{25,}/) || [])[0];
  if (!id) return '';
  const blob = DriveApp.getFileById(id).getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/* ═════════════════════ HELPERS ═════════════════════ */

function getSS_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getDataSheet_() {
  const ss = getSS_();
  let sh = ss.getSheetByName(SHEET_DATA);
  if (!sh) sh = ss.insertSheet(SHEET_DATA);
  if (sh.getMaxColumns() < HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), HEADERS.length - sh.getMaxColumns());
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('C:C').setNumberFormat('yyyy-mm-dd');
    sh.getRange('B:B').setNumberFormat('@');
  } else if (sh.getLastColumn() < HEADERS.length) {
    const from = sh.getLastColumn() + 1;   // อัปเกรดชีตเดิม: เติมหัวคอลัมน์ใหม่
    sh.getRange(1, from, 1, HEADERS.length - from + 1).setValues([HEADERS.slice(from - 1)])
      .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
  }
  return sh;
}

function getConfig_() {
  const sh = getSS_().getSheetByName(SHEET_CONFIG);
  const base = { branches: DEFAULT_BRANCHES, plates: DEFAULT_PLATES, fuelTypes: FUEL_TYPES, tankLevels: TANK_LEVELS };
  if (!sh || sh.getLastRow() < 2) return base;
  const all = sh.getRange(1, 1, sh.getLastRow(), Math.max(2, sh.getLastColumn())).getDisplayValues();
  const head = all[0].map(h => String(h).trim());
  const col = (name, fallbackIdx) => { const i = head.indexOf(name); return i >= 0 ? i : fallbackIdx; };
  const list = (i) => i < 0 ? [] : all.slice(1).map(r => String(r[i] || '').trim()).filter(Boolean);
  const branches = list(col('Branches', 0)), plates = list(col('LicensePlates', 1)), fuels = list(col('FuelTypes', -1));
  return { branches: branches.length ? branches : DEFAULT_BRANCHES, plates: plates.length ? plates : DEFAULT_PLATES,
           fuelTypes: fuels.length ? fuels : FUEL_TYPES, tankLevels: TANK_LEVELS };
}

function str_(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function fmtTs_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : String(v || ''); }
function esc_(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function validate_(raw) {
  const p = {
    requestDate:      str_(raw.requestDate, 10),
    branch:           str_(raw.branch, 100),
    driverName:       str_(raw.driverName, 100),
    recorderName:     str_(raw.recorderName, 100),
    mileageBefore:    Number(raw.mileageBefore),
    licensePlate:     str_(raw.licensePlate, 50),
    licensePlateOther:str_(raw.licensePlateOther, 50),
    gallonPurpose:    str_(raw.gallonPurpose, 300),
    mainDestination:  str_(raw.mainDestination, 300),
    fuelType:         str_(raw.fuelType, 50),
    origin:           str_(raw.origin, 300),
    destinations:     (Array.isArray(raw.destinations) ? raw.destinations : []).slice(0, 8).map(d => str_(d, 300)),
    totalDistanceKm:  raw.totalDistanceKm === '' || raw.totalDistanceKm == null ? '' : Number(raw.totalDistanceKm)
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.requestDate)) throw new Error('วันที่ไม่ถูกต้อง');
  if (!p.branch)       throw new Error('กรุณาเลือกสาขา');
  if (!p.driverName)   throw new Error('กรุณากรอกชื่อผู้ขับ');
  if (!p.recorderName) throw new Error('กรุณากรอกชื่อผู้ลงข้อมูล');
  if (!isFinite(p.mileageBefore) || p.mileageBefore < 0) throw new Error('เลขไมล์ไม่ถูกต้อง');
  if (!p.licensePlate) throw new Error('กรุณาเลือกทะเบียนรถ');
  if (p.licensePlate === 'อื่นๆ' && !p.licensePlateOther) throw new Error('กรุณากรอกทะเบียนรถอื่นๆ');
  if (getConfig_().fuelTypes.indexOf(p.fuelType) < 0) throw new Error('กรุณาเลือกประเภทน้ำมัน');
  if (!p.origin) throw new Error('กรุณาระบุต้นทาง');
  if (!p.destinations.some(Boolean)) throw new Error('กรุณาระบุปลายทางอย่างน้อย 1 จุด');
  if (p.totalDistanceKm === '' || !isFinite(p.totalDistanceKm) || p.totalDistanceKm < 0) throw new Error('กรุณาระบุระยะทางรวม (กม.)');
  while (p.destinations.length < 8) p.destinations.push('');
  return p;
}

function buildRow_(refId, p, mileageUrl, receiptUrl, createdBy, requesterSigUrl) {
  const vehicle = p.licensePlate === 'อื่นๆ' ? p.licensePlateOther : p.licensePlate;
  const row = [
    new Date(), refId, p.requestDate, p.branch, p.driverName, p.recorderName,
    p.mileageBefore, p.licensePlate, p.licensePlateOther, p.gallonPurpose, p.mainDestination
  ].concat(p.destinations, [p.totalDistanceKm, mileageUrl, receiptUrl, vehicle, S_L1, '', '', '', '', createdBy || '',
    p.fuelType, p.origin, requesterSigUrl || '']);
  while (row.length < HEADERS.length) row.push('');
  return row;
}

/** FUEL-YYYYMMDD-#### (นับต่อเนื่องตามวันที่บันทึก) */
function nextRefId_(sheet) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  const prefix = 'FUEL-' + today + '-';
  let max = 0;
  const last = sheet.getLastRow();
  if (last > 1) {
    const start = Math.max(2, last - 500);
    sheet.getRange(start, 2, last - start + 1, 1).getDisplayValues().forEach(r => {
      if (r[0].indexOf(prefix) === 0) max = Math.max(max, parseInt(r[0].slice(prefix.length), 10) || 0);
    });
  }
  return prefix + ('000' + (max + 1)).slice(-4);
}

/** บันทึกไฟล์ลงโฟลเดอร์ย่อยรายเดือน (yyyy-MM) แล้วคืนลิงก์ */
function saveFile_(f, baseName, requestDate) {
  if (!f || !f.data) return '';
  const mime = String(f.mimeType || '');
  if (!/^image\/|^application\/pdf$/.test(mime)) throw new Error('รองรับเฉพาะไฟล์รูปภาพหรือ PDF');
  const bytes = Utilities.base64Decode(f.data);
  if (bytes.length > MAX_FILE_MB * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน ' + MAX_FILE_MB + ' MB');
  const ext = (String(f.name || '').match(/\.[a-z0-9]{2,5}$/i) || [mime === 'application/pdf' ? '.pdf' : '.jpg'])[0];
  const folder = monthFolder_(requestDate.slice(0, 7));
  const file = folder.createFile(Utilities.newBlob(bytes, mime, baseName + ext));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (_) { try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (__) {} }
  return file.getUrl();
}

function monthFolder_(yyyyMM) {
  const root = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const it = root.getFoldersByName(yyyyMM);
  return it.hasNext() ? it.next() : root.createFolder(yyyyMM);
}

function getRecords_() {
  const sh = getDataSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  return vals.filter(r => r[1]).map(rowToObj_).reverse();
}

function rowToObj_(r) {
  const fmtDate = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || '');
  return {
    timestamp: fmtTs_(r[0]),
    refId: String(r[1]),
    requestDate: fmtDate(r[2]),
    branch: String(r[3]),
    driverName: String(r[4]),
    recorderName: String(r[5]),
    mileageBefore: Number(r[6]) || 0,
    licensePlate: String(r[7]),
    licensePlateOther: String(r[8]),
    gallonPurpose: String(r[9]),
    mainDestination: String(r[10]),
    destinations: r.slice(11, 19).map(String).filter(Boolean),
    totalDistanceKm: Number(r[19]) || 0,
    mileagePhotoUrl: String(r[20]),
    receiptPhotoUrl: String(r[21]),
    vehicle: String(r[22] || (r[7] === 'อื่นๆ' ? r[8] : r[7])),
    status: normStatus_(r[23]),
    approverName: String(r[24] || ''),
    approvedAt: fmtTs_(r[25]),
    approvalNote: String(r[26] || ''),
    hasSignature: !!r[27],
    createdBy: String(r[28] || ''),
    fuelType: String(r[29] || ''),
    origin: String(r[30] || ''),
    hasRequesterSignature: !!r[31],
    reviewerName: String(r[32] || ''),
    reviewedAt: fmtTs_(r[33]),
    approvedLiters: Number(r[34]) || 0,
    tankLevel: String(r[35] || ''),
    hasReviewerSignature: !!r[36],
    reviewNote: String(r[37] || ''),
    filledDate: fmtDate(r[38]),
    filledLiters: Number(r[39]) || 0,
    filledAmount: Number(r[40]) || 0,
    pricePerLiter: Number(r[41]) || 0,
    filledBy: String(r[42] || ''),
    filledAt: fmtTs_(r[43])
  };
}

function normStatus_(v) {
  const s = String(v || '').trim();
  if (!s) return S_L1;
  return LEGACY_STATUS[s] || s;
}

function buildStats_(records) {
  const byBranch = {}, byVehicle = {}, byMonth = {};
  let totalKm = 0, gallon = 0, pending = 0, liters = 0, amount = 0;
  records.forEach(x => {
    if (x.status === S_L1 || x.status === S_L2) pending++;
    liters += x.filledLiters; amount += x.filledAmount;
    totalKm += x.totalDistanceKm;
    if (x.gallonPurpose) gallon++;
    const b = byBranch[x.branch] || (byBranch[x.branch] = { count: 0, km: 0 });
    b.count++; b.km += x.totalDistanceKm;
    const v = byVehicle[x.vehicle] || (byVehicle[x.vehicle] = { count: 0, km: 0 });
    v.count++; v.km += x.totalDistanceKm;
    const m = x.requestDate.slice(0, 7);
    const mm = byMonth[m] || (byMonth[m] = { count: 0, km: 0 });
    mm.count++; mm.km += x.totalDistanceKm;
  });
  let topBranch = '', topCount = 0;
  Object.keys(byBranch).forEach(k => { if (byBranch[k].count > topCount) { topCount = byBranch[k].count; topBranch = k; } });
  return { totalRequests: records.length, totalDistanceKm: Math.round(totalKm * 10) / 10, topBranch: topBranch,
           topBranchCount: topCount, gallonCount: gallon, pendingCount: pending,
           totalLiters: Math.round(liters * 100) / 100, totalAmount: Math.round(amount * 100) / 100, byBranch: byBranch, byVehicle: byVehicle, byMonth: byMonth };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}