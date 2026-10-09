/* ==========================================================================
 * MODULE 11  VIEW: ② PO เทียบใบส่งสินค้า
 * ปุ่มนำเข้าไฟล์ ตารางใบส่งสินค้า และผลเทียบรายบรรทัด
 * ฟังก์ชัน: upPanel, docTable, reBar, vDelivery, reState, reSection, sendRE, priceDetail, reDocs, reCan, drvErr, reBad
 * ========================================================================== */
function upPanel(kind){const t=kind==='del'?'ใบส่งสินค้า / Packing attached sheet':'ใบกำกับภาษี';
  return `<div class="row">
    <button class="pri" data-act="scan" data-v="${kind}" ${BUSY?'disabled':''}>นำเข้าไฟล์ PDF / รูปสแกน${kind==='del'?'ใบส่งสินค้า':'ใบกำกับภาษี'}</button>
    ${kind==='del'?'<button data-act="impX" data-v="re">นำเข้า Excel รายงานรับสินค้า (RE)</button>':''}
    <button data-act="manual" data-v="${kind}">กรอก${t}เอง</button>
    ${BUSY?`<span class="chip">${esc(BUSY)}</span><button class="sm" data-act="stop">หยุด</button>`:''}
  </div><p class="hint">เลือกได้หลายไฟล์พร้อมกัน และไฟล์ PDF หนึ่งไฟล์มีได้หลายใบ ระบบแยกตามเลขที่เอกสารแล้วเปิดให้ตรวจและ match ทีละใบ ${CFG.aiKey?'ใช้ Claude API อ่านเอกสาร รองรับ PDF ที่พิมพ์จากระบบ PDF สแกน และรูปถ่าย':'ใช้ตัวอ่านในเครื่อง: PDF ที่พิมพ์จากระบบอ่านจากข้อความในไฟล์ ส่วนไฟล์สแกนและรูปถ่ายใช้ OCR ซึ่งแม่นยำน้อยกว่า ใส่ Claude API key ที่แท็บ “ตั้งค่า” เพื่อความแม่นยำสูงขึ้น'} ระบบหา PO ที่ตรงกันให้ แล้วเปิดให้ตรวจทานก่อนบันทึกทุกครั้ง</p>`}
function docTable(D,docs,kind,R){return `<div class="tw"><table><thead><tr><th>เลขที่เอกสาร</th><th>วันที่</th><th>ผู้ขาย (จากเอกสาร)</th><th>เลขที่อ้างอิง (Customer P/O No.)</th><th>PO ที่จับคู่ได้</th><th class="n">รายการที่ตรงกับ PO</th><th>ผลการจับคู่</th><th></th></tr></thead><tbody>
  ${docs.map(d=>{const m=docMatch(D,d),n=(d.lines||[]).length,refs=[...new Set([...String(d.refNo||'').split(/[,;]/),...(d.lines||[]).map(l=>l.ref)].map(x=>String(x||'').trim()).filter(Boolean))];
    return `<tr><td><span class="code">${esc(d.docNo)}</span>${kind==='dels'?`<div class="sub">${isRE(d)?'รับสินค้า RE (Excel)':'ใบส่งสินค้า / Packing list'}</div>`:''}</td><td class="c">${esc(d.date||'')}</td><td class="d">${esc(d.vendor||(m?m.po.vendor:'')||'–')}</td><td class="d">${refs.map(x=>`<span class="code">${esc(x)}</span>`).join('<br>')||esc(d.poNo||'–')}</td><td class="d">${m?m.pos.map(q=>`<span class="code">${esc(q.poNo)}</span>${poSteps(R,q.poNo)}`).join(''):pill('bad','ไม่พบ')}</td><td class="n">${m?m.hit+' / '+n:'0 / '+n}</td><td>${!m?pill('bad','ไม่พบ PO'):m.hit===n?pill('ok','ตรงทุกรายการ'):pill('warn','ตรงบางรายการ')}</td><td style="white-space:nowrap">${m?`<button class="sm" data-act="openPO2" data-v="${esc(m.pos.length===1?m.po.poNo:'')}">ดูผลเทียบ</button> `:''}${D.demo||d._hub?'':`<button class="sm" data-w data-act="edit" data-v="${kind}" data-id="${esc(d._id)}">แก้ไข</button>`}</td></tr>`}).join('')||'<tr><td colspan="8" class="sub">ยังไม่มีเอกสาร</td></tr>'}
  </tbody></table></div>`}

