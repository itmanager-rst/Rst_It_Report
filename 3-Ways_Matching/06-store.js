/* ==========================================================================
 * MODULE 06  STORE + GOOGLE SHEET
 * ฐานข้อมูลในเบราว์เซอร์ การตั้งค่า สิทธิ์ผู้ดูแล และการซิงก์กับ Google Sheet
 * ฟังก์ชัน: refreshAdmin, settings, DATA, hubSet, pickRE, loadHub, saveLocal, enqueue, put, rm, gsPost, flush, gsLoad, pushAll, chip, wErr, init, saveCfg, hubOn, realEmpty, isDemo, wait
 * ========================================================================== */
/* ---------- store: this browser + optional Google Sheet ---------- */
const S={pos:{},dels:{},invs:{},appr:{},promos:{},promosets:{},meta:{},res:{}},COLLS=Object.keys(S);
/* ไฟล์ HTML ไม่มีตัวเชื่อมต่อ Google Drive ของ Claude: ปุ่มออก RE ผ่าน Drive จึงปิดไว้ */
const mcpCap=null,userCap=null;
const CFG={gsUrl:'',aiKey:'',aiModel:'claude-sonnet-5-5',userName:''};
try{Object.assign(CFG,JSON.parse(localStorage.getItem('m3_cfg')||'{}'))}catch(e){}
const saveCfg=()=>{try{localStorage.setItem('m3_cfg',JSON.stringify(CFG))}catch(e){}};
const db=null,readOnly=false,ready=true,NAMES=new Proxy({},{get:(t,k)=>k}),names=()=>{};
let myId=CFG.userName||null;
function refreshAdmin(){const pin=settings().adminPin||'';let u='';try{u=sessionStorage.getItem('m3_admin')||''}catch(e){}isAdmin=!pin||u===pin}
const SYNC={state:'idle',msg:''};
/* RST GROUP Data Hub: อ่านผ่าน Apps Script Web App (action=hub) ไม่คัดลอกลงฐานข้อมูลของหน้านี้ */
const HUB_ID='';
let HUB=null,HUBST={s:'idle',msg:''};
const hubOn=()=>!!(HUB&&(HUB.pos.length||HUB.dels.length));
const realEmpty=()=>!hubOn()&&!Object.keys(S.pos).length&&!Object.keys(S.dels).length&&!Object.keys(S.invs).length&&!Object.keys(S.promos).length;
const isDemo=()=>realEmpty();
function settings(){return{...DEF,...(S.meta.settings||{})}}
function DATA(){if(isDemo()){for(const k of['pos','dels','invs'])for(const x of SAMPLE[k])if(!x._id)x._id=idOf(x.docNo||x.poNo);return{...SAMPLE,set:settings(),demo:true}}
  const sets=Object.entries(S.promosets).map(([id,d])=>({...d,id})),chunks=Object.keys(S.promos).sort();
  if(chunks.some(k=>!S.promos[k].set))sets.push({id:'legacy',name:'โปรโมชั่นเดิม',...(S.meta.promo||{}),start:(S.meta.promo||{}).start||'',end:(S.meta.promo||{}).end||''});
  const promos=chunks.flatMap(k=>{const c=S.promos[k],x=sets.find(z=>z.id===(c.set||'legacy'));return x?(c.rows||[]).map((r,i)=>applyDC({...r,_k:k,_i:i,setId:x.id,setName:x.name,start:x.start,end:x.end},x)):[]});
  sets.forEach(x=>{x.count=promos.filter(q=>q.setId===x.id).length});sets.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
  const v=o=>Object.entries(o).map(([id,d])=>({...d,_id:id}));
  let pos=v(S.pos).map(poDateFix),dels=v(S.dels);
  if(hubOn()){const hp=new Set(HUB.pos.map(p=>p._id)),hd=new Set(HUB.dels.map(d=>d._id));pos=[...HUB.pos,...pos.filter(p=>!hp.has(p._id))];dels=[...dels.filter(d=>!(isRE(d)&&hd.has(d._id))),...HUB.dels]}
  return{promos,pos:pos.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||String(a.poNo).localeCompare(String(b.poNo))),dels,invs:v(S.invs),appr:S.appr,sets,set:settings(),demo:false}}
