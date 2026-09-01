const BASE_URL = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') 
    ? 'http://127.0.0.1:8000' 
    : 'https://purchaseorder-yxjy.onrender.com';

let currentTargetInputId = null;
let currentTargetRow = null;
let currentSearchData = [];
let searchModal = null;
let loadingModal = null;
let excelModal = null;

document.addEventListener("DOMContentLoaded", function() {
    const searchModalEl = document.getElementById('searchModal');
    const loadingModalEl = document.getElementById('loadingModal');
    const excelModalEl = document.getElementById('excelModal');

    if (searchModalEl) searchModal = new bootstrap.Modal(searchModalEl);
    if (loadingModalEl) loadingModal = new bootstrap.Modal(loadingModalEl);
    if (excelModalEl) excelModal = new bootstrap.Modal(excelModalEl);
    
    const today = new Date().toISOString().split('T')[0];
    const ioDateEl = document.getElementById('io_date');
    const reqDateEl = document.getElementById('req_date');
    
    if (ioDateEl) ioDateEl.value = today;
    if (reqDateEl) reqDateEl.value = today;

    generateDocNumber();
    if (ioDateEl) ioDateEl.addEventListener('change', generateDocNumber);
    
    // เพิ่มรายการสินค้าเริ่มต้น 1 แถว
    addRow();

    // เช็คสถานะการเชื่อมต่อ ECOUNT และ BigQuery
    checkSystemStatus();

    // ดึงรายการใบสั่งซื้อที่มีใน ECOUNT
    loadPOList();

    // เพิ่ม Event Listener สำหรับการอัปโหลดไฟล์ Excel
    const excelForm = document.getElementById('excelUploadForm');
    if (excelForm) {
        excelForm.addEventListener('submit', handleExcelUpload);
    }
});

// ----------------------------------------------------
// 1. ระบบเช็คสถานะการเชื่อมต่อ (ECOUNT & BigQuery)
// ----------------------------------------------------
async function checkSystemStatus() {
    const ecountBadge = document.getElementById('ecountStatusBadge');
    const bqBadge = document.getElementById('bqStatusBadge');

    try {
        const res = await fetch(BASE_URL + '/api/health-check');
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const textData = await res.text();
        if (!textData || !textData.trim()) throw new Error("Empty Response");
        
        const data = JSON.parse(textData);

        // อัปเดตสถานะ ECOUNT Badge
        if (ecountBadge) {
            if (data.ecount) {
                ecountBadge.className = 'badge bg-success border border-light d-flex align-items-center gap-1 fw-normal';
                ecountBadge.innerHTML = `<i class="bi bi-check-circle-fill"></i> เชื่อมต่อ ECOUNT สำเร็จ`;
            } else {
                ecountBadge.className = 'badge bg-danger border border-light d-flex align-items-center gap-1 fw-normal';
                ecountBadge.innerHTML = `<i class="bi bi-x-circle-fill"></i> เชื่อมต่อ ECOUNT ล้มเหลว`;
            }
        }

        // อัปเดตสถานะ BigQuery Badge
        if (bqBadge) {
            if (data.bigquery) {
                bqBadge.className = 'badge bg-info text-dark border border-light d-flex align-items-center gap-1 fw-normal';
                bqBadge.innerHTML = `<i class="bi bi-database-check"></i> BigQuery: Connected`;
            } else {
                bqBadge.className = 'badge bg-secondary border border-light d-flex align-items-center gap-1 fw-normal';
                bqBadge.innerHTML = `<i class="bi bi-database-slash"></i> BigQuery: Disconnected`;
            }
        }
    } catch (err) {
        if (ecountBadge) {
            ecountBadge.className = 'badge bg-danger border border-light d-flex align-items-center gap-1 fw-normal';
            ecountBadge.innerHTML = `<i class="bi bi-x-circle-fill"></i> ไม่สามารถเชื่อมต่อระบบ ECOUNT ได้`;
        }
        if (bqBadge) {
            bqBadge.className = 'badge bg-secondary border border-light d-flex align-items-center gap-1 fw-normal';
            bqBadge.innerHTML = `<i class="bi bi-database-slash"></i> BigQuery: Disconnected`;
        }
    }
}

