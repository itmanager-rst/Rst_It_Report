/**
 * Vehicle-Number-Photo-Survey — Backend (Google Apps Script)
 * ---------------------------------------------------------
 * 1) รัน setupDatabase() ครั้งแรกครั้งเดียว เพื่อสร้างโฟลเดอร์รูปและไฟล์ Google Sheets
 * 2) Deploy เป็น Web app (Execute as: Me, Who has access: Anyone)
 *
 * API
 *   GET  ?action=ping            -> ตรวจสอบการเชื่อมต่อ
 *   GET  ?action=list            -> ดึงข้อมูลทั้งหมด (ใหม่สุดอยู่บน)
 *   POST body(JSON, text/plain)  -> { action:"create", chassisNumber, ownerName,
 *                                     photographerName, notes,
 *                                     photoChassis:"data:image/jpeg;base64,...",
 *                                     photoVehicle:"data:image/jpeg;base64,..." }
 */

const ROOT_FOLDER_ID    = '1PL6TmcxjnPbNoYbNd6itZ84dKurJN_cy';
const PHOTO_FOLDER_NAME = 'Survey_Photos';
const SHEET_FILE_NAME   = 'Vehicle_Survey_DB';
const SHEET_NAME        = 'Data';
const TIMEZONE          = 'Asia/Bangkok';
const MAX_IMAGE_BYTES   = 8 * 1024 * 1024; // กันไฟล์ใหญ่ผิดปกติ (หลังบีบอัดปกติจะเหลือ ~150–400 KB)

const HEADERS = [
  'ID',
  'Timestamp',
  'Chassis_Number',
  'Owner_Name',
  'Photographer_Name',
  'Photo_Chassis_URL',
  'Photo_Vehicle_URL',
  'Notes'
];

/* =========================================================
 * SETUP — กด Run ฟังก์ชันนี้ครั้งแรก (รันซ้ำได้ ไม่สร้างซ้ำ)
 * ========================================================= */
function setupDatabase() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);

  // 1) โฟลเดอร์เก็บรูป
  const folderIt = root.getFoldersByName(PHOTO_FOLDER_NAME);
  const photoFolder = folderIt.hasNext() ? folderIt.next() : root.createFolder(PHOTO_FOLDER_NAME);
  try {
    photoFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    Logger.log('⚠️ ตั้งค่าแชร์โฟลเดอร์ไม่ได้ (บัญชีองค์กรอาจปิดการแชร์ภายนอก): ' + err);
  }

  // 2) ไฟล์ Google Sheets
  let ss;
  const fileIt = root.getFilesByName(SHEET_FILE_NAME);
  if (fileIt.hasNext()) {
    ss = SpreadsheetApp.open(fileIt.next());
  } else {
    ss = SpreadsheetApp.create(SHEET_FILE_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(root);
  }
  ss.setSpreadsheetTimeZone(TIMEZONE);

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.getSheets()[0];
    sheet.setName(SHEET_NAME);
  }

  // Header + รูปแบบคอลัมน์
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setValues([HEADERS])
    .setFontWeight('bold')
    .setBackground('#16243A')
    .setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
  sheet.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('C:C').setNumberFormat('@'); // เก็บเลขตัวถังเป็นข้อความเสมอ
  [180, 150, 200, 200, 160, 280, 280, 260].forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // เก็บ ID ไว้ใช้ใน doGet/doPost
  PropertiesService.getScriptProperties().setProperties({
    PHOTO_FOLDER_ID: photoFolder.getId(),
    SHEET_ID: ss.getId()
  });

  Logger.log('✅ Setup เสร็จแล้ว');
  Logger.log('📁 Survey_Photos : ' + photoFolder.getUrl());
  Logger.log('📊 Vehicle_Survey_DB : ' + ss.getUrl());
}

