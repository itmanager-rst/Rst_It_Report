/**
 * RST GROUP — แผนนำเข้าเพื่อลดต้นทุน · Database API
 *
 * ผูกกับ Google Sheet "RST GROUP – Import Plan DB" (Extensions → Apps Script)
 * - setup()        สร้าง/ตรวจแท็บและหัวคอลัมน์ จัดรูปแบบ และสร้าง API_TOKEN
 * - doGet(e)       อ่านข้อมูล  ?token=...&table=PO_HISTORY  (table=ALL ได้ทุกแท็บ)
 * - doPost(e)      เขียนข้อมูล JSON {token, action, table, rows, key, ...}
 *
 * action ที่รองรับ
 *   append        เพิ่มแถวต่อท้าย                      {table, rows:[{...}]}
 *   upsert        เพิ่ม/แก้แถวตามคอลัมน์ key            {table, key:'rfq_no', rows:[{...}]}
 *   replace       ลบข้อมูลเดิมทั้งแท็บแล้วเขียนใหม่        {table, rows:[{...}]}
 *   deleteWhere   ลบแถวที่ค่าในคอลัมน์ key ตรงกัน         {table, key:'rfq_no', values:['RFQ-...']}
 *   setSettings   บันทึกค่าตั้งค่า (key/value)           {settings:{company_th:'...', ...}}
 *   setPlan       บันทึกรายการในแผน + ค่าตั้งต้น           {codes:['RM00141',...], months:12, disc_pct:30, lang:'th', company:''}
 *   saveRfq       บันทึก RFQ 1 ใบ (หัว + รายการ)          {rfq:{rfq_no,..., items:[{code,qty,...}]}}
 *
 * หมายเหตุความปลอดภัย: ทุกคำขอต้องมี token ตรงกับ Script Property API_TOKEN
 * อย่าเผยแพร่ token ใน GitHub (โค้ดนี้ไม่มี token ฝังไว้)
 */

const TABLES = {
  PO_HISTORY:   ['ln', 'date', 'po', 'code', 'name', 'cat', 'scope', 'qty', 'price', 'amount', 'vendor', 'project', 'company'],
  ITEM_TR:      ['code', 'name_th', 'name_en', 'name_zh'],
  CATS:         ['cat', 'level', 'note'],
  IMPORTED:     ['ln', 'date', 'po', 'code', 'name', 'qty', 'price', 'amount', 'project', 'dom_price', 'dom_date', 'dom_vendor', 'diff_pct', 'saving', 'company'],
  IMPORT_COSTS: ['ln', 'date', 'po', 'name', 'amount', 'vendor', 'type', 'group', 'company'],
  SETTINGS:     ['key', 'value'],
  PLAN:         ['seq', 'code', 'company', 'name', 'cat', 'added_at'],
  RFQ_LOG:      ['rfq_no', 'created', 'lang', 'currency', 'items', 'files', 'status', 'supplier', 'note'],
  RFQ_ITEMS:    ['rfq_no', 'line', 'code', 'name_th', 'name_doc', 'sub', 'qty', 'remark'],
};
const READ_ONLY_FOR_API = ['COST_SUMMARY', 'README'];
const HEADER_BG = '#1F3A5F';
const TZ = 'Asia/Bangkok';

/* ---------------- menu ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('RST GROUP')
    .addItem('ตั้งค่าฐานข้อมูล (setup)', 'setup')
    .addItem('จัดประเภทค่าใช้จ่ายนำเข้าใหม่', 'classifyImportCosts')
    .addItem('ดู API token', 'showToken')
    .addItem('สร้าง API token ใหม่', 'rotateToken')
    .addToUi();
}

/* ---------------- setup ---------------- */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach((name) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = TABLES[name];
    const cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), head.length)).getValues()[0] : [];
    head.forEach((h, i) => { if (cur[i] !== h) sh.getRange(1, i + 1).setValue(h); });
    sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setFontColor('#FFFFFF').setBackground(HEADER_BG);
    sh.setFrozenRows(1);
  });
  classifyImportCosts();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', Utilities.getUuid());
  ss.toast('ตั้งค่าเสร็จแล้ว · ดู API token ที่เมนู RST GROUP → ดู API token', 'RST GROUP', 8);
}

