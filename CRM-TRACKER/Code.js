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
// หมายเหตุ (2026-09-14 รอบถัดมา): ต่อยอดจาก r20-2026-09-14-permission-matrix
// เพิ่ม action ใหม่ getStaleLeadsReport (รายงานลูกค้าค้างนานไม่ได้ติดตาม หน้า "รายงาน")
//
// หมายเหตุ (2026-09-15 รอบถัดมา): เพิ่ม action ใหม่ 'screenshotAttempt' — รองรับมาตรการ
// "ยับยั้ง/ตามรอย" การแคปหน้าจอ-คัดลอกข้อมูลลูกค้าฝั่ง frontend (ดู activateLeakDeterrentMeasures_
// ใน index.html) ไม่ใช่การ "ป้องกัน" การแคปหน้าจอจริง (เว็บทำไม่ได้ 100% — ดูคอมเมนต์ที่
// action==='screenshotAttempt' ด้านล่าง) แค่บันทึกว่าใครกด Print Screen/พยายามคัดลอกเมื่อไหร่
// ลงตาราง user_activity_log เพื่อให้ตรวจสอบย้อนหลังได้ — เพิ่มเข้า ACTIVITY_LOG_WHITELIST แล้ว
//
// หมายเหตุ (2026-09-18 รอบถัดมา — แก้บั๊กร้ายแรง "user หายหมดเหลือแต่ admin"):
// พบว่า addUserHTML ซิงก์ตาราง users เข้า BigQuery แบบ WRITE_TRUNCATE ทุกครั้งที่เพิ่ม
// สมาชิก โดยอ่านข้อมูลจาก Sheet แท็บ "users" ที่ไม่เคย backfill user เดิมจาก BigQuery
// เข้ามาก่อน (ต่างจากตาราง customers ที่ export มาแล้วตอน migration) ทำให้ TRUNCATE
// ทับข้อมูลเดิมหายไปหมด — แก้ 2 จุด: (1) เพิ่ม assertSafeRowCountForTruncateSync_
// เช็คก่อน sync ทุกครั้งว่าจำนวนแถวใหม่ลดลงจากของเดิมผิดปกติหรือไม่ ถ้าใช่ throw error
// ไม่ยอม sync ทับให้ (ใช้ป้องกันทั้งตาราง users และ customers) (2) เพิ่มฟังก์ชัน
// runOneTimeSetup_BackfillUsersFromBigQuery_ ให้ดึง user ที่ยังเหลืออยู่ใน BigQuery
// กลับเข้า Sheet ให้ครบ — ต้องรันฟังก์ชันนี้ครั้งเดียวก่อนใช้งานเมนู "เพิ่มสมาชิก" ต่อ
//
// หมายเหตุ (2026-09-17 รอบถัดมา): โปรเจกต์ BigQuery ไม่ได้ผูก Billing Account จึงรัน
// DML (INSERT/UPDATE/DELETE) ไม่ได้เลย (Free Tier บล็อกเสมอ ไม่เกี่ยวกับปริมาณข้อมูล) —
// ย้ายจุด "เขียน" ข้อมูลลูกค้าทั้งหมด (เพิ่ม/แก้ไข/ลบ/บันทึกการติดตาม) จากเดิมที่ยิง SQL
// เข้า BigQuery ตรงๆ มาเป็นเขียนลง Google Sheet แทน (ดูคอมเมนต์ที่ CUSTOMER_SHEET_ID
// ด้านล่าง) ส่วนการอ่าน/ค้นหา/รายงาน/แดชบอร์ดทั้งหมดยังคงผ่าน BigQuery เหมือนเดิมทุกจุด
// (ต้องผูก Sheet นี้เป็น BigQuery External Table ชื่อ customers ไว้ด้วย — ดูคู่มือ setup)
// ⚠️ ต้องตั้งค่า CUSTOMER_SHEET_ID ให้เป็น Sheet ID จริงก่อนใช้งาน ไม่งั้นการเพิ่ม/แก้ไข/
// ลบข้อมูลลูกค้าจะ error ทันที (ดูข้อความ error ที่ getCustomerSheet_ ด้านล่าง)
// หมายเหตุ (2026-09-20 รอบถัดมา — เปิดให้ Salepromofinder ใช้ users ชุดเดียวกัน):
// เพิ่มคอลัมน์ 'name' (ชื่อ-นามสกุลจริง) และ 'branch' (สาขา) ให้ตาราง users เพื่อให้แอป
// Salepromofinder (อีกแอปของบริษัท) login ผ่าน backend ตัวนี้แล้วแสดงชื่อ-สาขาได้ถูกต้อง
// แทนที่จะเห็นแค่ username เฉยๆ — ออกแบบให้ "ไม่ทำให้ login เดิมพัง" แม้จะยัง[ไม่]ได้เพิ่ม
// คอลัมน์ name/branch ในตาราง BigQuery จริงก่อน deploy ก็ตาม (ดู getBigQueryUserExtraFields_
// ด้านล่าง — ดึง name/branch แยกเป็นคนละ query ต่างหากจาก query login หลัก ถ้า query นี้พลาด/
// คอลัมน์ยังไม่มี จะได้แค่ name/branch ว่างเปล่า ไม่กระทบผลการ login เลย)
// ⚠️ แนะนำให้เพิ่มคอลัมน์ name, branch (STRING, NULLABLE) ในตาราง BigQuery `users` ก่อน
// deploy โค้ดรุ่นนี้ (กด Edit schema ในหน้า BigQuery Console) และเพิ่มหัวคอลัมน์ name, branch
// ในแถวที่ 1 ของแท็บ Sheet "users" ด้วย — แต่ถ้าลืม ระบบจะไม่พัง แค่ยังไม่เห็น name/branch
// จนกว่าจะเพิ่มคอลัมน์แล้วมีคนกด "เพิ่มสมาชิก" อีกครั้ง (ทำให้ sync ทับ schema ใหม่อัตโนมัติ)
// หมายเหตุ (2026-09-25 — r35): เพิ่ม action ใหม่ 'getStaffDashboardStats' สำหรับกราฟ Dashboard
// ในหน้า "📈 รายงาน" (Top Staff Activity + สัดส่วนวิธีติดตามลูกค้า) — สรุปผลด้วย COUNT/GROUP BY
// ใน BigQuery แล้วส่งกลับเฉพาะตัวเลข ดู getStaffDashboardStatsHTML — ไม่แก้ฟังก์ชันเดิมใดๆ
// หมายเหตุ (2026-09-25 — r36): จำกัด getStaffDashboardStats ให้ "เฉพาะ admin" เท่านั้น (เดิม r35 ให้
// role อื่นเห็นตัวเลขของตัวเองได้) — เช็คทั้งที่ doPost และในฟังก์ชันเอง (defense in depth)
// หมายเหตุ (2026-09-25 — r37): เอากราฟ "สัดส่วนประเภทการติดตาม" (UNNEST follow_up_log จาก customers —
// error ในระบบจริง) ออก แทนด้วย "แนวโน้มกิจกรรมของทีม" ที่อ่านจาก user_activity_log ตารางเดียวกับกราฟแรก
var CODE_VERSION = 'r37-2026-09-25-staff-dashboard-trend';
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
// 📝 แก้ไข (2026-09-17): ย้ายจุด "เขียน" ข้อมูลลูกค้า (เพิ่ม/แก้ไข/ลบ) จากเดิมที่ยิง
// SQL INSERT/UPDATE/DELETE เข้า BigQuery ตรงๆ (ซึ่งใช้ไม่ได้ถ้าโปรเจกต์ไม่ผูก Billing
// Account — BigQuery บล็อกคำสั่ง DML ในโหมด Free Tier เสมอ ไม่ว่าข้อมูลจะน้อยแค่ไหน)
// มาเป็นการเขียนตรงลง Google Sheet นี้แทน โดยยังคง "อ่าน" ข้อมูล (ค้นหา/รายงาน/สรุปยอด)
// ผ่าน BigQuery เหมือนเดิมทุกจุด — เพราะ SELECT ไม่ติดข้อจำกัด DML เลย
//
// ⚠️ ต้องตั้งค่า 2 บรรทัดด้านล่างนี้ก่อนใช้งาน:
//   1) CUSTOMER_SHEET_ID: เปิด Google Sheet ที่จะใช้เก็บข้อมูลลูกค้า แล้วคัดลอก ID จาก URL
//      (ส่วนที่อยู่ระหว่าง /d/ กับ /edit เช่น https://docs.google.com/spreadsheets/d/
//      **ID_ตรงนี้**/edit)
//   2) CUSTOMER_SHEET_NAME: ชื่อแท็บ (sheet tab) ที่เก็บข้อมูล ต้องมีแถวหัวตาราง (row 1)
//      เป็นชื่อคอลัมน์ตรงตาม CUSTOMER_SHEET_COLUMNS ด้านล่างนี้ทุกตัวอักษร (ลำดับคอลัมน์
//      ในชีตจะเรียงยังไงก็ได้ ไม่ต้องตรงลำดับ — โค้ดจะหาตำแหน่งคอลัมน์จากชื่อหัวตารางเอง)
//   3) ต้องผูก Sheet นี้เข้ากับ BigQuery เป็น External Table (ชนิด Google Drive/Sheets
//      source) ชื่อตารางเดียวกับ TABLE_ID ด้านบน (customers) เพื่อให้ทุกจุดที่ยัง query
//      อ่านข้อมูล (ค้นหา/แดชบอร์ด/รายงาน) เห็นข้อมูลที่เพิ่ง เพิ่ม/แก้ไข/ลบ ผ่านหน้าเว็บทันที
var CUSTOMER_SHEET_ID = '1qsuBtj-7j3p4-jwgeU-rDpjbJ1gPVXM45EtK-ywLk9U'; // Sheet ข้อมูลลูกค้าจริงที่ export จาก BigQuery มา (2026-09-17)
var CUSTOMER_SHEET_NAME = 'Sheet1'; // ถ้าหาแท็บนี้ไม่เจอ จะใช้แท็บแรกสุดในไฟล์แทนอัตโนมัติ (ดู getCustomerSheet_)

// รายชื่อคอลัมน์ทั้งหมดที่ต้องมีอยู่ในแถวหัวตาราง (row 1) ของแท็บ CUSTOMER_SHEET_NAME
// เรียงตามที่ปรากฏใน INSERT SQL เดิม + คอลัมน์ที่เพิ่มทีหลังผ่าน one-time setup ต่างๆ
var CUSTOMER_SHEET_COLUMNS = [
  'created_date', 'first_name', 'last_name', 'phone', 'booking_date', 'type', 'product',
  'address_no', 'moo', 'village', 'subdistrict', 'district', 'province', 'zipcode',
  'remark', 'line', 'facebook', 'follow_up_log', 'financial_info', 'created_at_ts',
  'last_followup_date',
  // (2026-09-19) เพิ่ม 2 คอลัมน์นี้เข้ามาให้เป็น "บังคับ" แล้ว (ผู้ใช้เพิ่มหัวคอลัมน์ทั้งคู่ในชีต
  // จริงแล้ว) — จำเป็นต้องอยู่ในลิสต์นี้ ไม่งั้น syncCustomerSheetToBigQuery_() ด้านล่างจะไม่ดึง
  // 2 คอลัมน์นี้ไปสร้าง schema/ข้อมูลใน BigQuery เลย (สร้าง schema จากลิสต์นี้ล้วนๆ ทุกครั้งที่
  // sync แบบ WRITE_TRUNCATE) ทำให้หน้าเว็บค้นหา/แสดงผลผ่าน BigQuery ไม่เห็นค่าเหล่านี้ แม้จะเขียน
  // ลง Sheet ไปแล้วจริงก็ตาม — ⚠️ ถ้าใครเผลอลบหัวคอลัมน์นี้ออกจากชีตในอนาคต ระบบทั้งระบบจะพัง
  // ทันที (getCustomerHeaderMap_ โยน error ถ้าขาดคอลัมน์ในลิสต์นี้แม้แต่ตัวเดียว)
  'created_by', 'updated_by'
];

// เปิด Sheet object ของแท็บข้อมูลลูกค้า — โยน error ชัดเจนถ้ายังไม่ได้ตั้งค่า/หาไม่เจอ
function getCustomerSheet_() {
  if (!CUSTOMER_SHEET_ID || CUSTOMER_SHEET_ID === 'PUT_YOUR_GOOGLE_SHEET_ID_HERE') {
    throw new Error('ยังไม่ได้ตั้งค่า CUSTOMER_SHEET_ID — เปิด Code.gs แล้วใส่ Sheet ID ของ Google Sheet ที่จะใช้เก็บข้อมูลลูกค้าก่อน');
  }
  var ss = SpreadsheetApp.openById(CUSTOMER_SHEET_ID);
  var sheet = ss.getSheetByName(CUSTOMER_SHEET_NAME);
  if (!sheet) {
    // หาแท็บชื่อ CUSTOMER_SHEET_NAME ไม่เจอ (เช่น ตั้งชื่อไว้ไม่ตรง) — ใช้แท็บแรกสุดในไฟล์แทน
    // เพื่อไม่ให้ระบบพังเพราะเรื่องชื่อแท็บเพียงอย่างเดียว (ไฟล์นี้มักมีแท็บข้อมูลหลักแท็บเดียวอยู่แล้ว)
    var allSheets = ss.getSheets();
    if (allSheets.length === 0) {
      throw new Error('Google Sheet ที่ระบุ (CUSTOMER_SHEET_ID) ไม่มีแท็บใดๆ เลย');
    }
    sheet = allSheets[0];
    Logger.log('ไม่พบแท็บชื่อ "' + CUSTOMER_SHEET_NAME + '" — ใช้แท็บแรกสุด ("' + sheet.getName() + '") แทนโดยอัตโนมัติ');
  }
  return sheet;
}

// อ่านแถวหัวตาราง (row 1) แล้วคืนค่าเป็น { ชื่อคอลัมน์: เลขคอลัมน์ (1-based) }
// ใช้แทนการอ้างอิงตำแหน่งคอลัมน์แบบตายตัว เผื่อมีคนสลับลำดับคอลัมน์ในชีตภายหลัง
function getCustomerHeaderMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), CUSTOMER_SHEET_COLUMNS.length);
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    var h = (headerRow[i] || '').toString().trim();
    if (h) map[h] = i + 1;
  }
  var missing = CUSTOMER_SHEET_COLUMNS.filter(function(c) { return !map[c]; });
  if (missing.length > 0) {
    throw new Error('แถวหัวตารางในชีต "' + CUSTOMER_SHEET_NAME + '" ขาดคอลัมน์: ' + missing.join(', ') +
                     ' — ต้องเพิ่มหัวคอลัมน์เหล่านี้ในแถวที่ 1 ให้ครบก่อนใช้งาน');
  }
  return map;
}

// คำนวณ fingerprint ให้ตรงกับ FINGERPRINT_EXPR ฝั่ง BigQuery ทุกประการ
// (TO_HEX(MD5(CONCAT(created_date, first_name, last_name, phone))) แบบ IFNULL เป็น '')
// เพื่อให้ "key" ที่หน้าเว็บส่งมา (คำนวณจาก BigQuery ตอน search) หาแถวใน Sheet เจอ
function computeCustomerFingerprint_(createdDateStr, firstName, lastName, phoneStr) {
  var s = (createdDateStr || '') + (firstName || '') + (lastName || '') + (phoneStr || '');
  var digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < digestBytes.length; i++) {
    var v = (digestBytes[i] < 0 ? digestBytes[i] + 256 : digestBytes[i]).toString(16);
    hex += (v.length === 1 ? '0' + v : v);
  }
  return hex;
}

// =================================================================
// ⚡ เพิ่ม (2026-09-17 รอบที่ 4): แก้ปัญหาความเร็ว — พบว่าชีตข้อมูลลูกค้าจริงมีมากกว่า
// 116,000 แถว การวนลูป (for) อ่านทุกแถวแล้วคำนวณ MD5 ทีละแถวแบบเดิม จะช้ามากจนดูเหมือน
// ระบบค้าง จึงเปลี่ยนมาใช้ Range.createTextFinder(...) ซึ่งเป็นการค้นหาแบบ native ของ
// Google Sheets (เร็วกว่าวนลูปด้วย JavaScript มาก ไม่ว่าชีตจะมีกี่แสนแถว) เป็นเส้นทางหลัก
// ส่วนการวนลูปคำนวณ fingerprint แบบเดิมยังเก็บไว้เป็น "ทางสำรองรอง" เผื่อกรณีที่หา
// ด้วยเบอร์โทรไม่เจอจริงๆ (เช่น key เป็น fingerprint แต่เบอร์ในชีตถูกแก้ไปแล้วไม่ตรงกับ
// ตอนที่หน้าเว็บโหลดข้อมูลมา) ซึ่งควรเกิดขึ้นน้อยมากในทางปฏิบัติ

// ค้นหาแถวด้วยเบอร์โทรแบบเร็ว (TextFinder) — ลองทั้งรูปแบบเบอร์ตรงๆ และแบบตัด/เติมเลข 0
// นำหน้า เพื่อรองรับกรณีบันทึกเบอร์ไว้ไม่ตรงรูปแบบเป๊ะ
function findCustomerRowNumberByPhoneFast_(sheet, headerMap, phone) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var col = headerMap['phone'];
  var range = sheet.getRange(2, col, lastRow - 1, 1);
  var cleanPhone = formatPhoneNumber(phone);
  if (!cleanPhone) return -1;

  var candidates = [cleanPhone];
  var digits = cleanPhone.replace(/\D/g, '');
  if (digits) {
    if (cleanPhone.charAt(0) === '0') candidates.push(digits.substring(1)); // ตัด 0 นำหน้า
    else candidates.push('0' + digits); // เติม 0 นำหน้า
  }

  for (var i = 0; i < candidates.length; i++) {
    var finder = range.createTextFinder(candidates[i]).matchEntireCell(true);
    var found = finder.findNext();
    if (found) return found.getRow();
  }
  return -1;
}

// หาเลขแถว (1-based, นับรวมหัวตาราง) ในชีตที่ตรงกับ key ที่ส่งมา
// phoneHint (ถ้ามี — ส่งมาจากหน้าเว็บ เป็นเบอร์โทรของแถวนั้น ณ ตอนเปิดดู/แก้ไข) คือทางลัด
// สำคัญที่ทำให้ค้นหาเร็ว ไม่ต้องวนลูปทั้งชีต — ถ้าไม่มี phoneHint หรือหาไม่เจอด้วย phoneHint
// ค่อย fallback ไปวิธีเดิม (วนลูปคำนวณ fingerprint ทุกแถว ซึ่งช้าถ้าข้อมูลมีเป็นแสนแถว)
function findCustomerRowNumberByKey_(sheet, headerMap, key, phoneHint) {
  // ทางลัดที่ 1: มี phoneHint ส่งมา — ค้นด้วย TextFinder ทันที (เร็วมาก ไม่ว่าจะกี่แสนแถว)
  if (phoneHint) {
    var rowByHint = findCustomerRowNumberByPhoneFast_(sheet, headerMap, phoneHint);
    if (rowByHint !== -1) return rowByHint;
  }
  // ทางลัดที่ 2: key เองมีลักษณะเป็นเบอร์โทร (ตัวเลขล้วน 8-10 หลัก) ไม่ใช่ fingerprint (hex 32 ตัว)
  // — ลองค้นด้วย TextFinder เลยเช่นกัน
  var keyDigits = (key || '').toString().replace(/\D/g, '');
  if (keyDigits && /^\d{8,10}$/.test(keyDigits) && !/^[0-9a-f]{32}$/i.test(String(key))) {
    var rowByKeyAsPhone = findCustomerRowNumberByPhoneFast_(sheet, headerMap, key);
    if (rowByKeyAsPhone !== -1) return rowByKeyAsPhone;
  }

  // ทางสำรอง (ช้า — วนลูปทุกแถวคำนวณ fingerprint): ใช้เฉพาะกรณีข้างบนหาไม่เจอจริงๆ เท่านั้น
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var cdCol = headerMap['created_date'] - 1;
  var fnCol = headerMap['first_name'] - 1;
  var lnCol = headerMap['last_name'] - 1;
  var phCol = headerMap['phone'] - 1;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var createdDateStr = formatDateStr(row[cdCol]);
    var phoneStr = formatPhoneNumber(row[phCol]);
    // ⚠️ (2026-09-19) แก้บั๊ก: เดิมคำนวณ fingerprint จาก phoneStr ที่ผ่าน formatPhoneNumber()
    // ซึ่งเติมเลข 0 นำหน้าให้เบอร์ 9 หลัก (เช่น 453112222 -> 0453112222) แต่ฝั่ง BigQuery
    // (FINGERPRINT_EXPR) คำนวณจาก CAST(phone AS STRING) ตรงๆ ไม่เติม 0 ให้ — ทำให้ fingerprint
    // สองฝั่งไม่ตรงกันแทบทุกแถวที่เบอร์เก็บเป็น 9 หลักไม่มี 0 นำหน้า (คือเกือบทุกแถวในชีตจริง)
    // ผลคือ "แก้ไข"/"บันทึกการติดตาม" ล้มเหลวแทบทุกครั้งด้วย error "ไม่พบข้อมูลลูกค้ารายนี้ในชีต"
    // แก้โดยใช้ค่าเบอร์ดิบ (แค่ trim ไม่เติม 0) ให้ตรงกับที่ BigQuery เห็นจริงๆ
    var rawPhoneForFp = (row[phCol] === null || row[phCol] === undefined) ? '' : row[phCol].toString().trim();
    var fp = computeCustomerFingerprint_(createdDateStr, row[fnCol], row[lnCol], rawPhoneForFp);
    if (fp === key) return i + 2;
    if (phoneStr && phoneStr === key) return i + 2;
    if (keyDigits && phoneStr) {
      var phoneDigits = phoneStr.replace(/\D/g, '');
      if (phoneDigits !== '' && phoneDigits !== '0' && phoneDigits === keyDigits) return i + 2;
    }
  }
  return -1;
}

// หาเลขแถวด้วยชื่อ Facebook แบบเร็ว (TextFinder) — ไม่สนตัวพิมพ์เล็ก/ใหญ่ — ใช้ตอนเช็คซ้ำ
function findCustomerRowNumberByFacebook_(sheet, headerMap, fbName) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var col = headerMap['facebook'];
  var range = sheet.getRange(2, col, lastRow - 1, 1);
  var finder = range.createTextFinder(fbName.toString().trim()).matchEntireCell(true).matchCase(false);
  var found = finder.findNext();
  return found ? found.getRow() : -1;
}

// หาเลขแถวด้วยเบอร์โทรแบบเร็ว (TextFinder, รองรับมี/ไม่มีเลข 0 นำหน้า) — ใช้ตอนเช็คซ้ำ
function findCustomerRowNumberByPhone_(sheet, headerMap, phone) {
  return findCustomerRowNumberByPhoneFast_(sheet, headerMap, phone);
}

