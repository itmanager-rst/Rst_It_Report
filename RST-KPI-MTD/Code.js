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
 *
 * หมายเหตุ CORS: ฝั่งหน้าเว็บต้องส่ง POST แบบ Content-Type: text/plain เท่านั้น
 * (ถ้าส่ง application/json เบราว์เซอร์จะยิง preflight ซึ่ง GAS ไม่รองรับ)
 */

/**
 * Token สำหรับเรียก API — ต้องตรงกับ API_TOKEN ใน index.html (รูปแบบเดียวกับแอป IT Subscription)
 * เปลี่ยนค่าได้ทั้งสองฝั่งพร้อมกัน แล้ว Deploy เวอร์ชันใหม่ / ปล่อยว่าง = ไม่ตรวจ
 */
const API_TOKEN = 'RSTKPI-i9I8R3TMgLoWHmIZHEZswrUoSciPzUdaJPpK';

const SH = { DATA: 'KPI_Data', MASTER: 'KPI_Master', LOOKUP: 'Lookup', LOG: 'Log' };

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

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ ok: false, error: 'ระบบกำลังบันทึกข้อมูลของผู้ใช้อื่น กรุณาลองใหม่อีกครั้ง' });
  try {
    if (body.action === 'upsert') {
      const res = upsertRows_(body.rows || [], String(body.user || 'web').slice(0, 80));
      return json_(Object.assign({ ok: true }, res));
    }
    return json_({ ok: false, error: 'ไม่รู้จัก action: ' + body.action });
  } catch (err) {
    log_(body.user, body.action, (body.rows || []).length, 0, 0, 1, String(err && err.stack || err));
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* =========================== UPSERT =========================== */

function upsertRows_(rows, user) {
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
      if (isNew || !row[dCol.Direction]) row[dCol.Direction] = v.direction || direction;
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
  return out;
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