// VN Asset Tracker & Stock - Phase 2 fixes (2026-09-23)
// - Stock qty read by header name + robust number parsing (fixes missing/0 balance)
// - Stock_Log column I = Balance after each transaction
// - Admin Override logs change (new-old) + real item name
// Phase 1 critical fixes
// - Fix image field mismatch
// - Add delete item/log actions
// - Add LockService for stock mutations
// - Validate quantity/input
// - Server-side admin role check for admin actions

const SPREADSHEET_ID = "1eX2zfmtU0_J43bzB4GCNcdcYPa5VfjKuRpIr-DGC2AA";
const TZ = "GMT+7";

function getTargetSpreadsheet() {
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    return SpreadsheetApp.getActiveSpreadsheet();
  }
}

function jsonOutput(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheetOrThrow(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("ไม่พบแท็บ " + name);
  return sheet;
}

function normalizeText(value) {
  return (value === null || value === undefined) ? "" : value.toString().trim();
}

function normalizeCode(value) {
  return normalizeText(value).toUpperCase();
}

function parseNonNegativeInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(fieldName + " ต้องเป็นจำนวนเต็ม 0 ขึ้นไป");
  }
  return n;
}

function parsePositiveInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(fieldName + " ต้องเป็นจำนวนเต็มมากกว่า 0");
  }
  return n;
}

