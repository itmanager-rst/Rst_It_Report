// RST GROUP - PriceLogic Procurement : Code.gs (v5.9.6)
// ฐานข้อมูลของแอป = Google Sheet ที่ผูกกับสคริปต์นี้ (ชีต "Data" + "รายงาน")
// สถานะใบขอซื้อจาก ECOUNT = อ่านจาก RST GROUP Data Hub (Google Sheet กลาง)
var DATA_HUB_ID = "1UlBTYtHKb9SOrb41J1svuUU5-r3FRr119druz9EIx-o";

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === "data") return jsonOut(getDataJson());
  if (p.action === "prstatus") return jsonOut(getPRStatusJson(p.hub, p.tab));
  if (p.action === "prinfo") return jsonOut(getPRInfoJson());
  if (p.action === "codes") return jsonOut(getEcountCodesJson());
  if (p.action === "vendorhist") return jsonOut(getVendorHistJson());
  if (p.action === "ecKeyStatus") return jsonOut(ecKeyStatusForClient());
  if (p.action === "vendormaster") return jsonOut(getVendorMasterJson());
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("RST GROUP - PriceLogic Procurement")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function doPost(e) {
  var body = e.postData.contents;
  var req = null;
  try { req = JSON.parse(body); } catch (err) {}
  // ผู้ช่วย AI ส่ง "สถานะใบขอซื้อ" จากหน้ารายงาน ECOUNT เข้ามาทางนี้
  if (req && req.action === "pushPR") return jsonOut(JSON.stringify(pushPRStatus(req)));
  if (req && req.action === "createPO") return jsonOut(JSON.stringify(createPurchaseOrder(req)));
  if (req && req.action === "saveCodes") return jsonOut(saveEcountCode(req));
  if (req && req.action === "ecKeySave") return jsonOut(saveEcountKeyForClient(req));
  if (req && req.action === "pushVendor") return jsonOut(JSON.stringify(pushVendorMaster(req)));
  if (req && req.action === "pushLocation") return jsonOut(JSON.stringify(pushLocations(req)));
  if (req && req.action === "ecKeyTest") return jsonOut(testEcountKeyForClient(req));
  if (req && req.action) return jsonOut(JSON.stringify({ status: "error", message: "unknown action" }));
  saveDataJson(body);
  return jsonOut(JSON.stringify({status:"ok"}));
}

function jsonOut(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// เรียกผ่าน google.script.run เมื่อเปิดแอปจากลิงก์ Web App
function loadDataForClient() { return getDataJson(); }
function saveDataForClient(jsonString) { saveDataJson(jsonString); return "ok"; }
function loadPRStatusForClient(hubId, tabName) { return getPRStatusJson(hubId, tabName); }

// ---- ฐานข้อมูลของแอป: เก็บ JSON แบ่งเป็นท่อนๆ ลงคอลัมน์ A (1 เซลล์รับได้ไม่เกิน 50,000 ตัวอักษร) ----
function getDataJson() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Data");
  var empty = '{"purchaseRequests":[]}';
  if (!sheet) return empty;
  var last = sheet.getLastRow();
  if (last < 1) return empty;
  var vals = sheet.getRange(1, 1, last, 1).getValues();
  var json = "";
  for (var i = 0; i < vals.length; i++) json += vals[i][0];
  return json || empty;
}

function saveDataJson(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Data") || ss.insertSheet("Data");
    var size = 45000, chunks = [];
    for (var i = 0; i < body.length; i += size) chunks.push([body.substring(i, i + size)]);
    sheet.getRange("A:A").clearContent().setNumberFormat("@");
    sheet.getRange(1, 1, chunks.length, 1).setValues(chunks);
    sheet.getRange("B1").setValue(new Date());
    try {
      var parsed = JSON.parse(body);
      writeReadableSheet(ss, parsed.purchaseRequests || []);
    } catch (err) {}
  } finally {
    lock.releaseLock();
  }
}

function writeReadableSheet(ss, prs) {
  var sheet = ss.getSheetByName("รายงาน") || ss.insertSheet("รายงาน");
  sheet.clear();
  var headers = ["บริษัท","เลขที่ใบขอซื้อ","โครงการ","วันที่ต้องการ","รหัสสินค้า","รายการสินค้า","จำนวน","หน่วย","ผู้จำหน่ายที่อนุมัติ","ราคาต่อหน่วย","สถานะ","อนุมัติโดย","วันที่อนุมัติ"];
  var rows = [headers];
  prs.forEach(function (pr) {
    pr.items.forEach(function (it) {
      var sup = null;
      if (it.approvedSupplierId) {
        pr.suppliers.forEach(function (s) { if (s.id === it.approvedSupplierId) sup = s; });
      }
      rows.push([
        pr.company || "", pr.prNo, pr.projectName, it.neededDate || pr.neededDate, it.code, it.name, it.qty, it.unit,
        sup ? sup.name : "", sup ? sup.prices[it.id] : "",
        it.approvedSupplierId ? "อนุมัติแล้ว" : "รอดำเนินการ",
        it.approvedBy || "", it.approvedAt || ""
      ]);
    });
  });
  sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
}

