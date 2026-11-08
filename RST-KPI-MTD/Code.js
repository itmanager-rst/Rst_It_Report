/**
 * RST-KPI Dashboard — Google Apps Script Backend
 * ------------------------------------------------------------
 * ชีตที่ใช้ (นำเข้าจากไฟล์ RST_KPI_DB.xlsx หรือรัน setup() เพื่อสร้างใหม่)
 *   KPI_Data   : ข้อมูลผล KPI รายเดือน (1 แถว = 1 KPI x 1 เดือน)  — Primary key = ID
 *   KPI_Master : ทะเบียนหัวข้อ KPI + ทิศทางเป้า (HIGHER / LOWER)
 *   Lookup     : ตารางแปลงชื่อบริษัท/แผนกที่สะกดต่างกันให้เป็นชื่อมาตรฐาน
 *   Log        : ประวัติการอัปโหลด/บันทึก
 *
 * Endpoint
 *   GET  ?action=data&token=…  → { ok, data:[...], master:[...], lookup:[...], serverTime }
 *   GET  ?action=ping&token=…  → { ok:true }
 *   POST body(text/plain JSON) { action:'upsert', token, user, rows:[...] }
 *        → { ok, inserted, updated, unchanged, errors:[{index,msg}], newKpis:[...], rows:[...] }
 *        แถวที่มี forceDirection:true จะเปลี่ยนทิศทางของแถวเดิมได้ (ใช้จากหน้าแก้ไขด่วน)
 *   POST { action:'addKpi', kpi:{ company, dept, topic, method, direction, defaultTarget,
 *          companyCode?, deptCode?, year?, months?:[1..12] } }
 *        → { ok, kpi:{...KPI_Master}, rows:[...] }   (months = สร้างแถวรายเดือนล่วงหน้าพร้อม Target)
 *   POST { action:'updateKpi', kpi:{ kpiCode, topic?, method?, direction?, defaultTarget?, active?, applyFromYear? } }
 *        → { ok, kpi, rows:[แถวที่เปลี่ยน] }
 *   POST { action:'rollYear', fromYear, toYear, codes:[...], months:[...] }  (Admin) เปิดปี KPI ใหม่
 *        → { ok, created, skipped, rows:[...] }   คัดลอกหัวข้อ + Target ล่าสุด สร้างแถวรายเดือนล่วงหน้า (ไม่สร้างซ้ำ)
 *   POST { action:'deleteRows', ids:[...] }  → { ok, deleted, ids }   (เก็บสำเนาแถวที่ลบไว้ในชีต Log)
 *
 * หมายเหตุ CORS: ฝั่งหน้าเว็บต้องส่ง POST แบบ Content-Type: text/plain เท่านั้น
 * (ถ้าส่ง application/json เบราว์เซอร์จะยิง preflight ซึ่ง GAS ไม่รองรับ)
 */

/**
 * Token สำหรับเรียก API — ต้องตรงกับ API_TOKEN ใน index.html (รูปแบบเดียวกับแอป IT Subscription)
 * เปลี่ยนค่าได้ทั้งสองฝั่งพร้อมกัน แล้ว Deploy เวอร์ชันใหม่ / ปล่อยว่าง = ไม่ตรวจ
 */
const API_TOKEN = 'RSTKPI-i9I8R3TMgLoWHmIZHEZswrUoSciPzUdaJPpK';

const SH = { DATA: 'KPI_Data', MASTER: 'KPI_Master', LOOKUP: 'Lookup', LOG: 'Log', USERS: 'Users' };

/**
 * สิทธิ์ผู้ใช้ระดับแผนก (Role = DEPT) — Admin ทำได้ทุกอย่างเสมอ
 *   DEPT_CAN_DELETE     : ลบแถวข้อมูลของแผนกตัวเองได้
 *   DEPT_CAN_MANAGE_KPI : เพิ่ม/แก้/ปิดหัวข้อ KPI ของแผนกตัวเองได้
 */
const PERMS = { DEPT_CAN_DELETE: false, DEPT_CAN_MANAGE_KPI: false };
const SESSION_TTL = 6 * 60 * 60;          // วินาที (สูงสุดของ CacheService = 6 ชม.)
const USER_HEADERS = ['Username','DisplayName','Role','Company','Depts','Active','PassHash','Salt','CreatedAt','CreatedBy','LastLogin','Note'];

const DATA_HEADERS = ['ID','KPI_Code','Company','Dept','Year','Month','MonthName','Topic','Method','Link',
  'Direction','Target','Actual','Achieved','Result','Status','Note','SrcNo','UpdatedAt','UpdatedBy'];
const MASTER_HEADERS = ['KPI_Code','Company','Dept','Topic','Method','Direction','DefaultTarget',
  'FirstYM','LastYM','Active','NeedReview'];
const LOOKUP_HEADERS = ['Type','Raw','Canonical','Code'];
const LOG_HEADERS = ['Time','User','Action','Rows','Inserted','Updated','Errors','Detail'];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TH_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const MAX_ROWS_PER_REQUEST = 2000;

const R = { PASS: 'ผ่านเป้า', FAIL: 'ต่ำกว่าเป้า', NA: 'ไม่มีข้อมูล (N.A.)', PENDING: 'ยังไม่ได้ประเมิน' };
const S = { PASS: 'ผ่านเป้า', FAIL: 'ไม่ผ่านเป้า', PENDING: 'ยังไม่ได้ประเมิน' };

