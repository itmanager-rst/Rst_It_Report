// =================================================================
// CRM-TRACKER : Backend Code.gs (BigQuery Standard Schema - Full Fixed Code)
// =================================================================
// เลขเวอร์ชันโค้ด ใช้เช็คว่า deployment ที่หน้าเว็บเรียกอยู่จริง เป็นโค้ดชุดล่าสุด
// หรือยังเป็นของเก่าที่ค้าง cache อยู่ — เปลี่ยนค่านี้ทุกครั้งที่แก้โค้ดแล้ว deploy ใหม่
// วิธีเช็ค: เปิด URL เว็บแอพ แล้วต่อท้ายด้วย ?action=checkStatus แล้วดูค่า codeVersion
// ในผลลัพธ์ JSON ที่ได้ ถ้าไม่ตรงกับค่าล่าสุดในไฟล์นี้ แปลว่า deploy ไม่ติดจริง
//
// แก้ไข (2026-08-08 รอบใหม่): ทั้งสองบั๊กที่รายงานเข้ามา —
//   1) หน้ารายงานขึ้น "Invalid Action" ตอนกดดึงรายงาน
//   2) ยอด Facebook/ManyChat ขึ้น 0 ทั้งที่มีลีดส่งเข้ามาจริง
// ทั้งสองอย่างนี้ "แก้อยู่ในโค้ดไฟล์นี้แล้ว" (ดูจุด action==='getDailyLeadReport' ใน
// doPost ด้านล่าง และ FB_LEAD_MARKER ที่ตัด "/manychat" ออกแล้วด้านล่าง) — ถ้ายังเจอ
// อาการเดิมอยู่ แปลว่าไฟล์นี้ "ยังไม่ถูก deploy จริง" ไปทับ Apps Script เดิม ให้ทำตาม
// ขั้นตอน: เปิด Apps Script > วางโค้ดไฟล์นี้ทับของเดิมทั้งไฟล์ > Deploy > Manage
// deployments > กดไอคอนดินสอ (แก้ไข) ที่ deployment ที่ใช้งานอยู่ (ต้อง URL ตรงกับ
// WEB_APP_URL ในไฟล์ index.html) > Version เลือก "New version" > Deploy
// (ถ้าลืมขั้นนี้ กด Save เฉยๆ จะไม่มีผลกับเว็บที่ใช้งานจริงเลย) — เปลี่ยนเลขเวอร์ชัน
// ด้านล่างนี้ไว้เป็นค่าที่ index_11.html คาดหวัง (ดู EXPECTED_CODE_VERSION ในไฟล์นั้น)
// เพื่อให้หน้าเว็บเช็คได้เองว่า deploy ติดจริงหรือยัง (จะขึ้นแถบเตือนสีเหลืองถ้ายังไม่ตรง)
//
// แก้เพิ่ม (2026-08-08 รอบถัดมา): ผู้ใช้ยืนยันว่าอยากให้ "นับตัวเลขให้ได้ก่อน" เป็นอันดับแรก
// สุด (ตัดเรื่องดึงชื่อสินค้าจาก remark ออกไปก่อน) — เลยทำ FB_LEAD_MARKER ให้ผิดพลาดยากที่สุด
// เท่าที่จะทำได้ ดูรายละเอียดที่คอมเมนต์ตรง FB_LEAD_MARKER ด้านล่าง
var CODE_VERSION = 'r7-2026-08-08-fb-marker-broaden';
var GCP_PROJECT_ID = 'crm-tracker-503906';
var DATASET_ID = 'crm_tracker';
var TABLE_ID = 'customers';
var TABLE_FULL_PATH = '`' + GCP_PROJECT_ID + '.' + DATASET_ID + '.' + TABLE_ID + '`';
// สร้าง Unique Key แบบ Hexadecimal Text ด้วย MD5 ป้องกันปัญหา JS ปัดเศษตัวเลข BigInt
var FINGERPRINT_EXPR = "TO_HEX(MD5(CONCAT(IFNULL(CAST(created_date AS STRING),''), IFNULL(first_name,''), IFNULL(last_name,''), IFNULL(CAST(phone AS STRING),''))))";
// เงื่อนไขในการค้นหาและระบุตัวตนแถวข้อมูล (รองรับทั้ง MD5 Key และ เบอร์โทรศัพท์ทั้งแบบมี/ไม่มีเลข 0)
var ROW_MATCH_WHERE = "(" + FINGERPRINT_EXPR + " = @key " +
                      " OR CAST(phone AS STRING) = @key " +
                      " OR (SAFE_CAST(phone AS INT64) = SAFE_CAST(REGEXP_REPLACE(@key, r'\\D', '') AS INT64) " +
                      "     AND SAFE_CAST(phone AS INT64) IS NOT NULL AND SAFE_CAST(phone AS INT64) != 0))";
// เครื่องหมายที่ใช้ระบุว่าลูกค้ารายนี้ถูกยิงเข้ามาอัตโนมัติจาก ManyChat/Facebook
// (ManyChat External Request ยัดข้อความนี้ไว้หน้า remark ทุกครั้งที่ส่งลีดเข้ามา —
// ดูขั้นตอนผูก ManyChat ใน manychat-to-crm-setup-guide.md)
//
// แก้ไข (2026-08-08): เดิมเช็คว่า remark ต้องมีคำว่า "lead จาก facebook/manychat"
// (มี "/manychat" ต่อท้าย) แต่ automation ตัวจริงที่ผูกไว้ในทุกโฟลว์ ManyChat ตอนนี้
// ส่ง remark เป็น "[Lead จาก Facebook] ..." เท่านั้น (ไม่มี "/ManyChat" ต่อท้าย) —
// ทำให้ LIKE เดิมไม่แมตช์เลยสักแถว นับได้ 0 ตลอด ทั้งๆที่มีลีดส่งเข้ามาจริง
// (เห็นได้จากตัวเลขในหน้ารายงานไม่ขึ้นเลย) ตัด "/manychat" ออกจากคำที่ใช้เช็ค
// ให้เหลือแค่ "lead จาก facebook" ซึ่งแมตช์ได้ทั้งข้อความเก่า [Lead จาก Facebook/ManyChat]
// และข้อความจริงที่ใช้อยู่ตอนนี้ [Lead จาก Facebook]
//
// แก้เพิ่มอีกรอบ (2026-08-08): แม้แต่ "lead จาก facebook" ก็ยังพึ่งพาคำภาษาไทย "จาก"
// ต้องสะกด/เว้นวรรคตรงเป๊ะทุกตัวอักษรถึงจะแมตช์ — ถ้า automation ใน ManyChat เปลี่ยนคำ
// (เช่น "มาจาก" แทน "จาก", เว้นวรรคต่าง, หรือแก้ข้อความใหม่ทั้งประโยค) ตัวเลขจะพัง 0
// แบบเงียบๆ อีกได้เหมือนที่เคยเกิดมาแล้วสองรอบ ผู้ใช้ระบุชัดว่า "เอาให้นับตัวเลขให้ได้ก่อน"
// เป็นอันดับแรก เลยตัดคำภาษาไทยออกทั้งหมด เหลือแค่เช็คคำว่า "facebook" คำเดียว (ภาษาอังกฤษ
// ล้วน ไม่มีปัญหาเรื่องตัวสะกด/รูปประโยคภาษาไทย) — ทุกเวอร์ชันของข้อความที่เคยเห็นมา
// ("[Lead จาก Facebook/ManyChat]" และ "[Lead จาก Facebook]") มีคำว่า facebook อยู่เสมอ
// ตัวนี้จึงกว้างที่สุดเท่าที่จะทำได้โดยยังไม่เสี่ยงนับผิดเป็นอย่างอื่น (ระวังไว้อย่างเดียว:
// ถ้าพนักงานพิมพ์บันทึกเองแล้วบังเอิญมีคำว่า facebook ปนอยู่ เช่น "ลูกค้าถามถึงเพจ Facebook"
// แถวนั้นจะถูกนับเป็น ManyChat ไปด้วย เป็น edge case ที่หายากกว่าปัญหาตัวเลขเป็น 0 มาก)
var FB_LEAD_MARKER = 'facebook';
var FB_LEAD_MATCH_COND = "LOWER(IFNULL(remark, '')) LIKE @fbMarker";
var FB_LEAD_MATCH_PARAM = { name: 'fbMarker', value: '%' + FB_LEAD_MARKER + '%' };

// =================================================================
// เบอร์โทรที่ไม่ควรถูกนับเป็น "ลูกค้า" เลย (เช่น เบอร์เซลล์ที่ให้ลูกค้าโทรกลับ)
// =================================================================
// ลูกค้าบางคนกดคัดลอกเบอร์ติดต่อของเซลล์จากข้อความ/โพสต์ แล้วส่งเบอร์นั้นกลับมาผ่าน
// ManyChat โดยเข้าใจผิดว่าต้องส่งเบอร์ (เป็นเบอร์เซลล์ ไม่ใช่เบอร์ลูกค้าจริง) ทำให้เบอร์นี้
// ถูกบันทึกเข้าระบบซ้ำไปเรื่อยๆ และทำให้ตัวเลขในรายงาน/ยอดลูกค้าเพี้ยน — เบอร์ในลิสต์นี้
// จะถูกกันไว้ 2 ชั้น: (1) addCustomerHTML จะไม่สร้าง/ไม่อัปเดตแถวลูกค้าใดๆ และไม่ log เข้า
// lead_intake_log เลยถ้าเบอร์ที่ส่งมาตรงกับลิสต์นี้ (กันไม่ให้นับเข้าไปตั้งแต่ต้น) และ
// (2) รายงาน/หน้าดูรายละเอียด (getDailyLeadReportHTML, getLeadIntakeLogDetailHTML) กรอง
// แถว lead_intake_log เก่าที่มีเบอร์นี้ออกจากการนับด้วย เผื่อมีแถวเก่าที่บันทึกไปแล้วก่อนเพิ่ม
// ลิสต์นี้ — เทียบกับเบอร์ที่ผ่าน formatPhoneNumber แล้วเสมอ (รูปแบบ 10 หลัก ขึ้นต้นด้วย 0)
// เพิ่มเบอร์อื่นในลิสต์นี้ได้เรื่อยๆ ถ้าเจอปัญหาแบบเดียวกัน (เบอร์ทีม/เบอร์ร้าน ฯลฯ)
var EXCLUDED_PHONE_NUMBERS = ['0864609120'];

// สร้างเงื่อนไข WHERE (สำหรับ query กับ lead_intake_log) ที่กันเบอร์ใน
// EXCLUDED_PHONE_NUMBERS ออกจากการนับ — คืนค่าเป็น '' ถ้าลิสต์ว่าง (ไม่ต้องเติมเงื่อนไข)
function buildExcludedPhoneCondition_() {
  if (!EXCLUDED_PHONE_NUMBERS || EXCLUDED_PHONE_NUMBERS.length === 0) return '';
  var placeholders = EXCLUDED_PHONE_NUMBERS.map(function(_, i) { return '@excludedPhone' + i; });
  return "IFNULL(phone, '') NOT IN (" + placeholders.join(', ') + ")";
}
// พารามิเตอร์คู่กับ buildExcludedPhoneCondition_() ด้านบน — ต้อง concat เข้ากับ params
// ทุกครั้งที่ใช้เงื่อนไขนี้ ไม่งั้น BigQuery จะ error ว่าไม่รู้จัก @excludedPhoneN
function buildExcludedPhoneParams_() {
  return (EXCLUDED_PHONE_NUMBERS || []).map(function(p, i) {
    return { name: 'excludedPhone' + i, value: p };
  });
}

