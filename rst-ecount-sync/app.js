const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwCFSw4YGHUbqwaHD2BuAQgsPfO2HC60mqMIbLs1X2NvXN4h6iEEPp-2svn7w736SmMCQ/exec";

let allStockData = []; 
let currentFilter = 'all'; 
let activeTab = 'count'; 
let selectedRowKeys = new Set(); 
let html5QrCode = null;

function getItemCode(item) {
    return String(item.PROD_CD || item.prod_cd || item["รหัสสินค้า"] || "").trim();
}

function getItemName(item) {
    return String(item.PROD_NM || item.PROD_DES || item["ชื่ออะไหล่"] || "").trim();
}

function getItemQty(item) {
    return parseFloat(item.QTY !== undefined ? item.QTY : (item.qty !== undefined ? item.qty : (item["สินค้าคงเหลือ"] || 0)));
}

function getItemMinQty(item) {
    return item.MIN_QTY !== undefined && item.MIN_QTY !== "" ? parseFloat(item.MIN_QTY) : (item.min_qty !== undefined && item.min_qty !== "" ? parseFloat(item.min_qty) : null);
}

function getItemMaxQty(item) {
    return item.MAX_QTY !== undefined && item.MAX_QTY !== "" ? parseFloat(item.MAX_QTY) : (item.max_qty !== undefined && item.max_qty !== "" ? parseFloat(item.MAX_QTY) : null);
}

function isNeedToOrder(item) {
    const qty = getItemQty(item);
    const minQty = getItemMinQty(item);
    return qty <= 0 || (minQty !== null && qty <= minQty);
}

function formatThaiDateTime(rawDateStr) {
    if (!rawDateStr) return '-';
    try {
        const dateObj = new Date(rawDateStr);
        if (isNaN(dateObj.getTime())) return rawDateStr;
        const day = String(dateObj.getDate()).padStart(2, '0');
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const year = dateObj.getFullYear();
        const hours = String(dateObj.getHours()).padStart(2, '0');
        const minutes = String(dateObj.getMinutes()).padStart(2, '0');
        const seconds = String(dateObj.getSeconds()).padStart(2, '0');
        return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
    } catch (e) {
        return rawDateStr;
    }
}

function showStatus(message, isSuccess = true) {
    const statusDiv = document.getElementById('statusMessage');
    statusDiv.innerText = message;
    statusDiv.className = `p-3 rounded-lg text-xs font-medium mb-4 ${isSuccess ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`;
    statusDiv.classList.remove('hidden');
    setTimeout(() => statusDiv.classList.add('hidden'), 5000);
}

function switchTab(tab) {
    activeTab = tab;
    const viewCount = document.getElementById('view-count');
    const viewMinmax = document.getElementById('view-minmax');
    const btnCount = document.getElementById('tab-count-btn');
    const btnMinmax = document.getElementById('tab-minmax-btn');

    if (tab === 'count') {
        viewCount.classList.remove('hidden');
        viewMinmax.classList.add('hidden');
        btnCount.className = "bg-emerald-600 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 shadow cursor-pointer";
        btnMinmax.className = "bg-slate-800 hover:bg-slate-700 text-slate-300 px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 border border-slate-700 cursor-pointer";
    } else {
        viewCount.classList.add('hidden');
        viewMinmax.classList.remove('hidden');
        btnMinmax.className = "bg-emerald-600 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 shadow cursor-pointer";
        btnCount.className = "bg-slate-800 hover:bg-slate-700 text-slate-300 px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 border border-slate-700 cursor-pointer";
    }
}

async function fetchStockData() {
    const refreshBtn = document.getElementById('refresh-btn');
    const refreshIcon = document.getElementById('refresh-icon');
    refreshBtn.disabled = true;
    refreshIcon.classList.add('fa-spin');
    
    try {
        const response = await fetch(`${WEB_APP_URL}?nocache=${new Date().getTime()}`);
        allStockData = await response.json();
        
        allStockData.forEach(item => {
            if (item.actualQty === undefined) item.actualQty = null;
        });

        document.getElementById('total-items').innerText = `${allStockData.length.toLocaleString()} รายการ`;
        if (allStockData.length > 0) {
            const rawTime = allStockData[0].UPDATE_TIME || allStockData[0]["วันที่อัปเดตล่าสุด"] || '-';
            document.getElementById('last-update').innerText = formatThaiDateTime(rawTime);
        }
        
        applyFilterAndSearch();
    } catch (error) {
        document.getElementById('count-table-body').innerHTML = `<tr><td colspan="8" class="py-10 text-center text-rose-500">การเชื่อมต่อขัดข้อง กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต</td></tr>`;
        document.getElementById('stock-table-body').innerHTML = `<tr><td colspan="7" class="py-10 text-center text-rose-500">การเชื่อมต่อขัดข้อง กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต</td></tr>`;
    } finally {
        refreshBtn.disabled = false;
        refreshIcon.classList.remove('fa-spin');
    }
}

