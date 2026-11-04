/******************************************************************************
 * HR-ASSET-TRACKER : Server Add-on (Login + สมาชิก + ใบเบิก/อนุมัติ + ลายเซ็น)
 * ---------------------------------------------------------------------------
 * วิธีติดตั้ง / อัปเดต:
 *  1) ไฟล์ Code.js ต้องใช้ชื่อ doGetLegacy / doPostLegacy (ห้ามมี doGet / doPost ซ้ำกับไฟล์นี้)
 *  2) ไฟล์ Approval.gs: ลบของเดิมทิ้ง แล้ววางโค้ดนี้ทั้งหมดแทน
 *  3) เลือกฟังก์ชัน setupAdmin ที่แถบด้านบน → กด ▶ Run (ครั้งเดียว)
 *     → ได้ผู้ใช้ admin / รหัส Admin@1234  (เข้าระบบแล้วเปลี่ยนรหัสทันที)
 *  4) Deploy > Manage deployments > ✏️ Edit > Version: New version > Deploy
 *
 * ชีตที่สร้างให้อัตโนมัติ:
 *  - Users    : username | password | passwordHash | salt | fullName | role | branch | active | ...
 *               (เพิ่มผู้ใช้ตรงในชีตได้: ใส่ username + password แบบข้อความ ระบบจะเข้ารหัสให้ตอน Login ครั้งแรก)
 *  - Requests : ใบขอเบิก / ผลการอนุมัติ / ลายเซ็น
 *
 * สิทธิ์ (role):
 *  ADMIN   = HR Admin : ทุกอย่าง + จัดการอุปกรณ์ + จัดการสมาชิก + อนุมัติ
 *  MANAGER = ผู้อนุมัติ/ผู้บริหาร : ดูทุกสาขา + อนุมัติ/ไม่อนุมัติ + พิมพ์ PR
 *  BRANCH  = พนักงานสาขา : ดูสต็อก + ส่งคำขอเบิก (เฉพาะสาขาตัวเอง) + พิมพ์ใบเบิกที่อนุมัติแล้ว
 *
 * สถานะใบเบิก:
 *   PENDING (รออนุมัติ)
 *     → APPROVED (อนุมัติแล้ว · รอ HR จ่ายของ, ตัดสต็อกแล้ว)
 *     → ISSUED   (HR จ่ายของแล้ว · รอฝากส่งไปสาขา)
 *     → SHIPPED  (ฝากส่งแล้ว · กำลังส่งไปสาขา — ฝากฝ่ายบริการ / ฝ่ายขาย / อื่น ๆ)
 *     → RECEIVED (สาขาได้รับของแล้ว · ปิดงาน)
 *   ↘ REJECTED (ไม่อนุมัติ)
 *   * ถ้าผู้รับมารับของเองที่ HR → ISSUED ข้ามไป RECEIVED ได้ทันที
 ******************************************************************************/

const APP_CONFIG = {
  SPREADSHEET_ID: '',                       // เว้นว่างถ้าสคริปต์ผูกกับ Sheet อยู่แล้ว
  REQ_SHEET: 'Requests',
  USERS_SHEET: 'Users',
  IMAGE_FOLDER: 'HR-Asset-Request-Images',  // โฟลเดอร์ Drive เก็บรูปหลักฐาน
  TOKEN_HOURS: 12,                          // อายุการ Login (ชั่วโมง)
  MAX_LOGIN_FAIL: 5,                        // ใส่รหัสผิดได้กี่ครั้งก่อนล็อก
  LOCK_MINUTES: 15,
  TZ: 'Asia/Bangkok'
};

const ROLES = ['ADMIN', 'MANAGER', 'BRANCH'];
const BRANCHES = [
  'สาขาขุขันธ์', 'สาขาเบญจลักษณ์', 'สาขากุฉินารายณ์', 'เดชอุดม',
  'ตระการพืชผล', 'ศรีเมืองใหม่', 'อำนาจเจริญ', 'สำนักงานใหญ่'
];