// ---- อ่าน "สถานะใบขอซื้อ" จาก RST GROUP Data Hub ----
// ถ้าไม่ระบุชื่อชีต จะหาเองจากหัวคอลัมน์ (ต้องมี "เลขที่ใบขอซื้อ" และ "รหัสสินค้า")
function getPRStatusJson(hubId, tabName) {
  var out = { rows: [], sheet: "", error: "" };
  try {
    var ss = SpreadsheetApp.openById(hubId || DATA_HUB_ID);
    var best = null, bestScore = 0, bestHead = 0;
    var sheets = tabName ? [ss.getSheetByName(tabName)] : ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      var sh = sheets[i];
      if (!sh) continue;
      var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
      if (lastRow < 2 || lastCol < 2) continue;
      var head = sh.getRange(1, 1, Math.min(lastRow, 5), lastCol).getDisplayValues();
      for (var r = 0; r < head.length; r++) {
        var joined = "|" + head[r].join("|") + "|";
        if (joined.indexOf("|เลขที่ใบขอซื้อ|") === -1 || joined.indexOf("|รหัสสินค้า|") === -1) continue;
        var score = 1;
        if (joined.indexOf("จำนวนขอซื้อ") > -1) score += 2;
        if (joined.indexOf("เลขที่ใบสั่งซื้อ") > -1) score -= 1;
        var nm = sh.getName().toUpperCase();
        if (nm.indexOf("PR") > -1 || nm.indexOf("REQUEST") > -1 || nm.indexOf("ขอซื้อ") > -1) score += 2;
        if (score > bestScore) { best = sh; bestScore = score; bestHead = r; }
        break;
      }
    }
    if (!best) { out.error = "NO_PR_SHEET"; return JSON.stringify(out); }
    var n = best.getLastRow() - bestHead;
    out.rows = best.getRange(bestHead + 1, 1, n, best.getLastColumn()).getDisplayValues();
    out.sheet = best.getName();
  } catch (err) {
    out.error = String(err);
  }
  return JSON.stringify(out);
}

// ================= Data Hub : สถานะใบขอซื้อ (ชีต ECOUNT_PR) =================
var PR_TAB = "ECOUNT_PR";
var PR_STD_HEADERS = ["วันที่-ลำดับ","ชื่อโครงการ","เลขที่ใบขอซื้อ","รหัสสินค้า","ชื่อสินค้า (ข้อมูลจำเพาะ)","จำนวนขอซื้อ","ราคาต่อหน่วย","จำนวนเงิน","วันที่ต้องการ","ชื่อลูกค้า/ผู้ขาย","หมายเหตุ"];

function nowBangkok() {
  return Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
}

// รันครั้งเดียวจากหน้า Apps Script เพื่อสร้างชีต ECOUNT_PR ใน Data Hub (และให้สิทธิ์เข้าถึง Data Hub)
function setupPRDataHub() {
  var ss = SpreadsheetApp.openById(DATA_HUB_ID);
  var sh = ss.getSheetByName(PR_TAB) || ss.insertSheet(PR_TAB);
  if (sh.getLastRow() === 0) {
    var head = ["COMPANY", "PULLED_AT"].concat(PR_STD_HEADERS);
    sh.getRange(1, 1, 1, head.length).setNumberFormat("@").setValues([head]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return "พร้อมใช้งาน: " + ss.getName() + " / " + PR_TAB;
}

// รับข้อมูล {action:"pushPR", company, range, headers:[...], rows:[[...]]}
// แทนที่ข้อมูลเดิมของบริษัทนั้นทั้งชุด (ข้อมูลบริษัทอื่นคงไว้) แล้วบันทึกลง DATAHUB_LOG
function pushPRStatus(req) {
  var out = { status: "error", rows: 0, sheet: PR_TAB, message: "" };
  try {
    var company = String(req.company || "").trim();
    var headers = (req.headers || []).map(function (h) { return String(h).trim(); });
    var rows = req.rows || [];
    var iPr = headers.indexOf("เลขที่ใบขอซื้อ"), iCode = headers.indexOf("รหัสสินค้า"), iName = -1;
    for (var h = 0; h < headers.length; h++) { if (headers[h].indexOf("ชื่อสินค้า") === 0) { iName = h; break; } }
    if (!company) { out.message = "ไม่ได้ระบุ company"; return out; }
    if (iPr === -1 || iCode === -1 || iName === -1) { out.message = "หัวคอลัมน์ต้องมี เลขที่ใบขอซื้อ / รหัสสินค้า / ชื่อสินค้า"; return out; }
    // ตัดบรรทัดยอดรวม/บรรทัดว่าง: เก็บเฉพาะบรรทัดที่มีทั้งเลขที่ใบขอซื้อและชื่อสินค้า
    var clean = [];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !String(row[iName] || "").trim()) continue;
      if (!/^PR\d+/i.test(String(row[iPr] || "").trim())) continue;
      if (row.some(function (c) { return /(^|\s)รวม\s*$|ผลรวมทั้งหมด/.test(String(c || "").trim()); })) continue;
      clean.push(row);
    }
    if (!clean.length) { out.message = "ไม่มีบรรทัดข้อมูล — ไม่ได้แก้ไขข้อมูลเดิม"; return out; }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var ss = SpreadsheetApp.openById(DATA_HUB_ID);
      var sh = ss.getSheetByName(PR_TAB) || ss.insertSheet(PR_TAB);
      var old = sh.getLastRow() > 0 ? sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues() : [];
      var oldHead = old.length ? old[0].map(function (x) { return String(x).trim(); }) : [];
      var head = ["COMPANY", "PULLED_AT"];
      oldHead.concat(headers).forEach(function (x) { if (x && head.indexOf(x) === -1) head.push(x); });
      var pos = {};
      head.forEach(function (x, i) { pos[x] = i; });
      var all = [head];
      var oc = oldHead.indexOf("COMPANY");
      for (var i = 1; i < old.length; i++) {
        if (oc === -1 || old[i][oc] === company) continue;
        var keep = head.map(function () { return ""; });
        for (var c = 0; c < oldHead.length; c++) { if (oldHead[c]) keep[pos[oldHead[c]]] = old[i][c]; }
        all.push(keep);
      }
      var stamp = nowBangkok();
      clean.forEach(function (row) {
        var line = head.map(function () { return ""; });
        line[0] = company; line[1] = stamp;
        for (var c = 0; c < headers.length; c++) {
          if (headers[c]) line[pos[headers[c]]] = (row[c] === undefined || row[c] === null) ? "" : String(row[c]);
        }
        all.push(line);
      });
      sh.clearContents();
      sh.getRange(1, 1, all.length, head.length).setNumberFormat("@").setValues(all);
      sh.getRange(1, 1, 1, head.length).setFontWeight("bold");
      sh.setFrozenRows(1);
      var log = ss.getSheetByName("DATAHUB_LOG");
      if (log) log.appendRow([stamp, PR_TAB, company, String(req.range || ""), clean.length, String(req.note || "สถานะใบขอซื้อ จากหน้ารายงาน ECOUNT")]);
    } finally {
      lock.releaseLock();
    }
    out.status = "ok"; out.rows = clean.length; out.pulledAt = stamp;
  } catch (err) {
    out.message = String(err);
  }
  return out;
}