function checkSearchEnter(event) {
    if (event.key === 'Enter' || event.keyCode === 13) {
        event.preventDefault();
        applyFilterAndSearch();
    }
}

function applyFilterAndSearch() {
    const searchText = document.getElementById('barcode-input').value.toLowerCase().trim();
    const selectedWarehouse = document.getElementById('warehouse-select').value;
    
    let totalCritical = 0;
    allStockData.forEach(item => { if (getItemQty(item) <= 0) totalCritical++; });
    document.getElementById('critical-items').innerText = `${totalCritical.toLocaleString()} รายการ`;

    const filteredData = allStockData.filter(item => {
        let pCode = getItemCode(item).toLowerCase();
        let pName = getItemName(item).toLowerCase();
        const matchesSearch = pCode.includes(searchText) || pName.includes(searchText);
        const matchesWarehouse = selectedWarehouse === 'all' || pName.includes(`(${selectedWarehouse})`);
        return matchesSearch && matchesWarehouse;
    });

    displayCountTable(filteredData);
    displayMinMaxTable(filteredData);
    updateSelectionUI();
    updateCountCards();
}

function displayCountTable(data) {
    const tbody = document.getElementById('count-table-body');
    if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="py-8 text-center text-slate-400">ไม่พบข้อมูลที่ตรงตามเงื่อนไข</td></tr>`;
        return;
    }

    let html = '';
    data.forEach((item, index) => {
        let pCode = getItemCode(item);
        let pName = getItemName(item);
        let systemQty = getItemQty(item);
        let actualQty = item.actualQty;
        let rowKey = `${pCode}_${pName}`;
        let isChecked = selectedRowKeys.has(rowKey);
        
        let diff = actualQty !== null ? actualQty - systemQty : null;
        let statusBadge = '<span class="bg-purple-50 text-purple-600 border border-purple-200 text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><i class="fa-regular fa-moon"></i> ยังไม่นับ</span>';
        let diffDisplay = '-';

        if (actualQty !== null) {
            if (diff === 0) {
                statusBadge = '<span class="bg-emerald-50 text-emerald-600 border border-emerald-200 text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><i class="fa-solid fa-check"></i> ตรง</span>';
                diffDisplay = `<span class="text-emerald-600 font-semibold">0.00</span>`;
            } else if (diff < 0) {
                statusBadge = '<span class="bg-rose-50 text-rose-600 border border-rose-200 text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><i class="fa-solid fa-minus"></i> ขาด</span>';
                diffDisplay = `<span class="text-rose-600 font-semibold">${diff.toFixed(2)}</span>`;
            } else {
                statusBadge = '<span class="bg-amber-50 text-amber-600 border border-amber-200 text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><i class="fa-solid fa-plus"></i> เกิน</span>';
                diffDisplay = `<span class="text-amber-600 font-semibold">+${diff.toFixed(2)}</span>`;
            }
        }

        html += `
            <tr class="hover:bg-slate-50 transition border-b border-slate-100">
                <td class="px-4 py-3 text-center no-print">
                    <input type="checkbox" class="count-row-checkbox w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer" 
                        data-code="${pCode}" data-name="${pName}" ${isChecked ? 'checked' : ''} onchange="toggleRow('${rowKey}', this.checked)">
                </td>
                <td class="px-4 py-3 text-center text-slate-400 font-medium">${index + 1}</td>
                <td class="px-4 py-3 font-mono text-slate-600">${pCode}</td>
                <td class="px-6 py-3 font-medium text-slate-800">${pName}</td>
                <td class="px-4 py-3 text-right font-semibold text-slate-700">${systemQty.toFixed(2)}</td>
                <td class="px-4 py-3 text-center">
                    <input type="number" 
                           value="${actualQty !== null ? actualQty : ''}" 
                           placeholder="ระบุนับจริง" 
                           onchange="updateActualQty('${pCode}', '${pName.replace(/'/g, "\\'")}', this.value)"
                           class="w-28 text-center bg-white border border-slate-300 text-slate-800 text-xs rounded-md focus:ring-emerald-500 focus:border-emerald-500 p-1.5 placeholder-slate-300 font-medium">
                </td>
                <td class="px-4 py-3 text-center font-mono">${diffDisplay}</td>
                <td class="px-4 py-3 text-center">${statusBadge}</td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