const REQ_HEADERS = [
  'requestId', 'timestamp', 'assetId', 'assetName', 'category', 'quantity',
  'staffName', 'department', 'branch', 'notes', 'imageUrl', 'imageFileId',
  'requesterSig', 'status', 'approverName', 'approverPosition', 'approverSig',
  'actionAt', 'rejectReason', 'requestedBy', 'approvedBy',
  'issuedBy', 'issuedByName', 'issuedAt', 'issuerSig', 'receiverName', 'receiverSig',
  // ขั้นตอนจัดส่งไปสาขา (เพิ่มคอลัมน์ให้อัตโนมัติในชีตเดิม)
  'deliveryMethod', 'shipVia', 'shipCarrier', 'shipNote', 'shippedBy', 'shippedByName', 'shippedAt',
  'receivedBy', 'receivedAt', 'receiveNote'
];
const SHIP_VIA = ['ฝ่ายบริการ', 'ฝ่ายขาย', 'อื่น ๆ'];
const USER_HEADERS = [
  'username', 'password', 'passwordHash', 'salt', 'fullName', 'role', 'branch',
  'active', 'createdAt', 'updatedAt', 'lastLogin'
];

/* ================================ Router ================================ */
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (!p.action) return legacyGet_(e);                 // หน้าเว็บเดิม (ถ้ามี)
    if (p.action === 'ping') return jsonOut_({ status: 'success', time: new Date().toISOString() });
    if (p.action === 'diag') return jsonOut_(diag_());

    const user = auth_(p.token);
    if (!user) return jsonOut_({ status: 'error', code: 'auth', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });

    switch (p.action) {
      case 'me':          return jsonOut_({ status: 'success', user: publicUser_(user) });
      case 'getRequests': return jsonOut_(listRequests_(user));
      case 'getRequest':  return jsonOut_(getRequestDetail_(p.id, user));
      case 'listUsers':   requireRole_(user, ['ADMIN']); return jsonOut_(listUsers_());
      case 'getLogs':
        if (user.role === 'BRANCH') return jsonOut_(filterLegacyByBranch_(legacyGet_(e), user.branch));
        break;
    }
    return legacyGet_(e);                               // getAssets ฯลฯ ของเดิม
  } catch (err) {
    return jsonOut_({ status: 'error', message: String(err.message || err) });   // ตอบ JSON เสมอ → ไม่เกิด CORS error
  }
}

/** เรียก Code.js อย่างปลอดภัย — ถ้าไม่มีฟังก์ชันจะแจ้งสาเหตุชัดเจน */
function legacyGet_(e) {
  if (typeof doGetLegacy !== 'function') throw new Error(LEGACY_MISSING_MSG_);
  return doGetLegacy(e);
}
function legacyPost_(e) {
  if (typeof doPostLegacy !== 'function') throw new Error(LEGACY_MISSING_MSG_);
  return doPostLegacy(e);
}
const LEGACY_MISSING_MSG_ = 'Server ยังไม่มี doGetLegacy/doPostLegacy — ให้วาง Code.js เวอร์ชันใหม่ทับของเดิม กด Save แล้ว Deploy เป็น New version';

/** ตรวจการติดตั้ง: เปิด WEB_APP_URL?action=diag ในเบราว์เซอร์ */
function diag_() {
  const ss = ss_();
  return {
    status: 'success',
    codeJs_doGetLegacy: typeof doGetLegacy === 'function',
    codeJs_doPostLegacy: typeof doPostLegacy === 'function',
    spreadsheet: ss ? ss.getName() : 'ไม่พบ (ตั้ง SPREADSHEET_ID)',
    sheets: ss ? ss.getSheets().map(s => s.getName()) : [],
    hasUsers: !!(ss && ss.getSheetByName(APP_CONFIG.USERS_SHEET)),
    hasAssetsStock: !!(ss && ss.getSheetByName('Assets_Stock')),
    hasRequisitionLog: !!(ss && ss.getSheetByName('Requisition_Log'))
  };
}

function doPost(e) {
  let data = {};
  try { data = JSON.parse(e.postData.contents); } catch (err) {}
  try {
    if (data.action === 'login') return jsonOut_(login_(data));

    const user = auth_(data.token);
    if (!user) return jsonOut_({ status: 'error', code: 'auth', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });

    switch (data.action) {
      case 'createRequest':  return jsonOut_(createRequest_(data, user));
      case 'approveRequest': requireRole_(user, ['ADMIN', 'MANAGER']); return jsonOut_(decideRequest_(data, true, user));
      case 'rejectRequest':  requireRole_(user, ['ADMIN', 'MANAGER']); return jsonOut_(decideRequest_(data, false, user));
      case 'issueRequest':   requireRole_(user, ['ADMIN']); return jsonOut_(issueRequest_(data, user));
      case 'shipRequest':    requireRole_(user, ['ADMIN']); return jsonOut_(shipRequest_(data, user));
      case 'receiveRequest': return jsonOut_(receiveRequest_(data, user));   // ตรวจสิทธิ์ตามสาขาในฟังก์ชัน
      case 'saveUser':       requireRole_(user, ['ADMIN']); return jsonOut_(saveUser_(data, user));
      case 'changePassword': return jsonOut_(changePassword_(data, user));
      case undefined:
      case '':
        // การเบิกตรง (ตัดสต็อกทันที) ถูกปิด — ต้องผ่านระบบอนุมัติเท่านั้น
        return jsonOut_({ status: 'error', message: 'การเบิกต้องส่งผ่านระบบขออนุมัติ' });
      default:
        // addAsset / editAsset / deleteAsset และ action อื่นของระบบเดิม = ADMIN เท่านั้น
        requireRole_(user, ['ADMIN']);
        return legacyPost_(e);
    }
  } catch (err) {
    return jsonOut_({ status: 'error', message: String(err.message || err) });
  }
}

