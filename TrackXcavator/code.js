// ==========================================
// CONFIGURATION & HELPER FUNCTIONS
// ==========================================
const BQ_PROJECT_ID = 'trackxcavator';
const BQ_DATASET_ID = 'ExcavatorsDB';

/**
 * ฟังก์ชันกลางสำหรับส่ง SQL Query ไปยัง BigQuery
 * พร้อมระบบ Retry เมื่อเจอ Job ไม่เสร็จสมบูรณ์
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

    const rows = queryResults.rows;
    if (!rows) return [];

    const headers = queryResults.schema.fields.map(field => field.name);

    return rows.map(row => {
      let item = {};
      row.f.forEach((cell, index) => {
        item[headers[index]] = cell ? cell.v : null;
      });
      return item;
    });

  } catch (error) {
    Logger.log('BigQuery Error: ' + error.toString());
    throw new Error('BigQuery Exec Error: ' + error.message);
  }
}

/**
 * Helper Function ส่งคืนค่า JSON (พร้อมรองรับ CORS)
 */
function responseJSON(data) {
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

// ==========================================
// WEB APP ENTRY POINTS (doGet / doPost)
// ==========================================

function doGet(e) {
  try {
    var action = e ? e.parameter.action : "";
    
    if (action === "getDashboard") {
      return getDashboardData();
    } else if (action === "getReportList") {
      return getReportList();
    } else if (action === "getPMProgressMatrix") {
      return getPMProgressMatrix();
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

    if (action === "verifyLogin") {
      return verifyLogin(data.username, data.password);
    } else if (action === "insertTicket") {
      return insertOrUpdateTicket(data);
    } else if (action === "claimCoupon") {
      return claimCoupon(data);
    } else if (action === "updatePartsStatus") {
      return updatePartsStatus(data);
    } else if (action === "approveMachine") {
      return approveMachine(data.machineId);
    } else if (action === "deleteDashboard") {
      return deleteDashboard(data.machineId);
    } else if (action === "deleteReport") {
      return deleteReport(data.ticketId);
    }

    return responseJSON({ status: "error", message: "Unknown action" });

  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

// ==========================================
// 1. ตรวจสอบ Login (ส่ง Dual Key ให้รองรับทุกหน้า)
// ==========================================
function verifyLogin(username, password) {
  try {
    var cleanUser = escapeSql(username);
    var cleanPass = escapeSql(password);

    var sql = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.users\` ` +
              `WHERE LOWER(user) = LOWER('${cleanUser}') AND CAST(password AS STRING) = '${cleanPass}' ` +
              `LIMIT 1`;

    var results = runBigQuery(sql);

    if (results && results.length > 0) {
      var foundUser = results[0];
      var userRole = foundUser.role || foundUser.Role || "admin";
      var userVal = foundUser.user || cleanUser;

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
      });
    } else {
      return responseJSON({ 
        status: "error",
        success: false, 
        message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' 
      });
    }
  } catch (e) {
    return responseJSON({ 
      status: "error",
      success: false, 
      message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ: ' + e.toString() 
    });
  }
}

// ==========================================
// 2. ดึงข้อมูล ตารางสถานะเครื่องจักร (Service_Report)
// ==========================================
function getDashboardData() {
  try {
    var sql = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\``;
    var rows = runBigQuery(sql);
    
    var alerts = [];
    var pmAlertCount = 0;
    var incompleteInvoiceCount = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var machineId = String(row.machine_id || row.machineId || "").trim();
      
      var hrs = Number(row.current_Hours || row.current_hours || row.currentHours) || 0;
      var lastPm = Number(row.last_pm_round || row.last_pm || row.lastPm) || 0;
      var nextPm = Number(row.next_pm_round || row.next_pm || row.nextPm) || 0;
      var pStatus = String(row.parts_status || row.partsStatus || "ส่งครบแล้ว").trim();

      if (nextPm > 0 && (nextPm - hrs <= 50)) {
        pmAlertCount++;
      }

      if (pStatus === "ส่งบางส่วน" || pStatus === "ค้างส่งอะไหล่") {
        incompleteInvoiceCount++;
      }

      alerts.push({
        machineId: machineId,
        machine_id: machineId,
        model: row.model || "",
        customer: row.customer || "",
        customerName: row.customer || "",
        customerId: row.customer_id || row.customerId || "",
        customer_id: row.customer_id || row.customerId || "",
        phone: row.phone_number || row.phone || "",
        phone_number: row.phone_number || row.phone || "",
        contractDate: row.contract_date || "",
        contract_date: row.contract_date || "",
        currentHours: hrs,
        current_Hours: hrs,
        lastPm: lastPm,
        last_pm_round: lastPm,
        nextPm: nextPm,
        next_pm_round: nextPm,
        status: row.status || "Approved",
        updatedBy: row.updated_by || "",
        updated_by: row.updated_by || "",
        partsStore: row.parts_store || "",
        parts_store: row.parts_store || "",
        supplierId: row.supplier_id || row.supplierId || "-",
        supplier_id: row.supplier_id || row.supplierId || "-",
        partsBillNo: row.parts_bill_no || "",
        parts_bill_no: row.parts_bill_no || "",
        partsStatus: pStatus,
        parts_status: pStatus,
        receiptImage: row.receipt_image || "",
        receipt_image: row.receipt_image || "",
        yanmarCoupon: Number(row.yanmar_coupon) || 0,
        yanmar_coupon: Number(row.yanmar_coupon) || 0,
        remark: row.remark || ""
      });
    }

    return responseJSON({
      status: "success",
      pmAlerts: alerts,
      pmAlertCount: pmAlertCount,
      incompleteInvoiceCount: incompleteInvoiceCount
    });
  } catch (e) {
    return responseJSON({ 
      status: "error", 
      pmAlerts: [], 
      pmAlertCount: 0, 
      incompleteInvoiceCount: 0, 
      message: e.toString() 
    });
  }
}

// ==========================================
// 3. ดึงข้อมูล ประวัติทำ PM (PM_Log) - พร้อมระบบตรวจสอบความถูกต้อง
// ==========================================
function getReportList() {
  try {
    var sql = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\``;
    var rows = runBigQuery(sql);
    var result = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      
      var tId = row.ticket_id || row.ticketId || row.no || ("TK-" + (i + 1));
      var mId = row.machine_id || row.machineId || "";
      var mdl = row.model || "";
      
      var rawCustomer = String(row.customer || row.customerName || "").trim();
      var rawCustomerId = String(row.customer_id || row.customerId || "").trim();
      var rawPhone = String(row.phone_number || row.phone || "").trim();

      var finalCustomerName = rawCustomer;
      var finalCustomerId = rawCustomerId;
      var finalPhone = rawPhone;

      // เช็กสลับคอลัมน์: ถ้า customer เก็บชื่อรุ่นรถ แล้ว customer_id เก็บชื่อลูกค้า
      if (rawCustomer.indexOf("รถขุด") !== -1 || rawCustomer.indexOf("OLD-") !== -1) {
        finalCustomerName = rawCustomerId;
        finalCustomerId = rawPhone;
        finalPhone = "-";
      }

      // ดึงค่าวันที่และรอบ PM
      var rawDate = String(row.contract_date || row.serviceDate || "").trim();
      var rawPmRound = String(row.last_pm_round || row.pmRound || "").trim();

      // ตรวจสอบข้อมูลสลับช่องกันแบบอัตโนมัติ (เผื่อข้อมูลเก่าค้าง)
      var serviceDateVal = rawDate;
      var pmRoundVal = Number(rawPmRound) || 0;

      if (_looksLikeDate(rawPmRound)) {
        serviceDateVal = rawPmRound;
        pmRoundVal = Number(rawDate) || 0;
      }

      // กรองวันที่เริ่มต้น Default 2000-01-01 หรือค่าว่างให้เป็น '-'
      if (!serviceDateVal || serviceDateVal === "" || serviceDateVal.startsWith("2000-01-01")) {
        serviceDateVal = "-";
      }

      result.push({
        no: row.no || (i + 1),
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
        actualHours: Number(row.current_Hours) || 0,
        current_Hours: Number(row.current_Hours) || 0,
        serviceDate: serviceDateVal,
        contract_date: serviceDateVal,
        cost: Number(row.cost) || 0,
        invoiceNo: row.parts_bill_no || "-",
        supplierId: row.supplier_id || row.supplierId || "-",
        partsStore: row.parts_store || "-",
        parts_store: row.parts_store || "-",
        partsBillNo: row.parts_bill_no || "NA",
        parts_bill_no: row.parts_bill_no || "NA",
        partsStatus: row.parts_status || "ส่งครบแล้ว",
        parts_status: row.parts_status || "ส่งครบแล้ว",
        receiptImage: row.receipt_image || "",
        receipt_image: row.receipt_image || "",
        yanmarCoupon: Number(row.yanmar_coupon) || 0,
        yanmar_coupon: Number(row.yanmar_coupon) || 0,
        remark: row.remark || ""
      });
    }

    return responseJSON(result);
  } catch (e) {
    return responseJSON([]);
  }
}

