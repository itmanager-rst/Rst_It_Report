/**
 * SITEASSET TRACKER - Google Apps Script (Legacy Core: สต็อก + ประวัติการเบิก)
 * ---------------------------------------------------------------------------
 * ⚠️ ไฟล์นี้ทำงานคู่กับ Approval.js
 *    - doGet / doPost ตัวจริงอยู่ใน Approval.js (ตรวจ Login + สิทธิ์ก่อน)
 *    - ไฟล์นี้จึงต้องใช้ชื่อ doGetLegacy / doPostLegacy เท่านั้น
 *      (ถ้ามี doGet/doPost ซ้ำ 2 ไฟล์ Apps Script จะเรียกผิดตัว และ Approval.js จะหา doGetLegacy ไม่เจอ)
 *
 * 🏢 รองรับ 2 แผนก (คลังแยกกันเด็ดขาด — ชีตคนละชุด):
 *    HR  : Assets_Stock     / Requisition_Log     / Stock_Movements
 *    HQ  : HQ_Assets_Stock  / HQ_Requisition_Log  / HQ_Stock_Movements   (HQ_Office: ปากกา ดินสอ ยางลบ ...)
 *    ทุกฟังก์ชันรับค่า dept ('HR' | 'HQ') — ไม่ส่งมา = 'HR' (เข้ากันได้กับระบบเดิม 100%)
 *    ชีตของ HQ สร้างให้อัตโนมัติ หรือกด ▶ Run ฟังก์ชัน setupHQOffice ครั้งเดียว
 */

var STOCK_SHEET = "Assets_Stock";            // (ชื่อเดิม — ใช้กับ HR)
var LOG_SHEET = "Requisition_Log";
var MOVE_SHEET = "Stock_Movements";
var LEGACY_TZ = "Asia/Bangkok";

var DEPTS_ = {
  HR: { code: "HR", label: "HR", fullLabel: "ฝ่ายทรัพยากรบุคคล (HR)",
        stock: "Assets_Stock", log: "Requisition_Log", move: "Stock_Movements" },
  HQ: { code: "HQ", label: "HQ_Office", fullLabel: "สำนักงานใหญ่ (HQ_Office)",
        stock: "HQ_Assets_Stock", log: "HQ_Requisition_Log", move: "HQ_Stock_Movements" }
};
var DEPT_CODES_ = ["HR", "HQ"];
var STOCK_HEADERS_ = ["รหัสอุปกรณ์", "ชื่ออุปกรณ์", "หมวดหมู่", "จำนวนทั้งหมด", "คงเหลือ", "รูปภาพ", "หมายเหตุ/สถานที่เก็บ"];
var LOG_HEADERS_ = ["txId", "วันที่เวลา", "รหัสอุปกรณ์", "ชื่ออุปกรณ์", "จำนวน", "ผู้เบิก", "แผนก", "สาขา", "รูปหลักฐาน", "หมายเหตุ"];

/** 'HQ' / 'HQ_OFFICE' / 'hq' → 'HQ' · อื่น ๆ / ว่าง → 'HR' */
function normDept_(d) {
  d = String(d || "").trim().toUpperCase();
  return (d === "HQ" || d === "HQ_OFFICE" || d === "HQOFFICE") ? "HQ" : "HR";
}
function deptCfg_(d) { return DEPTS_[normDept_(d)]; }
/** 'ALL' → ทั้งสองแผนก */
function deptList_(d) {
  return String(d || "").trim().toUpperCase() === "ALL" ? DEPT_CODES_.slice() : [normDept_(d)];
}

function ensureLegacySheet_(name, headers, color, textCols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  if (textCols) sh.getRange(textCols).setNumberFormat("@");
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground(color);
  sh.setFrozenRows(1);
  return sh;
}
/** ชีตสต็อก / ประวัติการเบิก ของแผนก (สร้างให้อัตโนมัติถ้ายังไม่มี) */
function stockSheet_(dept) { var c = deptCfg_(dept); return ensureLegacySheet_(c.stock, STOCK_HEADERS_, c.code === "HQ" ? "#fef3c7" : "#dbeafe", "A:A"); }
function logSheet_(dept)   { var c = deptCfg_(dept); return ensureLegacySheet_(c.log, LOG_HEADERS_, c.code === "HQ" ? "#fef3c7" : "#e0e7ff", "A:A"); }
/** อ่านอย่างเดียว: ไม่มีชีต = null (ไม่สร้างชีตเปล่าตอนดึงรายงาน) */
function stockSheetRO_(dept) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(deptCfg_(dept).stock); }
function logSheetRO_(dept)   { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(deptCfg_(dept).log); }

