/* ==========================================================================
 * MODULE 17  DOCUMENT REVIEW EDITOR
 * หน้าตรวจทานใบส่งสินค้า / ใบกำกับภาษีก่อนบันทึก
 * ฟังก์ชัน: splitDocs, scanOpen, scanPick, scanNext, sqAfter, sqStop, finDoc, fillDiscount, openEditor, edDelVal, edHints, edMatch, edWarns, renderEd, edRefresh, edDoc, edTotals, edPreview, edSave, sqPdf, sqName, sqMore, sqBar, edDelCell
 * ========================================================================== */
/* ---------- document editor ---------- */
/* ---------- document queue ---------- */
/* นำเข้าได้หลายไฟล์พร้อมกัน และหนึ่งไฟล์ PDF มีได้หลายเอกสาร (ใบกำกับภาษี หรือ ใบส่งสินค้า / Packing list)
   ระบบแยกเป็นเอกสารตามเลขที่เอกสารของแต่ละหน้า แล้วเปิดให้ตรวจทานและ match ทีละใบ
   SQ = คิวของไฟล์, PEND = เอกสารที่อ่านจากไฟล์ปัจจุบันแล้วและรอตรวจ */
let SQ=null,PEND=[];
const sqPdf=f=>f.type==='application/pdf'||/\.pdf$/i.test(f.name||'');
const sqName=k=>k==='inv'?'ใบกำกับภาษี':'ใบส่งสินค้า / Packing list';
/* แบ่งหน้าเป็นเอกสาร: ขึ้นเอกสารใหม่เมื่อหน้าถัดไปมีเลขที่เอกสารต่างจากเดิม หน้าที่ไม่มีเลขที่ถือเป็นหน้าต่อของเอกสารก่อนหน้า */
function splitDocs(pages){const out=[];let cur=null;for(const p of pages){const dn=p&&p.docNo!=null?String(p.docNo).trim():'';if(!cur||(dn&&cur.docNo&&kc(dn)!==kc(cur.docNo))){cur={docNo:dn,pages:[]};out.push(cur)}if(!cur.docNo&&dn)cur.docNo=dn;cur.pages.push(p)}return out}
/* เตรียมเอกสารที่อ่านได้ จับคู่ PO ตามข้อมูลล่าสุด แล้วเปิดหน้าตรวจทาน */
function scanOpen(kind,doc,warns){warns=[...(warns||[])];const D=DATA(),seen=new Set();doc.lines=(doc.lines||[]).filter(l=>l.code||l.name||l.qty!=null);
  for(const l of doc.lines){const k=kc(l.code)+'|'+l.qty+'|'+l.amount;if(l.code&&seen.has(k)){l.unsure=true;warns.push('พบรายการที่ดูซ้ำกัน ('+l.code+') ตรวจว่าเป็นรายการจริงหรืออ่านซ้ำ')}seen.add(k)}
  doc.vendor=vendorName(D,doc.vendor);
  {const rs=[...new Set(doc.lines.map(l=>String(l.ref||'').trim()).filter(Boolean))];if(rs.length&&!doc.refNo)doc.refNo=rs.join(', ');if(!doc.poNo&&rs.length===1&&findPO(D,rs[0]))doc.poNo=findPO(D,rs[0]).poNo}
  const rf0=docRef(D,doc);if(rf0&&!findPO(D,doc.poNo)){if(doc.poNo&&!doc.refNo)doc.refNo=doc.poNo;doc.poNo=rf0.po.poNo;warns.push('จับคู่ PO '+rf0.po.poNo+' จากเอกสารอ้างอิง '+rf0.ref)}
  if(!rf0&&!docPOs(D,doc).length){const m=matchPO(D,doc);if(m){warns.push((doc.poNo?'ไม่พบ PO เลขที่ “'+doc.poNo+'” ในระบบ ':'เอกสารไม่ระบุเลขที่ PO ')+'ระบบจับคู่ให้เป็น '+m.po.poNo+' จากรายการสินค้าที่ตรงกัน '+m.hit+' จาก '+m.n+' รายการ ตรวจว่าถูกต้อง');doc.poNo=m.po.poNo}}
  finDoc(D,doc,warns,kind);openEditor(kind,doc,warns,true)}
function scanPick(kind,files){const pdf=files.filter(sqPdf),img=files.filter(f=>!sqPdf(f)),items=pdf.map(f=>[f]);if(img.length)items.push(img);
  PEND=[];SQ={kind,items,i:0,n:0,ok:0,skip:0,fail:[],file:'',inFile:0};scanNext()}
async function scanNext(){const q=SQ;if(!q)return;
  while(SQ===q){if(PEND.length){const x=PEND.shift();q.n++;scanOpen(q.kind,x.doc,x.warns);return}
    if(q.i>=q.items.length)break;const fs=q.items[q.i++];q.file=fs.map(f=>f.name).join(', ');await scan(q.kind,fs);if(SQ!==q)return;q.inFile=PEND.length;if(!PEND.length)q.fail.push(q.file)}
  if(SQ===q){SQ=null;if(q.n+q.fail.length>1)toast(sqName(q.kind)+': อ่านได้ '+q.n+' ใบ จาก '+q.items.length+' ไฟล์ · บันทึก '+q.ok+' ใบ · ข้าม '+q.skip+' ใบ'+(q.fail.length?' · อ่านไม่สำเร็จ '+q.fail.length+' ไฟล์ ('+q.fail.join(', ')+')':''));render()}}
