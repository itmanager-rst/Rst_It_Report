/**
 * RST FixPoint — ระบบแจ้งซ่อมอาคารและอุปกรณ์สำนักงาน | รวมสินไทยกรุ๊ป
 * Backend: Google Apps Script + Google Sheets
 *
 * CODE_VERSION: r16-2026-11-05-security-multiphoto-expense
 *
 * ฟีเจอร์:
 *  - r16: [ความปลอดภัย] ปิดบัญชี (soft delete) แทนการลบแถวจริง • ลบรูประบุตัวตนอัตโนมัติหลังปิดบัญชี 30 วัน
 *         (ตั้ง trigger ด้วย installIdCleanupTrigger) • ล็อกบัญชีชั่วคราวหลังใส่รหัสผิด 5 ครั้ง (15 นาที)
 *         • รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร • ประวัติการจัดการผู้ใช้ (ชีต UserLogs) ให้ admin ดูได้
 *         [รูปหลายรูปต่องาน] แนบได้สูงสุด 6 รูปต่อประเภท (ก่อน/หลังซ่อม) • แสดงรูปในรายการงาน • Admin เพิ่ม/ลบรูปได้
 *         [ค่าใช้จ่าย] รายงานค่าใช้จ่ายรายการ (expenseReport) กรองตามช่วงวันที่/สาขา/สถานะ สรุปตามสาขา ช่าง หมวดหมู่ เดือน

 *  - Login / Session token (CacheService, อายุ 6 ชม.)
 *  - Role: employee / technician / manager / admin
 *  - สาขา (Branches) — ผู้ใช้ผูกกับสาขา, manager/technician เห็นเฉพาะสาขาตัวเอง (ยกเว้น Branch = ALL)
 *  - Workflow: Pending -> Approved -> In Progress -> Completed  (หรือ Rejected / Cancelled)
 *  - Dashboard สรุปภาพรวม
 *  - จัดการผู้ใช้ / สาขา (admin)
 *  - r15: Admin เพิ่ม/เปลี่ยนรูปหลังซ่อมได้ในหน้าแก้ไขรายการ (updateTicket.afterImage)
 *  - r14: Admin ลบผู้ใช้ได้ (ในรุ่น r16 เปลี่ยนเป็นการปิดบัญชีแบบ soft delete) — เดิมเก็บประวัติไว้ที่ชีต DeletedUsers,
 *         ลบรูปโปรไฟล์และรูประบุตัวตนออกจาก Drive, ห้ามลบตัวเอง/admin คนสุดท้าย/ช่างที่มีงานค้าง
 *  - r13: รูปโปรไฟล์ของผู้แจ้งแสดงให้ทุกคนที่ login เห็น (รายการงาน / ตารางทั้งหมด / ใบแจ้งซ่อม) — รูประบุตัวตนยังจำกัดเจ้าของ+admin
 *  - r12: การมองเห็นข้อมูลตามบทบาท (ticketView_ / logVisible_) — พนักงานไม่เห็นหมายเหตุ/ค่าใช้จ่าย,
 *         ช่างเห็นสรุปคะแนนเท่านั้น, ผู้จัดการ/admin เห็นทั้งหมด • เพิ่มค่าใช้จ่าย (Cost) และการประเมินช่าง (rateTicket)
 *  - r11: โปรไฟล์ผู้ใช้ — รูปโปรไฟล์ + รูประบุตัวตน (ไฟล์ส่วนตัว ไม่สร้างลิงก์แชร์, เห็นได้เฉพาะเจ้าของและ admin)
 *  - r10: Admin แก้ไข / ลบ รายการแจ้งซ่อมได้ (updateTicket / deleteTickets) — เฉพาะ role admin
 *         · ทุกการแก้ไขบันทึกค่าเดิม → ค่าใหม่ ลงประวัติ (TicketLogs)
 *         · รายการที่ลบถูกย้ายสำเนาไปชีต "DeletedTickets" (กู้คืนได้ด้วย restoreDeletedTicket)
 *  - r09: เร็วขึ้นและเสถียรขึ้น — memo การอ่าน Sheet ต่อคำขอ, me/login ส่ง branches มาด้วย,
 *         counts (badge) รวมเป็นคำขอเดียว, getImages ดึงรูปเป็นชุด
 *  - r08: ย้ายที่เก็บรูปไปโฟลเดอร์ "Image" (17LfuEDEVzi5Q7TdWgVoKuHhZJ8L-DbPw) ภายใน RST-FixPoint
 *  - r07: ลายเซ็นดิจิทัลของผู้อนุมัติ (บังคับตอนอนุมัติ) บันทึกเป็น ApproverSignURL และพิมพ์ในใบแจ้งซ่อม
 *  - r06: รูปแสดงผ่าน Web App (action getImage / printTickets withImages) — ไม่ต้องแชร์ Drive ออกนอกองค์กร
 *  - r05: แก้ "Access denied: DriveApp" — แชร์รูปแบบ fallback (Anyone > ภายในองค์กร > ไม่แชร์),
 *         อัปโหลดรูปไม่ผ่านก็ยังบันทึกงานได้, เพิ่มฟังก์ชัน diagnose() สำหรับตรวจสิทธิ์
 *  - r04: ตรวจสิทธิ์โฟลเดอร์รูปใน checkStatus, ตั้งชื่อไฟล์รูป <TicketID>_before/after_<วันเวลา>.jpg
 *  - r03: checkStatus ตรวจการเชื่อมต่อฐานข้อมูล, พิมพ์ใบแจ้งซ่อม (printTickets), Dashboard MTD/YTD + เทียบช่วงก่อนหน้า
 *
 * ⚠️ หลังแก้โค้ดทุกครั้ง: Deploy > Manage deployments > ✏️ > Version: New version > Deploy
 *    (อย่ากด New deployment เพราะ URL จะเปลี่ยน)
 */

const CODE_VERSION = 'r16-2026-11-05-security-multiphoto-expense';

// 📌 ID ของ Google Sheet ฐานข้อมูล (ถ้าสคริปต์นี้สร้างจาก Extensions > Apps Script ของชีตอยู่แล้ว เว้นว่างได้)
const SPREADSHEET_ID = '';

// 📌 ID ของโฟลเดอร์ Google Drive เก็บรูป (ใส่เฉพาะ ID ไม่ใช่ URL ทั้งเส้น)
//    = โฟลเดอร์ "Image" (อยู่ใน RST-FixPoint) https://drive.google.com/drive/folders/17LfuEDEVzi5Q7TdWgVoKuHhZJ8L-DbPw
const FOLDER_ID = '17LfuEDEVzi5Q7TdWgVoKuHhZJ8L-DbPw';

// 📌 (r11) โฟลเดอร์เก็บ "รูประบุตัวตน" — แนะนำให้สร้างโฟลเดอร์ใหม่ที่แชร์ให้เฉพาะ Admin แล้วใส่ ID ที่นี่
//    เว้นว่าง = ใช้ FOLDER_ID เดิม (ไฟล์ทั้งหมดของโปรไฟล์ไม่สร้างลิงก์แชร์ แต่สิทธิ์การเข้าถึงไฟล์ตามโฟลเดอร์)
const ID_FOLDER_ID = '';

const TZ = 'Asia/Bangkok';
const SESSION_SECONDS = 21600; // 6 ชม. (สูงสุดของ CacheService)
const PW_SALT = 'RST-FixPoint-v1';
const PW_MIN_LENGTH = 8;            // r16: รหัสผ่านใหม่ขั้นต่ำ 8 ตัวอักษร
const LOGIN_MAX_FAILS = 5;          // r16: ใส่รหัสผิดกี่ครั้งจึงล็อก
const LOGIN_LOCK_MINUTES = 15;      // r16: ระยะเวลาล็อกชั่วคราว
const ID_RETENTION_DAYS = 30;       // r16: เก็บรูประบุตัวตนหลังปิดบัญชีกี่วัน
const MAX_PHOTOS_PER_KIND = 6;      // r16: รูปสูงสุดต่อประเภท (ก่อนซ่อม / หลังซ่อม) ต่อ 1 งาน

const SHEETS = {
  USERS: {
    name: 'Users',
    headers: ['Username', 'PasswordHash', 'FullName', 'Role', 'Branch', 'Department', 'Email', 'Active', 'CreatedAt', 'LastLogin',
      'ProfilePhotoURL', 'IdPhotoURL', 'ProfileUpdatedAt',
      'DeactivatedAt', 'DeactivatedBy', 'FailedLogins', 'LockedUntil'] // r16
  },
  BRANCHES: {
    name: 'Branches',
    headers: ['BranchCode', 'BranchName', 'Active']
  },
  TICKETS: {
    name: 'Tickets',
    headers: ['TicketID', 'CreatedAt', 'Username', 'Requester', 'Branch', 'Department', 'Location', 'Category', 'Title',
      'Description', 'Priority', 'Status', 'ImageURL', 'ApprovedBy', 'ApprovedAt', 'ManagerNote', 'Technician',
      'TechnicianName', 'AcceptedAt', 'CompletedAt', 'TechNote', 'AfterImageURL', 'UpdatedAt', 'ApproverSignURL', 'Cost', 'Rating', 'RatingComment', 'RatedBy', 'RatedAt', 'ExtraPhotos'] // r16: รูปเพิ่มเติม (JSON)
  },
  DELETED: {
    name: 'DeletedTickets',
    headers: ['TicketID', 'CreatedAt', 'Username', 'Requester', 'Branch', 'Department', 'Location', 'Category', 'Title',
      'Description', 'Priority', 'Status', 'ImageURL', 'ApprovedBy', 'ApprovedAt', 'ManagerNote', 'Technician',
      'TechnicianName', 'AcceptedAt', 'CompletedAt', 'TechNote', 'AfterImageURL', 'UpdatedAt', 'ApproverSignURL',
      'Cost', 'Rating', 'RatingComment', 'RatedBy', 'RatedAt', 'ExtraPhotos',
      'DeletedAt', 'DeletedBy', 'DeleteReason']
  },
  USER_LOG: {  // r16: ประวัติการจัดการผู้ใช้ (ไม่เก็บรหัสผ่าน)
    name: 'UserLogs',
    headers: ['Timestamp', 'Actor', 'Action', 'Target', 'Detail']
  },
  LOGS: {
    name: 'TicketLogs',
    headers: ['Timestamp', 'TicketID', 'Action', 'ByUser', 'ByName', 'FromStatus', 'ToStatus', 'Note']
  }
};

const ROLES = ['employee', 'technician', 'manager', 'admin'];
const ST = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled'
};
const ALL_STATUS = [ST.PENDING, ST.APPROVED, ST.IN_PROGRESS, ST.COMPLETED, ST.REJECTED, ST.CANCELLED];

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const ALL_ROLES = ROLES;
const MGR = ['manager', 'admin'];
const TECH = ['technician', 'admin'];
const ADMIN = ['admin'];

const ROUTES = {
  me:              { roles: ALL_ROLES, fn: (u) => ({ user: publicUser_(u), branches: getBranches_(false) }) },
  logout:          { roles: ALL_ROLES, fn: (u, r) => { CacheService.getScriptCache().remove('sess_' + r.token); return {}; } },
  changePassword:  { roles: ALL_ROLES, fn: changePassword_, write: true },
  getBranches:     { roles: ALL_ROLES, fn: () => ({ branches: getBranches_(false) }) },
  counts:          { roles: ALL_ROLES, fn: counts_ },

  createTicket:    { roles: ALL_ROLES, fn: createTicket_, write: true },
  listTickets:     { roles: ALL_ROLES, fn: listTickets_ },
  getTicket:       { roles: ALL_ROLES, fn: getTicket_ },
  printTickets:    { roles: ALL_ROLES, fn: printTickets_ },
  getImage:        { roles: ALL_ROLES, fn: getImage_ },
  getImages:       { roles: ALL_ROLES, fn: getImages_ },
  getProfile:      { roles: ALL_ROLES, fn: getProfile_ },    // r11
  updateProfile:   { roles: ALL_ROLES, fn: updateProfile_, write: true }, // r11: ตัวเอง หรือ admin
  cancelTicket:    { roles: ALL_ROLES, fn: cancelTicket_, write: true },
  rateTicket:      { roles: ALL_ROLES, fn: rateTicket_, write: true }, // r12: ผู้แจ้งประเมินช่างหลังปิดงาน

  approveTicket:   { roles: MGR, fn: approveTicket_, write: true },
  rejectTicket:    { roles: MGR, fn: rejectTicket_, write: true },
  assignTechnician:{ roles: MGR, fn: assignTechnician_, write: true },
  listTechnicians: { roles: MGR, fn: (u) => ({ technicians: listTechnicians_(u) }) },
  dashboard:       { roles: MGR, fn: dashboard_ },

  acceptTicket:    { roles: TECH, fn: acceptTicket_, write: true },
  updateProgress:  { roles: TECH, fn: updateProgress_, write: true },
  completeTicket:  { roles: TECH, fn: completeTicket_, write: true },

  updateTicket:    { roles: ADMIN, fn: updateTicket_, write: true },   // r10: แก้ไขรายการ (admin เท่านั้น)
  deleteTickets:   { roles: ADMIN, fn: deleteTickets_, write: true },  // r10: ลบรายการ (admin เท่านั้น)

  listUsers:       { roles: ADMIN, fn: () => ({ users: readAll_(SHEETS.USERS).map(publicUser_) }) },
  saveUser:        { roles: ADMIN, fn: saveUser_, write: true },
  getAllBranches:  { roles: ADMIN, fn: () => ({ branches: getBranches_(true) }) },
  saveBranch:      { roles: ADMIN, fn: saveBranch_, write: true },
  deactivateUser:  { roles: ADMIN, fn: deactivateUser_, write: true }, // r16: ปิดบัญชี (แทนการลบ)
  reactivateUser:  { roles: ADMIN, fn: reactivateUser_, write: true }, // r16: เปิดใช้งานบัญชีอีกครั้ง
  listUserLogs:    { roles: ADMIN, fn: listUserLogs_ },                // r16
  expenseReport:   { roles: ADMIN, fn: expenseReport_ }                // r16: รายงานค่าใช้จ่าย
};

