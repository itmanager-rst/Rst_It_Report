/* ==========================================================================
 * MODULE 02  MATCHING ENGINE
 * ตรรกะการจับคู่ทั้งหมด: อ้างอิงเอกสาร โปรโมชั่นและส่วนลด ขั้น ① ② ③ ตรวจใบกำกับ และสรุปราย PO
 * ฟังก์ชัน: aggLines, resolveLine, findDO, docRef, docRef0, inheritRefs, poIdx, vendorName, poDateFix, applyDC, step1, matchPO, docMatch, invLines, dateIn, tally, recv, m1of, step2, step3, invComp, invBreak, invChecks, summary, hubDocs, reCheck, poRefs, findPO, isInvDoc, refTok, doNoPO, docPO, linePO, docPOs0, docPOs, addDays, dueOf, inRange, invDisc, MONTHS, isRE, m1key, r1map
 * ========================================================================== */
function aggLines(po){const hit=AGG.get(po);if(hit)return hit;const m=new Map();
  for(const l of po.lines||[]){const k=kc(l.code)||('N:'+nk(l.name));
    const up=l.net??l.price,e=m.get(k)||{k,code:l.code,name:l.name,qty:0,amt:0,price:up};
    e.qty+=l.qty||0;e.amt+=(l.qty||0)*(up||0);m.set(k,e)}
  for(const e of m.values())if(e.qty)e.price=e.amt/e.qty;
  const out=[...m.values()];AGG.set(po,out);return out}
function resolveLine(lines,l){const k=kc(l.code);
  if(k){const f=lines.find(x=>x.k===k);if(f)return f;
    const f2=lines.filter(x=>x.k.length>=5&&k.length>=5&&(x.k.endsWith(k)||k.endsWith(x.k)));if(f2.length===1)return f2[0]}
  let best=null,bs=0;for(const x of lines){const s=sim(x.name,l.name);if(s>bs){bs=s;best=x}}
  return((!k&&bs>=0.72)||(k&&bs>=0.9))?best:null}
/* เลขอ้างอิงของผู้ขายที่บันทึกไว้ใน PO (YDS. No./หมายเหตุ) ใช้จับคู่ Customer P/O No. บนใบส่งสินค้า
   เช่น MOHQ040826-1003 = YDS. No. MOHQ040826-1 + ลำดับบรรทัด 3 หลัก ใช้เฉพาะเลขที่ชี้ไป PO เดียว */
const poRefs=p=>String(p.ref||'').split(/[\s,;\/|]+/).map(kc).filter(t=>t.length>=6);
const findPO=(D,no)=>{const k=kc(no);if(!k)return null;const c=cx(D);if(!c.pm){c.pm=new Map();c.rm=new Map();for(const p of D.pos){const q=kc(p.poNo);if(q&&!c.pm.has(q))c.pm.set(q,p);for(const t of poRefs(p))c.rm.set(t,c.rm.has(t)&&c.rm.get(t)!==p?null:p)}}
  const raw=String(no).trim();return c.pm.get(k)||c.rm.get(k)||(/-\d{4,}$/.test(raw)&&c.rm.get(kc(raw.slice(0,-3))))||null};
/* หา PO ของเอกสาร
   ใบกำกับภาษี: 1) เลขที่เอกสารอ้างอิงตรงกับ D/O No. ของใบส่งสินค้าในระบบ  2) ถ้าไม่มี ใช้เลขที่ PO
   ใบส่งสินค้า: 1) เลขที่ PO / Customer P/O No.  2) ใบส่งสินค้าอื่นที่อ้างถึง */
const isInvDoc=d=>('subtotal' in d)||('vat' in d)||('vendorTaxId' in d);
const refTok=v=>{const a=String(v||'').split(/[,;]/).map(x=>x.trim()).filter(x=>kc(x)),o=[];for(const x of a){o.push(x);for(const y of x.split(/[\s\/|]+/))if(kc(y).length>=4&&!o.includes(y))o.push(y)}return o};
/* ใบส่งสินค้าที่ D/O No. เป็นเลขเดียวกับเลขอ้างอิง (ไม่สนใจขีด ช่องว่าง ตัวพิมพ์เล็กใหญ่) */
function findDO(D,d,refs){const c=cx(D);if(!c.dn){c.dn=[];c.dm=new Map();for(const x of D.dels){const n=kc(x.docNo);c.dn.push([n,x]);if(!n)continue;if(!c.dm.has(n))c.dm.set(n,[]);c.dm.get(n).push(x)}}
  for(const r of refs){const a=c.dm.get(kc(r)),dl=a&&a.find(x=>x!==d);if(dl)return dl}
  for(const r of refs){const k=kc(r);for(const e of c.dn){const n=e[0];if(e[1]!==d&&n.length>=5&&(k.includes(n)||(k.length>=5&&n.includes(k))))return e[1]}}return null}
/* เอกสารที่อยู่ในชุดข้อมูลแล้วไม่ถูกแก้ระหว่างการแสดงผล จึงจำผลการจับคู่ไว้ได้ เอกสารที่กำลังกรอกหรือเพิ่งสแกนคำนวณใหม่ทุกครั้ง */
function docRef(D,d){if(!memOf(D).has(d))return docRef0(D,d);const c=cx(D);if(!c.dr)c.dr=new Map();if(!c.dr.has(d))c.dr.set(d,docRef0(D,d));return c.dr.get(d)}
function docRef0(D,d){const inv=isInvDoc(d),refs=inv?[...refTok(d.refNo),...refTok(d.poNo)]:[...refTok(d.poNo),...refTok(d.refNo)];
  const viaDO=()=>{const dl=findDO(D,d,refs);if(!dl)return null;const po=findPO(D,dl.poNo)||refTok(dl.poNo).concat(refTok(dl.refNo)).map(r=>findPO(D,r)).find(Boolean)||(dl.lines||[]).map(l=>kc(l.ref)?findPO(D,l.ref):null).find(Boolean);return po?{po,via:'do',ref:dl.docNo,dl}:null};
  const viaPO=()=>{for(const r of refs){const po=findPO(D,r);if(po)return{po,via:'po',ref:r}}return null};
  return inv?(viaDO()||viaPO()):(viaPO()||viaDO())}