/* ============================ Authentication ============================ */
function setupAdmin() {
  const t = readTable_(usersSheet_());
  if (t.rows.some(r => String(r.username).toLowerCase() === 'admin')) {
    Logger.log('มีผู้ใช้ admin อยู่แล้ว — ถ้าลืมรหัส ให้พิมพ์รหัสใหม่ในคอลัมน์ password ของชีต Users แล้ว Login อีกครั้ง');
    return;
  }
  const salt = newSalt_();
  appendObj_(t, {
    username: 'admin', password: '', passwordHash: hashPw_('Admin@1234', salt), salt: salt,
    fullName: 'HR Admin', role: 'ADMIN', branch: 'สำนักงานใหญ่', active: 'TRUE',
    createdAt: nowStr_(), updatedAt: nowStr_(), lastLogin: ''
  });
  secret_();
  Logger.log('✓ สร้างผู้ใช้ admin / Admin@1234 แล้ว — เข้าระบบแล้วเปลี่ยนรหัสผ่านทันที');
}

function login_(d) {
  const username = String(d.username || '').trim().toLowerCase();
  const pw = String(d.password || '');
  if (!username || !pw) return { status: 'error', message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' };

  const cache = CacheService.getScriptCache();
  const key = 'LF_' + username;
  const fails = parseInt(cache.get(key) || '0', 10);
  if (fails >= APP_CONFIG.MAX_LOGIN_FAIL) {
    return { status: 'error', message: 'ใส่รหัสผิดเกิน ' + APP_CONFIG.MAX_LOGIN_FAIL + ' ครั้ง ระบบล็อกชั่วคราว ' + APP_CONFIG.LOCK_MINUTES + ' นาที' };
  }

  const t = readTable_(usersSheet_());
  const row = t.rows.find(r => String(r.username).trim().toLowerCase() === username);
  let ok = false;
  if (row && isActive_(row)) {
    const plain = row.password === null || row.password === undefined ? '' : String(row.password);
    if (plain !== '') {
      // รหัสที่พิมพ์ไว้ในชีต → ตรวจแล้วเข้ารหัสเก็บแทน
      ok = plain === pw;
      if (ok) {
        const salt = newSalt_();
        setCell_(t, row._row, 'passwordHash', hashPw_(pw, salt));
        setCell_(t, row._row, 'salt', salt);
        setCell_(t, row._row, 'password', '');
      }
    } else if (row.passwordHash) {
      ok = safeEq_(hashPw_(pw, String(row.salt)), String(row.passwordHash));
    }
  }

  if (!ok) {
    cache.put(key, String(fails + 1), APP_CONFIG.LOCK_MINUTES * 60);
    Utilities.sleep(500);
    const left = APP_CONFIG.MAX_LOGIN_FAIL - fails - 1;
    return { status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' + (left <= 2 ? ' (เหลืออีก ' + left + ' ครั้ง)' : '') };
  }

  cache.remove(key);
  setCell_(t, row._row, 'lastLogin', nowStr_());
  const user = normUser_(row);
  const exp = Date.now() + APP_CONFIG.TOKEN_HOURS * 3600 * 1000;
  return { status: 'success', token: makeToken_(user.username, exp), exp: exp, user: publicUser_(user) };
}

function makeToken_(username, exp) {
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({ u: username, exp: exp }));
  return payload + '.' + Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}

/** ตรวจ token → คืนข้อมูลผู้ใช้ปัจจุบัน (อ่าน role/สาขา/สถานะล่าสุดจากชีต ผ่าน cache 5 นาที) */
function auth_(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], secret_()));
  if (!safeEq_(sig, parts[1])) return null;
  let p;
  try { p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); } catch (e) { return null; }
  if (!p || !p.exp || Date.now() > p.exp) return null;
  const u = getUserCached_(p.u);
  return u && u.active ? u : null;
}

