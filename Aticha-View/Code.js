/**
 * ============================================================================
 *  ริชาวิลล์ เทคโน-ดอนกลาง — Backend API (Google Apps Script)
 *  - รับลงทะเบียนลูกค้า (Leads)
 *  - ระบบป๊อปอัปโปรโมชั่น (Promotions) + สถิติการเห็น/คลิก
 *  - API หลังบ้านสำหรับ admin.html (ต้องล็อกอิน)
 * ============================================================================
 *  วิธีติดตั้ง (ครั้งแรก)
 *   1. เปิด Google Sheet > ส่วนขยาย > Apps Script แล้ววางโค้ดนี้ทับทั้งหมด
 *   2. เลือกฟังก์ชัน `setup` แล้วกด Run 1 ครั้ง (อนุญาตสิทธิ์ Sheets + Drive)
 *      → ระบบจะสร้างชีต Leads, Promotions, โฟลเดอร์รูปใน Drive และรหัสผ่านเริ่มต้น
 *   3. เปลี่ยนรหัสผ่าน: Project Settings (⚙️) > Script properties > ADMIN_PASSWORD
 *   4. Deploy > Manage deployments > Edit (✏️) > Version: New version > Deploy
 *      (Execute as: Me, Who has access: Anyone) — URL เดิมใช้ต่อได้
 * ============================================================================
 */

const CFG = {
  LEADS_SHEET: 'Leads',
  PROMO_SHEET: 'Promotions',
  DRIVE_FOLDER: 'RichaVille-Promotions',
  TZ: 'Asia/Bangkok',
  TOKEN_TTL: 6 * 60 * 60,      // อายุการล็อกอิน 6 ชั่วโมง
  PUBLIC_CACHE_SEC: 600,       // แคชรายการโปรสำหรับหน้าเว็บ 10 นาที (บันทึก/ลบโปรในหลังบ้านจะล้างแคชทันที)
  MAX_UPLOAD_MB: 8,
  // ฐานข้อมูลหลัก: Google Sheet "Aticha-View-db"
  SPREADSHEET_ID: '1ZEaIqEnt6IChY5ZBFz0v52w1bkjStPK6-kwES1OfqM8',
};