// ==========================================
// 3.1 ดึงข้อมูล PM Progress Matrix
// ==========================================
function getPMProgressMatrix() {
  try {
    var sqlService = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\``;
    var sqlLogs = `SELECT machine_id, last_pm_round, current_Hours, contract_date, parts_store, parts_bill_no, parts_status, yanmar_coupon FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\``;
    
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

    // Map ข้อมูลรอบ PM Log เข้ากับตัวเครื่อง พร้อมสถานะหลังเข้าบริการ
    var pmRoundsMap = {};
    logs.forEach(function(l) {
      var mId = String(l.machine_id || "").trim();
      var round = Number(l.last_pm_round) || 0;
      if (mId && round > 0) {
        if (!pmRoundsMap[mId]) pmRoundsMap[mId] = {};
        pmRoundsMap[mId][round] = {
          completed: true,
          actualHours: Number(l.current_Hours) || 0,
          date: l.contract_date || "",
          statuses: getWorkflowStatuses(l.parts_status, l.yanmar_coupon, l.parts_store, l.parts_bill_no)
        };
      }
    });

    var matrixData = services.map(function(s) {
      var mId = String(s.machine_id || "").trim();
      var hrs = Number(s.current_Hours) || 0;
      var lastPm = Number(s.last_pm_round) || 0;
      var roundsHistory = pmRoundsMap[mId] || {};

      // รอบ PM มาตรฐาน
      var pmCheckpoints = [50, 250, 500, 750, 1000, 1250, 1500, 1750, 2000];
      var matrix = {};

      pmCheckpoints.forEach(function(cp) {
        if (cp === lastPm && lastPm > 0) {
          matrix[cp] = getWorkflowStatuses(s.parts_status, s.yanmar_coupon, s.parts_store, s.parts_bill_no);
        } else if (roundsHistory[cp]) {
          matrix[cp] = roundsHistory[cp].statuses;
        } else if (lastPm >= cp) {
          matrix[cp] = ["เสร็จสิ้น"];
        } else if (hrs >= cp) {
          matrix[cp] = ["เข้าบริการ"];
        } else {
          matrix[cp] = ["รอดำเนินการ"];
        }
      });

      return {
        machine_id: mId,
        machineId: mId,
        model: s.model || "",
        customer: s.customer || "",
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
    });

    return responseJSON({ status: "success", data: matrixData });
  } catch (e) {
    return responseJSON({ status: "error", data: [], message: e.toString() });
  }
}

// ==========================================
// 4. บันทึก / อัปเดต ข้อมูลใบงาน (pm_log & service_report)
// ==========================================
function insertOrUpdateTicket(p) {
  try {
    var ticketId = p.ticketId ? escapeSql(p.ticketId) : "TK-" + Utilities.formatDate(new Date(), "GMT+7", "yyyyMMdd-HHmmss");
    
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

    var safeMachineId = escapeSql(p.machineId || p.machine_id);
    var safeModel = escapeSql(p.model);
    var safeCustomerName = escapeSql(p.customerName || p.customer);
    var safeCustomerId = escapeSql(p.customerId || p.customer_id);
    var safePhone = escapeSql(p.phone || p.phone_number);

    var safePartsStore = escapeSql(p.partsStore || p.parts_store || '-');
    var safeSupplierId = escapeSql(p.supplierId || p.supplier_id || '-');
    var safePartsBillNo = escapeSql(p.partsBillNo || p.parts_bill_no || 'NA');
    var safePartsStatus = escapeSql(p.partsStatus || p.parts_status || 'ส่งครบแล้ว');
    var safeReceiptImage = escapeSql(p.receiptImage || p.receipt_image);
    var safeRemark = escapeSql(p.remark);
    var safeUpdatedBy = escapeSql(p.updatedBy || p.updated_by);

    // 1. INSERT ลง pm_log (ใส่ Backticks ครอบ `no` ป้องกัน Keyword Error)
    var queryLog = `INSERT INTO \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` 
      (\`no\`, machine_id, model, customer, customer_id, phone_number, contract_date, current_Hours, last_pm_round, next_pm_round, status, updated_by, parts_store, parts_bill_no, parts_status, receipt_image, yanmar_coupon, remark)
      VALUES (
        '${ticketId}', '${safeMachineId}', '${safeModel}', '${safeCustomerName}', '${safeCustomerId}', '${safePhone}', 
        '${escapeSql(strDate)}', ${actualHours}, ${pmRound}, ${nextPm}, 'Approved', '${safeUpdatedBy}', 
        '${safePartsStore}', '${safePartsBillNo}', '${safePartsStatus}', '${safeReceiptImage}', 
        ${Number(p.yanmarCoupon) || 0}, '${safeRemark}'
      )`;
    runBigQuery(queryLog);

    // 2. MERGE/UPDATE ลง service_report
    var queryDash = `
      MERGE \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\` T
      USING (SELECT '${safeMachineId}' AS machine_id) S
      ON LOWER(T.machine_id) = LOWER(S.machine_id)
      WHEN MATCHED THEN
        UPDATE SET 
          model = '${safeModel}', 
          customer = '${safeCustomerName}', 
          customer_id = '${safeCustomerId}', 
          phone_number = '${safePhone}', 
          contract_date = '${escapeSql(strDate)}',
          current_Hours = ${actualHours}, 
          last_pm_round = ${pmRound}, 
          next_pm_round = ${nextPm}, 
          status = 'Approved',
          updated_by = '${safeUpdatedBy}', 
          parts_store = '${safePartsStore}', 
          parts_bill_no = '${safePartsBillNo}', 
          parts_status = '${safePartsStatus}', 
          receipt_image = '${safeReceiptImage}', 
          yanmar_coupon = ${Number(p.yanmarCoupon) || 0}, 
          remark = '${safeRemark}'
      WHEN NOT MATCHED THEN
        INSERT (\`no\`, machine_id, model, customer, customer_id, phone_number, contract_date, current_Hours, last_pm_round, next_pm_round, status, updated_by, parts_store, parts_bill_no, parts_status, receipt_image, yanmar_coupon, remark)
        VALUES (
          '', '${safeMachineId}', '${safeModel}', '${safeCustomerName}', '${safeCustomerId}', '${safePhone}', 
          '${escapeSql(strDate)}', ${actualHours}, ${pmRound}, ${nextPm}, 'Approved', '${safeUpdatedBy}', 
          '${safePartsStore}', '${safePartsBillNo}', '${safePartsStatus}', '${safeReceiptImage}', 
          ${Number(p.yanmarCoupon) || 0}, '${safeRemark}'
        )
    `;
    runBigQuery(queryDash);

    return responseJSON({ status: "success", ticketId: ticketId });
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

// ==========================================
// 5. บันทึกยืนยันรับคูปองย้อนหลัง
// ==========================================
function claimCoupon(p) {
  try {
    var ticketId = escapeSql(p.ticketId);
    var amount = Number(p.yanmarCoupon) || 4000;
    var couponRemark = p.couponRemark ? escapeSql(p.couponRemark) : "";

    var getMachineSql = `SELECT machine_id FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` WHERE \`no\` = '${ticketId}' OR machine_id = '${ticketId}' LIMIT 1`;
    var rows = runBigQuery(getMachineSql);
    var machineId = rows.length > 0 ? escapeSql(rows[0].machine_id) : "";

    var remarkUpdate = couponRemark !== "" ? `CONCAT(IFNULL(remark, ''), ' | เลขรับคูปอง: ${couponRemark}')` : "remark";
    var updateLogSql = `UPDATE \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` 
                        SET yanmar_coupon = ${amount}, remark = ${remarkUpdate} 
                        WHERE \`no\` = '${ticketId}' OR machine_id = '${ticketId}'`;
    runBigQuery(updateLogSql);

    if (machineId) {
      var updateDashSql = `UPDATE \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\` 
                          SET yanmar_coupon = ${amount}, remark = ${remarkUpdate} 
                          WHERE LOWER(machine_id) = LOWER('${machineId}')`;
      runBigQuery(updateDashSql);
    }

    return responseJSON({ status: "success" });
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

// ==========================================
// 6. อัปเดตสถานะอะไหล่ค้างส่ง
// ==========================================
function updatePartsStatus(p) {
  try {
    var targetMachineId = escapeSql(p.machineId || p.machine_id);
    var partsRemark = p.partsRemark ? escapeSql(p.partsRemark) : "";
    var partsStore = escapeSql(p.partsStore || p.parts_store);
    var partsStatus = escapeSql(p.partsStatus || p.parts_status);
    var updatedBy = escapeSql(p.updatedBy || p.updated_by);
    var remarkUpdate = partsRemark !== "" ? `CONCAT(IFNULL(remark, ''), ' | เอกสารรับอะไหล่: ${partsRemark}')` : "remark";

    var sql = `UPDATE \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\` 
               SET parts_store = '${partsStore}', 
                   parts_status = '${partsStatus}', 
                   updated_by = '${updatedBy}', 
                   remark = ${remarkUpdate} 
               WHERE LOWER(machine_id) = LOWER('${targetMachineId}')`;
    
    runBigQuery(sql);
    return responseJSON({ status: "success" });
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

// ==========================================
// 7. อนุมัติสถานะเครื่องจักร (Approve)
// ==========================================
function approveMachine(machineId) {
  try {
    var safeMachineId = escapeSql(machineId);
    var sql = `UPDATE \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\` 
               SET status = 'Approved' 
               WHERE LOWER(machine_id) = LOWER('${safeMachineId}')`;
    runBigQuery(sql);
    return responseJSON({ status: "success" });
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

// ==========================================
// 8. ลบข้อมูลใน Service_Report
// ==========================================
function deleteDashboard(machineId) {
  try {
    var safeMachineId = escapeSql(machineId);
    var sql = `DELETE FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.service_report\` 
               WHERE LOWER(machine_id) = LOWER('${safeMachineId}')`;
    runBigQuery(sql);
    return responseJSON({ status: "success" });
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

// ==========================================
// 9. ลบข้อมูลใน PM_Log (แก้ไขจุดที่เป็นปัญหา Syntax Error)
// ==========================================
function deleteReport(ticketId) {
  try {
    var safeTicketId = escapeSql(ticketId);
    var sql = `DELETE FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` 
               WHERE \`no\` = '${safeTicketId}' OR machine_id = '${safeTicketId}'`;
    runBigQuery(sql);
    return responseJSON({ status: "success" });
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
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

function detectPmLogSwaps() {
  try {
    var rows = runBigQuery(`SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\``);
    var candidates = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var ticket = r.no || r.ticket_id || r.ticketId || (i+1);
      var customer = String(r.customer || r.customerName || r.customer_name || '').trim();
      var phone = String(r.phone_number || r.phone || '').trim();
      var serviceDate = String(r.contract_date || r.serviceDate || r.service_date || '').trim();

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

    return responseJSON({ status: 'success', candidates: candidates });
  } catch (err) {
    return responseJSON({ status: 'error', message: err.toString() });
  }
}

function fixPmLogSwaps(payload) {
  try {
    var fixes = [];
    if (!payload) return responseJSON({ status: 'error', message: 'Missing payload' });

    if (payload.fixes && Array.isArray(payload.fixes)) {
      fixes = payload.fixes;
    } else if (payload.tickets && Array.isArray(payload.tickets)) {
      var detected = detectPmLogSwaps().getContent ? JSON.parse(detectPmLogSwaps().getContent()) : detectPmLogSwaps();
      var map = {};
      (detected.candidates || []).forEach(function(c){ map[String(c.ticketId)] = c; });
      payload.tickets.forEach(function(t){ if (map[t]) fixes.push({ ticketId: t, set: map[t].issue.suggested }); });
    } else if (payload.ticketId) {
      var det = detectPmLogSwaps();
      var detObj = det.getContent ? JSON.parse(det.getContent()) : det;
      var found = (detObj.candidates || []).find(function(c){ return String(c.ticketId) === String(payload.ticketId); });
      if (found) fixes.push({ ticketId: payload.ticketId, set: found.issue.suggested });
    } else {
      return responseJSON({ status: 'error', message: 'Invalid payload format' });
    }

    var applied = [];
    fixes.forEach(function(f) {
      var t = String(f.ticketId).replace(/'/g, "\\'");
      var sets = [];
      if (f.set.customer !== undefined) sets.push(`customer = '${escapeSql(f.set.customer)}'`);
      if (f.set.phone !== undefined) sets.push(`phone_number = '${escapeSql(f.set.phone)}'`);
      if (f.set.contract_date !== undefined) sets.push(`contract_date = '${escapeSql(f.set.contract_date)}'`);
      if (sets.length === 0) return;
      var sql = `UPDATE \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` SET ${sets.join(', ')} WHERE \`no\` = '${t}' OR machine_id = '${t}' LIMIT 1`;
      try {
        runBigQuery(sql);
        applied.push({ ticketId: f.ticketId, applied: f.set });
      } catch (e) {
        applied.push({ ticketId: f.ticketId, error: e.toString() });
      }
    });

    return responseJSON({ status: 'success', applied: applied });
  } catch (err) {
    return responseJSON({ status: 'error', message: err.toString() });
  }
}