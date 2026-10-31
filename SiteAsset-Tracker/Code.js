function doGet(e) {
  try {
    const action = e.parameter.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("Assets"); //
    
    if (action === "read") {
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) {
        return ContentService.createTextOutput(JSON.stringify([]))
                             .setMimeType(ContentService.MimeType.JSON);
      }
      
      const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
      const assets = [];
      
      data.forEach((row, index) => {
        assets.push({
          rowNumber: index + 2, 
          assetId: row[0],      // A
          assetName: row[1],    // B
          branch: row[2],       // C
          imageUrl: row[3],     // D: ข้อความ Base64 ของรูปภาพ
          status: row[4],       // E
          note: row[5],         // F
          recorder: row[6],     // G
          quantity: row[7]      // H
        });
      });
      
      return ContentService.createTextOutput(JSON.stringify(assets))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  // 📤 แจ้งคืนทรัพย์สินเข้าสำนักงานใหญ่ (โค้ดอยู่ในไฟล์ ReturnToHQ.gs) — คำสั่งอื่นทำงานตามเดิม
  const rthq = handleReturnToHQPost_(e);
  if (rthq) return rthq;

  try {
    let data;
    if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else {
      data = e.parameter;
    }
    
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("Assets");
    
    // 1. บันทึกข้อมูลใหม่ (Insert)
    if (data.action === "insert") {
      const nextRow = sheet.getLastRow() + 1;
      sheet.getRange(nextRow, 1).setValue(data.assetId);     
      sheet.getRange(nextRow, 2).setValue(data.assetName);   
      sheet.getRange(nextRow, 3).setValue(data.branch);      
      sheet.getRange(nextRow, 4).setValue(data.fileData || ""); // บันทึกข้อความ Base64 ลงในคอลัมน์ D 直接
      sheet.getRange(nextRow, 5).setValue(data.status);      
      sheet.getRange(nextRow, 6).setValue(data.note);        
      sheet.getRange(nextRow, 7).setValue(data.recorder);    
      sheet.getRange(nextRow, 8).setValue(parseInt(data.quantity) || 1);    
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 2. แก้ไขข้อมูล (Update)
    if (data.action === "update") {
      const targetRow = parseInt(data.rowNumber);
      if (!targetRow || targetRow < 2) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error" }))
                             .setMimeType(ContentService.MimeType.JSON);
      }
      
      let imageUrl = data.existingImageUrl || ""; 
      if (data.fileData && data.fileData.trim() !== "") {
        imageUrl = data.fileData; // อัปเดตด้วย Base64 ชุดใหม่
      }
      
      sheet.getRange(targetRow, 1).setValue(data.assetId);     
      sheet.getRange(targetRow, 2).setValue(data.assetName);   
      sheet.getRange(targetRow, 3).setValue(data.branch);      
      sheet.getRange(targetRow, 4).setValue(imageUrl);         
      sheet.getRange(targetRow, 5).setValue(data.status);      
      sheet.getRange(targetRow, 6).setValue(data.note);        
      sheet.getRange(targetRow, 7).setValue(data.recorder);    
      sheet.getRange(targetRow, 8).setValue(parseInt(data.quantity) || 1);    
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 3. ลบข้อมูล (Delete)
    if (data.action === "delete") {
      const targetRow = parseInt(data.rowNumber);
      if (targetRow && targetRow >= 2) {
        sheet.deleteRow(targetRow);
        return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
                             .setMimeType(ContentService.MimeType.JSON);
      }
    }
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
}