/* ใบกำกับที่เลขอ้างอิงตรงกับ D/O No. แต่ใบส่งสินค้านั้นยังไม่ได้จับคู่ PO */
const doNoPO=(D,d)=>{if(!isInvDoc(d))return null;const dl=findDO(D,d,refTok(d.refNo));return dl&&!docPOs(D,dl).length?dl:null};
/* ใบกำกับที่จับคู่จากใบส่งสินค้า: ให้แต่ละรายการใช้ PO เดียวกับรายการนั้นในใบส่งสินค้า (รองรับใบส่งสินค้าที่รวมหลาย PO) */
function inheritRefs(D,doc){if(!isInvDoc(doc))return;const rf=docRef(D,doc),ls=doc.lines||[];
  if(!rf||rf.via!=='do'){ls.forEach(l=>{if(l._inh){l.ref='';l._inh=false}});return}
  const dp=findPO(D,rf.dl.poNo)||rf.po,mp=new Map();for(const x of rf.dl.lines||[]){const q=(kc(x.ref)&&findPO(D,x.ref))||dp;if(q&&kc(x.code)&&!mp.has(kc(x.code)))mp.set(kc(x.code),q)}
  ls.forEach(l=>{const q=mp.get(kc(l.code));if(q&&q!==rf.po){l.ref=q.poNo;l._inh=true}else if(l._inh){l.ref='';l._inh=false}})}
const docPO=(D,d)=>{const m=docRef(D,d);return m?m.po:null};
const linePO=(D,l,dp)=>(l&&kc(l.ref)&&findPO(D,l.ref))||dp;
const docPOs0=(D,d)=>{const dp=docPO(D,d),set=new Set();for(const l of d.lines||[]){const q=linePO(D,l,dp);if(q)set.add(q)}if(!set.size&&dp)set.add(dp);return[...set]};
const docPOs=(D,d)=>{if(!memOf(D).has(d))return docPOs0(D,d);const c=cx(D);if(!c.dp)c.dp=new Map();if(!c.dp.has(d))c.dp.set(d,docPOs0(D,d));return c.dp.get(d)};
/* เอกสารของแต่ละ PO: ใบส่งสินค้า (pk) รับสินค้า RE (re) ใบกำกับภาษี (inv) */
const NOIX={pk:[],re:[],inv:[]};
function poIdx(D){const c=cx(D);if(c.ix)return c.ix;const ix=new Map(),g=po=>{let e=ix.get(po);if(!e){e={pk:[],re:[],inv:[]};ix.set(po,e)}return e};
  for(const d of D.dels)for(const po of docPOs(D,d))g(po)[isRE(d)?'re':'pk'].push(d);
  for(const d of D.invs)for(const po of docPOs(D,d))g(po).inv.push(d);
  return c.ix=ix}
function vendorName(D,raw){const st=D.set,t=nk(raw);if(!t)return raw||'';let name='';
  for(const ln of String(st.vendorAlias||'').split(/\r?\n/)){const i=ln.indexOf('=');if(i<0)continue;const a=nk(ln.slice(0,i)),v=ln.slice(i+1).trim();if(a&&v&&t.includes(a)){name=v;break}}
  const want=nk(name||raw).replace(/^บริษัท|จำกัด$|มหาชน|coltd|ltd|co$/g,'');
  const hit=D.pos.map(p=>p.vendor).find(v=>v&&want&&nk(v).includes(want));
  return hit||name||raw}
const addDays=(iso,n)=>{const t=new Date(String(iso)+'T00:00:00Z');if(isNaN(t))return'';t.setUTCDate(t.getUTCDate()+(+n||0));return t.toISOString().slice(0,10)};
const dueOf=inv=>inv.dueDate||'';

const inRange=(p,dt)=>{if(!dt)return true;if(dt.length===7)return(!p.start||dt+'-31'>=p.start)&&(!p.end||dt+'-01'<=p.end);return(!p.start||dt>=p.start)&&(!p.end||dt<=p.end)};
function poDateFix(p){if(p.date)return p;const m=kc(p.poNo).match(/^[A-Zก-๙]*(\d{2})(\d{2})\d{3,}$/);if(m&&+m[2]>=1&&+m[2]<=12&&+m[1]>=20&&+m[1]<=45)return{...p,date:'20'+m[1]+'-'+m[2],dateFromNo:true};return p}
function applyDC(r,x){const t=(x.dcByType||{})[r.ptype||'(ไม่ระบุ)'],q=t?num(t.q)||0:num(x.dcQ)||0,y=t?num(t.y)||0:num(x.dcY)||0,sp=t?num(t.s)||0:num(x.dcS)||0,o={...r,discBase:r.disc??null,dcQ:q,dcY:y,dcS:sp};
  if(r.mo!=null&&r.disc!=null&&(q||y||sp)){o.disc=Math.round((r.disc+q+y+sp)*1e4)/1e4;o.price=Math.round(r.mo*(100-o.disc))/100}
  return o}