// ---- Stock balance helpers (Phase 2 fix: missing remaining stock) ----
// Parse a stock cell to an integer. Handles numbers, "1,200", " 15 ", "15 pcs", and blank cells.
function parseStockQty(value) {
  if (typeof value === "number") return isFinite(value) ? Math.trunc(value) : 0;
  const cleaned = normalizeText(value).replace(/,/g, "").replace(/[^\d.\-]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? Math.trunc(n) : 0;
}

// Find the Inventory columns from the header row, so an extra/moved column no longer breaks the qty read.
// Falls back to A=Code, B=Name, C=Qty.
function getInventoryCols(headerRow) {
  const cols = { code: 0, name: 1, qty: 2 };
  const header = (headerRow || []).map(function (h) { return normalizeText(h).toLowerCase(); });
  const qtyIdx = header.findIndex(function (h) {
    if (/(code|รหัส|mã|name|ชื่อ|tên)/i.test(h)) return false;
    return /(qty|quantity|stock|balance|available|remain|คงเหลือ|จำนวน|สต็อก|สต๊อก|tồn|số lượng)/i.test(h);
  });
  if (qtyIdx >= 0) cols.qty = qtyIdx;
  return cols;
}

// Stock_Log column I (index 8) = remaining balance after the transaction
const LOG_BALANCE_COL = 9;

function ensureLogBalanceHeader(logSheet) {
  const cell = logSheet.getRange(1, LOG_BALANCE_COL);
  if (normalizeText(cell.getValue()) === "") cell.setValue("Balance");
}

function findUser(ss, username) {
  const userSheet = getSheetOrThrow(ss, "Users");
  const userData = userSheet.getDataRange().getValues();
  const inputUser = normalizeText(username).toLowerCase();

  for (let i = 1; i < userData.length; i++) {
    const dbUser = normalizeText(userData[i][0]).toLowerCase();
    if (dbUser && dbUser === inputUser) {
      return {
        row: i + 1,
        username: dbUser,
        password: normalizeText(userData[i][1]),
        fullName: normalizeText(userData[i][2]),
        role: normalizeText(userData[i][3]) || "User"
      };
    }
  }
  return null;
}

function requireAdmin(ss, identity) {
  const userSheet = getSheetOrThrow(ss, "Users");
  const userData = userSheet.getDataRange().getValues();
  const input = normalizeText(identity).toLowerCase();

  for (let i = 1; i < userData.length; i++) {
    const dbUser = normalizeText(userData[i][0]).toLowerCase();
    const fullName = normalizeText(userData[i][2]);
    const dbFullName = fullName.toLowerCase();
    const role = normalizeText(userData[i][3]) || "User";

    if ((dbUser && dbUser === input) || (dbFullName && dbFullName === input)) {
      if (role === "Admin") {
        return {
          row: i + 1,
          username: dbUser,
          fullName: fullName,
          role: role
        };
      }
      break;
    }
  }

  throw new Error("Permission denied: Admin only");
}

function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : "";
    const ss = getTargetSpreadsheet();

    if (action === "getInventory") {
      const sheet = getSheetOrThrow(ss, "Inventory");
      const data = sheet.getDataRange().getValues();
      const cols = getInventoryCols(data[0]);
      const result = [];

      for (let i = 1; i < data.length; i++) {
        if (normalizeText(data[i][cols.code])) {
          result.push({
            code: normalizeText(data[i][cols.code]),
            name: normalizeText(data[i][cols.name]),
            qty: parseStockQty(data[i][cols.qty])
          });
        }
      }

      return jsonOutput({ success: true, data: result });
    }

    if (action === "getLogs") {
      const sheet = getSheetOrThrow(ss, "Stock_Log");
      const data = sheet.getDataRange().getValues();
      const result = [];
      const startRow = Math.max(1, data.length - 15);

      for (let i = data.length - 1; i >= startRow; i--) {
        if (data[i][0]) {
          let formattedDate = data[i][0];
          if (data[i][0] instanceof Date) {
            formattedDate = Utilities.formatDate(data[i][0], TZ, "yyyy-MM-dd HH:mm");
          }

          const imgBase64 = normalizeText(data[i][7]);
          const rawBalance = data[i][LOG_BALANCE_COL - 1];
          const signedQty = parseStockQty(data[i][3]);
          result.push({
            id: i + 1,
            rowNumber: i + 1,
            timestamp: normalizeText(formattedDate),
            user: normalizeText(data[i][1]),
            itemName: normalizeText(data[i][2]),
            qty: Math.abs(signedQty),
            signedQty: signedQty,
            balance: (rawBalance === "" || rawBalance === null || rawBalance === undefined) ? null : parseStockQty(rawBalance),
            type: normalizeText(data[i][4]),
            reason: normalizeText(data[i][5]),
            matchainLine: normalizeText(data[i][6]) || "Non",
            imgBase64: imgBase64,
            image: imgBase64
          });
        }
      }

      return jsonOutput({ success: true, data: result });
    }

    return HtmlService.createHtmlOutputFromFile("index")
      .setTitle("VN Asset Tracker & Stock")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  } catch (err) {
    return jsonOutput({ success: false, message: err.toString() });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    const data = JSON.parse(e.postData.contents || "{}");
    const ss = getTargetSpreadsheet();
    const timestamp = Utilities.formatDate(new Date(), TZ, "dd/MM/yyyy, HH:mm");

    if (data.action === "login") {
      const inputUser = normalizeText(data.username).toLowerCase();
      const inputPass = normalizeText(data.password);
      const user = findUser(ss, inputUser);

      if (user && user.password === inputPass) {
        return jsonOutput({
          success: true,
          user: { fullName: user.fullName, role: user.role }
        });
      }

      return jsonOutput({ success: false, message: "Username หรือ Password ไม่ถูกต้อง!" });
    }

    if (data.action === "register") {
      const userSheet = getSheetOrThrow(ss, "Users");
      const inputUser = normalizeText(data.username).toLowerCase();
      const password = normalizeText(data.password);
      const fullName = normalizeText(data.fullName);

      if (!inputUser || !password || !fullName) {
        return jsonOutput({ success: false, message: "กรุณากรอกข้อมูลสมัครสมาชิกให้ครบ" });
      }

      if (findUser(ss, inputUser)) {
        return jsonOutput({ success: false, message: "Username นี้ถูกใช้ไปแล้ว!" });
      }

      userSheet.appendRow([inputUser, password, fullName, "User"]);
      return jsonOutput({ success: true });
    }

    if (data.action === "submitForm") {
      lock.waitLock(10000);

      const logSheet = getSheetOrThrow(ss, "Stock_Log");
      const invSheet = getSheetOrThrow(ss, "Inventory");
      const invData = invSheet.getDataRange().getValues();
      const cols = getInventoryCols(invData[0]);

      const itemCode = normalizeCode(data.itemCode);
      const changeQty = parsePositiveInt(data.qty, "จำนวน");
      const txType = normalizeText(data.type);
      const isOut = txType.includes("Out") || txType.includes("เบิก") || txType.includes("Xuất");
      const imgBase64 = normalizeText(data.imgBase64 || data.image);

      if (!itemCode) throw new Error("กรุณาเลือกรหัสสินค้า");

      let foundRow = -1;
      let currentItemName = "";
      let newQty = 0;

      for (let i = 1; i < invData.length; i++) {
        if (normalizeCode(invData[i][cols.code]) === itemCode) {
          foundRow = i + 1;
          currentItemName = normalizeText(invData[i][cols.name]);
          const currentQty = parseStockQty(invData[i][cols.qty]);
          newQty = isOut ? currentQty - changeQty : currentQty + changeQty;

          if (isOut && newQty < 0) {
            return jsonOutput({ success: false, message: "Error: สินค้าในสต็อกมีไม่พอให้เบิก! (คงเหลือ " + currentQty + ")" });
          }

          invSheet.getRange(foundRow, cols.qty + 1).setValue(newQty);
          break;
        }
      }

      if (foundRow === -1) {
        return jsonOutput({ success: false, message: "ไม่พบรหัสสินค้านี้ในคลัง" });
      }

      ensureLogBalanceHeader(logSheet);
      logSheet.appendRow([
        timestamp,
        normalizeText(data.username),
        currentItemName || itemCode,
        isOut ? -changeQty : changeQty,
        txType,
        normalizeText(data.reason),
        normalizeText(data.matchainLine) || "Non",
        imgBase64,
        newQty
      ]);

      return jsonOutput({ success: true, newQty: newQty });
    }

    if (data.action === "adminUpdateStock") {
      lock.waitLock(10000);
      const admin = requireAdmin(ss, data.adminUsername || data.username || data.adminName);

      const invSheet = getSheetOrThrow(ss, "Inventory");
      const invData = invSheet.getDataRange().getValues();
      const cols = getInventoryCols(invData[0]);
      const itemCode = normalizeCode(data.itemCode);
      const newQty = parseNonNegativeInt(data.newQty, "จำนวนสต็อกใหม่");
      let isUpdated = false;
      let oldQty = 0;
      let itemName = "";

      for (let i = 1; i < invData.length; i++) {
        if (normalizeCode(invData[i][cols.code]) === itemCode) {
          oldQty = parseStockQty(invData[i][cols.qty]);
          itemName = normalizeText(invData[i][cols.name]);
          invSheet.getRange(i + 1, cols.qty + 1).setValue(newQty);
          isUpdated = true;
          break;
        }
      }

      if (isUpdated) {
        const logSheet = getSheetOrThrow(ss, "Stock_Log");
        ensureLogBalanceHeader(logSheet);
        // Qty = change (new - old), Balance = new stock
        logSheet.appendRow([timestamp, admin.fullName + " (Admin)", itemName || itemCode, newQty - oldQty, "Admin Override", "Manual Adjustment " + oldQty + " → " + newQty, "Non", "", newQty]);
        return jsonOutput({ success: true });
      }

      return jsonOutput({ success: false, message: "ไม่พบรหัสสินค้านี้ในคลัง" });
    }

    if (data.action === "adminAddNewItem") {
      lock.waitLock(10000);
      const admin = requireAdmin(ss, data.adminUsername || data.username || data.adminName);

      const invSheet = getSheetOrThrow(ss, "Inventory");
      const invData = invSheet.getDataRange().getValues();
      const cols = getInventoryCols(invData[0]);
      const newCode = normalizeCode(data.itemCode);
      const itemName = normalizeText(data.itemName);
      const initialQty = parseNonNegativeInt(data.initialQty, "ยอดเริ่มต้นคลัง");

      if (!newCode || !itemName) {
        return jsonOutput({ success: false, message: "กรุณากรอกรหัสและชื่อสินค้าให้ครบ" });
      }

      for (let i = 1; i < invData.length; i++) {
        if (normalizeCode(invData[i][cols.code]) === newCode) {
          return jsonOutput({ success: false, message: "Error: รหัสอุปกรณ์พัสดุนี้มีอยู่ในคลังสินค้าแล้ว!" });
        }
      }

      // Put values in the detected columns (not always A/B/C)
      const width = Math.max(invSheet.getLastColumn(), cols.code + 1, cols.name + 1, cols.qty + 1);
      const newRow = new Array(width).fill("");
      newRow[cols.code] = newCode;
      newRow[cols.name] = itemName;
      newRow[cols.qty] = initialQty;
      invSheet.appendRow(newRow);

      const logSheet = getSheetOrThrow(ss, "Stock_Log");
      ensureLogBalanceHeader(logSheet);
      logSheet.appendRow([timestamp, admin.fullName + " (Admin)", itemName, initialQty, "New Item Added", "Initial Stock Entry", "Non", "", initialQty]);

      return jsonOutput({ success: true });
    }

    if (data.action === "adminDeleteItem") {
      lock.waitLock(10000);
      const admin = requireAdmin(ss, data.adminUsername || data.username || data.adminName);

      const invSheet = getSheetOrThrow(ss, "Inventory");
      const invData = invSheet.getDataRange().getValues();
      const cols = getInventoryCols(invData[0]);
      const itemCode = normalizeCode(data.itemCode);

      for (let i = 1; i < invData.length; i++) {
        if (normalizeCode(invData[i][cols.code]) === itemCode) {
          const itemName = normalizeText(invData[i][cols.name]);
          const qty = parseStockQty(invData[i][cols.qty]);

          if (qty > 0) {
            return jsonOutput({ success: false, message: "ไม่สามารถลบได้ เพราะสต็อกยังมากกว่า 0" });
          }

          invSheet.deleteRow(i + 1);
          const logSheet = getSheetOrThrow(ss, "Stock_Log");
          logSheet.appendRow([timestamp, admin.fullName + " (Admin)", itemName || itemCode, 0, "Item Deleted", "Admin deleted item from inventory", "Non", "", 0]);
          return jsonOutput({ success: true });
        }
      }

      return jsonOutput({ success: false, message: "ไม่พบรหัสสินค้านี้ในคลัง" });
    }

    if (data.action === "adminDeleteLog") {
      lock.waitLock(10000);
      requireAdmin(ss, data.adminUsername || data.username || data.adminName);

      const logSheet = getSheetOrThrow(ss, "Stock_Log");
      const rowNumber = parseInt(data.logId, 10);

      if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > logSheet.getLastRow()) {
        return jsonOutput({ success: false, message: "ไม่พบ Log ที่ต้องการลบ" });
      }

      logSheet.deleteRow(rowNumber);
      return jsonOutput({ success: true });
    }

    return jsonOutput({ success: false, message: "Invalid Action" });
  } catch (error) {
    return jsonOutput({ success: false, message: error.toString() });
  } finally {
    try {
      lock.releaseLock();
    } catch (releaseError) {
      // Lock may not have been acquired for non-mutating actions.
    }
  }
}