/* =========================================================
 * GET — ดึงข้อมูล
 * ========================================================= */
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'list';
    if (action === 'ping') return json_({ ok: true, message: 'pong', time: new Date().toISOString() });
    if (action === 'list') return json_({ ok: true, data: listRecords_() });
    return json_({ ok: false, error: 'ไม่รู้จัก action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* =========================================================
 * POST — บันทึกข้อมูล + อัปโหลดรูป
 * หมายเหตุ CORS: ฝั่งหน้าเว็บส่ง Content-Type: text/plain เพื่อไม่ให้เกิด preflight
 * ========================================================= */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('ไม่มีข้อมูลที่ส่งมา');
    const body = JSON.parse(e.postData.contents);
    const action = body.action || 'create';
    if (action !== 'create') throw new Error('ไม่รู้จัก action: ' + action);

    const chassis      = String(body.chassisNumber || '').toUpperCase().replace(/\s+/g, '');
    const owner        = String(body.ownerName || '').trim();
    const photographer = String(body.photographerName || '').trim();
    const notes        = String(body.notes || '').trim();

    if (!chassis)          throw new Error('กรุณากรอกเลขตัวถังรถ');
    if (!owner)            throw new Error('กรุณากรอกชื่อผู้ครอบครอง');
    if (!photographer)     throw new Error('กรุณากรอกชื่อผู้ถ่ายรูป');
    if (!body.photoChassis) throw new Error('ไม่มีรูปเลขตัวถัง');
    if (!body.photoVehicle) throw new Error('ไม่มีรูปตัวรถ');

    lock.waitLock(30000); // กันรหัส ID ซ้ำเมื่อบันทึกพร้อมกันหลายเครื่อง

    const db = getDb_();
    const id = nextId_(db.sheet);
    const safeChassis = chassis.replace(/[^A-Z0-9-]/g, '_');

    const photoChassisUrl = saveImage_(db.folder, body.photoChassis, id + '_' + safeChassis + '_CHASSIS');
    const photoVehicleUrl = saveImage_(db.folder, body.photoVehicle, id + '_' + safeChassis + '_VEHICLE');

    db.sheet.appendRow([
      id,
      new Date(),
      chassis,
      safeText_(owner),
      safeText_(photographer),
      photoChassisUrl,
      photoVehicleUrl,
      safeText_(notes)
    ]);
    SpreadsheetApp.flush();

    return json_({ ok: true, id: id, chassisNumber: chassis, photoChassisUrl: photoChassisUrl, photoVehicleUrl: photoVehicleUrl });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* =========================================================
 * Helpers
 * ========================================================= */
function getDb_() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SHEET_ID');
  const folderId = props.getProperty('PHOTO_FOLDER_ID');
  if (!sheetId || !folderId) throw new Error('ยังไม่ได้รัน setupDatabase() ใน Apps Script');
  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('ไม่พบชีต "' + SHEET_NAME + '" — ลองรัน setupDatabase() อีกครั้ง');
  return { sheet: sheet, folder: DriveApp.getFolderById(folderId) };
}

function listRecords_() {
  const sheet = getDb_().sheet;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getDisplayValues();
  return rows
    .filter(r => r[0])
    .map(r => {
      const obj = {};
      HEADERS.forEach((h, i) => { obj[h] = r[i]; });
      return obj;
    })
    .reverse(); // ใหม่สุดอยู่บน
}

/** รหัส SURV-YYYYMMDD-XXXX นับใหม่ทุกวัน */
function nextId_(sheet) {
  const prefix = 'SURV-' + Utilities.formatDate(new Date(), TIMEZONE, 'yyyyMMdd') + '-';
  const lastRow = sheet.getLastRow();
  let max = 0;
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = String(ids[i][0]);
      if (id.indexOf(prefix) === 0) {
        const n = parseInt(id.slice(prefix.length), 10);
        if (n > max) max = n;
      }
    }
  }
  return prefix + String(max + 1).padStart(4, '0');
}

/** แปลง Data URL (Base64) เป็นไฟล์ใน Drive แล้วคืน Direct Image Link */
function saveImage_(folder, dataUrl, baseName) {
  const str = String(dataUrl);
  const comma = str.indexOf(',');
  const header = str.slice(0, comma);
  const match = header.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64$/);
  if (comma < 0 || !match) throw new Error('รูปแบบรูปภาพไม่ถูกต้อง');

  const mime = match[1];
  const bytes = Utilities.base64Decode(str.slice(comma + 1));
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('ไฟล์รูปใหญ่เกินกำหนด');

  const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
  const file = folder.createFile(Utilities.newBlob(bytes, mime, baseName + '.' + ext));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    Logger.log('⚠️ ตั้งค่าแชร์ไฟล์ไม่ได้: ' + err);
  }
  // Direct image link ใช้กับ <img src> ได้ทันที
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

/** กันข้อความที่ขึ้นต้นด้วย = + - @ ไม่ให้ Sheets ตีความเป็นสูตร */
function safeText_(text) {
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}