function doPost(e) {
  resetMemo_();
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = req.action;

    if (action === 'login') return ok_(login_(req));
    if (action === 'checkStatus') return ok_(checkStatus_());

    const route = ROUTES[action];
    if (!route) throw new Error('ไม่รู้จักคำสั่ง: ' + action);

    const user = getSessionUser_(req.token);
    if (!user) return err_('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 'AUTH');
    if (route.roles.indexOf(user.Role) === -1) throw new Error('คุณไม่มีสิทธิ์ใช้งานส่วนนี้');

    if (route.write) {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        return ok_(route.fn(user, req));
      } finally {
        lock.releaseLock();
      }
    }
    return ok_(route.fn(user, req));
  } catch (error) {
    return err_(error && error.message ? error.message : String(error));
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'checkStatus') {
    return ok_(checkStatus_());
  }
  return ContentService.createTextOutput('RST FixPoint API Online — ' + CODE_VERSION);
}

function checkStatus_() {
  const out = { codeVersion: CODE_VERSION, time: new Date().toISOString(), db: 'ok' };
  try {
    const sh = ss_().getSheetByName(SHEETS.TICKETS.name);
    if (!sh) out.db = 'ยังไม่ได้รัน setupDatabase';
    else out.tickets = Math.max(sh.getLastRow() - 1, 0);
  } catch (e) {
    out.db = e.message || String(e);
  }
  // ตรวจสิทธิ์เข้าโฟลเดอร์เก็บรูป (cache 10 นาที เพื่อไม่ให้ช้า)
  const cache = CacheService.getScriptCache();
  let drive = cache.get('drive_check');
  if (!drive) {
    try {
      drive = 'ok|' + DriveApp.getFolderById(FOLDER_ID).getName();
    } catch (e) {
      drive = 'error|เข้าโฟลเดอร์เก็บรูปไม่ได้: ' + driveHint_(e);
    }
    cache.put('drive_check', drive, 600);
  }
  const parts = drive.split('|');
  out.drive = parts[0] === 'ok' ? 'ok' : parts.slice(1).join('|');
  out.folderName = parts[0] === 'ok' ? parts.slice(1).join('|') : '';
  out.sharing = PropertiesService.getScriptProperties().getProperty('SHARING_MODE') || '';
  return out;
}

function ok_(data) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: data || {} }))
    .setMimeType(ContentService.MimeType.JSON);
}

function err_(message, code) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'error', code: code || 'ERROR', message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

// ---- memo ต่อคำขอ (ลดการอ่าน Sheet ซ้ำในคำขอเดียว) — ล้างทุกครั้งที่เริ่มคำขอใหม่ ----
let MEMO = { ss: null, sheets: {}, rows: {}, headers: {} };
function resetMemo_() { MEMO = { ss: null, sheets: {}, rows: {}, headers: {}, photos: null }; }

/** รูปโปรไฟล์ของผู้ใช้ (ทุกคนดูได้) — อ่านชีต Users ครั้งเดียวต่อคำขอ */
function profilePhotoOf_(username) {
  if (!MEMO.photos) {
    MEMO.photos = {};
    readAll_(SHEETS.USERS).forEach(x => { MEMO.photos[norm_(x.Username)] = String(x.ProfilePhotoURL || ''); });
  }
  return MEMO.photos[norm_(username)] || '';
}

function ss_() {
  if (MEMO.ss) return MEMO.ss;
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ไม่พบ Google Sheet — กรุณาใส่ SPREADSHEET_ID ใน Code.gs');
  MEMO.ss = ss;
  return ss;
}

function sheet_(def) {
  if (MEMO.sheets[def.name]) return MEMO.sheets[def.name];
  const ss = ss_();
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers])
      .setFontWeight('bold').setBackground('#0c4a6e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  } else {
    // เติมคอลัมน์ที่ขาด (กรณีอัปเกรดจากเวอร์ชันเก่า)
    const lastCol = Math.max(sh.getLastColumn(), 1);
    const current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const missing = def.headers.filter(h => current.indexOf(h) === -1);
    if (missing.length) {
      sh.getRange(1, current.filter(String).length + 1, 1, missing.length).setValues([missing])
        .setFontWeight('bold').setBackground('#0c4a6e').setFontColor('#ffffff');
      delete MEMO.headers[def.name];
    }
  }
  MEMO.sheets[def.name] = sh;
  return sh;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function headerOf_(def) {
  if (!MEMO.headers[def.name]) MEMO.headers[def.name] = headers_(sheet_(def));
  return MEMO.headers[def.name];
}

function readAll_(def) {
  if (MEMO.rows[def.name]) return MEMO.rows[def.name];
  const sh = sheet_(def);
  const values = sh.getDataRange().getValues();
  const out = [];
  if (values.length >= 2) {
    const h = values[0].map(String);
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (r.every(c => c === '' || c === null)) continue;
      const o = { _row: i + 1 };
      h.forEach((k, j) => { if (k) o[k] = r[j]; });
      out.push(o);
    }
  }
  MEMO.rows[def.name] = out;
  return out;
}

function appendObj_(def, obj) {
  appendObjs_(def, [obj]);
}

/** เพิ่มหลายแถวในครั้งเดียว (เร็วกว่า appendRow ทีละแถว) */
function appendObjs_(def, objs) {
  if (!objs.length) return;
  const sh = sheet_(def);
  const h = headerOf_(def);
  const rows = objs.map(obj => h.map(k => (obj[k] !== undefined && obj[k] !== null ? obj[k] : '')));
  if (rows.length === 1) sh.appendRow(rows[0]);
  else sh.getRange(sh.getLastRow() + 1, 1, rows.length, h.length).setValues(rows);
  delete MEMO.rows[def.name];
  if (def.name === SHEETS.USERS.name) MEMO.photos = null;
}

function updateRow_(def, row, patch) {
  const sh = sheet_(def);
  const h = headerOf_(def);
  const rng = sh.getRange(row, 1, 1, h.length);
  const vals = rng.getValues()[0];
  h.forEach((k, i) => { if (Object.prototype.hasOwnProperty.call(patch, k)) vals[i] = patch[k]; });
  rng.setValues([vals]);
  delete MEMO.rows[def.name];
  if (def.name === SHEETS.USERS.name) MEMO.photos = null;
}

function toDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function clean_(o) {
  const out = {};
  Object.keys(o).forEach(k => {
    if (k === '_row' || k === 'PasswordHash') return;
    const v = o[k];
    out[k] = v instanceof Date ? v.toISOString() : v;
  });
  return out;
}

function norm_(s) {
  return String(s || '').trim().toLowerCase();
}

function isActive_(v) {
  const s = String(v).trim().toUpperCase();
  return !(v === false || s === 'FALSE' || s === 'N' || s === 'NO' || s === '0' || s === 'INACTIVE');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function hash_(password, username) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    PW_SALT + '|' + norm_(username) + '|' + String(password),
    Utilities.Charset.UTF_8
  );
  return raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function isHash_(s) {
  return /^[0-9a-f]{64}$/.test(String(s));
}

function publicUser_(u) {
  return {
    username: String(u.Username),
    fullName: String(u.FullName || u.Username),
    role: String(u.Role),
    branch: String(u.Branch || ''),
    department: String(u.Department || ''),
    email: String(u.Email || ''),
    active: isActive_(u.Active),
    lastLogin: u.LastLogin instanceof Date ? u.LastLogin.toISOString() : String(u.LastLogin || ''),
    profilePhotoUrl: String(u.ProfilePhotoURL || ''),
    hasIdPhoto: !!String(u.IdPhotoURL || ''),
    deactivatedAt: isoOf_(u.DeactivatedAt),
    // r16: วันที่รูประบุตัวตนจะถูกลบอัตโนมัติ (เฉพาะบัญชีที่ปิดแล้วและยังมีรูป)
    idPurgeAt: purgeAtOf_(u)
  };
}

/** r16: วันที่รูประบุตัวตนของบัญชีที่ปิดแล้วจะถูกลบ (ว่างถ้าไม่เกี่ยวข้อง) */
function purgeAtOf_(u) {
  const da = toDate_(u.DeactivatedAt);
  if (isActive_(u.Active) || !da || !String(u.IdPhotoURL || '')) return '';
  return new Date(da.getTime() + ID_RETENTION_DAYS * 864e5).toISOString();
}

/** r16: บันทึกประวัติการจัดการผู้ใช้ (ไม่บันทึกรหัสผ่าน) */
function addUserLog_(actor, action, target, detail) {
  appendObj_(SHEETS.USER_LOG, {
    Timestamp: new Date(),
    Actor: String(actor || 'ระบบ'),
    Action: action,
    Target: String(target || ''),
    Detail: String(detail || '').slice(0, 2000)
  });
}

function findUser_(username) {
  const n = norm_(username);
  return readAll_(SHEETS.USERS).find(u => norm_(u.Username) === n) || null;
}

function login_(req) {
  const username = norm_(req.username);
  const password = String(req.password || '');
  if (!username || !password) throw new Error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');

  const u = findUser_(username);
  if (!u || !isActive_(u.Active)) throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');

  // r16: ตรวจการล็อกชั่วคราว (ใส่รหัสผิดหลายครั้ง)
  const lockedUntil = toDate_(u.LockedUntil);
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    const mins = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
    throw new Error('บัญชีถูกล็อกชั่วคราวเนื่องจากใส่รหัสผิดหลายครั้ง กรุณารอ ' + mins + ' นาทีแล้วลองใหม่ หรือแจ้งผู้ดูแลระบบ');
  }

  const stored = String(u.PasswordHash || '');
  // รองรับกรณีแอดมินพิมพ์รหัสผ่านแบบตัวอักษรธรรมดาในชีต -> จะถูกแปลงเป็น hash อัตโนมัติเมื่อ login สำเร็จครั้งแรก
  const okPw = isHash_(stored) ? stored === hash_(password, username) : stored === password;
  if (!okPw) {
    const fails = (Number(u.FailedLogins) || 0) + 1;
    if (fails >= LOGIN_MAX_FAILS) {
      updateRow_(SHEETS.USERS, u._row, { FailedLogins: 0, LockedUntil: new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000) });
      addUserLog_('ระบบ', 'ล็อกบัญชีชั่วคราว', u.Username, 'ใส่รหัสผิด ' + LOGIN_MAX_FAILS + ' ครั้ง ล็อก ' + LOGIN_LOCK_MINUTES + ' นาที');
      throw new Error('ใส่รหัสผ่านผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว ' + LOGIN_LOCK_MINUTES + ' นาที');
    }
    updateRow_(SHEETS.USERS, u._row, { FailedLogins: fails });
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }

  if (ROLES.indexOf(String(u.Role)) === -1) throw new Error('บทบาทผู้ใช้ไม่ถูกต้อง (' + u.Role + ') กรุณาติดต่อผู้ดูแลระบบ');

  const patch = { LastLogin: new Date(), FailedLogins: 0, LockedUntil: '' };
  if (!isHash_(stored)) patch.PasswordHash = hash_(password, username);
  updateRow_(SHEETS.USERS, u._row, patch);

  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('sess_' + token, norm_(u.Username), SESSION_SECONDS);

  return { token: token, user: publicUser_(u), branches: getBranches_(false), codeVersion: CODE_VERSION };
}