/* =========================== HTTP =========================== */

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (!checkKey_(p.token || p.key)) return json_({ ok: false, error: 'unauthorized: token ไม่ถูกต้อง' });
    const action = p.action || 'data';
    if (action === 'ping') return json_({ ok: true, serverTime: new Date().toISOString() });
    if (action === 'data') {
      return json_({
        ok: true,
        data: readObjects_(SH.DATA),
        master: readObjects_(SH.MASTER),
        lookup: readObjects_(SH.LOOKUP),
        serverTime: new Date().toISOString()
      });
    }
    return json_({ ok: false, error: 'ไม่รู้จัก action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'รูปแบบ JSON ไม่ถูกต้อง' });
  }
  if (!checkKey_(body.token || body.apiKey)) return json_({ ok: false, error: 'unauthorized: token ไม่ถูกต้อง' });

  // ---- ไม่ต้องล็อกอิน ----
  try {
    if (body.action === 'login') return json_(Object.assign({ ok: true }, login_(body.username, body.password)));
    if (body.action === 'logout') { if (body.session) CacheService.getScriptCache().remove('sess_' + body.session); return json_({ ok: true }); }
  } catch (err) { return json_({ ok: false, error: String(err && err.message || err) }); }

  // ---- ทุก action ต่อจากนี้ต้องมี session ที่ยังไม่หมดอายุ (เซิร์ฟเวอร์เป็นผู้ตัดสินสิทธิ์ ไม่เชื่อค่าจากหน้าเว็บ) ----
  const sess = getSession_(body.session);
  if (!sess) return json_({ ok: false, error: 'unauthenticated: กรุณาเข้าสู่ระบบ (หรือ session หมดอายุ)', code: 'AUTH' });
  if (body.action === 'me') return json_({ ok: true, me: publicSession_(sess) });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ ok: false, error: 'ระบบกำลังบันทึกข้อมูลของผู้ใช้อื่น กรุณาลองใหม่อีกครั้ง' });
  try {
    const a = body.action;
    if (a === 'upsert') return json_(Object.assign({ ok: true }, upsertRows_(body.rows || [], sess)));
    if (a === 'addKpi') return json_(Object.assign({ ok: true }, addKpi_(body.kpi || {}, sess)));
    if (a === 'updateKpi') return json_(Object.assign({ ok: true }, updateKpi_(body.kpi || {}, sess)));
    if (a === 'rollYear') { requireAdmin_(sess); return json_(Object.assign({ ok: true }, rollYear_(body, sess))); }
    if (a === 'deleteRows') return json_(Object.assign({ ok: true }, deleteRows_(body.ids || [], sess)));
    if (a === 'changePassword') return json_(Object.assign({ ok: true }, changePassword_(sess, body.oldPassword, body.newPassword)));
    if (a === 'listUsers') { requireAdmin_(sess); return json_({ ok: true, users: listUsers_() }); }
    if (a === 'saveUser') { requireAdmin_(sess); return json_(Object.assign({ ok: true }, saveUser_(body.u || {}, sess))); }
    return json_({ ok: false, error: 'ไม่รู้จัก action: ' + a });
  } catch (err) {
    log_(sess.name, body.action, (body.rows || []).length, 0, 0, 1, String(err && err.stack || err));
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* =========================== USERS / SESSION =========================== */
/*
 * ชีต Users: 1 แถว = 1 บัญชี
 *   Role  = ADMIN (ทำได้ทุกอย่าง + จัดการสมาชิก) | DEPT (แก้ไขได้เฉพาะ Company + Depts ของตัวเอง)
 *   Depts = ชื่อแผนกคั่นด้วย , (เช่น "HR, IT") หรือ * = ทุกแผนกในบริษัทนั้น
 *   รหัสผ่านเก็บเป็น SHA-256 + salt (วนซ้ำ) ไม่เก็บรหัสจริง — ลืมรหัสให้ Admin ตั้งใหม่
 */
function hash_(pw, salt) {
  let h = String(pw);
  for (let i = 0; i < 300; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + h, Utilities.Charset.UTF_8)
      .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  }
  return h;
}
function usersSheet_() { return ensureSheet_(SH.USERS, USER_HEADERS); }
function readUsers_() {
  const sh = usersSheet_(), u = colIndex_(sh, USER_HEADERS);
  return { sh, u, rows: sheetBody_(sh, USER_HEADERS.length) };
}
function userObj_(r, u) {
  const depts = String(r[u.Depts] || '').split(/\s*[,;\n]\s*/).map(cleanText_).filter(String);
  return { username: String(r[u.Username]).toLowerCase(), name: cleanText_(r[u.DisplayName]) || String(r[u.Username]),
    role: String(r[u.Role]).toUpperCase() === 'ADMIN' ? 'ADMIN' : 'DEPT', company: normCompany_(r[u.Company]),
    depts: depts.length ? depts : ['*'], active: String(r[u.Active] || 'Y').toUpperCase() !== 'N' };
}
function publicSession_(s) {
  return { username: s.username, name: s.name, role: s.role, company: s.company, depts: s.depts,
    canDelete: s.role === 'ADMIN' || PERMS.DEPT_CAN_DELETE, canManageKpi: s.role === 'ADMIN' || PERMS.DEPT_CAN_MANAGE_KPI };
}

function login_(username, password) {
  const un = cleanText_(username).toLowerCase();
  if (!un || !password) throw new Error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
  const cache = CacheService.getScriptCache(), failKey = 'fail_' + un;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('ใส่รหัสผิดหลายครั้ง บัญชีถูกพักชั่วคราว 10 นาที');
  const { sh, u, rows } = readUsers_();
  const i = rows.findIndex(r => String(r[u.Username]).toLowerCase() === un);
  const r = rows[i];
  if (!r || hash_(password, String(r[u.Salt])) !== String(r[u.PassHash])) {
    cache.put(failKey, String(fails + 1), 600);
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  const user = userObj_(r, u);
  if (!user.active) throw new Error('บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อ Admin');
  cache.remove(failKey);
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('sess_' + token, un, SESSION_TTL);
  sh.getRange(i + 2, u.LastLogin + 1).setValue(new Date());
  log_(user.name, 'login', 0, 0, 0, 0, un);
  return { session: token, me: publicSession_(user), ttl: SESSION_TTL };
}

/** ตรวจ session ทุกครั้ง + อ่านสิทธิ์ล่าสุดจากชีต (Admin ปิดบัญชี/เปลี่ยนแผนก มีผลทันที) */
function getSession_(token) {
  if (!token || !/^[0-9a-f]{40,80}$/.test(String(token))) return null;
  const cache = CacheService.getScriptCache();
  const un = cache.get('sess_' + token);
  if (!un) return null;
  const { u, rows } = readUsers_();
  const r = rows.find(x => String(x[u.Username]).toLowerCase() === un);
  if (!r) return null;
  const user = userObj_(r, u);
  if (!user.active) { cache.remove('sess_' + token); return null; }
  cache.put('sess_' + token, un, SESSION_TTL);        // ต่ออายุเมื่อมีการใช้งาน
  return user;
}

function requireAdmin_(sess) { if (!sess || sess.role !== 'ADMIN') throw new Error('เฉพาะ Admin เท่านั้น'); }
function inScope_(sess, company, dept) {
  if (sess.role === 'ADMIN') return true;
  if (normCompany_(company) !== sess.company) return false;
  return sess.depts.includes('*') || sess.depts.some(d => normKey_(d) === normKey_(dept));
}
function canEditDept_(sess, company, dept) { return inScope_(sess, company, dept); }
function canDelete_(sess, company, dept) { return sess.role === 'ADMIN' || (PERMS.DEPT_CAN_DELETE && inScope_(sess, company, dept)); }
function canManageKpi_(sess, company, dept) { return sess.role === 'ADMIN' || (PERMS.DEPT_CAN_MANAGE_KPI && inScope_(sess, company, dept)); }

function listUsers_() {
  const { u, rows } = readUsers_();
  return rows.map(r => Object.assign(userObj_(r, u), {
    note: cleanText_(r[u.Note]), createdBy: cleanText_(r[u.CreatedBy]),
    createdAt: r[u.CreatedAt] instanceof Date ? r[u.CreatedAt].toISOString() : String(r[u.CreatedAt] || ''),
    lastLogin: r[u.LastLogin] instanceof Date ? r[u.LastLogin].toISOString() : String(r[u.LastLogin] || '') }));
}

/** เพิ่ม/แก้ไขสมาชิก (Admin) — ส่ง password มาเฉพาะตอนสร้างใหม่หรือรีเซ็ตรหัส */
function saveUser_(x, sess) {
  const un = cleanText_(x.username).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(un)) throw new Error('ชื่อผู้ใช้ 3–30 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -');
  const { sh, u, rows } = readUsers_();
  const i = rows.findIndex(r => String(r[u.Username]).toLowerCase() === un);
  const isNew = i < 0;
  if (isNew && !x.isNew) throw new Error('ไม่พบผู้ใช้ ' + un);
  if (!isNew && x.isNew) throw new Error('ชื่อผู้ใช้ "' + un + '" มีอยู่แล้ว');
  const role = String(x.role || '').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'DEPT';
  const lk = buildLookup_();
  const company = role === 'ADMIN' ? '' : canon_(lk.company, normCompany_(x.company));
  const depts = role === 'ADMIN' ? '*' : (Array.isArray(x.depts) ? x.depts : String(x.depts || '').split(','))
    .map(d => cleanText_(d)).filter(String).map(d => d === '*' ? '*' : canon_(lk.dept, d)).join(', ');
  if (role === 'DEPT' && (!company || !depts)) throw new Error('ผู้ใช้ระดับแผนกต้องระบุบริษัทและแผนก');
  const active = String(x.active || 'Y').toUpperCase() === 'N' ? 'N' : 'Y';
  const pw = x.password ? String(x.password) : '';
  if (isNew && !pw) throw new Error('กรุณาตั้งรหัสผ่าน');
  if (pw && pw.length < 8) throw new Error('รหัสผ่านอย่างน้อย 8 ตัวอักษร');

  // กันล็อกตัวเองออก: ต้องเหลือ Admin ที่ใช้งานได้อย่างน้อย 1 คน
  if (!isNew) {
    const admins = rows.map(r => userObj_(r, u)).filter(o => o.role === 'ADMIN' && o.active && o.username !== un);
    if ((role !== 'ADMIN' || active === 'N') && !admins.length) throw new Error('ต้องมี Admin ที่ใช้งานได้อย่างน้อย 1 คน');
  }
  const row = isNew ? new Array(USER_HEADERS.length).fill('') : rows[i];
  row[u.Username] = un; row[u.DisplayName] = cleanText_(x.name) || un; row[u.Role] = role;
  row[u.Company] = company; row[u.Depts] = depts; row[u.Active] = active; row[u.Note] = cleanText_(x.note);
  if (pw) { const salt = Utilities.getUuid(); row[u.Salt] = salt; row[u.PassHash] = hash_(pw, salt); }
  if (isNew) { row[u.CreatedAt] = new Date(); row[u.CreatedBy] = sess.username; sh.appendRow(row); }
  else sh.getRange(i + 2, 1, 1, USER_HEADERS.length).setValues([row]);
  log_(sess.name, isNew ? 'addUser' : 'updateUser', 1, isNew ? 1 : 0, isNew ? 0 : 1, 0,
       un + ' ' + role + ' ' + company + ' [' + depts + '] active=' + active + (pw ? ' (ตั้งรหัสใหม่)' : ''));
  return { user: listUsers_().find(o => o.username === un) };
}

