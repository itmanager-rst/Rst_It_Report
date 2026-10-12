/**
 * ระบบจัดอะไหล่ส่งลูกค้า (Spare Parts Dispatch / Pick List) — Google Apps Script Backend
 *
 * ฐานข้อมูลใหม่ (Google Sheet ไฟล์ใหม่ที่สคริปต์นี้ผูกอยู่) — สร้างอัตโนมัติด้วย setupDatabase()
 *  - ชีต Data   : A=รหัส | B=ชื่อ | C=ราคา | D=จำนวน (ต่อชุด) | E=Place | F=หัวข้อ (promotion)
 *  - ชีต Topics (หรือ ชีต2 เดิม) : A=หัวข้อ/ระยะเช็ก/อาการเสีย | B=ประเภทรถ/งาน
 *
 * ขั้นตอนใช้งาน: เลือกประเภท -> เลือกหัวข้อ -> ระบบดึงรายการอะไหล่ที่หัวข้อตรงกัน -> พิมพ์ใบจัด
 */

// ไฟล์ฐานข้อมูล: ปล่อยว่าง = ใช้ไฟล์ Google Sheet ที่สคริปต์นี้ผูกอยู่ (แนะนำ)
const SPREADSHEET_ID = '';

// ไฟล์เดิมที่จะคัดลอกข้อมูลมา (Form_แบบฟอร์ม_จัดอะไหล่) — ใช้ตอนรัน setupDatabase() ครั้งแรกเท่านั้น
const SOURCE_SPREADSHEET_ID = '1-CMHuz-fJH2CeNQnfdbG_gjlhDmYp4AxyTPo7Y60INg';
const SOURCE_DATA_SHEET = 'Data';
const SOURCE_TOPIC_SHEET = 'ชีต2';

const DATA_SHEET = 'Data';
const TOPIC_SHEET = 'Topics';                         // ชีตที่ setupDatabase() สร้าง
const TOPIC_SHEET_CANDIDATES = ['Topics', 'ชีต2'];   // อ่านจากชีตแรกที่พบ
const DATA_HEADERS = ['รหัส', 'ชื่อ', 'ราคา', 'จำนวน', 'Place', 'หัวข้อ'];
const TOPIC_HEADERS = ['หัวข้อ', 'ประเภท'];
const NUM_COLS = 6; // A–F ของชีต Data
const UNCATEGORIZED = 'ยังไม่จัดประเภท';

/* ================= Web App ================= */

const CODE_VERSION = 'r08-2026-10-12-backup'; // เปลี่ยนทุกครั้งที่ Deploy เวอร์ชันใหม่

