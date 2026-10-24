/**
 * CODE_VERSION: r07-2026-10-24-printform-v3
 * =====================================================================
 *  ระบบติดตามสถานะงานซ่อม / PM  (Service Repair & PM Tracker)
 *  Backend : Google Apps Script  |  Database : Google Sheets
 * =====================================================================
 *  ไฟล์ในโปรเจกต์ Apps Script:
 *    - Code.gs     (ไฟล์นี้ : Backend / API / ตั้งค่าฐานข้อมูล)
 *    - Index.html  (หน้าเว็บ HTML + CSS + JS รวมในไฟล์เดียว)
 * =====================================================================
 */

// ---------------------------------------------------------------------
// 1) CONFIG
// ---------------------------------------------------------------------
const CONFIG = {
  // ID ของ Google Sheet ฐานข้อมูล (ว่างไว้ = ใช้ Sheet ที่ผูกกับสคริปต์)
  SPREADSHEET_ID: '1YNPvdS2Q0HW5uzyhr1MBc2EYYT5cQXwnGxraB3tPPXE', // Tracker_Repair_Jobs_DB
  TIMEZONE: 'Asia/Bangkok',
  APP_TITLE: 'ติดตามสถานะงานซ่อม / PM',

  SHEETS: { JOBS: 'Repair_Jobs', TECHS: 'Technicians', REASONS: 'Delay_Reasons' },

  STATUS: {
    IN_PROGRESS: 'กำลังซ่อม',
    WAITING_PARTS: 'รออะไหล่',
    WAITING_PAINT: 'รอพ่นสี',
    WAITING_CONTINUE: 'รอซ่อมต่อ',
    DONE: 'ซ่อมเสร็จแล้ว',
    CANCELLED: 'ยกเลิก',
  },

  PARTS: { COMPLETE: 'ส่งครบแล้ว', PENDING: 'ค้างส่งอะไหล่', PARTIAL: 'ส่งบางส่วน' },

  // สถานที่ (เดิมคือ "แผนก") — ใช้ใน dropdown หน้าเว็บ และหัวใบงานตอนพิมพ์
  DEPARTMENTS: [
    'สำนักงานใหญ่', 'สาขาศรีเมืองใหม่', 'สาขากุฉินารายณ์', 'สาขาตระการ',
    'สาขาเดชอุดม', 'สาขาขุขันธ์', 'สาขาเบญจลักษณ์', 'สาขาอำนาจเจริญ',
  ],

  // ประเภทงาน (ตัวเลือกใน dropdown หน้าเว็บ)
  JOB_TYPES: ['ติดตั้งใบมีด', 'ติดถังอุ้มรถเกี่ยว', 'พ่นสี', 'ปรับสภาพมือสอง', 'งานซ่อมลูกค้า', 'อื่นๆ'],

  // SLA (วัน) เริ่มต้นตามประเภทงาน — ใช้เมื่อช่อง SLA_Target_Days ว่าง
  //  (มีประเภทเก่าไว้ด้วย เพื่อให้งานเดิมคำนวณกำหนดเสร็จได้เหมือนเดิม)
  SLA_BY_TYPE: {
    'ติดถังอุ้มรถเกี่ยว': 7,
    'ปรับสภาพมือสอง': 30,
    'ซ่อมมือสองสาขา': 30,
    'ติดตั้งใบมีด': 7,
    'ติดตั้งถังอุ้ม': 7,
    'ติดอุ้มรถเกี่ยว': 7,
    'พ่นสี': 7,
    'งานซ่อมลูกค้า': 7,
    'อื่นๆ': 14,
  },
  DEFAULT_SLA_DAYS: 14,

  // ไฟล์ข้อมูลนำเข้า (ข้อมูลจริงจาก Excel) ใน Google Drive — ใช้กับ importRealData()
  IMPORT_FILE_ID: '1QmBu523L1lc-gQSSUN-d7tkJ_shnaf1C',

  // รหัส PIN สำหรับ เพิ่ม/แก้ไข/ลบ (ว่าง '' = ไม่ต้องใส่ PIN)
  EDIT_PIN: '',

  // Prefix เลขที่งานอัตโนมัติ ตามแผนก (เช่น IN-0001)
  TICKET_PREFIX: {
    'สำนักงานใหญ่': 'HQ', 'สาขาศรีเมืองใหม่': 'SM', 'สาขากุฉินารายณ์': 'KN', 'สาขาตระการ': 'TK',
    'สาขาเดชอุดม': 'DU', 'สาขาขุขันธ์': 'KK', 'สาขาเบญจลักษณ์': 'BL', 'สาขาอำนาจเจริญ': 'AC',
    'งานภายใน': 'IN', 'พ่นสี': 'PT', 'มือสองสาขา': 'BR', // ค่าเดิม (ข้อมูลเก่า)
  },
  DEFAULT_TICKET_PREFIX: 'JOB',

  // ข้อมูลหัวฟอร์มรายงาน (แบบฟอร์มรวมสินไทย)
  COMPANY: {
    nameTh: 'ห้างหุ้นส่วนจำกัด บ้านและที่ดินรวมสินไทย',
    nameEn: 'RUAMSINTHAI GROUP',
    division: 'ฝ่ายบริการ / ศูนย์ซ่อม',
    address: '',   // เช่น '123 ถ.xxx ต.xxx อ.xxx จ.อุบลราชธานี 34000'
    phone: '',     // เช่น 'โทร. 045-xxx-xxx'
    taxId: '',     // เช่น 'เลขประจำตัวผู้เสียภาษี 0-0000-00000-00-0'
    logoUrl: '',   // URL รูปโลโก้ เช่น https://lh3.googleusercontent.com/d/<FILE_ID>  (ว่าง = ใช้ตัวอักษร RST)
  },
};