function displayMinMaxTable(data) {
    const tableBody = document.getElementById('stock-table-body');
    if (!data || data.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-400">ไม่พบข้อมูลที่ตรงตามเงื่อนไข</td></tr>`;
        return;
    }

    let rowsHtml = '';
    data.forEach(item => {
        let pCode = getItemCode(item);
        let pName = getItemName(item);
        let qty = getItemQty(item);
        let minQty = getItemMinQty(item);
        let maxQty = getItemMaxQty(item);

        if (!pCode || pCode.trim() === "" || pCode === "undefined") return;

        const rowKey = `${pCode}_${pName}`; 

        let statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">🟢 ปกติ</span>`;
        let qtyColor = 'text-emerald-700 font-semibold';

        if (qty <= 0) {
            statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200 animate-pulse">🔴 วิกฤต (สินค้าหมด)</span>`;
            qtyColor = 'text-rose-600 font-bold bg-rose-50 rounded px-1';
        } else if (minQty !== null && qty <= minQty) {
            statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">🟡 ควรสั่งเพิ่ม</span>`;
            qtyColor = 'text-amber-600 font-semibold bg-amber-50 rounded px-1';
        } else if (maxQty !== null && qty > maxQty) {
            statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">🔵 ล้นคลัง</span>`;
            qtyColor = 'text-blue-600 font-semibold';
        }

        const formattedQty = qty.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        const isChecked = selectedRowKeys.has(rowKey);
        
        rowsHtml += `
            <tr class="hover:bg-slate-50 transition-colors border-b border-slate-100 ${isChecked ? 'bg-emerald-50/40' : ''}">
                <td class="py-3 px-4 text-center">
                    <input type="checkbox" class="row-checkbox w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer" 
                        data-code="${pCode}" data-name="${pName}" ${isChecked ? 'checked' : ''} onchange="toggleRow('${rowKey}', this.checked)">
                </td>
                <td class="py-3 px-4 font-mono text-slate-500 text-xs">${pCode}</td>
                <td class="py-3 px-4 font-medium text-slate-800 break-words max-w-xs sm:max-w-md">
                    ${pName} <div class="mt-0.5">${statusBadge}</div>
                </td>
                <td class="py-2 px-2 text-center">
                    <input type="number" id="min_input_${pCode}" value="${minQty !== null ? minQty : ''}" placeholder="ระบุ Min" 
                        class="w-full text-center border border-slate-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        onchange="updateLocalValue('${pCode}', 'min', this.value)"
                    />
                </td>
                <td class="py-2 px-2 text-center">
                    <input type="number" id="max_input_${pCode}" value="${maxQty !== null ? maxQty : ''}" placeholder="ระบุ Max" 
                        class="w-full text-center border border-slate-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        onchange="updateLocalValue('${pCode}', 'max', this.value)"
                    />
                </td>
                <td class="py-3 px-4 text-right ${qtyColor}">${formattedQty}</td>
                <td class="py-2 px-4 text-center">
                    <button onclick="saveMinMaxQty('${pCode}', '${pName.replace(/'/g, "\\'")}')" 
                        class="bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] px-2.5 py-1 rounded font-medium transition cursor-pointer shadow-sm">
                        💾 บันทึกค่า
                    </button>
                </td>
            </tr>`;
    });
    tableBody.innerHTML = rowsHtml;
}

function openCameraScanner() {
    document.getElementById('camera-modal').classList.remove('hidden');
    if (!html5QrCode) html5QrCode = new Html5Qrcode("interactive");

    const config = { fps: 10, qrbox: { width: 250, height: 180 } };
    html5QrCode.start(
        { facingMode: "environment" },
        config,
        (decodedText) => {
            playBeepSound();
            document.getElementById('barcode-input').value = decodedText;
            closeCameraScanner();
            applyFilterAndSearch();
            showStatus(`🔎 สแกนบาร์โค้ด: ${decodedText} เรียบร้อย`);
        },
        (errorMessage) => {}
    ).catch(err => {
        alert("❌ ไม่สามารถเปิดกล้องได้ กรุณาอนุญาตให้สิทธิ์การใช้งานกล้องในเบราว์เซอร์");
        closeCameraScanner();
    });
}