// ----------------------------------------------------
// 2. ฟังก์ชันเกี่ยวกับการอัปโหลด Excel (Auto PO Batch 10)
// ----------------------------------------------------
function updateFileNameDisplay(input) {
    const fileNameDiv = document.getElementById('selectedFileName');
    const btnUpload = document.getElementById('btnUploadExcel');
    
    if (input.files && input.files[0]) {
        if (fileNameDiv) fileNameDiv.textContent = `ไฟล์ที่เลือก: ${input.files[0].name}`;
        if (btnUpload) btnUpload.disabled = false;
    } else {
        if (fileNameDiv) fileNameDiv.textContent = '';
        if (btnUpload) btnUpload.disabled = true;
    }
}

async function handleExcelUpload(e) {
    e.preventDefault();
    
    const fileInput = document.getElementById('excelFileInput');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
        alert('กรุณาเลือกไฟล์ Excel');
        return;
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    if (excelModal) excelModal.hide();
    const loadingText = document.getElementById('loadingText');
    if (loadingText) loadingText.textContent = 'กำลังส่งข้อมูลเข้า ECOUNT ( Auto PO ครั้งละ 10 รายการ )...';
    if (loadingModal) loadingModal.show();

    try {
        const res = await fetch(BASE_URL + '/api/upload-excel-po', {
            method: 'POST',
            body: formData
        });

        const result = await res.json();
        if (loadingModal) loadingModal.hide();

        if (res.ok && result.success) {
            let message = `🎉 สร้าง Auto PO สำเร็จทั้งหมด ${result.total_batches} ใบ!\n\n`;
            if (Array.isArray(result.summary)) {
                result.summary.forEach(batch => {
                    if (batch.status === 'success') {
                        message += `• Batch ${batch.batch} (${batch.item_count} รายการ) -> เลขที่ PO: ${batch.slip_nos}\n`;
                    } else {
                        message += `• Batch ${batch.batch} -> ❌ ล้มเหลว\n`;
                    }
                });
            }
            alert(message);
            location.reload();
        } else {
            alert('❌ เกิดข้อผิดพลาด: ' + (result.detail || JSON.stringify(result)));
        }
    } catch (err) {
        if (loadingModal) loadingModal.hide();
        alert('❌ ไม่สามารถเชื่อมต่อ Server ได้: ' + err.message);
    }
}

// ----------------------------------------------------
// 3. ฟังก์ชันการจัดการฟอร์ม Manual PO
// ----------------------------------------------------
function generateDocNumber() {
    const ioDateEl = document.getElementById('io_date');
    if (!ioDateEl) return;
    
    const ioDateVal = ioDateEl.value;
    if (!ioDateVal) return;

    const dateObj = new Date(ioDateVal);
    const yearBE = (dateObj.getFullYear() + 543).toString().slice(-2);
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    const randomSeq = String(Math.floor(Math.random() * 9000) + 1000); 

    const poNoEl = document.getElementById('po_no');
    if (poNoEl) poNoEl.value = `PO${yearBE}${month}${day}${randomSeq}`;
}

async function checkDuplicatePO() {
    const poNoEl = document.getElementById('po_no');
    const poNo = poNoEl ? poNoEl.value.trim() : '';
    if (!poNo) {
        alert('⚠️ กรุณาระบุเลขที่ใบสั่งซื้อ');
        return;
    }
    try {
        const res = await fetch(`${BASE_URL}/api/check-po-duplicate?po_no=${encodeURIComponent(poNo)}`);
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const textData = await res.text();
        if (!textData || !textData.trim()) throw new Error("Empty Response");
        
        const result = JSON.parse(textData);
        if (result.is_duplicate) {
            alert(`❌ เลขที่ใบสั่งซื้อ "${poNo}" มีอยู่ในระบบแล้ว!`);
        } else {
            alert(`✅ เลขที่ใบสั่งซื้อ "${poNo}" สามารถใช้งานได้`);
        }
    } catch (err) {
        alert(`🔍 ตรวจสอบหมายเลข: ${poNo} สามารถใช้งานได้`);
    }
}

