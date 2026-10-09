/* ==========================================================================
 * MODULE 15  EXCEL IMPORT
 * จับคู่คอลัมน์และนำเข้ารายงานสถานะการซื้อ / ไฟล์โปรโมชั่น
 * ฟังก์ชัน: autoMap, readXlsx, netPrice, promoPrice, importGo, hn, dstr
 * ========================================================================== */
/* ---------- Excel import ---------- */
const FIELDS={po:[['poNo','เลขที่ใบสั่งซื้อ',['เลขที่ใบสั่งซื้อ','วันที่-เลขที่','เลขที่ po','po no','po number','date-no','เลขที่เอกสาร','เลขที่','ใบสั่งซื้อ']],['date','วันที่',['วันที่','date']],['project','โครงการ',['ชื่อโครงการ','โครงการ','project']],['vendor','ผู้จำหน่าย',['ชื่อผู้จำหน่าย','ชื่อผู้จัดจำหน่าย','ชื่อลูกค้า/ผู้จำหน่าย','ชื่อลูกค้า/ผู้จัดจำหน่าย','ผู้จำหน่าย','ผู้จัดจำหน่าย','ชื่อผู้ขาย','ผู้ขาย','ชื่อลูกค้า','vendor','supplier','customer']],['code','รหัสสินค้า',['รหัสสินค้า','item code','parts no','part no','รหัส']],['name','รายละเอียดสินค้า',['ชื่อสินค้า','รายละเอียดสินค้า','item name','parts name','description','รายการ']],['net','ราคาต่อหน่วยหลังหักส่วนลด',['ราคาต่อหน่วยหลังหักส่วนลด','ราคาหลังหักส่วนลด','ราคาหลังส่วนลด','ราคาสุทธิ','net price']],['amount','จำนวนเงินหลังหักส่วนลด (ก่อน VAT)',['จำนวนเงิน','มูลค่าสินค้า','มูลค่า','ยอดเงิน','supply amount','amount']],['qty','จำนวน',['จำนวน','qty','quantity']],['price','ราคาต่อหน่วย (ก่อนส่วนลด)',['ราคาต่อหน่วย','ราคา/หน่วย','unit price','ราคา','price']],['disc','ส่วนลด',['ส่วนลด','discount']],['ref','YDS. No. / หมายเหตุ (เลขอ้างอิงผู้ขาย)',['yds. no./หมายเหตุ','yds. no.','yds no','yds','หมายเหตุ','remark']]],
  re:[['poNo','เลขที่ใบสั่งซื้อ / PO ที่อ้างอิง',['เลขที่ใบสั่งซื้อ','เลขที่ po','ใบสั่งซื้อ','po no','po number','อ้างอิง','po']],['docNo','เลขที่เอกสารรับสินค้า (RE)',['เลขที่ใบรับสินค้า','เลขที่รับสินค้า','วันที่-เลขที่','เลขที่เอกสาร','re no','gr no','doc no','เลขที่']],['date','วันที่รับ',['วันที่รับ','วันที่','date']],['vendor','ผู้จำหน่าย',['ชื่อผู้จำหน่าย','ชื่อผู้จัดจำหน่าย','ชื่อลูกค้า/ผู้จำหน่าย','ผู้จำหน่าย','ผู้จัดจำหน่าย','ผู้ขาย','ชื่อลูกค้า','vendor','supplier']],['code','รหัสสินค้า',['รหัสสินค้า','item code','parts no','part no','รหัส']],['name','รายละเอียดสินค้า',['ชื่อสินค้า','รายละเอียดสินค้า','item name','description','รายการ']],['qty','จำนวนรับ',['จำนวนรับ','จำนวน','qty','quantity']],['price','ราคาต่อหน่วยหลังส่วนลด (ราคา_RE)',['ราคาต่อหน่วยหลังส่วนลด','ราคาหลังหักส่วนลด','ราคาสุทธิ','net price','ราคาต่อหน่วย','unit price']],['amount','จำนวนเงิน (ก่อน VAT)',['จำนวนเงิน','มูลค่า','amount']]],
  promo:[['code','รหัสสินค้า',['parts no','part no','รหัสสินค้า','item code','รหัส']],['name','ชื่อสินค้า (อังกฤษ)',['parts name','part name','item name','description']],['nameTh','ชื่อภาษาไทย',['ชื่อภาษาไทย','ชื่อไทย','ชื่อสินค้า']],['mo','MO (ราคาตั้ง)',['mo']],['disc','ส่วนลดโปรโมชั่น %',['promotion','sp discount','ส่วนลดโปร','ส่วนลด','discount','%']],['price','ราคาโปรโมชั่นก่อน VAT / NP_Promotion',['np_promotion','np promotion','sp price_net','sp price net','price_net','ราคาโปรโมชั่น','ราคาโปร','ราคาก่อน vat','ราคาก่อนภาษี','ราคาสุทธิ','net price','ราคา','price']],['brand','ยี่ห้อ / ผู้จำหน่าย',['solis/yanmar','brand','ยี่ห้อ']],['ptype','Part Type / Type Part',['part type','type part','parts type','type parts','parttype','typepart','part_type','type_part','ประเภทอะไหล่','ประเภทสินค้า','type']]]};