function changePassword_(sess, oldPw, newPw) {
  if (!newPw || String(newPw).length < 8) throw new Error('รหัสผ่านใหม่อย่างน้อย 8 ตัวอักษร');
  const { sh, u, rows } = readUsers_();
  const i = rows.findIndex(r => String(r[u.Username]).toLowerCase() === sess.username);
  if (i < 0 || hash_(oldPw || '', String(rows[i][u.Salt])) !== String(rows[i][u.PassHash])) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  const salt = Utilities.getUuid();
  sh.getRange(i + 2, u.PassHash + 1, 1, 2).setValues([[hash_(newPw, salt), salt]]);
  log_(sess.name, 'changePassword', 0, 0, 0, 0, sess.username);
  return {};
}

/* =========================== UPSERT =========================== */

function upsertRows_(rows, sess) {
  const user = sess.name;
  if (!Array.isArray(rows)) throw new Error('rows ต้องเป็น array');
  if (rows.length > MAX_ROWS_PER_REQUEST) throw new Error('ส่งได้ไม่เกิน ' + MAX_ROWS_PER_REQUEST + ' แถวต่อครั้ง');

  const ss = SpreadsheetApp.getActive();
  const dataSh = ensureSheet_(SH.DATA, DATA_HEADERS);
  const masterSh = ensureSheet_(SH.MASTER, MASTER_HEADERS);
  const lk = buildLookup_();

  // ---- โหลดข้อมูลเดิมทั้งหมดครั้งเดียว ----
  const dCol = colIndex_(dataSh, DATA_HEADERS);
  const dVals = sheetBody_(dataSh, DATA_HEADERS.length);
  const idRow = new Map();                         // ID -> index ใน dVals
  dVals.forEach((r, i) => { if (r[dCol.ID]) idRow.set(String(r[dCol.ID]), i); });

  const mCol = colIndex_(masterSh, MASTER_HEADERS);
  const mVals = sheetBody_(masterSh, MASTER_HEADERS.length);
  const mByCode = new Map(), mByKey = new Map(), seqByPrefix = new Map();
  mVals.forEach((r, i) => {
    const code = String(r[mCol.KPI_Code] || '');
    if (!code) return;
    mByCode.set(code, i);
    mByKey.set(masterKey_(r[mCol.Company], r[mCol.Dept], r[mCol.Topic]), i);
    const m = code.match(/^(.*)-(\d+)$/);
    if (m) seqByPrefix.set(m[1], Math.max(seqByPrefix.get(m[1]) || 0, Number(m[2])));
  });

  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
  const errors = [], newKpis = [], touched = [];
  let inserted = 0, updated = 0, unchanged = 0;
  const seenInBatch = new Set();
  let masterDirty = false;

  rows.forEach((raw, index) => {
    try {
      const v = normalizeIncoming_(raw, lk);

      // ---- หา/สร้าง KPI_Code ----
      let mi = v.kpiCode && mByCode.has(v.kpiCode) ? mByCode.get(v.kpiCode)
             : mByKey.get(masterKey_(v.company, v.dept, v.topic));
      if (mi === undefined) {
        if (!v.topic) throw new Error('ไม่พบ KPI_Code และไม่มี TOPIC สำหรับสร้างหัวข้อใหม่');
        if (!canManageKpi_(sess, v.company, v.dept)) throw new Error('หัวข้อใหม่ "' + v.topic.slice(0, 40) + '…" — เฉพาะ Admin เพิ่มหัวข้อ KPI ได้');
        const prefix = (lk.compCode[v.company] || 'X') + '-' + (lk.deptCode[v.dept] || 'X');
        const seq = (seqByPrefix.get(prefix) || 0) + 1;
        seqByPrefix.set(prefix, seq);
        const code = prefix + '-' + String(seq).padStart(2, '0');
        const ym = v.year + '-' + String(v.month).padStart(2, '0');
        const mrow = new Array(MASTER_HEADERS.length).fill('');
        mrow[mCol.KPI_Code] = code; mrow[mCol.Company] = v.company; mrow[mCol.Dept] = v.dept;
        mrow[mCol.Topic] = v.topic; mrow[mCol.Method] = v.method || '';
        mrow[mCol.Direction] = v.direction || 'HIGHER';
        mrow[mCol.DefaultTarget] = isNum_(v.target) ? v.target : '';
        mrow[mCol.FirstYM] = "'" + ym; mrow[mCol.LastYM] = "'" + ym; mrow[mCol.Active] = 'Y';   // ' = เก็บเป็นข้อความ ไม่ให้ Sheets แปลงเป็นวันที่
        mrow[mCol.NeedReview] = v.direction ? '' : 'Y';     // เดาทิศทางไม่ได้ → ให้คนตรวจ
        mVals.push(mrow);
        mi = mVals.length - 1;
        mByCode.set(code, mi); mByKey.set(masterKey_(v.company, v.dept, v.topic), mi);
        newKpis.push({ code, company: v.company, dept: v.dept, topic: v.topic, direction: mrow[mCol.Direction] });
        masterDirty = true;
      }
      const m = mVals[mi];
      if (!canEditDept_(sess, m[mCol.Company], m[mCol.Dept]))
        throw new Error('ไม่มีสิทธิ์แก้ไขข้อมูลแผนก ' + m[mCol.Dept] + ' · ' + m[mCol.Company]);
      if (raw.needReview && m[mCol.NeedReview] !== 'Y') { m[mCol.NeedReview] = 'Y'; masterDirty = true; }  // สูตร Excel ทิศทางไม่สม่ำเสมอ
      const code = String(m[mCol.KPI_Code]);
      const direction = String(m[mCol.Direction] || 'HIGHER').toUpperCase() === 'LOWER' ? 'LOWER' : 'HIGHER';
      const ym = v.year + '-' + String(v.month).padStart(2, '0');
      if (ymText_(m[mCol.LastYM]) < ym) { m[mCol.LastYM] = "'" + ym; masterDirty = true; }

      const id = code + '_' + v.year + '_' + String(v.month).padStart(2, '0');
      if (seenInBatch.has(id)) throw new Error('ID ซ้ำในไฟล์เดียวกัน: ' + id + ' (ใช้แถวแรก)');
      seenInBatch.add(id);

      // ---- รวมกับข้อมูลเดิม (อัปเดตเฉพาะช่องที่ส่งมา) ----
      const isNew = !idRow.has(id);
      const row = isNew ? new Array(DATA_HEADERS.length).fill('') : dVals[idRow.get(id)];
      const before = isNew ? '' : JSON.stringify(row.slice(0, dCol.UpdatedAt));

      row[dCol.ID] = id; row[dCol.KPI_Code] = code;
      row[dCol.Company] = m[mCol.Company]; row[dCol.Dept] = m[mCol.Dept];
      row[dCol.Year] = v.year; row[dCol.Month] = v.month; row[dCol.MonthName] = MONTHS[v.month - 1];
      row[dCol.Topic] = v.topic || row[dCol.Topic] || m[mCol.Topic];
      if (v.method !== undefined) row[dCol.Method] = v.method;
      if (v.link !== undefined) row[dCol.Link] = v.link;
      if (v.note !== undefined) row[dCol.Note] = v.note;
      if (v.srcNo !== undefined) row[dCol.SrcNo] = v.srcNo;
      if (v.target !== undefined) row[dCol.Target] = v.target;
      else if (isNew) row[dCol.Target] = m[mCol.DefaultTarget];
      if (v.actual !== undefined) row[dCol.Actual] = v.actual;
      // แถวเดิมใช้ทิศทางที่บันทึกไว้แล้ว (บาง KPI ทิศทางต่างกันรายปี)
      // แถวใหม่: ใช้ทิศทางที่หน้าเว็บส่งมา (ตรวจจากสูตร Excel แบบเสียงข้างมากรายปี) ถ้าไม่มีใช้ KPI_Master
      // forceDirection = ผู้ใช้แก้ทิศทางเองจากหน้าแก้ไขด่วน → ทับค่าเดิมได้
      if (isNew || !row[dCol.Direction] || (v.forceDirection && v.direction)) row[dCol.Direction] = v.direction || direction;
      const rowDir = String(row[dCol.Direction]).toUpperCase() === 'LOWER' ? 'LOWER' : 'HIGHER';

      const ev = evaluateKpi(row[dCol.Target], row[dCol.Actual], rowDir);
      row[dCol.Achieved] = ev.achieved === null ? '' : ev.achieved;
      row[dCol.Result] = ev.result; row[dCol.Status] = ev.status;

      if (!isNew && JSON.stringify(row.slice(0, dCol.UpdatedAt)) === before) { unchanged++; return; }
      row[dCol.UpdatedAt] = now; row[dCol.UpdatedBy] = user;
      if (isNew) { dVals.push(row); idRow.set(id, dVals.length - 1); inserted++; }
      else updated++;
      touched.push(rowToObj_(row, DATA_HEADERS));
    } catch (err) {
      errors.push({ index, msg: String(err && err.message || err) });
    }
  });

  // ---- เขียนกลับครั้งเดียว (เร็วกว่าเขียนทีละแถวหลายสิบเท่า) ----
  if (inserted || updated) writeBody_(dataSh, dVals, DATA_HEADERS.length);
  if (masterDirty) writeBody_(masterSh, mVals, MASTER_HEADERS.length);
  log_(user, 'upsert', rows.length, inserted, updated, errors.length,
       errors.slice(0, 5).map(e => '#' + e.index + ' ' + e.msg).join(' | '));

  return { inserted, updated, unchanged, errors, newKpis, rows: touched };
}

