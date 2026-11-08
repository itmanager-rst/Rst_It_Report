/**
 * ============================================================================
 *  Hiring_Pipeline  —  Google Apps Script Back-end  (v5 · HR KPI 13 ข้อ + ปุ่มสถานะเซิร์ฟเวอร์)
 * ============================================================================
 *  ผูกกับไฟล์ Google Sheets : Hiring_Pipeline_DB  (ชีต "Applications", "SLA_Timeline")
 *  ส่ง KPI ไปที่            : Rst-Kpi-Mtd-db       (ชีต "KPI_Data", "KPI_Master", "Log")
 *
 *  KPI ของ HR ทั้งหมด (OFC-HR-01 … OFC-HR-13) อ่านจาก KPI_Master อัตโนมัติ
 *  → HR แก้ไข Target / Actual / Note / Link ได้เองในหน้าเว็บ แล้วกดส่ง (manual) เหมือน asset-app
 *  → KPI ที่ระบบคำนวณให้ได้ (ปุ่ม "ใช้ค่าอัตโนมัติ"):
 *      OFC-HR-01/02/03  (ปี 68)  % ตำแหน่งที่เริ่มงานทันเวลา ≤ 30/45/60 วัน     (HIGHER เป้า 100%)
 *      OFC-HR-09/10/11  (ปี 69)  จำนวนวันเฉลี่ยที่ใช้สรรหา Operation/Sup-Mgr/Director (LOWER เป้า 30/45/60 วัน)
 *    ระยะเวลา = วันที่เปิดตำแหน่ง (Created At) → วันที่เริ่มงาน (Onboard Date)
 *
 *  มาตรฐานเดียวกับ asset-app:  ID = <KPI_Code>_<ปี พ.ศ.>_<MM>,  SrcNo = "hiring-app",
 *  UpdatedBy = ชื่อผู้กด,  Log = "hiring-app:<user>" / upsert / "hiring-app YYYY-MM (manual|auto)"
 *  แถวที่กรอกเองจะติดแท็ก [hiring-app:manual] ใน Note → ระบบอัตโนมัติจะไม่เขียนทับ
 *
 *  ---------------------------------------------------------------------------
 *  API (Web App URL เดิม ใช้ต่อได้เลย)
 *    GET  ?                                   → [ ...jobs ]   (เหมือนเดิม)
 *    GET  ?action=kpiForm&month=2026-10[&all=1] → KPI HR ของเดือน (ค่าปัจจุบันใน KPI_Data + ค่าอัตโนมัติ)
 *    GET  ?action=kpi&month=2026-10           → JSON สรุป Pipeline + ค่าอัตโนมัติ (ให้แอปอื่นดึงแบบ Real-time)
 *    GET  ?action=ping                        → สถานะเซิร์ฟเวอร์ {version, hiring:{ok..}, kpi:{ok..}} (ปุ่มสถานะบนหน้าเว็บ)
 *    POST {action:"create"|"update"|"delete", ...}
 *    POST {action:"saveKpi", month, user, rows:[{kpiCode,target,actual,note,link}]}  → ส่งแบบแมนนวล
 *    POST {action:"pushKpi", month, user}     → ส่งเฉพาะค่าอัตโนมัติ (ไม่ทับค่าที่กรอกเอง)
 *  ---------------------------------------------------------------------------
 *  ติดตั้ง:
 *    1) วางไฟล์นี้แทน Code.gs เดิมของโปรเจกต์ Apps Script ที่ผูกกับ Hiring_Pipeline_DB
 *    2) Project Settings → Time zone = (GMT+07:00) Bangkok
 *    3) รันฟังก์ชัน  setupKpiSync()  1 ครั้ง (กดอนุญาตสิทธิ์) → จะเพิ่มคอลัมน์ใหม่ + ทดสอบเชื่อม KPI DB + ตั้ง Trigger รายวัน
 *    4) Deploy → Manage deployments → Edit → Version: New version → Deploy
 *       (Execute as: Me  /  Who has access: Anyone)  — URL เดิมไม่เปลี่ยน
 * ============================================================================
 */

