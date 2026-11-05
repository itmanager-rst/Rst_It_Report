/**
 * SITEASSET TRACKER - Google Apps Script (Legacy Core: สต็อก + ประวัติการเบิก)
 * ---------------------------------------------------------------------------
 * ⚠️ ไฟล์นี้ทำงานคู่กับ Approval.js
 *    - doGet / doPost ตัวจริงอยู่ใน Approval.js (ตรวจ Login + สิทธิ์ก่อน)
 *    - ไฟล์นี้จึงต้องใช้ชื่อ doGetLegacy / doPostLegacy เท่านั้น
 *      (ถ้ามี doGet/doPost ซ้ำ 2 ไฟล์ Apps Script จะเรียกผิดตัว และ Approval.js จะหา doGetLegacy ไม่เจอ)
 */

var STOCK_SHEET = "Assets_Stock";
var LOG_SHEET = "Requisition_Log";
var LEGACY_TZ = "Asia/Bangkok";

function doGetLegacy(e) {
  var action = e && e.parameter ? e.parameter.action : "";

  if (action === "getAssets") return jsonLegacy_(getAssetList());
  if (action === "getLogs") return jsonLegacy_(getRequisitionLogs());

  // หน้าเว็บผ่าน Apps Script (ถ้ามีไฟล์ Index.html ในโปรเจกต์)
  try {
    return HtmlService.createTemplateFromFile('Index').evaluate()
      .setTitle('HR SiteAsset Tracker')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return ContentService.createTextOutput("HR SiteAsset Tracker API is running.");
  }
}

function doPostLegacy(e) {
  try {
    var data = {};
    if (e && e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      data = e.parameter;
    }

    var action = data.action;
    var result;

    if (action === "getAssets") {
      result = getAssetList();
    } else if (action === "addAsset") {
      result = addAsset(data);
    } else if (action === "editAsset") {
      result = editAsset(data);
    } else if (action === "deleteAsset") {
      result = deleteAsset(data.assetId);
    } else if (action === "deleteLog") {
      result = deleteLog(data.txId);
    } else if (!action) {
      // เรียกได้จาก Approval.js (หลังอนุมัติ) เท่านั้น — Router ปิดการเบิกตรงจากหน้าเว็บแล้ว
      result = processRequisition(data);
    } else {
      result = { status: "error", message: "ไม่รู้จักคำสั่ง: " + action };
    }

    return jsonLegacy_(result);
  } catch (err) {
    return jsonLegacy_({ status: "error", message: err.toString() });
  }
}

function jsonLegacy_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * รูปภาพ: เซลล์ Google Sheets เก็บได้ไม่เกิน 50,000 ตัวอักษร
 * รูป base64 ที่ยาวเกิน → อัปโหลดเข้า Drive แล้วเก็บเป็นลิงก์แทน (ใช้ saveImage_ จาก Approval.js)
 */
function toImageCell_(img, name) {
  if (!img) return "";
  img = String(img);
  if (img.indexOf("data:image") !== 0 || img.length < 45000) return img;
  return saveImage_(img, name).url;
}

// 1. ดึงรายการอุปกรณ์พร้อมประวัติผู้เบิกล่าสุด
function getAssetList() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(STOCK_SHEET);
    var logSheet = ss.getSheetByName(LOG_SHEET);
    if (!sheet) return [];

    var data = sheet.getDataRange().getValues();
    var logData = logSheet ? logSheet.getDataRange().getValues() : [];
    var list = [];

    // ผู้เบิกและสาขาล่าสุดของแต่ละอุปกรณ์
    var lastLogMap = {};
    for (var j = logData.length - 1; j >= 1; j--) {
      var aId = logData[j][2] ? logData[j][2].toString() : "";
      if (aId && !lastLogMap[aId]) {
        lastLogMap[aId] = { borrower: logData[j][5] || "-", branch: logData[j][7] || "-" };
      }
    }

    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === "" || data[i][0] === null) continue;
      var assetId = data[i][0].toString();
      var total = parseInt(data[i][3]) || 0;
      var rem = parseInt(data[i][4]);
      if (isNaN(rem)) rem = total;                     // คอลัมน์ E ว่าง = ยังไม่เคยเบิก
      var lastLog = lastLogMap[assetId] || { borrower: "-", branch: "-" };

      list.push({
        id: assetId,
        name: data[i][1],
        category: data[i][2] || "-",
        total: total,
        remaining: Math.max(0, rem),
        image: data[i][5] || "",
        notes: data[i][6] || "-",
        lastBorrower: lastLog.borrower,
        lastBranch: lastLog.branch
      });
    }
    return list;
  } catch (e) {
    return [];
  }
}

