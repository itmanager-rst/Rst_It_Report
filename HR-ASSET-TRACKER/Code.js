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
var MOVE_SHEET = "Stock_Movements";          // ประวัติการเคลื่อนไหวสต็อกทุกประเภท (สร้างให้อัตโนมัติ)
var LEGACY_TZ = "Asia/Bangkok";

/* ======================= ประวัติการเคลื่อนไหวสต็อก =======================
 * ทุกครั้งที่ยอดคงเหลือเปลี่ยน จะบันทึก 1 แถวในชีต Stock_Movements:
 *   NEW        เพิ่มอุปกรณ์ใหม่เข้าคลัง
 *   IN         รับของเข้าเพิ่ม (เติมสต็อก)
 *   ADJUST     ปรับยอดตามการนับจริง / แก้ยอดทั้งหมดผ่านหน้าเว็บ
 *   OUT        เบิกออก (ตัดสต็อกเมื่ออนุมัติใบเบิก)
 *   CANCEL     ยกเลิกใบเบิก → คืนยอดเข้าคลัง
 *   RETURN     ลบประวัติการเบิก (ที่ไม่ผูกกับใบเบิก) → คืนยอดเข้าคลัง
 *   DELETE     ลบอุปกรณ์ออกจากคลัง
 *   SHEET_EDIT มีคนแก้ยอดตรงในชีต Assets_Stock
 * ชีตนี้ตั้งค่าเตือนเมื่อมีคนพยายามแก้ด้วยมือ (กันแก้ประวัติโดยไม่ตั้งใจ)
 */
var MOVE_HEADERS = ["moveId", "timestamp", "type", "assetId", "assetName", "qtyChange",
  "remBefore", "remAfter", "totalBefore", "totalAfter", "refId", "note", "byUser", "byName"];
var MOVE_ACTOR_ = null;                        // ผู้ใช้ที่ Login — Approval.js ตั้งค่าให้ทุกครั้งที่มีคำสั่งเข้ามา

function moveSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MOVE_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(MOVE_SHEET);
  sh.getRange("A:N").setNumberFormat("@");
  sh.getRange(1, 1, 1, MOVE_HEADERS.length).setValues([MOVE_HEADERS]).setFontWeight("bold").setBackground("#dcfce7");
  sh.setFrozenRows(1);
  try { sh.protect().setDescription("ประวัติสต็อก — ห้ามแก้ไขด้วยมือ").setWarningOnly(true); } catch (e) {}
  return sh;
}

/** บันทึกการเคลื่อนไหว 1 รายการ — ถ้าบันทึกไม่สำเร็จจะไม่ทำให้คำสั่งหลักล้ม (คืนข้อความเตือนแทน) */
function logMovement_(m) {
  try {
    var a = MOVE_ACTOR_ || {};
    var now = new Date();
    moveSheet_().appendRow([
      "MV-" + now.getTime() + "-" + Math.floor(Math.random() * 1000),
      Utilities.formatDate(now, LEGACY_TZ, "dd/MM/yyyy HH:mm:ss"),
      m.type, String(m.assetId || ""), String(m.assetName || ""),
      Number(m.remAfter || 0) - Number(m.remBefore || 0),
      m.remBefore, m.remAfter, m.totalBefore, m.totalAfter,
      String(m.refId || ""), String(m.note || ""),
      m.byUser || a.username || "", m.byName || a.fullName || a.username || ""
    ]);
    return "";
  } catch (e) {
    return " (⚠️ บันทึกประวัติสต็อกไม่สำเร็จ: " + e + ")";
  }
}