// สรุปสถานะชีต ECOUNT_PR (ใช้ตรวจผลหลังส่งข้อมูล)
function getPRInfoJson() {
  var out = { sheet: PR_TAB, exists: false, companies: {}, error: "" };
  try {
    var sh = SpreadsheetApp.openById(DATA_HUB_ID).getSheetByName(PR_TAB);
    if (sh && sh.getLastRow() > 1) {
      out.exists = true;
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues();
      v.forEach(function (x) {
        var c = out.companies[x[0]] || (out.companies[x[0]] = { rows: 0, pulledAt: "" });
        c.rows++;
        if (x[1] > c.pulledAt) c.pulledAt = x[1];
      });
    } else if (sh) { out.exists = true; }
  } catch (err) { out.error = String(err); }
  return JSON.stringify(out);
}

// ================= ECOUNT : ออกใบสั่งซื้อ (Purchase Order) ผ่าน OpenAPI V2 =================
// ตั้งค่าใน Project Settings (⚙️) → Script Properties (ไม่ต้องใส่รหัสในโค้ด):
//   PO_PASSCODE        = รหัสทีม ที่ต้องกรอกก่อนส่งใบสั่งซื้อ
//   ECOUNT_TEST        = true  (ใช้ระบบทดสอบ sboapi ของ ECOUNT) / false = ระบบจริง
//   ECOUNT_RUAMSINTHAI = {"COM_CODE":"...","USER_ID":"...","API_CERT_KEY":"..."}
//   ECOUNT_ASIA / ECOUNT_ROBOTICS = รูปแบบเดียวกัน (ชื่อบริษัทตาม Data Hub: RUAMSINTHAI / ASIA / ROBOTICS)
var PO_LOG_TAB = "PO_LOG";

function ecProps() { return PropertiesService.getScriptProperties(); }
function ecIsTest() { return String(ecProps().getProperty("ECOUNT_TEST") || "true").toLowerCase() !== "false"; }
function ecCred(company) {
  var raw = ecProps().getProperty("ECOUNT_" + company);
  if (!raw) throw new Error("ยังไม่ได้ตั้งค่า Script Property ECOUNT_" + company);
  var c = JSON.parse(raw);
  if (!c.COM_CODE || !c.USER_ID || !c.API_CERT_KEY) throw new Error("ECOUNT_" + company + " ต้องมี COM_CODE, USER_ID, API_CERT_KEY");
  return c;
}
function ecPost(url, body) {
  var res = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true });
  var text = res.getContentText();
  var json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!json) throw new Error("ECOUNT ตอบกลับไม่ใช่ JSON (HTTP " + res.getResponseCode() + "): " + text.substring(0, 200));
  return json;
}
function ecHost(zone) { return ecIsTest() ? "https://sboapi" + zone + ".ecount.com" : "https://oapi" + zone + ".ecount.com"; }

// เข้าสู่ระบบ ECOUNT แล้วเก็บ SESSION_ID ไว้ 20 นาที
function ecSession(company, forceNew) {
  var cache = CacheService.getScriptCache(), key = "ecs_" + company + (ecIsTest() ? "_t" : "");
  if (!forceNew) { var hit = cache.get(key); if (hit) return JSON.parse(hit); }
  var c = ecCred(company);
  var zone = c.ZONE;
  if (!zone) {
    var z = ecPost((ecIsTest() ? "https://sboapi.ecount.com" : "https://oapi.ecount.com") + "/OAPI/V2/Zone", { COM_CODE: c.COM_CODE });
    zone = z && z.Data && z.Data.ZONE;
    if (!zone) throw new Error("หา Zone ของบริษัทไม่ได้: " + JSON.stringify(z).substring(0, 200));
  }
  var lg = ecPost(ecHost(zone) + "/OAPI/V2/OAPILogin", { COM_CODE: c.COM_CODE, USER_ID: c.USER_ID, API_CERT_KEY: c.API_CERT_KEY, LAN_TYPE: "en-US", ZONE: zone });
  var sid = lg && lg.Data && lg.Data.Datas && lg.Data.Datas.SESSION_ID;
  if (!sid) throw new Error("เข้าสู่ระบบ ECOUNT ไม่สำเร็จ: " + JSON.stringify(lg).substring(0, 300));
  var s = { zone: zone, sid: sid };
  cache.put(key, JSON.stringify(s), 1200);
  return s;
}

// แปลงข้อมูลจาก PriceLogic เป็นรูปแบบ SavePurchaseOrder ของ ECOUNT (แก้ชื่อฟิลด์ได้ที่ฟังก์ชันนี้ที่เดียว)
function ecBuildPOBody(req) {
  var h = req.header || {};
  var list = (req.lines || []).map(function (l) {
    return { BulkDatas: {
      ORD_DATE: String(h.date || "").replace(/-/g, ""),
      UPLOAD_SER_NO: "1",
      DOC_NO: h.docNo || "",
      IO_TYPE: h.ioType || "",
      PJT_CD: h.projectCode || "",
      CUST: h.custCode || "", CUST_DES: h.custName || "",
      EMP_CD: h.empCode || "", WH_CD: h.whCode || "",
      TIME_DATE: String(l.dueDate || h.dueDate || "").replace(/-/g, ""),
      U_MEMO1: h.remark || "",
      PROD_CD: l.code || "", PROD_DES: l.name || "",
      QTY: String(l.qty), PRICE: String(l.price),
      SUPPLY_AMT: String(l.supply), VAT_AMT: String(l.vat),
      REMARKS: l.remark || ""
    } };
  });
  return { PurchaseOrderList: list };
}