// ฟังก์ชันที่เรียกจากหน้าเว็บภายนอก (VS Code Live Server / GitHub Pages) ได้
const API_ACTIONS = {
  getAppData: getAppData,
  getData: getData,
  addPart: addPart,
  updatePart: updatePart,
  deletePart: deletePart,
  addTopic: addTopic,
  deleteTopic: deleteTopic,
  ping: ping,
  importParts: importParts,
  listBackups: listBackups,
  createBackup: createBackup,
  restoreBackup: restoreBackup,
  deleteBackup: deleteBackup,
  getBackupData: getBackupData
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * API สำหรับหน้าเว็บที่ host ที่อื่น
 * body (text/plain): {"action":"addPart","args":[{...}]}
 * ตอบกลับ: {"ok":true,"result":...} หรือ {"ok":false,"error":"..."}
 */
function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = API_ACTIONS[req.action];
    if (!fn) throw new Error('ไม่รู้จัก action: ' + req.action);
    return json_({ ok: true, result: fn.apply(null, req.args || []) });
  } catch (err) {
    return json_({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

/**
 * GET /exec                     -> หน้าเว็บ (Index.html)
 * GET /exec?action=checkStatus  -> เช็กเวอร์ชันที่ Deploy อยู่
 * GET /exec?action=getAppData   -> ข้อมูลทั้งหมด (JSON) ไว้ทดสอบ
 */
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'checkStatus') return json_({ ok: true, codeVersion: CODE_VERSION, time: new Date().toISOString() });
  if (action === 'getAppData') {
    try { return json_({ ok: true, result: getAppData() }); }
    catch (err) { return json_({ ok: false, error: err.message }); }
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ระบบจัดอะไหล่ส่งลูกค้า (Pick List)')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ================= Helpers ================= */

function ss_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

/** หาชีตแบบไม่สนตัวพิมพ์เล็ก/ใหญ่ */
function sheet_(name) {
  const ss = ss_();
  const sh = ss.getSheetByName(name) ||
    ss.getSheets().find(s => s.getName().trim().toLowerCase() === name.toLowerCase());
  if (!sh) throw new Error('ไม่พบชีต "' + name + '" — กรุณารัน setupDatabase() ก่อน (เมนู ระบบจัดอะไหล่ > ตั้งค่าฐานข้อมูล)');
  return sh;
}

function norm_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function toNumberOrBlank_(v) {
  if (v === null || v === undefined || String(v).trim() === '') return '';
  const n = Number(String(v).replace(/,/g, ''));
  if (isNaN(n)) throw new Error('ค่าตัวเลขไม่ถูกต้อง: ' + v);
  return n;
}

function cleanPart_(data) {
  if (!data) throw new Error('ไม่มีข้อมูลที่ส่งมา');
  const partNumber = norm_(data.partNumber);
  const partName = norm_(data.partName);
  if (!partNumber) throw new Error('กรุณากรอกรหัสอะไหล่');
  if (!partName) throw new Error('กรุณากรอกชื่ออะไหล่');
  return [
    partNumber,
    partName,
    toNumberOrBlank_(data.price),
    toNumberOrBlank_(data.quantity),
    norm_(data.place),
    norm_(data.promotion)
  ];
}

/** หาแถวเป้าหมาย: ใช้เลขแถวที่ส่งมาถ้ารหัสในแถวนั้นยังตรงกัน (กันลบ/แก้ผิดแถว) */
function resolveRow_(sh, row, partNumber) {
  const lastRow = sh.getLastRow();
  row = Number(row);
  if (row >= 2 && row <= lastRow) {
    const cur = norm_(sh.getRange(row, 1).getDisplayValue());
    if (!partNumber || cur === norm_(partNumber)) return row;
    throw new Error('ข้อมูลในชีตมีการเปลี่ยนแปลง กรุณากดรีเฟรชแล้วลองใหม่');
  }
  if (partNumber && lastRow >= 2) {
    const ids = sh.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (let i = 0; i < ids.length; i++) {
      if (norm_(ids[i][0]) === norm_(partNumber)) return i + 2;
    }
  }
  throw new Error('ไม่พบรายการที่ต้องการ');
}

/* ================= Read ================= */

/** ดึงข้อมูลอะไหล่ทั้งหมดจากชีต Data */
function getData() {
  const sh = sheet_(DATA_SHEET);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const range = sh.getRange(2, 1, lastRow - 1, NUM_COLS);
  const values = range.getValues();
  const display = range.getDisplayValues(); // รหัสใช้ค่าที่แสดง (กันเลขยาวเป็น 1.94E+11)
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const code = norm_(display[i][0]);
    if (!code && !norm_(v[1])) continue; // ข้ามแถวว่าง
    out.push({
      row: i + 2,
      partNumber: code,
      partName: norm_(v[1]),
      price: v[2] === '' ? '' : Number(v[2]) || 0,
      quantity: v[3] === '' ? '' : Number(v[3]) || 0,
      place: norm_(v[4]),
      promotion: norm_(v[5])
    });
  }
  return out;
}

/** ชีตหัวข้อ: ใช้ "Topics" ถ้ามี ไม่งั้นใช้ "ชีต2" (โครงสร้างไฟล์เดิม) */
function topicSheet_() {
  const ss = ss_();
  for (const name of TOPIC_SHEET_CANDIDATES) {
    const sh = ss.getSheetByName(name);
    if (sh) return sh;
  }
  throw new Error('ไม่พบชีตหัวข้อ (' + TOPIC_SHEET_CANDIDATES.join(' / ') + ')');
}

/**
 * ดึงรายการ หัวข้อ -> ประเภทรถ/งาน
 * A = หัวข้อ/ระยะเช็ก/อาการเสีย, B = ประเภทรถ/งาน
 * ข้ามแถวที่ไม่มีประเภท (เช่น แถวหัวเรื่อง "เปลี่ยนน้ำมัน" ในชีต2) และแถวหัวตาราง
 */
function getTopics() {
  const sh = topicSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 1) return [];
  const values = sh.getRange(1, 1, lastRow, 2).getDisplayValues();
  const out = [], seen = new Set();
  values.forEach((r, i) => {
    const topic = norm_(r[0]), category = norm_(r[1]);
    if (!topic || !category || seen.has(topic)) return;
    if (topic === TOPIC_HEADERS[0] && category === TOPIC_HEADERS[1]) return; // หัวตาราง
    seen.add(topic);
    out.push({ row: i + 1, topic: topic, category: category });
  });
  return out;
}

/** ข้อมูลทั้งหมดที่หน้าเว็บต้องใช้ (เรียกครั้งเดียวตอนเปิด) */
function getAppData() {
  return { parts: getData(), topics: getTopics() };
}

/* ================= CRUD อะไหล่ (ชีต Data) ================= */

function addPart(data) {
  return withLock_(() => {
    autoBackup_();
    const sh = sheet_(DATA_SHEET);
    const rowValues = cleanPart_(data);
    const newRow = sh.getLastRow() + 1;
    sh.getRange(newRow, 1).setNumberFormat('@'); // เก็บรหัสเป็นข้อความ
    sh.getRange(newRow, 1, 1, NUM_COLS).setValues([rowValues]);
    SpreadsheetApp.flush();
    return { ok: true, message: 'เพิ่ม "' + rowValues[1] + '" เรียบร้อย', parts: getData() };
  });
}

/**
 * แก้ไขอะไหล่ — data ต้องมี row (เลขแถว) และ originalPartNumber
 * data.applyAll = true -> อัปเดต รหัส/ชื่อ/ราคา/Place ในทุกแถวที่ใช้รหัสเดิม (ทุกหัวข้อ)
 *                        ส่วน จำนวน และ หัวข้อ เปลี่ยนเฉพาะแถวที่แก้
 */
function updatePart(data) {
  return withLock_(() => {
    autoBackup_();
    const sh = sheet_(DATA_SHEET);
    const orig = norm_(data.originalPartNumber || data.partNumber);
    const row = resolveRow_(sh, data.row, orig);
    const rowValues = cleanPart_(data);
    sh.getRange(row, 1).setNumberFormat('@');
    sh.getRange(row, 1, 1, NUM_COLS).setValues([rowValues]);

    let others = 0;
    if (data.applyAll && orig) {
      const last = sh.getLastRow();
      const ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
      ids.forEach((r, i) => {
        const rr = i + 2;
        if (rr === row || norm_(r[0]) !== orig) return;
        sh.getRange(rr, 1).setNumberFormat('@');
        sh.getRange(rr, 1, 1, 3).setValues([[rowValues[0], rowValues[1], rowValues[2]]]); // รหัส ชื่อ ราคา
        sh.getRange(rr, 5).setValue(rowValues[4]);                                         // Place
        others++;
      });
    }
    SpreadsheetApp.flush();
    return {
      ok: true,
      message: 'บันทึก "' + rowValues[1] + '" เรียบร้อย' + (others ? ' (อัปเดตหัวข้ออื่นอีก ' + others + ' แถว)' : ''),
      parts: getData()
    };
  });
}

/** partId: { row, partNumber } (แนะนำ) หรือ string รหัส (ลบแถวแรกที่พบ) */
function deletePart(partId) {
  return withLock_(() => {
    autoBackup_();
    const sh = sheet_(DATA_SHEET);
    const isObj = partId && typeof partId === 'object';
    const row = resolveRow_(sh, isObj ? partId.row : null, isObj ? partId.partNumber : partId);
    const name = sh.getRange(row, 2).getDisplayValue();
    sh.deleteRow(row);
    SpreadsheetApp.flush();
    return { ok: true, message: 'ลบ "' + name + '" เรียบร้อย', parts: getData() };
  });
}

/* ================= จัดการหัวข้อ/ประเภท (ชีต Topics) ================= */

function addTopic(data) {
  return withLock_(() => {
    const topic = norm_(data && data.topic), category = norm_(data && data.category);
    if (!topic || !category) throw new Error('กรุณากรอกทั้งหัวข้อและประเภท');
    if (getTopics().some(t => t.topic === topic)) throw new Error('มีหัวข้อ "' + topic + '" อยู่แล้ว');
    const sh = topicSheet_();
    sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([[topic, category]]);
    SpreadsheetApp.flush();
    return { ok: true, message: 'เพิ่มหัวข้อ "' + topic + '" เรียบร้อย', topics: getTopics() };
  });
}

/** ลบหัวข้อออกจากชีต Topics (ไม่ลบรายการอะไหล่ในชีต Data) */
function deleteTopic(data) {
  return withLock_(() => {
    const sh = topicSheet_();
    const row = Number(data && data.row);
    if (!row || norm_(sh.getRange(row, 1).getDisplayValue()) !== norm_(data.topic)) {
      throw new Error('ข้อมูลหัวข้อมีการเปลี่ยนแปลง กรุณารีเฟรชแล้วลองใหม่');
    }
    sh.deleteRow(row);
    SpreadsheetApp.flush();
    return { ok: true, message: 'ลบหัวข้อ "' + data.topic + '" เรียบร้อย', topics: getTopics() };
  });
}

/* ======================================================================
   ตั้งค่าฐานข้อมูลใหม่ (รันครั้งแรกครั้งเดียว)
   - สร้างชีต Data และ Topics ในไฟล์นี้
   - คัดลอกข้อมูลจากไฟล์เดิม พร้อมทำความสะอาด:
       * รหัสเก็บเป็นข้อความ (ไม่เพี้ยนเป็น 1.94E+11)
       * ตัดช่องว่างเกิน, ข้ามแถวว่าง, ตัดแถวที่ซ้ำกันทุกช่อง
       * หัวข้อที่มีใน Data แต่ไม่มีในชีต2 -> เพิ่มให้อัตโนมัติ (เดาประเภทจากหัวข้อชุดเดียวกัน)
   ====================================================================== */

/** เมนูในไฟล์ Google Sheet */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ระบบจัดอะไหล่')
    .addItem('ตั้งค่าฐานข้อมูล (คัดลอกจากไฟล์เดิม)', 'setupDatabase')
    .addToUi();
}