// 2. ดึงรายงานประวัติการเบิก (ใหม่ → เก่า)
function getRequisitionLogs() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
    if (!sheet) return [];

    var data = sheet.getDataRange().getValues();
    var logs = [];
    for (var i = data.length - 1; i >= 1; i--) {
      if (data[i][0] === "" || data[i][0] === null) continue;
      var ts = data[i][1] instanceof Date
        ? Utilities.formatDate(data[i][1], LEGACY_TZ, "dd/MM/yyyy HH:mm")
        : String(data[i][1]);

      logs.push({
        txId: data[i][0],
        timestamp: ts,
        assetId: data[i][2],
        assetName: data[i][3],
        quantity: data[i][4],
        staffName: data[i][5],
        department: data[i][6],
        branch: data[i][7],
        image: data[i][8] || "",
        notes: data[i][9] || "-"
      });
    }
    return logs;
  } catch (e) {
    return [];
  }
}

// 3. เพิ่มอุปกรณ์ใหม่เข้าคลัง
function addAsset(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_SHEET);
    if (!sheet) return { status: "error", message: "ไม่พบชีท " + STOCK_SHEET };

    var id = String(data.id || "").trim();
    if (!id || !data.name) return { status: "error", message: "กรุณาระบุรหัสและชื่ออุปกรณ์" };

    var ids = sheet.getDataRange().getValues().slice(1).map(function (r) { return String(r[0]).trim(); });
    if (ids.indexOf(id) >= 0) return { status: "error", message: "รหัสอุปกรณ์ \"" + id + "\" มีอยู่แล้วในระบบ" };

    var totalQty = parseInt(data.total) || 1;
    // ยอดคงเหลือเริ่มต้น (E) = จำนวนทั้งหมด (D)
    sheet.appendRow([
      id, data.name, data.category, totalQty, totalQty,
      toImageCell_(data.image, "asset_" + id),
      data.notes || "-"
    ]);
    return { status: "success", message: "เพิ่มอุปกรณ์ใหม่เข้าระบบสำเร็จ" };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

// 4. แก้ไขข้อมูลพัสดุ + เติมสต็อก
//    [แก้บั๊ก] เดิมคิดยอดคงเหลือจาก "ส่วนต่างของยอดทั้งหมด" เท่านั้น
//    → ถ้า HR กรอกจำนวนที่รับเข้า/จำนวนที่มีจริง (ซึ่งไม่มากกว่ายอดทั้งหมดเดิม) คงเหลือจะยังเป็น 0 = "ของหมด"
//    ตอนนี้รองรับ 2 แบบ (คำนวณจากค่าล่าสุดในชีตใต้ Lock):
//      • addQty       = รับเข้าเพิ่ม X ชิ้น      → คงเหลือ +X, ยอดทั้งหมด +X
//      • setRemaining = นับสต็อกได้จริง N ชิ้น   → คงเหลือ = N, ยอดทั้งหมดปรับตามส่วนต่าง (ยอดที่เบิกไปแล้วคงเดิม)
//    ถ้าไม่ส่งทั้งสองค่า จะใช้วิธีเดิม (แก้ยอดทั้งหมด → คงเหลือปรับตามส่วนต่าง)
function editAsset(data) {
  if (data.addQty !== undefined || data.setRemaining !== undefined) return editAssetStock_(data);
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_SHEET);
    if (!sheet) return { status: "error", message: "ไม่พบชีท " + STOCK_SHEET };

    var stockData = sheet.getDataRange().getValues();
    var assetId = String(data.id || "").trim();
    var newTotal = parseInt(data.total) || 1;

    for (var i = 1; i < stockData.length; i++) {
      if (stockData[i][0].toString().trim() !== assetId) continue;
      var row = i + 1;
      var oldTotal = parseInt(stockData[i][3]) || 0;
      var oldRem = parseInt(stockData[i][4]);
      if (isNaN(oldRem)) oldRem = oldTotal;
      var newRem = Math.max(0, Math.min(newTotal, oldRem + (newTotal - oldTotal)));

      sheet.getRange(row, 2, 1, 4).setValues([[data.name, data.category, newTotal, newRem]]);
      sheet.getRange(row, 7).setValue(data.notes || "-");
      if (data.image) sheet.getRange(row, 6).setValue(toImageCell_(data.image, "asset_" + assetId));

      return { status: "success", message: "อัปเดตข้อมูลสำเร็จ (คงเหลือ " + newRem + " / " + newTotal + ")" };
    }
    return { status: "error", message: "ไม่พบรหัสอุปกรณ์" };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