function createPurchaseOrder(req) {
  var out = { status: "error", message: "", slipNos: [], test: ecIsTest() };
  try {
    var pass = ecProps().getProperty("PO_PASSCODE");
    if (!pass) { out.message = "ผู้ดูแลยังไม่ได้ตั้ง PO_PASSCODE ใน Script Properties"; return out; }
    if (String(req.passcode || "") !== pass) { out.message = "รหัสทีมไม่ถูกต้อง"; return out; }
    if (!req.company) { out.message = "ไม่ได้ระบุบริษัท"; return out; }
    if (!req.lines || !req.lines.length) { out.message = "ไม่มีรายการสินค้า"; return out; }
    if (!(req.header && req.header.custCode)) { out.message = "ไม่ได้ระบุรหัสผู้ขาย (CUST)"; return out; }
    var body = ecBuildPOBody(req);
    if (req.preview) { out.status = "preview"; out.body = body; return out; }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var log = ss.getSheetByName(PO_LOG_TAB) || ss.insertSheet(PO_LOG_TAB);
      if (log.getLastRow() === 0) log.appendRow(["เวลา", "REQ_ID", "บริษัท", "ผู้ขาย", "รหัสผู้ขาย", "จำนวนบรรทัด", "ผล", "เลขที่ PO", "ผู้ส่ง", "Ref. PR", "ข้อความ", "โหมด"]);
      // กันส่งซ้ำ: REQ_ID เดิมที่สำเร็จแล้วจะคืนเลขที่ PO เดิม ไม่สร้างใหม่
      if (req.reqId && log.getLastRow() > 1) {
        var prev = log.getRange(2, 1, log.getLastRow() - 1, 8).getValues();
        for (var i = 0; i < prev.length; i++) {
          if (prev[i][1] === req.reqId && prev[i][6] === "OK") { out.status = "ok"; out.duplicate = true; out.slipNos = String(prev[i][7]).split(", "); return out; }
        }
      }
      var s = ecSession(req.company, false);
      var url = ecHost(s.zone) + "/OAPI/V2/PurchaseOrder/SavePurchaseOrder?SESSION_ID=" + encodeURIComponent(s.sid);
      var res = ecPost(url, body);
      if (res && res.Error && /session/i.test(JSON.stringify(res.Error))) {
        s = ecSession(req.company, true);
        url = ecHost(s.zone) + "/OAPI/V2/PurchaseOrder/SavePurchaseOrder?SESSION_ID=" + encodeURIComponent(s.sid);
        res = ecPost(url, body);
      }
      var d = (res && res.Data) || {};
      var ok = String(res && res.Status) === "200" && Number(d.SuccessCnt || 0) > 0 && Number(d.FailCnt || 0) === 0;
      out.slipNos = d.SlipNos || [];
      out.detail = d.ResultDetails || res.Error || null;
      out.status = ok ? "ok" : "error";
      if (!ok) out.message = "ECOUNT ไม่รับใบสั่งซื้อ: " + JSON.stringify(d.ResultDetails || res.Error || res).substring(0, 400);
      log.appendRow([new Date(), req.reqId || "", req.company, (req.header || {}).custName || "", (req.header || {}).custCode || "",
        req.lines.length, ok ? "OK" : "FAIL", out.slipNos.join(", "), req.user || "", req.refPR || "", out.message, ecIsTest() ? "TEST" : "LIVE"]);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    out.message = String(err && err.message ? err.message : err);
  }
  return out;
}
function createPOForClient(req) { return JSON.stringify(createPurchaseOrder(req)); }

