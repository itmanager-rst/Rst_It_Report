/**
 * RST GROUP — ตัวเชื่อมหน้าเว็บ (GitHub Pages) กับ Backend Apps Script ของแอป
 * ใช้ร่วมกันทุกแอป: แต่ละแอปแค่ตั้ง URL ของ backend ตัวเอง
 *
 *   <script src="rst-app-datahub.js"></script>
 *   RSTApp.init('https://script.google.com/macros/s/....../exec');   // URL backend ของแอปนี้
 *   const po = await RSTApp.get('PO_STATUS', { company: 'RUAMSINTHAI' });
 *   po.data    → [{ 'เลขที่ใบสั่งซื้อ': ..., ... }]
 *   po.updated → เวลาอัปเดตล่าสุดของแต่ละบริษัท
 *
 *   ถ้าแอปตั้ง APP_PIN ไว้ ระบบจะถามรหัสครั้งแรกแล้วจำไว้ในเครื่อง  (ล้าง: RSTApp.resetPin())
 */
(function (root) {
  var cfg = { url: '', pinKey: '' };
  var cache = {};

  function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  async function call(params, retried) {
    if (!cfg.url) throw new Error('ยังไม่ได้ตั้งค่า RSTApp.init(URL ของ backend)');
    var q = Object.assign({}, params);
    var pin = load(cfg.pinKey); if (pin) q.pin = pin;
    Object.keys(q).forEach(function (k) { if (q[k] == null || q[k] === '') delete q[k]; });
    var res = await fetch(cfg.url + '?' + new URLSearchParams(q).toString(), { redirect: 'follow' });
    if (!res.ok) throw new Error('Backend ตอบกลับ HTTP ' + res.status);
    var json = await res.json();
    if (!json.ok) {
      if (/รหัสเข้าใช้แอป/.test(json.error || '') && !retried && root.prompt) {
        var p = (root.prompt('ใส่รหัสเข้าใช้แอป') || '').trim();
        if (p) { store(cfg.pinKey, p); return call(params, true); }
      }
      throw new Error(json.error || 'Backend error');
    }
    return json;
  }

  root.RSTApp = {
    init: function (url) { cfg.url = url; cfg.pinKey = 'RST_APP_PIN:' + url; return root.RSTApp; },
    /** opts: { company, q, limit, offset, maxAgeSec } */
    get: async function (dataset, opts) {
      opts = opts || {};
      var p = { action: 'data', dataset: dataset, company: opts.company, q: opts.q, limit: opts.limit, offset: opts.offset };
      var ck = JSON.stringify(p);
      if (opts.maxAgeSec && cache[ck] && Date.now() - cache[ck].t < opts.maxAgeSec * 1000) return cache[ck].v;
      var v = await call(p);
      cache[ck] = { t: Date.now(), v: v };
      return v;
    },
    info: function () { return call({ action: 'info' }); },
    resetPin: function () { store(cfg.pinKey, null); },
    ago: function (s) {
      if (!s) return 'ยังไม่มีข้อมูล';
      var h = (Date.now() - new Date(String(s).replace(' ', 'T') + '+07:00').getTime()) / 36e5;
      if (h < 1) return 'อัปเดต ' + Math.max(1, Math.round(h * 60)) + ' นาทีที่แล้ว';
      if (h < 48) return 'อัปเดต ' + Math.round(h) + ' ชม.ที่แล้ว';
      return 'อัปเดต ' + Math.round(h / 24) + ' วันที่แล้ว';
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
