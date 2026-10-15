/* ==========================================================================
 * MODULE 05  UI HELPERS
 * ฟังก์ชันจัดรูปแบบตัวเลข วันที่ ป้ายสถานะ และข้อความแจ้งเตือน
 * ฟังก์ชัน: vN, $, esc, fm, fq, idOf, fd, fp, fdisc, pill, pz, brkHtml
 * ========================================================================== */
/*ENDLOGIC*/

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fm=n=>n==null?'–':Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
const fq=n=>n==null?'–':Number(n).toLocaleString('th-TH',{maximumFractionDigits:3});
const idOf=s=>{s=String(s).trim();const c=s.replace(/[^A-Za-z0-9_\-]/g,'_').slice(0,120)||'x';if(c===s)return c;let h=0;for(const ch of s)h=(h*31+ch.codePointAt(0))>>>0;return c+'-'+h.toString(36)};
const fd=d=>{if(!d)return'ไม่ระบุ';const x=new Date(d+'T00:00:00');return isNaN(x)?d:x.toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'2-digit'})};
const fp=n=>n==null?'–':Number(n).toLocaleString('th-TH',{maximumFractionDigits:2})+'%';
const fdisc=(d,price)=>d!=null?fp(d):price!=null?'<span class="sub">ราคาโปร</span>':'–';
const pill=(lv,t)=>{const x=String(t??''),c=lv!=='ok'&&/ค้างส่ง/.test(x)?'bad':/^(ส่งมอบ )?รอส่ง/.test(x)?'warn':lv;return `<span class="pill ${c}">${esc(t)}</span>`};
/* ป้ายสถานะที่กดแล้วเปิดหน้าต่างรายละเอียด k = ชนิด|ค่า */
const pz=(k,h)=>`<span class="pbtn" role="button" tabindex="0" data-act="pop" data-v="${esc(k)}" title="กดเพื่อดูรายละเอียด">${h}</span>`;
/* ชื่อผู้จำหน่าย: ถ้าข้อมูลเป็นรหัส ใช้ชื่อจากตั้งค่า "ชื่อผู้ขาย" (รหัส = ชื่อ) */
function vN(D,v){const t=String(v??'').trim();if(!t)return'';const k=nk(t);for(const ln of String((D&&D.set&&D.set.vendorAlias)||'').split(/\r?\n/)){const i=ln.indexOf('=');if(i>0&&nk(ln.slice(0,i))===k){const n=ln.slice(i+1).trim();if(n)return n}}return t}
/* แสดงส่วนลดทั้งหมดของใบกำกับและที่มา (b = ผลจาก invBreak) */
const brkHtml=(b,long)=>b.disc>0.005||b.parts.length?`${b.odd?`<div>${pill('warn','ส่วนลด '+fp(b.pct)+' ไม่เป็นจำนวนเต็มหรือ .50 ตรวจยอดส่วนลดและยอดรายการ')}</div>`:''}<div>ส่วนลดทั้งหมด <b>${fm(b.disc)}</b> บาท คิดเป็น <b>${fp(b.pct)}</b> ของยอดตามราคาในใบกำกับ ${fm(b.base)}</div>${b.parts.map(x=>`<div class="${long?'':'sub'}">${long?'· ':''}${esc(x.label)} <b>${fp(x.pct)}</b> (${fm(x.amt)} บาท)</div>`).join('')}`:'<div class="sub">ไม่มีส่วนลดในใบกำกับ</div>';
let toastT;function toast(m){const t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,4500)}