// Modal ค้นหา Master Data
async function openModal(type, targetInputId) {
    currentTargetInputId = targetInputId;
    currentTargetRow = null;
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalTableBody');
    
    if (modalTitle) modalTitle.innerText = 'ค้นหาข้อมูล ' + type.toUpperCase();
    if (modalBody) modalBody.innerHTML = '<tr><td colspan="3" class="text-center py-4">กำลังโหลด...</td></tr>';
    if (searchModal) searchModal.show();

    try {
        const res = await fetch(BASE_URL + '/api/search/' + type);
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const textData = await res.text();
        if (!textData || !textData.trim()) throw new Error("Empty Response");
        
        const result = JSON.parse(textData);
        if(result.success && result.data.length > 0) {
            currentSearchData = result.data;
            renderSearchTable(currentSearchData);
        } else {
            if (modalBody) modalBody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">ไม่พบข้อมูล</td></tr>';
        }
    } catch(e) {
        if (modalBody) modalBody.innerHTML = '<tr><td colspan="3" class="text-center text-danger">เกิดข้อผิดพลาดในการโหลด</td></tr>';
    }
}

async function openProductModal(btn) {
    currentTargetInputId = null;
    currentTargetRow = btn.closest('tr');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalTableBody');

    if (modalTitle) modalTitle.innerText = 'ค้นหารายการสินค้า';
    if (modalBody) modalBody.innerHTML = '<tr><td colspan="3" class="text-center py-4">กำลังโหลด...</td></tr>';
    if (searchModal) searchModal.show();

    try {
        const res = await fetch(BASE_URL + '/api/search/product');
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

        const textData = await res.text();
        if (!textData || !textData.trim()) throw new Error("Empty Response");

        const result = JSON.parse(textData);
        if(result.success && result.data.length > 0) {
            currentSearchData = result.data;
            renderSearchTable(currentSearchData);
        } else {
            if (modalBody) modalBody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">ไม่พบรายการสินค้า</td></tr>';
        }
    } catch(e) {
        if (modalBody) modalBody.innerHTML = '<tr><td colspan="3" class="text-center text-danger">เกิดข้อผิดพลาดในการโหลด</td></tr>';
    }
}

