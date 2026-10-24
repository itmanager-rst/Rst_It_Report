/**
 * RST — รายการรถตีเทิร์น (Trade-in) · ไฟล์เซิร์ฟเวอร์เสริม อยู่ในโปรเจกต์ Apps Script เดียวกับแอปรูปรถ
 * TURN_VERSION: t01-2026-10-24
 *
 * เปิดใช้งาน: ลิงก์ Web App เดิม + ?page=turn   (หรือกดเมนู "รถตีเทิร์น" ในแอปรูปรถ ปุ่มจะโผล่เฉพาะ admin)
 * สิทธิ์:     ทุกคำสั่งในไฟล์นี้ใช้ได้เฉพาะผู้ใช้ที่ล็อกอิน CRM แล้วได้ role = admin เท่านั้น (ตรวจที่เซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนปุ่ม)
 *             token ล็อกอินใช้ร่วมกับแอปรูปรถ (SESSION_SECRET เดียวกัน) ล็อกอินที่ไหนก็ใช้ได้ทั้งสองหน้า
 *
 * ชีต (สร้างอัตโนมัติเมื่อเรียกใช้ครั้งแรก):
 *   TurnCars  รถตีเทิร์น 1 แถวต่อ 1 รายการ (id = UUID)  key = เลขตัวรถแบบเดียวกับชีต Tractors ใช้จับคู่กับ Ecount
 *   TurnLog   ประวัติ เพิ่ม/แก้/ลบ/นำเข้า (ลบแล้วเก็บข้อมูลทั้งแถวไว้ในช่อง detail กู้คืนได้)
 *
 * เชื่อมโยง Ecount: จับคู่ key (เลขตัวรถ) กับชีต Tractors ที่แอปรูปรถนำเข้าจาก Ecount
 *   ถ้ารถตีเทิร์นคันนั้นถูกลงทะเบียนเป็นสินค้ามือสองใน Ecount แล้ว → แสดง สถานะสต็อก / สาขา / ราคา / จำนวนรูป ให้อัตโนมัติ
 *   ไม่ต้องนำเข้าอะไรเพิ่ม ใช้ไฟล์ Ecount ที่นำเข้าในแอปรูปรถอยู่แล้ว
 *
 * ใช้ฟังก์ชันกลางจาก code.js: sheet_ แบบเดียวกันไม่ได้ (HEAD ผูกกับชีตของแอปรูปรถ) จึงมี helper ของตัวเองด้านล่าง
 * แต่ใช้ readAll_/normCar_/applyPrice_/legacyCount_/keyOf_/withLock_/SESSION_ ของ code.js ร่วมกัน
 */
var TURN_VERSION = 't01-2026-10-24';
var TURN_SH = { CARS: 'TurnCars', LOG: 'TurnLog' };
var TURN_HEAD = {
  TurnCars: [
    'id', 'sheetSrc', 'seq', 'source', 'recvDate',              // ที่มา: ชีตต้นทาง, ลำดับเดิม, ประเภทรับเข้า (ตีเทิร์น/รถประมูล/รับซื้อ/กทบ.), วันที่รับเข้า
    'plate', 'brand', 'model', 'chassis', 'engine', 'key', 'year', // ข้อมูลรถ (year = ค.ศ.)
    'regBook', 'taxDue', 'custCode', 'ownerName', 'transferSet', 'idExpire', // เอกสาร / เจ้าของเดิม
    'branch', 'boughtFrom', 'yctCheck', 'holder',                // ส่งรถที่ / ซื้อต่อจาก / เช็ค YCT / ชื่อในเล่มปัจจุบัน (โอนแล้วเข้าชื่อ)
    'status', 'bookOutDate', 'transferDate', 'transferTo', 'transferCode', // สถานะ / เบิกเล่ม / โอนต่อ
    'taxPaid', 'prbPaid', 'note',
    'createdAt', 'createdBy', 'updatedAt', 'updatedBy'
  ],
  TurnLog: ['at', 'user', 'name', 'action', 'id', 'chassis', 'detail']
};
/** ช่องที่ฟอร์มแก้ได้ (ที่เหลือเซิร์ฟเวอร์จัดการเอง) */
var TURN_EDIT = ['sheetSrc', 'seq', 'source', 'recvDate', 'plate', 'brand', 'model', 'chassis', 'engine', 'year',
  'regBook', 'taxDue', 'custCode', 'ownerName', 'transferSet', 'idExpire', 'branch', 'boughtFrom', 'yctCheck', 'holder',
  'status', 'bookOutDate', 'transferDate', 'transferTo', 'transferCode', 'taxPaid', 'prbPaid', 'note'];
