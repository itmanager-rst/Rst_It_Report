/**
 * AgriForge MRP — Google Sheets Backend (Apps Script Web App)
 * ---------------------------------------------------------------
 * ทำหน้าที่เป็นฐานข้อมูล (เก็บทุกตารางเป็นชีตแยก อ่านง่าย แก้ผ่าน Sheet ได้โดยตรง)
 * และเป็น "proxy" สำหรับเชื่อมต่อ ECOUNT API (เก็บ credential ไว้ฝั่งเซิร์ฟเวอร์
 * ผ่าน Script Properties เท่านั้น — ไม่เปิดเผยใน HTML ที่ publish บน GitHub Pages)
 *
 * วิธีติดตั้ง: ดู README.md ในโฟลเดอร์นี้ / โฟลเดอร์หลักของ repo
 */

/* ======================= CONFIG ======================= */
const SHEETS = {
  materials: 'Materials',
  products: 'Products',
  bom: 'BOM',
  workOrders: 'WorkOrders',
  dailyLogs: 'DailyLogs',
  purchaseRequests: 'PurchaseRequests',
  prItems: 'PRItems',
  stockLog: 'StockLog',
  sales: 'Sales',
  purchasePriceHistory: 'PurchasePriceHistory', // imported from the app's "สถานะการซื้อ" Excel-import feature
  lists: 'Lists',      // categories / materialCategories / departments / productionSteps
  settings: 'Settings', // key-value: webhookUrl, nextWoSeq, nextPrSeq, nextSoSeq, nextLogSeq
};

const COLS = {
  // Round Q: added purchaseUnit/purchaseToUsageRatio — lets a material's purchase price (manual or
  // imported history) be denominated in a different unit than the one BOM lines consume it in (e.g.
  // ซื้อเป็นราคา/กก. แต่ใช้ในสูตรเป็น/ชิ้น). Also backfilled minOrderQty (Round H, ฝ่ายจัดซื้อ's "จำนวน
  // สั่งซื้อขั้นต่ำ" field) which had never been added here at all. Same standing gotcha as products:
  // this list must be kept in sync with the client's material data model or auto-sync silently drops
  // whatever's missing here.
  materials: ['id','name','category','unit','unitCost','stock','min','safety','supplier','minOrderQty','purchaseUnit','purchaseToUsageRatio','costOverride','bulkUnit','bulkCost','yieldQty','yieldUnit','wastePct'],
  // Round N: replaced the old flat laborWeld/laborAssemble/overhead columns (pre-per-step-labor data
  // model) with the fields the app has actually used since earlier rounds — overheadPct, lotSize,
  // wipItem, and laborByStep (serialized as a JSON string, since production steps are user-configurable
  // so a fixed per-step column layout can't work). Sheets that predate this still have the old columns'
  // data sitting in now-unused trailing cells — harmless, just orphaned — sheet_() re-syncs the header
  // row text to match this array on every call so the labels never go stale even on an existing sheet.
  products: ['id','name','category','active','unit','price','markupPct','scrapPct','overheadPct','lotSize','wipItem','usableAsMaterial','laborByStep','stock'],
  bom: ['productId','materialId','qty','steps'],
  workOrders: ['id','productId','targetQty','lotNo','status','started','created','due'],
  dailyLogs: ['id','date','woId','step','qty','defect'],
  purchaseRequests: ['id','requestedDate','status','approvedDate'],
  prItems: ['prId','materialId','qty'],
  stockLog: ['date','materialId','type','qty','ref'],
  sales: ['id','date','productId','qty'],
  purchasePriceHistory: ['materialId','date','price','supplier','qty','ref'],
  lists: ['type','value','order'],
  settings: ['key','value'],
};

/* ======================= ENTRY POINTS ======================= */
function doGet(e) {
  const action = (e.parameter && e.parameter.action) || 'getState';
  try {
    if (action === 'getState') return jsonOut({ ok: true, state: getState() });
    if (action === 'ping') return jsonOut({ ok: true, message: 'AgriForge MRP backend พร้อมใช้งาน' });
    return jsonOut({ ok: false, message: 'ไม่รู้จัก action: ' + action });
  } catch (err) {
    return jsonOut({ ok: false, message: String(err) });
  }
}