const CODE_VERSION = 'r07-2026-10-24-printform-v3';

const HEADERS = {
  Repair_Jobs: [
    'Ticket_ID', 'Machine_ID', 'Customer_Name', 'Status', 'Technician_Name',
    'Start_Date', 'SLA_Target_Days', 'Target_Finish_Date', 'Actual_Finish_Date',
    'Parts_Status', 'Delay_Category', 'Delay_Remark', 'Updated_At',
    'Department', 'Job_Type', 'Product', 'Delivery_No', 'Work_Detail',
  ],
  Technicians: ['Tech_ID', 'Tech_Name', 'Tech_Phone'],
  Delay_Reasons: ['Reason_Name'],
};

const DEFAULT_DELAY_REASONS = [
  'รออะไหล่', 'รอพ่นสี', 'รอชิ้นส่วนจากรถยึด', 'รออนุมัติราคา', 'ช่างคิวแน่น',
  'ตรวจพบความเสียหายเพิ่ม', 'รอเครื่องมือ/อุปกรณ์พิเศษ', 'อื่นๆ',
];

// ---------------------------------------------------------------------
// 2) WEB APP ENTRY
// ---------------------------------------------------------------------
function doGet(e) {
  // API JSON สำหรับหน้าเว็บภายนอก (VS Code / Live Server) : <URL>/exec?action=data
  if (e && e.parameter && e.parameter.action === 'data') {
    return ContentService.createTextOutput(getRepairJobsData())
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(CONFIG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, shrink-to-fit=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * API สำหรับหน้าเว็บภายนอก (GitHub Pages / Live Server)
 * ส่ง POST ด้วย Content-Type: text/plain;charset=utf-8  body = JSON { action, ... }
 *   action: 'data' | 'save' | 'delete'
 */
function doPost(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (body.action) {
      case 'data': out = getRepairJobsData(); break;
      case 'save': out = saveJob(body); break;
      case 'delete': out = deleteJobs(body); break;
      case 'checkStatus': out = JSON.stringify({ ok: true, codeVersion: CODE_VERSION }); break;
      default: out = JSON.stringify({ ok: false, message: 'ไม่รู้จัก action: ' + body.action });
    }
  } catch (err) {
    out = JSON.stringify({ ok: false, message: String(err && err.message ? err.message : err) });
  }
  return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------
// 3) MENU ในตัว Google Sheet
// ---------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🛠️ ระบบงานซ่อม')
    .addItem('⚙️ สร้าง/ตรวจสอบโครงสร้างฐานข้อมูล', 'setupDatabase')
    .addItem('🔄 คำนวณวันกำหนดเสร็จใหม่ทั้งหมด', 'recalculateAllTargets')
    .addSeparator()
    .addItem('📥 นำเข้าข้อมูลจริง (แทนที่ข้อมูลเดิม)', 'importRealData')
    .addToUi();
}

// ---------------------------------------------------------------------
// 4) DATABASE SETUP : สร้าง Tab + Header + Format + Dropdown อัตโนมัติ
//    (ไม่ลบข้อมูลเดิม — เติมเฉพาะส่วนที่ขาด)
// ---------------------------------------------------------------------
function setupDatabase() {
  const ss = getSpreadsheet_();
  const reasonsSh = ensureSheet_(ss, CONFIG.SHEETS.REASONS, HEADERS.Delay_Reasons);
  const techSh = ensureSheet_(ss, CONFIG.SHEETS.TECHS, HEADERS.Technicians);
  const jobsSh = ensureSheet_(ss, CONFIG.SHEETS.JOBS, HEADERS.Repair_Jobs);

  if (reasonsSh.getLastRow() < 2) {
    reasonsSh.getRange(2, 1, DEFAULT_DELAY_REASONS.length, 1)
      .setValues(DEFAULT_DELAY_REASONS.map(function (r) { return [r]; }));
  }
  reasonsSh.setColumnWidth(1, 260);

  techSh.getRange('A:A').setNumberFormat('@');
  techSh.getRange('C:C').setNumberFormat('@'); // เบอร์โทรเป็น Text กันเลข 0 หาย
  techSh.setColumnWidths(1, 3, 160);

  const col = headerIndex_(jobsSh);
  const maxRows = jobsSh.getMaxRows();
  const body = function (name) { return jobsSh.getRange(2, col[name], maxRows - 1, 1); };

  ['Ticket_ID', 'Machine_ID', 'Delivery_No'].forEach(function (h) { body(h).setNumberFormat('@'); });
  ['Start_Date', 'Target_Finish_Date', 'Actual_Finish_Date'].forEach(function (h) { body(h).setNumberFormat('yyyy-mm-dd'); });
  body('SLA_Target_Days').setNumberFormat('0');
  body('Updated_At').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  body('Target_Finish_Date').setBackground('#f1f5f9');
  jobsSh.getRange(1, col['Target_Finish_Date'])
    .setNote('คำนวณอัตโนมัติ = Start_Date + SLA_Target_Days (ไม่ต้องกรอกเอง)');

  const values = function (o) { return Object.keys(o).map(function (k) { return o[k]; }); };
  const listRule = function (list, allowInvalid) {
    return SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(!!allowInvalid).build();
  };
  const rangeRule = function (range) {
    return SpreadsheetApp.newDataValidation().requireValueInRange(range, true).setAllowInvalid(true).build();
  };
  const dateRule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build();

  body('Status').setDataValidation(listRule(values(CONFIG.STATUS)));
  body('Parts_Status').setDataValidation(listRule(values(CONFIG.PARTS), true));
  body('Department').setDataValidation(listRule(CONFIG.DEPARTMENTS, true));
  body('Job_Type').setDataValidation(listRule(CONFIG.JOB_TYPES, true));
  body('Delay_Category').setDataValidation(rangeRule(reasonsSh.getRange('A2:A')));
  body('Technician_Name').setDataValidation(rangeRule(techSh.getRange('B2:B')));
  body('Start_Date').setDataValidation(dateRule);
  body('Actual_Finish_Date').setDataValidation(dateRule);

  const statusRange = body('Status');
  const cf = function (text, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(text).setBackground(bg).setFontColor(fg).setRanges([statusRange]).build();
  };
  jobsSh.setConditionalFormatRules([
    cf(CONFIG.STATUS.IN_PROGRESS, '#dbeafe', '#1e40af'),
    cf(CONFIG.STATUS.WAITING_PARTS, '#fef3c7', '#92400e'),
    cf(CONFIG.STATUS.WAITING_PAINT, '#ede9fe', '#5b21b6'),
    cf(CONFIG.STATUS.WAITING_CONTINUE, '#cffafe', '#155e75'),
    cf(CONFIG.STATUS.DONE, '#dcfce7', '#166534'),
    cf(CONFIG.STATUS.CANCELLED, '#e5e7eb', '#374151'),
  ]);

  jobsSh.setColumnWidths(1, jobsSh.getLastColumn(), 130);
  jobsSh.setColumnWidth(col['Customer_Name'], 200);
  jobsSh.setColumnWidth(col['Delay_Remark'], 320);
  jobsSh.setColumnWidth(col['Product'], 200);
  if (col['Work_Detail']) jobsSh.setColumnWidth(col['Work_Detail'], 320);

  recalculateAllTargets(true);
  toast_('สร้าง/ตรวจสอบโครงสร้างฐานข้อมูลเรียบร้อย ✅');
  return 'OK';
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  const lastCol = Math.max(sh.getLastColumn(), 1);
  const existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const isEmpty = existing.every(function (h) { return h === ''; });

  if (isEmpty) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
    if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }

  sh.getRange(1, 1, 1, sh.getLastColumn())
    .setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 32);
  return sh;
}