const CFG = {
  VERSION: 'v5',                // หน้าเว็บใช้ตรวจว่า Deploy โค้ดล่าสุดแล้วหรือยัง

  // ไฟล์ Hiring_Pipeline_DB — ใช้เมื่อสคริปต์ไม่ได้ผูกกับชีต (standalone)
  // ลำดับ: Script Properties HIRING_SPREADSHEET_ID → ชีตที่ผูกอยู่ → ค่านี้
  HIRING_SPREADSHEET_ID: '1stZZ8-FYbIlULya33f2D1hD9HXDck9ehRXKDH7GYEdk',
  HIRING_SHEET: 'Applications',
  TIMELINE_SHEET: 'SLA_Timeline',

  // ไฟล์ Rst-Kpi-Mtd-db  (เปลี่ยนได้ที่ Script Properties → KPI_SPREADSHEET_ID)
  KPI_SPREADSHEET_ID: '1UF_HlJKmgR81OMqwvgU0l0iQtRyOndRck7wy_KjejTE',
  KPI_DATA_SHEET: 'KPI_Data',
  KPI_MASTER_SHEET: 'KPI_Master',
  KPI_LOG_SHEET: 'Log',

  SRC: 'hiring-app',
  TZ: 'Asia/Bangkok',
  WARNING_DAYS: 7,              // SLA วิกฤต เมื่อเหลือ ≤ 7 วัน (ตรงกับหน้าเว็บ)
  AUTO_PUSH_ON_ONBOARD: true,   // เปลี่ยนสถานะเป็น Onboard แล้วส่ง KPI เดือนนั้นทันที

  KPI_PREFIX: 'OFC-HR-',                // KPI ทุกตัวที่ขึ้นต้นด้วยรหัสนี้ใน KPI_Master จะแสดงในแอป
  MANUAL_TAG: '[hiring-app:manual]',

  // KPI ที่คำนวณอัตโนมัติจากข้อมูลสรรหา
  //   pctOnTime = สัดส่วนตำแหน่งที่เริ่มงานภายใน maxDays วัน
  //   avgDays   = จำนวนวันเฉลี่ย เปิดตำแหน่ง → เริ่มงาน
  AUTO_RULES: {
    'OFC-HR-01': { type: 'pctOnTime', level: 'Operation',          maxDays: 30 },
    'OFC-HR-02': { type: 'pctOnTime', level: 'Supervisor/Manager', maxDays: 45 },
    'OFC-HR-03': { type: 'pctOnTime', level: 'Assis MD/Director',  maxDays: 60 },
    'OFC-HR-09': { type: 'avgDays',   level: 'Operation',          maxDays: 30 },
    'OFC-HR-10': { type: 'avgDays',   level: 'Supervisor/Manager', maxDays: 45 },
    'OFC-HR-11': { type: 'avgDays',   level: 'Assis MD/Director',  maxDays: 60 }
  }
};

const STATUS = {
  SOURCING: 'กำลังจัดหา (Sourcing)',
  INTERVIEW: 'สัมภาษณ์ (Interview)',
  ONBOARD: 'เริ่มงานแล้ว (Onboard)'
};

// key ใน JSON  ↔  หัวคอลัมน์ในชีต  (9 คอลัมน์แรกคือของเดิม, 4 คอลัมน์หลังเพิ่มใหม่อัตโนมัติ)
const COLS = [
  ['id', 'App ID'],
  ['createdBy', 'Created By'],
  ['department', 'Department'],
  ['jobTitle', 'Job Title'],
  ['targetDate', 'SLA Target Date'],
  ['status', 'Current Status'],
  ['candidateName', 'Candidate Name'],
  ['delayReason', 'Delay Reason'],
  ['hrNotes', 'HR Action Note'],
  ['positionLevel', 'Position Level'],
  ['createdAt', 'Created At'],
  ['onboardDate', 'Onboard Date'],
  ['updatedAt', 'Last Updated']
];
const DATE_KEYS = ['targetDate', 'createdAt', 'onboardDate'];
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* =========================================================================
 *  HTTP ENTRY POINTS
 * ========================================================================= */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'list');
  try {
    if (action === 'list') return json_(readJobs_());
    if (action === 'kpi') {
      const ym = normalizeYm_(p.month);
      return json_(Object.assign({ status: 'success', ok: true }, buildKpiSummary_(readJobs_(), ym)));
    }
    if (action === 'kpiForm') {
      const ym = normalizeYm_(p.month);
      return json_(Object.assign({ status: 'success', ok: true }, kpiForm_(ym, p.all === '1' || p.all === 'true')));
    }
    if (action === 'ping') return json_(Object.assign({ status: 'success', ok: true }, health_()));
    return json_({ status: 'error', ok: false, message: 'Unknown action: ' + action });
  } catch (err) {
    return json_({ status: 'error', ok: false, message: String(err && err.message || err) });
  }
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ status: 'error', ok: false, message: 'Invalid JSON body' });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ status: 'error', ok: false, message: 'ระบบไม่ว่าง กรุณาลองใหม่' });

  try {
    let result;
    switch (body.action) {
      case 'create':  result = createJob_(body); break;
      case 'update':  result = updateJob_(body); break;
      case 'delete':  result = deleteJob_(body.id); break;
      case 'pushKpi': result = pushKpi_(normalizeYm_(body.month), cleanUser_(body.user)); break;
      case 'saveKpi': result = saveKpi_(normalizeYm_(body.month), cleanUser_(body.user), body.rows); break;
      default: throw new Error('Unknown action: ' + body.action);
    }
    return json_(Object.assign({ status: 'success', ok: true }, result));
  } catch (err) {
    return json_({ status: 'error', ok: false, message: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================================
 *  HIRING CRUD
 * ========================================================================= */

function getHiringSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('HIRING_SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();      // null เมื่อเป็นสคริปต์ standalone
  return active || SpreadsheetApp.openById(CFG.HIRING_SPREADSHEET_ID);
}

function getHiringSheet_() {
  const sh = getHiringSpreadsheet_().getSheetByName(CFG.HIRING_SHEET);
  if (!sh) throw new Error('ไม่พบชีต "' + CFG.HIRING_SHEET + '" ในไฟล์ Hiring_Pipeline_DB');
  return sh;
}

/** เพิ่มคอลัมน์ที่ยังไม่มี (ต่อท้าย) แล้วคืน map  key → column index (0-based) */
function ensureSchema_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  COLS.forEach(([, header]) => {
    if (headers.indexOf(header) === -1) {
      headers.push(header);
      sh.getRange(1, headers.length).setValue(header).setFontWeight('bold');
    }
  });
  const map = {};
  COLS.forEach(([key, header]) => { map[key] = headers.indexOf(header); });
  map._width = headers.length;
  return map;
}

function readJobs_() {
  const sh = getHiringSheet_();
  const map = ensureSchema_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, map._width).getValues();
  return values
    .filter(r => String(r[map.id]).trim() !== '')
    .map(r => rowToJob_(r, map));
}

function rowToJob_(r, map) {
  const job = {};
  COLS.forEach(([key]) => {
    let v = r[map[key]];
    if (DATE_KEYS.indexOf(key) > -1) v = toYmd_(v);
    else if (v instanceof Date) v = Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    else v = (v === null || v === undefined) ? '' : String(v).trim();
    job[key] = v;
  });
  if (!job.createdAt) job.createdAt = dateFromReqId_(job.id);
  if (!job.positionLevel) job.positionLevel = guessLevel_(job.jobTitle);
  if (job.candidateName === '-') job.candidateName = '';
  return job;
}

function findRowById_(sh, map, id) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2 || !id) return -1;
  const ids = sh.getRange(2, map.id + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === String(id).trim()) return i + 2;
  return -1;
}

