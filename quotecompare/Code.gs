/**
 * QuoteCompare — ระบบเปรียบเทียบราคาใบเสนอราคาตามใบขอซื้อ (Google Apps Script)
 * -----------------------------------------------------------
 * วิธีติดตั้ง
 * 1) เปิด Google ชีตที่ต้องการใช้เก็บข้อมูล (หรือสร้างชีตใหม่)
 * 2) เมนู ส่วนขยาย (Extensions) > Apps Script
 * 3) ลบโค้ดเดิมในไฟล์ Code.gs แล้ววางไฟล์นี้ทั้งหมดแทน
 * 4) สร้างไฟล์ใหม่ชนิด HTML ชื่อ "index" (ต้องชื่อ index เป๊ะๆ) แล้ววางเนื้อหาไฟล์ index.html ที่ให้มาคู่กัน
 * 5) กด Deploy > New deployment > เลือกประเภท "Web app"
 *    - Execute as: Me
 *    - Who has access: เลือกตามที่ต้องการ (เช่น "Anyone within [องค์กร]")
 * 6) กด Deploy แล้วอนุญาตสิทธิ์การเข้าถึง จะได้ลิงก์เว็บแอปสำหรับแจกจ่ายให้ทีมจัดซื้อ
 * 7) ตั้งค่า Gemini API Key (สำหรับอ่านไฟล์ PDF/รูปภาพ/Excel อัตโนมัติ):
 *    ขอฟรีที่ aistudio.google.com/apikey แล้วไปที่ Project Settings > Script Properties
 *    เพิ่ม Property ชื่อ GEMINI_API_KEY
 *
 * ไม่มีระบบล็อกอิน — ใครเปิดลิงก์เว็บแอปนี้ก็ใช้งานได้ทันที
 * ข้อมูลใบขอซื้อ/ใบเปรียบเทียบราคาทั้งหมดจะถูกเก็บลงชีตชื่อ "RFQs" ในสเปรดชีตนี้
 * (ระบบจะสร้างชีตนี้ให้อัตโนมัติในการบันทึกครั้งแรก)
 *
 * หมายเหตุการอัปเกรด: โครงสร้างคอลัมน์เวอร์ชันนี้เปลี่ยนจากเวอร์ชันก่อนหน้า (ตัดระบบผู้ใช้/อนุมัติออก)
 * ถ้าแท็บ "RFQs" เดิมมีข้อมูลทดสอบอยู่ แนะนำให้ลบหรือเปลี่ยนชื่อแท็บนั้นทิ้งก่อน แล้วให้ระบบสร้างใหม่
 * เพื่อให้โครงสร้างคอลัมน์ตรงกับเวอร์ชันนี้
 */

var SHEET_NAME = 'RFQs';
var HEADERS = [
  'id', 'title', 'prNumber', 'preparedBy', 'createdAt', 'status',
  'itemsJson', 'notes', 'completedBy', 'completedAt', 'selectionsJson', 'referencePrice'
];
/* เปลี่ยนรุ่นโมเดลได้ที่นี่ เช่น 'gemini-3.5-flash-lite' ถ้าต้องการรุ่นใหม่กว่า/เร็วกว่า */
var GEMINI_MODEL = 'gemini-2.5-flash';

function doGet(e) {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('QuoteCompare')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function rowToRecord_(row) {
  return {
    id: row[0],
    title: row[1],
    prNumber: row[2] || '',
    preparedBy: row[3] || '',
    createdAt: row[4],
    status: row[5] || 'draft',
    items: row[6] ? JSON.parse(row[6]) : [],
    notes: row[7] || '',
    completedBy: row[8] || '',
    completedAt: row[9] || '',
    selections: row[10] ? JSON.parse(row[10]) : {},
    referencePrice: row[11] || ''
  };
}

function recordToRow_(r) {
  return [
    r.id,
    r.title || '',
    r.prNumber || '',
    r.preparedBy || '',
    r.createdAt || '',
    r.status || 'draft',
    JSON.stringify(r.items || []),
    r.notes || '',
    r.completedBy || '',
    r.completedAt || '',
    JSON.stringify(r.selections || {}),
    r.referencePrice || ''
  ];
}

/** คืนรายการสรุปทั้งหมด (สำหรับหน้ารายการ) เรียงจากใหม่ไปเก่า */
function getIndex() {
  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;
    var itemCount = 0;
    try { itemCount = row[6] ? JSON.parse(row[6]).length : 0; } catch (err) { itemCount = 0; }
    var vendorCount = 0;
    try {
      var items = row[6] ? JSON.parse(row[6]) : [];
      var names = {};
      items.forEach(function (it) {
        (it.vendors || []).forEach(function (v) { if (v.vendorName && v.vendorName.trim()) names[v.vendorName.trim()] = true; });
      });
      vendorCount = Object.keys(names).length;
    } catch (err) { vendorCount = 0; }
    out.push({
      id: row[0],
      title: row[1],
      prNumber: row[2],
      preparedBy: row[3],
      createdAt: row[4],
      status: row[5],
      itemCount: itemCount,
      vendorCount: vendorCount
    });
  }
  out.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return out;
}