// แปลง object { ชื่อคอลัมน์: ค่า } ให้เป็น array 1 แถว เรียงตามตำแหน่งจริงในชีต
// (ใช้กับ appendRow ตอนเพิ่มลูกค้าใหม่) — คอลัมน์ที่ไม่ได้ระบุค่ามาจะเว้นว่างไว้
// =================================================================
// 📝 เพิ่ม (2026-09-17 รอบถัดมา): ซิงก์ข้อมูลจาก Google Sheet เข้า BigQuery
// native table `customers` แบบเต็มตาราง (WRITE_TRUNCATE) ทุกครั้งหลังเขียน Sheet สำเร็จ
// โดยใช้ "Load Job" (BigQuery.Jobs.insert แบบ configuration.load) ไม่ใช่ DML —
// Load Job เป็นคนละกลไกกับ INSERT/UPDATE/DELETE จึง**ไม่ติดข้อจำกัด Free Tier**
// (หลักฐาน: คุณเพิ่งอัปโหลดข้อมูลเข้าตาราง native ตัวนี้ได้เองโดยไม่ผูก billing มาแล้ว
// นั่นคือ Load Job เหมือนกัน) วิธีนี้ทำให้ได้ทั้ง 2 อย่าง:
//   - เขียน/แก้ไข/ลบ ผ่าน Google Sheet (เร็ว ไม่ติด billing)
//   - อ่าน/ค้นหา/รายงาน ผ่าน BigQuery native table (เร็วกว่า external table มาก
//     และไม่มีปัญหาเรื่องสิทธิ์ Google Drive ที่เจอตอนทำ External Table)
// ข้อเสียเดียวคือข้อมูลใน BigQuery จะ "ตามหลัง" Sheet ไม่กี่วินาที (เวลาที่ Load Job ใช้รัน)
// ไม่ใช่แบบ real-time เป๊ะเหมือน external table แต่เร็วพอสำหรับงาน CRM ทั่วไป

// แปลงชื่อคอลัมน์ให้เป็นชนิดข้อมูล BigQuery ที่ตรงกับตาราง customers (native) ที่คุณสร้างไว้
function bigQueryTypeForColumn_(colName) {
  if (colName === 'created_date' || colName === 'booking_date' || colName === 'last_followup_date') return 'DATE';
  if (colName === 'created_at_ts') return 'TIMESTAMP';
  return 'STRING';
}

// escape ค่าให้เป็น CSV field ที่ถูกต้อง (ครอบ "..." และ double-quote ตัว " ข้างในถ้าจำเป็น)
// follow_up_log / financial_info เป็น JSON string ที่มักมี , และ " อยู่ข้างใน ต้อง escape ให้ดี
function csvEscape_(val) {
  var s = (val === null || val === undefined) ? '' : String(val);
  if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// แปลงค่าจากเซลล์ (อาจเป็น Date object จาก Sheets) ให้เป็นข้อความรูปแบบที่ BigQuery
// รับได้ตรงกับชนิดคอลัมน์ (DATE ต้องเป็น 'yyyy-MM-dd', TIMESTAMP ต้องมี timezone)
function formatCellForCsv_(colName, val) {
  if (val === '' || val === null || val === undefined) return '';
  if (colName === 'created_date' || colName === 'booking_date' || colName === 'last_followup_date') {
    return formatDateStr(val) || '';
  }
  if (colName === 'created_at_ts') {
    if (Object.prototype.toString.call(val) === '[object Date]') {
      return Utilities.formatDate(val, 'GMT+7', "yyyy-MM-dd'T'HH:mm:ssXXX");
    }
    return val;
  }
  return val;
}

// =================================================================
// 📝 เพิ่ม (2026-09-17 รอบที่ 3): ย้ายจุดเขียนที่เหลืออีก 2 จุด — "เพิ่มสมาชิก" และ
// log การใช้งาน/รับลีด (lead_intake_log, user_activity_log) — มาเขียนลง Google Sheet
// (แท็บใหม่ในสเปรดชีตเดียวกับ customers) แล้วซิงก์เข้า BigQuery ด้วย Load Job เหมือนกัน
//
// ต่างจาก customers ตรงที่แท็บพวกนี้จะ "สร้างอัตโนมัติ" ให้เองถ้ายังไม่มี (ไม่ต้องสร้างมือ
// ก่อน) เพราะเป็นข้อมูลที่โค้ดคุมโครงสร้างเองทั้งหมดอยู่แล้ว ไม่ได้ import มาจากที่อื่น
//
// log 2 ตัว (lead_intake_log, user_activity_log) เป็นข้อมูลที่ "เพิ่มอย่างเดียว ไม่มีแก้/ลบ"
// (append-only) จึงซิงก์แบบ "เพิ่มแค่แถวใหม่" (WRITE_APPEND) แทนที่จะโหลดทั้งตารางใหม่ทุกครั้ง
// (ต่างจาก customers/users ที่ใช้ WRITE_TRUNCATE เพราะมีการแก้ไข/ลบแถวเดิมได้) วิธีนี้ทำให้
// ไม่ว่า log จะสะสมมากแค่ไหนในระยะยาว การซิงก์แต่ละครั้งก็ยังเร็วเท่าเดิม (ส่งแค่ 1 แถวใหม่)

var USERS_SHEET_NAME = 'users';
// (2026-09-20) เพิ่ม 'name'/'branch' ต่อท้าย — ต่อท้ายเจตนา ไม่แทรกกลาง เพื่อไม่ให้กระทบ
// ตำแหน่งคอลัมน์เดิมที่อาจมีโค้ด/ข้อมูลอื่นอ้างอิงอยู่ (แม้โค้ดทั้งไฟล์นี้จะหาคอลัมน์จากชื่อ
// หัวตารางเสมออยู่แล้ว ไม่ใช้ตำแหน่งตายตัว แต่ต่อท้ายไว้ก็ยังปลอดภัยกว่า)
var USERS_SHEET_COLUMNS = ['user_id', 'username', 'password_hash', 'role', 'status', 'name', 'branch'];
var USERS_TYPE_MAP = { user_id: 'STRING', username: 'STRING', password_hash: 'STRING', role: 'STRING', status: 'STRING', name: 'STRING', branch: 'STRING' };

// เติมหัวคอลัมน์ที่ยังขาดเข้าไปในแท็บ users อัตโนมัติ (กรณีแท็บมีอยู่แล้วจากก่อนหน้านี้ แต่ยัง
// ไม่มีหัวคอลัมน์ใหม่ เช่น name/branch ที่เพิ่งเพิ่มเข้ามาทีหลัง) — ทำงานแบบ idempotent เรียกซ้ำ
// ได้ปลอดภัย เพิ่มเฉพาะคอลัมน์ที่ยังไม่มีจริงๆ ต่อท้ายหัวตารางเดิม ไม่แตะ/ไม่ลบคอลัมน์หรือข้อมูล
// เดิมเลย ป้องกันไม่ให้ buildHeaderMapForColumns_() ด้านล่าง throw error "ขาดคอลัมน์" ทันทีหลัง
// deploy โค้ดรุ่นนี้ (ถ้าลืมไปเพิ่มหัวคอลัมน์ในชีตด้วยมือก่อน)
function ensureUsersSheetColumns_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var existing = {};
  for (var i = 0; i < headerRow.length; i++) {
    var h = (headerRow[i] || '').toString().trim();
    if (h) existing[h] = true;
  }
  var missing = USERS_SHEET_COLUMNS.filter(function(c) { return !existing[c]; });
  if (missing.length > 0) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
}

var LEAD_LOG_SHEET_NAME = 'lead_intake_log';
var LEAD_LOG_SHEET_COLUMNS = ['received_at', 'received_date', 'phone', 'facebook', 'first_name', 'last_name', 'is_duplicate', 'match_type', 'is_manychat'];
var LEAD_LOG_TYPE_MAP = {
  received_at: 'TIMESTAMP', received_date: 'DATE', phone: 'STRING', facebook: 'STRING',
  first_name: 'STRING', last_name: 'STRING', is_duplicate: 'BOOLEAN', match_type: 'STRING', is_manychat: 'BOOLEAN'
};

var ACTIVITY_LOG_SHEET_NAME = 'user_activity_log';
var ACTIVITY_LOG_SHEET_COLUMNS = ['logged_at', 'log_date', 'username', 'role', 'action', 'detail', 'is_success'];
var ACTIVITY_LOG_TYPE_MAP = {
  logged_at: 'TIMESTAMP', log_date: 'DATE', username: 'STRING', role: 'STRING',
  action: 'STRING', detail: 'STRING', is_success: 'BOOLEAN'
};

// เปิดแท็บตามชื่อในสเปรดชีตเดียวกับ customers — ถ้ายังไม่มีแท็บนี้ (หรือแท็บว่างเปล่า
// ไม่มีแม้แต่แถวหัวตาราง) จะสร้างให้เองพร้อมใส่หัวคอลัมน์ตาม columns ที่ส่งมา
function getOrCreateSheetTab_(tabName, columns) {
  var ss = SpreadsheetApp.openById(CUSTOMER_SHEET_ID);
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
  }
  return sheet;
}

// เหมือน getCustomerHeaderMap_ แต่ใช้ได้กับแท็บ/คอลัมน์ชุดไหนก็ได้ (ใช้ซ้ำกับ users/logs)
function buildHeaderMapForColumns_(sheet, columns) {
  var lastCol = Math.max(sheet.getLastColumn(), columns.length);
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    var h = (headerRow[i] || '').toString().trim();
    if (h) map[h] = i + 1;
  }
  var missing = columns.filter(function(c) { return !map[c]; });
  if (missing.length > 0) {
    throw new Error('แท็บ "' + sheet.getName() + '" ขาดคอลัมน์: ' + missing.join(', '));
  }
  return map;
}

// แปลงค่า 1 ช่อง ให้เป็นข้อความ CSV ตามชนิดข้อมูล BigQuery ที่กำหนด (ใช้ร่วมกับ
// USERS_TYPE_MAP / LEAD_LOG_TYPE_MAP / ACTIVITY_LOG_TYPE_MAP)
function formatValueForCsvByType_(bqType, val) {
  if (val === '' || val === null || val === undefined) return '';
  if (bqType === 'DATE') {
    return formatDateStr(val) || '';
  }
  if (bqType === 'TIMESTAMP') {
    if (Object.prototype.toString.call(val) === '[object Date]') {
      return Utilities.formatDate(val, 'GMT+7', "yyyy-MM-dd'T'HH:mm:ssXXX");
    }
    return val;
  }
  if (bqType === 'BOOLEAN') {
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    var s = String(val).toLowerCase();
    return (s === 'true' || s === '1') ? 'true' : 'false';
  }
  return val;
}

// ซิงก์ทั้งแท็บเข้า BigQuery table แบบ "แทนที่ทั้งหมด" (WRITE_TRUNCATE) — ใช้กับ users
// (ตารางเล็ก แก้ไข/ลบแถวได้ในอนาคต จึงต้องโหลดใหม่ทั้งหมดเพื่อความถูกต้องเสมอ)
// รอผลจริงของ BigQuery Load Job จนเสร็จ (BigQuery.Jobs.insert แค่ "ส่งงานเข้าคิว" เท่านั้น
// ไม่ได้แปลว่างานสำเร็จ — ถ้าไม่รอเช็คสถานะ โค้ดจะไม่รู้เลยว่า Load Job พังทีหลัง เช่น
// ข้อมูลแปลงชนิดไม่ได้ / คอลัมน์ไม่ตรง schema ฯลฯ) ถ้า Load Job ล้มเหลว จะ throw
// error พร้อมข้อความจริงจาก BigQuery ออกมาให้เห็นสาเหตุตรงๆ แทนที่จะดูเหมือน "สำเร็จ" เฉยๆ
function waitForBigQueryLoadJob_(insertResult) {
  var jobRef = insertResult && insertResult.jobReference;
  if (!jobRef) throw new Error('BigQuery.Jobs.insert ไม่คืนค่า jobReference กลับมา (รูปแบบผลลัพธ์ผิดปกติ)');
  var job = insertResult;
  var maxWaitMs = 25000; // รอสูงสุด ~25 วิ กันไม่ให้ค้างนานเกินไปถ้า BigQuery ช้าผิดปกติ
  var waited = 0;
  while (job.status && job.status.state !== 'DONE' && waited < maxWaitMs) {
    Utilities.sleep(1000);
    waited += 1000;
    job = BigQuery.Jobs.get(GCP_PROJECT_ID, jobRef.jobId, { location: jobRef.location });
  }
  if (job.status && job.status.errorResult) {
    throw new Error('BigQuery Load Job ล้มเหลว: ' + job.status.errorResult.message +
      (job.status.errors && job.status.errors.length ? (' | รายละเอียด: ' + job.status.errors.map(function(e){return e.message;}).join(' / ')) : ''));
  }
  if (!job.status || job.status.state !== 'DONE') {
    throw new Error('BigQuery Load Job ยังไม่เสร็จภายในเวลาที่รอ (' + (maxWaitMs/1000) + ' วินาที) — สถานะล่าสุด: ' + (job.status ? job.status.state : 'ไม่ทราบ'));
  }
  return job;
}

// =================================================================
// 🛡️ Safety guard (2026-09-18): กันบั๊ก "user หายหมดเหลือแต่ admin" ที่เคยเกิดจริง —
// สาเหตุเดิม: addUserHTML ซิงก์ตาราง users เข้า BigQuery แบบ WRITE_TRUNCATE (ลบข้อมูล
// เดิมทั้งตารางทิ้งแล้วโหลดใหม่ทั้งหมด) ทุกครั้งที่มีการเพิ่มสมาชิก โดยอ่านข้อมูลจากแท็บ
// Google Sheet "users" ซึ่งถูกสร้างขึ้นมาใหม่แบบว่างเปล่าตอน migration (ไม่มีขั้นตอน
// backfill user เดิมที่มีอยู่แล้วใน BigQuery กลับเข้า Sheet ก่อน) ผลคือพอมีคนกด "เพิ่ม
// สมาชิก" ครั้งแรก ระบบ TRUNCATE ตาราง users ทับด้วยข้อมูลใน Sheet ที่มีแค่ไม่กี่แถว —
// user เก่าทั้งหมดที่มีอยู่ใน BigQuery (แต่ไม่มีใน Sheet) หายไปทันที
//
// ฟังก์ชันนี้เช็คก่อน sync ทุกครั้งว่าจำนวนแถวที่กำลังจะเขียนทับ (จาก Sheet) ต่ำกว่า
// จำนวนแถวที่มีอยู่จริงใน BigQuery ตอนนี้แบบ "ผิดปกติ" หรือไม่ (ลดลงเกิน
// ALLOWED_ROW_DROP_RATIO ที่กำหนด) ถ้าใช่ จะ throw error ทันทีและไม่ยอม sync เลย —
// ป้องกันไม่ให้ TRUNCATE ทับข้อมูลจริงโดยไม่ได้ตั้งใจซ้ำอีก
var ALLOWED_ROW_DROP_RATIO = 0.5; // ยอมให้จำนวนแถวลดได้ไม่เกินครึ่งหนึ่งของของเดิมต่อการ sync 1 ครั้ง

function getBigQueryRowCount_(tableId) {
  try {
    var sql = "SELECT COUNT(*) as cnt FROM `" + GCP_PROJECT_ID + "." + DATASET_ID + "." + tableId + "`";
    var rows = runParamQueryFetch(sql, []);
    var cnt = (rows && rows.length && rows[0].cnt !== '' && rows[0].cnt != null) ? parseInt(rows[0].cnt, 10) : 0;
    return isNaN(cnt) ? 0 : cnt;
  } catch (e) {
    // ตารางอาจยังไม่มีอยู่เลย (เช่น sync ครั้งแรกสุด) — ถือว่ามี 0 แถว ไม่ต้อง block
    Logger.log('getBigQueryRowCount_(' + tableId + ') อ่านไม่สำเร็จ (ถือว่ามี 0 แถว): ' + e.toString());
    return 0;
  }
}

// throw error ถ้าจำนวนแถวใหม่ (จาก Sheet) น้อยกว่าที่มีอยู่ใน BigQuery ตอนนี้แบบผิดปกติ
function assertSafeRowCountForTruncateSync_(tableId, newRowCount) {
  var currentCount = getBigQueryRowCount_(tableId);
  if (currentCount > 0 && newRowCount < currentCount * ALLOWED_ROW_DROP_RATIO) {
    throw new Error(
      'ยกเลิกการซิงก์ตาราง "' + tableId + '" เพื่อความปลอดภัย (ป้องกันเหตุข้อมูลหายซ้ำแบบเดิม): ' +
      'ข้อมูลที่จะเขียนทับมีแค่ ' + newRowCount + ' แถว แต่ตาราง BigQuery ปัจจุบันมี ' + currentCount +
      ' แถว (ลดลงเกิน ' + Math.round((1 - ALLOWED_ROW_DROP_RATIO) * 100) + '%) — น่าจะเกิดจากข้อมูลใน ' +
      'Google Sheet ไม่ครบ (ยังไม่ backfill) ไม่ใช่ต้องการลบข้อมูลจริง จึงไม่ยอม TRUNCATE ทับให้ ' +
      '(ถ้าเป็นตาราง users ให้รัน runOneTimeSetup_BackfillUsersFromBigQuery_ ก่อน แล้วลองใหม่)'
    );
  }
}

function syncSheetTabToBigQueryTable_(tabName, columns, typeMap, tableId) {
  var sheet = getOrCreateSheetTab_(tabName, columns);
  var headerMap = buildHeaderMapForColumns_(sheet, columns);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var allValues = (lastRow > 1) ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  // 🛡️ เช็คก่อนเสมอ — ถ้าจำนวนแถวจาก Sheet น้อยกว่าที่มีอยู่ใน BigQuery แบบผิดปกติ
  // จะ throw error ออกไปตรงนี้เลย ไม่ทำ Load Job ต่อ (ดูคอมเมนต์ที่ฟังก์ชันด้านบน)
  assertSafeRowCountForTruncateSync_(tableId, allValues.length);

  var csvLines = allValues.map(function(row) {
    return columns.map(function(colName) {
      var idx = headerMap[colName] - 1;
      return csvEscape_(formatValueForCsvByType_(typeMap[colName], row[idx]));
    }).join(',');
  });
  var csvText = csvLines.join('\r\n');
  var schemaFields = columns.map(function(c) { return { name: c, type: typeMap[c], mode: 'NULLABLE' }; });

  var job = {
    configuration: {
      load: {
        destinationTable: { projectId: GCP_PROJECT_ID, datasetId: DATASET_ID, tableId: tableId },
        sourceFormat: 'CSV',
        writeDisposition: 'WRITE_TRUNCATE',
        schema: { fields: schemaFields },
        allowQuotedNewlines: true,
        allowJaggedRows: false,
        maxBadRecords: 100
      }
    }
  };
  var blob = Utilities.newBlob(csvText, 'text/csv', tableId + '_sync.csv');
  var insertResult = BigQuery.Jobs.insert(job, GCP_PROJECT_ID, blob);
  return waitForBigQueryLoadJob_(insertResult);
}

// เพิ่ม "แค่ 1 แถวใหม่" เข้า BigQuery table แบบต่อท้าย (WRITE_APPEND) — ใช้กับ log ที่เป็น
// append-only (lead_intake_log, user_activity_log) เพื่อไม่ต้องโหลดประวัติ log ทั้งหมดซ้ำ
// ทุกครั้งที่มี log ใหม่ 1 รายการ (จะช้าลงเรื่อยๆ ถ้า log สะสมเยอะขึ้นถ้าใช้ WRITE_TRUNCATE)
function appendRowToBigQueryTable_(rowValuesInColumnOrder, columns, typeMap, tableId) {
  var csvLine = columns.map(function(colName, i) {
    return csvEscape_(formatValueForCsvByType_(typeMap[colName], rowValuesInColumnOrder[i]));
  }).join(',');
  var schemaFields = columns.map(function(c) { return { name: c, type: typeMap[c], mode: 'NULLABLE' }; });

  var job = {
    configuration: {
      load: {
        destinationTable: { projectId: GCP_PROJECT_ID, datasetId: DATASET_ID, tableId: tableId },
        sourceFormat: 'CSV',
        writeDisposition: 'WRITE_APPEND',
        schema: { fields: schemaFields },
        allowQuotedNewlines: true,
        allowJaggedRows: false,
        maxBadRecords: 100
      }
    }
  };
  var blob = Utilities.newBlob(csvLine, 'text/csv', tableId + '_append.csv');
  var insertResult = BigQuery.Jobs.insert(job, GCP_PROJECT_ID, blob);
  return waitForBigQueryLoadJob_(insertResult);
}
// เข้าตาราง customers (native) — เรียกใช้หลังเขียน Sheet สำเร็จทุกครั้ง (เพิ่ม/แก้ไข/ลบ/
// บันทึกการติดตาม) ห่อด้วย try/catch เสมอที่จุดเรียก เพื่อไม่ให้การซิงก์ล้มเหลวไปบล็อก
// การบันทึกหลัก (ซึ่งสำเร็จไปแล้วที่ Sheet ก่อนหน้านี้)
// =================================================================
// ⏰ เพิ่ม (2026-09-17 รอบที่ 4): ฟังก์ชันสำหรับตั้ง time-driven trigger ให้ Apps Script
// เรียกเป็นระยะ (แนะนำทุก 3-5 นาที) เพื่อซิงก์ข้อมูลจาก Sheet เข้า BigQuery native table
// `customers` แทนการซิงก์แบบ synchronous ทุกครั้งที่มีคนกดบันทึก (ซึ่งช้าเกินไปเมื่อมี
// ข้อมูลหลักแสนแถว) — Sheet ยังคงเป็นข้อมูลล่าสุดเสมอทันทีที่บันทึก ส่วนฝั่ง BigQuery
// (ที่หน้าค้นหา/แดชบอร์ด/รายงานใช้อ่าน) จะตามหลังไม่เกินความถี่ของ trigger ที่ตั้งไว้
//
// วิธีติดตั้ง (ทำครั้งเดียว): เปิด Apps Script Editor → เมนูซ้าย รูปนาฬิกา "Triggers"
// → Add Trigger → Choose function: scheduledSyncCustomersToBigQuery_ → Select event
// source: Time-driven → Minutes timer → Every 5 minutes → Save (ตอน Save ครั้งแรกจะขอ
// authorize สิทธิ์เพิ่ม ให้กด Allow)
// ⏰ ทางเลือกสำหรับตั้ง trigger ผ่านโค้ดโดยตรง (เผื่อหน้า Triggers ใน Apps Script Editor
// มีปัญหาแคช/ไม่ขึ้นรายชื่อฟังก์ชันใหม่ในหน้าเว็บ) — รันฟังก์ชันนี้ "1 ครั้งเดียว" จาก
// dropdown "เรียกใช้" ด้านบน (เลือกชื่อ installScheduledCustomerSync_ แล้วกด ▶︎) จะสร้าง
// time-driven trigger ให้อัตโนมัติ ไม่ต้องเข้าหน้า Triggers เองเลย — รันซ้ำได้ปลอดภัย
// (จะลบ trigger เดิมของฟังก์ชันนี้ทิ้งก่อนเสมอ กันสร้างซ้ำซ้อนหลายอัน)
function installScheduledCustomerSync_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'scheduledSyncCustomersToBigQuery_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('scheduledSyncCustomersToBigQuery_')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('ตั้ง trigger สำเร็จ: จะรัน scheduledSyncCustomersToBigQuery_ ทุก 5 นาที');
}