var TURN_DATES = ['recvDate', 'taxDue', 'bookOutDate', 'transferDate', 'taxPaid', 'prbPaid'];
var TURN_STATUS = ['ถือครองอยู่', 'รอเอกสาร', 'เบิกเล่มแล้ว', 'โอนต่อแล้ว', 'มีปัญหา'];

/** คำสั่งที่หน้าเว็บเรียกได้ (code.js call() จะมองหาใน TURN_API ถ้าไม่พบใน API) */
var TURN_API = {
  turnBoot: turnBoot, turnSave: turnSave, turnDelete: turnDelete, turnImport: turnImport,
  turnLink: turnLink, turnRestore: turnRestore
};

/* ================= สิทธิ์ ================= */
function turnAdmin_() {
  if (!SESSION_) throw new Error('AUTH: กรุณาเข้าสู่ระบบ');
  if (String(SESSION_.r || '').toLowerCase() !== 'admin') {
    accessLog_(SESSION_, 'turn_denied', 'role=' + SESSION_.r);
    throw new Error('ADMIN: เมนูรถตีเทิร์นเปิดให้เฉพาะผู้ดูแลระบบ (admin) เท่านั้น');
  }
}

/* ================= sheet helpers (ของรถตีเทิร์น) ================= */
function turnSheet_(name) {
  var ss = ss_(), s = ss.getSheetByName(name), h = TURN_HEAD[name];
  if (!s) {
    s = ss.insertSheet(name);
    ensureCols_(s, h.length);
    s.getRange(1, 1, s.getMaxRows(), h.length).setNumberFormat('@');
    s.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#FDE8EA');
    s.setFrozenRows(1);
    if (name === TURN_SH.CARS) s.protect().setWarningOnly(true).setDescription('แก้ผ่านหน้าเว็บ รถตีเทิร์น เท่านั้น'); // เตือนคนแก้ในชีตตรงๆ
  } else {
    var cur = headerOf_(s);
    var miss = h.filter(function (k) { return cur.indexOf(k) < 0; }); // อัปเกรดหัวตาราง: เติมคอลัมน์ใหม่ต่อท้าย ไม่ย้ายของเดิม
    if (miss.length) {
      ensureCols_(s, cur.length + miss.length);
      s.getRange(1, cur.length + 1, 1, miss.length).setNumberFormat('@').setValues([miss]).setFontWeight('bold');
    }
  }
  return s;
}
function turnRead_() {
  var s = turnSheet_(TURN_SH.CARS), n = s.getLastRow(), h = headerOf_(s);
  if (n < 2) return { s: s, h: h, rows: [] };
  var vals = s.getRange(2, 1, n - 1, h.length).getDisplayValues();
  return {
    s: s, h: h, rows: vals.map(function (r, i) {
      var o = { _row: i + 2 }; h.forEach(function (k, j) { if (k) o[k] = r[j]; }); return o;
    }).filter(function (o) { return o.id; })
  };
}
function turnRowOf_(h, o) { return h.map(function (k) { return o[k] == null ? '' : String(o[k]); }); }
function turnLog_(action, rec, detail) {
  try {
    var s = SESSION_ || {};
    appendRows_(turnSheet_(TURN_SH.LOG), [turnRowOf_(TURN_HEAD.TurnLog, {
      at: new Date().toISOString(), user: s.u, name: s.n, action: action,
      id: rec && rec.id, chassis: rec && rec.chassis, detail: String(detail || '').slice(0, 45000)
    })]);
  } catch (e) { }
}
function turnWho_() { return SESSION_ ? (SESSION_.n || SESSION_.u) : 'ไม่ระบุ'; }

