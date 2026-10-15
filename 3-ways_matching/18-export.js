/* ==========================================================================
 * MODULE 18  EXPORT + REPORT
 * ส่งออก Excel และส่งรายงานไป Google Sheet
 * ฟังก์ชัน: buildWB, exportX, report, stamp
 * ========================================================================== */
/* ---------- export ---------- */
function buildWB(){const D=DATA(),R=summary(D),wb=XLSX.utils.book_new();
  const add=(n,rows)=>XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows.length?rows:[{'ไม่มีข้อมูล':''}]),n);
  add('สรุป PO',R.pos.map(p=>({'เลขที่ PO':p.po.poNo,'ผู้จำหน่าย':p.po.vendor,'วันที่':p.po.date,'มูลค่า':p.total,'1 โปรโมชั่น':p.l1,'2 ส่งมอบ':p.l2,'3 ใบกำกับ':p.l3,'สรุป':p.label})));
  add('1 PO-โปรโมชั่น',R.r1.map(r=>({'โครงการ':r.project,PO:r.poNo,'วันที่ PO':r.date,'ผู้จำหน่าย':r.vendor,'โปรโมชั่นที่แนะนำ':r.promoSet,'รหัสสินค้า':r.code,'รายละเอียด':r.name,'จำนวน':r.qty,'ราคาตั้งใน PO':r.listPrice,'ราคาต่อหน่วยหลังหักส่วนลด':r.poPrice,'MO':r.mo,'ส่วนลดโปร %':r.disc,'NP_Promotion':r.promo,'ส่วนต่างต่อหน่วย':r.diff,'จ่ายเกินรวม':r.leak,'ผลตรวจ':r.label,'หมายเหตุ':r.note})));
  add('2 PO-ใบส่งสินค้า',R.r2.map(r=>({PO:r.poNo,'รหัสสินค้า':r.code,'รายละเอียด':r.name,'สั่งซื้อ':r.ord,'ใบส่งสินค้า':r.pk||0,'รับเข้า RE':r.re||0,'รับแล้ว (ใช้เทียบ)':r.del,'ค้างส่ง':r.out,'ราคา PO หลังหักส่วนลด':r.poPrice,'ราคาเทียบโปร':r.priceOk==='ok'?'ตรงโปรแล้ว':r.priceOk==='no'?'ยังไม่ตรงโปร':'','ราคาใบส่ง':r.docPrice,'ใบส่งสินค้า':r.docs.join(', '),'สถานะ':r.label})));
  add('3 สามทาง',R.r3.map(r=>({PO:r.poNo,'รหัสสินค้า':r.code,'รายละเอียด':r.name,'สั่งซื้อ':r.ord,'ใบส่งสินค้า':r.pk||0,'รับเข้า RE':r.re||0,'รับจริง (ใช้เทียบ)':r.del,'ใบกำกับ':r.inv,'ราคา PO หลังหักส่วนลด':r.poPrice,'ราคา_RE':r.rePrice??'','ราคาเทียบโปร':r.priceOk==='ok'?'ตรงโปรแล้ว':r.priceOk==='no'?'ยังไม่ตรงโปร':'','ราคาใบกำกับ':r.invPrice,'ใบกำกับภาษี':r.docs.join(', '),'ผลตรวจ':r.label})));
  add('คลังโปรโมชั่น',D.promos.map(p=>({'โปรโมชั่น':p.setName,'Part Type':p.ptype||'','รหัสสินค้า':p.code,'ชื่อสินค้า':p.name,'ชื่อภาษาไทย':p.nameTh,'ยี่ห้อ':p.brand,'MO':p.mo,'ส่วนลดโปร %':p.discBase,'DC:Quarter %':p.dcQ||0,'DC:Yearly %':p.dcY||0,'ส่วนลดพิเศษ %':p.dcS||0,'ส่วนลดรวม %':p.disc,'NP_Promotion':p.price,'เริ่มโปรโมชั่น':p.start||'','สิ้นสุดโปรโมชั่น':p.end||''})));
  add('ส่วนลดชดเชย',R.pos.filter(x=>x.comp.due>0||x.comp.list.some(k=>k.disc||Math.abs(k.comp)>0.5)).flatMap(x=>(x.comp.list.length?x.comp.list:[null]).map(k=>({PO:x.po.poNo,'ผู้จำหน่าย':x.po.vendor,'ใบกำกับภาษี':k?k.inv.docNo:'','ยอดตามราคาในใบกำกับ':k?k.gross:'','ส่วนลดท้ายใบกำกับ':k?k.disc:'','ส่วนลดตามใบสั่งซื้อ':k?k.poDisc:'','ส่วนลดชดเชยใบนี้':k?k.comp:'','ส่วนลดทั้งหมด %':k?invBreak(D,k.inv).pct:'','ที่มาของส่วนลด':k?invBreak(D,k.inv).parts.map(z=>z.label+' '+z.pct+'% ('+z.amt+')').join(' + '):'','ควรได้ชดเชยทั้ง PO':x.comp.due,'ได้รับแล้วทั้ง PO':x.comp.got,'ยังไม่ครบ':x.comp.out}))));
  add('ตรวจใบกำกับ',D.invs.flatMap(i=>invChecks(D,i).map(k=>({'ใบกำกับ':i.docNo,PO:i.poNo,'ผล':k.ok?'ผ่าน':'ไม่ผ่าน','รายการตรวจ':k.label}))));
  add('ข้อมูล PO',D.pos.flatMap(p=>(p.lines||[]).map(l=>({'เลขที่ PO':p.poNo,'วันที่':p.date,'ผู้จำหน่าย':p.vendor,'โครงการ':l.project||p.project||'','รหัสสินค้า':l.code,'รายละเอียด':l.name,'จำนวน':l.qty,'ราคาต่อหน่วย':l.price,'ราคาต่อหน่วยหลังหักส่วนลด':l.net??l.price}))));
  const dl=(arr)=>arr.flatMap(d=>(d.lines||[]).map(l=>({'เลขที่เอกสาร':d.docNo,'วันที่':d.date,'ผู้ขาย':d.vendor,'อ้างอิง PO':d.poNo,'เอกสารอ้างอิง':d.refNo||'','PO อ้างอิงรายบรรทัด':l.ref||'','PO ที่จับคู่ได้':(linePO(D,l,docPO(D,d))||{}).poNo||'','เครดิต (วัน)':d.creditDays??'','วันครบกำหนด':d.dueDate||'','รหัสสินค้า':l.code,'รายละเอียด':l.name,'จำนวน':l.qty,'ราคาต่อหน่วย':l.price,'ยอดรายการ':l.amount,'ส่วนลดท้ายใบกำกับ':d.discount??'','ยอดก่อนภาษี':d.subtotal??'','ภาษี':d.vat??'','ยอดรวม':d.total??''})));
  add('ข้อมูลใบส่งสินค้า',dl(D.dels));add('ข้อมูลใบกำกับ',dl(D.invs));
  add('การอนุมัติ',Object.entries(D.appr||{}).map(([k,a])=>({PO:(S.pos[k]||{}).poNo||k,'ประเภท':a.kind==='ready'?'อนุมัติจ่าย':'อนุมัติข้อยกเว้น','เหตุผล':a.note||'','ผู้อนุมัติ':NAMES[a.by]||'','เวลา':a.at||''})));
  return wb}
