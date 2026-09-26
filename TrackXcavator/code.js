// ==========================================
// CONFIGURATION & HELPER FUNCTIONS
// ==========================================
const BQ_PROJECT_ID = 'trackxcavator';
const BQ_DATASET_ID = 'ExcavatorsDB';

// ==========================================
// GOOGLE SHEET (ฐานข้อมูลจริงสำหรับการเขียน/แก้/ลบ)
// ==========================================
// 👉 ใส่ Spreadsheet ID ของ Google Sheet ที่จะใช้เป็นฐานข้อมูล (เอาจาก URL ของ Sheet)
// ตัวอย่าง URL: https://docs.google.com/spreadsheets/d/1AbCdEfGhIjK.../edit
//                                                    ↑ ตรงนี้คือ SHEET_ID
const SHEET_ID = '1NmRPToToQEo4b2ikARQilMId_3ZjaQcT0XXHfq98ueM';

// ชื่อแท็บ (sheet tab) ในไฟล์ ต้องตรงกับชื่อตาราง BigQuery ที่จะสร้างเป็น External Table
const SHEET_TABS = {
  users: 'users',
  service_report: 'service_report',
  pm_log: 'pm_log',
  modelpart: 'modelpart'
};

// ==========================================
// รูปใบเสร็จ/ใบรับอะไหล่ (เก็บเป็นไฟล์ใน Google Drive แทน Base64 ในเซลล์)
// ==========================================
// Sheets จำกัด 1 เซลล์ไม่เกิน 50,000 ตัวอักษร แต่รูป Base64 ยาวเป็นแสนตัวอักษร
// จึงต้องอัปโหลดรูปขึ้น Drive แล้วเก็บแค่ "ลิงก์" (สั้น) ไว้ในเซลล์แทน
const RECEIPT_DRIVE_FOLDER_NAME = 'PM_Receipts_TrackXcavator';

/**
 * หา/สร้างโฟลเดอร์ปลายทางสำหรับเก็บรูปใบเสร็จ (แคชไว้ไม่ต้องค้นหาซ้ำทุกครั้ง)
 */
function getOrCreateReceiptFolder() {
  var props = PropertiesService.getScriptProperties();
  var cachedId = props.getProperty('RECEIPT_FOLDER_ID');
  if (cachedId) {
    try { return DriveApp.getFolderById(cachedId); } catch (e) { /* โฟลเดอร์เดิมหาย ให้สร้างใหม่ */ }
  }
  var folders = DriveApp.getFoldersByName(RECEIPT_DRIVE_FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(RECEIPT_DRIVE_FOLDER_NAME);
  props.setProperty('RECEIPT_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * แปลงรูป Base64 (Data URI เช่น "data:image/jpeg;base64,....") ให้เป็นไฟล์ใน Drive
 * แล้วคืนค่าเป็นลิงก์รูปที่ใช้แสดงผลตรงๆ ผ่าน <img src="..."> ได้ (uc?export=view)
 */
function saveReceiptImageToDrive(dataUri, fileNameHint) {
  var match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUri);
  if (!match) return dataUri; // ไม่ใช่ base64 image ก็คืนค่าเดิม (เผื่อเป็น URL อยู่แล้ว)

  var mimeType = match[1];
  var base64Data = match[2];
  var ext = mimeType.split('/')[1] || 'jpg';
  var safeName = String(fileNameHint || 'receipt').replace(/[^a-zA-Z0-9ก-๙_-]/g, '_');
  var fileName = safeName + '_' + new Date().getTime() + '.' + ext;

  var bytes = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(bytes, mimeType, fileName);

  var folder = getOrCreateReceiptFolder();
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

/**
 * ใช้ตอนจะบันทึกฟิลด์ receipt_image: ถ้าเป็น Base64 ให้แปลงเป็นลิงก์ Drive อัตโนมัติ
 * ถ้าเป็นค่าว่างหรือเป็นลิงก์อยู่แล้ว ก็คืนค่าเดิม
 */
function resolveReceiptImage(value, fileNameHint) {
  if (!value) return value;
  var str = String(value).trim();
  if (str.indexOf('data:image') === 0) {
    try {
      return saveReceiptImageToDrive(str, fileNameHint);
    } catch (e) {
      Logger.log('อัปโหลดรูปขึ้น Drive ไม่สำเร็จ (' + fileNameHint + '): ' + e.toString());
      return value; // ถ้าอัปโหลดไม่สำเร็จ ให้คงค่าเดิมไว้ก่อน (กันข้อมูลหาย)
    }
  }
  return value;
}

/**
 * ดึงค่าฟิลด์จาก object แบบไม่สนตัวพิมพ์เล็ก-ใหญ่ของชื่อคีย์
 * ใช้ได้ทั้งกับแถวที่มาจาก BigQuery (runBigQuery) และแถวจาก Google Sheet (sheetToObjects)
 * เพราะชื่อคอลัมน์จริงในชีตอาจเป็น "Machine_ID" แต่โค้ดเรียกด้วย "machine_id"
 */
function ciGet(row, fieldName) {
  if (!row) return undefined;
  var target = String(fieldName).toLowerCase();
  for (var key in row) {
    if (key !== '__row' && key.toLowerCase() === target) {
      return row[key];
    }
  }
  return undefined;
}

/**
 * เปิด Sheet tab ตามชื่อที่กำหนด
 */
function getSheet(tabName) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(tabName);
  if (!sh) throw new Error('ไม่พบแท็บชื่อ "' + tabName + '" ใน Google Sheet (SHEET_ID: ' + SHEET_ID + ')');
  return sh;
}

/**
 * แปลงข้อมูลทั้งชีตเป็น Array of Objects โดยอ้างอิง Header แถวแรก
 * แต่ละ object จะมี __row เก็บเลขแถวจริงไว้ใช้ update/delete
 */
function sheetToObjects(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (headers[c]) obj[headers[c]] = data[i][c];
    }
    obj.__row = i + 1; // แถวจริงใน Sheet (แถวที่ 1 คือ Header)
    rows.push(obj);
  }
  return rows;
}

/**
 * กรองแถวที่ตรงเงื่อนไขจาก Sheet
 */
function findRows(sheet, matchFn) {
  return sheetToObjects(sheet).filter(matchFn);
}

/**
 * อัปเดตค่าบางคอลัมน์ในแถวที่ระบุ (rowNumber = เลขแถวจริงใน Sheet, นับรวม Header)
 * จับคู่ชื่อคอลัมน์แบบไม่สนตัวพิมพ์เล็ก-ใหญ่ (เช่น key "machine_id" จะจับคู่กับ Header "Machine_ID" ได้)
 */
function updateRowByObject(sheet, rowNumber, updates) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var updatesLower = {};
  Object.keys(updates).forEach(function (k) { updatesLower[k.toLowerCase()] = k; });

  headers.forEach(function (h, idx) {
    if (!h) return;
    var matchKey = updatesLower[String(h).toLowerCase()];
    if (matchKey !== undefined && updates[matchKey] !== undefined) {
      sheet.getRange(rowNumber, idx + 1).setValue(updates[matchKey]);
    }
  });
}

/**
 * เพิ่มแถวใหม่ต่อท้าย Sheet ตามลำดับ Header ที่มีอยู่
 * จับคู่ชื่อคอลัมน์แบบไม่สนตัวพิมพ์เล็ก-ใหญ่เช่นเดียวกับ updateRowByObject
 */
function appendRowByObject(sheet, obj) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var objLower = {};
  Object.keys(obj).forEach(function (k) { objLower[k.toLowerCase()] = k; });

  var newRow = headers.map(function (h) {
    if (!h) return '';
    var matchKey = objLower[String(h).toLowerCase()];
    return (matchKey !== undefined && obj[matchKey] !== undefined) ? obj[matchKey] : '';
  });
  sheet.appendRow(newRow);
}

/**
 * ลบหลายแถวพร้อมกัน (ลบจากแถวล่างขึ้นบนเพื่อไม่ให้เลขแถวเพี้ยนระหว่างลบ)
 */
function deleteRows(sheet, rowNumbers) {
  var sorted = rowNumbers.slice().sort(function (a, b) { return b - a; });
  sorted.forEach(function (r) { sheet.deleteRow(r); });
}

/**
 * ฟังก์ชันกลางสำหรับส่ง SQL Query ไปยัง BigQuery
 * แก้ไขป้องกันปัญหา TypeError: is not an iterable or ArrayLike
 */