/**
 * ▶ Run ครั้งเดียวใน Editor: สร้างชีตของ HQ_Office + ใส่ตัวอย่างเครื่องเขียน (เฉพาะตอนชีตยังว่าง)
 */
function setupHQOffice() {
  var sh = stockSheet_("HQ");
  logSheet_("HQ");
  moveSheet_("HQ");
  if (sh.getLastRow() < 2) {
    var seed = [
      ["OF-001", "ปากกาลูกลื่น สีน้ำเงิน", "เครื่องเขียน", 100, 100, "", "ตู้เครื่องเขียน HQ ชั้น 1"],
      ["OF-002", "ปากกาลูกลื่น สีแดง", "เครื่องเขียน", 50, 50, "", "ตู้เครื่องเขียน HQ ชั้น 1"],
      ["OF-003", "ดินสอ 2B", "เครื่องเขียน", 60, 60, "", "ตู้เครื่องเขียน HQ ชั้น 1"],
      ["OF-004", "ยางลบ", "เครื่องเขียน", 40, 40, "", "ตู้เครื่องเขียน HQ ชั้น 1"],
      ["OF-005", "ไม้บรรทัด 30 ซม.", "เครื่องเขียน", 20, 20, "", "ตู้เครื่องเขียน HQ ชั้น 1"],
      ["OF-006", "กระดาษ A4 80 แกรม (รีม)", "กระดาษ", 30, 30, "", "ห้องเก็บของ HQ"]
    ];
    sh.getRange(2, 1, seed.length, seed[0].length).setValues(seed);
    seed.forEach(function (r) {
      logMovement_({ dept: "HQ", type: "NEW", assetId: r[0], assetName: r[1], remBefore: 0, remAfter: r[4],
        totalBefore: 0, totalAfter: r[3], note: "ตั้งค่าเริ่มต้น HQ_Office (setupHQOffice)", byUser: "system", byName: "ติดตั้งระบบ" });
    });
  }
  Logger.log("✓ พร้อมใช้งาน: HQ_Assets_Stock / HQ_Requisition_Log / HQ_Stock_Movements");
}

/* ======================= ประวัติการเคลื่อนไหวสต็อก =======================
 * ทุกครั้งที่ยอดคงเหลือเปลี่ยน จะบันทึก 1 แถวในชีต Stock_Movements (HR) / HQ_Stock_Movements (HQ):
 *   NEW / IN / ADJUST / OUT / CANCEL / RETURN / DELETE / SHEET_EDIT
 */
var MOVE_HEADERS = ["moveId", "timestamp", "type", "assetId", "assetName", "qtyChange",
  "remBefore", "remAfter", "totalBefore", "totalAfter", "refId", "note", "byUser", "byName"];
var MOVE_ACTOR_ = null;                        // ผู้ใช้ที่ Login — Approval.js ตั้งค่าให้ทุกครั้งที่มีคำสั่งเข้ามา

function moveSheet_(dept) {
  var c = deptCfg_(dept);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(c.move);
  if (sh) return sh;
  sh = ss.insertSheet(c.move);
  sh.getRange("A:N").setNumberFormat("@");
  sh.getRange(1, 1, 1, MOVE_HEADERS.length).setValues([MOVE_HEADERS]).setFontWeight("bold").setBackground(c.code === "HQ" ? "#fef3c7" : "#dcfce7");
  sh.setFrozenRows(1);
  try { sh.protect().setDescription("ประวัติสต็อก " + c.label + " — ห้ามแก้ไขด้วยมือ").setWarningOnly(true); } catch (e) {}
  return sh;
}

