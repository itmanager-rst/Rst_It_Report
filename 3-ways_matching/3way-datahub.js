/**
 * RST 3-Way Matching — ส่วนเชื่อม Data Hub (วางคู่กับ rst-app-datahub.js)
 *
 * ใส่ในหน้า 3-Way Matching (ก่อน </body>):
 *   <div id="datahub-slot"></div>        ← (ไม่บังคับ) ตำแหน่งที่ต้องการให้แถบ "โหลดจาก Data Hub" แสดง
 *   <script src="rst-app-datahub.js"></script>
 *   <script src="3way-datahub.js"></script>
 *
 * เมื่อกด "โหลดจาก Data Hub" จะได้:
 *   window.RST3WAY.po        → แถวสถานะใบสั่งซื้อ (ตัดแถวสรุปยอด "รวม" ออกแล้ว)
 *   window.RST3WAY.purchase  → แถวสถานะการซื้อ (มีเลข RE, โครงการ, เลขที่ใบส่งสินค้า/ใบกำกับภาษี)
 *   window.RST3WAY.projectOf(po)   → ชื่อโครงการของ PO นั้น (จากสถานะการซื้อ หรือสถานะใบสั่งซื้อ)
 *   window.RST3WAY.reOf(po)        → รายการเลข RE ของ PO นั้น
 *   window.RST3WAY.reOfDoc(docNo)  → เลข RE ที่อ้างอิงใบส่งสินค้า/ใบกำกับภาษี (DT/IV) นั้น
 * และเกิด event: document.addEventListener('datahub:loaded', e => { e.detail.po, e.detail.purchase })
 *
 * ถ้าแอปมีฟังก์ชันรับข้อมูล PO จาก Excel อยู่แล้ว ให้ตั้งชื่อฟังก์ชันใน ON_LOADED ด้านล่าง
 */