function runBigQuery(sqlQuery) {
  const request = {
    query: sqlQuery,
    useLegacySql: false
  };

  try {
    let queryResults = BigQuery.Jobs.query(request, BQ_PROJECT_ID);
    const jobId = queryResults.jobReference.jobId;

    let sleepTime = 200;
    while (!queryResults.jobComplete) {
      Utilities.sleep(sleepTime);
      queryResults = BigQuery.Jobs.getQueryResults(BQ_PROJECT_ID, jobId);
      if (sleepTime < 1000) sleepTime += 200; // Exponential backoff
    }

    // ตรวจสอบเช็กความปลอดภัย หากเป็นคำสั่ง INSERT/UPDATE/DELETE หรือไม่มีข้อมูลตอบกลับ
    if (!queryResults || !queryResults.rows || !queryResults.schema || !queryResults.schema.fields) {
      return [];
    }

    const rows = queryResults.rows;
    const fields = queryResults.schema.fields;

    // ดึงรายชื่อ Header แบบปลอดภัย
    const headers = [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i] && fields[i].name) {
        headers.push(fields[i].name);
      }
    }

    // แปลงผลลัพธ์เป็น Array of Objects
    const result = [];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var item = {};
      if (row && row.f && Array.isArray(row.f)) {
        for (var c = 0; c < row.f.length; c++) {
          var cell = row.f[c];
          var headerName = headers[c];
          if (headerName) {
            item[headerName] = (cell && cell.v !== null && cell.v !== undefined) ? cell.v : null;
          }
        }
      }
      result.push(item);
    }

    return result;

  } catch (error) {
    Logger.log('BigQuery Error: ' + error.toString());
    throw new Error('BigQuery Exec Error: ' + error.message);
  }
}

/**
 * Helper Function ส่งคืนค่า JSON หรือ Object แบบ Dynamic
 * รองรับทั้งการเรียกผ่าน Web App Fetch (CORS HTTP) และ google.script.run
 */
function responseJSON(data, isRawObject) {
  if (isRawObject) {
    return data;
  }
  var out = ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
  try {
    out.setHeader && out.setHeader('Access-Control-Allow-Origin', '*');
    out.setHeader && out.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    out.setHeader && out.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  } catch (e) {
    // setHeader may not be available in some runtimes; ignore if so
  }
  return out;
}

// Basic handler for preflight OPTIONS requests (may be invoked by the runtime)
function doOptions(e) {
  var out = ContentService.createTextOutput('').setMimeType(ContentService.MimeType.JSON);
  try {
    out.setHeader && out.setHeader('Access-Control-Allow-Origin', '*');
    out.setHeader && out.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    out.setHeader && out.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  } catch (err) {
    // ignore
  }
  return out;
}

/**
 * Helper ฟังก์ชันสำหรับ Safe Escape SQL String
 */
function escapeSql(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function tableHasColumn(tableName, columnName) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'schema_' + tableName + '_' + columnName;
  var cached = cache.get(cacheKey);
  if (cached !== null) return cached === '1';

  var sql = `SELECT COUNT(1) AS total
             FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.INFORMATION_SCHEMA.COLUMNS\`
             WHERE table_name = '${escapeSql(tableName)}'
               AND column_name = '${escapeSql(columnName)}'`;
  var rows = runBigQuery(sql);
  var exists = rows.length > 0 && Number(rows[0].total) > 0;
  cache.put(cacheKey, exists ? '1' : '0', 21600);
  return exists;
}

// ==========================================
// WEB APP ENTRY POINTS (doGet / doPost)
// ==========================================

