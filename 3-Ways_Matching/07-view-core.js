/* ==========================================================================
 * MODULE 07  VIEW CORE
 * แท็บ ตัวกรอง และฟังก์ชัน render หลัก
 * ฟังก์ชัน: render, vendors, projects, months, mLabel, filt, tools
 * ========================================================================== */
/* ---------- view state ---------- */
const TABS=[['overview','ภาพรวม','สถานะทุก PO'],['promo','① PO เทียบโปรโมชั่น','รหัส · รายละเอียด · ราคา'],['delivery','② PO เทียบใบส่งสินค้า','จำนวนสั่ง · ส่งมอบ · ค้างส่ง'],['invoice','③ เทียบใบกำกับภาษี','จำนวน · ราคา · ภาษี'],['promos','คลังโปรโมชั่น','รายการ · ส่วนลด · ช่วงเวลา'],['docs','เอกสารและนำเข้า','PO · โปรโมชั่น · เอกสาร'],['settings','ตั้งค่า','เกณฑ์และข้อเสนอ']];
let tab=(location.hash||'').slice(1);if(!TABS.some(t=>t[0]===tab))tab='overview';
const F={q:'',only:false,re:'',brand:'',vendor:'',set:'',project:'',month:'',ptype:''};
let isAdmin=false,PE=null,DT_TYPES=[];
let IMP=null,ED=null,BUSY=null,EXC=null,abortCtl=null;

function render(){
  if(typeof refreshAdmin==='function')refreshAdmin();
  const D=DATA(),R=summary(D);
  document.body.classList.toggle('ro',readOnly);
  chip();
  {const hb=$('#btnHub'),hc=$('#hubChip'),busy=HUBST.s==='busy';hb.hidden=!CFG.gsUrl;hb.disabled=busy;hb.textContent=busy?'กำลังโหลดจาก Data Hub…':hubOn()?'โหลดจาก Data Hub อีกครั้ง':'โหลดจาก Data Hub';
    hc.hidden=!hubOn();if(hubOn())hc.textContent='Data Hub · PO '+HUB.pos.length+' · RE '+HUB.dels.length+' · '+new Date(HUB.at).toLocaleString('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}
  $('#btnSheet').hidden=!CFG.gsUrl;
  $('#rail').innerHTML=TABS.map(t=>`<button data-act="tab" data-v="${t[0]}" aria-current="${t[0]===tab}"><b>${t[1]}</b><span>${t[2]}</span></button>`).join('');
  $('#banner').innerHTML=(D.demo?`<div class="banner">กำลังแสดง<b>ข้อมูลตัวอย่าง</b> ไม่ใช่ข้อมูลของบริษัท เริ่มใช้งานจริงที่แท็บ “เอกสารและนำเข้า” ข้อมูลตัวอย่างจะหายไปเมื่อนำเข้ารายการแรก</div>`:'')+(HUBST.s==='err'?`<div class="banner">${esc(HUBST.msg)}</div>`:'')+(readOnly?`<div class="banner">คุณมีสิทธิ์ดูอย่างเดียว ขอสิทธิ์ Contributor จากเจ้าของหน้าเพื่อบันทึกเอกสาร</div>`:'');
  const m=$('#main');
  
  m.innerHTML=({overview:vOverview,promos:vPromos,promo:vPromo,delivery:vDelivery,invoice:vInvoice,docs:vDocs,settings:vSettings})[tab](D,R);
  const q=$('#q');if(q&&document.activeElement!==q)q.value=F.q;
  const g=$('#gasCode');if(g)g.value=document.getElementById('gas').textContent.trim();
}
const CAP=400,capNote=n=>n>CAP?`<p class="hint">แสดง ${CAP} แถวแรกจาก ${n.toLocaleString('th-TH')} แถว ใช้ช่องค้นหา ผู้จำหน่าย โครงการ หรือเดือน เพื่อจำกัดรายการ ไฟล์ส่งออก Excel มีครบทุกแถว</p>`:'';
const vendors=D=>[...new Set(D.pos.map(p=>p.vendor).filter(Boolean))].sort();
const projects=D=>[...new Set(D.pos.flatMap(p=>[p.project,...(p.lines||[]).map(l=>l.project)]).filter(Boolean))].sort();
const months=D=>[...new Set(D.pos.map(p=>String(p.date||'').slice(0,7)).filter(m=>/^\d{4}-\d{2}$/.test(m)))].sort().reverse();
const mLabel=m=>new Date(m+'-01T00:00:00').toLocaleDateString('th-TH',{month:'long',year:'numeric'});
const filt=rows=>rows.filter(r=>(!F.vendor||r.vendor===F.vendor)&&(!F.month||String(r.date||'').startsWith(F.month))&&(!F.project||r.project===F.project)&&(!F.only||['bad','warn'].includes(r.lv))&&(!F.q||nk(r.poNo+r.code+r.name+(r.vendor||'')).includes(nk(F.q))));
const tools=(n,D)=>`<div class="row"><input id="q" placeholder="ค้นหา PO / รหัส / ชื่อสินค้า" style="flex:1 1 220px" aria-label="ค้นหา"><select id="vend" aria-label="ผู้จำหน่าย" style="max-width:260px"><option value="">ผู้จำหน่ายทั้งหมด</option>${vendors(D).map(v=>`<option ${F.vendor===v?'selected':''}>${esc(v)}</option>`).join('')}</select><select id="proj" aria-label="โครงการ" style="max-width:200px"><option value="">โครงการทั้งหมด</option>${projects(D).map(v=>`<option ${F.project===v?'selected':''}>${esc(v)}</option>`).join('')}</select><select id="mon" aria-label="เดือนของ PO" style="max-width:180px"><option value="">ทุกเดือน</option>${months(D).map(v=>`<option value="${v}" ${F.month===v?'selected':''}>${esc(mLabel(v))}</option>`).join('')}</select><label class="row" style="gap:4px"><input type="checkbox" id="only" ${F.only?'checked':''}> เฉพาะที่มีปัญหา</label><span class="sub">${n} รายการ</span></div>`;