const stamp=()=>new Date(Date.now()+7*36e5).toISOString().slice(0,16).replace('T',' ').replace(':','');
function exportX(){try{XLSX.writeFile(buildWB(),'RST-3way-matching-'+stamp().slice(0,10)+'.xlsx')}catch(e){console.error(e);toast('ส่งออกไม่สำเร็จ')}}
async function report(){if(!CFG.gsUrl)return toast('เชื่อมต่อ Google Sheet ที่แท็บ “ตั้งค่า” ก่อน');if(isDemo())return toast('นี่คือข้อมูลตัวอย่าง นำเข้าข้อมูลจริงก่อน');
  const wb=buildWB(),sheets={};for(const n of wb.SheetNames)sheets[n]=XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,defval:''});
  SYNC.msg='กำลังส่งรายงานไป Google Sheet…';chip();
  try{await gsPost({action:'report',sheets});SYNC.msg='ส่งรายงานไป Google Sheet แล้ว '+new Date().toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});toast('อัปเดตแท็บรายงานใน Google Sheet แล้ว')}
  catch(e){console.error(e);SYNC.msg='ส่งรายงานไม่สำเร็จ';toast('ส่งรายงานไป Google Sheet ไม่สำเร็จ ตรวจ URL และการ Deploy')}
  chip()}