function step1(D){const st=D.set,pm=new Map(),rows=[];
  for(const p of D.promos){const k=kc(p.code);if(!pm.has(k))pm.set(k,[]);pm.get(k).push(p)}
  for(const po of D.pos)for(const l of po.lines||[]){
    const up=l.net??l.price,net=up==null?null:(st.poIncVat?up/(1+st.vatRate/100):up);
    const r={listPrice:l.price??null,poNo:po.poNo,vendor:po.vendor,date:po.date||'',code:l.code,name:l.name,qty:l.qty,poPrice:net,promo:null,mo:null,disc:null,promoSet:'',nAlt:0,note:'',diff:null,leak:0,lv:'ok',label:'ตรงกัน',project:l.project||po.project||'',scope:true};
    if((st.promoVendor&&!nk(po.vendor).includes(nk(st.promoVendor)))||!projOK(r.project,st.promoProject)){r.scope=false;r.lv='wait';r.label='ไม่ต้องเทียบโปรโมชั่น';rows.push(r);continue}
    const c=pm.get(kc(l.code))||[],v=c.filter(p=>p.price!=null&&inRange(p,po.date)).sort((a,b)=>a.price-b.price),p=v[0];
    if(!c.length){r.lv='info';r.label='ไม่อยู่ในโปรโมชั่น'}
    else if(!p){r.lv='info';r.label='นอกช่วงโปรโมชั่น'}
    else{r.promo=p.price;r.mo=p.mo??null;r.disc=p.disc??null;r.discBase=p.discBase??null;r.dc=(p.dcQ||0)+(p.dcY||0)+(p.dcS||0);r.dcQ=p.dcQ||0;r.dcY=p.dcY||0;r.dcS=p.dcS||0;r.promoSet=p.setName||'';r.nAlt=v.length;
      if(net==null){r.lv='warn';r.label='ไม่มีราคาให้เทียบ'}
      else{r.diff=Math.round(net*100)/100-Math.round(p.price*100)/100;
        if(r.diff>st.priceTol){r.lv='bad';r.label=v.length>1?'ไม่ตรง · สูงกว่าโปรที่ดีที่สุด':'ไม่ตรง · สูงกว่า NP_Promotion';r.leak=r.diff*(l.qty||0);
          const o=v.slice(1).find(x=>Math.abs(net-x.price)<=st.priceTol);if(o)r.note='ราคาตรงกับ “'+o.setName+'” แต่ “'+p.setName+'” ถูกกว่า'}
        else if(r.diff<-st.priceTol){r.lv='warn';r.label='ไม่ตรง · ต่ำกว่า NP_Promotion'}
        else if(Math.max(sim(l.name,p.name),sim(l.name,p.nameTh))<0.3)r.note='ชื่อสินค้าใน PO ต่างจากชื่อในโปรโมชั่น: '+(p.nameTh||p.name)}}
    rows.push(r)}
  return rows}
function matchPO(D,doc){let best=null,bn=0;const n=(doc.lines||[]).length;
  for(const po of D.pos){const ls=aggLines(po);let c=0;for(const l of doc.lines||[])if(resolveLine(ls,l))c++;if(c>bn){bn=c;best=po}}
  return best&&bn>=Math.max(1,Math.ceil(n*0.5))?{po:best,hit:bn,n}:null}
function docMatch(D,doc){const dp=docPO(D,doc),ps=docPOs(D,doc),n=(doc.lines||[]).length,ag=new Map();if(!ps.length)return null;let hit=0;
  for(const l of doc.lines||[]){const q=linePO(D,l,dp);if(!q)continue;if(!ag.has(q))ag.set(q,aggLines(q));if(resolveLine(ag.get(q),l))hit++}
  return{po:dp||ps[0],pos:ps,hit,n}}

/* รายการของเอกสารพร้อมยอดหลังหักส่วนลด
   ส่วนลดท้ายใบกำกับถูกกระจายตามส่วนลดที่ควรได้ของแต่ละรายการตามราคา PO (ถ้าหา PO ไม่ได้ กระจายตามยอดรายการ)
   ถ้าไม่มีส่วนลดท้ายใบกำกับ ใช้ส่วนลด % รายบรรทัด */
function invLines(d,D){const ls=d.lines||[],am=l=>l.amount!=null?l.amount:(l.qty||0)*(l.price||0),G=ls.reduce((a,l)=>a+am(l),0),F=d.discount>0&&G?d.discount:null;let w=null;
  if(F!=null){if(D){const dp=docPO(D,d),ag=new Map(),e=ls.map(l=>{const po=linePO(D,l,dp);if(po&&!ag.has(po))ag.set(po,aggLines(po));const t=po&&resolveLine(ag.get(po),l);return t&&t.price!=null?Math.max(0,am(l)-(l.qty||0)*t.price):0}),E=e.reduce((a,b)=>a+b,0);if(E>0.005)w=e.map(x=>x/E)}
    if(!w)w=ls.map(l=>am(l)/G)}
  return ls.map((l,i)=>{const a=am(l),dsc=w?F*w[i]:l.disc!=null?a*l.disc/100:0,net=a-dsc;return{l,amt:a,net,dsc,pct:a?dsc/a*100:0}})}
const invDisc=d=>Math.round(invLines(d).reduce((a,x)=>a+x.dsc,0)*100)/100;
const MONTHS=(()=>{const m={};['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].forEach((x,i)=>m[x]=i+1);['january','february','march','april','may','june','july','august','september','october','november','december'].forEach((x,i)=>m[x]=i+1);
  ['มค','กพ','มีค','เมย','พค','มิย','กค','สค','กย','ตค','พย','ธค'].forEach((x,i)=>m[x]=i+1);['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'].forEach((x,i)=>m[x]=i+1);return m})();
/* หาวันที่ตัวแรกในข้อความ รองรับ 31/10/2569, 2026-10-31, 31 ต.ค. 69, 31-Oct-26 คืนค่าเป็น YYYY-MM-DD */
function dateIn(s){s=String(s||'');const yr=y=>{y=+y;if(y<100)y+=y>=43?2500:2000;if(y>2400)y-=543;return y},iso=(y,m,d)=>(+m>=1&&+m<=12&&+d>=1&&+d<=31)?yr(y)+'-'+String(+m).padStart(2,'0')+'-'+String(+d).padStart(2,'0'):'';
  const c=[];let m;
  if((m=s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/)))c.push([m.index,iso(m[1],m[2],m[3])]);
  if((m=s.match(/(?<!\d)(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})(?!\d)/)))c.push([m.index,iso(m[3],m[2],m[1])]);
  if((m=s.match(/(?<!\d)(\d{1,2})\s*[\-\/ ]?\s*([A-Za-zก-๙.]{2,12}?)\.?\s*[\-\/ ,]?\s*(\d{4}|\d{2})(?!\d)/))){const k=MONTHS[m[2].toLowerCase().replace(/[.\s]/g,'')];if(k)c.push([m.index,iso(m[3],k,m[1])])}
  c.sort((a,b)=>a[0]-b[0]);const f=c.find(x=>x[1]);return f?f[1]:''}