function getUserCached_(username) {
  const cache = CacheService.getScriptCache();
  const key = 'U_' + username;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const row = readTable_(usersSheet_()).rows.find(r => String(r.username).trim().toLowerCase() === username);
  if (!row) return null;
  const u = normUser_(row);
  cache.put(key, JSON.stringify(u), 300);
  return u;
}

function normUser_(row) {
  const role = String(row.role || '').trim().toUpperCase();
  return {
    username: String(row.username).trim().toLowerCase(),
    fullName: String(row.fullName || row.username),
    role: ROLES.indexOf(role) >= 0 ? role : 'BRANCH',
    branch: String(row.branch || ''),
    active: isActive_(row)
  };
}
function publicUser_(u) { return { username: u.username, fullName: u.fullName, role: u.role, branch: u.branch }; }

function requireRole_(user, roles) {
  if (roles.indexOf(user.role) < 0) throw new Error('คุณไม่มีสิทธิ์ใช้งานฟังก์ชันนี้');
}

function isActive_(row) {
  const v = String(row.active === undefined ? '' : row.active).trim().toUpperCase();
  return ['FALSE', '0', 'NO', 'INACTIVE', 'ปิด', 'ปิดใช้งาน'].indexOf(v) < 0;
}

function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('AUTH_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('AUTH_SECRET', s); }
  return s;
}
/** เรียกใน Editor ถ้าต้องการบังคับให้ทุกคน Logout ทันที */
function revokeAllSessions() { PropertiesService.getScriptProperties().deleteProperty('AUTH_SECRET'); Logger.log('✓ ทุกคนต้อง Login ใหม่'); }