// ================= v5.9.1: ตั้งค่า ECOUNT API Key จากหน้าแอป (เก็บใน Script Properties เท่านั้น ไม่ส่งกลับไปที่เบราว์เซอร์) =================
var EC_COMPANIES = ["RUAMSINTHAI", "ASIA", "ROBOTICS"];
function ecMask(v) { v = String(v || ""); return v ? "••••" + v.slice(-4) : ""; }
function ecKeyStatusForClient() {
  var p = ecProps(), out = { test: ecIsTest(), passcodeSet: !!p.getProperty("PO_PASSCODE"), companies: {} };
  EC_COMPANIES.forEach(function (c) {
    var raw = p.getProperty("ECOUNT_" + c), o = { set: false };
    if (raw) { try { var j = JSON.parse(raw); o = { set: !!(j.COM_CODE && j.USER_ID && j.API_CERT_KEY), comCode: j.COM_CODE || "", userId: j.USER_ID || "", key: ecMask(j.API_CERT_KEY), zone: j.ZONE || "" }; } catch (e) { o = { set: false, error: "รูปแบบ JSON ไม่ถูกต้อง" }; } }
    out.companies[c] = o;
  });
  return JSON.stringify(out);
}
// ตรวจรหัสทีม — ถ้ายังไม่เคยตั้ง PO_PASSCODE ระบบจะใช้รหัสที่กรอกครั้งแรกเป็นรหัสทีม
function ecCheckPass(req, allowFirst) {
  var p = ecProps(), pass = p.getProperty("PO_PASSCODE"), given = String(req.passcode || "");
  if (!pass) {
    if (allowFirst && given.length >= 4) { p.setProperty("PO_PASSCODE", given); return ""; }
    return "ยังไม่ได้ตั้งรหัสทีม — กรอกรหัสทีมอย่างน้อย 4 ตัวอักษร (ครั้งแรกจะถูกตั้งเป็นรหัสทีม)";
  }
  return given === pass ? "" : "รหัสทีมไม่ถูกต้อง";
}
function saveEcountKeyForClient(req) {
  var out = { status: "error", message: "" };
  try {
    var bad = ecCheckPass(req, true); if (bad) { out.message = bad; return JSON.stringify(out); }
    var c = String(req.company || "");
    if (EC_COMPANIES.indexOf(c) === -1) { out.message = "บริษัทไม่ถูกต้อง"; return JSON.stringify(out); }
    var p = ecProps(), old = {};
    try { old = JSON.parse(p.getProperty("ECOUNT_" + c) || "{}"); } catch (e) {}
    var cred = {
      COM_CODE: String(req.comCode || old.COM_CODE || "").trim(),
      USER_ID: String(req.userId || old.USER_ID || "").trim(),
      API_CERT_KEY: String(req.apiKey || old.API_CERT_KEY || "").trim()
    };
    var zone = String(req.zone != null ? req.zone : (old.ZONE || "")).trim(); if (zone) cred.ZONE = zone;
    if (!cred.COM_CODE || !cred.USER_ID || !cred.API_CERT_KEY) { out.message = "ต้องกรอก Company Code, User ID และ API Key ให้ครบ"; return JSON.stringify(out); }
    p.setProperty("ECOUNT_" + c, JSON.stringify(cred));
    if (req.mode === "live" || req.mode === "test") p.setProperty("ECOUNT_TEST", req.mode === "test" ? "true" : "false");
    var cache = CacheService.getScriptCache(); cache.remove("ecs_" + c); cache.remove("ecs_" + c + "_t");
    out.status = "ok";
  } catch (err) { out.message = String(err && err.message ? err.message : err); }
  return JSON.stringify(out);
}
function testEcountKeyForClient(req) {
  var out = { status: "error", message: "", test: ecIsTest() };
  try {
    var bad = ecCheckPass(req, false); if (bad) { out.message = bad; return JSON.stringify(out); }
    var s = ecSession(String(req.company || ""), true);
    out.status = "ok"; out.zone = s.zone;
  } catch (err) { out.message = String(err && err.message ? err.message : err); }
  return JSON.stringify(out);
}

// รหัสผู้ขาย/คลัง/พนักงาน ที่จำไว้ใช้ครั้งต่อไป (เก็บในชีต "รหัส ECOUNT" ของ Data Hub)
function getEcountCodesJson() {
  var out = { rows: [], error: "" };
  try {
    var sh = SpreadsheetApp.openById(DATA_HUB_ID).getSheetByName("รหัส ECOUNT");
    if (sh && sh.getLastRow() > 1) out.rows = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(3, Math.min(sh.getLastColumn(), 4))).getDisplayValues();
  } catch (err) { out.error = String(err); }
  return JSON.stringify(out);
}
function loadEcountCodesForClient() { return getEcountCodesJson(); }
function saveEcountCode(req) {
  var pass = ecProps().getProperty("PO_PASSCODE");
  if (!pass || String(req.passcode || "") !== pass) return JSON.stringify({ status: "error" });
  var ss = SpreadsheetApp.openById(DATA_HUB_ID);
  var sh = ss.getSheetByName("รหัส ECOUNT") || ss.insertSheet("รหัส ECOUNT");
  if (sh.getLastRow() === 0) sh.appendRow(["ประเภท", "ชื่อ", "รหัส", "บริษัท"]);
  if (sh.getLastColumn() < 4) sh.getRange(1, 4).setValue("บริษัท");
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 4).getDisplayValues() : [];
  (req.codes || []).forEach(function (c) {
    if (!c.type || !c.name || !c.code) return;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === c.type && rows[i][1] === c.name && rows[i][3] === (c.company || "")) {
        if (rows[i][2] !== c.code) sh.getRange(i + 2, 3).setValue(c.code);
        return;
      }
    }
    sh.appendRow([c.type, c.name, c.code, c.company || ""]);
    rows.push([c.type, c.name, c.code, c.company || ""]);
  });
  return JSON.stringify({ status: "ok" });
}
function saveEcountCodeForClient(req) { return saveEcountCode(req); }

// รันจากหน้า Apps Script เพื่อทดสอบการเข้าสู่ระบบ ECOUNT ทุกบริษัทที่ตั้งค่าไว้ (ดูผลใน Execution log)
function testEcountLogin() {
  var keys = ecProps().getKeys().filter(function (k) { return k.indexOf("ECOUNT_") === 0 && k !== "ECOUNT_TEST"; });
  if (!keys.length) { Logger.log("ยังไม่มี Script Property ECOUNT_<บริษัท>"); return; }
  Logger.log("โหมด: " + (ecIsTest() ? "TEST (sboapi)" : "LIVE (oapi)"));
  keys.forEach(function (k) {
    var company = k.substring(7);
    try { var s = ecSession(company, true); Logger.log(company + ": เข้าสู่ระบบสำเร็จ (Zone " + s.zone + ")"); }
    catch (err) { Logger.log(company + ": " + err.message); }
  });
}

// ================= ประวัติการซื้อ: ผู้ขายที่เคยซื้อ + ราคาล่าสุด (จากชีต DH_PO_STATUS / PO_LINES ใน Data Hub) =================
var TH_MON = { "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6, "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12 };
function vhIsoDate(v) {
  var s = String(v || "").trim(), m;
  if ((m = s.match(/^(\d{1,2})\s*([ก-๙.]+)\s*(\d{4})/)) && TH_MON[m[2]]) {
    var y = +m[3]; if (y > 2400) y -= 543;
    return y + "-" + ("0" + TH_MON[m[2]]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) { var yy = +m[3]; if (yy > 2400) yy -= 543; return yy + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2); }
  return "";
}
function vhNum(v) { var n = parseFloat(String(v || "").replace(/,/g, "")); return isNaN(n) ? 0 : n; }