function tally(D,docs,po){const lines=aggLines(po),m=new Map(lines.map(x=>[x.k,{qty:0,price:null,amt:0,net:0,docs:[]}])),extra=[];
  for(const d of docs){const dp=docPO(D,d);
    for(const x of invLines(d,D)){const l=x.l;if(linePO(D,l,dp)!==po)continue;const t=resolveLine(lines,l);
      if(!t){extra.push({doc:d.docNo,...l,amt:x.amt,net:x.net});continue}
      const e=m.get(t.k);if(x.dsc>0.005)e.disc=true;e.qty+=l.qty||0;e.amt+=x.amt;e.net+=x.net;if(l.price!=null)e.price=l.price;if(!e.docs.includes(d.docNo))e.docs.push(d.docNo)}}
  return{lines,m,extra}}

/* เอกสารรับสินค้า (RE) ที่นำเข้าจาก Excel เก็บรวมกับใบส่งสินค้าโดยมี kind:'re'
   จำนวนรับของแต่ละรายการ: ใช้ใบส่งสินค้า / Packing list ถ้ามี ถ้าไม่มีจึงใช้ RE (ไม่นับซ้ำกัน) */
const isRE=d=>!!d&&d.kind==='re';
function recv(D,po){const ix=poIdx(D).get(po)||NOIX,pk=tally(D,ix.pk,po),re=tally(D,ix.re,po),m=new Map();
  for(const x of pk.lines){const a=pk.m.get(x.k),b=re.m.get(x.k),u=a.docs.length?a:b;m.set(x.k,{...u,price:a.price,rePrice:b.qty>EPS&&b.amt>0?b.amt/b.qty:null,pk:a.qty,re:b.qty,pkDocs:a.docs,reDocs:b.docs,docs:[...a.docs,...b.docs]})}
  return{lines:pk.lines,m,extra:[...pk.extra,...re.extra]}}
const m1key=(no,code)=>kc(no)+'|'+kc(code);
function m1of(r1){const m=new Map();for(const r of r1||[]){const k=m1key(r.poNo,r.code),v=!r.scope?'':r.lv==='ok'?'ok':(r.label==='ไม่อยู่ในโปรโมชั่น'||r.label==='นอกช่วงโปรโมชั่น')?'':'no';if(m.get(k)!=='no')m.set(k,v)}return m}
function step2(D,m1){const st=D.set,rows=[];m1=m1||m1of(step1(D));
  for(const po of D.pos){const{lines,m,extra}=recv(D,po);
    for(const x of lines){const e=m.get(x.k);const out=x.qty-e.qty;
      const r={poNo:po.poNo,date:po.date||'',vendor:po.vendor,project:po.project||((po.lines||[]).find(z=>z.project)||{}).project||'',code:x.code,name:x.name,ord:x.qty,del:e.qty,out:Math.max(out,0),poPrice:x.price,priceOk:m1.get(m1key(po.poNo,x.code))||'',docPrice:e.price,rePrice:e.rePrice,docs:e.docs,pk:e.pk,re:e.re,pkDocs:e.pkDocs,reDocs:e.reDocs,lv:'ok',label:'จำนวนครบ'};
      if(e.qty<EPS){r.lv='wait';r.label='รอส่ง'}
      else if(out>EPS){r.lv='warn';r.label='ค้างส่ง'}
      else if(out<-EPS){r.lv='bad';r.label='ส่งเกิน PO'}
      if(e.price!=null&&x.price!=null&&Math.abs(e.price-x.price)>st.priceTol&&e.qty>EPS){r.lv='bad';r.label=(r.label==='ค้างส่ง'?'ค้างส่ง · ':'')+'ราคาไม่ตรง PO'}
      if(e.pk>EPS&&e.re>EPS&&Math.abs(e.pk-e.re)>EPS){if(r.lv==='ok'||r.lv==='wait')r.lv='warn';r.label+=' · ใบส่งสินค้า ≠ รับเข้า RE'}
      rows.push(r)}
    for(const l of extra)rows.push({poNo:po.poNo,date:po.date||'',vendor:po.vendor,project:po.project||((po.lines||[]).find(z=>z.project)||{}).project||'',code:l.code,name:l.name,ord:0,del:l.qty||0,out:0,poPrice:null,docPrice:l.price,docs:[l.doc],lv:'bad',label:'ไม่อยู่ใน PO'})}
  return rows}

function step3(D,m1){const st=D.set,rows=[];m1=m1||m1of(step1(D));
  for(const po of D.pos){const dl=recv(D,po),iv=tally(D,(poIdx(D).get(po)||NOIX).inv,po);
    for(const x of dl.lines){const d=dl.m.get(x.k),i=iv.m.get(x.k),eff=i.qty>EPS&&i.price!=null?i.net/i.qty:null,ptol=Math.max(st.priceTol,0.01);
      const r={poNo:po.poNo,date:po.date||'',vendor:po.vendor,project:po.project||((po.lines||[]).find(z=>z.project)||{}).project||'',code:x.code,name:x.name,ord:x.qty,del:d.qty,inv:i.qty,poPrice:x.price,priceOk:m1.get(m1key(po.poNo,x.code))||'',invPrice:i.price,invAmt:i.amt,invNet:i.net,effPrice:eff,byDisc:!!i.disc,delDocs:d.docs,rePrice:d.rePrice,pk:d.pk,re:d.re,pkDocs:d.pkDocs,reDocs:d.reDocs,docs:i.docs,lv:'ok',label:'ตรงกันทั้ง 3 เอกสาร'};
      if(i.qty<EPS){r.lv='wait';r.label='รอใบกำกับภาษี'}
      else if(i.qty-d.qty>EPS){r.lv='bad';r.label='วางบิลเกินจำนวนที่รับ'}
      else if(eff!=null&&x.price!=null&&(eff-x.price>ptol||(x.price-eff>ptol&&!i.disc))){r.lv='bad';r.label=i.disc?'ราคาหลังหักส่วนลดสูงกว่า PO':'ราคาไม่ตรง PO'}
      else if(d.qty-i.qty>EPS){r.lv='warn';r.label='วางบิลยังไม่ครบที่รับ'}
      else if(x.qty-i.qty>EPS){r.lv='ok';r.label='ตรงกัน · ยังค้างส่ง'}
      if(d.pk>EPS&&d.re>EPS&&Math.abs(d.pk-d.re)>EPS){if(r.lv==='ok'){r.lv='warn';r.label='ใบส่งสินค้า ≠ รับเข้า RE'}else r.label+=' · ใบส่งสินค้า ≠ รับเข้า RE'}
      rows.push(r)}
    for(const l of iv.extra)rows.push({poNo:po.poNo,date:po.date||'',vendor:po.vendor,project:po.project||((po.lines||[]).find(z=>z.project)||{}).project||'',code:l.code,name:l.name,ord:0,del:0,inv:l.qty||0,poPrice:null,invPrice:l.price,invAmt:l.amt,invNet:l.net,effPrice:l.qty?l.net/l.qty:null,byDisc:false,delDocs:[],docs:[l.doc],lv:'bad',label:'ไม่อยู่ใน PO'})}
  return rows}