/* ================= ทำความสะอาดข้อมูล ================= */
function turnTxt_(v) {
  var t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return /^[-−–—]+$/.test(t) ? '' : t; // ช่องที่ใส่แค่ขีด = ว่าง
}
/** วันที่ → yyyy-MM-dd (ค.ศ.) รับ yyyy-MM-dd / d/m/yyyy (พ.ศ. หรือ ค.ศ.)  แปลงไม่ได้ → คืนข้อความเดิม (เช่น ตลอดชีพ) */
function turnDate_(v) {
  var t = turnTxt_(v);
  if (!t) return '';
  var m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/), y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += y > 50 ? 2500 : 2000; }
  else return t;
  if (y > 2400) y -= 543;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1950 || y > 2200) return t;
  return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
}
/** key จับคู่ Ecount: เลขตัวรถ ตัวใหญ่ ไม่มีช่องว่าง (เหมือน keyOf_ ของแอปรูปรถ) สั้นเกินไป/ไม่สมบูรณ์ = ไม่จับคู่ */
function turnKey_(chassis) {
  var t = turnTxt_(chassis);
  if (!t) return '';
  var k = keyOf_(t);
  return k.replace(/[-\/]/g, '').length >= 5 && !/-$/.test(k) ? k : '';
}
function turnClean_(rec) {
  var o = {};
  TURN_EDIT.forEach(function (k) { o[k] = turnTxt_(rec[k]); });
  o.note = String(rec.note == null ? '' : rec.note).replace(/[ \t]+/g, ' ').trim(); // หมายเหตุเก็บการขึ้นบรรทัดใหม่ไว้
  TURN_DATES.forEach(function (k) { o[k] = turnDate_(o[k]); });
  o.idExpire = turnDate_(o.idExpire);
  if (o.year) { var y = yearOf_(o.year); if (y === null) throw new Error('ปีรถไม่ถูกต้อง ใส่ ค.ศ. หรือ พ.ศ. 4 หลัก'); o.year = y; }
  if (o.status && TURN_STATUS.indexOf(o.status) < 0) o.status = '';
  if (!o.status) o.status = turnAutoStatus_(o);
  o.key = turnKey_(o.chassis);
  if (!o.chassis && !o.plate && !o.engine) throw new Error('ใส่อย่างน้อย หมายเลขรถ / หมายเลขเครื่อง / ทะเบียน อย่างใดอย่างหนึ่ง');
  return o;
}
function turnAutoStatus_(o) {
  if (o.transferDate || o.transferTo) return 'โอนต่อแล้ว';
  if (/เสียชีวิต|ไม่ยอมเซ็น|ไม่ยอมเซ็นต์|ติดปัญหา/.test(o.note || '')) return 'มีปัญหา';
  if (o.bookOutDate) return 'เบิกเล่มแล้ว';
  if (/ไม่.?มีคู่มือ|รอคู่มือ/.test(o.regBook || '') || /ไม่มีชุดโอน/.test(o.transferSet || '')) return 'รอเอกสาร';
  return 'ถือครองอยู่';
}

/* ================= เชื่อม Ecount (ชีต Tractors ของแอปรูปรถ) ================= */
function turnEcount_(keys) {
  var want = {}; keys.forEach(function (k) { if (k) want[legacyNorm_(k)] = k; });
  var out = {};
  if (!Object.keys(want).length) return out;
  var photos = {};
  try { readAll_(SH.PHOTOS).forEach(function (p) { photos[p.key] = (photos[p.key] || 0) + 1; }); } catch (e) { }
  var lc = { p: {} }; try { lc = legacyCount_(); } catch (e) { }
  var cars = []; try { cars = readAll_(SH.TRACTORS).map(normCar_); } catch (e) { }
  cars.forEach(function (c) {
    var nk = legacyNorm_(c.key), k = want[nk];
    if (!k) return;
    var prev = out[k];
    if (prev && prev.status === 'stock' && c.status !== 'stock') return; // มีหลายแถว ใช้แถวที่ยังอยู่ในสต็อก
    applyPrice_(c, lc.p[nk]);
    out[k] = {
      key: c.key, status: c.status, kind: c.kind, type: c.type, series: c.series, name: c.name, code: c.code,
      branch: c.branch, spot: c.spot, price: c.price, priceSrc: c.priceSrc, cond: c.cond, hours: c.hours, reg: c.reg,
      firstSeen: c.firstSeen, lastSeen: c.lastSeen, outDate: c.outDate, photos: photos[c.key] || 0
    };
  });
  return out;
}