function scheduledSyncCustomersToBigQuery_() {
  var t0 = Date.now();
  try {
    syncCustomerSheetToBigQuery_();
    saveCustomerSyncStatus_(true, 'ok (' + Math.round((Date.now() - t0) / 1000) + 's)');
  } catch (err) {
    Logger.log('scheduledSyncCustomersToBigQuery_ error: ' + err);
    saveCustomerSyncStatus_(false, String(err).substring(0, 300));
  }
}
// (2026-09-24 r34) เก็บผลการ sync ล่าสุดไว้ใน Script Properties — ดูได้จาก ?action=checkStatus
// (ช่อง lastCustomerSync) จะได้รู้ว่า sync ชีต → BigQuery ทำงานอยู่จริงหรือพังเงียบๆ
function saveCustomerSyncStatus_(ok, message) {
  try {
    PropertiesService.getScriptProperties().setProperty('LAST_CUSTOMER_SYNC', JSON.stringify({
      ok: ok, message: message, at: Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd HH:mm:ss')
    }));
  } catch (e) { /* ignore */ }
}
function getCustomerSyncStatus_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('LAST_CUSTOMER_SYNC');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function syncCustomerSheetToBigQuery_() {
  var sheet = getCustomerSheet_();
  var headerMap = getCustomerHeaderMap_(sheet);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var allValues = (lastRow > 1) ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  var csvLines = [];
  for (var i = 0; i < allValues.length; i++) {
    var row = allValues[i];
    var fields = [];
    for (var c = 0; c < CUSTOMER_SHEET_COLUMNS.length; c++) {
      var colName = CUSTOMER_SHEET_COLUMNS[c];
      var idx = headerMap[colName] - 1;
      fields.push(csvEscape_(formatCellForCsv_(colName, row[idx])));
    }
    csvLines.push(fields.join(','));
  }
  var csvText = csvLines.join('\r\n');

  // 🛡️ เช็คก่อนเสมอ — กันบั๊กเดียวกับที่เกิดกับตาราง users (ดูคอมเมนต์ที่
  // assertSafeRowCountForTruncateSync_ ด้านบนไฟล์) เผื่อ Sheet customers ถูกลบ/เคลียร์
  // แถวไปโดยไม่ได้ตั้งใจ ก่อนที่ trigger จะรันซิงก์รอบถัดไป
  assertSafeRowCountForTruncateSync_(TABLE_ID, allValues.length);

  var schemaFields = CUSTOMER_SHEET_COLUMNS.map(function(colName) {
    return { name: colName, type: bigQueryTypeForColumn_(colName), mode: 'NULLABLE' };
  });

  var job = {
    configuration: {
      load: {
        destinationTable: { projectId: GCP_PROJECT_ID, datasetId: DATASET_ID, tableId: TABLE_ID },
        sourceFormat: 'CSV',
        writeDisposition: 'WRITE_TRUNCATE', // แทนที่ข้อมูลทั้งตารางทุกครั้งด้วยข้อมูลล่าสุดจาก Sheet
        schema: { fields: schemaFields },
        allowQuotedNewlines: true,
        allowJaggedRows: false,
        maxBadRecords: 100
      }
    }
  };

  // ถ้าไม่มีข้อมูลเลย (ชีตว่าง) csvText จะเป็น '' — ยังส่งได้ปกติ ได้ตารางเปล่า ไม่ error
  var blob = Utilities.newBlob(csvText, 'text/csv', 'customers_sync.csv');
  var insertResult = BigQuery.Jobs.insert(job, GCP_PROJECT_ID, blob);
  return waitForBigQueryLoadJob_(insertResult);
}

// =================================================================
// 📋 ตาราง Log ประวัติการใช้งานของพนักงาน (user_activity_log)
// =================================================================
// บันทึกว่า "ใคร (username/role) ทำอะไร (action/detail) เมื่อไหร่ (logged_at) สำเร็จ
// หรือไม่ (is_success)" — ใช้สำหรับหน้า "📋 ประวัติการใช้งาน" (เฉพาะ admin ดูได้)
// ครอบคลุม: login เข้าระบบ, ค้นหาข้อมูล, เพิ่ม/แก้ไข/ลบลูกค้า, บันทึกการติดตาม,
// export ข้อมูล และเพิ่มสมาชิกใหม่ (ดู ACTIVITY_LOG_WHITELIST ด้านล่างว่า log action ไหนบ้าง
// — ตั้งใจไม่ log action ที่แค่ "ดึงข้อมูลมาแสดงหน้าจอ" เช่น getInitialData/
// getDashboardSummary เพราะจะรันถี่มากจนตาราง log รกโดยไม่มีประโยชน์)
//
// ⚠️ ต้องรันคำสั่งนี้ใน BigQuery Console ก่อนใช้งาน (ครั้งเดียว) มิฉะนั้นการบันทึก log
// จะ error เงียบๆ ใน Logger เฉยๆ (ไม่กระทบการทำงานหลักของระบบ) — ใช้ฟังก์ชัน
// runOneTimeSetup_CreateUserActivityLogTable() ด้านล่างของไฟล์นี้
var ACTIVITY_LOG_TABLE_ID = 'user_activity_log';
var ACTIVITY_LOG_TABLE_FULL_PATH = '`' + GCP_PROJECT_ID + '.' + DATASET_ID + '.' + ACTIVITY_LOG_TABLE_ID + '`';

// รวม action ชื่อเก่า/ชื่อใหม่ที่ความหมายเดียวกันให้เหลือชื่อเดียว เพื่อให้กรอง/รายงาน
// ประวัติการใช้งานได้ง่าย (ไม่ต้องมานั่งเช็คทั้ง 'add' และ 'addCustomer' แยกกัน)
function normalizeActivityAction_(action) {
  var map = {
    'searchCustomers': 'search',
    'addCustomer': 'add',
    'editCustomer': 'update',
    'deleteCustomer': 'delete',
    'addMember': 'addUser'
  };
  return map[action] || action;
}

// เฉพาะ action ในลิสต์นี้เท่านั้นที่จะถูกบันทึกลง user_activity_log
// (screenshotAttempt เพิ่มเข้ามา 2026-09-15 — ดูคอมเมนต์ที่ action==='screenshotAttempt'
// ใน doPost ด้านล่าง: เป็นมาตรการ "ตามรอย" ไม่ใช่ "ป้องกัน" การแคปหน้าจอ — เว็บทำไม่ได้จริง)
var ACTIVITY_LOG_WHITELIST = ['login', 'search', 'add', 'update', 'delete', 'exportAll', 'addFollowUp', 'addUser', 'screenshotAttempt'];

// สร้างข้อความ "detail" ที่อ่านง่าย บอกรายละเอียดของแต่ละ action ไว้ในหน้า log
function buildActivityLogDetail_(normalizedAction, payload, result) {
  payload = payload || {};
  try {
    switch (normalizedAction) {
      case 'login':
        return 'username: ' + cleanStr(payload.username);
      case 'search':
        var kw = cleanStr(payload.keyword);
        return kw ? ('คำค้น: "' + kw + '"') : 'ค้นหา/กรองข้อมูลลูกค้า';
      case 'add':
        var c = payload.cust || payload.data || payload;
        return 'ลูกค้าใหม่: ' + cleanStr(c.firstname || c.first_name) + ' ' + cleanStr(c.lastname || c.last_name) +
               (c.phone1 || c.phone ? ' (' + cleanStr(c.phone1 || c.phone) + ')' : '');
      case 'update':
        return 'แก้ไขลูกค้า key: ' + cleanStr(payload.rowIndex || payload.phoneKey) +
               (result && result.changedSummary ? ' — ' + cleanStr(result.changedSummary) : '');
      case 'delete':
        return 'ลบลูกค้า key: ' + cleanStr(payload.phoneKey || payload.rowIndex);
      case 'addFollowUp':
        return 'บันทึกการติดตาม key: ' + cleanStr(payload.key || payload.rowIndex || payload.phoneKey);
      case 'addUser':
        return 'เพิ่มสมาชิก username: ' + cleanStr(payload.username) + ' (role: ' + cleanStr(payload.role) + ')';
      case 'exportAll':
        return 'Export ข้อมูลลูกค้าทั้งหมดเป็นไฟล์';
      case 'screenshotAttempt':
        // payload.method มาจากฝั่งหน้าเว็บ: 'printscreen' (กดปุ่ม Print Screen) หรือ
        // 'copy' (พยายามคัดลอกข้อมูลลูกค้าในตาราง/การ์ดรายละเอียด)
        var methodLabel = { printscreen: 'กดปุ่ม Print Screen', copy: 'พยายามคัดลอกข้อมูลลูกค้า' };
        return '⚠️ ' + (methodLabel[cleanStr(payload.method)] || ('เหตุการณ์: ' + cleanStr(payload.method)));
      default:
        return '';
    }
  } catch (e) {
    return '';
  }
}

// บันทึก 1 แถวลง user_activity_log — ห่อด้วย try/catch เสมอ เพื่อไม่ให้การบันทึก log
// ล้มเหลวไปทำให้ action หลัก (เช่นบันทึกลูกค้า) ที่สำเร็จไปแล้วดูเหมือนพังไปด้วย
//
// แก้ไข (2026-09-18 — ปัญหา login/logout ช้าผิดปกติ): เดิมฟังก์ชันนี้เขียนลง Sheet แล้ว
// เรียก appendRowToBigQueryTable_() ซิงก์เข้า BigQuery "ทันที" แบบ synchronous ก่อน
// ตอบกลับหน้าเว็บ — ซึ่ง appendRowToBigQueryTable_ รอ BigQuery Load Job จนเสร็จจริง
// (waitForBigQueryLoadJob_ poll ทุก 1 วิ นานสุด 25 วิ) และ Load Job ใช้เวลาขั้นต่ำ
// 2-10+ วิเสมอไม่ว่าจะมีกี่แถว (เป็น overhead จัดคิวงานของ BigQuery เอง ไม่ใช่ปริมาณข้อมูล)
// ผลคือ "ทุก" action ที่อยู่ใน ACTIVITY_LOG_WHITELIST (login, logout, add, update, delete,
// exportAll, addFollowUp, addUser, screenshotAttempt) ต้องรอ Load Job นี้ก่อนตอบกลับ
// หน้าเว็บเสมอ ทำให้ login/logout (และจริงๆ add/update/delete ด้วย) ช้าผิดปกติ
//
// ตอนนี้เปลี่ยนให้เขียนลง Sheet เท่านั้น (เร็ว ~100-300ms) แล้ว "ไม่รอ" ซิงก์เข้า BigQuery
// ทันทีอีกต่อไป — ปล่อยให้ scheduledSyncActivityLogToBigQuery_ (ตั้ง trigger รันทุก 5 นาที
// ดูฟังก์ชัน installScheduledActivityLogSync_ ด้านล่างไฟล์) ไปซิงก์แถวใหม่เข้า BigQuery
// เป็นรอบๆ ทีหลังแทน — ผลข้างเคียงเดียวคือหน้า "📋 ประวัติการใช้งาน" (อ่านจาก BigQuery)
// จะเห็นข้อมูลล่าช้าได้สูงสุด ~5 นาที ซึ่งยอมรับได้เพราะเป็นแค่หน้า audit log ไม่ใช่ข้อมูล
// ที่ต้องเรียลไทม์ ต่างจาก login/logout ที่ user รอผลอยู่หน้าจอตรงๆ
function logUserActivity_(user, action, detail, isSuccess) {
  try {
    var now = new Date();
    var rowValues = [
      now,                                               // logged_at
      Utilities.formatDate(now, 'GMT+7', 'yyyy-MM-dd'),  // log_date
      user ? cleanStr(user.username) : '',
      user ? cleanStr(user.role) : '',
      cleanStr(action),
      cleanStr(detail),
      isSuccess ? true : false
    ];
    var sheet = getOrCreateSheetTab_(ACTIVITY_LOG_SHEET_NAME, ACTIVITY_LOG_SHEET_COLUMNS);
    sheet.appendRow(rowValues);
    // ⛔ ไม่เรียก appendRowToBigQueryTable_ ตรงนี้แล้ว (ดูคอมเมนต์ด้านบน) — ปล่อยให้
    // scheduledSyncActivityLogToBigQuery_ ซิงก์เป็นรอบๆ ทีหลังแทน เพื่อไม่ให้ login/logout/
    // add/update/delete ต้องรอ BigQuery Load Job ก่อนตอบกลับหน้าเว็บ
  } catch (e) {
    Logger.log('logUserActivity_ error (ไม่กระทบการทำงานหลัก): ' + e.toString());
  }
}

// =================================================================
// ⏰ (2026-09-18) ซิงก์แถวใหม่ของ log แบบ "เป็นรอบๆ" เข้า BigQuery ผ่าน trigger — แทนที่
// การรอ BigQuery Load Job แบบ synchronous ทุกครั้งที่มี log ใหม่ 1 แถว (ดูคอมเมนต์ที่
// logUserActivity_ ด้านบนไฟล์ — เป็นสาเหตุที่ login/logout/add/update/delete ช้าผิดปกติ)
// =================================================================
// เก็บ "เลขแถวล่าสุดที่ซิงก์ไปแล้ว" ไว้ใน Script Properties เพื่อรู้ว่าต้องอ่านจากแถว
// ไหนต่อ (ไม่ใช้ WRITE_TRUNCATE เหมือน customers/users เพราะ log เป็น append-only ไม่มี
// การแก้ไข/ลบแถวเดิม จึงซิงก์แค่ "แถวที่เพิ่มใหม่ตั้งแต่รอบก่อน" ด้วย WRITE_APPEND พอ)
function syncNewSheetRowsToBigQueryAppend_(tabName, columns, typeMap, tableId, lastSyncedRowPropKey) {
  var sheet = getOrCreateSheetTab_(tabName, columns);
  var headerMap = buildHeaderMapForColumns_(sheet, columns);
  var lastRow = sheet.getLastRow();

  var props = PropertiesService.getScriptProperties();
  var lastSyncedRow = parseInt(props.getProperty(lastSyncedRowPropKey) || '1', 10); // แถว 1 = หัวตาราง
  if (isNaN(lastSyncedRow) || lastSyncedRow < 1) lastSyncedRow = 1;

  if (lastRow <= lastSyncedRow) {
    return; // ไม่มีแถวใหม่ตั้งแต่รอบก่อน ไม่ต้องทำอะไร
  }

  var numNewRows = lastRow - lastSyncedRow;
  var lastCol = sheet.getLastColumn();
  var newValues = sheet.getRange(lastSyncedRow + 1, 1, numNewRows, lastCol).getValues();

  var csvLines = newValues.map(function(row) {
    return columns.map(function(colName) {
      var idx = headerMap[colName] - 1;
      return csvEscape_(formatValueForCsvByType_(typeMap[colName], row[idx]));
    }).join(',');
  });
  var csvText = csvLines.join('\r\n');
  var schemaFields = columns.map(function(c) { return { name: c, type: typeMap[c], mode: 'NULLABLE' }; });

  var job = {
    configuration: {
      load: {
        destinationTable: { projectId: GCP_PROJECT_ID, datasetId: DATASET_ID, tableId: tableId },
        sourceFormat: 'CSV',
        writeDisposition: 'WRITE_APPEND',
        schema: { fields: schemaFields },
        allowQuotedNewlines: true,
        allowJaggedRows: false,
        maxBadRecords: 100
      }
    }
  };
  var blob = Utilities.newBlob(csvText, 'text/csv', tableId + '_batch_append.csv');
  var insertResult = BigQuery.Jobs.insert(job, GCP_PROJECT_ID, blob);
  waitForBigQueryLoadJob_(insertResult); // ที่นี่รอได้ เพราะรันจาก trigger เบื้องหลัง ไม่มี user รอหน้าเว็บ

  // อัปเดต "แถวล่าสุดที่ซิงก์แล้ว" เฉพาะตอน Load Job สำเร็จเท่านั้น (ถ้า throw ก่อนถึงบรรทัด
  // นี้ รอบถัดไปจะลองซิงก์แถวชุดเดิมใหม่อีกครั้ง กันข้อมูลตกหาย)
  props.setProperty(lastSyncedRowPropKey, String(lastRow));
}

var ACTIVITY_LOG_LAST_SYNCED_ROW_KEY = 'ACTIVITY_LOG_LAST_SYNCED_ROW';

function scheduledSyncActivityLogToBigQuery_() {
  try {
    syncNewSheetRowsToBigQueryAppend_(
      ACTIVITY_LOG_SHEET_NAME, ACTIVITY_LOG_SHEET_COLUMNS, ACTIVITY_LOG_TYPE_MAP,
      ACTIVITY_LOG_TABLE_ID, ACTIVITY_LOG_LAST_SYNCED_ROW_KEY
    );
  } catch (err) {
    Logger.log('scheduledSyncActivityLogToBigQuery_ error: ' + err);
  }
}

// ⚙️ Setup ครั้งเดียว: ตั้ง time-driven trigger ให้รัน scheduledSyncActivityLogToBigQuery_
// ทุก 5 นาที (เหมือน installScheduledCustomerSync_ ด้านบนไฟล์) — วิธีรัน: เลือกฟังก์ชัน
// "installScheduledActivityLogSync_" จาก dropdown ▶ Run แล้วกดรัน ครั้งเดียวพอ (รันซ้ำได้
// ปลอดภัย จะลบ trigger เดิมของฟังก์ชันนี้ทิ้งก่อนเสมอ กันสร้างซ้ำซ้อนหลายอัน)
// ⚠️ ต้องรันฟังก์ชันนี้ 1 ครั้ง ไม่งั้น log ใหม่จะเขียนเข้า Sheet ได้ปกติ (login/logout เร็ว
// ตามที่ตั้งใจ) แต่จะไม่ถูกซิงก์เข้า BigQuery เลย ทำให้หน้า "📋 ประวัติการใช้งาน" ไม่มี
// ข้อมูลใหม่ขึ้นเลย
function installScheduledActivityLogSync() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'scheduledSyncActivityLogToBigQuery_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('scheduledSyncActivityLogToBigQuery_')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('ตั้ง trigger สำเร็จ: จะรัน scheduledSyncActivityLogToBigQuery_ ทุก 5 นาที');
}
// ดึงประวัติการใช้งานมาแสดงในหน้า "📋 ประวัติการใช้งาน" — เฉพาะ admin เรียกได้
// (เช็คสิทธิ์ที่ doPost ก่อนเรียกฟังก์ชันนี้แล้ว)
function getUserActivityLogHTML(filters) {
  filters = filters || {};
  try {
    var startDate = cleanStr(filters.startDate) || formatDateStr(new Date());
    var endDate = cleanStr(filters.endDate) || formatDateStr(new Date());
    var usernameFilter = cleanStr(filters.username);

    var whereParts = ["log_date BETWEEN @startDate AND @endDate"];
    var params = [
      { name: 'startDate', value: startDate },
      { name: 'endDate', value: endDate }
    ];
    if (usernameFilter) {
      whereParts.push("LOWER(username) = LOWER(@username)");
      params.push({ name: 'username', value: usernameFilter });
    }

    var sql = "SELECT CAST(logged_at AS STRING) as logged_at, username, role, action, detail, is_success " +
      "FROM " + ACTIVITY_LOG_TABLE_FULL_PATH +
      " WHERE " + whereParts.join(' AND ') +
      " ORDER BY logged_at DESC LIMIT 500";
    var rows = runParamQueryFetch(sql, params);
    return { success: true, data: rows || [] };
  } catch (err) {
    return { success: false, message: err.toString(), data: [] };
  }
}

// =================================================================
// 📊 (2026-09-25) Dashboard ผลการทำงานพนักงาน (หน้า "📈 รายงาน") — เฉพาะ admin
// =================================================================
// action: 'getStaffDashboardStats'  payload: { startDate: 'yyyy-MM-dd', endDate: 'yyyy-MM-dd' }
//
// หลักการ: สรุปผล (COUNT/GROUP BY) ใน BigQuery ให้เสร็จฝั่งเซิร์ฟเวอร์ แล้วส่งกลับเฉพาะ
// "ตัวเลข" ไม่กี่สิบแถว — ไม่ส่งแถว log ดิบไปหน้าเว็บ
//   1) staffActivity : login + addFollowUp (สำเร็จเท่านั้น) แยกตาม username, Top N
//   2) activityTrend : แนวโน้มรายวัน (หรือรายสัปดาห์ถ้าช่วงยาวเกิน 92 วัน) ของ
//                      จำนวนการติดตามลูกค้า / ลูกค้าที่พนักงานบันทึกเพิ่ม / จำนวนพนักงานที่ใช้งานจริง
//
// (r37) ทั้งสองกราฟอ่านจาก user_activity_log ตารางเดียว (PARTITION BY log_date — กรองตามช่วง
// วันที่แล้วสแกนแค่ partition ที่เกี่ยวข้อง เบามาก) — เอากราฟ "สัดส่วนประเภทการติดตาม" ที่ต้อง
// UNNEST follow_up_log จากตาราง customers ออกแล้ว (error ในระบบจริง)
//
// ⚠️ ข้อมูลใน BigQuery ตามหลัง Google Sheet ได้ ~5 นาที (ซิงก์ผ่าน trigger
// scheduledSyncActivityLogToBigQuery_) จึงแคชผลไว้ใน CacheService 5 นาทีด้วย
//
// สิทธิ์: "เฉพาะ admin เท่านั้น" (เหมือน getUserActivityLog) — เป็นรายงานอ่านอย่างเดียว ไม่อยู่ใน
// ACTIVITY_LOG_WHITELIST; role อื่นเรียกมาจะได้ success:false ทันทีโดยไม่ยิง query ใดๆ
// (หน้าเว็บซ่อนการ์ดนี้จาก role อื่นด้วย แต่นั่นเป็นแค่ UI — ตัวบังคับจริงคือฝั่งนี้)
var STAFF_DASHBOARD_ALLOWED_ROLES = ['admin'];
var STAFF_DASHBOARD_TOP_N = 15;
var STAFF_DASHBOARD_MAX_RANGE_DAYS = 366;
var STAFF_DASHBOARD_DAILY_MAX_DAYS = 92; // ช่วงยาวกว่านี้สรุปเป็นรายสัปดาห์ (จุดบนกราฟไม่เกิน ~53 จุด)
var STAFF_DASHBOARD_CACHE_SECONDS = 300;
var STAFF_DASHBOARD_CACHE_PREFIX = 'staffDash:v3:';
// action ที่นับว่า "พนักงานได้ใช้งานระบบจริง" ในวันนั้น (ใช้นับจำนวนพนักงานแอคทีฟ)
var STAFF_DASHBOARD_ACTIVE_ACTIONS = ['login', 'search', 'add', 'update', 'addFollowUp'];

function isIsoDateStr_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