function doPost(e) {
  // ใช้ Content-Type: text/plain ฝั่ง client เพื่อเลี่ยง CORS preflight (Apps Script ไม่รองรับ OPTIONS)
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return jsonOut({ ok: false, message: 'อ่าน request body ไม่ได้: ' + err }); }
  const action = body.action || 'saveState';
  try {
    if (action === 'saveState') { saveState(body.state); return jsonOut({ ok: true, message: 'บันทึกข้อมูลลง Google Sheet แล้ว', savedAt: new Date().toISOString() }); }
    if (action === 'ecountTest') return jsonOut(ecountTest());
    if (action === 'ecountSavePR') return jsonOut(ecountSavePurchaseRequests(body.purchaseRequests || []));
    if (action === 'ecountCreatePR') return jsonOut(ecountCreatePurchaseRequestRows(body.prId, body.headers || [], body.rows || []));
    return jsonOut({ ok: false, message: 'ไม่รู้จัก action: ' + action });
  } catch (err) {
    return jsonOut({ ok: false, message: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ======================= SHEET HELPERS ======================= */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name, cols) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(cols);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(cols);
    sh.setFrozenRows(1);
  } else {
    // Keep row 1's header labels in sync with the current schema even on a pre-existing sheet — a
    // code update that adds/renames/reorders columns (like Round N's Products schema change) would
    // otherwise leave stale header text sitting over different data, since writeRows_/readRows_ always
    // address columns positionally via `cols`, never by reading the header text itself.
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
  }
  return sh;
}

function readRows_(name, cols) {
  const sh = sheet_(name, cols);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
  return values
    .filter(function (row) { return row.some(function (c) { return c !== '' && c !== null; }); })
    .map(function (row) {
      const obj = {};
      cols.forEach(function (c, i) { obj[c] = row[i]; });
      return obj;
    });
}

function writeRows_(name, cols, rows) {
  const sh = sheet_(name, cols);
  const lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, cols.length).clearContent();
  if (!rows.length) return;
  const values = rows.map(function (r) { return cols.map(function (c) { return r[c] === undefined || r[c] === null ? '' : r[c]; }); });
  sh.getRange(2, 1, values.length, cols.length).setValues(values);
}