function createJob_(b) {
  const sh = getHiringSheet_();
  const map = ensureSchema_(sh);
  const row = new Array(map._width).fill('');
  const id = (b.id && /^REQ-\d+$/.test(b.id)) ? b.id : 'REQ-' + Date.now();
  const data = {
    id: id,
    createdBy: b.createdBy || '',
    department: b.department || '',
    jobTitle: b.jobTitle || '',
    targetDate: b.targetDate || '',
    status: b.status || STATUS.SOURCING,
    candidateName: b.candidateName || '',
    delayReason: b.delayReason || '-',
    hrNotes: b.hrNotes || '',
    positionLevel: normalizeLevel_(b.positionLevel) || guessLevel_(b.jobTitle),
    createdAt: dateFromReqId_(id) || today_(),
    onboardDate: '',
    updatedAt: now_()
  };
  COLS.forEach(([key]) => { row[map[key]] = data[key]; });
  sh.appendRow(row);
  logTimeline_(id, data.status, data.targetDate, '', b.createdBy || 'web');
  return { id: id };
}

function updateJob_(b) {
  const sh = getHiringSheet_();
  const map = ensureSchema_(sh);
  const rowNo = findRowById_(sh, map, b.id);
  if (rowNo < 0) throw new Error('ไม่พบรายการ ID: ' + b.id);

  const range = sh.getRange(rowNo, 1, 1, map._width);
  const row = range.getValues()[0];
  const before = rowToJob_(row, map);

  const editable = ['createdBy', 'department', 'jobTitle', 'targetDate', 'status',
                    'candidateName', 'delayReason', 'hrNotes', 'positionLevel', 'onboardDate'];
  editable.forEach(k => { if (b[k] !== undefined) row[map[k]] = String(b[k]); });
  if (b.positionLevel !== undefined) row[map.positionLevel] = normalizeLevel_(b.positionLevel) || guessLevel_(row[map.jobTitle]);

  const isOnboard = statusKey_(row[map.status]) === 'onboard';
  if (isOnboard && !toYmd_(row[map.onboardDate])) row[map.onboardDate] = today_();   // ประทับวันที่เริ่มงานอัตโนมัติ
  if (!isOnboard) row[map.onboardDate] = '';
  if (!toYmd_(row[map.createdAt])) row[map.createdAt] = dateFromReqId_(b.id) || today_();
  row[map.updatedAt] = now_();
  range.setValues([row]);

  if (String(before.status) !== String(row[map.status])) {
    logTimeline_(b.id, row[map.status], toYmd_(row[map.targetDate]), b.delayReason || '', b.updatedBy || 'HR');
  }

  // Real-time: ปิดตำแหน่งได้ → ส่ง KPI เดือนที่เริ่มงานไป Rst-Kpi-Mtd ทันที
  let kpi = null;
  const onboardYm = toYmd_(row[map.onboardDate]).slice(0, 7);
  if (CFG.AUTO_PUSH_ON_ONBOARD && onboardYm && (before.status !== row[map.status] || before.onboardDate !== toYmd_(row[map.onboardDate]))) {
    try { kpi = pushKpi_(onboardYm, 'auto'); } catch (err) { kpi = { error: String(err.message || err) }; }
  }
  return { id: b.id, kpi: kpi };
}

function deleteJob_(id) {
  const sh = getHiringSheet_();
  const map = ensureSchema_(sh);
  const rowNo = findRowById_(sh, map, id);
  if (rowNo < 0) throw new Error('ไม่พบรายการ ID: ' + id);
  sh.deleteRow(rowNo);
  return { id: id };
}