const r1map=D=>D._r1m||(D._r1m=new Map(step1(D).map(r=>[m1key(r.poNo,r.code),r])));
/* ส่วนลดชดเชยของใบกำกับหนึ่งใบ: gross=ยอดตามราคาในใบกำกับ, exp=ยอดตามราคา PO หลังหักส่วนลด, ent=ยอดตาม NP_Promotion
   poDisc=ส่วนลดตามใบสั่งซื้อ, comp=ส่วนลดชดเชยที่ได้รับ (ติดลบ = ได้ส่วนลดน้อยกว่าใบสั่งซื้อ) */
function invComp(D,inv){const m=r1map(D),dp=docPO(D,inv),ag=new Map();let gross=0,exp=0,ent=0,un=0;
  let dsum=0;for(const x of invLines(inv,D)){const l=x.l,amt=x.amt;gross+=amt;dsum+=x.dsc;
    const po=linePO(D,l,dp);if(po&&!ag.has(po))ag.set(po,aggLines(po));const t=po&&resolveLine(ag.get(po),l);
    if(!t||t.price==null){exp+=amt;ent+=amt;un++;continue}
    const q=l.qty||0,r=m.get(m1key(po.poNo,t.code)),np=r&&r.scope&&r.promo!=null?Math.min(r.promo,t.price):t.price;
    exp+=q*t.price;ent+=q*np}
  const disc=dsum,net=disc>0.005?gross-disc:(inv.subtotal!=null?inv.subtotal:gross),r2=v=>Math.round(v*100)/100;
  return{gross:r2(gross),disc:r2(disc),net:r2(net),exp:r2(exp),poDisc:r2(gross-exp),comp:r2(exp-net),due:r2(exp-ent),un}}
/* ที่มาของส่วนลดในใบกำกับหนึ่งใบ ใช้ฐานเดียวกับทุกหน้าจอ: base = ผลรวมยอดรายการตามใบกำกับ, disc = ส่วนลดในใบกำกับ, net = base − disc
   แยกเป็น ส่วนลดโปร + DC:Quarter + DC:Yearly + ส่วนลดพิเศษ ส่วนลดที่ไม่ได้ระบุไว้ในโปรโมชั่นทั้งหมดถือเป็นส่วนลดชดเชย */
function invBreak(D,inv){const m=r1map(D),dp=docPO(D,inv),ag=new Map(),o={base:0,net:0,promo:0,q:0,y:0,s:0,po:0},rates=new Set();
  for(const x of invLines(inv,D)){const l=x.l,po=linePO(D,l,dp);if(po&&!ag.has(po))ag.set(po,aggLines(po));const t=po&&resolveLine(ag.get(po),l),r=t&&m.get(m1key(po.poNo,t.code));
    o.base+=x.amt;o.net+=x.net;rates.add(r&&r.scope&&r.discBase!=null?r.disc:t&&t.price!=null&&x.amt?Math.round((1-(l.qty||0)*t.price/x.amt)*1000)/10:-1);
    if(r&&r.scope&&r.discBase!=null){o.promo+=x.amt*r.discBase/100;o.q+=x.amt*r.dcQ/100;o.y+=x.amt*r.dcY/100;o.s+=x.amt*r.dcS/100}
    else if(t&&t.price!=null)o.po+=Math.max(0,x.amt-(l.qty||0)*t.price)}
  const r2=v=>Math.round(v*100)/100,pc=v=>o.base?Math.round(v/o.base*1e4)/100:0,disc=o.base-o.net,has=disc>0.005,comp=has?disc-o.promo-o.q-o.y-o.s:0;
  const parts=!has?[]:[['ส่วนลดโปร',o.promo],['DC:Quarter',o.q],['DC:Yearly',o.y],['ส่วนลดพิเศษ',o.s],[comp<0?'ส่วนลดขาดจากโปรโมชั่น':'ส่วนลดชดเชย',comp]].map(z=>({label:z[0],amt:r2(z[1]),pct:snap5(pc(z[1]))})).filter(z=>Math.abs(z.pct)>=0.06);
  const raw=pc(disc),odd=has&&rates.size<=1&&!isHalf(raw);
  return{base:r2(o.base),net:r2(o.net),disc:r2(disc),pct:snap5(raw),comp:r2(comp),parts,odd}}
