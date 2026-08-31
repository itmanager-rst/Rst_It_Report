const BASE_URL = window.location.port === '5500' ? 'http://127.0.0.1:8000' : '';

let currentTargetInputId = null;
let currentTargetRow = null;
let currentSearchData = [];
let searchModal = null;
let loadingModal = null;

document.addEventListener("DOMContentLoaded", function() {
    searchModal = new bootstrap.Modal(document.getElementById('searchModal'));
    loadingModal = new bootstrap.Modal(document.getElementById('loadingModal'));
    
    const today = new Date().toISOString().split('T')[0];
    const ioDateEl = document.getElementById('io_date');
    const reqDateEl = document.getElementById('req_date');
    
    if (ioDateEl) ioDateEl.value = today;
    if (reqDateEl) reqDateEl.value = today;

    generateDocNumber();
    if (ioDateEl) ioDateEl.addEventListener('change', generateDocNumber);
    
    checkSystemStatus();
    loadPOList(); // เรียกดึงรายการใบสั่งซื้อเมื่อโหลดหน้าเว็บ
});

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

async function checkSystemStatus() {
    const bqEl = document.getElementById('bqStatus');
    const ecountEl = document.getElementById('ecountStatus');

    if (!bqEl || !ecountEl) return;

    try {
        const res = await fetch(BASE_URL + '/api/health-check');
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const textData = await res.text();
        if (!textData || !textData.trim()) throw new Error("Empty Response");
        
        const data = JSON.parse(textData);

        bqEl.className = data.bigquery ? 'status-badge status-online' : 'status-badge status-offline';
        bqEl.innerHTML = `<span class="status-dot"></span> BigQuery: ${data.bigquery ? 'Connected' : 'Disconnected'}`;

        ecountEl.className = data.ecount ? 'status-badge status-online' : 'status-badge status-offline';
        ecountEl.innerHTML = `<span class="status-dot"></span> ECOUNT: ${data.ecount ? 'Connected' : 'Disconnected'}`;
    } catch (err) {
        bqEl.className = 'status-badge status-offline';
        ecountEl.className = 'status-badge status-offline';
    }
}

async function openModal(type, targetInputId) {
    currentTargetInputId = targetInputId;
    currentTargetRow = null;
    document.getElementById('modalTitle').innerText = 'ค้นหาข้อมูล ' + type.toUpperCase();
    document.getElementById('modalTableBody').innerHTML = '<tr><td colspan="3" class="text-center py-4">กำลังโหลด...</td></tr>';
    searchModal.show();

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
            document.getElementById('modalTableBody').innerHTML = '<tr><td colspan="3" class="text-center text-muted">ไม่พบข้อมูล</td></tr>';
        }
    } catch(e) {
        document.getElementById('modalTableBody').innerHTML = '<tr><td colspan="3" class="text-center text-danger">เกิดข้อผิดพลาดในการโหลด</td></tr>';
    }
}

async function openProductModal(btn) {
    currentTargetInputId = null;
    currentTargetRow = btn.closest('tr');
    document.getElementById('modalTitle').innerText = 'ค้นหารายการสินค้า';
    document.getElementById('modalTableBody').innerHTML = '<tr><td colspan="3" class="text-center py-4">กำลังโหลด...</td></tr>';
    searchModal.show();

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
            document.getElementById('modalTableBody').innerHTML = '<tr><td colspan="3" class="text-center text-muted">ไม่พบรายการสินค้า</td></tr>';
        }
    } catch(e) {
        document.getElementById('modalTableBody').innerHTML = '<tr><td colspan="3" class="text-center text-danger">เกิดข้อผิดพลาดในการโหลด</td></tr>';
    }
}

function renderSearchTable(data) {
    const tbody = document.getElementById('modalTableBody');
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
    const term = document.getElementById('searchInput').value.toLowerCase();
    const filtered = currentSearchData.filter(i => 
        (i.code && i.code.toLowerCase().includes(term)) || 
        (i.name && i.name.toLowerCase().includes(term))
    );
    renderSearchTable(filtered);
}

function selectItem(code, name) {
    if (currentTargetInputId) {
        document.getElementById(currentTargetInputId).value = code;
    } else if (currentTargetRow) {
        currentTargetRow.querySelector('.prod-cd').value = code;
        currentTargetRow.querySelector('.prod-des').value = name || '';
    }
    searchModal.hide();
    document.getElementById('searchInput').value = '';
}