/** ประวัติการเคลื่อนไหว ใหม่ → เก่า (สูงสุด 3,000 รายการล่าสุด) */
function getStockMovements() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MOVE_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues();
  var head = v[0].map(String), out = [];
  for (var i = v.length - 1; i >= 1 && out.length < 3000; i--) {
    if (v[i][0] === "" || v[i][0] === null) continue;
    var o = {};
    head.forEach(function (h, c) {
      var x = v[i][c];
      o[h] = x instanceof Date ? Utilities.formatDate(x, LEGACY_TZ, "dd/MM/yyyy HH:mm:ss") : x;
    });
    out.push(o);
  }
  return out;
}

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
    var warn = logMovement_({ type: "NEW", assetId: id, assetName: data.name, remBefore: 0, remAfter: totalQty,
      totalBefore: 0, totalAfter: totalQty, note: "เพิ่มอุปกรณ์ใหม่เข้าคลัง" });
    return { status: "success", message: "เพิ่มอุปกรณ์ใหม่เข้าระบบสำเร็จ" + warn };
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
//      • addQty       = รับเข้าเพิ่ม X ชิ้น      → คงเหลือ +X, ยอดทั้งหมด +X                       (บันทึกเป็น IN)
//      • setRemaining = นับสต็อกได้จริง N ชิ้น   → คงเหลือ = N, ยอดที่เบิกไปแล้วคงเดิม           (บันทึกเป็น ADJUST)
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

      var warn = "";
      if (newRem !== oldRem || newTotal !== oldTotal) {
        warn = logMovement_({ type: "ADJUST", assetId: assetId, assetName: data.name, remBefore: oldRem, remAfter: newRem,
          totalBefore: oldTotal, totalAfter: newTotal, note: "แก้ยอดทั้งหมดผ่านหน้าเว็บ" });
      }
      return { status: "success", message: "อัปเดตข้อมูลสำเร็จ (คงเหลือ " + newRem + " / " + newTotal + ")" + warn };
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
    var stockNote = String(data.stockNote || "").trim();
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
      var name = data.name || stockData[i][1];

      sheet.getRange(row, 2, 1, 4).setValues([[name, data.category || stockData[i][2], newTotal, newRem]]);
      if (data.notes !== undefined) sheet.getRange(row, 7).setValue(data.notes || "-");
      if (data.image) sheet.getRange(row, 6).setValue(toImageCell_(data.image, "asset_" + assetId));

      var warn = "";
      if (newRem !== oldRem) {
        warn = logMovement_({
          type: hasCount ? "ADJUST" : "IN", assetId: assetId, assetName: name,
          remBefore: oldRem, remAfter: newRem, totalBefore: oldTotal, totalAfter: newTotal,
          note: (hasCount ? "ปรับยอดตามการนับจริง" : "รับของเข้าเพิ่ม") + (stockNote ? " · " + stockNote : "")
        });
      }
      return {
        status: "success", remaining: newRem, total: newTotal,
        message: "อัปเดตสต็อกสำเร็จ (คงเหลือ " + oldRem + " → " + newRem + " / ทั้งหมด " + newTotal + ")" + warn
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
 * มีคนแก้ยอดตรงในชีต Assets_Stock (simple trigger ไม่ต้องตั้งค่าเพิ่ม · ทำงานเมื่อแก้ทีละเซลล์)
 *   • แก้ "ยอดทั้งหมด" (D) → ปรับ "คงเหลือ" (E) ตามส่วนต่างให้อัตโนมัติ
 *   • แก้ "คงเหลือ" (E) ตรง ๆ → คงค่าตามที่แก้
 *   ทั้งสองกรณีบันทึกลง Stock_Movements เป็น SHEET_EDIT (ย้อนดูได้ว่าใครแก้)
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== STOCK_SHEET || e.range.getRow() < 2) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;
    var col = e.range.getColumn();
    if (col !== 4 && col !== 5) return;

    var r = e.range.getRow();
    var rowVals = sh.getRange(r, 1, 1, 5).getValues()[0];
    var who = "";
    try { who = (e.user && e.user.getEmail()) || Session.getActiveUser().getEmail() || ""; } catch (x) {}
    var actor = { byUser: who || "sheet", byName: (who || "แก้ในชีต") + " (แก้ในชีต)" };
    var oldV = parseInt(e.oldValue), newV = parseInt(e.value);
    if (isNaN(newV)) return;

    if (col === 4) {                                   // แก้ยอดทั้งหมด
      var remCell = sh.getRange(r, 5);
      var rem = parseInt(rowVals[4]);
      if (isNaN(oldV)) {                               // แถวใหม่ / ไม่เคยมียอด → คงเหลือ = ยอดทั้งหมด
        if (isNaN(rem)) {
          remCell.setValue(newV);
          logMovement_(merge_({ type: "SHEET_EDIT", assetId: rowVals[0], assetName: rowVals[1], remBefore: 0, remAfter: newV,
            totalBefore: 0, totalAfter: newV, note: "กรอกยอดทั้งหมดในชีต (แถวใหม่)" }, actor));
        }
        return;
      }
      if (isNaN(rem)) rem = oldV;
      var newRem = Math.max(0, Math.min(newV, rem + (newV - oldV)));
      remCell.setValue(newRem);
      logMovement_(merge_({ type: "SHEET_EDIT", assetId: rowVals[0], assetName: rowVals[1], remBefore: rem, remAfter: newRem,
        totalBefore: oldV, totalAfter: newV, note: "แก้ยอดทั้งหมดในชีต " + oldV + " → " + newV }, actor));
    } else {                                           // แก้คงเหลือตรง ๆ
      var tot = parseInt(rowVals[3]) || 0;
      var before = isNaN(oldV) ? tot : oldV;
      if (before === newV) return;
      logMovement_(merge_({ type: "SHEET_EDIT", assetId: rowVals[0], assetName: rowVals[1], remBefore: before, remAfter: newV,
        totalBefore: tot, totalAfter: tot, note: "แก้ยอดคงเหลือในชีต " + before + " → " + newV }, actor));
    }
  } catch (err) {}
}
function merge_(a, b) { for (var k in b) a[k] = b[k]; return a; }

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
        var tot = parseInt(data[i][3]) || 0, rem = parseInt(data[i][4]);
        if (isNaN(rem)) rem = tot;
        sheet.deleteRow(i + 1);
        var warn = logMovement_({ type: "DELETE", assetId: assetId, assetName: data[i][1], remBefore: rem, remAfter: 0,
          totalBefore: tot, totalAfter: 0, note: "ลบอุปกรณ์ออกจากคลัง" });
        return { status: "success", message: "ลบอุปกรณ์สำเร็จ" + warn };
      }
    }
    return { status: "error", message: "ไม่พบรหัสอุปกรณ์" };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