function sqAfter(saved){if(!SQ)return;saved?SQ.ok++:SQ.skip++;setTimeout(scanNext,saved&&(PEND.length||SQ.i<SQ.items.length)?700:0)}
const sqMore=()=>!!SQ&&(PEND.length>0||SQ.i<SQ.items.length);
function sqStop(){if(!SQ)return;const q=SQ,left=PEND.length,lf=q.items.length-q.i;SQ=null;PEND=[];toast('หยุดคิวแล้ว บันทึก '+q.ok+' ใบ'+(left?' · เอกสารที่อ่านแล้วแต่ยังไม่ได้ตรวจ '+left+' ใบ':'')+(lf?' · ยังไม่ได้อ่านอีก '+lf+' ไฟล์':''))}
const sqBar=()=>SQ&&ED&&ED.fromScan&&(SQ.n>1||sqMore())?`<div class="banner row" style="margin-bottom:6px"><span>${sqName(SQ.kind)} ใบที่ <b>${SQ.n}</b>${SQ.inFile>1?' · ไฟล์นี้มี <b>'+SQ.inFile+'</b> ใบ เหลือรอตรวจ '+PEND.length+' ใบ':''} · ไฟล์ ${esc(SQ.file)}${SQ.items.length>1?' (ไฟล์ที่ '+SQ.i+' จาก '+SQ.items.length+')':''} · บันทึกแล้ว ${SQ.ok} ใบ</span><span style="flex:1"></span><button class="sm" data-act="edCancel">ข้ามใบนี้</button><button class="sm" data-act="sqStop">หยุดคิว</button></div><p class="hint">ตรวจและบันทึกทีละใบ เมื่อบันทึกหรือข้ามแล้ว ระบบจะเปิดใบถัดไปให้เอง</p>`:'';
function finDoc(D,doc,warns,kind){
  if(kind==='inv'){inheritRefs(D,doc);const rf=docRef(D,doc),rn=String(doc.refNo||'').trim();if(rf&&rf.via==='do')warns.push('จับคู่จากเอกสารอ้างอิง: ตรงกับใบส่งสินค้า D/O No. '+rf.ref+' ของ PO '+docPOs(D,rf.dl).map(q=>q.poNo).join(', '));else if(rf&&rn)warns.push('ยังไม่พบใบส่งสินค้าเลขที่ '+rn+' ในระบบ จึงจับคู่จากเลขที่ PO '+rf.po.poNo+' แทน นำเข้าใบส่งสินค้าใบนั้นก่อนถ้าต้องการจับคู่ตาม D/O No.');else if(rf)warns.push('ใบกำกับไม่มีเลขที่เอกสารอ้างอิง จึงจับคู่จากเลขที่ PO '+rf.po.poNo)}
  {const od=(doc.lines||[]).filter(l=>l.disc!=null&&!isHalf(l.disc));od.forEach(l=>{l.unsure=true});if(od.length)warns.push('มี '+od.length+' บรรทัดที่ส่วนลด % ไม่เป็นจำนวนเต็มหรือ .50 อาจอ่านตัวเลขผิด')}
  if(kind==='inv'&&doc.discount>0&&doc.subtotal!=null){const sm=(doc.lines||[]).reduce((a,l)=>a+(l.amount!=null?l.amount:(l.qty||0)*(l.price||0)),0),rt=D.set.vatRate/100;
    if(Math.abs(sm-doc.subtotal)<=0.05&&doc.vat!=null&&Math.abs(doc.vat-(sm-doc.discount)*rt)<Math.abs(doc.vat-sm*rt))doc.subtotal=Math.round((sm-doc.discount)*100)/100}

  if(!doc.vendor){const po=docPO(D,doc)||docPOs(D,doc)[0];if(po&&po.vendor){doc.vendor=po.vendor;warns.push('ไม่พบชื่อผู้ขายบนเอกสาร จึงใช้ชื่อผู้ขายจาก PO ตรวจว่าถูกต้อง')}}
  if(!doc.docNo)warns.push('ไม่พบเลขที่'+(kind==='inv'?'ใบกำกับภาษี':'เอกสาร')+' กรอกเองก่อนบันทึก');
  if(kind==='inv'&&doc.creditDays==null)warns.push('ไม่พบเงื่อนไขเครดิตในใบกำกับภาษี ช่องเครดิตจึงว่าง');
  if(kind==='inv'&&!doc.dueDate)warns.push('ไม่พบวันครบกำหนดในใบกำกับภาษี ช่องวันครบกำหนดจึงว่าง')}