/**
 * ตรรกะเดียวกับสูตรใน Excel (คอลัมน์ K, L, M) แต่ทิศทางมาจาก KPI_Master
 *   HIGHER : Actual >= Target → ผ่าน   (ยอดขาย, % ทำได้ตามแผน)
 *   LOWER  : Actual <= Target → ผ่าน   (ข้อร้องเรียน, จำนวนวัน, ค่าใช้จ่าย)
 *   Actual ว่าง → ยังไม่ได้ประเมิน | Actual เป็นข้อความ เช่น N.A. → ไม่นับผ่าน/ไม่ผ่าน
 */
function evaluateKpi(target, actual, direction) {
  if (actual === '' || actual === null || actual === undefined)
    return { achieved: null, result: R.PENDING, status: S.PENDING };
  if (!isNum_(actual) || !isNum_(target))
    return { achieved: null, result: R.NA, status: S.PENDING };
  const t = Number(target), a = Number(actual), EPS = 1e-9;
  const lower = direction === 'LOWER';
  const ok = lower ? a <= t + EPS : a >= t - EPS;
  let achieved = null;
  if (lower) achieved = a !== 0 ? t / a : (ok ? 1 : null);
  else achieved = t !== 0 ? a / t : null;
  if (achieved !== null) achieved = Math.round(achieved * 10000) / 10000;
  return { achieved, result: ok ? R.PASS : R.FAIL, status: ok ? S.PASS : S.FAIL };
}

/* =========================== NORMALIZE =========================== */

function normalizeIncoming_(r, lk) {
  if (!r || typeof r !== 'object') throw new Error('แถวว่างหรือไม่ใช่ object');
  const company = canon_(lk.company, normCompany_(r.company));
  const dept = canon_(lk.dept, cleanText_(r.dept));
  const topic = cleanText_(r.topic);
  const kpiCode = cleanText_(r.kpiCode);
  if (!kpiCode && (!company || !dept)) throw new Error('ไม่มีชื่อบริษัทหรือแผนก');
  if (!kpiCode && !topic) throw new Error('ไม่มี TOPIC');

  const month = parseMonth_(r.month);
  if (!month) throw new Error('เดือนไม่ถูกต้อง: ' + r.month);
  const year = parseYear_(r.year);
  if (!year) throw new Error('ปีไม่ถูกต้อง: ' + r.year);

  const out = { company, dept, topic, kpiCode, month, year };
  if ('target' in r) {
    const t = parseNumber_(r.target);
    if (t !== '' && !isNum_(t)) throw new Error('Target ต้องเป็นตัวเลข: ' + r.target);
    out.target = t;
  }
  if ('actual' in r) out.actual = parseNumber_(r.actual);   // ข้อความเช่น N.A. เก็บไว้ได้
  ['method', 'link', 'note'].forEach(k => { if (k in r) out[k] = cleanText_(r[k]); });
  if ('srcNo' in r) out.srcNo = r.srcNo;
  if (r.direction) out.direction = String(r.direction).toUpperCase() === 'LOWER' ? 'LOWER' : 'HIGHER';
  if (r.forceDirection) out.forceDirection = true;
  return out;
}

/* =========================== KPI MASTER (เพิ่ม / แก้ไขหัวข้อ) =========================== */