function logTimeline_(appId, stage, targetDate, delayReason, by) {
  try {
    const ss = getHiringSheet_().getParent();
    const sh = ss.getSheetByName(CFG.TIMELINE_SHEET);
    if (!sh) return;
    sh.appendRow(['LOG-' + Date.now(), appId, stage, targetDate || '', now_(), delayReason || '', by || '']);
  } catch (err) { /* ไม่ให้ log ทำให้การบันทึกหลักล้ม */ }
}

/* =========================================================================
 *  KPI CALCULATION (ค่าอัตโนมัติจากข้อมูลสรรหา)
 * ========================================================================= */

function buildPipeline_(jobs, ym) {
  const todayYmd = today_();
  const pipe = { total: jobs.length, open: 0, sourcing: 0, interview: 0, onboard: 0,
                 slaNormal: 0, slaWarning: 0, slaOverdue: 0, openedThisMonth: 0, onboardThisMonth: 0 };
  jobs.forEach(j => {
    const st = statusKey_(j.status);
    pipe[st]++;
    if (st !== 'onboard') pipe.open++;
    const sla = slaCategory_(j, todayYmd);
    if (sla === 'normal') pipe.slaNormal++;
    if (sla === 'warning') pipe.slaWarning++;
    if (sla === 'overdue') pipe.slaOverdue++;
    if (j.createdAt && j.createdAt.slice(0, 7) === ym) pipe.openedThisMonth++;
    if (st === 'onboard' && j.onboardDate && j.onboardDate.slice(0, 7) === ym) pipe.onboardThisMonth++;
  });
  return pipe;
}

function pipeNote_(pipe) {
  return 'Pipeline: เปิดอยู่ ' + pipe.open + ' · Sourcing ' + pipe.sourcing + ' · Interview ' + pipe.interview +
         ' · Onboard ' + pipe.onboard + ' · เลย SLA ' + pipe.slaOverdue + ' · วิกฤต ' + pipe.slaWarning;
}

/** คำนวณค่าอัตโนมัติของ KPI 1 ตัว (คืน null ถ้า KPI นี้ไม่มีสูตรอัตโนมัติ) */
function autoValue_(code, jobs, ym, pipe) {
  const rule = CFG.AUTO_RULES[code];
  if (!rule) return null;

  const hires = jobs.filter(j =>
    statusKey_(j.status) === 'onboard' &&
    j.onboardDate && j.onboardDate.slice(0, 7) === ym &&
    normalizeLevel_(j.positionLevel) === rule.level);
  const detail = hires.map(j => {
    const days = daysBetween_(j.createdAt, j.onboardDate);
    return { id: j.id, jobTitle: j.jobTitle, candidateName: j.candidateName, createdAt: j.createdAt,
             onboardDate: j.onboardDate, days: days, onTime: days !== null && days <= rule.maxDays };
  });
  const onTime = detail.filter(d => d.onTime).length;
  const avgDays = hires.length ? Math.round(detail.reduce((s, d) => s + (d.days || 0), 0) / hires.length) : null;

  let actual = null, note;
  if (hires.length) actual = rule.type === 'avgDays' ? avgDays : round4_(onTime / hires.length);

  if (!hires.length) {
    note = '[' + CFG.SRC + '] ไม่มีตำแหน่ง ' + rule.level + ' เริ่มงานในเดือนนี้ | ' + pipeNote_(pipe);
  } else {
    const late = detail.filter(d => !d.onTime).slice(0, 3).map(d => d.jobTitle + ' ' + d.days + ' วัน').join(', ');
    note = '[' + CFG.SRC + '] เริ่มงาน ' + hires.length + ' ตำแหน่ง · ทัน ≤' + rule.maxDays + ' วัน ' + onTime +
           ' · เฉลี่ย ' + avgDays + ' วัน' + (late ? ' · ล่าช้า: ' + late : '') + ' | ' + pipeNote_(pipe);
  }
  return { type: rule.type, level: rule.level, maxDays: rule.maxDays, hires: hires.length,
           onTime: onTime, avgDays: avgDays, actual: actual, note: note, detail: detail };
}

/** JSON สรุป (GET ?action=kpi) — ไม่ต้องเปิด KPI DB ใช้ดึงไปแสดงผลแบบ Real-time */
function buildKpiSummary_(jobs, ym) {
  const pipe = buildPipeline_(jobs, ym);
  const todayYmd = today_();
  return {
    month: ym,
    yearBE: Number(ym.slice(0, 4)) + 543,
    generatedAt: now_(),
    pipeline: pipe,
    overdue: jobs.filter(j => slaCategory_(j, todayYmd) === 'overdue')
      .map(j => ({ id: j.id, jobTitle: j.jobTitle, department: j.department, targetDate: j.targetDate,
                   daysLate: daysBetween_(j.targetDate, todayYmd), delayReason: j.delayReason })),
    kpiRows: Object.keys(CFG.AUTO_RULES).map(code => Object.assign({ kpiCode: code }, autoValue_(code, jobs, ym, pipe)))
  };
}

/* =========================================================================
 *  Rst-Kpi-Mtd  —  อ่าน / เขียน KPI_Data (มาตรฐานเดียวกับ asset-app)
 * ========================================================================= */

function getKpiSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('KPI_SPREADSHEET_ID') || CFG.KPI_SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