/* เติมช่องส่วนลด (บาท) เมื่อเอกสารไม่ได้อ่านยอดส่วนลดมา:
   1) มีส่วนลด % รายบรรทัด → คิดจากรายบรรทัด  2) ไม่มีเลย แต่ยอดรายการมากกว่ายอดก่อนภาษี และภาษีตรงกับยอดก่อนภาษี
      และส่วนต่างคิดเป็น % จำนวนเต็มหรือ .50 → ส่วนต่างนั้นคือส่วนลด */
function fillDiscount(doc,warns){if(doc.discount>0)return;const ls=doc.lines||[],am=l=>l.amount!=null?l.amount:(l.qty||0)*(l.price||0),g=ls.reduce((a,l)=>a+am(l),0),r2=v=>Math.round(v*100)/100;
  if(ls.some(l=>l.disc>0)){const by=ls.reduce((a,l)=>a+am(l)*(l.disc||0)/100,0);doc.discount=r2(doc.subtotal!=null&&Math.abs(g-by-doc.subtotal)<=1?g-doc.subtotal:by);return}
  if(doc.subtotal==null||!(g-doc.subtotal>0.05)||!g)return;const d=g-doc.subtotal,pct=d/g*100,rt=settings().vatRate/100;
  if(!isHalf(pct)||(doc.vat!=null&&Math.abs(doc.vat-doc.subtotal*rt)>Math.max(0.5,settings().vatTol)))return;
  doc.discount=r2(d);if(warns)warns.push('ไม่พบยอดส่วนลดในเอกสาร ระบบคำนวณส่วนลด '+doc.discount.toLocaleString('th-TH',{minimumFractionDigits:2})+' บาท ('+snap5(pct)+'%) จากผลรวมรายการลบยอดก่อนภาษี ตรวจว่าตรงกับบรรทัดส่วนลดในใบกำกับ')}
function openEditor(kind,doc,warns,fromScan){warns=warns||[];if(kind==='inv'){fillDiscount(doc,warns);if(!('subtotal' in doc))doc.subtotal=null;inheritRefs(DATA(),doc)}ED={kind,id:doc._id||null,fromScan:!!fromScan,warns:warns||[],dupOk:false,
  docNo:doc.docNo||'',date:doc.date||'',vendor:doc.vendor||'',poNo:doc.poNo||'',refNo:doc.refNo||'',creditDays:doc.creditDays??'',dueDate:doc.dueDate||'',dueAuto:false,vendorTaxId:doc.vendorTaxId||'',buyerTaxId:doc.buyerTaxId||'',
  discount:doc.discount??'',subtotal:doc.subtotal??'',vat:doc.vat??'',total:doc.total??'',lines:(doc.lines||[]).map(l=>({...l}))};
  if(!ED.lines.length)ED.lines.push({code:'',name:'',qty:null,price:null,amount:null});renderEd()}
/* มูลค่าตาม PO ของแต่ละรายการในใบส่งสินค้า ใช้ราคา PO หลังหักส่วนลดซึ่งเทียบโปรโมชั่นแล้วในขั้น ① (ใช้เทียบกับใบกำกับภาษีเท่านั้น ไม่บันทึกลงเอกสาร) */
function edDelVal(){const D=DATA(),dp=docPO(D,ED),m=r1map(D);return ED.lines.map(l=>{const po=linePO(D,l,dp),t=po&&resolveLine(aggLines(po),l);if(!t||t.price==null)return{price:null,amt:null,tag:''};
  const r=m.get(m1key(po.poNo,t.code)),ok=r&&r.promo!=null&&r.lv==='ok',no=r&&r.promo!=null&&r.lv!=='ok';return{price:t.price,amt:l.qty!=null?Math.round(l.qty*t.price*100)/100:null,tag:ok?pill('ok','ตรงโปร'):no?pill('warn','ยังไม่ตรงโปร'):'<span class="sub">ราคา PO</span>'}})}
const edDelCell=(v,k)=>k==='p'?(v.price!=null?fm(v.price)+'<div>'+v.tag+'</div>':'–'):'<b>'+fm(v.amt)+'</b>';
function edHints(){const D=DATA(),dp=docPO(D,ED),inv=ED.kind==='inv',m=inv?r1map(D):null,hasD=inv&&(num(ED.discount)>0||ED.lines.some(l=>l.disc>0));
  return ED.lines.map(l=>{const po=linePO(D,l,dp);if(!po)return pill('wait','ยังไม่ระบุ PO');const t=resolveLine(aggLines(po),l);if(!t)return pill('bad','ไม่พบใน PO');
    if(l.qty!=null&&l.price!=null&&l.amount!=null&&Math.abs(l.qty*l.price-l.amount)>0.05)return pill('warn','จำนวน×ราคา ≠ ยอด');
    if(inv&&l.disc!=null&&!isHalf(l.disc))return pill('warn','ส่วนลด % ต้องเป็นจำนวนเต็มหรือ .50');
    if(inv&&l.price!=null){const r=m.get(m1key(po.poNo,t.code)),mo=r&&r.mo!=null?r.mo:null,raw=(po.lines||[]).find(z=>kc(z.code)===kc(t.code)),list=raw&&raw.price!=null?raw.price:null,eq=v=>v!=null&&Math.abs(l.price-v)<=0.01;
      if(hasD&&(mo!=null||list!=null)&&!eq(mo)&&!eq(list))return pill('warn','ราคา ≠ MO '+fm(mo!=null?mo:list));
      if(!hasD&&t.price!=null&&!eq(t.price)&&!eq(mo)&&!eq(list))return pill('warn','ราคา ≠ PO '+fm(t.price))}
    if(l.qty!=null&&l.qty-t.qty>1e-6)return pill('warn','เกิน PO (สั่ง '+fq(t.qty)+')');
    return pill('ok','PO สั่ง '+fq(t.qty))})}