function setupDatabase() {
  const ss = ss_();
  let ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* รันจาก editor */ }

  // กันเขียนทับข้อมูลที่มีอยู่แล้ว
  const existing = ss.getSheetByName(DATA_SHEET);
  if (existing && existing.getLastRow() > 1) {
    if (!ui) throw new Error('ชีต Data มีข้อมูลอยู่แล้ว — ถ้าต้องการคัดลอกใหม่ให้ลบชีต Data ก่อน หรือรันจากเมนูในชีต');
    const ans = ui.alert('ชีต Data มีข้อมูลอยู่แล้ว', 'ต้องการล้างแล้วคัดลอกจากไฟล์เดิมใหม่ทั้งหมดหรือไม่?', ui.ButtonSet.YES_NO);
    if (ans !== ui.Button.YES) return;
  }

  const src = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  const findSheet = name => src.getSheetByName(name) ||
    src.getSheets().find(s => s.getName().trim().toLowerCase() === name.toLowerCase());

  /* ---------- 1) อ่านอะไหล่ ---------- */
  const sData = findSheet(SOURCE_DATA_SHEET);
  if (!sData) throw new Error('ไม่พบชีต "' + SOURCE_DATA_SHEET + '" ในไฟล์เดิม');
  const n = sData.getLastRow() - 1;
  const raw = n > 0 ? sData.getRange(2, 1, n, NUM_COLS).getValues() : [];
  const disp = n > 0 ? sData.getRange(2, 1, n, NUM_COLS).getDisplayValues() : [];

  const seen = new Set();
  const parts = [];
  let skippedBlank = 0, skippedDup = 0;
  raw.forEach((r, i) => {
    const code = codeToText_(r[0], disp[i][0]);
    const name = norm_(r[1]);
    if (!code && !name) { skippedBlank++; return; }
    const row = [code, name, numOrBlank_(r[2]), numOrBlank_(r[3]), norm_(r[4]), norm_(r[5])];
    const key = JSON.stringify(row);
    if (seen.has(key)) { skippedDup++; return; }
    seen.add(key);
    parts.push(row);
  });

  /* ---------- 2) อ่านหัวข้อ/ประเภท ---------- */
  const sTopic = findSheet(SOURCE_TOPIC_SHEET);
  const topics = [];
  const topicSet = new Set();
  if (sTopic && sTopic.getLastRow() > 0) {
    sTopic.getRange(1, 1, sTopic.getLastRow(), 2).getDisplayValues().forEach(r => {
      const t = norm_(r[0]), c = norm_(r[1]);
      if (t && c && !topicSet.has(t)) { topicSet.add(t); topics.push([t, c]); }
    });
  }

  // หัวข้อที่อยู่ใน Data แต่ยังไม่มีในรายการหัวข้อ -> เพิ่มให้ โดยเดาประเภทจากหัวข้อที่ต่างกันแค่ "xx ชม."
  const pattern = t => t.replace(/\d+\s*ชม\.?/, '#');
  const added = [];
  parts.forEach(p => {
    const t = p[5];
    if (!t || topicSet.has(t)) return;
    const sibling = topics.find(x => pattern(x[0]) === pattern(t) && x[0] !== t);
    const cat = sibling ? sibling[1] : UNCATEGORIZED;
    topicSet.add(t); topics.push([t, cat]); added.push(t + ' → ' + cat);
  });

  /* ---------- 3) เขียนลงไฟล์ใหม่ ---------- */
  const dataSh = resetSheet_(ss, DATA_SHEET, DATA_HEADERS);
  dataSh.getRange('A:A').setNumberFormat('@'); // รหัสเป็นข้อความ
  if (parts.length) dataSh.getRange(2, 1, parts.length, NUM_COLS).setValues(parts);
  dataSh.getRange('C:C').setNumberFormat('#,##0.##');
  [140, 320, 80, 70, 90, 240].forEach((w, i) => dataSh.setColumnWidth(i + 1, w));

  const topicSh = resetSheet_(ss, TOPIC_SHEET, TOPIC_HEADERS);
  if (topics.length) topicSh.getRange(2, 1, topics.length, 2).setValues(topics);
  topicSh.setColumnWidth(1, 280); topicSh.setColumnWidth(2, 220);

  // ลบชีตว่างตั้งต้น (Sheet1 / ชีต1)
  ss.getSheets().forEach(s => {
    if (s.getName() !== DATA_SHEET && s.getName() !== TOPIC_SHEET && s.getLastRow() === 0 && ss.getSheets().length > 2) ss.deleteSheet(s);
  });
  SpreadsheetApp.flush();

  const msg = 'คัดลอกอะไหล่ ' + parts.length + ' แถว, หัวข้อ ' + topics.length + ' รายการ\n' +
    'ข้ามแถวว่าง ' + skippedBlank + ' แถว, ตัดแถวซ้ำ ' + skippedDup + ' แถว' +
    (added.length ? '\nเพิ่มหัวข้อที่ขาด:\n- ' + added.join('\n- ') : '');
  Logger.log(msg);
  if (ui) ui.alert('ตั้งค่าฐานข้อมูลเรียบร้อย', msg, ui.ButtonSet.OK);
  return msg;
}

function resetSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (sh) sh.clear(); else sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#198754').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}

/** แปลงรหัสเป็นข้อความ: ตัวเลขยาวไม่ให้กลายเป็น 1.94E+11 */
function codeToText_(rawVal, dispVal) {
  if (typeof rawVal === 'number') {
    return Number.isInteger(rawVal) ? BigInt(rawVal).toString() : String(rawVal);
  }
  return norm_(rawVal !== '' ? rawVal : dispVal);
}

function numOrBlank_(v) {
  if (v === '' || v === null) return '';
  const x = Number(String(v).replace(/,/g, ''));
  return isNaN(x) ? '' : x;
}


/* ======================================================================
   สถานะการเชื่อมต่อ (หน้าเว็บเรียกทุก 1 นาที)
   ====================================================================== */
function ping() {
  const ss = ss_();
  const sh = sheet_(DATA_SHEET);
  return {
    ok: true,
    codeVersion: CODE_VERSION,
    spreadsheet: ss.getName(),
    rows: Math.max(0, sh.getLastRow() - 1),
    topics: getTopics().length,
    serverTime: new Date().toISOString()
  };
}

/* ======================================================================
   อัปโหลดฐานข้อมูลรายการอะไหล่ (จากไฟล์ Excel/CSV ที่หน้าเว็บอ่านมาแล้ว)
   payload = {
     mode: 'upsert' | 'append' | 'replace',
     rows: [[รหัส, ชื่อ, ราคา, จำนวน, Place, หัวข้อ], ...],
     topics: [[หัวข้อ, ประเภท], ...]   (ไม่บังคับ — ถ้ามี จะเพิ่มหัวข้อที่ยังไม่มี)
   }
   upsert  = รหัส+หัวข้อ ตรงกัน -> อัปเดต, ไม่ตรง -> เพิ่มใหม่ (แนะนำ)
   append  = เพิ่มต่อท้ายทั้งหมด
   replace = สำรองชีตเดิมเป็น Data_backup_... แล้วแทนที่ทั้งหมด
   ====================================================================== */
