/**
 * Generate Code & Part Management System — Backend (Google Apps Script)
 * ---------------------------------------------------------------------
 * โครงสร้างรหัส 13 หลัก = 1-2-2-3-3-2
 *   L1 กลุ่มใหญ่ (A-Z) | L2 หมวดหลัก | L3 หมวดย่อย | L4 ขนาด/รุ่น | L5 สเปก | L6 วัสดุ/ผิวชุบ (Running)
 *   ตัวอย่าง  M | 01 | 01 | 003 | 001 | 01   →  M010100300101
 *   เลข 0 ทั้งช่อง (00 / 000) = ไม่ระบุระดับนั้น
 *
 * ชีทที่ใช้: Master_Parts, Code_Structure, Users_Log, Users
 * ครั้งแรก: เลือกฟังก์ชัน setup แล้วกด Run 1 ครั้ง (สร้างชีท + ตั้งคุณเป็น Admin)
 */

// ============================ CONFIG ============================
const CFG = {
  SPREADSHEET_ID: '',          // ว่าง = ใช้ Google Sheet ที่ผูกกับสคริปต์นี้ (Extensions > Apps Script)
  TZ: 'Asia/Bangkok',
  APP_NAME: 'Generate Code',
  DEFAULT_ROLE: 'Viewer',      // สิทธิ์ของคนที่ยังไม่อยู่ในชีท Users ('' = ห้ามเข้าใช้งาน)
  DEFAULT_UNIT: 'pcs',
};

const SH = { PARTS: 'Master_Parts', STRUCT: 'Code_Structure', LOG: 'Users_Log', USERS: 'Users' };
const HEAD = {
  Master_Parts:   ['PartCode', 'Name2', 'Category', 'Specification', 'Unit', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'Status'],
  Code_Structure: ['Level', 'Segment', 'FullPrefix', 'ParentPrefix', 'Label', 'ItemCount', 'Status'],
  Users_Log:      ['Timestamp', 'UserEmail', 'Action', 'PartCode', 'Detail'],
  Users:          ['Email', 'Name', 'Role', 'Active', 'PasswordHash'],
};
const WIDTH = [1, 2, 2, 3, 3, 2];          // จำนวนหลักของแต่ละระดับ
const CUT   = [1, 3, 5, 8, 11, 13];        // ตำแหน่งสิ้นสุดของแต่ละระดับ
const LEVEL_NAMES = ['กลุ่มใหญ่', 'หมวดหลัก', 'หมวดย่อย', 'ขนาด/รุ่น', 'สเปก', 'วัสดุ/ผิวชุบ'];
const ROLES = {
  Admin:  ['view', 'generate', 'update', 'structure', 'admin'],
  Editor: ['view', 'generate', 'update', 'structure'],
  Viewer: ['view'],
};

let API_USER_ = null;    // ใช้เมื่อเรียกด้วย API key
let TOKEN_EMAIL_ = '';    // อีเมลจาก token (ล็อกอินด้วยรหัสผ่าน)
const TOKEN_HOURS = 6;

// ============================ WEB ENTRY ============================
/**
 * โหมด 1: เปิด URL /exec ตรง ๆ  → แสดง index.html (เรียกผ่าน google.script.run → apiCall)
 * โหมด 2: รัน index.html นอก Google (VS Code Live Server ฯลฯ) → fetch POST มาที่ doPost
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action) {  // GET แบบอ่านอย่างเดียว เช่น ?action=getParts&token=...
    return json_(apiCall({ action: p.action, args: p.data ? [JSON.parse(p.data)] : [], token: p.token, key: p.key }));
  }
  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle(CFG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * POST body (ส่งเป็น Content-Type: text/plain เพื่อเลี่ยง CORS preflight)
 * {"action":"generateCode","args":[{...}],"token":"..."}   หรือใช้ "key":"API_KEY" แทน token
 */
function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'JSON ไม่ถูกต้อง' }); }
  if (!body.args && body.data !== undefined) body.args = [body.data];
  return json_(apiCall(body));
}