function editAssetStock_(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_SHEET);
    if (!sheet) return { status: "error", message: "ไม่พบชีท " + STOCK_SHEET };

    var assetId = String(data.id || "").trim();
    var addQty = parseInt(data.addQty) || 0;
    var hasCount = data.setRemaining !== undefined && data.setRemaining !== null && String(data.setRemaining) !== "";
    var count = hasCount ? parseInt(data.setRemaining) : NaN;
    if (addQty < 0) return { status: "error", message: "จำนวนรับเข้าต้องไม่ติดลบ" };
    if (hasCount && (isNaN(count) || count < 0)) return { status: "error", message: "ยอดคงเหลือที่นับได้ไม่ถูกต้อง" };

    var stockData = sheet.getDataRange().getValues();
    for (var i = 1; i < stockData.length; i++) {
      if (stockData[i][0].toString().trim() !== assetId) continue;
      var row = i + 1;
      var oldTotal = parseInt(stockData[i][3]) || 0;
      var oldRem = parseInt(stockData[i][4]);
      if (isNaN(oldRem)) oldRem = oldTotal;

      var newRem = hasCount ? count : oldRem + addQty;
      var newTotal = Math.max(newRem, oldTotal + (newRem - oldRem));   // ยอดที่เบิกไปแล้ว (total - rem) คงเดิม

      sheet.getRange(row, 2, 1, 4).setValues([[data.name || stockData[i][1], data.category || stockData[i][2], newTotal, newRem]]);
      if (data.notes !== undefined) sheet.getRange(row, 7).setValue(data.notes || "-");
      if (data.image) sheet.getRange(row, 6).setValue(toImageCell_(data.image, "asset_" + assetId));

      return {
        status: "success", remaining: newRem, total: newTotal,
        message: "อัปเดตสต็อกสำเร็จ (คงเหลือ " + oldRem + " → " + newRem + " / ทั้งหมด " + newTotal + ")"
      };
    }
    return { status: "error", message: "ไม่พบรหัสอุปกรณ์" };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * HR แก้ "ยอดทั้งหมด" (คอลัมน์ D) ตรงในชีต Assets_Stock → ปรับ "คงเหลือ" (คอลัมน์ E) ตามส่วนต่างให้อัตโนมัติ
 * (เดิมแก้ D อย่างเดียว E ยังเป็น 0 → หน้าเว็บขึ้นว่าของหมด)
 * เป็น simple trigger ไม่ต้องตั้งค่าอะไรเพิ่ม · ทำงานเฉพาะการแก้ทีละเซลล์
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== STOCK_SHEET || e.range.getColumn() !== 4 || e.range.getRow() < 2) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;
    var oldTotal = parseInt(e.oldValue), newTotal = parseInt(e.value);
    if (isNaN(newTotal)) return;
    var remCell = sh.getRange(e.range.getRow(), 5);
    var rem = parseInt(remCell.getValue());
    if (isNaN(oldTotal)) {                       // แถวใหม่ / ไม่เคยมียอด → คงเหลือ = ยอดทั้งหมด
      if (isNaN(rem)) remCell.setValue(newTotal);
      return;
    }
    if (isNaN(rem)) rem = oldTotal;
    remCell.setValue(Math.max(0, Math.min(newTotal, rem + (newTotal - oldTotal))));
  } catch (err) {}
}