function readKpiMaster_(ss) {
  const sh = ss.getSheetByName(CFG.KPI_MASTER_SHEET);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  const v = sh.getDataRange().getValues();
  const head = v[0].map(h => String(h).trim());
  for (let i = 1; i < v.length; i++) {
    const o = {};
    head.forEach((h, c) => { o[h] = v[i][c]; });
    if (o.KPI_Code) out[String(o.KPI_Code).trim()] = o;
  }
  return out;
}

/** KPI ของ HR ทั้งหมดใน KPI_Master (OFC-HR-01 … OFC-HR-13) เรียงตามรหัส */
function hrMasterCodes_(master) {
  return Object.keys(master)
    .filter(c => c.indexOf(CFG.KPI_PREFIX) === 0 && String(master[c].Active || 'Y').toUpperCase() !== 'N')
    .sort();
}

function openKpiData_(ss) {
  const sh = ss.getSheetByName(CFG.KPI_DATA_SHEET);
  if (!sh) throw new Error('ไม่พบชีต KPI_Data ใน Rst-Kpi-Mtd-db');
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const H = {};
  headers.forEach((h, i) => { H[h] = i; });
  ['ID', 'KPI_Code', 'Target', 'Actual', 'Status'].forEach(h => {
    if (H[h] === undefined) throw new Error('KPI_Data ไม่มีคอลัมน์ ' + h);
  });
  const lastRow = sh.getLastRow();
  const ids = lastRow > 1 ? sh.getRange(2, H.ID + 1, lastRow - 1, 1).getValues().map(r => String(r[0]).trim()) : [];
  return { sh: sh, H: H, lastCol: lastCol, ids: ids };
}

function kpiRowId_(code, ym) {
  return code + '_' + (Number(ym.slice(0, 4)) + 543) + '_' + ym.slice(5, 7);
}

/** แปลง FirstYM / LastYM ของ KPI_Master เป็นเลข YYYYMM (พ.ศ.) */
function masterYm_(v) {
  if (v === null || v === undefined || v === '') return null;
  let y, m;
  if (v instanceof Date) { y = v.getFullYear(); m = v.getMonth() + 1; }
  else {
    const s = String(v).match(/(\d{4})\D(\d{1,2})/);
    if (!s) return null;
    y = Number(s[1]); m = Number(s[2]);
  }
  if (y < 2400) y += 543;
  return y * 100 + m;
}

function masterCovers_(m, ym) {
  const cur = (Number(ym.slice(0, 4)) + 543) * 100 + Number(ym.slice(5, 7));
  const a = masterYm_(m.FirstYM), b = masterYm_(m.LastYM);
  if (a === null && b === null) return true;
  return (a === null || cur >= a) && (b === null || cur <= b);
}

/**
 * ฟอร์ม KPI ของเดือน (GET ?action=kpiForm&month=YYYY-MM&all=1)
 *  - แสดง KPI ที่มีแถวในเดือนนั้นแล้ว หรืออยู่ในช่วง FirstYM–LastYM
 *  - all=1 → แสดงครบทั้ง 13 ข้อ
 */
function kpiForm_(ym, showAll) {
  const jobs = readJobs_();
  const pipe = buildPipeline_(jobs, ym);
  const ss = getKpiSpreadsheet_();
  const master = readKpiMaster_(ss);
  const kd = openKpiData_(ss);

  const rows = [];
  hrMasterCodes_(master).forEach(code => {
    const m = master[code];
    const id = kpiRowId_(code, ym);
    const idx = kd.ids.indexOf(id);
    const exists = idx > -1;
    const inPeriod = exists || masterCovers_(m, ym);
    if (!showAll && !inPeriod) return;

    const r = exists ? kd.sh.getRange(idx + 2, 1, 1, kd.lastCol).getValues()[0] : null;
    const g = h => (r ? cellText_(get_(r, kd.H, h)) : '');
    const note = g('Note');
    rows.push({
      kpiCode: code,
      topic: String(m.Topic || ''),
      method: String(m.Method || ''),
      direction: String((r && get_(r, kd.H, 'Direction')) || m.Direction || 'HIGHER').toUpperCase(),
      target: exists && g('Target') !== '' ? g('Target') : cellText_(m.DefaultTarget),
      actual: g('Actual'),
      achieved: g('Achieved'),
      result: g('Result'),
      status: g('Status') || 'ยังไม่ได้ประเมิน',
      note: stripTag_(note),
      manual: note.indexOf(CFG.MANUAL_TAG) > -1,
      link: g('Link'),
      srcNo: g('SrcNo'),
      updatedAt: g('UpdatedAt'),
      updatedBy: g('UpdatedBy'),
      exists: exists,
      inPeriod: inPeriod,
      auto: autoValue_(code, jobs, ym, pipe)
    });
  });

  return { month: ym, yearBE: Number(ym.slice(0, 4)) + 543, pipeline: pipe,
           totalHrKpi: hrMasterCodes_(master).length, rows: rows };
}

/**
 * เขียน KPI ลง KPI_Data (ใช้ร่วมกันทั้งแบบแมนนวลและอัตโนมัติ)
 *   mode 'manual' : ค่าจากหน้าเว็บที่ HR แก้ไขเอง  → Note ติดแท็ก [hiring-app:manual]
 *   mode 'auto'   : ค่าคำนวณจากระบบ → ไม่ทับแถวที่คนกรอกเองไว้แล้ว
 */