function importParts(payload) {
  return withLock_(() => {
    autoBackup_();
    const mode = payload && payload.mode;
    if (['upsert', 'append', 'replace'].indexOf(mode) < 0) throw new Error('โหมดอัปโหลดไม่ถูกต้อง');
    const rows = ((payload && payload.rows) || [])
      .map(r => { try { return cleanPart_({ partNumber: r[0], partName: r[1], price: r[2], quantity: r[3], place: r[4], promotion: r[5] }); } catch (e) { return null; } })
      .filter(Boolean);
    if (!rows.length) throw new Error('ไม่มีรายการที่ถูกต้องในไฟล์ (ต้องมีอย่างน้อย รหัส และ ชื่อ)');

    const ss = ss_();
    const sh = sheet_(DATA_SHEET);
    const last = sh.getLastRow();
    let added = 0, updated = 0, backup = '';

    if (mode === 'replace') {
      backup = snapshot_('ก่อนอัปโหลดแบบแทนที่ทั้งหมด', 'auto').name;
      if (last > 1) sh.getRange(2, 1, last - 1, NUM_COLS).clearContent();
      sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
      sh.getRange(2, 1, rows.length, NUM_COLS).setValues(rows);
      added = rows.length;
    } else {
      let existing = [];
      if (last > 1) {
        const rng = sh.getRange(2, 1, last - 1, NUM_COLS);
        existing = rng.getValues();
        const disp = rng.getDisplayValues();
        existing.forEach((r, i) => { r[0] = norm_(disp[i][0]); });
      }
      const toAppend = [];
      if (mode === 'upsert') {
        const index = {};
        existing.forEach((r, i) => { index[r[0] + '|' + norm_(r[5])] = i; });
        const pending = {};   // แถวซ้ำในไฟล์เดียวกัน -> ใช้แถวล่าสุด
        rows.forEach(r => {
          const k = r[0] + '|' + r[5];
          if (k in index) { existing[index[k]] = r; updated++; }
          else if (k in pending) { toAppend[pending[k]] = r; }
          else { pending[k] = toAppend.length; toAppend.push(r); }
        });
        if (updated) {
          sh.getRange(2, 1, existing.length, 1).setNumberFormat('@');
          sh.getRange(2, 1, existing.length, NUM_COLS).setValues(existing);
        }
      } else {
        rows.forEach(r => toAppend.push(r));
      }
      if (toAppend.length) {
        const start = sh.getLastRow() + 1;
        sh.getRange(start, 1, toAppend.length, 1).setNumberFormat('@');
        sh.getRange(start, 1, toAppend.length, NUM_COLS).setValues(toAppend);
      }
      added = toAppend.length;
    }

    // หัวข้อ/ประเภท (ถ้ามีในไฟล์)
    let topicsAdded = 0;
    const tp = (payload && payload.topics) || [];
    if (tp.length) {
      const have = new Set(getTopics().map(t => t.topic));
      const tsh = topicSheet_();
      const newT = [];
      tp.forEach(r => {
        const t = norm_(r[0]), c = norm_(r[1]);
        if (t && c && !have.has(t)) { have.add(t); newT.push([t, c]); }
      });
      if (newT.length) tsh.getRange(tsh.getLastRow() + 1, 1, newT.length, 2).setValues(newT);
      topicsAdded = newT.length;
    }

    SpreadsheetApp.flush();
    const msg = 'อัปโหลดเรียบร้อย: เพิ่ม ' + added + ' แถว' + (updated ? ', อัปเดต ' + updated + ' แถว' : '') +
      (topicsAdded ? ', หัวข้อใหม่ ' + topicsAdded : '') + (backup ? ' (สำรองข้อมูลเดิมไว้แล้ว: ' + backup + ')' : '');
    return { ok: true, message: msg, parts: getData(), topics: getTopics() };
  });
}


