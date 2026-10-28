// RST GROUP - PriceLogic Procurement : Code.gs (v5.5)
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
  if (req && req.action === "retail") return jsonOut(getRetailPrices(req));
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
  var out = { byCode: {}, sheet: "", rows: 0, error: "" };
  try {
    var ss = SpreadsheetApp.openById(DATA_HUB_ID);
    var src = [
      { tab: "DH_PO_STATUS", co: "_company", code: "รหัสสินค้า", vendor: "ลูกค้า/ผู้ขาย", vcode: "รหัสผู้ขาย", date: "วันที่", net: "ราคาต่อหน่วยหลังส่วนลด", price: "ราคาต่อหน่วย", qty: "จำนวน", po: "เลขที่ใบสั่งซื้อ" },
      { tab: "PO_LINES", co: "COMPANY", code: "ITEM_CODE", vendor: "VENDOR", vcode: "", date: "PO_DATE", net: "NET_PRICE", price: "UNIT_PRICE", qty: "QTY", po: "PO_NO" }
    ];
    var agg = {};
    for (var s = 0; s < src.length; s++) {
      var d = src[s], sh = ss.getSheetByName(d.tab);
      if (!sh || sh.getLastRow() < 2) continue;
      var v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
      var h = v[0].map(function (x) { return String(x).trim(); });
      var c = {}; ["co", "code", "vendor", "vcode", "date", "net", "price", "qty", "po"].forEach(function (k) { c[k] = d[k] ? h.indexOf(d[k]) : -1; });
      if (c.code < 0 || c.vendor < 0) continue;
      for (var i = 1; i < v.length; i++) {
        var r = v[i], code = String(r[c.code] || "").trim(), vendor = String(r[c.vendor] || "").trim();
        if (!code || !vendor) continue;
        var price = c.net >= 0 ? vhNum(r[c.net]) : 0;
        if (!price && c.price >= 0) price = vhNum(r[c.price]);
        var co = c.co >= 0 ? String(r[c.co] || "").trim() : "";
        var key = co + "|" + vendor, date = vhIsoDate(c.date >= 0 ? r[c.date] : "");
        var byV = agg[code] || (agg[code] = {});
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
  } catch (err) { out.error = String(err); }
  return JSON.stringify(out);
}
function loadVendorHistForClient() { return getVendorHistJson(); }

// ================= ราคาปลีกจากเมนูลงทะเบียนสินค้า ECOUNT (OUT_PRICE) ผ่าน API =================
// คืนค่า { prices: { "รหัสสินค้า": { out: ราคาขายในทะเบียนสินค้า, ex: ราคาไม่รวมภาษี (out / 1.07) } }, errors: {...} }
// เก็บผลไว้ในแคช 6 ชั่วโมงต่อรหัสสินค้า เพื่อลดจำนวนครั้งที่เรียก API
function ecFindOutPrice(node, code, depth) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) { var a = ecFindOutPrice(node[i], code, depth + 1); if (a) return a; }
    return null;
  }
  if (typeof node === "object") {
    if (node.OUT_PRICE !== undefined && (!node.PROD_CD || String(node.PROD_CD).trim() === code)) return node;
    for (var k in node) { if (node[k] && typeof node[k] === "object") { var b = ecFindOutPrice(node[k], code, depth + 1); if (b) return b; } }
  }
  return null;
}
function getRetailPrices(req) {
  var out = { prices: {}, errors: {}, error: "" };
  try {
    var company = String(req.company || "").trim();
    var codes = (req.codes || []).map(function (c) { return String(c || "").trim(); }).filter(function (c) { return c; });
    codes = codes.filter(function (c, i) { return codes.indexOf(c) === i; }).slice(0, 100);
    if (!company || !codes.length) { out.error = "ไม่ได้ระบุบริษัทหรือรหัสสินค้า"; return JSON.stringify(out); }
    var cache = CacheService.getScriptCache(), todo = [];
    codes.forEach(function (c) {
      var hit = cache.get("rp_" + company + "_" + c);
      if (hit) out.prices[c] = JSON.parse(hit); else todo.push(c);
    });
    if (todo.length) {
      var s = ecSession(company, false);
      var call = function (list, sess) {
        return UrlFetchApp.fetchAll(list.map(function (c) {
          return { url: ecHost(sess.zone) + "/OAPI/V2/InventoryBasic/ViewBasicProduct?SESSION_ID=" + encodeURIComponent(sess.sid),
                   method: "post", contentType: "application/json", payload: JSON.stringify({ PROD_CD: c }), muteHttpExceptions: true };
        }));
      };
      for (var i = 0; i < todo.length; i += 10) {
        var chunk = todo.slice(i, i + 10), res = call(chunk, s);
        var expired = res.some(function (r) { return /session/i.test(r.getContentText().substring(0, 400)); });
        if (expired) { s = ecSession(company, true); res = call(chunk, s); }
        res.forEach(function (r, j) {
          var c = chunk[j], json = null;
          try { json = JSON.parse(r.getContentText()); } catch (e) {}
          var item = json ? ecFindOutPrice(json.Data || json, c, 0) : null;
          if (!item) { out.errors[c] = json && json.Error ? (json.Error.Message || JSON.stringify(json.Error)).substring(0, 150) : "ไม่พบสินค้า/ราคาขายในทะเบียนสินค้า"; return; }
          var o = parseFloat(String(item.OUT_PRICE).replace(/,/g, "")) || 0;
          var p = { out: o, ex: Math.round(o / 1.07 * 100) / 100 };
          out.prices[c] = p;
          cache.put("rp_" + company + "_" + c, JSON.stringify(p), 21600);
        });
        if (i + 10 < todo.length) Utilities.sleep(300);
      }
    }
  } catch (err) { out.error = String(err && err.message ? err.message : err); }
  return JSON.stringify(out);
}
function loadRetailPricesForClient(req) { return getRetailPrices(req); }
