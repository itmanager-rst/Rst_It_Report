/* ==========================================================================
 * MODULE 16  PDF / SCAN READER
 * อ่าน PDF และไฟล์สแกนด้วยข้อความในไฟล์ OCR หรือ Claude API
 * ฟังก์ชัน: loadScript, pdfLib, filePages, ocr, aiRead, scan, isPdf, b64, PROMPT
 * ========================================================================== */
/* ---------- reading PDF / scans ---------- */
function loadScript(src){return new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>no(new Error('โหลดไม่ได้: '+src));document.head.appendChild(s)})}
async function pdfLib(){if(!window.pdfjsLib){const b='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';await loadScript(b+'pdf.min.js');pdfjsLib.GlobalWorkerOptions.workerSrc=b+'pdf.worker.min.js'}return pdfjsLib}
const isPdf=f=>f.type==='application/pdf'||/\.pdf$/i.test(f.name);
async function filePages(file){
  if(isPdf(file)){const lib=await pdfLib(),pdf=await lib.getDocument({data:await file.arrayBuffer()}).promise,out=[];
    for(let p=1;p<=pdf.numPages;p++){const pg=await pdf.getPage(p);
      let text='';try{const tc=await pg.getTextContent(),ln=new Map();for(const it of tc.items){if(!it.str||!it.str.trim())continue;const y=Math.round(it.transform[5]/4);if(!ln.has(y))ln.set(y,[]);ln.get(y).push(it)}
        text=[...ln.entries()].sort((a,b)=>b[0]-a[0]).map(e=>e[1].sort((a,b)=>a.transform[4]-b.transform[4]).map(i=>i.str).join('  ')).join('\n')}catch(e){}
      out.push({text,render:async()=>{const v0=pg.getViewport({scale:1}),vp=pg.getViewport({scale:2200/v0.width}),c=document.createElement('canvas');c.width=vp.width;c.height=vp.height;const cx=c.getContext('2d');cx.fillStyle='#fff';cx.fillRect(0,0,c.width,c.height);await pg.render({canvasContext:cx,viewport:vp}).promise;return c}})}
    return out}
  return[{text:'',render:async()=>{const bmp=await createImageBitmap(file,{imageOrientation:'from-image'}).catch(()=>createImageBitmap(file));const sc=Math.min(1,2600/bmp.width),c=document.createElement('canvas');c.width=bmp.width*sc;c.height=bmp.height*sc;c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return c}}]}
let ocrW=null;
async function ocr(canvas,label){if(!window.Tesseract)await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  if(!ocrW)ocrW=await Tesseract.createWorker(['tha','eng'],1,{logger:m=>{if(m.status==='recognizing text'){BUSY=label+' '+Math.round(m.progress*100)+'%';const c=document.querySelector('.row .chip');if(c)c.textContent=BUSY}}});
  const r=await ocrW.recognize(canvas);return r.data.text||''}
const b64=buf=>{let s='';const u=new Uint8Array(buf);for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));return btoa(s)};
const PROMPT=kind=>`You are reading a Thai procurement document for an accounts-payable check. The document is a ${kind==='inv'?'tax invoice (ใบกำกับภาษี)':'delivery note / packing list (ใบส่งสินค้า / packing attached list)'}. All attached files are pages of the same document.
Transcribe exactly what is printed. Never guess, never correct, never compute a value that is not printed. Copy item codes character by character (watch 0/O, 1/I, 5/S, 8/B). If a character or number is unclear, give your best reading and set "unsure": true on that line. Use null for anything not printed.
Numbers: plain numbers without thousands separators. Dates: YYYY-MM-DD in the Gregorian calendar (subtract 543 from a Buddhist-era year).
Reply with only one JSON object in this shape:
{"docNo":string|null,"date":string|null,"vendor":string|null,"vendorTaxId":string|null,"buyerTaxId":string|null,"poNo":string|null,"refNo":string|null,"creditDays":number|null,"dueDate":string|null,"lines":[{"ref":string|null,"code":string|null,"name":string|null,"qty":number|null,"unit":string|null,"price":number|null,"disc":number|null,"amount":number|null,"unsure":boolean}],"discount":number|null,"subtotal":number|null,"vat":number|null,"total":number|null}
"docNo" is this document's own number: for a tax invoice the tax-invoice number (เลขที่ใบกำกับภาษี, เลขที่, Invoice No., Tax Invoice No.; it usually begins with IV or INV, and may be printed above or beside its label), never a purchase-order number, a delivery-note number or a tax ID. "vendor" is the seller who issued the document, the company on the letterhead or named as ผู้ขาย / ผู้ออกใบกำกับภาษี, never the customer the document is addressed to. "poNo" is the buyer's purchase-order number the document refers to (PO No., เลขที่ใบสั่งซื้อ, อ้างอิง). "refNo" is any other reference number or reference document printed on it (เลขที่อ้างอิง, เอกสารอ้างอิง, Ref. No., delivery note / D/O number, ใบส่งสินค้าเลขที่). On a tax invoice, when a delivery-order number is printed (D/O No., เลขที่ใบส่งสินค้า), use it as "refNo". Each line's "disc" is the discount percent printed on that row, null when none; "amount" stays the row amount as printed. "creditDays" is the credit term in days wherever the document prints it (เครดิต 30 วัน, เงื่อนไขการชำระเงิน, Credit term, Terms of payment, Payment term "30 Days"); 0 for cash (เงินสด / Cash). "dueDate" is the payment due date (วันครบกำหนด, วันครบกำหนดชำระ, Due date). "vendor" is the issuing company exactly as printed on the letterhead or logo (for example "YANMAR S.P."). Each line's "ref" is that row's customer purchase-order reference: on a packing attached sheet with a "Customer P/O No." column that prints two lines per row, use the LOWER line; null when the row has none. When every row carries the same reference, also put it in "refNo". "price" is the unit price before VAT, "amount" the line amount. "discount" is the total trade discount amount printed below the item table (ส่วนลด, ส่วนลดการค้า, หักส่วนลด, Discount), as a positive number, null when none. "subtotal" is the amount after that discount and before VAT, "vat" the VAT amount, "total" the grand total. Include every item row of every page, each exactly once.`;
async function aiRead(kind,files,signal){const content=[];
  for(const f of files){if(isPdf(f))content.push({type:'document',source:{type:'base64',media_type:'application/pdf',data:b64(await f.arrayBuffer())}});
    else{const c=await(await filePages(f))[0].render(),blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.92));content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64(await blob.arrayBuffer())}})}}
  content.push({type:'text',text:PROMPT(kind)+'\n\nIMPORTANT: this file may contain SEVERAL separate documents, each with its own document number. Reply with ONE JSON object {"documents":[...]} where every element has exactly the shape described above. A document that continues over several pages is ONE element. Never merge rows of different documents.'});
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',signal,headers:{'content-type':'application/json','x-api-key':CFG.aiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:CFG.aiModel||'claude-sonnet-5-5',max_tokens:32000,messages:[{role:'user',content}]})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw{code:r.status===401?'bad_key':'api',message:(j.error&&j.error.message)||('HTTP '+r.status)};
  const t=(j.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(''),a=t.indexOf('{'),z=t.lastIndexOf('}');
  if(a<0||z<0)throw{code:'invalid_json'};
  const o0=JSON.parse(t.slice(a,z+1));
  return(Array.isArray(o0.documents)&&o0.documents.length?o0.documents:[o0]).map(o=>({docNo:o.docNo,date:o.date,vendor:o.vendor,vendorTaxId:o.vendorTaxId,buyerTaxId:o.buyerTaxId,poNo:o.poNo,refNo:o.refNo,creditDays:num(o.creditDays),dueDate:o.dueDate,discount:num(o.discount),subtotal:num(o.subtotal),vat:num(o.vat),total:num(o.total),
    lines:(o.lines||[]).map(l=>({ref:l.ref?String(l.ref):'',code:l.code||'',name:l.name||'',qty:num(l.qty),price:num(l.price),disc:num(l.disc),amount:num(l.amount),unsure:!!l.unsure}))}))}
