/* ==========================================================================
 * MODULE 08  VIEW: ภาพรวม
 * ตารางสถานะทุก PO และการอนุมัติ
 * ฟังก์ชัน: vOverview, vPOStatus
 * ========================================================================== */
function vOverview(D,R){
  const P=R.pos,c=f=>P.filter(f).length;
  const leak=R.r1.reduce((s,r)=>s+r.leak,0),k=(st,cls,n,t)=>`<button class="kpi ${cls}" data-act="kpi" data-v="${st}" style="text-align:left;font-weight:400" title="ดูรายการในแท็บสถานะใบสั่งซื้อ"><b>${n}</b><span>${t}</span></button>`;
  return `<div class="kpis">
    ${k('','',P.length,'ใบสั่งซื้อทั้งหมด')}
    ${k('ready','ok',c(p=>p.all==='ok'),'ผ่านครบ 3 ขั้น พร้อมจ่าย')}
    ${k('wait','warn',c(p=>p.d2==='wait'),'รอส่ง (ยังไม่มีของเข้า)')}
    ${k('out','bad',c(p=>p.nOut>0&&p.d2!=='wait'),'ค้างส่ง (ส่งมาแล้วบางรายการ)')}
    ${k('bad','bad',c(p=>p.all==='bad'),'ต้องแก้ไข')}
    <div class="kpi ${leak>0?'bad':''}"><b>${fm(leak)}</b><span>มูลค่าที่จ่ายเกินราคาโปร (บาท)</span></div>
    <div class="kpi ${P.reduce((a,x)=>a+x.comp.out,0)>0?'warn':''}"><b>${fm(P.reduce((a,x)=>a+x.comp.out,0))}</b><span>ส่วนลดชดเชยยังไม่ครบ (บาท)</span></div></div>
  <section class="card"><h2>ภาพรวม</h2><p>กดที่ตัวเลขเพื่อเปิดรายการ PO ในแท็บ “สถานะใบสั่งซื้อ” PO ที่ยังส่งของไม่ครบทุกรายการแสดงสถานะ ค้างส่ง ที่แท็บนั้น ส่วนแท็บ ② เทียบเฉพาะรายการที่ส่งมาแล้วกับ PO แบบ 1:1</p>
  <div class="tw"><table><thead><tr><th>ขั้นตอน</th><th class="n">ผ่าน</th><th class="n">รอเอกสาร</th><th class="n">ยังไม่ครบ / ค้างส่ง</th><th class="n">ไม่ตรง / ต้องแก้ไข</th></tr></thead><tbody>
  ${[['① PO เทียบโปรโมชั่น',p=>p.na?'wait':p.s1],['② ส่งมอบ (ทั้ง PO)',p=>p.s2],['③ ใบกำกับภาษี',p=>p.s3],['สรุป',p=>p.all]].map(([t,f])=>`<tr><td>${t}</td><td class="n">${c(p=>f(p)==='ok')}</td><td class="n">${c(p=>f(p)==='wait')}</td><td class="n">${c(p=>f(p)==='warn')}</td><td class="n">${c(p=>f(p)==='bad')}</td></tr>`).join('')}
  </tbody></table></div></section>`}

function vPOStatus(D,R){
  const ids=Object.values(D.appr||{}).map(a=>a.by);names(ids);
  const rows=poRowsF(D,R.pos),stl={'':'ทุกสถานะ',ready:'พร้อมจ่าย',wait:'รอส่ง',out:'ค้างส่ง',bad:'ต้องแก้ไข'};
  return `<section class="card"><h2>สถานะใบสั่งซื้อ</h2><p>สถานะส่งมอบของทั้ง PO: รอส่ง = ยังไม่มีของเข้าเลย · ค้างส่ง = ส่งมาแล้วแต่ยังไม่ครบทุกรายการตาม PO · ส่งครบ = ครบทุกรายการ กดที่ป้ายสถานะหรือแถวเพื่อดูรายละเอียดของ PO นั้น</p>${tools(rows.length,D)}
  <div class="row"><span class="sub">สถานะ:</span>${Object.entries(stl).map(([k,t])=>`<button class="sm${F.st===k?' pri':''}" data-act="stF" data-v="${k}">${t}</button>`).join('')}</div>
  <div class="tw"><table><thead><tr><th>เลขที่ PO</th><th>ผู้จำหน่าย</th><th>วันที่</th><th class="n">มูลค่า</th><th>① โปรโมชั่น</th><th>② ส่งมอบ (ทั้ง PO)</th><th class="n">รายการ ส่งครบ / ทั้งหมด</th><th>③ ใบกำกับ</th><th>สรุป</th><th>การอนุมัติ</th></tr></thead><tbody>
  ${rows.slice(0,CAP).map(p=>{const id=p.po._id||idOf(p.po.poNo),a=(D.appr||{})[id],no=p.po.poNo;
    const ap=a?`<span class="pill ${a.kind==='ready'?'ok':'info'}">${a.kind==='ready'?'อนุมัติจ่ายแล้ว':'อนุมัติข้อยกเว้น'}</span><div class="sub">${esc(NAMES[a.by]||'')} ${esc((a.at||'').slice(0,10))}${a.note?' · '+esc(a.note):''}</div><button class="sm" data-w data-act="unappr" data-id="${esc(id)}">ยกเลิก</button>`
      :EXC===id?`<div class="row"><input id="excNote" placeholder="เหตุผลที่อนุมัติ" style="width:150px"><button class="sm pri" data-act="excSave" data-id="${esc(id)}">บันทึก</button><button class="sm" data-act="excCancel">เลิก</button></div>`
      :p.all==='ok'?`<button class="sm pri" data-w data-act="appr" data-id="${esc(id)}">อนุมัติจ่าย</button>`:`<button class="sm" data-w data-act="exc" data-id="${esc(id)}">อนุมัติข้อยกเว้น</button>`;
    return `<tr class="clk" data-act="pop" data-v="${esc('po|'+no+'|0')}"><td><span class="code">${esc(no)}</span></td><td class="d">${p.po.vendor?esc(vN(D,p.po.vendor)):'<span class="sub">ไม่มีชื่อในไฟล์ที่นำเข้า</span>'}</td><td class="c">${esc(p.po.date||'')}</td><td class="n">${fm(p.total)}</td><td>${pz('po|'+no+'|1',pill(p.na?'wait':p.s1,p.l1))}</td><td>${pz('po|'+no+'|2',pill(p.s2,p.l2))}${p.nOut&&p.s2!=='wait'?`<div class="sub">ค้าง ${p.nOut} รายการ</div>`:''}</td><td class="n">${p.nDone} / ${p.nLine}</td><td>${pz('po|'+no+'|3',pill(p.s3,p.l3))}</td><td>${pz('po|'+no+'|0',pill(p.all,p.label))}</td><td data-stop>${ap}</td></tr>`}).join('')||'<tr><td colspan="10" class="sub">ไม่มีรายการ</td></tr>'}
  </tbody></table></div>${capNote(rows.length)}</section>`}