function reBar(D,all){if(!hubOn())return'';const rl=all.filter(r=>r.re>EPS),q=rl.reduce((a,r)=>a+r.re,0);
  return `<div class="row" style="align-items:center;gap:10px;margin:6px 0 8px"><span class="hint" style="margin:0;flex:1">จำนวนรับสินค้าตาม RE ดึงจาก Data Hub แท็บ <b>${esc(HUB.reTab||'PURCHASE_LINES')}</b> · RE ${HUB.dels.length.toLocaleString('th-TH')} ใบ · ${(HUB.nr||0).toLocaleString('th-TH')} บรรทัด · รายการ PO ที่รับแล้ว ${rl.length.toLocaleString('th-TH')} รายการ (รวม ${fq(q)} หน่วย)${HUB.skip?' · ข้าม '+HUB.skip.toLocaleString('th-TH')+' บรรทัดที่อ้าง PO ก่อนวันที่เริ่มหรือนอกเงื่อนไข':''}${HUB.noPo?' · '+HUB.noPo.toLocaleString('th-TH')+' บรรทัดไม่มีเลข PO':''}</span>
  <select id="reF" style="width:auto"><option value="">ทุกรายการ</option><option value="has"${F.re==='has'?' selected':''}>เฉพาะที่มีรับเข้า RE</option><option value="none"${F.re==='none'?' selected':''}>ยังไม่มี RE</option></select></div>`}
function vDelivery(D,R){const all=filt(R.r2),rows=!F.re?all:all.filter(r=>F.re==='has'?r.re>EPS:!(r.re>EPS)),rdt=new Map(D.dels.filter(isRE).map(d=>[d.docNo,d.date]));
  return `<section class="card"><h2>② ใบสั่งซื้อเทียบใบส่งสินค้า</h2><p>รวมจำนวนส่งมอบจากทุกใบส่งของ PO เดียวกัน จำนวนที่ยังไม่ครบแสดงสถานะ “ค้างส่ง” พร้อมจำนวนคงค้าง นำเข้ารายงานรับสินค้า (RE) จาก Excel ซ้ำได้ เอกสารและรายการที่มีอยู่แล้วจะไม่ถูกแตะ ระบบเพิ่มและจับคู่เฉพาะรายการใหม่ ถ้ารายการเดียวกันมีทั้งใบส่งสินค้าและ RE ระบบใช้จำนวนจากใบส่งสินค้าและเตือนเมื่อสองเอกสารไม่เท่ากัน</p>${upPanel('del')}<h2>ใบส่งสินค้าที่นำเข้าแล้ว และ PO ที่จับคู่ได้</h2>${hubOn()?`<p class="hint">เอกสารรับสินค้า (RE) ${HUB.dels.length.toLocaleString('th-TH')} ใบจาก Data Hub ถูกนำไปเทียบในตารางผลเทียบรายบรรทัดแล้ว และไม่แสดงซ้ำในตารางนี้</p>`:''}${docTable(D,D.dels.filter(d=>{if(d._hub)return false;const os=docPOs(D,d);return(!F.vendor&&!F.month&&!F.project)||os.some(o=>(!F.vendor||o.vendor===F.vendor)&&(!F.month||String(o.date||'').startsWith(F.month))&&(!F.project||o.project===F.project))}),'dels',R)}${reSection(D)}<h2>ผลเทียบรายบรรทัด</h2>${STEPHINT}${tools(rows.length,D)}${reBar(D,all)}
  <div class="tw"><table><thead><tr><th style="min-width:200px">PO</th><th>รหัสและรายละเอียดสินค้า</th><th class="n">สั่งซื้อ</th><th class="n">ใบส่งสินค้า / Packing list</th><th class="n">รับสินค้าตาม RE</th><th class="n">ค้างส่ง</th><th class="n">ราคา PO หลังหักส่วนลด</th><th class="n">ราคาใบส่ง</th><th style="min-width:96px">สถานะ</th></tr></thead><tbody>
  ${rows.slice(0,CAP).map(r=>`<tr><td><span class="code">${esc(r.poNo)}</span>${poSteps(R,r.poNo)}</td><td class="d"><span class="code">${esc(r.code)}</span><div>${esc(r.name)}</div></td><td class="n">${r.ord?fq(r.ord):'–'}</td><td class="n">${r.pk?fq(r.pk):r.ord?'–':fq(r.del)}${(r.pkDocs||(r.ord?[]:r.docs)).length?`<div class="sub">${esc((r.pkDocs||r.docs).join(', '))}</div>`:''}</td><td class="n">${r.re?'<b>'+fq(r.re)+'</b>':'–'}${(r.reDocs||[]).map(n=>`<div class="sub" style="white-space:nowrap">${esc(n)}${rdt.get(n)?' · '+fd(rdt.get(n)):''}</div>`).join('')}</td><td class="n">${r.out?fq(r.out):'–'}</td><td class="n">${fm(r.poPrice)}${r.priceOk==='ok'?'<div class="sub">ตรงโปรแล้ว</div>':r.priceOk==='no'?'<div>'+pill('warn','ยังไม่ตรงโปร')+'</div>':''}</td><td class="n">${fm(r.docPrice)}</td><td style="white-space:nowrap">${pill(r.lv,r.label)}</td></tr>`).join('')||'<tr><td colspan="9" class="sub">ไม่มีรายการ</td></tr>'}
  </tbody></table></div>${capNote(rows.length)}</section>`}