function newSalt_() { return Utilities.getUuid().replace(/-/g, ''); }
function hashPw_(pw, salt) {
  let h = salt + '|' + pw;
  for (let i = 0; i < 200; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}
function safeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* =========================== Member Management =========================== */
function listUsers_() {
  return {
    status: 'success',
    data: readTable_(usersSheet_()).rows.map(r => {
      const u = normUser_(r);
      return Object.assign(publicUser_(u), { active: u.active, lastLogin: r.lastLogin || '', createdAt: r.createdAt || '' });
    })
  };
}

function saveUser_(d, admin) {
  const isNew = d.mode === 'add';
  const username = String(d.username || '').trim().toLowerCase();
  const role = String(d.role || '').toUpperCase();
  const branch = String(d.branch || '');
  const fullName = String(d.fullName || '').trim();
  const active = d.active === false || d.active === 'false' ? 'FALSE' : 'TRUE';
  const password = String(d.password || '');

  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return { status: 'error', message: 'Username ต้องเป็น a-z, 0-9, . _ - ยาว 3-30 ตัว' };
  if (!fullName) return { status: 'error', message: 'กรุณาระบุชื่อ-นามสกุล' };
  if (ROLES.indexOf(role) < 0) return { status: 'error', message: 'สิทธิ์ไม่ถูกต้อง' };
  if (branch && BRANCHES.indexOf(branch) < 0) return { status: 'error', message: 'สาขาไม่ถูกต้อง' };
  if (role === 'BRANCH' && !branch) return { status: 'error', message: 'พนักงานสาขาต้องระบุสาขา' };
  if ((isNew || password) && password.length < 6) return { status: 'error', message: 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร' };
  if (!isNew && username === admin.username && (role !== 'ADMIN' || active === 'FALSE')) {
    return { status: 'error', message: 'ไม่สามารถลดสิทธิ์หรือปิดใช้งานบัญชีของตัวเองได้' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = readTable_(usersSheet_());
    const row = t.rows.find(r => String(r.username).trim().toLowerCase() === username);
    if (isNew) {
      if (row) return { status: 'error', message: 'Username "' + username + '" มีอยู่แล้ว' };
      const salt = newSalt_();
      appendObj_(t, {
        username: username, password: '', passwordHash: hashPw_(password, salt), salt: salt,
        fullName: fullName, role: role, branch: branch, active: active,
        createdAt: nowStr_(), updatedAt: nowStr_(), lastLogin: ''
      });
    } else {
      if (!row) return { status: 'error', message: 'ไม่พบผู้ใช้ ' + username };
      setCell_(t, row._row, 'fullName', fullName);
      setCell_(t, row._row, 'role', role);
      setCell_(t, row._row, 'branch', branch);
      setCell_(t, row._row, 'active', active);
      setCell_(t, row._row, 'updatedAt', nowStr_());
      if (password) {
        const salt = newSalt_();
        setCell_(t, row._row, 'passwordHash', hashPw_(password, salt));
        setCell_(t, row._row, 'salt', salt);
        setCell_(t, row._row, 'password', '');
      }
    }
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('U_' + username);   // มีผลทันที
  return { status: 'success' };
}

function changePassword_(d, user) {
  const oldPw = String(d.oldPassword || ''), newPw = String(d.newPassword || '');
  if (newPw.length < 6) return { status: 'error', message: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร' };
  const t = readTable_(usersSheet_());
  const row = t.rows.find(r => String(r.username).trim().toLowerCase() === user.username);
  if (!row) return { status: 'error', message: 'ไม่พบผู้ใช้' };
  const plain = row.password ? String(row.password) : '';
  const ok = plain ? plain === oldPw : safeEq_(hashPw_(oldPw, String(row.salt)), String(row.passwordHash));
  if (!ok) return { status: 'error', message: 'รหัสผ่านเดิมไม่ถูกต้อง' };
  const salt = newSalt_();
  setCell_(t, row._row, 'passwordHash', hashPw_(newPw, salt));
  setCell_(t, row._row, 'salt', salt);
  setCell_(t, row._row, 'password', '');
  setCell_(t, row._row, 'updatedAt', nowStr_());
  return { status: 'success' };
}

/* ============================ Requests / Approval ============================ */
function listRequests_(user) {
  // ไม่ส่งลายเซ็นในรายการ (ลดขนาดข้อมูล → โหลดเร็ว) ดึงเต็มผ่าน getRequest
  return readTable_(reqSheet_()).rows
    .filter(r => user.role !== 'BRANCH' || String(r.branch) === user.branch)
    .reverse()
    .map(r => {
      const o = Object.assign({}, r);
      o.status = effStatus_(r);
      o.hasIssuerSig = !!o.issuerSig;
      o.hasReceiverSig = !!o.receiverSig;
      delete o._row; delete o.requesterSig; delete o.approverSig; delete o.issuerSig; delete o.receiverSig;
      return o;
    });
}

function getRequestDetail_(id, user) {
  const r = readTable_(reqSheet_()).rows.find(x => String(x.requestId) === String(id));
  if (!r || (user.role === 'BRANCH' && String(r.branch) !== user.branch)) {
    return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + id };
  }
  const o = Object.assign({}, r); delete o._row;
  o.status = effStatus_(r);
  return { status: 'success', data: o };
}

function createRequest_(d, user) {
  const branch = user.role === 'BRANCH' && user.branch ? user.branch : String(d.branch || '');
  if (!d.staffName || !d.assetId) return { status: 'error', message: 'ข้อมูลไม่ครบ (ผู้เบิก / อุปกรณ์)' };
  if (BRANCHES.indexOf(branch) < 0) return { status: 'error', message: 'กรุณาเลือกสาขาให้ถูกต้อง' };
  const qty = parseInt(d.quantity, 10);
  if (!(qty > 0)) return { status: 'error', message: 'จำนวนไม่ถูกต้อง' };
  if (!d.requesterSig) return { status: 'error', message: 'กรุณาเซ็นลายเซ็นผู้ขอเบิก' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = readTable_(reqSheet_());
    const now = new Date();
    const prefix = 'RQ-' + Utilities.formatDate(now, APP_CONFIG.TZ, 'yyMMdd') + '-';
    const seq = t.rows.filter(x => String(x.requestId).indexOf(prefix) === 0).length + 1;
    const requestId = prefix + String(seq).padStart(3, '0');
    const img = d.imageBase64 ? saveImage_(d.imageBase64, requestId + '_evidence') : { id: '', url: '' };

    appendObj_(t, {
      requestId: requestId,
      timestamp: Utilities.formatDate(now, APP_CONFIG.TZ, 'dd/MM/yyyy HH:mm'),
      assetId: d.assetId, assetName: d.assetName || '', category: d.category || '',
      quantity: qty, staffName: d.staffName, department: d.department || '',
      branch: branch, notes: d.notes || '-',
      imageUrl: img.url, imageFileId: img.id,
      requesterSig: storeSig_(d.requesterSig, requestId + '_requester'),
      status: 'PENDING', requestedBy: user.username
    });
    return { status: 'success', requestId: requestId };
  } finally {
    lock.releaseLock();
  }
}

function decideRequest_(d, approve, user) {
  const approverName = user.fullName || user.username;     // ใช้ชื่อจากบัญชีที่ Login (ปลอมชื่อไม่ได้)
  if (approve && !d.approverSig) return { status: 'error', message: 'กรุณาเซ็นลายเซ็นผู้อนุมัติ' };
  if (!approve && !d.rejectReason) return { status: 'error', message: 'กรุณาระบุเหตุผลที่ไม่อนุมัติ' };

  // 1) จองสถานะใต้ Lock กันการอนุมัติซ้ำ
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let t, r;
  try {
    t = readTable_(reqSheet_());
    r = t.rows.find(x => String(x.requestId) === String(d.requestId));
    if (!r) return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + d.requestId };
    if (r.status !== 'PENDING') return { status: 'error', message: 'ใบเบิกนี้ถูกพิจารณาไปแล้ว (' + r.status + ')' };
    setCell_(t, r._row, 'status', approve ? 'PROCESSING' : 'REJECTED');
  } finally {
    lock.releaseLock();
  }

  if (approve) {
    // 2) ตัดสต็อก + บันทึก Log ผ่านระบบเดิม (doPostLegacy) ด้วย payload รูปแบบเดิม
    try {
      // ส่งลิงก์รูปใน Drive (ไม่ส่ง base64) → เร็วกว่า และไม่ชนลิมิต 50,000 ตัวอักษรต่อเซลล์ของชีต Log
      const contents = JSON.stringify({
        staffName: r.staffName, department: r.department, branch: r.branch,
        assetId: r.assetId, quantity: Number(r.quantity),
        requisitionNotes: (r.notes || '-') + ' [ใบเบิก ' + r.requestId + ' อนุมัติโดย ' + approverName + ']',
        imageBase64: r.imageUrl || ''
      });
      const out = legacyPost_({ postData: { contents: contents, type: 'text/plain', length: contents.length }, parameter: {}, parameters: {} });
      let j = null;
      try { j = JSON.parse(out && out.getContent ? out.getContent() : ''); } catch (e) {}
      if (j && (j.status === 'error' || j.success === false || j.result === 'error')) {
        throw new Error(j.message || j.error || 'ระบบเดิมแจ้งข้อผิดพลาด');
      }
    } catch (err) {
      setCell_(t, r._row, 'status', 'PENDING');
      return { status: 'error', message: 'ตัดสต็อกไม่สำเร็จ: ' + (err.message || err) };
    }
  }

  // 3) บันทึกผลการพิจารณา
  setCell_(t, r._row, 'approverName', approverName);
  setCell_(t, r._row, 'approverPosition', d.approverPosition || '');
  setCell_(t, r._row, 'approvedBy', user.username);
  if (d.approverSig) setCell_(t, r._row, 'approverSig', storeSig_(d.approverSig, r.requestId + '_approver'));
  setCell_(t, r._row, 'actionAt', nowStr_());
  setCell_(t, r._row, 'rejectReason', approve ? '' : d.rejectReason);
  setCell_(t, r._row, 'status', approve ? 'APPROVED' : 'REJECTED');
  return { status: 'success', requestId: r.requestId };
}

/**
 * สถานะจริงของใบเบิก — ใบเก่า (ก่อนมีขั้นตอนจัดส่ง) ที่เป็น ISSUED และผู้รับเซ็นรับที่ HR แล้ว
 * ถือว่า "ได้รับของแล้ว" (RECEIVED) ไม่ต้องไล่แก้ข้อมูลในชีต
 */
function effStatus_(r) {
  const s = String(r.status || '');
  if (s === 'ISSUED' && r.receiverSig && !r.deliveryMethod) return 'RECEIVED';
  return s;
}

/**
 * ขั้นที่ 3 — HR จ่ายของตามใบเบิกที่อนุมัติแล้ว
 *   deliveryMethod = 'SHIP'   → ISSUED (รอฝากส่งไปสาขา)  [ค่าเริ่มต้น]
 *   deliveryMethod = 'PICKUP' → RECEIVED (ผู้รับมารับเองที่ HR ต้องมีลายเซ็นผู้รับ)
 * ใบที่จ่ายไปแล้วแต่ยังไม่มีลายเซ็น HR → เซ็นย้อนหลังได้ (ไม่เปลี่ยนสถานะ)
 */
function issueRequest_(d, user) {
  if (!d.issuerSig) return { status: 'error', message: 'กรุณาเซ็นลายเซ็นผู้จ่ายพัสดุ (HR)' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = readTable_(reqSheet_());
    const r = t.rows.find(x => String(x.requestId) === String(d.requestId));
    if (!r) return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + d.requestId };
    const st = effStatus_(r);
    const lateSign = ['ISSUED', 'SHIPPED', 'RECEIVED'].indexOf(st) >= 0 && !r.issuerSig;
    if (st !== 'APPROVED' && !lateSign) {
      return { status: 'error', message: 'จ่ายของได้เฉพาะใบเบิกที่อนุมัติแล้ว (สถานะปัจจุบัน: ' + st + ')' };
    }

    if (lateSign) {                                   // เซ็นย้อนหลังอย่างเดียว
      if (!r.issuedBy) {
        setCell_(t, r._row, 'issuedBy', user.username);
        setCell_(t, r._row, 'issuedByName', user.fullName || user.username);
        setCell_(t, r._row, 'issuedAt', nowStr_());
      }
      setCell_(t, r._row, 'issuerSig', storeSig_(d.issuerSig, r.requestId + '_issuer'));
      return { status: 'success', requestId: r.requestId, newStatus: st };
    }

    const pickup = d.deliveryMethod === 'PICKUP';
    const receiverName = String(d.receiverName || '').trim();
    if (pickup && (!receiverName || !d.receiverSig)) {
      return { status: 'error', message: 'รับของเองที่ HR: กรุณาระบุชื่อและลายเซ็นผู้รับพัสดุ' };
    }
    const now = nowStr_();
    setCell_(t, r._row, 'issuedBy', user.username);
    setCell_(t, r._row, 'issuedByName', user.fullName || user.username);
    setCell_(t, r._row, 'issuedAt', now);
    setCell_(t, r._row, 'issuerSig', storeSig_(d.issuerSig, r.requestId + '_issuer'));
    setCell_(t, r._row, 'deliveryMethod', pickup ? 'PICKUP' : 'SHIP');
    if (pickup) {
      setCell_(t, r._row, 'receiverName', receiverName);
      setCell_(t, r._row, 'receiverSig', storeSig_(d.receiverSig, r.requestId + '_receiver'));
      setCell_(t, r._row, 'receivedBy', user.username);
      setCell_(t, r._row, 'receivedAt', now);
      setCell_(t, r._row, 'receiveNote', 'รับของเองที่ HR');
    }
    const newStatus = pickup ? 'RECEIVED' : 'ISSUED';
    setCell_(t, r._row, 'status', newStatus);
    return { status: 'success', requestId: r.requestId, newStatus: newStatus };
  } finally {
    lock.releaseLock();
  }
}

/** ขั้นที่ 4 — HR บันทึกการฝากส่งของไปสาขา (ฝากฝ่ายบริการ / ฝ่ายขาย / อื่น ๆ) → SHIPPED */
function shipRequest_(d, user) {
  const via = String(d.shipVia || '').trim();
  const carrier = String(d.shipCarrier || '').trim();
  if (SHIP_VIA.indexOf(via) < 0) return { status: 'error', message: 'กรุณาเลือกช่องทางที่ฝากส่ง' };
  if (!carrier) return { status: 'error', message: 'กรุณาระบุชื่อผู้นำส่ง' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = readTable_(reqSheet_());
    const r = t.rows.find(x => String(x.requestId) === String(d.requestId));
    if (!r) return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + d.requestId };
    const st = effStatus_(r);
    // ISSUED = ฝากส่งครั้งแรก · SHIPPED = แก้ไขข้อมูลผู้นำส่ง (เช่น เปลี่ยนคนฝาก)
    if (st !== 'ISSUED' && st !== 'SHIPPED') {
      return { status: 'error', message: 'บันทึกฝากส่งได้เฉพาะใบที่ HR จ่ายของแล้ว (สถานะปัจจุบัน: ' + st + ')' };
    }
    setCell_(t, r._row, 'deliveryMethod', 'SHIP');
    setCell_(t, r._row, 'shipVia', via);
    setCell_(t, r._row, 'shipCarrier', carrier);
    setCell_(t, r._row, 'shipNote', String(d.shipNote || '').trim());
    setCell_(t, r._row, 'shippedBy', user.username);
    setCell_(t, r._row, 'shippedByName', user.fullName || user.username);
    setCell_(t, r._row, 'shippedAt', nowStr_());
    setCell_(t, r._row, 'status', 'SHIPPED');
    return { status: 'success', requestId: r.requestId, newStatus: 'SHIPPED' };
  } finally {
    lock.releaseLock();
  }
}

/** ขั้นที่ 5 — สาขายืนยันได้รับของ (พนักงานสาขาเดียวกัน / ADMIN / MANAGER) → RECEIVED */
function receiveRequest_(d, user) {
  const receiverName = String(d.receiverName || '').trim();
  if (!receiverName) return { status: 'error', message: 'กรุณาระบุชื่อผู้รับพัสดุ' };
  if (!d.receiverSig) return { status: 'error', message: 'กรุณาเซ็นลายเซ็นผู้รับพัสดุ' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = readTable_(reqSheet_());
    const r = t.rows.find(x => String(x.requestId) === String(d.requestId));
    if (!r || (user.role === 'BRANCH' && String(r.branch) !== user.branch)) {
      return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + d.requestId };
    }
    const st = effStatus_(r);
    if (st !== 'SHIPPED' && st !== 'ISSUED') {
      return { status: 'error', message: 'ยืนยันรับของได้เฉพาะใบที่ HR จ่าย/ฝากส่งแล้ว (สถานะปัจจุบัน: ' + st + ')' };
    }
    setCell_(t, r._row, 'receiverName', receiverName);
    setCell_(t, r._row, 'receiverSig', storeSig_(d.receiverSig, r.requestId + '_receiver'));
    setCell_(t, r._row, 'receivedBy', user.username);
    setCell_(t, r._row, 'receivedAt', nowStr_());
    setCell_(t, r._row, 'receiveNote', String(d.receiveNote || '').trim());
    if (!r.deliveryMethod) setCell_(t, r._row, 'deliveryMethod', 'SHIP');
    setCell_(t, r._row, 'status', 'RECEIVED');
    return { status: 'success', requestId: r.requestId, newStatus: 'RECEIVED' };
  } finally {
    lock.releaseLock();
  }
}