// คืนค่า { byCode: { "รหัสสินค้า": [[บริษัท, ผู้ขาย, รหัสผู้ขาย, วันที่, ราคาต่อหน่วย(หลังส่วนลด), จำนวน, เลขที่PO, จำนวนครั้งที่ซื้อ], ...] } }
// เก็บผู้ขายสูงสุด 5 รายต่อรหัสสินค้า เรียงจากซื้อล่าสุด
function getVendorHistJson() {
  var out = { byCode: {}, info: {}, sheet: "", rows: 0, error: "" };
  try {
    var ss = SpreadsheetApp.openById(DATA_HUB_ID);
    var src = [
      { tab: "DH_PO_STATUS", co: "_company", code: "รหัสสินค้า", vendor: "ลูกค้า/ผู้ขาย", vcode: "รหัสผู้ขาย", date: "วันที่", net: "ราคาต่อหน่วยหลังส่วนลด", price: "ราคาต่อหน่วย", qty: "จำนวน", po: "เลขที่ใบสั่งซื้อ", name: "ชื่อสินค้า [ข้อมูลจำเพาะ]", group: "ชื่อกลุ่มสินค้า I" },
      { tab: "PO_LINES", co: "COMPANY", code: "ITEM_CODE", vendor: "VENDOR", vcode: "", date: "PO_DATE", net: "NET_PRICE", price: "UNIT_PRICE", qty: "QTY", po: "PO_NO", name: "ITEM_NAME", group: "ITEM_GROUP" }
    ];
    var agg = {}, info = {};
    for (var s = 0; s < src.length; s++) {
      var d = src[s], sh = ss.getSheetByName(d.tab);
      if (!sh || sh.getLastRow() < 2) continue;
      var v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
      var h = v[0].map(function (x) { return String(x).trim(); });
      var c = {}; ["co", "code", "vendor", "vcode", "date", "net", "price", "qty", "po", "name", "group"].forEach(function (k) { c[k] = d[k] ? h.indexOf(d[k]) : -1; });
      if (c.code < 0 || c.vendor < 0) continue;
      for (var i = 1; i < v.length; i++) {
        var r = v[i], code = String(r[c.code] || "").trim(), vendor = String(r[c.vendor] || "").trim();
        if (!code || !vendor) continue;
        var price = c.net >= 0 ? vhNum(r[c.net]) : 0;
        if (!price && c.price >= 0) price = vhNum(r[c.price]);
        var co = c.co >= 0 ? String(r[c.co] || "").trim() : "";
        var key = co + "|" + vendor, date = vhIsoDate(c.date >= 0 ? r[c.date] : "");
        var byV = agg[code] || (agg[code] = {});
        if (!info[code]) info[code] = [c.name >= 0 ? String(r[c.name] || "").trim() : "", c.group >= 0 ? String(r[c.group] || "").trim() : ""];
        var e = byV[key];
        if (!e) e = byV[key] = [co, vendor, c.vcode >= 0 ? String(r[c.vcode] || "").trim() : "", "", 0, 0, "", 0];
        e[7]++;
        if (c.vcode >= 0 && String(r[c.vcode] || "").trim()) e[2] = String(r[c.vcode]).trim();
        if (date >= e[3] && price > 0) { e[3] = date; e[4] = price; e[5] = vhNum(r[c.qty]); e[6] = c.po >= 0 ? String(r[c.po] || "") : ""; }
        else if (!e[3] && date) e[3] = date;
      }
      out.sheet = d.tab; out.rows = v.length - 1;
      break; // ใช้ชีตแรกที่มีข้อมูล
    }
    Object.keys(agg).forEach(function (code) {
      out.byCode[code] = Object.keys(agg[code]).map(function (k) { return agg[code][k]; })
        .sort(function (a, b) { return a[3] < b[3] ? 1 : a[3] > b[3] ? -1 : 0; }).slice(0, 5);
    });
    out.info = info; // รหัสสินค้า -> [ชื่อสินค้า, กลุ่มสินค้า] ใช้หาสินค้าใกล้เคียง/กลุ่มเดียวกัน
  } catch (err) { out.error = String(err); }
  return JSON.stringify(out);
}
function loadVendorHistForClient() { return getVendorHistJson(); }