// =================================================================
// ตาราง Log การรับลีดเข้ามา (lead_intake_log)
// =================================================================
// เหตุผลที่ต้องมีตารางนี้แยกจาก customers: เวลาลีดที่ส่งเข้ามาซ้ำ (ชื่อ Facebook เดิม
// หรือเบอร์เดิม) ระบบจะ "ไม่สร้างแถวใหม่" ในตาราง customers (ไปอัปเดต follow_up_log
// ของแถวเดิมแทน) ดังนั้นถ้าจะนับ "วันนี้ได้กี่เบอร์ทั้งหมด" (รวมที่ส่งซ้ำมาด้วย)
// จะนับจากตาราง customers อย่างเดียวไม่ได้ ต้องมี Log แยกที่บันทึกทุกครั้งที่มีการ
// ยิง action:add เข้ามา ไม่ว่าจะจบด้วยการสร้างลูกค้าใหม่หรือไปรวมกับของเดิมก็ตาม
//
// ⚠️ ต้องรันคำสั่งนี้ใน BigQuery Console ก่อนใช้งาน (ครั้งเดียว) มิฉะนั้นจะ error
// เพราะตารางยังไม่มีอยู่ — ใช้ฟังก์ชัน runOneTimeSetup_CreateLeadIntakeLogTable()
// ด้านล่างของไฟล์นี้ (เลือกจาก dropdown ▶ Run แล้วกดรันครั้งเดียว)
var LOG_TABLE_ID = 'lead_intake_log';
var LOG_TABLE_FULL_PATH = '`' + GCP_PROJECT_ID + '.' + DATASET_ID + '.' + LOG_TABLE_ID + '`';

// =================================================================
// คอลัมน์ last_followup_date — "วันที่ติดตามล่าสุด" แยกจาก created_date
// =================================================================
// created_date (คอลัมน์ "วันที่" ที่โชว์ในตาราง) ยังคงหมายถึงวันที่ลูกค้ารายนี้
// เข้าระบบครั้งแรกเสมอ ไม่ถูกแก้ไขตอนมีการติดตาม เพื่อไม่ให้เสียข้อมูลว่าได้ลูกค้า
// รายนี้มาตั้งแต่เมื่อไหร่ (กระทบรายงาน/การกรองตามวันที่รับลีดถ้าไปทับค่านี้)
// last_followup_date คือคอลัมน์ใหม่ที่เก็บ "วันที่ของการติดตามครั้งล่าสุด" แยกไว้
// ต่างหาก อัปเดตทุกครั้งที่มีการเพิ่มบันทึกลงไทม์ไลน์ follow_up_log (ทั้งจากพนักงาน
// กดในหน้าเว็บ และจาก ManyChat ส่งข้อมูลซ้ำเข้ามา) — ใช้ sort/filter หน้ารายงานว่า
// ใคร active ล่าสุดได้ โดยไม่ต้องไปยุ่งกับ created_date เดิม
//
// ⚠️ ต้องรันคำสั่งนี้ใน BigQuery Console ก่อนใช้งาน (ครั้งเดียว) — ใช้ฟังก์ชัน
// runOneTimeSetup_AddLastFollowupDateColumn() ด้านล่างของไฟล์นี้

/**
 * ฟังก์ชันเช็คการเชื่อมต่อ BigQuery
 */
function checkBigQueryStatus() {
  try {
    var sql = "SELECT 1 as status";
    var res = runParamQueryFetch(sql, []);
    if (res && res.length > 0) {
      return { success: true, connected: true, message: 'BigQuery Connected', codeVersion: CODE_VERSION };
    }
    return { success: false, connected: false, message: 'No response', codeVersion: CODE_VERSION };
  } catch (err) {
    return { success: false, connected: false, message: err.toString(), codeVersion: CODE_VERSION };
  }
}
/**
 * ฟังก์ชันแปลงวันที่ ให้คงรูปแบบ YYYY-MM-DD (ค.ศ.) ตาม BigQuery
 */
function formatDateStr(val) {
  if (val === null || val === undefined || val === '') return '';

  // 1. ถ้าได้ประเภท Date Object มาจาก BigQuery
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    return Utilities.formatDate(val, 'Asia/Bangkok', 'yyyy-MM-dd');
  }
  var str = val.toString().trim();
  if (str === '-' || str === 'null' || str === 'undefined') return '';
  // ตัดส่วนเวลาออกถ้ามีติดมา (เช่น 2026-08-06T00:00:00Z)
  if (str.indexOf('T') !== -1) str = str.split('T')[0];
  if (str.indexOf(' ') !== -1) str = str.split(' ')[0];
  // 2. ถ้าเป็น YYYY-MM-DD อยู่แล้ว (ตรงกับ BigQuery) ให้ส่งกลับได้ทันที ไม่ต้องคำนวณปีใหม่
  if (/^\d{4}[-\/\.]\d{2}[-\/\.]\d{2}$/.test(str)) {
    var parts = str.split(/[-\/\.]/);
    var y = parseInt(parts[0], 10);
    var m = parts[1];
    var d = parts[2];
    // ป้องกันกรณีหลุดปี พ.ศ. (ต้องมากกว่า 2400 จริงๆ ถึงจะลบ 543)
    if (y > 2400) {
      y = y - 543;
    }
    return y + '-' + m + '-' + d;
  }
  // 3. ถ้าเป็น DD/MM/YYYY (เช่น 31/08/2023 หรือ 31/08/2566)
  if (/^\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{4}$/.test(str)) {
    var p = str.split(/[-\/\.]/);
    var day = p[0].padStart(2, '0');
    var month = p[1].padStart(2, '0');
    var year = parseInt(p[2], 10);
    if (year > 2400) {
      year = year - 543;
    }
    return year + '-' + month + '-' + day;
  }
  // 4. แก้เพิ่ม (2026-08-08 รอบ 2): ข้อมูลเก่าบางแถวพิมพ์ปี พ.ศ. แบบย่อแค่ 2 หลัก
  // เช่น "31/10/67" (หมายถึง 31/10/2567) — เดิมโค้ดข้อ 3 ต้องการปีเต็ม 4 หลัก
  // เจอปีย่อแบบนี้เลยไม่แมตช์เลย ตกไป return str เดิมๆ (โชว์ "31/10/67" ตรงๆ
  // ในตาราง ไม่ถูกแปลงเป็นวันที่จริง) เพราะข้อมูลทั้งหมดเป็นของไทย ปีย่อ 2 หลักจึง
  // ตีความเป็น พ.ศ. เสมอ (ไม่ใช่ปี ค.ศ. ย่อ) แปลงเป็น ค.ศ. ด้วยสูตร 2500+YY-543
  if (/^\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2}$/.test(str)) {
    var p2 = str.split(/[-\/\.]/);
    var day2 = p2[0].padStart(2, '0');
    var month2 = p2[1].padStart(2, '0');
    var yy = parseInt(p2[2], 10);
    var year2 = 2500 + yy - 543; // เทียบเท่า 1957 + yy
    return year2 + '-' + month2 + '-' + day2;
  }
  return str;
}
/**
 * จัดการรูปแบบเบอร์โทรศัพท์ เติม 0 ข้างหน้าให้ครบ 10 หลัก
 */