/** ตัวกลางของทุกคำสั่ง — ใช้ทั้ง google.script.run และ fetch */
function apiCall(req) {
  req = req || {};
  const ROUTES = {
    login: login, logout: logout, changePassword: changePassword,
    getInit: getInit, getStructure: getStructure, getParts: getParts, getPart: getPart, previewNext: previewNext,
    generateCode: generateCode, updatePart: updatePart, addNode: addNode, updateNode: updateNode,
    getUsers: getUsers, saveUser: saveUser, deleteUser: deleteUser, getLogs: getLogs,
  };
  API_USER_ = null; TOKEN_EMAIL_ = '';
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (apiKey && req.key && req.key === apiKey) API_USER_ = { email: 'api', name: 'API', role: 'Admin', perms: ROLES.Admin };
    if (req.token) TOKEN_EMAIL_ = CacheService.getScriptCache().get('tok_' + req.token) || '';
    const fn = ROUTES[req.action];
    if (!fn) throw new Error('ไม่รู้จัก action: ' + req.action);
    const data = fn.apply(null, req.args || []);
    return { ok: true, data: data === undefined ? null : data };
  } catch (err) {
    return { ok: false, error: String(err.message || err), code: err.code || '' };
  }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function err_(msg, code) { const e = new Error(msg); e.code = code; return e; }

// ============================ SETUP ============================
/** รันครั้งแรกจาก Editor: สร้างชีทที่ขาด + เพิ่มผู้รันเป็น Admin + ตั้งรหัสผ่านชั่วคราว (ดูใน Execution log) */
function setup() {
  Object.keys(HEAD).forEach(name => {
    const sh = sheet_(name);
    sh.getRange(1, 1, 1, HEAD[name].length).setValues([HEAD[name]]).setFontWeight('bold').setBackground('#1F4E78').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });
  // บังคับคอลัมน์รหัสเป็นข้อความ (กันเลข 0 นำหน้าหาย)
  sheet_(SH.PARTS).getRange('A:A').setNumberFormat('@');
  sheet_(SH.STRUCT).getRange('B:D').setNumberFormat('@');

  const owner = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const ush = sheet_(SH.USERS);
  // ลบแถวตัวอย่าง
  read_(SH.USERS).filter(u => /@example\.com$/i.test(u.Email)).reverse().forEach(u => ush.deleteRow(u._row));
  let u = read_(SH.USERS).find(x => str_(x.Email).toLowerCase() === owner);
  if (owner && !u) { ush.appendRow([owner, owner.split('@')[0], 'Admin', true, '']); u = read_(SH.USERS).find(x => str_(x.Email).toLowerCase() === owner); }
  let msg = 'Setup เสร็จแล้ว — Admin: ' + owner;
  if (u && !str_(u.PasswordHash)) {
    const temp = Utilities.getUuid().slice(0, 8);
    ush.getRange(u._row, 5).setValue(hash_(owner, temp));
    msg += '\nรหัสผ่านชั่วคราว (ใช้ล็อกอินจาก Live Server): ' + temp + '\n→ เปลี่ยนได้ที่เมนู Setting';
  }
  log_(owner, 'SETUP', '', 'initialize sheets');
  Logger.log(msg);
  return msg;
}

/** ตั้งรหัสผ่านให้ผู้ใช้จาก Editor (กรณีลืม): แก้ค่า 2 บรรทัดนี้แล้วกด Run */
function resetPasswordManually() {
  const email = 'name@ruamsinthaigroup.com', password = 'ChangeMe123';
  const u = read_(SH.USERS).find(x => str_(x.Email).toLowerCase() === email.toLowerCase());
  if (!u) throw new Error('ไม่พบผู้ใช้ ' + email);
  sheet_(SH.USERS).getRange(u._row, 5).setValue(hash_(email.toLowerCase(), password));
  Logger.log('ตั้งรหัสผ่านให้ ' + email + ' แล้ว');
}

// ============================ LOGIN (สำหรับรันนอก Google) ============================
function salt_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SALT');
  if (!s) { s = Utilities.getUuid(); props.setProperty('SALT', s); }
  return s;
}

function hash_(email, password) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt_() + '|' + email + '|' + password, Utilities.Charset.UTF_8);
  return raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function login(p) {
  const email = str_(p && p.email).toLowerCase(), pw = String((p && p.password) || '');
  const u = read_(SH.USERS).find(x => str_(x.Email).toLowerCase() === email);
  if (!u || !isTrue_(u.Active) || !str_(u.PasswordHash) || str_(u.PasswordHash) !== hash_(email, pw)) {
    Utilities.sleep(800);
    throw err_('อีเมลหรือรหัสผ่านไม่ถูกต้อง', 'AUTH');
  }
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('tok_' + token, email, TOKEN_HOURS * 3600);
  log_(email, 'LOGIN', '', 'token login');
  return { token: token, hours: TOKEN_HOURS };
}