function getSessionUser_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const username = cache.get('sess_' + token);
  if (!username) return null;
  const u = findUser_(username);
  if (!u || !isActive_(u.Active)) return null;
  cache.put('sess_' + token, username, SESSION_SECONDS); // ต่ออายุ session
  u.Role = String(u.Role);
  return u;
}

function changePassword_(u, req) {
  const oldPw = String(req.oldPassword || '');
  const newPw = String(req.newPassword || '');
  if (newPw.length < PW_MIN_LENGTH) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย ' + PW_MIN_LENGTH + ' ตัวอักษร');
  const stored = String(u.PasswordHash || '');
  const okPw = isHash_(stored) ? stored === hash_(oldPw, u.Username) : stored === oldPw;
  if (!okPw) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  updateRow_(SHEETS.USERS, u._row, { PasswordHash: hash_(newPw, u.Username) });
  addUserLog_(u.Username, 'เปลี่ยนรหัสผ่านของตนเอง', u.Username, '');
  return { message: 'เปลี่ยนรหัสผ่านเรียบร้อย' };
}

// ---------------------------------------------------------------------------
// Branch scope
// ---------------------------------------------------------------------------

function isAllBranch_(u) {
  return u.Role === 'admin' || String(u.Branch).trim().toUpperCase() === 'ALL' || !String(u.Branch).trim();
}

function inScope_(u, branch) {
  return isAllBranch_(u) || String(branch) === String(u.Branch);
}

function getBranches_(includeInactive) {
  return readAll_(SHEETS.BRANCHES)
    .filter(b => includeInactive || isActive_(b.Active))
    .map(b => ({ code: String(b.BranchCode), name: String(b.BranchName), active: isActive_(b.Active) }));
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/**
 * บันทึกรูปลงโฟลเดอร์ FOLDER_ID แล้วคืนค่า { url, warning }
 * - ถ้าองค์กรห้ามแชร์ "ทุกคนที่มีลิงก์" (Access denied: DriveApp) จะลดระดับเป็น "ภายในองค์กร" หรือไม่แชร์ อัตโนมัติ
 * - ถ้าอัปโหลดไม่ได้เลย จะไม่ทำให้การบันทึกงานล้มเหลว แต่คืน warning กลับไปแสดงผู้ใช้
 */
function saveImage_(image, prefix, folderId, share) {
  if (!image || !image.base64) return { url: '', warning: '' };
  let file;
  try {
    const parts = String(image.base64).split(',');
    const bytes = Utilities.base64Decode(parts.length > 1 ? parts[1] : parts[0]);
    const ext = /png/i.test(image.type || '') ? '.png' : '.jpg';
    const name = prefix + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss') + ext; // เช่น FIX-261104-001_before_20261104-153000.jpg
    const blob = Utilities.newBlob(bytes, image.type || 'image/jpeg', name);
    file = DriveApp.getFolderById(folderId || FOLDER_ID).createFile(blob);
  } catch (e) {
    Logger.log('saveImage_ createFile error: ' + e);
    return { url: '', warning: 'บันทึกงานแล้ว แต่อัปโหลดรูปไม่สำเร็จ (' + driveHint_(e) + ')' };
  }
  try { file.setDescription('RST FixPoint · ' + prefix + ' · ไฟล์ต้นฉบับ: ' + (image.name || '-')); } catch (e) { /* ไม่สำคัญ */ }

  if (share === false) { // r11: ไฟล์ส่วนตัว — ไม่สร้างลิงก์แชร์ ให้เข้าถึงผ่านแอปเท่านั้น
    try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW); } catch (e) { /* ใช้สิทธิ์ตามโฟลเดอร์ */ }
    return { url: file.getUrl(), warning: '' };
  }
  const mode = setSharingSafe_(file);
  PropertiesService.getScriptProperties().setProperty('SHARING_MODE', mode);
  return { url: file.getUrl(), warning: '' };
}

/** พยายามแชร์ไฟล์แบบกว้างที่สุดที่องค์กรอนุญาต คืนค่าโหมดที่ใช้ได้ */
function setSharingSafe_(file) {
  const tries = [
    ['anyone', DriveApp.Access.ANYONE_WITH_LINK],
    ['domain', DriveApp.Access.DOMAIN_WITH_LINK]
  ];
  for (let i = 0; i < tries.length; i++) {
    try {
      file.setSharing(tries[i][1], DriveApp.Permission.VIEW);
      return tries[i][0];
    } catch (e) {
      Logger.log('setSharing ' + tries[i][0] + ' failed: ' + e);
    }
  }
  return 'private'; // ใช้สิทธิ์ตามโฟลเดอร์ (คนที่มีสิทธิ์ในโฟลเดอร์ยังเปิดดูได้)
}

function driveHint_(e) {
  const m = String(e && e.message || e);
  if (/access denied|permission|ไม่มีสิทธิ์/i.test(m)) {
    return 'บัญชีที่ Deploy ไม่มีสิทธิ์ "ผู้แก้ไข" ในโฟลเดอร์รูป หรือองค์กรจำกัดการใช้ Drive — ให้รันฟังก์ชัน diagnose() เพื่อตรวจ';
  }
  if (/not found|ไม่พบ/i.test(m)) return 'ไม่พบโฟลเดอร์ตาม FOLDER_ID';
  return m;
}

function nextTicketId_(tickets) {
  const prefix = 'FIX-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-';
  let max = 0;
  tickets.concat(readAll_(SHEETS.DELETED)).forEach(t => { // r10: นับรวมรายการที่ถูกลบ กันรหัสซ้ำ
    const id = String(t.TicketID);
    if (id.indexOf(prefix) === 0) {
      const n = parseInt(id.slice(prefix.length), 10);
      if (n > max) max = n;
    }
  });
  return prefix + ('000' + (max + 1)).slice(-3);
}

function addLog_(ticketId, action, u, from, to, note) {
  appendObj_(SHEETS.LOGS, {
    Timestamp: new Date(),
    TicketID: ticketId,
    Action: action,
    ByUser: u.Username,
    ByName: u.FullName || u.Username,
    FromStatus: from || '',
    ToStatus: to || '',
    Note: note || ''
  });
}

function canSee_(u, t) {
  if (u.Role === 'admin') return true;
  if (norm_(t.Username) === norm_(u.Username)) return true;
  if (!inScope_(u, t.Branch)) return false;
  if (u.Role === 'manager') return true;
  if (u.Role === 'technician') return [ST.APPROVED, ST.IN_PROGRESS, ST.COMPLETED].indexOf(String(t.Status)) > -1;
  return false;
}

function getTicketRow_(id) {
  const t = readAll_(SHEETS.TICKETS).find(x => String(x.TicketID) === String(id));
  if (!t) throw new Error('ไม่พบรายการแจ้งซ่อม ' + id);
  return t;
}

// ---------------------------------------------------------------------------
// r16: รูปหลายรูปต่องาน
//   ImageURL / AfterImageURL = รูปหลัก (ก่อน/หลังซ่อม) • ExtraPhotos = JSON รูปเพิ่มเติม [{kind, url, by, at}]
// ---------------------------------------------------------------------------

function extraPhotosOf_(t) {
  try {
    const a = JSON.parse(String(t.ExtraPhotos || '[]'));
    return Array.isArray(a) ? a.filter(p => p && p.url) : [];
  } catch (e) {
    return [];
  }
}

/** รูปทั้งหมดของงานตามลำดับ: ก่อนซ่อม (หลัก + เพิ่มเติม) แล้วตามด้วยหลังซ่อม (หลัก + เพิ่มเติม) */
function photosOf_(t) {
  const extra = extraPhotosOf_(t);
  const out = [];
  if (String(t.ImageURL || '')) out.push({ kind: 'before', url: String(t.ImageURL) });
  extra.filter(p => p.kind === 'before').forEach(p => out.push({ kind: 'before', url: String(p.url) }));
  if (String(t.AfterImageURL || '')) out.push({ kind: 'after', url: String(t.AfterImageURL) });
  extra.filter(p => p.kind === 'after').forEach(p => out.push({ kind: 'after', url: String(p.url) }));
  return out;
}

function ticketFileIds_(t) {
  return [t.ImageURL, t.AfterImageURL, t.ApproverSignURL].concat(extraPhotosOf_(t).map(p => p.url))
    .map(fileIdFromUrl_).filter(String);
}

function checkPhotoLimit_(t, kind, n) {
  const cur = photosOf_(t).filter(p => p.kind === kind).length;
  if (cur + n > MAX_PHOTOS_PER_KIND) {
    throw new Error('รูป' + (kind === 'before' ? 'ก่อนซ่อม' : 'หลังซ่อม') + 'ของรายการนี้มีได้สูงสุด ' +
      MAX_PHOTOS_PER_KIND + ' รูป (ปัจจุบัน ' + cur + ' รูป)');
  }
}

/** บันทึกรูปหลายรูป (สูงสุด 5 รูปต่อครั้ง) คืน urls และ warning ของรูปที่อัปโหลดไม่สำเร็จ */
function saveImages_(images, prefix) {
  const list = (Array.isArray(images) ? images : []).filter(i => i && i.base64).slice(0, 5);
  const urls = [];
  let warning = '';
  list.forEach((img, i) => {
    const r = saveImage_(img, prefix + (list.length > 1 ? '-' + (i + 1) : ''));
    if (r.url) urls.push(r.url);
    else warning = warning || r.warning;
  });
  return { urls: urls, warning: warning };
}

/** แพตช์ที่ต้องเขียนลงแถวเมื่อเพิ่มรูป: รูปแรกของประเภทนั้นที่ยังไม่มีรูปหลัก → รูปหลัก ที่เหลือ → ExtraPhotos */
function addPhotoPatch_(base, kind, urls, actor) {
  const patch = {};
  const rest = urls.slice();
  const now = new Date().toISOString();
  if (kind === 'before' && !String(base.ImageURL || '') && rest.length) patch.ImageURL = rest.shift();
  if (kind === 'after' && !String(base.AfterImageURL || '') && rest.length) patch.AfterImageURL = rest.shift();
  if (rest.length) {
    const extra = extraPhotosOf_(base);
    rest.forEach(url => extra.push({ kind: kind, url: url, by: String(actor || ''), at: now }));
    patch.ExtraPhotos = JSON.stringify(extra);
  }
  return patch;
}

/** แพตช์สำหรับลบรูปตาม fileId — ถ้าลบรูปหลัก จะเลื่อนรูปเพิ่มเติมประเภทเดียวกันขึ้นมาแทน */
function removePhotoPatch_(t, fileIds) {
  const gone = url => fileIds.indexOf(fileIdFromUrl_(url)) > -1;
  const trash = [];
  let count = 0;
  let before = String(t.ImageURL || '');
  let after = String(t.AfterImageURL || '');
  if (before && gone(before)) { trash.push(before); before = ''; count++; }
  if (after && gone(after)) { trash.push(after); after = ''; count++; }
  const kept = extraPhotosOf_(t).filter(p => {
    if (gone(p.url)) { trash.push(p.url); count++; return false; }
    return true;
  });
  const promote = kind => {
    const i = kept.findIndex(p => p.kind === kind);
    return i > -1 ? kept.splice(i, 1)[0].url : '';
  };
  if (!before) before = promote('before');
  if (!after) after = promote('after');
  return {
    count: count,
    trash: trash,
    patch: { ImageURL: before, AfterImageURL: after, ExtraPhotos: kept.length ? JSON.stringify(kept) : '' }
  };
}