(function () {
  // URL ของ RST 3-Way Matching API (Apps Script)
  var API_URL = 'https://script.google.com/macros/s/AKfycbzQaVJuwTeIZjp6Vtz-oYctWzcqoCPaiMJqvyqZ0665Qvybii_tf0JqaCMuXNCw9KD_/exec';

  // ชื่อคอลัมน์จาก ECOUNT (แก้ที่นี่ที่เดียวถ้า ECOUNT เปลี่ยนชื่อ)
  var COL = {
    po: 'เลขที่ใบสั่งซื้อ',
    re: 'หมายเลขการซื้อ',
    project: 'ชื่อโครงการ',
    doc: 'เลขที่ใบส่งสินค้า/ใบกำกับภาษี',
    vendor: 'ลูกค้า/ผู้ขาย',
    vendorAlt: 'ชื่อลูกค้า/ผู้ขาย',
    item: 'รหัสสินค้า',
    date: 'วันที่',
    dateSeq: 'วันที่-ลำดับ',
  };

  // (ไม่บังคับ) ชื่อฟังก์ชันของแอปที่จะเรียกเมื่อโหลดเสร็จ เช่น 'loadPOFromRows'  → window[ON_LOADED](po, purchase)
  var ON_LOADED = '';

  var COMPANIES = [['RUAMSINTHAI', 'รวมสินไทย'], ['ASIA', 'RST Asia Pacific'], ['ROBOTICS', 'RST Robotics'], ['', 'ทุกบริษัท']];

  function val(r, k) { var v = r[k]; return v == null ? '' : String(v).trim(); }
  function isSubtotal(r) {
    // แถวสรุปยอดของ ECOUNT เช่น "ต.ค. 2569 รวม" หรือ "รวม"
    return [COL.date, COL.dateSeq, COL.po].some(function (k) { return /(^|\s)รวม\s*$/.test(val(r, k)); });
  }
  function clean(rows) { return (rows || []).filter(function (r) { return !isSubtotal(r); }); }

  var state = { po: [], purchase: [], byPO: {}, byDoc: {} };

  function index() {
    state.byPO = {}; state.byDoc = {};
    function add(map, k, row) { if (!k) return; (map[k] = map[k] || []).push(row); }
    state.purchase.forEach(function (r) { add(state.byPO, val(r, COL.po), r); add(state.byDoc, val(r, COL.doc), r); });
  }

  window.RST3WAY = {
    get po() { return state.po; },
    get purchase() { return state.purchase; },
    COL: COL,
    projectOf: function (po) {
      var a = state.byPO[po] || [];
      for (var i = 0; i < a.length; i++) { var p = val(a[i], COL.project); if (p) return p; }
      var b = state.po.filter(function (r) { return val(r, COL.po) === po; });
      return b.length ? val(b[0], COL.project) : '';
    },
    reOf: function (po) {
      var s = {}; (state.byPO[po] || []).forEach(function (r) { var re = val(r, COL.re); if (re) s[re] = 1; });
      return Object.keys(s);
    },
    reOfDoc: function (doc) {
      var s = {}; (state.byDoc[doc] || []).forEach(function (r) { var re = val(r, COL.re); if (re) s[re] = 1; });
      return Object.keys(s);
    },
    load: load,
  };

  async function load(company) {
    setMsg('กำลังโหลดจาก Data Hub...', '');
    btn.disabled = true;
    try {
      var both = await Promise.all([
        RSTApp.get('PO_STATUS', { company: company, maxAgeSec: 300 }),
        RSTApp.get('PURCHASE_STATUS', { company: company, maxAgeSec: 300 }),
      ]);
      state.po = clean(both[0].data);
      state.purchase = clean(both[1].data);
      index();
      var upd = (both[1].updated || []).concat(both[0].updated || [])
        .filter(function (u) { return !company || u.company === company; })
        .map(function (u) { return u.updated_at; }).sort();
      setMsg('✓ ใบสั่งซื้อ ' + state.po.length.toLocaleString('th-TH') + ' แถว · การซื้อ ' +
             state.purchase.length.toLocaleString('th-TH') + ' แถว' +
             (upd.length ? ' · ' + RSTApp.ago(upd[0]) : ''), 'ok');
      document.dispatchEvent(new CustomEvent('datahub:loaded', { detail: { company: company, po: state.po, purchase: state.purchase } }));
      if (ON_LOADED && typeof window[ON_LOADED] === 'function') window[ON_LOADED](state.po, state.purchase);
    } catch (e) {
      setMsg('โหลดไม่สำเร็จ: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- แถบ "โหลดจาก Data Hub" ----------
  var bar, btn, sel, msg;
  function setMsg(t, kind) { msg.textContent = t; msg.style.color = kind === 'err' ? '#c23b31' : kind === 'ok' ? '#1f7a5a' : '#5b6d80'; }

  function mount() {
    RSTApp.init(API_URL);
    bar = document.createElement('div');
    bar.setAttribute('style', 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 14px;margin:10px 0;border:1px solid #d6e0e9;border-radius:10px;background:#f6f9fb;font:14px system-ui,"Noto Sans Thai",sans-serif;color:#14263a');
    bar.innerHTML = '<b style="color:#0f3d5e">RST GROUP Data Hub</b>';
    sel = document.createElement('select');
    sel.setAttribute('style', 'font:inherit;padding:6px 10px;border:1px solid #c9d6e2;border-radius:8px;background:#fff');
    COMPANIES.forEach(function (c) { var o = document.createElement('option'); o.value = c[0]; o.textContent = c[1]; sel.appendChild(o); });
    try { var last = localStorage.getItem('RST3WAY_COMPANY'); if (last != null) sel.value = last; } catch (e) {}
    btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'โหลดจาก Data Hub';
    btn.setAttribute('style', 'font:inherit;font-weight:600;padding:7px 14px;border:0;border-radius:8px;background:#0f3d5e;color:#fff;cursor:pointer');
    btn.onclick = function () { try { localStorage.setItem('RST3WAY_COMPANY', sel.value); } catch (e) {} load(sel.value); };
    msg = document.createElement('span');
    bar.appendChild(sel); bar.appendChild(btn); bar.appendChild(msg);
    var slot = document.getElementById('datahub-slot');
    if (slot) slot.appendChild(bar); else document.body.insertBefore(bar, document.body.firstChild);
    setMsg('เลือกบริษัทแล้วกดโหลด — ไม่ต้องอัปโหลด Excel', '');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