/* ---------- ออก RE เข้า ECOUNT ----------
   ใบส่งสินค้าที่ผ่านขั้น ② ส่งเป็นไฟล์คำสั่ง (RST-RE-QUEUE …) ไปที่ Google Drive สคริปต์ RE อัตโนมัติใน Data Hub อ่านไฟล์นี้แล้วบันทึกใบซื้อผ่าน ECOUNT OpenAPI
   ผลการบันทึกอ่านกลับจากแท็บ RE_Log ของ Data Hub  S.res = สถานะที่หน้านี้จำไว้ต่อใบส่งสินค้า */
let RES=null;
const reDocs=D=>D.dels.filter(d=>!isRE(d)&&!d._hub);
function reState(d){const s=S.res[d._id],lg=HUB&&HUB.log&&HUB.log[kc(d.docNo)];
  if(lg&&lg.st==='บันทึกแล้ว')return{k:'done',lv:'ok',t:'ออก RE แล้ว '+lg.re};
  if(s&&s.status==='manual')return{k:'manual',lv:'wait',t:'มี RE แล้ว (ระบุเอง)'};
  if(lg&&(lg.st==='ECOUNT ไม่รับ'||lg.st==='ต้องแก้ไข'))return{k:'fail',lv:'bad',t:lg.st+(lg.note?' · '+lg.note:'')+' (แก้ในชีต “รออนุมัติ” ของ Data Hub)'};
  if(lg&&lg.st==='ทดสอบแล้ว')return{k:'queued',lv:'info',t:'ทดสอบแล้ว ยังไม่เข้า ECOUNT'};
  if(lg&&lg.st)return{k:'queued',lv:'warn',t:lg.st+(lg.note?' · '+lg.note:'')};
  if(s)return{k:'queued',lv:'info',t:'ส่งคำสั่งแล้ว รอระบบบันทึก'};
  return{k:'',lv:'',t:''}}