/* ================= API ================= */
function turnBoot() {
  turnAdmin_();
  var d = turnRead_();
  var rows = d.rows.map(function (o) { delete o._row; return o; });
  var log = [];
  try {
    var ls = turnSheet_(TURN_SH.LOG), n = ls.getLastRow();
    if (n > 1) {
      var from = Math.max(2, n - 29), h = headerOf_(ls);
      log = ls.getRange(from, 1, n - from + 1, h.length).getDisplayValues().map(function (r) {
        var o = {}; h.forEach(function (k, i) { if (k && k !== 'detail') o[k] = r[i]; }); return o;
      }).reverse();
    }
  } catch (e) { }
  var ecLast = null;
  try { var il = readAll_(SH.LOG); if (il.length) ecLast = il[il.length - 1].at; } catch (e) { }
  var appUrl = ''; try { appUrl = ScriptApp.getService().getUrl(); } catch (e) { }
  return {
    version: TURN_VERSION, codeVersion: CODE_VERSION, me: SESSION_, rows: rows, appUrl: appUrl,
    ecount: turnEcount_(rows.map(function (r) { return r.key; })), ecountAt: ecLast,
    status: TURN_STATUS, log: log
  };
}

/** เพิ่ม (ไม่มี id) หรือแก้ไข (มี id) รถ 1 รายการ
 *  rec.updatedAt ต้องตรงกับในชีต (กันเขียนทับงานคนอื่นที่แก้ไปก่อน)  rec.allowDup = ยอมให้หมายเลขรถซ้ำ */
function turnSave(rec) {
  turnAdmin_();
  rec = rec || {};
  var o = turnClean_(rec);
  return withLock_(function () {
    var d = turnRead_(), now = new Date().toISOString(), who = turnWho_(), cur = null;
    if (rec.id) {
      cur = d.rows.filter(function (r) { return r.id === rec.id; })[0];
      if (!cur) throw new Error('ไม่พบรายการนี้ (อาจถูกลบไปแล้ว) กดรีเฟรช');
      if (rec.updatedAt && cur.updatedAt && rec.updatedAt !== cur.updatedAt)
        throw new Error('CONFLICT: รายการนี้ถูกแก้ไขโดย ' + (cur.updatedBy || 'คนอื่น') + ' หลังจากที่คุณเปิดฟอร์ม กดรีเฟรชแล้วแก้ใหม่');
    }
    if (o.key && !rec.allowDup) {
      var dup = d.rows.filter(function (r) { return r.key === o.key && r.id !== rec.id; })[0];
      if (dup) throw new Error('DUP: หมายเลขรถ ' + o.chassis + ' มีอยู่แล้ว (ทะเบียน ' + (dup.plate || '-') + ', ' + (dup.ownerName || '-') + ')');
    }
    var h = d.h.length ? d.h : TURN_HEAD.TurnCars, out;
    if (cur) {
      out = {}; h.forEach(function (k) { out[k] = cur[k]; });
      var diff = [];
      TURN_EDIT.concat(['key']).forEach(function (k) { if (String(cur[k] || '') !== String(o[k] || '')) { diff.push(k + ': ' + (cur[k] || '∅') + ' → ' + (o[k] || '∅')); out[k] = o[k]; } });
      if (!diff.length) return out;
      out.updatedAt = now; out.updatedBy = who;
      d.s.getRange(cur._row, 1, 1, h.length).setNumberFormat('@').setValues([turnRowOf_(h, out)]);
      turnLog_('แก้ไข', out, diff.join(' | '));
    } else {
      out = o; out.id = Utilities.getUuid(); out.createdAt = now; out.createdBy = who; out.updatedAt = now; out.updatedBy = who;
      appendRows_(d.s, [turnRowOf_(h, out)]);
      turnLog_('เพิ่ม', out, '');
    }
    var res = {}; h.forEach(function (k) { res[k] = out[k] == null ? '' : String(out[k]); });
    res.ec = out.key ? (turnEcount_([out.key])[out.key] || null) : null;
    return res;
  });
}

function turnDelete(id) {
  turnAdmin_();
  return withLock_(function () {
    var d = turnRead_(), cur = d.rows.filter(function (r) { return r.id === id; })[0];
    if (!cur) return { ok: true };
    d.s.deleteRow(cur._row);
    delete cur._row;
    turnLog_('ลบ', cur, JSON.stringify(cur)); // เก็บทั้งแถวไว้ กู้คืนได้ด้วย turnRestore
    return { ok: true };
  });
}

