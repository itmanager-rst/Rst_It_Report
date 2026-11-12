/******************************************************************************
 * HR-ASSET-TRACKER : Server Add-on (Login + สมาชิก + ใบเบิก/อนุมัติ + ลายเซ็น)
 * ---------------------------------------------------------------------------
 * วิธีติดตั้ง / อัปเดต:
 *  1) ไฟล์ Code.js ต้องใช้ชื่อ doGetLegacy / doPostLegacy (ห้ามมี doGet / doPost ซ้ำกับไฟล์นี้)
 *  2) ไฟล์ Approval.gs: ลบของเดิมทิ้ง แล้ววางโค้ดนี้ทั้งหมดแทน
 *  3) เลือกฟังก์ชัน setupAdmin ที่แถบด้านบน → กด ▶ Run (ครั้งเดียว)
 *     → ได้ผู้ใช้ admin / รหัส Admin@1234  (เข้าระบบแล้วเปลี่ยนรหัสทันที)
 *  4) (ใหม่) เลือกฟังก์ชัน setupHQOffice → ▶ Run (ครั้งเดียว) สร้างชีต HQ_Office + ตัวอย่างเครื่องเขียน
 *     จากนั้นเพิ่มผู้ใช้ Role = HQ_ADMIN ในเมนู 👥 จัดการสมาชิก ให้แอดมินฝั่ง HQ_Office
 *  5) Deploy > Manage deployments > ✏️ Edit > Version: New version > Deploy
 *
 * ชีตที่สร้างให้อัตโนมัติ:
 *  - Users    : username | password | passwordHash | salt | fullName | role | branch | active | ...
 *               (เพิ่มผู้ใช้ตรงในชีตได้: ใส่ username + password แบบข้อความ ระบบจะเข้ารหัสให้ตอน Login ครั้งแรก)
 *  - Requests : ใบขอเบิก / ผลการอนุมัติ / ลายเซ็น
 *
 * สิทธิ์ (role):
 *  ADMIN    = HR Admin        : จัดการคลัง HR + อนุมัติ/จ่ายของ + จัดการสมาชิก (เมนูสมาชิกเฉพาะ ADMIN)
 *  HQ_ADMIN = HQ_Office Admin : จัดการคลัง HQ_Office + อนุมัติ/จ่ายของ
 *     ★ แอดมิน 2 ฝ่าย "ทำแทนกันได้" — ADMIN / HQ_ADMIN จัดการสต็อก อนุมัติ จ่ายของ ยกเลิก ได้ทั้งคลัง HR และ HQ_Office
 *       (ระบบบันทึกหมายเหตุ "ทำแทน ..." ในประวัติสต็อก / ใบเบิก ให้ตรวจย้อนหลังได้)
 *  MANAGER  = ผู้อนุมัติ/ผู้บริหาร : ดูทุกสาขา + อนุมัติ/ไม่อนุมัติ (ทั้ง 2 แผนก) + พิมพ์ PR
 *  BRANCH   = พนักงานสาขา : ดูสต็อก + ส่งคำขอเบิก (เฉพาะสาขาตัวเอง) + พิมพ์ใบเบิกที่อนุมัติแล้ว
 *
 * 🏢 แผนก / คลัง (แยกฐานข้อมูลเด็ดขาด)
 *  HR : Requests     (เลขที่ RQ-yyMMdd-001)  · Assets_Stock / Requisition_Log / Stock_Movements
 *  HQ : HQ_Requests  (เลขที่ HQ-yyMMdd-001)  · HQ_Assets_Stock / HQ_Requisition_Log / HQ_Stock_Movements
 *  พนักงานเบิกของทั้ง 2 แผนกพร้อมกันได้ในการกดส่งครั้งเดียว → ระบบแยกเป็นใบเบิกของแต่ละแผนกให้อัตโนมัติ
 *  รายงาน / Export ดึงรวมกันได้ (dept=ALL)
 *
 * สถานะใบเบิก:
 *   PENDING (รออนุมัติ)
 *     → APPROVED (อนุมัติแล้ว · รอ HR จ่ายของ, ตัดสต็อกแล้ว)
 *     → ISSUED   (HR จ่ายของแล้ว · รอฝากส่งไปสาขา)
 *     → SHIPPED  (ฝากส่งแล้ว · กำลังส่งไปสาขา — ฝากฝ่ายบริการ / ฝ่ายขาย / อื่น ๆ)
 *     → RECEIVED (สาขาได้รับของแล้ว · ปิดงาน)
 *   ↘ REJECTED (ไม่อนุมัติ)
 *   ↘ CANCELLED (ยกเลิก) — PENDING: ผู้ขอ/ผู้อนุมัติ/ADMIN ยกเลิกได้
 *                         APPROVED / ISSUED: ADMIN ยกเลิกได้ → คืนยอดเข้าคลัง + บันทึกประวัติสต็อก
 *   * ผู้รับมารับของเองที่ HR → แอดมินจ่ายของ (แนบรูป) = ISSUED (deliveryMethod=PICKUP)
 *     → พนักงานผู้มารับกด 📥 ยืนยันรับของในระบบเอง (เซ็น หรือ แนบรูป) → RECEIVED
 *   * จ่ายของ: แนบรูปหลักฐาน (issuerPhoto) แทนการเซ็น · รับของ: เซ็น หรือ แนบรูปใบเบิกที่เซ็นรับแล้ว อย่างใดอย่างหนึ่ง
 *
 * ✏️ HQ_Office พิมพ์ชื่อสินค้าเองได้ (MANUAL_ITEM_DEPTS) — items[].manual = true, assetId ว่าง
 *    อนุมัติ → บันทึกใน HQ_Requisition_Log (รหัสว่าง) แต่ไม่ตัดสต็อก · ยกเลิก → ลบประวัติ ไม่คืนยอด
 * ใบเบิก 1 ใบเบิกได้หลายรายการ (สูงสุด MAX_REQ_ITEMS) — เก็บในคอลัมน์ items (JSON)
 *   อนุมัติ = ตรวจยอดคงเหลือทุกรายการก่อน ถ้ามีรายการไหนไม่พอจะไม่ตัดสต็อกเลย
 *   ยกเลิก  = คืนยอดทุกรายการของใบนั้น
 *
 * ประวัติการเคลื่อนไหวสต็อก (รับเข้า/เบิกออก/ปรับยอด/ยกเลิก) → ชีต Stock_Movements (ดูใน Code.js)
 ******************************************************************************/