function doGet(e) {
  try {
    var action = e ? e.parameter.action : "";

    if (action === "getReceiptImage") {
      return getReceiptImageData(e.parameter.fileId);
    }

    if (action === "getDashboard") {
      return getDashboardData();
    } else if (action === "getReportList") {
      return getReportList();
    } else if (action === "getPMProgressMatrix") {
      return getPMProgressMatrix();
    } else if (action === "getModelParts") {
      return getModelParts(e.parameter.model);
    } else if (action === "getModels") {
      return getModels();
    } else if (action === "detectPmLogSwaps") {
      return detectPmLogSwaps();
    }
    
    // หากไม่มี action ระบุมา ให้แสดงผลหน้า index.html ของ Web App
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('ระบบฐานข้อมูลรถขุด - ติดตามสถานะและบันทึกใบงาน PM')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');

  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

function doPost(e) {
  try {
    var data = {};
    if (e && e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      data = e.parameter;
    }

    var action = data.action;

    if (action === "verifyLogin" || action === "login") {
      return verifyLogin(data.username, data.password);
    } else if (action === "getDashboard") {
      return getDashboardData();
    } else if (action === "getReportList") {
      return getReportList();
    } else if (action === "getPMProgressMatrix") {
      return getPMProgressMatrix();
    } else if (action === "getModelParts") {
      return getModelParts(data.model);
    } else if (action === "getModels") {
      return getModels();
    } else if (action === "getReceiptImage") {
      return getReceiptImageData(data.fileId);
    } else if (action === "insertTicket") {
      return insertOrUpdateTicket(data);
    } else if (action === "claimCoupon") {
      return claimCoupon(data);
    } else if (action === "updatePartsStatus") {
      return updatePartsStatus(data);
    } else if (action === "updatePendingPartsByRound") {
      return updatePendingPartsByRound(data);
    } else if (action === "updatePmLog") {
      return updatePmLog(data);
    } else if (action === "approveMachine") {
      return approveMachine(data.machineId);
    } else if (action === "deleteDashboard") {
      return deleteDashboard(data.machineId);
    } else if (action === "deleteReport") {
      return deleteReport(data.ticketId, false, data.machineId, data.pmRound);
    } else if (action === "detectPmLogSwaps") {
      return detectPmLogSwaps();
    } else if (action === "fixPmLogSwaps") {
      return fixPmLogSwaps(data);
    }

    return responseJSON({ status: "error", message: "Unknown action" });

  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

/**
 * Entry point สำหรับหน้า HTML ที่รันอยู่ใน Apps Script โดยตรง
 * คืนค่าเป็น object ธรรมดาเพื่อให้ google.script.run รับผลลัพธ์ได้
 * และหลีกเลี่ยงปัญหา CORS/redirect ของ fetch ตอนบันทึกข้อมูล
 */
function apiRequest(data) {
  var output = doPost({
    postData: { contents: JSON.stringify(data || {}) },
    parameter: data || {}
  });

  if (!output) {
    return { status: 'error', message: 'Invalid response from server' };
  }

  // หากอยู่ในรูปแบบ TextOutput (จากการเรียกผ่าน Web App) ให้แปลงกลับเป็น JSON Object
  if (typeof output.getContent === 'function') {
    try {
      return JSON.parse(output.getContent());
    } catch (err) {
      return { status: 'error', message: 'Invalid JSON response: ' + err.toString() };
    }
  }

  // หากถูกส่งคืนเป็น JS Object โดยตรง
  return output;
}

// ==========================================
// 1. ตรวจสอบ Login (ครอบ Backtick คำสงวน user/password)
// ==========================================
function verifyLogin(username, password, isRawObject) {
  try {
    var inputUser = String(username || '').trim();
    var inputPass = String(password || '').trim();

    // ฟังก์ชันช่วยดึงค่าฟิลด์แบบไม่สนตัวพิมพ์เล็ก-ใหญ่ของชื่อคอลัมน์
    // (เผื่อ Header ในชีตเป็น "User"/"Password"/"Role" แทนที่จะเป็นตัวเล็กล้วน)
    function getField(row, fieldName) {
      var target = fieldName.toLowerCase();
      for (var key in row) {
        if (key !== '__row' && key.toLowerCase() === target) {
          return row[key];
        }
      }
      return undefined;
    }

    // อ่านจาก Google Sheet โดยตรง (ไม่ผ่าน BigQuery) เพื่อเลี่ยงปัญหา BigQuery เดา Type ผิด
    // (เช่น รหัสผ่านตัวเลขล้วนโดนตีความเป็น NUMBER แล้วตัดเลข 0 ข้างหน้าทิ้ง)
    var sheet = getSheet(SHEET_TABS.users);
    var rows = findRows(sheet, function (r) {
      var sheetUser = String(getField(r, 'user') || '').trim();
      var sheetPass = String(getField(r, 'password') || '').trim();
      return sheetUser.toLowerCase() === inputUser.toLowerCase() && sheetPass === inputPass;
    });

    if (rows.length > 0) {
      var foundUser = rows[0];
      var userRole = getField(foundUser, 'role') || "admin";
      var userVal = getField(foundUser, 'user') || inputUser;

      return responseJSON({
        status: "success",
        success: true,
        user: {
          username: userVal,
          user: userVal,
          role: userRole
        },
        username: userVal,
        role: userRole
      }, isRawObject);
    } else {
      return responseJSON({
        status: "error",
        success: false,
        message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'
      }, isRawObject);
    }
  } catch (e) {
    return responseJSON({
      status: "error",
      success: false,
      message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ: ' + e.toString()
    }, isRawObject);
  }
}

// ==========================================
// 2. ดึงข้อมูล ตารางสถานะเครื่องจักร (Service_Report)
// ==========================================
function getDashboardData(isRawObject) {
  try {
    var sql = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\``;
    var rows = runBigQuery(sql);

    var alerts = [];
    var pmAlertCount = 0;
    var incompleteInvoiceCount = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var machineId = String(ciGet(row, 'machine_id') || "").trim();

      // ข้ามแถวว่างเปล่า (แถวว่างส่วนเกินที่ติดมาจาก Google Sheet ไม่ใช่ข้อมูลเครื่องจักรจริง)
      if (!machineId) continue;

      var hrs = Number(ciGet(row, 'current_hours')) || 0;
      var lastPm = Number(ciGet(row, 'last_pm_round')) || 0;
      var nextPm = Number(ciGet(row, 'next_pm_round')) || 0;
      var pStatus = String(ciGet(row, 'parts_status') || "ส่งครบแล้ว").trim();

      if (nextPm > 0 && (nextPm - hrs <= 50)) {
        pmAlertCount++;
      }

      if (pStatus === "ส่งบางส่วน" || pStatus === "ค้างส่งอะไหล่") {
        incompleteInvoiceCount++;
      }

      alerts.push({
        machineId: machineId,
        machine_id: machineId,
        model: ciGet(row, 'model') || "",
        customer: ciGet(row, 'customer') || "",
        customerName: ciGet(row, 'customer') || "",
        customerId: ciGet(row, 'customer_id') || "",
        customer_id: ciGet(row, 'customer_id') || "",
        phone: ciGet(row, 'phone_number') || "",
        phone_number: ciGet(row, 'phone_number') || "",
        contractDate: ciGet(row, 'contract_date') || "",
        contract_date: ciGet(row, 'contract_date') || "",
        currentHours: hrs,
        current_Hours: hrs,
        lastPm: lastPm,
        last_pm_round: lastPm,
        nextPm: nextPm,
        next_pm_round: nextPm,
        status: ciGet(row, 'status') || "Approved",
        updatedBy: ciGet(row, 'updated_by') || "",
        updated_by: ciGet(row, 'updated_by') || "",
        partsStore: ciGet(row, 'parts_store') || "",
        parts_store: ciGet(row, 'parts_store') || "",
        supplierId: ciGet(row, 'supplier_id') || "-",
        supplier_id: ciGet(row, 'supplier_id') || "-",
        partsBillNo: ciGet(row, 'parts_bill_no') || "",
        parts_bill_no: ciGet(row, 'parts_bill_no') || "",
        partsStatus: pStatus,
        parts_status: pStatus,
        receiptImage: ciGet(row, 'receipt_image') || "",
        receipt_image: ciGet(row, 'receipt_image') || "",
        yanmarCoupon: Number(ciGet(row, 'yanmar_coupon')) || 0,
        yanmar_coupon: Number(ciGet(row, 'yanmar_coupon')) || 0,
        remark: ciGet(row, 'remark') || "",
        updatedAt: ciGet(row, "updated_at") || ""
      });
    }

    return responseJSON({
      status: "success",
      pmAlerts: alerts,
      pmAlertCount: pmAlertCount,
      incompleteInvoiceCount: incompleteInvoiceCount
    }, isRawObject);
  } catch (e) {
    return responseJSON({ 
      status: "error", 
      pmAlerts: [], 
      pmAlertCount: 0, 
      incompleteInvoiceCount: 0, 
      message: e.toString() 
    }, isRawObject);
  }
}

// ==========================================
// 3. ดึงข้อมูล ประวัติทำ PM (PM_Log) - พร้อมระบบตรวจสอบความถูกต้อง
// ==========================================
function getReportList(isRawObject) {
  try {
    var sql = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\``;
    var rows = runBigQuery(sql);
    var result = [];

    // pm_log ไม่มีคอลัมน์เบอร์โทรศัพท์เก็บไว้ ต้องดึงมาจาก service_report แทน (จับคู่ด้วย machine_id)
    var phoneByMachineId = {};
    try {
      var dashRows = runBigQuery(`SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\``);
      dashRows.forEach(function (dr) {
        var mid = String(ciGet(dr, 'machine_id') || '').trim().toLowerCase();
        if (mid) phoneByMachineId[mid] = ciGet(dr, 'phone_number') || '';
      });
    } catch (e) {
      // ถ้าดึง service_report ไม่สำเร็จ ก็ปล่อยเบอร์โทรว่างไว้ ไม่ต้องหยุดการทำงาน
    }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];

      var mId = ciGet(row, 'machine_id') || "";
      // ข้ามแถวว่างเปล่า (แถวว่างส่วนเกินที่ติดมาจาก Google Sheet ไม่ใช่ข้อมูลจริง)
      if (!String(mId).trim()) continue;

      var tId = ciGet(row, 'ticket_id') || ciGet(row, 'no') || ("TK-" + (i + 1));
      var mdl = ciGet(row, 'model') || "";

      var rawCustomer = String(ciGet(row, 'customer') || "").trim();
      var rawCustomerId = String(ciGet(row, 'customer_id') || "").trim();
      var rawPhone = String(ciGet(row, 'phone_number') || "").trim();
      if (!rawPhone) {
        rawPhone = String(phoneByMachineId[String(mId).trim().toLowerCase()] || '').trim();
      }

      var finalCustomerName = rawCustomer;
      var finalCustomerId = rawCustomerId;
      var finalPhone = rawPhone;

      // เช็กสลับคอลัมน์: ถ้า customer เก็บชื่อรุ่นรถ แล้ว customer_id เก็บชื่อลูกค้า
      if (rawCustomer.indexOf("รถขุด") !== -1 || rawCustomer.indexOf("OLD-") !== -1) {
        finalCustomerName = rawCustomerId;
        finalCustomerId = rawPhone;
        finalPhone = "-";
      }

      // ดึงค่าวันที่และรอบ PM (pm_log ใช้ชื่อคอลัมน์ Service_Date / PM_Target / Actual_Hours จริง)
      var rawDate = String(ciGet(row, 'service_date') || "").trim();
      var rawPmRound = String(ciGet(row, 'pm_target') || "").trim();

      // ตรวจสอบข้อมูลสลับช่องกันแบบอัตโนมัติ (เผื่อข้อมูลเก่าค้าง)
      var serviceDateVal = rawDate;
      var pmRoundVal = Number(rawPmRound) || 0;

      if (_looksLikeDate(rawPmRound)) {
        serviceDateVal = rawPmRound;
        pmRoundVal = Number(rawDate) || 0;
      }

      // กรองวันที่เริ่มต้น Default 2000-01-01 หรือค่าว่างให้เป็น '-'
      if (!serviceDateVal || serviceDateVal === "" || serviceDateVal.indexOf("2000-01-01") === 0) {
        serviceDateVal = "-";
      }

      result.push({
        no: ciGet(row, 'no') || (i + 1),
        ticketId: tId,
        ticket_id: tId,
        machineId: mId,
        machine_id: mId,
        model: mdl,
        customerName: finalCustomerName,
        customer: finalCustomerName,
        customerId: finalCustomerId,
        customer_id: finalCustomerId,
        phone: finalPhone,
        phone_number: finalPhone,
        pmRound: pmRoundVal,
        last_pm_round: pmRoundVal,
        actualHours: Number(ciGet(row, 'actual_hours')) || 0,
        current_Hours: Number(ciGet(row, 'actual_hours')) || 0,
        serviceDate: serviceDateVal,
        contract_date: serviceDateVal,
        cost: Number(ciGet(row, 'cost')) || 0,
        invoiceNo: ciGet(row, 'invoice_no') || ciGet(row, 'parts_bill_no') || "-",
        supplierId: ciGet(row, 'supplier_id') || "-",
        partsStore: ciGet(row, 'parts_store') || "-",
        parts_store: ciGet(row, 'parts_store') || "-",
        partsBillNo: ciGet(row, 'parts_bill_no') || "NA",
        parts_bill_no: ciGet(row, 'parts_bill_no') || "NA",
        partsStatus: ciGet(row, 'parts_status') || "ส่งครบแล้ว",
        parts_status: ciGet(row, 'parts_status') || "ส่งครบแล้ว",
        receiptImage: ciGet(row, 'receipt_image') || "",
        receipt_image: ciGet(row, 'receipt_image') || "",
        yanmarCoupon: Number(ciGet(row, 'yanmar_coupon')) || 0,
        yanmar_coupon: Number(ciGet(row, 'yanmar_coupon')) || 0,
        remark: ciGet(row, 'remark') || "",
        updatedAt: ciGet(row, "updated_at") || ""
      });
    }

    return responseJSON(result, isRawObject);
  } catch (e) {
    return responseJSON([], isRawObject);
  }
}

// ==========================================
// กติกากลางของ pm_log (log ซ้ำได้): เวลาจะใช้ข้อมูล "รายรอบ" ให้ใช้แถวล่าสุดแถวเดียว
// ==========================================
function pmLogTime(val) {
  if (!val) return 0;
  if (val instanceof Date) return val.getTime();
  var t = new Date(String(val).trim().replace(' ', 'T')).getTime();
  return isNaN(t) ? 0 : t;
}

// เลือกแถวล่าสุดจากผล findRows: updated_at ใหม่สุดก่อน ถ้าเท่ากัน/ไม่มี ใช้แถวล่างสุดใน Sheet
function pickLatestLogRow(rows) {
  if (!rows || rows.length === 0) return null;
  return rows.slice().sort(function (a, b) {
    var d = pmLogTime(ciGet(b, 'updated_at')) - pmLogTime(ciGet(a, 'updated_at'));
    return d !== 0 ? d : (b.__row - a.__row);
  })[0];
}

// ==========================================
// 3.1 ดึงข้อมูล PM Progress Matrix (ปรับปรุง Logic ดึงประวัติย้อนหลัง)
// ==========================================
function getPMProgressMatrix(isRawObject) {
  try {
    var sqlService = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\``;
    // pm_log ใช้คอลัมน์ PM_Target / Actual_Hours / Service_Date (ไม่ใช่ last_pm_round / current_Hours / contract_date)
    // ใช้ SELECT * + ciGet เพื่อไม่ผูกกับตัวพิมพ์เล็ก-ใหญ่ของชื่อคอลัมน์
    var sqlLogs = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\``;
    
    var services = runBigQuery(sqlService);
    var logs = runBigQuery(sqlLogs);

    // งาน PM ที่บันทึกแล้วอาจยังไม่จบ workflow หากยังค้างคูปองหรืออะไหล่
    function getWorkflowStatuses(partsStatus, yanmarCoupon, partsStore, partsBillNo) {
      var statuses = [];
      var normalizedPartsStatus = String(partsStatus || "").trim();
      var couponAmount = Number(String(yanmarCoupon || 0).replace(/,/g, "")) || 0;
      var normalizedPartsStore = String(partsStore || "").trim();
      var normalizedPartsBillNo = String(partsBillNo || "").trim().toUpperCase();
      var hasPendingParts = normalizedPartsStatus === "ส่งบางส่วน" || normalizedPartsStatus === "ค้างส่งอะไหล่";
      var hasPartsList = normalizedPartsStore !== "" && normalizedPartsStore !== "-";
      var hasPartsBill = normalizedPartsBillNo !== "" && normalizedPartsBillNo !== "-" && normalizedPartsBillNo !== "NA";
      var hasCouponEntitlement = normalizedPartsStatus !== "ไม่ได้เบิกอะไหล่" &&
        (hasPendingParts || hasPartsList || hasPartsBill);

      if (hasPendingParts) {
        statuses.push("ค้างอะไหล่");
      }
      // ข้อมูลเก่าที่ไม่มีรายการ/บิล/สถานะค้างยังยืนยันสิทธิ์คูปองไม่ได้
      if (couponAmount <= 0 && hasCouponEntitlement) {
        statuses.push("ค้างคูปอง");
      }

      return statuses.length > 0 ? statuses : ["เสร็จสิ้น"];
    }

    // Map ข้อมูลรอบ PM Log เข้ากับตัวเครื่อง
    // pm_log เป็น log → เครื่อง+รอบเดียวกันมีหลายแถวได้ ใช้ "แถวล่าสุด" (updated_at ใหม่สุด, เท่ากันใช้แถวที่มาทีหลัง)
    var pmRoundsMap = {};
    var pmRoundsTime = {};
    if (Array.isArray(logs)) {
      logs.forEach(function(l, idx) {
        var mId = String(ciGet(l, 'machine_id') || "").trim().toLowerCase();
        var round = Number(ciGet(l, 'pm_target')) || 0;
        if (!mId || round <= 0) return;
        var t = pmLogTime(ciGet(l, 'updated_at'));
        var key = mId + '|' + round;
        if (pmRoundsTime[key] !== undefined && t < pmRoundsTime[key]) return;
        pmRoundsTime[key] = t;
        if (!pmRoundsMap[mId]) pmRoundsMap[mId] = {};
        pmRoundsMap[mId][round] = {
          completed: true,
          actualHours: Number(ciGet(l, 'actual_hours')) || 0,
          date: ciGet(l, 'service_date') || "",
          statuses: getWorkflowStatuses(ciGet(l, 'parts_status'), ciGet(l, 'yanmar_coupon'), ciGet(l, 'parts_store'), ciGet(l, 'parts_bill_no'))
        };
      });
    }

    var matrixData = Array.isArray(services) ? services.filter(function(s) {
      return String(ciGet(s, 'machine_id') || "").trim() !== "";
    }).map(function(s) {
      var mId = String(ciGet(s, 'machine_id') || "").trim();
      var mIdKey = mId.toLowerCase();
      var hrs = Number(ciGet(s, 'current_hours')) || 0;
      var lastPm = Number(ciGet(s, 'last_pm_round')) || 0;
      var roundsHistory = pmRoundsMap[mIdKey] || {};

      // รอบ PM มาตรฐาน
      var pmCheckpoints = [50, 250, 500, 750, 1000, 1250, 1500, 1750, 2000];
      var matrix = {};

      pmCheckpoints.forEach(function(cp) {
        // Priority 1: เช็กประวัติที่มีใน pm_log ก่อนเป็นอันดับแรก (ป้องกันการข้ามรอบ)
        if (roundsHistory[cp]) {
          matrix[cp] = roundsHistory[cp].statuses;
        } 
        // Priority 2: ถ้าตรงกับรอบล่าสุดใน service_report
        else if (cp === lastPm && lastPm > 0) {
          matrix[cp] = getWorkflowStatuses(ciGet(s, 'parts_status'), ciGet(s, 'yanmar_coupon'), ciGet(s, 'parts_store'), ciGet(s, 'parts_bill_no'));
        } 
        // Priority 3: ถ้าชั่วโมงถึงรอบแล้วแต่ยังไม่มี Log ให้ขึ้น 'เข้าบริการ'
        else if (hrs >= cp) {
          matrix[cp] = ["เข้าบริการ"];
        } 
        // Priority 4: ยังไม่ถึงรอบ
        else {
          matrix[cp] = ["รอดำเนินการ"];
        }
      });

      return {
        machine_id: mId,
        machineId: mId,
        model: ciGet(s, 'model') || "",
        customer: ciGet(s, 'customer') || "",
        current_Hours: hrs,
        currentHours: hrs,
        last_pm_round: lastPm,
        lastPm: lastPm,
        matrix: matrix,
        pm50: matrix[50],
        pm250: matrix[250],
        pm500: matrix[500],
        pm750: matrix[750],
        pm1000: matrix[1000]
      };
    }) : [];

    return responseJSON({ status: "success", data: matrixData }, isRawObject);
  } catch (e) {
    return responseJSON({ status: "error", data: [], message: e.toString() }, isRawObject);
  }
}

// ==========================================
// 3.2 ดึงรายการอะไหล่ตามรุ่นรถ (สำหรับหน้าฟอร์มบันทึกใบงาน PM)
// ==========================================
function getModelParts(model, isRawObject) {
  try {
    var safeModel = escapeSql(model);
    if (!safeModel.trim()) return responseJSON({ status: "success", data: [] }, isRawObject);

    var sql = `SELECT DISTINCT partno, maintenanceparts
               FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.modelpart\`
              WHERE LOWER(TRIM(model)) = LOWER(TRIM('${safeModel}'))
                OR LOWER(TRIM('${safeModel}')) LIKE CONCAT(LOWER(TRIM(model)), '%')
                OR (LOWER(TRIM(model)) LIKE CONCAT(LOWER(TRIM('${safeModel}')), '%')
                   AND (NULLIF(TRIM(partno), '') IS NOT NULL
                     OR NULLIF(TRIM(maintenanceparts), '') IS NOT NULL))
               ORDER BY maintenanceparts, partno`;
    var rows = runBigQuery(sql).map(function (row) {
      return {
        partNo: String(ciGet(row, 'partno') || '').trim(),
        maintenancePart: String(ciGet(row, 'maintenanceparts') || '').trim()
      };
    }).filter(function (row) {
      return row.partNo || row.maintenancePart;
    });

    return responseJSON({ status: "success", data: rows }, isRawObject);
  } catch (e) {
    return responseJSON({ status: "error", data: [], message: e.toString() }, isRawObject);
  }
}

/**
 * ส่งรูปใบเสร็จกลับเป็น Base64 (data URI) ผ่านช่องทาง RPC ปกติ (ไม่ใช่หน้าเว็บแยก)
 * เพราะ doGet คืนไฟล์ Blob ตรงๆ ไม่ได้ (Apps Script ไม่รองรับ) และ Google บล็อกการฝังลิงก์ Drive ตรงๆ ใน <img>
 */
function getReceiptImageData(fileId, isRawObject) {
  try {
    if (!fileId) return responseJSON({ status: "error", message: "ไม่พบรหัสไฟล์รูป" }, isRawObject);
    var blob = DriveApp.getFileById(fileId).getBlob();
    var base64 = Utilities.base64Encode(blob.getBytes());
    var mimeType = blob.getContentType() || 'image/jpeg';
    return responseJSON({ status: "success", dataUri: 'data:' + mimeType + ';base64,' + base64 }, isRawObject);
  } catch (e) {
    return responseJSON({ status: "error", message: e.toString() }, isRawObject);
  }
}

function getModels(isRawObject) {
  try {
    var sql = `SELECT DISTINCT TRIM(model) AS model
               FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.modelpart\`
               WHERE NULLIF(TRIM(model), '') IS NOT NULL
               ORDER BY model`;
    var models = runBigQuery(sql).map(function (row) {
      return String(ciGet(row, 'model') || '').trim();
    }).filter(Boolean);

    return responseJSON({ status: "success", data: models }, isRawObject);
  } catch (e) {
    return responseJSON({ status: "error", data: [], message: e.toString() }, isRawObject);
  }
}

// ==========================================
// 4. บันทึก / อัปเดต ข้อมูลใบงาน (pm_log & service_report)
// ==========================================
function insertOrUpdateTicket(p, isRawObject) {
  try {
    var ticketId = p.ticketId ? String(p.ticketId) : "TK-" + Utilities.formatDate(new Date(), "GMT+7", "yyyyMMdd-HHmmss");

    // --- SAFEGUARD: ป้องกันการสลับค่าระหว่าง วันที่ กับ รอบ PM ---
    var rawDate = String(p.serviceDate || p.contractDate || p.contract_date || '').trim();
    var rawPmRound = String(p.pmRound || p.last_pm_round || '0').trim();

    var strDate = rawDate;
    var pmRound = Number(rawPmRound) || 0;

    if (_looksLikeDate(rawPmRound)) {
      strDate = rawPmRound;
      pmRound = Number(rawDate) || 0;
    }

    var actualHours = Number(p.actualHours) || 0;
    var nextPm = pmRound > 0 ? (pmRound + 250) : 50;

    var machineId = p.machineId || p.machine_id || '';
    var originalMachineId = p.originalMachineId || p.original_machine_id || machineId;
    var model = p.model || '';
    var customerName = p.customerName || p.customer || '';
    var customerId = p.customerId || p.customer_id || '';
    var phone = p.phone || p.phone_number || '';

    var partsStore = p.partsStore || p.parts_store || '-';
    var supplierId = p.supplierId || p.supplier_id || '-';
    var partsBillNo = p.partsBillNo || p.parts_bill_no || 'NA';
    var partsStatus = p.partsStatus || p.parts_status || 'ส่งครบแล้ว';
    var receiptImage = resolveReceiptImage(p.receiptImage || p.receipt_image || '', ticketId);
    var remark = p.remark || '';
    var updatedBy = p.updatedBy || p.updated_by || '';
    var yanmarCoupon = Number(p.yanmarCoupon) || 0;
    var nowStr = Utilities.formatDate(new Date(), "GMT+7", "yyyy-MM-dd HH:mm:ss");

    // 1. เพิ่มแถวใหม่ใน pm_log (ประวัติ PM ทุกครั้ง เพิ่มแถวใหม่เสมอ ไม่ทับของเดิม)
    // หมายเหตุ: pm_log ใช้ชื่อคอลัมน์จริงคือ Ticket_ID / PM_Target / Actual_Hours / Service_Date
    // (ไม่ใช่ contract_date / last_pm_round / current_Hours แบบ service_report)
    var logSheet = getSheet(SHEET_TABS.pm_log);
    appendRowByObject(logSheet, {
      ticket_id: ticketId,
      machine_id: machineId,
      model: model,
      customer: customerName,
      customer_id: customerId,
      pm_target: pmRound,
      actual_hours: actualHours,
      service_date: strDate,
      invoice_no: partsBillNo,
      parts_store: partsStore,
      supplier_id: supplierId,
      parts_bill_no: partsBillNo,
      parts_status: partsStatus,
      receipt_image: receiptImage,
      yanmar_coupon: yanmarCoupon,
      remark: remark,
      updated_at: nowStr
    });

    // 2. Upsert ลง service_report: หาแถวเดิมด้วย machine_id (ไม่สนตัวพิมพ์เล็ก-ใหญ่ของค่าและชื่อคอลัมน์)
    var dashSheet = getSheet(SHEET_TABS.service_report);
    var matched = findRows(dashSheet, function (r) {
      return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === String(originalMachineId).trim().toLowerCase();
    });

    var dashObj = {
      machine_id: machineId,
      model: model,
      customer: customerName,
      customer_id: customerId,
      phone_number: phone,
      contract_date: strDate,
      current_Hours: actualHours,
      last_pm_round: pmRound,
      next_pm_round: nextPm,
      status: 'Approved',
      updated_by: updatedBy,
      parts_store: partsStore,
      supplier_id: supplierId,
      parts_bill_no: partsBillNo,
      parts_status: partsStatus,
      yanmar_coupon: yanmarCoupon,
      remark: remark,
      updated_at: nowStr
    };
    // receipt_image: อัปเดตเฉพาะตอนมีค่าใหม่ส่งมา (ถ้าไม่ส่งมา ไม่แตะของเดิม)
    if (receiptImage) dashObj.receipt_image = receiptImage;

    if (matched.length > 0) {
      updateRowByObject(dashSheet, matched[0].__row, dashObj);
    } else {
      dashObj.no = '';
      if (!dashObj.receipt_image) dashObj.receipt_image = '';
      appendRowByObject(dashSheet, dashObj);
    }

    return responseJSON({ status: "success", ticketId: ticketId }, isRawObject);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() }, isRawObject);
  }
}