// ตรวจ/เติมค่าช่วงวันที่ — default 30 วันล่าสุด (เวลาไทย), สลับให้ถ้าเริ่ม > ถึง,
// และจำกัดความยาวช่วงไม่เกิน STAFF_DASHBOARD_MAX_RANGE_DAYS กัน query สแกนหนักเกินจำเป็น
function resolveStaffDashboardRange_(payload) {
  var todayStr = Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
  var endDate = cleanStr(payload.endDate);
  var startDate = cleanStr(payload.startDate);
  if (!isIsoDateStr_(endDate)) endDate = todayStr;
  if (!isIsoDateStr_(startDate)) {
    var d = new Date(endDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 29);
    startDate = Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  if (startDate > endDate) { var tmp = startDate; startDate = endDate; endDate = tmp; }
  var spanDays = Math.round((new Date(endDate + 'T00:00:00Z') - new Date(startDate + 'T00:00:00Z')) / 86400000) + 1;
  if (spanDays > STAFF_DASHBOARD_MAX_RANGE_DAYS) {
    var s = new Date(endDate + 'T00:00:00Z');
    s.setUTCDate(s.getUTCDate() - (STAFF_DASHBOARD_MAX_RANGE_DAYS - 1));
    startDate = Utilities.formatDate(s, 'UTC', 'yyyy-MM-dd');
    spanDays = STAFF_DASHBOARD_MAX_RANGE_DAYS;
  }
  return { startDate: startDate, endDate: endDate, spanDays: spanDays };
}

// กราฟที่ 1: login + addFollowUp แยกตามพนักงาน (GROUP BY username) — ส่งกลับแค่ Top N แถว
// พร้อมยอดรวมทั้งหมด (คำนวณด้วย window function ก่อน LIMIT จึงเป็นยอดรวมของทุกคนจริง)
function queryStaffActivityCounts_(range) {
  var sql =
    "SELECT username, " +
    "  COUNTIF(action = 'login') AS login_count, " +
    "  COUNTIF(action = 'addFollowUp') AS followup_count, " +
    "  SUM(COUNTIF(action = 'login')) OVER () AS total_login, " +
    "  SUM(COUNTIF(action = 'addFollowUp')) OVER () AS total_followup, " +
    "  COUNT(*) OVER () AS total_staff " +
    "FROM " + ACTIVITY_LOG_TABLE_FULL_PATH +
    " WHERE log_date BETWEEN SAFE_CAST(@startDate AS DATE) AND SAFE_CAST(@endDate AS DATE)" +
    " AND is_success = TRUE" +
    " AND action IN ('login', 'addFollowUp')" +
    " AND username IS NOT NULL AND TRIM(username) != ''" +
    " GROUP BY username" +
    " ORDER BY (COUNTIF(action = 'login') + COUNTIF(action = 'addFollowUp')) DESC, username" +
    " LIMIT " + STAFF_DASHBOARD_TOP_N;
  var rows = runParamQueryFetch(sql, [
    { name: 'startDate', value: range.startDate },
    { name: 'endDate', value: range.endDate }
  ]) || [];
  var first = rows[0] || {};
  return {
    rows: rows.map(function(r) {
      return {
        username: cleanStr(r.username),
        login: parseInt(r.login_count, 10) || 0,
        followUp: parseInt(r.followup_count, 10) || 0
      };
    }),
    totalStaff: parseInt(first.total_staff, 10) || 0,
    totalLogin: parseInt(first.total_login, 10) || 0,
    totalFollowUp: parseInt(first.total_followup, 10) || 0
  };
}

// กราฟที่ 2: แนวโน้มกิจกรรมของทีม — GROUP BY วัน (หรือสัปดาห์) แล้ว LEFT JOIN กับปฏิทินที่
// สร้างด้วย GENERATE_DATE_ARRAY เพื่อให้วันที่ไม่มีกิจกรรมเลยขึ้นเป็น 0 (เส้นกราฟไม่กระโดดข้ามวัน)
// ยอดรวม/จำนวนพนักงานไม่ซ้ำ "ทั้งช่วง" คำนวณแยกใน CTE totals ภายใน query เดียวกัน
function queryActivityTrend_(range) {
  var granularity = range.spanDays > STAFF_DASHBOARD_DAILY_MAX_DAYS ? 'week' : 'day';
  var startExpr = "SAFE_CAST(@startDate AS DATE)";
  var endExpr = "SAFE_CAST(@endDate AS DATE)";
  var bucketOf = function(col) {
    return granularity === 'week' ? "DATE_TRUNC(" + col + ", WEEK(MONDAY))" : col;
  };
  var activeList = STAFF_DASHBOARD_ACTIVE_ACTIONS.map(function(a) { return "'" + a + "'"; }).join(', ');
  var sql =
    "WITH src AS (" +
    "  SELECT log_date, action, LOWER(TRIM(username)) AS uname" +
    "  FROM " + ACTIVITY_LOG_TABLE_FULL_PATH +
    "  WHERE log_date BETWEEN " + startExpr + " AND " + endExpr +
    "  AND is_success = TRUE AND username IS NOT NULL AND TRIM(username) != ''" +
    "  AND action IN (" + activeList + ")" +
    "), agg AS (" +
    "  SELECT " + bucketOf('log_date') + " AS bucket_date," +
    "    COUNTIF(action = 'addFollowUp') AS followup_count," +
    "    COUNTIF(action = 'add') AS add_count," +
    "    COUNT(DISTINCT uname) AS active_staff" +
    "  FROM src GROUP BY bucket_date" +
    "), totals AS (" +
    "  SELECT COUNTIF(action = 'addFollowUp') AS total_followup," +
    "    COUNTIF(action = 'add') AS total_add," +
    "    COUNT(DISTINCT uname) AS total_active_staff FROM src" +
    "), cal AS (" +
    "  SELECT b AS bucket_date FROM UNNEST(GENERATE_DATE_ARRAY(" +
         bucketOf(startExpr) + ", " + endExpr + ", INTERVAL 1 " + (granularity === 'week' ? 'WEEK' : 'DAY') + ")) AS b" +
    ")" +
    " SELECT CAST(cal.bucket_date AS STRING) AS bucket_date," +
    "   IFNULL(agg.followup_count, 0) AS followup_count," +
    "   IFNULL(agg.add_count, 0) AS add_count," +
    "   IFNULL(agg.active_staff, 0) AS active_staff," +
    "   totals.total_followup, totals.total_add, totals.total_active_staff" +
    " FROM cal CROSS JOIN totals LEFT JOIN agg ON agg.bucket_date = cal.bucket_date" +
    " ORDER BY cal.bucket_date";
  var rows = runParamQueryFetch(sql, [
    { name: 'startDate', value: range.startDate },
    { name: 'endDate', value: range.endDate }
  ]) || [];
  var first = rows[0] || {};
  return {
    granularity: granularity,
    rows: rows.map(function(r) {
      return {
        date: cleanStr(r.bucket_date),
        followUp: parseInt(r.followup_count, 10) || 0,
        added: parseInt(r.add_count, 10) || 0,
        activeStaff: parseInt(r.active_staff, 10) || 0
      };
    }),
    totalFollowUp: parseInt(first.total_followup, 10) || 0,
    totalAdded: parseInt(first.total_add, 10) || 0,
    totalActiveStaff: parseInt(first.total_active_staff, 10) || 0
  };
}

function getStaffDashboardStatsHTML(reqPayload, user) {
  try {
    if (!user || STAFF_DASHBOARD_ALLOWED_ROLES.indexOf(user.role) === -1) {
      return { success: false, message: 'เฉพาะ admin เท่านั้นที่ดู Dashboard ผลการทำงานพนักงานได้' };
    }
    var range = resolveStaffDashboardRange_(reqPayload || {});

    var cache = null;
    var cacheKey = STAFF_DASHBOARD_CACHE_PREFIX + range.startDate + ':' + range.endDate;
    try {
      cache = CacheService.getScriptCache();
      var cached = cache.get(cacheKey);
      if (cached) {
        var cachedObj = JSON.parse(cached);
        cachedObj.cached = true;
        return cachedObj;
      }
    } catch (cacheErr) {
      cache = null; // แคชใช้ไม่ได้ก็ query ตรงตามปกติ ไม่ให้กระทบผลลัพธ์
    }

    // แยก try/catch ต่อกราฟ — ถ้า query หนึ่งมีปัญหา อีกกราฟยังแสดงได้ตามปกติ
    var staffActivity, activityTrend;
    try {
      staffActivity = queryStaffActivityCounts_(range);
    } catch (e1) {
      staffActivity = { rows: [], totalStaff: 0, totalLogin: 0, totalFollowUp: 0, error: e1.toString() };
    }
    try {
      activityTrend = queryActivityTrend_(range);
    } catch (e2) {
      activityTrend = { granularity: 'day', rows: [], totalFollowUp: 0, totalAdded: 0, totalActiveStaff: 0, error: e2.toString() };
    }

    var result = {
      success: true,
      range: { startDate: range.startDate, endDate: range.endDate },
      topN: STAFF_DASHBOARD_TOP_N,
      staffActivity: staffActivity,
      activityTrend: activityTrend,
      generatedAt: Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd HH:mm'),
      cached: false
    };
    // แคชเฉพาะตอนที่ทั้งสองส่วนสำเร็จ — ถ้ามี error จะได้ลองใหม่รอบถัดไปทันที ไม่ค้าง error 5 นาที
    if (cache && !staffActivity.error && !activityTrend.error) {
      try { cache.put(cacheKey, JSON.stringify(result), STAFF_DASHBOARD_CACHE_SECONDS); } catch (putErr) {}
    }
    return result;
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

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
      return { success: true, connected: true, message: 'BigQuery Connected', codeVersion: CODE_VERSION, lastCustomerSync: getCustomerSyncStatus_() };
    }
    return { success: false, connected: false, message: 'No response', codeVersion: CODE_VERSION, lastCustomerSync: getCustomerSyncStatus_() };
  } catch (err) {
    return { success: false, connected: false, message: err.toString(), codeVersion: CODE_VERSION, lastCustomerSync: getCustomerSyncStatus_() };
  }
}
/**
 * ฟังก์ชันแปลงวันที่ ให้คงรูปแบบ YYYY-MM-DD (ค.ศ.) ตาม BigQuery
 */