function filterLegacyByBranch_(out, branch) {
  try {
    const data = JSON.parse(out.getContent());
    return Array.isArray(data) ? data.filter(x => String(x.branch) === branch) : data;
  } catch (e) { return []; }
}

/* ================================ Helpers ================================ */
function ss_() {
  return APP_CONFIG.SPREADSHEET_ID ? SpreadsheetApp.openById(APP_CONFIG.SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}
function reqSheet_()   { return ensureSheet_(APP_CONFIG.REQ_SHEET, REQ_HEADERS, '#e0e7ff'); }
function usersSheet_() { return ensureSheet_(APP_CONFIG.USERS_SHEET, USER_HEADERS, '#fee2e2'); }

/** สร้างชีต/เติมหัวคอลัมน์ที่ขาดให้อัตโนมัติ (รองรับชีตจากเวอร์ชันเก่า) */
function ensureSheet_(name, headers, color) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange('A:Z').setNumberFormat('@');           // เก็บเป็นข้อความ กัน Sheets แปลงรหัส/วันที่เอง
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground(color);
    sh.setFrozenRows(1);
    return sh;
  }
  const cur = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  const missing = headers.filter(h => cur.indexOf(h) < 0);
  if (missing.length) {
    sh.getRange(1, cur.filter(String).length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground(color);
  }
  return sh;
}

