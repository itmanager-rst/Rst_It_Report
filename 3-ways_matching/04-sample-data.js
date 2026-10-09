/* ==========================================================================
 * MODULE 04  SAMPLE DATA
 * ข้อมูลตัวอย่างที่แสดงเมื่อยังไม่มีข้อมูลจริง
 * ฟังก์ชัน: SAMPLE
 * ========================================================================== */
const SAMPLE=(()=>{const V='บริษัท ยันม่าร์ เอส.พี. จำกัด',T='0105500000018';
  const P=[['129150-35153','OIL FILTER ELEMENT','ไส้กรองน้ำมันเครื่อง',185],['119802-55801','FUEL FILTER','ไส้กรองน้ำมันเชื้อเพลิง',240],['129612-12560','AIR CLEANER ELEMENT','ไส้กรองอากาศ',520],['25132-004200','V-BELT FAN','สายพานพัดลม',310],['24421-354508','OIL SEAL','ซีลน้ำมัน',95],['1A8296-72100','ROTARY BLADE SET','ชุดใบมีดโรตารี่',1450],['24101-062054','BALL BEARING','ลูกปืน',160]];
  const sets=[{id:'s1',name:'โปรอะไหล่ PM ประจำปี FY2026',start:'2026-04-01',end:'2027-03-31',d:20,it:[0,1,2,3,4,5,6]},{id:'s2',name:'โปรไส้กรอง ไตรมาส 3',start:'2026-07-01',end:'2026-09-30',d:25,it:[0,1,2]},{id:'s3',name:'PRO_COMBINE',start:'2026-10-01',end:'2026-12-31',d:15,dcQ:1,it:[3,4,5,6]}];
  const oil={id:'s4',type:'price',name:'โปรโมชั่นน้ำมัน',start:'2026-08-01',end:'2026-12-31',count:1};
  const promos=sets.flatMap(S=>S.it.map(i=>({code:P[i][0],name:P[i][1],nameTh:P[i][2],mo:P[i][3]/0.8,...(x=>({disc:x,discBase:S.d,dcQ:S.dcQ||0,dcY:0,price:Math.round(P[i][3]/0.8*(100-x))/100}))(S.d+(S.dcQ||0)),brand:'Yanmar',ptype:i<3?'PM':'Other',setId:S.id,setName:S.name,start:S.start,end:S.end})));
  sets.forEach(S=>{S.count=S.it.length});
  promos.push({code:'OIL-15W40-18L',name:'ENGINE OIL 15W-40 18L',nameTh:'น้ำมันเครื่อง 15W-40 ถัง 18 ลิตร',mo:null,disc:null,price:1850,brand:'Yanmar',setId:oil.id,setName:oil.name,start:oil.start,end:oil.end});sets.push(oil);
  const L=(i,q,pr)=>({code:P[i][0],name:P[i][2],qty:q,price:pr??P[i][3]});
  const D=(l,x={})=>({code:l.code,name:l.name,qty:x.qty??l.qty,price:x.price===undefined?l.price:x.price,amount:(x.qty??l.qty)*((x.price===undefined?l.price:x.price)||0)});
  const inv=(docNo,poNo,lines,o={})=>{const sub=lines.reduce((s,l)=>s+l.amount,0),vat=o.vat??Math.round(sub*7)/100;return{docNo,date:'2026-09-22',vendor:V,vendorTaxId:T,buyerTaxId:'',poNo:o.noPo?'':poNo,refNo:o.ref||'',creditDays:30,dueDate:'2026-10-22',subtotal:sub,vat,total:sub+vat,lines}};
  const OL={code:'OIL-15W40-18L',name:'น้ำมันเครื่อง 15W-40 ถัง 18 ลิตร',qty:10,price:1850},p1=[L(0,40,173.44),L(1,30,225),L(2,12,487.5),L(3,20),OL],p2=[L(4,100),L(5,8,1520),L(6,60)],p3=[L(0,24),L(3,10)],p4=[L(2,6),{code:'TOOL-0091',name:'ประแจบล็อกชุด 24 ชิ้น',qty:2,price:890}];
  return{promos,sets,
    pos:[{poNo:'PO-2609-001',date:'2026-09-08',vendor:V,project:'MO',lines:p1},{poNo:'PO-2609-002',date:'2026-09-11',vendor:V,project:'MO',lines:p2},{poNo:'PO-2609-003',date:'2026-09-15',vendor:V,project:'MO',lines:p3},{poNo:'PO-2609-004',date:'2026-09-24',vendor:V,project:'งานซ่อมบำรุง',lines:p4}],
    dels:[{docNo:'DO-680915',date:'2026-09-15',vendor:V,poNo:'PO-2609-001',lines:p1.map(l=>D(l,{price:null}))},
      {docNo:'DO-680918',date:'2026-09-18',vendor:V,poNo:'PO-2609-002',lines:[D(p2[0],{qty:60,price:null}),D(p2[1],{price:null}),D(p2[2],{price:null})]},
      {docNo:'DO-680921',date:'2026-09-21',vendor:V,poNo:'PO-2609-003',lines:p3.map(l=>D(l,{price:null}))}],
    invs:[inv('IV-6809-0112','PO-2609-001',p1.map(l=>D(l)),{ref:'DO-680915',noPo:true}),
      inv('IV-6809-0127','PO-2609-002',[D(p2[0],{qty:60}),D(p2[1]),D(p2[2])],{ref:'DO-680918'}),
      inv('IV-6809-0140','PO-2609-003',[D(p3[0],{price:195}),D(p3[1])],{vat:560})],
    appr:{}}})();