// 5. ลบอุปกรณ์ออกจากคลัง
function deleteAsset(assetId) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_SHEET);
    if (!sheet) return { status: "error", message: "ไม่พบชีท " + STOCK_SHEET };

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().trim() === String(assetId).trim()) {
        sheet.deleteRow(i + 1);
        return { status: "success", message: "ลบอุปกรณ์สำเร็จ" };
      }
    }
    return { status: "error", message: "ไม่พบรหัสอุปกรณ์" };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

// 6. ลบประวัติการเบิก (คืนยอดเข้าคลัง)
function deleteLog(txId) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName(LOG_SHEET);
    var stockSheet = ss.getSheetByName(STOCK_SHEET);
    if (!logSheet || !stockSheet) return { status: "error", message: "ไม่พบชีทประวัติหรือสต็อก" };

    var logData = logSheet.getDataRange().getValues();
    var assetId = "", qtyToRestore = 0, logRowIndex = -1;
    for (var i = 1; i < logData.length; i++) {
      if (logData[i][0].toString() === String(txId)) {
        assetId = logData[i][2];
        qtyToRestore = parseInt(logData[i][4]) || 0;
        logRowIndex = i + 1;
        break;
      }
    }
    if (logRowIndex === -1) return { status: "error", message: "ไม่พบรายการประวัตินี้ในระบบ" };

    logSheet.deleteRow(logRowIndex);

    if (assetId !== "" && qtyToRestore > 0) {
      var stockData = stockSheet.getDataRange().getValues();
      for (var k = 1; k < stockData.length; k++) {
        if (stockData[k][0].toString() === assetId.toString()) {
          var total = parseInt(stockData[k][3]) || 0;
          var cur = parseInt(stockData[k][4]) || 0;
          stockSheet.getRange(k + 1, 5).setValue(Math.min(total || Infinity, cur + qtyToRestore));
          break;
        }
      }
    }
    return { status: "success", message: "ลบประวัติและคืนยอดเข้าคลังสำเร็จ" };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

// 7. บันทึกการเบิกพัสดุ + ตัดสต็อก (ถูกเรียกจาก Approval.js หลังผู้อนุมัติเซ็นอนุมัติ)
function processRequisition(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var stockSheet = ss.getSheetByName(STOCK_SHEET);
    var logSheet = ss.getSheetByName(LOG_SHEET);
    if (!stockSheet || !logSheet) return { status: "error", message: "ไม่พบชีทระบบสต็อกหรือชีทประวัติ" };

    var assetId = String(data.assetId || "").trim();
    var qty = parseInt(data.quantity);
    if (!(qty > 0)) return { status: "error", message: "จำนวนที่เบิกไม่ถูกต้อง" };

    var stockData = stockSheet.getDataRange().getValues();
    var row = -1, assetName = "", currentRemaining = 0;
    for (var i = 1; i < stockData.length; i++) {
      if (stockData[i][0].toString().trim() === assetId) {
        assetName = stockData[i][1];
        currentRemaining = parseInt(stockData[i][4]);
        if (isNaN(currentRemaining)) currentRemaining = parseInt(stockData[i][3]) || 0;
        row = i + 1;
        break;
      }
    }
    if (row === -1) return { status: "error", message: "ไม่พบรหัสอุปกรณ์ " + assetId };
    if (currentRemaining < qty) {
      return { status: "error", message: "จำนวนคงเหลือไม่พอ (คงเหลือปัจจุบัน: " + currentRemaining + ", ขอเบิก: " + qty + ")" };
    }

    // บันทึก Log ก่อน แล้วค่อยตัดสต็อก → ถ้าบันทึก Log ล้มเหลว สต็อกจะไม่ถูกตัดทิ้งไว้ฟรี ๆ
    logSheet.appendRow([
      "TX-" + new Date().getTime(),
      new Date(),
      assetId,
      assetName,
      qty,
      data.staffName,
      data.department,
      data.branch,
      toImageCell_(data.imageBase64, "log_" + assetId + "_" + Date.now()),
      data.requisitionNotes || "-"
    ]);
    stockSheet.getRange(row, 5).setValue(currentRemaining - qty);

    return { status: "success", message: "บันทึกการเบิกและตัดสต็อกสำเร็จ" };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}