// ---------------------------------------------------------------------
// 5) AUTO-UPDATE เมื่อแก้ไขข้อมูลใน Sheet (Simple Trigger)
// ---------------------------------------------------------------------
function onEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  if (sh.getName() !== CONFIG.SHEETS.JOBS) return;

  const firstRow = e.range.getRow();
  const numRows = e.range.getNumRows();
  if (firstRow + numRows - 1 < 2) return;

  const col = headerIndex_(sh);
  const editedFrom = e.range.getColumn();
  const editedTo = editedFrom + e.range.getNumColumns() - 1;
  const touched = function (name) { return col[name] >= editedFrom && col[name] <= editedTo; };
  if (editedFrom === editedTo &&
      (editedFrom === col['Updated_At'] || editedFrom === col['Target_Finish_Date'])) return;

  const startRow = Math.max(firstRow, 2);
  const rowsCount = firstRow + numRows - startRow;
  if (rowsCount > 500) return;

  const values = sh.getRange(startRow, 1, rowsCount, sh.getLastColumn()).getValues();
  const now = new Date();

  values.forEach(function (row, i) {
    const r = startRow + i;
    const get = function (name) { return col[name] ? row[col[name] - 1] : ''; };
    if (get('Ticket_ID') === '' && get('Machine_ID') === '') return;

    // ใส่ SLA ตามประเภทงานให้อัตโนมัติ ถ้ายังว่าง
    let sla = get('SLA_Target_Days');
    if ((touched('Job_Type') || touched('Start_Date')) && sla === '' && col['SLA_Target_Days']) {
      sla = slaForType_(get('Job_Type'));
      sh.getRange(r, col['SLA_Target_Days']).setValue(sla);
    }
    if (touched('Start_Date') || touched('SLA_Target_Days') || touched('Job_Type')) {
      const target = calculateTargetFinishDate(get('Start_Date'), sla);
      sh.getRange(r, col['Target_Finish_Date']).setValue(target ? strToSheetDate_(target) : '');
    }
    if (touched('Status') && String(get('Status')).trim() === CONFIG.STATUS.DONE && !toDateStr_(get('Actual_Finish_Date'))) {
      sh.getRange(r, col['Actual_Finish_Date']).setValue(strToSheetDate_(todayStr_()));
    }
    sh.getRange(r, col['Updated_At']).setValue(now);
  });
}