/* ======================= STATE <-> SHEETS ======================= */
function getState() {
  const materials = readRows_(SHEETS.materials, COLS.materials).map(function (m) {
    const out = {
      id: m.id, name: m.name, category: m.category, unit: m.unit,
      unitCost: Number(m.unitCost) || 0, stock: Number(m.stock) || 0, min: Number(m.min) || 0,
      safety: Number(m.safety) || 0, supplier: m.supplier, minOrderQty: Number(m.minOrderQty) || 0,
      purchaseUnit: m.purchaseUnit || '',
      purchaseToUsageRatio: (Number(m.purchaseToUsageRatio) > 0) ? Number(m.purchaseToUsageRatio) : 1,
      costOverride: (m.costOverride === '' || m.costOverride === undefined || m.costOverride === null || isNaN(Number(m.costOverride)) || Number(m.costOverride) < 0) ? null : Number(m.costOverride),
    };
    if (m.bulkUnit) out.bulk = { bulkUnit: m.bulkUnit, bulkCost: Number(m.bulkCost) || 0, yieldQty: Number(m.yieldQty) || 0, yieldUnit: m.yieldUnit, wastePct: Number(m.wastePct) || 0 };
    return out;
  });

  const bomByProduct = {};
  readRows_(SHEETS.bom, COLS.bom).forEach(function (b) {
    if (!bomByProduct[b.productId]) bomByProduct[b.productId] = [];
    bomByProduct[b.productId].push({ materialId: b.materialId, qty: Number(b.qty) || 0, steps: String(b.steps || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean) });
  });
  const products = readRows_(SHEETS.products, COLS.products).map(function (p) {
    let laborByStep = {};
    try { laborByStep = p.laborByStep ? JSON.parse(p.laborByStep) : {}; } catch (e) { laborByStep = {}; }
    const out = {
      id: p.id, name: p.name, category: p.category, active: p.active === true || p.active === 'TRUE' || p.active === 'true',
      unit: p.unit, price: Number(p.price) || 0, markupPct: Number(p.markupPct) || 0, scrapPct: Number(p.scrapPct) || 0,
      overheadPct: (p.overheadPct === '' || p.overheadPct === undefined || p.overheadPct === null) ? 10 : Number(p.overheadPct),
      lotSize: Number(p.lotSize) || 1, laborByStep: laborByStep,
      stock: Number(p.stock) || 0, bom: bomByProduct[p.id] || [],
    };
    if (p.wipItem === true || p.wipItem === 'TRUE' || p.wipItem === 'true') out.wipItem = true;
    out.usableAsMaterial = (p.usableAsMaterial === true || p.usableAsMaterial === 'TRUE' || p.usableAsMaterial === 'true');
    return out;
  });

  const workOrders = readRows_(SHEETS.workOrders, COLS.workOrders).map(function (w) {
    return { id: w.id, productId: w.productId, targetQty: Number(w.targetQty) || 0, lotNo: w.lotNo, status: w.status, started: w.started === true || w.started === 'TRUE' || w.started === 'true', created: w.created, due: w.due };
  });

  const dailyLogs = readRows_(SHEETS.dailyLogs, COLS.dailyLogs).map(function (l) {
    return { id: l.id, date: l.date, woId: l.woId, step: l.step, qty: Number(l.qty) || 0, defect: Number(l.defect) || 0 };
  });

  const itemsByPr = {};
  readRows_(SHEETS.prItems, COLS.prItems).forEach(function (it) {
    if (!itemsByPr[it.prId]) itemsByPr[it.prId] = [];
    itemsByPr[it.prId].push({ materialId: it.materialId, qty: Number(it.qty) || 0 });
  });
  const purchaseRequests = readRows_(SHEETS.purchaseRequests, COLS.purchaseRequests).map(function (r) {
    return { id: r.id, requestedDate: r.requestedDate, status: r.status, approvedDate: r.approvedDate || null, items: itemsByPr[r.id] || [] };
  });

  const stockLog = readRows_(SHEETS.stockLog, COLS.stockLog).map(function (s) {
    return { date: s.date, materialId: s.materialId, type: s.type, qty: Number(s.qty) || 0, ref: s.ref };
  });

  const sales = readRows_(SHEETS.sales, COLS.sales).map(function (s) {
    return { id: s.id, date: s.date, productId: s.productId, qty: Number(s.qty) || 0 };
  });

  const purchasePriceHistory = readRows_(SHEETS.purchasePriceHistory, COLS.purchasePriceHistory).map(function (h) {
    return { materialId: h.materialId, date: h.date, price: Number(h.price) || 0, supplier: h.supplier, qty: Number(h.qty) || 0, ref: h.ref };
  });

  const lists = readRows_(SHEETS.lists, COLS.lists);
  const listOf = function (type) {
    return lists.filter(function (l) { return l.type === type; })
      .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); })
      .map(function (l) { return l.value; });
  };

  const settingsRows = readRows_(SHEETS.settings, COLS.settings);
  const settingsMap = {};
  settingsRows.forEach(function (s) { settingsMap[s.key] = s.value; });

  return {
    materials: materials, products: products, workOrders: workOrders, dailyLogs: dailyLogs,
    purchaseRequests: purchaseRequests, stockLog: stockLog, sales: sales,
    purchasePriceHistory: purchasePriceHistory,
    categories: listOf('category'), materialCategories: listOf('materialCategory'),
    departments: listOf('department'), productionSteps: listOf('productionStep'),
    operators: listOf('operator'), projects: listOf('project'),
    webhookUrl: settingsMap.webhookUrl || '',
    nextWoSeq: Number(settingsMap.nextWoSeq) || 1,
    nextPrSeq: Number(settingsMap.nextPrSeq) || 1,
    nextSoSeq: Number(settingsMap.nextSoSeq) || 1,
    nextLogSeq: Number(settingsMap.nextLogSeq) || 1,
  };
}