function addKpi_(k, sess) {
  const user = sess.name;
  const lk = buildLookup_();
  const company = canon_(lk.company, normCompany_(k.company));
  const dept = canon_(lk.dept, cleanText_(k.dept));
  const topic = cleanText_(k.topic);
  if (!company) throw new Error('กรุณาระบุบริษัท');
  if (!dept) throw new Error('กรุณาระบุแผนก');
  if (topic.length < 5) throw new Error('หัวข้อ KPI สั้นเกินไป (อย่างน้อย 5 ตัวอักษร)');
  const target = parseNumber_(k.defaultTarget);
  if (target !== '' && !isNum_(target)) throw new Error('Target ต้องเป็นตัวเลข เช่น 95%, 0.95, 10');
  const direction = String(k.direction || '').toUpperCase() === 'LOWER' ? 'LOWER' : 'HIGHER';
  if (!canManageKpi_(sess, company, dept)) throw new Error('ไม่มีสิทธิ์เพิ่มหัวข้อ KPI ของ ' + dept + ' · ' + company);

  // บริษัท/แผนกใหม่ → ต้องมีรหัสย่อ แล้วเพิ่มลงชีต Lookup อัตโนมัติ
  const lkSh = ensureSheet_(SH.LOOKUP, LOOKUP_HEADERS);
  const codeOk = c => /^[A-Z0-9]{2,5}$/.test(c);
  if (!lk.compCode[company]) {
    const c = cleanText_(k.companyCode).toUpperCase();
    if (sess.role !== 'ADMIN') throw new Error('เฉพาะ Admin เพิ่มบริษัทใหม่ได้');
    if (!codeOk(c)) throw new Error('บริษัทใหม่ "' + company + '" ต้องระบุรหัสย่อ 2–5 ตัว (A-Z, 0-9)');
    lkSh.appendRow(['COMPANY', company, company, c]);
  }
  if (!lk.deptCode[dept]) {
    const c = cleanText_(k.deptCode).toUpperCase();
    if (sess.role !== 'ADMIN') throw new Error('เฉพาะ Admin เพิ่มแผนกใหม่ได้');
    if (!codeOk(c)) throw new Error('แผนกใหม่ "' + dept + '" ต้องระบุรหัสย่อ 2–5 ตัว (A-Z, 0-9)');
    lkSh.appendRow(['DEPT', dept, dept, c]);
  }
  const lk2 = buildLookup_();

  const masterSh = ensureSheet_(SH.MASTER, MASTER_HEADERS);
  const mCol = colIndex_(masterSh, MASTER_HEADERS);
  const mVals = sheetBody_(masterSh, MASTER_HEADERS.length);
  const key = masterKey_(company, dept, topic);
  const dup = mVals.find(r => masterKey_(r[mCol.Company], r[mCol.Dept], r[mCol.Topic]) === key);
  if (dup) throw new Error('มีหัวข้อนี้อยู่แล้ว: ' + dup[mCol.KPI_Code]);

  const prefix = lk2.compCode[company] + '-' + lk2.deptCode[dept];
  let seq = 0;
  mVals.forEach(r => { const m = String(r[mCol.KPI_Code]).match(/^(.*)-(\d+)$/); if (m && m[1] === prefix) seq = Math.max(seq, Number(m[2])); });
  const code = prefix + '-' + String(seq + 1).padStart(2, '0');
  const year = parseYear_(k.year) || (new Date().getFullYear() + 543);
  const months = (Array.isArray(k.months) ? k.months : []).map(Number).filter(m => m >= 1 && m <= 12);
  const ym = year + '-' + String(months[0] || new Date().getMonth() + 1).padStart(2, '0');

  const mrow = new Array(MASTER_HEADERS.length).fill('');
  mrow[mCol.KPI_Code] = code; mrow[mCol.Company] = company; mrow[mCol.Dept] = dept; mrow[mCol.Topic] = topic;
  mrow[mCol.Method] = cleanText_(k.method); mrow[mCol.Direction] = direction;
  mrow[mCol.DefaultTarget] = target; mrow[mCol.FirstYM] = "'" + ym; mrow[mCol.LastYM] = "'" + ym;
  mrow[mCol.Active] = 'Y'; mrow[mCol.NeedReview] = '';
  masterSh.appendRow(mrow);
  log_(user, 'addKpi', 1, 1, 0, 0, code + ' ' + topic);

  let rows = [];
  if (months.length) {
    const res = upsertRows_(months.map(m => ({ kpiCode: code, topic, year, month: m, target, direction })), sess);
    rows = res.rows;
  }
  return { kpi: rowToObj_(mrow.map(v => typeof v === 'string' ? v.replace(/^'/, '') : v), MASTER_HEADERS), rows };
}

function updateKpi_(k, sess) {
  const user = sess.name;
  const code = cleanText_(k.kpiCode);
  if (!code) throw new Error('ไม่มี KPI_Code');
  const masterSh = ensureSheet_(SH.MASTER, MASTER_HEADERS);
  const mCol = colIndex_(masterSh, MASTER_HEADERS);
  const mVals = sheetBody_(masterSh, MASTER_HEADERS.length);
  const mi = mVals.findIndex(r => String(r[mCol.KPI_Code]) === code);
  if (mi < 0) throw new Error('ไม่พบ KPI_Code: ' + code);
  const m = mVals[mi];
  if (!canManageKpi_(sess, m[mCol.Company], m[mCol.Dept])) throw new Error('ไม่มีสิทธิ์แก้ไขหัวข้อ KPI นี้');
  const changes = [];

  if ('topic' in k) {
    const t = cleanText_(k.topic);
    if (t.length < 5) throw new Error('หัวข้อ KPI สั้นเกินไป');
    const key = masterKey_(m[mCol.Company], m[mCol.Dept], t);
    const dup = mVals.find((r, i) => i !== mi && masterKey_(r[mCol.Company], r[mCol.Dept], r[mCol.Topic]) === key);
    if (dup) throw new Error('ชื่อหัวข้อซ้ำกับ ' + dup[mCol.KPI_Code]);
    if (t !== m[mCol.Topic]) { m[mCol.Topic] = t; changes.push('topic'); }
  }
  if ('method' in k) { m[mCol.Method] = cleanText_(k.method); changes.push('method'); }
  if ('defaultTarget' in k) {
    const t = parseNumber_(k.defaultTarget);
    if (t !== '' && !isNum_(t)) throw new Error('Target ต้องเป็นตัวเลข');
    m[mCol.DefaultTarget] = t; changes.push('target');
  }
  if ('active' in k) { m[mCol.Active] = String(k.active).toUpperCase() === 'N' ? 'N' : 'Y'; changes.push('active'); }
  let newDir = '';
  if (k.direction) {
    newDir = String(k.direction).toUpperCase() === 'LOWER' ? 'LOWER' : 'HIGHER';
    m[mCol.Direction] = newDir; m[mCol.NeedReview] = ''; changes.push('direction');
  }
  // FirstYM/LastYM อาจถูก Sheets แปลงเป็นวันที่ → เขียนกลับเป็นข้อความ
  m[mCol.FirstYM] = "'" + ymText_(m[mCol.FirstYM]); m[mCol.LastYM] = "'" + ymText_(m[mCol.LastYM]);
  writeBody_(masterSh, mVals, MASTER_HEADERS.length);

  // นำไปใช้กับแถวข้อมูล: ชื่อหัวข้อทุกแถว / ทิศทางตั้งแต่ปีที่เลือก แล้วคำนวณผลใหม่
  const touched = [];
  const fromYear = parseYear_(k.applyFromYear);
  if (changes.includes('topic') || (newDir && fromYear)) {
    const dataSh = ensureSheet_(SH.DATA, DATA_HEADERS);
    const d = colIndex_(dataSh, DATA_HEADERS);
    const rows = sheetBody_(dataSh, DATA_HEADERS.length);
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
    rows.forEach(r => {
      if (String(r[d.KPI_Code]) !== code) return;
      let hit = false;
      if (changes.includes('topic') && r[d.Topic] !== m[mCol.Topic]) { r[d.Topic] = m[mCol.Topic]; hit = true; }
      if (newDir && fromYear && Number(r[d.Year]) >= fromYear && r[d.Direction] !== newDir) {
        r[d.Direction] = newDir;
        const ev = evaluateKpi(r[d.Target], r[d.Actual], newDir);
        r[d.Achieved] = ev.achieved === null ? '' : ev.achieved; r[d.Result] = ev.result; r[d.Status] = ev.status;
        hit = true;
      }
      if (hit) { r[d.UpdatedAt] = now; r[d.UpdatedBy] = user; touched.push(rowToObj_(r, DATA_HEADERS)); }
    });
    if (touched.length) writeBody_(dataSh, rows, DATA_HEADERS.length);
  }
  log_(user, 'updateKpi', 1, 0, touched.length, 0, code + ' ' + changes.join(','));
  return { kpi: rowToObj_(m.map(v => typeof v === 'string' ? v.replace(/^'/, '') : v), MASTER_HEADERS), rows: touched };
}

/**
 * เปิดปี KPI ใหม่ (Admin): สร้างแถวรายเดือนของปีใหม่จากหัวข้อที่เลือก
 *   Target / ทิศทาง = ค่าล่าสุดของหัวข้อนั้นในปีต้นแบบ (ไม่มี → ใช้ KPI_Master)
 *   แถวที่มีอยู่แล้ว (ID ซ้ำ) จะข้าม ไม่เขียนทับ → กดซ้ำได้ปลอดภัย
 */
function rollYear_(b, sess) {
  const fromYear = parseYear_(b.fromYear), toYear = parseYear_(b.toYear);
  if (!toYear) throw new Error('ปีใหม่ไม่ถูกต้อง');
  if (fromYear && toYear <= fromYear) throw new Error('ปีใหม่ต้องมากกว่าปีต้นแบบ');
  const codes = new Set((b.codes || []).map(String));
  const months = [...new Set((b.months || []).map(Number).filter(m => m >= 1 && m <= 12))];
  if (!codes.size) throw new Error('ยังไม่ได้เลือกหัวข้อ KPI');
  if (!months.length) throw new Error('ยังไม่ได้เลือกเดือน');

  const masterSh = ensureSheet_(SH.MASTER, MASTER_HEADERS), mCol = colIndex_(masterSh, MASTER_HEADERS);
  const master = new Map(sheetBody_(masterSh, MASTER_HEADERS.length).map(r => [String(r[mCol.KPI_Code]), r]));
  const dataSh = ensureSheet_(SH.DATA, DATA_HEADERS), d = colIndex_(dataSh, DATA_HEADERS);
  const data = sheetBody_(dataSh, DATA_HEADERS.length);
  const ids = new Set(data.map(r => String(r[d.ID])));
  const latest = new Map();                         // ค่าล่าสุดของแต่ละหัวข้อในปีต้นแบบ
  data.forEach(r => {
    const c = String(r[d.KPI_Code]);
    if (!codes.has(c) || (fromYear && Number(r[d.Year]) !== fromYear)) return;
    const k = Number(r[d.Year]) * 100 + Number(r[d.Month]), cur = latest.get(c);
    if (isNum_(r[d.Target]) && (!cur || k > cur.k)) latest.set(c, { k, target: r[d.Target], direction: r[d.Direction] });
  });

  const rows = [], missing = [];
  let skipped = 0;
  codes.forEach(c => {
    const m = master.get(c);
    if (!m) { missing.push(c); return; }
    const src = latest.get(c);
    const target = src ? src.target : (isNum_(m[mCol.DefaultTarget]) ? m[mCol.DefaultTarget] : '');
    const direction = String((src && src.direction) || m[mCol.Direction] || 'HIGHER').toUpperCase() === 'LOWER' ? 'LOWER' : 'HIGHER';
    months.forEach(mo => {
      if (ids.has(c + '_' + toYear + '_' + String(mo).padStart(2, '0'))) { skipped++; return; }
      rows.push({ kpiCode: c, topic: cleanText_(m[mCol.Topic]), method: cleanText_(m[mCol.Method]), year: toYear, month: mo, target, direction });
    });
  });
  if (missing.length) throw new Error('ไม่พบรหัสใน KPI_Master: ' + missing.slice(0, 5).join(', '));
  let created = 0; const out = [], errors = [];
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_REQUEST) {
    const res = upsertRows_(rows.slice(i, i + MAX_ROWS_PER_REQUEST), sess);
    created += res.inserted; out.push(...res.rows); errors.push(...res.errors);
  }
  log_(sess.name, 'rollYear', rows.length, created, 0, errors.length, (fromYear || '-') + ' → ' + toYear + ' · ' + codes.size + ' หัวข้อ × ' + months.length + ' เดือน · ข้าม ' + skipped);
  return { created, skipped, errors, rows: out };
}

/** ลบแถวข้อมูลตาม ID (แก้ไขด่วน) — สำเนาแถวที่ลบเก็บใน Log เพื่อกู้คืนได้ */
function deleteRows_(ids, sess) {
  const user = sess.name;
  if (!Array.isArray(ids) || !ids.length) throw new Error('ไม่มี ID ที่จะลบ');
  if (ids.length > 200) throw new Error('ลบได้ครั้งละไม่เกิน 200 แถว');
  const want = new Set(ids.map(String));
  const dataSh = ensureSheet_(SH.DATA, DATA_HEADERS);
  const d = colIndex_(dataSh, DATA_HEADERS);
  const rows = sheetBody_(dataSh, DATA_HEADERS.length);
  const keep = [], removed = [];
  rows.forEach(r => (want.has(String(r[d.ID])) ? removed : keep).push(r));
  if (!removed.length) throw new Error('ไม่พบ ID ที่ระบุ');
  const denied = removed.filter(r => !canDelete_(sess, r[d.Company], r[d.Dept]));
  if (denied.length) throw new Error('ไม่มีสิทธิ์ลบ ' + denied.length + ' แถว (เช่น ' + denied[0][d.ID] + ')');
  writeBody_(dataSh, keep, DATA_HEADERS.length);
  if (!keep.length) dataSh.getRange(2, 1, Math.max(1, dataSh.getLastRow() - 1), DATA_HEADERS.length).clearContent();
  removed.forEach(r => log_(user, 'deleteRow', 1, 0, 0, 0, JSON.stringify(rowToObj_(r, DATA_HEADERS))));
  return { deleted: removed.length, ids: removed.map(r => String(r[d.ID])) };
}

function buildLookup_() {
  const lk = { company: {}, dept: {}, compCode: {}, deptCode: {} };
  readObjects_(SH.LOOKUP).forEach(o => {
    const type = String(o.Type || '').toUpperCase();
    const canon = cleanText_(o.Canonical);
    if (!canon) return;
    if (type === 'COMPANY') {
      lk.company[normKey_(normCompany_(o.Raw))] = normCompany_(canon);
      lk.company[normKey_(normCompany_(canon))] = normCompany_(canon);
      if (o.Code) lk.compCode[normCompany_(canon)] = String(o.Code);
    } else if (type === 'DEPT') {
      lk.dept[normKey_(o.Raw)] = canon;
      lk.dept[normKey_(canon)] = canon;
      if (o.Code) lk.deptCode[canon] = String(o.Code);
    }
  });
  return lk;
}

/** อ่านค่า ปี-เดือน ที่ Sheets อาจแปลงเป็น Date ไปแล้ว ให้กลับเป็นข้อความ 'yyyy-MM' */
function ymText_(v) {
  if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0');
  return String(v || '').replace(/^'/, '');
}

function canon_(map, v) { return v ? (map[normKey_(v)] || v) : ''; }
function cleanText_(v) { return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim(); }
function normCompany_(v) { return cleanText_(v).replace(/\s*-\s*/g, '-').toUpperCase(); }
function normKey_(v) { return cleanText_(v).toLowerCase().replace(/[\s_:&\-]+/g, ''); }
function masterKey_(c, d, t) { return normCompany_(c) + '|' + cleanText_(d) + '|' + cleanText_(t).toLowerCase(); }
function isNum_(v) { return v !== '' && v !== null && typeof v !== 'boolean' && isFinite(Number(v)); }

function parseNumber_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '' || s === '-') return '';
  const pct = /%$/.test(s);
  const n = Number(s.replace(/[,%\s]/g, ''));
  if (isFinite(n) && s.replace(/[,%\s]/g, '') !== '') return pct ? n / 100 : n;
  return s;                                    // เก็บข้อความไว้ (เช่น N.A.)
}

function parseMonth_(v) {
  if (v instanceof Date) return v.getMonth() + 1;
  if (typeof v === 'number') return v >= 1 && v <= 12 ? Math.floor(v) : 0;
  const s = cleanText_(v).toLowerCase();
  if (!s) return 0;
  if (/^\d{1,2}$/.test(s)) { const n = Number(s); return n >= 1 && n <= 12 ? n : 0; }
  let i = MONTHS.findIndex(m => s.startsWith(m.toLowerCase()));
  if (i >= 0) return i + 1;
  i = TH_MONTHS.findIndex(m => s.replace(/\s/g, '') === m || s.startsWith(m.replace(/\./g, '').slice(0, 2)));
  return i >= 0 ? i + 1 : 0;
}

function parseYear_(v) {
  const n = Number(String(v || '').trim());
  if (!isFinite(n) || n <= 0) return 0;
  if (n < 100) return 2500 + n;               // 68 → 2568
  if (n < 2400) return n + 543;               // ค.ศ. → พ.ศ.
  return Math.floor(n);
}

/* =========================== SHEET HELPERS =========================== */

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function colIndex_(sh, expected) {
  const hdr = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), expected.length)).getValues()[0].map(String);
  const idx = {};
  expected.forEach((h, i) => {
    if (hdr[i] !== h) throw new Error('หัวคอลัมน์ชีต "' + sh.getName() + '" คอลัมน์ ' + (i + 1) +
      ' ต้องเป็น "' + h + '" แต่พบ "' + hdr[i] + '" (ห้ามสลับ/ลบคอลัมน์)');
    idx[h] = i;
  });
  return idx;
}

function sheetBody_(sh, width) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, width).getValues().filter(r => r.some(c => c !== ''));
}

function writeBody_(sh, rows, width) {
  if (!rows.length) return;
  const last = sh.getLastRow();
  sh.getRange(2, 1, rows.length, width).setValues(rows);
  if (last - 1 > rows.length) sh.getRange(rows.length + 2, 1, last - 1 - rows.length, width).clearContent();
}

function readObjects_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const vals = sh.getDataRange().getValues();
  const hdr = vals.shift().map(String);
  return vals.filter(r => r.some(c => c !== '')).map(r => rowToObj_(r, hdr));
}