function showToken() {
  SpreadsheetApp.getUi().alert('API_TOKEN', PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '(ยังไม่มี — รัน setup ก่อน)', SpreadsheetApp.getUi().ButtonSet.OK);
}
function rotateToken() {
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', Utilities.getUuid());
  showToken();
}

/** ใส่ประเภท (type) และกลุ่ม (group) ให้แถวค่าใช้จ่ายนำเข้าจากชื่อรายการ */
function classifyImportCosts() {
  const sh = SpreadsheetApp.getActive().getSheetByName('IMPORT_COSTS');
  if (!sh || sh.getLastRow() < 2) return;
  const n = sh.getLastRow() - 1;
  const names = sh.getRange(2, 4, n, 1).getValues();
  const out = names.map(([nm]) => { const t = costType_(String(nm)); return [t, t === 'ภาษีอากรนำเข้า' ? 'ภาษี' : 'ค่าบริการ']; });
  sh.getRange(2, 7, n, 2).setValues(out);
}
function costType_(n) {
  if (/ภาษีอากร|อากรขาเข้า|duty/i.test(n)) return 'ภาษีอากรนำเข้า';
  if (/D\/O|ADVAN/i.test(n)) return 'ค่า D/O';
  if (/shipping|ชิปปิ้ง|ขนส่ง|freight/i.test(n)) return 'ค่า Shipping';
  return 'ค่าบริการอื่น';
}

/* ---------------- web API ---------------- */
function doGet(e) {
  try {
    auth_(e.parameter.token);
    const t = String(e.parameter.table || 'ALL').toUpperCase();
    if (t === 'ALL') {
      const out = {};
      Object.keys(TABLES).forEach((k) => (out[k] = readTable_(k)));
      out.COST_SUMMARY = readSummary_();
      return json_({ ok: true, data: out });
    }
    if (t === 'COST_SUMMARY') return json_({ ok: true, data: readSummary_() });
    if (!TABLES[t]) throw new Error('unknown table: ' + t);
    return json_({ ok: true, table: t, rows: readTable_(t) });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse(e.postData && e.postData.contents || '{}');
    auth_(body.token);
    lock.waitLock(20000);
    const a = body.action;
    let res;
    if (a === 'append') res = appendRows_(tbl_(body.table), body.rows || []);
    else if (a === 'upsert') res = upsertRows_(tbl_(body.table), body.key, body.rows || []);
    else if (a === 'replace') res = replaceRows_(tbl_(body.table), body.rows || []);
    else if (a === 'deleteWhere') res = deleteWhere_(tbl_(body.table), body.key, body.values || []);
    else if (a === 'setSettings') res = setSettings_(body.settings || {});
    else if (a === 'setPlan') res = setPlan_(body);
    else if (a === 'saveRfq') res = saveRfq_(body.rfq);
    else throw new Error('unknown action: ' + a);
    return json_({ ok: true, result: res });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* not held */ }
  }
}