function formatPhoneNumber(ph) {
  if (ph === undefined || ph === null) return '';
  var strPhone = ph.toString().trim();
  if (!strPhone) return '';

  strPhone = strPhone.replace(/\D/g, '');
  if (strPhone.length === 9 && !strPhone.startsWith('0')) {
    strPhone = '0' + strPhone;
  }
  return strPhone;
}
function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : '';
  if (action === 'getInitialData') {
    return createJsonResponse(getInitialDataHTML());
  } else if (action === 'getDashboardSummary') {
    return createJsonResponse(getDashboardSummaryHTML());
  } else if (action === 'checkStatus') {
    return createJsonResponse(checkBigQueryStatus());
  } else if (action === 'getDailyLeadReport') {
    return createJsonResponse(getDailyLeadReportHTML(e.parameter));
  } else if (action === 'getLeadIntakeLogDetail') {
    // รายละเอียดที่ประกอบเป็นตัวเลขในรายงานรายวัน (ดู getLeadIntakeLogDetailHTML)
    // รองรับ GET ด้วยเผื่ออยากทดสอบผ่าน URL ตรงๆ — หน้าเว็บจริงเรียกผ่าน doPost
    return createJsonResponse(getLeadIntakeLogDetailHTML(e.parameter));
  }
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('CRM-TRACKER ระบบจัดการข้อมูลลูกค้า')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function doPost(e) {
  try {
    var contents = JSON.parse(e.postData.contents);
    var action = contents.action;
    // ใส่ codeVersion + action ที่รับมาจริงไว้ใน error message เผื่อ deploy ไม่ติด
    // (โค้ดที่รันจริงบน server เป็นคนละเวอร์ชันกับที่แก้ไว้ในตัวแก้ไข) จะได้เห็นชัดๆ
    // ทันทีจาก error message เองว่า server ที่รันอยู่จริงเป็นเวอร์ชันไหน ไม่ต้องเดา
    var result = { success: false, message: 'Invalid Action: "' + action + '" (codeVersion=' + CODE_VERSION + ')' };
    if (action === 'checkStatus' || action === 'checkBigQuery') {
      result = checkBigQueryStatus();
    } else if (action === 'search' || action === 'searchCustomers') {
      result = searchCustomersHTML(contents.payload || contents);
    } else if (action === 'add' || action === 'addCustomer') {
      result = addCustomerHTML(contents.payload || contents.data || {});
    } else if (action === 'update' || action === 'editCustomer') {
      var editData = contents.payload || contents;
      result = updateCustomerHTML(editData.rowIndex || editData.phoneKey, editData.cust || editData.data || {});
    } else if (action === 'delete' || action === 'deleteCustomer') {
      var delData = contents.payload || contents;
      result = deleteCustomerHTML(delData.phoneKey || delData.rowIndex);
    } else if (action === 'getByPhone' || action === 'getCustomerByRow') {
      var getData = contents.payload || contents;
      result = getCustomerByPhone(getData.phoneKey || getData.rowIndex);
    } else if (action === 'getInitialData') {
      result = getInitialDataHTML();
    } else if (action === 'getDashboardSummary') {
      result = getDashboardSummaryHTML(contents.payload || contents);
    } else if (action === 'checkDuplicatePhone') {
      var checkData = contents.payload || contents;
      result = checkDuplicatePhoneHTML(checkData.phone);
    } else if (action === 'exportAll') {
      result = getAllCustomersExport();
    } else if (action === 'addFollowUp') {
      // เพิ่มบันทึกการติดตามลูกค้า 1 รอบ (วันที่ + หมายเหตุ) เข้าไปในไทม์ไลน์
      var flData = contents.payload || contents;
      result = addFollowUpLogHTML(flData.key || flData.rowIndex || flData.phoneKey, flData.entry || {});
    } else if (action === 'getDailyLeadReport') {
      // รายงานจำนวนลีดที่ส่งเข้ามาต่อวัน (รวมที่ซ้ำด้วย) — ดูฟังก์ชัน getDailyLeadReportHTML
      result = getDailyLeadReportHTML(contents.payload || contents);
    } else if (action === 'getLeadIntakeLogDetail') {
      // รายละเอียด (รายชื่อ/เบอร์/สถานะ) ที่ประกอบเป็นตัวเลขในตารางรายงานรายวัน
      // ใช้ตอนกดตัวเลขในหน้ารายงาน (index.html) — ดูฟังก์ชัน getLeadIntakeLogDetailHTML
      result = getLeadIntakeLogDetailHTML(contents.payload || contents);
    }
    return createJsonResponse(result);
  } catch (err) {
    return createJsonResponse({ success: false, message: err.toString() });
  }
}
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
function cleanStr(str) {
  if (str === null || str === undefined) return '';
  return str.toString().trim();
}
function runParamQueryFetch(sql, params) {
  try {
    var request = {
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: (params || []).map(function(p) {
        return { name: p.name, parameterType: { type: 'STRING' }, parameterValue: { value: p.value } };
      })
    };
    var queryResults = BigQuery.Jobs.query(request, GCP_PROJECT_ID);
    var jobId = queryResults.jobReference.jobId;
    while (!queryResults.jobComplete) {
      Utilities.sleep(250);
      queryResults = BigQuery.Jobs.getQueryResults(GCP_PROJECT_ID, jobId);
    }
    var rows = queryResults.rows;
    var schema = queryResults.schema ? queryResults.schema.fields : [];
    var result = [];
    if (rows) {
      for (var i = 0; i < rows.length; i++) {
        var item = {};
        for (var j = 0; j < schema.length; j++) {
          item[schema[j].name] = (rows[i].f[j] && rows[i].f[j].v !== null) ? rows[i].f[j].v : '';
        }
        result.push(item);
      }
    }
    return result;
  } catch (e) {
    throw new Error('BigQuery Query Error: ' + e.toString());
  }
}
function runParamQuery(sql, params) {
  try {
    var request = {
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: (params || []).map(function(p) {
        return { name: p.name, parameterType: { type: 'STRING' }, parameterValue: { value: p.value } };
      })
    };
    var queryResults = BigQuery.Jobs.query(request, GCP_PROJECT_ID);
    var jobId = queryResults.jobReference.jobId;
    while (!queryResults.jobComplete) {
      Utilities.sleep(250);
      queryResults = BigQuery.Jobs.getQueryResults(GCP_PROJECT_ID, jobId);
    }
    return true;
  } catch (e) {
    throw new Error('BigQuery Execute Error: ' + e.toString());
  }
}
function getInitialDataHTML() {
  try {
    var countSQL = "SELECT COUNT(*) as total FROM " + TABLE_FULL_PATH;
    var countRes = runParamQueryFetch(countSQL, []);
    var totalCount = (countRes && countRes.length > 0) ? parseInt(countRes[0].total) : 0;

    // จำนวนลูกค้าทั้งหมด (ไม่กรอง) ที่มาจาก ManyChat/Facebook อัตโนมัติ — โชว์เป็นตัวเลขคงที่บนหัวหน้าเว็บ
    var fbSQL = "SELECT COUNT(*) as cnt FROM " + TABLE_FULL_PATH + " WHERE " + FB_LEAD_MATCH_COND;
    var fbRes = runParamQueryFetch(fbSQL, [FB_LEAD_MATCH_PARAM]);
    var manyChatTotalCount = (fbRes && fbRes.length > 0) ? parseInt(fbRes[0].cnt) : 0;

    return { success: true, totalCount: totalCount, manyChatTotalCount: manyChatTotalCount };
  } catch (err) {
    return { success: false, message: err.toString(), totalCount: 0, manyChatTotalCount: 0 };
  }
}
function buildWhereClause(filters) {
  var whereClauses = [];
  var params = [];
  if (filters.keyword) {
    var cleanKw = cleanStr(filters.keyword).toLowerCase();
    whereClauses.push("(LOWER(CAST(created_date AS STRING)) LIKE @kw " +
                      "OR LOWER(IFNULL(first_name, '')) LIKE @kw " +
                      "OR LOWER(IFNULL(last_name, '')) LIKE @kw " +
                      "OR LOWER(CAST(phone AS STRING)) LIKE @kw " +
                      "OR LOWER(IFNULL(product, '')) LIKE @kw " +
                      "OR LOWER(IFNULL(village, '')) LIKE @kw " +
                      "OR LOWER(IFNULL(subdistrict, '')) LIKE @kw " +
                      "OR LOWER(IFNULL(district, '')) LIKE @kw " +
                      "OR LOWER(IFNULL(remark, '')) LIKE @kw)");
    params.push({ name: 'kw', value: '%' + cleanKw + '%' });
  }
  if (filters.exactPhone) {
    var cleanP = cleanStr(filters.exactPhone);
    whereClauses.push("(CAST(phone AS STRING) = @exactPhone OR SAFE_CAST(phone AS INT64) = SAFE_CAST(REGEXP_REPLACE(@exactPhone, r'\\D', '') AS INT64))");
    params.push({ name: 'exactPhone', value: cleanP });
  }
  if (filters.types && Array.isArray(filters.types) && filters.types.length > 0) {
    var typeConditions = [];
    for (var i = 0; i < filters.types.length; i++) {
      var paramName = 'type_' + i;
      typeConditions.push("type = @" + paramName);
      params.push({ name: paramName, value: cleanStr(filters.types[i]) });
    }
    whereClauses.push("(" + typeConditions.join(" OR ") + ")");
  }
  if (filters.startDate) {
    whereClauses.push("CAST(created_date AS STRING) >= @startDate");
    params.push({ name: 'startDate', value: cleanStr(filters.startDate) });
  }
  if (filters.endDate) {
    whereClauses.push("CAST(created_date AS STRING) <= @endDate");
    params.push({ name: 'endDate', value: cleanStr(filters.endDate) });
  }
  if (filters.appdate) {
    whereClauses.push("CAST(booking_date AS STRING) LIKE @appdate");
    params.push({ name: 'appdate', value: '%' + cleanStr(filters.appdate) + '%' });
  }
  // กรองตาม "วันที่ติดตามล่าสุด" (last_followup_date) — แยกจาก startDate/endDate ที่กรองตาม
  // created_date (วันที่รับลีดครั้งแรก) ด้านบน
  if (filters.followupStartDate) {
    whereClauses.push("CAST(last_followup_date AS STRING) >= @followupStartDate");
    params.push({ name: 'followupStartDate', value: cleanStr(filters.followupStartDate) });
  }
  if (filters.followupEndDate) {
    whereClauses.push("CAST(last_followup_date AS STRING) <= @followupEndDate");
    params.push({ name: 'followupEndDate', value: cleanStr(filters.followupEndDate) });
  }
  if (filters.product && filters.product !== 'ALL') {
    whereClauses.push("product = @product");
    params.push({ name: 'product', value: cleanStr(filters.product) });
  }
  if (filters.subdistrict) {
    whereClauses.push("LOWER(IFNULL(subdistrict, '')) LIKE @subdistrict");
    params.push({ name: 'subdistrict', value: '%' + cleanStr(filters.subdistrict).toLowerCase() + '%' });
  }
  if (filters.district) {
    whereClauses.push("LOWER(IFNULL(district, '')) LIKE @district");
    params.push({ name: 'district', value: '%' + cleanStr(filters.district).toLowerCase() + '%' });
  }
  if (filters.note) {
    whereClauses.push("LOWER(IFNULL(remark, '')) LIKE @note");
    params.push({ name: 'note', value: '%' + cleanStr(filters.note).toLowerCase() + '%' });
  }
  return {
    sql: whereClauses.length > 0 ? " WHERE " + whereClauses.join(" AND ") : "",
    params: params
  };
}