/** เปิดชีตฐานข้อมูล (ใช้ได้ทั้งสคริปต์ที่ผูกกับชีต และสคริปต์แยก) */
let _db = null;
function getDb() {
  if (_db) return _db;
  return _db = CFG.SPREADSHEET_ID ? SpreadsheetApp.openById(CFG.SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

const LEAD_HEADERS  = ['Timestamp', 'Name', 'Phone', 'Model', 'Source', 'Status', 'Note'];
const PROMO_HEADERS = ['ID', 'Title', 'Description', 'ImageUrl', 'CtaText', 'CtaLink',
                       'StartDate', 'EndDate', 'Active', 'Priority', 'Frequency',
                       'Views', 'Clicks', 'UpdatedAt'];
const LEAD_STATUSES = ['ใหม่', 'ติดต่อแล้ว', 'นัดชมบ้าน', 'ยื่นกู้', 'ปิดการขาย', 'ไม่สนใจ'];

/* ========================================================================== */
/*  SETUP                                                                     */
/* ========================================================================== */
function setup() {
  ensureSheet(CFG.LEADS_SHEET, LEAD_HEADERS);
  const promo = ensureSheet(CFG.PROMO_SHEET, PROMO_HEADERS);
  getFolder();

  const props = PropertiesService.getScriptProperties();
  // ตั้งรหัสผ่านเริ่มต้น (เปลี่ยนได้ในหน้า admin > ตั้งค่า)
  if (!props.getProperty('ADMIN_PASSWORD')) props.setProperty('ADMIN_PASSWORD', 'richa@2026');

  // โปรโมชั่นตัวอย่าง: โบรชัวร์ ธอส. (ใช้รูปในโฟลเดอร์ images/ ของเว็บ)
  if (promo.getLastRow() < 2) {
    savePromo({
      title: 'สินเชื่อ ธอส. บ้านคนละหลัง PLUS',
      description: 'ดอกเบี้ยปีที่ 1-2 เพียง 2.60% ผ่อนนานสูงสุด 40 ปี\nสำหรับบ้านราคาไม่เกิน 3 ล้านบาท',
      imageUrl: 'images/ghb-promo.jpeg',
      ctaText: 'คำนวณค่างวดกับ ธอส.',
      ctaLink: '#ghb',
      active: true, priority: 10, frequency: 'session',
    });
  }
  Logger.log('✅ Setup เสร็จแล้ว | รหัสผ่านหลังบ้าน: ' + props.getProperty('ADMIN_PASSWORD'));
}

/* ========================================================================== */
/*  ENTRY POINTS                                                              */
/* ========================================================================== */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'promos') return json({ result: 'success', promos: getPublicPromos() });
    return json({ result: 'ok', service: 'Richa Ville API', time: new Date().toISOString() });
  } catch (err) {
    return json({ result: 'error', message: String(err.message || err) });
  }
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); }
  catch (_) { return json({ result: 'error', message: 'Invalid JSON' }); }

  const action = data.action || 'lead';
  try {
    // ---------- Public actions ----------
    if (action === 'lead')  return json(withLock(() => saveLead(data)));
    if (action === 'track') return json(withLock(() => trackPromo(data)));
    if (action === 'login') return json(login(data));

    // ---------- Admin actions (ต้องมี token) ----------
    requireAuth(data.token);
    switch (action) {
      case 'logout':      CacheService.getScriptCache().remove('tok_' + data.token); return json({ result: 'success' });
      case 'dashboard':   return json({ result: 'success', promos: readPromos(), leads: readLeads(1000), statuses: LEAD_STATUSES });
      case 'listPromos':  return json({ result: 'success', promos: readPromos() });
      case 'savePromo':   return json(withLock(() => savePromo(data.promo || {})));
      case 'deletePromo': return json(withLock(() => deletePromo(data.id)));
      case 'uploadImage': return json(uploadImage(data));
      case 'listLeads':   return json({ result: 'success', leads: readLeads(data.limit || 1000), statuses: LEAD_STATUSES });
      case 'updateLead':  return json(withLock(() => updateLead(data)));
      case 'changePassword': return json(changePassword(data));
    }
    return json({ result: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    return json({ result: 'error', message: String(err.message || err), auth: !!err.auth });
  }
}

/* ========================================================================== */
/*  LEADS                                                                     */
/* ========================================================================== */
function saveLead(d) {
  const name  = clean(d.name || d.fullname);
  const phone = clean(d.phone).replace(/\D/g, '');
  const model = clean(d.model || d.selectedModel || d.interestedModel);
  if (!name || !/^0\d{8,9}$/.test(phone)) return { result: 'error', message: 'Invalid name or phone' };

  const sheet = ensureSheet(CFG.LEADS_SHEET, LEAD_HEADERS);
  sheet.appendRow([new Date(), name, "'" + phone, model, clean(d.source || 'landing-page'), 'ใหม่', '']);
  return { result: 'success' };
}

function readLeads(limit) {
  const sheet = ensureSheet(CFG.LEADS_SHEET, LEAD_HEADERS);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - limit + 1);
  const rows = sheet.getRange(start, 1, last - start + 1, LEAD_HEADERS.length).getValues();
  return rows.map((r, i) => ({
    row: start + i,
    timestamp: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
    name: String(r[1]), phone: String(r[2]).replace(/^'/, ''), model: String(r[3]),
    source: String(r[4]), status: String(r[5] || 'ใหม่'), note: String(r[6] || ''),
  })).reverse();
}

function updateLead(d) {
  const row = parseInt(d.row, 10);
  const sheet = ensureSheet(CFG.LEADS_SHEET, LEAD_HEADERS);
  if (!(row >= 2 && row <= sheet.getLastRow())) throw new Error('ไม่พบรายการ');
  if (d.status !== undefined) {
    if (LEAD_STATUSES.indexOf(d.status) < 0) throw new Error('สถานะไม่ถูกต้อง');
    sheet.getRange(row, 6).setValue(d.status);
  }
  if (d.note !== undefined) sheet.getRange(row, 7).setValue(clean(d.note, 500));
  return { result: 'success' };
}

/* ========================================================================== */
/*  PROMOTIONS                                                                */
/* ========================================================================== */
function readPromos() {
  const sheet = ensureSheet(CFG.PROMO_SHEET, PROMO_HEADERS);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, PROMO_HEADERS.length).getValues()
    .filter(r => r[0])
    .map((r, i) => ({
      row: i + 2,
      id: String(r[0]), title: String(r[1]), description: String(r[2]), imageUrl: String(r[3]),
      ctaText: String(r[4]), ctaLink: String(r[5]),
      startDate: toDateStr(r[6]), endDate: toDateStr(r[7]),
      active: r[8] === true || String(r[8]).toUpperCase() === 'TRUE',
      priority: Number(r[9]) || 0, frequency: String(r[10] || 'session'),
      views: Number(r[11]) || 0, clicks: Number(r[12]) || 0,
      updatedAt: r[13] instanceof Date ? r[13].toISOString() : String(r[13] || ''),
    }))
    .sort((a, b) => b.priority - a.priority);
}