function upsertKpiRows_(ym, user, inputs, mode) {
  const ss = getKpiSpreadsheet_();
  const master = readKpiMaster_(ss);
  const kd = openKpiData_(ss);
  const H = kd.H;
  const yearBE = Number(ym.slice(0, 4)) + 543;
  const month = Number(ym.slice(5, 7));
  const stamp = now_();
  let inserted = 0, updated = 0;
  const results = [], skipped = [];

  inputs.forEach(inp => {
    const code = String(inp.kpiCode || '').trim();
    const m = master[code];
    if (!m || code.indexOf(CFG.KPI_PREFIX) !== 0) { skipped.push({ kpiCode: code, reason: 'ไม่พบใน KPI_Master' }); return; }

    const id = kpiRowId_(code, ym);
    const idx = kd.ids.indexOf(id);
    let row;
    if (idx > -1) {
      row = kd.sh.getRange(idx + 2, 1, 1, kd.lastCol).getValues()[0];
      if (mode === 'auto') {
        const hasValue = cellText_(get_(row, H, 'Actual')) !== '';
        const humanRow = String(get_(row, H, 'SrcNo')) !== CFG.SRC ||
                         String(get_(row, H, 'Note')).indexOf(CFG.MANUAL_TAG) > -1;
        if (hasValue && humanRow) { skipped.push({ kpiCode: code, reason: 'มีค่าที่กรอกเองแล้ว (ไม่ทับ)' }); return; }
      }
    } else {
      row = new Array(kd.lastCol).fill('');
      set_(row, H, 'ID', id);
      set_(row, H, 'KPI_Code', code);
      set_(row, H, 'Company', m.Company || 'RST-OFFICE');
      set_(row, H, 'Dept', m.Dept || 'HR');
      set_(row, H, 'Year', yearBE);
      set_(row, H, 'Month', month);
      set_(row, H, 'MonthName', MONTH_EN[month - 1]);
      set_(row, H, 'Topic', m.Topic || '');
      set_(row, H, 'Method', m.Method || '');
      set_(row, H, 'Direction', m.Direction || 'HIGHER');
    }

    // Target: ค่าที่ส่งมา → ค่าเดิม → DefaultTarget
    const tIn = parseNum_(inp.target);
    let target = tIn.kind === 'num' ? tIn.value : Number(get_(row, H, 'Target'));
    if (!target && target !== 0) target = Number(m.DefaultTarget) || 1;
    if (!target && Number(m.DefaultTarget)) target = Number(m.DefaultTarget);
    set_(row, H, 'Target', target);

    const direction = String(get_(row, H, 'Direction') || m.Direction || 'HIGHER').toUpperCase();
    const ev = evaluate_(parseNum_(inp.actual), target, direction);
    set_(row, H, 'Actual', ev.actual);
    set_(row, H, 'Achieved', ev.achieved);
    set_(row, H, 'Result', ev.result);
    set_(row, H, 'Status', ev.status);

    const userNote = stripTag_(String(inp.note || ''));
    const note = mode === 'manual' ? (CFG.MANUAL_TAG + (userNote ? ' ' + userNote : '')) : userNote;
    set_(row, H, 'Note', note.slice(0, 480));
    if (inp.link !== undefined) set_(row, H, 'Link', String(inp.link).slice(0, 300));
    set_(row, H, 'SrcNo', CFG.SRC);
    set_(row, H, 'UpdatedAt', stamp);
    set_(row, H, 'UpdatedBy', user);

    if (idx > -1) { kd.sh.getRange(idx + 2, 1, 1, kd.lastCol).setValues([row]); updated++; }
    else { kd.sh.appendRow(row); kd.ids.push(id); inserted++; }

    results.push({ id: id, kpiCode: code, target: target, actual: ev.actual, achieved: ev.achieved,
                   result: ev.result, status: ev.status, updatedAt: stamp, updatedBy: user });
  });

  const logSh = ss.getSheetByName(CFG.KPI_LOG_SHEET);
  if (logSh && (inserted || updated)) {
    logSh.appendRow([new Date(), CFG.SRC + ':' + user, 'upsert', inserted + updated, inserted, updated, 0,
                     CFG.SRC + ' ' + ym + (mode === 'manual' ? ' (manual)' : ' (auto)')]);
  }
  return { month: ym, yearBE: yearBE, mode: mode, inserted: inserted, updated: updated, rows: results, skipped: skipped };
}

/** POST {action:"saveKpi"} — HR แก้ไขค่าเองแล้วกดส่ง (เหมือน asset-app) */
function saveKpi_(ym, user, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('ไม่มีรายการ KPI ที่จะส่ง');
  if (rows.length > 30) throw new Error('ส่งได้ครั้งละไม่เกิน 30 รายการ');
  return upsertKpiRows_(ym, user, rows, 'manual');
}