function createTicket_(u, req) {
  const d = req.ticket || {};
  ['title', 'location', 'category'].forEach(k => {
    if (!String(d[k] || '').trim()) throw new Error('กรุณากรอกข้อมูลให้ครบ (' + k + ')');
  });

  let branch = String(d.branch || '').trim();
  if (!isAllBranch_(u)) branch = String(u.Branch); // ผู้ใช้สาขาหนึ่งแจ้งได้เฉพาะสาขาตัวเอง
  if (!branch) throw new Error('กรุณาเลือกสาขา');

  const images = Array.isArray(d.images) ? d.images : (d.image ? [d.image] : []);
  if (images.length > 5) throw new Error('แนบรูปได้ไม่เกิน 5 รูปต่อครั้ง');
  checkPhotoLimit_({}, 'before', images.filter(i => i && i.base64).length);

  const tickets = readAll_(SHEETS.TICKETS);
  const id = nextTicketId_(tickets);
  const saved = saveImages_(images, id + '_before');
  const now = new Date();
  const patch = addPhotoPatch_({}, 'before', saved.urls, u.Username);

  appendObj_(SHEETS.TICKETS, Object.assign({
    TicketID: id,
    CreatedAt: now,
    Username: u.Username,
    Requester: String(d.requester || u.FullName || u.Username),
    Branch: branch,
    Department: String(d.department || u.Department || ''),
    Location: String(d.location),
    Category: String(d.category),
    Title: String(d.title),
    Description: String(d.description || ''),
    Priority: String(d.priority || 'ปกติ'),
    Status: ST.PENDING,
    UpdatedAt: now
  }, patch));
  addLog_(id, 'สร้างรายการแจ้งซ่อม', u, '', ST.PENDING, d.title + (saved.urls.length > 1 ? ' (รูป ' + saved.urls.length + ' รูป)' : ''));

  return { ticketId: id, message: 'บันทึกข้อมูลแจ้งซ่อมเรียบร้อยแล้ว', warning: saved.warning };
}

function listTickets_(u, req) {
  const f = req.filter || {};
  const scope = f.scope || 'visible';
  const from = f.dateFrom ? new Date(f.dateFrom + 'T00:00:00+07:00') : null;
  const to = f.dateTo ? new Date(f.dateTo + 'T23:59:59+07:00') : null;
  const q = norm_(f.q);

  let list = readAll_(SHEETS.TICKETS).filter(t => canSee_(u, t));

  if (scope === 'mine') list = list.filter(t => norm_(t.Username) === norm_(u.Username));
  if (scope === 'approvals') list = list.filter(t => t.Status === ST.PENDING && inScope_(u, t.Branch));
  if (scope === 'jobs') {
    const mine = t => u.Role === 'admin' || norm_(t.Technician) === norm_(u.Username);
    list = list.filter(t => inScope_(u, t.Branch) && (
      (t.Status === ST.APPROVED && (!t.Technician || mine(t))) ||
      ((t.Status === ST.IN_PROGRESS || t.Status === ST.COMPLETED) && mine(t))));
  }
  if (f.status) list = list.filter(t => t.Status === f.status);
  if (f.branch) list = list.filter(t => t.Branch === f.branch);
  if (f.category) list = list.filter(t => t.Category === f.category);
  if (from) list = list.filter(t => toDate_(t.CreatedAt) && toDate_(t.CreatedAt) >= from);
  if (to) list = list.filter(t => toDate_(t.CreatedAt) && toDate_(t.CreatedAt) <= to);
  if (q) {
    list = list.filter(t => [t.TicketID, t.Title, t.Description, t.Location, t.Requester, t.TechnicianName, t.Category]
      .some(v => norm_(v).indexOf(q) > -1));
  }

  list.sort((a, b) => (toDate_(b.CreatedAt) || 0) - (toDate_(a.CreatedAt) || 0));
  const limit = Math.min(Number(f.limit) || 500, 2000);
  return { tickets: list.slice(0, limit).map(t => ticketView_(u, t)), total: list.length };
}

function getTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (!canSee_(u, t)) throw new Error('คุณไม่มีสิทธิ์ดูรายการนี้');
  const logs = readAll_(SHEETS.LOGS)
    .filter(l => String(l.TicketID) === String(t.TicketID) && logVisible_(u, l))
    .sort((a, b) => (toDate_(a.Timestamp) || 0) - (toDate_(b.Timestamp) || 0))
    .map(clean_);
  return { ticket: ticketView_(u, t), logs: logs };
}

function printTickets_(u, req) {
  const ids = (req.ticketIds || []).map(String).slice(0, 100);
  if (!ids.length) throw new Error('กรุณาเลือกรายการที่จะพิมพ์');
  const all = readAll_(SHEETS.TICKETS);
  const logs = readAll_(SHEETS.LOGS);
  const out = [];
  ids.forEach(id => {
    const t = all.find(x => String(x.TicketID) === id);
    if (!t || !canSee_(u, t)) return;
    const item = {
      ticket: ticketView_(u, t),
      logs: logs.filter(l => String(l.TicketID) === id && logVisible_(u, l))
        .sort((a, b) => (toDate_(a.Timestamp) || 0) - (toDate_(b.Timestamp) || 0)).map(clean_)
    };
    item.signImg = imageData_(t.ApproverSignURL);
    item.requesterImg = imageData_(profilePhotoOf_(t.Username)); // r13: รูปผู้แจ้งในใบแจ้งซ่อม
    if (req.withImages) {
      // r16: ส่งรูปทั้งหมด (สูงสุด 6 รูปต่อประเภท) — beforeImg/afterImg = รูปแรกเพื่อความเข้ากันได้
      const photos = photosOf_(t);
      item.beforeImgs = photos.filter(p => p.kind === 'before').slice(0, MAX_PHOTOS_PER_KIND).map(p => imageData_(p.url));
      item.afterImgs = photos.filter(p => p.kind === 'after').slice(0, MAX_PHOTOS_PER_KIND).map(p => imageData_(p.url));
      item.beforeImg = item.beforeImgs[0] || '';
      item.afterImg = item.afterImgs[0] || '';
    }
    out.push(item);
  });
  if (!out.length) throw new Error('ไม่พบรายการที่มีสิทธิ์พิมพ์');
  return { items: out, printedBy: u.FullName || u.Username, printedAt: new Date().toISOString() };
}

/** ส่งรูปของงานให้ผู้ที่มีสิทธิ์ดูงานนั้น (ไม่ต้องแชร์ไฟล์ใน Drive) */
function getImage_(u, req) {
  const id = fileIdFromUrl_(req.url);
  if (!id) throw new Error('ลิงก์รูปไม่ถูกต้อง');
  if (!imageAccess_(u, req.url)) throw new Error('ไม่มีสิทธิ์ดูรูปนี้');
  return { data: imageData_(req.url) };
}

/** ดึงรูปหลายรูปในคำขอเดียว (เฉพาะรูปของงานที่ผู้ใช้มีสิทธิ์ดู) */
function getImages_(u, req) {
  const urls = (req.urls || []).slice(0, 12);
  const tickets = readAll_(SHEETS.TICKETS);
  const images = {};
  urls.forEach(url => {
    const id = fileIdFromUrl_(url);
    if (!id) return;
    if (!imageAccess_(u, url)) return;
    images[url] = imageData_(url);
  });
  return { images: images };
}

