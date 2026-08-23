/**
 * Smart Scanner - PR System Professional (Backend Script)
 * Complete Version with Force MinHQ Auto-Sync, Multi-Key Mapping & Full Features
 */

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  
  try {
    var rawContent = "";
    if (e.parameter && e.parameter.contents) {
      rawContent = e.parameter.contents; 
    } else if (e.postData && e.postData.contents) {
      rawContent = e.postData.contents; 
    }
    
    if (!rawContent) {
      throw new Error("Payload is empty");
    }
    
    var payload = JSON.parse(rawContent);
    var firstItem = Array.isArray(payload) ? payload[0] : payload;
    var action = firstItem ? firstItem.action : null;

    // Helper สร้าง Key ค้นหา (ตัดขีด ตัดช่องว่าง ตัดศูนย์นำหน้า)
    function getPossibleKeys(str) {
      var s = String(str || "").trim();
      var clean = s.replace(/[- ]/g, "").toUpperCase();
      var noZero = clean.replace(/^0+/, "");
      return [s, clean, noZero];
    }

    function findDataInMap(mapObj, rawCode) {
      if (!mapObj || !rawCode) return null;
      var keys = getPossibleKeys(rawCode);
      for (var k = 0; k < keys.length; k++) {
        if (mapObj[keys[k]] !== undefined && mapObj[keys[k]] !== null) return mapObj[keys[k]];
      }
      return null;
    }

    function getFirstValid(arr) {
      for (var i = 0; i < arr.length; i++) {
        var v = arr[i];
        if (v !== undefined && v !== null && v !== "" && !isNaN(v)) {
          return Number(v);
        }
      }
      return null;
    }

    function getValueForColumn(colName, pData, minHqFallback) {
      if (!pData) pData = {};
      var colTrim = colName.trim();
      
      // 1. ค้นตามชื่อหัวคอลัมน์ตรงๆ
      if (pData[colTrim] !== undefined && pData[colTrim] !== null && pData[colTrim] !== "") return Number(pData[colTrim]);
      if (pData[colTrim.replace(/\s+/g, "")] !== undefined) return Number(pData[colTrim.replace(/\s+/g, "")]);

      // 2. เช็กคอลัมน์ Min HQ (คอลัมน์ K)
      if (colTrim.indexOf("Min") !== -1 || colTrim.indexOf("min") !== -1) {
        var minVal = getFirstValid([
          pData.minHQ, pData.min_hq, pData.minHQStock, pData.min, pData.minstock, 
          pData.minStock, pData["Min สำนักงานใหญ่"], pData["min สำนักงานใหญ่"], 
          pData.min_stock, pData.min_hq_stock
        ]);
        if (minVal !== null) return minVal;
        if (minHqFallback !== undefined && minHqFallback !== null && !isNaN(minHqFallback)) return Number(minHqFallback);
        return null;
      }

      // 3. เช็กคอลัมน์ สต๊อกสาขาต่างๆ
      if (colTrim.indexOf("เดชอุดม") !== -1) return getFirstValid([pData.stockDechudom, pData.stock_dechudom, pData.dechudom, pData["Stock เดชอุดม"], pData.stockBranch]);
      if (colTrim.indexOf("ตระการ") !== -1) return getFirstValid([pData.stockTrakan, pData.stock_trakan, pData.trakan, pData["Stock ตระการพืชผล"]]);
      if (colTrim.indexOf("เบญจลักษณ์") !== -1) return getFirstValid([pData.stockBenjalak, pData.stock_benjalak, pData.benjalak, pData["Stock เบญจลักษณ์"]]);
      if (colTrim.indexOf("ฉนารายณ์") !== -1) return getFirstValid([pData.stockChanarai, pData.stock_chanarai, pData.chanarai, pData["Stock ฉนารายณ์"]]);
      if (colTrim.indexOf("ศรีเมืองใหม่") !== -1) return getFirstValid([pData.stockSriMueang, pData.stock_srimueang, pData.srimueang, pData["Stock ศรีเมืองใหม่"]]);
      if (colTrim.indexOf("ขุขันธ์") !== -1) return getFirstValid([pData.stockKhukhan, pData.stock_khukhan, pData.khukhan, pData["Stock ขุขันธ์"]]);
      if (colTrim.indexOf("HQ") !== -1 || colTrim.indexOf("ใหญ่") !== -1) return getFirstValid([pData.stockHQ, pData.stock_hq, pData.hq, pData.ecout, pData["Stock สำนักงานใหญ่"]]);

      return null;
    }

    // =========================================================
    // 🎯 กรณีที่ 1: รับข้อมูล Sync สต๊อกยิงตรงลง Sheet Master_Parts
    // =========================================================
    if (action === "updateMasterStock") {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheetMaster = ss.getSheetByName("Master_Parts") || ss.getSheetByName("MasterParts") || ss.getSheets()[0];
      var sheetMinHQ = ss.getSheetByName("Minstock-HQ") || ss.getSheetByName("MinHQ") || ss.getSheetByName("Min_HQ");
      
      if (!sheetMaster) {
        return ContentService.createTextOutput(JSON.stringify({"status": "error", "message": "ไม่พบแผ่นงาน Master_Parts"}))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      // ดึง Map ค่า Min HQ จากชีท Minstock-HQ อัตโนมัติ
      var minHQBackupMap = {};
      if (sheetMinHQ) {
        var lastMinRow = sheetMinHQ.getLastRow();
        if (lastMinRow > 1) {
          var minData = sheetMinHQ.getRange(1, 1, lastMinRow, sheetMinHQ.getLastColumn()).getValues();
          var minHeader = minData[0];
          var codeColIdx = 1; // Col B
          var minColIdx = 5;  // Col F

          for (var h = 0; h < minHeader.length; h++) {
            var hTitle = String(minHeader[h] || "").trim().toLowerCase();
            if (hTitle.indexOf("รหัส") !== -1 || hTitle.indexOf("code") !== -1) codeColIdx = h;
            if (hTitle.indexOf("min") !== -1) minColIdx = h;
          }

          for (var m = 1; m < minData.length; m++) {
            var mCode = String(minData[m][codeColIdx] || "").trim();
            var mMin = minData[m][minColIdx];
            if (mCode && mMin !== "" && !isNaN(mMin)) {
              var keys = getPossibleKeys(mCode);
              for (var k = 0; k < keys.length; k++) {
                minHQBackupMap[keys[k]] = Number(mMin);
              }
            }
          }
        }
      }

      var lastRow = sheetMaster.getLastRow();
      var lastCol = sheetMaster.getLastColumn();
      var stockMap = firstItem.stockMap || payload.stockMap || {};

      if (lastRow > 1 && lastCol >= 4) {
        var headers = sheetMaster.getRange(1, 1, 1, lastCol).getValues()[0];
        var numDataRows = lastRow - 1;
        var numDataCols = lastCol - 3;
        
        var existingRange = sheetMaster.getRange(2, 4, numDataRows, numDataCols);
        var existingValues = existingRange.getValues();
        var codes = sheetMaster.getRange(2, 1, numDataRows, 1).getValues();
        var outputValues = [];

        for (var i = 0; i < numDataRows; i++) {
          var rawCode = String(codes[i][0]).trim();
          var pData = findDataInMap(stockMap, rawCode);
          var minFallback = findDataInMap(minHQBackupMap, rawCode);
          var rowOutput = [];

          for (var c = 3; c < headers.length; c++) {
            var colIndexInOutput = c - 3;
            var colName = String(headers[c] || "").trim();
            var oldValue = existingValues[i][colIndexInOutput];

            var newVal = getValueForColumn(colName, pData, minFallback);

            if (newVal !== null && newVal !== undefined && !isNaN(newVal)) {
              rowOutput.push(newVal);
            } else {
              rowOutput.push(oldValue !== "" && !isNaN(oldValue) ? Number(oldValue) : 0);
            }
          }
          outputValues.push(rowOutput);
        }

        sheetMaster.getRange(2, 4, numDataRows, numDataCols).setValues(outputValues);
      }

      SpreadsheetApp.flush();
      return ContentService.createTextOutput(JSON.stringify({"status": "SUCCESS", "updatedRows": lastRow - 1}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // =========================================================
    // 🎯 กรณีที่ 2: สั่งอัปเดต Minstock Manual
    // =========================================================
    if (action === "update_minstock") {
      SpreadsheetApp.flush();
      return ContentService.createTextOutput(JSON.stringify({"status": "SUCCESS", "message": "อัปเดต Minstock เรียบร้อยแล้ว"}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // =========================================================
    // 🎯 กรณีที่ 3: Export Excel 
    // =========================================================
    if (action === "export_excel") {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheetSME = ss.getSheetByName("SME_List") || ss.getSheetByName("Config") || ss.getSheets()[1];
      var targetBranch = firstItem.targetBranch || firstItem.branch;

      if (sheetSME && targetBranch) {
        var smeData = sheetSME.getDataRange().getValues();
        var maxSeq = 0;
        
        for (var r = 1; r < smeData.length; r++) {
          if (smeData[r][1] && smeData[r][1].toString().trim() === targetBranch.trim()) {
            var val = Number(smeData[r][3]) || 0;
            if (val > maxSeq) {
              maxSeq = val;
            }
          }
        }
        
        var newSeq = maxSeq + 1;
        
        for (var r = 1; r < smeData.length; r++) {
          if (smeData[r][1] && smeData[r][1].toString().trim() === targetBranch.trim()) {
            sheetSME.getRange(r + 1, 4).setValue(newSeq);
          }
        }
      }

      SpreadsheetApp.flush();
      return ContentService.createTextOutput(JSON.stringify({"status": "success", "message": "Sequence updated for export"}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // =========================================================
    // 🛒 กรณีที่ 4: บันทึกรายการขอซื้อลง Sheet1 (การสั่งซื้อผ่านหน้าเว็บ)
    // =========================================================
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet1 = ss.getSheetByName("Sheet1") || ss.getSheets()[0];
    var sheetSME = ss.getSheetByName("SME_List") || ss.getSheetByName("Config") || ss.getSheets()[1];
    
    var itemsToRecord = Array.isArray(payload) ? payload : [payload];
    
    if (itemsToRecord.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({"status": "success", "message": "No items to process"}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (sheet1) {
      var lastRowSheet1 = sheet1.getLastRow();
      if (lastRowSheet1 > 1) {
        sheet1.getRange(2, 1, lastRowSheet1 - 1, 10).clearContent(); 
      }
    }
    
    var nextNumber = 1;
    var allRowsData = [];
    var currentTime = new Date();
    
    for (var i = 0; i < itemsToRecord.length; i++) {
      var data = itemsToRecord[i];
      var rowData = [
        nextNumber + i,
        currentTime,
        data.branch || "",
        "'" + (data.partId || "").toString().trim(),
        data.partName || "",
        Number(data.stockBranch || data.stock) || 0,
        Number(data.quantity) || 1,
        data.recorder || "",
        data.remarks || "",
        data.docCode || ""
      ];
      allRowsData.push(rowData);
    }
    
    if (sheet1 && allRowsData.length > 0) {
      sheet1.getRange(2, 1, allRowsData.length, allRowsData[0].length).setValues(allRowsData);
    }

    if (sheetSME && itemsToRecord.length > 0) {
      var targetBranch = itemsToRecord[0].targetBranch || itemsToRecord[0].branch;
      if (targetBranch) {
        var smeData = sheetSME.getDataRange().getValues();
        var maxSeq = 0;
        
        for (var r = 1; r < smeData.length; r++) {
          if (smeData[r][1] && smeData[r][1].toString().trim() === targetBranch.trim()) {
            var val = Number(smeData[r][3]) || 0;
            if (val > maxSeq) {
              maxSeq = val;
            }
          }
        }
        
        var newSeq = maxSeq + 1;
        
        for (var r = 1; r < smeData.length; r++) {
          if (smeData[r][1] && smeData[r][1].toString().trim() === targetBranch.trim()) {
            sheetSME.getRange(r + 1, 4).setValue(newSeq);
          }
        }
      }
    }
    
    SpreadsheetApp.flush();
    return ContentService.createTextOutput(JSON.stringify({"status": "success"}))
      .setMimeType(ContentService.MimeType.JSON);
                        
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({"status": "error", "message": error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetMaster = ss.getSheetByName("Master_Parts") || ss.getSheetByName("MasterParts") || ss.getSheets()[0]; 
  var sheetSME = ss.getSheetByName("SME_List") || ss.getSheetByName("Config") || ss.getSheets()[1]; 
  var sheetMinHQ = ss.getSheetByName("Minstock-HQ") || ss.getSheetByName("MinHQ") || ss.getSheetByName("Min_HQ");
  
  var responseData = { 
    masterParts: {}, 
    minHQMap: {},
    smeList: [], 
    branchList: [],
    branchMap: {},
    branchSeqMap: {} 
  };

  function getPossibleKeys(str) {
    var s = String(str || "").trim();
    var clean = s.replace(/[- ]/g, "").toUpperCase();
    var noZero = clean.replace(/^0+/, "");
    return [s, clean, noZero];
  }

  // 1. ดึงข้อมูลจากแผ่นงาน Minstock-HQ (Col B=รหัส, Col C=ชื่อ, Col E=Stock HQ, Col F=Min HQ)
  if (sheetMinHQ) {
    var lastRowMin = sheetMinHQ.getLastRow();
    if (lastRowMin > 1) {
      var minDataRows = sheetMinHQ.getRange(1, 1, lastRowMin, sheetMinHQ.getLastColumn()).getValues();
      var minHeader = minDataRows[0];
      var codeColIdx = 1; // Col B
      var nameColIdx = 2; // Col C
      var stockColIdx = 4; // Col E
      var minColIdx = 5;  // Col F

      // ตรวจเช็กหัวคอลัมน์อัตโนมัติหากมีการย้ายคอลัมน์
      for (var h = 0; h < minHeader.length; h++) {
        var hTitle = String(minHeader[h] || "").trim().toLowerCase();
        if (hTitle.indexOf("รหัส") !== -1 || hTitle.indexOf("code") !== -1) codeColIdx = h;
        if (hTitle.indexOf("ชื่อ") !== -1 || hTitle.indexOf("name") !== -1) nameColIdx = h;
        if (hTitle.indexOf("ecout") !== -1 || hTitle.indexOf("hq") !== -1 || hTitle.indexOf("สต๊อก") !== -1) stockColIdx = h;
        if (hTitle.indexOf("min") !== -1) minColIdx = h;
      }

      for (var m = 1; m < minDataRows.length; m++) {
        var mCode = minDataRows[m][codeColIdx] ? minDataRows[m][codeColIdx].toString().trim() : "";
        var mName = minDataRows[m][nameColIdx] ? minDataRows[m][nameColIdx].toString().trim() : "";
        var mStockHQ = (minDataRows[m][stockColIdx] !== "" && !isNaN(minDataRows[m][stockColIdx])) ? Number(minDataRows[m][stockColIdx]) : 0;
        var mMinHQ = (minDataRows[m][minColIdx] !== "" && !isNaN(minDataRows[m][minColIdx])) ? Number(minDataRows[m][minColIdx]) : 0;

        if (mCode) {
          var keys = getPossibleKeys(mCode);
          var minObj = {
            rawCode: mCode,
            name: mName,
            stockHQ: mStockHQ,
            minHQ: mMinHQ
          };
          for (var k = 0; k < keys.length; k++) {
            responseData.minHQMap[keys[k]] = minObj;
          }
        }
      }
    }
  }

  // 2. ดึงรายการจาก Sheet Master_Parts และแมปข้อมูลให้ตรงกับ Frontend
  if (sheetMaster) {
    var masterData = sheetMaster.getDataRange().getValues();
    if (masterData.length > 1) {
      var headers = masterData[0];

      // ค้นหาตำแหน่งคอลัมน์ Min สำนักงานใหญ่ ใน Master_Parts
      var masterMinColIdx = -1;
      for (var h = 0; h < headers.length; h++) {
        var hName = String(headers[h] || "").trim();
        if (hName.indexOf("Min") !== -1 || hName.indexOf("min") !== -1) {
          masterMinColIdx = h;
          break;
        }
      }

      for (var j = 1; j < masterData.length; j++) {
        var row = masterData[j];
        var code = row[0] ? row[0].toString().trim() : "";
        var name = row[1] ? row[1].toString().trim() : "";
        var status = row[2] ? row[2].toString().trim() : "";
        var stockBranch = (row[3] !== "" && !isNaN(row[3])) ? Number(row[3]) : 0;
        
        // ค้นหา Min/Stock HQ จาก minHQMap
        var keys = getPossibleKeys(code);
        var hqInfo = {};
        for (var k = 0; k < keys.length; k++) {
          if (responseData.minHQMap[keys[k]]) {
            hqInfo = responseData.minHQMap[keys[k]];
            break;
          }
        }
        
        var ecoutHQ = (hqInfo.stockHQ !== undefined) ? hqInfo.stockHQ : 0;
        
        // ลำดับการดึงค่า Min HQ: 1) จาก Minstock-HQ  2) จากคอลัมน์ K ใน Master_Parts
        var finalMinHQ = 0;
        if (hqInfo.minHQ !== undefined && hqInfo.minHQ > 0) {
          finalMinHQ = hqInfo.minHQ;
        } else if (masterMinColIdx !== -1 && row[masterMinColIdx] !== "" && !isNaN(row[masterMinColIdx])) {
          finalMinHQ = Number(row[masterMinColIdx]);
        }

        if (code) {
          var stocksObj = {};
          
          for (var colIdx = 3; colIdx < headers.length; colIdx++) {
            var hName = String(headers[colIdx] || "").trim();
            if (hName) {
              var val = (row[colIdx] !== "" && !isNaN(row[colIdx])) ? Number(row[colIdx]) : 0;
              stocksObj[hName] = val;

              if (hName.indexOf("เดชอุดม") !== -1) stocksObj["stockDechudom"] = val;
              if (hName.indexOf("ตระการ") !== -1) stocksObj["stockTrakan"] = val;
              if (hName.indexOf("เบญจลักษณ์") !== -1) stocksObj["stockBenjalak"] = val;
              if (hName.indexOf("ฉนารายณ์") !== -1) stocksObj["stockChanarai"] = val;
              if (hName.indexOf("ศรีเมืองใหม่") !== -1) stocksObj["stockSriMueang"] = val;
              if (hName.indexOf("ขุขันธ์") !== -1) stocksObj["stockKhukhan"] = val;
            }
          }

          var partObj = {
            name: name || hqInfo.name || "",
            status: status,
            stockBranch: stockBranch,
            ecout: ecoutHQ,
            stockHQ: ecoutHQ,
            minHQ: finalMinHQ,
            minStock: finalMinHQ,
            min_hq: finalMinHQ,
            stocks: stocksObj
          };

          for (var key in stocksObj) {
            partObj[key] = stocksObj[key];
          }

          responseData.masterParts[code] = partObj;
        }
      }
    }
  }

  // 3. ดึง SME_List
  if (sheetSME) {
    var lastRowSME = sheetSME.getLastRow();
    if (lastRowSME > 1) {
      var smeRows = sheetSME.getDataRange().getValues();
      var rawSmeList = [];
      var rawBranchList = [];

      for (var k = 1; k < smeRows.length; k++) {
        var empName = smeRows[k][0] ? smeRows[k][0].toString().trim() : "";
        var bName = smeRows[k][1] ? smeRows[k][1].toString().trim() : "";
        var bCode = smeRows[k][2] ? smeRows[k][2].toString().trim() : "";
        var bSeq = (smeRows[k][3] !== "" && !isNaN(smeRows[k][3])) ? Number(smeRows[k][3]) : 0;
        
        if (empName) rawSmeList.push(empName);
        if (bName) {
          rawBranchList.push(bName);
          if (bCode) responseData.branchMap[bName] = bCode;
          if (responseData.branchSeqMap[bName] === undefined || bSeq > responseData.branchSeqMap[bName]) {
            responseData.branchSeqMap[bName] = bSeq;
          }
        }
      }

      responseData.smeList = Array.from(new Set(rawSmeList));
      responseData.branchList = Array.from(new Set(rawBranchList));
    }
  }
  
  return ContentService.createTextOutput(JSON.stringify(responseData))
    .setMimeType(ContentService.MimeType.JSON);
}