/** รายการโปรที่กำลังแสดงอยู่ (สำหรับหน้าเว็บสาธารณะ) */
function getPublicPromos() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('public_promos');
  if (hit) return JSON.parse(hit);

  const today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  const list = readPromos()
    .filter(p => p.active && p.imageUrl &&
                 (!p.startDate || p.startDate <= today) &&
                 (!p.endDate || p.endDate >= today))
    .map(p => ({ id: p.id, title: p.title, description: p.description, imageUrl: p.imageUrl,
                 ctaText: p.ctaText, ctaLink: p.ctaLink, frequency: p.frequency }));
  cache.put('public_promos', JSON.stringify(list), CFG.PUBLIC_CACHE_SEC);
  return list;
}

function savePromo(p) {
  const title = clean(p.title, 120);
  const imageUrl = String(p.imageUrl || '').trim();
  if (!title) throw new Error('กรุณาใส่ชื่อโปรโมชั่น');
  if (!imageUrl) throw new Error('กรุณาใส่รูปภาพ');

  const freq = ['every', 'session', 'daily', 'once'].indexOf(p.frequency) >= 0 ? p.frequency : 'session';
  const sheet = ensureSheet(CFG.PROMO_SHEET, PROMO_HEADERS);
  const existing = p.id ? readPromos().find(x => x.id === p.id) : null;
  const id = existing ? existing.id : 'P' + Date.now();

  const row = [
    id, title, clean(p.description, 1000), imageUrl.slice(0, 1000),
    clean(p.ctaText, 60), sanitizeLink(p.ctaLink),
    p.startDate || '', p.endDate || '', !!p.active, Number(p.priority) || 0, freq,
    existing ? existing.views : 0, existing ? existing.clicks : 0, new Date(),
  ];
  if (existing) sheet.getRange(existing.row, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);

  CacheService.getScriptCache().remove('public_promos');
  return { result: 'success', id: id };
}

function deletePromo(id) {
  const p = readPromos().find(x => x.id === id);
  if (!p) throw new Error('ไม่พบโปรโมชั่น');
  ensureSheet(CFG.PROMO_SHEET, PROMO_HEADERS).deleteRow(p.row);
  CacheService.getScriptCache().remove('public_promos');
  return { result: 'success' };
}

function trackPromo(d) {
  const col = d.type === 'click' ? 13 : d.type === 'view' ? 12 : 0;
  if (!col || !d.id) return { result: 'error', message: 'bad track' };
  const sheet = ensureSheet(CFG.PROMO_SHEET, PROMO_HEADERS);
  const hit = sheet.getRange('A:A').createTextFinder(String(d.id)).matchEntireCell(true).findNext();
  if (!hit) return { result: 'success' }; // เช่น โปรสำรองที่ไม่มีในชีต
  const cell = sheet.getRange(hit.getRow(), col);
  cell.setValue((Number(cell.getValue()) || 0) + 1);
  return { result: 'success' };
}