/** บันทึกการเคลื่อนไหว 1 รายการ (m.dept = แผนก) — ถ้าบันทึกไม่สำเร็จจะไม่ทำให้คำสั่งหลักล้ม */
function logMovement_(m) {
  try {
    var a = MOVE_ACTOR_ || {};
    var now = new Date();
    moveSheet_(m.dept).appendRow([
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

/** ประวัติการเคลื่อนไหว ใหม่ → เก่า (สูงสุด 3,000 รายการต่อแผนก) · dept = 'HR' | 'HQ' | 'ALL' */
function getStockMovements(dept) {
  var out = [];
  deptList_(dept === undefined ? "ALL" : dept).forEach(function (d) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEPTS_[d].move);
    if (!sh || sh.getLastRow() < 2) return;
    var v = sh.getDataRange().getValues();
    var head = v[0].map(String), n = 0;
    for (var i = v.length - 1; i >= 1 && n < 3000; i--) {
      if (v[i][0] === "" || v[i][0] === null) continue;
      var o = { dept: d };
      head.forEach(function (h, c) {
        var x = v[i][c];
        o[h] = x instanceof Date ? Utilities.formatDate(x, LEGACY_TZ, "dd/MM/yyyy HH:mm:ss") : x;
      });
      out.push(o); n++;
    }
  });
  var ms = function (m) { var p = String(m.moveId || "").split("-"); return Number(p[1]) || 0; };
  out.sort(function (a, b) { return ms(b) - ms(a); });
  return out;
}

function doGetLegacy(e) {
  var p = e && e.parameter ? e.parameter : {};
  var action = p.action || "";

  if (action === "getAssets") return jsonLegacy_(getAssetList(p.dept || "ALL"));
  if (action === "getLogs") return jsonLegacy_(getRequisitionLogs(p.dept || "ALL"));

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
      result = getAssetList(data.dept || "ALL");
    } else if (action === "addAsset") {
      result = addAsset(data);
    } else if (action === "editAsset") {
      result = editAsset(data);
    } else if (action === "deleteAsset") {
      result = deleteAsset(data.assetId, data.dept);
    } else if (action === "deleteLog") {
      result = deleteLog(data.txId, data.dept);
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

// 1. ดึงรายการอุปกรณ์พร้อมประวัติผู้เบิกล่าสุด · dept = 'HR' | 'HQ' | 'ALL' (ทุกแถวมี field dept)
function getAssetList(dept) {
  var list = [];
  deptList_(dept === undefined ? "HR" : dept).forEach(function (d) {
    try {
      var sheet = stockSheetRO_(d);
      if (!sheet) return;
      var logSheet = logSheetRO_(d);
      var data = sheet.getDataRange().getValues();
      var logData = logSheet ? logSheet.getDataRange().getValues() : [];

      var lastLogMap = {};
      for (var j = logData.length - 1; j >= 1; j--) {
        var aId = logData[j][2] ? logData[j][2].toString() : "";
        if (aId && !lastLogMap[aId]) lastLogMap[aId] = { borrower: logData[j][5] || "-", branch: logData[j][7] || "-" };
      }

      for (var i = 1; i < data.length; i++) {
        if (data[i][0] === "" || data[i][0] === null) continue;
        var assetId = data[i][0].toString();
        var total = parseInt(data[i][3]) || 0;
        var rem = parseInt(data[i][4]);
        if (isNaN(rem)) rem = total;                     // คอลัมน์ E ว่าง = ยังไม่เคยเบิก
        var lastLog = lastLogMap[assetId] || { borrower: "-", branch: "-" };
        list.push({
          dept: d,
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
    } catch (e) {}
  });
  return list;
}

// 2. ดึงรายงานประวัติการเบิก (ใหม่ → เก่า) · dept = 'HR' | 'HQ' | 'ALL' → รวมรายงานทั้งสองแผนกได้
function getRequisitionLogs(dept) {
  var logs = [];
  deptList_(dept === undefined ? "HR" : dept).forEach(function (d) {
    try {
      var sheet = logSheetRO_(d);
      if (!sheet) return;
      var data = sheet.getDataRange().getValues();
      for (var i = data.length - 1; i >= 1; i--) {
        if (data[i][0] === "" || data[i][0] === null) continue;
        var isDate = data[i][1] instanceof Date;
        logs.push({
          dept: d,
          txId: data[i][0],
          timestamp: isDate ? Utilities.formatDate(data[i][1], LEGACY_TZ, "dd/MM/yyyy HH:mm") : String(data[i][1]),
          assetId: data[i][2],
          assetName: data[i][3],
          quantity: data[i][4],
          staffName: data[i][5],
          department: data[i][6],
          branch: data[i][7],
          image: data[i][8] || "",
          notes: data[i][9] || "-",
          _t: isDate ? data[i][1].getTime() : txTime_(data[i][0])
        });
      }
    } catch (e) {}
  });
  logs.sort(function (a, b) { return b._t - a._t; });
  logs.forEach(function (l) { delete l._t; });
  return logs;
}
/** TX-1730000000000-2 → 1730000000000 (ใช้เรียงลำดับเมื่อเวลาไม่ใช่ Date) */
function txTime_(tx) { var m = String(tx || "").match(/TX-(\d+)/); return m ? Number(m[1]) : 0; }

// 3. เพิ่มอุปกรณ์ใหม่เข้าคลัง (data.dept = แผนกเจ้าของคลัง)
function addAsset(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var dept = normDept_(data.dept);
    var sheet = stockSheet_(dept);

    var id = String(data.id || "").trim();
    if (!id || !data.name) return { status: "error", message: "กรุณาระบุรหัสและชื่ออุปกรณ์" };

    var ids = sheet.getDataRange().getValues().slice(1).map(function (r) { return String(r[0]).trim(); });
    if (ids.indexOf(id) >= 0) return { status: "error", message: "รหัสอุปกรณ์ \"" + id + "\" มีอยู่แล้วในคลัง " + DEPTS_[dept].label };

    var totalQty = parseInt(data.total) || 1;
    sheet.appendRow([
      id, data.name, data.category, totalQty, totalQty,
      toImageCell_(data.image, (dept === "HQ" ? "hq_asset_" : "asset_") + id),
      data.notes || "-"
    ]);
    var warn = logMovement_({ dept: dept, type: "NEW", assetId: id, assetName: data.name, remBefore: 0, remAfter: totalQty,
      totalBefore: 0, totalAfter: totalQty, note: "เพิ่มอุปกรณ์ใหม่เข้าคลัง " + DEPTS_[dept].label });
    return { status: "success", message: "เพิ่มอุปกรณ์ใหม่เข้าคลัง " + DEPTS_[dept].label + " สำเร็จ" + warn };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

// 4. แก้ไขข้อมูลพัสดุ + เติมสต็อก
//      • addQty       = รับเข้าเพิ่ม X ชิ้น      → คงเหลือ +X, ยอดทั้งหมด +X   (IN)
//      • setRemaining = นับสต็อกได้จริง N ชิ้น   → คงเหลือ = N               (ADJUST)
//    ถ้าไม่ส่งทั้งสองค่า จะใช้วิธีเดิม (แก้ยอดทั้งหมด → คงเหลือปรับตามส่วนต่าง)
function editAsset(data) {
  if (data.addQty !== undefined || data.setRemaining !== undefined) return editAssetStock_(data);
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var dept = normDept_(data.dept);
    var sheet = stockSheet_(dept);

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
      if (data.image) sheet.getRange(row, 6).setValue(toImageCell_(data.image, (dept === "HQ" ? "hq_asset_" : "asset_") + assetId));

      var warn = "";
      if (newRem !== oldRem || newTotal !== oldTotal) {
        warn = logMovement_({ dept: dept, type: "ADJUST", assetId: assetId, assetName: data.name, remBefore: oldRem, remAfter: newRem,
          totalBefore: oldTotal, totalAfter: newTotal, note: "แก้ยอดทั้งหมดผ่านหน้าเว็บ" });
      }
      return { status: "success", message: "อัปเดตข้อมูลสำเร็จ (คงเหลือ " + newRem + " / " + newTotal + ")" + warn };
    }
    return { status: "error", message: "ไม่พบรหัสอุปกรณ์ในคลัง " + DEPTS_[dept].label };
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
    var dept = normDept_(data.dept);
    var sheet = stockSheet_(dept);

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
      if (data.image) sheet.getRange(row, 6).setValue(toImageCell_(data.image, (dept === "HQ" ? "hq_asset_" : "asset_") + assetId));

      var warn = "";
      if (newRem !== oldRem) {
        warn = logMovement_({
          dept: dept, type: hasCount ? "ADJUST" : "IN", assetId: assetId, assetName: name,
          remBefore: oldRem, remAfter: newRem, totalBefore: oldTotal, totalAfter: newTotal,
          note: (hasCount ? "ปรับยอดตามการนับจริง" : "รับของเข้าเพิ่ม") + (stockNote ? " · " + stockNote : "")
        });
      }
      return {
        status: "success", remaining: newRem, total: newTotal,
        message: "อัปเดตสต็อก " + DEPTS_[dept].label + " สำเร็จ (คงเหลือ " + oldRem + " → " + newRem + " / ทั้งหมด " + newTotal + ")" + warn
      };
    }
    return { status: "error", message: "ไม่พบรหัสอุปกรณ์ในคลัง " + DEPTS_[dept].label };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * มีคนแก้ยอดตรงในชีต Assets_Stock / HQ_Assets_Stock (simple trigger · ทำงานเมื่อแก้ทีละเซลล์)
 *   • แก้ "ยอดทั้งหมด" (D) → ปรับ "คงเหลือ" (E) ตามส่วนต่างให้อัตโนมัติ
 *   • แก้ "คงเหลือ" (E) ตรง ๆ → คงค่าตามที่แก้
 *   บันทึกลงประวัติสต็อกของแผนกนั้นเป็น SHEET_EDIT
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var name = sh.getName();
    var dept = name === DEPTS_.HQ.stock ? "HQ" : name === DEPTS_.HR.stock ? "HR" : "";
    if (!dept || e.range.getRow() < 2) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;
    var col = e.range.getColumn();
    if (col !== 4 && col !== 5) return;

    var r = e.range.getRow();
    var rowVals = sh.getRange(r, 1, 1, 5).getValues()[0];
    var who = "";
    try { who = (e.user && e.user.getEmail()) || Session.getActiveUser().getEmail() || ""; } catch (x) {}
    var actor = { dept: dept, byUser: who || "sheet", byName: (who || "แก้ในชีต") + " (แก้ในชีต)" };
    var oldV = parseInt(e.oldValue), newV = parseInt(e.value);
    if (isNaN(newV)) return;

    if (col === 4) {                                   // แก้ยอดทั้งหมด
      var remCell = sh.getRange(r, 5);
      var rem = parseInt(rowVals[4]);
      if (isNaN(oldV)) {
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
function deleteAsset(assetId, dept) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    dept = normDept_(dept);
    var sheet = stockSheet_(dept);

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().trim() === String(assetId).trim()) {
        var tot = parseInt(data[i][3]) || 0, rem = parseInt(data[i][4]);
        if (isNaN(rem)) rem = tot;
        sheet.deleteRow(i + 1);
        var warn = logMovement_({ dept: dept, type: "DELETE", assetId: assetId, assetName: data[i][1], remBefore: rem, remAfter: 0,
          totalBefore: tot, totalAfter: 0, note: "ลบอุปกรณ์ออกจากคลัง " + DEPTS_[dept].label });
        return { status: "success", message: "ลบอุปกรณ์สำเร็จ" + warn };
      }
    }
    return { status: "error", message: "ไม่พบรหัสอุปกรณ์ในคลัง " + DEPTS_[dept].label };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

/** ดึงเลขที่ใบเบิกจากหมายเหตุ เช่น "... [ใบเบิก RQ-261105-001 อนุมัติโดย ...]" หรือ "[ใบเบิก HQ-261110-002 ...]" */
function reqIdFromNote_(note) {
  var m = String(note || "").match(/\[ใบเบิก ((?:RQ|HQ)-\S+) /);
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

// 6. ลบประวัติการเบิก (คืนยอดเข้าคลัง) — ประวัติที่มาจากใบเบิกห้ามลบตรง ต้อง "ยกเลิกใบเบิก" แทน
function deleteLog(txId, dept) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    dept = normDept_(dept);
    var logSheet = logSheet_(dept);
    var stockSheet = stockSheet_(dept);

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
        warn = logMovement_({ dept: dept, type: "RETURN", assetId: assetId, assetName: s.name, remBefore: s.remBefore, remAfter: s.remAfter,
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
 *   ลบแถวประวัติการเบิกทุกแถวของใบนั้น + คืนยอดเข้าคลังของแผนกนั้น + บันทึก CANCEL
 */
function reverseRequisition_(requestId, txId, reason, dept) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    dept = normDept_(dept);
    var logSheet = logSheet_(dept);
    var stockSheet = stockSheet_(dept);

    var txSet = {};
    String(txId || "").split(",").forEach(function (x) { x = x.trim(); if (x) txSet[x] = true; });

    var logData = logSheet.getDataRange().getValues();
    var hits = [];
    for (var i = logData.length - 1; i >= 1; i--) {         // ล่าง → บน (ลบแถวแล้วเลขแถวด้านบนไม่เลื่อน)
      if (txSet[String(logData[i][0])] || reqIdFromNote_(logData[i][9]) === String(requestId)) hits.push(i);
    }
    if (!hits.length) return { status: "success", restored: 0, lines: 0, logFound: false };

    var restored = 0, missing = [], warn = "";
    hits.forEach(function (idx) {
      var row = logData[idx];
      var qty = parseInt(row[4]) || 0;
      logSheet.deleteRow(idx + 1);
      var s = restoreStock_(stockSheet, row[2], qty);
      if (s.found) {
        restored += qty;
        warn = logMovement_({ dept: dept, type: "CANCEL", assetId: row[2], assetName: s.name, remBefore: s.remBefore, remAfter: s.remAfter,
          totalBefore: s.totalBefore, totalAfter: s.totalAfter, refId: requestId,
          note: "ยกเลิกใบเบิก คืนยอดเข้าคลัง · เหตุผล: " + reason }) || warn;
      } else {
        missing.push(String(row[2]));
      }
    });
    return { status: "success", restored: restored, lines: hits.length, logFound: true,
      assetFound: missing.length === 0, missingAssets: missing, warn: warn };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 7b. ตัดสต็อกใบเบิกหลายรายการในครั้งเดียว (เรียกจาก Approval.js หลังอนุมัติ)
 *   data.dept  = คลังที่ตัด ('HR' | 'HQ')
 *   data.items = [{ assetId, quantity }, ...]
 *   ตรวจยอดคงเหลือทุกรายการก่อน → ถ้ามีรายการไหนไม่พอ/ไม่พบ จะไม่ตัดอะไรเลย (all-or-nothing)
 */
function processRequisitionBatch_(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var dept = normDept_(data.dept);
    var stockSheet = stockSheet_(dept);
    var logSheet = logSheet_(dept);

    var items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return { status: "error", message: "ใบเบิกไม่มีรายการอุปกรณ์" };

    var stockData = stockSheet.getDataRange().getValues();
    var idx = {};
    for (var i = 1; i < stockData.length; i++) {
      var id = String(stockData[i][0]).trim();
      if (!id || idx[id]) continue;
      var total = parseInt(stockData[i][3]) || 0;
      var rem = parseInt(stockData[i][4]);
      if (isNaN(rem)) rem = total;
      idx[id] = { row: i + 1, name: stockData[i][1], total: total, rem: rem, need: 0 };
    }

    var errs = [];
    items.forEach(function (it) {
      var aid = String(it.assetId || "").trim(), q = parseInt(it.quantity);
      if (!(q > 0)) { errs.push(aid + ": จำนวนไม่ถูกต้อง"); return; }
      if (!idx[aid]) { errs.push(aid + ": ไม่พบในคลัง " + DEPTS_[dept].label); return; }
      idx[aid].need += q;
    });
    Object.keys(idx).forEach(function (aid) {
      var s = idx[aid];
      if (s.need > s.rem) errs.push(aid + " " + s.name + ": คงเหลือ " + s.rem + " แต่ขอเบิก " + s.need);
    });
    if (errs.length) return { status: "error", message: "สต็อก " + DEPTS_[dept].label + " ไม่พอ / ข้อมูลไม่ถูกต้อง — ยังไม่ได้ตัดสต็อก\n• " + errs.join("\n• ") };

    var now = new Date(), base = now.getTime();
    var img = toImageCell_(data.imageBase64, "log_" + (data.requestId || base));
    var txIds = [], rows = [];
    items.forEach(function (it, n) {
      var aid = String(it.assetId).trim();
      var tx = "TX-" + base + (items.length > 1 ? "-" + (n + 1) : "");
      txIds.push(tx);
      rows.push([tx, now, aid, idx[aid].name, parseInt(it.quantity), data.staffName, data.department, data.branch, img, data.requisitionNotes || "-"]);
    });
    logSheet.getRange(logSheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    var warn = "";
    items.forEach(function (it) {
      var aid = String(it.assetId).trim(), q = parseInt(it.quantity), s = idx[aid];
      var before = s.rem;
      s.rem -= q;
      stockSheet.getRange(s.row, 5).setValue(s.rem);
      warn = logMovement_({ dept: dept, type: "OUT", assetId: aid, assetName: s.name, remBefore: before, remAfter: s.rem,
        totalBefore: s.total, totalAfter: s.total, refId: data.requestId || txIds[0],
        note: "เบิกออก: " + (data.staffName || "-") + " / " + (data.branch || "-") }) || warn;
    });
    return { status: "success", txIds: txIds, txId: txIds[0], message: "บันทึกการเบิกและตัดสต็อกสำเร็จ " + items.length + " รายการ" + warn };
  } catch (error) {
    return { status: "error", message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

// 7. บันทึกการเบิก 1 รายการ + ตัดสต็อก (ระบบเดิม — ยังรองรับ data.dept)
function processRequisition(data) {
  return processRequisitionBatch_({
    dept: data.dept, requestId: data.requestId, staffName: data.staffName, department: data.department,
    branch: data.branch, requisitionNotes: data.requisitionNotes, imageBase64: data.imageBase64,
    items: [{ assetId: data.assetId, quantity: data.quantity }]
  });
}