function invChecks(D,inv){const st=D.set,c=[],add=(ok,label)=>c.push({ok,label});
  const sum=(inv.lines||[]).reduce((s,l)=>s+(l.amount!=null?l.amount:(l.qty||0)*(l.price||0)),0);
  const rf=docRef(D,inv);add(!!rf,rf?(rf.via==='po'?'จับคู่จากเลขที่ PO '+rf.po.poNo:'จับคู่จากเอกสารอ้างอิง ตรงกับใบส่งสินค้า D/O No. '+rf.ref+' ของ PO '+docPOs(D,rf.dl).map(q=>q.poNo).join(', ')):'ไม่พบ PO หรือใบส่งสินค้าที่อ้างอิง ('+([inv.poNo,inv.refNo].filter(Boolean).join(', ')||'ไม่ระบุ')+')');
  if(rf&&rf.via==='do'&&kc(inv.poNo)){const ps=docPOs(D,rf.dl),pn=findPO(D,inv.poNo);if(pn&&ps.length&&!ps.includes(pn))add(false,'เลขที่ PO ในใบกำกับ ('+inv.poNo+') ไม่ตรงกับ PO ของใบส่งสินค้า '+rf.ref+' ('+ps.map(q=>q.poNo).join(', ')+')')}
  if(!rf||rf.via!=='do'){const rn=String(inv.refNo||'').trim(),dn=doNoPO(D,inv);if(dn)add(false,'เลขที่เอกสารอ้างอิงตรงกับใบส่งสินค้า D/O No. '+dn.docNo+' แล้ว แต่ใบส่งสินค้าใบนั้นยังไม่ได้จับคู่กับ PO');else if(rn)add(true,'ยังไม่พบใบส่งสินค้าเลขที่ '+rn+' ในระบบ จึงจับคู่จากเลขที่ PO')}
  if(inv.dueDate)add(true,'วันครบกำหนดตามเอกสาร '+inv.dueDate);
  const badLine=(inv.lines||[]).filter(l=>l.amount!=null&&l.qty!=null&&l.price!=null&&Math.abs(l.qty*l.price-l.amount)>Math.max(st.vatTol,0.05));
  add(!badLine.length,badLine.length?'จำนวน × ราคา ไม่เท่ายอดรายการ '+badLine.length+' บรรทัด':'จำนวน × ราคา = ยอดรายการ ทุกบรรทัด');
  const dsc=invDisc(inv);if(inv.subtotal!=null)add(Math.abs(sum-dsc-inv.subtotal)<=Math.max(st.vatTol,0.05),'ผลรวมรายการ '+sum.toFixed(2)+(dsc?' หักส่วนลดท้ายใบกำกับ '+dsc.toFixed(2):'')+' เทียบยอดก่อนภาษี '+inv.subtotal.toFixed(2));
  {const bk=invBreak(D,inv);if(bk.odd)add(false,'ส่วนลด '+bk.pct+'% ไม่เป็นจำนวนเต็มหรือ .50 ยอดส่วนลดหรือยอดรายการอาจอ่านผิด')}
  if(rf){const k=invComp(D,inv),ct=Math.max(st.vatTol,0.5);if(k.comp<-ct)add(false,'ยอดหลังหักส่วนลด '+k.net.toFixed(2)+' สูงกว่ายอดตามใบสั่งซื้อ '+k.exp.toFixed(2)+' ส่วนลดขาด '+(-k.comp).toFixed(2));else if(k.comp>ct)add(true,'ได้ส่วนลดชดเชย '+k.comp.toFixed(2)+' (ส่วนลดท้ายใบกำกับ '+k.disc.toFixed(2)+' ส่วนลดตามใบสั่งซื้อ '+k.poDisc.toFixed(2)+')');else if(dsc)add(true,'ส่วนลดท้ายใบกำกับ '+k.disc.toFixed(2)+' เท่ากับส่วนลดตามใบสั่งซื้อ')}
  else add(false,'ไม่มียอดก่อนภาษี');
  const base=inv.subtotal!=null?inv.subtotal:sum,exp=Math.round(base*st.vatRate)/100;
  if(inv.vat!=null)add(Math.abs(inv.vat-exp)<=st.vatTol,'ภาษี '+st.vatRate+'% ควรเป็น '+exp.toFixed(2)+' เอกสารระบุ '+inv.vat.toFixed(2));
  else add(false,'ไม่มียอดภาษีมูลค่าเพิ่ม');
  if(inv.total!=null&&inv.vat!=null)add(Math.abs(base+inv.vat-inv.total)<=st.vatTol,'ยอดรวมสุทธิ = ก่อนภาษี + ภาษี ('+inv.total.toFixed(2)+')');
  const tid=String(inv.vendorTaxId||'').replace(/\D/g,'');
  add(tid.length===13,tid.length===13?'เลขผู้เสียภาษีผู้ขายครบ 13 หลัก':'เลขผู้เสียภาษีผู้ขายไม่ครบ 13 หลัก');
  if(st.buyerTaxId){const b=String(inv.buyerTaxId||'').replace(/\D/g,'');add(b===String(st.buyerTaxId).replace(/\D/g,''),b?'เลขผู้เสียภาษีผู้ซื้อ '+(b===String(st.buyerTaxId).replace(/\D/g,'')?'ตรงกับบริษัท':'ไม่ตรงกับบริษัท'):'ไม่มีเลขผู้เสียภาษีผู้ซื้อ')}
  const dup=D.invs.filter(x=>kc(x.docNo)===kc(inv.docNo)&&kc(x.vendor)===kc(inv.vendor)).length>1;
  add(!dup,dup?'เลขที่ใบกำกับซ้ำ':'เลขที่ใบกำกับไม่ซ้ำ');
  return c}

