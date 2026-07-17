// VN Asset Tracker & Stock - Phase 1 critical fixes
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
      const result = [];

      for (let i = 1; i < data.length; i++) {
        if (data[i][0]) {
          result.push({
            code: normalizeText(data[i][0]),
            name: normalizeText(data[i][1]),
            qty: parseInt(data[i][2], 10) || 0
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
          result.push({
            id: i + 1,
            rowNumber: i + 1,
            timestamp: normalizeText(formattedDate),
            user: normalizeText(data[i][1]),
            itemName: normalizeText(data[i][2]),
            qty: data[i][3] !== "" ? Math.abs(parseInt(data[i][3], 10)) || 0 : 0,
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
        if (normalizeCode(invData[i][0]) === itemCode) {
          foundRow = i + 1;
          currentItemName = normalizeText(invData[i][1]);
          const currentQty = parseInt(invData[i][2], 10) || 0;
          newQty = isOut ? currentQty - changeQty : currentQty + changeQty;

          if (isOut && newQty < 0) {
            return jsonOutput({ success: false, message: "Error: สินค้าในสต็อกมีไม่พอให้เบิก!" });
          }

          invSheet.getRange(foundRow, 3).setValue(newQty);
          break;
        }
      }

      if (foundRow === -1) {
        return jsonOutput({ success: false, message: "ไม่พบรหัสสินค้านี้ในคลัง" });
      }

      logSheet.appendRow([
        timestamp,
        normalizeText(data.username),
        currentItemName || itemCode,
        isOut ? -changeQty : changeQty,
        txType,
        normalizeText(data.reason),
        normalizeText(data.matchainLine) || "Non",
        imgBase64
      ]);

      return jsonOutput({ success: true, newQty: newQty });
    }

    if (data.action === "adminUpdateStock") {
      lock.waitLock(10000);
      const admin = requireAdmin(ss, data.adminUsername || data.username || data.adminName);

      const invSheet = getSheetOrThrow(ss, "Inventory");
      const invData = invSheet.getDataRange().getValues();
      const itemCode = normalizeCode(data.itemCode);
      const newQty = parseNonNegativeInt(data.newQty, "จำนวนสต็อกใหม่");
      let isUpdated = false;

      for (let i = 1; i < invData.length; i++) {
        if (normalizeCode(invData[i][0]) === itemCode) {
          invSheet.getRange(i + 1, 3).setValue(newQty);
          isUpdated = true;
          break;
        }
      }

      if (isUpdated) {
        const logSheet = getSheetOrThrow(ss, "Stock_Log");
        logSheet.appendRow([timestamp, admin.fullName + " (Admin)", "Code: " + itemCode, newQty, "Admin Override", "Database Manual Adjustment", "Non", ""]);
        return jsonOutput({ success: true });
      }

      return jsonOutput({ success: false, message: "ไม่พบรหัสสินค้านี้ในคลัง" });
    }

    if (data.action === "adminAddNewItem") {
      lock.waitLock(10000);
      const admin = requireAdmin(ss, data.adminUsername || data.username || data.adminName);

      const invSheet = getSheetOrThrow(ss, "Inventory");
      const invData = invSheet.getDataRange().getValues();
      const newCode = normalizeCode(data.itemCode);
      const itemName = normalizeText(data.itemName);
      const initialQty = parseNonNegativeInt(data.initialQty, "ยอดเริ่มต้นคลัง");

      if (!newCode || !itemName) {
        return jsonOutput({ success: false, message: "กรุณากรอกรหัสและชื่อสินค้าให้ครบ" });
      }

      for (let i = 1; i < invData.length; i++) {
        if (normalizeCode(invData[i][0]) === newCode) {
          return jsonOutput({ success: false, message: "Error: รหัสอุปกรณ์พัสดุนี้มีอยู่ในคลังสินค้าแล้ว!" });
        }
      }

      invSheet.appendRow([newCode, itemName, initialQty]);
      const logSheet = getSheetOrThrow(ss, "Stock_Log");
      logSheet.appendRow([timestamp, admin.fullName + " (Admin)", itemName, initialQty, "New Item Added", "Initial Stock Entry", "Non", ""]);

      return jsonOutput({ success: true });
    }

    if (data.action === "adminDeleteItem") {
      lock.waitLock(10000);
      const admin = requireAdmin(ss, data.adminUsername || data.username || data.adminName);

      const invSheet = getSheetOrThrow(ss, "Inventory");
      const invData = invSheet.getDataRange().getValues();
      const itemCode = normalizeCode(data.itemCode);

      for (let i = 1; i < invData.length; i++) {
        if (normalizeCode(invData[i][0]) === itemCode) {
          const itemName = normalizeText(invData[i][1]);
          const qty = parseInt(invData[i][2], 10) || 0;

          if (qty > 0) {
            return jsonOutput({ success: false, message: "ไม่สามารถลบได้ เพราะสต็อกยังมากกว่า 0" });
          }

          invSheet.deleteRow(i + 1);
          const logSheet = getSheetOrThrow(ss, "Stock_Log");
          logSheet.appendRow([timestamp, admin.fullName + " (Admin)", itemName || itemCode, 0, "Item Deleted", "Admin deleted item from inventory", "Non", ""]);
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