function saveState(state) {
  if (!state) throw new Error('ไม่มีข้อมูล state ส่งมา');

  writeRows_(SHEETS.materials, COLS.materials, (state.materials || []).map(function (m) {
    const b = m.bulk || {};
    return {
      id: m.id, name: m.name, category: m.category, unit: m.unit, unitCost: m.unitCost, stock: m.stock, min: m.min, safety: m.safety, supplier: m.supplier, minOrderQty: m.minOrderQty || 0,
      purchaseUnit: m.purchaseUnit || '', purchaseToUsageRatio: (m.purchaseToUsageRatio > 0) ? m.purchaseToUsageRatio : 1,
      costOverride: (typeof m.costOverride === 'number' && !isNaN(m.costOverride) && m.costOverride >= 0) ? m.costOverride : '',
      bulkUnit: b.bulkUnit || '', bulkCost: b.bulkCost || '', yieldQty: b.yieldQty || '', yieldUnit: b.yieldUnit || '', wastePct: b.wastePct || '',
    };
  }));

  writeRows_(SHEETS.products, COLS.products, (state.products || []).map(function (p) {
    return {
      id: p.id, name: p.name, category: p.category, active: !!p.active, unit: p.unit, price: p.price,
      markupPct: p.markupPct, scrapPct: p.scrapPct,
      overheadPct: (p.overheadPct === undefined || p.overheadPct === null) ? '' : p.overheadPct,
      lotSize: p.lotSize || 1, wipItem: !!p.wipItem, usableAsMaterial: !!p.usableAsMaterial,
      laborByStep: JSON.stringify(p.laborByStep || {}), stock: p.stock,
    };
  }));

  const bomRows = [];
  (state.products || []).forEach(function (p) {
    (p.bom || []).forEach(function (b) { bomRows.push({ productId: p.id, materialId: b.materialId, qty: b.qty, steps: (b.steps || []).join(',') }); });
  });
  writeRows_(SHEETS.bom, COLS.bom, bomRows);

  writeRows_(SHEETS.workOrders, COLS.workOrders, (state.workOrders || []).map(function (w) {
    return { id: w.id, productId: w.productId, targetQty: w.targetQty, lotNo: w.lotNo, status: w.status, started: !!w.started, created: w.created, due: w.due };
  }));

  writeRows_(SHEETS.dailyLogs, COLS.dailyLogs, state.dailyLogs || []);

  writeRows_(SHEETS.purchaseRequests, COLS.purchaseRequests, (state.purchaseRequests || []).map(function (r) {
    return { id: r.id, requestedDate: r.requestedDate, status: r.status, approvedDate: r.approvedDate || '' };
  }));
  const prItemRows = [];
  (state.purchaseRequests || []).forEach(function (r) {
    (r.items || []).forEach(function (it) { prItemRows.push({ prId: r.id, materialId: it.materialId, qty: it.qty }); });
  });
  writeRows_(SHEETS.prItems, COLS.prItems, prItemRows);

  writeRows_(SHEETS.stockLog, COLS.stockLog, state.stockLog || []);
  writeRows_(SHEETS.sales, COLS.sales, state.sales || []);
  writeRows_(SHEETS.purchasePriceHistory, COLS.purchasePriceHistory, state.purchasePriceHistory || []);

  const listRows = [];
  (state.categories || []).forEach(function (v, i) { listRows.push({ type: 'category', value: v, order: i }); });
  (state.materialCategories || []).forEach(function (v, i) { listRows.push({ type: 'materialCategory', value: v, order: i }); });
  (state.departments || []).forEach(function (v, i) { listRows.push({ type: 'department', value: v, order: i }); });
  (state.productionSteps || []).forEach(function (v, i) { listRows.push({ type: 'productionStep', value: v, order: i }); });
  // Round K: ผู้ปฏิบัติงาน/โครงการ now round-trip through Sheets too — previously these two lists
  // were entirely absent from getState()/saveState(), so a getState() pull's response never included
  // them (the client's syncPull merge already keeps the LOCAL value for any key genuinely missing
  // from the response, so a same-browser refresh was never actually affected) — but a fresh browser/
  // device relying on Sheets as the source of truth would never receive these lists at all. Fixed by
  // treating them the same as the other master lists here.
  (state.operators || []).forEach(function (v, i) { listRows.push({ type: 'operator', value: v, order: i }); });
  (state.projects || []).forEach(function (v, i) { listRows.push({ type: 'project', value: v, order: i }); });
  writeRows_(SHEETS.lists, COLS.lists, listRows);

  writeRows_(SHEETS.settings, COLS.settings, [
    { key: 'webhookUrl', value: state.webhookUrl || '' },
    { key: 'nextWoSeq', value: state.nextWoSeq },
    { key: 'nextPrSeq', value: state.nextPrSeq },
    { key: 'nextSoSeq', value: state.nextSoSeq },
    { key: 'nextLogSeq', value: state.nextLogSeq },
  ]);
}