/** POST {action:"pushKpi"} / Trigger — ส่งเฉพาะ KPI ที่มีสูตรอัตโนมัติและอยู่ในรอบของเดือนนั้น */
function pushKpi_(ym, user) {
  const jobs = readJobs_();
  const pipe = buildPipeline_(jobs, ym);
  const ss = getKpiSpreadsheet_();
  const master = readKpiMaster_(ss);
  const kd = openKpiData_(ss);

  const inputs = Object.keys(CFG.AUTO_RULES)
    .filter(code => master[code] && (kd.ids.indexOf(kpiRowId_(code, ym)) > -1 || masterCovers_(master[code], ym)))
    .map(code => {
      const a = autoValue_(code, jobs, ym, pipe);
      return { kpiCode: code, actual: a.actual === null ? 'N.A.' : a.actual, note: a.note };
    });
  const res = upsertKpiRows_(ym, user, inputs, 'auto');
  res.pipeline = pipe;
  return res;
}

/** คำนวณ Achieved / Result / Status ให้ตรงรูปแบบที่ Rst-Kpi-Mtd ใช้ */
function evaluate_(p, target, direction) {
  if (!p || p.kind === 'empty') {
    return { actual: '', achieved: '', result: 'ยังไม่ได้ประเมิน', status: 'ยังไม่ได้ประเมิน' };
  }
  if (p.kind === 'na') {
    return { actual: 'N.A.', achieved: '', result: 'ไม่มีข้อมูล (N.A.)', status: 'ยังไม่ได้ประเมิน' };
  }
  const actual = p.value;
  let ach;
  if (direction === 'LOWER') ach = actual === 0 ? 1 : target / actual;
  else ach = target ? actual / target : 0;
  ach = round4_(ach);
  const pass = ach >= 1;
  return { actual: actual, achieved: ach, result: pass ? 'ผ่านเป้า' : 'ต่ำกว่าเป้า', status: pass ? 'ผ่านเป้า' : 'ไม่ผ่านเป้า' };
}

/** "95%" → 0.95 · "N.A." → na · "" → empty · "1,250" → 1250 */
function parseNum_(v) {
  if (v === null || v === undefined) return { kind: 'empty' };
  if (typeof v === 'number') return isFinite(v) ? { kind: 'num', value: v } : { kind: 'empty' };
  const s = String(v).trim();
  if (s === '') return { kind: 'empty' };
  if (/^(n\.?\/?a\.?|-|\.)$/i.test(s)) return { kind: 'na' };
  const pct = /%$/.test(s);
  const n = Number(s.replace(/[%,\s]/g, ''));
  if (!isFinite(n)) return { kind: 'na' };
  return { kind: 'num', value: pct ? round4_(n / 100) : n };
}

function cellText_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
  return typeof v === 'number' ? v : String(v).trim();
}

function stripTag_(note) {
  return String(note || '').split(CFG.MANUAL_TAG).join('').trim();
}

/**
 * ตรวจสถานะเซิร์ฟเวอร์ (GET ?action=ping) — ไม่ throw แยกผลเป็นส่วน ๆ ให้หน้าเว็บแสดงว่าพังตรงไหน
 *   hiring : อ่านชีต Applications ของ Hiring_Pipeline_DB ได้ไหม
 *   kpi    : เปิด Rst-Kpi-Mtd-db + อ่าน KPI_Master / KPI_Data ได้ไหม
 */
function health_() {
  const t0 = Date.now();
  const out = { version: CFG.VERSION, serverTime: now_(), timezone: Session.getScriptTimeZone(),
                hiring: { ok: false }, kpi: { ok: false } };
  try {
    const sh = getHiringSheet_();
    const map = ensureSchema_(sh);
    out.hiring = { ok: true, file: sh.getParent().getName(), sheet: sh.getName(),
                   rows: Math.max(sh.getLastRow() - 1, 0),
                   columnsOk: COLS.every(([k]) => map[k] > -1) };
  } catch (err) {
    out.hiring = { ok: false, error: String(err && err.message || err) };
  }
  try {
    const ss = getKpiSpreadsheet_();
    const master = readKpiMaster_(ss);
    openKpiData_(ss);
    out.kpi = { ok: true, file: ss.getName(), hrKpiCount: hrMasterCodes_(master).length };
  } catch (err) {
    out.kpi = { ok: false, error: String(err && err.message || err) };
  }
  out.ms = Date.now() - t0;
  return out;
}

function pingKpiDb_() {
  const ss = getKpiSpreadsheet_();
  const master = readKpiMaster_(ss);
  const codes = hrMasterCodes_(master);
  return {
    kpiDb: ss.getName(),
    hrKpiCount: codes.length,
    hrKpi: codes.map(c => ({ code: c, topic: String(master[c].Topic), auto: !!CFG.AUTO_RULES[c] }))
  };
}

/* =========================================================================
 *  SETUP + AUTO SYNC (Trigger)
 * ========================================================================= */