function closeCameraScanner() {
    if (html5QrCode) {
        html5QrCode.stop().then(() => {
            document.getElementById('camera-modal').classList.add('hidden');
        }).catch(() => {
            document.getElementById('camera-modal').classList.add('hidden');
        });
    } else {
        document.getElementById('camera-modal').classList.add('hidden');
    }
}

function playBeepSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = 800;
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
}

function printDiffReport() {
    let targetData = [];
    if (selectedRowKeys.size > 0) {
        targetData = allStockData.filter(item => selectedRowKeys.has(`${getItemCode(item)}_${getItemName(item)}`));
    } else {
        targetData = allStockData.filter(item => item.actualQty !== null && (item.actualQty - getItemQty(item)) !== 0);
    }

    if (targetData.length === 0) {
        alert("⚠️ ไม่พบรายการ Diff หรือไม่มีรายการที่เลือกไว้สำหรับพิมพ์");
        return;
    }

    const printWindow = window.open('', '_blank');
    const nowStr = new Date().toLocaleString('th-TH');

    let printTableRows = '';
    targetData.forEach((item, index) => {
        const pCode = getItemCode(item);
        const pName = getItemName(item);
        const sysQty = getItemQty(item);
        const actQty = item.actualQty !== null ? item.actualQty : '-';
        const diff = item.actualQty !== null ? item.actualQty - sysQty : '-';
        let diffText = diff !== '-' ? (diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)) : '-';

        printTableRows += `
            <tr>
                <td style="text-align:center;">${index + 1}</td>
                <td>${pCode}</td>
                <td>${pName}</td>
                <td style="text-align:right;">${sysQty.toFixed(2)}</td>
                <td style="text-align:right;">${typeof actQty === 'number' ? actQty.toFixed(2) : actQty}</td>
                <td style="text-align:right; font-weight:bold; color:${diff < 0 ? 'red' : (diff > 0 ? 'green' : 'black')};">${diffText}</td>
            </tr>
        `;
    });

    const htmlContent = `<html><head><title>รายงานผลการตรวจนับสต็อก (Diff Report)</title><style>body { font-family: Sarabun, sans-serif; padding: 20px; color: #333; } h2 { margin-bottom: 5px; font-size: 18px; } p { font-size: 12px; color: #666; margin-top: 0; margin-bottom: 15px; } table { width: 100%; border-collapse: collapse; font-size: 12px; } th, td { border: 1px solid #ddd; padding: 6px 8px; } th { background-color: #f2f2f2; text-align: left; } .footer { margin-top: 30px; display: flex; justify-content: space-between; font-size: 12px; } .sign-box { text-align: center; width: 200px; border-top: 1px solid #000; padding-top: 5px; margin-top: 40px; }</style></head><body><h2>ใบรายงานผลต่างการตรวจนับสินค้าคงคลัง (Diff Report)</h2><p>บริษัท รุ่งเรืองสินไทย จำกัด | วันที่พิมพ์: ${nowStr} | จำนวนรายการ: ${targetData.length} รายการ</p><table><thead><tr><th style="width: 40px; text-align:center;">#</th><th style="width: 120px;">รหัสสินค้า</th><th>ชื่อสินค้า / คลัง</th><th style="width: 90px; text-align:right;">ยอดในระบบ</th><th style="width: 90px; text-align:right;">ยอดนับจริง</th><th style="width: 90px; text-align:right;">ผลต่าง (Diff)</th></tr></thead><tbody>${printTableRows}</tbody></table><div class="footer"><div class="sign-box">ผู้ตรวจนับ</div><div class="sign-box">ผู้อนุมัติ / ผู้จัดการ</div></div></body></html>`;

    printWindow.document.write(htmlContent);
    printWindow.document.close();
    setTimeout(function() { printWindow.print(); printWindow.close(); }, 500);
}

function toggleSelectAllCount(checked) {
    document.querySelectorAll('.count-row-checkbox').forEach(cb => {
        const code = cb.getAttribute('data-code');
        const name = cb.getAttribute('data-name');
        const rowKey = `${code}_${name}`;
        cb.checked = checked;
        if (checked) selectedRowKeys.add(rowKey); else selectedRowKeys.delete(rowKey);
    });
    updateSelectionUI();
}