// ==========================================
// หาแถวใน pm_log ที่ตรงกับ "ใบงานเดียว" อย่างเข้มงวด
// ==========================================
// เดิมใช้เงื่อนไข no === id || ticket_id === id || machine_id === id
// ทำให้แก้/ลบใบงานเดียวแล้วไปโดนแถวอื่นด้วย (ticket_id ซ้ำ, ค่าว่างตรงกัน, เลข no ชนกับ ticket_id ฯลฯ)
// ตอนนี้: ห้ามจับค่าว่าง, จับ ticket_id ก่อน (ถ้าไม่มีค่อยใช้ no), แล้วกรองด้วย machine_id / pm_target
// pm_log เป็น log จึงมีแถวซ้ำ (เครื่อง+รอบเดียวกัน) ได้ตามปกติ
// ถ้ายังเหลือมากกว่า 1 แถว → เลือก "แถวล่าสุด" (แถวล่างสุดใน Sheet) เพียงแถวเดียว ไม่เขียนทับหลายแถว
function findPmLogTarget(logSheet, ticketId, machineId, pmRound) {
  var id = String(ticketId || '').trim();
  var mId = String(machineId || '').trim().toLowerCase();
  var round = (pmRound === undefined || pmRound === null || pmRound === '') ? null : (Number(pmRound) || 0);

  function sameMachine(r) { return !mId || String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === mId; }
  function sameRound(r) { return round === null || (Number(ciGet(r, 'pm_target')) || 0) === round; }

  var rows = [];
  if (id) {
    rows = findRows(logSheet, function (r) { return String(ciGet(r, 'ticket_id') || '').trim() === id; });
    if (rows.length === 0) {
      rows = findRows(logSheet, function (r) {
        return !String(ciGet(r, 'ticket_id') || '').trim() && String(ciGet(r, 'no') || '').trim() === id;
      });
    }
  }
  // ไม่มีเลขใบงาน (หรือหาไม่เจอ) → ใช้ machine_id + รอบ PM ต้องมีครบทั้งคู่
  if (rows.length === 0 && mId && round !== null) {
    rows = findRows(logSheet, function (r) { return sameMachine(r) && sameRound(r); });
  }

  if (rows.length > 1) rows = rows.filter(sameMachine);
  if (rows.length > 1) rows = rows.filter(sameRound);

  if (rows.length === 0) throw new Error('ไม่พบใบงาน ' + (id || '-') + ' ใน pm_log');
  return pickLatestLogRow(rows);
}