const APP_CONFIG = {
  SPREADSHEET_ID: '',                       // เว้นว่างถ้าสคริปต์ผูกกับ Sheet อยู่แล้ว
  REQ_SHEET: 'Requests',                    // ใบเบิก HR (ชื่อเดิม)
  HQ_REQ_SHEET: 'HQ_Requests',              // ใบเบิก HQ_Office (แยกชีต)
  USERS_SHEET: 'Users',
  IMAGE_FOLDER: 'HR-Asset-Request-Images',  // โฟลเดอร์ Drive เก็บรูปหลักฐาน
  TOKEN_HOURS: 12,                          // อายุการ Login (ชั่วโมง)
  MAX_LOGIN_FAIL: 5,                        // ใส่รหัสผิดได้กี่ครั้งก่อนล็อก
  LOCK_MINUTES: 15,
  TZ: 'Asia/Bangkok'
};

const ROLES = ['ADMIN', 'HQ_ADMIN', 'MANAGER', 'BRANCH'];
const ADMIN_ROLES = ['ADMIN', 'HQ_ADMIN'];             // แอดมินคลัง — ทำแทนกันได้ทั้ง 2 แผนก
const APPROVER_ROLES = ['ADMIN', 'HQ_ADMIN', 'MANAGER'];
const DEPT_LABEL = { HR: 'HR', HQ: 'HQ_Office' };
const REQ_PREFIX = { HR: 'RQ-', HQ: 'HQ-' };
/** แผนกต้นสังกัดของแอดมิน (ใช้บันทึกว่า "ทำแทน" อีกฝ่าย) */
function homeDept_(user) { return user.role === 'HQ_ADMIN' ? 'HQ' : user.role === 'ADMIN' ? 'HR' : ''; }
function isAdmin_(user) { return ADMIN_ROLES.indexOf(user.role) >= 0; }
/** " (ทำแทน HQ_Office)" เมื่อแอดมินของอีกฝ่ายเป็นผู้ทำรายการ */
function proxyTag_(user, dept) {
  const h = homeDept_(user);
  return h && h !== normDept_(dept) ? ' (ทำแทน ' + DEPT_LABEL[normDept_(dept)] + ')' : '';
}
/** เลขที่ใบเบิก → แผนก (HQ-... = HQ, อื่น ๆ = HR) */
function reqDept_(id) { return /^HQ-/i.test(String(id || '').trim()) ? 'HQ' : 'HR'; }
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
  'receivedBy', 'receivedAt', 'receiveNote',
  // เชื่อมกับประวัติการเบิก + การยกเลิกใบเบิก
  'txId', 'cancelledBy', 'cancelledByName', 'cancelledAt', 'cancelReason',
  // ใบเบิกหลายรายการ: JSON [{assetId, assetName, category, quantity}]  (ใบเก่าที่ไม่มีค่า = 1 รายการจาก assetId/quantity)
  'items',
  // รูปหลักฐาน (ลิงก์ Drive): ผู้จ่ายแนบรูปแทนลายเซ็น · ผู้รับแนบรูปใบเบิกที่เซ็นรับแล้ว
  'issuerPhoto', 'receiverPhoto'
];
const MAX_REQ_ITEMS = 30;                   // จำนวนรายการสูงสุดต่อใบเบิก
/**
 * ✏️ แผนกที่ให้ "พิมพ์ชื่อสินค้าเอง" ได้ (ไม่ต้องเพิ่มเข้าสต็อกก่อน · อนุมัติแล้วบันทึกประวัติการเบิก แต่ไม่ตัดสต็อก)
 *    ใช้ระหว่างที่ HQ_Office ปรับปรุงฐานข้อมูล — เสร็จแล้วเปลี่ยนเป็น [] เพื่อปิด (และแก้ MANUAL_ITEM_DEPTS ใน index.html ด้วย)
 */