/** รันครั้งเดียวจาก Editor: เพิ่มคอลัมน์ใหม่ · ทดสอบสิทธิ์ KPI DB · ตั้ง Trigger รายวัน */
function setupKpiSync() {
  const sh = getHiringSheet_();
  const map = ensureSchema_(sh);

  // เติม Created At / Position Level ให้แถวเก่า
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const rng = sh.getRange(2, 1, lastRow - 1, map._width);
    const v = rng.getValues();
    v.forEach(r => {
      if (!toYmd_(r[map.createdAt])) r[map.createdAt] = dateFromReqId_(String(r[map.id]));
      if (!String(r[map.positionLevel]).trim()) r[map.positionLevel] = guessLevel_(r[map.jobTitle]);
      // แถวที่ Onboard แล้วแต่ยังไม่มีวันที่เริ่มงาน → ลองอ่านจาก HR Note เช่น "นัดเริ่มงานวันที่ 22/7/69"
      if (statusKey_(r[map.status]) === 'onboard' && !toYmd_(r[map.onboardDate])) {
        const m = String(r[map.hrNotes]).match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
        if (m) r[map.onboardDate] = toYmd_(m[0]);
      }
    });
    rng.setValues(v);
  }

  Logger.log(JSON.stringify(pingKpiDb_(), null, 2));

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'autoSyncKpi')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('autoSyncKpi').timeBased().everyDays(1).atHour(18).inTimezone(CFG.TZ).create();
  Logger.log('✅ ตั้ง Trigger autoSyncKpi ทุกวัน 18:00 เรียบร้อย');
}

/** Trigger รายวัน: ส่ง KPI เดือนปัจจุบัน + เดือนก่อนหน้า (กันกรณีอัปเดตย้อนหลัง) */
function autoSyncKpi() {
  const now = new Date();
  const cur = Utilities.formatDate(now, CFG.TZ, 'yyyy-MM');
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const prev = Utilities.formatDate(prevDate, CFG.TZ, 'yyyy-MM');
  [prev, cur].forEach(ym => Logger.log(JSON.stringify(pushKpi_(ym, 'auto'))));
}

/** ทดสอบจาก Editor โดยไม่เขียนข้อมูล */
function testPreviewKpi() {
  const ym = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM');
  Logger.log(JSON.stringify(buildKpiSummary_(readJobs_(), ym), null, 2));
}

/* =========================================================================
 *  HELPERS
 * ========================================================================= */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function today_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }
function now_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss'); }
function round4_(n) { return Math.round(n * 10000) / 10000; }
function set_(row, H, h, v) { if (H[h] !== undefined) row[H[h]] = v; }
function get_(row, H, h) { return H[h] !== undefined ? row[H[h]] : ''; }

function cleanUser_(u) {
  const s = String(u || 'web').replace(/[^\w฀-๿ .@-]/g, '').trim().slice(0, 40);
  return s || 'web';
}

function normalizeYm_(m) {
  const s = String(m || '').trim();
  if (/^\d{4}-\d{2}$/.test(s)) {
    let y = Number(s.slice(0, 4));
    if (y > 2400) y -= 543;                      // รับปี พ.ศ. ได้ด้วย
    const mo = Number(s.slice(5, 7));
    if (mo >= 1 && mo <= 12) return y + '-' + ('0' + mo).slice(-2);
  }
  return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM');
}

/** แปลงค่าวันที่ทุกรูปแบบ → 'yyyy-MM-dd' (ว่างถ้าแปลงไม่ได้) */
function toYmd_(v) {
  if (v === null || v === undefined || v === '' || v === '-') return '';
  if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    let y = Number(m[1]); if (y > 2400) y -= 543;
    return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);         // d/m/yyyy  (รองรับ พ.ศ. และปี 2 หลัก เช่น 22/7/69)
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2500;
    if (y > 2400) y -= 543;
    return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  return '';
}

function dateFromReqId_(id) {
  const m = String(id || '').match(/^REQ-(\d{12,13})$/);
  return m ? Utilities.formatDate(new Date(Number(m[1])), CFG.TZ, 'yyyy-MM-dd') : '';
}

function daysBetween_(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return null;
  const a = fromYmd.split('-').map(Number), b = toYmd.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

function statusKey_(status) {
  const s = String(status || '').toLowerCase();
  if (s.indexOf('onboard') > -1 || s.indexOf('เริ่มงาน') > -1) return 'onboard';
  if (s.indexOf('interview') > -1 || s.indexOf('สัมภาษณ์') > -1) return 'interview';
  return 'sourcing';
}

function slaCategory_(job, todayYmd) {
  if (statusKey_(job.status) === 'onboard') return 'completed';
  if (!job.targetDate) return 'normal';
  const diff = daysBetween_(todayYmd, job.targetDate);
  if (diff < 0) return 'overdue';
  if (diff <= CFG.WARNING_DAYS) return 'warning';
  return 'normal';
}

function normalizeLevel_(v) {
  const s = String(v || '').toLowerCase();
  if (!s) return '';
  if (/director|assis|md|ผู้อำนวยการ|กรรมการ/.test(s)) return 'Assis MD/Director';
  if (/supervisor|manager|ผู้จัดการ|หัวหน้า/.test(s)) return 'Supervisor/Manager';
  return 'Operation';
}

/** เดาระดับตำแหน่งจากชื่อ (ใช้เมื่อยังไม่ได้ระบุ) */
function guessLevel_(title) {
  const s = String(title || '').toLowerCase();
  if (/ผู้ช่วยกรรมการ|ผู้อำนวยการ|director|assis(tant)?\s*md/.test(s)) return 'Assis MD/Director';
  if (/ผู้จัดการ|หัวหน้า|manager|supervisor/.test(s)) return 'Supervisor/Manager';
  return 'Operation';
}