const hn=s=>String(s??'').toLowerCase().replace(/\s+/g,' ').trim();
function autoMap(headers,fields){const H=headers.map(hn),map={},used=new Set();
  for(const pass of[0,1])for(const[f,,syn]of fields){if(map[f]!=null)continue;
    for(const s of syn){const i=H.findIndex((h,ix)=>!used.has(ix)&&(pass===0?h===s:h.includes(s))&&!(f==='vendor'&&/รหัส|code/.test(h)));if(i>=0){map[f]=i;used.add(i);break}}}
  return map}
async function readXlsx(file,kind){
  const wb=XLSX.read(await file.arrayBuffer(),{cellDates:true});
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:'',raw:true});
  const fields=FIELDS[kind];let best=0,bs=-1;
  for(let i=0;i<Math.min(rows.length,25);i++){const n=Object.keys(autoMap(rows[i],fields)).length;if(n>bs){bs=n;best=i}}
  const headers=rows[best].map(x=>String(x??''));
  IMP={kind,fields,headers,map:autoMap(headers,fields),rows:rows.slice(best+1).filter(r=>r.some(c=>c!=='')),file:file.name,name:file.name.replace(/\.[^.]+$/,''),start:'',end:'',discType:'pct'};
  if(kind==='promo')IMP.ptype=(IMP.map.disc==null||/น้ำมัน|oil|lube/i.test(file.name))?'price':'pct';
  tab='docs';render()}
const dstr=v=>{if(v instanceof Date){const d=new Date(v.getTime()-v.getTimezoneOffset()*60000);return d.toISOString().slice(0,10)}const m=String(v||'').match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);if(m)return`${m[1]>2400?m[1]-543:m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;const m2=String(v||'').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);if(m2)return`${m2[3]>2400?m2[3]-543:m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;return''};
function netPrice(price,qty,netRaw,amtRaw,dRaw,type){const n=num(netRaw),a=num(amtRaw),r4=x=>Math.round(x*1e4)/1e4;
  if(n!=null)return n;if(a!=null&&qty)return r4(a/qty);
  let d=typeof dRaw==='string'?num(dRaw.replace('%','')):num(dRaw);if(d==null||price==null)return price;
  if(typeof dRaw==='string'&&dRaw.includes('%'))return r4(price*(1-d/100));
  if(type==='unit')return r4(price-d);if(type==='line')return qty?r4(price-d/qty):price;
  if(typeof dRaw==='number'&&Math.abs(d)<1)d*=100;return r4(price*(1-d/100))}
function promoPrice(mo,disc,np){mo=num(mo);np=num(np);let d=typeof disc==='string'&&disc.includes('%')?num(disc.replace('%','')):num(disc);
  if(d!=null&&typeof disc!=='string'&&Math.abs(d)<=1)d=d*100;else if(d!=null&&typeof disc==='string'&&!disc.includes('%')&&Math.abs(d)<=1)d=d*100;
  if(d!=null)d=Math.abs(d);
  if(mo!=null&&d!=null)return{mo,disc:Math.round(d*1e4)/1e4,price:Math.round(mo*(1-d/100)*100)/100};
  return{mo,disc:d,price:np}}