/** จำนวนงานที่รอดำเนินการของผู้ใช้ (ใช้แสดง badge เมนู) */
function counts_(u) {
  const all = readAll_(SHEETS.TICKETS);
  const out = { approvals: 0, jobs: 0 };
  if (MGR.indexOf(u.Role) > -1) {
    out.approvals = all.filter(t => t.Status === ST.PENDING && inScope_(u, t.Branch)).length;
  }
  if (TECH.indexOf(u.Role) > -1) {
    out.jobs = all.filter(t => t.Status === ST.APPROVED && inScope_(u, t.Branch) &&
      (u.Role === 'admin' || !t.Technician || norm_(t.Technician) === norm_(u.Username))).length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// r11: โปรไฟล์ผู้ใช้ — รูปโปรไฟล์ + รูประบุตัวตน
// ---------------------------------------------------------------------------

/** ตรวจว่าผู้ใช้มีสิทธิ์ดูรูปนี้หรือไม่: รูปงานซ่อม / รูปโปรไฟล์ / รูประบุตัวตน */
function imageAccess_(u, url) {
  const id = fileIdFromUrl_(url);
  if (!id) return false;
  const t = readAll_(SHEETS.TICKETS).find(x => ticketFileIds_(x).indexOf(id) > -1);
  if (t) return canSee_(u, t);
  const users = readAll_(SHEETS.USERS);
  if (users.some(x => fileIdFromUrl_(x.ProfilePhotoURL) === id)) return true; // รูปโปรไฟล์ — ผู้ใช้ที่ login แล้วดูได้
  const owner = users.find(x => fileIdFromUrl_(x.IdPhotoURL) === id);       // รูประบุตัวตน — เจ้าของ + admin เท่านั้น
  if (owner) return u.Role === 'admin' || norm_(owner.Username) === norm_(u.Username);
  return false;
}

function trashFileByUrl_(url) {
  const id = fileIdFromUrl_(url);
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { Logger.log('trash error: ' + e); }
}

function getProfile_(u, req) {
  const target = norm_(req.username) || norm_(u.Username);
  if (target !== norm_(u.Username)) requireAdmin_(u);
  const row = findUser_(target);
  if (!row) throw new Error('ไม่พบผู้ใช้ ' + target);
  const canId = u.Role === 'admin' || norm_(row.Username) === norm_(u.Username);
  return { profile: {
    username: String(row.Username),
    fullName: String(row.FullName || row.Username),
    role: String(row.Role),
    branch: String(row.Branch || ''),
    department: String(row.Department || ''),
    profilePhotoUrl: String(row.ProfilePhotoURL || ''),
    hasIdPhoto: !!String(row.IdPhotoURL || ''),
    idPhotoUrl: canId ? String(row.IdPhotoURL || '') : '',
    updatedAt: row.ProfileUpdatedAt instanceof Date ? row.ProfileUpdatedAt.toISOString() : String(row.ProfileUpdatedAt || '')
  } };
}

function updateProfile_(u, req) {
  const target = norm_(req.username) || norm_(u.Username);
  if (target !== norm_(u.Username)) requireAdmin_(u);
  const row = findUser_(target);
  if (!row) throw new Error('ไม่พบผู้ใช้ ' + target);
  const patch = {};
  const done = [];

  if (req.profilePhoto && req.profilePhoto.base64) {
    const img = saveImage_(req.profilePhoto, 'PROFILE_' + target, '', false);
    if (!img.url) throw new Error('อัปโหลดรูปโปรไฟล์ไม่สำเร็จ — ' + (img.warning || 'ลองใหม่อีกครั้ง'));
    trashFileByUrl_(row.ProfilePhotoURL);
    patch.ProfilePhotoURL = img.url;
    done.push('รูปโปรไฟล์');
  }
  if (req.removeProfilePhoto) {
    trashFileByUrl_(row.ProfilePhotoURL);
    patch.ProfilePhotoURL = '';
    done.push('ลบรูปโปรไฟล์');
  }
  if (req.idPhoto && req.idPhoto.base64) {
    const img = saveImage_(req.idPhoto, 'IDPHOTO_' + target, ID_FOLDER_ID, false);
    if (!img.url) throw new Error('อัปโหลดรูประบุตัวตนไม่สำเร็จ — ' + (img.warning || 'ลองใหม่อีกครั้ง'));
    trashFileByUrl_(row.IdPhotoURL);
    patch.IdPhotoURL = img.url;
    done.push('รูประบุตัวตน');
  }
  if (req.removeIdPhoto) {
    trashFileByUrl_(row.IdPhotoURL);
    patch.IdPhotoURL = '';
    done.push('ลบรูประบุตัวตน');
  }

  if (!done.length) throw new Error('ไม่มีรูปที่จะบันทึก');
  patch.ProfileUpdatedAt = new Date();
  updateRow_(SHEETS.USERS, row._row, patch);
  addUserLog_(u.Username, 'แก้ไขรูปโปรไฟล์', target, done.join(', ')); // r16
  return { message: 'บันทึก' + done.join(' และ') + 'ของ ' + target + ' แล้ว' };
}

// ---------------------------------------------------------------------------
// r12: การมองเห็นข้อมูลตามบทบาท
//   พนักงาน (employee): เห็นรูป/ชื่อ/หัวข้อ/สถานที่/อาการ/รูปชำรุด/สถานะ; ไม่เห็น หมายเหตุ/ค่าใช้จ่าย;
//                      การประเมิน เห็นเฉพาะของตนเอง
//   ช่าง (technician):  เห็นหมายเหตุ/ค่าใช้จ่าย; การประเมิน เห็นเฉพาะ "สรุป" (คะแนนเฉลี่ย + จำนวน)
//   ผู้จัดการ/admin:    เห็นทั้งหมด
// ---------------------------------------------------------------------------

function toCost_(v) {
  const n = Math.round(Number(v) * 100) / 100;
  if (!(n >= 0)) throw new Error('ค่าใช้จ่ายต้องเป็นตัวเลข 0 ขึ้นไป');
  return n;
}

function isoOf_(v) {
  return v instanceof Date ? v.toISOString() : String(v || '');
}

/** สรุปคะแนนการประเมินของช่าง (รวมทุกรายการที่ช่างคนนี้ดูแลและได้รับการประเมินแล้ว) */
function techSummary_(name) {
  const rated = readAll_(SHEETS.TICKETS).filter(t => norm_(t.Technician) === norm_(name) && String(t.Rating || '') !== '');
  const count = rated.length;
  const avg = count ? Math.round(rated.reduce((a, t) => a + Number(t.Rating), 0) / count * 10) / 10 : null;
  return { avg: avg, count: count };
}

/** แปลงรายการแจ้งซ่อมให้เหลือเฉพาะข้อมูลที่บทบาทนี้มีสิทธิ์เห็น */
function ticketView_(u, t) {
  const out = clean_(t);
  const owner = norm_(t.Username) === norm_(u.Username);
  out.requesterPhotoUrl = profilePhotoOf_(t.Username); // r13: ทุกบทบาทเห็นรูปโปรไฟล์ผู้แจ้ง
  out.photos = photosOf_(t);                            // r16: รูปทั้งหมดของงาน (ใช้แสดงในรายการ)
  delete out.ExtraPhotos;

  // ฟิลด์ดิบของการประเมินไม่ส่งออกไปตรงๆ — ส่งเฉพาะผ่าน evaluation / techSummary
  delete out.Rating; delete out.RatingComment; delete out.RatedBy; delete out.RatedAt;
  const hasRating = String(t.Rating || '') !== '';
  const fullEval = () => ({ score: Number(t.Rating), comment: String(t.RatingComment || ''), by: String(t.RatedBy || ''), at: isoOf_(t.RatedAt) });

  if (u.Role === 'employee') {
    delete out.ManagerNote;
    delete out.TechNote;
    delete out.Cost;
    if (owner && hasRating) out.evaluation = { score: Number(t.Rating), comment: String(t.RatingComment || ''), at: isoOf_(t.RatedAt) };
  } else if (u.Role === 'technician') {
    if (t.Technician) out.techSummary = techSummary_(t.Technician);
  } else { // manager / admin
    if (hasRating) out.evaluation = fullEval();
    if (t.Technician) out.techSummary = techSummary_(t.Technician);
  }
  return out;
}

/** กรองประวัติการดำเนินงานตามบทบาท (ไม่ให้เห็นบันทึกที่ซ่อนจากบทบาทนั้น) */
function logVisible_(u, l) {
  if (u.Role === 'manager' || u.Role === 'admin') return true;
  const act = String(l.Action || '');
  if (act === 'ประเมินผลงานช่าง') return u.Role === 'employee' && norm_(l.ByUser) === norm_(u.Username);
  if (u.Role === 'employee') {
    return ['อัปเดตความคืบหน้า', 'ปิดงานซ่อม (เสร็จสิ้น)', 'อนุมัติงานซ่อม', 'ไม่อนุมัติ', 'แก้ไขข้อมูล (Admin)', 'ลบรายการ (Admin)'].indexOf(act) === -1;
  }
  return true; // ช่าง: เห็นประวัติทั้งหมด ยกเว้นการประเมิน
}

/** ผู้แจ้งซ่อมให้คะแนนช่าง 1–5 + ข้อเสนอแนะ (ได้ครั้งเดียว เมื่อปิดงานแล้ว) */
function rateTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (norm_(t.Username) !== norm_(u.Username)) throw new Error('ประเมินได้เฉพาะผู้แจ้งซ่อมรายการนี้');
  requireStatus_(t, [ST.COMPLETED]);
  if (String(t.Rating || '') !== '') throw new Error('รายการนี้ได้รับการประเมินแล้ว');
  const score = Math.round(Number(req.score));
  if (!(score >= 1 && score <= 5)) throw new Error('กรุณาให้คะแนน 1–5');
  const comment = String(req.comment || '').trim().slice(0, 1000);
  const now = new Date();
  updateRow_(SHEETS.TICKETS, t._row, {
    Rating: score, RatingComment: comment, RatedBy: u.FullName || u.Username, RatedAt: now, UpdatedAt: now
  });
  // บันทึกเฉพาะคะแนนลงประวัติ — ข้อเสนอแนะเก็บในรายการเท่านั้น (กันช่างเห็นข้อความผ่านประวัติ)
  addLog_(t.TicketID, 'ประเมินผลงานช่าง', u, t.Status, t.Status, score + '/5');
  return { ticketId: t.TicketID, message: 'ขอบคุณสำหรับการประเมิน' };
}

function fileIdFromUrl_(url) {
  const m = String(url || '').match(/\/d\/([\w-]{10,})/) || String(url || '').match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : '';
}

/** อ่านไฟล์รูปจาก Drive แล้วคืนเป็น data URL (ทำงานได้แม้องค์กรห้ามแชร์ลิงก์) */
function imageData_(url) {
  const id = fileIdFromUrl_(url);
  if (!id) return '';
  try {
    const blob = DriveApp.getFileById(id).getBlob();
    return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (e) {
    Logger.log('imageData_ error: ' + e);
    return '';
  }
}

function transition_(u, t, toStatus, action, note, extra) {
  const from = String(t.Status);
  const patch = Object.assign({ Status: toStatus, UpdatedAt: new Date() }, extra || {});
  updateRow_(SHEETS.TICKETS, t._row, patch);
  addLog_(t.TicketID, action, u, from, toStatus, note);
  return { ticketId: t.TicketID, status: toStatus, message: action + ' เรียบร้อย' };
}

function requireStatus_(t, allowed) {
  if (allowed.indexOf(String(t.Status)) === -1) {
    throw new Error('สถานะปัจจุบันคือ "' + t.Status + '" ไม่สามารถทำรายการนี้ได้ (อาจมีผู้อื่นอัปเดตไปแล้ว กรุณารีเฟรช)');
  }
}

function approveTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (!inScope_(u, t.Branch)) throw new Error('รายการนี้ไม่อยู่ในสาขาที่คุณดูแล');
  requireStatus_(t, [ST.PENDING]);
  if (!req.signature || String(req.signature).indexOf('data:image/') !== 0) throw new Error('กรุณาเซ็นลายเซ็นก่อนอนุมัติ');
  const sig = saveImage_({ base64: req.signature, type: 'image/png', name: 'signature.png' }, t.TicketID + '_sign_approve');
  if (!sig.url) throw new Error('บันทึกลายเซ็นไม่สำเร็จ — ' + (sig.warning || 'ลองใหม่อีกครั้ง'));
  const extra = { ApprovedBy: u.FullName || u.Username, ApprovedAt: new Date(), ManagerNote: String(req.note || ''), ApproverSignURL: sig.url };
  if (req.technician) {
    const tech = findUser_(req.technician);
    if (!tech || tech.Role !== 'technician') throw new Error('ไม่พบช่างที่เลือก');
    extra.Technician = tech.Username;
    extra.TechnicianName = tech.FullName || tech.Username;
  }
  const note = [req.note, extra.TechnicianName ? 'มอบหมาย: ' + extra.TechnicianName : ''].filter(String).join(' | ');
  return transition_(u, t, ST.APPROVED, 'อนุมัติงานซ่อม', note, extra);
}

function rejectTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (!inScope_(u, t.Branch)) throw new Error('รายการนี้ไม่อยู่ในสาขาที่คุณดูแล');
  requireStatus_(t, [ST.PENDING, ST.APPROVED]);
  if (!String(req.note || '').trim()) throw new Error('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
  return transition_(u, t, ST.REJECTED, 'ไม่อนุมัติ', req.note, {
    ApprovedBy: u.FullName || u.Username, ApprovedAt: new Date(), ManagerNote: String(req.note)
  });
}

function assignTechnician_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (!inScope_(u, t.Branch)) throw new Error('รายการนี้ไม่อยู่ในสาขาที่คุณดูแล');
  requireStatus_(t, [ST.APPROVED, ST.IN_PROGRESS]);
  const tech = findUser_(req.technician);
  if (!tech || tech.Role !== 'technician') throw new Error('ไม่พบช่างที่เลือก');
  const name = tech.FullName || tech.Username;
  updateRow_(SHEETS.TICKETS, t._row, { Technician: tech.Username, TechnicianName: name, UpdatedAt: new Date() });
  addLog_(t.TicketID, 'มอบหมายช่าง', u, t.Status, t.Status, name);
  return { message: 'มอบหมายงานให้ ' + name + ' แล้ว' };
}

function acceptTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (!inScope_(u, t.Branch)) throw new Error('รายการนี้ไม่อยู่ในสาขาที่คุณดูแล');
  requireStatus_(t, [ST.APPROVED]);
  if (t.Technician && norm_(t.Technician) !== norm_(u.Username) && u.Role !== 'admin') {
    throw new Error('งานนี้ถูกมอบหมายให้ ' + (t.TechnicianName || t.Technician) + ' แล้ว');
  }
  const self = t.Technician && u.Role === 'admin' ? null : u;
  const extra = { AcceptedAt: new Date() };
  if (self) { extra.Technician = u.Username; extra.TechnicianName = u.FullName || u.Username; }
  return transition_(u, t, ST.IN_PROGRESS, 'รับงาน / เริ่มดำเนินการ', req.note, extra);
}

function updateProgress_(u, req) {
  const t = getTicketRow_(req.ticketId);
  requireStatus_(t, [ST.IN_PROGRESS]);
  if (u.Role !== 'admin' && norm_(t.Technician) !== norm_(u.Username)) throw new Error('งานนี้ไม่ใช่งานของคุณ');
  const note = String(req.note || '').trim();
  if (!note) throw new Error('กรุณาระบุความคืบหน้า');
  const patch = { TechNote: note, UpdatedAt: new Date() };
  if (req.cost !== undefined && req.cost !== '') patch.Cost = toCost_(req.cost);
  updateRow_(SHEETS.TICKETS, t._row, patch);
  addLog_(t.TicketID, 'อัปเดตความคืบหน้า', u, t.Status, t.Status, note);
  return { message: 'บันทึกความคืบหน้าแล้ว' };
}

function completeTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  requireStatus_(t, [ST.IN_PROGRESS]);
  if (u.Role !== 'admin' && norm_(t.Technician) !== norm_(u.Username)) throw new Error('งานนี้ไม่ใช่งานของคุณ');
  // r16: รองรับรูปหลังซ่อมหลายรูป (req.images) — req.image ยังใช้ได้เพื่อความเข้ากันได้
  const imgs = Array.isArray(req.images) ? req.images : (req.image ? [req.image] : []);
  if (imgs.length > 5) throw new Error('แนบรูปได้ไม่เกิน 5 รูปต่อครั้ง');
  checkPhotoLimit_(t, 'after', imgs.filter(i => i && i.base64).length);
  const saved = saveImages_(imgs, t.TicketID + '_after');
  const extra = Object.assign({ CompletedAt: new Date(), TechNote: String(req.note || t.TechNote || '') },
    addPhotoPatch_(t, 'after', saved.urls, u.Username));
  if (req.cost !== undefined && req.cost !== '') extra.Cost = toCost_(req.cost);
  const res = transition_(u, t, ST.COMPLETED, 'ปิดงานซ่อม (เสร็จสิ้น)', req.note, extra);
  res.warning = saved.warning;
  return res;
}

function cancelTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (norm_(t.Username) !== norm_(u.Username) && u.Role !== 'admin') throw new Error('ยกเลิกได้เฉพาะรายการที่คุณแจ้งเอง');
  requireStatus_(t, [ST.PENDING]);
  return transition_(u, t, ST.CANCELLED, 'ยกเลิกการแจ้งซ่อม', req.note);
}

// ---------------------------------------------------------------------------
// r10: Admin แก้ไข / ลบ รายการแจ้งซ่อม (route จำกัด role = admin แล้ว — ตรวจซ้ำอีกชั้นเพื่อความปลอดภัย)
// ---------------------------------------------------------------------------

const PRIORITIES = ['ปกติ', 'ด่วน', 'ด่วนมาก'];

function requireAdmin_(u) {
  if (u.Role !== 'admin') throw new Error('ต้องเป็นผู้ดูแลระบบ (Admin) เท่านั้น');
}