/* ======================================================================
   สำรองข้อมูล (Backup) / กู้คืน (Restore)
   - แต่ละชุดสำรองเก็บเป็นชีตซ่อนชื่อ BK_yyyyMMdd_HHmmss ในไฟล์เดียวกัน
       A:F = ข้อมูล Data, H:I = หัวข้อ/ประเภท
   - รายการชุดสำรองอยู่ในชีต "Backups" (เวลา, จำนวนแถว, หมายเหตุ, ชนิด)
   - สำรองอัตโนมัติ: ก่อนการแก้ไขครั้งแรกของแต่ละวัน และก่อนกู้คืน/แทนที่ทั้งหมด
   - เก็บชุดอัตโนมัติไว้ล่าสุด MAX_AUTO_BACKUPS ชุด (ชุดที่กดสำรองเองไม่ลบอัตโนมัติ)
   ====================================================================== */
const BACKUP_LOG = 'Backups';
const BACKUP_PREFIX = 'BK_';
const MAX_AUTO_BACKUPS = 30;

function backupLog_() {
  const ss = ss_();
  let sh = ss.getSheetByName(BACKUP_LOG);
  if (!sh) {
    sh = ss.insertSheet(BACKUP_LOG);
    sh.getRange(1, 1, 1, 6).setValues([['ชีตสำรอง', 'เวลา', 'จำนวนรายการ', 'จำนวนหัวข้อ', 'ชนิด', 'หมายเหตุ']])
      .setFontWeight('bold').setBackground('#0d6efd').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** สร้างชุดสำรอง (ใช้ภายใน — ต้องอยู่ใน lock แล้ว) */
function snapshot_(note, kind) {
  const ss = ss_();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  let name = BACKUP_PREFIX + Utilities.formatDate(now, tz, 'yyyyMMdd_HHmmss');
  while (ss.getSheetByName(name)) name += '_1';

  const data = sheet_(DATA_SHEET);
  const dLast = data.getLastRow();
  const dVals = dLast >= 1 ? data.getRange(1, 1, dLast, NUM_COLS).getValues() : [];
  const dDisp = dLast >= 1 ? data.getRange(1, 1, dLast, 1).getDisplayValues() : [];
  dVals.forEach((r, i) => { r[0] = dDisp[i][0]; });           // รหัสเป็นข้อความ
  const tsh = topicSheet_();
  const tLast = tsh.getLastRow();
  const tVals = tLast >= 1 ? tsh.getRange(1, 1, tLast, 2).getDisplayValues() : [];

  const bk = ss.insertSheet(name, ss.getSheets().length);
  if (dVals.length) {
    bk.getRange(1, 1, dVals.length, 1).setNumberFormat('@');
    bk.getRange(1, 1, dVals.length, NUM_COLS).setValues(dVals);
  }
  if (tVals.length) bk.getRange(1, 8, tVals.length, 2).setValues(tVals);
  bk.hideSheet();

  const rows = Math.max(0, dVals.length - 1);
  const topics = getTopics().length;
  backupLog_().appendRow([name, now, rows, topics, kind === 'auto' ? 'อัตโนมัติ' : 'สำรองเอง', note || '']);
  if (kind === 'auto') pruneAutoBackups_();
  return { name: name, rows: rows, topics: topics };
}

/** สำรองอัตโนมัติวันละครั้ง ก่อนการแก้ไขครั้งแรกของวัน */
function autoBackup_() {
  try {
    const tz = Session.getScriptTimeZone();
    const today = Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('lastAutoBackup') === today) return;
    snapshot_('สำรองอัตโนมัติประจำวัน (ก่อนแก้ไขครั้งแรก)', 'auto');
    props.setProperty('lastAutoBackup', today);
  } catch (e) { Logger.log('autoBackup error: ' + e); }   // ไม่ให้การสำรองที่ผิดพลาดขวางการบันทึก
}

function pruneAutoBackups_() {
  const list = listBackups().filter(b => b.kind === 'อัตโนมัติ');
  if (list.length <= MAX_AUTO_BACKUPS) return;
  list.slice(MAX_AUTO_BACKUPS).forEach(b => deleteBackupInternal_(b.name));
}

/** รายการชุดสำรอง (ใหม่สุดก่อน) */
function listBackups() {
  const sh = backupLog_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  const ss = ss_();
  return sh.getRange(2, 1, last - 1, 6).getValues()
    .filter(r => r[0] && ss.getSheetByName(String(r[0])))
    .map(r => ({
      name: String(r[0]),
      time: r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'yyyy-MM-dd HH:mm:ss') : String(r[1]),
      rows: Number(r[2]) || 0, topics: Number(r[3]) || 0, kind: String(r[4]), note: String(r[5] || '')
    }))
    .reverse();
}

