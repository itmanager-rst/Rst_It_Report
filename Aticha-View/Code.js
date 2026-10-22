/**
 * ============================================================================
 *  ริชาวิลล์ เทคโน-ดอนกลาง — Lead Capture (Google Apps Script)
 * ============================================================================
 *  วิธีติดตั้ง
 *   1. เปิด Google Sheet > ส่วนขยาย > Apps Script แล้ววางโค้ดนี้
 *   2. Deploy > New deployment > Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   3. คัดลอก Web app URL ไปใส่ CONFIG.SCRIPT_URL ใน index.html
 *   * ทุกครั้งที่แก้โค้ด ให้ Deploy > Manage deployments > Edit > New version
 *     (URL เดิมจะใช้ต่อได้)
 * ============================================================================
 */

const SHEET_NAME = 'Leads';
const HEADERS = ['Timestamp', 'Name', 'Phone', 'Model', 'Source'];

/** รับข้อมูลจากฟอร์ม (POST JSON) แล้วบันทึกลงชีต */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // กันข้อมูลชนกันเมื่อมีคนส่งพร้อมกัน

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ result: 'error', message: 'No data received' });
    }

    const data = JSON.parse(e.postData.contents);

    // รองรับชื่อฟิลด์ทั้งแบบใหม่และแบบเดิม
    const name  = clean(data.name  || data.fullname);
    const phone = clean(data.phone).replace(/\D/g, '');
    const model = clean(data.model || data.selectedModel || data.interestedModel);
    const source = clean(data.source || 'landing-page');

    if (!name || !/^0\d{8,9}$/.test(phone)) {
      return jsonResponse({ result: 'error', message: 'Invalid name or phone' });
    }

    const sheet = getSheet();
    // ใส่ ' นำหน้าเบอร์โทรเพื่อไม่ให้ Sheets ตัดเลข 0 ข้างหน้า
    sheet.appendRow([new Date(), name, "'" + phone, model, source]);

    return jsonResponse({ result: 'success' });
  } catch (err) {
    return jsonResponse({ result: 'error', message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** เปิด URL ในเบราว์เซอร์เพื่อตรวจว่า Web App ทำงานอยู่ */
function doGet() {
  return jsonResponse({ result: 'ok', service: 'Richa Ville Lead API' });
}

/** หา (หรือสร้าง) ชีต Leads พร้อมหัวตาราง */
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold').setBackground('#0a2540').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  }
  return sheet;
}

/** ตัดช่องว่าง จำกัดความยาว และกัน Formula Injection (=, +, -, @) */
function clean(v) {
  let s = String(v == null ? '' : v).trim().slice(0, 200);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}