function edMatch(){const D=DATA(),m=docMatch(D,ED);
  if(!m)return `<div class="inv"><h3>PO ที่จับคู่ได้: ${pill('bad','ยังไม่พบ')}</h3><div class="sub">ใส่เลขที่เอกสารอ้างอิงให้ตรงกับ D/O No. ของใบส่งสินค้าในระบบ หรือใส่เลขที่ PO</div></div>`;
  const rf=docRef(D,ED),how=ED.kind!=='inv'?'':rf&&rf.via==='do'?'จับคู่จากเอกสารอ้างอิง ตรงกับใบส่งสินค้า D/O No. '+rf.ref+(rf.dl.date?' วันที่ '+rf.dl.date:''):String(ED.refNo||'').trim()?'ยังไม่พบใบส่งสินค้าเลขที่ '+ED.refNo+' ในระบบ จึงจับคู่จากเลขที่ PO':'ไม่มีเลขที่เอกสารอ้างอิง จึงจับคู่จากเลขที่ PO';
  return `<div class="inv"><h3>PO ที่จับคู่ได้: ${esc(m.pos.map(q=>q.poNo).join(', '))} ${m.hit===m.n?pill('ok','ตรงทุกรายการ'):pill('warn','ตรง '+m.hit+' จาก '+m.n+' รายการ')}</h3><div class="sub">${esc(m.po.vendor)} · วันที่ ${esc(m.po.date||'–')} · โครงการ ${esc(m.po.project||'–')} · ${(m.po.lines||[]).length} รายการใน PO</div>${how?`<div><b>${esc(how)}</b></div>`:''}<div class="sub">${m.hit===m.n?'ตรวจแล้วตรงกับ PO กดบันทึกได้เลย':'ยังมีรายการที่ไม่ตรงกับ PO ตรวจก่อนบันทึก'}</div></div>`}
function edWarns(){const w=[...ED.warns],D=DATA();
  {const dn=ED.kind==='inv'&&doNoPO(D,ED);if(dn)w.push('เลขที่เอกสารอ้างอิงตรงกับใบส่งสินค้า D/O No. '+dn.docNo+' แล้ว แต่ใบส่งสินค้าใบนั้นยังไม่ได้จับคู่กับ PO เปิดใบส่งสินค้าแล้วใส่เลขที่ PO ก่อน')}
  if((ED.poNo||ED.refNo)&&!docPOs(D,ED).length)w.push('ไม่พบ PO หรือใบส่งสินค้าจากเลขที่อ้างอิง “'+[ED.poNo,ED.refNo].filter(Boolean).join(', ')+'” ตรวจเลขที่หรือนำเข้า PO ก่อน');
  const u=ED.lines.filter(l=>l.unsure).length;if(u)w.push('มี '+u+' บรรทัดที่อ่านได้ไม่ชัด (แถวสีเหลือง) เทียบกับเอกสารจริงก่อนบันทึก');
  if(ED.kind==='inv'&&num(ED.subtotal)!=null){const s=ED.lines.reduce((a,l)=>a+(l.amount!=null?l.amount:(l.qty||0)*(l.price||0)),0);const ds=invDisc(edDoc(true));if(Math.abs(s-ds-num(ED.subtotal))>0.05)w.push('ผลรวมรายการ '+fm(s)+(ds?' หักส่วนลด '+fm(ds):'')+' ไม่เท่ายอดก่อนภาษี '+fm(num(ED.subtotal))+' อาจอ่านตกบรรทัดหรืออ่านตัวเลขผิด')}
  return w}