const reCan=x=>x.c.ok&&(!x.s.k||x.s.k==='queued');
function reSection(D){if(D.demo)return'';const docs=reDocs(D).map(d=>({d,c:reCheck(D,d),s:reState(d)})),n=docs.filter(x=>reCan(x)&&x.s.k!=='queued').length,on=mcpCap&&RES!=='busy';
  return `<h2>ออก RE เข้า ECOUNT</h2><p class="hint">ใบส่งสินค้าที่ทุกรายการตรงกับ PO และไม่เกินจำนวนค้างรับ ถือว่าผ่าน และออก RE ได้ทันที หนึ่งใบส่งสินค้าเป็นหนึ่ง RE ราคาใช้ราคา PO หลังหักส่วนลด เมื่อกดออก RE หน้านี้ส่งคำสั่งไปที่ Google Drive แล้วสคริปต์ RE อัตโนมัติใน Data Hub บันทึกเข้า ECOUNT ในรอบถัดไป เลขที่ RE แสดงที่นี่หลังกด “โหลดจาก Data Hub” ใบที่บันทึกใน ECOUNT ด้วยมือไปแล้วให้กด “มี RE แล้ว” เพื่อไม่ให้ออกซ้ำ</p>
  <div class="row" data-w><button class="pri" data-act="reAll" ${on&&n?'':'disabled'}>${RES==='busy'?'กำลังส่งคำสั่ง…':'ออก RE ทุกใบที่ผ่าน ('+n+' ใบ)'}</button>${mcpCap?'':'<span class="sub">ใช้ได้เมื่อเปิดหน้านี้ใน Claude ที่เชื่อมต่อ Google Drive แล้ว</span>'}</div>
  <div class="tw"><table><thead><tr><th>ใบส่งสินค้า</th><th>วันที่</th><th>PO ที่อ้างอิง</th><th class="n">รายการ</th><th class="n">จำนวนรวม</th><th>ผลเทียบ PO</th><th>สถานะ RE</th><th></th></tr></thead><tbody>
  ${docs.map(x=>{const id=esc(x.d._id);return `<tr><td><span class="code">${esc(x.d.docNo)}</span></td><td class="c">${esc(x.d.date||'')}</td><td class="d">${x.c.pos.map(p=>'<span class="code">'+esc(p.poNo)+'</span>').join(', ')||'–'}</td><td class="n">${(x.d.lines||[]).length}</td><td class="n">${fq(x.c.qty)}</td><td class="d">${x.c.ok?pill('ok','ผ่าน'):pill('bad','ไม่ผ่าน')+x.c.why.slice(0,4).map(w=>'<div class="sub">'+esc(w)+'</div>').join('')}</td><td class="d">${x.s.k?pill(x.s.lv,x.s.t):'<span class="sub">ยังไม่ได้ออก</span>'}</td><td style="white-space:nowrap" data-w>${reCan(x)?`<button class="sm pri" data-act="reOne" data-id="${id}" ${on?'':'disabled'}>${x.s.k?'ส่งอีกครั้ง':'ออก RE'}</button> `:''}${!x.s.k?`<button class="sm" data-act="reManual" data-id="${id}">มี RE แล้ว</button>`:x.s.k==='manual'?`<button class="sm" data-act="reClear" data-id="${id}">ยกเลิก</button>`:''}</td></tr>`}).join('')||'<tr><td colspan="8" class="sub">ยังไม่มีใบส่งสินค้า</td></tr>'}
  </tbody></table></div>`}
const drvErr=e=>{const c=e&&e.code;return c==='server_not_connected'||c==='server_not_found'?'ยังไม่ได้เชื่อมต่อ Google Drive ใน Claude เชื่อมต่อที่การตั้งค่า Connectors ก่อน':c==='needs_reauth'?'การเชื่อมต่อ Google Drive หมดอายุ เชื่อมต่อใหม่ใน Claude':c==='not_granted'||c==='consent_required'||c==='approval_required'?'ยังไม่ได้อนุญาตให้หน้านี้ใช้ Google Drive':c==='blocked_by_policy'?'องค์กรไม่อนุญาตให้ใช้ Google Drive จากหน้านี้':'ส่งคำสั่งออก RE ไม่สำเร็จ: '+((e&&e.message)||c||'')};
async function sendRE(ids){if(!mcpCap||RES==='busy')return;const D=DATA(),pick=reDocs(D).filter(d=>ids.includes(d._id)).map(d=>({d,c:reCheck(D,d),s:reState(d)})).filter(reCan);
  if(!pick.length)return toast('ไม่มีใบส่งสินค้าที่ผ่านให้ออก RE');
  RES='busy';render();
  try{const co=hubSet().company,at=new Date().toISOString();let who='';try{if(userCap&&myId){const ps=await userCap.profiles([myId]);who=(ps[myId]&&ps[myId].name)||''}}catch(e){}
    const rows=pick.flatMap(x=>x.c.lines.map(l=>({COMPANY:co,DO_NO:x.d.docNo,DO_DATE:x.d.date||'',VENDOR:l.po.vendor||'',PO_NO:l.po.poNo,WAREHOUSE:l.po.wh||'',PROJECT:l.po.project||'',CUSTOMER_PO:l.ref,ITEM_CODE:l.code,ITEM_NAME:l.name,QTY:l.qty,NET_PRICE:l.price,APPROVED_BY:who,APPROVED_AT:at})));
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'RE_QUEUE');
    const title='RST-RE-QUEUE '+stamp()+' ('+pick.length+' ใบ)';
    await mcpCap.callTool('Google Drive','create_file',{title,contentMimeType:XLSX_MIME,base64Content:XLSX.write(wb,{type:'base64',bookType:'xlsx'})});
    for(const x of pick)await put('res',x.d._id,{docNo:x.d.docNo,status:'queued',file:title,at,by:myId||null});
    toast('ส่งคำสั่งออก RE '+pick.length+' ใบแล้ว สคริปต์ใน Data Hub จะบันทึกเข้า ECOUNT ในรอบถัดไป')}
  catch(e){console.error(e);toast(drvErr(e))}
  RES=null;render()}