/** กดสำรองเองจากหน้าเว็บ */
function createBackup(data) {
  return withLock_(() => {
    const b = snapshot_(norm_(data && data.note) || 'สำรองด้วยตนเอง', 'manual');
    return { ok: true, message: 'สำรองข้อมูลเรียบร้อย (' + b.rows + ' รายการ)', backups: listBackups() };
  });
}

/** กู้คืนจากชุดสำรอง — สำรองข้อมูลปัจจุบันอัตโนมัติก่อนเสมอ */
function restoreBackup(data) {
  return withLock_(() => {
    const name = String(data && data.name || '');
    const ss = ss_();
    const bk = ss.getSheetByName(name);
    if (!name.startsWith(BACKUP_PREFIX) || !bk) throw new Error('ไม่พบชุดสำรอง ' + name);

    const safety = snapshot_('ก่อนกู้คืนจาก ' + name, 'auto');

    // Data
    const bLast = bk.getLastRow();
    const dVals = bLast >= 2 ? bk.getRange(2, 1, bLast - 1, NUM_COLS).getValues().filter(r => r.some(c => c !== '')) : [];
    const dsh = sheet_(DATA_SHEET);
    const dLast = dsh.getLastRow();
    if (dLast > 1) dsh.getRange(2, 1, dLast - 1, NUM_COLS).clearContent();
    if (dVals.length) {
      dsh.getRange(2, 1, dVals.length, 1).setNumberFormat('@');
      dsh.getRange(2, 1, dVals.length, NUM_COLS).setValues(dVals);
    }
    // Topics (คอลัมน์ H:I ของชุดสำรอง)
    const tAll = bLast >= 1 ? bk.getRange(1, 8, bLast, 2).getDisplayValues().filter(r => r[0] || r[1]) : [];
    if (tAll.length) {
      const tsh = topicSheet_();
      const tLast = tsh.getLastRow();
      if (tLast > 0) tsh.getRange(1, 1, tLast, 2).clearContent();
      tsh.getRange(1, 1, tAll.length, 2).setValues(tAll);
    }
    SpreadsheetApp.flush();
    return {
      ok: true,
      message: 'กู้คืนจาก ' + name + ' เรียบร้อย (' + dVals.length + ' รายการ) — ข้อมูลก่อนกู้คืนสำรองไว้ที่ ' + safety.name,
      parts: getData(), topics: getTopics(), backups: listBackups()
    };
  });
}