function summary(D){const r1=step1(D),m1=m1of(r1),r2=step2(D,m1),r3=step3(D,m1);
  const grp=rows=>{const m=new Map();for(const r of rows){const a=m.get(r.poNo);if(a)a.push(r);else m.set(r.poNo,[r])}return m},g1=grp(r1),g2=grp(r2),g3=grp(r3),NO=[];
  const ivx=poIdx(D);
  const pos=D.pos.map(po=>{const a=g1.get(po.poNo)||NO,b=g2.get(po.poNo)||NO,c=g3.get(po.poNo)||NO;
    const a1=a.filter(r=>r.scope),na=!a1.length;let s1=worst(a1.map(r=>r.lv==='info'?'ok':r.lv));
    let s2=worst(b.map(r=>r.lv));if(s2==='wait'&&b.some(r=>r.del>EPS))s2='warn';
    const invs=(ivx.get(po)||NOIX).inv;
    let s3=invs.length?worst(c.map(r=>r.lv)):'wait';
    if(invs.some(i=>invChecks(D,i).some(k=>!k.ok)))s3='bad';
    const due=Math.round(a1.reduce((x,r)=>x+(r.leak||0),0)*100)/100,cl=invs.map(i=>({inv:i,...invComp(D,i)})),got=Math.round(cl.reduce((x,k)=>x+Math.max(0,k.comp),0)*100)/100,out=Math.max(0,Math.round((due-got)*100)/100);
    const comp={due,got,out,list:cl};let l1x='';
    if(s1==='bad'&&due>0&&out<=Math.max(D.set.vatTol,0.5)&&a1.every(r=>r.lv!=='bad'||r.leak>0)){s1=worst(a1.map(r=>r.lv==='bad'||r.lv==='info'?'ok':r.lv));if(s1==='ok')l1x='ชดเชยครบแล้ว'}
    const dl2=b.filter(r=>r.del>EPS),d2=!dl2.length?'wait':dl2.some(r=>r.lv==='bad')?'bad':dl2.some(r=>r.out>EPS)?'warn':'ok',nOut=b.filter(r=>r.ord>0&&r.out>EPS).length,nLine=b.filter(r=>r.ord>0).length,nDone=b.filter(r=>r.ord>0&&r.del>EPS&&r.out<=EPS).length;
    const all=worst([s1,s2,s3]);
    const total=(po.lines||[]).reduce((s,l)=>s+(l.qty||0)*((l.net??l.price)||0),0);
    return{po,s1,s2,s3,total,comp,
      na,l1:na?'ไม่ต้องเทียบ':l1x||{ok:'ตรงโปร',warn:'ราคาไม่ตรงโปร',bad:'ราคาสูงกว่าโปร'}[s1],
      l2:{ok:'ส่งครบ',wait:'รอส่ง',warn:'ค้างส่ง',bad:'ไม่ตรง PO'}[s2],d2,ld2:{ok:'จำนวนครบ',wait:'รอส่ง',warn:'ค้างส่ง',bad:'ไม่ตรง PO'}[d2],nOut,nLine,nDone,
      l3:{ok:'ตรงกัน',wait:'รอใบกำกับ',warn:'ยังไม่ครบ',bad:'ไม่ตรงกัน'}[s3],
      all,label:{ok:'พร้อมจ่าย',wait:'รอเอกสาร',warn:'ยังไม่ครบ',bad:'ต้องแก้ไข'}[all]}});
  return{pos,r1,r2,r3}}

/* แปลงแถวจาก RST GROUP Data Hub (แท็บ PO_LINES และ PURCHASE_LINES แถวแรกเป็นหัวคอลัมน์) เป็นใบสั่งซื้อและเอกสารรับสินค้า (RE)
   o.company = รหัสบริษัทใน Data Hub (ว่าง = ทุกบริษัท), o.from = วันที่ PO เริ่มต้น, o.vendor = คำในชื่อผู้ขาย (ว่าง = ทุกผู้ขาย)
   เอกสารรับสินค้านำมาเฉพาะรายการที่อ้าง PO ที่โหลดมา */