// =================================================================
// แก้บั๊กการเรียงลำดับวันที่ (2026-08-08)
// =================================================================
// ปัญหาที่พบ: ตาราง customers มีข้อมูลวันที่ (created_date/booking_date/
// last_followup_date) ปนกันหลายรูปแบบ เพราะเป็นข้อมูลเก่าที่ import มาจาก
// สเปรดชีตในหลายรอบ — บางแถวเป็น STRING/DATE รูปแบบ ISO 'YYYY-MM-DD' (แถวใหม่ๆ
// ที่กรอกผ่านหน้าเว็บปัจจุบัน ซึ่งใช้ <input type="date">) แต่แถวเก่าบางส่วนเป็น
// ข้อความ 'DD/MM/YYYY' (บางทีปี พ.ศ. เช่น 31/10/2567) ของเดิมก่อนย้ายมาระบบนี้
//
// ของเดิม ORDER BY ทำ CAST(...AS STRING) แล้วเรียงแบบ "เรียงตัวอักษร" (lexicographic)
// ตรงๆ — พอเจอวันที่แบบ 'DD/MM/YYYY' การเรียงจะไปยึดตาม "วันที่" (DD) ตัวหน้าสุดเป็นหลัก
// ไม่ใช่ปี ทำให้ทุกแถวที่วันที่ (DD) = 31 ลอยขึ้นไปอยู่บนสุดเสมอเมื่อเรียง DESC
// (เพราะ "31" เป็นสตริงที่มีค่ามากที่สุดในตำแหน่งแรก) ไม่ว่าเดือน/ปีจริงจะเก่าแค่ไหนก็ตาม
// นี่คือสาเหตุที่เห็นข้อมูลปี พ.ศ. 2566-2567 (เก่ามาก) ลอยขึ้นมาบนสุดของ "เรียงใหม่สุดก่อน"
//
// วิธีแก้: แปลงข้อความให้เป็นวันที่จริง (DATE) ก่อนเรียง โดยลองตามลำดับ:
//   1) ลองแปลงแบบ ISO 'YYYY-MM-DD' ก่อน (ครอบคลุมทั้งแถวใหม่ และแถวที่เป็น DATE
//      type จริงอยู่แล้ว เพราะ BigQuery จะ CAST(DATE AS STRING) ออกมาเป็น ISO เสมอ)
//   2) ถ้าแปลงแบบ ISO ไม่ได้ ลองแปลงแบบ 'DD/MM/YYYY' — ถ้าปีที่ได้มากกว่าปีปัจจุบัน
//      เกิน 50 ปี (เช่น 2567) ให้เดาว่าเป็นปี พ.ศ. แล้วลบ 543 ปีให้เป็นปี ค.ศ.
//   3) แปลงไม่ได้เลย (ว่าง/ผิดรูปแบบ) ให้ตกไปเป็น '1900-01-01' เหมือนของเดิม
// ผลคือเรียงตามวันที่จริงถูกต้อง ไม่ว่าแถวนั้นจะเก็บวันที่แบบไหนมาก็ตาม
//
// ⚠️ หมายเหตุ: นี่แก้เฉพาะการ "เรียงลำดับ" (ORDER BY) เท่านั้น ตัวกรองช่วงวันที่
// (filters.startDate/endDate ฯลฯ ใน buildWhereClause) ยังใช้การเทียบ STRING แบบเดิม
// ซึ่งน่าจะมีปัญหาคล้ายกันกับแถวที่เป็น 'DD/MM/YYYY' — ยังไม่ได้แก้ในรอบนี้ เพราะเป็น
// คนละส่วนและอาจกระทบประสิทธิภาพการค้นหาบนตารางที่มีข้อมูลจำนวนมาก ถ้าพบว่ากรองช่วง
// วันที่ได้ผลลัพธ์ไม่ตรง (เช่นแถวเก่าที่เป็น DD/MM/YYYY หลุดออกจากผลกรอง) แจ้งมาได้
// จะแก้ในส่วนนั้นต่อ
//
// แก้เพิ่ม (2026-08-08 รอบ 2): พบว่ายังมีแถวลอยขึ้นบนสุดผิดที่อยู่ (เช่นวันที่โชว์เป็น
// "31/10/67") ทั้งที่ควรจะเก่ากว่าแถวอื่น — สาเหตุคือแถวเหล่านี้พิมพ์ปี พ.ศ. แบบย่อ
// แค่ 2 หลัก (เช่น "31/10/67" หมายถึง 31/10/2567) ซึ่งของเดิม dmyParse ('%d/%m/%Y')
// ไม่ได้ตั้งใจรองรับ แต่ %Y ใน BigQuery ไม่ได้บังคับความยาวหลัก ปล่อยให้กลืนเลขปีย่อ
// เป็นตัวเลขปีตรงๆ (เช่น "67" กลายเป็นปี ค.ศ. 67 ซึ่งเป็นปีโบราณเกินจริงไปอีกทาง) —
// ไม่ว่าผลจะออกมาแบบไหนก็ผิดทั้งคู่ (ทั้งกรณีลอยขึ้นบนสุดจากการเรียงตัวอักษรถ้ายังไม่ได้
// deploy โค้ดใหม่ และกรณี parse ผิดปีถ้า deploy แล้วแต่เจอปีย่อ) จึงแก้โดย "กันเขต" การ
// แปลงแต่ละแบบด้วย regex เช็ครูปแบบก่อนเสมอ (REGEXP_CONTAINS) ไม่ปล่อยให้ %Y เดามั่ว:
//   - ถ้ารูปแบบเป็นปีเต็ม 4 หลักเท่านั้น ถึงจะลองแปลงแบบ DD/MM/YYYY (dmyParse)
//   - ถ้ารูปแบบเป็นปีย่อ 2 หลักเท่านั้น (เช่น 31/10/67) ให้ดึงวัน/เดือน/ปีย่อออกมาด้วย
//     regex เอง แล้วตีความปีย่อเป็น พ.ศ. เสมอ (ข้อมูลทั้งหมดเป็นของไทย) บวก 1957 เข้ากับ
//     ปีย่อ (สูตรเทียบเท่า 2500+ปีย่อ-543) ประกอบกลับเป็นสตริง ISO ก่อนแปลงเป็น DATE
// ทั้งสองแบบจึงไม่มีทางมาปนกัน ไม่ต้องพึ่งพฤติกรรมความยาวหลักของ %Y ที่ไม่ชัดเจน
//
// แก้เพิ่ม (2026-08-08 รอบ 3): เจอสาเหตุจริงที่ทำให้แถวเก่ายังลอยขึ้นบนสุดอยู่ — มีแถวที่
// เก็บวันที่แบบ "YYYY-MM-DD" (เรียงลำดับปี-เดือน-วันแบบ ISO ถูกต้อง) แต่ตัวเลขปีเป็น พ.ศ.
// ที่ไม่ได้ถูกแปลงเป็น ค.ศ. มาก่อน (เช่น "2563-03-26" หมายถึง 26 มี.ค. 2563 พ.ศ. = ค.ศ. 2020
// แต่ไม่มีการลบ 543 ปีไว้ตั้งแต่ตอน import) เดิม isoParse ข้างล่างเชื่อว่ารูปแบบ YYYY-MM-DD
// ต้องเป็นปี ค.ศ. เสมอ (ไม่มีการเช็ค/แก้ปี พ.ศ. เหมือนสาขา DD/MM/YYYY ด้านล่าง) เลย parse
// ปี "2563" ตรงๆ กลายเป็นปี ค.ศ. 2563 จริงๆ (อนาคตเกินจริงไปกว่า 500 ปี) ทำให้แถวนี้มีค่า
// วันที่ใหญ่กว่าทุกแถวในตาราง ลอยขึ้นบนสุดเสมอไม่ว่าจะกรอกข้อมูลใหม่วันไหนก็ตาม
// วิธีแก้: เพิ่มการเช็ค/แปลงปี พ.ศ. (ปี > ปีปัจจุบัน+50 ปี ให้ลบ 543) ให้กับสาขา ISO นี้ด้วย
// เหมือนที่สาขา DD/MM/YYYY มีอยู่แล้ว
function buildRobustDateOrderExpr_(colName) {
  var raw = "CAST(" + colName + " AS STRING)";
  var isoParseRaw = "SAFE.PARSE_DATE('%Y-%m-%d', " + raw + ")";
  var isoParse = "IF(" + isoParseRaw + " IS NOT NULL AND " +
      "EXTRACT(YEAR FROM " + isoParseRaw + ") > EXTRACT(YEAR FROM CURRENT_DATE()) + 50, " +
      "DATE_SUB(" + isoParseRaw + ", INTERVAL 543 YEAR), " +
      isoParseRaw + ")";

  // DD/MM/YYYY (ปีเต็ม 4 หลัก ค.ศ. หรือ พ.ศ.) — เช็ครูปแบบก่อนด้วย REGEXP_CONTAINS
  // กันไม่ให้ %Y ไปกลืนสตริงปีย่อ 2 หลักโดยไม่ตั้งใจ
  var is4DigitYear = "REGEXP_CONTAINS(" + raw + ", r'^\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}$')";
  var dmyParseRaw = "SAFE.PARSE_DATE('%d/%m/%Y', " + raw + ")";
  var dmyParse = "IF(" + is4DigitYear + ", " + dmyParseRaw + ", NULL)";
  var dmyResolved = "IF(" + dmyParse + " IS NOT NULL AND " +
      "EXTRACT(YEAR FROM " + dmyParse + ") > EXTRACT(YEAR FROM CURRENT_DATE()) + 50, " +
      "DATE_SUB(" + dmyParse + ", INTERVAL 543 YEAR), " +
      dmyParse + ")";

  // DD/MM/YY (ปีย่อ 2 หลัก เช่น 31/10/67) — ตีความเป็น พ.ศ. เสมอ
  var is2DigitYear = "REGEXP_CONTAINS(" + raw + ", r'^\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2}$')";
  var dayFromYY2 = "REGEXP_EXTRACT(" + raw + ", r'^(\\d{1,2})[/.-]\\d{1,2}[/.-]\\d{2}$')";
  var monthFromYY2 = "REGEXP_EXTRACT(" + raw + ", r'^\\d{1,2}[/.-](\\d{1,2})[/.-]\\d{2}$')";
  var yy2 = "REGEXP_EXTRACT(" + raw + ", r'^\\d{1,2}[/.-]\\d{1,2}[/.-](\\d{2})$')";
  var yy2ParseRaw = "SAFE.PARSE_DATE('%Y-%m-%d', CONCAT(CAST(1957 + SAFE_CAST(" + yy2 + " AS INT64) AS STRING), '-', " +
                 monthFromYY2 + ", '-', " + dayFromYY2 + "))";
  var yy2Parse = "IF(" + is2DigitYear + ", " + yy2ParseRaw + ", NULL)";

  return "COALESCE(" +
    isoParse + ", " +
    dmyResolved + ", " +
    yy2Parse + ", " +
    "DATE '1900-01-01')";
}