function updateActualQty(pCode, pName, val) {
    // 1. อัปเดตข้อมูลในหน่วยความจำ
    const item = allStockData.find(d => getItemCode(d) === pCode && getItemName(d) === pName);
    if (!item) return;
    
    item.actualQty = val !== '' ? parseFloat(val) : null;

    // 2. คำนวณผลต่าง (Diff) และสถานะใหม่เฉพาะแถวนี้
    const systemQty = getItemQty(item);
    const actualQty = item.actualQty;
    const diff = actualQty !== null ? actualQty - systemQty : null;

    let statusBadge = '<span class="bg-purple-50 text-purple-600 border border-purple-200 text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><i class="fa-regular fa-moon"></i> ยังไม่นับ</span>';
    let diffDisplay = '-';

    if (actualQty !== null) {
        if (diff === 0) {
            statusBadge = '<span class="bg-emerald-50 text-emerald-600 border border-emerald-200 text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><i class="fa-solid fa-check"></i> ตรง</span>';
            diffDisplay = `<span class="text-emerald-600 font-semibold">0.00</span>`;
        } else if (diff < 0) {
            statusBadge = '<span class="bg-rose-50 text-rose-600 border border-rose-200 text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><i class="fa-solid fa-minus"></i> ขาด</span>';
            diffDisplay = `<span class="text-rose-600 font-semibold">${diff.toFixed(2)}</span>`;
        } else {
            statusBadge = '<span class="bg-amber-50 text-amber-600 border border-amber-200 text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><i class="fa-solid fa-plus"></i> เกิน</span>';
            diffDisplay = `<span class="text-amber-600 font-semibold">+${diff.toFixed(2)}</span>`;
        }
    }

    // 3. อัปเดตเฉพาะ Cell ของแถวนั้นทันที โดยไม่ต้องวาดตารางใหม่ทั้งหมด
    const rowInput = event.target; // รับ HTML Element ตัวที่กำลังกรอก
    const row = rowInput.closest('tr');
    if (row) {
        row.cells[6].innerHTML = diffDisplay;  // ช่องผลต่าง (Diff)
        row.cells[7].innerHTML = statusBadge;  // ช่องสถานะ
    }

    // 4. อัปเดตตัวเลขการ์ดสรุปด้านบน
    updateCountCards();
}

function updateCountCards() {
    const countedItems = allStockData.filter(i => i.actualQty !== null);
    const total = allStockData.length;
    
    let match = 0;
    let diffMinus = 0;
    let diffPlus = 0;

    countedItems.forEach(i => {
        const diff = i.actualQty - getItemQty(i);
        if (diff === 0) match++;
        else if (diff < 0) diffMinus++;
        else if (diff > 0) diffPlus++;
    });

    document.getElementById('card-counted').innerText = `${countedItems.length} / ${total}`;
    document.getElementById('card-match').innerText = match;
    document.getElementById('card-diff-minus').innerText = diffMinus;
    document.getElementById('card-diff-plus').innerText = diffPlus;
}

function updateLocalValue(prodCd, type, newValue) {
    allStockData.forEach(item => {
        if (getItemCode(item) === prodCd) {
            const val = newValue !== '' ? parseFloat(newValue) : "";
            if (type === 'min') {
                if (item.MIN_QTY !== undefined) item.MIN_QTY = val;
                if (item.min_qty !== undefined) item.min_qty = val;
            } else {
                if (item.MAX_QTY !== undefined) item.MAX_QTY = val;
                if (item.max_qty !== undefined) item.max_qty = val;
            }
        }
    });
}

async function saveMinMaxQty(prodCd, prodDes) {
    const minVal = document.getElementById(`min_input_${prodCd}`).value.trim();
    const maxVal = document.getElementById(`max_input_${prodCd}`).value.trim();
    
    showStatus(`⏳ กำลังบันทึกค่า Min/Max ใหม่ของรหัส ${prodCd}...`);
    
    try {
        await fetch(WEB_APP_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: "update_min_max",
                PROD_CD: prodCd,
                PROD_DES: prodDes,
                MIN_QTY: minVal !== '' ? parseFloat(minVal) : null,
                MAX_QTY: maxVal !== '' ? parseFloat(maxVal) : null
            })
        });
        showStatus(`✅ บันทึก Min: ${minVal || 'ว่าง'} / Max: ${maxVal || 'ว่าง'} ของรหัส ${prodCd} สำเร็จ!`);
        applyFilterAndSearch();
    } catch (error) {
        showStatus(`❌ บันทึกไม่สำเร็จ: ${error.message}`, false);
    }
}

function toggleRow(rowKey, checked) {
    if (checked) selectedRowKeys.add(rowKey); else selectedRowKeys.delete(rowKey);
    updateSelectionUI();
}