function updateTicket_(u, req) {
  requireAdmin_(u);
  const t = getTicketRow_(req.ticketId);
  const d = req.ticket || {};
  const patch = {}, changes = [];
  const txt = v => (v instanceof Date ? v.toISOString() : String(v === undefined || v === null ? '' : v)).trim();
  const set = (col, val, label) => {
    const nv = txt(val), ov = txt(t[col]);
    if (nv === ov) return;
    patch[col] = nv;
    changes.push(label + ': ' + (ov || '-') + ' → ' + (nv || '-'));
  };
  const has = k => Object.prototype.hasOwnProperty.call(d, k);

  ['title', 'location', 'category', 'requester'].forEach(k => {
    if (has(k) && !txt(d[k])) throw new Error('ห้ามเว้นว่าง (' + k + ')');
  });
  if (has('requester')) set('Requester', d.requester, 'ผู้แจ้ง');
  if (has('branch')) {
    const b = txt(d.branch);
    if (!b) throw new Error('กรุณาเลือกสาขา');
    if (b !== txt(t.Branch) && !getBranches_(true).some(x => x.name === b)) throw new Error('ไม่พบสาขา ' + b);
    set('Branch', b, 'สาขา');
  }
  if (has('department')) set('Department', d.department, 'แผนก');
  if (has('location')) set('Location', d.location, 'สถานที่');
  if (has('category')) set('Category', d.category, 'หมวดหมู่');
  if (has('title')) set('Title', d.title, 'หัวข้อ');
  if (has('description')) set('Description', d.description, 'รายละเอียด');
  if (has('priority')) {
    if (PRIORITIES.indexOf(txt(d.priority)) === -1) throw new Error('ระดับความเร่งด่วนไม่ถูกต้อง');
    set('Priority', d.priority, 'ความเร่งด่วน');
  }
  if (has('managerNote')) set('ManagerNote', d.managerNote, 'หมายเหตุผู้จัดการ');
  if (has('techNote')) set('TechNote', d.techNote, 'บันทึกช่าง');
  if (has('cost')) set('Cost', (d.cost === '' || d.cost === null || d.cost === undefined) ? '' : toCost_(d.cost), 'ค่าใช้จ่าย');

  if (has('technician') && norm_(d.technician) !== norm_(t.Technician)) {
    if (!txt(d.technician)) {
      patch.Technician = ''; patch.TechnicianName = '';
      changes.push('ช่าง: ' + (t.TechnicianName || t.Technician) + ' → -');
    } else {
      const tech = findUser_(d.technician);
      if (!tech || tech.Role !== 'technician') throw new Error('ไม่พบช่างที่เลือก');
      patch.Technician = tech.Username;
      patch.TechnicianName = tech.FullName || tech.Username;
      changes.push('ช่าง: ' + (t.TechnicianName || t.Technician || '-') + ' → ' + patch.TechnicianName);
    }
  }

  const from = String(t.Status);
  if (has('status') && txt(d.status) !== from) {
    const to = txt(d.status);
    if (ALL_STATUS.indexOf(to) === -1) throw new Error('สถานะไม่ถูกต้อง');
    patch.Status = to;
    changes.push('สถานะ: ' + from + ' → ' + to);
    // ปรับวันที่ให้สอดคล้อง เพื่อให้ Dashboard คำนวณถูก
    if (to === ST.COMPLETED && !t.CompletedAt) patch.CompletedAt = new Date();
    if (to !== ST.COMPLETED && t.CompletedAt) patch.CompletedAt = '';
    if (to === ST.IN_PROGRESS && !t.AcceptedAt) patch.AcceptedAt = new Date();
    if (to === ST.PENDING) { patch.ApprovedBy = ''; patch.ApprovedAt = ''; patch.AcceptedAt = ''; patch.ApproverSignURL = ''; }
  }

  // r16: รูปหลายรูป — ลบรูปที่ระบุ (removePhotos) แล้วเพิ่มรูปใหม่ (addBefore / addAfter)
  let warning = '';
  const trash = [];
  const removeIds = (Array.isArray(d.removePhotos) ? d.removePhotos : []).map(fileIdFromUrl_).filter(String);
  if (removeIds.length) {
    const rp = removePhotoPatch_(t, removeIds);
    if (rp.count) {
      Object.assign(patch, rp.patch);
      trash.push.apply(trash, rp.trash);
      changes.push('ลบรูป ' + rp.count + ' รูป');
    }
  }
  const base = Object.assign({}, t, patch);
  const addBefore = (Array.isArray(d.addBefore) ? d.addBefore : []).filter(i => i && i.base64);
  const addAfter = (Array.isArray(d.addAfter) ? d.addAfter : []).filter(i => i && i.base64);
  if (addBefore.length > 5 || addAfter.length > 5) throw new Error('เพิ่มรูปได้ไม่เกิน 5 รูปต่อครั้ง');
  if (addBefore.length) checkPhotoLimit_(base, 'before', addBefore.length);
  if (addAfter.length) checkPhotoLimit_(base, 'after', addAfter.length);
  if (addBefore.length) {
    const sv = saveImages_(addBefore, t.TicketID + '_before');
    warning = warning || sv.warning;
    if (sv.urls.length) { Object.assign(patch, addPhotoPatch_(base, 'before', sv.urls, u.Username)); Object.assign(base, patch); changes.push('เพิ่มรูปก่อนซ่อม ' + sv.urls.length + ' รูป'); }
  }
  if (addAfter.length) {
    const sv2 = saveImages_(addAfter, t.TicketID + '_after');
    warning = warning || sv2.warning;
    if (sv2.urls.length) { Object.assign(patch, addPhotoPatch_(base, 'after', sv2.urls, u.Username)); Object.assign(base, patch); changes.push('เพิ่มรูปหลังซ่อม ' + sv2.urls.length + ' รูป'); }
  }

  if (!changes.length) {
    if (warning) throw new Error(warning);
    return { ticketId: t.TicketID, message: 'ไม่มีข้อมูลที่เปลี่ยนแปลง' };
  }
  patch.UpdatedAt = new Date();
  updateRow_(SHEETS.TICKETS, t._row, patch);
  trash.forEach(trashFileByUrl_); // ลบไฟล์หลังบันทึกสำเร็จเท่านั้น
  const reason = txt(req.reason);
  addLog_(t.TicketID, 'แก้ไขข้อมูล (Admin)', u, from, patch.Status || from,
    (reason ? 'เหตุผล: ' + reason + ' | ' : '') + changes.join(' | ').slice(0, 45000));
  return { ticketId: t.TicketID, message: 'แก้ไขรายการ ' + t.TicketID + ' แล้ว (' + changes.length + ' จุด)', warning: warning };
}

function deleteTickets_(u, req) {
  requireAdmin_(u);
  const ids = (req.ticketIds || []).map(String).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 300);
  if (!ids.length) throw new Error('กรุณาเลือกรายการที่จะลบ');
  const reason = String(req.reason || '').trim();
  if (!reason) throw new Error('กรุณาระบุเหตุผลการลบ');

  const targets = readAll_(SHEETS.TICKETS).filter(t => ids.indexOf(String(t.TicketID)) > -1);
  if (!targets.length) throw new Error('ไม่พบรายการที่จะลบ (อาจถูกลบไปแล้ว กรุณารีเฟรช)');

  // 1) เก็บสำเนาไว้ที่ชีต DeletedTickets ก่อนลบ (กู้คืนได้)
  const now = new Date();
  const by = (u.FullName || u.Username) + ' (' + u.Username + ')';
  appendObjs_(SHEETS.DELETED, targets.map(t => Object.assign({}, t, { DeletedAt: now, DeletedBy: by, DeleteReason: reason })));

  // 2) ลบแถวจากล่างขึ้นบน รวมแถวที่ติดกันเป็นช่วงเดียว
  const sh = sheet_(SHEETS.TICKETS);
  const rows = targets.map(t => t._row).sort((a, b) => b - a);
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sh.deleteRows(rows[j], i === j ? 1 : rows[i] - rows[j] + 1);
    i = j + 1;
  }
  delete MEMO.rows[SHEETS.TICKETS.name];

  // 3) บันทึกประวัติ (ประวัติเดิมของรายการยังอยู่ใน TicketLogs)
  appendObjs_(SHEETS.LOGS, targets.map(t => ({
    Timestamp: now, TicketID: t.TicketID, Action: 'ลบรายการ (Admin)', ByUser: u.Username,
    ByName: u.FullName || u.Username, FromStatus: t.Status, ToStatus: 'Deleted', Note: reason
  })));

  return {
    deleted: targets.map(t => String(t.TicketID)),
    message: 'ลบแล้ว ' + targets.length + ' รายการ (สำเนาเก็บไว้ที่ชีต DeletedTickets)'
  };
}