/* ======================= ECOUNT API PROXY =======================
 * เก็บ credential ไว้ที่ Script Properties เท่านั้น (Project Settings ›
 * Script Properties ใน Apps Script editor) — ห้ามใส่ในไฟล์ HTML ที่ publish
 * บน GitHub Pages เพราะเป็นหน้าเว็บสาธารณะ ใครก็เปิดดู source ได้
 *
 * ต้องตั้งค่า Script Properties ต่อไปนี้ก่อนใช้งานจริง:
 *   ECOUNT_COM_CODE     - รหัสบริษัทใน ECOUNT
 *   ECOUNT_USER_ID      - user id ที่มีสิทธิ์เรียก API
 *   ECOUNT_API_CERT_KEY - API Certification Key จากหน้า Setup > API 인증키 ใน ECOUNT
 *   ECOUNT_LAN_TYPE     - (ไม่บังคับ) ค่าเริ่มต้น 'ko-KR' ปรับเป็น 'en-US' ได้
 *
 * หมายเหตุ: endpoint สำหรับ "บันทึกใบขอซื้อ" ด้านล่างเป็นโครงสร้างตาม
 * รูปแบบมาตรฐานของ ECOUNT OAPI (Zone -> Login -> Call API ด้วย SESSION_ID)
 * ต้องตรวจสอบชื่อ endpoint ที่แท้จริงจากเอกสาร API ของ ECOUNT
 * (Setup > API 문서 ในระบบ ECOUNT ของบริษัทท่าน) แล้วแก้ที่ตัวแปร
 * ECOUNT_SAVE_PR_PATH ด้านล่างให้ตรงก่อนใช้งานจริง
 */
const ECOUNT_SAVE_PR_PATH = '/OAPI/V2/Purchases/SavePurchasesRequest'; // TODO: ยืนยัน path จริงจากเอกสาร ECOUNT ของบริษัทท่าน

function ecountConfig_() {
  const p = PropertiesService.getScriptProperties();
  return {
    comCode: p.getProperty('ECOUNT_COM_CODE'),
    userId: p.getProperty('ECOUNT_USER_ID'),
    apiCertKey: p.getProperty('ECOUNT_API_CERT_KEY'),
    lanType: p.getProperty('ECOUNT_LAN_TYPE') || 'ko-KR',
  };
}

function ecountGetZone_(cfg) {
  const res = UrlFetchApp.fetch('https://oapi.ecount.com/OAPI/V2/Zone', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ COM_CODE: cfg.comCode }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  const zone = data && data.Data && data.Data.ZONE;
  if (!zone) throw new Error('ไม่สามารถขอ Zone จาก ECOUNT ได้: ' + res.getContentText());
  return zone;
}

function ecountLogin_(cfg, zone) {
  const url = 'https://oapi' + zone + '.ecount.com/OAPI/V2/OAPILogin';
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ COM_CODE: cfg.comCode, USER_ID: cfg.userId, API_CERT_KEY: cfg.apiCertKey, LAN_TYPE: cfg.lanType, ZONE: zone }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  const sessionId = data && data.Data && data.Data.Datas && data.Data.Datas.SESSION_ID;
  if (!sessionId) throw new Error('เข้าสู่ระบบ ECOUNT ไม่สำเร็จ: ' + res.getContentText());
  return sessionId;
}

function ecountTest() {
  const cfg = ecountConfig_();
  if (!cfg.comCode || !cfg.userId || !cfg.apiCertKey) {
    return { ok: false, message: 'ยังไม่ได้ตั้งค่า ECOUNT credentials ใน Script Properties (ECOUNT_COM_CODE / ECOUNT_USER_ID / ECOUNT_API_CERT_KEY)' };
  }
  try {
    const zone = ecountGetZone_(cfg);
    const sessionId = ecountLogin_(cfg, zone);
    return { ok: true, message: 'เชื่อมต่อ ECOUNT สำเร็จ (Zone ' + zone + ')', zone: zone, sessionIdMasked: String(sessionId).slice(0, 6) + '…' };
  } catch (err) {
    return { ok: false, message: 'เชื่อมต่อ ECOUNT ไม่สำเร็จ: ' + err };
  }
}