function renderSearchTable(data) {
    const tbody = document.getElementById('modalTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    data.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="fw-bold">${item.code || ''}</td>
            <td>${item.name || '-'}</td>
            <td><button type="button" class="btn btn-sm btn-primary" onclick="selectItem('${item.code}', '${item.name || ''}')">เลือก</button></td>
        `;
        tbody.appendChild(tr);
    });
}

function filterSearchTable() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;
    const term = searchInput.value.toLowerCase();
    const filtered = currentSearchData.filter(i => 
        (i.code && i.code.toLowerCase().includes(term)) || 
        (i.name && i.name.toLowerCase().includes(term))
    );
    renderSearchTable(filtered);
}

function selectItem(code, name) {
    if (currentTargetInputId) {
        const targetEl = document.getElementById(currentTargetInputId);
        if (targetEl) targetEl.value = code;
    } else if (currentTargetRow) {
        const prodCd = currentTargetRow.querySelector('.prod-cd');
        const prodDes = currentTargetRow.querySelector('.prod-des');
        if (prodCd) prodCd.value = code;
        if (prodDes) prodDes.value = name || '';
    }
    if (searchModal) searchModal.hide();
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';
}

// เพิ่ม/ลบ แถวรายการสินค้า
function addRow() {
    const tbody = document.getElementById('itemRows');
    if (!tbody) return;
    const rowCount = tbody.children.length + 1;
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td class="text-center row-num">${rowCount}</td>
        <td>
            <div class="input-group input-group-sm">
                <input type="text" class="form-control prod-cd" required>
                <button class="btn btn-outline-secondary search-btn" type="button" onclick="openProductModal(this)"><i class="bi bi-search"></i></button>
            </div>
        </td>
        <td><input type="text" class="form-control form-control-sm prod-des"></td>
        <td><input type="text" class="form-control form-control-sm size-des"></td>
        <td><input type="number" class="form-control form-control-sm text-end qty" value="1" min="0.01" step="any" onchange="calcRow(this)" required></td>
        <td><input type="number" class="form-control form-control-sm text-end price" value="0" step="any" onchange="calcRow(this)"></td>
        <td><input type="number" class="form-control form-control-sm text-end discount-rate" value="0" step="any" onchange="calcRow(this)"></td>
        <td><input type="number" class="form-control form-control-sm text-end discount-amt" value="0" step="any" onchange="calcRow(this)"></td>
        <td><input type="number" class="form-control form-control-sm text-end supply-amt" value="0.00" step="any" readonly></td>
        <td><input type="number" class="form-control form-control-sm text-end total-amt" value="0.00" step="any" readonly></td>
        <td><input type="number" class="form-control form-control-sm text-end vat-amt" value="0.00" step="any" onchange="calcRow(this)"></td>
        <td><input type="date" class="form-control form-control-sm item-delivery-date"></td>
        <td><input type="text" class="form-control form-control-sm remarks"></td>
        <td class="text-center"><button type="button" class="btn btn-sm btn-outline-danger p-0 px-1" onclick="removeRow(this)"><i class="bi bi-trash"></i></button></td>
    `;
    tbody.appendChild(tr);
    updateRowNumbers();
}

function removeRow(btn) {
    const tbody = document.getElementById('itemRows');
    if(tbody && tbody.children.length > 1) {
        btn.closest('tr').remove();
        updateRowNumbers();
        updateTotals();
    }
}

function updateRowNumbers() {
    document.querySelectorAll('#itemRows tr').forEach((tr, index) => {
        const numEl = tr.querySelector('.row-num');
        if (numEl) numEl.innerText = index + 1;
    });
}

function calcRow(el) {
    const tr = el.closest('tr');
    if (!tr) return;

    const qty = parseFloat(tr.querySelector('.qty')?.value) || 0;
    const price = parseFloat(tr.querySelector('.price')?.value) || 0;
    const discountRate = parseFloat(tr.querySelector('.discount-rate')?.value) || 0;
    
    let baseAmount = qty * price;
    let discountAmt = parseFloat(tr.querySelector('.discount-amt')?.value) || 0;

    if (discountRate > 0) {
        discountAmt = baseAmount * (discountRate / 100);
        const discInput = tr.querySelector('.discount-amt');
        if (discInput) discInput.value = discountAmt.toFixed(2);
    }

    const supplyAmt = Math.max(0, baseAmount - discountAmt);
    const supplyInput = tr.querySelector('.supply-amt');
    if (supplyInput) supplyInput.value = supplyAmt.toFixed(2);

    const ioTypeEl = document.getElementById('io_type');
    const ioType = ioTypeEl ? ioTypeEl.value : '';
    let vatAmt = parseFloat(tr.querySelector('.vat-amt')?.value) || 0;
    if (ioType === 'VAT') {
        vatAmt = supplyAmt * 0.07;
        const vatInput = tr.querySelector('.vat-amt');
        if (vatInput) vatInput.value = vatAmt.toFixed(2);
    }

    const totalAmt = supplyAmt + vatAmt;
    const totalInput = tr.querySelector('.total-amt');
    if (totalInput) totalInput.value = totalAmt.toFixed(2);

    updateTotals();
}

function updateTotals() {
    let totQty = 0, totDisc = 0, totSupply = 0, totVat = 0, totGrand = 0;

    document.querySelectorAll('#itemRows tr').forEach(tr => {
        totQty += parseFloat(tr.querySelector('.qty')?.value) || 0;
        totDisc += parseFloat(tr.querySelector('.discount-amt')?.value) || 0;
        totSupply += parseFloat(tr.querySelector('.supply-amt')?.value) || 0;
        totVat += parseFloat(tr.querySelector('.vat-amt')?.value) || 0;
        totGrand += parseFloat(tr.querySelector('.total-amt')?.value) || 0;
    });

    const totalQtyEl = document.getElementById('totalQty');
    const totalDiscountEl = document.getElementById('totalDiscount');
    const totalSupplyEl = document.getElementById('totalSupply');
    const totalVatEl = document.getElementById('totalVat');
    const grandTotalEl = document.getElementById('grandTotal');

    if (totalQtyEl) totalQtyEl.innerText = totQty.toLocaleString();
    if (totalDiscountEl) totalDiscountEl.innerText = totDisc.toFixed(2);
    if (totalSupplyEl) totalSupplyEl.innerText = totSupply.toFixed(2);
    if (totalVatEl) totalVatEl.innerText = totVat.toFixed(2);
    if (grandTotalEl) grandTotalEl.innerText = totGrand.toFixed(2);
}

// ----------------------------------------------------
// 4. ฟังก์ชันดึงรายการใบสั่งซื้อจาก ECOUNT ERP (ปรับปรุงดึงยอดเงิน)
// ----------------------------------------------------
function formatThaiDate(dateStr) {
    if (!dateStr || dateStr === '-') return '-';
    let cleanStr = String(dateStr).replace(/[^0-9]/g, '');
    if (cleanStr.length === 8) {
        let year = parseInt(cleanStr.substring(0, 4));
        let month = cleanStr.substring(4, 6);
        let day = cleanStr.substring(6, 8);
        if (year < 2500) year += 543;
        return `${day}/${month}/${year}`;
    }
    return dateStr;
}

function parseNumber(val) {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    const cleaned = String(val).replace(/,/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
}

// ฟังก์ชันค้นหายอดเงินแบบละเอียด ครอบคลุมทุก Key จาก ECOUNT
function extractAmountFromObject(obj) {
    if (!obj || typeof obj !== 'object') return 0;

    const normalizeKey = (key) => String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    const directCandidates = [
        'TOTALAMT', 'TOTALAMOUNT', 'POAMT', 'POAMOUNT', 'BUYAMT', 'BUYAMTF',
        'SUPPLYAMT', 'SUPPLYAMOUNT', 'NETAMT', 'NETAMOUNT', 'SUMAMT', 'SUMAMOUNT',
        'TOTALPRICE', 'TOTALPRICEVAT', 'TOTALAMTVAT', 'TOTALAFTERVAT',
        'TOTALBEFOREVAT', 'OUTAMT', 'PRODAMT', 'EXCHBUYAMT', 'AMTF', 'AMT',
        'AMOUNT', 'TOTAMT', 'TOTAL', 'NETH', 'NETTOTAL', 'TOTALNET', 'PO_TOTAL', 'DOCAMT'
    ];

    const values = [];

    const walk = (value) => {
        if (!value || typeof value !== 'object') {
            return;
        }

        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }

        for (const [key, propValue] of Object.entries(value)) {
            const normalizedKey = normalizeKey(key);
            if (directCandidates.includes(normalizedKey)) {
                const parsed = parseNumber(propValue);
                if (parsed !== 0 || String(propValue ?? '').trim() === '0' || String(propValue ?? '').trim() === '0.00') {
                    values.push(parsed);
                }
            }
            if (propValue && typeof propValue === 'object') {
                walk(propValue);
            }
        }
    };

    walk(obj);

    if (values.length > 0) {
        return values.reduce((sum, value) => sum + value, 0);
    }

    // fallback: ถ้าระบบส่ง Quantity * Price แทนยอดรวม
    const qty = parseNumber(obj.QTY || obj.BUY_QTY || obj.QUANTITY || obj.QTY_1);
    const price = parseNumber(obj.PRICE || obj.BUY_PRICE || obj.UNIT_PRICE || obj.PUR_PRICE);
    if (qty > 0 && price > 0) {
        return qty * price;
    }

    return 0;
}

async function loadPOList(retryCount = 0) {
    const listTableBody = document.getElementById('poListTableBody');
    if (!listTableBody) return;

    listTableBody.innerHTML = '<tr><td colspan="16" class="text-center py-4 text-muted"><div class="spinner-border spinner-border-sm text-primary me-2"></div>กำลังโหลดข้อมูลจาก ECOUNT...</td></tr>';

    try {
        const today = new Date();
        const past30Days = new Date(today);
        past30Days.setDate(today.getDate() - 30);

        const formatDateStr = (d) => {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}${month}${day}`;
        };

        const startDateStr = formatDateStr(past30Days);
        const endDateStr = formatDateStr(today);

        const dateRangeEl = document.getElementById('ecountDateRangeText');
        if (dateRangeEl) {
            dateRangeEl.textContent = `${formatThaiDate(startDateStr)} ~ ${formatThaiDate(endDateStr)}`;
        }

        const queryParams = new URLSearchParams({
            DATE_FROM: startDateStr,
            DATE_TO: endDateStr
        });

        let res = await fetch(`${BASE_URL}/api/get-po-list?${queryParams.toString()}`);

        const textData = await res.text();
        let result = null;
        try {
            result = textData && textData.trim() ? JSON.parse(textData) : null;
        } catch (e) {
            console.error("JSON Parse Error:", e);
        }

        // จัดการกรณี ECOUNT Session 412: ทำการ Auto Re-login ให้อัตโนมัติสูงสุด 2 ครั้ง
        const isSessionExpired = res.status === 412 || (result && result.message && result.message.includes('412'));
        
        if (isSessionExpired && retryCount < 2) {
            console.warn(`ECOUNT Session 412 Detected. Auto relogging (Attempt ${retryCount + 1})...`);
            await fetch(`${BASE_URL}/api/health-check`); // กระตุ้นการ Re-login ฝั่ง Backend
            await new Promise(resolve => setTimeout(resolve, 1200)); // หน่วงเวลา 1.2 วินาที
            return loadPOList(retryCount + 1); // โหลดรายการซ้ำอีกครั้ง
        }

        if (!res.ok && !isSessionExpired) {
            throw new Error(`Server status: ${res.status} (${res.statusText})`);
        }

        if (result && result.success && result.data && result.data.length > 0) {
            listTableBody.innerHTML = '';
            
            console.log("ECOUNT Raw Data Sample:", result.data[0]);

            result.data.forEach((item, index) => {
                const tr = document.createElement('tr');

                const rawDate = item.ORD_DATE || item.IO_DATE || item.TIME_DATE || '';
                const thaiDate = formatThaiDate(rawDate);
                const seqNo = item.ORD_NO || item.SEQ || (index + 1);
                const dateSeqStr = `${thaiDate} -${seqNo}`;

                const projectName = item.PJT_DES || item.PJT_CD || '-';
                const prReceiveDate = formatThaiDate(item.ORD_DATE || item.IO_DATE);
                const prReqDate = formatThaiDate(item.TIME_DATE || item.IO_DATE);
                const seoType = item.P_DES1 || item.SEO_TYPE || '-';
                const locationName = item.WH_DES || item.WH_CD || 'สำนักงานใหญ่';

                let poNo = item.ORD_NO ? `PO-${rawDate}-${item.ORD_NO}` : (item.PO_NO || item.SLIP_NO || '-');

                const prodName = item.PROD_DES || item.PROD_CD || '-';
                const sizeSpec = item.SIZE_DES ? ` [${item.SIZE_DES}]` : '';
                const fullProdDisplay = `${prodName}${sizeSpec}`;

                const deliveryDate = formatThaiDate(item.TIME_DATE || item.IO_DATE);
                
                // คำนวณดึงยอดรวมสุทธิ
                const totalAmt = extractAmountFromObject(item);

                const custName = item.CUST_DES || item.CUST_NAME || item.CUST || '-';
                const picName = item.CUST_NAME || item.EMP_CD || item.WRITER_ID || '-';
                const remarkText = item.REF_DES || item.TTL_CTT || '-';

                const isCompleted = item.P_FLAG === '9' || item.P_FLAG === 9 || item.CONFIRM_TYPE === 'Y';
                const statusBadge = isCompleted 
                    ? `<span class="text-success fw-bold">เสร็จสิ้น</span>` 
                    : `<span class="text-secondary">กำลังดำเนินการ</span>`;

                tr.innerHTML = `
                    <td class="text-center text-nowrap">${dateSeqStr}</td>
                    <td>${projectName}</td>
                    <td class="text-center text-nowrap">${prReceiveDate}</td>
                    <td class="text-center text-nowrap">${prReqDate}</td>
                    <td>${seoType}</td>
                    <td>${locationName}</td>
                    <td class="fw-bold text-nowrap">${poNo}</td>
                    <td>${fullProdDisplay}</td>
                    <td class="text-center text-nowrap">${deliveryDate}</td>
                    <td class="text-end fw-bold text-primary">${totalAmt.toLocaleString('th-TH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                    <td>${custName}</td>
                    <td class="text-center">${statusBadge}</td>
                    <td class="text-center">${picName}</td>
                    <td class="text-center"><a href="#" class="text-decoration-none">ดู</a></td>
                    <td class="text-center"><button class="btn btn-sm btn-warning text-white py-0 px-2 fw-bold">พิมพ์</button></td>
                    <td class="small text-muted">${remarkText}</td>
                `;
                listTableBody.appendChild(tr);
            });
        } else {
            const message = result && result.message ? result.message : 'ECOUNT Session หมดอายุ กรุณากดปุ่ม \'โหลดรายการใหม่\' อีกครั้ง';
            listTableBody.innerHTML = `<tr><td colspan="16" class="text-center py-4 text-warning fw-bold">${message}</td></tr>`;
        }
    } catch (err) {
        console.error("Error loading PO list:", err);
        listTableBody.innerHTML = `<tr><td colspan="16" class="text-center text-danger py-4">❌ ไม่สามารถดึงข้อมูลได้: ${err.message}</td></tr>`;
    }
}

// Submit Manual PO Form
const poFormEl = document.getElementById('poForm');
if (poFormEl) {
    poFormEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const btnSubmit = document.getElementById('btnSubmit');
        const loadingText = document.getElementById('loadingText');

        if (btnSubmit) btnSubmit.disabled = true;
        if (loadingText) loadingText.textContent = 'กำลังบันทึกข้อมูลใบสั่งซื้อ...';
        if (loadingModal) loadingModal.show();

        const items = [];
        document.querySelectorAll('#itemRows tr').forEach(tr => {
            items.push({
                prod_cd: tr.querySelector('.prod-cd')?.value.trim() || '',
                prod_des: tr.querySelector('.prod-des')?.value.trim() || '',
                size_des: tr.querySelector('.size-des')?.value.trim() || '',
                qty: parseFloat(tr.querySelector('.qty')?.value) || 0,
                price: parseFloat(tr.querySelector('.price')?.value) || 0,
                supply_amt: parseFloat(tr.querySelector('.supply-amt')?.value) || 0,
                vat_amt: parseFloat(tr.querySelector('.vat-amt')?.value) || 0,
                remarks: tr.querySelector('.remarks')?.value.trim() || '-'
            });
        });

        const payload = {
            po_no: document.getElementById('po_no')?.value.trim() || '',
            pr_no: document.getElementById('pr_no')?.value.trim() || '',
            cust_cd: document.getElementById('cust_cd')?.value.trim() || '',
            io_date: document.getElementById('io_date')?.value || '',
            req_date: document.getElementById('req_date')?.value || '',
            wh_cd: document.getElementById('wh_cd')?.value.trim() || '',
            emp_cd: document.getElementById('emp_cd')?.value.trim() || '',
            pjt_cd: document.getElementById('pjt_cd')?.value.trim() || '',
            io_type: document.getElementById('io_type')?.value || '',
            exchange_type: document.getElementById('exchange_type')?.value || '',
            u_memo1: document.getElementById('u_memo1')?.value.trim() || '',
            items: items
        };

        try {
            const res = await fetch(BASE_URL + '/api/save-po', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (!res.ok) throw new Error(`HTTP Status ${res.status}`);

            const textData = await res.text();
            if (!textData || !textData.trim()) throw new Error("Empty Response From Server");

            const result = JSON.parse(textData);

            if (loadingModal) loadingModal.hide();
            if (btnSubmit) btnSubmit.disabled = false;

            if (result.success) {
                alert('🎉 บันทึกใบสั่งซื้อสำเร็จเรียบร้อย!');
                location.reload();
            } else {
                alert('❌ บันทึกไม่สำเร็จ: ' + JSON.stringify(result.details || result.detail, null, 2));
            }
        } catch (err) {
            if (loadingModal) loadingModal.hide();
            if (btnSubmit) btnSubmit.disabled = false;
            alert('❌ การเชื่อมต่อล้มเหลว: ' + err.message);
        }
    });
}