function searchCustomersHTML(reqPayload) {
  try {
    var filters = (reqPayload && reqPayload.filters) ? reqPayload.filters : {};
    var page = (reqPayload && reqPayload.page) ? parseInt(reqPayload.page) : 1;
    var pageSize = (reqPayload && reqPayload.pageSize) ? parseInt(reqPayload.pageSize) : 50;
    var offset = (page - 1) * pageSize;
    var whereObj = buildWhereClause(filters);
    var countSQL = "SELECT COUNT(*) as total FROM " + TABLE_FULL_PATH + whereObj.sql;
    var countRes = runParamQueryFetch(countSQL, whereObj.params);
    var totalCount = (countRes && countRes.length > 0) ? parseInt(countRes[0].total) : 0;
    // เรียงตามฟิลด์วันที่ที่หน้าเว็บส่งมาได้ (sortBy) — หน้าเว็บจะเลือกส่งค่านี้เองอัตโนมัติ
    // ตามเงื่อนไขกรองที่กำลังใช้อยู่ (เช่นกรองช่วงวันติดตามล่าสุด ก็ส่ง sortBy เป็น
    // last_followup_date มาด้วย ไม่ต้องให้ผู้ใช้เลือกเอง) ไม่ส่งมา/ส่งค่าที่ไม่รู้จัก =
    // เรียงตาม created_date เหมือนเดิม (วันที่บันทึกลูกค้าครั้งแรก ใหม่สุดก่อน) —
    // จำกัดเป็น whitelist ป้องกัน SQL injection ผ่านชื่อคอลัมน์
    var ALLOWED_SORT_FIELDS = ['created_date', 'last_followup_date', 'booking_date'];
    var sortBy = (reqPayload && reqPayload.sortBy) ? cleanStr(reqPayload.sortBy) : 'created_date';
    var orderByField = (ALLOWED_SORT_FIELDS.indexOf(sortBy) !== -1) ? sortBy : 'created_date';
    // แก้เพิ่ม (2026-08-08): เรียงตามวันที่ (created_date/booking_date/last_followup_date
    // แล้วแต่ orderByField) เป็นหลักก่อนเหมือนเดิม แต่ถ้าหลายแถวอยู่ "วันเดียวกัน" (ซึ่ง
    // เกิดขึ้นบ่อยเพราะคอลัมน์วันที่เก็บแค่ระดับวัน ไม่มีเวลา) ลำดับภายในวันเดียวกันจะไม่
    // แน่นอน (BigQuery ไม่การันตีลำดับของแถวที่ค่าเรียงเท่ากัน) ทำให้ลูกค้าที่เพิ่งกรอกล่าสุด
    // ในวันนั้นอาจไม่ได้ขึ้นบนสุดของกลุ่มวันเดียวกัน — เพิ่ม created_at_ts (เวลาบันทึกจริง
    // ระดับวินาที เก็บอัตโนมัติตอน INSERT ใหม่ ดู addCustomerHTML) เป็นตัวเรียงรองถัดไป
    // เพื่อไล่จากใหม่สุดไปเก่าสุดภายในวันเดียวกันได้แม่นยำ — แถวเก่าที่ไม่มีค่านี้ (insert
    // ก่อนจะมีคอลัมน์นี้) จะเป็น NULL ซึ่ง BigQuery จัดให้ NULL อยู่ท้ายสุดเสมอเวลาเรียง DESC
    // จึงไม่กระทบลำดับของแถวเก่าที่ไม่มีค่านี้ (ยังคงลำดับแบบเดิม ไม่แน่นอนภายในกลุ่มนั้นๆ)
    var dataSQL = "SELECT * EXCEPT(created_date, booking_date, last_followup_date), " +
                  "CAST(created_date AS STRING) AS created_date, " +
                  "CAST(booking_date AS STRING) AS booking_date, " +
                  "CAST(last_followup_date AS STRING) AS last_followup_date, " +
                  FINGERPRINT_EXPR + " as row_key " +
                  "FROM " + TABLE_FULL_PATH + whereObj.sql + " " +
                  "ORDER BY " + buildRobustDateOrderExpr_(orderByField) + " DESC, created_at_ts DESC " +
                  "LIMIT " + pageSize + " OFFSET " + offset;
    var rows = runParamQueryFetch(dataSQL, whereObj.params);
    var formattedData = rows.map(function(r) {
      var recDate = formatDateStr(r.created_date || r.date || '');
      var bookDate = formatDateStr(r.booking_date || '');
      var lastFollowupDate = formatDateStr(r.last_followup_date || '');
      var fn = (r.first_name || r.firstname || '').toString().trim();
      var ln = (r.last_name || r.lastname || '').toString().trim();
      var lineId = (r.line || '').toString().trim();
      var fbId = (r.facebook || '').toString().trim();
      var noteVal = (r.remark || r.note || '').toString().trim();
      var fullName = (fn && ln && fn !== ln) ? (fn + ' ' + ln) : (fn || ln);
      if (!fullName) {
        if (lineId) fullName = '[Line] ' + lineId;
        else if (fbId) fullName = '[FB] ' + fbId;
        else fullName = '(ไม่ระบุชื่อ)';
      }
      var ph = formatPhoneNumber(r.phone);
      var uniqueKey = (r.row_key !== undefined && r.row_key !== null && r.row_key !== '')
                      ? r.row_key.toString()
                      : (ph || (fn + '_' + ln));
      var followUpArr = parseFollowUpLog(r.follow_up_log);
      return {
        sheetRowIndex: uniqueKey,
        raw_key: uniqueKey,
        date: recDate,
        firstname: fn,
        lastname: ln,
        name: fullName,
        phone: ph,
        phone1: ph,
        appdate: bookDate,
        booking_date: bookDate,
        lastFollowupDate: lastFollowupDate,
        type: r.type || 'ลงทะเบียน',
        product: r.product || '',
        addressno: r.address_no || '',
        moo: r.moo || '',
        village: r.village || '',
        subdistrict: r.subdistrict || '',
        district: r.district || '',
        province: r.province || 'อุบลราชธานี',
        zipcode: r.zipcode || '',
        remark: noteVal,
        note: noteVal,
        line: lineId,
        facebook: fbId,
        followUpLog: followUpArr,
        followUpCount: followUpArr.length
      };
    });
    return { success: true, totalCount: totalCount, data: formattedData };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
// รวมเงื่อนไข WHERE ที่มาจาก buildWhereClause() (อาจว่างเปล่า หรือขึ้นต้นด้วย " WHERE ...")
// เข้ากับเงื่อนไขเพิ่มเติมอีกอันแบบปลอดภัย — ถ้า whereObj.sql มีอยู่แล้วให้ต่อด้วย AND,
// ถ้าไม่มีให้เปิด WHERE ใหม่ (เดิมโค้ดนี้เอาไปต่อกับ " WHERE ..." ตรงๆ ทำให้ได้ SQL
// ที่มี WHERE ซ้ำสองครั้งเวลามีการกรองอยู่แล้ว เช่น "...WHERE type=@t WHERE product IS NOT NULL..."
// ซึ่งจะ error ทันทีที่มีการกรองข้อมูลใดๆ ก่อนเปิดหน้ารายงาน)
function appendWhereCondition(baseWhereSql, extraCondition) {
  return baseWhereSql ? (baseWhereSql + " AND " + extraCondition) : (" WHERE " + extraCondition);
}

function getDashboardSummaryHTML(reqPayload) {
  try {
    var filters = (reqPayload && reqPayload.filters) ? reqPayload.filters : {};
    var whereObj = buildWhereClause(filters);
    var sql1 = "SELECT type, COUNT(*) as count FROM " + TABLE_FULL_PATH +
               appendWhereCondition(whereObj.sql,
                 "type IS NOT NULL AND TRIM(type) != '' " +
                 "AND type IN ('จอง', 'เป้าหมาย', 'ติดตาม', 'ลงทะเบียน', 'ส่งมอบ', 'ปิดการขาย', 'ลูกค้าเก่าดีเลอร์', 'ทำสัญญา', 'สนใจ')") +
               " GROUP BY type ORDER BY count DESC";
    var res1 = runParamQueryFetch(sql1, whereObj.params);
    var sql2 = "SELECT product, COUNT(*) as count FROM " + TABLE_FULL_PATH +
               appendWhereCondition(whereObj.sql,
                 "product IS NOT NULL AND TRIM(product) != '' AND product != '-' " +
                 "AND NOT REGEXP_CONTAINS(TRIM(product), r'^\\d+$')") +
               " GROUP BY product";
    var rawProd = runParamQueryFetch(sql2, whereObj.params);
    var prodGroup = {};
    (rawProd || []).forEach(function(item) {
      var name = (item.product || '').toString().trim();
      var cnt = parseInt(item.count) || 0;
      if (/^\d+$/.test(name)) return;
      var cleanName = name;
      if (/แทรกเตอร์|tractor/i.test(name)) {
        cleanName = 'รถแทรกเตอร์';
      } else if (/เกี่ยว|harvester/i.test(name)) {
        cleanName = 'รถเกี่ยวข้าว';
      } else if (/อัดฟาง|baler/i.test(name)) {
        cleanName = 'เครื่องอัดฟาง';
      } else if (/ขุด|excavator/i.test(name)) {
        cleanName = 'รถขุด';
      } else if (/โดรน|drone/i.test(name)) {
        cleanName = 'Drone';
      }
      if (!prodGroup[cleanName]) prodGroup[cleanName] = 0;
      prodGroup[cleanName] += cnt;
    });
    var topProducts = [];
    for (var pName in prodGroup) {
      topProducts.push({ product: pName, count: prodGroup[pName] });
    }
    topProducts.sort(function(a, b) { return b.count - a.count; });
    topProducts = topProducts.slice(0, 5);

    // ---- จำนวนลูกค้าที่มาจาก ManyChat/Facebook อัตโนมัติ ภายใต้ตัวกรองปัจจุบัน ----
    var sql3 = "SELECT COUNT(*) as cnt FROM " + TABLE_FULL_PATH + appendWhereCondition(whereObj.sql, FB_LEAD_MATCH_COND);
    var fbParams = whereObj.params.concat([FB_LEAD_MATCH_PARAM]);
    var res3 = runParamQueryFetch(sql3, fbParams);
    var manyChatLeadCount = (res3 && res3.length > 0) ? parseInt(res3[0].cnt) : 0;

    return { success: true, typeSummary: res1, topProducts: topProducts, manyChatLeadCount: manyChatLeadCount };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
function getCustomerByPhone(phoneKey) {
  try {
    var rawKey = cleanStr(phoneKey || '');
    if (!rawKey) return { success: false, message: 'ไม่พบรหัสอ้างอิงลูกค้า' };
    var sql = "SELECT * EXCEPT(created_date, booking_date, last_followup_date), " +
              "CAST(created_date AS STRING) AS created_date, " +
              "CAST(booking_date AS STRING) AS booking_date, " +
              "CAST(last_followup_date AS STRING) AS last_followup_date, " +
              FINGERPRINT_EXPR + " as row_key FROM " + TABLE_FULL_PATH +
              " WHERE " + ROW_MATCH_WHERE + " LIMIT 1";
    var params = [{ name: 'key', value: rawKey }];
    var rows = runParamQueryFetch(sql, params);
    if (!rows || rows.length === 0) return { success: false, message: 'ไม่พบข้อมูลลูกค้าในระบบ' };
    var r = rows[0];
    var ph = formatPhoneNumber(r.phone);
    var followUpArr = parseFollowUpLog(r.follow_up_log);
    return {
      success: true,
      data: {
        sheetRowIndex: r.row_key ? r.row_key.toString() : ph,
        date: formatDateStr(r.created_date || ''),
        firstname: r.first_name || '',
        lastname: r.last_name || '',
        phone: ph,
        phone1: ph,
        appdate: formatDateStr(r.booking_date || ''),
        lastFollowupDate: formatDateStr(r.last_followup_date || ''),
        type: r.type || 'ลงทะเบียน',
        product: r.product || '',
        addressno: r.address_no || '',
        moo: r.moo || '',
        village: r.village || '',
        subdistrict: r.subdistrict || '',
        district: r.district || '',
        province: r.province || 'อุบลราชธานี',
        zipcode: r.zipcode || '',
        remark: r.remark || '',
        line: r.line || '',
        facebook: r.facebook || '',
        followUpLog: followUpArr,
        followUpCount: followUpArr.length
      }
    };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
// เช็คว่าชื่อ Facebook นี้มีอยู่ในระบบแล้วหรือไม่ (เทียบแบบไม่สนตัวพิมพ์เล็ก/ใหญ่ และเว้นวรรคหน้า-หลัง)
// ใช้ป้องกันไม่ให้สร้างรายชื่อลูกค้าซ้ำ เวลาคนเดิมส่งเบอร์มาอีกรอบผ่าน Facebook/ManyChat
function findCustomerByFacebookName(fbName) {
  var cleanFb = cleanStr(fbName);
  if (!cleanFb) return null;
  var sql = "SELECT follow_up_log FROM " + TABLE_FULL_PATH +
            " WHERE LOWER(TRIM(IFNULL(facebook, ''))) = LOWER(TRIM(@fb)) LIMIT 1";
  var rows = runParamQueryFetch(sql, [{ name: 'fb', value: cleanFb }]);
  return (rows && rows.length > 0) ? rows[0] : null;
}

// เช็คว่าเบอร์นี้มีอยู่ในระบบแล้วหรือไม่ (รองรับทั้งแบบมี/ไม่มีเลข 0 นำหน้า เหมือน ROW_MATCH_WHERE)
// ใช้คู่กับ findCustomerByFacebookName เพื่อจับซ้ำได้ทั้งกรณี "ชื่อ Facebook เดิมแต่เบอร์เปลี่ยน"
// และกรณี "เบอร์เดิมแต่ชื่อ Facebook ไม่ตรงกัน (เช่น ใช้คนละบัญชี หรือรอบก่อนพิมพ์ชื่อผิด)"
function findCustomerByPhoneNumber(phone) {
  var cleanPhone = formatPhoneNumber(phone);
  if (!cleanPhone) return null;
  var sql = "SELECT follow_up_log, phone, facebook FROM " + TABLE_FULL_PATH +
            " WHERE CAST(phone AS STRING) = @phone " +
            " OR (SAFE_CAST(phone AS INT64) = SAFE_CAST(REGEXP_REPLACE(@phone, r'\\D', '') AS INT64) " +
            "     AND SAFE_CAST(phone AS INT64) IS NOT NULL AND SAFE_CAST(phone AS INT64) != 0) LIMIT 1";
  var rows = runParamQueryFetch(sql, [{ name: 'phone', value: cleanPhone }]);
  return (rows && rows.length > 0) ? rows[0] : null;
}

// บันทึกทุกครั้งที่มีการยิง action:add เข้ามา (ไม่ว่าจะสร้างลูกค้าใหม่ หรือไปชนกับของเดิม)
// ลง lead_intake_log เพื่อให้นับ "วันนี้ได้กี่เบอร์" ได้ครบ รวมที่ส่งซ้ำมาด้วย —
// ถ้า insert ตารางนี้ล้มเหลว (เช่น ยังไม่ได้รัน one-time setup สร้างตาราง) จะไม่ทำให้
// การเพิ่ม/อัปเดตลูกค้าหลักพัง แค่เขียน Logger ไว้เฉยๆ
function logLeadIntake_(info) {
  try {
    var sql = "INSERT INTO " + LOG_TABLE_FULL_PATH +
              " (received_at, received_date, phone, facebook, first_name, last_name, is_duplicate, match_type, is_manychat) " +
              "VALUES (CURRENT_TIMESTAMP(), CURRENT_DATE('Asia/Bangkok'), @phone, @fb, @fn, @ln, CAST(@dup AS BOOL), @mt, CAST(@mc AS BOOL))";
    runParamQuery(sql, [
      { name: 'phone', value: cleanStr(info.phone) },
      { name: 'fb', value: cleanStr(info.facebook) },
      { name: 'fn', value: cleanStr(info.firstName) },
      { name: 'ln', value: cleanStr(info.lastName) },
      { name: 'dup', value: info.isDuplicate ? 'true' : 'false' },
      { name: 'mt', value: cleanStr(info.matchType) },
      { name: 'mc', value: info.isManyChat ? 'true' : 'false' }
    ]);
  } catch (e) {
    Logger.log('logLeadIntake_ error (ข้อมูลลูกค้าหลักถูกบันทึกไปแล้วตามปกติ ไม่กระทบ): ' + e.toString());
  }
}

function addCustomerHTML(cust) {
  try {
    var fbNameForDup = cleanStr(cust.facebook);
    var newPhoneForDup = formatPhoneNumber(cust.phone1 || cust.phone);
    var isManyChatLead = (cleanStr(cust.remark || cust.note).toLowerCase().indexOf(FB_LEAD_MARKER) !== -1);

    // กันเบอร์ที่อยู่ใน EXCLUDED_PHONE_NUMBERS (เช่นเบอร์เซลล์เอง ที่ลูกค้ากดคัดลอกส่งกลับมา
    // โดยไม่ได้ตั้งใจ) ไม่ให้ถูกนับเป็นลูกค้าเลย — ไม่สร้าง/ไม่อัปเดตแถวใน customers และไม่ log
    // เข้า lead_intake_log เลย (ทำก่อนเช็ค/ทำอย่างอื่นทั้งหมด เพื่อไม่ให้ตัวเลขรายงานเพี้ยน)
    if (newPhoneForDup && EXCLUDED_PHONE_NUMBERS.indexOf(newPhoneForDup) !== -1) {
      return {
        success: true,
        skipped: true,
        message: 'เบอร์นี้อยู่ในรายการเบอร์ที่ไม่นับเป็นลูกค้า (เช่น เบอร์เซลล์) — ไม่ได้บันทึกเข้าระบบและไม่นับเข้ารายงาน'
      };
    }

    // กันข้อมูลซ้ำด้วยชื่อ Facebook หรือเบอร์โทร (อย่างใดอย่างหนึ่งตรงกันก็ถือว่าซ้ำ):
    // ถ้าคนเดิมส่งเบอร์มาอีกรอบผ่าน Facebook/ManyChat (ไม่ว่าจะชื่อ Facebook เดิมแต่เบอร์เปลี่ยน
    // เพราะรอบแรกพิมพ์ผิด, หรือเบอร์เดิมแต่ชื่อ Facebook ไม่ตรงกัน) ไม่สร้างรายชื่อใหม่
    // แต่บันทึกเป็น "การติดตาม" เพิ่มเข้ารายชื่อเดิม พร้อมตั้งวันนัดติดตามเป็นวันถัดไป
    // ให้เซลล์กรองวันที่มาดูว่าต้องโทรตามใครต่อ — ข้อมูลเบอร์/ชื่อที่ส่งมาใหม่ล่าสุดจะถูก
    // เก็บไว้ในบันทึกไทม์ไลน์ (follow_up_log) ของลูกค้ารายเดิมด้วย ไม่ทิ้งไปเฉยๆ
    var existingByFb = fbNameForDup ? findCustomerByFacebookName(fbNameForDup) : null;
    var existingByPhone = newPhoneForDup ? findCustomerByPhoneNumber(newPhoneForDup) : null;
    var existing = existingByFb || existingByPhone;

    if (existing) {
      var matchType = existingByFb && existingByPhone ? 'facebook+phone' : (existingByFb ? 'facebook' : 'phone');
      var matchLabel = matchType === 'facebook' ? 'ชื่อ Facebook เดิม' :
                        matchType === 'phone' ? 'เบอร์โทรเดิม' : 'ชื่อ Facebook และเบอร์โทรเดิม';

      var todayStrForDup = Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
      var followUpBaseForDup = new Date();
      followUpBaseForDup.setDate(followUpBaseForDup.getDate() + 1);
      var nextDayStrForDup = Utilities.formatDate(followUpBaseForDup, 'GMT+7', 'yyyy-MM-dd');

      var logArrForDup = parseFollowUpLog(existing.follow_up_log);
      var noteText = 'ลูกค้าส่งข้อมูลมาอีกรอบผ่าน Facebook/ManyChat (พบซ้ำจาก: ' + matchLabel + ')';
      if (newPhoneForDup) noteText += ' — เบอร์ที่ส่งมาล่าสุด: ' + newPhoneForDup;
      if (fbNameForDup) noteText += ' — Facebook: ' + fbNameForDup;

      logArrForDup.push({
        date: todayStrForDup,
        note: noteText,
        loggedAt: new Date().toISOString()
      });

      var updParamsForDup = [
        { name: 'log', value: JSON.stringify(logArrForDup) },
        { name: 'bd', value: nextDayStrForDup },
        { name: 'lfd', value: todayStrForDup }
      ];
      var setClausesForDup = ["follow_up_log = @log", "booking_date = @bd", "last_followup_date = @lfd"];
      if (newPhoneForDup) {
        setClausesForDup.push("phone = @ph");
        updParamsForDup.push({ name: 'ph', value: newPhoneForDup });
      }
      if (fbNameForDup) {
        setClausesForDup.push("facebook = @fb2");
        updParamsForDup.push({ name: 'fb2', value: fbNameForDup });
      }

      // WHERE ต้องชี้ไปที่แถวเดิมที่เจอจริง ๆ: ถ้าเจอจาก Facebook ให้ match ด้วย Facebook
      // (เผื่อกรณีเบอร์เปลี่ยนไปแล้ว การ match ด้วยเบอร์เก่าจะหาไม่เจอ), ถ้าเจอจากเบอร์อย่างเดียว
      // (ไม่มีชื่อ Facebook ตรงกัน) ให้ match ด้วยเบอร์
      var whereSqlForDup;
      if (existingByFb) {
        whereSqlForDup = "LOWER(TRIM(IFNULL(facebook, ''))) = LOWER(TRIM(@matchFb))";
        updParamsForDup.push({ name: 'matchFb', value: fbNameForDup });
      } else {
        whereSqlForDup = "(CAST(phone AS STRING) = @matchPhone " +
                         "OR (SAFE_CAST(phone AS INT64) = SAFE_CAST(REGEXP_REPLACE(@matchPhone, r'\\D', '') AS INT64) " +
                         "     AND SAFE_CAST(phone AS INT64) IS NOT NULL AND SAFE_CAST(phone AS INT64) != 0))";
        updParamsForDup.push({ name: 'matchPhone', value: newPhoneForDup });
      }

      var updSqlForDup = "UPDATE " + TABLE_FULL_PATH + " SET " + setClausesForDup.join(", ") + " WHERE " + whereSqlForDup;
      runParamQuery(updSqlForDup, updParamsForDup);

      logLeadIntake_({
        phone: newPhoneForDup,
        facebook: fbNameForDup,
        firstName: cust.firstname || cust.firstName,
        lastName: cust.lastname || cust.lastName,
        isDuplicate: true,
        matchType: matchType,
        isManyChat: isManyChatLead
      });

      return {
        success: true,
        duplicate: true,
        message: 'พบข้อมูลลูกค้ารายนี้ในระบบแล้ว (ซ้ำจาก: ' + matchLabel + ') — เพิ่มเป็นการติดตามใหม่ (นัดวันพรุ่งนี้) ไม่ได้สร้างรายชื่อซ้ำ'
      };
    }

    // created_at_ts: เวลาบันทึกจริงระดับวินาที (CURRENT_TIMESTAMP() ฝั่ง BigQuery ไม่ใช่
    // ค่าที่ส่งมาจากพารามิเตอร์) ใช้เป็นตัวเรียงรองใน searchCustomersHTML ตอนหลายแถว
    // อยู่วันเดียวกัน (ดูคอมเมนต์ที่ ORDER BY ของ searchCustomersHTML) — ต้องรัน
    // runOneTimeSetup_AddCreatedAtTimestampColumn() ก่อนครั้งเดียวถ้ายังไม่เคยรัน
    var sql = "INSERT INTO " + TABLE_FULL_PATH + " (" +
              "created_date, first_name, last_name, phone, booking_date, type, product, " +
              "address_no, moo, village, subdistrict, district, province, zipcode, remark, line, facebook, follow_up_log, created_at_ts) " +
              "VALUES (@d0, @d1, @d2, @d3, @d4, @d5, @d6, @d7, @d8, @d9, @d10, @d11, @d12, @d13, @d14, @d15, @d16, @d17, CURRENT_TIMESTAMP())";
    var inputDate = formatDateStr(cust.date || cust.created_date) || Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
    var inputBookingDate = formatDateStr(cust.appdate || cust.booking_date);

    // ถ้าไม่ได้ระบุวันนัด/วันติดตามมา (เช่น lead จาก ManyChat ที่ไม่มีข้อมูลนี้)
    // ให้ default เป็น "วันถัดไปจากวันที่บันทึก" อัตโนมัติ เพื่อเตือนให้พนักงานโทรตามลูกค้าต่อ
    if (!inputBookingDate) {
      var followUpBase = new Date(inputDate + 'T00:00:00+07:00');
      followUpBase.setDate(followUpBase.getDate() + 1);
      inputBookingDate = Utilities.formatDate(followUpBase, 'GMT+7', 'yyyy-MM-dd');
    }

    var params = [
      { name: 'd0', value: inputDate },
      { name: 'd1', value: cleanStr(cust.firstname || cust.firstName) },
      { name: 'd2', value: cleanStr(cust.lastname || cust.lastName) },
      { name: 'd3', value: cleanStr(cust.phone1 || cust.phone) },
      { name: 'd4', value: inputBookingDate },
      { name: 'd5', value: cleanStr(cust.type || 'ลงทะเบียน') },
      { name: 'd6', value: cleanStr(cust.product) },
      { name: 'd7', value: cleanStr(cust.addressno) },
      { name: 'd8', value: cleanStr(cust.moo) },
      { name: 'd9', value: cleanStr(cust.village) },
      { name: 'd10', value: cleanStr(cust.subdistrict) },
      { name: 'd11', value: cleanStr(cust.district) },
      { name: 'd12', value: cleanStr(cust.province || 'อุบลราชธานี') },
      { name: 'd13', value: cleanStr(cust.zipcode) },
      { name: 'd14', value: cleanStr(cust.remark || cust.note) },
      { name: 'd15', value: cleanStr(cust.line) },
      { name: 'd16', value: cleanStr(cust.facebook) },
      { name: 'd17', value: '[]' }
    ];
    runParamQuery(sql, params);

    logLeadIntake_({
      phone: newPhoneForDup,
      facebook: fbNameForDup,
      firstName: cust.firstname || cust.firstName,
      lastName: cust.lastname || cust.lastName,
      isDuplicate: false,
      matchType: 'new',
      isManyChat: isManyChatLead
    });

    return { success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
function updateCustomerHTML(rowIndex, cust) {
  try {
    var rawKey = cleanStr(rowIndex || '');
    if (!rawKey) return { success: false, message: 'ไม่พบอ้างอิงรายการที่จะแก้ไข' };
    var inputDate = formatDateStr(cust.date || cust.created_date);
    var inputBookingDate = formatDateStr(cust.appdate || cust.booking_date);
    var sql = "UPDATE " + TABLE_FULL_PATH + " SET " +
              "created_date = @d0, first_name = @d1, last_name = @d2, " +
              "phone = @d3, booking_date = @d4, type = @d5, " +
              "product = @d6, address_no = @d7, moo = @d8, " +
              "village = @d9, subdistrict = @d10, district = @d11, " +
              "province = @d12, zipcode = @d13, remark = @d14, " +
              "line = @d15, facebook = @d16 " +
              "WHERE " + ROW_MATCH_WHERE;
    var params = [
      { name: 'd0', value: inputDate },
      { name: 'd1', value: cleanStr(cust.firstname || cust.firstName) },
      { name: 'd2', value: cleanStr(cust.lastname || cust.lastName) },
      { name: 'd3', value: cleanStr(cust.phone1 || cust.phone) },
      { name: 'd4', value: inputBookingDate },
      { name: 'd5', value: cleanStr(cust.type || 'ลงทะเบียน') },
      { name: 'd6', value: cleanStr(cust.product) },
      { name: 'd7', value: cleanStr(cust.addressno) },
      { name: 'd8', value: cleanStr(cust.moo) },
      { name: 'd9', value: cleanStr(cust.village) },
      { name: 'd10', value: cleanStr(cust.subdistrict) },
      { name: 'd11', value: cleanStr(cust.district) },
      { name: 'd12', value: cleanStr(cust.province || 'อุบลราชธานี') },
      { name: 'd13', value: cleanStr(cust.zipcode) },
      { name: 'd14', value: cleanStr(cust.remark || cust.note) },
      { name: 'd15', value: cleanStr(cust.line) },
      { name: 'd16', value: cleanStr(cust.facebook) },
      { name: 'key', value: rawKey }
    ];
    runParamQuery(sql, params);
    return { success: true, message: 'อัปเดตข้อมูลสำเร็จ' };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
function deleteCustomerHTML(phoneKey) {
  try {
    var rawKey = cleanStr(phoneKey);
    if (!rawKey) return { success: false, message: 'ไม่พบรายการที่จะลบ' };
    var sql = "DELETE FROM " + TABLE_FULL_PATH +
              " WHERE " + ROW_MATCH_WHERE;
    runParamQuery(sql, [{ name: 'key', value: rawKey }]);
    return { success: true, message: 'ลบข้อมูลสำเร็จ' };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
function checkDuplicatePhoneHTML(phone) {
  try {
    var cleanPhone = cleanStr(phone);
    if (!cleanPhone) return { success: true, isDuplicate: false };
    var sql = "SELECT CONCAT(IFNULL(first_name,''), ' ', IFNULL(last_name,'')) as fullname " +
              "FROM " + TABLE_FULL_PATH +
              " WHERE CAST(phone AS STRING) = @phone OR SAFE_CAST(phone AS INT64) = SAFE_CAST(REGEXP_REPLACE(@phone, r'\\D', '') AS INT64) LIMIT 1";
    var res = runParamQueryFetch(sql, [{ name: 'phone', value: cleanPhone }]);
    if (res && res.length > 0) {
      return { success: true, isDuplicate: true, customerName: res[0].fullname };
    }
    return { success: true, isDuplicate: false };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
function getAllCustomersExport() {
  try {
    var sql = "SELECT CAST(created_date AS STRING) AS created_date, " +
              "CAST(booking_date AS STRING) AS booking_date, " +
              "CAST(last_followup_date AS STRING) AS last_followup_date, " +
              "first_name, last_name, phone, type, product, address_no, moo, village, subdistrict, district, province, zipcode, line, facebook, remark " +
              "FROM " + TABLE_FULL_PATH + " ORDER BY " + buildRobustDateOrderExpr_('created_date') + " DESC, created_at_ts DESC LIMIT 50000";
    var rows = runParamQueryFetch(sql, []);
    return { success: true, data: rows };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// =================================================================
// รายงานจำนวนลีดที่ส่งเข้ามาต่อวัน (นับจาก lead_intake_log — รวมที่ส่งซ้ำด้วย)
// =================================================================
// payload รองรับ: { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', onlyManyChat: true/false }
// ไม่ส่ง startDate/endDate มา = เอาทั้งหมดที่มี Log อยู่
// ไม่ส่ง onlyManyChat หรือส่ง false = นับทุกช่องทาง, ส่ง true = นับเฉพาะลีดที่มาจาก
// Facebook/ManyChat (เช็คจาก remark ตอนที่บันทึกเข้ามา)
function getDailyLeadReportHTML(reqPayload) {
  try {
    var payload = reqPayload || {};
    var startDate = cleanStr(payload.startDate);
    var endDate = cleanStr(payload.endDate);
    var onlyManyChat = (payload.onlyManyChat === true || payload.onlyManyChat === 'true');

    var whereClauses = [];
    var params = [];
    if (startDate) {
      whereClauses.push("received_date >= SAFE_CAST(@sd AS DATE)");
      params.push({ name: 'sd', value: startDate });
    }
    if (endDate) {
      whereClauses.push("received_date <= SAFE_CAST(@ed AS DATE)");
      params.push({ name: 'ed', value: endDate });
    }
    if (onlyManyChat) {
      whereClauses.push("is_manychat = TRUE");
    }
    // กันเบอร์ใน EXCLUDED_PHONE_NUMBERS (เช่นเบอร์เซลล์เอง) ออกจากการนับ — เผื่อมีแถวเก่า
    // ที่บันทึกไปแล้วก่อนเพิ่มลิสต์นี้ (ของใหม่จะไม่ถูกบันทึกเข้ามาอยู่แล้วตาม addCustomerHTML)
    var excludedPhoneCond = buildExcludedPhoneCondition_();
    if (excludedPhoneCond) {
      whereClauses.push(excludedPhoneCond);
      params = params.concat(buildExcludedPhoneParams_());
    }
    var whereSql = whereClauses.length > 0 ? (" WHERE " + whereClauses.join(" AND ")) : "";

    var sql = "SELECT CAST(received_date AS STRING) AS day, " +
              "COUNT(*) as total, " +
              "SUM(CASE WHEN is_duplicate = FALSE THEN 1 ELSE 0 END) as new_count, " +
              "SUM(CASE WHEN is_duplicate = TRUE THEN 1 ELSE 0 END) as duplicate_count, " +
              "SUM(CASE WHEN is_manychat = TRUE THEN 1 ELSE 0 END) as manychat_count " +
              "FROM " + LOG_TABLE_FULL_PATH + whereSql +
              " GROUP BY day ORDER BY day DESC";
    var rows = runParamQueryFetch(sql, params);
    var report = (rows || []).map(function(r) {
      return {
        day: r.day,
        total: parseInt(r.total) || 0,
        newCount: parseInt(r.new_count) || 0,
        duplicateCount: parseInt(r.duplicate_count) || 0,
        manychatCount: parseInt(r.manychat_count) || 0
      };
    });
    return { success: true, report: report };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// =================================================================
// รายละเอียด (รายชื่อ/เบอร์/สถานะ) ที่ประกอบเป็นตัวเลขในตารางรายงานรายวัน
// =================================================================
// ใช้ตอนพนักงานกดตัวเลข (ยอดรวม/ลูกค้าใหม่/ส่งซ้ำ/จาก ManyChat) ในหน้ารายงาน
// (index.html) เพื่อดูว่าตัวเลขนั้นประกอบด้วยรายการอะไรบ้าง — คิวรีจาก
// lead_intake_log ตัวเดียวกับที่ getDailyLeadReportHTML ใช้นับตัวเลข
//
// payload รองรับ:
//   - date: 'YYYY-MM-DD'                 → ระบุวันเดียว (กดจากแถวรายวัน)
//   - startDate / endDate: 'YYYY-MM-DD'  → ระบุช่วงวัน (กดจากแถว "รวมทั้งหมด")
//     (ถ้าส่ง date มา จะใช้ date เป็นหลัก ไม่สนใจ startDate/endDate)
//   - filter: 'total' | 'new' | 'duplicate' | 'manychat' (ไม่ส่งมา = 'total')
//   - onlyManyChat: true/false → เหมือนใน getDailyLeadReport ถ้าเปิดไว้ตอนกด
//     จะกรอง is_manychat = TRUE ซ้อนอีกชั้น (เว้นแต่ filter เป็น 'manychat' อยู่แล้ว)
// จำกัดผลลัพธ์ไว้ที่ 500 แถวล่าสุด (เรียงใหม่สุดก่อน) กันโหลดหนักเกินไปถ้าช่วงวันที่กว้าง
function getLeadIntakeLogDetailHTML(reqPayload) {
  try {
    var payload = reqPayload || {};
    var filter = cleanStr(payload.filter) || 'total';
    var onlyManyChat = (payload.onlyManyChat === true || payload.onlyManyChat === 'true');

    var singleDate = cleanStr(payload.date);
    var startDate = cleanStr(payload.startDate);
    var endDate = cleanStr(payload.endDate);

    var whereClauses = [];
    var params = [];

    if (singleDate) {
      whereClauses.push("received_date = SAFE_CAST(@d AS DATE)");
      params.push({ name: 'd', value: singleDate });
    } else {
      if (startDate) {
        whereClauses.push("received_date >= SAFE_CAST(@sd AS DATE)");
        params.push({ name: 'sd', value: startDate });
      }
      if (endDate) {
        whereClauses.push("received_date <= SAFE_CAST(@ed AS DATE)");
        params.push({ name: 'ed', value: endDate });
      }
    }

    if (filter === 'new') {
      whereClauses.push("is_duplicate = FALSE");
    } else if (filter === 'duplicate') {
      whereClauses.push("is_duplicate = TRUE");
    } else if (filter === 'manychat') {
      whereClauses.push("is_manychat = TRUE");
    }
    // กรองซ้ำอีกชั้นถ้าเปิดเช็คบ็อก "เฉพาะ ManyChat" ไว้ตอนกด (เหมือน getDailyLeadReportHTML)
    // เว้นแต่ filter ที่กดมาเป็น 'manychat' อยู่แล้ว (กันเขียนเงื่อนไขซ้ำสองรอบเฉยๆ)
    if (onlyManyChat && filter !== 'manychat') {
      whereClauses.push("is_manychat = TRUE");
    }
    // กันเบอร์ใน EXCLUDED_PHONE_NUMBERS ออกจากรายการ drill-down ด้วย (สอดคล้องกับตัวเลขที่
    // ถูกกรองออกไปแล้วใน getDailyLeadReportHTML — ไม่ให้เห็นแถวที่ไม่ได้ถูกนับในรายการละเอียด)
    var excludedPhoneCondDetail = buildExcludedPhoneCondition_();
    if (excludedPhoneCondDetail) {
      whereClauses.push(excludedPhoneCondDetail);
      params = params.concat(buildExcludedPhoneParams_());
    }

    var whereSql = whereClauses.length > 0 ? (" WHERE " + whereClauses.join(" AND ")) : "";

    var sql = "SELECT FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', received_at, 'Asia/Bangkok') AS received_at_str, " +
              "phone, facebook, first_name, last_name, is_duplicate, match_type, is_manychat " +
              "FROM " + LOG_TABLE_FULL_PATH + whereSql +
              " ORDER BY received_at DESC LIMIT 500";
    var rows = runParamQueryFetch(sql, params);

    var result = (rows || []).map(function(r) {
      return {
        receivedAt: r.received_at_str || '',
        phone: formatPhoneNumber(r.phone),
        facebook: r.facebook || '',
        firstName: r.first_name || '',
        lastName: r.last_name || '',
        isDuplicate: (r.is_duplicate === 'true' || r.is_duplicate === true),
        matchType: r.match_type || '',
        isManychat: (r.is_manychat === 'true' || r.is_manychat === true)
      };
    });

    return { success: true, rows: result };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// =================================================================
// ไทม์ไลน์การติดตามลูกค้า (follow_up_log)
// =================================================================
// เก็บเป็น JSON array ของ { date, note, loggedAt } ในคอลัมน์ follow_up_log
// (STRING) ของตาราง customers เดิม — ไม่ได้แยกเป็นตารางใหม่ เพื่อให้ยังใช้
// คีย์อ้างอิงลูกค้าเดิม (ROW_MATCH_WHERE / FINGERPRINT_EXPR) ได้โดยไม่ต้อง JOIN
//
// ⚠️ ต้องรันคำสั่งนี้ใน BigQuery Console ก่อนใช้งาน (ครั้งเดียว) มิฉะนั้นจะ
// error เพราะคอลัมน์ยังไม่มีในตาราง:
//
//   ALTER TABLE `crm-tracker-503906.crm_tracker.customers`
//   ADD COLUMN IF NOT EXISTS follow_up_log STRING;
//
// หลังเพิ่มคอลัมน์แล้ว ค่อยเอาไฟล์นี้ไปแทนของเดิมใน Apps Script editor แล้ว
// Deploy > Manage deployments > แก้ไข deployment เดิมให้ใช้เวอร์ชันใหม่

function parseFollowUpLog(raw) {
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function addFollowUpLogHTML(rawKeyInput, entry) {
  try {
    var rawKey = cleanStr(rawKeyInput || '');
    if (!rawKey) return { success: false, message: 'ไม่พบรหัสอ้างอิงลูกค้า' };

    var noteVal = cleanStr(entry && entry.note);
    var dateVal = cleanStr(entry && entry.date);
    if (!noteVal || !dateVal) return { success: false, message: 'กรุณาระบุวันที่และหมายเหตุการติดตามให้ครบ' };

    // วันติดตามครั้งต่อไป (booking_date): หน้าเว็บควรโชว์ช่องนี้ให้พนักงานเลือกเอง
    // โดย default เป็นวันพรุ่งนี้ไว้ก่อน (ส่งมาที่ entry.nextFollowUpDate) — ถ้าไม่ส่งมา
    // (เช่นเรียก API ตรงๆ โดยไม่ผ่านฟอร์มที่มีช่องนี้) ให้ default เป็นวันพรุ่งนี้ฝั่ง
    // เซิร์ฟเวอร์เองเหมือนกัน กันพลาด
    var nextFollowUpDateInput = formatDateStr(entry && (entry.nextFollowUpDate || entry.nextDate || entry.bookingDate));
    var nextFollowUpDate = nextFollowUpDateInput;
    if (!nextFollowUpDate) {
      var defaultNextBase = new Date();
      defaultNextBase.setDate(defaultNextBase.getDate() + 1);
      nextFollowUpDate = Utilities.formatDate(defaultNextBase, 'GMT+7', 'yyyy-MM-dd');
    }

    // 1) ดึง follow_up_log ปัจจุบันของลูกค้ารายนี้มาก่อน
    var selSql = "SELECT follow_up_log FROM " + TABLE_FULL_PATH +
                 " WHERE " + ROW_MATCH_WHERE + " LIMIT 1";
    var selRows = runParamQueryFetch(selSql, [{ name: 'key', value: rawKey }]);
    if (!selRows || selRows.length === 0) {
      return { success: false, message: 'ไม่พบข้อมูลลูกค้าในระบบ (ถ้าเพิ่งบันทึกลูกค้าใหม่ ข้อมูลอาจยังอยู่ใน streaming buffer ลองรออีกสักครู่)' };
    }

    var logArr = parseFollowUpLog(selRows[0].follow_up_log);
    logArr.push({
      date: dateVal,
      note: noteVal,
      loggedAt: new Date().toISOString()
    });

    // 2) เขียนกลับทั้ง array ที่อัปเดตแล้ว พร้อมอัปเดต last_followup_date (วันที่ของ
    // การติดตามรอบนี้) และ booking_date (วันนัดครั้งต่อไป) — created_date (วันที่บันทึก
    // ลูกค้าครั้งแรก) ไม่ถูกแก้ไขตรงนี้เลย ตั้งใจให้คงเดิมเสมอ
    var updSql = "UPDATE " + TABLE_FULL_PATH + " SET follow_up_log = @log, " +
                 "last_followup_date = @lfd, booking_date = @bd " +
                 "WHERE " + ROW_MATCH_WHERE;
    runParamQuery(updSql, [
      { name: 'log', value: JSON.stringify(logArr) },
      { name: 'lfd', value: dateVal },
      { name: 'bd', value: nextFollowUpDate },
      { name: 'key', value: rawKey }
    ]);

    return {
      success: true,
      message: 'บันทึกการติดตามลูกค้าสำเร็จ',
      followUpLog: logArr,
      followUpCount: logArr.length,
      nextFollowUpDate: nextFollowUpDate
    };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// =================================================================
// ⚙️ Setup ครั้งเดียว: เพิ่มคอลัมน์ follow_up_log ให้ตาราง customers
// =================================================================
// วิธีรัน: เปิดไฟล์นี้ใน Apps Script Editor > เลือกฟังก์ชัน
// "runOneTimeSetup_AddFollowUpLogColumn" จาก dropdown ข้างปุ่ม ▶ Run (เรียกใช้)
// ที่แถบด้านบน (อย่าเผลอเลือกฟังก์ชันอื่น) > กด ▶ Run > เช็คแท็บ "Executions"
// (บันทึกการดำเนินการ) ว่าขึ้นข้อความ "สำเร็จ" จริงก่อนไปทดสอบ ManyChat ต่อ
// รันครั้งเดียวพอ ไม่ต้องรันซ้ำอีกถ้าสำเร็จแล้ว (ใช้ ADD COLUMN IF NOT EXISTS
// ป้องกัน error ถ้าเผลอรันซ้ำ)
function runOneTimeSetup_AddFollowUpLogColumn() {
  try {
    var sql = "ALTER TABLE " + TABLE_FULL_PATH + " ADD COLUMN IF NOT EXISTS follow_up_log STRING";
    runParamQuery(sql, []);
    Logger.log('สำเร็จ: เพิ่มคอลัมน์ follow_up_log ให้ตาราง customers แล้ว (หรือมีอยู่แล้วก่อนหน้านี้)');
  } catch (err) {
    Logger.log('เกิดข้อผิดพลาด: ' + err.toString());
  }
}

// =================================================================
// ⚙️ Setup ครั้งเดียว (ใหม่): สร้างตาราง lead_intake_log สำหรับรายงานจำนวนลีดต่อวัน
// =================================================================
// วิธีรัน: เหมือนขั้นตอนด้านบน — เลือกฟังก์ชัน
// "runOneTimeSetup_CreateLeadIntakeLogTable" จาก dropdown ข้างปุ่ม ▶ Run แล้วกดรัน
// เช็คแท็บ "Executions" ว่าขึ้น "สำเร็จ" ก่อนใช้งานจริง (ก่อนหน้านั้น action:add
// จะยังทำงานตามปกติ แค่ log เข้า lead_intake_log จะ error เงียบ ๆ ใน Logger เฉยๆ
// ไม่กระทบการบันทึกลูกค้าหลัก — แต่รายงานรายวันจะยังไม่มีข้อมูลจนกว่าจะรันขั้นนี้)
// รันครั้งเดียวพอ ไม่ต้องรันซ้ำอีกถ้าสำเร็จแล้ว (ใช้ CREATE TABLE IF NOT EXISTS
// ป้องกัน error ถ้าเผลอรันซ้ำ)
function runOneTimeSetup_CreateLeadIntakeLogTable() {
  try {
    var sql = "CREATE TABLE IF NOT EXISTS " + LOG_TABLE_FULL_PATH + " (" +
      "received_at TIMESTAMP, " +
      "received_date DATE, " +
      "phone STRING, " +
      "facebook STRING, " +
      "first_name STRING, " +
      "last_name STRING, " +
      "is_duplicate BOOL, " +
      "match_type STRING, " +
      "is_manychat BOOL" +
      ") PARTITION BY received_date";
    runParamQuery(sql, []);
    Logger.log('สำเร็จ: สร้างตาราง ' + LOG_TABLE_ID + ' แล้ว (หรือมีอยู่แล้วก่อนหน้านี้)');
  } catch (err) {
    Logger.log('เกิดข้อผิดพลาด: ' + err.toString());
  }
}

// =================================================================
// ⚙️ Setup ครั้งเดียว (ใหม่): เพิ่มคอลัมน์ last_followup_date ให้ตาราง customers
// =================================================================
// วิธีรัน: เหมือนขั้นตอนด้านบน — เลือกฟังก์ชัน
// "runOneTimeSetup_AddLastFollowupDateColumn" จาก dropdown ข้างปุ่ม ▶ Run แล้วกดรัน
// เช็คแท็บ "Executions" ว่าขึ้น "สำเร็จ" ก่อนใช้งานจริง (ก่อนรันขั้นนี้ การเพิ่มบันทึก
// ติดตามยังทำงานได้ปกติ แค่ UPDATE ...SET last_followup_date... จะ error เพราะ
// คอลัมน์ยังไม่มี — ทำให้ทั้งการบันทึกติดตามครั้งนั้นล้มเหลวไปด้วย ต้องรันขั้นนี้ก่อน
// ถึงจะใช้ฟีเจอร์ "ติดตามล่าสุด" ได้)
// รันครั้งเดียวพอ ไม่ต้องรันซ้ำอีกถ้าสำเร็จแล้ว (ใช้ ADD COLUMN IF NOT EXISTS
// ป้องกัน error ถ้าเผลอรันซ้ำ)
function runOneTimeSetup_AddLastFollowupDateColumn() {
  try {
    var sql = "ALTER TABLE " + TABLE_FULL_PATH + " ADD COLUMN IF NOT EXISTS last_followup_date DATE";
    runParamQuery(sql, []);
    Logger.log('สำเร็จ: เพิ่มคอลัมน์ last_followup_date ให้ตาราง customers แล้ว (หรือมีอยู่แล้วก่อนหน้านี้)');
  } catch (err) {
    Logger.log('เกิดข้อผิดพลาด: ' + err.toString());
  }
}

// =================================================================
// ⚙️ Setup ครั้งเดียว: เพิ่มคอลัมน์ created_at_ts ให้ตาราง customers
// =================================================================
// เหตุผล: created_date เก็บแค่ระดับ "วัน" (ไม่มีเวลา) พอมีลูกค้าหลายรายกรอกเข้ามาใน
// วันเดียวกัน ระบบเรียง "ใหม่สุดก่อน" จะเรียงได้แค่ระดับวัน ส่วนลำดับ "ภายในวันเดียวกัน"
// ไม่แน่นอน (BigQuery ไม่การันตีลำดับของแถวที่ค่าที่ใช้เรียงเท่ากันเป๊ะ) ทำให้ลูกค้าที่
// เพิ่งกรอกล่าสุดของวันนั้นอาจไม่ขึ้นบนสุดของกลุ่มวันเดียวกัน — คอลัมน์นี้เก็บเวลาบันทึก
// จริงระดับวินาที (ตั้งอัตโนมัติตอน INSERT ใหม่ทุกครั้ง ดู addCustomerHTML) ใช้เป็น
// ตัวเรียงรองถัดจาก created_date ใน searchCustomersHTML/getAllCustomersExport
//
// วิธีรัน: เลือกฟังก์ชัน "runOneTimeSetup_AddCreatedAtTimestampColumn" จาก dropdown
// ข้างปุ่ม ▶ Run (เรียกใช้) ที่แถบด้านบน (อย่าเผลอเลือกฟังก์ชันอื่น) > กด ▶ Run
// > เช็คแท็บ Execution log ว่าขึ้นข้อความ "สำเร็จ" จริงก่อนใช้งานต่อ รันครั้งเดียวพอ
// (ใช้ ADD COLUMN IF NOT EXISTS ป้องกัน error ถ้าเผลอรันซ้ำ)
//
// หมายเหตุ: แถวเก่าที่มีอยู่ก่อนรันฟังก์ชันนี้จะมีค่า created_at_ts เป็น NULL ทั้งหมด
// (ไม่มีทางย้อนไปรู้เวลาบันทึกจริงของแถวเก่าได้) BigQuery จัดให้ NULL อยู่ท้ายสุดเสมอ
// เวลาเรียง DESC จึงไม่กระทบลำดับของแถวเก่า (ยังคงเรียงแบบเดิมภายในกลุ่มวันเดียวกัน)
// มีผลเฉพาะแถวใหม่ที่กรอกหลังจากรันฟังก์ชันนี้แล้วเท่านั้น
function runOneTimeSetup_AddCreatedAtTimestampColumn() {
  try {
    var sql = "ALTER TABLE " + TABLE_FULL_PATH + " ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMP";
    runParamQuery(sql, []);
    Logger.log('สำเร็จ: เพิ่มคอลัมน์ created_at_ts ให้ตาราง customers แล้ว (หรือมีอยู่แล้วก่อนหน้านี้)');
  } catch (err) {
    Logger.log('เกิดข้อผิดพลาด: ' + err.toString());
  }
}

function testDailyLeadReportDirect() {
  var result = getDailyLeadReportHTML({
    startDate: '2026-08-08',
    endDate: '2026-08-08',
    onlyManyChat: false
  });

  Logger.log(JSON.stringify(result));
}