async function scan(kind,files){
  abortCtl=new AbortController();const D=DATA();
  try{
    if(CFG.aiKey){BUSY='Claude กำลังอ่านเอกสาร (ราว 20–60 วินาที)';render();const ds=await aiRead(kind,files,abortCtl.signal);
      PEND=ds.map((doc,gi)=>({doc,warns:ds.length>1?['ไฟล์นี้มี '+ds.length+' เอกสาร ใบนี้คือใบที่ '+(gi+1)+' ตรวจว่ารายการครบและไม่ปนกับใบอื่น']:[]}))}
    else{BUSY='กำลังเตรียมไฟล์…';render();const pt=[];let usedOcr=false;
      for(const f of files){const pages=await filePages(f);
        for(let i=0;i<pages.length;i++){if(abortCtl.signal.aborted)throw{code:'cancelled'};
          if(pages[i].text.replace(/\s/g,'').length>60)pt.push(pages[i].text);
          else{usedOcr=true;BUSY='OCR หน้า '+(i+1)+'/'+pages.length;render();pt.push(await ocr(await pages[i].render(),'OCR หน้า '+(i+1)+'/'+pages.length))}}}
      const groups=splitDocs(pt.map(t=>({docNo:parseDocText(D,t,kind).docNo||null,text:t})));
      PEND=groups.map((g,gi)=>{const doc=parseDocText(D,g.pages.map(x=>x.text).join('\n'),kind),warns=[];
        if(groups.length>1)warns.push('ไฟล์นี้มี '+groups.length+' เอกสาร ระบบแยกตามเลขที่เอกสารของแต่ละหน้า ใบนี้คือใบที่ '+(gi+1)+' ('+g.pages.length+' หน้า) ตรวจว่ารายการครบและไม่ปนกับใบอื่น');
        warns.push(usedOcr?'อ่านจากไฟล์สแกนด้วย OCR ในเครื่อง ตัวเลขและรหัสอาจคลาดเคลื่อน เทียบกับเอกสารจริงทุกบรรทัด':'อ่านจากข้อความในไฟล์ PDF ระบบดึงเฉพาะบรรทัดที่พบรหัสสินค้าของ PO ตรวจว่าครบทุกรายการ');
        if(!doc.lines.length)warns.push('ไม่พบรหัสสินค้าที่ตรงกับ PO ในระบบ กรอกรายการเอง หรือใช้ Claude API key เพื่ออ่านเอกสารนี้');
        return{doc,warns}})}}
  catch(e){console.error(e);const c=e&&(e.code||e.name);toast(c==='cancelled'||c==='AbortError'?'หยุดการอ่านแล้ว':c==='bad_key'?'Claude API key ไม่ถูกต้อง ตรวจที่แท็บ “ตั้งค่า”':c==='invalid_json'?'อ่านเอกสารไม่สำเร็จ ลองสแกนให้ชัดขึ้น':'อ่านไฟล์ไม่สำเร็จ: '+((e&&e.message)||''))}
  finally{BUSY=null;abortCtl=null;render()}}
