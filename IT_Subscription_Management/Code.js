/**
 * Apps Script ที่ผูกกับชีต IT_Billing_Master_Log
 * หน้าที่: ให้ index.html อ่านและบันทึกข้อมูลลงชีตผ่าน Web App
 * แท็บ: M365_Logs, GSuite_Logs, Bluehost_Logs (บริการ/วันต่ออายุ), Bluehost_Payments (ประวัติการชำระเงิน),
 *       Bluehost_Dedupe_Log (บันทึกแถวที่ถูกลบจากการรวมรายการซ้ำ — กู้คืนได้),
 *       BQ_IT_Expenses (ค่าใช้จ่ายแผนก IT ดึงจาก BigQuery: multi_company_inventory)
 *
 * วิธีติดตั้ง:
 * 1) เปิดชีต IT_Billing_Master_Log > Extensions > Apps Script
 * 2) วางโค้ดนี้แทนของเดิม (TOKEN ต้องตรงกับ API_TOKEN ใน index.html)
 * 3) Services (+) > เพิ่ม "BigQuery API" (Advanced Service ชื่อ BigQuery) > Add
 * 4) แก้ BQ_TABLE ด้านล่างให้เป็น dataset.table ที่เก็บ PO จริง
 * 5) (ครั้งแรก) Run ฟังก์ชัน setupSheets เพื่อสร้างแท็บและหัวตาราง
 * 6) Run ฟังก์ชัน createBigQuerySyncTrigger (ตั้งให้ดึงข้อมูล BigQuery ทุกวันเวลา 06:00 อัตโนมัติ)
 *    หรือกดเมนู "IT Dashboard > ดึงข้อมูล BigQuery (IT) ทันที" ในชีต
 * 7) (ล้างข้อมูลซ้ำที่มีอยู่แล้ว) Run ฟังก์ชัน dedupeBluehostSheet หรือใช้เมนู "IT Dashboard" ในชีต
 * 8) Deploy > Manage deployments > Edit (ไอคอนดินสอ) > Version: New version > Deploy
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    (ใช้ deployment เดิม URL จะไม่เปลี่ยน ไม่ต้องแก้ API_URL ใน index.html)
 */

const TOKEN = "Qm7vT2xLp9WzRk4HsD1axcsdewsLpOjkGFDXvzgabxcs";

const TABS = {
  m365: "M365_Logs",
  gsuite: "GSuite_Logs",
  bluehost: "Bluehost_Logs",
  bhpay: "Bluehost_Payments",
  bqit: "BQ_IT_Expenses"
};
const DEDUPE_LOG_TAB = "Bluehost_Dedupe_Log";

const BILLING_HEADER = ["Date", "Invoice ID", "Billing Period", "Total Amount", "Status"];
const BLUEHOST_HEADER = ["Service Name", "Plan / Domain", "Billing Cycle", "Amount", "Renewal Date", "Status",
                         "Product Type", "Auto Renew", "Product Id"];
const BHPAY_HEADER = ["Date", "Order Number", "Payment Method", "Total Amount", "Status"];
const DEDUPE_LOG_HEADER = ["Logged At", "Reason", "Composite Key"].concat(BLUEHOST_HEADER);

/* ----- BigQuery (IT expenses) ----- */
const BQ_PROJECT = "rst-ecount-sync-py";                    // GCP project ที่เก็บตาราง (ใช้เป็น billing project ด้วย)
const BQ_TABLE = "multi_company_inventory.it_expenses";     // dataset.table ที่เก็บ PO (ยืนยันจากหน้า BigQuery Console)
const BQ_IT_FILTER = "pjt_des IN ('แผนก IT', 'IT', 'ไอที')";   // ค่าใช้จ่ายแผนก IT ทุกบริษัท
const BQ_HEADER = ["Company", "PO No", "Order No", "Order Date", "Project Code", "Project",
                   "Vendor Code", "Vendor", "Product", "Qty", "Amount", "VAT", "Total Amount",
                   "PIC", "Payment Flag", "Status", "Updated At"];