function hubSet(){const s=settings(),raw=String(s.hubFileId||'').trim(),m=raw.match(/\/d\/([\w-]{20,})/);
  return{id:m?m[1]:raw||HUB_ID,company:s.hubCompany==null?'RUAMSINTHAI':String(s.hubCompany).trim(),from:s.hubFrom==null?'2026-01-01':String(s.hubFrom).trim(),vendor:String(s.hubVendor||'').trim()}}
/* แท็บเอกสารรับสินค้า (สถานะการซื้อ) ใน Data Hub: ใช้แท็บที่มีข้อมูลมากที่สุดระหว่าง PURCHASE_LINES กับ ECOUNT_PURCHASE */
function pickRE(t){for(const k in t){const r=t[k];if(r&&r.length>1)return{rows:r,tab:k}}return{rows:[[]],tab:''}}
async function loadHub(auto){if(HUBST.s==='busy')return;if(!CFG.gsUrl){if(!auto)toast('เชื่อมต่อ Apps Script Web App ที่แท็บ “ตั้งค่า” ก่อน');return}
  const o=hubSet();HUBST={s:'busy',msg:''};render();
  try{const r=await fetch(CFG.gsUrl+(CFG.gsUrl.includes('?')?'&':'?')+'action=hub&id='+encodeURIComponent(o.id)),j=await r.json();
    if(!j.tabs)throw{code:'hub_old',message:j.ok?'Apps Script ยังเป็นเวอร์ชันเก่า คัดลอก Code.gs ใหม่จากแท็บ “ตั้งค่า” แล้ว Deploy เวอร์ชันใหม่':'Apps Script อ่าน Data Hub ไม่ได้: '+(j.error||'')+' ตรวจว่าบัญชีที่ติดตั้ง Apps Script เปิดไฟล์ Data Hub ได้ และ Deploy Code.gs เวอร์ชันใหม่แล้ว'};
    const T=t=>t?[t.headers,...t.rows]:null,po=T(j.tabs.PO_LINES),{rows:re,tab:reTab}=pickRE({PURCHASE_LINES:T(j.tabs.PURCHASE_LINES),ECOUNT_PURCHASE:T(j.tabs.ECOUNT_PURCHASE)});
    if(!po)throw{code:'hub_tabs',message:'ไฟล์นี้ไม่มีแท็บ PO_LINES'};
    const h=hubDocs(po,re,o);
    for(const p of h.pos)p._id=idOf(p.poNo);
    for(const d of h.dels){let id=idOf(d.docNo);if(S.dels[id]&&!isRE(S.dels[id])){d.docNo='RE-'+d.docNo;id=idOf(d.docNo)}d._id=id}
    const first=!hubOn();HUB={pos:h.pos,dels:h.dels,byDoc:h.byDoc||{},nl:h.nl,nr:h.nr,skip:h.skip,noPo:h.noPo,reTab,reCols:h.reCols,reHead:h.reHead,rows:po.length-1+Math.max(re.length-1,0),at:Date.now(),o};
    HUBST={s:'ok',msg:''};try{localStorage.setItem('m3_hub','1')}catch(e){}
    if(first&&!F.month&&h.nl>1500){const ms=months(DATA());if(ms.length)F.month=ms[0]}
    if(!auto)toast(h.pos.length?'โหลดจาก Data Hub แล้ว: ใบสั่งซื้อ '+h.pos.length+' ใบ เอกสารรับสินค้า (RE) '+h.dels.length+' ใบ'+(reTab?' จากแท็บ '+reTab:' (ไม่พบแท็บสถานะการซื้อ)'):'เชื่อมต่อ Data Hub ได้ แต่ไม่มีใบสั่งซื้อที่ตรงเงื่อนไข ตรวจบริษัท วันที่เริ่ม และผู้ขายที่แท็บตั้งค่า')}
  catch(e){console.error(e);HUBST={s:'err',msg:e&&e.code?e.message:'โหลดจาก Data Hub ไม่สำเร็จ: '+((e&&e.message)||'')+' ตรวจ URL ของ Apps Script และการเชื่อมต่ออินเทอร์เน็ต'};if(!auto)toast(HUBST.msg)}
  render()}