function addRow() {
    const tbody = document.getElementById('itemRows');
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
        <td><input type="number" class="form-control form-control-sm text-end qty" value="1" min="1" step="0.01" onchange="calcRow(this)" required></td>
        <td><input type="number" class="form-control form-control-sm text-end price" value="0" step="0.01" onchange="calcRow(this)"></td>
        <td><input type="number" class="form-control form-control-sm text-end discount-rate" value="0" step="0.01" onchange="calcRow(this)"></td>
        <td><input type="number" class="form-control form-control-sm text-end discount-amt" value="0" step="0.01" onchange="calcRow(this)"></td>
        <td><input type="number" class="form-control form-control-sm text-end supply-amt" value="0.00" step="0.01" readonly></td>
        <td><input type="number" class="form-control form-control-sm text-end total-amt" value="0.00" step="0.01" readonly></td>
        <td><input type="number" class="form-control form-control-sm text-end vat-amt" value="0.00" step="0.01" onchange="calcRow(this)"></td>
        <td><input type="date" class="form-control form-control-sm item-delivery-date"></td>
        <td><input type="text" class="form-control form-control-sm remarks"></td>
        <td class="text-center"><button type="button" class="btn btn-sm btn-outline-danger p-0 px-1" onclick="removeRow(this)"><i class="bi bi-trash"></i></button></td>
    `;
    tbody.appendChild(tr);
    updateRowNumbers();
}

function removeRow(btn) {
    const tbody = document.getElementById('itemRows');
    if(tbody.children.length > 1) {
        btn.closest('tr').remove();
        updateRowNumbers();
        updateTotals();
    }
}

function updateRowNumbers() {
    document.querySelectorAll('#itemRows tr').forEach((tr, index) => {
        tr.querySelector('.row-num').innerText = index + 1;
    });
}

function calcRow(el) {
    const tr = el.closest('tr');
    const qty = parseFloat(tr.querySelector('.qty').value) || 0;
    const price = parseFloat(tr.querySelector('.price').value) || 0;
    const discountRate = parseFloat(tr.querySelector('.discount-rate').value) || 0;
    
    let baseAmount = qty * price;
    let discountAmt = parseFloat(tr.querySelector('.discount-amt').value) || 0;

    if (discountRate > 0) {
        discountAmt = baseAmount * (discountRate / 100);
        tr.querySelector('.discount-amt').value = discountAmt.toFixed(2);
    }

    const supplyAmt = Math.max(0, baseAmount - discountAmt);
    tr.querySelector('.supply-amt').value = supplyAmt.toFixed(2);

    const ioTypeEl = document.getElementById('io_type');
    const ioType = ioTypeEl ? ioTypeEl.value : '';
    let vatAmt = parseFloat(tr.querySelector('.vat-amt').value) || 0;
    if (ioType === 'VAT') {
        vatAmt = supplyAmt * 0.07;
        tr.querySelector('.vat-amt').value = vatAmt.toFixed(2);
    }

    const totalAmt = supplyAmt + vatAmt;
    tr.querySelector('.total-amt').value = totalAmt.toFixed(2);

    updateTotals();
}

function updateTotals() {
    let totQty = 0, totDisc = 0, totSupply = 0, totVat = 0, totGrand = 0;

    document.querySelectorAll('#itemRows tr').forEach(tr => {
        totQty += parseFloat(tr.querySelector('.qty').value) || 0;
        totDisc += parseFloat(tr.querySelector('.discount-amt').value) || 0;
        totSupply += parseFloat(tr.querySelector('.supply-amt').value) || 0;
        totVat += parseFloat(tr.querySelector('.vat-amt').value) || 0;
        totGrand += parseFloat(tr.querySelector('.total-amt').value) || 0;
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

// ฟังก์ชันช่วยจัดรูปแบบวันที่ให้อยู่ในรูปแบบ DD/MM/YYYY (พ.ศ.)
function formatThaiDate(dateStr) {
    if (!dateStr || dateStr === '-') return '-';
    let cleanStr = String(dateStr).replace(/[^0-9]/g, '');
    if (cleanStr.length === 8) {
        let year = parseInt(cleanStr.substring(0, 4));
        let month = cleanStr.substring(4, 6);
        let day = cleanStr.substring(6, 8);
        if (year < 2500) year += 543; // แปลงเป็น พ.ศ.
        return `${day}/${month}/${year}`;
    }
    return dateStr;
}

// ปรับปรุงฟังก์ชัน loadPOList ดึงข้อมูล ใบขอซื้อ, เลขใบสั่งซื้อ, อ้างอิง และวันที่ส่งมอบ ครบถ้วน
async function loadPOList() {
    const listTableBody = document.getElementById('poListTableBody');
    if (!listTableBody) return;

    listTableBody.innerHTML = '<tr><td colspan="14" class="text-center py-4 text-muted"><div class="spinner-border spinner-border-sm text-primary me-2"></div>กำลังโหลดข้อมูลจาก ECOUNT...</td></tr>';

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

        const res = await fetch(`${BASE_URL}/api/get-po-list?${queryParams.toString()}`);

        // 1. ตรวจสอบสถานะ HTTP Status 412 (Session Expired / Precondition Failed)
        if (res.status === 412) {
            throw new Error("ECOUNT Session หมดอายุ หรือพารามิเตอร์ไม่ถูกต้อง (Status 412)");
        }

        if (!res.ok) {
            throw new Error(`Server returned status code: ${res.status} (${res.statusText})`);
        }

        // 2. ดึงข้อความตอบกลับเป็นข้อความดิบก่อน
        const textData = await res.text();

        if (!textData || !textData.trim()) {
            throw new Error("Server ตอบกลับด้วยค่าว่าง (Empty Response)");
        }

        // 3. แปลงเป็น JSON ด้วยความปลอดภัย
        let result;
        try {
            result = JSON.parse(textData);
        } catch (parseErr) {
            throw new Error("Server Response ไม่ใช่ JSON ที่ถูกต้อง (อาจเป็น HTML Error Page)");
        }

        // 4. นำข้อมูลไป Render ลงตารางพร้อมค้นหา Key สำรองทุกรูปแบบจาก ECOUNT
        if (result.success && result.data && result.data.length > 0) {
            listTableBody.innerHTML = '';
            
            result.data.forEach((item, index) => {
                const tr = document.createElement('tr');

                // วันที่และลำดับ
                const rawDate = item.IO_DATE || item.ORD_DATE || item.PROD_DATE || item.DATE || '';
                const thaiDate = formatThaiDate(rawDate);
                const seqNo = item.SEQ || item.LINE_NO || item.IO_SEQ || (index + 1);

                // อ้างอิง (REF_NO / REMARKS / U_MEMO1)
                const refNo = item.REF_NO || item.REFERENCE_NO || item.REMARKS || item.U_MEMO1 || item.CUST_REF_NO || '-';

                // โครงการ
                const projectName = item.PJT_DES || item.PJT_NAME || item.PJT_CD || '-';

                // ใบขอซื้อเลขที่ (PR_NO / REQ_NO / REL_NO / PUR_REQ_NO / U_MEMO2)
                const prNo = item.PR_NO || item.REQ_NO || item.PUR_REQ_NO || item.REL_NO || item.U_MEMO2 || '-';

                // เลขที่ใบสั่งซื้อ (PO_NO / IO_NO / ORD_NO / DOC_NO)
                const poNo = item.PO_NO || item.IO_NO || item.ORD_NO || item.DOC_NO || item.PO_NUM || 
                             (item.U_MEMO1 && item.U_MEMO1.startsWith('PO') ? item.U_MEMO1 : '-') || '-';

                // ลูกค้า/ผู้ขาย
                const customerName = item.CUST_DES || item.CUST_NAME || item.CUST || item.CUSTOMER_NAME || '-';

                // PIC
                const empName = item.EMP_DES || item.EMP_NAME || item.PIC_NAME || item.EMP_CD || '-';

                // สินค้า และ ข้อมูลจำเพาะ
                const productName = item.PROD_DES || item.PROD_NAME || item.ITEM_DES || item.PROD_CD || '-';
                const sizeName = item.SIZE_DES || item.SIZE || item.SPEC || '';

                // วันที่ส่งมอบ (DELIVERY_DATE / TIME_DATE / REQ_DATE / DUE_DATE)
                const rawDeliveryDate = item.DELIVERY_DATE || item.TIME_DATE || item.REQ_DATE || item.DUE_DATE || item.DELIVERY_DATE_ITEM || '';
                const deliveryDateFormatted = rawDeliveryDate ? formatThaiDate(rawDeliveryDate) : '-';

                // ยอดรวม
                const totalValue = parseFloat(item.TOTAL_AMT || item.TOTAL_PRICE || item.SUPPLY_AMT || item.AMT || item.QTY || 0);

                // สถานะ
                const confirm = item.CONFIRM_TYPE || item.STATUS || item.APPROVAL_STATUS || 'N';

                tr.innerHTML = `
                    <td class="text-center"><input type="checkbox" value="${poNo}"></td>
                    <td class="text-center text-nowrap">${thaiDate}${rawDate ? `-${seqNo}` : '-'}</td>
                    <td>${refNo}</td>
                    <td>${projectName}</td>
                    <td class="text-nowrap">${prNo}</td>
                    <td class="fw-bold text-primary text-nowrap">${poNo}</td>
                    <td>${customerName}</td>
                    <td>${empName}</td>
                    <td>${productName}${sizeName ? ` [${sizeName}]` : ''}</td>
                    <td class="text-center text-nowrap">${deliveryDateFormatted}</td>
                    <td class="text-end fw-bold">${Number.isFinite(totalValue) && totalValue > 0 ? totalValue.toLocaleString('th-TH', {minimumFractionDigits: 2}) : '0.00'}</td>
                    <td class="text-center">
                        <span class="status-badge-ecount ${confirm === 'Y' || confirm === 'Approved' || confirm === 'APPROVED' || confirm === 'COMPLETED' ? 'status-completed' : 'status-in-progress'}">
                            ${confirm === 'Y' || confirm === 'Approved' || confirm === 'APPROVED' || confirm === 'COMPLETED' ? 'เสร็จสิ้น' : 'กำลังดำเนินการ'}
                        </span>
                    </td>
                    <td class="text-center">-</td>
                    <td class="text-center"><button class="btn btn-sm btn-link p-0 text-secondary"><i class="bi bi-printer"></i></button></td>
                `;
                listTableBody.appendChild(tr);
            });
        } else {
            const message = result && result.message ? result.message : 'ไม่พบรายการใบสั่งซื้อในระบบ';
            listTableBody.innerHTML = `<tr><td colspan="14" class="text-center py-4 ${message.includes('ECOUNT') ? 'text-warning' : 'text-muted'}">${message}</td></tr>`;
        }
    } catch (err) {
        console.error("Error loading PO list:", err);
        listTableBody.innerHTML = `<tr><td colspan="14" class="text-center text-danger py-4">❌ ไม่สามารถดึงข้อมูลได้: ${err.message}</td></tr>`;
    }
}

const poFormEl = document.getElementById('poForm');
if (poFormEl) {
    poFormEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const btnSubmit = document.getElementById('btnSubmit');
        if (btnSubmit) btnSubmit.disabled = true;
        if (loadingModal) loadingModal.show();

        const items = [];
        document.querySelectorAll('#itemRows tr').forEach(tr => {
            items.push({
                prod_cd: tr.querySelector('.prod-cd').value.trim(),
                prod_des: tr.querySelector('.prod-des').value.trim(),
                size_des: tr.querySelector('.size-des').value.trim(),
                qty: parseFloat(tr.querySelector('.qty').value) || 0,
                price: parseFloat(tr.querySelector('.price').value) || 0,
                supply_amt: parseFloat(tr.querySelector('.supply-amt').value) || 0,
                vat_amt: parseFloat(tr.querySelector('.vat-amt').value) || 0,
                remarks: tr.querySelector('.remarks').value.trim() || '-'
            });
        });

        const payload = {
            po_no: document.getElementById('po_no').value.trim(),
            pr_no: document.getElementById('pr_no').value.trim(),
            cust_cd: document.getElementById('cust_cd').value.trim(),
            io_date: document.getElementById('io_date').value,
            req_date: document.getElementById('req_date').value,
            wh_cd: document.getElementById('wh_cd').value.trim(),
            emp_cd: document.getElementById('emp_cd').value.trim(),
            pjt_cd: document.getElementById('pjt_cd').value.trim(),
            io_type: document.getElementById('io_type').value,
            exchange_type: document.getElementById('exchange_type').value,
            u_memo1: document.getElementById('u_memo1').value.trim(),
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