const HEADERS = {
  m365: BILLING_HEADER,
  gsuite: BILLING_HEADER,
  bluehost: BLUEHOST_HEADER,
  bhpay: BHPAY_HEADER,
  bqit: BQ_HEADER
};

/* =========================================================
   Web App API
   ========================================================= */

/** GET ?token=... -> ส่งข้อมูลทุกแท็บเป็น JSON */
function doGet(e) {
  if (!authorized(e && e.parameter && e.parameter.token)) return out({ error: "unauthorized" });
  const action = (e.parameter && e.parameter.action) || "";
  if (action === "bqsync") return out(runBqSyncForWeb_());   // ดึง BigQuery → Sheet จากปุ่มในเว็บ
  if (action === "status") return out(getStatus_());          // สถานะการเชื่อมต่อ Sheet / BigQuery
  const res = {};
  Object.keys(TABS).forEach(key => { res[key] = readTab(key); });
  return out(res);
}

/** POST (text/plain, JSON) -> เขียนทับเฉพาะแท็บที่ส่งมา (แท็บที่ไม่ได้ส่งมาจะไม่ถูกแตะ)
 *  - bluehost / bhpay จะถูก Deduplicate ฝั่ง Server อีกชั้นก่อนเขียน (กันข้อมูลซ้ำจาก client รุ่นเก่า)
 *  - bluehostRemoved: แถวที่ client รวม/ลบไป -> บันทึกลง Bluehost_Dedupe_Log
 *  - bqit ไม่ได้มาจาก client: ดึงจาก BigQuery ด้วย syncBigQueryItExpenses() เท่านั้น */
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ error: "bad json" }); }
  if (!authorized(body.token)) return out({ error: "unauthorized" });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return out({ error: "busy, please retry" });
  try {
    const written = {}, removed = {};
    Object.keys(TABS).forEach(key => {
      if (key === "bqit") return;                                // ป้องกัน client เขียนทับข้อมูล BigQuery
      if (!Array.isArray(body[key])) return;
      let rows = body[key];
      if (key === "bluehost") {
        const d = dedupeBluehostRows(rows);
        rows = d.rows;
        if (d.dropped.length) { appendDedupeLog(d.dropped, "server dedupe on save"); removed.bluehost = d.dropped.length; }
      } else if (key === "bhpay") {
        const d = dedupeByKey(rows, 1);                       // Order Number
        rows = d.rows; if (d.dropped) removed.bhpay = d.dropped;
      }
      writeTab(key, rows);
      written[key] = rows.length;
    });
    if (Array.isArray(body.bluehostRemoved) && body.bluehostRemoved.length) {
      appendLogRows(body.bluehostRemoved);
    }
    return out({ ok: true, written: written, removed: removed });
  } catch (err) {
    return out({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================
   BigQuery: ค่าใช้จ่ายแผนก IT (multi_company_inventory)
   ========================================================= */

/** SQL ของตาราง PO — คอลัมน์เรียงตาม BQ_HEADER */
function bqSql_() {
  return `SELECT
    company_id, po_no, CAST(ord_no AS STRING) AS ord_no,
    PARSE_DATE('%Y%m%d', CAST(ord_date AS STRING)) AS ord_date,
    pjt_cd, pjt_des, cust_cd, cust_des, prod_des, qty, buy_amt, vat_amt, total_amt,
    pic_name, p_flag, status_name, CAST(updated_at AS STRING) AS updated_at
  FROM \`${BQ_PROJECT}.${BQ_TABLE}\`
  WHERE ${BQ_IT_FILTER}
  ORDER BY ord_date DESC`;
}

/** รัน query แล้วคืนแถวทั้งหมด (รอ job เสร็จ + อ่านทุกหน้า) เป็นข้อความ */
function bqRunQuery_() {
  let res = BigQuery.Jobs.query({ query: bqSql_(), useLegacySql: false, timeoutMs: 20000 }, BQ_PROJECT);
  const jobId = res.jobReference.jobId, location = res.jobReference.location;
  while (!res.jobComplete) {
    Utilities.sleep(2000);
    res = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { location: location, timeoutMs: 20000 });
  }
  let rows = res.rows || [], token = res.pageToken;
  while (token) {
    res = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { location: location, pageToken: token });
    rows = rows.concat(res.rows || []);
    token = res.pageToken;
  }
  return rows.map(r => r.f.map(c => (c.v == null ? "" : String(c.v))));
}

/** ดึงข้อมูลจาก BigQuery แล้วเขียนลงแท็บ BQ_IT_Expenses (ใช้กับ Trigger และเมนู) */
// ใช้กับ trigger ตามเวลา และเมนูในชีต: ถ้าล้มเหลวจะ throw เพื่อให้เห็นใน Executions
function syncBigQueryItExpenses() {
  const info = runBqSyncForWeb_();
  if (!info.ok) throw new Error(info.error);
  const msg = "BigQuery → " + TABS.bqit + ": " + info.rows + " แถว";
  Logger.log(msg);
  return msg;
}

// ดึง BigQuery → แท็บ BQ_IT_Expenses แล้วบันทึกผลล่าสุดไว้ใน Script Properties
function runBqSyncForWeb_() {
  const lock = LockService.getScriptLock();
  let info;
  try {
    if (!lock.tryLock(60000)) throw new Error("ระบบกำลังซิงก์อยู่ กรุณาลองใหม่อีกครั้ง");
    try {
      const rows = bqRunQuery_();
      writeTab("bqit", rows);
      info = { ok: true, at: new Date().toISOString(), rows: rows.length };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    info = { ok: false, at: new Date().toISOString(), error: String((err && err.message) || err) };
  }
  PropertiesService.getScriptProperties().setProperty("bqLast", JSON.stringify(info));
  return info;
}

// ทดสอบการเชื่อมต่อ BigQuery ด้วยคำสั่งเบาๆ (SELECT 1)
function bqCheck_() {
  try {
    const res = BigQuery.Jobs.query({ query: "SELECT 1 AS ok", useLegacySql: false, timeoutMs: 10000 }, BQ_PROJECT);
    return { ok: !!res.jobComplete, error: res.jobComplete ? "" : "หมดเวลาตอบกลับ" };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// สถานะรวม: Google Sheet (อ่านได้หรือไม่) + BigQuery (ทดสอบเชื่อมต่อ) + ผลซิงก์ล่าสุด
function getStatus_() {
  let sheetOk = true, sheetError = "";
  try { SpreadsheetApp.getActiveSpreadsheet().getName(); } catch (err) { sheetOk = false; sheetError = String(err.message || err); }
  let last = null;
  try { last = JSON.parse(PropertiesService.getScriptProperties().getProperty("bqLast") || "null"); } catch (e) {}
  return { sheet: { ok: sheetOk, error: sheetError }, bigquery: bqCheck_(), lastSync: last, serverTime: new Date().toISOString() };
}

/** รันครั้งเดียว: ตั้ง Time-driven trigger ให้ดึงข้อมูล BigQuery ทุกวัน 06:00 */
function createBigQuerySyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "syncBigQueryItExpenses") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncBigQueryItExpenses").timeBased().everyDays(1).atHour(6).create();
}

/* =========================================================
   Bluehost: Normalization / Composite Key / Dedupe
   (ตรรกะเดียวกับ index.html: Category + Primary Identifier)
   ========================================================= */
const BH_TYPES = ["Hosting", "Domain", "Email", "SSL", "Other"];
const BH_SERVICE_ALIASES = [
  { re: /domain privacy|privacy\s*\+?\s*protection|whois|sitelock|codeguard|backup|seo|spam/i, type: "Other" },
  { re: /\bssl\b|certificate/i, type: "SSL" },
  { re: /professional e-?mail|e-?mail|mailbox|อีเมล/i, type: "Email" },
  { re: /web hosting|hosting package|shared hosting|wordpress|choice plus|online store|woocommerce|\b(basic|plus|pro|starter)\s+(plan|hosting)|\bvps\b|dedicated|cloud hosting|hosting|โฮสต์/i, type: "Hosting" },
  { re: /domain|โดเมน/i, type: "Domain" }
];
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function cleanNull_(v) { const s = String(v == null ? "" : v).trim(); return /^(null|undefined|n\/a|-)$/i.test(s) ? "" : s; }
function normalizeDomain_(s) {
  const d = cleanNull_(s).toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[\/?#].*$/, "").replace(/\.$/, "").trim();
  return DOMAIN_RE.test(d) ? d : "";
}
function canonicalName_(s) { return cleanNull_(s).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9ก-๙.]+/g, " ").trim(); }
function classifyName_(s) { for (let i = 0; i < BH_SERVICE_ALIASES.length; i++) if (BH_SERVICE_ALIASES[i].re.test(s)) return BH_SERVICE_ALIASES[i].type; return null; }
function normType_(type, service) {
  if (BH_TYPES.indexOf(type) >= 0) return type;
  const t = cleanNull_(type);
  if (t) { const c = classifyName_(t); if (c) return c; }
  if (normalizeDomain_(service)) return "Domain";
  return classifyName_(cleanNull_(service)) || "Other";
}
/** แถวชีต: [Service, Domain, Cycle, Amount, Renewal, Status, Type, AutoRenew, ProductId] */
function bhKeyRow_(r) {
  const cat = normType_(r[6], r[0]);
  const id = normalizeDomain_(r[1]) || normalizeDomain_(r[0]) || ("svc:" + canonicalName_(r[0]));
  return cat === "Other" ? "Other|" + id + "|" + canonicalName_(r[0]) : cat + "|" + id;
}
/** วันที่ -> YYYY-MM-DD (รองรับ YYYY-MM-DD, M/D/YYYY) สำหรับเปรียบเทียบ */
function isoDate_(s) {
  s = cleanNull_(s); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return m[3] + "-" + ("0" + m[1]).slice(-2) + "-" + ("0" + m[2]).slice(-2);
  return s;
}
function completeness_(r) {
  return (cleanNull_(r[3]) ? 8 : 0) + (cleanNull_(r[2]) ? 4 : 0) + (/^\d{4}-\d{2}-\d{2}$/.test(isoDate_(r[4])) ? 2 : 0) + (cleanNull_(r[7]) ? 1 : 0) + (cleanNull_(r[8]) ? 1 : 0);
}
/** เก็บ record ที่ Renewal Date ล่าสุด (เสมอกัน -> ข้อมูลสมบูรณ์กว่า) แล้วเติมช่องว่างจากแถวอื่นในกลุ่ม */
function dedupeBluehostRows(rows) {
  const width = BLUEHOST_HEADER.length, groups = {}, order = [];
  rows.forEach(r => {
    const row = []; for (let i = 0; i < width; i++) row.push(r && r[i] != null ? String(r[i]) : "");
    if (!cleanNull_(row[0])) return;
    const k = bhKeyRow_(row);
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(row);
  });
  const out = [], dropped = [];
  order.forEach(k => {
    const g = groups[k].slice().sort((a, b) => isoDate_(b[4]).localeCompare(isoDate_(a[4])) || completeness_(b) - completeness_(a));
    const kept = g[0].slice();
    for (let j = 1; j < g.length; j++) {
      for (let i = 0; i < width; i++) if (!cleanNull_(kept[i]) && cleanNull_(g[j][i])) kept[i] = g[j][i];
      dropped.push({ key: k, row: g[j] });
    }
    out.push(kept);
  });
  return { rows: out, dropped: dropped };
}
/** Deduplicate ตามคอลัมน์ key (เก็บแถวสุดท้าย) */
function dedupeByKey(rows, col) {
  const map = {}, order = [];
  rows.forEach(r => { const k = String(r[col] || r.join("|")); if (!(k in map)) order.push(k); map[k] = r; });
  return { rows: order.map(k => map[k]), dropped: rows.length - order.length };
}

/** ใช้จากเมนู/หน้า Apps Script: ล้างรายการซ้ำที่มีอยู่แล้วในแท็บ Bluehost_Logs และ Bluehost_Payments */
function dedupeBluehostSheet() {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const d = dedupeBluehostRows(readTab("bluehost"));
    if (d.dropped.length) { appendDedupeLog(d.dropped, "manual dedupe"); writeTab("bluehost", d.rows); }
    const p = dedupeByKey(readTab("bhpay"), 1);
    if (p.dropped) writeTab("bhpay", p.rows);
    const msg = "Bluehost_Logs: รวมรายการซ้ำ " + d.dropped.length + " แถว (เก็บไว้ใน " + DEDUPE_LOG_TAB + ")\n" +
                "Bluehost_Payments: ลบ Order ซ้ำ " + p.dropped + " แถว";
    try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
    return msg;
  } finally { lock.releaseLock(); }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("IT Dashboard")
    .addItem("ลบรายการซ้ำ Bluehost", "dedupeBluehostSheet")
    .addItem("ดึงข้อมูล BigQuery (IT) ทันที", "syncBigQueryItExpenses")
    .addItem("สร้างแท็บ / หัวตาราง", "setupSheets")
    .addToUi();
}