function listTechnicians_(u) {
  return readAll_(SHEETS.USERS)
    .filter(x => x.Role === 'technician' && isActive_(x.Active))
    .filter(x => isAllBranch_(u) || String(x.Branch) === String(u.Branch) || String(x.Branch).toUpperCase() === 'ALL')
    .map(x => ({ username: String(x.Username), fullName: String(x.FullName || x.Username), branch: String(x.Branch) }));
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function dashboard_(u, req) {
  const f = req.filter || {};
  const from = f.dateFrom ? new Date(f.dateFrom + 'T00:00:00+07:00') : null;
  const to = f.dateTo ? new Date(f.dateTo + 'T23:59:59+07:00') : null;

  let list = readAll_(SHEETS.TICKETS).filter(t => inScope_(u, t.Branch));
  if (f.branch) list = list.filter(t => t.Branch === f.branch);
  if (from) list = list.filter(t => toDate_(t.CreatedAt) && toDate_(t.CreatedAt) >= from);
  if (to) list = list.filter(t => toDate_(t.CreatedAt) && toDate_(t.CreatedAt) <= to);

  const byStatus = {};
  ALL_STATUS.forEach(s => byStatus[s] = 0);
  const byBranch = {}, byCategory = {}, byPriority = {}, techs = {};
  let approveHrs = [], resolveHrs = [];

  list.forEach(t => {
    const s = String(t.Status || ST.PENDING);
    byStatus[s] = (byStatus[s] || 0) + 1;

    const b = String(t.Branch || '-');
    byBranch[b] = byBranch[b] || { total: 0 };
    byBranch[b].total++;
    byBranch[b][s] = (byBranch[b][s] || 0) + 1;

    const c = String(t.Category || 'อื่นๆ');
    byCategory[c] = (byCategory[c] || 0) + 1;
    const p = String(t.Priority || 'ปกติ');
    byPriority[p] = (byPriority[p] || 0) + 1;

    const created = toDate_(t.CreatedAt), approved = toDate_(t.ApprovedAt), done = toDate_(t.CompletedAt);
    if (created && approved && s !== ST.REJECTED) approveHrs.push((approved - created) / 36e5);
    if (created && done) resolveHrs.push((done - created) / 36e5);

    if (t.Technician) {
      const k = String(t.TechnicianName || t.Technician);
      techs[k] = techs[k] || { name: k, inProgress: 0, completed: 0, hours: [] };
      if (s === ST.IN_PROGRESS) techs[k].inProgress++;
      if (s === ST.COMPLETED) {
        techs[k].completed++;
        if (created && done) techs[k].hours.push((done - created) / 36e5);
      }
    }
  });

  const allScoped = readAll_(SHEETS.TICKETS).filter(t => inScope_(u, t.Branch) && (!f.branch || t.Branch === f.branch));

  // แนวโน้ม: รายวัน (MTD / ช่วงสั้น) หรือ รายเดือน (YTD / ช่วงยาว) — ไม่ระบุช่วง = 6 เดือนล่าสุด
  const gran = f.granularity === 'day' ? 'day' : 'month';
  const keyFmt = gran === 'day' ? 'yyyy-MM-dd' : 'yyyy-MM';
  const now = new Date();
  const tFrom = from || new Date(Utilities.formatDate(new Date(now.getTime() - 155 * 864e5), TZ, 'yyyy-MM') + '-01T00:00:00+07:00');
  const tTo = to && to < now ? to : now;
  const endKey = Utilities.formatDate(tTo, TZ, keyFmt);
  const trend = [];
  if (gran === 'day') {
    for (let d = new Date(tFrom.getTime()); trend.length < 400; d = new Date(d.getTime() + 864e5)) {
      const key = Utilities.formatDate(d, TZ, keyFmt);
      if (key > endKey) break;
      if (!trend.length || trend[trend.length - 1].key !== key) trend.push({ key: key, created: 0, completed: 0 });
    }
  } else {
    let ym = Utilities.formatDate(tFrom, TZ, 'yyyy-MM').split('-').map(Number);
    while (trend.length < 120) {
      const key = ym[0] + '-' + ('0' + ym[1]).slice(-2);
      trend.push({ key: key, created: 0, completed: 0 });
      if (key >= endKey) break;
      ym = ym[1] === 12 ? [ym[0] + 1, 1] : [ym[0], ym[1] + 1];
    }
  }
  const tIdx = {};
  trend.forEach((b, i) => tIdx[b.key] = i);
  allScoped.forEach(t => {
    const c = toDate_(t.CreatedAt), d = toDate_(t.CompletedAt);
    if (c) { const i = tIdx[Utilities.formatDate(c, TZ, keyFmt)]; if (i !== undefined) trend[i].created++; }
    if (d) { const i = tIdx[Utilities.formatDate(d, TZ, keyFmt)]; if (i !== undefined) trend[i].completed++; }
  });

  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null;

  // สรุปช่วงเวลา (ใช้เทียบช่วงปัจจุบัน vs ช่วงก่อนหน้า)
  const summarize = (a, b) => {
    const inRange = d => d && (!a || d >= a) && (!b || d <= b);
    const created = allScoped.filter(t => inRange(toDate_(t.CreatedAt)));
    const closed = allScoped.filter(t => t.Status === ST.COMPLETED && inRange(toDate_(t.CompletedAt)));
    const hrs = closed.map(t => (toDate_(t.CompletedAt) - toDate_(t.CreatedAt)) / 36e5).filter(h => h >= 0);
    const done = created.filter(t => t.Status === ST.COMPLETED).length;
    return {
      total: created.length,
      completed: done,
      closedInPeriod: closed.length,
      completionRate: created.length ? Math.round(done / created.length * 100) : 0,
      avgResolveHours: avg(hrs)
    };
  };
  const cur = summarize(from, to);
  const prevFrom = f.prevFrom ? new Date(f.prevFrom + 'T00:00:00+07:00') : null;
  const prevTo = f.prevTo ? new Date(f.prevTo + 'T23:59:59+07:00') : null;
  const prev = prevFrom && prevTo ? summarize(prevFrom, prevTo) : null;
  const open = list.filter(t => [ST.PENDING, ST.APPROVED, ST.IN_PROGRESS].indexOf(String(t.Status)) > -1);
  const urgentOpen = open
    .filter(t => t.Priority === 'ด่วนมาก' || t.Priority === 'ด่วน')
    .sort((a, b) => (toDate_(a.CreatedAt) || 0) - (toDate_(b.CreatedAt) || 0))
    .slice(0, 10)
    .map(clean_);

  return {
    total: list.length,
    open: open.length,
    byStatus: byStatus,
    byBranch: byBranch,
    byCategory: byCategory,
    byPriority: byPriority,
    monthly: trend,
    trend: trend,
    granularity: gran,
    closedInPeriod: cur.closedInPeriod,
    current: cur,
    prev: prev,
    avgApproveHours: avg(approveHrs),
    avgResolveHours: avg(resolveHrs),
    completionRate: list.length ? Math.round((byStatus[ST.COMPLETED] || 0) / list.length * 100) : 0,
    technicians: Object.keys(techs).map(k => ({
      name: techs[k].name, inProgress: techs[k].inProgress, completed: techs[k].completed, avgHours: avg(techs[k].hours)
    })).sort((a, b) => b.completed - a.completed),
    urgentOpen: urgentOpen,
    generatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Admin: Users & Branches
// ---------------------------------------------------------------------------

function saveUser_(u, req) {
  const d = req.user || {};
  const username = norm_(d.username);
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('Username ต้องเป็น a-z, 0-9, . _ - ความยาว 3-30 ตัว');
  if (ROLES.indexOf(d.role) === -1) throw new Error('บทบาทไม่ถูกต้อง');
  if (!String(d.fullName || '').trim()) throw new Error('กรุณากรอกชื่อ-นามสกุล');

  const existing = findUser_(username);
  const rec = {
    Username: username,
    FullName: String(d.fullName).trim(),
    Role: d.role,
    Branch: String(d.branch || 'ALL'),
    Department: String(d.department || ''),
    Email: String(d.email || ''),
    Active: d.active === false ? 'FALSE' : 'TRUE'
  };
  const actor = u.Username;

  if (existing) {
    if (norm_(existing.Username) === norm_(u.Username) && (rec.Role !== 'admin' || rec.Active === 'FALSE')) {
      throw new Error('ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้');
    }
    if (d.password && String(d.password).length < PW_MIN_LENGTH) throw new Error('รหัสผ่านต้องมีอย่างน้อย ' + PW_MIN_LENGTH + ' ตัวอักษร');

    const wasActive = isActive_(existing.Active);
    const nowActive = rec.Active !== 'FALSE';
    if (wasActive && !nowActive) {
      // r16: การปิดใช้งานผ่านฟอร์มผู้ใช้ = ปิดบัญชี (เก็บข้อมูล) — ใช้กฎเดียวกับ deactivateUser
      assertCanDeactivate_(readAll_(SHEETS.USERS), existing);
      rec.DeactivatedAt = new Date();
      rec.DeactivatedBy = actor;
    }
    if (!wasActive && nowActive) { rec.DeactivatedAt = ''; rec.DeactivatedBy = ''; }

    const changes = [];
    if (String(existing.FullName || '') !== rec.FullName) changes.push('ชื่อ: ' + (existing.FullName || '-') + ' → ' + rec.FullName);
    if (String(existing.Role) !== rec.Role) changes.push('บทบาท: ' + existing.Role + ' → ' + rec.Role);
    if (String(existing.Branch || '') !== rec.Branch) changes.push('สาขา: ' + (existing.Branch || '-') + ' → ' + rec.Branch);
    if (wasActive !== nowActive) changes.push(nowActive ? 'เปิดใช้งาน' : 'ปิดบัญชี');

    if (d.password) {
      rec.PasswordHash = hash_(d.password, username);
      rec.FailedLogins = 0;   // ตั้งรหัสใหม่ = ปลดล็อกบัญชีด้วย
      rec.LockedUntil = '';
      changes.push('ตั้งรหัสผ่านใหม่');
    }
    updateRow_(SHEETS.USERS, existing._row, rec);
    if (changes.length) addUserLog_(actor, 'แก้ไขผู้ใช้', username, changes.join(' | '));
    return { message: 'อัปเดตผู้ใช้ ' + username + ' แล้ว' };
  }

  if (!d.password || String(d.password).length < PW_MIN_LENGTH) throw new Error('ผู้ใช้ใหม่ต้องตั้งรหัสผ่านอย่างน้อย ' + PW_MIN_LENGTH + ' ตัวอักษร');
  rec.PasswordHash = hash_(d.password, username);
  rec.CreatedAt = new Date();
  rec.FailedLogins = 0;
  rec.LockedUntil = '';
  appendObj_(SHEETS.USERS, rec);
  addUserLog_(actor, 'เพิ่มผู้ใช้', username, 'บทบาท: ' + rec.Role + ' | สาขา: ' + rec.Branch);
  return { message: 'เพิ่มผู้ใช้ ' + username + ' แล้ว' };
}

/** r16: กฎก่อนปิดบัญชี — ห้ามปิด admin คนสุดท้าย และห้ามปิดช่างที่มีงาน Approved / In Progress ค้างอยู่ */
function assertCanDeactivate_(users, target) {
  if (String(target.Role) === 'admin') {
    const activeAdmins = users.filter(x => String(x.Role) === 'admin' && isActive_(x.Active)).length;
    if (activeAdmins <= 1) throw new Error('ไม่สามารถปิดบัญชี admin คนสุดท้ายของระบบได้');
  }
  const openJobs = readAll_(SHEETS.TICKETS).filter(t =>
    norm_(t.Technician) === norm_(target.Username) && [ST.APPROVED, ST.IN_PROGRESS].indexOf(String(t.Status)) > -1);
  if (openJobs.length) {
    throw new Error('ผู้ใช้นี้มีงานค้าง ' + openJobs.length + ' รายการ (' + openJobs.map(t => t.TicketID).join(', ') +
      ') กรุณามอบหมายงานให้ช่างคนอื่นก่อนปิดบัญชี');
  }
}

/**
 * r16: ปิดบัญชี (soft delete) — ไม่ลบแถวผู้ใช้ ประวัติงานซ่อมและรูปโปรไฟล์ยังอยู่
 * - รูประบุตัวตน (IdPhotoURL) เก็บไว้ได้ไม่เกิน ID_RETENTION_DAYS วัน แล้วลบอัตโนมัติด้วย cleanupExpiredIdPhotos
 * - เปิดใช้งานคืนได้ด้วย reactivateUser ก่อนรูปถูกลบ
 */
function deactivateUser_(u, req) {
  requireAdmin_(u);
  const username = norm_(req.username);
  const reason = String(req.reason || '').trim();
  if (!username) throw new Error('ไม่พบชื่อผู้ใช้ที่จะปิดบัญชี');
  if (!reason) throw new Error('กรุณาระบุเหตุผลการปิดบัญชี');
  if (username === norm_(u.Username)) throw new Error('ไม่สามารถปิดบัญชีของตัวเองได้');

  const users = readAll_(SHEETS.USERS);
  const target = users.find(x => norm_(x.Username) === username);
  if (!target) throw new Error('ไม่พบผู้ใช้ ' + username + ' (กรุณารีเฟรช)');
  if (!isActive_(target.Active)) throw new Error('บัญชีนี้ถูกปิดอยู่แล้ว');
  assertCanDeactivate_(users, target);

  updateRow_(SHEETS.USERS, target._row, { Active: 'FALSE', DeactivatedAt: new Date(), DeactivatedBy: u.Username });
  addUserLog_(u.Username, 'ปิดบัญชี', target.Username,
    'เหตุผล: ' + reason + ' | รูประบุตัวตนจะถูกลบอัตโนมัติหลัง ' + ID_RETENTION_DAYS + ' วัน');
  return { message: 'ปิดบัญชี ' + target.Username + ' แล้ว (ประวัติงานซ่อมยังอยู่ · รูประบุตัวตนจะถูกลบอัตโนมัติหลัง ' + ID_RETENTION_DAYS + ' วัน)' };
}

/** r16: เปิดใช้งานบัญชีที่ถูกปิดอีกครั้ง (และปลดล็อกการใส่รหัสผิด) */
function reactivateUser_(u, req) {
  requireAdmin_(u);
  const username = norm_(req.username);
  const target = readAll_(SHEETS.USERS).find(x => norm_(x.Username) === username);
  if (!target) throw new Error('ไม่พบผู้ใช้ ' + username + ' (กรุณารีเฟรช)');
  if (isActive_(target.Active)) throw new Error('บัญชีนี้ใช้งานอยู่แล้ว');

  updateRow_(SHEETS.USERS, target._row, { Active: 'TRUE', DeactivatedAt: '', DeactivatedBy: '', FailedLogins: 0, LockedUntil: '' });
  addUserLog_(u.Username, 'เปิดใช้งานบัญชี', target.Username, '');
  return { message: 'เปิดใช้งานบัญชี ' + target.Username + ' แล้ว' };
}

/** r16: ประวัติการจัดการผู้ใช้ (admin) */
function listUserLogs_(u, req) {
  requireAdmin_(u);
  const limit = Math.min(Number(req.limit) || 100, 300);
  const logs = readAll_(SHEETS.USER_LOG)
    .sort((a, b) => (toDate_(b.Timestamp) || 0) - (toDate_(a.Timestamp) || 0))
    .slice(0, limit)
    .map(clean_);
  return { logs: logs };
}

/**
 * ▶️ r16: ลบรูประบุตัวตนของบัญชีที่ปิดเกิน ID_RETENTION_DAYS วัน
 * ถูกเรียกอัตโนมัติทุกวันโดย trigger (ตั้งด้วย installIdCleanupTrigger) หรือกด Run เองได้
 */
function cleanupExpiredIdPhotos() {
  resetMemo_();
  const cutoff = Date.now() - ID_RETENTION_DAYS * 864e5;
  let purged = 0;
  readAll_(SHEETS.USERS).forEach(x => {
    if (isActive_(x.Active) || !String(x.IdPhotoURL || '')) return;
    const at = toDate_(x.DeactivatedAt);
    if (!at) { // ปิดบัญชีก่อนมีระบบนี้ — เริ่มนับวันตั้งแต่ตอนนี้
      updateRow_(SHEETS.USERS, x._row, { DeactivatedAt: new Date() });
      return;
    }
    if (at.getTime() > cutoff) return;
    trashFileByUrl_(x.IdPhotoURL);
    updateRow_(SHEETS.USERS, x._row, { IdPhotoURL: '' });
    addUserLog_('ระบบ', 'ลบรูประบุตัวตนอัตโนมัติ', x.Username, 'ปิดบัญชีมาเกิน ' + ID_RETENTION_DAYS + ' วัน');
    purged++;
  });
  Logger.log('✅ ลบรูประบุตัวตนที่หมดอายุแล้ว ' + purged + ' รายการ');
  return purged;
}

/** ▶️ r16: ตั้ง trigger ให้ลบรูประบุตัวตนที่หมดอายุทุกวันเวลา 02:00 (กด Run หนึ่งครั้ง) */
function installIdCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'cleanupExpiredIdPhotos') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cleanupExpiredIdPhotos').timeBased().everyDays(1).atHour(2).create();
  Logger.log('✅ ตั้งเวลาลบรูประบุตัวตนอัตโนมัติทุกวัน 02:00 แล้ว');
}

/**
 * r16: รายงานค่าใช้จ่าย (admin) — เฉพาะรายการที่กรอกค่าใช้จ่ายแล้ว
 * filter: dateFrom, dateTo (YYYY-MM-DD), dateBy ('created' | 'completed'), branch, status, category
 */
function expenseReport_(u, req) {
  requireAdmin_(u);
  const f = req.filter || {};
  const from = f.dateFrom ? new Date(f.dateFrom + 'T00:00:00+07:00') : null;
  const to = f.dateTo ? new Date(f.dateTo + 'T23:59:59+07:00') : null;
  const dateField = f.dateBy === 'completed' ? 'CompletedAt' : 'CreatedAt';

  let list = readAll_(SHEETS.TICKETS).filter(t =>
    t.Cost !== '' && t.Cost !== null && t.Cost !== undefined && !isNaN(Number(t.Cost)));
  if (f.branch) list = list.filter(t => String(t.Branch) === String(f.branch));
  if (f.status) list = list.filter(t => String(t.Status) === String(f.status));
  if (f.category) list = list.filter(t => String(t.Category) === String(f.category));
  list = list.filter(t => {
    const d = toDate_(t[dateField]);
    if (!d) return !from && !to;
    return (!from || d >= from) && (!to || d <= to);
  });

  const rows = list.map(t => ({
    ticketId: String(t.TicketID),
    date: isoOf_(toDate_(t[dateField]) || t.CreatedAt),
    createdAt: isoOf_(t.CreatedAt),
    completedAt: isoOf_(t.CompletedAt),
    branch: String(t.Branch || '-'),
    title: String(t.Title || ''),
    category: String(t.Category || 'อื่นๆ'),
    requester: String(t.Requester || t.Username || ''),
    technician: String(t.TechnicianName || t.Technician || ''),
    status: String(t.Status || ''),
    cost: Math.round(Number(t.Cost) * 100) / 100
  })).sort((a, b) => (toDate_(b.date) || 0) - (toDate_(a.date) || 0));

  const sum = rows.reduce((a, r) => a + r.cost, 0);
  const group = keyFn => {
    const m = {};
    rows.forEach(r => {
      const k = keyFn(r);
      m[k] = m[k] || { name: k, amount: 0, count: 0 };
      m[k].amount += r.cost;
      m[k].count++;
    });
    return Object.keys(m).map(k => ({ name: k, amount: Math.round(m[k].amount * 100) / 100, count: m[k].count }))
      .sort((a, b) => b.amount - a.amount);
  };

  return {
    rows: rows,
    totals: {
      amount: Math.round(sum * 100) / 100,
      count: rows.length,
      average: rows.length ? Math.round(sum / rows.length * 100) / 100 : 0
    },
    byBranch: group(r => r.branch),
    byTechnician: group(r => r.technician || '(ยังไม่มอบหมายช่าง)'),
    byCategory: group(r => r.category),
    byMonth: group(r => Utilities.formatDate(toDate_(r.date) || new Date(), TZ, 'yyyy-MM')).sort((a, b) => a.name < b.name ? -1 : 1),
    generatedAt: new Date().toISOString()
  };
}

function saveBranch_(u, req) {
  const d = req.branch || {};
  const code = String(d.code || '').trim().toUpperCase();
  const name = String(d.name || '').trim();
  if (!code || !name) throw new Error('กรุณากรอกรหัสสาขาและชื่อสาขา');
  if (code === 'ALL') throw new Error('ห้ามใช้รหัส ALL');
  const list = readAll_(SHEETS.BRANCHES);
  const existing = list.find(b => String(b.BranchCode).toUpperCase() === code);
  const rec = { BranchCode: code, BranchName: name, Active: d.active === false ? 'FALSE' : 'TRUE' };
  if (existing) {
    updateRow_(SHEETS.BRANCHES, existing._row, rec);
    return { message: 'อัปเดตสาขา ' + name + ' แล้ว' };
  }
  if (list.some(b => String(b.BranchName) === name)) throw new Error('มีชื่อสาขานี้อยู่แล้ว');
  appendObj_(SHEETS.BRANCHES, rec);
  return { message: 'เพิ่มสาขา ' + name + ' แล้ว' };
}

// ---------------------------------------------------------------------------
// ▶️ ฟังก์ชันตั้งค่าครั้งแรก — เลือก setupDatabase แล้วกด Run ใน Apps Script Editor
// ---------------------------------------------------------------------------

/**
 * ▶️ ตรวจสิทธิ์ทั้งหมด — เลือก diagnose แล้วกด Run ดูผลที่ "Execution log"
 * ใช้เมื่อเจอ "Access denied" หรืออัปโหลดรูปไม่ได้
 */
function diagnose() {
  const log = (ok, msg) => Logger.log((ok ? '✅ ' : '❌ ') + msg);
  log(true, 'CODE_VERSION = ' + CODE_VERSION + ' · ผู้รันสคริปต์ = ' + Session.getEffectiveUser().getEmail());
  try { const ss = ss_(); log(true, 'เปิด Google Sheet ได้: ' + ss.getName()); }
  catch (e) { log(false, 'เปิด Google Sheet ไม่ได้: ' + e + ' → ตรวจ SPREADSHEET_ID / สิทธิ์ของชีต'); }

  let folder;
  try { folder = DriveApp.getFolderById(FOLDER_ID); log(true, 'เข้าโฟลเดอร์รูปได้: ' + folder.getName()); }
  catch (e) { log(false, 'เข้าโฟลเดอร์รูปไม่ได้: ' + e + ' → ให้เจ้าของโฟลเดอร์แชร์สิทธิ์ "ผู้แก้ไข" ให้ ' + Session.getEffectiveUser().getEmail()); return; }

  let f;
  try { f = folder.createFile('fixpoint_diagnose_test.txt', 'test ' + new Date()); log(true, 'สร้างไฟล์ในโฟลเดอร์ได้'); }
  catch (e) { log(false, 'สร้างไฟล์ในโฟลเดอร์ไม่ได้: ' + e + ' → ต้องมีสิทธิ์ "ผู้แก้ไข" (Editor) ไม่ใช่แค่ "ผู้ดู"'); return; }

  try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); log(true, 'แชร์แบบ "ทุกคนที่มีลิงก์" ได้'); }
  catch (e) {
    log(false, 'แชร์แบบ "ทุกคนที่มีลิงก์" ไม่ได้ (องค์กรห้ามแชร์ภายนอก): ' + e);
    try { f.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); log(true, 'แชร์แบบ "ภายในองค์กร" ได้ → ระบบจะใช้โหมดนี้อัตโนมัติ (ผู้ดูรูปต้อง login บัญชีองค์กร)'); }
    catch (e2) { log(false, 'แชร์ภายในองค์กรก็ไม่ได้: ' + e2 + ' → ระบบจะเก็บรูปแบบไม่แชร์ คนที่มีสิทธิ์ในโฟลเดอร์ยังเปิดดูได้'); }
  }
  try { f.setTrashed(true); log(true, 'ลบไฟล์ทดสอบแล้ว'); } catch (e) { log(false, 'ลบไฟล์ทดสอบไม่ได้ (ลบเองได้): ' + e); }
  CacheService.getScriptCache().remove('drive_check');
  Logger.log('เสร็จสิ้น — ถ้าทุกข้อ ✅ แล้วยังขึ้น Access denied ในหน้าเว็บ ให้ตรวจ Deploy: Execute as = Me, Who has access = Anyone และกด New version');
}