function deleteBackupInternal_(name) {
  const ss = ss_();
  const sh = ss.getSheetByName(name);
  if (sh && name.startsWith(BACKUP_PREFIX)) ss.deleteSheet(sh);
  const log = backupLog_();
  const last = log.getLastRow();
  if (last < 2) return;
  const names = log.getRange(2, 1, last - 1, 1).getValues();
  for (let i = names.length - 1; i >= 0; i--) if (String(names[i][0]) === name) log.deleteRow(i + 2);
}

function deleteBackup(data) {
  return withLock_(() => {
    const name = String(data && data.name || '');
    if (!name.startsWith(BACKUP_PREFIX)) throw new Error('ชื่อชุดสำรองไม่ถูกต้อง');
    deleteBackupInternal_(name);
    return { ok: true, message: 'ลบชุดสำรอง ' + name + ' แล้ว', backups: listBackups() };
  });
}

/** ดึงข้อมูลชุดสำรอง (ไว้ดาวน์โหลดเป็น Excel) */
function getBackupData(data) {
  const name = String(data && data.name || '');
  const bk = ss_().getSheetByName(name);
  if (!name.startsWith(BACKUP_PREFIX) || !bk) throw new Error('ไม่พบชุดสำรอง ' + name);
  const last = bk.getLastRow();
  if (last < 1) return { data: [], topics: [] };
  const d = bk.getRange(1, 1, last, NUM_COLS).getDisplayValues().filter(r => r.some(c => c !== ''));
  const t = bk.getRange(1, 8, last, 2).getDisplayValues().filter(r => r[0] || r[1]);
  return { name: name, data: d, topics: t };
}