function readTable_(sh) {
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) continue;
    const o = { _row: i + 1 };
    headers.forEach((h, c) => {
      const v = values[i][c];
      o[h] = v instanceof Date ? Utilities.formatDate(v, APP_CONFIG.TZ, 'dd/MM/yyyy HH:mm') : v;
    });
    rows.push(o);
  }
  return { sh: sh, headers: headers, rows: rows };
}

function appendObj_(t, obj) {
  t.sh.appendRow(t.headers.map(h => obj[h] !== undefined ? obj[h] : ''));
}

function setCell_(t, rowNum, key, value) {
  const c = t.headers.indexOf(key);
  if (c >= 0) t.sh.getRange(rowNum, c + 1).setValue(value);
}

function nowStr_() { return Utilities.formatDate(new Date(), APP_CONFIG.TZ, 'dd/MM/yyyy HH:mm'); }

/** ลายเซ็น PNG ขนาดเล็กเก็บในเซลล์ได้เลย ถ้าใหญ่เกิน limit เซลล์ (50,000 ตัวอักษร) จะเก็บใน Drive แทน */
function storeSig_(dataUrl, name) {
  if (!dataUrl) return '';
  if (String(dataUrl).length < 45000) return dataUrl;
  return saveImage_(dataUrl, name).url;
}

function saveImage_(dataUrl, name) {
  const m = String(dataUrl).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) return { id: '', url: '' };
  const ext = m[1] === 'image/png' ? '.png' : '.jpg';
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name + ext);
  const file = getImageFolder_().createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { id: file.getId(), url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1000' };
}

function getImageFolder_() {
  const it = DriveApp.getFoldersByName(APP_CONFIG.IMAGE_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(APP_CONFIG.IMAGE_FOLDER);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}