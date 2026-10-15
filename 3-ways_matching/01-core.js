/* ==========================================================================
 * MODULE 01  CORE
 * ค่าคงที่ ค่าเริ่มต้นของเกณฑ์ และฟังก์ชันพื้นฐาน (แปลงตัวเลข เทียบรหัส เทียบชื่อ)
 * ฟังก์ชัน: sim, num, kc, nk, isHalf, snap5, projOK, worst, memOf
 * ========================================================================== */
/*LOGIC*/
const num=v=>{if(typeof v==='number')return isFinite(v)?v:null;if(v==null||v==='')return null;const n=parseFloat(String(v).replace(/[,\s฿]/g,''));return isFinite(n)?n:null};
const kc=s=>String(s??'').toUpperCase().replace(/[^A-Z0-9ก-๙]/g,'');
const nk=s=>String(s??'').toLowerCase().replace(/[\s\-_.,/()#:"']/g,'');
function sim(a,b){a=nk(a);b=nk(b);if(!a||!b)return 0;if(a===b)return 1;if(a.length<2||b.length<2)return 0;
  const g=s=>{const m=new Map();for(let i=0;i<s.length-1;i++){const k=s.slice(i,i+2);m.set(k,(m.get(k)||0)+1)}return m};
  const A=g(a),B=g(b);let hit=0;for(const[k,v]of A)hit+=Math.min(v,B.get(k)||0);return 2*hit/(a.length-1+b.length-1)}
/* ส่วนลด % เป็นจำนวนเต็มหรือลงท้าย .50 เท่านั้น: isHalf ตรวจ, snap5 ปัดค่าที่คลาดจากเศษสตางค์ให้ลงตัว */
const isHalf=p=>p==null||Math.abs(p-Math.round(p*2)/2)<=0.06;
const snap5=p=>p!=null&&isHalf(p)?Math.round(p*2)/2:p;
const DEF={priceTol:0.01,vatRate:7,vatTol:0.10,buyerTaxId:'',poIncVat:false,promoVendor:'',promoProject:'MO',creditDays:30,vendorAlias:'YANMAR S.P. = บริษัท ยันม่าร์ เอส.พี. จำกัด',buyerNames:'RST, อาร์เอสที, รวมสินไทย, RUAMSINTHAI'};
const projOK=(v,want)=>!want||kc(v)===kc(want)||String(v||'').split(/[^A-Za-z0-9ก-๙]+/).some(t=>t&&kc(t)===kc(want));
const LV={ok:0,info:0,wait:1,warn:2,bad:3};
const worst=a=>a.reduce((m,x)=>LV[x]>LV[m]?x:m,'ok');
const EPS=1e-6;
/* ดัชนีต่อชุดข้อมูล D เก็บนอกตัว D เพื่อไม่ให้ติดไปกับ {...D} และคำนวณครั้งเดียวต่อการแสดงผล */
const CX=new WeakMap(),cx=D=>{let c=CX.get(D);if(!c){c={};CX.set(D,c)}return c},AGG=new WeakMap();
const memOf=D=>{const c=cx(D);return c.mem||(c.mem=new Set([...(D.dels||[]),...(D.invs||[])]))};