const MANUAL_ITEM_DEPTS = ['HQ'];
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
      case 'getMovements':
        requireRole_(user, APPROVER_ROLES);
        if (typeof getStockMovements !== 'function') throw new Error(LEGACY_MISSING_MSG_);
        return jsonOut_({ status: 'success', data: getStockMovements(p.dept || 'ALL') });
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
    hasRequisitionLog: !!(ss && ss.getSheetByName('Requisition_Log')),
    hasHQ_AssetsStock: !!(ss && ss.getSheetByName('HQ_Assets_Stock')),
    hasHQ_RequisitionLog: !!(ss && ss.getSheetByName('HQ_Requisition_Log')),
    hasHQ_Requests: !!(ss && ss.getSheetByName(APP_CONFIG.HQ_REQ_SHEET)),
    codeJs_multiDept: typeof normDept_ === 'function' && typeof stockSheet_ === 'function'
  };
}

function doPost(e) {
  let data = {};
  try { data = JSON.parse(e.postData.contents); } catch (err) {}
  try {
    if (data.action === 'login') return jsonOut_(login_(data));

    const user = auth_(data.token);
    if (!user) return jsonOut_({ status: 'error', code: 'auth', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    MOVE_ACTOR_ = { username: user.username, fullName: user.fullName };   // ผู้ทำรายการ → ประวัติสต็อก (Code.js)

    switch (data.action) {
      case 'createRequest':  return jsonOut_(createRequest_(data, user));
      case 'approveRequest': requireRole_(user, APPROVER_ROLES); return jsonOut_(decideRequest_(data, true, user));
      case 'rejectRequest':  requireRole_(user, APPROVER_ROLES); return jsonOut_(decideRequest_(data, false, user));
      case 'issueRequest':   requireRole_(user, ADMIN_ROLES); return jsonOut_(issueRequest_(data, user));
      case 'shipRequest':    requireRole_(user, ADMIN_ROLES); return jsonOut_(shipRequest_(data, user));
      case 'receiveRequest': return jsonOut_(receiveRequest_(data, user));   // ตรวจสิทธิ์ตามสาขาในฟังก์ชัน
      case 'cancelRequest':  return jsonOut_(cancelRequest_(data, user));    // ตรวจสิทธิ์ตามสถานะในฟังก์ชัน
      case 'setupHQ':        requireRole_(user, ADMIN_ROLES); setupHQOffice(); reqSheet_('HQ'); return jsonOut_({ status: 'success', message: 'สร้างชีต HQ_Office เรียบร้อย' });
      case 'saveUser':       requireRole_(user, ['ADMIN']); return jsonOut_(saveUser_(data, user));
      case 'changePassword': return jsonOut_(changePassword_(data, user));
      case undefined:
      case '':
        // การเบิกตรง (ตัดสต็อกทันที) ถูกปิด — ต้องผ่านระบบอนุมัติเท่านั้น
        return jsonOut_({ status: 'error', message: 'การเบิกต้องส่งผ่านระบบขออนุมัติ' });
      default:
        // addAsset / editAsset / deleteAsset / deleteLog = แอดมินคลัง (HR หรือ HQ_Office ทำแทนกันได้ทั้ง 2 คลัง)
        requireRole_(user, ADMIN_ROLES);
        if (typeof normDept_ !== 'function') throw new Error(LEGACY_MISSING_MSG_);
        MOVE_ACTOR_.fullName = (user.fullName || user.username) + proxyTag_(user, data.dept);
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
  // รวมใบเบิกของ HR (Requests) + HQ_Office (HQ_Requests) → เรียงใหม่ → เก่า
  const all = [];
  ['HR', 'HQ'].forEach(dept => {
    const sh = dept === 'HQ' && !ss_().getSheetByName(APP_CONFIG.HQ_REQ_SHEET) ? null : reqSheet_(dept);
    if (!sh) return;
    readTable_(sh).rows.forEach((r, i) => { r.dept = dept; r._ord = i; all.push(r); });
  });
  return all
    .filter(r => user.role !== 'BRANCH' || String(r.branch) === user.branch)
    .sort((a, b) => (tsNum_(b.timestamp) - tsNum_(a.timestamp)) || (b._ord - a._ord))
    .map(r => {
      const o = Object.assign({}, r);
      delete o._ord;
      o.status = effStatus_(r);
      o.items = reqItems_(r);
      o.hasIssuerSig = !!(o.issuerSig || o.issuerPhoto);       // มีลายเซ็น หรือ รูปหลักฐานการจ่าย
      o.hasReceiverSig = !!(o.receiverSig || o.receiverPhoto);
      delete o._row; delete o.requesterSig; delete o.approverSig; delete o.issuerSig; delete o.receiverSig;
      return o;
    });
}

/** "dd/MM/yyyy HH:mm" → ตัวเลขสำหรับเรียงลำดับ */
function tsNum_(v) {
  const m = String(v || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return 0;
  return Number(m[3]) * 1e8 + Number(m[2]) * 1e6 + Number(m[1]) * 1e4 + Number(m[4] || 0) * 100 + Number(m[5] || 0);
}

/** หาใบเบิกจากเลขที่ (เลือกชีตตามแผนกจาก prefix) → { t, r, dept } */
function findReq_(id) {
  const dept = reqDept_(id);
  const t = readTable_(reqSheet_(dept));
  const r = t.rows.find(x => String(x.requestId) === String(id));
  if (r) r.dept = dept;
  return { t: t, r: r, dept: dept };
}

function getRequestDetail_(id, user) {
  const r = findReq_(id).r;
  if (!r || (user.role === 'BRANCH' && String(r.branch) !== user.branch)) {
    return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + id };
  }
  const o = Object.assign({}, r); delete o._row;
  o.status = effStatus_(r);
  o.items = reqItems_(r);
  return { status: 'success', data: o };
}

/** รายการอุปกรณ์ในใบเบิก (รองรับใบเก่าแบบ 1 รายการ) */
function reqItems_(r) {
  if (r.items) {
    try {
      const a = JSON.parse(r.items);
      if (Array.isArray(a) && a.length) return a;
    } catch (e) {}
  }
  return [{ assetId: String(r.assetId || ''), assetName: String(r.assetName || ''), category: String(r.category || ''), quantity: Number(r.quantity) || 0 }];
}

/** รับรายการจากหน้าเว็บ (items[] หรือแบบเดิม assetId/quantity) → ตรวจ + รวมรหัสซ้ำ */
function parseReqItems_(d) {
  const src = Array.isArray(d.items) && d.items.length ? d.items
    : [{ assetId: d.assetId, assetName: d.assetName, category: d.category, quantity: d.quantity }];
  const map = {}, out = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i] || {};
    const manual = it.manual === true || it.manual === 'true';   // ✏️ พิมพ์ชื่อสินค้าเอง (ไม่ผูกสต็อก)
    const dept = normDept_(it.dept || d.dept);
    const id = manual ? '' : String(it.assetId || '').trim();
    const name = String(it.assetName || '').trim().slice(0, 120);
    const q = parseInt(it.quantity, 10);
    if (manual) {
      if (MANUAL_ITEM_DEPTS.indexOf(dept) < 0) return { error: 'รายการที่ ' + (i + 1) + ': พิมพ์ชื่อสินค้าเองได้เฉพาะคลัง ' + MANUAL_ITEM_DEPTS.map(k => DEPT_LABEL[k]).join(', ') };
      if (!name) return { error: 'รายการที่ ' + (i + 1) + ': กรุณาพิมพ์ชื่อสินค้า' };
    } else if (!id) return { error: 'รายการที่ ' + (i + 1) + ': ไม่ได้เลือกอุปกรณ์' };
    if (!(q > 0)) return { error: 'รายการที่ ' + (i + 1) + ' (' + (id || name) + '): จำนวนไม่ถูกต้อง' };
    const key = dept + '|' + (manual ? 'M:' + name.toLowerCase() : id);   // รหัสซ้ำกันได้ถ้าอยู่คนละคลัง
    if (map[key]) { map[key].quantity += q; continue; }
    map[key] = { dept: dept, assetId: id, assetName: name, category: manual ? 'พิมพ์ชื่อเอง' : String(it.category || ''), quantity: q, manual: manual };
    out.push(map[key]);
  }
  if (!out.length) return { error: 'กรุณาเพิ่มอุปกรณ์อย่างน้อย 1 รายการ' };
  // แยกตามแผนก → 1 แผนก = 1 ใบเบิก
  const groups = {};
  out.forEach(x => {
    const o = { assetId: x.assetId, assetName: x.assetName, category: x.category, quantity: x.quantity };
    if (x.manual) o.manual = true;
    (groups[x.dept] = groups[x.dept] || []).push(o);
  });
  for (const k in groups) {
    if (groups[k].length > MAX_REQ_ITEMS) return { error: 'ใบเบิก ' + DEPT_LABEL[k] + ' เบิกได้ไม่เกิน ' + MAX_REQ_ITEMS + ' รายการต่อใบ' };
  }
  return { items: out, groups: groups };
}

function createRequest_(d, user) {
  const branch = user.role === 'BRANCH' && user.branch ? user.branch : String(d.branch || '');
  if (!d.staffName) return { status: 'error', message: 'ข้อมูลไม่ครบ (ชื่อผู้เบิก)' };
  if (BRANCHES.indexOf(branch) < 0) return { status: 'error', message: 'กรุณาเลือกสาขาให้ถูกต้อง' };
  if (typeof normDept_ !== 'function') return { status: 'error', message: LEGACY_MISSING_MSG_ };
  const parsed = parseReqItems_(d);
  if (parsed.error) return { status: 'error', message: parsed.error };
  if (!d.requesterSig) return { status: 'error', message: 'กรุณาเซ็นลายเซ็นผู้ขอเบิก' };

  const depts = ['HR', 'HQ'].filter(k => parsed.groups[k]);   // เบิกพร้อมกัน 2 แผนก → ได้ 2 ใบ
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const now = new Date();
    const ymd = Utilities.formatDate(now, APP_CONFIG.TZ, 'yyMMdd');
    const ids = [];
    let img = null, sig = '';
    depts.forEach(dept => {
      const items = parsed.groups[dept], multi = items.length > 1;
      const qty = items.reduce((s, x) => s + x.quantity, 0);
      const t = readTable_(reqSheet_(dept));
      const prefix = REQ_PREFIX[dept] + ymd + '-';
      const seq = t.rows.filter(x => String(x.requestId).indexOf(prefix) === 0).length + 1;
      const requestId = prefix + String(seq).padStart(3, '0');
      if (!img) img = d.imageBase64 ? saveImage_(d.imageBase64, requestId + '_evidence') : { id: '', url: '' };   // รูปเดียวใช้ร่วมกัน
      if (!sig) sig = storeSig_(d.requesterSig, requestId + '_requester');
      appendObj_(t, {
        requestId: requestId,
        timestamp: Utilities.formatDate(now, APP_CONFIG.TZ, 'dd/MM/yyyy HH:mm'),
        assetId: items[0].assetId,
        assetName: multi ? items[0].assetName + ' และอีก ' + (items.length - 1) + ' รายการ' : items[0].assetName,
        category: multi ? 'หลายรายการ (' + items.length + ')' : items[0].category,
        items: JSON.stringify(items),
        quantity: qty, staffName: d.staffName, department: d.department || '',
        branch: branch,
        notes: (d.notes || '-') + (depts.length > 1 ? ' [เบิกคู่กับ ' + DEPT_LABEL[depts[0] === dept ? depts[1] : depts[0]] + ']' : ''),
        imageUrl: img.url, imageFileId: img.id,
        requesterSig: sig,
        status: 'PENDING', requestedBy: user.username
      });
      ids.push(requestId);
    });
    return { status: 'success', requestId: ids.join(', '), requestIds: ids, depts: depts };
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
    ({ t, r } = findReq_(d.requestId));
    if (!r) return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + d.requestId };
    if (r.status !== 'PENDING') return { status: 'error', message: 'ใบเบิกนี้ถูกพิจารณาไปแล้ว (' + r.status + ')' };
    setCell_(t, r._row, 'status', approve ? 'PROCESSING' : 'REJECTED');
  } finally {
    lock.releaseLock();
  }

  if (approve) {
    // 2) ตัดสต็อก + บันทึก Log ทุกรายการในใบเดียว (ตรวจยอดครบทุกรายการก่อน → ตัดทั้งหมด หรือไม่ตัดเลย)
    try {
      if (typeof processRequisitionBatch_ !== 'function') throw new Error(LEGACY_MISSING_MSG_);
      // ส่งลิงก์รูปใน Drive (ไม่ส่ง base64) → เร็วกว่า และไม่ชนลิมิต 50,000 ตัวอักษรต่อเซลล์ของชีต Log
      const j = processRequisitionBatch_({
        dept: r.dept,                                          // ตัดสต็อกจากคลังของแผนกเจ้าของใบเบิก
        requestId: r.requestId,
        staffName: r.staffName, department: r.department, branch: r.branch,
        items: reqItems_(r),
        requisitionNotes: (r.notes || '-') + ' [ใบเบิก ' + r.requestId + ' อนุมัติโดย ' + approverName + proxyTag_(user, r.dept) + ']',
        imageBase64: r.imageUrl || ''
      });
      if (!j || j.status !== 'success') throw new Error((j && j.message) || 'ตัดสต็อกไม่สำเร็จ');
      if (j.txIds && j.txIds.length) setCell_(t, r._row, 'txId', j.txIds.join(','));   // ผูกใบเบิกกับแถวประวัติ → ใช้ตอนยกเลิก
    } catch (err) {
      setCell_(t, r._row, 'status', 'PENDING');
      return { status: 'error', message: 'ตัดสต็อกไม่สำเร็จ: ' + (err.message || err) };
    }
  }

  // 3) บันทึกผลการพิจารณา
  setCell_(t, r._row, 'approverName', approverName + proxyTag_(user, r.dept));
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
 * ขั้นที่ 3 — แอดมินคลังจ่ายของตามใบเบิกที่อนุมัติแล้ว (แนบรูปหลักฐานแทนการเซ็น)
 *   deliveryMethod = 'SHIP'   → ISSUED (รอฝากส่งไปสาขา)  [ค่าเริ่มต้น]
 *   deliveryMethod = 'PICKUP' → ISSUED (รอพนักงานที่มารับของกด 📥 ยืนยันรับของเอง)
 * ใบที่จ่ายไปแล้วแต่ยังไม่มีรูป/ลายเซ็นผู้จ่าย → แนบย้อนหลังได้ (ไม่เปลี่ยนสถานะ)
 */
function issueRequest_(d, user) {
  if (!d.issuerPhoto && !d.issuerSig) return { status: 'error', message: 'กรุณาแนบรูปหลักฐานการจ่ายของ' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { t, r } = findReq_(d.requestId);
    if (!r) return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + d.requestId };
    const st = effStatus_(r);
    const lateSign = ['ISSUED', 'SHIPPED', 'RECEIVED'].indexOf(st) >= 0 && !r.issuerSig && !r.issuerPhoto;
    if (st !== 'APPROVED' && !lateSign) {
      return { status: 'error', message: 'จ่ายของได้เฉพาะใบเบิกที่อนุมัติแล้ว (สถานะปัจจุบัน: ' + st + ')' };
    }
    const putProof = () => {
      if (d.issuerPhoto) {
        const ph = savePhoto_(d.issuerPhoto, r.requestId + '_issue');
        if (!ph) throw new Error('บันทึกรูปหลักฐานการจ่ายไม่สำเร็จ');
        setCell_(t, r._row, 'issuerPhoto', ph);
      }
      if (d.issuerSig) setCell_(t, r._row, 'issuerSig', storeSig_(d.issuerSig, r.requestId + '_issuer'));
    };

    if (lateSign) {                                   // แนบรูปย้อนหลังอย่างเดียว
      if (!r.issuedBy) {
        setCell_(t, r._row, 'issuedBy', user.username);
        setCell_(t, r._row, 'issuedByName', (user.fullName || user.username) + proxyTag_(user, r.dept));
        setCell_(t, r._row, 'issuedAt', nowStr_());
      }
      putProof();
      return { status: 'success', requestId: r.requestId, newStatus: st };
    }

    const pickup = d.deliveryMethod === 'PICKUP';
    putProof();
    setCell_(t, r._row, 'issuedBy', user.username);
    setCell_(t, r._row, 'issuedByName', (user.fullName || user.username) + proxyTag_(user, r.dept));
    setCell_(t, r._row, 'issuedAt', nowStr_());
    setCell_(t, r._row, 'deliveryMethod', pickup ? 'PICKUP' : 'SHIP');
    setCell_(t, r._row, 'status', 'ISSUED');          // PICKUP: รอผู้มารับกดยืนยันรับของเอง
    return { status: 'success', requestId: r.requestId, newStatus: 'ISSUED', deliveryMethod: pickup ? 'PICKUP' : 'SHIP' };
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
    const { t, r } = findReq_(d.requestId);
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
    setCell_(t, r._row, 'shippedByName', (user.fullName || user.username) + proxyTag_(user, r.dept));
    setCell_(t, r._row, 'shippedAt', nowStr_());
    setCell_(t, r._row, 'status', 'SHIPPED');
    return { status: 'success', requestId: r.requestId, newStatus: 'SHIPPED' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ขั้นที่ 5 — ยืนยันได้รับของ (พนักงานสาขาเดียวกัน / ADMIN / MANAGER) → RECEIVED
 *   ใช้ได้ทั้งของที่ฝากส่ง (SHIPPED) และของที่มารับเองที่ HR (ISSUED + PICKUP)
 *   หลักฐาน: ลายเซ็นในระบบ หรือ รูปใบเบิกที่เซ็นรับแล้ว (อย่างใดอย่างหนึ่ง / ทั้งสองอย่าง)
 */
function receiveRequest_(d, user) {
  const receiverName = String(d.receiverName || '').trim();
  if (!receiverName) return { status: 'error', message: 'กรุณาระบุชื่อผู้รับพัสดุ' };
  if (!d.receiverSig && !d.receiverPhoto) return { status: 'error', message: 'กรุณาเซ็นชื่อ หรือแนบรูปใบเบิกที่เซ็นรับของแล้ว' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { t, r } = findReq_(d.requestId);
    if (!r || (user.role === 'BRANCH' && String(r.branch) !== user.branch)) {
      return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + d.requestId };
    }
    const st = effStatus_(r);
    if (st !== 'SHIPPED' && st !== 'ISSUED') {
      return { status: 'error', message: 'ยืนยันรับของได้เฉพาะใบที่ HR จ่าย/ฝากส่งแล้ว (สถานะปัจจุบัน: ' + st + ')' };
    }
    if (d.receiverPhoto) {
      const ph = savePhoto_(d.receiverPhoto, r.requestId + '_receive');
      if (!ph) return { status: 'error', message: 'บันทึกรูปหลักฐานการรับของไม่สำเร็จ (ไฟล์ต้องเป็นรูปภาพ)' };
      setCell_(t, r._row, 'receiverPhoto', ph);
    }
    setCell_(t, r._row, 'receiverName', receiverName);
    if (d.receiverSig) setCell_(t, r._row, 'receiverSig', storeSig_(d.receiverSig, r.requestId + '_receiver'));
    setCell_(t, r._row, 'receivedBy', user.username);
    setCell_(t, r._row, 'receivedAt', nowStr_());
    setCell_(t, r._row, 'receiveNote', String(d.receiveNote || '').trim() || (r.deliveryMethod === 'PICKUP' ? 'รับของเองที่ ' + DEPT_LABEL[r.dept] : ''));
    if (!r.deliveryMethod) setCell_(t, r._row, 'deliveryMethod', 'SHIP');
    setCell_(t, r._row, 'status', 'RECEIVED');
    return { status: 'success', requestId: r.requestId, newStatus: 'RECEIVED' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ยกเลิกใบเบิก
 *   PENDING            → CANCELLED (ยังไม่ตัดสต็อก) · ผู้ขอเอง / ADMIN / MANAGER
 *   APPROVED / ISSUED  → CANCELLED + คืนยอดเข้าคลัง · ADMIN เท่านั้น (ISSUED = ของต้องกลับมาอยู่ที่ HR แล้ว)
 *   SHIPPED / RECEIVED → ยกเลิกไม่ได้ (ของออกจาก HR ไปแล้ว)
 */
function cancelRequest_(d, user) {
  const reason = String(d.cancelReason || '').trim();
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลที่ยกเลิก' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let t, r, st, rawStatus, stockBack;
  try {
    ({ t, r } = findReq_(d.requestId));
    if (!r || (user.role === 'BRANCH' && String(r.branch) !== user.branch)) {
      return { status: 'error', message: 'ไม่พบใบเบิกเลขที่ ' + d.requestId };
    }
    st = effStatus_(r);
    rawStatus = String(r.status || '');
    stockBack = st === 'APPROVED' || st === 'ISSUED';
    if (st === 'PENDING') {
      const own = String(r.requestedBy || '') === user.username;
      if (!own && user.role === 'BRANCH') return { status: 'error', message: 'ยกเลิกได้เฉพาะใบเบิกที่คุณเป็นผู้ขอ' };
    } else if (stockBack) {
      if (!isAdmin_(user)) return { status: 'error', message: 'ใบที่อนุมัติแล้ว ยกเลิกได้เฉพาะแอดมินคลัง (HR / HQ_Office) — ต้องคืนยอดเข้าคลัง' };
    } else {
      return { status: 'error', message: 'ยกเลิกได้เฉพาะใบที่รออนุมัติ / อนุมัติแล้ว / รอฝากส่ง (สถานะปัจจุบัน: ' + st + ')' };
    }
    setCell_(t, r._row, 'status', stockBack ? 'CANCELLING' : 'CANCELLED');   // จองสถานะ กันกดซ้ำ
  } finally {
    lock.releaseLock();
  }

  let note = '';
  if (stockBack) {
    try {
      if (typeof reverseRequisition_ !== 'function') throw new Error(LEGACY_MISSING_MSG_);
      const res = reverseRequisition_(r.requestId, r.txId, reason, r.dept);
      if (!res || res.status !== 'success') throw new Error((res && res.message) || 'คืนยอดไม่สำเร็จ');
      note = res.logFound
        ? (res.restored > 0 ? ' · คืนยอดเข้าคลัง ' + res.restored + ' ชิ้น' + (res.lines > 1 ? ' (' + res.lines + ' รายการ)' : '') : '')
          + (res.missingAssets && res.missingAssets.length ? ' · ไม่พบในคลัง (อาจถูกลบไปแล้ว) จึงไม่คืนยอด: ' + res.missingAssets.join(', ') : '')
        : ' · ไม่พบประวัติการเบิก (เคยถูกลบและคืนยอดไปแล้ว) จึงไม่คืนยอดซ้ำ';
      note += res.warn || '';
    } catch (err) {
      setCell_(t, r._row, 'status', rawStatus);                              // คืนสถานะเดิม
      return { status: 'error', message: 'ยกเลิกไม่สำเร็จ: ' + (err.message || err) };
    }
  }

  setCell_(t, r._row, 'cancelledBy', user.username);
  setCell_(t, r._row, 'cancelledByName', (user.fullName || user.username) + proxyTag_(user, r.dept));
  setCell_(t, r._row, 'cancelledAt', nowStr_());
  setCell_(t, r._row, 'cancelReason', reason);
  setCell_(t, r._row, 'status', 'CANCELLED');
  return { status: 'success', requestId: r.requestId, newStatus: 'CANCELLED', message: 'ยกเลิกใบเบิก ' + r.requestId + ' แล้ว' + note };
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
/** ชีตใบเบิกของแผนก: HR = Requests · HQ = HQ_Requests */
function reqSheet_(dept) {
  return normDept_(dept) === 'HQ'
    ? ensureSheet_(APP_CONFIG.HQ_REQ_SHEET, REQ_HEADERS, '#fef3c7')
    : ensureSheet_(APP_CONFIG.REQ_SHEET, REQ_HEADERS, '#e0e7ff');
}
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

/** รูปหลักฐาน (ถ่ายใบเบิก/ของ) → เก็บใน Drive เสมอ คืนลิงก์ */
function savePhoto_(dataUrl, name) {
  if (!dataUrl) return '';
  if (/^https?:\/\//.test(String(dataUrl))) return String(dataUrl);
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