function renderEd(){const inv=ED.kind==='inv',D=DATA(),h=edHints(),nets=invLines(edDoc(true),D),dv=inv?[]:edDelVal();
  const f=(k,l,ph='')=>`<label class="f">${l}<input id="ed_${k}" data-f="${k}" value="${esc(ED[k])}" placeholder="${ph}" ${k==='poNo'?'list="poList"':''}></label>`;
  $('#ed').innerHTML=`<section class="card"><h2>${ED.fromScan?'ตรวจทานข้อมูลที่อ่านได้: ':''}${inv?'ใบกำกับภาษี':'ใบส่งสินค้า / Packing list'}</h2>
  <p>${ED.fromScan?'เทียบกับเอกสารจริงทีละบรรทัด แก้ไขได้ทุกช่อง ข้อมูลจะเข้าระบบเมื่อกดบันทึกเท่านั้น':'กรอกข้อมูลตามเอกสาร'}</p>
  ${sqBar()}<div id="edW">${edWarns().map(w=>`<div class="banner" style="margin-bottom:4px">${esc(w)}</div>`).join('')}</div>
  <div class="fgrid">${f('docNo',inv?'เลขที่ใบกำกับภาษี':'เลขที่เอกสาร')}${f('date','วันที่ (ปี ค.ศ.-เดือน-วัน)','2026-10-03')}${f('poNo',inv?'เลขที่ใบสั่งซื้อ / PO No. (ใช้เมื่อไม่มี D/O)':'อ้างอิง PO เลขที่')}${f('refNo',inv?'เลขที่เอกสารอ้างอิง (D/O No. / ใบส่งสินค้า)':'เลขที่อ้างอิง / เอกสารอ้างอิง',inv?'ใช้จับคู่เป็นอันดับแรก':'Customer P/O No.')}${f('vendor',inv?'ผู้ขาย / ผู้ออกใบกำกับภาษี':'ผู้ขาย (ตามหัวเอกสาร)')}
  ${inv?f('creditDays','เครดิต (วัน)')+f('dueDate','วันครบกำหนด (ตามที่พิมพ์ในใบกำกับ)','2026-11-02')+f('vendorTaxId','เลขผู้เสียภาษีผู้ขาย')+f('buyerTaxId','เลขผู้เสียภาษีผู้ซื้อ')+f('discount','ส่วนลด / Discount ในใบกำกับ (บาท)')+f('subtotal','ยอดก่อนภาษี (หลังหักส่วนลด)')+f('vat','ภาษีมูลค่าเพิ่ม')+f('total','ยอดรวมสุทธิ'):''}</div>
  <div id="edM">${edMatch()}</div>
  <div class="row" style="margin:6px 0 10px"><button class="pri" data-act="edSave">${ED.dupOk?'ยืนยันบันทึกทับ':'บันทึกเข้าระบบ'}</button></div>
  <datalist id="poList">${D.pos.map(p=>`<option value="${esc(p.poNo)}">${esc(p.vendor)}</option>`).join('')}</datalist>
  <div class="tw"><table><thead><tr><th>#</th><th>รหัสสินค้า</th><th>รายละเอียด</th>${inv?'':'<th>เทียบ PO</th>'}<th class="n">${inv?'จำนวน':'จำนวนส่งมอบ'}</th><th class="n">${inv?'ราคา/หน่วย':'ราคา/หน่วย (PO เทียบโปรแล้ว)'}</th><th class="n">${inv?'ยอดตามราคาในใบกำกับ':'ยอดรายการ (มูลค่าตาม PO)'}</th>${inv?'<th class="n">ส่วนลด %</th><th class="n">ราคาหลังหักส่วนลด / หน่วย</th><th class="n">ยอดหลังหักส่วนลด (ก่อนภาษี)</th><th>เทียบ PO</th>':''}<th></th></tr></thead><tbody>
  ${ED.lines.map((l,i)=>`<tr class="${l.unsure?'flag':''}"><td class="n">${i+1}</td>
    <td style="min-width:112px"><input data-i="${i}" data-k="code" value="${esc(l.code)}" aria-label="รหัสสินค้า"></td>
    <td style="min-width:110px"><input data-i="${i}" data-k="name" value="${esc(l.name)}" aria-label="รายละเอียด"></td>${inv?'':`<td id="edh${i}" style="min-width:96px">${h[i]}</td>`}
    <td class="n" style="min-width:64px"><input data-i="${i}" data-k="qty" inputmode="decimal" value="${l.qty??''}" aria-label="จำนวน"></td>
    ${inv?`<td class="n" style="min-width:90px"><input data-i="${i}" data-k="price" inputmode="decimal" value="${l.price??''}" aria-label="ราคาต่อหน่วย"></td>
    <td class="n" style="min-width:92px"><input data-i="${i}" data-k="amount" inputmode="decimal" value="${l.amount??''}" aria-label="ยอดรายการ"></td>`:`<td class="n" id="edv${i}">${edDelCell(dv[i],'p')}</td><td class="n" id="eda${i}">${edDelCell(dv[i],'a')}</td>`}
    ${inv?`<td class="n" style="min-width:70px"><input data-i="${i}" data-k="disc" inputmode="decimal" value="${ED.discount!==''&&num(ED.discount)>0?(nets[i]&&nets[i].pct>0.005?Math.round(snap5(nets[i].pct)*100)/100:''):(l.disc??'')}" aria-label="ส่วนลด %"></td><td class="n" id="edu${i}">${nets[i]&&l.qty?fm(nets[i].net/l.qty):'–'}</td><td class="n" id="edn${i}"><b>${fm(nets[i]?nets[i].net:null)}</b></td>`:''}
    ${inv?`<td id="edh${i}" style="min-width:96px">${h[i]}</td>`:''}<td><button class="sm" data-act="edDel" data-i="${i}" aria-label="ลบบรรทัด">ลบ</button></td></tr>`).join('')}
  </tbody></table></div>
  <div id="edT">${edTotals()}</div>
  <div id="edP">${edPreview()}</div>
  <div class="row"><button data-act="edAdd">เพิ่มบรรทัด</button><span style="flex:1"></span><button data-act="edCancel">ยกเลิก</button><button class="pri" data-act="edSave">${ED.dupOk?'ยืนยันบันทึกทับ':'บันทึกเข้าระบบ'}</button></div></section>`;
  $('#ed').hidden=false}