/** คืนข้อมูลเต็มของใบขอซื้อ/ใบเปรียบเทียบราคาใบเดียว */
function getRfq(id) {
  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === id) return rowToRecord_(values[i]);
  }
  return null;
}

/** บันทึก (สร้างใหม่ หรืออัปเดต) ใบขอซื้อ/ใบเปรียบเทียบราคา — ใช้ LockService กันเขียนชนกัน */
function saveRfq(record) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_();
    var values = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === record.id) { rowIndex = i + 1; break; }
    }
    var rowValues = recordToRow_(record);
    if (rowIndex === -1) {
      sheet.appendRow(rowValues);
    } else {
      sheet.getRange(rowIndex, 1, 1, HEADERS.length).setValues([rowValues]);
    }
    return { ok: true, id: record.id };
  } finally {
    lock.releaseLock();
  }
}

/** ลบใบขอซื้อ 1 รายการ */
function deleteRfq(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === id) { sheet.deleteRow(i + 1); break; }
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ---------- อ่านใบเสนอราคาจากไฟล์ (PDF / รูปภาพ / Excel / CSV) ด้วย Gemini AI ----------
 * ต้องตั้งค่า Script Property ชื่อ GEMINI_API_KEY ก่อนใช้งาน:
 *   1) ขอ API key ฟรีได้ที่ https://aistudio.google.com/apikey
 *   2) ในหน้า Apps Script: ไอคอนเฟือง "การตั้งค่าโปรเจกต์" (Project Settings)
 *      > เลื่อนลงไปที่ "Script Properties" > Add script property
 *      > Property: GEMINI_API_KEY   Value: <คีย์ที่ได้มา>
 */
function getGeminiApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    throw new Error(
      'ยังไม่ได้ตั้งค่า Gemini API Key — ไปที่ Project Settings (ไอคอนเฟือง) > Script Properties ' +
      'แล้วเพิ่มคีย์ชื่อ GEMINI_API_KEY (ขอฟรีได้ที่ aistudio.google.com/apikey)'
    );
  }
  return key;
}

function quoteExtractSchema_() {
  return {
    type: 'OBJECT',
    properties: {
      vendorName: { type: 'STRING' },
      paymentTerms: { type: 'STRING' },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            code: { type: 'STRING' },
            name: { type: 'STRING' },
            unit: { type: 'STRING' },
            qty: { type: 'NUMBER' },
            unitPrice: { type: 'NUMBER' },
            leadTimeDays: { type: 'NUMBER' },
            warrantyMonths: { type: 'NUMBER' },
            shippingCost: { type: 'NUMBER' },
            vatIncluded: { type: 'BOOLEAN' }
          },
          required: ['name', 'unitPrice']
        }
      }
    },
    required: ['vendorName', 'items']
  };
}

function purchaseRequestExtractSchema_() {
  return {
    type: 'OBJECT',
    properties: {
      prNumber: { type: 'STRING' },
      title: { type: 'STRING' },
      requestedBy: { type: 'STRING' },
      department: { type: 'STRING' },
      neededDate: { type: 'STRING' },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            code: { type: 'STRING' },
            name: { type: 'STRING' },
            unit: { type: 'STRING' },
            qty: { type: 'NUMBER' }
          },
          required: ['name']
        }
      }
    },
    required: ['items']
  };
}

function quoteExtractInstructions_() {
  return 'อ่านเอกสารใบเสนอราคา (quotation) จากผู้ขายรายหนึ่งอย่างละเอียด แล้วดึงข้อมูลต่อไปนี้ออกมา:\n' +
    '- ชื่อบริษัท/ผู้ขายที่ออกใบเสนอราคา\n' +
    '- เงื่อนไขการชำระเงิน (ถ้าระบุ)\n' +
    '- รายการสินค้าทุกรายการ พร้อม: รหัสสินค้า (ถ้ามีระบุในเอกสาร), ชื่อสินค้า, หน่วยนับ, จำนวน, ราคาต่อหน่วย, ' +
    'ระยะเวลาส่งมอบเป็นจำนวนวัน (ถ้าระบุ), ระยะเวลารับประกันเป็นจำนวนเดือน (ถ้าระบุ), ' +
    'ค่าจัดส่งแยกต่างหาก (ถ้ามี), และราคานี้รวมภาษีมูลค่าเพิ่ม 7% แล้วหรือยัง\n' +
    'ห้ามเดาตัวเลขที่ไม่ปรากฏในเอกสาร ถ้าไม่มีข้อมูลส่วนใดให้เว้นว่างหรือใส่ 0 ตอบกลับเป็น JSON ตามโครงสร้างที่กำหนดเท่านั้น';
}