function recalculateAllTargets(silent) {
  const sh = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.JOBS);
  if (!sh || sh.getLastRow() < 2) return 0;
  const col = headerIndex_(sh);
  const n = sh.getLastRow() - 1;
  const starts = sh.getRange(2, col['Start_Date'], n, 1).getValues();
  const slas = sh.getRange(2, col['SLA_Target_Days'], n, 1).getValues();
  const types = col['Job_Type'] ? sh.getRange(2, col['Job_Type'], n, 1).getValues() : null;
  const out = starts.map(function (s, i) {
    const sla = slas[i][0] === '' ? slaForType_(types ? types[i][0] : '') : slas[i][0];
    const t = calculateTargetFinishDate(s[0], sla);
    return [t ? strToSheetDate_(t) : ''];
  });
  sh.getRange(2, col['Target_Finish_Date'], n, 1).setValues(out);
  if (silent !== true) toast_('คำนวณวันกำหนดเสร็จใหม่แล้ว ' + n + ' แถว');
  return n;
}

// ---------------------------------------------------------------------
// 6) API : ส่งข้อมูลให้ Frontend (JSON)
// ---------------------------------------------------------------------
function getRepairJobsData() {
  try {
    const ss = getSpreadsheet_();
    const today = todayStr_();
    const techs = readSheetAsObjects_(ss, CONFIG.SHEETS.TECHS);
    const techMap = buildTechMap_(techs);
    const reasons = readSheetAsObjects_(ss, CONFIG.SHEETS.REASONS)
      .map(function (r) { return String(r.Reason_Name || '').trim(); }).filter(String);

    const jobs = readSheetAsObjects_(ss, CONFIG.SHEETS.JOBS)
      .filter(function (r) { return String(r.Ticket_ID || '').trim() || String(r.Machine_ID || '').trim(); })
      .map(function (r) { return enrichJob_(r, techMap, today); });

    return JSON.stringify({
      ok: true,
      codeVersion: CODE_VERSION,
      features: { workDetail: true },
      appTitle: CONFIG.APP_TITLE,
      today: today,
      generatedAt: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
      summary: buildSummary_(jobs),
      technicians: techs.map(function (t) {
        return { id: String(t.Tech_ID || ''), name: String(t.Tech_Name || ''), phone: normalizePhone_(t.Tech_Phone) };
      }),
      delayReasons: reasons,
      statuses: Object.keys(CONFIG.STATUS).map(function (k) { return CONFIG.STATUS[k]; }),
      partsStatuses: Object.keys(CONFIG.PARTS).map(function (k) { return CONFIG.PARTS[k]; }),
      departments: CONFIG.DEPARTMENTS,
      jobTypes: CONFIG.JOB_TYPES,
      slaByType: CONFIG.SLA_BY_TYPE,
      defaultSla: CONFIG.DEFAULT_SLA_DAYS,
      requirePin: !!CONFIG.EDIT_PIN,
      company: CONFIG.COMPANY,
      jobs: jobs,
    });
  } catch (err) {
    console.error(err);
    return JSON.stringify({ ok: false, message: String(err && err.message ? err.message : err) });
  }
}

function enrichJob_(r, techMap, today) {
  const S = CONFIG.STATUS;
  const status = String(r.Status || '').trim() || S.IN_PROGRESS;
  const jobType = String(r.Job_Type || '').trim();
  const startDate = toDateStr_(r.Start_Date);
  const slaRaw = String(r.SLA_Target_Days === undefined ? '' : r.SLA_Target_Days).trim();
  const slaDays = slaRaw !== '' && isFinite(Number(slaRaw)) ? Number(slaRaw) : slaForType_(jobType);
  const targetDate = calculateTargetFinishDate(startDate, slaDays) || toDateStr_(r.Target_Finish_Date);
  const actualDate = toDateStr_(r.Actual_Finish_Date);
  const partsStatus = String(r.Parts_Status || '').trim();
  const techName = String(r.Technician_Name || '').trim();
  const tech = techMap[techName.toLowerCase()] || null;

  const job = {
    row: r._row,
    ticketId: String(r.Ticket_ID || '').trim(),
    machineId: String(r.Machine_ID || '').trim(),
    product: String(r.Product || '').trim(),
    customerName: String(r.Customer_Name || '').trim(),
    department: String(r.Department || '').trim() || 'ไม่ระบุแผนก',
    jobType: jobType || 'อื่นๆ',
    status: status,
    technicianName: tech ? tech.name : techName,
    technicianPhone: tech ? tech.phone : '',
    startDate: startDate,
    slaDays: slaDays,
    targetDate: targetDate,
    actualDate: actualDate,
    partsStatus: partsStatus,
    delayCategory: String(r.Delay_Category || '').trim(),
    delayRemark: String(r.Delay_Remark || '').trim(),
    deliveryNo: String(r.Delivery_No || '').trim(),
    workDetail: String(r.Work_Detail || '').trim(),
    updatedAt: toDateTimeStr_(r.Updated_At),
  };

  job.isActive = status !== S.DONE && status !== S.CANCELLED;
  job.isPending = status === S.WAITING_PARTS || status === S.WAITING_PAINT || status === S.WAITING_CONTINUE ||
    (job.isActive && (partsStatus === CONFIG.PARTS.PENDING || partsStatus === CONFIG.PARTS.PARTIAL));
  // อายุงาน (วัน) : งานยังไม่ปิด = นับถึงวันนี้, งานปิดแล้ว = นับถึงวันเสร็จจริง
  job.ageDays = startDate
    ? (job.isActive ? Math.max(0, diffDays_(startDate, today)) : (actualDate ? Math.max(0, diffDays_(startDate, actualDate)) : null))
    : null;

  const sla = checkOverdue(job, today);
  Object.keys(sla).forEach(function (k) { job[k] = sla[k]; });
  return job;
}