function edRefresh(){if(ED.kind==='inv')inheritRefs(DATA(),ED);$('#edM').innerHTML=edMatch();$('#edT').innerHTML=edTotals();$('#edP').innerHTML=edPreview();invLines(edDoc(true),DATA()).forEach((x,i)=>{const c=$('#edn'+i);if(c)c.innerHTML='<b>'+fm(x.net)+'</b>';const u=$('#edu'+i);if(u)u.textContent=x.l.qty?fm(x.net/x.l.qty):'–';const di=document.querySelector('#ed input[data-k="disc"][data-i="'+i+'"]');if(di&&num(ED.discount)>0&&document.activeElement!==di)di.value=x.pct>0.005?Math.round(snap5(x.pct)*100)/100:''});if(ED.kind!=='inv')edDelVal().forEach((v,i)=>{const a=$('#edv'+i),b=$('#eda'+i);if(a)a.innerHTML=edDelCell(v,'p');if(b)b.innerHTML=edDelCell(v,'a')});const h=edHints();h.forEach((x,i)=>{const c=$('#edh'+i);if(c)c.innerHTML=x});$('#edW').innerHTML=edWarns().map(w=>`<div class="banner" style="margin-bottom:4px">${esc(w)}</div>`).join('')}
/* สร้างเอกสารจากข้อมูลในหน้าตรวจทาน (all=true เก็บทุกบรรทัดตามลำดับบนจอ) */
function edDoc(all){const lines=ED.lines.filter(l=>all||l.code||l.name).map(l=>({ref:String(l.ref||'').trim(),code:String(l.code||'').trim(),name:String(l.name||'').trim(),qty:num(l.qty),price:num(l.price),disc:num(l.disc),amount:num(l.amount)}));
  const d={docNo:ED.docNo.trim(),date:ED.date.trim(),vendor:ED.vendor.trim(),poNo:ED.poNo.trim(),refNo:ED.refNo.trim(),lines,by:myId||null,at:new Date().toISOString()};
  if(ED.kind==='inv')Object.assign(d,{creditDays:num(ED.creditDays),dueDate:String(ED.dueDate||'').trim(),vendorTaxId:ED.vendorTaxId.trim(),buyerTaxId:ED.buyerTaxId.trim(),discount:num(ED.discount),subtotal:num(ED.subtotal),vat:num(ED.vat),total:num(ED.total)});
  return d}