function purchaseRequestInstructions_() {
  return 'นี่คือ "ใบขอซื้อ" (Purchase Request) ภายในองค์กร อ่านเอกสารนี้แล้วดึงข้อมูลต่อไปนี้:\n' +
    '- เลขที่ใบขอซื้อ\n' +
    '- โครงการ หรือวัตถุประสงค์การขอซื้อ (ใช้เป็นชื่อเรื่อง)\n' +
    '- ผู้ขอซื้อ/ผู้รับผิดชอบ\n' +
    '- แผนกที่ขอซื้อ\n' +
    '- วันที่ต้องการสินค้า (ถ้าระบุ)\n' +
    '- รายการสินค้าทุกรายการที่ขอซื้อ พร้อม: รหัสสินค้า (ถ้ามี), ชื่อสินค้า, จำนวน, หน่วยนับ\n\n' +
    'สำคัญมากเรื่องคอลัมน์ "จำนวน": ตารางในใบขอซื้ออาจมีหลายคอลัมน์ตัวเลขปนกัน เช่น ' +
    '"จำนวนสต็อกขั้นต่ำ", "จำนวนคงเหลือ" — คอลัมน์เหล่านี้ไม่ใช่จำนวนที่ต้องการ ห้ามนำมาใช้เด็ดขาด ' +
    'ให้ดึงเฉพาะค่าจากคอลัมน์ที่หมายถึงจำนวนที่สั่งซื้อจริงเท่านั้น เช่น "จำนวนสั่งซื้อ" หรือถ้าตารางมีคอลัมน์ "จำนวน" ' +
    'เพียงคอลัมน์เดียวโดยไม่มีคอลัมน์สต็อก/คงเหลืออื่นปน ก็ให้ใช้คอลัมน์นั้น หากมีทั้ง "จำนวนสั่งซื้อ" และคอลัมน์สต็อก/คงเหลืออยู่ด้วยกัน ' +
    'ให้ยึดค่าจาก "จำนวนสั่งซื้อ" เป็นหลักเสมอ\n\n' +
    'เอกสารนี้เป็นใบขอซื้อภายใน ไม่มีราคา แม้ตารางจะมีคอลัมน์ราคา/จำนวนเงินอยู่ก็ให้ข้ามไป ห้ามใส่ราคาหรือเดาตัวเลขที่ไม่ปรากฏ ' +
    'ตอบเป็น JSON ตามโครงสร้างที่กำหนดเท่านั้น';
}

/** เรียก Gemini generateContent แล้วแกะผลลัพธ์ JSON ที่ต้องการ ใช้ร่วมกันทุกฟังก์ชันแยกข้อมูล */
function callGeminiExtract_(parts, schema) {
  var apiKey = getGeminiApiKey_();
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
  };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var bodyText = response.getContentText();
  if (code !== 200) {
    throw new Error('เรียก Gemini API ไม่สำเร็จ (รหัส ' + code + '): ' + bodyText.substring(0, 300));
  }

  var json;
  try { json = JSON.parse(bodyText); } catch (e) {
    throw new Error('อ่านผลลัพธ์จาก Gemini ไม่สำเร็จ');
  }
  if (json.promptFeedback && json.promptFeedback.blockReason) {
    throw new Error('ไฟล์นี้ถูกระงับโดยระบบความปลอดภัยของ Gemini (' + json.promptFeedback.blockReason + ')');
  }
  if (!json.candidates || !json.candidates.length || !json.candidates[0].content) {
    throw new Error('Gemini ไม่ได้ส่งผลลัพธ์กลับมา กรุณาลองใหม่อีกครั้ง');
  }

  var textPart = json.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
  try {
    return JSON.parse(textPart);
  } catch (e) {
    throw new Error('รูปแบบข้อมูลที่ได้จาก Gemini ไม่ถูกต้อง กรุณาลองใหม่หรือกรอกข้อมูลด้วยตนเอง');
  }
}