// ---------------------------------------------------------------------
// 7) SLA LOGIC
// ---------------------------------------------------------------------
/** Target_Finish_Date = Start_Date + SLA_Target_Days (วันปฏิทิน) -> 'yyyy-MM-dd' */
function calculateTargetFinishDate(startDate, slaDays) {
  const s = toDateStr_(startDate);
  const n = Number(slaDays);
  if (!s || slaDays === '' || slaDays === null || !isFinite(n)) return '';
  return addDays_(s, Math.round(n));
}

/** slaState : overdue | due_today | due_soon | on_track | done_on_time | done_late | done | cancelled | no_target */
function checkOverdue(job, today) {
  today = today || todayStr_();
  const res = { slaState: 'no_target', isOverdue: false, overdueDays: 0, daysRemaining: null, lateDays: 0 };

  if (job.status === CONFIG.STATUS.CANCELLED) { res.slaState = 'cancelled'; return res; }
  if (job.status === CONFIG.STATUS.DONE) {
    if (!job.targetDate || !job.actualDate) { res.slaState = 'done'; return res; } // ไม่มีวันเสร็จจริง = ไม่ประเมิน
    const late = diffDays_(job.targetDate, job.actualDate);
    res.lateDays = Math.max(0, late);
    res.slaState = late > 0 ? 'done_late' : 'done_on_time';
    return res;
  }
  if (!job.targetDate) return res;

  const passed = diffDays_(job.targetDate, today);
  res.daysRemaining = -passed;
  if (passed > 0) { res.isOverdue = true; res.overdueDays = passed; res.slaState = 'overdue'; }
  else if (passed === 0) res.slaState = 'due_today';
  else if (passed >= -2) res.slaState = 'due_soon';
  else res.slaState = 'on_track';
  return res;
}

function slaForType_(type) {
  const t = String(type || '').trim();
  return CONFIG.SLA_BY_TYPE[t] || CONFIG.DEFAULT_SLA_DAYS;
}

function buildSummary_(jobs) {
  const S = CONFIG.STATUS;
  const s = { total: jobs.length, inProgress: 0, pending: 0, overdue: 0, completed: 0, cancelled: 0, dueToday: 0, active: 0 };
  jobs.forEach(function (j) {
    if (j.status === S.IN_PROGRESS) s.inProgress++;
    if (j.isPending) s.pending++;
    if (j.isOverdue) s.overdue++;
    if (j.status === S.DONE) s.completed++;
    if (j.status === S.CANCELLED) s.cancelled++;
    if (j.slaState === 'due_today') s.dueToday++;
    if (j.isActive) s.active++;
  });
  return s;
}

// ---------------------------------------------------------------------
// 8) HELPERS
// ---------------------------------------------------------------------
function getSpreadsheet_() {
  const ss = CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ไม่พบ Google Sheet — ตรวจ SPREADSHEET_ID ใน CONFIG');
  return ss;
}

function readSheetAsObjects_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1).map(function (row, i) {
    const o = { _row: i + 2 };
    headers.forEach(function (h, c) { if (h) o[h] = row[c]; });
    return o;
  });
}

function headerIndex_(sh) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach(function (h, i) { map[String(h).trim()] = i + 1; });
  return map;
}

function buildTechMap_(techs) {
  const map = {};
  techs.forEach(function (t) {
    const info = { id: String(t.Tech_ID || '').trim(), name: String(t.Tech_Name || '').trim(), phone: normalizePhone_(t.Tech_Phone) };
    if (info.name) map[info.name.toLowerCase()] = info;
    if (info.id) map[info.id.toLowerCase()] = info;
  });
  return map;
}

function normalizePhone_(v) {
  if (v === null || v === undefined || v === '') return '';
  let s = String(v).trim();
  if (typeof v === 'number' && /^\d{8,9}$/.test(s)) s = '0' + s;
  return s;
}