// ================= v5.9.2: รายชื่อลูกค้า/ผู้ขาย จาก ECOUNT (ชีต DH_VENDOR ใน Data Hub) =================
// รับได้ทั้งจากการอัปโหลด Excel ในแอป และจากผู้ช่วย AI (POST action=pushVendor) — แทนที่รายชื่อของบริษัทนั้นทั้งชุด
var VENDOR_TAB = "DH_VENDOR";
var VENDOR_HEAD = ["_company", "รหัสลูกค้า/ผู้ขาย", "ชื่อลูกค้า/ผู้ขาย", "เลขประจำตัวผู้เสียภาษี", "โทรศัพท์", "_updated"];
function vmFind(h, tests) {
  for (var t = 0; t < tests.length; t++) for (var i = 0; i < h.length; i++) if (tests[t](h[i])) return i;
  return -1;
}
function pushVendorMaster(req) {
  var out = { status: "error", rows: 0, message: "" };
  try {
    var company = String(req.company || "").trim().toUpperCase();
    if (EC_COMPANIES.indexOf(company) === -1) { out.message = "company ต้องเป็น RUAMSINTHAI / ASIA / ROBOTICS"; return out; }
    var h = (req.headers || []).map(function (x) { return String(x || "").trim(); }), rows = req.rows || [];
    var party = /(ลูกค้า|ผู้ขาย|คู่ค้า|ผู้จำหน่าย)/;
    var iCode = vmFind(h, [function (x) { return /รหัส/.test(x) && party.test(x); }, function (x) { return x === "รหัส" || /^(CUST_CD|CUST|CODE)$/i.test(x); }]);
    var iName = vmFind(h, [function (x) { return /ชื่อ/.test(x) && party.test(x) && !/ผู้ติดต่อ|ภาษาอังกฤษ/.test(x); }, function (x) { return x === "ชื่อ" || /^(CUST_NAME|CUST_DES|NAME)$/i.test(x); }]);
    var iTax = vmFind(h, [function (x) { return /ผู้เสียภาษี|เลขประจำตัว|BUSINESS_NO/i.test(x); }]);
    var iTel = vmFind(h, [function (x) { return /โทรศัพท์|เบอร์โทร|^TEL/i.test(x); }]);
    if (iCode === -1 || iName === -1) { out.message = "ไม่พบคอลัมน์ รหัสลูกค้า/ผู้ขาย และ ชื่อลูกค้า/ผู้ขาย"; return out; }
    var now = new Date().toISOString(), seen = {}, clean = [];
    rows.forEach(function (r) {
      var code = String(r[iCode] == null ? "" : r[iCode]).trim(), name = String(r[iName] == null ? "" : r[iName]).trim();
      if (!code || !name || seen[code] || /^(รวม|ผลรวม|total)/i.test(code)) return;
      seen[code] = 1;
      clean.push([company, code, name, iTax === -1 ? "" : String(r[iTax] || "").trim(), iTel === -1 ? "" : String(r[iTel] || "").trim(), now]);
    });
    if (!clean.length) { out.message = "ไม่มีรายชื่อที่ใช้ได้"; return out; }
    var lock = LockService.getScriptLock(); lock.waitLock(30000);
    try {
      var ss = SpreadsheetApp.openById(DATA_HUB_ID), sh = ss.getSheetByName(VENDOR_TAB) || ss.insertSheet(VENDOR_TAB);
      var keep = [];
      if (sh.getLastRow() > 1) keep = sh.getRange(2, 1, sh.getLastRow() - 1, VENDOR_HEAD.length).getValues().filter(function (r) { return String(r[0]) !== company; });
      var all = keep.concat(clean);
      sh.clearContents();
      sh.getRange(1, 1, 1, VENDOR_HEAD.length).setValues([VENDOR_HEAD]);
      sh.getRange(2, 1, all.length, VENDOR_HEAD.length).setNumberFormat("@").setValues(all);
    } finally { lock.releaseLock(); }
    out.status = "ok"; out.rows = clean.length;
  } catch (err) { out.message = String(err && err.message ? err.message : err); }
  return out;
}
function saveVendorMasterForClient(req) { return JSON.stringify(pushVendorMaster(req)); }
// อ่านรายชื่อลูกค้า/ผู้ขาย: หลักคือชีต DH_PARTNER_MASTER (ที่ดึงจาก ECOUNT เข้า Data Hub) + DH_VENDOR (ถ้ามี)
// คืน rows: [บริษัท, รหัส, ชื่อ, เลขผู้เสียภาษี, โทรศัพท์, เงื่อนไขการชำระเงิน, สถานะ]
function getVendorMasterJson() {
  var out = { rows: [], updated: {}, source: [], cols: {}, error: "" };
  try {
    var ss = SpreadsheetApp.openById(DATA_HUB_ID), party = /(ลูกค้า|ผู้ขาย|คู่ค้า|ผู้จำหน่าย)/;
    ["DH_PARTNER_MASTER", VENDOR_TAB].forEach(function (tab) {
      var sh = ss.getSheetByName(tab);
      if (!sh || sh.getLastRow() < 2) return;
      var v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
      var h = v[0].map(function (x) { return String(x).trim(); });
      var iCo = vmFind(h, [function (x) { return /^_?company$/i.test(x) || x === "บริษัท"; }]);
      var iCode = vmFind(h, [function (x) { return /รหัส/.test(x) && party.test(x); }]);
      var iName = vmFind(h, [function (x) { return /ชื่อ/.test(x) && party.test(x) && !/ผู้ติดต่อ|ภาษาอังกฤษ|PIC/i.test(x); }]);
      var iTax = vmFind(h, [function (x) { return /ผู้เสียภาษี|ภาษี|เลขประจำตัว|BUSINESS_NO|TAX/i.test(x); }, function (x) { return /ทะเบียน/.test(x); }, function (x) { return /^หมายเลข/.test(x) && !/โทร|แฟกซ์|fax|มือถือ/i.test(x); }]);
      var iTel = vmFind(h, [function (x) { return /โทรศัพท์|เบอร์โทร|^TEL/i.test(x) && !/มือถือ/.test(x); }, function (x) { return /โทร|มือถือ/.test(x); }]);
      var iPay = vmFind(h, [function (x) { return /เงื่อนไข/.test(x) && /ชำระ|เครดิต|จ่าย/.test(x); }, function (x) { return /เครดิต|credit|payment/i.test(x); }, function (x) { return /เงื่อนไข/.test(x) && !/จัดส่ง|ส่งสินค้า/.test(x); }]);
      var iSt = vmFind(h, [function (x) { return /สถานะ/.test(x); }]);
      var iUp = vmFind(h, [function (x) { return /^_?updated/i.test(x); }]);
      if (iCode === -1 || iName === -1) return;
      out.source.push(tab);
      out.cols[tab] = { code: h[iCode], name: h[iName], tax: iTax === -1 ? "" : h[iTax], tel: iTel === -1 ? "" : h[iTel], pay: iPay === -1 ? "" : h[iPay], status: iSt === -1 ? "" : h[iSt] };
      for (var r = 1; r < v.length; r++) {
        var row = v[r], co = iCo === -1 ? "" : String(row[iCo]).trim(), code = String(row[iCode]).trim(), name = String(row[iName]).trim();
        if (!code || !name) continue;
        out.rows.push([co, code, name, iTax === -1 ? "" : row[iTax], iTel === -1 ? "" : row[iTel], iPay === -1 ? "" : row[iPay], iSt === -1 ? "" : row[iSt]]);
        var up = iUp === -1 ? "" : String(row[iUp]);
        if (up && (!out.updated[co] || up > out.updated[co])) out.updated[co] = up;
      }
    });
    out.wh = ecWarehouses(ss);
  } catch (err) { out.error = String(err); }
  return JSON.stringify(out);
}
// สถานที่รับเข้า (คลัง) จาก Data Hub: [บริษัท, รหัส, ชื่อ]
function ecWarehouses(ss) {
  var m = {}, src = "", add = function (co, code, name) {
    co = String(co || "").trim(); code = String(code || "").trim(); name = String(name || "").trim();
    if (!code && !name) return;
    var k = co + "|" + (code || ("#" + name));
    if (!m[k]) m[k] = [co, code, name, src]; else if (name && !m[k][2]) m[k][2] = name;
  };
  try {
    var loc = ss.getSheetByName(LOC_TAB);
    src = "loc";
    if (loc && loc.getLastRow() > 1) loc.getRange(2, 1, loc.getLastRow() - 1, 3).getDisplayValues().forEach(function (r) { add(r[0], r[1], r[2]); });
  } catch (e) {}
  src = "";
  var src = [
    { tab: "STOCK_BY_WH", co: ["COMPANY"], code: ["WH_CD"], name: ["WH_DES"] },
    { tab: "PO_HEADER", co: ["COMPANY"], code: ["WH_CD"], name: ["WH_DES"] },
    { tab: "PO_LINES", co: ["COMPANY"], code: [], name: ["WAREHOUSE"] },
    { tab: "DH_PO_STATUS", co: ["_company"], code: ["รหัสสถานที่รับเข้า", "รหัสคลัง"], name: ["ชื่อสถานที่รับเข้า", "สถานที่รับเข้า", "ชื่อคลัง"] }
  ];
  src.forEach(function (d) {
    try {
      var sh = ss.getSheetByName(d.tab); if (!sh || sh.getLastRow() < 2) return;
      var v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
      var h = v[0].map(function (x) { return String(x).trim(); });
      var pick = function (names, loose) { for (var i = 0; i < names.length; i++) { var j = h.indexOf(names[i]); if (j > -1) return j; } if (loose) for (var k = 0; k < h.length; k++) if (loose.test(h[k])) return k; return -1; };
      var iCo = pick(d.co), iCode = pick(d.code), iName = pick(d.name, d.tab === "DH_PO_STATUS" ? /สถานที่|คลัง/ : null);
      if (iCode === -1 && iName === -1) return;
      for (var r = 1; r < v.length; r++) add(iCo === -1 ? "" : v[r][iCo], iCode === -1 ? "" : v[r][iCode], iName === -1 ? "" : v[r][iName]);
    } catch (e) {}
  });
  try {
    var c = ss.getSheetByName("รหัส ECOUNT");
    if (c && c.getLastRow() > 1) c.getRange(2, 1, c.getLastRow() - 1, Math.min(4, c.getLastColumn())).getDisplayValues().forEach(function (r) { if (r[0] === "คลัง") add(r[3] || "", r[2], r[1]); });
  } catch (e) {}
  return Object.keys(m).map(function (k) { return m[k]; });
}
function loadVendorMasterForClient() { return getVendorMasterJson(); }


