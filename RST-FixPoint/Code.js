/**
 * RST FixPoint — ระบบแจ้งซ่อมอาคารและอุปกรณ์สำนักงาน | รวมสินไทยกรุ๊ป
 * Backend: Google Apps Script + Google Sheets
 *
 * CODE_VERSION: r07-2026-11-04-approver-signature
 *
 * ฟีเจอร์:
 *  - Login / Session token (CacheService, อายุ 6 ชม.)
 *  - Role: employee / technician / manager / admin
 *  - สาขา (Branches) — ผู้ใช้ผูกกับสาขา, manager/technician เห็นเฉพาะสาขาตัวเอง (ยกเว้น Branch = ALL)
 *  - Workflow: Pending -> Approved -> In Progress -> Completed  (หรือ Rejected / Cancelled)
 *  - Dashboard สรุปภาพรวม
 *  - จัดการผู้ใช้ / สาขา (admin)
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

const CODE_VERSION = 'r07-2026-11-04-approver-signature';

// 📌 ID ของ Google Sheet ฐานข้อมูล (ถ้าสคริปต์นี้สร้างจาก Extensions > Apps Script ของชีตอยู่แล้ว เว้นว่างได้)
const SPREADSHEET_ID = '';

// 📌 ID ของโฟลเดอร์ Google Drive เก็บรูป (ใส่เฉพาะ ID ไม่ใช่ URL ทั้งเส้น)
//    = โฟลเดอร์ "RST-FixPoint" https://drive.google.com/drive/folders/1zeldR0MkzazzzK3X4HMfdeh5hWKW5o_I
const FOLDER_ID = '1zeldR0MkzazzzK3X4HMfdeh5hWKW5o_I';

const TZ = 'Asia/Bangkok';
const SESSION_SECONDS = 21600; // 6 ชม. (สูงสุดของ CacheService)
const PW_SALT = 'RST-FixPoint-v1';

const SHEETS = {
  USERS: {
    name: 'Users',
    headers: ['Username', 'PasswordHash', 'FullName', 'Role', 'Branch', 'Department', 'Email', 'Active', 'CreatedAt', 'LastLogin']
  },
  BRANCHES: {
    name: 'Branches',
    headers: ['BranchCode', 'BranchName', 'Active']
  },
  TICKETS: {
    name: 'Tickets',
    headers: ['TicketID', 'CreatedAt', 'Username', 'Requester', 'Branch', 'Department', 'Location', 'Category', 'Title',
      'Description', 'Priority', 'Status', 'ImageURL', 'ApprovedBy', 'ApprovedAt', 'ManagerNote', 'Technician',
      'TechnicianName', 'AcceptedAt', 'CompletedAt', 'TechNote', 'AfterImageURL', 'UpdatedAt', 'ApproverSignURL']
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
  me:              { roles: ALL_ROLES, fn: (u) => ({ user: publicUser_(u) }) },
  logout:          { roles: ALL_ROLES, fn: (u, r) => { CacheService.getScriptCache().remove('sess_' + r.token); return {}; } },
  changePassword:  { roles: ALL_ROLES, fn: changePassword_, write: true },
  getBranches:     { roles: ALL_ROLES, fn: () => ({ branches: getBranches_(false) }) },

  createTicket:    { roles: ALL_ROLES, fn: createTicket_, write: true },
  listTickets:     { roles: ALL_ROLES, fn: listTickets_ },
  getTicket:       { roles: ALL_ROLES, fn: getTicket_ },
  printTickets:    { roles: ALL_ROLES, fn: printTickets_ },
  getImage:        { roles: ALL_ROLES, fn: getImage_ },
  cancelTicket:    { roles: ALL_ROLES, fn: cancelTicket_, write: true },

  approveTicket:   { roles: MGR, fn: approveTicket_, write: true },
  rejectTicket:    { roles: MGR, fn: rejectTicket_, write: true },
  assignTechnician:{ roles: MGR, fn: assignTechnician_, write: true },
  listTechnicians: { roles: MGR, fn: (u) => ({ technicians: listTechnicians_(u) }) },
  dashboard:       { roles: MGR, fn: dashboard_ },

  acceptTicket:    { roles: TECH, fn: acceptTicket_, write: true },
  updateProgress:  { roles: TECH, fn: updateProgress_, write: true },
  completeTicket:  { roles: TECH, fn: completeTicket_, write: true },

  listUsers:       { roles: ADMIN, fn: () => ({ users: readAll_(SHEETS.USERS).map(publicUser_) }) },
  saveUser:        { roles: ADMIN, fn: saveUser_, write: true },
  getAllBranches:  { roles: ADMIN, fn: () => ({ branches: getBranches_(true) }) },
  saveBranch:      { roles: ADMIN, fn: saveBranch_, write: true }
};

function doPost(e) {
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

function ss_() {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ไม่พบ Google Sheet — กรุณาใส่ SPREADSHEET_ID ใน Code.gs');
  return ss;
}

function sheet_(def) {
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
    }
  }
  return sh;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function readAll_(def) {
  const sh = sheet_(def);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = values[0].map(String);
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(c => c === '' || c === null)) continue;
    const o = { _row: i + 1 };
    h.forEach((k, j) => { if (k) o[k] = r[j]; });
    out.push(o);
  }
  return out;
}

function appendObj_(def, obj) {
  const sh = sheet_(def);
  const h = headers_(sh);
  sh.appendRow(h.map(k => (obj[k] !== undefined && obj[k] !== null ? obj[k] : '')));
}

function updateRow_(def, row, patch) {
  const sh = sheet_(def);
  const h = headers_(sh);
  const rng = sh.getRange(row, 1, 1, h.length);
  const vals = rng.getValues()[0];
  h.forEach((k, i) => { if (Object.prototype.hasOwnProperty.call(patch, k)) vals[i] = patch[k]; });
  rng.setValues([vals]);
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
    lastLogin: u.LastLogin instanceof Date ? u.LastLogin.toISOString() : String(u.LastLogin || '')
  };
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

  const stored = String(u.PasswordHash || '');
  // รองรับกรณีแอดมินพิมพ์รหัสผ่านแบบตัวอักษรธรรมดาในชีต -> จะถูกแปลงเป็น hash อัตโนมัติเมื่อ login สำเร็จครั้งแรก
  const okPw = isHash_(stored) ? stored === hash_(password, username) : stored === password;
  if (!okPw) throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');

  if (ROLES.indexOf(String(u.Role)) === -1) throw new Error('บทบาทผู้ใช้ไม่ถูกต้อง (' + u.Role + ') กรุณาติดต่อผู้ดูแลระบบ');

  const patch = { LastLogin: new Date() };
  if (!isHash_(stored)) patch.PasswordHash = hash_(password, username);
  updateRow_(SHEETS.USERS, u._row, patch);

  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('sess_' + token, norm_(u.Username), SESSION_SECONDS);

  return { token: token, user: publicUser_(u), codeVersion: CODE_VERSION };
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
  if (newPw.length < 4) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร');
  const stored = String(u.PasswordHash || '');
  const okPw = isHash_(stored) ? stored === hash_(oldPw, u.Username) : stored === oldPw;
  if (!okPw) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  updateRow_(SHEETS.USERS, u._row, { PasswordHash: hash_(newPw, u.Username) });
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
function saveImage_(image, prefix) {
  if (!image || !image.base64) return { url: '', warning: '' };
  let file;
  try {
    const parts = String(image.base64).split(',');
    const bytes = Utilities.base64Decode(parts.length > 1 ? parts[1] : parts[0]);
    const ext = /png/i.test(image.type || '') ? '.png' : '.jpg';
    const name = prefix + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss') + ext; // เช่น FIX-261104-001_before_20261104-153000.jpg
    const blob = Utilities.newBlob(bytes, image.type || 'image/jpeg', name);
    file = DriveApp.getFolderById(FOLDER_ID).createFile(blob);
  } catch (e) {
    Logger.log('saveImage_ createFile error: ' + e);
    return { url: '', warning: 'บันทึกงานแล้ว แต่อัปโหลดรูปไม่สำเร็จ (' + driveHint_(e) + ')' };
  }
  try { file.setDescription('RST FixPoint · ' + prefix + ' · ไฟล์ต้นฉบับ: ' + (image.name || '-')); } catch (e) { /* ไม่สำคัญ */ }

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
  tickets.forEach(t => {
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

function createTicket_(u, req) {
  const d = req.ticket || {};
  ['title', 'location', 'category'].forEach(k => {
    if (!String(d[k] || '').trim()) throw new Error('กรุณากรอกข้อมูลให้ครบ (' + k + ')');
  });

  let branch = String(d.branch || '').trim();
  if (!isAllBranch_(u)) branch = String(u.Branch); // ผู้ใช้สาขาหนึ่งแจ้งได้เฉพาะสาขาตัวเอง
  if (!branch) throw new Error('กรุณาเลือกสาขา');

  const tickets = readAll_(SHEETS.TICKETS);
  const id = nextTicketId_(tickets);
  const img = saveImage_(d.image, id + '_before');
  const imageUrl = img.url;
  const now = new Date();

  appendObj_(SHEETS.TICKETS, {
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
    ImageURL: imageUrl,
    UpdatedAt: now
  });
  addLog_(id, 'สร้างรายการแจ้งซ่อม', u, '', ST.PENDING, d.title);

  return { ticketId: id, message: 'บันทึกข้อมูลแจ้งซ่อมเรียบร้อยแล้ว', warning: img.warning };
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
  return { tickets: list.slice(0, limit).map(clean_), total: list.length };
}

function getTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (!canSee_(u, t)) throw new Error('คุณไม่มีสิทธิ์ดูรายการนี้');
  const logs = readAll_(SHEETS.LOGS)
    .filter(l => String(l.TicketID) === String(t.TicketID))
    .sort((a, b) => (toDate_(a.Timestamp) || 0) - (toDate_(b.Timestamp) || 0))
    .map(clean_);
  return { ticket: clean_(t), logs: logs };
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
      ticket: clean_(t),
      logs: logs.filter(l => String(l.TicketID) === id)
        .sort((a, b) => (toDate_(a.Timestamp) || 0) - (toDate_(b.Timestamp) || 0)).map(clean_)
    };
    item.signImg = imageData_(t.ApproverSignURL);
    if (req.withImages) {
      item.beforeImg = imageData_(t.ImageURL);
      item.afterImg = imageData_(t.AfterImageURL);
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
  const t = readAll_(SHEETS.TICKETS).find(x => [x.ImageURL, x.AfterImageURL, x.ApproverSignURL].some(v => fileIdFromUrl_(v) === id));
  if (!t || !canSee_(u, t)) throw new Error('ไม่มีสิทธิ์ดูรูปนี้');
  return { data: imageData_(req.url) };
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
  updateRow_(SHEETS.TICKETS, t._row, { TechNote: note, UpdatedAt: new Date() });
  addLog_(t.TicketID, 'อัปเดตความคืบหน้า', u, t.Status, t.Status, note);
  return { message: 'บันทึกความคืบหน้าแล้ว' };
}

function completeTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  requireStatus_(t, [ST.IN_PROGRESS]);
  if (u.Role !== 'admin' && norm_(t.Technician) !== norm_(u.Username)) throw new Error('งานนี้ไม่ใช่งานของคุณ');
  const afterImg = saveImage_(req.image, t.TicketID + '_after');
  const after = afterImg.url;
  const extra = { CompletedAt: new Date(), TechNote: String(req.note || t.TechNote || '') };
  if (after) extra.AfterImageURL = after;
  const res = transition_(u, t, ST.COMPLETED, 'ปิดงานซ่อม (เสร็จสิ้น)', req.note, extra);
  res.warning = afterImg.warning;
  return res;
}

