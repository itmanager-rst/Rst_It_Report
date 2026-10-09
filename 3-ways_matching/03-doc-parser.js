/* ==========================================================================
 * MODULE 03  DOCUMENT TEXT PARSER
 * แยกข้อมูลจากข้อความของ PDF/OCR เป็นหัวเอกสารและรายการสินค้า (ตัวอ่านในเครื่อง)
 * ฟังก์ชัน: parseDocText, lastNum
 * ========================================================================== */
const NUMRE=/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
const lastNum=l=>{const m=l.match(NUMRE);return m?num(m[m.length-1]):null};
function parseDocText(D,text,kind){
  const lines=String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean),T=kc(text);
  const doc={docNo:null,date:null,vendor:null,vendorTaxId:null,buyerTaxId:null,poNo:null,lines:[],subtotal:null,vat:null,total:null};
  const hits=D.pos.filter(p=>kc(p.poNo).length>=4&&T.includes(kc(p.poNo))).sort((a,b)=>kc(b.poNo).length-kc(a.poNo).length);
  if(hits.length===1){doc.poNo=hits[0].poNo}
  {const head=lines.slice(0,14).join(' '),v=vendorName(D,head),mine=String(D.set.buyerNames||'').split(',').map(nk).filter(Boolean);
    const CO=/(บริษัท\s*[^\n]{2,60}?จำกัด(?:\s*\(มหาชน\))?|ห้างหุ้นส่วน(?:จำกัด)?\s*[^\n]{2,40}|[A-Z][A-Z0-9&.,'\- ]{2,50}?(?:CO\.?,?\s*LTD\.?|COMPANY\s+LIMITED|LIMITED|CORPORATION|CORP\.|INC\.))/i;
    let nm='';for(const ln of lines.slice(0,25)){if(/ลูกค้า|ผู้ซื้อ|customer|sold\s*to|bill\s*to|ship\s*to|ส่งถึง|ที่อยู่จัดส่ง/i.test(ln))continue;const m=ln.match(CO);if(m&&!mine.some(x=>nk(m[1]).includes(x))){nm=m[1].trim();break}}
    doc.vendor=v!==head?v:nm?vendorName(D,nm):null}
  const poKeys=hits.map(p=>[kc(p.poNo),p.poNo]);
  const codes=new Map();for(const p of(hits.length?hits:D.pos))for(const l of p.lines||[]){const k=kc(l.code);if(k.length>=4&&!codes.has(k))codes.set(k,l)}
  const keys=[...codes.keys()].sort((a,b)=>b.length-a.length);
  const triple=n=>{for(let k=n.length-1;k>=2;k--)for(let j=k-1;j>=1;j--)for(let i=j-1;i>=0;i--)if(n[i]>0&&n[j]>0&&Math.abs(n[i]*n[j]-n[k])<=Math.max(0.05,n[k]*0.0005))return[n[i],n[j],n[k]];return null};
  for(let li=0;li<lines.length;li++){const ln=lines[li],K=kc(ln),K2=K+'|'+kc(lines[li+1]||''),pr=poKeys.find(x=>K2.includes(x[0])),lref=pr?pr[1]:'';let hit=null;for(const k of keys)if(K.includes(k)){hit=k;break}
    if(hit){const ref=codes.get(hit),re=new RegExp(hit.split('').map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s\\-./_]*'),'i'),m=ln.match(re);
      const rest=m?ln.slice(m.index+m[0].length):ln,ns=(rest.match(NUMRE)||[]).map(num).filter(x=>x!=null),t=triple(ns);
      const nm=(rest.split(/\s-?\d[\d,]*(?:\.\d+)?(?:\s|$)/)[0]||'').trim();
      let qty=null,price=null,amount=null,unsure=false;
      if(t){[qty,price,amount]=t}else if(ns.length){qty=ns.includes(ref.qty)?ref.qty:ns[0];unsure=!ns.includes(ref.qty);if(kind==='inv')unsure=true}else unsure=true;
      doc.lines.push({ref:lref,code:ref.code,name:nm.length>2?nm:ref.name,qty,price,amount,unsure});continue}
    const cm=ln.match(/\b(?=[A-Z0-9\-\/]*\d)[A-Z0-9]{2,}(?:[\-\/][A-Z0-9]+)+\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\b/i);
    if(cm){const rest=ln.slice(cm.index+cm[0].length),ns=(rest.match(NUMRE)||[]).map(num).filter(x=>x!=null),t=triple(ns);
      if(t){const nm=(rest.split(/\s-?\d[\d,]*(?:\.\d+)?(?:\s|$)/)[0]||'').trim();doc.lines.push({code:cm[0],name:nm,qty:t[0],price:t[1],amount:t[2],unsure:true})}}}
  {const TOK='([A-Z0-9][A-Z0-9\\-\\/]{2,})',bad=x=>!/\d/.test(x)||/^\d{13}$/.test(x.replace(/\D/g,''))&&x.replace(/\D/g,'').length===13||kc(x)===kc(doc.poNo)||D.pos.some(p=>kc(p.poNo)===kc(x))||(kind==='inv'&&D.dels.some(q=>kc(q.docNo)===kc(x)));
    const pats=kind==='inv'?['(?:เลขที่\\s*ใบกำกับ(?:ภาษี)?|ใบกำกับ(?:ภาษี)?\\s*เลขที่|Tax\\s*Invoice\\s*(?:No|Number|#)\\.?|Invoice\\s*(?:No|Number|#)\\.?|INV\\.?\\s*(?:No|#)\\.?)']:['(?:เลขที่ใบส่ง(?:สินค้า|ของ)?|ใบส่งสินค้า\\s*เลขที่|Packing\\s*(?:List|Sheet)?\\s*No\\.?|Delivery\\s*(?:Order|Note)?\\s*No\\.?|D\\/?O\\.?\\s*No\\.?)'];
    pats.push('(?:เลขที่เอกสาร|Doc(?:ument)?\\.?\\s*No\\.?)','(?:เลขที่|No\\.)');
    if(kind==='inv'){const re=/(?<![A-Z0-9])(?:INV|IV)[A-Z]{0,3}[\-\/ ]?\d[A-Z0-9\-\/]{2,}/ig;let m;while((m=re.exec(text))){const v=m[0].replace(/\s/g,'');if(!bad(v)){doc.docNo=v;break}}}
    if(!doc.docNo)for(const pt of pats){const re=new RegExp(pt+'\\s*[:.#\\-]?\\s*'+TOK,'ig');let m,got=null;
      while((m=re.exec(text))){const pre=text.slice(Math.max(0,m.index-14),m.index);if(/สั่งซื้อ|P\/?O|ประจำตัว|ผู้เสียภาษี|อ้างอิง|Ref|Tax\s*ID/i.test(pre+m[0].slice(0,m[0].length-m[1].length)))continue;if(!bad(m[1])){got=m[1];break}}
      if(got){doc.docNo=got;break}}}
  {const re=/(วันที่|Date)\s*[:.]?\s*([^\n]{0,26})/ig;let m;while((m=re.exec(text))){if(/ครบกำหนด|ส่งของ|สั่งซื้อ/.test(m[2].slice(0,12))||/(ครบกำหนด|Due|P\/?O|Delivery)\s*$/i.test(text.slice(Math.max(0,m.index-12),m.index)))continue;const v=dateIn(m[2]);if(v){doc.date=v;break}}
    if(!doc.date)doc.date=dateIn(text)||null}
  const ids=[...new Set((text.match(/\d(?:[ \-]?\d){12}(?!\d)/g)||[]).map(x=>x.replace(/\D/g,'')))],mine=String(D.set.buyerTaxId||'').replace(/\D/g,'');
  if(mine&&ids.includes(mine))doc.buyerTaxId=mine;doc.vendorTaxId=ids.find(x=>x!==mine)||null;
  const toIso=m=>{let y=+m[3];if(y<100)y+=y>=43?2500:2000;if(y>2400)y-=543;return y+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0')};
  doc.refNo=null;doc.creditDays=null;doc.dueDate=null;
  const kd=D.dels.filter(x=>kc(x.docNo).length>=4&&T.includes(kc(x.docNo)))[0];
  const dom=text.match(/(?:\bD\s*\/\s*O\b|\bDO\b|Delivery\s*(?:Order|Note)|เลขที่\s*ใบส่ง(?:สินค้า|ของ)|ใบส่ง(?:สินค้า|ของ)\s*เลขที่)\.?\s*(?:No\.?|Number|เลขที่)?\s*[:.#\-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i);
  const rm=text.match(/(?:เลขที่อ้างอิง|เอกสารอ้างอิง|อ้างอิง|Ref(?:erence)?\.?\s*(?:No\.?|Doc\.?)?)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i);
  const okRef=x=>x&&/\d/.test(x)&&kc(x)!==kc(doc.poNo)&&kc(x)!==kc(doc.docNo);
  if(kind==='inv'&&dom&&okRef(dom[1]))doc.refNo=dom[1];else if(kd)doc.refNo=kd.docNo;else if(rm&&okRef(rm[1]))doc.refNo=rm[1];
  for(const ln of lines){const ci=ln.search(/เครดิต|credit/i);if(ci<0)continue;const tail=ln.slice(ci).replace(/^(เครดิต|credit)\s*(term|เทอม)?/i,'');
    const m=tail.match(/^[^\d\n]{0,25}?(\d{1,3})(?![\d\/\-.])/);if(m&&+m[1]<=365){doc.creditDays=+m[1];break}
    if(/เงินสด|cash/i.test(tail)){doc.creditDays=0;break}}
  if(doc.creditDays==null)for(const ln of lines){if(!/เครดิต|credit|เงื่อนไข(?:การ)?ชำระ|การชำระเงิน|payment|terms?\b/i.test(ln))continue;
    const tail=ln.slice(ln.search(/เครดิต|credit|เงื่อนไข(?:การ)?ชำระ|การชำระเงิน|payment|terms?\b/i));
    const m=tail.match(/(\d{1,3})\s*(?:วัน|days?|d\b)/i)||tail.match(/[:.]\s*(\d{1,3})(?!\s*[\/\-.]\d)(?!\d)/);
    if(m&&+m[1]<=365){doc.creditDays=+m[1];break}
    if(/เงินสด|cash/i.test(tail)){doc.creditDays=0;break}}
  {const du=text.match(/(?:วันที่?\s*ครบกำหนด(?:ชำระ(?:เงิน)?)?|ครบกำหนด(?:ชำระ(?:เงิน)?)?|Due\s*Date|Payment\s*Due(?:\s*Date)?)\s*[:.]?\s*([^\n]{0,26})/i);if(du)doc.dueDate=dateIn(du[1])||null}
  doc.discount=null;let aft=false;
  if(kind==='inv')for(const ln of lines){
    if(/หลังหักส่วนลด|หลังส่วนลด|after\s*discount/i.test(ln)){const v=lastNum(ln);if(v!=null){doc.subtotal=v;aft=true}}
    else if(/ส่วนลด|discount/i.test(ln)){const v=lastNum(ln.replace(/\d+(?:\.\d+)?\s*%/g,''));if(v!=null&&v>0)doc.discount=v}
    else if(/ภาษีมูลค่าเพิ่ม|VAT|V\.A\.T/i.test(ln)&&!/ก่อนภาษี|ไม่รวมภาษี|เลขประจำตัว|TAX\s*ID/i.test(ln)){const v=lastNum(ln.replace(/\d+(?:\.\d+)?\s*%/,''));if(v!=null)doc.vat=v}
    else if(/รวมทั้งสิ้น|ยอดสุทธิ|จำนวนเงินรวมทั้งสิ้น|GRAND\s*TOTAL|NET\s*TOTAL|TOTAL\s*AMOUNT/i.test(ln)){const v=lastNum(ln);if(v!=null)doc.total=v}
    else if(/รวมเป็นเงิน|รวมเงิน|มูลค่าสินค้า|ก่อนภาษี|ไม่รวมภาษี|SUB\s*TOTAL/i.test(ln)){const v=lastNum(ln);if(v!=null&&!aft)doc.subtotal=v}}
  return doc}