/** กู้คืนรายการที่ลบล่าสุดตาม id (อ่านจาก TurnLog) */
function turnRestore(id) {
  turnAdmin_();
  return withLock_(function () {
    var ls = turnSheet_(TURN_SH.LOG), n = ls.getLastRow(), h = headerOf_(ls);
    if (n < 2) throw new Error('ไม่พบประวัติการลบ');
    var vals = ls.getRange(2, 1, n - 1, h.length).getDisplayValues(), ai = h.indexOf('action'), ii = h.indexOf('id'), di = h.indexOf('detail');
    for (var i = vals.length - 1; i >= 0; i--) {
      if (vals[i][ai] === 'ลบ' && vals[i][ii] === id) {
        var o = JSON.parse(vals[i][di]), d = turnRead_();
        if (d.rows.some(function (r) { return r.id === id; })) throw new Error('รายการนี้มีอยู่แล้ว');
        o.updatedAt = new Date().toISOString(); o.updatedBy = turnWho_();
        appendRows_(d.s, [turnRowOf_(d.h.length ? d.h : TURN_HEAD.TurnCars, o)]);
        turnLog_('กู้คืน', o, '');
        return o;
      }
    }
    throw new Error('ไม่พบประวัติการลบของรายการนี้');
  });
}

/** นำเข้าหลายรายการจาก Excel (หน้าเว็บแปลงไฟล์แล้วส่งมาเป็น rows)
 *  mode 'append'  = เพิ่มเฉพาะรายการที่หมายเลขรถยังไม่มีในระบบ (รายการไม่มีหมายเลขรถ เทียบด้วย ทะเบียน+เลขเครื่อง)
 *  mode 'replace' = ลบข้อมูลเดิมทั้งหมด แล้วใส่ชุดนี้แทน (ข้อมูลเดิมถูกสำรองเป็นชีต TurnCars_backup_วันเวลา) */
function turnImport(rows, mode, fileName) {
  turnAdmin_();
  rows = rows || [];
  return withLock_(function () {
    var d = turnRead_(), now = new Date().toISOString(), who = turnWho_(), h = d.h.length ? d.h : TURN_HEAD.TurnCars;
    var seen = {}, sig = function (o) { return o.key || ('#' + norm2_(o.plate) + '|' + norm2_(o.engine) + '|' + norm2_(o.model)); };
    if (mode === 'replace') {
      if (d.rows.length) {
        var bk = d.s.copyTo(ss_()); bk.setName('TurnCars_backup_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmm'));
        if (d.s.getLastRow() > 1) d.s.deleteRows(2, d.s.getLastRow() - 1);
      }
    } else {
      d.rows.forEach(function (r) { seen[sig(r)] = 1; });
    }
    var add = [], skip = 0, bad = 0;
    rows.forEach(function (r) {
      var o;
      try { o = turnClean_(r); } catch (e) { bad++; return; }
      var k = sig(o);
      if (mode !== 'replace' && seen[k]) { skip++; return; }
      seen[k] = 1;
      o.id = Utilities.getUuid(); o.createdAt = now; o.createdBy = who; o.updatedAt = now; o.updatedBy = who;
      add.push(turnRowOf_(h, o));
    });
    if (add.length) appendRows_(d.s, add);
    turnLog_('นำเข้า', { id: '', chassis: '' }, (fileName || '') + ' | mode=' + mode + ' | เพิ่ม ' + add.length + ' | ข้าม(ซ้ำ) ' + skip + ' | ใช้ไม่ได้ ' + bad + (mode === 'replace' ? ' | แทนที่ของเดิม ' + d.rows.length : ''));
    return { added: add.length, skipped: skip, bad: bad, replaced: mode === 'replace' ? d.rows.length : 0 };
  });
}
function norm2_(s) { return String(s || '').toUpperCase().replace(/[\s\-\/\.]/g, ''); }

/** ลิงก์หน้า รถตีเทิร์น (ให้แอปรูปรถเปิด) */
function turnLink() {
  turnAdmin_();
  var u = ''; try { u = ScriptApp.getService().getUrl(); } catch (e) { }
  return { url: u ? u + (u.indexOf('?') < 0 ? '?' : '&') + 'page=turn' : '' };
}