// ================= v5.9.5: สถานที่รับเข้า (คลัง) ที่นำเข้าจากหน้า "ตั้งค่า" — ชีต DH_LOCATION (รหัสต้องตรงกับ ECOUNT) =================
var LOC_TAB = "DH_LOCATION";
var LOC_HEAD = ["_company", "รหัสสถานที่", "ชื่อสถานที่", "_updated"];
function pushLocations(req) {
  var out = { status: "error", rows: 0, message: "" };
  try {
    var company = String(req.company || "").trim().toUpperCase();
    if (EC_COMPANIES.indexOf(company) === -1) { out.message = "company ต้องเป็น RUAMSINTHAI / ASIA / ROBOTICS"; return out; }
    var now = new Date().toISOString(), seen = {}, clean = [];
    (req.rows || []).forEach(function (r) {
      var code = String(r[0] == null ? "" : r[0]).trim(), name = String(r[1] == null ? "" : r[1]).trim();
      if (!code || seen[code]) return;
      seen[code] = 1; clean.push([company, code, name || code, now]);
    });
    if (!clean.length && !req.allowEmpty) { out.message = "ไม่มีรายการสถานที่ที่ใช้ได้"; return out; }
    var lock = LockService.getScriptLock(); lock.waitLock(30000);
    try {
      var ss = SpreadsheetApp.openById(DATA_HUB_ID), sh = ss.getSheetByName(LOC_TAB) || ss.insertSheet(LOC_TAB);
      var keep = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, LOC_HEAD.length).getValues().filter(function (r) { return String(r[0]) !== company; }) : [];
      var all = keep.concat(clean);
      sh.clearContents();
      sh.getRange(1, 1, 1, LOC_HEAD.length).setValues([LOC_HEAD]);
      if (all.length) sh.getRange(2, 1, all.length, LOC_HEAD.length).setNumberFormat("@").setValues(all);
    } finally { lock.releaseLock(); }
    out.status = "ok"; out.rows = clean.length;
  } catch (err) { out.message = String(err && err.message ? err.message : err); }
  return out;
}
function saveLocationsForClient(req) { return JSON.stringify(pushLocations(req)); }