// ==========================================
// 4.1 อัปเดตข้อมูล PM รอบย้อนหลัง (แก้ไขใบงานเดิม)
// ==========================================
function updatePmLog(p, isRawObject) {
  try {
    var ticketId = String(p.ticketId || p.ticket_id || '');
    var machineId = p.machineId || p.machine_id || '';

    var strDate = p.serviceDate || p.contractDate || p.contract_date || '';
    var pmRound = Number(p.pmRound || p.last_pm_round) || 0;
    var actualHours = Number(p.actualHours || p.current_Hours) || 0;
    var nextPm = pmRound > 0 ? (pmRound + 250) : 50;

    var model = p.model || '';
    var customerName = p.customerName || p.customer || '';
    var customerId = p.customerId || p.customer_id || '';
    var phone = p.phone || p.phone_number || '';

    var partsStore = p.partsStore || p.parts_store || '-';
    var partsBillNo = p.partsBillNo || p.parts_bill_no || 'NA';
    var partsStatus = p.partsStatus || p.parts_status || 'ส่งครบแล้ว';
    var receiptImage = resolveReceiptImage(p.receiptImage || p.receipt_image || '', ticketId);
    var remark = p.remark || '';
    var updatedBy = p.updatedBy || p.updated_by || '';
    var couponAmt = Number(p.yanmarCoupon || p.yanmar_coupon) || 0;
    var nowStr = Utilities.formatDate(new Date(), "GMT+7", "yyyy-MM-dd HH:mm:ss");

    // update สำหรับ pm_log (ใช้ชื่อคอลัมน์จริง: Ticket_ID / PM_Target / Actual_Hours / Service_Date)
    var logUpdate = {
      machine_id: machineId, model: model, customer: customerName, customer_id: customerId,
      service_date: strDate, actual_hours: actualHours, pm_target: pmRound,
      parts_store: partsStore, parts_bill_no: partsBillNo, parts_status: partsStatus,
      receipt_image: receiptImage, yanmar_coupon: couponAmt, remark: remark, updated_at: nowStr
    };
    // update สำหรับ service_report (ใช้ชื่อคอลัมน์จริง: Contract_Date / Last_PM_Round / Current_Hours)
    var dashUpdate = {
      machine_id: machineId, model: model, customer: customerName, customer_id: customerId,
      phone_number: phone, contract_date: strDate, current_Hours: actualHours,
      last_pm_round: pmRound, next_pm_round: nextPm, updated_by: updatedBy,
      parts_store: partsStore, parts_bill_no: partsBillNo, parts_status: partsStatus,
      receipt_image: receiptImage, yanmar_coupon: couponAmt, remark: remark, updated_at: nowStr
    };

    // 1. อัปเดตข้อมูลใบงานเดิมใน pm_log (no หรือ ticket_id ตรงกับที่ระบุ)
    var logSheet = getSheet(SHEET_TABS.pm_log);
    var origMachineId = p.originalMachineId || p.original_machine_id || machineId;
    var origPmRound = (p.originalPmRound !== undefined && p.originalPmRound !== '') ? p.originalPmRound : pmRound;
    var targetRow = findPmLogTarget(logSheet, ticketId, origMachineId, origPmRound);
    updateRowByObject(logSheet, targetRow.__row, logUpdate);

    // 2. sync ไป service_report เฉพาะแถวที่ machine_id ตรงกัน และ last_pm_round เดิม <= รอบที่แก้
    var dashSheet = getSheet(SHEET_TABS.service_report);
    var dashRows = findRows(dashSheet, function (r) {
      return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === String(machineId).trim().toLowerCase()
        && (Number(ciGet(r, 'last_pm_round')) || 0) <= pmRound;
    });
    dashRows.forEach(function (r) { updateRowByObject(dashSheet, r.__row, dashUpdate); });

    return responseJSON({ status: "success", ticketId: ticketId }, isRawObject);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() }, isRawObject);
  }
}