function logout() {
  return true; // token หมดอายุเองตาม TOKEN_HOURS (ฝั่งหน้าเว็บลบ token ทิ้ง)
}

function changePassword(p) {
  const m = me_();
  if (!m.email || m.email === 'api') throw err_('กรุณาเข้าสู่ระบบ', 'AUTH');
  const np = String((p && p.newPassword) || '');
  if (np.length < 6) throw new Error('รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร');
  const u = read_(SH.USERS).find(x => str_(x.Email).toLowerCase() === m.email);
  if (!u) throw new Error('ไม่พบบัญชีในชีท Users');
  if (str_(u.PasswordHash) && str_(u.PasswordHash) !== hash_(m.email, String(p.oldPassword || ''))) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  sheet_(SH.USERS).getRange(u._row, 5).setValue(hash_(m.email, np));
  log_(m.email, 'CHANGE_PASSWORD', '', '');
  return true;
}

// ============================ HELPERS ============================
function ss_() { return CFG.SPREADSHEET_ID ? SpreadsheetApp.openById(CFG.SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEAD[name].length).setValues([HEAD[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function read_(name) {
  const sh = sheet_(name);
  const n = sh.getLastRow();
  if (n < 2) return [];
  const h = HEAD[name];
  return sh.getRange(2, 1, n - 1, h.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    h.forEach((k, j) => { o[k] = r[j]; });
    return o;
  });
}

function fmt_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
  return d == null ? '' : String(d);
}
function now_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss'); }
function isTrue_(v) { return v === true || v === 1 || /^(true|1|yes|y)$/i.test(String(v)); }
function str_(v) { return String(v == null ? '' : v).trim(); }
function isPlaceholder_(label) { return !label || /^\(.*\)$/.test(String(label).trim()); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('ระบบกำลังทำงานให้ผู้ใช้อื่น กรุณาลองใหม่อีกครั้ง');
  try { return fn(); } finally { lock.releaseLock(); }
}

function log_(email, action, code, detail) {
  try { sheet_(SH.LOG).appendRow([now_(), email || '', action, code || '', detail || '']); } catch (e) { /* ignore */ }
}

// ============================ AUTH ============================
function me_() {
  if (API_USER_) return API_USER_;
  const email = (TOKEN_EMAIL_ || Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) return { email: '', name: 'Guest', role: '', perms: [] };   // ไม่รู้ตัวตน → ต้องล็อกอิน
  const u = read_(SH.USERS).find(r => str_(r.Email).toLowerCase() === email);
  let role = TOKEN_EMAIL_ ? '' : CFG.DEFAULT_ROLE;   // DEFAULT_ROLE ใช้กับบัญชี Google ในโดเมนที่ยังไม่อยู่ในชีท
  if (u) role = isTrue_(u.Active) ? str_(u.Role) : '';
  return { email: email, name: u ? str_(u.Name) : email.split('@')[0], role: role, perms: ROLES[role] || [] };
}

function need_(perm) {
  const m = me_();
  if (!m.email) throw err_('กรุณาเข้าสู่ระบบ', 'AUTH');
  if (m.perms.indexOf(perm) < 0) throw err_('คุณไม่มีสิทธิ์ใช้งานส่วนนี้ (' + perm + ')', 'FORBIDDEN');
  return m;
}

// ============================ STRUCTURE ============================
function structRaw_() {
  return read_(SH.STRUCT).map(r => ({
    _row: r._row,
    level: Number(r.Level),
    prefix: str_(r.FullPrefix).toUpperCase(),
    parent: str_(r.ParentPrefix).toUpperCase(),
    label: str_(r.Label),
    status: str_(r.Status) || 'Active',
  })).filter(n => n.prefix && n.level >= 1 && n.level <= 6);
}

function partCodes_() {
  const sh = sheet_(SH.PARTS);
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 1).getValues().map(r => str_(r[0]).toUpperCase()).filter(String);
}

/** ส่งโครงสร้างแบบกะทัดรัด: [level, prefix, parent, label, status] */
function getStructure() {
  need_('view');
  return structRaw_().map(n => [n.level, n.prefix, n.parent, n.label, n.status]);
}

/** หาเลขถัดไปของระดับ level ภายใต้ parent (ดูทั้ง Code_Structure และ Master_Parts) */
function nextSeg_(level, parent, nodes, codes) {
  const w = WIDTH[level - 1], a = CUT[level - 2], b = CUT[level - 1];
  let max = 0;
  nodes.forEach(n => { if (n.level === level && n.parent === parent) max = Math.max(max, Number(n.prefix.slice(a, b)) || 0); });
  codes.forEach(c => { if (c.length === 13 && c.indexOf(parent) === 0) max = Math.max(max, Number(c.slice(a, b)) || 0); });
  const nx = max + 1;
  if (String(nx).length > w) throw new Error('เลขในระดับ ' + level + ' ภายใต้ ' + parent + ' เต็มแล้ว');
  return ('0000' + nx).slice(-w);
}

function appendNode_(level, seg, prefix, parent, label, count) {
  const sh = sheet_(SH.STRUCT);
  const row = sh.getLastRow() + 1;
  const rg = sh.getRange(row, 1, 1, HEAD.Code_Structure.length);
  rg.setNumberFormat('@');
  rg.setValues([[String(level), seg, prefix, parent, label, String(count || 0), 'Active']]);
}

function validParent_(level, parent) {
  if (level === 1) return parent === '';
  return parent.length === CUT[level - 2];
}

/** เพิ่มหัวข้อใหม่ {level, parent, label, segment?} — segment ว่าง = รันเลขอัตโนมัติ */
function addNode(p) {
  const m = need_('structure');
  return withLock_(() => {
    const level = Number(p.level);
    const parent = str_(p.parent).toUpperCase();
    const label = str_(p.label);
    if (!(level >= 1 && level <= 6)) throw new Error('ระดับไม่ถูกต้อง');
    if (!label) throw new Error('กรุณากรอกชื่อหัวข้อ');
    if (!validParent_(level, parent)) throw new Error('หัวข้อแม่ไม่ถูกต้อง');
    const nodes = structRaw_();
    if (level > 1 && !nodes.some(n => n.prefix === parent)) throw new Error('ไม่พบหัวข้อแม่ ' + parent);

    let seg = str_(p.segment).toUpperCase();
    if (level === 1) {
      if (!/^[A-Z]$/.test(seg)) throw new Error('กลุ่มใหญ่ต้องเป็นตัวอักษร A-Z 1 ตัว');
    } else if (seg) {
      if (!new RegExp('^\\d{' + WIDTH[level - 1] + '}$').test(seg)) throw new Error('รหัสระดับ ' + level + ' ต้องเป็นตัวเลข ' + WIDTH[level - 1] + ' หลัก');
    } else {
      seg = nextSeg_(level, parent, nodes, partCodes_());
    }
    const prefix = parent + seg;
    if (nodes.some(n => n.prefix === prefix)) throw new Error('รหัส ' + prefix + ' มีอยู่แล้ว');
    appendNode_(level, seg, prefix, parent, label, 0);
    log_(m.email, 'ADD_NODE', prefix, 'L' + level + ': ' + label);
    return [level, prefix, parent, label, 'Active'];
  });
}

/** แก้ไขหัวข้อ {prefix, label, status} */
function updateNode(p) {
  const m = need_('structure');
  return withLock_(() => {
    const prefix = str_(p.prefix).toUpperCase();
    const node = structRaw_().find(n => n.prefix === prefix);
    if (!node) throw new Error('ไม่พบหัวข้อ ' + prefix);
    const label = p.label != null ? str_(p.label) : node.label;
    const status = p.status === 'Inactive' ? 'Inactive' : 'Active';
    if (!label) throw new Error('กรุณากรอกชื่อหัวข้อ');
    const sh = sheet_(SH.STRUCT);
    sh.getRange(node._row, 5).setValue(label);
    sh.getRange(node._row, 7).setValue(status);
    log_(m.email, 'EDIT_NODE', prefix, node.label + ' → ' + label + ' [' + status + ']');
    return [node.level, prefix, node.parent, label, status];
  });
}

// ============================ PARTS ============================
function partObj_(r) {
  return {
    code: str_(r.PartCode), name: str_(r.Name2), category: str_(r.Category), spec: str_(r.Specification),
    unit: str_(r.Unit), createdAt: fmt_(r.CreatedAt), createdBy: str_(r.CreatedBy),
    updatedAt: fmt_(r.UpdatedAt), updatedBy: str_(r.UpdatedBy), status: str_(r.Status) || 'Active',
  };
}

function getParts() {
  need_('view');
  return read_(SH.PARTS).map(partObj_).filter(p => p.code);
}

function getPart(p) {
  need_('view');
  const code = str_(p && p.code || p).toUpperCase();
  const r = read_(SH.PARTS).find(x => str_(x.PartCode).toUpperCase() === code);
  return r ? partObj_(r) : null;
}

/** ดูรหัสถัดไปของ L6 ภายใต้ prefix L5 (11 ตัว) */
function previewNext(p) {
  need_('view');
  const l5 = str_(p && p.l5 || p).toUpperCase();
  if (l5.length !== 11) throw new Error('ต้องเลือกให้ครบ 5 ระดับก่อน');
  const nodes = structRaw_(), codes = partCodes_();
  const seg = nextSeg_(6, l5, nodes, codes);
  return { seg: seg, code: l5 + seg, zeroUsed: codes.indexOf(l5 + '00') >= 0 };
}

/**
 * สร้างรหัสใหม่
 * p = { chain:[L1..L5 prefix], l6Label, l6Zero:boolean, name, spec, unit }
 */
function generateCode(p) {
  const m = need_('generate');
  return withLock_(() => {
    const chain = (p.chain || []).map(x => str_(x).toUpperCase());
    if (chain.length !== 5) throw new Error('กรุณาเลือกให้ครบ 5 ระดับ');
    chain.forEach((pre, i) => {
      if (pre.length !== CUT[i]) throw new Error('ระดับ ' + (i + 1) + ' ไม่ถูกต้อง');
      if (i > 0 && pre.indexOf(chain[i - 1]) !== 0) throw new Error('ลำดับหมวดไม่ต่อเนื่องที่ระดับ ' + (i + 1));
    });

    let nodes = structRaw_();
    const codes = partCodes_();
    const byPrefix = {};
    nodes.forEach(n => { byPrefix[n.prefix] = n; });

    // ตรวจ/สร้างหัวข้อ "ไม่ระบุ" (เลข 0) ที่ยังไม่มีในโครงสร้าง
    chain.forEach((pre, i) => {
      if (byPrefix[pre]) return;
      const seg = pre.slice(i ? CUT[i - 1] : 0);
      if (i > 0 && /^0+$/.test(seg)) {
        appendNode_(i + 1, seg, pre, i ? chain[i - 1] : '', '(ไม่ระบุ)', 0);
        byPrefix[pre] = { level: i + 1, prefix: pre, parent: chain[i - 1], label: '(ไม่ระบุ)' };
      } else {
        throw new Error('ไม่พบหัวข้อ ' + pre + ' ในโครงสร้าง');
      }
    });

    // Running number ระดับ 6
    const l5 = chain[4];
    const seg = p.l6Zero ? '00' : nextSeg_(6, l5, nodes, codes);
    const code = l5 + seg;
    if (codes.indexOf(code) >= 0) throw new Error('รหัส ' + code + ' มีอยู่แล้ว');

    const l6Label = str_(p.l6Label) || (p.l6Zero ? '(ไม่ระบุ)' : '');
    const labels = chain.slice(1).map(pre => byPrefix[pre].label).concat([l6Label]).filter(l => !isPlaceholder_(l));
    const name = str_(p.name) || labels.join(' ');
    if (!name) throw new Error('กรุณากรอกชื่อสินค้า');
    const l2 = byPrefix[chain[1]], l3 = byPrefix[chain[2]];
    const category = !isPlaceholder_(l2.label) ? l2.label : (l3 && !isPlaceholder_(l3.label) ? l3.label : '');

    if (!byPrefix[code]) appendNode_(6, seg, code, l5, l6Label || '(ไม่ระบุ)', 1);

    const ts = now_();
    const row = [code, name, category, str_(p.spec), str_(p.unit) || CFG.DEFAULT_UNIT, ts, m.email || m.name, '', '', 'Active'];
    const sh = sheet_(SH.PARTS);
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1).setNumberFormat('@');
    sh.getRange(r, 1, 1, row.length).setValues([row]);
    log_(m.email, 'GENERATE', code, name);
    return partObj_({ PartCode: code, Name2: name, Category: category, Specification: row[3], Unit: row[4], CreatedAt: ts, CreatedBy: row[6], Status: 'Active' });
  });
}