function toggleSelectAll(checked) {
    document.querySelectorAll('.row-checkbox').forEach(cb => {
        if (cb.closest('tr').style.display === "none") return;
        const code = cb.getAttribute('data-code');
        const name = cb.getAttribute('data-name');
        const rowKey = `${code}_${name}`;
        cb.checked = checked;
        if (checked) selectedRowKeys.add(rowKey); else selectedRowKeys.delete(rowKey);
    });
    updateSelectionUI();
}

function selectAllCritical() {
    allStockData.forEach(item => {
        if (isNeedToOrder(item)) { 
            const rowKey = `${getItemCode(item)}_${getItemName(item)}`;
            selectedRowKeys.add(rowKey); 
        }
    });
    document.querySelectorAll('.row-checkbox').forEach(cb => {
        if (cb.closest('tr').style.display === "none") return;
        const code = cb.getAttribute('data-code');
        const name = cb.getAttribute('data-name');
        cb.checked = selectedRowKeys.has(`${code}_${name}`);
    });
    updateSelectionUI();
}

function clearSelection() {
    selectedRowKeys.clear();
    document.querySelectorAll('.row-checkbox, .count-row-checkbox').forEach(cb => cb.checked = false);
    updateSelectionUI();
}

function updateSelectionUI() {
    const activeCheckedCount = selectedRowKeys.size;
    const countEl = document.getElementById('selected-count');
    const badgeEl = document.getElementById('export-count-badge');
    
    if (countEl) countEl.innerText = activeCheckedCount.toLocaleString();
    if (activeCheckedCount > 0) {
        badgeEl.innerText = activeCheckedCount;
        badgeEl.classList.remove('hidden');
    } else {
        badgeEl.classList.add('hidden');
    }
    
    const rowCheckboxes = document.querySelectorAll('.row-checkbox');
    const allChecked = rowCheckboxes.length > 0 ? Array.from(rowCheckboxes).every(cb => cb.checked) : false;
    const headCb = document.getElementById('select-all-checkbox-head');
    const subCb = document.getElementById('select-all-checkbox');
    if (headCb) headCb.checked = allChecked;
    if (subCb) subCb.checked = allChecked;
}

function exportToEcountExcel() {
    if (selectedRowKeys.size === 0) {
        alert("⚠️ กรุณาเลือกรายการสินค้าที่ต้องการ Export อย่างน้อย 1 รายการ");
        return;
    }

    let csvContent = "\uFEFF"; 
    csvContent += "รหัสสินค้า,จำนวน,รหัสคลัง\r\n"; 
    let exportCount = 0;

    selectedRowKeys.forEach(rowKey => {
        let [pCode, pName] = rowKey.split('_');
        let item = allStockData.find(d => getItemCode(d) === pCode && getItemName(d) === pName);
        if (!item) return;

        let qty = getItemQty(item);
        let maxInputEl = document.getElementById(`max_input_${pCode}`);
        let maxQty = (maxInputEl && maxInputEl.value !== "") ? parseFloat(maxInputEl.value) : getItemMaxQty(item);
        if (maxQty === null || isNaN(maxQty)) maxQty = 5; 

        let orderQty = maxQty - qty; 
        if (orderQty <= 0) orderQty = maxQty; 

        let whCode = "00001"; 
        if (pName.includes("(กุฉินารายณ์)")) whCode = "00002";
        else if (pName.includes("(เดชอุดม)")) whCode = "00003";
        else if (pName.includes("(ตระการพืชผล)")) whCode = "00004";
        else if (pName.includes("(ศรีเมือง)") || pName.includes("(ศรีเมืองใหม่)")) whCode = "00005";
        else if (pName.includes("(ศรีสะเกษ)") || pName.includes("(เมืองศรีสะเกษ)")) whCode = "00006";
        else if (pName.includes("(เบญจลักษ์)") || pName.includes("(เบญจลักษณ์)")) whCode = "00007";
        else if (pName.includes("(ขุขันธ์)")) whCode = "00008";
        else if (pName.includes("(โกดังบ้านดอน)")) whCode = "0014";

        csvContent += `"${pCode}","${orderQty}","=""${whCode}"""\r\n`;
        exportCount++;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0,10);
    
    link.setAttribute("href", url);
    link.setAttribute("download", `ECOUNT_PO_UPLOAD_${today}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showStatus(`📥 Export ข้อมูลจำนวน ${exportCount} รายการ เรียบร้อยแล้ว`, true);
}

window.onload = fetchStockData;