// ==========================================
// 5. บันทึกยืนยันรับคูปองย้อนหลัง
// ==========================================
function claimCoupon(p, isRawObject) {
  try {
    var ticketId = String(p.ticketId || '');
    var amount = Number(p.yanmarCoupon) || 4000;
    var couponRemark = p.couponRemark || '';

    var logSheet = getSheet(SHEET_TABS.pm_log);
    // ปุ่มจากตารางสถานะอาจส่ง machine_id มาแทน ticket_id → ใช้คู่กับรอบ PM เพื่อหาแถวเดียว
    var claimMachineId = p.machineId || '';
    var claimRound = (p.pmRound !== undefined && p.pmRound !== '') ? p.pmRound : null;
    var targetRow;
    try {
      targetRow = findPmLogTarget(logSheet, ticketId, claimMachineId, claimRound);
    } catch (notFound) {
      if (claimRound === null) throw notFound;
      targetRow = findPmLogTarget(logSheet, '', ticketId, claimRound);
    }
    var logRows = [targetRow];
    var roundOfClaim = Number(ciGet(targetRow, 'pm_target')) || 0;

    var machineId = String(ciGet(targetRow, 'machine_id') || '');

    logRows.forEach(function (r) {
      var newRemark = couponRemark ? (String(ciGet(r, 'remark') || '') + ' | เลขรับคูปอง: ' + couponRemark) : ciGet(r, 'remark');
      updateRowByObject(logSheet, r.__row, { yanmar_coupon: amount, remark: newRemark });
    });

    if (machineId) {
      var dashSheet = getSheet(SHEET_TABS.service_report);
      var dashRows = findRows(dashSheet, function (r) {
        return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === machineId.trim().toLowerCase()
          && (Number(ciGet(r, 'last_pm_round')) || 0) === roundOfClaim;
      });
      dashRows.forEach(function (r) {
        var newRemark = couponRemark ? (String(ciGet(r, 'remark') || '') + ' | เลขรับคูปอง: ' + couponRemark) : ciGet(r, 'remark');
        updateRowByObject(dashSheet, r.__row, { yanmar_coupon: amount, remark: newRemark });
      });
    }

    return responseJSON({ status: "success" }, isRawObject);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() }, isRawObject);
  }
}

// ==========================================
// 6. อัปเดตสถานะอะไหล่ค้างส่ง (ทั่วไป)
// ==========================================
function updatePartsStatus(p, isRawObject) {
  try {
    var targetMachineId = String(p.machineId || p.machine_id || '');
    var partsRemark = String(p.partsRemark || '').trim();
    var partsStore = p.partsStore || p.parts_store || '';
    var partsStatus = p.partsStatus || p.parts_status || '';
    var updatedBy = p.updatedBy || p.updated_by || '';
    var deliveredParts = String(p.deliveredParts || '').trim();
    var partsDocNo = String(p.partsDocNo || '').trim().toUpperCase();
    var nowDate = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy");
    var nowStr = Utilities.formatDate(new Date(), "GMT+7", "yyyy-MM-dd HH:mm:ss");

    // ข้อความบันทึกการส่งอะไหล่ เช่น
    // [ส่งอะไหล่ครบแล้ว 26/09/2026] รายการ: กรองน้ำมันเครื่อง, กรองโซล่า | DTT: DTT01234 | หมายเหตุ: ...
    var logParts = [];
    if (deliveredParts) logParts.push('รายการ: ' + deliveredParts);
    if (partsDocNo) logParts.push('DTT: ' + partsDocNo);
    if (partsRemark) logParts.push('หมายเหตุ: ' + partsRemark);
    var label = partsStatus === 'ส่งครบแล้ว' ? 'ส่งอะไหล่ครบแล้ว' : 'ส่งอะไหล่บางส่วน';
    var deliveryLog = logParts.length ? ('[' + label + ' ' + nowDate + '] ' + logParts.join(' | ')) : '';

    function appendRemark(existing) {
      var ex = String(existing || '').trim();
      if (!deliveryLog) return existing;
      return (ex && ex !== '-') ? (ex + ' | ' + deliveryLog) : deliveryLog;
    }

    var dashSheet = getSheet(SHEET_TABS.service_report);
    var rows = findRows(dashSheet, function (r) {
      return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === targetMachineId.trim().toLowerCase();
    });

    var roundsUpdated = {};
    rows.forEach(function (r) {
      updateRowByObject(dashSheet, r.__row, {
        parts_store: partsStore, parts_status: partsStatus, updated_by: updatedBy,
        remark: appendRemark(ciGet(r, 'remark')), updated_at: nowStr
      });
      roundsUpdated[Number(ciGet(r, 'last_pm_round')) || 0] = true;
    });

    // บันทึกลง pm_log ของรอบ PM ล่าสุดด้วย เพื่อให้ประวัติรายรอบ + Matrix แสดงสถานะตรงกัน
    var logSheet = getSheet(SHEET_TABS.pm_log);
    var logRows = findRows(logSheet, function (r) {
      return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === targetMachineId.trim().toLowerCase()
        && roundsUpdated[Number(ciGet(r, 'pm_target')) || 0] === true;
    });
    // ถ้ามีหลายแถวของเครื่อง+รอบเดียวกัน (ข้อมูลซ้ำ) เขียนเฉพาะแถวล่าสุดแถวเดียว
    logRows = logRows.length ? [pickLatestLogRow(logRows)] : [];
    logRows.forEach(function (r) {
      updateRowByObject(logSheet, r.__row, {
        parts_store: partsStore, parts_status: partsStatus,
        remark: appendRemark(ciGet(r, 'remark')), updated_at: nowStr
      });
    });

    return responseJSON({ status: "success", deliveryLog: deliveryLog }, isRawObject);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() }, isRawObject);
  }
}