function todayStr_() { return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd'); }

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

/**
 * แปลงวันที่ -> 'yyyy-MM-dd'
 * รองรับ Date, 'YYYY-MM-DD', 'DD/MM/YYYY', ปี พ.ศ. และกรณีพิมพ์ปี 2 หลัก (17/11/68 -> 2568 -> 2025)
 */
function toDateStr_(v) {
  if (v === null || v === undefined || v === '') return '';
  let y, m, d, mt;
  if (isDate_(v)) {
    const p = Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd').split('-');
    y = +p[0]; m = +p[1]; d = +p[2];
  } else {
    const s = String(v).trim();
    if ((mt = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; if (y < 100) y += 2500; }
    else return '';
  }
  if (y > 2400) y -= 543;                  // พ.ศ. -> ค.ศ.
  else if (y >= 1950 && y < 2000) y += 57; // ปี 2 หลัก (68/69) ที่ Sheet ตีความเป็น 1968/1969
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return y + '-' + pad2_(m) + '-' + pad2_(d);
}

function toDateTimeStr_(v) {
  if (isDate_(v)) return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
  return v ? String(v) : '';
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function ymdToUTC_(s) { const p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
function diffDays_(a, b) { return Math.round((ymdToUTC_(b) - ymdToUTC_(a)) / 86400000); }
function addDays_(s, n) { return new Date(ymdToUTC_(s) + n * 86400000).toISOString().slice(0, 10); }
function strToSheetDate_(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0); }

// ---------------------------------------------------------------------
// 9) IMPORT : นำเข้าข้อมูลจริงจากไฟล์ใน Drive ลง Repair_Jobs / Technicians
//    ⚠️ แทนที่ข้อมูลเดิมใน Repair_Jobs ทั้งหมด (เบอร์โทรช่างเดิมจะถูกเก็บไว้)
// ---------------------------------------------------------------------
function importRealData() {
  setupDatabase();
  const ss = getSpreadsheet_();
  const text = DriveApp.getFileById(CONFIG.IMPORT_FILE_ID).getBlob().getDataAsString('UTF-8');
  const lines = text.split('\n').filter(function (l) { return l.trim() !== ''; });
  const meta = JSON.parse(lines.shift());

  const ST = ['กำลังซ่อม', 'รออะไหล่', 'รอพ่นสี', 'ซ่อมเสร็จแล้ว', 'ยกเลิก'];
  const DEPT = ['งานภายใน', 'พ่นสี', 'มือสองสาขา'];
  const TYPE = ['ปรับสภาพมือสอง', 'พ่นสี', 'อื่นๆ', 'ติดอุ้มรถเกี่ยว', 'ติดตั้งใบมีด', 'ซ่อมมือสองสาขา', 'ติดตั้งถังอุ้ม'];
  const RS = ['รออะไหล่', 'รอพ่นสี', 'รอชิ้นส่วนจากรถยึด'];
  const pick = function (list, v) { return v === '' || v === undefined ? '' : list[+v]; };
  const date6 = function (v) { return v ? strToSheetDate_('20' + v.slice(0, 2) + '-' + v.slice(2, 4) + '-' + v.slice(4, 6)) : ''; };
  const seq = { 0: 0, 1: 0 };
  const now = new Date();

  const jobsSh = ss.getSheetByName(CONFIG.SHEETS.JOBS);
  const col = headerIndex_(jobsSh);
  const width = jobsSh.getLastColumn();

  const rows = lines.map(function (line) {
    const f = line.split('|');
    while (f.length < 14) f.push('');
    const dep = +f[10];
    if (dep in seq) seq[dep]++;
    let id = f[0];
    if (id === '#') id = (dep === 0 ? 'IN-' : 'PT-') + ('000' + seq[dep]).slice(-4);
    let remark = f[9];
    if (remark.charAt(0) === '~') {
      const p = remark.slice(1).split(',');
      remark = 'สั่งงานโดย ' + meta.names[+p[0]] + (p.length > 1 ? ' · ผู้ส่งงาน ' + meta.names[+p[1]] : '');
    }
    const type = TYPE[+f[11]];
    const sla = slaForType_(type);
    const start = date6(f[5]);
    const target = start ? calculateTargetFinishDate(start, sla) : '';
    const rec = {
      Ticket_ID: id, Machine_ID: f[1], Customer_Name: f[2], Status: ST[+f[3]],
      Technician_Name: pick(meta.names, f[4]), Start_Date: start, SLA_Target_Days: sla,
      Target_Finish_Date: target ? strToSheetDate_(target) : '', Actual_Finish_Date: date6(f[6]),
      Parts_Status: f[7] === 'P' ? CONFIG.PARTS.PENDING : '', Delay_Category: pick(RS, f[8]),
      Delay_Remark: remark, Updated_At: now, Department: DEPT[dep], Job_Type: type,
      Product: meta.prod[+f[12]] || '', Delivery_No: f[13],
    };
    const out = new Array(width).fill('');
    Object.keys(rec).forEach(function (k) { if (col[k]) out[col[k] - 1] = rec[k]; });
    return out;
  });

  if (jobsSh.getLastRow() > 1) jobsSh.getRange(2, 1, jobsSh.getLastRow() - 1, width).clearContent();
  if (rows.length) jobsSh.getRange(2, 1, rows.length, width).setValues(rows);

  // Technicians : ใส่รายชื่อช่าง (เก็บเบอร์โทรเดิมไว้ถ้ามี)
  const techSh = ss.getSheetByName(CONFIG.SHEETS.TECHS);
  const phones = {};
  readSheetAsObjects_(ss, CONFIG.SHEETS.TECHS).forEach(function (t) {
    if (t.Tech_Name) phones[String(t.Tech_Name).trim()] = t.Tech_Phone;
  });
  const techRows = meta.techs.map(function (n, i) { return ['T' + ('0' + (i + 1)).slice(-2), n, phones[n] || '']; });
  if (techSh.getLastRow() > 1) techSh.getRange(2, 1, techSh.getLastRow() - 1, 3).clearContent();
  techSh.getRange(2, 1, techRows.length, 3).setValues(techRows);

  toast_('นำเข้าข้อมูลจริงแล้ว ' + rows.length + ' งาน / ช่าง ' + techRows.length + ' คน ✅');
  return rows.length;
}

function toast_(msg) {
  try { getSpreadsheet_().toast(msg, CONFIG.APP_TITLE, 5); } catch (e) { console.log(msg); }
}
// ---------------------------------------------------------------------
// 10) CRUD : เพิ่ม / แก้ไข / ลบ งานซ่อม (เรียกจากหน้าเว็บ)
//     ทุกฟังก์ชันคืนค่าเป็น JSON string { ok, message, ... }
// ---------------------------------------------------------------------

/**
 * บันทึกงาน (เพิ่มใหม่ หรือ แก้ไข)
 * payload = {
 *   mode: 'add' | 'edit',
 *   row, originalTicketId, originalMachineId,   // ใช้ตอน edit เพื่อหาแถวเดิม
 *   pin,
 *   job: { ticketId, machineId, product, customerName, department, jobType, deliveryNo,
 *          status, technicianName, startDate, slaDays, actualDate, partsStatus,
 *          delayCategory, delayRemark }
 * }
 */
function saveJob(payload) {
  return runWrite_(function () {
    const p = parsePayload_(payload);
    checkPin_(p.pin);
    const j = p.job || {};
    const S = CONFIG.STATUS;
    const sh = jobsSheet_();
    ensureColumn_(sh, 'Work_Detail');
    const col = headerIndex_(sh);
    const width = sh.getLastColumn();
    const isEdit = p.mode === 'edit';

    // ---------- validate ----------
    const status = clean_(j.status) || S.IN_PROGRESS;
    if (objValues_(S).indexOf(status) === -1) throw new Error('สถานะไม่ถูกต้อง: ' + status);
    const startStr = toDateStr_(j.startDate);
    if (!startStr) throw new Error('กรุณาระบุวันที่เริ่มซ่อม');
    if (!clean_(j.machineId) && !clean_(j.product) && !clean_(j.customerName)) {
      throw new Error('กรุณาระบุอย่างน้อย 1 ช่อง: รหัสรถ / สินค้า / ชื่อลูกค้า');
    }
    const jobType = clean_(j.jobType) || 'อื่นๆ';
    const slaRaw = j.slaDays === null || j.slaDays === undefined ? '' : String(j.slaDays).trim();
    let sla = slaRaw === '' ? slaForType_(jobType) : Number(slaRaw);
    if (!isFinite(sla) || sla < 0 || sla > 3650) throw new Error('SLA (วัน) ต้องเป็นตัวเลข 0–3650');
    sla = Math.round(sla);
    const target = calculateTargetFinishDate(startStr, sla);
    let actual = toDateStr_(j.actualDate);
    if (status === S.DONE && !actual) actual = todayStr_();
    if (actual && actual < startStr) throw new Error('วันที่เสร็จจริงต้องไม่ก่อนวันที่เริ่มซ่อม');
    const dept = clean_(j.department);

    // ---------- หาแถว / เลขที่งาน ----------
    const lastRow = sh.getLastRow();
    const ids = lastRow > 1
      ? sh.getRange(2, col['Ticket_ID'], lastRow - 1, 1).getDisplayValues().map(function (r) { return String(r[0]).trim(); })
      : [];
    let rowNum, ticket, rowValues;

    if (isEdit) {
      rowNum = locateRow_(sh, col, p.row, p.originalTicketId, p.originalMachineId);
      if (!rowNum) throw new Error('ไม่พบงานที่ต้องการแก้ไข (อาจถูกลบหรือย้ายแถว) — กรุณารีเฟรชแล้วลองใหม่');
      rowValues = sh.getRange(rowNum, 1, 1, width).getValues()[0];
      ticket = clean_(p.originalTicketId) || clean_(j.ticketId);
      // ถ้างานเดิมไม่มีเลขที่งาน อนุญาตให้ใส่ใหม่ได้ (ต้องไม่ซ้ำ)
      if (!clean_(p.originalTicketId) && ticket && ids.indexOf(ticket) > -1) {
        throw new Error('เลขที่งาน ' + ticket + ' มีอยู่แล้ว');
      }
    } else {
      ticket = clean_(j.ticketId);
      if (ticket) {
        if (ids.indexOf(ticket) > -1) throw new Error('เลขที่งาน ' + ticket + ' มีอยู่แล้ว — กรุณาใช้เลขอื่น หรือเว้นว่างให้ระบบออกเลขให้');
      } else {
        ticket = nextTicketId_(ids, dept);
      }
      rowNum = lastRow + 1;
      if (rowNum > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
      rowValues = new Array(width).fill('');
    }

    const rec = {
      Ticket_ID: ticket,
      Machine_ID: clean_(j.machineId),
      Customer_Name: clean_(j.customerName),
      Status: status,
      Technician_Name: clean_(j.technicianName),
      Start_Date: strToSheetDate_(startStr),
      SLA_Target_Days: sla,
      Target_Finish_Date: target ? strToSheetDate_(target) : '',
      Actual_Finish_Date: actual ? strToSheetDate_(actual) : '',
      Parts_Status: clean_(j.partsStatus),
      Delay_Category: clean_(j.delayCategory),
      Delay_Remark: clean_(j.delayRemark),
      Updated_At: new Date(),
      Department: dept,
      Job_Type: jobType,
      Product: clean_(j.product),
      Delivery_No: clean_(j.deliveryNo),
      Work_Detail: clean_(j.workDetail),
    };
    Object.keys(rec).forEach(function (k) { if (col[k]) rowValues[col[k] - 1] = rec[k]; });

    // กันเลข 0 นำหน้าหาย / กันถูกแปลงเป็นตัวเลข
    ['Ticket_ID', 'Machine_ID', 'Delivery_No'].forEach(function (h) {
      if (col[h]) sh.getRange(rowNum, col[h]).setNumberFormat('@');
    });
    sh.getRange(rowNum, 1, 1, width).setValues([rowValues]);
    SpreadsheetApp.flush();

    return {
      ok: true,
      mode: isEdit ? 'edit' : 'add',
      ticketId: ticket,
      row: rowNum,
      workDetailSaved: true,
      codeVersion: CODE_VERSION,
      message: (isEdit ? 'แก้ไขงาน ' : 'เพิ่มงาน ') + ticket + ' เรียบร้อย',
    };
  });
}

/**
 * ลบงาน (ได้ทั้งรายการเดียว และหลายรายการ)
 * payload = { pin, items: [ { row, ticketId, machineId }, ... ] }
 */
function deleteJobs(payload) {
  return runWrite_(function () {
    const p = parsePayload_(payload);
    checkPin_(p.pin);
    const items = Array.isArray(p.items) ? p.items : [];
    if (!items.length) throw new Error('ไม่มีรายการที่จะลบ');
    if (items.length > 500) throw new Error('ลบได้ครั้งละไม่เกิน 500 รายการ');

    const sh = jobsSheet_();
    const col = headerIndex_(sh);
    const rows = [];
    const notFound = [];
    items.forEach(function (it) {
      const r = locateRow_(sh, col, it.row, it.ticketId, it.machineId);
      if (r && rows.indexOf(r) === -1) rows.push(r);
      else if (!r) notFound.push(it.ticketId || it.machineId || ('แถว ' + it.row));
    });
    // ลบจากแถวล่างขึ้นบน เพื่อไม่ให้เลขแถวเลื่อน
    rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
    SpreadsheetApp.flush();

    return {
      ok: true,
      deleted: rows.length,
      notFound: notFound,
      message: 'ลบแล้ว ' + rows.length + ' รายการ' + (notFound.length ? ' (ไม่พบ ' + notFound.length + ' รายการ)' : ''),
    };
  });
}

// ---------- CRUD helpers ----------
function runWrite_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return JSON.stringify({ ok: false, message: 'ระบบกำลังบันทึกข้อมูลของผู้ใช้อื่น กรุณาลองใหม่อีกครั้ง' });
  }
  try {
    return JSON.stringify(fn());
  } catch (err) {
    console.error(err);
    return JSON.stringify({ ok: false, message: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function parsePayload_(payload) {
  if (typeof payload === 'string') return JSON.parse(payload);
  return payload || {};
}

function checkPin_(pin) {
  if (CONFIG.EDIT_PIN && String(pin || '') !== String(CONFIG.EDIT_PIN)) {
    throw new Error('PIN ไม่ถูกต้อง');
  }
}

function jobsSheet_() {
  const sh = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.JOBS);
  if (!sh) throw new Error('ไม่พบชีต ' + CONFIG.SHEETS.JOBS + ' — กรุณารัน setupDatabase ก่อน');
  return sh;
}

/** เพิ่มคอลัมน์ท้ายตารางให้อัตโนมัติ ถ้ายังไม่มี (ไม่ต้องรัน setupDatabase ใหม่) */
function ensureColumn_(sh, name) {
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (headers.indexOf(name) > -1) return;
  if (lastCol >= sh.getMaxColumns()) sh.insertColumnAfter(lastCol);
  sh.getRange(1, lastCol + 1).setValue(name)
    .setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff').setHorizontalAlignment('center');
}

/** หาเลขแถวของงาน : ตรวจแถวเดิมก่อน (เร็ว) ถ้าไม่ตรงค่อยค้นจาก Ticket_ID */
function locateRow_(sh, col, row, ticketId, machineId) {
  const last = sh.getLastRow();
  const tid = clean_(ticketId);
  const mid = clean_(machineId);
  const r = Number(row);
  const matches = function (rr) {
    const t = String(sh.getRange(rr, col['Ticket_ID']).getDisplayValue()).trim();
    if (tid) return t === tid;
    const m = String(sh.getRange(rr, col['Machine_ID']).getDisplayValue()).trim();
    return !t && m === mid;
  };
  if (r >= 2 && r <= last && matches(r)) return r;
  if (!tid || last < 2) return 0;
  const ids = sh.getRange(2, col['Ticket_ID'], last - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === tid) return i + 2;
  return 0;
}

/** ออกเลขที่งานถัดไปตาม Prefix ของแผนก เช่น IN-0001 → IN-0002 */
function nextTicketId_(ids, dept) {
  const prefix = CONFIG.TICKET_PREFIX[dept] || CONFIG.DEFAULT_TICKET_PREFIX;
  const re = new RegExp('^' + prefix + '-(\\d+)$');
  let max = 0;
  ids.forEach(function (id) {
    const m = String(id).match(re);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + '-' + ('0000' + (max + 1)).slice(-4);
}

function clean_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function objValues_(o) { return Object.keys(o).map(function (k) { return o[k]; }); }