/**
 * ▶️ (r10) กู้คืนรายการที่ถูกลบ — แก้ ID ด้านล่าง แล้วเลือก restoreDeletedTicket กด Run
 */
function restoreDeletedTicket(ticketId) {
  ticketId = ticketId || 'FIX-YYMMDD-001'; // ← ใส่รหัสที่ต้องการกู้คืน
  const del = readAll_(SHEETS.DELETED).filter(t => String(t.TicketID) === String(ticketId));
  if (!del.length) { Logger.log('ไม่พบ ' + ticketId + ' ในชีต DeletedTickets'); return; }
  if (readAll_(SHEETS.TICKETS).some(t => String(t.TicketID) === String(ticketId))) { Logger.log(ticketId + ' มีอยู่ในชีต Tickets แล้ว'); return; }
  const rec = del[del.length - 1];
  appendObj_(SHEETS.TICKETS, Object.assign({}, rec, { UpdatedAt: new Date() }));
  sheet_(SHEETS.DELETED).deleteRow(rec._row);
  delete MEMO.rows[SHEETS.DELETED.name];
  appendObj_(SHEETS.LOGS, { Timestamp: new Date(), TicketID: ticketId, Action: 'กู้คืนรายการ (Admin)',
    ByUser: Session.getEffectiveUser().getEmail(), ByName: 'Apps Script', FromStatus: 'Deleted', ToStatus: rec.Status, Note: '' });
  Logger.log('✅ กู้คืน ' + ticketId + ' แล้ว');
}

function setupDatabase() {
  Object.keys(SHEETS).forEach(k => sheet_(SHEETS[k]));

  if (readAll_(SHEETS.BRANCHES).length === 0) {
    [
      ['HQ', 'สำนักงานใหญ่', 'TRUE'],
      ['BR01', 'สาขา 1 (แก้ชื่อได้)', 'TRUE'],
      ['BR02', 'สาขา 2 (แก้ชื่อได้)', 'TRUE']
    ].forEach(r => appendObj_(SHEETS.BRANCHES, { BranchCode: r[0], BranchName: r[1], Active: r[2] }));
  }

  if (readAll_(SHEETS.USERS).length === 0) {
    const now = new Date();
    [
      ['admin', 'admin1234', 'ผู้ดูแลระบบ', 'admin', 'ALL', 'IT'],
      ['manager1', '1234', 'ผู้จัดการ สำนักงานใหญ่', 'manager', 'สำนักงานใหญ่', 'Management'],
      ['tech1', '1234', 'ช่างซ่อมบำรุง 1', 'technician', 'สำนักงานใหญ่', 'Maintenance'],
      ['staff1', '1234', 'พนักงานทดสอบ', 'employee', 'สำนักงานใหญ่', 'Accounting']
    ].forEach(r => appendObj_(SHEETS.USERS, {
      Username: r[0], PasswordHash: hash_(r[1], r[0]), FullName: r[2], Role: r[3],
      Branch: r[4], Department: r[5], Email: '', Active: 'TRUE', CreatedAt: now
    }));
  }

  Logger.log('✅ ตั้งค่าฐานข้อมูลเรียบร้อย — ' + ss_().getUrl());
  Logger.log('ผู้ใช้เริ่มต้น: admin / admin1234 (กรุณาเปลี่ยนรหัสผ่านหลัง login)');
}

/**
 * (ทางเลือก) ย้ายข้อมูลจากชีตเวอร์ชันเก่า "RepairData" มาไว้ในชีต "Tickets"
 * ข้อมูลเก่าจะถูกตั้งสาขาเป็น "สำนักงานใหญ่" และคงสถานะเดิมไว้
 */
function migrateOldRepairData() {
  const old = ss_().getSheetByName('RepairData');
  if (!old) { Logger.log('ไม่พบชีต RepairData'); return; }
  const rows = old.getDataRange().getValues().slice(1);
  const existing = readAll_(SHEETS.TICKETS).map(t => String(t.TicketID));
  let n = 0;
  rows.forEach(r => {
    if (!r[0] || existing.indexOf(String(r[0])) > -1) return;
    appendObj_(SHEETS.TICKETS, {
      TicketID: r[0], CreatedAt: r[1], Username: '', Requester: r[2], Branch: 'สำนักงานใหญ่',
      Department: r[3], Location: r[4], Category: r[5], Title: r[6], Description: r[7],
      Priority: r[8], Status: r[9] || ST.PENDING, ImageURL: r[10], UpdatedAt: new Date()
    });
    n++;
  });
  Logger.log('ย้ายข้อมูลแล้ว ' + n + ' รายการ');
}