let SELINV=null,PRD=null;
const reBad=(r,D)=>r.rePrice!=null&&r.poPrice!=null&&Math.abs(r.rePrice-r.poPrice)>Math.max(D.set.priceTol,0.01);
/* รายละเอียดราคาของรายการหนึ่ง: PO เทียบ โปรโมชั่น เทียบ ราคา_RE (สถานะการซื้อ) */
function priceDetail(D,no,r){const x=r1map(D).get(m1key(no,r.code))||{},tol=Math.max(D.set.priceTol,0.01),q=r.ord||x.qty||0,np=x.promo,d=(a,b)=>a!=null&&b!=null?a-b:null,sg=v=>v==null?'–':(v>0?'+':'')+fm(v),cl=v=>v!=null&&Math.abs(v)>tol?(v>0?'color:var(--bad)':'color:var(--warn)'):'';
  const row=(k,v,n)=>`<tr><td>${k}</td><td class="n"><b>${v}</b></td><td class="sub">${n||''}</td></tr>`,dPO=d(r.poPrice,np),dRE=d(r.rePrice,np),dPR=d(r.rePrice,r.poPrice);
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;padding:6px 2px">
  <div><b>ใบสั่งซื้อ ${esc(no)}</b><table>${row('ราคาตั้งใน PO',fm(x.listPrice),'ก่อนหักส่วนลด')}${row('ส่วนลดใน PO',x.listPrice!=null&&r.poPrice!=null&&x.listPrice>0?fp((1-r.poPrice/x.listPrice)*100)+' · '+fm(x.listPrice-r.poPrice):'–')}${row('ราคา PO หลังหักส่วนลด',fm(r.poPrice))}${row('จำนวนสั่ง',fq(q))}</table></div>
  <div><b>โปรโมชั่น${x.promoSet?' · '+esc(x.promoSet):''}</b><table>${row('MO',fm(x.mo))}${row('ส่วนลดโปร',fp(x.discBase??x.disc),(x.dcQ?'DC:Quarter '+fp(x.dcQ)+' ':'')+(x.dcY?'DC:Yearly '+fp(x.dcY)+' ':'')+(x.dcS?'พิเศษ '+fp(x.dcS):''))}${row('ส่วนลดรวม',fp(x.disc))}${row('NP_Promotion',fm(np),x.nAlt>1?'ดีที่สุดจาก '+x.nAlt+' โปร':'')}</table></div>
  <div><b>ราคา_RE (สถานะการซื้อ)</b><table>${row('ราคา_RE / หน่วย',fm(r.rePrice),(r.reDocs||[]).join(', '))}${row('จำนวนรับ (RE)',r.re?fq(r.re):'–')}</table></div>
  <div><b>ส่วนต่างต่อหน่วย</b><table>
    <tr><td>PO − NP_Promotion</td><td class="n" style="${cl(dPO)}"><b>${sg(dPO)}</b></td><td class="sub">${dPO!=null&&q?'รวม '+sg(dPO*q):''}</td></tr>
    <tr><td>ราคา_RE − NP_Promotion</td><td class="n" style="${cl(dRE)}"><b>${sg(dRE)}</b></td><td class="sub">${dRE!=null&&r.re?'รวม '+sg(dRE*r.re):''}</td></tr>
    <tr><td>ราคา_RE − PO</td><td class="n" style="${cl(dPR)}"><b>${sg(dPR)}</b></td><td class="sub">${dPR!=null&&r.re?'รวม '+sg(dPR*r.re):''}</td></tr></table>
    <div class="sub">${dPO!=null&&dPO>tol?'PO เปิดราคาสูงกว่าโปรโมชั่น':'' }${dRE!=null&&Math.abs(dRE)<=tol&&dPO!=null&&dPO>tol?' · แต่ RE บันทึกตามราคาโปรแล้ว':''}${dPR!=null&&Math.abs(dPR)>tol?' · ราคาที่รับเข้า (RE) ต่างจาก PO ตรวจว่าผู้ขายให้ราคาตามโปรหรือบันทึก RE ผิด':''}${x.note?' · '+esc(x.note):''}</div></div></div>`}