// ==========================================
// 6.1 บันทึกรับอะไหล่ค้างส่ง เฉพาะรอบ PM ย้อนหลัง (เพิ่มเติมสำหรับ Matrix)
// ==========================================
function updatePendingPartsByRound(p, isRawObject) {
  try {
    var machineId = String(p.machineId || p.machine_id || '');
    var pmRound = Number(p.pmRound || p.last_pm_round) || 0;
    var partsStatus = p.partsStatus || 'ส่งครบแล้ว';
    var partsStore = p.partsStore || '-';
    var partsBillNo = p.partsBillNo || '-';
    var remark = p.remark || '';
    var updatedBy = p.updatedBy || 'System';

    function buildRemark(existing) {
      return remark ? (String(existing || '') + ' | [รับอะไหล่รอบ ' + pmRound + ' ชม.]: ' + remark) : existing;
    }

    // 1. อัปเดตข้อมูลอะไหล่เฉพาะรอบ PM ใน pm_log (pm_log ใช้คอลัมน์ PM_Target แทน Last_PM_Round)
    var logSheet = getSheet(SHEET_TABS.pm_log);
    var logRows = findRows(logSheet, function (r) {
      return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === machineId.trim().toLowerCase()
        && (Number(ciGet(r, 'pm_target')) || 0) === pmRound;
    });
    // pm_log ซ้ำได้ → อัปเดตเฉพาะ log ล่าสุดของรอบนี้แถวเดียว
    logRows = logRows.length ? [pickLatestLogRow(logRows)] : [];
    logRows.forEach(function (r) {
      updateRowByObject(logSheet, r.__row, {
        parts_status: partsStatus, parts_store: partsStore, parts_bill_no: partsBillNo,
        remark: buildRemark(ciGet(r, 'remark'))
      });
    });

    // 2. ถ้ารอบที่แก้เป็นรอบล่าสุดของ service_report ให้ซิงก์สถานะไปด้วย
    var dashSheet = getSheet(SHEET_TABS.service_report);
    var dashRows = findRows(dashSheet, function (r) {
      return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === machineId.trim().toLowerCase();
    });
    dashRows.forEach(function (r) {
      if ((Number(ciGet(r, 'last_pm_round')) || 0) === pmRound) {
        updateRowByObject(dashSheet, r.__row, {
          parts_status: partsStatus, parts_store: partsStore, parts_bill_no: partsBillNo,
          updated_by: updatedBy, remark: buildRemark(ciGet(r, 'remark'))
        });
      }
    });

    return responseJSON({ status: "success", machineId: machineId, pmRound: pmRound }, isRawObject);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() }, isRawObject);
  }
}

// ==========================================
// 7. อนุมัติสถานะเครื่องจักร (Approve)
// ==========================================
function approveMachine(machineId, isRawObject) {
  try {
    var target = String(machineId || '');
    var dashSheet = getSheet(SHEET_TABS.service_report);
    var rows = findRows(dashSheet, function (r) {
      return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === target.trim().toLowerCase();
    });
    rows.forEach(function (r) { updateRowByObject(dashSheet, r.__row, { status: 'Approved' }); });
    return responseJSON({ status: "success" }, isRawObject);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() }, isRawObject);
  }
}

// ==========================================
// 8. ลบข้อมูลใน Service_Report
// ==========================================
function deleteDashboard(machineId, isRawObject) {
  try {
    var target = String(machineId || '');
    var dashSheet = getSheet(SHEET_TABS.service_report);
    var rows = findRows(dashSheet, function (r) {
      return String(ciGet(r, 'machine_id') || '').trim().toLowerCase() === target.trim().toLowerCase();
    });
    deleteRows(dashSheet, rows.map(function (r) { return r.__row; }));
    return responseJSON({ status: "success" }, isRawObject);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() }, isRawObject);
  }
}

// ==========================================
// 9. ลบข้อมูลใน PM_Log
// ==========================================
function deleteReport(ticketId, isRawObject, machineId, pmRound) {
  try {
    var logSheet = getSheet(SHEET_TABS.pm_log);
    var row = findPmLogTarget(logSheet, ticketId, machineId, pmRound);
    deleteRows(logSheet, [row.__row]);
    return responseJSON({ status: "success" }, isRawObject);
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() }, isRawObject);
  }
}

// ==========================================
// Utilities to detect and fix swapped fields in pm_log
// ==========================================
function _looksLikeDate(val) {
  if (!val) return false;
  val = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(val)) return true;
  if (/\d{4}/.test(val) && /[-\/]/.test(val)) return true;
  return false;
}

function _looksLikePhone(val) {
  if (!val) return false;
  var s = String(val).trim();
  var digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function detectPmLogSwaps(isRawObject) {
  try {
    var rows = runBigQuery(`SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\``);
    var candidates = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var ticket = ciGet(r, 'ticket_id') || ciGet(r, 'no') || (i + 1);
      var customer = String(ciGet(r, 'customer') || '').trim();
      var phone = String(ciGet(r, 'phone_number') || '').trim();
      var serviceDate = String(ciGet(r, 'service_date') || '').trim();

      var custIsDate = _looksLikeDate(customer);
      var custIsPhone = _looksLikePhone(customer);
      var phoneIsDate = _looksLikeDate(phone);
      var phoneIsPhone = _looksLikePhone(phone);
      var dateIsDate = _looksLikeDate(serviceDate);
      var dateIsPhone = _looksLikePhone(serviceDate);

      var needs = {};

      if (phoneIsDate && dateIsPhone) {
        needs.action = 'swap_phone_date';
        needs.suggested = { phone: serviceDate, contract_date: phone };
      }

      if (custIsPhone && !phoneIsPhone) {
        needs.action = needs.action || 'swap_customer_phone';
        needs.suggested = needs.suggested || {};
        needs.suggested.customer = phone || '';
        needs.suggested.phone = customer || '';
      }

      if (custIsDate && !dateIsDate) {
        needs.action = needs.action || 'swap_customer_date';
        needs.suggested = needs.suggested || {};
        needs.suggested.customer = serviceDate || '';
        needs.suggested.contract_date = customer || '';
      }

      if (Object.keys(needs).length > 0) {
        candidates.push({ ticketId: ticket, original: { customer: customer, phone: phone, contract_date: serviceDate }, issue: needs });
      }
    }

    return responseJSON({ status: 'success', candidates: candidates }, isRawObject);
  } catch (err) {
    return responseJSON({ status: 'error', message: err.toString() }, isRawObject);
  }
}

