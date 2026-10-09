/* ==========================================================================
 * MODULE 19  APP: EVENTS + START
 * ตัวจัดการปุ่มและช่องกรอกทั้งหมด และการเริ่มทำงานของระบบ
 * ฟังก์ชัน: -
 * ========================================================================== */
/* ---------- events ---------- */
let pendKind=null;
document.addEventListener('click',async ev=>{
  const b=ev.target.closest('[data-act]');if(!b)return;
  if((b.dataset.act==='openPO'||(b.dataset.act==='pop'&&b.tagName==='TR'))&&ev.target.closest('[data-stop]'))return;
  const a=b.dataset.act,v=b.dataset.v,id=b.dataset.id,demo=isDemo();
  const need=()=>{if(demo){toast('นี่คือข้อมูลตัวอย่าง นำเข้าข้อมูลจริงก่อน');return true}return false};
  try{switch(a){
    case'tab':popClose();tab=v;F.q='';try{history.replaceState(null,'','#'+v)}catch(e){}render();window.scrollTo(0,0);break;
    case'openPO':tab='invoice';F.q=v;F.only=false;render();break;
    case'prd':PRD=PRD===v?null:v;render();break;
    case'pop':popOpen(v);break;
    case'popX':popClose();break;
    case'kpi':F.st=v;F.only=false;tab='postatus';try{history.replaceState(null,'','#postatus')}catch(e){}render();window.scrollTo(0,0);break;
    case'stF':F.st=v;render();break;
    case'reBtn':{if(need())break;const D=DATA(),d=D.dels.find(x=>x._id===id);if(!d)break;const st=reState(d),c=reCheck(D,d);
      if(st.k||!c.ok){popOpen('re|'+id);if(st.k==='done'||st.k==='manual')toast('ใบส่งสินค้า '+d.docNo+' ออก RE แล้ว ไม่สามารถออกซ้ำได้')}
      else if(!mcpCap)popOpen('re|'+id);else sendRE([id]);break}
    case'selInv':SELINV=id&&id!==SELINV?id:null;render();if(SELINV){const e=$('#deepSec');if(e)e.scrollIntoView({behavior:'smooth',block:'start'})}break;
    case'openPO2':F.q=v;F.only=false;render();break;
    case'export':exportX();break;
    case'sheet':report();break;
    case'saveCfg':for(const k of['gsUrl','userName','aiKey','aiModel']){const el=$('#c_'+k);if(el)CFG[k]=el.value.trim()}saveCfg();myId=CFG.userName||null;toast('บันทึกแล้ว');render();
      if(CFG.gsUrl){try{SYNC.msg='กำลังดึงข้อมูลจาก Google Sheet…';chip();const n=await gsLoad();SYNC.msg='เชื่อมต่อ Google Sheet แล้ว';if(!n&&!realEmpty())await pushAll();render();toast(n?'ดึงข้อมูลจาก Google Sheet แล้ว':'เชื่อมต่อแล้ว')}catch(e){console.error(e);SYNC.msg='เชื่อมต่อ Google Sheet ไม่ได้';chip();toast('เชื่อมต่อ Google Sheet ไม่ได้ ตรวจ URL และสิทธิ์ Anyone ตอน Deploy')}}break;
    case'gsPull':try{const n=await gsLoad();render();toast(n?'ดึงข้อมูลจาก Google Sheet แล้ว':'Google Sheet ยังไม่มีข้อมูล')}catch(e){toast('ดึงข้อมูลไม่สำเร็จ')}break;
    case'gsPush':if(isDemo()){toast('ยังไม่มีข้อมูลจริงให้ส่ง');break}await pushAll();toast(SYNC.state==='ok'?'ส่งข้อมูลทั้งหมดไป Google Sheet แล้ว':'ส่งข้อมูลไม่สำเร็จ');break;
    case'adminIn':{const v=$('#adminPin').value;if(v&&v===settings().adminPin){try{sessionStorage.setItem('m3_admin',v)}catch(e){}toast('เข้าโหมดผู้ดูแลระบบแล้ว')}else toast('รหัสผู้ดูแลไม่ถูกต้อง');render();break}
    case'adminSet':{if(!isAdmin)break;const v=$('#adminPin').value.trim();if(v.length<4){toast('รหัสต้องยาวอย่างน้อย 4 ตัว');break}await put('meta','settings',{...settings(),adminPin:v});try{sessionStorage.setItem('m3_admin',v)}catch(e){}toast('ตั้งรหัสผู้ดูแลแล้ว');render();break}
    case'adminOut':try{sessionStorage.removeItem('m3_admin')}catch(e){}PE=null;render();break;
    case'copyGas':{const t=$('#gasCode');try{await navigator.clipboard.writeText(t.value);toast('คัดลอกโค้ดแล้ว')}catch(e){t.focus();t.select();toast('กด Ctrl+C เพื่อคัดลอก')}break}
    case'hub':loadHub(false);break;
    case'hubSave':{const fr=$('#s_hubFrom').value.trim(),s={...settings(),hubFileId:$('#s_hubFileId').value.trim(),hubCompany:$('#s_hubCompany').value.trim(),hubFrom:fr,hubVendor:$('#s_hubVendor').value.trim()};
      if(fr&&!/^\d{4}-\d{2}-\d{2}$/.test(fr)){toast('วันที่เริ่มต้องเป็นรูปแบบ ปี ค.ศ.-เดือน-วัน');break}
      if(!readOnly){try{await put('meta','settings',s)}catch(e){wErr(e)}}else S.meta.settings=s;
      loadHub(false);break}
    case'impX':pendKind=v;$('#fileX').value='';$('#fileX').click();break;
    case'impGo':importGo();break;
    case'impCancel':IMP=null;render();break;
    case'scan':pendKind=v;$('#fileS').value='';$('#fileS').click();break;
    case'stop':SQ=null;PEND=[];abortCtl&&abortCtl.abort();break;
    case'sqStop':sqStop();renderEd();break;
    case'manual':openEditor(v,{},[],false);break;
    case'edit':openEditor(v==='invs'?'inv':'del',{...S[v][id],_id:id},[],false);break;
    case'delDoc':if(b.dataset.sure){await rm(v,id);toast('ลบแล้ว');render()}else{b.dataset.sure='1';b.textContent='ยืนยันลบ'}break;
    case'edAdd':ED.lines.push({code:'',name:'',qty:null,price:null,amount:null});renderEd();break;
    case'edAddPo':{const D=DATA(),po=findPO(D,id),inv=ED.kind==='inv';if(!po)break;const cur={...edDoc(true),_id:ED.id||'__new'},coll=inv?'invs':'dels',D2={...D,[coll]:[...D[coll].filter(x=>x._id!==ED.id&&kc(x.docNo)!==kc(cur.docNo)),cur]};delete D2._r1m;
      const R=summary(D2),ag=aggLines(po),have=new Set(ED.lines.map(l=>{const t=resolveLine(ag,l);return t?kc(t.code):kc(l.code)})),hp=docPO(D,ED);let n=0;
      for(const r of (inv?R.r3:R.r2).filter(r=>r.poNo===po.poNo&&!have.has(kc(r.code))&&(v==='*'||kc(r.code)===kc(v)))){const q=inv?Math.max(0,(r.del||0)-(r.inv||0)):(r.out||0),pr=inv?r.poPrice??null:null;
        ED.lines.push({code:r.code,name:r.name,qty:q>0?q:null,price:pr,amount:pr!=null&&q>0?Math.round(q*pr*100)/100:null,ref:!inv&&hp&&hp!==po?po.poNo:'',unsure:true});n++}
      ED.lines=ED.lines.filter(l=>l.code||l.name||l.qty!=null);renderEd();toast(n?'เพิ่ม '+n+' รายการจาก PO แล้ว ตรวจจำนวนกับเอกสารจริงก่อนบันทึก':'ไม่มีรายการให้เพิ่ม');break}
    case'edDel':ED.lines.splice(+b.dataset.i,1);renderEd();break;
    case'edCancel':ED=null;$('#ed').hidden=true;sqAfter(false);break;
    case'edSave':edSave();break;
    case'reOne':if(need())break;sendRE([id]);break;
    case'reAll':{if(need())break;const D=DATA();sendRE(reDocs(D).filter(d=>reState(d).k!=='queued').map(d=>d._id));break}
    case'reManual':if(need())break;await put('res',id,{docNo:(S.dels[id]||{}).docNo||'',status:'manual',at:new Date().toISOString(),by:myId||null});render();break;
    case'reClear':await rm('res',id);render();break;
    case'appr':if(need())break;await put('appr',id,{kind:'ready',note:'',by:myId||null,at:new Date().toISOString()});render();break;
    case'exc':if(need())break;EXC=id;render();$('#excNote')&&$('#excNote').focus();break;
    case'excCancel':EXC=null;render();break;
    case'excSave':{const n=$('#excNote').value.trim();if(!n){toast('ใส่เหตุผลก่อนอนุมัติ');break}await put('appr',id,{kind:'exception',note:n,by:myId||null,at:new Date().toISOString()});EXC=null;render();break}
    case'unappr':await rm('appr',id);render();break;
    case'saveSetRange':{const a=$('#ps_start_'+id).value,z=$('#ps_end_'+id).value,qe=$('#ps_q_'+id),ye=$('#ps_y_'+id),se=$('#ps_s_'+id),q=qe?num(qe.value)||0:0,y=ye?num(ye.value)||0:0,sp=se?num(se.value)||0:0;
      if(a&&z&&a>z){toast('วันเริ่มต้องไม่หลังวันสิ้นสุด');break}
      if(q<0||y<0||sp<0||q+y+sp>100){toast('ส่วนลดเพิ่มต้องอยู่ระหว่าง 0–100');break}
      if(![q,y,sp].every(isHalf)){toast('ส่วนลดต้องเป็นจำนวนเต็มหรือลงท้าย .50 เช่น 1, 1.5, 2');break}
      if(id==='legacy')await put('meta','promo',{...(S.meta.promo||{}),start:a,end:z,dcQ:q,dcY:y,dcS:sp});else await put('promosets',id,{...S.promosets[id],start:a,end:z,dcQ:q,dcY:y,dcS:sp});toast('บันทึกโปรโมชั่นแล้ว'+(q||y||sp?' คำนวณ NP_Promotion ใหม่ด้วยส่วนลดเพิ่ม '+(q+y+sp)+'%':''));render();break}
    case'saveDcType':{const by={};let bad=false;DT_TYPES.forEach((t,n)=>{const qe=$('#dt_q_'+n),ye=$('#dt_y_'+n);if(!qe)return;const se=$('#dt_s_'+n),qs=qe.value.trim(),ys=ye.value.trim(),ss=se?se.value.trim():'';if(qs===''&&ys===''&&ss==='')return;const q=num(qs)||0,y=num(ys)||0,sp=num(ss)||0;if(q<0||y<0||sp<0||q+y+sp>100||![q,y,sp].every(isHalf))bad=true;by[t]={q,y,s:sp}});
      if(bad){toast('ส่วนลดเพิ่มต้องอยู่ระหว่าง 0–100 และเป็นจำนวนเต็มหรือลงท้าย .50');break}
      if(id==='legacy')await put('meta','promo',{...(S.meta.promo||{}),dcByType:by});else await put('promosets',id,{...S.promosets[id],dcByType:by});toast('บันทึกส่วนลดตาม Part Type แล้ว คำนวณ NP_Promotion ใหม่');render();break}
    case'peEdit':PE={k:b.dataset.k,i:+b.dataset.i,dc:+b.dataset.dc||0};render();break;
    case'peCancel':PE=null;render();break;
    case'peSave':{if(!isAdmin||!PE)break;const c=S.promos[PE.k];if(!c||!c.rows[PE.i]){PE=null;render();break}
      const mo=num($('#pe_mo').value),d=num($('#pe_disc').value),np=num($('#pe_price').value);
      if(np==null){toast('ใส่ NP_Promotion หรือใส่ MO กับส่วนลดเพื่อให้ระบบคำนวณ');break}
      if(np<0||(d!=null&&(d<0||d>100))){toast('ตรวจตัวเลข: ส่วนลดต้องอยู่ระหว่าง 0–100 และราคาต้องไม่ติดลบ');break}
      if(d!=null&&!isHalf(d)){toast('ส่วนลดโปรต้องเป็นจำนวนเต็มหรือลงท้าย .50 เช่น 12.5, 13, 15');break}
      const rows=c.rows.slice();rows[PE.i]={...rows[PE.i],ptype:$('#pe_ptype')?$('#pe_ptype').value.trim():rows[PE.i].ptype||'',mo,disc:d,price:Math.round(np*100)/100,editedAt:new Date().toISOString(),editedBy:myId||null};
      await put('promos',PE.k,{...c,rows});PE=null;toast('บันทึกราคาโปรโมชั่นแล้ว');render();break}
    case'delSet':if(!b.dataset.sure){b.dataset.sure='1';b.textContent='ยืนยันลบทั้งโปร';break}
      for(const k of Object.keys(S.promos))if((S.promos[k].set||'legacy')===id)await rm('promos',k);
      if(S.promosets[id])await rm('promosets',id);if(F.set===id)F.set='';toast('ลบโปรโมชั่นทั้งชุดแล้ว');render();break;
    case'saveSet':{const s={...settings(),priceTol:num($('#s_priceTol').value)??DEF.priceTol,vatRate:num($('#s_vatRate').value)??DEF.vatRate,vatTol:num($('#s_vatTol').value)??DEF.vatTol,vendorAlias:$('#s_vendorAlias').value,buyerNames:$('#s_buyerNames').value,buyerTaxId:$('#s_buyerTaxId').value.trim(),poIncVat:$('#s_poIncVat').value==='1',promoVendor:$('#s_promoVendor').value.trim(),promoProject:$('#s_promoProject').value.trim()};await put('meta','settings',s);toast('บันทึกเกณฑ์แล้ว');render();break}
  }}catch(e){wErr(e)}});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&POP){popClose();return}const t=ev.target;if((ev.key==='Enter'||ev.key===' ')&&t.classList&&t.classList.contains('pbtn')){ev.preventDefault();t.click()}});