function cancelTicket_(u, req) {
  const t = getTicketRow_(req.ticketId);
  if (norm_(t.Username) !== norm_(u.Username) && u.Role !== 'admin') throw new Error('ยกเลิกได้เฉพาะรายการที่คุณแจ้งเอง');
  requireStatus_(t, [ST.PENDING]);
  return transition_(u, t, ST.CANCELLED, 'ยกเลิกการแจ้งซ่อม', req.note);
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

  if (existing) {
    if (norm_(existing.Username) === norm_(u.Username) && (rec.Role !== 'admin' || rec.Active === 'FALSE')) {
      throw new Error('ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้');
    }
    if (d.password) rec.PasswordHash = hash_(d.password, username);
    updateRow_(SHEETS.USERS, existing._row, rec);
    return { message: 'อัปเดตผู้ใช้ ' + username + ' แล้ว' };
  }

  if (!d.password || String(d.password).length < 4) throw new Error('ผู้ใช้ใหม่ต้องตั้งรหัสผ่านอย่างน้อย 4 ตัวอักษร');
  rec.PasswordHash = hash_(d.password, username);
  rec.CreatedAt = new Date();
  appendObj_(SHEETS.USERS, rec);
  return { message: 'เพิ่มผู้ใช้ ' + username + ' แล้ว' };
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