async function importGo(){
  const map={};for(const f of IMP.fields)map[f[0]]=+$('#map_'+f[0]).value;
  const g=(r,f)=>map[f]>=0?r[map[f]]:'';
  try{
  if(IMP.kind==='promo'){
    const fixed=IMP.ptype==='price';
    if(map.code<0)return toast('ต้องเลือกคอลัมน์รหัสสินค้า');
    if(fixed&&map.price<0)return toast('ต้องเลือกคอลัมน์ราคาโปรโมชั่นก่อน VAT');
    if(!fixed&&(map.mo<0||map.disc<0)&&map.price<0)return toast('ต้องเลือกคอลัมน์ MO กับส่วนลด %');
    const list=IMP.rows.map(r=>({code:String(g(r,'code')).trim(),name:String(g(r,'name')).trim(),nameTh:String(g(r,'nameTh')).trim(),...(fixed?{mo:null,disc:null,price:num(g(r,'price'))}:promoPrice(g(r,'mo'),g(r,'disc'),g(r,'price'))),brand:String(g(r,'brand')).trim(),ptype:String(g(r,'ptype')).trim()})).filter(p=>p.code),all=list.length;
    if(!fixed)for(const x of list){if(x.disc==null)x.disc=0;if(x.price==null&&x.mo!=null)x.price=Math.round(x.mo*(100-x.disc))/100}
    if(!fixed)for(const x of list)if(x.disc!=null&&isHalf(x.disc)&&x.mo!=null){x.disc=snap5(x.disc);x.price=Math.round(x.mo*(100-x.disc))/100}
    const skipped=0,noDisc=fixed?0:list.filter(x=>!(x.disc>0)).length,oddN=fixed?0:list.filter(x=>!isHalf(x.disc)).length;
    if(!list.length)return toast('ไม่พบแถวที่มีรหัสสินค้า');
    const nm=(IMP.name||'').trim();if(!nm)return toast('ใส่ชื่อโปรโมชั่น');
    if(!IMP.start||!IMP.end)return toast('ระบุวันเริ่มและวันสิ้นสุดโปรโมชั่น');
    if(IMP.start>IMP.end)return toast('วันเริ่มต้องไม่หลังวันสิ้นสุด');
    const sid='p'+Date.now().toString(36),n=Math.ceil(list.length/100);
    for(let i=0;i<n;i++){BUSY=`กำลังบันทึก ${i+1}/${n}`;render();await put('promos',sid+'-c'+String(i).padStart(3,'0'),{set:sid,rows:list.slice(i*100,i*100+100)})}
    await put('promosets',sid,{type:IMP.ptype||'pct',name:nm,start:IMP.start,end:IMP.end,file:IMP.file||'',at:new Date().toISOString(),by:myId||null});
    tab='promos';
    toast('เพิ่มโปรโมชั่น “'+nm+'” '+list.length+' รายการ'+(noDisc?' ในจำนวนนี้ '+noDisc+' รายการไม่มีส่วนลด':'')+(oddN?' พบ '+oddN+' รายการที่ส่วนลดไม่เป็นจำนวนเต็มหรือ .50 ตรวจในคลังโปรโมชั่น':''));
  }else if(IMP.kind==='re'){
    if(map.code<0||map.qty<0||(map.docNo<0&&map.poNo<0))return toast('ต้องเลือกคอลัมน์รหัสสินค้า จำนวนรับ และเลขที่เอกสารรับสินค้าหรือเลขที่ PO');
    const docs=new Map(),key=l=>kc(l.ref||'')+'|'+kc(l.code);let last=null,lastPo='';
    for(const r of IMP.rows){let no=g(r,'docNo');no=no instanceof Date?dstr(no):String(no).trim();let pn=String(g(r,'poNo')).trim();
      const code=String(g(r,'code')).trim(),qty=num(g(r,'qty'));
      if(!no&&map.docNo<0&&pn)no='RE-'+pn;if(!no&&last&&code){no=last;if(!pn)pn=lastPo}
      if(!no||!code||qty==null)continue;last=no;lastPo=pn;
      const d=docs.get(no)||{docNo:no,kind:'re',date:dstr(g(r,'date'))||dstr(no),vendor:String(g(r,'vendor')).trim(),poNo:pn,refNo:'',lines:[]};
      const am0=num(g(r,'amount')),up=num(g(r,'price'))??(am0!=null&&qty?Math.round(am0/qty*1e4)/1e4:null);
      const l={ref:pn&&pn!==d.poNo?pn:'',code,name:String(g(r,'name')).trim(),qty,price:up,disc:null,amount:up!=null?Math.round(up*qty*100)/100:null},o=d.lines.find(x=>key(x)===key(l));
      if(o){o.qty+=qty;if(o.price!=null&&up!=null)o.amount=Math.round((o.amount+up*qty)*100)/100;else{o.price=null;o.amount=null}}else d.lines.push(l);docs.set(no,d)}
    if(!docs.size)return toast('ไม่พบรายการรับสินค้า ตรวจการเลือกคอลัมน์');
    const D0=DATA();let nNew=0,nAdd=0,nSame=0,nDiff=0,nNoPO=0,i=0;
    for(const d of docs.values()){i++;if(i%5===1){BUSY=`กำลังบันทึก ${i}/${docs.size}`;render()}
      let id=idOf(d.docNo);if(S.dels[id]&&!isRE(S.dels[id])){d.docNo='RE-'+d.docNo;id=idOf(d.docNo)}
      const old=S.dels[id];
      if(!old){await put('dels',id,{...d,by:myId||null,at:new Date().toISOString()});nNew++;if(!docPOs(D0,d).length)nNoPO++;continue}
      const have=new Map((old.lines||[]).map(l=>[key(l),l])),add=d.lines.filter(l=>!have.has(key(l)));
      nDiff+=d.lines.filter(l=>have.has(key(l))&&Math.abs((have.get(key(l)).qty||0)-l.qty)>1e-6).length;
      if(add.length){await put('dels',id,{...old,lines:[...(old.lines||[]),...add]});nAdd+=add.length}else nSame++}
    tab='delivery';
    toast('รับสินค้า: เอกสารใหม่ '+nNew+' ใบ · เพิ่มรายการใหม่ในเอกสารเดิม '+nAdd+' รายการ · เอกสารเดิมไม่เปลี่ยน '+nSame+' ใบ'+(nDiff?' · มี '+nDiff+' รายการที่จำนวนในไฟล์ต่างจากที่บันทึกไว้ ระบบไม่ได้แก้ให้ ตรวจแล้วแก้ที่เอกสารนั้น':'')+(nNoPO?' · '+nNoPO+' ใบยังหา PO ไม่พบ':''));
  }else{
    if(map.poNo<0||map.code<0||map.qty<0)return toast('ต้องเลือกคอลัมน์เลขที่ PO รหัสสินค้า และจำนวน');
    const pos=new Map();let last=null;
    for(const r of IMP.rows){let no=g(r,'poNo');no=no instanceof Date?dstr(no):String(no).trim();
      const code=String(g(r,'code')).trim(),qty=num(g(r,'qty'));
      if(!no&&last&&code)no=last;if(!no||!code||qty==null)continue;last=no;
      const p=pos.get(no)||{poNo:no,date:dstr(g(r,'date'))||dstr(no),vendor:String(g(r,'vendor')).trim(),project:'',lines:[]};
      if(!p.vendor)p.vendor=String(g(r,'vendor')).trim();
      const pj=String(g(r,'project')).trim();if(pj&&!p.project)p.project=pj;
      const rf=String(g(r,'ref')).trim();if(rf&&!String(p.ref||'').includes(rf))p.ref=(p.ref?p.ref+' ':'')+rf;
      const pr=num(g(r,'price'));p.lines.push({code,name:String(g(r,'name')).trim(),qty,price:pr,net:netPrice(pr,qty,g(r,'net'),g(r,'amount'),g(r,'disc'),IMP.discType),project:pj});pos.set(no,p)}
    if(!pos.size)return toast('ไม่พบรายการ PO ตรวจการเลือกคอลัมน์');
    let i=0;for(const p of pos.values()){i++;if(i%5===1){BUSY=`กำลังบันทึก ${i}/${pos.size}`;render()}await put('pos',idOf(p.poNo),p)}
    toast('นำเข้า PO '+pos.size+' ใบ');
  }
  IMP=null}catch(e){wErr(e)}finally{BUSY=null;render()}}