function fixPmLogSwaps(payload, isRawObject) {
  try {
    var fixes = [];
    if (!payload) return responseJSON({ status: 'error', message: 'Missing payload' }, isRawObject);

    if (payload.fixes && Array.isArray(payload.fixes)) {
      fixes = payload.fixes;
    } else if (payload.tickets && Array.isArray(payload.tickets)) {
      var detected = detectPmLogSwaps(true);
      var map = {};
      (detected.candidates || []).forEach(function(c){ map[String(c.ticketId)] = c; });
      payload.tickets.forEach(function(t){ if (map[t]) fixes.push({ ticketId: t, set: map[t].issue.suggested }); });
    } else if (payload.ticketId) {
      var detObj = detectPmLogSwaps(true);
      var found = (detObj.candidates || []).find(function(c){ return String(c.ticketId) === String(payload.ticketId); });
      if (found) fixes.push({ ticketId: payload.ticketId, set: found.issue.suggested });
    } else {
      return responseJSON({ status: 'error', message: 'Invalid payload format' }, isRawObject);
    }

    var logSheet = getSheet(SHEET_TABS.pm_log);
    var applied = [];
    fixes.forEach(function(f) {
      var t = String(f.ticketId);
      var update = {};
      if (f.set.customer !== undefined) update.customer = f.set.customer;
      if (f.set.phone !== undefined) update.phone_number = f.set.phone;
      if (f.set.contract_date !== undefined) update.service_date = f.set.contract_date;
      if (Object.keys(update).length === 0) return;

      try {
        var rows = findRows(logSheet, function (r) {
          return String(ciGet(r, 'no') || '') === t || String(ciGet(r, 'ticket_id') || '') === t || String(ciGet(r, 'machine_id') || '') === t;
        });
        rows.forEach(function (r) { updateRowByObject(logSheet, r.__row, update); });
        applied.push({ ticketId: f.ticketId, applied: f.set });
      } catch (e) {
        applied.push({ ticketId: f.ticketId, error: e.toString() });
      }
    });

    return responseJSON({ status: 'success', applied: applied }, isRawObject);
  } catch (err) {
    return responseJSON({ status: 'error', message: err.toString() }, isRawObject);
  }
}
// ==========================================
// 🔧 MIGRATION: ดึงข้อมูลปัจจุบันจาก BigQuery (Native Table) มาลง Google Sheet
// ==========================================
// วิธีใช้:
// 1. ใส่ SHEET_ID ด้านบนให้เรียบร้อยก่อน
// 2. สร้างแท็บเปล่าชื่อ users, service_report, pm_log ใน Sheet นั้น (ยังไม่ต้องใส่ Header)
// 3. เปิดไฟล์นี้ใน Apps Script Editor แล้วเลือกรัน migrateNativeDataToSheet() ครั้งเดียว
// 4. เช็กว่าข้อมูลมาครบใน Sheet แล้วค่อยไปตั้ง External Table ใน BigQuery Console
// 5. ลบฟังก์ชันนี้ทิ้งได้ (หรือปล่อยไว้ก็ได้ ไม่กระทบระบบ เพราะไม่ได้ถูกเรียกจาก doGet/doPost)
function migrateNativeDataToSheet() {
  var tables = ['users', 'service_report', 'pm_log', 'modelpart'];
  var ss = SpreadsheetApp.openById(SHEET_ID);

  tables.forEach(function (tableName) {
    var rows = runBigQuery(`SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.${tableName}\``);
    var sheet = ss.getSheetByName(tableName) || ss.insertSheet(tableName);
    sheet.clearContents();

    if (rows.length === 0) {
      Logger.log('ตาราง ' + tableName + ' ไม่มีข้อมูล ข้ามไป');
      return;
    }

    // รวม Header จากทุกแถว (เผื่อบาง field ไม่ครบทุกแถว)
    var headerSet = {};
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { headerSet[k] = true; }); });
    var headers = Object.keys(headerSet);

    var values = [headers];
    rows.forEach(function (r, idx) {
      var identifier = r.no || r.ticket_id || r.machine_id || (tableName + '_' + (idx + 1));
      values.push(headers.map(function (h) {
        var v = (r[h] === null || r[h] === undefined) ? '' : r[h];
        // receipt_image ถ้าเป็น Base64 (ยาวเกิน 50,000 ตัวอักษรแน่นอน) ให้แปลงเป็นลิงก์ Drive ก่อน
        if (h === 'receipt_image') {
          v = resolveReceiptImage(v, identifier);
        }
        return v;
      }));
    });

    sheet.getRange(1, 1, values.length, headers.length).setValues(values);
    Logger.log('ย้าย ' + tableName + ' เสร็จแล้ว: ' + rows.length + ' แถว');
  });

  Logger.log('Migration เสร็จสมบูรณ์ — ตรวจสอบข้อมูลใน Sheet ก่อนไปตั้ง External Table');
}

// ==========================================
// 🔍 DIAGNOSTIC: หาว่าคอลัมน์/แถวไหนมีข้อความยาวเกิน 50,000 ตัวอักษร
// ==========================================
// รันฟังก์ชันนี้ก่อน migrateNativeDataToSheet() ถ้าเจอ error เรื่อง 50000 ตัวอักษร
// อ่านจาก BigQuery อย่างเดียว ไม่เขียนอะไรลง Sheet จึงปลอดภัย รันซ้ำได้เรื่อยๆ
function findOversizedCells() {
  var tables = ['users', 'service_report', 'pm_log', 'modelpart'];
  var LIMIT = 50000;
  var found = [];

  tables.forEach(function (tableName) {
    var rows = runBigQuery(`SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.${tableName}\``);
    rows.forEach(function (r, idx) {
      Object.keys(r).forEach(function (col) {
        var val = r[col];
        if (val !== null && val !== undefined) {
          var len = String(val).length;
          if (len > LIMIT) {
            found.push({
              table: tableName,
              rowIndex: idx + 1,
              identifier: r.no || r.ticket_id || r.machine_id || ('row#' + (idx + 1)),
              column: col,
              length: len
            });
          }
        }
      });
    });
  });

  if (found.length === 0) {
    Logger.log('ไม่พบเซลล์ที่ยาวเกิน 50,000 ตัวอักษร');
  } else {
    Logger.log('พบ ' + found.length + ' เซลล์ที่ยาวเกินกำหนด:');
    found.forEach(function (f) {
      Logger.log(f.table + ' | แถวที่อ้างอิง: ' + f.identifier + ' | คอลัมน์: ' + f.column + ' | ความยาว: ' + f.length + ' ตัวอักษร');
    });
  }
  return found;
}


// ตั้งค่าตัวแปรประจำโปรเจกต์


/**
 * ฟังก์ชันสำหรับทดสอบการดึงข้อมูลจากตาราง pm_log ใน BigQuery
 */
function testFetchBigQueryData() {
  const query = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` LIMIT 10`;
  
  const request = {
    query: query,
    useLegacySql: false
  };
  
  try {
    const queryResults = BigQuery.Jobs.query(request, BQ_PROJECT_ID);
    const jobId = queryResults.jobReference.jobId;
    
    // รอผลลัพธ์คิวรีประมวลผล
    let rows = queryResults.rows;
    while (!queryResults.jobComplete) {
      Utilities.sleep(1000);
      queryResults = BigQuery.Jobs.getQueryResults(BQ_PROJECT_ID, jobId);
      rows = queryResults.rows;
    }
    
    Logger.log('ดึงข้อมูลสำเร็จ! จำนวนแถวที่พบ: ' + (rows ? rows.length : 0));
    if (rows && rows.length > 0) {
      Logger.log('ตัวอย่างข้อมูลแถวแรก: ' + JSON.stringify(rows[0]));
    } else {
      Logger.log('ตารางยังไม่มีข้อมูล');
    }
  } catch (error) {
    Logger.log('เกิดข้อผิดพลาดในการดึงข้อมูล: ' + error.toString());
  }
}





function syncSheetToBigQuery() {
  const tables = ['users', 'modelpart', 'pm_log', 'service_report'];
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  tables.forEach(tableName => {
    const sheet = ss.getSheetByName(tableName);
    if (!sheet) {
      Logger.log(`ไม่พบแผ่นงานชื่อ ${tableName}`);
      return;
    }

    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      Logger.log(`แผ่นงาน ${tableName} ไม่มีข้อมูล`);
      return;
    }

    // ดึง Schema จริงจาก BigQuery
    let bqFieldsMap = {};
    try {
      const tableInfo = BigQuery.Tables.get(BQ_PROJECT_ID, BQ_DATASET_ID, tableName);
      tableInfo.schema.fields.forEach(f => {
        // ใช้ key แบบ lowercase เพื่อเปรียบเทียบ แต่เก็บชื่อจริงใน BQ ไว้
        bqFieldsMap[f.name.toLowerCase()] = f.name;
      });
    } catch (e) {
      Logger.log(`ไม่สามารถดึง Schema ของ ${tableName}: ` + e.toString());
      return;
    }

    const rawHeaders = data[0];
    const rows = data.slice(1);
    
    const jsonRows = rows.map(row => {
      let rowObj = {};
      rawHeaders.forEach((header, index) => {
        if (!header) return;
        
        const cleanHeader = String(header).trim().toLowerCase();
        const bqFieldName = bqFieldsMap[cleanHeader];
        
        if (bqFieldName) {
          let val = row[index];
          
          if (val instanceof Date) {
            val = isNaN(val.getTime()) ? null : val.toISOString();
          } else if (val === '' || val === undefined) {
            val = null;
          } else if (typeof val === 'string') {
            val = val.trim();
          }
          
          rowObj[bqFieldName] = val;
        }
      });
      
      // เติม created_at สำหรับ BigQuery Partitioning
      if (bqFieldsMap['created_at']) {
        rowObj[bqFieldsMap['created_at']] = new Date().toISOString();
      }
      
      return rowObj;
    });

    const insertRequest = { rows: jsonRows.map(row => ({ json: row })) };

    try {
      const response = BigQuery.Tabledata.insertAll(insertRequest, BQ_PROJECT_ID, BQ_DATASET_ID, tableName);
      if (response.insertErrors && response.insertErrors.length > 0) {
        Logger.log(`Error ตาราง ${tableName}: ` + JSON.stringify(response.insertErrors));
      } else {
        Logger.log(`นำเข้าข้อมูล ${tableName} สำเร็จ ${jsonRows.length} แถว`);
      }
    } catch (err) {
      Logger.log(`Error ตาราง ${tableName}: ` + err.toString());
    }
  });
}