/** แก้ไขข้อมูลอะไหล่ {code, name, spec, unit, status} */
function updatePart(p) {
  const m = need_('update');
  return withLock_(() => {
    const code = str_(p.code).toUpperCase();
    const r = read_(SH.PARTS).find(x => str_(x.PartCode).toUpperCase() === code);
    if (!r) throw new Error('ไม่พบรหัส ' + code);
    const name = str_(p.name);
    if (!name) throw new Error('ชื่อสินค้าห้ามว่าง');
    const before = partObj_(r);
    const ts = now_();
    const vals = [name, str_(r.Category), str_(p.spec), str_(p.unit) || CFG.DEFAULT_UNIT];
    const sh = sheet_(SH.PARTS);
    sh.getRange(r._row, 2, 1, 4).setValues([vals]);
    sh.getRange(r._row, 8, 1, 3).setValues([[ts, m.email || m.name, p.status === 'Inactive' ? 'Inactive' : 'Active']]);
    const diff = [];
    if (before.name !== name) diff.push('name: ' + before.name + ' → ' + name);
    if (before.spec !== vals[2]) diff.push('spec: ' + before.spec + ' → ' + vals[2]);
    if (before.unit !== vals[3]) diff.push('unit: ' + before.unit + ' → ' + vals[3]);
    if (before.status !== (p.status === 'Inactive' ? 'Inactive' : 'Active')) diff.push('status → ' + p.status);
    log_(m.email, 'UPDATE', code, diff.join(' | ') || 'no change');
    return getPart(code);
  });
}

