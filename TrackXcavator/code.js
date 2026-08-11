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
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
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
// 3. ดึงข้อมูล ประวัติทำ PM (PM_Log)
// ==========================================
function getReportList() {
  try {
    var sql = `SELECT * FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\``;
    var rows = runBigQuery(sql);
    var result = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      
      var tId = row.string_field_18 || row.ticket_id || row.ticketId || ("TK-" + (row.no || (i + 1)));
      var mId = row.machine_id || row.machineId || "";
      var mdl = row.model || "";
      var cName = row.customer || row.customerName || "";
      var cId = row.customer_id || row.customerId || "";

      result.push({
        no: row.no || (i + 1),
        ticketId: tId,
        ticket_id: tId,
        string_field_18: tId,
        machineId: mId,
        machine_id: mId,
        model: mdl,
        customerName: cName,
        customer: cName,
        customerId: cId,
        customer_id: cId,
        phone: row.phone_number || row.phone || "-",
        phone_number: row.phone_number || row.phone || "-",
        pmRound: Number(row.last_pm_round) || 0,
        last_pm_round: Number(row.last_pm_round) || 0,
        actualHours: Number(row.current_Hours) || 0,
        current_Hours: Number(row.current_Hours) || 0,
        serviceDate: row.contract_date || "-",
        contract_date: row.contract_date || "-",
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
// 3.1 แก้ไขปัญหา Matrix ขึ้น "รอดำเนินการ"
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
        // รอบ PM ล่าสุดต้องยึด service_report เป็นหลัก แม้ข้อมูลเก่าใน pm_log
        // จะไม่มีแถวที่จับคู่ machine_id + รอบ PM ได้ก็ตาม
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
// 4. บันทึก / แก้ไข ใบงานบริการ (ปรับปรุง SQL Query)
// ==========================================
function insertOrUpdateTicket(p) {
  try {
    var ticketId = p.ticketId ? escapeSql(p.ticketId) : "TK-" + Utilities.formatDate(new Date(), "GMT+7", "yyyyMMdd-HHmmss");
    var pmRound = Number(p.pmRound) || 0;
    var actualHours = Number(p.actualHours) || 0;
    var nextPm = pmRound > 0 ? (pmRound + 250) : 50;

    var safeMachineId = escapeSql(p.machineId || p.machine_id);
    var safeModel = escapeSql(p.model);
    var safeCustomerName = escapeSql(p.customerName || p.customer);
    var safeCustomerId = escapeSql(p.customerId || p.customer_id);
    var safePhone = escapeSql(p.phone || p.phone_number);
    var strDate = escapeSql(p.serviceDate || p.contractDate || p.contract_date || '');

    var safePartsStore = escapeSql(p.partsStore || p.parts_store || '-');
    var safeSupplierId = escapeSql(p.supplierId || p.supplier_id || '-');
    var safePartsBillNo = escapeSql(p.partsBillNo || p.parts_bill_no || 'NA');
    var safePartsStatus = escapeSql(p.partsStatus || p.parts_status || 'ส่งครบแล้ว');
    var safeReceiptImage = escapeSql(p.receiptImage || p.receipt_image);
    var safeRemark = escapeSql(p.remark);
    var safeUpdatedBy = escapeSql(p.updatedBy || p.updated_by);

    // 1. INSERT ลง pm_log
    var queryLog = `INSERT INTO \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` 
      (no, machine_id, model, customer, customer_id, phone_number, contract_date, current_Hours, last_pm_round, next_pm_round, status, updated_by, parts_store, parts_bill_no, parts_status, receipt_image, yanmar_coupon, remark, string_field_18)
      VALUES (
        '', '${safeMachineId}', '${safeModel}', '${safeCustomerName}', '${safeCustomerId}', '${safePhone}', 
        '${strDate}', ${actualHours}, '${pmRound}', ${nextPm}, 'Approved', '${safeUpdatedBy}', 
        '${safePartsStore}', '${safePartsBillNo}', '${safePartsStatus}', '${safeReceiptImage}', 
        ${Number(p.yanmarCoupon) || 0}, '${safeRemark}', '${ticketId}'
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
          contract_date = '${strDate}',
          current_Hours = ${actualHours}, 
          last_pm_round = CAST('${pmRound}' AS INT64), 
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
        INSERT (no, machine_id, model, customer, customer_id, phone_number, contract_date, current_Hours, last_pm_round, next_pm_round, status, updated_by, parts_store, parts_bill_no, parts_status, receipt_image, yanmar_coupon, remark)
        VALUES (
          '', '${safeMachineId}', '${safeModel}', '${safeCustomerName}', '${safeCustomerId}', '${safePhone}', 
          '${strDate}', ${actualHours}, CAST('${pmRound}' AS INT64), ${nextPm}, 'Approved', '${safeUpdatedBy}', 
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

    var getMachineSql = `SELECT machine_id FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` WHERE string_field_18 = '${ticketId}' LIMIT 1`;
    var rows = runBigQuery(getMachineSql);
    var machineId = rows.length > 0 ? escapeSql(rows[0].machine_id) : "";

    var remarkUpdate = couponRemark !== "" ? `CONCAT(IFNULL(remark, ''), ' | เลขรับคูปอง: ${couponRemark}')` : "remark";
    var updateLogSql = `UPDATE \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` 
                        SET yanmar_coupon = ${amount}, remark = ${remarkUpdate} 
                        WHERE string_field_18 = '${ticketId}'`;
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
// 9. ลบข้อมูลใน PM_Log
// ==========================================
function deleteReport(ticketId) {
  try {
    var safeTicketId = escapeSql(ticketId);
    var sql = `DELETE FROM \`${BQ_PROJECT_ID}.${BQ_DATASET_ID}.pm_log\` 
               WHERE string_field_18 = '${safeTicketId}' OR machine_id = '${safeTicketId}'`;
    runBigQuery(sql);
    return responseJSON({ status: "success" });
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}