/** ดึงเลขที่ใบเบิกจากหมายเหตุในประวัติการเบิก เช่น "... [ใบเบิก RQ-261105-001 อนุมัติโดย ...]" */
function reqIdFromNote_(note) {
  var m = String(note || "").match(/\[ใบเบิก (RQ-\S+) /);
  return m ? m[1] : "";
}

/** คืนยอดเข้าคลัง (ไม่จำกัดที่ยอดทั้งหมด: ถ้าข้อมูลเดิมเพี้ยน จะขยายยอดทั้งหมดแทนการทิ้งของ) */
function restoreStock_(stockSheet, assetId, qty) {
  var stockData = stockSheet.getDataRange().getValues();
  for (var k = 1; k < stockData.length; k++) {
    if (stockData[k][0].toString().trim() !== String(assetId).trim()) continue;
    var total = parseInt(stockData[k][3]) || 0;
    var cur = parseInt(stockData[k][4]);
    if (isNaN(cur)) cur = total;
    var rem = cur + qty, newTotal = Math.max(total, rem);
    stockSheet.getRange(k + 1, 4, 1, 2).setValues([[newTotal, rem]]);
    return { found: true, name: stockData[k][1], remBefore: cur, remAfter: rem, totalBefore: total, totalAfter: newTotal };
  }
  return { found: false };
}

// 6. ลบประวัติการเบิก (คืนยอดเข้าคลัง)
//    [ปิดช่องโหว่] ประวัติที่มาจากใบเบิก (ผ่านการอนุมัติ) ห้ามลบตรง ๆ — ต้อง "ยกเลิกใบเบิก" แทน
//    เพื่อให้สถานะใบเบิก ยอดสต็อก และประวัติ ตรงกันเสมอ
function deleteLog(txId) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName(LOG_SHEET);
    var stockSheet = ss.getSheetByName(STOCK_SHEET);
    if (!logSheet || !stockSheet) return { status: "error", message: "ไม่พบชีทประวัติหรือสต็อก" };

    var logData = logSheet.getDataRange().getValues();
    var row = null, logRowIndex = -1;
    for (var i = 1; i < logData.length; i++) {
      if (logData[i][0].toString() === String(txId)) { row = logData[i]; logRowIndex = i + 1; break; }
    }
    if (logRowIndex === -1) return { status: "error", message: "ไม่พบรายการประวัตินี้ในระบบ" };

    var linkedReq = reqIdFromNote_(row[9]);
    if (linkedReq) {
      return { status: "error", message: "ประวัตินี้มาจากใบเบิก " + linkedReq + " — ลบตรงไม่ได้ ให้ใช้ปุ่ม 🚫 ยกเลิกใบเบิก แทน (ระบบจะคืนยอดและบันทึกประวัติให้)" };
    }

    var assetId = row[2], qtyToRestore = parseInt(row[4]) || 0;
    logSheet.deleteRow(logRowIndex);

    var warn = "";
    if (assetId !== "" && qtyToRestore > 0) {
      var s = restoreStock_(stockSheet, assetId, qtyToRestore);
      if (s.found) {
        warn = logMovement_({ type: "RETURN", assetId: assetId, assetName: s.name, remBefore: s.remBefore, remAfter: s.remAfter,
          totalBefore: s.totalBefore, totalAfter: s.totalAfter, refId: txId,
          note: "ลบประวัติการเบิก (" + (row[5] || "-") + " / " + (row[7] || "-") + ") คืนยอดเข้าคลัง" });
      }
    }
    return { status: "success", message: "ลบประวัติและคืนยอดเข้าคลังสำเร็จ" + warn };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ยกเลิกใบเบิกที่ตัดสต็อกไปแล้ว (เรียกจาก Approval.js → cancelRequest_)
 *   ลบแถวประวัติการเบิกของใบนั้น (ยอดเบิกใน Dashboard จะไม่นับซ้ำ) + คืนยอดเข้าคลัง + บันทึก CANCEL
 *   ถ้าไม่พบประวัติ (เคยถูกลบและคืนยอดไปแล้ว) → ไม่คืนยอดซ้ำ
 */
function reverseRequisition_(requestId, txId, reason) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName(LOG_SHEET);
    var stockSheet = ss.getSheetByName(STOCK_SHEET);
    if (!logSheet || !stockSheet) return { status: "error", message: "ไม่พบชีทประวัติหรือสต็อก" };

    var logData = logSheet.getDataRange().getValues();
    var idx = -1;
    for (var i = logData.length - 1; i >= 1; i--) {
      if ((txId && String(logData[i][0]) === String(txId)) || reqIdFromNote_(logData[i][9]) === String(requestId)) { idx = i; break; }
    }
    if (idx < 0) return { status: "success", restored: 0, logFound: false };

    var row = logData[idx];
    var qty = parseInt(row[4]) || 0;
    logSheet.deleteRow(idx + 1);
    var s = restoreStock_(stockSheet, row[2], qty);
    var warn = "";
    if (s.found) {
      warn = logMovement_({ type: "CANCEL", assetId: row[2], assetName: s.name, remBefore: s.remBefore, remAfter: s.remAfter,
        totalBefore: s.totalBefore, totalAfter: s.totalAfter, refId: requestId,
        note: "ยกเลิกใบเบิก คืนยอดเข้าคลัง · เหตุผล: " + reason });
    }
    return { status: "success", restored: s.found ? qty : 0, logFound: true, assetFound: s.found, warn: warn };
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
    var row = -1, assetName = "", currentRemaining = 0, total = 0;
    for (var i = 1; i < stockData.length; i++) {
      if (stockData[i][0].toString().trim() === assetId) {
        assetName = stockData[i][1];
        total = parseInt(stockData[i][3]) || 0;
        currentRemaining = parseInt(stockData[i][4]);
        if (isNaN(currentRemaining)) currentRemaining = total;
        row = i + 1;
        break;
      }
    }
    if (row === -1) return { status: "error", message: "ไม่พบรหัสอุปกรณ์ " + assetId };
    if (currentRemaining < qty) {
      return { status: "error", message: "จำนวนคงเหลือไม่พอ (คงเหลือปัจจุบัน: " + currentRemaining + ", ขอเบิก: " + qty + ")" };
    }

    // บันทึก Log ก่อน แล้วค่อยตัดสต็อก → ถ้าบันทึก Log ล้มเหลว สต็อกจะไม่ถูกตัดทิ้งไว้ฟรี ๆ
    var txId = "TX-" + new Date().getTime();
    logSheet.appendRow([
      txId,
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

    var warn = logMovement_({ type: "OUT", assetId: assetId, assetName: assetName, remBefore: currentRemaining,
      remAfter: currentRemaining - qty, totalBefore: total, totalAfter: total, refId: data.requestId || txId,
      note: "เบิกออก: " + (data.staffName || "-") + " / " + (data.branch || "-") });
    return { status: "success", txId: txId, message: "บันทึกการเบิกและตัดสต็อกสำเร็จ" + warn };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}