// ============================ USERS / SETTINGS ============================
function getUsers() {
  need_('admin');
  return read_(SH.USERS).map(u => ({ email: str_(u.Email).toLowerCase(), name: str_(u.Name), role: str_(u.Role), active: isTrue_(u.Active), hasPassword: !!str_(u.PasswordHash) }))
    .filter(u => u.email);
}

function saveUser(p) {
  const m = need_('admin');
  const email = str_(p.email).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('อีเมลไม่ถูกต้อง');
  if (!ROLES[p.role]) throw new Error('สิทธิ์ไม่ถูกต้อง');
  const active = p.active !== false;
  if (email === m.email && (p.role !== 'Admin' || !active)) throw new Error('ไม่สามารถลดสิทธิ์ของตัวเองได้');
  return withLock_(() => {
    const sh = sheet_(SH.USERS);
    const u = read_(SH.USERS).find(x => str_(x.Email).toLowerCase() === email);
    const pw = String(p.password || '');
    if (pw && pw.length < 6) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
    const hash = pw ? hash_(email, pw) : (u ? str_(u.PasswordHash) : '');
    const row = [email, str_(p.name) || email.split('@')[0], p.role, active, hash];
    if (u) sh.getRange(u._row, 1, 1, 5).setValues([row]); else sh.appendRow(row);
    log_(m.email, u ? 'EDIT_USER' : 'ADD_USER', '', email + ' → ' + p.role + (active ? '' : ' (inactive)'));
    return getUsers();
  });
}