function rowToObj_(r, hdr) {
  const o = {};
  hdr.forEach((h, i) => { if (h) o[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
  return o;
}

function log_(user, action, n, ins, upd, err, detail) {
  try {
    const sh = ensureSheet_(SH.LOG, LOG_HEADERS);
    sh.appendRow([new Date(), user || '', action || '', n, ins, upd, err, String(detail || '').slice(0, 2000)]);
  } catch (e) { /* ไม่ให้ log ทำให้งานหลักล้ม */ }
}

function checkKey_(token) {
  const required = API_TOKEN || PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '';
  return !required || String(token || '') === required;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================== ADMIN (รันจาก Editor) =========================== */

/** ค่าเริ่มต้นของชีต Lookup: [Type, คำที่พบในไฟล์, ชื่อมาตรฐาน, รหัสย่อ] */
const LOOKUP_SEED = [
  ['COMPANY','RST-ASIA','RST-ASIA','ASIA'],['COMPANY','RST-RUAMSINTHAI','RST-RUAMSINTHAI','RST'],
  ['COMPANY','RST-OFFICE','RST-OFFICE','OFC'],['COMPANY','RST-ROBOTICS','RST-ROBOTICS','ROB'],
  ['COMPANY','RST- OFFICE','RST-OFFICE','OFC'],['COMPANY','RST- ROBOTICS','RST-ROBOTICS','ROB'],
  ['COMPANY','RST-RUAM SIN THAI','RST-RUAMSINTHAI','RST'],
  ['DEPT','ผู้จัดการโรงงาน','ผู้จัดการโรงงาน','PLM'],['DEPT','Engineer','Engineer','ENG'],['DEPT','QC','QC','QC'],
  ['DEPT','ซ่อมบำรุง','ซ่อมบำรุง','MTN'],['DEPT','คลังสินค้า','คลังสินค้า','WH'],['DEPT','ผลิต','ผลิต','PRD'],
  ['DEPT','ฝ่ายอะไหล่และบริการภายนอก','ฝ่ายอะไหล่และบริการภายนอก','SPS'],['DEPT','คลังสินค้า_อะไหล่','คลังสินค้า_อะไหล่','SPW'],
  ['DEPT','ฝ่ายบริการภายใน','ฝ่ายบริการภายใน','ISV'],['DEPT','ฝ่ายจัดส่ง','ฝ่ายจัดส่ง','DLV'],['DEPT','ฝ่ายขาย','ฝ่ายขาย','SAL'],
  ['DEPT','HR','HR','HR'],['DEPT','IT','IT','IT'],['DEPT','ติดตามหนี้','ติดตามหนี้','COL'],['DEPT','การเงิน','การเงิน','FIN'],
  ['DEPT','บัญชี','บัญชี','ACC'],['DEPT','จัดซื้อ','จัดซื้อ','PUR'],['DEPT','จัดซื้อ_สโตร์','จัดซื้อ_สโตร์','PST'],['DEPT','สโตร์','สโตร์','STR'],
  ['DEPT','Project engineer-sales','Project engineer-sales','PES'],['DEPT','Development and Execution','Development and Execution','DEX'],
  ['DEPT','Joint KPI: Project and Dev&Ex','Joint KPI: Project and Dev&Ex','JNT'],
  ['DEPT','Sale manager & Project Engineer','Sale manager & Project Engineer','SMP'],['DEPT','QA/QE','QA/QE','QAE'],
  ['DEPT','จัดซื้อสโตร์','จัดซื้อ_สโตร์','PST'],['DEPT','คลิงสินค้าเอเชีย','คลังสินค้า','WH'],['DEPT','คลังสินค้าเอเชีย','คลังสินค้า','WH'],
  ['DEPT','Joint KPI Project and Dev Ex','Joint KPI: Project and Dev&Ex','JNT'],['DEPT','อะไหล่','ฝ่ายอะไหล่และบริการภายนอก','SPS'],
  ['DEPT','บริการภายใน','ฝ่ายบริการภายใน','ISV'],['DEPT','ฝ่ายซ่อมบำรุง','ซ่อมบำรุง','MTN']
];

/** เมนูในชีต: RST-KPI */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('RST-KPI')
    .addItem('1) สร้างโครงสร้างฐานข้อมูล (setup)', 'setup')
    .addItem('คำนวณผลใหม่ทั้งหมด (recalcAll)', 'recalcAll')
    .addItem('ใช้ทิศทางจาก KPI_Master (applyMasterDirection)', 'applyMasterDirection')
    .addSeparator()
    .addItem('สร้าง / รีเซ็ตรหัส Admin', 'createAdminFromMenu')
    .addToUi();
}

/**
 * สร้างฐานข้อมูลในสเปรดชีตนี้ (รันซ้ำได้ ไม่ลบข้อมูลเดิม)
 *  - สร้างแท็บ KPI_Data, KPI_Master, Lookup, Log พร้อมหัวคอลัมน์ + ตรึงแถว + ความกว้างคอลัมน์
 *  - ใส่ค่า Lookup เริ่มต้นถ้ายังว่าง
 *  - ลบแท็บเปล่าที่ติดมากับไฟล์ใหม่ (Sheet1 / ชีต1) ถ้าไม่มีข้อมูล
 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const specs = [
    [SH.DATA, DATA_HEADERS, { ID: 190, KPI_Code: 110, Company: 130, Dept: 170, Topic: 420, Method: 260, Link: 160, Result: 130, Status: 120, Note: 180, UpdatedAt: 150 }],
    [SH.MASTER, MASTER_HEADERS, { KPI_Code: 110, Company: 130, Dept: 170, Topic: 460, Method: 300 }],
    [SH.LOOKUP, LOOKUP_HEADERS, { Raw: 260, Canonical: 260 }],
    [SH.LOG, LOG_HEADERS, { Time: 150, User: 180, Detail: 420 }],
    [SH.USERS, USER_HEADERS, { Username: 140, DisplayName: 180, Company: 140, Depts: 220, PassHash: 120, Note: 220 }],
  ];
  specs.forEach(([name, headers, widths]) => {
    const sh = ensureSheet_(name, headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1f4e78').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    headers.forEach((h, i) => { if (widths[h]) sh.setColumnWidth(i + 1, widths[h]); });
  });
  const d = ss.getSheetByName(SH.DATA);
  d.getRange('N:N').setNumberFormat('0.0%');                          // Achieved เป็น %
  d.getRange('A:A').setNumberFormat('@'); ss.getSheetByName(SH.MASTER).getRange('A:A').setNumberFormat('@');
  const lk = ss.getSheetByName(SH.LOOKUP);
  if (lk.getLastRow() < 2) lk.getRange(2, 1, LOOKUP_SEED.length, 4).setValues(LOOKUP_SEED);
  ss.getSheets().forEach(sh => {
    if (/^(Sheet1|ชีต1|แผ่นงาน1)$/.test(sh.getName()) && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  ss.setActiveSheet(d);
  try { ss.toast('สร้างโครงสร้างเรียบร้อย — ขั้นต่อไป: Deploy เป็น Web App แล้วนำเข้า Excel ผ่านหน้าเว็บ', 'RST-KPI', 8); } catch (e) {}
}

/**
 * คำนวณสถานะใหม่ทั้งชีต ตามค่า Direction / Target / Actual ในแต่ละแถวของ KPI_Data
 * ใช้หลังแก้ข้อมูลในชีตโดยตรง
 */
function recalcAll() { recalc_(null, null); }

/**
 * นำ Direction จาก KPI_Master ไปใช้กับแถวข้อมูล แล้วคำนวณใหม่
 * ใช้หลังตรวจหัวข้อที่ NeedReview = Y แล้วแก้ Direction ใน KPI_Master
 * แก้ค่า YEAR ด้านล่างเพื่อจำกัดเฉพาะปี (เช่น 2569) หรือ null = ทุกปี
 */
function applyMasterDirection() {
  const YEAR = null;
  const masterSh = SpreadsheetApp.getActive().getSheetByName(SH.MASTER);
  const m = colIndex_(masterSh, MASTER_HEADERS);
  const dir = new Map(sheetBody_(masterSh, MASTER_HEADERS.length).map(r => [String(r[m.KPI_Code]), r[m.Direction]]));
  recalc_(dir, YEAR);
}

function recalc_(masterDir, onlyYear) {
  const dataSh = SpreadsheetApp.getActive().getSheetByName(SH.DATA);
  const d = colIndex_(dataSh, DATA_HEADERS);
  const rows = sheetBody_(dataSh, DATA_HEADERS.length);
  let changed = 0;
  rows.forEach(r => {
    let direction = String(r[d.Direction] || 'HIGHER').toUpperCase();
    if (masterDir && (!onlyYear || Number(r[d.Year]) === Number(onlyYear)) && masterDir.has(String(r[d.KPI_Code])))
      direction = String(masterDir.get(String(r[d.KPI_Code])) || 'HIGHER').toUpperCase();
    direction = direction === 'LOWER' ? 'LOWER' : 'HIGHER';
    const ev = evaluateKpi(r[d.Target], r[d.Actual], direction);
    const next = [direction, ev.achieved === null ? '' : ev.achieved, ev.result, ev.status];
    const prev = [r[d.Direction], r[d.Achieved], r[d.Result], r[d.Status]];
    if (JSON.stringify(next) !== JSON.stringify(prev)) changed++;
    r[d.Direction] = next[0]; r[d.Achieved] = next[1]; r[d.Result] = next[2]; r[d.Status] = next[3];
  });
  writeBody_(dataSh, rows, DATA_HEADERS.length);
  log_(Session.getActiveUser().getEmail(), masterDir ? 'applyMasterDirection' : 'recalcAll', rows.length, 0, changed, 0, onlyYear ? 'year=' + onlyYear : '');
  SpreadsheetApp.getActive().toast('คำนวณใหม่ ' + rows.length + ' แถว เปลี่ยน ' + changed + ' แถว');
}

/** ทดสอบตรรกะสถานะ (ดูผลที่ View > Logs) */
function testEvaluate() {
  const cases = [
    [4, 2, 'HIGHER', R.FAIL], [4, 4, 'HIGHER', R.PASS], [5, 4, 'LOWER', R.PASS], [5, 6, 'LOWER', R.FAIL],
    [0.9, '', 'HIGHER', R.PENDING], [1, 'N.A.', 'HIGHER', R.NA], [0, 0, 'LOWER', R.PASS], [0.1, 0.1, 'HIGHER', R.PASS]
  ];
  cases.forEach(c => {
    const r = evaluateKpi(c[0], c[1], c[2]);
    Logger.log((r.result === c[3] ? 'OK   ' : 'FAIL ') + JSON.stringify(c) + ' → ' + JSON.stringify(r));
  });
}
/**
 * สร้าง Admin คนแรก หรือรีเซ็ตรหัส Admin ที่ลืม — รันจากเมนู RST-KPI ในชีต (ต้องเป็นผู้มีสิทธิ์แก้ไขสเปรดชีต)
 */
function createAdminFromMenu() {
  const ui = SpreadsheetApp.getUi();
  const a = ui.prompt('สร้าง / รีเซ็ต Admin', 'ชื่อผู้ใช้ (a-z 0-9 . _ -)', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const b = ui.prompt('สร้าง / รีเซ็ต Admin', 'รหัสผ่าน (อย่างน้อย 8 ตัว)', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const un = cleanText_(a.getResponseText()).toLowerCase();
  const { rows, u } = readUsers_();
  const exists = rows.some(r => String(r[u.Username]).toLowerCase() === un);
  const sess = { username: Session.getActiveUser().getEmail() || 'sheet-owner', name: 'sheet-owner', role: 'ADMIN' };
  saveUser_({ username: un, name: un, role: 'ADMIN', active: 'Y', password: b.getResponseText(), isNew: !exists }, sess);
  usersSheet_().getRange('G:H').setFontColor('#999999');
  ui.alert((exists ? 'รีเซ็ตรหัส Admin "' : 'สร้าง Admin "') + un + '" เรียบร้อย — เข้าสู่ระบบที่หน้าเว็บได้เลย');
}

/**
 * ★ สร้าง Admin คนแรก (รันจากหน้า Apps Script ได้เลย ไม่ต้องใช้เมนูในชีต)
 *   1) แก้ USERNAME / PASSWORD ด้านล่าง → บันทึก (Ctrl+S)
 *   2) เลือกฟังก์ชัน createFirstAdmin ที่แถบด้านบน → กด "เรียกใช้"
 *   3) ดูผลที่ "บันทึกการดำเนินการ" → แล้ว "ลบรหัสผ่านออก" กลับเป็น '' แล้วบันทึกอีกครั้ง
 *   ใช้รีเซ็ตรหัส Admin ที่ลืมได้ด้วย (ใส่ USERNAME เดิม)
 */
function createFirstAdmin() {
  const USERNAME = 'itadmin';
  const PASSWORD = '';                 // ← ใส่รหัสผ่าน (อย่างน้อย 8 ตัว) แล้วลบออกหลังรันเสร็จ
  if (!PASSWORD) throw new Error('กรุณาใส่ PASSWORD ในฟังก์ชัน createFirstAdmin ก่อนรัน');
  const un = cleanText_(USERNAME).toLowerCase();
  const { rows, u } = readUsers_();
  const exists = rows.some(r => String(r[u.Username]).toLowerCase() === un);
  const sess = { username: Session.getActiveUser().getEmail() || 'script-owner', name: 'script-owner', role: 'ADMIN' };
  saveUser_({ username: un, name: un, role: 'ADMIN', active: 'Y', password: PASSWORD, isNew: !exists }, sess);
  CacheService.getScriptCache().remove('fail_' + un);
  Logger.log((exists ? 'รีเซ็ตรหัส Admin "' : 'สร้าง Admin "') + un + '" เรียบร้อย — เข้าสู่ระบบที่หน้าเว็บได้เลย (อย่าลืมลบ PASSWORD ออกจากโค้ด)');
}