function formatDateStr(val) {
  if (val === null || val === undefined || val === '') return '';

  // 1. ถ้าได้ประเภท Date Object มาจาก BigQuery/Sheets
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    var yFromDate = val.getFullYear();
    // แก้ไข (2026-09-17 รอบที่ 5): เดิมเช็คปี พ.ศ. หลุด (>2400) เฉพาะตอน val เป็น string
    // เท่านั้น ถ้า Sheets/BigQuery ส่งมาเป็น Date object ตรงๆ ที่มีปีเพี้ยนอยู่แล้ว (เช่น
    // ปี 2569 ถูกตีความเป็นปี ค.ศ. ตรงๆ ตอนคีย์ข้อมูลเก่า) โค้ดเดิมจะไม่แก้ให้เลย ทำให้
    // ส่งค่าผิดเข้า BigQuery — เพิ่มเช็คแบบเดียวกันให้ Date object ด้วย
    if (yFromDate > 2400) {
      var fixedDate = new Date(val.getTime());
      fixedDate.setFullYear(yFromDate - 543);
      return Utilities.formatDate(fixedDate, 'Asia/Bangkok', 'yyyy-MM-dd');
    }
    return Utilities.formatDate(val, 'Asia/Bangkok', 'yyyy-MM-dd');
  }

  // 1.5 แก้ไข (2026-09-17 รอบที่ 5): ค่าจาก Google Sheets บางเซลล์เป็น "เลข serial
  // วันที่" ดิบๆ (เช่น 244449) แทนที่จะเป็น Date object จริง — เกิดจากข้อมูลเก่าที่พิมพ์
  // ปี พ.ศ. ผิดเป็น ค.ศ. ตรงๆ (เช่น 2569) ทำให้ Sheets คำนวณเป็นวันที่ในอนาคตหลายร้อยปี
  // จนบางครั้งเซลล์เก็บเป็นตัวเลขล้วนแทนวันที่ ต้องแปลงกลับเป็นวันที่ก่อน แล้วค่อยเช็ค/แก้
  // ปี พ.ศ. เหมือนกรณี Date object ด้านบน ไม่งั้นจะส่งเลขดิบๆ เข้า BigQuery แล้ว Load Job
  // parse วันที่ไม่ได้ (error "Unable to parse... column_type: DATE")
  if (typeof val === 'number' && !isNaN(val)) {
    // Google Sheets serial date: วันที่ 0 = 30 ธ.ค. 1899 (นับแบบ UTC ไม่สนโซนเวลา)
    var serialDate = new Date(Date.UTC(1899, 11, 30) + Math.round(val) * 86400000);
    if (isNaN(serialDate.getTime())) return '';
    var yFromSerial = serialDate.getUTCFullYear();
    var mFromSerial = ('0' + (serialDate.getUTCMonth() + 1)).slice(-2);
    var dFromSerial = ('0' + serialDate.getUTCDate()).slice(-2);
    if (yFromSerial > 2400) yFromSerial = yFromSerial - 543;
    return yFromSerial + '-' + mFromSerial + '-' + dFromSerial;
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

var CRM_LOGIN_USERS_KEY = 'crm_tracker_login_users';
var CRM_LOGIN_SESSIONS_KEY = 'crm_tracker_login_sessions';

function getUsersStore() {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty(CRM_LOGIN_USERS_KEY);
  if (!stored) {
    var defaults = [
      { username: 'admin', password: 'admin123', role: 'admin', name: 'Administrator' },
      { username: 'user', password: 'user123', role: 'user', name: 'General User' }
    ];
    props.setProperty(CRM_LOGIN_USERS_KEY, JSON.stringify(defaults));
    return defaults;
  }
  try { return JSON.parse(stored); } catch (e) { return []; }
}

function getSessionsStore() {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty(CRM_LOGIN_SESSIONS_KEY);
  try { return stored ? JSON.parse(stored) : {}; } catch (e) { return {}; }
}

// =================================================================
// 🟢 ผู้ใช้งาน "ออนไลน์อยู่ตอนนี้" — โชว์ที่หน้า login
// =================================================================
// ONLINE_WINDOW_MS: ถือว่า session ยัง "ออนไลน์" อยู่ ถ้ามีการเรียก server (ทำอะไรก็ได้
// ในระบบ หรือ heartbeat 'ping' จากหน้าเว็บทุก ๆ 20 วิ) ภายในช่วงเวลานี้ — ถ้าเกินกว่านี้
// แปลว่าปิดแท็บ/ไม่ได้ใช้งานแล้ว จะไม่ถูกนับว่าออนไลน์ (แต่ไม่ได้แปลว่า logout จริง
// เพราะระบบนี้ไม่มี token หมดอายุ ยังใช้ token เดิม login ต่อได้ถ้าเปิดหน้าเว็บใหม่)
var SESSION_ONLINE_WINDOW_MS = 5 * 60 * 1000; // 5 นาที
// SESSION_MAX_AGE_MS: session ที่ไม่มีการใช้งานเลยเกินเวลานี้ จะถูกลบทิ้งจาก Properties
// (ทำตอน login ครั้งใหม่ - ดู pruneStaleSessions_) เพื่อไม่ให้ crm_tracker_login_sessions
// พอกพูนไม่มีที่สิ้นสุด (Script Properties มีเพดานขนาดต่อ 1 key)
var SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 ชั่วโมง

// ลบ session เก่าที่ไม่มีการใช้งานมานานเกิน SESSION_MAX_AGE_MS ออกจาก store
// (เรียกตอน login ใหม่แต่ละครั้ง เป็นจังหวะทำความสะอาดที่เนียนที่สุด ไม่ต้องตั้ง trigger แยก)
function pruneStaleSessions_(sessions) {
  var now = Date.now();
  var pruned = {};
  for (var token in sessions) {
    var s = sessions[token];
    var lastSeen = s.lastActive || 0;
    if (!lastSeen && s.createdAt) {
      var parsed = Date.parse(s.createdAt);
      lastSeen = isNaN(parsed) ? 0 : parsed;
    }
    if ((now - lastSeen) < SESSION_MAX_AGE_MS) {
      pruned[token] = s;
    }
  }
  return pruned;
}

// ดึงรายชื่อผู้ใช้งานที่ "ออนไลน์อยู่ตอนนี้" (ไม่ซ้ำ username แม้ login ไว้หลาย session/token)
// ไม่ต้อง login ก่อนก็เรียกได้ (ตั้งใจให้เรียกได้จากหน้า login ก่อนเข้าสู่ระบบ)
function getOnlineUsersHTML() {
  try {
    var sessions = getSessionsStore();
    var now = Date.now();
    var latestByUser = {};
    for (var token in sessions) {
      var s = sessions[token];
      var lastSeen = s.lastActive || 0;
      if ((now - lastSeen) > SESSION_ONLINE_WINDOW_MS) continue; // เงียบไปนานแล้ว ไม่นับว่าออนไลน์
      var existing = latestByUser[s.username];
      if (!existing || lastSeen > existing.lastActive) {
        latestByUser[s.username] = { username: s.username, role: s.role, name: s.name, lastActive: lastSeen };
      }
    }
    var list = [];
    for (var u in latestByUser) list.push(latestByUser[u]);
    list.sort(function(a, b) { return b.lastActive - a.lastActive; });
    return { success: true, data: list, count: list.length };
  } catch (err) {
    return { success: false, message: err.toString(), data: [], count: 0 };
  }
}

function sha256Hex_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return bytes.map(function(byte) {
    var unsigned = byte < 0 ? byte + 256 : byte;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

function getBigQueryLoginUser_(username, password) {
  try {
    var sql = "SELECT username, password_hash, role, status FROM `" + GCP_PROJECT_ID + "." + DATASET_ID + ".users` WHERE username = @username LIMIT 1";
    var rows = runParamQueryFetch(sql, [{ name: 'username', value: username }]);
    if (!rows.length) return { found: false };

    var row = rows[0];
    var storedPassword = String(row.password_hash || '').trim();
    var passwordMatches = storedPassword === password || storedPassword.toLowerCase() === sha256Hex_(password).toLowerCase();
    var status = String(row.status || '').trim().toLowerCase();
    if (!passwordMatches || (status && status !== 'active')) return { found: true, user: null };

    // (2026-09-20) ดึง name/branch แบบแยก query ต่างหากจาก query login หลักด้านบนโดยตั้งใจ —
    // ถ้าคอลัมน์ name/branch ยังไม่มีจริงในตาราง (ยังไม่ได้เพิ่ม schema/ยังไม่ sync) หรือ query นี้
    // พลาดด้วยเหตุใดก็ตาม getBigQueryUserExtraFields_ จะคืนค่าว่างเงียบๆ ไม่ throw ออกมา จึงไม่ทำให้
    // การ login (ที่ผ่านมาแล้วด้านบน) ล้มเหลวตามไปด้วย
    var extra = getBigQueryUserExtraFields_(username);

    return {
      found: true,
      user: {
        username: String(row.username || username),
        password: password,
        role: String(row.role || 'user').toLowerCase(),
        name: extra.name || String(row.username || username),
        branch: extra.branch || ''
      }
    };
  } catch (e) {
    return { found: false };
  }
}

// ดึง name/branch ของ user แบบ best-effort เท่านั้น (ดูคอมเมนต์ที่จุดเรียกใช้ด้านบน) — คืนค่า
// เป็นสตริงว่างเสมอถ้าหาไม่เจอ/คอลัมน์ยังไม่มี/query error ไม่ throw ออกไปให้กระทบ login หลัก
function getBigQueryUserExtraFields_(username) {
  try {
    var sql = "SELECT name, branch FROM `" + GCP_PROJECT_ID + "." + DATASET_ID + ".users` WHERE username = @username LIMIT 1";
    var rows = runParamQueryFetch(sql, [{ name: 'username', value: username }]);
    if (!rows.length) return { name: '', branch: '' };
    return { name: String(rows[0].name || ''), branch: String(rows[0].branch || '') };
  } catch (e) {
    Logger.log('getBigQueryUserExtraFields_ error (ไม่กระทบ login หลัก): ' + e.toString());
    return { name: '', branch: '' };
  }
}

function saveSessionsStore(data) {
  PropertiesService.getScriptProperties().setProperty(CRM_LOGIN_SESSIONS_KEY, JSON.stringify(data));
}

// ลบ session ทิ้งทันที (ใช้ตอนกดปุ่ม "ออกจากระบบ") — ต่างจากการปล่อยให้ session เงียบ
// หายไปเองหลัง 5 นาที (SESSION_ONLINE_WINDOW_MS) เพราะ logout คือ user ตั้งใจออกเอง จึง
// ควรหายจากลิสต์ "ออนไลน์อยู่ตอนนี้" ทันที ไม่ต้องรอ
function removeSession_(token) {
  if (!token) return;
  try {
    var sessions = getSessionsStore();
    if (sessions[token]) {
      delete sessions[token];
      saveSessionsStore(sessions);
    }
  } catch (e) {
    Logger.log('removeSession_ error: ' + e.toString());
  }
}

function loginHTML(payload) {
  payload = payload || {};
  var username = String(payload.username || '').trim();
  var password = String(payload.password || '').trim();
  if (!username || !password) {
    return { success: false, message: 'กรุณากรอก username และ password' };
  }

  var databaseUser = getBigQueryLoginUser_(username, password);
  var matched = databaseUser.found ? databaseUser.user : null;
  if (!databaseUser.found) {
    var users = getUsersStore();
    matched = users.find(function(u) {
      return String(u.username) === username && String(u.password) === password;
    });
  }

  if (!matched) {
    return { success: false, message: 'username หรือ password ไม่ถูกต้อง' };
  }

  var token = Utilities.base64EncodeWebSafe(Utilities.getUuid() + ':' + Date.now());
  var sessions = getSessionsStore();
  sessions = pruneStaleSessions_(sessions); // เก็บกวาด session เก่าทิ้งทุกครั้งที่มี login ใหม่
  sessions[token] = { username: matched.username, role: matched.role, name: matched.name, branch: matched.branch || '', createdAt: new Date().toISOString(), lastActive: Date.now() };
  saveSessionsStore(sessions);

  return {
    success: true,
    token: token,
    // (2026-09-20) เพิ่ม branch เข้า response ด้วย — ใช้โดยแอป Salepromofinder ที่ login ผ่าน
    // backend ตัวนี้ร่วมกัน (ไม่กระทบ CRM-TRACKER Pro เอง เพราะเป็นแค่ field เพิ่มเข้ามาเฉยๆ)
    user: { username: matched.username, role: matched.role, name: matched.name, branch: matched.branch || '' },
    message: 'เข้าสู่ระบบสำเร็จ'
  };
}

function validateToken(token) {
  if (!token) return null;
  var sessions = getSessionsStore();
  var session = sessions[token];
  if (!session) return null;

  // อัปเดต "เวลาใช้งานล่าสุด" ทุกครั้งที่ token นี้ถูกใช้เรียก server (รวมถึง heartbeat
  // 'ping' จากหน้าเว็บ) แต่เขียนกลับ Script Properties เฉพาะเมื่อห่างจากครั้งก่อนเกิน 20
  // วินาที เพื่อไม่ให้เขียน Properties ถี่เกินไปทุก request จนช้าโดยไม่จำเป็น
  var now = Date.now();
  var shouldPersist = !session.lastActive || (now - session.lastActive) > 20000;
  session.lastActive = now;
  if (shouldPersist) {
    sessions[token] = session;
    saveSessionsStore(sessions);
  }
  return session;
}

function getCurrentUserFromRequest(contents) {
  var token = contents && contents.token ? contents.token : '';
  if (!token && contents && contents.payload && contents.payload.token) token = contents.payload.token;
  return validateToken(token);
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') {
    return { success: false, message: 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถเพิ่ม แก้ไข ลบ หรือ export ได้' };
  }
  return null;
}

function requireAdminForAction(action) {
  var adminOnlyActions = {
    'add': 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถเพิ่มข้อมูลได้',
    'addCustomer': 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถเพิ่มข้อมูลได้',
    'update': 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถแก้ไขข้อมูลได้',
    'editCustomer': 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถแก้ไขข้อมูลได้',
    'delete': 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถลบข้อมูลได้',
    'deleteCustomer': 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถลบข้อมูลได้',
    'exportAll': 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถ export ข้อมูลได้',
    'addFollowUp': 'สิทธิ์ user ดูได้อย่างเดียว ไม่สามารถบันทึกการติดตามได้'
  };
  return adminOnlyActions[action] || '';
}

// =================================================================
// 👥 เมนู "เพิ่มสมาชิก" — เพิ่ม user ใหม่เข้าตาราง users (BigQuery)
// =================================================================
// กติกาสิทธิ์:
//  - ต้อง login อยู่ก่อนเสมอ (เช็คที่ doPost แล้วก่อนจะมาถึงฟังก์ชันนี้)
//  - เรียกเมนูนี้ได้เฉพาะ role 'admin' และ 'staff' (พนักงาน) เท่านั้น
//    (ดู ADD_MEMBER_ALLOWED_ROLES ด้านล่าง) — role อื่น (เช่น sale) ห้ามเข้าเมนูนี้
//  - ถ้าคนที่กดเพิ่มเป็น role 'staff' (ไม่ใช่ admin): ตั้ง role ให้สมาชิกใหม่ได้แค่
//    'staff' (พนักงาน) หรือ 'sale' เท่านั้น ห้ามตั้งเป็น 'admin' เด็ดขาด (กันพนักงาน
//    เผลอ/จงใจตั้งตัวเองหรือคนอื่นเป็นแอดมิน) — ถ้าคนกดเพิ่มเป็น 'admin' จะตั้ง role
//    อะไรก็ได้ในบรรดา role ที่ระบบรู้จัก (ดู KNOWN_ROLES)
var ADD_MEMBER_ALLOWED_ROLES = ['admin', 'staff']; // ใครมีสิทธิ์เข้าเมนู "เพิ่มสมาชิก" ได้บ้าง
var STAFF_ALLOWED_NEW_ROLES = ['staff', 'sale'];    // role ที่ "พนักงาน" (staff) ตั้งให้สมาชิกใหม่ได้
var KNOWN_ROLES = ['admin', 'staff', 'sale'];       // role ทั้งหมดที่ระบบรู้จัก (กัน role พิมพ์ผิด/ไม่รู้จัก)

// =================================================================
// 🧩 ช่วยเติมค่าให้คอลัมน์ "required" (NOT NULL) ของตาราง users ที่เราไม่รู้จักล่วงหน้า
// =================================================================
// สาเหตุที่ต้องมีส่วนนี้: ตาราง users จริงในโปรเจกต์นี้มีคอลัมน์ที่ REQUIRED (เช่น
// user_id) นอกเหนือจาก username/password_hash/role/status ที่โค้ดรู้จักอยู่แล้ว
// ถ้า INSERT แล้วไม่ใส่ค่าคอลัมน์เหล่านี้ BigQuery จะ error "Required field X cannot
// be null" ทันที
//
// แก้ไข (รอบนี้): เดิมใช้ query INFORMATION_SCHEMA.COLUMNS หา schema แต่พบว่ายัง error
// "user_id cannot be null" ซ้ำเดิมอยู่ (แปลว่า query นั้นน่าจะ error/คืนค่าว่างเงียบๆ
// แล้ว fallback ไม่เติมคอลัมน์ให้จริง) — เปลี่ยนมาใช้วิธี "ยิง SELECT * ... LIMIT 0" กับ
// ตาราง users โดยตรงแทน แล้วอ่าน schema (พร้อม mode REQUIRED/NULLABLE) จาก response ของ
// BigQuery.Jobs.query เอง — เป็น API เส้นเดียวกับที่ใช้ query ข้อมูลจริงอยู่แล้วทั้งไฟล์
// (เช่นตอน login) จึงมั่นใจได้ว่า permission เข้าถึงได้แน่นอน ต่างจาก
// INFORMATION_SCHEMA.COLUMNS ที่อาจต้องมีสิทธิ์เพิ่มเติมแยกต่างหาก
function getUsersTableSchema_() {
  try {
    var request = {
      query: "SELECT * FROM `" + GCP_PROJECT_ID + "." + DATASET_ID + ".users` LIMIT 0",
      useLegacySql: false
    };
    var queryResults = BigQuery.Jobs.query(request, GCP_PROJECT_ID);
    var jobId = queryResults.jobReference.jobId;
    while (!queryResults.jobComplete) {
      Utilities.sleep(250);
      queryResults = BigQuery.Jobs.getQueryResults(GCP_PROJECT_ID, jobId);
    }
    return (queryResults.schema && queryResults.schema.fields) ? queryResults.schema.fields : [];
  } catch (e) {
    Logger.log('getUsersTableSchema_ error: ' + e.toString());
    return [];
  }
}

// หาเลข user_id ถัดไป (ใช้เมื่อคอลัมน์ user_id เป็นชนิดตัวเลข) โดยดูจากค่ามากสุดที่มีอยู่ +1
function getNextNumericUserId_() {
  try {
    var sql = "SELECT MAX(SAFE_CAST(user_id AS INT64)) as max_id FROM `" + GCP_PROJECT_ID + "." + DATASET_ID + ".users`";
    var rows = runParamQueryFetch(sql, []);
    var maxId = (rows && rows.length && rows[0].max_id) ? parseInt(rows[0].max_id, 10) : 0;
    if (isNaN(maxId)) maxId = 0;
    return maxId + 1;
  } catch (e) {
    return Date.now(); // fallback กันพลาด — ยังไงก็ไม่ซ้ำ (เวลาปัจจุบันเป็น ms)
  }
}

// เตรียมรายชื่อคอลัมน์/expression/parameter เพิ่มเติม สำหรับคอลัมน์ required ที่ยังไม่ถูก
// จัดการโดยตรงในโค้ด (handledColumnNames = คอลัมน์ที่ addUserHTML ใส่ค่าเองอยู่แล้ว)
// field.mode ที่ได้จาก BigQuery schema เป็น 'REQUIRED' | 'NULLABLE' | 'REPEATED'
// field.type เป็น 'STRING' | 'INTEGER' | 'FLOAT' | 'NUMERIC' | 'BOOLEAN' | 'TIMESTAMP' | 'DATE' | ...
function buildExtraRequiredColumnsForInsert_(handledColumnNames) {
  var schemaFields = getUsersTableSchema_();
  var names = [];
  var exprs = [];
  var params = [];
  schemaFields.forEach(function(field, idx) {
    var colName = String(field.name || '');
    if (!colName || handledColumnNames.indexOf(colName) !== -1) return; // ถูกจัดการแล้วในโค้ดหลัก ข้ามไป
    if (String(field.mode || '').toUpperCase() !== 'REQUIRED') return; // ไม่ได้บังคับ ไม่ต้องใส่ค่าก็ได้
    var dataType = String(field.type || '').toUpperCase();
    var paramName = 'extraCol' + idx;
    names.push(colName);
    if (dataType === 'INTEGER' || dataType === 'INT64' || dataType === 'NUMERIC' || dataType === 'BIGNUMERIC' || dataType === 'FLOAT' || dataType === 'FLOAT64') {
      if (colName === 'user_id') {
        exprs.push('CAST(@' + paramName + ' AS INT64)');
        params.push({ name: paramName, value: String(getNextNumericUserId_()) });
      } else {
        exprs.push('CAST(@' + paramName + ' AS INT64)');
        params.push({ name: paramName, value: '0' });
      }
    } else if (dataType === 'BOOLEAN' || dataType === 'BOOL') {
      exprs.push('CAST(@' + paramName + ' AS BOOL)');
      params.push({ name: paramName, value: 'true' });
    } else if (dataType === 'TIMESTAMP') {
      exprs.push('CURRENT_TIMESTAMP()');
    } else if (dataType === 'DATE') {
      exprs.push("CURRENT_DATE('Asia/Bangkok')");
    } else if (colName === 'user_id') {
      // user_id เป็นชนิด STRING (หรือชนิดอื่นที่ไม่ใช่ตัวเลข) — ใช้ค่า unique แบบ UUID
      exprs.push('@' + paramName);
      params.push({ name: paramName, value: Utilities.getUuid() });
    } else {
      exprs.push('@' + paramName);
      params.push({ name: paramName, value: '' });
    }
  });
  return { names: names, exprs: exprs, params: params };
}


// แก้ไข (2026-09-17 รอบที่ 3): เปลี่ยนจาก INSERT SQL เข้า BigQuery มาเขียนลงแท็บ
// "users" ใน Google Sheet เดียวกับ customers แทน (ดูคอมเมนต์ที่ USERS_SHEET_NAME
// ด้านบนไฟล์) — เช็คซ้ำ username ตรงจาก Sheet เพื่อความสดใหม่ทันที ไม่ต้องรอ sync
function addUserHTML(payload, currentUser) {
  try {
    if (!currentUser || ADD_MEMBER_ALLOWED_ROLES.indexOf(currentUser.role) === -1) {
      return { success: false, message: 'คุณไม่มีสิทธิ์เพิ่มสมาชิกใหม่ (เมนูนี้ใช้ได้เฉพาะ admin และพนักงานเท่านั้น)' };
    }

    var username = cleanStr(payload && payload.username).toLowerCase();
    var password = cleanStr(payload && payload.password);
    var requestedRole = cleanStr(payload && payload.role).toLowerCase();
    var name = cleanStr(payload && payload.name);     // (2026-09-20) ชื่อ-นามสกุลจริง — ไม่บังคับ (fallback เป็น username ถ้าไม่กรอก)
    var branch = cleanStr(payload && payload.branch); // (2026-09-20) สาขา — ไม่บังคับ

    if (!username || !password || !requestedRole) {
      return { success: false, message: 'กรุณากรอก username, password และเลือกสิทธิ์ให้ครบ' };
    }
    if (password.length < 6) {
      return { success: false, message: 'password ต้องมีความยาวอย่างน้อย 6 ตัวอักษร' };
    }
    if (KNOWN_ROLES.indexOf(requestedRole) === -1) {
      return { success: false, message: 'ไม่รู้จักสิทธิ์ "' + requestedRole + '"' };
    }
    // พนักงาน (staff) ตั้ง role ให้สมาชิกใหม่ได้แค่ พนักงาน/sale เท่านั้น ห้ามตั้ง admin
    if (currentUser.role !== 'admin' && STAFF_ALLOWED_NEW_ROLES.indexOf(requestedRole) === -1) {
      return { success: false, message: 'สิทธิ์พนักงาน สามารถเพิ่มสมาชิกได้เฉพาะ role "พนักงาน" หรือ "sale" เท่านั้น' };
    }

    var usersSheet = getOrCreateSheetTab_(USERS_SHEET_NAME, USERS_SHEET_COLUMNS);
    ensureUsersSheetColumns_(usersSheet); // (2026-09-20) เติมหัวคอลัมน์ name/branch อัตโนมัติถ้าแท็บนี้มีอยู่ก่อนแล้วแต่ยังไม่มี
    var usersHeaderMap = buildHeaderMapForColumns_(usersSheet, USERS_SHEET_COLUMNS);

    // เช็คว่ามี username นี้อยู่แล้วในระบบหรือยัง (กันซ้ำ) — อ่านตรงจาก Sheet
    var lastRow = usersSheet.getLastRow();
    if (lastRow > 1) {
      var usernameCol = usersHeaderMap['username'];
      var existingUsernames = usersSheet.getRange(2, usernameCol, lastRow - 1, 1).getValues();
      for (var i = 0; i < existingUsernames.length; i++) {
        var existingU = (existingUsernames[i][0] || '').toString().trim().toLowerCase();
        if (existingU === username) {
          return { success: false, message: 'มี username "' + username + '" อยู่แล้วในระบบ กรุณาใช้ชื่ออื่น' };
        }
      }
    }

    // เก็บรหัสผ่านเป็น sha256 hash เสมอ (ไม่เก็บ plain text) — สอดคล้องกับที่
    // getBigQueryLoginUser_ ใช้ตอน login (รองรับทั้ง plain และ sha256 เผื่อแถวเก่า)
    var passwordHash = sha256Hex_(password);
    var newUserFields = {
      user_id: Utilities.getUuid(),
      username: username,
      password_hash: passwordHash,
      role: requestedRole,
      status: 'active',
      name: name || username, // ไม่กรอกชื่อมา ก็ใช้ username แทนกันช่องว่างเปล่าๆ
      branch: branch
    };
    usersSheet.appendRow(USERS_SHEET_COLUMNS.map(function(c) { return newUserFields[c] !== undefined ? newUserFields[c] : ''; }));

    try { syncSheetTabToBigQueryTable_(USERS_SHEET_NAME, USERS_SHEET_COLUMNS, USERS_TYPE_MAP, 'users'); }
    catch (syncErr) { Logger.log('sync users error: ' + syncErr); }

    return {
      success: true,
      message: 'เพิ่มสมาชิก "' + username + '" (สิทธิ์: ' + requestedRole + ') สำเร็จ'
    };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
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
  } else if (action === 'getFollowupCalendar') {
    return createJsonResponse(getFollowupCalendarHTML(e.parameter));
  } else if (action === 'getOnlineUsers') {
    // โชว์ที่หน้า login ก่อนเข้าสู่ระบบ จึงตั้งใจไม่เช็ค token/login ตรงนี้ (เหมือน checkStatus)
    return createJsonResponse(getOnlineUsersHTML());
  } else if (action === 'getStaleLeadsReport') {
    // รายงานลูกค้าที่ยังไม่ได้ติดตามนาน (ดู getStaleLeadsReportHTML) — ใช้ในหน้า "รายงาน"
    return createJsonResponse(getStaleLeadsReportHTML(e.parameter));
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
    var action = String(contents.action || '').trim();
    var token = contents.token || (contents.payload && contents.payload.token) || '';
    var user = validateToken(token);

    if (action === 'login') {
      var loginResult = loginHTML(contents.payload || contents);
      var loginPayloadForLog = contents.payload || contents;
      logUserActivity_(
        loginResult.success ? loginResult.user : { username: loginPayloadForLog.username, role: '' },
        'login',
        buildActivityLogDetail_('login', loginPayloadForLog, loginResult) +
          (loginResult.success ? '' : ' - ล้มเหลว: ' + cleanStr(loginResult.message)),
        !!loginResult.success
      );
      return createJsonResponse(loginResult);
    }

    if (action === 'getOnlineUsers') {
      // โชว์ที่หน้า login ก่อนเข้าสู่ระบบ จึงตั้งใจไม่เช็ค login ตรงนี้ (เหมือน checkStatus)
      return createJsonResponse(getOnlineUsersHTML());
    }

    if (action === 'logout') {
      // ลบ session ทิ้งทันที ให้หายจากลิสต์ "ออนไลน์อยู่ตอนนี้" ทันที ไม่ต้องรอ 5 นาที
      var userBeforeLogout = user; // เก็บไว้ก่อนลบ session เพื่อบันทึก log ว่าใคร logout
      removeSession_(token);
      if (userBeforeLogout) {
        logUserActivity_(userBeforeLogout, 'logout', 'ออกจากระบบ', true);
      }
      return createJsonResponse({ success: true, message: 'ออกจากระบบเรียบร้อย' });
    }

    if (!user) {
      return createJsonResponse({ success: false, message: 'กรุณาเข้าสู่ระบบก่อนใช้งาน', requireLogin: true });
    }

    // role check for sensitive update actions
    // นโยบายสิทธิ์ (อัปเดตล่าสุด — จำกัดสิทธิ์ลบข้อมูลลูกค้าให้เหลือแค่ admin):
    //  - admin        : ทำได้ทุกอย่าง (เพิ่ม/แก้ไข/ลบ/export/ดู log/เพิ่มสมาชิกได้ทุก role)
    //  - staff (พนักงาน): เพิ่ม/แก้ไขข้อมูลลูกค้าได้ และปริ้นได้ (ปริ้นไม่ผ่าน action นี้)
    //                     "ลบ" ทำไม่ได้แล้ว (เดิมทำได้ ตัดสิทธิ์นี้ออก เหลือแค่ admin เท่านั้น)
    //                     แต่ export และดู log ไม่ได้ (เช็คแยกจุดอื่น)
    //  - sale/user     : ดูข้อมูลได้อย่างเดียว (ปริ้นได้ แต่ปริ้นเป็นแค่การแสดงผลฝั่งหน้าเว็บ
    //                     ไม่ได้เรียก action นี้ จึงไม่ต้องเช็คตรงนี้)
    var CUSTOMER_WRITE_ALLOWED_ROLES = ['admin', 'staff'];
    // (2026-09-19) เพิ่ม role 'sale' ให้ "แก้ไข" ข้อมูลลูกค้าได้ ตามคำขอผู้บริหาร — แต่จำกัดแค่
    // "ชื่อ-นามสกุล" และ "ที่อยู่" เท่านั้น ฟิลด์อื่นที่ส่งมาด้วย (ถ้ามี) จะถูกตัดทิ้งเงียบๆ ใน
    // updateCustomerHTML (ดู SALE_EDITABLE_FIELDS_ ในฟังก์ชันนั้น) — ชั้นป้องกันที่ 2 ต่อจากหน้าเว็บ
    // ที่ซ่อน/ปิดฟิลด์อื่นไว้ให้ role นี้อยู่แล้วเป็นชั้นแรก ไม่ได้ให้สิทธิ์ "เพิ่ม"/"ลบ" เพิ่มขึ้นแต่อย่างใด
    var CUSTOMER_UPDATE_ALLOWED_ROLES = ['admin', 'staff', 'sale'];
    var CUSTOMER_DELETE_ALLOWED_ROLES = ['admin']; // ลบข้อมูลลูกค้า จำกัดเฉพาะ admin เท่านั้น (staff แก้ไข/เพิ่มได้ปกติ แต่ลบไม่ได้)
    var CUSTOMER_EXPORT_ALLOWED_ROLES = ['admin']; // เฉพาะ admin เท่านั้นที่ export ได้
    if (action === 'delete' || action === 'deleteCustomer') {
      if (CUSTOMER_DELETE_ALLOWED_ROLES.indexOf(user.role) === -1) {
        return createJsonResponse({ success: false, message: 'เฉพาะ admin เท่านั้นที่ลบข้อมูลลูกค้าได้' });
      }
    } else if (action === 'add' || action === 'addCustomer' || action === 'addFollowUp') {
      if (CUSTOMER_WRITE_ALLOWED_ROLES.indexOf(user.role) === -1) {
        return createJsonResponse({ success: false, message: 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว ไม่สามารถเพิ่มข้อมูลลูกค้าหรือบันทึกการติดตามได้ (เฉพาะ admin และพนักงานเท่านั้นที่ทำได้)' });
      }
    } else if (action === 'update' || action === 'editCustomer') {
      if (CUSTOMER_UPDATE_ALLOWED_ROLES.indexOf(user.role) === -1) {
        return createJsonResponse({ success: false, message: 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว ไม่สามารถแก้ไขข้อมูลลูกค้าได้' });
      }
    }
    if (action === 'exportAll') {
      if (CUSTOMER_EXPORT_ALLOWED_ROLES.indexOf(user.role) === -1) {
        return createJsonResponse({ success: false, message: 'เฉพาะ admin เท่านั้นที่ export ข้อมูลได้' });
      }
    }

    // ใส่ codeVersion + action ที่รับมาจริงไว้ใน error message เผื่อ deploy ไม่ติด
    var result = { success: false, message: 'Invalid Action: "' + action + '" (codeVersion=' + CODE_VERSION + ')' };
    if (action === 'checkStatus' || action === 'checkBigQuery') {
      result = checkBigQueryStatus();
    } else if (action === 'search' || action === 'searchCustomers') {
      result = searchCustomersHTML(contents.payload || contents);
    } else if (action === 'add' || action === 'addCustomer') {
      result = addCustomerHTML(contents.payload || contents.data || {}, user);
    } else if (action === 'update' || action === 'editCustomer') {
      var editData = contents.payload || contents;
      result = updateCustomerHTML(editData.rowIndex || editData.phoneKey || editData.key, editData.cust || editData.data || {}, editData.phoneHint, user);
    } else if (action === 'delete' || action === 'deleteCustomer') {
      var delData = contents.payload || contents;
      // แก้บั๊ก (2026-09-17 รอบที่ 4): เดิมไม่ได้เช็ค delData.key เลย ทั้งที่หน้าเว็บส่งมาในชื่อ
      // 'key' เสมอ (ดู deleteCustomerByIndex ใน index.html) ทำให้ลบไม่เคยทำงานได้จริงมาก่อน
      result = deleteCustomerHTML(delData.phoneKey || delData.rowIndex || delData.key, delData.phoneHint);
    } else if (action === 'getByPhone' || action === 'getCustomerByRow') {
      var getData = contents.payload || contents;
      result = getCustomerByPhone(getData.phoneKey || getData.rowIndex);
    } else if (action === 'addUser' || action === 'addMember') {
      // เมนู "เพิ่มสมาชิก" — สิทธิ์เช็คแยกอยู่ในฟังก์ชันนี้เอง (ไม่ใช่ admin-only ตรงๆ
      // เพราะ role 'staff' ก็เข้าเมนูนี้ได้ แต่ตั้ง role ให้คนใหม่ได้จำกัดกว่า admin)
      result = addUserHTML(contents.payload || contents.data || {}, user);
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
      var flData = contents.payload || contents;
      result = addFollowUpLogHTML(flData.key || flData.rowIndex || flData.phoneKey, flData.entry || {}, flData.phoneHint, user);
    } else if (action === 'getCustomerAudit') {
      // (2026-09-24) อ่าน "ผู้บันทึก/ผู้แก้ไขล่าสุด/ผู้ติดตาม" ตรงจาก Google Sheet (ไม่ผ่าน BigQuery)
      // เป็น read-only ทุก role ที่ login แล้วเรียกได้ — ใช้แก้ปัญหาชื่อไม่ขึ้นเพราะ BigQuery sync ตามหลังชีต
      result = getCustomerAuditHTML(contents.payload || contents);
    } else if (action === 'getDailyLeadReport') {
      result = getDailyLeadReportHTML(contents.payload || contents);
    } else if (action === 'getLeadIntakeLogDetail') {
      result = getLeadIntakeLogDetailHTML(contents.payload || contents);
    } else if (action === 'getFollowupCalendar') {
      result = getFollowupCalendarHTML(contents.payload || contents);
    } else if (action === 'ping') {
      // heartbeat จากหน้าเว็บ (ทุก ~20 วิ ตอน login อยู่) แค่เรียกมาให้ validateToken()
      // ด้านบนอัปเดต lastActive ของ session นี้ ไม่ต้องทำอะไรต่อ — ใช้เพื่อให้คนอื่นเห็นว่า
      // user นี้ยัง "ออนไลน์" อยู่ในหน้า login ของคนที่ยังไม่ได้เข้าสู่ระบบ
      result = { success: true };
    } else if (action === 'screenshotAttempt') {
      // ⚠️ ไม่ใช่การ "ป้องกัน" การแคปหน้าจอ/Snipping Tool จริง — ฝั่งเว็บสกัดไม่ได้ 100%
      // (Print Screen/Snipping Tool ทำงานในระดับ OS อยู่นอกเหนือการควบคุมของ JavaScript
      // ทุกเว็บไซต์ในโลกก็ทำแบบนี้ไม่ได้ 100% เหมือนกัน) ฟังก์ชันนี้แค่ "บันทึกร่องรอย" ว่า
      // ใคร (user จาก token) พยายามแคป/คัดลอกข้อมูล เมื่อไหร่ — ดู activateLeakDeterrentMeasures_
      // ในไฟล์ index.html ฝั่ง frontend ที่เรียก action นี้เข้ามา ทุก action ในนี้จะถูก log ลง
      // user_activity_log อัตโนมัติผ่านโค้ดด้านล่าง (อยู่ใน ACTIVITY_LOG_WHITELIST แล้ว)
      result = { success: true };
    } else if (action === 'getUserActivityLog') {
      // ประวัติการใช้งานของพนักงาน — เฉพาะ admin เท่านั้นที่ดูได้
      if (user.role !== 'admin') {
        result = { success: false, message: 'เฉพาะ admin เท่านั้นที่ดูประวัติการใช้งานได้' };
      } else {
        result = getUserActivityLogHTML(contents.payload || contents);
      }
    } else if (action === 'getStaleLeadsReport') {
      // รายงานลูกค้าที่ยังไม่ได้ติดตามนาน (ดู getStaleLeadsReportHTML) — ใช้ในหน้า "รายงาน"
      // เป็นรายงานอ่านอย่างเดียว ไม่ได้อยู่ใน CUSTOMER_WRITE_ALLOWED_ROLES/EXPORT ด้านบน
      // เหมือน getDashboardSummary/getDailyLeadReport — ทุก role ที่ login แล้วดูได้
      result = getStaleLeadsReportHTML(contents.payload || contents);
    } else if (action === 'getStaffDashboardStats') {
      // (2026-09-25) Dashboard กราฟในหน้า "รายงาน" — เฉพาะ admin เท่านั้น (เหมือน getUserActivityLog)
      if (user.role !== 'admin') {
        result = { success: false, message: 'เฉพาะ admin เท่านั้นที่ดู Dashboard ผลการทำงานพนักงานได้' };
      } else {
        result = getStaffDashboardStatsHTML(contents.payload || contents, user);
      }
    }

    // บันทึกประวัติการใช้งาน (เฉพาะ action ที่อยู่ใน ACTIVITY_LOG_WHITELIST เท่านั้น —
    // ดูคอมเมนต์ที่ประกาศตัวแปรนี้ด้านบนของไฟล์ว่าทำไมถึงไม่ log ทุก action)
    var normalizedActionForLog = normalizeActivityAction_(action);
    if (ACTIVITY_LOG_WHITELIST.indexOf(normalizedActionForLog) !== -1) {
      var logPayload = contents.payload || contents.data || contents;
      logUserActivity_(
        user,
        normalizedActionForLog,
        buildActivityLogDetail_(normalizedActionForLog, logPayload, result),
        !!(result && result.success)
      );
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

// รับข้อมูลจากทั้งหน้าเว็บปัจจุบัน, payload รุ่นเก่า และ automation ภายนอก
// เพื่อไม่ให้ที่อยู่หายเพียงเพราะชื่อ property ต่างกันเล็กน้อย
function firstNonEmpty_(obj, keys) {
  obj = obj || {};
  for (var i = 0; i < keys.length; i++) {
    var value = cleanStr(obj[keys[i]]);
    if (value) return value;
  }
  return '';
}

function customerAddressNo_(cust) {
  return firstNonEmpty_(cust, ['addressno', 'address_no', 'addressNo', 'address']);
}

function customerProduct_(cust) {
  var direct = firstNonEmpty_(cust, ['product']);
  if (direct) return direct;
  var category = firstNonEmpty_(cust, ['productCategory', 'product_category']);
  var model = firstNonEmpty_(cust, ['productModel', 'product_model']);
  return [category, model].filter(function(v) { return !!v; }).join(' | ');
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
        financialInfo: r.financial_info || '{}',
        followUpLog: followUpArr,
        followUpCount: followUpArr.length,
        // (2026-09-24) ผู้สร้าง/ผู้แก้ไขล่าสุด — เดิมเขียนลงชีตแล้วแต่ไม่เคยส่งกลับหน้าเว็บ ทำให้ขึ้น "-" ตลอด
        created_by: cleanStr(r.created_by),
        createdBy: cleanStr(r.created_by),
        updated_by: cleanStr(r.updated_by),
        updatedBy: cleanStr(r.updated_by)
      };
    });
    return { success: true, totalCount: totalCount, data: formattedData };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// รายชื่อลูกค้าตามวันนัดหมายสำหรับหน้าปฏิทินติดตาม
function getFollowupCalendarHTML(reqPayload) {
  try {
    var payload = reqPayload || {};
    var startDate = formatDateStr(payload.startDate);
    var endDate = formatDateStr(payload.endDate);
    if (!startDate || !endDate) {
      return { success: false, message: 'กรุณาระบุช่วงวันที่ของปฏิทิน' };
    }

    var bookingExpr = buildRobustDateOrderExpr_('booking_date');
    var sql = "SELECT * EXCEPT(created_date, booking_date, last_followup_date), " +
              "CAST(created_date AS STRING) AS created_date, " +
              "CAST(booking_date AS STRING) AS booking_date, " +
              "CAST(last_followup_date AS STRING) AS last_followup_date, " +
              FINGERPRINT_EXPR + " AS row_key FROM " + TABLE_FULL_PATH +
              " WHERE " + bookingExpr + " BETWEEN SAFE.PARSE_DATE('%Y-%m-%d', @startDate) " +
              "AND SAFE.PARSE_DATE('%Y-%m-%d', @endDate) " +
              "ORDER BY " + bookingExpr + " ASC, first_name ASC, last_name ASC";
    var rows = runParamQueryFetch(sql, [
      { name: 'startDate', value: startDate },
      { name: 'endDate', value: endDate }
    ]);

    var data = (rows || []).map(function(r) {
      var fn = cleanStr(r.first_name || r.firstname);
      var ln = cleanStr(r.last_name || r.lastname);
      var fb = cleanStr(r.facebook);
      var line = cleanStr(r.line);
      var fullName = (fn + ' ' + ln).trim() || (fb ? '[FB] ' + fb : (line ? '[Line] ' + line : '(ไม่ระบุชื่อ)'));
      var ph = formatPhoneNumber(r.phone);
      var key = cleanStr(r.row_key) || ph || (fn + '_' + ln);
      var logs = parseFollowUpLog(r.follow_up_log);
      return {
        sheetRowIndex: key,
        raw_key: key,
        date: formatDateStr(r.created_date),
        firstname: fn,
        lastname: ln,
        name: fullName,
        phone: ph,
        phone1: ph,
        appdate: formatDateStr(r.booking_date),
        booking_date: formatDateStr(r.booking_date),
        lastFollowupDate: formatDateStr(r.last_followup_date),
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
        note: r.remark || '',
        line: line,
        facebook: fb,
        followUpLog: logs,
        followUpCount: logs.length,
        // (2026-09-24) ผู้สร้าง/ผู้แก้ไขล่าสุด — เดิมเขียนลงชีตแล้วแต่ไม่เคยส่งกลับหน้าเว็บ ทำให้ขึ้น "-" ตลอด
        created_by: cleanStr(r.created_by),
        createdBy: cleanStr(r.created_by),
        updated_by: cleanStr(r.updated_by),
        updatedBy: cleanStr(r.updated_by)
      };
    });
    return { success: true, data: data, totalCount: data.length, startDate: startDate, endDate: endDate };
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
        financialInfo: r.financial_info || '{}',
        followUpLog: followUpArr,
        followUpCount: followUpArr.length,
        // (2026-09-24) ผู้สร้าง/ผู้แก้ไขล่าสุด — เดิมเขียนลงชีตแล้วแต่ไม่เคยส่งกลับหน้าเว็บ ทำให้ขึ้น "-" ตลอด
        created_by: cleanStr(r.created_by),
        createdBy: cleanStr(r.created_by),
        updated_by: cleanStr(r.updated_by),
        updatedBy: cleanStr(r.updated_by)
      }
    };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
// เช็คว่าชื่อ Facebook นี้มีอยู่ในระบบแล้วหรือไม่ (เทียบแบบไม่สนตัวพิมพ์เล็ก/ใหญ่ และเว้นวรรคหน้า-หลัง)
// ใช้ป้องกันไม่ให้สร้างรายชื่อลูกค้าซ้ำ เวลาคนเดิมส่งเบอร์มาอีกรอบผ่าน Facebook/ManyChat
// แก้ไข (2026-09-17): เปลี่ยนจาก SELECT ผ่าน BigQuery มาอ่านตรงจาก Google Sheet แทน
// เพราะฟังก์ชันนี้ถูกเรียกใช้ทันทีก่อนจะ เพิ่ม/แก้ไข แถวในสเปรดชีตเดียวกัน (ใน addCustomerHTML)
// การอ่านตรงจากชีตจึงเห็นข้อมูลล่าสุดแน่นอน ไม่ต้องรอ BigQuery external table รีเฟรช
function findCustomerByFacebookName(fbName) {
  var cleanFb = cleanStr(fbName);
  if (!cleanFb) return null;
  var sheet = getCustomerSheet_();
  var headerMap = getCustomerHeaderMap_(sheet);
  var rowNum = findCustomerRowNumberByFacebook_(sheet, headerMap, cleanFb);
  if (rowNum === -1) return null;
  return {
    follow_up_log: sheet.getRange(rowNum, headerMap['follow_up_log']).getValue(),
    _rowNum: rowNum
  };
}

// เช็คว่าเบอร์นี้มีอยู่ในระบบแล้วหรือไม่ (รองรับทั้งแบบมี/ไม่มีเลข 0 นำหน้า เหมือน ROW_MATCH_WHERE)
// ใช้คู่กับ findCustomerByFacebookName เพื่อจับซ้ำได้ทั้งกรณี "ชื่อ Facebook เดิมแต่เบอร์เปลี่ยน"
// และกรณี "เบอร์เดิมแต่ชื่อ Facebook ไม่ตรงกัน (เช่น ใช้คนละบัญชี หรือรอบก่อนพิมพ์ชื่อผิด)"
// (2026-09-17): อ่านตรงจาก Sheet เช่นเดียวกับด้านบน ด้วยเหตุผลเดียวกัน
function findCustomerByPhoneNumber(phone) {
  var cleanPhone = formatPhoneNumber(phone);
  if (!cleanPhone) return null;
  var sheet = getCustomerSheet_();
  var headerMap = getCustomerHeaderMap_(sheet);
  var rowNum = findCustomerRowNumberByPhone_(sheet, headerMap, cleanPhone);
  if (rowNum === -1) return null;
  var rowVals = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
  return {
    follow_up_log: rowVals[headerMap['follow_up_log'] - 1],
    phone: rowVals[headerMap['phone'] - 1],
    facebook: rowVals[headerMap['facebook'] - 1],
    _rowNum: rowNum
  };
}

// บันทึกทุกครั้งที่มีการยิง action:add เข้ามา (ไม่ว่าจะสร้างลูกค้าใหม่ หรือไปชนกับของเดิม)
// ลง lead_intake_log เพื่อให้นับ "วันนี้ได้กี่เบอร์" ได้ครบ รวมที่ส่งซ้ำมาด้วย —
// ถ้า insert ตารางนี้ล้มเหลว (เช่น ยังไม่ได้รัน one-time setup สร้างตาราง) จะไม่ทำให้
// การเพิ่ม/อัปเดตลูกค้าหลักพัง แค่เขียน Logger ไว้เฉยๆ
// แก้ไข (2026-09-17 รอบที่ 3): เขียนลงแท็บ lead_intake_log ใน Sheet ก่อน แล้วค่อย
// append 1 แถวเข้า BigQuery table เดียวกัน (ดูคอมเมนต์ที่ LEAD_LOG_SHEET_NAME ด้านบนไฟล์)
function logLeadIntake_(info) {
  try {
    var now = new Date();
    var rowValues = [
      now,                                                 // received_at
      Utilities.formatDate(now, 'GMT+7', 'yyyy-MM-dd'),    // received_date
      cleanStr(info.phone),
      cleanStr(info.facebook),
      cleanStr(info.firstName),
      cleanStr(info.lastName),
      info.isDuplicate ? true : false,
      cleanStr(info.matchType),
      info.isManyChat ? true : false
    ];
    var sheet = getOrCreateSheetTab_(LEAD_LOG_SHEET_NAME, LEAD_LOG_SHEET_COLUMNS);
    sheet.appendRow(rowValues);
    try {
      appendRowToBigQueryTable_(rowValues, LEAD_LOG_SHEET_COLUMNS, LEAD_LOG_TYPE_MAP, LOG_TABLE_ID);
    } catch (syncErr) {
      Logger.log('sync lead_intake_log error: ' + syncErr);
    }
  } catch (e) {
    Logger.log('logLeadIntake_ error (ข้อมูลลูกค้าหลักถูกบันทึกไปแล้วตามปกติ ไม่กระทบ): ' + e.toString());
  }
}

// ⚠️ (2026-09-19) แก้บั๊ก: ฟังก์ชันนี้ถูกเรียกใช้จาก addCustomerHTML ด้านล่างมาตลอด แต่ไม่เคย
// ถูกนิยามไว้ในไฟล์นี้เลย — แปลว่า "ทุกครั้ง" ที่มีการเพิ่มลูกค้าใหม่ (ไม่ใช่กรณีซ้ำเบอร์/Facebook
// ที่ไปรวมเป็นการติดตามแทน) โค้ดจะโยน ReferenceError ตรง appendRow() นี้ทันที ทำให้บันทึกลูกค้า
// ใหม่ไม่สำเร็จเลยสักรายเดียวจนกว่าจะมีฟังก์ชันนี้ — เพิ่มเข้ามาให้ ณ ที่นี้
//
// สร้าง array สำหรับ appendRow() ตามตำแหน่งคอลัมน์ใน headerMap (1-based) — คีย์ใน fields ที่ไม่มี
// หัวคอลัมน์ตรงกันในชีตจะถูกข้ามไปเงียบๆ (ทำให้เพิ่มฟิลด์ optional ใหม่ๆ เช่น created_by ได้
// โดยไม่ทำให้ของเดิมพัง แม้ยังไม่ได้เพิ่มหัวคอลัมน์นั้นในชีตจริงก็ตาม)
function buildCustomerRowArray_(headerMap, fields) {
  var maxCol = 0;
  for (var k in headerMap) { if (headerMap[k] > maxCol) maxCol = headerMap[k]; }
  var row = new Array(maxCol);
  for (var i = 0; i < maxCol; i++) row[i] = '';
  for (var key in fields) {
    var col = headerMap[key];
    if (col) row[col - 1] = fields[key];
  }
  return row;
}
// (2026-09-24) ชื่อผู้ใช้ที่ใช้บันทึกลงช่อง created_by / updated_by / follow_up_log[].by
// รูปแบบ "ชื่อจริง (username)" เพื่อให้แยกคนที่ชื่อซ้ำกันได้ — ถ้า user ยังไม่มีชื่อจริง ใช้ username
// อย่างเดียว ถ้าไม่มี user เลย (เช่น lead ที่ส่งเข้ามาอัตโนมัติจาก Facebook/ManyChat) ใช้ fallbackLabel
function userDisplayLabel_(user, fallbackLabel) {
  if (!user) return fallbackLabel || '';
  var uname = cleanStr(user.username);
  var nm = cleanStr(user.name);
  if (nm && uname && nm !== uname) return nm + ' (' + uname + ')';
  return nm || uname || (fallbackLabel || '');
}

// =================================================================
// 👤 (2026-09-24 r34) ข้อมูล "ใครสร้าง / ใครแก้ไขล่าสุด / ใครคีย์การติดตาม" แบบสดจาก Google Sheet
// =================================================================
// สาเหตุที่ต้องมี: หน้าค้นหาอ่านข้อมูลจาก BigQuery ซึ่ง sync จากชีตทุก ~5 นาที (ดู
// scheduledSyncCustomersToBigQuery_) ถ้า sync ยังไม่รอบ/sync ล้มเหลว (เช่นเกินเวลา 6 นาทีของ
// Apps Script เพราะชีตมี 116,000+ แถว) คอลัมน์ created_by/updated_by ฝั่ง BigQuery จะว่าง ทำให้
// หน้าเว็บขึ้น "-" ทั้งที่ในชีตมีชื่ออยู่แล้ว — ฟังก์ชันนี้อ่านค่าตรงจากชีตให้หน้าเว็บเติมทับ
//
// payload: { items: [{ key, phone }], includeLogs: true|false } (สูงสุด 100 รายการ)
// คืนค่า: { success, data: { <phone หรือ key>: { created_by, updated_by, follow_up_log[] } } }
function phoneLookupKey_(v) {
  var d = cleanStr(v).replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^0+/, '');
  return d;
}
function getCustomerAuditHTML(payload) {
  try {
    var items = (payload && Array.isArray(payload.items)) ? payload.items.slice(0, 100) : [];
    if (!items.length && payload && (payload.phone || payload.key)) items = [{ key: payload.key, phone: payload.phone }];
    var includeLogs = !(payload && payload.includeLogs === false);
    if (!items.length) return { success: true, data: {} };

    var sheet = getCustomerSheet_();
    var headerMap = getCustomerHeaderMap_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: {} };

    // อ่านคอลัมน์เบอร์โทรทั้งคอลัมน์ครั้งเดียว (เร็วกว่าเรียก TextFinder ทีละเบอร์)
    var wanted = {};
    items.forEach(function(it) {
      var pk = phoneLookupKey_(it && it.phone);
      if (pk) wanted[pk] = true;
    });
    var phoneVals = sheet.getRange(2, headerMap['phone'], lastRow - 1, 1).getValues();
    var rowByPhone = {};
    for (var i = 0; i < phoneVals.length; i++) {
      var pk2 = phoneLookupKey_(phoneVals[i][0]);
      if (pk2 && wanted[pk2]) rowByPhone[pk2] = i + 2; // เบอร์ซ้ำหลายแถว → ใช้แถวล่าสุด (ล่างสุด)
    }

    var cbCol = headerMap['created_by'], ubCol = headerMap['updated_by'], flCol = headerMap['follow_up_log'];
    var out = {};
    items.forEach(function(it) {
      var pk = phoneLookupKey_(it && it.phone);
      var rowNum = pk ? rowByPhone[pk] : null;
      if (!rowNum && it && it.key && !pk) {
        rowNum = findCustomerRowNumberByKey_(sheet, headerMap, cleanStr(it.key), '');
        if (rowNum === -1) rowNum = null;
      }
      if (!rowNum) return;
      var rec = {
        created_by: cbCol ? cleanStr(sheet.getRange(rowNum, cbCol).getValue()) : '',
        updated_by: ubCol ? cleanStr(sheet.getRange(rowNum, ubCol).getValue()) : ''
      };
      if (includeLogs && flCol) rec.follow_up_log = parseFollowUpLog(sheet.getRange(rowNum, flCol).getValue());
      out[cleanStr(it.phone) || cleanStr(it.key)] = rec;
    });
    return { success: true, data: out };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// 🔍 ตรวจสอบปัญหา "ชื่อผู้บันทึก/ผู้แก้ไขไม่ขึ้น" — รันเองใน Apps Script editor:
// เลือกฟังก์ชัน runDiagnostic_AuditColumns จาก dropdown แล้วกด ▶ Run → ดูผลใน Execution log
function runDiagnostic_AuditColumns() {
  Logger.log('CODE_VERSION = ' + CODE_VERSION);
  var sheet = getCustomerSheet_();
  var headerMap = getCustomerHeaderMap_(sheet);
  Logger.log('ชีต: คอลัมน์ created_by = ' + headerMap['created_by'] + ', updated_by = ' + headerMap['updated_by']);
  var lastRow = sheet.getLastRow();
  var n = Math.min(500, lastRow - 1);
  if (n > 0) {
    var start = lastRow - n + 1;
    var cb = sheet.getRange(start, headerMap['created_by'], n, 1).getValues();
    var ub = sheet.getRange(start, headerMap['updated_by'], n, 1).getValues();
    var cbFilled = cb.filter(function(r) { return cleanStr(r[0]); }).length;
    var ubFilled = ub.filter(function(r) { return cleanStr(r[0]); }).length;
    Logger.log('ชีต (' + n + ' แถวล่าสุด): created_by มีค่า ' + cbFilled + ' แถว, updated_by มีค่า ' + ubFilled + ' แถว');
    Logger.log('ตัวอย่าง created_by แถวล่าสุด: "' + cleanStr(cb[cb.length - 1][0]) + '"');
  }
  try {
    var rows = runParamQueryFetch("SELECT COUNTIF(IFNULL(created_by,'') != '') AS cb, COUNTIF(IFNULL(updated_by,'') != '') AS ub, COUNT(*) AS total FROM " + TABLE_FULL_PATH, []);
    Logger.log('BigQuery: total=' + rows[0].total + ', created_by มีค่า=' + rows[0].cb + ', updated_by มีค่า=' + rows[0].ub +
               ' (ถ้าตรงนี้เป็น 0 แต่ในชีตมีค่า = BigQuery sync ไม่ทำงาน/ยังไม่รอบ)');
  } catch (e) {
    Logger.log('BigQuery: query คอลัมน์ created_by/updated_by ไม่ได้ → ตารางใน BigQuery ยังไม่มีคอลัมน์นี้ (sync ไม่สำเร็จเลยตั้งแต่เพิ่มคอลัมน์) — ' + e);
  }
  var trig = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'scheduledSyncCustomersToBigQuery_'; });
  Logger.log('trigger sync customers: ' + (trig.length ? 'มี ' + trig.length + ' ตัว' : '❌ ไม่มี (ต้องตั้ง trigger ก่อน)'));
  try {
    var t0 = Date.now();
    syncCustomerSheetToBigQuery_();
    Logger.log('✅ ทดลอง sync ชีต → BigQuery สำเร็จ ใช้เวลา ' + Math.round((Date.now() - t0) / 1000) + ' วินาที');
  } catch (e2) {
    Logger.log('❌ sync ชีต → BigQuery ล้มเหลว: ' + e2);
  }
}

function addCustomerHTML(cust, user) {
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
        loggedAt: new Date().toISOString(),
        by: userDisplayLabel_(user, 'ระบบ (Facebook/ManyChat)')
      });

      // แก้ไข (2026-09-17): เขียนกลับตรงลง Google Sheet แทนการยิง UPDATE เข้า BigQuery
      // (existing._rowNum มาจาก findCustomerByFacebookName/findCustomerByPhoneNumber
      // ด้านบน ซึ่งตอนนี้อ่านจากชีตโดยตรงแล้ว จึงรู้เลขแถวที่แน่นอนอยู่แล้ว ไม่ต้องหาใหม่)
      var sheetForDup = getCustomerSheet_();
      var headerMapForDup = getCustomerHeaderMap_(sheetForDup);
      var rowNumForDup = existing._rowNum;
      sheetForDup.getRange(rowNumForDup, headerMapForDup['follow_up_log']).setValue(JSON.stringify(logArrForDup));
      sheetForDup.getRange(rowNumForDup, headerMapForDup['booking_date']).setValue(nextDayStrForDup);
      sheetForDup.getRange(rowNumForDup, headerMapForDup['last_followup_date']).setValue(todayStrForDup);
      if (newPhoneForDup) {
        sheetForDup.getRange(rowNumForDup, headerMapForDup['phone']).setValue(newPhoneForDup);
      }
      if (fbNameForDup) {
        sheetForDup.getRange(rowNumForDup, headerMapForDup['facebook']).setValue(fbNameForDup);
      }
      // ซิงก์เข้า BigQuery native table หลังเขียน Sheet สำเร็จ (ดูคอมเมนต์ที่
      // syncCustomerSheetToBigQuery_ ด้านบนไฟล์) — ถ้า sync ล้มเหลวไม่ทำให้การบันทึกหลักพัง
      // แก้ไข (2026-09-17 รอบที่ 4): เอาการ sync แบบ synchronous (รอผลระหว่างเก็บฟอร์ม) ออก
      // เพราะชีตข้อมูลลูกค้าจริงมี 116,000+ แถว การโหลดทั้งตารางใหม่ทุกครั้งที่มีคน
      // เพิ่ม/แก้ไข/ลบ 1 รายการ จะช้ามาก (หลายสิบวินาทีขึ้นไป) จนหน้าเว็บดูเหมือนค้าง
      // เปลี่ยนไปใช้ time-driven trigger เรียก scheduledSyncCustomersToBigQuery_()
      // เป็นระยะแทน (ดูคำอธิบายที่ฟังก์ชันนั้น) — ข้อมูลใน Sheet จะเห็นล่าสุดทันที
      // เสมอ ส่วนฝั่ง BigQuery (ที่ใช้ค้นหา/รายงาน) จะตามหลังไม่กี่นาทีตาม trigger

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

    // created_at_ts: เวลาบันทึกจริงระดับวินาที ใช้เป็นตัวเรียงรองใน searchCustomersHTML
    // ตอนหลายแถวอยู่วันเดียวกัน (ดูคอมเมนต์ที่ ORDER BY ของ searchCustomersHTML)
    //
    // แก้ไข (2026-09-17): เปลี่ยนจาก INSERT SQL เข้า BigQuery มาเป็น appendRow ลง
    // Google Sheet โดยตรงแทน (ดูคอมเมนต์อธิบายที่ CUSTOMER_SHEET_ID ด้านบนไฟล์)
    var inputDate = formatDateStr(cust.date || cust.created_date) || Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
    var inputBookingDate = formatDateStr(cust.appdate || cust.booking_date);

    // ถ้าไม่ได้ระบุวันนัด/วันติดตามมา (เช่น lead จาก ManyChat ที่ไม่มีข้อมูลนี้)
    // ให้ default เป็น "วันถัดไปจากวันที่บันทึก" อัตโนมัติ เพื่อเตือนให้พนักงานโทรตามลูกค้าต่อ
    if (!inputBookingDate) {
      var followUpBase = new Date(inputDate + 'T00:00:00+07:00');
      followUpBase.setDate(followUpBase.getDate() + 1);
      inputBookingDate = Utilities.formatDate(followUpBase, 'GMT+7', 'yyyy-MM-dd');
    }

    var newCustSheet = getCustomerSheet_();
    var newCustHeaderMap = getCustomerHeaderMap_(newCustSheet);
    var newCustFields = {
      created_date: inputDate,
      first_name: cleanStr(cust.firstname || cust.firstName),
      last_name: cleanStr(cust.lastname || cust.lastName),
      phone: cleanStr(cust.phone1 || cust.phone),
      booking_date: inputBookingDate,
      type: cleanStr(cust.type || 'ลงทะเบียน'),
      product: customerProduct_(cust),
      address_no: customerAddressNo_(cust),
      moo: cleanStr(cust.moo),
      village: cleanStr(cust.village),
      subdistrict: cleanStr(cust.subdistrict),
      district: cleanStr(cust.district),
      province: cleanStr(cust.province || 'อุบลราชธานี'),
      zipcode: cleanStr(cust.zipcode),
      remark: cleanStr(cust.remark || cust.note),
      line: cleanStr(cust.line),
      facebook: cleanStr(cust.facebook),
      follow_up_log: '[]',
      financial_info: cleanStr(cust.financialInfo || cust.financial_info) || '{}',
      created_at_ts: new Date(),
      // (2026-09-19) ชื่อผู้คีย์ข้อมูลลูกค้ารายนี้เข้าระบบ — เป็นคอลัมน์ optional: ถ้ายังไม่ได้เพิ่ม
      // หัวคอลัมน์ "created_by" ในชีตจริง buildCustomerRowArray_ ด้านล่างจะข้ามค่านี้ไปเงียบๆ ไม่ error
      created_by: userDisplayLabel_(user, 'ระบบ (Facebook/ManyChat)')
    };
    newCustSheet.appendRow(buildCustomerRowArray_(newCustHeaderMap, newCustFields));
    // แก้ไข (2026-09-17 รอบที่ 4): เอาการ sync แบบ synchronous (รอผลระหว่างเก็บฟอร์ม) ออก
      // เพราะชีตข้อมูลลูกค้าจริงมี 116,000+ แถว การโหลดทั้งตารางใหม่ทุกครั้งที่มีคน
      // เพิ่ม/แก้ไข/ลบ 1 รายการ จะช้ามาก (หลายสิบวินาทีขึ้นไป) จนหน้าเว็บดูเหมือนค้าง
      // เปลี่ยนไปใช้ time-driven trigger เรียก scheduledSyncCustomersToBigQuery_()
      // เป็นระยะแทน (ดูคำอธิบายที่ฟังก์ชันนั้น) — ข้อมูลใน Sheet จะเห็นล่าสุดทันที
      // เสมอ ส่วนฝั่ง BigQuery (ที่ใช้ค้นหา/รายงาน) จะตามหลังไม่กี่นาทีตาม trigger

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
// แก้ไข (2026-09-17): เปลี่ยนจาก UPDATE SQL เข้า BigQuery มาเป็นการหาแถวในชีตด้วย
// findCustomerRowNumberByKey_ (จำลองตรรกะเดียวกับ ROW_MATCH_WHARE เดิมทุกประการ)
// แล้วเขียนทับค่าลงในเซลล์ของแถวนั้นแทน
// ป้ายชื่อฟิลด์ภาษาไทย ใช้ทำ diff แสดงใน "ประวัติการใช้งาน" (admin ดูได้) ทุกครั้งที่มีการแก้ไข
var FIELD_LABELS_TH_ = {
  first_name: 'ชื่อ', last_name: 'นามสกุล', phone: 'เบอร์โทร', booking_date: 'วันนัด',
  type: 'ประเภท', product: 'สินค้า', address_no: 'บ้านเลขที่', moo: 'หมู่ที่',
  village: 'หมู่บ้าน', subdistrict: 'ตำบล', district: 'อำเภอ', province: 'จังหวัด',
  zipcode: 'รหัสไปรษณีย์', remark: 'หมายเหตุ', line: 'LINE', facebook: 'Facebook',
  created_date: 'วันที่บันทึก'
};
// (2026-09-19) role 'sale' แก้ได้เฉพาะฟิลด์ในลิสต์นี้เท่านั้น (ชื่อ-นามสกุล + ที่อยู่ทุกส่วน)
// ตามคำขอผู้บริหาร — ฟิลด์อื่นที่ส่งมาด้วยจะถูกตัดทิ้งก่อนเขียนลงชีต (ชั้นป้องกันที่ 2
// ต่อจากหน้าเว็บที่ปิด/ซ่อนช่องพวกนี้ไว้ให้ role นี้เป็นชั้นแรกอยู่แล้ว)
var SALE_EDITABLE_FIELDS_ = ['first_name', 'last_name', 'address_no', 'moo', 'village', 'subdistrict', 'district', 'province', 'zipcode'];

function updateCustomerHTML(rowIndex, cust, phoneHint, user) {
  try {
    var rawKey = cleanStr(rowIndex || '');
    if (!rawKey) return { success: false, message: 'ไม่พบอ้างอิงรายการที่จะแก้ไข' };
    var inputDate = formatDateStr(cust.date || cust.created_date);
    var inputBookingDate = formatDateStr(cust.appdate || cust.booking_date);

    var sheet = getCustomerSheet_();
    var headerMap = getCustomerHeaderMap_(sheet);
    var rowNum = findCustomerRowNumberByKey_(sheet, headerMap, rawKey, cleanStr(phoneHint));
    if (rowNum === -1) {
      return { success: false, message: 'ไม่พบข้อมูลลูกค้ารายนี้ในชีต (อาจถูกลบไปแล้ว หรือ key ไม่ตรงกับข้อมูลปัจจุบัน)' };
    }

    var fields = {
      created_date: inputDate,
      first_name: cleanStr(cust.firstname || cust.firstName),
      last_name: cleanStr(cust.lastname || cust.lastName),
      phone: cleanStr(cust.phone1 || cust.phone),
      booking_date: inputBookingDate,
      type: cleanStr(cust.type || 'ลงทะเบียน'),
      product: customerProduct_(cust),
      address_no: customerAddressNo_(cust),
      moo: cleanStr(cust.moo),
      village: cleanStr(cust.village),
      subdistrict: cleanStr(cust.subdistrict),
      district: cleanStr(cust.district),
      province: cleanStr(cust.province || 'อุบลราชธานี'),
      zipcode: cleanStr(cust.zipcode),
      remark: cleanStr(cust.remark || cust.note),
      line: cleanStr(cust.line),
      facebook: cleanStr(cust.facebook),
      financial_info: cleanStr(cust.financialInfo || cust.financial_info) || '{}'
    };

    // จำกัดฟิลด์ที่แก้ได้จริงถ้าเป็น role 'sale' — ตัดฟิลด์อื่นทิ้งทั้งหมดก่อนเขียน
    if (user && user.role === 'sale') {
      var restrictedFields = {};
      SALE_EDITABLE_FIELDS_.forEach(function (k) { restrictedFields[k] = fields[k]; });
      fields = restrictedFields;
    }

    // เก็บ diff (ค่าเดิม → ค่าใหม่) เฉพาะฟิลด์ที่เปลี่ยนจริง เพื่อโชว์ใน "ประวัติการใช้งาน"
    // (ข้าม financial_info เพราะเป็น JSON ยาว ไม่เหมาะโชว์เป็นข้อความ diff ตรงนี้)
    var changedParts = [];
    for (var field in fields) {
      var colNum = headerMap[field];
      if (!colNum) continue;
      if (field !== 'financial_info') {
        var oldVal = cleanStr(sheet.getRange(rowNum, colNum).getValue());
        var newVal = cleanStr(fields[field]);
        if (oldVal !== newVal) {
          changedParts.push((FIELD_LABELS_TH_[field] || field) + ': "' + (oldVal || '-') + '" → "' + (newVal || '-') + '"');
        }
      }
      sheet.getRange(rowNum, colNum).setValue(fields[field]);
    }

    // (2026-09-19) บันทึกชื่อผู้แก้ไขล่าสุด — คอลัมน์ optional เช่นเดียวกับ created_by
    // (เพิ่มหัวคอลัมน์ "updated_by" ในชีตเองถ้าต้องการใช้ ไม่มีคอลัมน์นี้ก็ข้ามไปเงียบๆ ไม่ error)
    var updatedByCol = headerMap['updated_by'];
    if (updatedByCol && user) {
      sheet.getRange(rowNum, updatedByCol).setValue(userDisplayLabel_(user));
    }

    // แก้ไข (2026-09-17 รอบที่ 4): เอาการ sync แบบ synchronous (รอผลระหว่างเก็บฟอร์ม) ออก
      // เพราะชีตข้อมูลลูกค้าจริงมี 116,000+ แถว การโหลดทั้งตารางใหม่ทุกครั้งที่มีคน
      // เพิ่ม/แก้ไข/ลบ 1 รายการ จะช้ามาก (หลายสิบวินาทีขึ้นไป) จนหน้าเว็บดูเหมือนค้าง
      // เปลี่ยนไปใช้ time-driven trigger เรียก scheduledSyncCustomersToBigQuery_()
      // เป็นระยะแทน (ดูคำอธิบายที่ฟังก์ชันนั้น) — ข้อมูลใน Sheet จะเห็นล่าสุดทันที
      // เสมอ ส่วนฝั่ง BigQuery (ที่ใช้ค้นหา/รายงาน) จะตามหลังไม่กี่นาทีตาม trigger
    return {
      success: true,
      message: 'อัปเดตข้อมูลสำเร็จ',
      changedSummary: changedParts.length ? changedParts.join('; ') : 'ไม่มีการเปลี่ยนแปลงค่าใดๆ'
    };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
// แก้ไข (2026-09-17): เปลี่ยนจาก DELETE SQL เข้า BigQuery มาเป็นการหาแถวในชีตแล้ว
// ลบแถวนั้นออกจริง (deleteRow) แทน
function deleteCustomerHTML(phoneKey, phoneHint) {
  try {
    var rawKey = cleanStr(phoneKey);
    if (!rawKey) return { success: false, message: 'ไม่พบรายการที่จะลบ' };
    var sheet = getCustomerSheet_();
    var headerMap = getCustomerHeaderMap_(sheet);
    var rowNum = findCustomerRowNumberByKey_(sheet, headerMap, rawKey, cleanStr(phoneHint));
    if (rowNum === -1) {
      return { success: false, message: 'ไม่พบข้อมูลลูกค้ารายนี้ในชีต (อาจถูกลบไปแล้วก่อนหน้านี้)' };
    }
    sheet.deleteRow(rowNum);
    // แก้ไข (2026-09-17 รอบที่ 4): เอาการ sync แบบ synchronous (รอผลระหว่างเก็บฟอร์ม) ออก
      // เพราะชีตข้อมูลลูกค้าจริงมี 116,000+ แถว การโหลดทั้งตารางใหม่ทุกครั้งที่มีคน
      // เพิ่ม/แก้ไข/ลบ 1 รายการ จะช้ามาก (หลายสิบวินาทีขึ้นไป) จนหน้าเว็บดูเหมือนค้าง
      // เปลี่ยนไปใช้ time-driven trigger เรียก scheduledSyncCustomersToBigQuery_()
      // เป็นระยะแทน (ดูคำอธิบายที่ฟังก์ชันนั้น) — ข้อมูลใน Sheet จะเห็นล่าสุดทันที
      // เสมอ ส่วนฝั่ง BigQuery (ที่ใช้ค้นหา/รายงาน) จะตามหลังไม่กี่นาทีตาม trigger
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
              "first_name, last_name, phone, type, product, address_no, moo, village, subdistrict, district, province, zipcode, line, facebook, remark, created_by, updated_by " +
              "FROM " + TABLE_FULL_PATH + " ORDER BY " + buildRobustDateOrderExpr_('created_date') + " DESC, created_at_ts DESC LIMIT 50000";
    var rows = runParamQueryFetch(sql, []);
    return { success: true, data: rows };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

// =================================================================
// รายงานลูกค้าที่ "ค้างนาน" ยังไม่ได้ติดตาม (Stale Leads) — ใช้ในหน้า "รายงาน"
// =================================================================
// เกณฑ์: เทียบ "วันที่ติดตามล่าสุด" (last_followup_date) กับวันนี้ ถ้าลูกค้ารายไหน
// ไม่เคยมีการติดตามเลยสักครั้ง (last_followup_date ว่าง) จะใช้ "วันที่บันทึกครั้งแรก"
// (created_date) แทนในการเทียบ (ถือว่ายิ่งค้างหนักกว่าปกติเพราะไม่เคยติดต่อเลย)
// ไม่รวมลูกค้าที่ปิดจบแล้ว (type = 'ส่งมอบ') เพราะไม่ต้องติดตามต่อ
// payload รองรับ: { days: จำนวนวันขั้นต่ำที่ถือว่า "ค้าง" (ค่าเริ่มต้น 14) }
// เป็นรายงานอ่านอย่างเดียว (ไม่ต้องมีสิทธิ์ admin/staff เป็นพิเศษ) เหมือน
// getDashboardSummary/getDailyLeadReport — role 'sale'/'user' ก็ดูได้ตามปกติ
// และไม่ได้อยู่ใน ACTIVITY_LOG_WHITELIST เพราะเป็นแค่ดึงข้อมูลมาแสดงหน้าจอ (เหมือน
// getDashboardSummary/getInitialData ที่ตั้งใจไม่ log เช่นกัน — ดูคอมเมนต์ตรง
// ACTIVITY_LOG_WHITELIST ด้านบนของไฟล์)
function getStaleLeadsReportHTML(reqPayload) {
  try {
    var payload = reqPayload || {};
    var days = parseInt(payload.days);
    if (!days || days < 1) days = 14;
    var lastFollowupExpr = buildRobustDateOrderExpr_('last_followup_date');
    var createdExpr = buildRobustDateOrderExpr_('created_date');
    // ใช้ last_followup_date จริงถ้ามีค่า (ไม่ใช่ผ่าน buildRobustDateOrderExpr_ ที่แปลงค่าว่าง
    // เป็น 1900-01-01 อยู่แล้ว) ก่อนจะ fallback ไปที่ created_date เมื่อยังไม่เคยติดตามเลย
    var effectiveDateExpr = "IF(last_followup_date IS NULL, " + createdExpr + ", " + lastFollowupExpr + ")";
    var daysSinceExpr = "DATE_DIFF(CURRENT_DATE('Asia/Bangkok'), " + effectiveDateExpr + ", DAY)";
    var sql = "SELECT * EXCEPT(created_date, booking_date, last_followup_date), " +
              "CAST(created_date AS STRING) AS created_date, " +
              "CAST(booking_date AS STRING) AS booking_date, " +
              "CAST(last_followup_date AS STRING) AS last_followup_date, " +
              FINGERPRINT_EXPR + " as row_key, " +
              daysSinceExpr + " AS days_since_contact " +
              "FROM " + TABLE_FULL_PATH +
              " WHERE (type IS NULL OR TRIM(type) = '' OR type != 'ส่งมอบ') " +
              " AND " + daysSinceExpr + " >= " + days +
              " ORDER BY " + effectiveDateExpr + " ASC" +
              " LIMIT 300";
    var rows = runParamQueryFetch(sql, []);
    var formattedData = rows.map(function(r) {
      var row = formatCustomerRowForList_(r);
      row.daysSinceContact = parseInt(r.days_since_contact) || 0;
      row.hasEverFollowedUp = !!(r.last_followup_date && cleanStr(r.last_followup_date));
      return row;
    });
    return { success: true, data: formattedData, days: days };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}
// แปลงแถวดิบจาก BigQuery ให้เป็นรูปแบบเดียวกับที่หน้าเว็บใช้แสดงผล/เปิด modal ประวัติติดตามได้
// (คัดลอกมาจาก mapping เดิมใน searchCustomersHTML โดยตั้งใจแยกเป็นฟังก์ชันของตัวเอง
// แทนที่จะไปแก้ searchCustomersHTML ให้เรียกใช้ร่วมกัน เพื่อไม่ให้กระทบพฤติกรรมเดิมที่
// ใช้งานอยู่แล้วในหน้าประวัติ/ค้นหา)
function formatCustomerRowForList_(r) {
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
    financialInfo: r.financial_info || '{}',
    followUpLog: followUpArr,
    followUpCount: followUpArr.length,
    // (2026-09-24) ผู้สร้าง/ผู้แก้ไขล่าสุด — เดิมเขียนลงชีตแล้วแต่ไม่เคยส่งกลับหน้าเว็บ ทำให้ขึ้น "-" ตลอด
    created_by: cleanStr(r.created_by),
    createdBy: cleanStr(r.created_by),
    updated_by: cleanStr(r.updated_by),
    updatedBy: cleanStr(r.updated_by)
  };
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
    // ถูกกรองออกไปแล้วใน getDailyLeadReportHTML — ไม่ให้เห็นแถวที่ไม่ได้ถูกนับในรายการรายละเอียด)
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

    // เติมข้อมูลลูกค้าฉบับเต็มจากตาราง customers ให้รายชื่อในหน้ารายงาน
    // ใช้คิวรีเดียวต่อการเปิดรายการ (ไม่ยิงทีละคน) เพื่อให้รองรับรายการจำนวนมากได้เร็ว
    var phoneKeys = {};
    result.forEach(function(item) {
      var digits = cleanStr(item.phone).replace(/\D/g, '');
      if (digits) phoneKeys[String(parseInt(digits, 10))] = true;
    });
    var keyList = Object.keys(phoneKeys).filter(function(k) { return k && k !== 'NaN'; });
    if (keyList.length) {
      var holders = [];
      var custParams = [];
      keyList.forEach(function(k, i) {
        holders.push('@rp' + i);
        custParams.push({ name: 'rp' + i, value: k });
      });
      var customerSql = "SELECT first_name, last_name, phone, product, address_no, moo, village, " +
                        "subdistrict, district, province, zipcode, remark, line, facebook, financial_info, created_by, updated_by " +
                        "FROM " + TABLE_FULL_PATH +
                        " WHERE CAST(SAFE_CAST(REGEXP_REPLACE(CAST(phone AS STRING), r'\\D', '') AS INT64) AS STRING) " +
                        "IN (" + holders.join(',') + ")";
      var customerRows = runParamQueryFetch(customerSql, custParams) || [];
      var customerByPhone = {};
      customerRows.forEach(function(c) {
        var digits = cleanStr(c.phone).replace(/\D/g, '');
        var k = digits ? String(parseInt(digits, 10)) : '';
        if (k && !customerByPhone[k]) customerByPhone[k] = c;
      });
      result.forEach(function(item) {
        var digits = cleanStr(item.phone).replace(/\D/g, '');
        var k = digits ? String(parseInt(digits, 10)) : '';
        var c = customerByPhone[k];
        if (!c) return;
        item.firstName = c.first_name || item.firstName;
        item.lastName = c.last_name || item.lastName;
        item.product = c.product || '';
        item.addressNo = c.address_no || '';
        item.moo = c.moo || '';
        item.village = c.village || '';
        item.subdistrict = c.subdistrict || '';
        item.district = c.district || '';
        item.province = c.province || '';
        item.zipcode = c.zipcode || '';
        item.remark = c.remark || '';
        item.line = c.line || '';
        item.facebook = c.facebook || item.facebook;
        item.financialInfo = c.financial_info || '{}';
        item.created_by = cleanStr(c.created_by);
        item.updated_by = cleanStr(c.updated_by);
      });
    }

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

function addFollowUpLogHTML(rawKeyInput, entry, phoneHint, user) {
  try {
    var rawKey = cleanStr(rawKeyInput || '');
    if (!rawKey) return { success: false, message: 'ไม่พบรหัสอ้างอิงลูกค้า' };

    var noteVal = cleanStr(entry && entry.note);
    var dateVal = cleanStr(entry && entry.date);
    var followupTypeVal = cleanStr(entry && (entry.followupType || entry.contactType || entry.type));
    if (!noteVal || !dateVal || !followupTypeVal) return { success: false, message: 'กรุณาระบุวันที่ ประเภท และหมายเหตุการติดตามให้ครบ' };

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

    // แก้ไข (2026-09-17): 1) หาแถวลูกค้าในชีตด้วย key เดียวกับที่เคยใช้กับ ROW_MATCH_WHERE
    var sheet = getCustomerSheet_();
    var headerMap = getCustomerHeaderMap_(sheet);
    var rowNum = findCustomerRowNumberByKey_(sheet, headerMap, rawKey, cleanStr(phoneHint));
    if (rowNum === -1) {
      return { success: false, message: 'ไม่พบข้อมูลลูกค้าในระบบ (ถ้าเพิ่งบันทึกลูกค้าใหม่ ข้อมูลอาจยังไม่ขึ้นในชีต ลองรออีกสักครู่)' };
    }

    var followLogCol = headerMap['follow_up_log'];
    var currentRaw = sheet.getRange(rowNum, followLogCol).getValue();
    var logArr = parseFollowUpLog(currentRaw);
    logArr.push({
      date: dateVal,
      followupType: followupTypeVal,
      note: noteVal,
      loggedAt: new Date().toISOString(),
      // (2026-09-19) ชื่อผู้บันทึกการติดตามรอบนี้ — แต่ละรอบอาจคนละคนกัน จึงเก็บแยกทีละ entry
      // ในนี้เลย (ไม่ใช่คอลัมน์ระดับลูกค้า) ไม่ต้องเพิ่มหัวคอลัมน์ใดๆ ในชีต เพราะ follow_up_log
      // เก็บเป็น JSON array อยู่แล้วในคอลัมน์เดิม
      by: userDisplayLabel_(user)
    });

    // 2) เขียนกลับทั้ง array ที่อัปเดตแล้ว พร้อมอัปเดต last_followup_date (วันที่ของ
    // การติดตามรอบนี้) และ booking_date (วันนัดครั้งต่อไป) — created_date (วันที่บันทึก
    // ลูกค้าครั้งแรก) ไม่ถูกแก้ไขตรงนี้เลย ตั้งใจให้คงเดิมเสมอ
    sheet.getRange(rowNum, followLogCol).setValue(JSON.stringify(logArr));
    sheet.getRange(rowNum, headerMap['last_followup_date']).setValue(dateVal);
    sheet.getRange(rowNum, headerMap['booking_date']).setValue(nextFollowUpDate);
    // แก้ไข (2026-09-17 รอบที่ 4): เอาการ sync แบบ synchronous (รอผลระหว่างเก็บฟอร์ม) ออก
      // เพราะชีตข้อมูลลูกค้าจริงมี 116,000+ แถว การโหลดทั้งตารางใหม่ทุกครั้งที่มีคน
      // เพิ่ม/แก้ไข/ลบ 1 รายการ จะช้ามาก (หลายสิบวินาทีขึ้นไป) จนหน้าเว็บดูเหมือนค้าง
      // เปลี่ยนไปใช้ time-driven trigger เรียก scheduledSyncCustomersToBigQuery_()
      // เป็นระยะแทน (ดูคำอธิบายที่ฟังก์ชันนั้น) — ข้อมูลใน Sheet จะเห็นล่าสุดทันที
      // เสมอ ส่วนฝั่ง BigQuery (ที่ใช้ค้นหา/รายงาน) จะตามหลังไม่กี่นาทีตาม trigger

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

// รันครั้งเดียวก่อนเปิดใช้การบันทึก/แสดงข้อมูลรายได้ ทรัพย์สิน และหนี้สิน
function runOneTimeSetup_AddFinancialInfoColumn() {
  try {
    var sql = "ALTER TABLE " + TABLE_FULL_PATH + " ADD COLUMN IF NOT EXISTS financial_info STRING";
    runParamQuery(sql, []);
    Logger.log('สำเร็จ: เพิ่มคอลัมน์ financial_info ให้ตาราง customers แล้ว (หรือมีอยู่แล้วก่อนหน้านี้)');
  } catch (err) {
    Logger.log('เกิดข้อผิดพลาด: ' + err.toString());
  }
}

// =================================================================
// ⚙️ Setup ครั้งเดียว (ใหม่): สร้างตาราง user_activity_log สำหรับเก็บประวัติการใช้งาน
// =================================================================
// วิธีรัน: เหมือนขั้นตอนด้านบน — เลือกฟังก์ชัน
// "runOneTimeSetup_CreateUserActivityLogTable" จาก dropdown ข้างปุ่ม ▶ Run แล้วกดรัน
// เช็คแท็บ "Executions" ว่าขึ้น "สำเร็จ" ก่อนใช้งานจริง (ก่อนรันขั้นนี้ ระบบจะยังทำงาน
// ปกติทุกอย่าง แค่การบันทึก log จะ error เงียบๆ ใน Logger เฉยๆ ไม่กระทบผู้ใช้งานเลย —
// แต่หน้า "📋 ประวัติการใช้งาน" จะยังไม่มีข้อมูลจนกว่าจะรันขั้นนี้)
// รันครั้งเดียวพอ ไม่ต้องรันซ้ำอีกถ้าสำเร็จแล้ว (ใช้ CREATE TABLE IF NOT EXISTS
// ป้องกัน error ถ้าเผลอรันซ้ำ)
function runOneTimeSetup_CreateUserActivityLogTable() {
  try {
    var sql = "CREATE TABLE IF NOT EXISTS " + ACTIVITY_LOG_TABLE_FULL_PATH + " (" +
      "logged_at TIMESTAMP, " +
      "log_date DATE, " +
      "username STRING, " +
      "role STRING, " +
      "action STRING, " +
      "detail STRING, " +
      "is_success BOOL" +
      ") PARTITION BY log_date";
    runParamQuery(sql, []);
    Logger.log('สำเร็จ: สร้างตาราง ' + ACTIVITY_LOG_TABLE_ID + ' แล้ว (หรือมีอยู่แล้วก่อนหน้านี้)');
  } catch (err) {
    Logger.log('เกิดข้อผิดพลาด: ' + err.toString());
  }
}

// =================================================================
// ⚙️ Setup ครั้งเดียว (กู้คืน/ป้องกันเหตุซ้ำ): ดึง user ทั้งหมดที่มีอยู่จริงใน BigQuery
// (ตาราง users) กลับมาใส่ไว้ในแท็บ Google Sheet "users" ให้ครบ
// =================================================================
// ทำไมต้องมีฟังก์ชันนี้: ตั้งแต่ 2026-09-17 ระบบเปลี่ยนมาถือ Google Sheet เป็นข้อมูล
// ต้นทางของ users แล้วซิงก์เข้า BigQuery แบบ WRITE_TRUNCATE ทุกครั้งที่เพิ่มสมาชิก
// (ดูคอมเมนต์ที่ assertSafeRowCountForTruncateSync_ ด้านบนไฟล์ — เป็นสาเหตุที่ user เดิม
// หายไปหมดเหลือแต่ admin) เพราะตอน migration ไม่ได้ backfill user เดิมจาก BigQuery
// เข้า Sheet ก่อน ฟังก์ชันนี้แก้ที่ต้นเหตุนั้น โดยดึง user ที่ "ยังเหลืออยู่จริง" ใน
// BigQuery ตอนนี้ กลับไปเติมใน Sheet ให้ครบ (เพิ่มเฉพาะ username ที่ Sheet ยังไม่มี
// เทียบแบบไม่สนตัวพิมพ์เล็ก/ใหญ่ — ปลอดภัยที่จะรันซ้ำได้หลายครั้ง ไม่ทำให้ข้อมูลซ้ำ)
//
// ⚠️ ถ้า user ที่หายไปแล้วถูก TRUNCATE ทับไปจริงๆ (ไม่เหลือใน BigQuery แล้ว) ฟังก์ชันนี้
// กู้คืนให้ไม่ได้ — ต้องกู้จาก BigQuery time travel (ปกติย้อนได้ 7 วัน ใช้
// FOR SYSTEM_TIME AS OF ตอน query) หรือจาก backup ก่อน แล้วค่อยรันฟังก์ชันนี้อีกครั้ง
// เพื่อดึงเข้า Sheet ให้ครบ
//
// วิธีรัน: เลือกฟังก์ชัน "runOneTimeSetup_BackfillUsersFromBigQuery_" จาก dropdown ข้าง
// ปุ่ม ▶ Run (เรียกใช้) ที่แถบด้านบน แล้วกด ▶ Run > เช็คแท็บ "Executions" ว่าขึ้น
// "สำเร็จ" ก่อนใช้งานเมนู "เพิ่มสมาชิก" ต่อ — แนะนำให้รันฟังก์ชันนี้ก่อนเสมอหลัง deploy
// โค้ดชุดนี้ครั้งแรก แม้จะยังไม่เจอปัญหา user หายก็ตาม (กันไว้ก่อนเกิดเหตุ)
function runOneTimeSetup_BackfillUsersFromBigQuery_() {
  try {
    var sql = "SELECT user_id, username, password_hash, role, status FROM `" +
      GCP_PROJECT_ID + "." + DATASET_ID + ".users`";
    var bqRows = runParamQueryFetch(sql, []);
    if (!bqRows || !bqRows.length) {
      Logger.log('ไม่พบ user เลยใน BigQuery ตาราง users ตอนนี้ (ถ้าเพิ่งถูกบั๊กเดิมลบไป ' +
        'ให้กู้จาก time travel/backup ก่อน แล้วรันฟังก์ชันนี้ใหม่อีกครั้ง — ไม่มีอะไรให้ backfill ตอนนี้)');
      return;
    }

    var usersSheet = getOrCreateSheetTab_(USERS_SHEET_NAME, USERS_SHEET_COLUMNS);
    var usersHeaderMap = buildHeaderMapForColumns_(usersSheet, USERS_SHEET_COLUMNS);
    var lastRow = usersSheet.getLastRow();
    var existingUsernames = {};
    if (lastRow > 1) {
      var usernameCol = usersHeaderMap['username'];
      var existingVals = usersSheet.getRange(2, usernameCol, lastRow - 1, 1).getValues();
      existingVals.forEach(function(r) {
        var u = (r[0] || '').toString().trim().toLowerCase();
        if (u) existingUsernames[u] = true;
      });
    }

    var rowsToAppend = [];
    bqRows.forEach(function(row) {
      var uname = (row.username || '').toString().trim().toLowerCase();
      if (!uname || existingUsernames[uname]) return; // มีอยู่แล้วใน Sheet ข้าม ไม่ใส่ซ้ำ
      rowsToAppend.push(USERS_SHEET_COLUMNS.map(function(c) {
        return (row[c] !== undefined && row[c] !== null) ? row[c] : '';
      }));
      existingUsernames[uname] = true; // กันซ้ำกันเองถ้า BigQuery มี username ซ้ำหลายแถว
    });

    if (rowsToAppend.length === 0) {
      Logger.log('ไม่มี user ใหม่ที่ต้อง backfill (Sheet มีครบแล้วเทียบกับ BigQuery ที่อ่านได้ตอนนี้)');
      return;
    }

    usersSheet.getRange(usersSheet.getLastRow() + 1, 1, rowsToAppend.length, USERS_SHEET_COLUMNS.length)
      .setValues(rowsToAppend);

    Logger.log('สำเร็จ: backfill user จาก BigQuery เข้า Sheet แล้ว ' + rowsToAppend.length + ' คน — ' +
      'ตรวจสอบแท็บ "users" ใน Google Sheet ให้ครบก่อนใช้งานเมนู "เพิ่มสมาชิก" ต่อ');
  } catch (err) {
    Logger.log('เกิดข้อผิดพลาด: ' + err.toString());
  }
}

// =================================================================
// ⚙️ Helper (2026-09-18): เพิ่ม/แก้ user ตรงๆ จาก Apps Script โดยไม่ต้องผ่านหน้าเว็บแอป
// =================================================================
// ⚠️ อย่าเพิ่ม/แก้ user โดยพิมพ์ลง BigQuery Console ตรงๆ อีก (เป็นสาเหตุที่เพิ่งเจอปัญหา
// login ไม่ได้) เพราะ 2 เหตุผล:
//   1) ตาราง users ใน BigQuery ตอนนี้เป็นแค่ "กระจก" (mirror) ที่ถูกเขียนทับใหม่ทั้งหมด
//      (WRITE_TRUNCATE) จาก Google Sheet แท็บ "users" ทุกครั้งที่มีคนกด "เพิ่มสมาชิก" ใน
//      แอป — user ที่เพิ่มตรงๆ ใน BigQuery แต่ไม่มีอยู่ใน Sheet ด้วย จะถูกลบทิ้งอีกครั้ง
//      ในการ sync รอบถัดไป (ถ้าจำนวนที่ลดลงไม่เกิน 50% จะไม่ถูก safety guard บล็อกด้วย)
//   2) password_hash ต้องเป็นผลลัพธ์จาก sha256Hex_() ของรหัสผ่านเป๊ะๆ ทุกตัวอักษร ถ้า
//      คำนวณเองด้วยเครื่องมืออื่น (เว็บ sha256 ออนไลน์, คำสั่ง echo ใน terminal ที่มักแอบ
//      เติม "\n" ต่อท้ายให้อัตโนมัติ) hash จะไม่ตรงกัน login ไม่ได้ทั้งที่ข้อมูลอื่นถูกหมด
//
// ฟังก์ชันนี้เขียนเข้า Google Sheet แท็บ "users" ให้ถูกต้องเสมอ (คำนวณ hash ด้วย
// sha256Hex_ ตัวเดียวกับที่หน้าเว็บใช้จริง) แล้วซิงก์เข้า BigQuery ให้เสร็จในตัวเลย —
// ปลอดภัยกว่าพิมพ์ลง BigQuery Console ตรงๆ 100% ใช้ได้ทั้งเพิ่มใหม่และแก้ของเดิม
//
// วิธีใช้: แก้ 3 ค่า username / plainPassword / role ด้านในฟังก์ชันด้านล่างนี้ชั่วคราว
// ให้ตรงกับที่ต้องการ (ถ้า username มีอยู่แล้วจะ "แก้" password/role/status ให้ ถ้ายังไม่
// มีจะ "เพิ่ม" ใหม่) > เลือกฟังก์ชัน "runOneTimeSetup_AddOrFixUserDirectly_" จาก dropdown
// ข้างปุ่ม ▶ Run แล้วกดรัน > เช็ค Logger ว่าขึ้น "สำเร็จ" > ลอง login ด้วย username/
// password ที่ตั้งไว้ได้เลย (แนะนำให้ตั้งค่ากลับเป็นค่า placeholder เดิมหลังใช้เสร็จ กัน
// เผลอรันซ้ำโดยไม่ได้ตั้งใจ)
function runOneTimeSetup_AddOrFixUserDirectly() {
  var username = 'admin'.toLowerCase();          // 👈 แก้ username ที่ต้องการที่นี่
  var plainPassword = 'rst311728it';   // 👈 แก้รหัสผ่าน (อย่างน้อย 6 ตัวอักษร)
  var role = 'admin';                             // 👈 แก้ role ที่ต้องการ (admin / staff / sale)

  if (!username || !plainPassword || plainPassword.length < 6) {
    Logger.log('กรุณากรอก username และ password (อย่างน้อย 6 ตัวอักษร) ให้ครบก่อนรัน');
    return;
  }

  var usersSheet = getOrCreateSheetTab_(USERS_SHEET_NAME, USERS_SHEET_COLUMNS);
  var usersHeaderMap = buildHeaderMapForColumns_(usersSheet, USERS_SHEET_COLUMNS);
  var lastRow = usersSheet.getLastRow();
  var passwordHash = sha256Hex_(plainPassword);
  var targetRowIndex = -1;

  if (lastRow > 1) {
    var usernameCol = usersHeaderMap['username'];
    var existingUsernames = usersSheet.getRange(2, usernameCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < existingUsernames.length; i++) {
      if ((existingUsernames[i][0] || '').toString().trim().toLowerCase() === username) {
        targetRowIndex = i + 2; // แถวจริงใน Sheet (แถว 1 เป็นหัวตาราง)
        break;
      }
    }
  }

  if (targetRowIndex === -1) {
    // ยังไม่มี username นี้ใน Sheet — เพิ่มแถวใหม่
    usersSheet.appendRow(USERS_SHEET_COLUMNS.map(function(c) {
      if (c === 'user_id') return Utilities.getUuid();
      if (c === 'username') return username;
      if (c === 'password_hash') return passwordHash;
      if (c === 'role') return role;
      if (c === 'status') return 'active';
      return '';
    }));
    Logger.log('เพิ่ม user "' + username + '" ใหม่ใน Sheet แล้ว');
  } else {
    // มีอยู่แล้ว (เช่น แถวที่เพิ่มตรงเข้า BigQuery ไปก่อนหน้านี้) — แก้ให้ถูกต้องตามที่ตั้งไว้
    usersSheet.getRange(targetRowIndex, usersHeaderMap['password_hash']).setValue(passwordHash);
    usersSheet.getRange(targetRowIndex, usersHeaderMap['role']).setValue(role);
    usersSheet.getRange(targetRowIndex, usersHeaderMap['status']).setValue('active');
    Logger.log('แก้ไข user "' + username + '" ที่มีอยู่แล้วใน Sheet ให้ถูกต้องตามที่ตั้งไว้แล้ว');
  }

  syncSheetTabToBigQueryTable_(USERS_SHEET_NAME, USERS_SHEET_COLUMNS, USERS_TYPE_MAP, 'users');
  Logger.log('สำเร็จ: ซิงก์เข้า BigQuery แล้ว ลอง login ด้วย username="' + username + '" ได้เลย');
}

// =================================================================
// 🔍 Debug (2026-09-18): เทียบ password_hash ที่เก็บจริงใน BigQuery กับ hash ที่คำนวณ
// จากรหัสผ่านที่ตั้งใจจะใช้ login — ใช้หาสาเหตุตอน login ไม่ผ่านทั้งที่รันฟังก์ชันเพิ่ม/
// แก้ user ไปแล้ว (เช่น รันฟังก์ชันสำเร็จแต่ sync เข้า BigQuery ไม่ทัน/ล้มเหลวเงียบๆ หรือ
// พิมพ์รหัสผ่านตอน login ผิดจากที่ตั้งไว้ตอนรันฟังก์ชัน)
//
// วิธีใช้: แก้ username / testPassword ด้านในให้ตรงกับที่กำลังจะลอง login จริง (ตัวพิมพ์
// เล็ก-ใหญ่ต้องตรงเป๊ะ) > เลือกฟังก์ชัน "debugCompareUserPasswordHash_" จาก dropdown ▶ Run
// แล้วกดรัน > ดูผลที่แท็บ Executions — ถ้าขึ้น "✅ ตรงกัน" แปลว่า login ควรผ่านแน่นอน (ถ้า
// ยัง login ไม่ได้ ปัญหาน่าจะอยู่ที่หน้าเว็บ/deploy ไม่ใช่ข้อมูล) ถ้าขึ้น "❌ ไม่ตรงกัน" ให้
// ดู hash ทั้ง 2 ค่าที่ print ออกมาเทียบกัน แล้วรัน runOneTimeSetup_AddOrFixUserDirectly_
// ใหม่อีกครั้งด้วยรหัสผ่านเดียวกับที่ตั้งไว้ใน testPassword นี้เป๊ะๆ
function debugCompareUserPasswordHash_() {
  var username = 'admin'.toLowerCase();   // 👈 ใส่ username ที่จะลอง login
  var testPassword = 'รหัสผ่านที่จะลอง login'; // 👈 ใส่รหัสผ่านที่ "จะพิมพ์ตอน login จริง" ให้ตรงเป๊ะ

  try {
    var sql = "SELECT username, password_hash, role, status FROM `" +
      GCP_PROJECT_ID + "." + DATASET_ID + ".users` WHERE username = @username LIMIT 1";
    var rows = runParamQueryFetch(sql, [{ name: 'username', value: username }]);

    if (!rows.length) {
      Logger.log('❌ ไม่พบ username "' + username + '" ใน BigQuery เลย — ต้องรัน ' +
        'runOneTimeSetup_AddOrFixUserDirectly_ ก่อน (หรือเช็คว่า sync ล้มเหลวหรือไม่)');
      return;
    }

    var row = rows[0];
    var storedHash = String(row.password_hash || '').trim();
    var computedHash = sha256Hex_(testPassword);
    var status = String(row.status || '').trim().toLowerCase();

    Logger.log('username ที่พบใน BigQuery: "' + row.username + '"');
    Logger.log('role: "' + row.role + '" | status: "' + row.status + '"');
    Logger.log('password_hash ที่เก็บอยู่จริงใน BigQuery: ' + storedHash);
    Logger.log('hash ที่คำนวณจาก testPassword ("' + testPassword + '"): ' + computedHash);

    if (status !== 'active') {
      Logger.log('⚠️ status ไม่ใช่ "active" (เป็น "' + row.status + '") — login จะไม่ผ่านแม้ password ตรง');
    }
    if (storedHash.toLowerCase() === computedHash.toLowerCase() || storedHash === testPassword) {
      Logger.log('✅ ตรงกัน — password ถูกต้อง ถ้า login ไม่ผ่านอีก ปัญหาน่าจะอยู่ที่หน้าเว็บ/deploy');
    } else {
      Logger.log('❌ ไม่ตรงกัน — password_hash ใน BigQuery กับ testPassword ที่ตั้งไว้ไม่ตรงกัน ' +
        'ให้รัน runOneTimeSetup_AddOrFixUserDirectly_ ใหม่ด้วยรหัสผ่านเดียวกับ testPassword นี้เป๊ะๆ');
    }
  } catch (e) {
    Logger.log('เกิดข้อผิดพลาด: ' + e.toString());
  }
}

// =================================================================
// ⚙️ Helper (2026-09-18): ลบ user ออกจากระบบ (Sheet + BigQuery) อย่างปลอดภัย
// =================================================================
// ⚠️ อย่าลบแถวใน BigQuery Console ตรงๆ (ทำไม่ได้อยู่แล้วเพราะ DML ถูกบล็อก — แต่ถ้าลบผ่าน
// วิธีอื่น เช่น export/reload ตาราง ก็จะเจอปัญหาเดิม: ตาราง users เป็นแค่กระจกจาก Sheet
// พอมีคนกด "เพิ่มสมาชิก" ในแอปครั้งถัดไป ข้อมูลจะกลับมาเหมือนเดิมเพราะ Sheet ยังมีอยู่)
// ฟังก์ชันนี้ลบออกจาก Sheet ก่อน (ต้นทางจริง) แล้วซิงก์เข้า BigQuery ให้ตรงกันทันที
//
// วิธีใช้: แก้ username ด้านในให้ตรงกับที่ต้องการลบ > เลือกฟังก์ชัน
// "runOneTimeSetup_DeleteUserByUsername_" จาก dropdown ▶ Run แล้วกดรัน > เช็ค Logger
// ว่าขึ้น "สำเร็จ" — ลบแล้วกู้คืนไม่ได้ (ยกเว้นไปดึงจาก BigQuery time travel เอาเอง)
// ⚠️ ถ้าตั้งใจจะ "แก้รหัสผ่าน/role" ของ user เดิม ไม่ต้องลบ — ใช้
// runOneTimeSetup_AddOrFixUserDirectly_ แทน จะปลอดภัยกว่าและขั้นตอนน้อยกว่า
function runOneTimeSetup_DeleteUserByUsername_() {
  var username = 'ใส่ username ที่ต้องการลบตรงนี้'.toLowerCase(); // 👈 แก้ตรงนี้

  var usersSheet = getOrCreateSheetTab_(USERS_SHEET_NAME, USERS_SHEET_COLUMNS);
  var usersHeaderMap = buildHeaderMapForColumns_(usersSheet, USERS_SHEET_COLUMNS);
  var lastRow = usersSheet.getLastRow();

  if (lastRow <= 1) {
    Logger.log('ไม่มี user อยู่ใน Sheet เลย ไม่มีอะไรให้ลบ');
    return;
  }

  var usernameCol = usersHeaderMap['username'];
  var existingUsernames = usersSheet.getRange(2, usernameCol, lastRow - 1, 1).getValues();
  var targetRowIndex = -1;
  for (var i = 0; i < existingUsernames.length; i++) {
    if ((existingUsernames[i][0] || '').toString().trim().toLowerCase() === username) {
      targetRowIndex = i + 2; // แถวจริงใน Sheet (แถว 1 เป็นหัวตาราง)
      break;
    }
  }

  if (targetRowIndex === -1) {
    Logger.log('ไม่พบ username "' + username + '" ใน Sheet — ไม่มีอะไรให้ลบ ' +
      '(ถ้า user นี้เพิ่งถูกเพิ่มตรงเข้า BigQuery โดยไม่ผ่าน Sheet ให้ไปลบที่ BigQuery แยก ' +
      'หรือปล่อยไว้เฉยๆ ก็ได้ เพราะ sync รอบถัดไปจะลบให้เองอยู่แล้วถ้าลดไม่เกิน 50%)');
    return;
  }

  usersSheet.deleteRow(targetRowIndex);
  Logger.log('ลบ user "' + username + '" ออกจาก Sheet แล้ว');

  syncSheetTabToBigQueryTable_(USERS_SHEET_NAME, USERS_SHEET_COLUMNS, USERS_TYPE_MAP, 'users');
  Logger.log('สำเร็จ: ซิงก์เข้า BigQuery แล้ว — user "' + username + '" ถูกลบออกจากระบบเรียบร้อย');
}

// ฟังก์ชันช่วย debug: พิมพ์ schema จริงของตาราง users ออกทาง Logger เพื่อดูว่ามีคอลัมน์
// อะไรบ้าง คอลัมน์ไหนเป็น REQUIRED — ใช้ตอนสงสัยว่าทำไม addUserHTML ยัง error เรื่อง
// คอลัมน์ required อยู่ (เลือกฟังก์ชันนี้จาก dropdown ▶ Run แล้วเปิดแท็บ Executions ดูผล)
function debugPrintUsersTableSchema() {
  var fields = getUsersTableSchema_();
  if (!fields.length) {
    Logger.log('ไม่พบ schema เลย (หรือ query ล้มเหลว) — เช็ค Logger ด้านบนถ้ามี error ของ getUsersTableSchema_');
    return;
  }
  fields.forEach(function(f) {
    Logger.log('คอลัมน์: ' + f.name + ' | ชนิด: ' + f.type + ' | mode: ' + f.mode);
  });
}

function testDailyLeadReportDirect() {
  var result = getDailyLeadReportHTML({
    startDate: '2026-08-08',
    endDate: '2026-08-08',
    onlyManyChat: false
  });

  Logger.log(JSON.stringify(result));
}