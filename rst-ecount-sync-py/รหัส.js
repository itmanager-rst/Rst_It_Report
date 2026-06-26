// ท่อรับข้อมูลจาก Python เข้ามาเคลียร์แผ่นชีตและจัดเรียงเรียงตามลำดับ 4 คอลัมน์ตรงๆ
function doPost(e) {
  try {
    var requestData = JSON.parse(e.postData.contents);
    var rowsToInsert = requestData.data; // รับอาเรย์ 4 ฟิลด์มาจาก Python
    
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Stock_Data'); // เช็คชื่อแผ่นงานให้ตรงตัว
    
    // 1. ล้างข้อมูลเก่าและล้างการจัดฟอร์แมตวันที่เพี้ยนๆ ออกให้หมดตั้งแตบรรทัด 2 ลงไป
    if (sheet.getLastRow() > 1) {
      var lastRow = sheet.getLastRow();
      sheet.getRange(2, 1, lastRow - 1, 4).clearContent().clearFormat();
    }
    
    // 2. เขียนข้อมูล 4 คอลัมน์ใหม่ (รหัสสินค้า, ชื่อสินค้า, คลังสินค้า, จำนวนคงเหลือ) 
    if (rowsToInsert.length > 0) {
      // บังคับให้คอลัมน์ที่ 4 (จำนวน QTY) เป็นฟอร์แมตตัวเลขธรรมดา ไม่ใช่วันที่
      sheet.getRange(2, 1, rowsToInsert.length, 4).setValues(rowsToInsert);
      sheet.getRange(2, 4, rowsToInsert.length, 1).setNumberFormat("#,##0.00");
    }
    
    return ContentService.createTextOutput(JSON.stringify({"status": "success"}))
                         .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({"status": "error", "message": err.toString()}))
                         .setMimeType(ContentService.MimeType.JSON);
  }
}

// ท่อดึงข้อมูลส่งออกไปให้ไฟล์ index.html ใช้ (4 คอลัมน์หลัก)
function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stock_Data'); 
  var range = sheet.getDataRange();
  var values = range.getValues();
  
  if (values.length <= 1) {
    return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
  }
  
  var jsonData = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    jsonData.push({
      "PROD_CD": row[0],  // รหัสสินค้า (A)
      "PROD_DES": row[1], // ชื่อสินค้าภาษาไทย (B)
      "WH_CD": row[2],    // รหัสคลังสินค้า (C)
      "QTY": row[3]       // จำนวนคงเหลือ (D)
    });
  }
  
  return ContentService.createTextOutput(JSON.stringify(jsonData))
                       .setMimeType(ContentService.MimeType.JSON);
}