function hubDocs(poRows,reRows,o){o=o||{};const T=v=>String(v??'').trim(),H=r=>{const h={};(r||[]).forEach((x,i)=>{h[T(x)]=i});return h},g=(r,h,k)=>h[k]==null?'':r[h[k]];
  const from=T(o.from),co=T(o.company),vf=nk(o.vendor||''),pos=new Map(),ph=H(poRows[0]);let nl=0;
  for(let i=1;i<poRows.length;i++){const r=poRows[i];if(!r||!r.length)continue;if(co&&T(g(r,ph,'COMPANY'))!==co)continue;
    const no=T(g(r,ph,'PO_NO')),dt=T(g(r,ph,'PO_DATE')).slice(0,10),vd=T(g(r,ph,'VENDOR'));
    if(!no||(from&&dt<from)||(vf&&!nk(vd).includes(vf)))continue;
    const code=T(g(r,ph,'ITEM_CODE')),qty=num(g(r,ph,'QTY'));if(!code||qty==null)continue;
    const pj=T(g(r,ph,'PROJECT')),p=pos.get(no)||{poNo:no,date:dt,vendor:vd,project:pj,wh:T(g(r,ph,'WAREHOUSE')),ref:['YDS_NO','REMARKS','REMARK','PR_REF'].map(k=>T(g(r,ph,k))).filter(Boolean).join(' '),lines:[],_hub:true};
    const pr=num(g(r,ph,'UNIT_PRICE')),nt=num(g(r,ph,'NET_PRICE')),am=num(g(r,ph,'AMOUNT'));
    p.lines.push({code,name:T(g(r,ph,'ITEM_NAME')),qty,price:pr,net:nt!=null?nt:(am!=null&&qty?Math.round(am/qty*1e4)/1e4:pr),project:pj});nl++;pos.set(no,p)}
  const rh0=H(reRows[0]),RA={COMPANY:['COMPANY','บริษัท'],RE_NO:['RE_NO','RE NO','RENO','PURCHASE_NO','PUR_NO','หมายเลขการซื้อ','เลขที่ RE','เลขที่ใบซื้อ','DOC_NO'],PO_NO:['PO_NO','PO NO','PONO','PO_REF','เลขที่ใบสั่งซื้อ'],ITEM_CODE:['ITEM_CODE','รหัสสินค้า'],ITEM_NAME:['ITEM_NAME','ชื่อสินค้า (ข้อมูลจำเพาะ)','ชื่อสินค้า'],QTY:['QTY','จำนวน'],RECEIVE_DATE:['RECEIVE_DATE','RE_DATE','DATE','วันที่รับสินค้า'],DOC_DATE:['DOC_DATE','วันที่-ลำดับ'],VENDOR:['VENDOR','ชื่อลูกค้า/ผู้ขาย','ชื่อผู้ขาย'],NET_PRICE:['NET_PRICE','ราคาต่อหน่วยหลังส่วนลด'],UNIT_PRICE:['UNIT_PRICE','ราคาต่อหน่วย'],AMOUNT:['AMOUNT','จำนวนเงิน'],INV_NO:['INV_NO','เลขที่ใบกำกับภาษี']},rh={};
  const hk=x=>String(x).toUpperCase().replace(/[\s_.\-]/g,''),rhN={};for(const k in rh0)rhN[hk(k)]=rh0[k];
  for(const k in RA){const f=RA[k].find(a=>rh0[a]!=null||rhN[hk(a)]!=null);if(f!=null)rh[k]=rh0[f]!=null?rh0[f]:rhN[hk(f)]}
  const rdt=v=>{if(typeof v==='number'&&v>20000&&v<80000)return new Date(Math.round((v-25569)*864e5)).toISOString().slice(0,10);const t=T(v);return /^\d{4}-\d{2}-\d{2}/.test(t)?t.slice(0,10):(dateIn(t)||t)};
  const docs=new Map(),key=l=>kc(l.ref||'')+'|'+kc(l.code),byDoc={};let nr=0,skip=0,noPo=0;
  for(let i=1;i<reRows.length;i++){const r=reRows[i];if(!r||!r.length)continue;if(co&&T(g(r,rh,'COMPANY'))!==co)continue;
    const pn=T(g(r,rh,'PO_NO')),no=T(g(r,rh,'RE_NO')),code=T(g(r,rh,'ITEM_CODE')),qty=num(g(r,rh,'QTY')),ivn=T(g(r,rh,'INV_NO'));
    if(no&&kc(ivn).length>=3){const k=kc(ivn),a=byDoc[k]||(byDoc[k]={re:[],date:'',po:[]});if(!a.re.includes(no))a.re.push(no);if(pn&&!a.po.includes(pn))a.po.push(pn);a.date=a.date||rdt(g(r,rh,'RECEIVE_DATE'))}
    if(!no||!code||qty==null)continue;if(!pn){noPo++;continue}if(!pos.has(pn)){skip++;continue}
    const d=docs.get(no)||{docNo:no,kind:'re',date:rdt(g(r,rh,'RECEIVE_DATE'))||rdt(g(r,rh,'DOC_DATE')),vendor:T(g(r,rh,'VENDOR')),poNo:pn,refNo:ivn,lines:[],_hub:true};
    const gp=ks=>{for(const k of ks){const v=num(g(r,rh,k));if(v!=null)return v}return null},am0=gp(['AMOUNT','จำนวนเงิน']),up=gp(['NET_PRICE','UNIT_PRICE'])??(am0!=null&&qty?Math.round(am0/qty*1e4)/1e4:null);
    const l={ref:pn!==d.poNo?pn:'',code,name:T(g(r,rh,'ITEM_NAME')),qty,price:up,disc:null,amount:up!=null?Math.round(up*qty*100)/100:null},x=d.lines.find(z=>key(z)===key(l));
    if(x){x.qty+=qty;if(x.price!=null&&up!=null)x.amount=Math.round((x.amount+up*qty)*100)/100;else{x.price=null;x.amount=null}}else d.lines.push(l);nr++;docs.set(no,d)}
  return{pos:[...pos.values()],dels:[...docs.values()],byDoc,nl,nr,skip,noPo,reCols:!!(rh.RE_NO!=null&&rh.PO_NO!=null&&rh.ITEM_CODE!=null&&rh.QTY!=null),reHead:(reRows[0]||[]).map(T).filter(Boolean)}}

/* ตรวจว่าใบส่งสินค้าหนึ่งใบผ่านขั้น PO เทียบใบส่งสินค้า และออก RE ได้หรือไม่
   ผ่าน = ทุกรายการจับคู่ PO ได้ อยู่ใน PO นั้น มีราคา และจำนวนไม่เกินจำนวนค้างรับ (สั่งซื้อ − ที่มี RE แล้ว) */
function reCheck(D,d){const why=[],lines=[],need=new Map(),dp=docPO(D,d);
  if(!kc(d.docNo))why.push('ไม่มีเลขที่ใบส่งสินค้า');if(!(d.lines||[]).length)why.push('ไม่มีรายการสินค้า');
  for(const l of d.lines||[]){const po=linePO(D,l,dp),t=po&&resolveLine(aggLines(po),l),nm=l.code||l.name||'?';
    if(!(l.qty>0)){why.push(nm+' ไม่มีจำนวน');continue}
    if(!po){why.push(nm+' ยังไม่ได้จับคู่ PO');continue}
    if(!t){why.push(nm+' ไม่อยู่ใน '+po.poNo);continue}
    if(t.price==null)why.push(nm+' ไม่มีราคาใน '+po.poNo);
    const k=po.poNo+'|'+t.k,e=need.get(k)||{po,t,qty:0};e.qty+=l.qty;need.set(k,e);
    lines.push({po,code:t.code,name:t.name||l.name||'',qty:l.qty,price:t.price==null?null:Math.round(t.price*1e4)/1e4,ref:l.ref||''})}
  for(const e of need.values()){const r=recv(D,e.po).m.get(e.t.k),re=r?r.re:0,left=e.t.qty-re;
    if(e.qty-left>EPS)why.push(e.t.code+' ส่ง '+e.qty+' เกินจำนวนค้างรับของ '+e.po.poNo+' (เหลือ '+Math.max(left,0)+(re>EPS?' มี RE แล้ว '+re:'')+')')}
  const pos=[...new Set(lines.map(x=>x.po))];
  if(new Set(pos.map(p=>nk(p.vendor))).size>1)why.push('PO ที่อ้างเป็นของผู้ขายต่างราย');
  return{ok:!why.length,why,lines,qty:lines.reduce((a,x)=>a+x.qty,0),pos}}