function appendDedupeLog(dropped, reason) {
  const now = new Date().toISOString();
  appendLogRows(dropped.map(d => [now, reason, d.key].concat(d.row)));
}
function appendLogRows(rows) {
  const sh = sheet(DEDUPE_LOG_TAB), w = DEDUPE_LOG_HEADER.length;
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, w).setValues([DEDUPE_LOG_HEADER]).setFontWeight("bold");
  const clean = rows.map(r => { const o = []; for (let i = 0; i < w; i++) o.push(r && r[i] != null ? String(r[i]) : ""); return o; });
  sh.getRange(sh.getLastRow() + 1, 1, clean.length, w).setNumberFormat("@").setValues(clean);
}

/* =========================================================
   Sheet helpers
   ========================================================= */

/** รันครั้งเดียวจากหน้า Apps Script เพื่อสร้างแท็บและหัวตารางให้ครบ */
function setupSheets() {
  Object.keys(TABS).forEach(key => {
    const sh = sheet(TABS[key]);
    const h = HEADERS[key];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight("bold");
    sh.setFrozenRows(1);
  });
  const log = sheet(DEDUPE_LOG_TAB);
  log.getRange(1, 1, 1, DEDUPE_LOG_HEADER.length).setValues([DEDUPE_LOG_HEADER]).setFontWeight("bold");
  log.setFrozenRows(1);
}

function authorized(t) { return t === TOKEN; }

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** อ่านค่าตามที่แสดงในชีต (เป็นข้อความ) เพื่อไม่ให้วันที่ถูกแปลงเป็นชนิดอื่น */
function readTab(key) {
  const sh = sheet(TABS[key]);
  const width = HEADERS[key].length;
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, width).getDisplayValues().filter(r => r[0] !== "");
}

/** เขียนหัวตาราง ล้างข้อมูลเดิม แล้วเขียนแถวใหม่ทั้งหมด (ตั้งรูปแบบเป็นข้อความก่อน) */
function writeTab(key, rows) {
  const sh = sheet(TABS[key]);
  const h = HEADERS[key], width = h.length;
  sh.getRange(1, 1, 1, width).setValues([h]).setFontWeight("bold");
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, width).clearContent();
  if (rows.length) {
    const clean = rows.map(r => {
      const row = [];
      for (let i = 0; i < width; i++) {
        const v = r && r[i];
        row.push(v === undefined || v === null ? "" : String(v));
      }
      return row;
    });
    sh.getRange(2, 1, clean.length, width).setNumberFormat("@").setValues(clean);
  }
}