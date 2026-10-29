/**
 * Apps Script ที่ผูกกับชีต IT_Billing_Master_Log
 * หน้าที่: ให้ index.html อ่านและบันทึกข้อมูลลงชีตผ่าน Web App
 *
 * วิธีติดตั้ง:
 * 1) เปิดชีต IT_Billing_Master_Log > Extensions > Apps Script
 * 2) วางโค้ดนี้แทนของเดิม แล้วเปลี่ยนค่า TOKEN ด้านล่างเป็นรหัสยาวๆ ของคุณ
 * 3) Deploy > New deployment > Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4) คัดลอก Web app URL ไปวางใน index.html ที่ตัวแปร API_URL
 *    และใส่ TOKEN เดียวกันในตัวแปร API_TOKEN
 *
 * หมายเหตุ: หลังแก้โค้ดต้อง Deploy ใหม่ (Manage deployments > Edit > New version)
 */

const TOKEN = "Qm7vT2xLp9WzRk4HsD1axcsdewsLpOjkGFDXvzgabxcs";
const TABS = { m365: "M365_Logs", gsuite: "GSuite_Logs" };
const HEADER = ["Date", "Invoice ID", "Billing Period", "Total Amount", "Status"];

/** GET ?token=... -> ส่งข้อมูลทั้งสองชีตเป็น JSON */
function doGet(e) {
  if (!authorized(e && e.parameter && e.parameter.token)) return out({ error: "unauthorized" });
  return out({ m365: readTab(TABS.m365), gsuite: readTab(TABS.gsuite) });
}

/** POST (text/plain, JSON) -> เขียนทับข้อมูลในชีตด้วยข้อมูลจากหน้า Dashboard */
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ error: "bad json" }); }
  if (!authorized(body.token)) return out({ error: "unauthorized" });
  writeTab(TABS.m365, body.m365 || []);
  writeTab(TABS.gsuite, body.gsuite || []);
  return out({ ok: true });
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
function readTab(name) {
  const sh = sheet(name);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, HEADER.length).getDisplayValues().filter(r => r[0] !== "");
}

/** เขียนหัวตาราง ล้างข้อมูลเดิม แล้วเขียนแถวใหม่ทั้งหมด (ตั้งรูปแบบเป็นข้อความก่อน) */
function writeTab(name, rows) {
  const sh = sheet(name);
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, HEADER.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, HEADER.length).setNumberFormat("@")
      .setValues(rows.map(r => [0, 1, 2, 3, 4].map(i => String(r[i] === undefined || r[i] === null ? "" : r[i]))));
  }
}