function edTotals(){if(ED.kind!=='inv'){const v=edDelVal(),t=v.reduce((a,x)=>a+(x.amt||0),0),miss=v.filter(x=>x.amt==null).length,vr=DATA().set.vatRate;
    return `<div class="deep-f" style="border:1px solid var(--line);border-radius:6px"><div class="deep-t"><div><span>มูลค่าตาม PO ของใบส่งสินค้านี้ (ก่อนภาษี)</span><b class="code">${fm(t)}</b></div><div><span>ภาษีมูลค่าเพิ่ม ${vr}%</span><b class="code">${fm(Math.round(t*vr)/100)}</b></div><div class="gt"><span>รวมภาษี</span><b class="code">${fm(Math.round(t*(100+vr))/100)}</b></div></div><div><div class="sub">คำนวณจากจำนวนส่งมอบ × ราคา PO หลังหักส่วนลดที่เทียบโปรโมชั่นแล้ว ใช้เทียบกับยอดในใบกำกับภาษีเท่านั้น ไม่ใช่ราคาที่พิมพ์ในใบส่งสินค้า</div>${miss?`<div>${pill('warn',miss+' รายการยังไม่มีราคา PO')}</div>`:''}</div></div>`}const D=DATA(),doc=edDoc(true),x=invLines(doc,D),g=x.reduce((a,v)=>a+v.amt,0),n=x.reduce((a,v)=>a+v.net,0),ds=g-n,sub=num(ED.subtotal),ok=sub!=null&&Math.abs(n-sub)<=0.05,expG=sub!=null?sub+ds:null;
  const bad=sub!=null&&!ok;
  const vr=D.set.vatRate,tol=Math.max(D.set.vatTol,0.05),vC=Math.round(n*vr)/100,vD=ED.vat===''?null:num(ED.vat),tD=ED.total===''?null:num(ED.total),vS=vD!=null?vD:vC,tS=tD!=null?tD:Math.round((n+vS)*100)/100;
  return `<div class="deep-f" style="border:1px solid var(--line);border-radius:6px"><div class="deep-t"><div><span>รวมยอดรายการที่อ่านได้ (ตามราคาในใบกำกับ)</span><b class="code">${fm(g)}</b></div><div><span>ส่วนลดในใบกำกับ</span><b class="code">${fm(ds)}</b></div><div><span>ยอดหลังหักส่วนลด (ก่อนภาษี)</span><b class="code">${fm(n)}</b></div><div><span>ภาษีมูลค่าเพิ่ม ${vr}% (VAT)</span><b class="code">${fm(vS)}</b></div><div class="gt"><span>ยอดรวม (Grand Total)</span><b class="code">${fm(tS)}</b></div>${vD==null||tD==null?`<div class="sub">${vD==null?'ภาษี':''}${vD==null&&tD==null?'และ':''}${tD==null?'ยอดรวม':''}คำนวณจากยอดหลังหักส่วนลด เพราะยังไม่ได้ระบุตามเอกสาร</div>`:''}${vD!=null&&Math.abs(vD-vC)>tol?`<div>${pill('bad','ภาษีในเอกสาร '+fm(vD)+' ≠ คำนวณ '+fm(vC))}</div>`:''}${tD!=null&&Math.abs(tD-(n+vS))>tol?`<div>${pill('bad','ยอดรวมในเอกสาร '+fm(tD)+' ≠ ก่อนภาษี + ภาษี '+fm(Math.round((n+vS)*100)/100))}</div>`:''}</div>
  <div><div class="sub">เทียบกับยอดก่อนภาษีในเอกสาร</div><div>${sub==null?pill('wait','ยังไม่ระบุยอดก่อนภาษี'):ok?pill('ok','ตรงกับเอกสาร '+fm(sub)):pill('bad','ไม่ตรง: เอกสารระบุ '+fm(sub)+' ต่างกัน '+fm(Math.abs(n-sub)))}</div>${bad?`<div>ยอดก่อนภาษีในเอกสาร ${fm(sub)} บวกส่วนลด ${fm(ds)} เท่ากับ <b>${fm(expG)}</b> แต่รวมยอดรายการที่อ่านได้คือ <b>${fm(g)}</b> ${g<expG?'ขาดไป':'เกินมา'} <b>${fm(Math.abs(expG-g))}</b></div><div class="sub">สาเหตุที่เป็นไปได้: อ่านรายการตกบรรทัด อ่านจำนวน ราคา หรือยอดรายการผิด หรือยอดส่วนลด / ยอดก่อนภาษีที่อ่านได้ไม่ถูก ตรวจแถวที่มีป้ายเตือนในตารางก่อน</div>`:''}</div>
  <div><div class="sub">ส่วนลดของใบกำกับนี้และที่มา</div>${bad?`<div>${pill('warn','ตัวเลขยังไม่ตรงกับเอกสาร')}</div><div class="sub">แก้ให้ยอดตรงกับเอกสารก่อน ระบบจึงจะแจกแจงที่มาของส่วนลดได้ถูกต้อง</div>`:brkHtml(invBreak(D,doc),true)}</div></div>`}