function ecountSavePurchaseRequests(prList) {
  const cfg = ecountConfig_();
  if (!cfg.comCode || !cfg.userId || !cfg.apiCertKey) {
    return { ok: false, message: 'ยังไม่ได้ตั้งค่า ECOUNT credentials ใน Script Properties — ยังไม่สามารถส่งข้อมูลจริงได้' };
  }
  try {
    const zone = ecountGetZone_(cfg);
    const sessionId = ecountLogin_(cfg, zone);
    const url = 'https://oapi' + zone + '.ecount.com' + ECOUNT_SAVE_PR_PATH + '?SESSION_ID=' + encodeURIComponent(sessionId);
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ PurchaseRequestList: prList }),
      muteHttpExceptions: true,
    });
    const data = JSON.parse(res.getContentText());
    return { ok: true, message: 'ส่งข้อมูลไป ECOUNT แล้ว ' + prList.length + ' ใบ', ecountResponse: data };
  } catch (err) {
    return { ok: false, message: 'ส่งข้อมูลไป ECOUNT ไม่สำเร็จ: ' + err };
  }
}

/*
 * ส่งใบขอซื้อ (1 ใบ, ที่เพิ่งออกจากหน้า "รายการที่รอออกใบขอซื้อ") เข้า ECOUNT ทันทีตอนกด "+ ออก PR"
 * โดยจัดข้อมูลตามคอลัมน์ของ "template ใบขอซื้อ.xlsx" ที่บริษัทกำหนด (ดู ECOUNT_PR_HEADERS ฝั่ง
 * index.html) — ต้องตรวจสอบชื่อ endpoint และชื่อ field จริงจากเอกสาร API ของ ECOUNT ก่อนใช้งานจริง
 * เช่นเดียวกับ ecountSavePurchaseRequests() ด้านบน (ตัวแปร ECOUNT_SAVE_PR_PATH)
 * ถ้ายังไม่ได้ตั้งค่า credentials หรือยังไม่ยืนยัน endpoint ฟังก์ชันนี้จะคืนค่า ok:false แบบไม่ throw
 * เพื่อให้ฝั่งเว็บยังคงแสดงไฟล์ CSV ตาม template ให้ผู้ใช้นำเข้า ECOUNT ได้เองเป็นทางสำรองเสมอ
 */
function ecountCreatePurchaseRequestRows(prId, headers, rows) {
  const cfg = ecountConfig_();
  if (!cfg.comCode || !cfg.userId || !cfg.apiCertKey) {
    return { ok: false, message: 'ยังไม่ได้ตั้งค่า ECOUNT credentials ใน Script Properties — ใช้ไฟล์ CSV ตาม template นำเข้า ECOUNT ด้วยตนเองไปก่อนได้' };
  }
  try {
    const zone = ecountGetZone_(cfg);
    const sessionId = ecountLogin_(cfg, zone);
    // แปลงแต่ละแถวเป็น object คีย์ตามชื่อคอลัมน์ของ template (ปรับ mapping ให้ตรงกับ field name จริงของ ECOUNT ก่อนใช้งานจริง)
    const rowObjects = rows.map(function (r) {
      const o = {};
      headers.forEach(function (h, i) { o[h] = r[i]; });
      return o;
    });
    const url = 'https://oapi' + zone + '.ecount.com' + ECOUNT_SAVE_PR_PATH + '?SESSION_ID=' + encodeURIComponent(sessionId);
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ PurchaseRequestList: rowObjects }),
      muteHttpExceptions: true,
    });
    const data = JSON.parse(res.getContentText());
    return { ok: true, message: 'บันทึกใบขอซื้อ ' + prId + ' เข้า ECOUNT แล้ว (' + rows.length + ' รายการ)', ecountResponse: data };
  } catch (err) {
    return { ok: false, message: 'บันทึกใบขอซื้อ ' + prId + ' เข้า ECOUNT ไม่สำเร็จ: ' + err };
  }
}
