/* ==========================================================================
 * MODULE 14  VIEW: ตั้งค่า
 * เกณฑ์การตรวจ Google Sheet ผู้ดูแลระบบ และการอ่านเอกสาร
 * ฟังก์ชัน: vSettings
 * ========================================================================== */
function vSettings(D){const s=D.set;
  return `<div class="grid2"><section class="card"><h2>เกณฑ์การตรวจ</h2>
  <div class="fgrid">
    <label class="f">ราคาคลาดเคลื่อนได้ (บาท/หน่วย)<input id="s_priceTol" type="number" step="0.01" value="${s.priceTol}"></label>
    <label class="f">อัตราภาษีมูลค่าเพิ่ม (%)<input id="s_vatRate" type="number" step="0.01" value="${s.vatRate}"></label>
    <label class="f">ภาษีปัดเศษต่างได้ (บาท)<input id="s_vatTol" type="number" step="0.01" value="${s.vatTol}"></label>
    <label class="f">เลขผู้เสียภาษีของบริษัท (ผู้ซื้อ)<input id="s_buyerTaxId" value="${esc(s.buyerTaxId)}" placeholder="13 หลัก"></label>
    <label class="f">เทียบโปรเฉพาะผู้ขายที่ชื่อมีคำว่า (ว่าง = ทุกผู้ขาย)<input id="s_promoVendor" value="${esc(s.promoVendor)}"></label>
    <label class="f">เทียบโปรเฉพาะโครงการ<input id="s_promoProject" value="${esc(s.promoProject)}"></label>
    <label class="f" style="grid-column:1/-1">ชื่อผู้ขายบนเอกสาร = ชื่อผู้ขายในระบบ (บรรทัดละคู่)<textarea id="s_vendorAlias" rows="3" style="font:inherit;font-size:13px;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 8px">${esc(s.vendorAlias||'')}</textarea></label>
    <label class="f" style="grid-column:1/-1">คำในชื่อบริษัทของเรา (ผู้ซื้อ) คั่นด้วยจุลภาค ใช้แยกชื่อผู้ขายออกจากชื่อผู้ซื้อบนเอกสาร<input id="s_buyerNames" value="${esc(s.buyerNames||'')}"></label>
    <label class="f">ราคาใน PO<select id="s_poIncVat"><option value="0" ${s.poIncVat?'':'selected'}>ก่อน VAT</option><option value="1" ${s.poIncVat?'selected':''}>รวม VAT แล้ว</option></select></label>
  </div><div class="row" data-w><button class="pri" data-act="saveSet">บันทึกเกณฑ์</button></div>
  <p class="hint">ถ้าใส่เลขผู้เสียภาษีของบริษัท ระบบจะตรวจว่าใบกำกับออกในชื่อบริษัทถูกต้อง เงื่อนไขผู้ขายและโครงการใช้กับขั้น ① เท่านั้น เว้นว่างถ้าต้องการเทียบทุกรายการ</p></section>
  <section class="card"><h2>เชื่อมต่อ Google Sheet</h2>
  <p>ข้อมูลถูกเก็บในเบราว์เซอร์นี้เสมอ เมื่อใส่ URL ของ Apps Script ทุกการบันทึกจะถูกส่งไป Google Sheet และทุกครั้งที่เปิดหน้าจะดึงข้อมูลล่าสุดจาก Sheet ทุกคนที่ใช้ URL เดียวกันจึงเห็นข้อมูลชุดเดียวกัน</p>
  <div class="fgrid"><label class="f" style="grid-column:1/-1">URL ของ Apps Script Web App<input id="c_gsUrl" value="${esc(CFG.gsUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
  <label class="f">ชื่อผู้ใช้งาน (แสดงในการอนุมัติ)<input id="c_userName" value="${esc(CFG.userName)}"></label></div>
  <div class="row"><button class="pri" data-act="saveCfg">บันทึกการเชื่อมต่อ</button><button data-act="gsPull" ${CFG.gsUrl?'':'disabled'}>ดึงข้อมูลจาก Sheet</button><button data-act="gsPush" ${CFG.gsUrl?'':'disabled'}>ส่งข้อมูลทั้งหมดไป Sheet</button><button data-act="sheet" ${CFG.gsUrl?'':'disabled'}>ส่งรายงานไป Sheet</button></div>
  <ol class="todo"><li>สร้าง Google Sheet ใหม่ เปิดเมนู Extensions แล้วเลือก Apps Script</li><li>ลบโค้ดเดิม วางโค้ดด้านล่าง แล้วกด Save</li><li>กด Deploy เลือก New deployment ชนิด Web app ตั้ง Execute as เป็น Me และ Who has access เป็น Anyone</li><li>คัดลอก URL ที่ลงท้ายด้วย /exec มาวางในช่องด้านบน แล้วกดบันทึกการเชื่อมต่อ</li></ol>
  <textarea id="gasCode" readonly rows="8" style="width:100%;font-family:var(--mono);font-size:11.5px;background:var(--soft);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px" aria-label="โค้ด Apps Script"></textarea>
  <div class="row"><button data-act="copyGas">คัดลอกโค้ด Apps Script</button></div>
  <p class="hint">แท็บ DB ใน Sheet เป็นข้อมูลของระบบ ห้ามแก้ไขด้วยมือ ส่วนแท็บรายงานอ่านได้ตามปกติและถูกเขียนทับทุกครั้งที่ส่งรายงาน</p></section>
  <section class="card"><h2>ผู้ดูแลระบบ</h2>
  <p>ผู้ดูแลระบบแก้ไข MO ส่วนลดโปร และ NP_Promotion รายบรรทัดในคลังโปรโมชั่นได้ ${settings().adminPin?(isAdmin?'ตอนนี้คุณอยู่ในโหมดผู้ดูแลระบบ':'ใส่รหัสผู้ดูแลเพื่อเข้าโหมดผู้ดูแลระบบ'):'ยังไม่ได้ตั้งรหัสผู้ดูแล ทุกคนจึงแก้ไขได้ ตั้งรหัสเพื่อจำกัดสิทธิ์'}</p>
  <div class="row"><input id="adminPin" type="password" placeholder="${isAdmin?'ตั้งรหัสผู้ดูแลใหม่':'รหัสผู้ดูแล'}" autocomplete="off" style="width:200px" aria-label="รหัสผู้ดูแล">${isAdmin?'<button class="pri" data-act="adminSet">ตั้งรหัสผู้ดูแล</button>'+(settings().adminPin?'<button data-act="adminOut">ออกจากโหมดผู้ดูแล</button>':''):'<button class="pri" data-act="adminIn">เข้าโหมดผู้ดูแล</button>'}</div>
  <p class="hint">รหัสนี้กันการแก้ไขโดยไม่ตั้งใจ ไม่ใช่ระบบรักษาความปลอดภัยเต็มรูปแบบ ผู้ที่เข้าถึง Google Sheet ได้ยังแก้ข้อมูลได้โดยตรง</p></section>
  <section class="card"><h2>การอ่านไฟล์ PDF และไฟล์สแกน</h2>
  <p>ไม่ใส่ key ระบบใช้ตัวอ่านในเครื่อง: PDF ที่พิมพ์จากระบบอ่านได้ดี ส่วนไฟล์สแกนใช้ OCR ซึ่งต้องตรวจทานมากกว่า ใส่ Claude API key เพื่อให้ Claude อ่านเอกสารโดยตรง ซึ่งแม่นยำกว่ามากกับไฟล์สแกนและตารางภาษาไทย</p>
  <div class="fgrid"><label class="f">Claude API key<input id="c_aiKey" type="password" value="${esc(CFG.aiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
  <label class="f">รุ่นโมเดล<input id="c_aiModel" value="${esc(CFG.aiModel)}"></label></div>
  <div class="row"><button class="pri" data-act="saveCfg">บันทึก</button></div>
  <p class="hint">key ถูกเก็บในเบราว์เซอร์เครื่องนี้เท่านั้น ไม่ถูกส่งไป Google Sheet และไม่อยู่ในไฟล์ HTML การอ่านเอกสารคิดค่าใช้จ่ายตามการใช้งาน API ของบัญชีเจ้าของ key</p></section>
  <section class="card"><h2>RST GROUP Data Hub</h2>
  <p>หน้านี้อ่านใบสั่งซื้อ (แท็บ PO_LINES) และเอกสารรับสินค้า (แท็บ PURCHASE_LINES) จากไฟล์ Google Sheet กลางผ่าน Apps Script Web App ที่เชื่อมต่อไว้ (ต้องใช้ Code.gs เวอร์ชันที่มี action=hub และบัญชีที่ติดตั้งต้องเปิดไฟล์ Data Hub ได้) ข้อมูลไม่ถูกคัดลอกมาเก็บที่หน้านี้ เมื่อ Data Hub อัปเดต กดโหลดอีกครั้งก็ได้ข้อมูลใหม่</p>
  ${(o=>`<div class="fgrid">
    <label class="f" style="grid-column:1/-1">ไฟล์ Data Hub (ลิงก์ Google Sheet หรือรหัสไฟล์)<input id="s_hubFileId" value="${esc(settings().hubFileId||'')}" placeholder="${esc(HUB_ID)}"></label>
    <label class="f">บริษัทใน Data Hub (ว่าง = ทุกบริษัท)<input id="s_hubCompany" value="${esc(o.company)}"></label>
    <label class="f">โหลด PO ตั้งแต่วันที่<input type="date" id="s_hubFrom" value="${esc(o.from)}"></label>
    <label class="f">เฉพาะผู้ขายที่ชื่อมีคำว่า (ว่าง = ทุกผู้ขาย)<input id="s_hubVendor" value="${esc(o.vendor)}"></label></div>`)(hubSet())}
  <div class="row"><button class="pri" data-act="hubSave" ${CFG.gsUrl&&HUBST.s!=='busy'?'':'disabled'}>บันทึกเงื่อนไขและโหลด</button>${CFG.gsUrl?'':'<span class="sub">เชื่อมต่อ Apps Script Web App ในการ์ด “เชื่อมต่อ Google Sheet” ก่อน</span>'}</div>
  ${hubOn()?`<p class="hint">โหลดล่าสุด: ใบสั่งซื้อ ${HUB.pos.length.toLocaleString('th-TH')} ใบ (${HUB.nl.toLocaleString('th-TH')} บรรทัด) เอกสารรับสินค้า ${HUB.dels.length.toLocaleString('th-TH')} ใบ (${HUB.nr.toLocaleString('th-TH')} บรรทัด จากแท็บ ${esc(HUB.reTab||'–')}) จากทั้งหมด ${HUB.rows.toLocaleString('th-TH')} บรรทัดใน Data Hub รายการรับสินค้าอีก ${HUB.skip.toLocaleString('th-TH')} บรรทัดอ้าง PO ที่อยู่นอกเงื่อนไข (บริษัท วันที่เริ่ม หรือผู้ขาย) และ ${(HUB.noPo||0).toLocaleString('th-TH')} บรรทัดไม่มีเลขที่ PO จึงไม่ได้นำมา${!HUB.reTab?' <b>ไม่พบแท็บ PURCHASE_LINES หรือ ECOUNT_PURCHASE ใน Data Hub</b>':!HUB.reCols||!HUB.nr?' <b>แท็บ '+esc(HUB.reTab)+(!HUB.reCols?' ไม่มีคอลัมน์เลขที่ RE / เลขที่ใบสั่งซื้อ / รหัสสินค้า / จำนวน ที่ระบบรู้จัก':' ไม่มีรายการที่อ้าง PO ที่โหลดมา')+'</b> หัวคอลัมน์ที่พบ: '+esc((HUB.reHead||[]).join(', '))+'':''}</p>`:HUBST.s==='err'?`<p class="hint">${esc(HUBST.msg)}</p>`:'<p class="hint">ยังไม่ได้โหลดจาก Data Hub ในการเปิดหน้าครั้งนี้</p>'}</section>
  <section class="card"><h2>ลำดับการใช้งาน</h2><ol class="todo">
    <li>นำเข้าตารางโปรโมชั่นและรายงานใบสั่งซื้อจาก ECOUNT ที่แท็บ “เอกสารและนำเข้า”</li>
    <li>ขั้น ① ดูราคาที่เปิดสูงกว่าโปรโมชั่น แก้ PO ก่อนส่งให้ผู้ขาย</li>
    <li>เมื่อของมาถึง สแกนใบส่งสินค้าในขั้น ② ตรวจทานตัวเลขที่ระบบอ่านได้ แล้วบันทึก</li>
    <li>ใบส่งสินค้าที่ผ่านการเทียบ PO กด “ออก RE” ในขั้น ② ระบบบันทึกใบซื้อเข้า ECOUNT ให้</li>
    <li>เมื่อได้ใบกำกับภาษี สแกนในขั้น ③ ระบบเทียบจำนวน ราคา และภาษีให้ทันที</li>
    <li>PO ที่ผ่านครบ 3 ขั้นกด “อนุมัติจ่าย” ในภาพรวม รายการที่ยอมรับได้ใช้ “อนุมัติข้อยกเว้น” พร้อมเหตุผล</li></ol></section></div>`}