function deleteUser(email) {
  const m = need_('admin');
  email = str_(email).toLowerCase();
  if (email === m.email) throw new Error('ไม่สามารถลบตัวเองได้');
  return withLock_(() => {
    const u = read_(SH.USERS).find(x => str_(x.Email).toLowerCase() === email);
    if (u) { sheet_(SH.USERS).deleteRow(u._row); log_(m.email, 'DELETE_USER', '', email); }
    return getUsers();
  });
}

function getLogs(limit) {
  need_('admin');
  const rows = read_(SH.LOG);
  return rows.slice(-(Number(limit) || 300)).reverse().map(r => ({
    ts: fmt_(r.Timestamp), email: str_(r.UserEmail), action: str_(r.Action), code: str_(r.PartCode), detail: str_(r.Detail),
  }));
}

// ============================ INIT ============================
function getInit() {
  const me = me_();
  if (!me.email) throw err_('กรุณาเข้าสู่ระบบ', 'AUTH');
  if (!me.perms.length) throw err_('บัญชี ' + me.email + ' ยังไม่ได้รับสิทธิ์ใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 'FORBIDDEN');
  return {
    me: me, app: CFG.APP_NAME, width: WIDTH, cut: CUT, levelNames: LEVEL_NAMES, defaultUnit: CFG.DEFAULT_UNIT,
    roles: Object.keys(ROLES), structure: getStructure(),
  };
}