/* ผลการ matching ของเอกสารชุดเดียวกัน โดยรวมเอกสารที่กำลังตรวจทานเข้าไปก่อนบันทึก */
function edPreview(){const inv=ED.kind==='inv',D=DATA(),cur={...edDoc(),_id:ED.id||'__new'},coll=inv?'invs':'dels';
  const D2={...D,[coll]:[...D[coll].filter(x=>x._id!==ED.id&&kc(x.docNo)!==kc(cur.docNo)),cur]};delete D2._r1m;
  const ps=docPOs(D2,cur);if(!ps.length)return'';const R=summary(D2);
  return (inv?verdictHtml(invVerdict(D2,cur)):'')+ps.map(po=>{const ag0=aggLines(po),have=new Set(ED.lines.map(l=>{const t=resolveLine(ag0,l);return t?kc(t.code):kc(l.code)})),miss=r=>!have.has(kc(r.code)),addB=r=>miss(r)?`<div><button class="sm" data-act="edAddPo" data-v="${esc(r.code)}" data-id="${esc(po.poNo)}">เพิ่มรายการนี้</button></div>`:'';
    const sm=R.pos.find(x=>x.po===po)||{},rows=(inv?R.r3:R.r2).filter(r=>r.poNo===po.poNo),dl=D2.dels.filter(x=>docPOs(D2,x).includes(po)),iv=D2.invs.filter(x=>docPOs(D2,x).includes(po)),me=x=>x===cur?' (ใบนี้)':'';
    return `<div class="deep"><div class="deep-h"><div><b>${inv?'ผลการ matching 3 ทางของเอกสารชุดนี้':'ผลการ matching กับใบสั่งซื้อ'}</b><div class="sub">PO <span class="code">${esc(po.poNo)}</span> ${esc(po.date||'')} · ${esc(vN(D,po.vendor||'')||'')} → Packing list / ใบส่งสินค้า: ${dl.filter(x=>!isRE(x)).map(x=>'<span class="code">'+esc(x.docNo)+'</span>'+me(x)+(x.date?' '+esc(x.date):'')).join(', ')||'ยังไม่มี'} → รับสินค้า RE: ${dl.filter(isRE).map(x=>'<span class="code">'+esc(x.docNo)+'</span>'+me(x)).join(', ')||'ยังไม่มี'}${inv?' → ใบกำกับภาษี: '+iv.map(x=>'<span class="code">'+esc(x.docNo)+'</span>'+me(x)).join(', '):''}</div></div>
      <div class="row">① ${pill(sm.na?'wait':sm.s1,sm.l1)} ② ${pill(sm.s2,sm.l2)}${inv?' ③ '+pill(sm.s3,sm.l3)+' '+pill(sm.all,sm.label):''}</div></div>
    <div class="tw" style="border:0;border-radius:0"><table><thead><tr><th>รหัส / รายการสินค้า</th><th class="n">PO จำนวน</th><th class="n">Packing list / ใบส่งสินค้า</th><th class="n">รับเข้า (RE)</th>${inv?'<th class="n">ใบกำกับ เรียกเก็บ</th><th class="n">ราคา PO / หน่วย</th><th class="n">ราคาใบกำกับ / หน่วย</th><th class="n">ส่วนลด</th><th class="n">ยอดหลังหักส่วนลด</th>':'<th class="n">ค้างส่ง</th>'}<th>สถานะ</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td class="d"><span class="code">${esc(r.code)}</span><div>${esc(r.name)}</div></td><td class="n">${fq(r.ord)}</td><td class="n">${r.pk?fq(r.pk):'–'}${(r.pkDocs||[]).length?`<div class="sub">${esc(r.pkDocs.join(', '))}</div>`:''}</td><td class="n">${r.re?fq(r.re):'–'}${(r.reDocs||[]).length?`<div class="sub">${esc(r.reDocs.join(', '))}</div>`:''}</td>${inv?`<td class="n">${fq(r.inv)}</td><td class="n">${fm(r.poPrice)}</td><td class="n">${fm(r.invPrice)}${r.byDisc&&r.effPrice!=null?`<div class="sub">สุทธิ ${fm(r.effPrice)}</div>`:''}</td><td class="n">${r.inv&&r.invAmt-r.invNet>0.005?fm(r.invAmt-r.invNet):'–'}</td><td class="n"><b>${r.inv?fm(r.invNet):'–'}</b>${r.inv&&r.docs&&r.docs.length?`<div class="sub" style="font-size:11px">${esc(r.docs.join(', '))}</div>`:''}</td>`:`<td class="n">${r.out?fq(r.out):'–'}</td>`}<td>${pill(r.lv,r.lv==='ok'&&inv?'ผ่าน (Match)':r.label)}${addB(r)}</td></tr>`).join('')}
    </tbody></table></div>${rows.some(miss)?`<div class="deep-f"><div class="row"><span>มี ${rows.filter(miss).length} รายการใน PO ที่ยังไม่อยู่ในเอกสารนี้ ถ้าเอกสารจริงมีรายการนั้น กดเพิ่มแล้วตรวจจำนวนกับเอกสาร</span><button class="sm" data-act="edAddPo" data-v="*" data-id="${esc(po.poNo)}">เพิ่มทุกรายการที่ขาด</button></div></div>`:''}${inv&&sm.comp&&(sm.comp.due>0||sm.comp.got>0)?`<div class="deep-f"><div>ส่วนลดชดเชย: ควรได้ ${fm(sm.comp.due)} · ได้รับแล้ว ${fm(sm.comp.got)} · ยังไม่ครบ ${fm(sm.comp.out)}</div></div>`:''}</div>`}).join('')}
async function edSave(){
  if(!ED.docNo.trim())return toast('ใส่เลขที่เอกสาร');
  const d=edDoc(),lines=d.lines;
  if(!lines.length)return toast('ต้องมีอย่างน้อย 1 รายการ');
  if(lines.some(l=>l.qty==null))return toast('มีบรรทัดที่ยังไม่ใส่จำนวน');
  const coll=ED.kind==='inv'?'invs':'dels',id=ED.id||idOf(ED.docNo);
  if(!ED.id&&S[coll][id]&&!ED.dupOk){ED.dupOk=true;renderEd();return toast('เลขที่เอกสารนี้มีอยู่แล้ว กดอีกครั้งเพื่อบันทึกทับ')}
  if(ED.id&&S[coll][ED.id]&&S[coll][ED.id].kind)d.kind=S[coll][ED.id].kind;
  try{await put(coll,id,d);const wasInv=ED.kind==='inv';ED=null;$('#ed').hidden=true;if(wasInv){SELINV=id;tab='invoice'}toast(sqMore()&&!wasInv?'บันทึกแล้ว กำลังเปิดเอกสารใบถัดไป':wasInv?(sqMore()?'บันทึกแล้ว กำลังเปิดเอกสารใบถัดไป':'บันทึกแล้ว แสดงผลการ matching 3 ทางของใบกำกับนี้'):'บันทึกแล้ว ระบบเทียบกับ PO ให้เรียบร้อย');render();sqAfter(true);if(wasInv){const e=$('#deepSec');if(e)e.scrollIntoView({behavior:'smooth',block:'start'})}}catch(e){wErr(e)}}