/**
 * อ่านไฟล์ใบเสนอราคาแบบไฟล์รูป/PDF (ส่งเนื้อไฟล์ตรงให้ Gemini อ่าน)
 * base64Data: เนื้อไฟล์แบบ base64 (ไม่มี prefix "data:...;base64,")
 * mimeType: เช่น 'application/pdf', 'image/jpeg', 'image/png'
 */
function extractQuoteFromFile(base64Data, mimeType, fileName) {
  return callGeminiExtract_([
    { inlineData: { mimeType: mimeType, data: base64Data } },
    { text: quoteExtractInstructions_() }
  ], quoteExtractSchema_());
}

/**
 * อ่านใบเสนอราคาจากไฟล์ Excel/CSV — ฝั่งไคลเอนต์แปลงเป็นตารางข้อความ (CSV) มาให้แล้ว
 * ส่งเป็นข้อความล้วนให้ Gemini ตีความแทนการส่งไฟล์ตรง (Gemini ไม่รองรับไฟล์ .xlsx โดยตรง)
 */
function extractQuoteFromText(textContent, fileName) {
  var note = 'ต่อไปนี้คือข้อมูลตารางที่แปลงมาจากไฟล์สเปรดชีต (' + (fileName || 'ไฟล์ Excel/CSV') + ') ของใบเสนอราคาจากผู้ขายรายหนึ่ง:\n\n' +
    textContent + '\n\n' + quoteExtractInstructions_();
  return callGeminiExtract_([{ text: note }], quoteExtractSchema_());
}

/**
 * อ่านไฟล์ "ใบขอซื้อ" (Purchase Request) แบบไฟล์รูป/PDF เพื่อดึงรายการสินค้ามาตั้งต้น
 * (ไม่มีราคา — ใช้สำหรับสร้างรายการสินค้าและใบขอราคาไปยัง supplier)
 */
function extractPurchaseRequest(base64Data, mimeType, fileName) {
  return callGeminiExtract_([
    { inlineData: { mimeType: mimeType, data: base64Data } },
    { text: purchaseRequestInstructions_() }
  ], purchaseRequestExtractSchema_());
}

/** อ่านใบขอซื้อจากไฟล์ Excel/CSV — แปลงเป็นข้อความ (CSV) ก่อนส่งให้ Gemini ตีความ */
function extractPurchaseRequestFromText(textContent, fileName) {
  var note = 'ต่อไปนี้คือข้อมูลตารางที่แปลงมาจากไฟล์สเปรดชีต (' + (fileName || 'ไฟล์ Excel/CSV') + ') ของใบขอซื้อ:\n\n' +
    textContent + '\n\n' + purchaseRequestInstructions_();
  return callGeminiExtract_([{ text: note }], purchaseRequestExtractSchema_());
}

/**
 * ให้ Gemini ช่วยสรุปข้อเสนอแนะสั้นๆ สำหรับใบเปรียบเทียบราคา (ใช้ในเอกสารพิมพ์)
 * summaryText: สรุปข้อมูลตัวเลขเปรียบเทียบที่เตรียมไว้แล้วจากฝั่งไคลเอนต์ (ข้อความล้วน)
 * คืนค่าเป็นข้อความล้วน (ไม่ใช่ JSON)
 */
function generateRecommendation(summaryText) {
  var apiKey = getGeminiApiKey_();
  var promptText =
    'คุณเป็นเจ้าหน้าที่จัดซื้อมืออาชีพ อ่านข้อมูลสรุปการเปรียบเทียบราคาต่อไปนี้ แล้วเขียนข้อเสนอแนะประกอบการตัดสินใจจัดซื้อ ' +
    'ความยาวไม่เกิน 4-5 ประโยค เป็นภาษาไทย น้ำเสียงมืออาชีพ กระชับ ตรงประเด็น ' +
    'ให้ระบุผู้ขายที่แนะนำพร้อมเหตุผล (ราคา, ระยะเวลาส่งมอบ, การรับประกัน, เงื่อนไขชำระเงิน ตามความเหมาะสม) ' +
    'ห้ามเดาตัวเลขที่ไม่มีในข้อมูลที่ให้ ตอบเป็นข้อความล้วน ไม่ต้องมีหัวข้อหรือ markdown:\n\n' + summaryText;

  var payload = { contents: [{ parts: [{ text: promptText }] }] };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error('เรียก Gemini API ไม่สำเร็จ (รหัส ' + response.getResponseCode() + ')');
  }
  var json = JSON.parse(response.getContentText());
  if (!json.candidates || !json.candidates.length || !json.candidates[0].content) {
    throw new Error('Gemini ไม่ได้ส่งผลลัพธ์กลับมา');
  }
  return json.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('').trim();
}