/* ---------------- table helpers ---------------- */
function auth_(token) {
  const want = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!want || token !== want) throw new Error('unauthorized');
}
function tbl_(name) {
  const t = String(name || '').toUpperCase();
  if (!TABLES[t] || READ_ONLY_FOR_API.includes(t)) throw new Error('table not writable: ' + name);
  return t;
}
function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('missing sheet ' + name + ' — run setup()');
  return sh;
}
function readTable_(name) {
  const sh = sheet_(name), head = TABLES[name], n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, head.length).getValues()
    .filter((r) => r.some((v) => v !== '' && v !== null))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] instanceof Date ? Utilities.formatDate(r[i], TZ, 'yyyy-MM-dd') : r[i]])));
}
function toRow_(name, obj) { return TABLES[name].map((h) => (obj[h] === undefined || obj[h] === null ? '' : obj[h])); }
function appendRows_(name, rows) {
  if (!rows.length) return { appended: 0 };
  const sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, TABLES[name].length).setValues(rows.map((r) => toRow_(name, r)));
  return { appended: rows.length };
}
function replaceRows_(name, rows) {
  const sh = sheet_(name), w = TABLES[name].length;
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, w).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, w).setValues(rows.map((r) => toRow_(name, r)));
  return { rows: rows.length };
}
function upsertRows_(name, key, rows) {
  const head = TABLES[name], ki = head.indexOf(key);
  if (ki < 0) throw new Error('bad key ' + key);
  const sh = sheet_(name), n = Math.max(0, sh.getLastRow() - 1);
  const keys = n ? sh.getRange(2, ki + 1, n, 1).getValues().map((r) => String(r[0])) : [];
  let upd = 0, add = 0; const fresh = [];
  rows.forEach((r) => {
    const i = keys.indexOf(String(r[key]));
    if (i >= 0) { sh.getRange(i + 2, 1, 1, head.length).setValues([toRow_(name, r)]); upd++; } else { fresh.push(r); add++; }
  });
  appendRows_(name, fresh);
  return { updated: upd, added: add };
}
function deleteWhere_(name, key, values) {
  const head = TABLES[name], ki = head.indexOf(key), sh = sheet_(name), n = sh.getLastRow() - 1;
  if (ki < 0 || n < 1) return { deleted: 0 };
  const set = new Set(values.map(String));
  const col = sh.getRange(2, ki + 1, n, 1).getValues();
  let del = 0;
  for (let i = col.length - 1; i >= 0; i--) if (set.has(String(col[i][0]))) { sh.deleteRow(i + 2); del++; }
  return { deleted: del };
}
function setSettings_(obj) {
  const cur = Object.fromEntries(readTable_('SETTINGS').map((r) => [r.key, r.value]));
  Object.assign(cur, obj);
  return replaceRows_('SETTINGS', Object.keys(cur).map((k) => ({ key: k, value: cur[k] })));
}
function setPlan_(b) {
  const sh = sheet_('PLAN');
  const items = Object.fromEntries(readTable_('PLAN').map((r) => [r.code, r]));
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const rows = (b.codes || []).map((c, i) => ({ seq: i + 1, code: c, company: (items[c] && items[c].company) || b.company || '', name: (items[c] && items[c].name) || '', cat: (items[c] && items[c].cat) || '', added_at: (items[c] && items[c].added_at) || today }));
  replaceRows_('PLAN', rows);
  if (b.months) sh.getRange('I2').setValue(b.months);
  if (b.disc_pct) sh.getRange('I3').setValue(b.disc_pct);
  if (b.lang) sh.getRange('I4').setValue(b.lang);
  return { rows: rows.length };
}
function saveRfq_(r) {
  if (!r || !r.rfq_no) throw new Error('rfq_no required');
  const items = r.items || [];
  upsertRows_('RFQ_LOG', 'rfq_no', [{ ...r, items: items.length, files: Array.isArray(r.files) ? r.files.join(',') : r.files }]);
  deleteWhere_('RFQ_ITEMS', 'rfq_no', [r.rfq_no]);
  appendRows_('RFQ_ITEMS', items.map((it, i) => ({ rfq_no: r.rfq_no, line: i + 1, code: it.code, name_th: it.name || it.name_th, name_doc: it.name_doc, sub: it.sub, qty: it.qty, remark: it.remark })));
  return { rfq_no: r.rfq_no, items: items.length };
}
function readSummary_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('COST_SUMMARY');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().filter((r) => r[0]).map((r) => ({ item: String(r[0]).trim(), value: r[1] }));
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