function saveLocal(){try{localStorage.setItem('m3_state',JSON.stringify(S))}catch(e){toast('พื้นที่เก็บข้อมูลของเบราว์เซอร์เต็ม เชื่อมต่อ Google Sheet หรือลบเอกสารเก่า')}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const QS=new Map(),QD=new Map();let qT=null,flushing=false;
function enqueue(coll,id,del){if(!CFG.gsUrl)return;const k=coll+'/'+id;if(del){QS.delete(k);QD.set(k,{coll,id})}else{QD.delete(k);QS.set(k,{coll,id})}clearTimeout(qT);qT=setTimeout(flush,1200)}
async function put(coll,id,data){data=JSON.parse(JSON.stringify(data));delete data._id;S[coll][id]=data;saveLocal();enqueue(coll,id,false)}
async function rm(coll,id){delete S[coll][id];saveLocal();enqueue(coll,id,true)}
async function gsPost(body){const r=await fetch(CFG.gsUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw new Error(j.error||'Google Sheet ตอบกลับผิดพลาด');return j}
async function flush(){if(flushing||!CFG.gsUrl)return;flushing=true;SYNC.state='busy';SYNC.msg='กำลังบันทึกลง Google Sheet…';chip();
  try{while(QS.size||QD.size){const ks=[...QS.keys()].slice(0,30),rows=[];
      for(const k of ks){const q=QS.get(k);QS.delete(k);if(S[q.coll][q.id])rows.push({coll:q.coll,id:q.id,json:JSON.stringify(S[q.coll][q.id])})}
      const deletes=[...QD.values()];QD.clear();
      try{await gsPost({action:'save',rows,deletes})}catch(e){rows.forEach(r=>QS.set(r.coll+'/'+r.id,{coll:r.coll,id:r.id}));deletes.forEach(d=>QD.set(d.coll+'/'+d.id,d));throw e}}
    SYNC.state='ok';SYNC.msg='บันทึกลง Google Sheet แล้ว '+new Date().toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})}
  catch(e){console.error(e);SYNC.state='err';SYNC.msg='บันทึกลง Google Sheet ไม่สำเร็จ ข้อมูลยังอยู่ในเบราว์เซอร์นี้'}
  flushing=false;chip()}
async function gsLoad(){const r=await fetch(CFG.gsUrl+(CFG.gsUrl.includes('?')?'&':'?')+'action=load'),j=await r.json();if(!j.ok)throw new Error(j.error||'โหลดไม่สำเร็จ');
  if(!j.rows.length)return 0;
  for(const c of COLLS)S[c]={};for(const x of j.rows){if(S[x.coll])try{S[x.coll][x.id]=JSON.parse(x.json)}catch(e){}}
  saveLocal();return j.rows.length}
function pushAll(){for(const c of COLLS)for(const id of Object.keys(S[c]))QS.set(c+'/'+id,{coll:c,id});return flush()}
function chip(){const c=$('#storeChip');if(!c)return;c.textContent=CFG.gsUrl?(SYNC.msg||'เชื่อมต่อ Google Sheet แล้ว'):'เก็บในเบราว์เซอร์นี้ ยังไม่เชื่อมต่อ Google Sheet'}
function wErr(e){console.error(e);toast('บันทึกไม่สำเร็จ ลองอีกครั้ง')}
let rT;function schedule(){clearTimeout(rT);rT=setTimeout(render,60)}
async function init(){
  try{Object.assign(S,JSON.parse(localStorage.getItem('m3_state')||'{}'))}catch(e){}
  for(const c of COLLS)if(!S[c])S[c]={};
  render();
  if(CFG.gsUrl){SYNC.state='busy';SYNC.msg='กำลังดึงข้อมูลจาก Google Sheet…';chip();
    try{const n=await gsLoad();SYNC.state='ok';SYNC.msg='ดึงข้อมูลจาก Google Sheet แล้ว';if(!n&&!realEmpty())await pushAll();render()}
    catch(e){console.error(e);SYNC.state='err';SYNC.msg='เชื่อมต่อ Google Sheet ไม่ได้ กำลังใช้ข้อมูลในเบราว์เซอร์นี้';chip()}
    if(settings().hubAuto!==false&&hubSet().id)loadHub(true)}
}