document.getElementById('pop').addEventListener('click',ev=>{if(ev.target.id==='pop')popClose()});
document.addEventListener('input',ev=>{const t=ev.target;
  if(t.id==='q'){F.q=t.value;clearTimeout(rT);rT=setTimeout(()=>{render();const q=$('#q');if(q){q.focus();q.setSelectionRange(q.value.length,q.value.length)}},250)}
  else if(t.id==='only'){F.only=t.checked;render()}
  else if(t.id==='reF'){F.re=t.value;render()}
  else if(IMP&&t.id&&t.id.startsWith('imp_')){IMP[t.id.slice(4)]=t.value}
  else if(t.id==='pe_mo'||t.id==='pe_disc'){const m=num($('#pe_mo').value),d=num($('#pe_disc').value);if(m!=null&&d!=null)$('#pe_price').value=Math.round(m*(100-d-((PE&&PE.dc)||0)))/100}
  else if(ED&&t.dataset.f){ED[t.dataset.f]=t.value;ED.dupOk=false;if(t.dataset.f==='dueDate')ED.dueAuto=false;else if(ED.kind==='inv'&&ED.dueAuto&&(t.dataset.f==='date'||t.dataset.f==='creditDays')){ED.dueDate=addDays(ED.date,num(ED.creditDays)??settings().creditDays??30);const e=$('#ed_dueDate');if(e)e.value=ED.dueDate}}
  else if(ED&&t.dataset.k){const l=ED.lines[+t.dataset.i],k=t.dataset.k;l[k]=['qty','price','amount','disc'].includes(k)?num(t.value):t.value}});
document.addEventListener('change',ev=>{const t=ev.target;
  if(t.id==='vend'){F.vendor=t.value;render()}
  else if(t.id==='proj'){F.project=t.value;render()}
  else if(t.id==='mon'){F.month=t.value;render()}
  else if(t.id==='setF'){F.set=t.value;F.ptype='';render()}
  else if(t.id==='ptF'){F.ptype=t.value;render()}
  else if(t.id==='fileX'&&t.files[0])readXlsx(t.files[0],pendKind).catch(e=>{console.error(e);toast('เปิดไฟล์ Excel ไม่ได้')});
  else if(t.id==='fileS'&&t.files.length)scanPick(pendKind,[...t.files]);
  else if(ED&&(t.dataset.f||t.dataset.k))edRefresh()});
init();