function uploadImage(d) {
  const mime = String(d.mimeType || '');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new Error('รองรับเฉพาะไฟล์รูปภาพ JPG/PNG/WebP/GIF');
  const bytes = Utilities.base64Decode(String(d.data || ''));
  if (bytes.length > CFG.MAX_UPLOAD_MB * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน ' + CFG.MAX_UPLOAD_MB + ' MB');

  const name = clean(d.name || 'promo', 80).replace(/[^\w.\-ก-๙]/g, '_');
  const file = getFolder().createFile(Utilities.newBlob(bytes, mime, Date.now() + '_' + name));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    throw new Error('อัปโหลดแล้ว แต่ตั้งค่าแชร์สาธารณะไม่ได้ (องค์กรอาจปิดการแชร์ภายนอก): ' + err.message);
  }
  return { result: 'success', url: 'https://lh3.googleusercontent.com/d/' + file.getId(), fileId: file.getId() };
}

/* ========================================================================== */
/*  AUTH                                                                      */
/* ========================================================================== */
function login(d) {
  const pass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!pass || String(d.password || '') !== pass) {
    Utilities.sleep(800); // หน่วงเวลาเพื่อลดการเดารหัส
    return { result: 'error', message: 'รหัสผ่านไม่ถูกต้อง' };
  }
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('tok_' + token, '1', CFG.TOKEN_TTL);
  return { result: 'success', token: token, expiresIn: CFG.TOKEN_TTL };
}

function requireAuth(token) {
  if (!token || !CacheService.getScriptCache().get('tok_' + token)) {
    const e = new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'); e.auth = true; throw e;
  }
}

function changePassword(d) {
  const props = PropertiesService.getScriptProperties();
  if (String(d.oldPassword || '') !== props.getProperty('ADMIN_PASSWORD')) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  if (String(d.newPassword || '').length < 8) throw new Error('รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร');
  props.setProperty('ADMIN_PASSWORD', String(d.newPassword));
  return { result: 'success' };
}

/* ========================================================================== */
/*  HELPERS                                                                   */
/* ========================================================================== */
const _sheetMemo = {};
function ensureSheet(name, headers) {
  if (_sheetMemo[name]) return _sheetMemo[name];
  const ss = getDb();
  let sh = ss.getSheetByName(name);
  // หัวตารางตรวจแล้วเมื่อไม่นาน → ข้ามการอ่านแถวหัว (เร็วขึ้นทุกคำขอ)
  const okKey = 'hdr_ok_' + name;
  if (sh && CacheService.getScriptCache().get(okKey)) return (_sheetMemo[name] = sh);
  // รองรับชีตเดิมที่ชื่อ Sheet1 / ชีตแรก สำหรับ Leads เวอร์ชันเก่า
  if (!sh) sh = ss.insertSheet(name);
  const width = headers.length;
  const current = sh.getLastRow() ? sh.getRange(1, 1, 1, width).getValues()[0] : [];
  if (current.join('|') !== headers.join('|')) {
    sh.getRange(1, 1, 1, width).setValues([headers])
      .setFontWeight('bold').setBackground('#0a2540').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    if (name === CFG.LEADS_SHEET) sh.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
    if (name === CFG.PROMO_SHEET) sh.getRange('G:H').setNumberFormat('@'); // วันที่เก็บเป็นข้อความ yyyy-MM-dd
  }
  CacheService.getScriptCache().put(okKey, '1', 21600);
  return (_sheetMemo[name] = sh);
}

function getFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DRIVE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (_) {} }
  // สร้างโฟลเดอร์รูปไว้ "ข้างๆ" ไฟล์ชีตฐานข้อมูล (โฟลเดอร์เดียวกัน)
  const dbFile = DriveApp.getFileById(getDb().getId());
  const parents = dbFile.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const it = parent.getFoldersByName(CFG.DRIVE_FOLDER);
  const folder = it.hasNext() ? it.next() : parent.createFolder(CFG.DRIVE_FOLDER);
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function toDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

/** ตัดช่องว่าง จำกัดความยาว และกัน Formula Injection */
function clean(v, max) {
  let s = String(v == null ? '' : v).trim().slice(0, max || 200);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

/** อนุญาตเฉพาะลิงก์ที่ปลอดภัย */
function sanitizeLink(v) {
  const s = String(v || '').trim();
  return /^(https?:\/\/|tel:|mailto:|#)/i.test(s) ? s.slice(0, 500) : '#register';
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}