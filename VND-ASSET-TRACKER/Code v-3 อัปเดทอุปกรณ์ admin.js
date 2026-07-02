// ⚠️ นำรหัส Spreadsheet ID จาก URL หน้า Google Sheets ของคุณมาวางแทนที่ตรงนี้
const SPREADSHEET_ID = "1eX2zfmtU0_J43bzB4GCNcdcYPa5VfjKuRpIr-DGC2AA"; 

function getTargetSpreadsheet() {
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch(e) {
    return SpreadsheetApp.getActiveSpreadsheet();
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    const ss = getTargetSpreadsheet(); 
    
    // 📦 ดึงข้อมูลพัสดุคงคลัง
    if (action === "getInventory") {
      const sheet = ss.getSheetByName("Inventory");
      const data = sheet.getDataRange().getValues();
      const result = [];
      for (let i = 1; i < data.length; i++) {
        if(data[i][0]) { 
          result.push({
            code: data[i][0].toString(),
            name: data[i][1].toString(),
            qty: parseInt(data[i][2]) || 0
          });
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true, data: result })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // 📜 ดึงข้อมูลประวัติกิจกรรมย้อนหลัง 15 รายการ
    if (action === "getLogs") {
      const sheet = ss.getSheetByName("Stock_Log");
      const data = sheet.getDataRange().getValues();
      const result = [];
      const startRow = Math.max(1, data.length - 15);
      for (let i = data.length - 1; i >= startRow; i--) {
        if(data[i][0]) {
          let formattedDate = data[i][0];
          if (data[i][0] instanceof Date) {
            formattedDate = Utilities.formatDate(data[i][0], "GMT+7", "yyyy-MM-dd HH:mm");
          }
          result.push({
            timestamp: formattedDate.toString(),
            user: data[i][1].toString(),
            itemName: data[i][2].toString(),
            qty: Math.abs(parseInt(data[i][3])) || 0,
            type: data[i][4].toString(),
            reason: data[i][5] ? data[i][5].toString() : "",
            matchainLine: data[i][6] ? data[i][6].toString() : "Non"
          });
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true, data: result })).setMimeType(ContentService.MimeType.JSON);
    }
    
    return HtmlService.createHtmlOutputFromFile('index')
        .setTitle('VN Asset Tracker & Stock')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = getTargetSpreadsheet();
    
    // 🔐 ระบบ Login
    if (data.action === "login") {
      const userSheet = ss.getSheetByName("Users");
      if (!userSheet) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Error: ไม่พบแท็บชื่อ Users ในระบบสเปรดชีต" })).setMimeType(ContentService.MimeType.JSON);
      }
      
      const userData = userSheet.getDataRange().getValues();
      const inputUser = data.username.trim().toLowerCase();
      const inputPass = data.password.toString().trim();
      
      for (let i = 1; i < userData.length; i++) {
        if (userData[i][0]) {
          const dbUser = userData[i][0].toString().trim().toLowerCase();
          const dbPassword = userData[i][1].toString().trim();
          
          if (dbUser === inputUser && dbPassword === inputPass) {
            return ContentService.createTextOutput(JSON.stringify({
              success: true,
              user: { 
                fullName: userData[i][2].toString(), 
                role: userData[i][3] ? userData[i][3].toString() : "User" 
              }
            })).setMimeType(ContentService.MimeType.JSON);
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Username หรือ Password ไม่ถูกต้อง!" })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // 📝 ระบบสมัครสมาชิก
    if (data.action === "register") {
      const userSheet = ss.getSheetByName("Users");
      const userData = userSheet.getDataRange().getValues();
      const inputUser = data.username.trim().toLowerCase();
      
      for (let i = 1; i < userData.length; i++) {
        if (userData[i][0] && userData[i][0].toString().trim().toLowerCase() === inputUser) {
          return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Username นี้ถูกใช้ไปแล้ว!" })).setMimeType(ContentService.MimeType.JSON);
        }
      }
      userSheet.appendRow([inputUser, data.password, data.fullName, "User"]);
      return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // 📦 ฟอร์มบันทึกข้อมูลและคำนวณตัดสต็อกสินค้า (พนักงาน)
    if (data.action === "submitForm") {
      const logSheet = ss.getSheetByName("Stock_Log");
      const invSheet = ss.getSheetByName("Inventory");
      const invData = invSheet.getDataRange().getValues();
      const changeQty = parseInt(data.qty);
      const isOut = data.type.includes("Out") || data.type.includes("เบิก");
      let currentItemName = "";
      
      for (let i = 1; i < invData.length; i++) {
        if (invData[i][0] && invData[i][0].toString().trim().toUpperCase() === data.itemCode.toString().trim().toUpperCase()) {
          currentItemName = invData[i][1].toString();
          let currentQty = parseInt(invData[i][2]) || 0;
          let newQty = isOut ? currentQty - changeQty : currentQty + changeQty;
          
          if (newQty < 0 && isOut) {
            return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Error: สินค้าในสต็อกมีไม่พอให้เบิก!" })).setMimeType(ContentService.MimeType.JSON);
          }
          invSheet.getRange(i + 1, 3).setValue(newQty);
          break;
        }
      }
      
      const timestamp = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy, HH:mm");
      logSheet.appendRow([timestamp, data.username, currentItemName || data.itemCode, isOut ? -changeQty : changeQty, data.type, data.reason, data.matchainLine || "Non"]);
      return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
    }

    // 🛠️ ฟังก์ชันแก้ไขสต็อกสินค้าโดยตรง (เฉพาะสิทธิ์ Admin)
    if (data.action === "adminUpdateStock") {
      const invSheet = ss.getSheetByName("Inventory");
      const invData = invSheet.getDataRange().getValues();
      let isUpdated = false;

      for (let i = 1; i < invData.length; i++) {
        if (invData[i][0] && invData[i][0].toString().trim().toUpperCase() === data.itemCode.toString().trim().toUpperCase()) {
          invSheet.getRange(i + 1, 3).setValue(parseInt(data.newQty));
          isUpdated = true;
          break;
        }
      }

      if (isUpdated) {
        const logSheet = ss.getSheetByName("Stock_Log");
        const timestamp = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy, HH:mm");
        logSheet.appendRow([timestamp, data.adminName + " (Admin)", "🔧 รหัสสินค้า: " + data.itemCode, data.newQty, "แก้ไขยอดโดยแอดมิน (Admin Override)", "ปรับปรุงฐานข้อมูลคลังสินค้า", "Non"]);
        return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: "ไม่พบรหัสสินค้านี้ในคลัง" })).setMimeType(ContentService.MimeType.JSON);
    }

    // ➕ ฟังก์ชันเพิ่มอุปกรณ์พัสดุชิ้นใหม่เข้าสู่ตารางคลังสินค้า (แก้ไขระบบตรวจสอบเพื่อรองรับ Barcode เรียบร้อย 🛠️)
    if (data.action === "adminAddNewItem") {
      const invSheet = ss.getSheetByName("Inventory");
      const invData = invSheet.getDataRange().getValues();
      const newCode = data.itemCode.toString().trim().toUpperCase(); // บังคับให้เป็นตัวใหญ่ตรงตามสเปกของบาร์โค้ด
      
      // ดักตรวจรหัสสินค้าซ้ำ (เปลี่ยนเป็นเช็กแบบพิมพ์ใหญ่คู่ เพื่อป้องกันความผิดพลาด)
      for (let i = 1; i < invData.length; i++) {
        if (invData[i][0] && invData[i][0].toString().trim().toUpperCase() === newCode) {
          return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Error: รหัสอุปกรณ์พัสดุนี้มีอยู่ในคลังสินค้าแล้ว!" })).setMimeType(ContentService.MimeType.JSON);
        }
      }
      
      // บันทึกแถวใหม่ลงในแท็บ Inventory
      invSheet.appendRow([newCode, data.itemName.trim(), parseInt(data.initialQty) || 0]);
      
      // บันทึกประวัติกิจกรรมลง Stock_Log ว่าแอดมินสร้างขึ้นใหม่
      const logSheet = ss.getSheetByName("Stock_Log");
      const timestamp = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy, HH:mm");
      logSheet.appendRow([timestamp, data.adminName + " (Admin)", "✨ เพิ่มชิ้นส่วนใหม่: " + data.itemName.trim(), parseInt(data.initialQty) || 0, "สร้างพัสดุใหม่ในคลัง (New Item)", "เพิ่มฐานข้อมูลพัสดุอุปกรณ์", "Non"]);
      
      return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Invalid Action" })).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}