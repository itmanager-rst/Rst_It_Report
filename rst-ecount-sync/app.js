// ==========================================
// Config & Global Variables
// ==========================================
// URL ชี้ไปยัง Python API Server สำหรับเชื่อมต่อ BigQuery / ECOUNT
const PYTHON_API_URL = "http://localhost:5000/api"; 
// เก็บ URL เดิมไว้เผื่ออ้างอิง
// const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwf-5C_zTUBWfdARhEfjjhlCnF7H2Q2B6EoYWhknCO_mprhJDwzNg2Myvh_JWYutgyhlQ/exec"; 

const EXCLUDED_KEYWORDS = [
    "***สินค้าซ่อม***",
    "ค่าขนส่ง",
    "ค่าแรง"
];

let rawStockData = [];          
let filteredStockData = [];     
let countedData = {};           
let selectedMinMaxItems = new Set(); 
let selectedCountItems = new Set();  
let filterCriticalStatus = 'all';    
let html5QrCode = null;              

// ==========================================
// Date Formatting Helper
// ==========================================
/**
 * ฟังก์ชันสำหรับแปลงรูปแบบวันที่ให้อ่านง่าย และแก้ไขปัญหาปีผิดพลาด เช่น 0008 หรือ 0000
 */
function formatThaiDateTime(dateStr) {
    if (!dateStr || dateStr === '-' || dateStr === 'None' || dateStr === 'null') return '-';
    
    try {
        let cleanStr = String(dateStr).trim();

        // แก้ไขกรณีที่ปีในฐานข้อมูลส่งมาเป็น 0008 หรือ 0000 ให้แทนที่ด้วยปีปัจจุบัน
        if (cleanStr.startsWith('0008') || cleanStr.startsWith('0000')) {
            const currentYear = new Date().getFullYear();
            cleanStr = cleanStr.replace(/^(0008|0000)/, currentYear);
        }

        const d = new Date(cleanStr);
        if (isNaN(d.getTime())) {
            return dateStr;
        }

        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear(); // หากต้องการ พ.ศ. ให้ใช้ d.getFullYear() + 543
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');

        return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
    } catch (e) {
        console.error("Error formatting date:", e);
        return dateStr;
    }
}

// ==========================================
// Initialization & Data Fetching (BigQuery Ready)
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    fetchStockData();
});

function isExcludedItem(itemName) {
    if (!itemName) return false;
    return EXCLUDED_KEYWORDS.some(keyword => itemName.includes(keyword));
}

async function fetchStockData() {
    showToast("กำลังดึงข้อมูลสต็อกล่าสุดจาก BigQuery...", "info");
    const refreshIcon = document.getElementById("refresh-icon");
    if (refreshIcon) refreshIcon.classList.add("fa-spin");

    try {
        const response = await fetch(`${PYTHON_API_URL}/get-stock`);
        if (!response.ok) throw new Error("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ Python/BigQuery ได้");
        
        const data = await response.json();
        
        // 📌 Mapping ฟิลด์ให้อยู่ในโครงสร้างมาตรฐาน (รองรับทั้ง Schema BigQuery และ ECOUNT)
        let lastUpdateTime = null;
        rawStockData = data.map(item => {
            const pCode = String(item.PROD_CD || item.item_code || "").trim();
            const pName = String(item.PROD_NM || item.item_name || "").trim();
            const qty = parseFloat(item.QTY !== undefined ? item.QTY : item.stock_qty) || 0;
            const minQty = parseFloat(item.MIN_QTY !== undefined ? item.MIN_QTY : item.min_qty) || 0;
            const maxQty = parseFloat(item.MAX_QTY !== undefined ? item.MAX_QTY : item.max_qty) || 0;
            const updateTime = item.UPDATE_TIME || item.updated_at || "";

            // หากมี updateTime และไม่อยู่ในฟอร์แมต 0008 ให้เก็บค่าไว้
            if (updateTime && !lastUpdateTime && !updateTime.startsWith('0008') && !updateTime.startsWith('0000')) {
                lastUpdateTime = updateTime;
            }

            return {
                PROD_CD: pCode,
                PROD_NM: pName,
                QTY: qty,
                MIN_QTY: minQty,
                MAX_QTY: maxQty,
                UPDATE_TIME: updateTime
            };
        }).filter(item => item.PROD_CD !== "" && !isExcludedItem(item.PROD_NM));
        
        // แสดงเวลาอัปเดตล่าสุดที่จัดฟอร์แมตแล้ว หรือแสดงเวลาปัจจุบันที่มีการโหลดข้อมูลสำเร็จ
        const lastUpdateElem = document.getElementById("last-update");
        if (lastUpdateElem) {
            if (lastUpdateTime) {
                lastUpdateElem.innerText = formatThaiDateTime(lastUpdateTime);
            } else {
                const now = new Date();
                lastUpdateElem.innerText = formatThaiDateTime(now.toISOString());
            }
        }

        applyFilterAndSearch();
        showToast(`โหลดข้อมูลสำเร็จ ${rawStockData.length} รายการ`, "success");
    } catch (error) {
        console.error("Error fetching data:", error);
        showToast("เกิดข้อผิดพลาดในการดึงข้อมูล: " + error.message, "error");
    } finally {
        if (refreshIcon) refreshIcon.classList.remove("fa-spin");
    }
}

// ==========================================
// Tab Switching & Warehouse Sync
// ==========================================

function switchTab(tabName) {
    const viewMinMax = document.getElementById("view-minmax");
    const viewCount = document.getElementById("view-count");
    const btnMinMax = document.getElementById("tab-minmax-btn");
    const btnCount = document.getElementById("tab-count-btn");

    if (tabName === 'minmax') {
        if (viewMinMax) viewMinMax.classList.remove("hidden");
        if (viewCount) viewCount.classList.add("hidden");

        if (btnMinMax) btnMinMax.className = "bg-emerald-600 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 shadow cursor-pointer";
        if (btnCount) btnCount.className = "bg-slate-800 hover:bg-slate-700 text-slate-300 px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 border border-slate-700 cursor-pointer";
    } else {
        if (viewMinMax) viewMinMax.classList.add("hidden");
        if (viewCount) viewCount.classList.remove("hidden");

        if (btnCount) btnCount.className = "bg-emerald-600 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 shadow cursor-pointer";
        if (btnMinMax) btnMinMax.className = "bg-slate-800 hover:bg-slate-700 text-slate-300 px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 border border-slate-700 cursor-pointer";
    }
}

function syncWarehouseSelection(value) {
    const whCount = document.getElementById('warehouse-select');
    const whMinmax = document.getElementById('warehouse-select-minmax');

    if (whCount) whCount.value = value;
    if (whMinmax) whMinmax.value = value;

    applyFilterAndSearch();
}

// ==========================================
// Filter & Search Logic
// ==========================================

function checkSearchEnter(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        applyFilterAndSearch();
    }
}

function handleSearchInput(event) {
    if (event.target.value.trim() === "") {
        applyFilterAndSearch();
    }
}

function setCriticalFilter(status) {
    filterCriticalStatus = status;
    
    const btnAll = document.getElementById("btn-filter-all");
    const btnCritical = document.getElementById("btn-filter-critical");

    if (status === 'critical') {
        if (btnCritical) btnCritical.className = "px-3 py-1 rounded-md font-semibold transition text-white bg-red-600 shadow-sm";
        if (btnAll) btnAll.className = "px-3 py-1 rounded-md font-semibold transition text-slate-500 hover:text-slate-700";
    } else {
        if (btnAll) btnAll.className = "px-3 py-1 rounded-md font-semibold transition text-slate-700 bg-white shadow-sm";
        if (btnCritical) btnCritical.className = "px-3 py-1 rounded-md font-semibold transition text-slate-500 hover:text-red-600";
    }

    applyFilterAndSearch();
}

function applyFilterAndSearch() {
    const warehouseSelect = document.getElementById("warehouse-select");
    const warehouse = warehouseSelect ? warehouseSelect.value : "all";
    const searchInput = document.getElementById("barcode-input");
    const keyword = searchInput ? searchInput.value.trim().toLowerCase() : "";

    filteredStockData = rawStockData.filter(item => {
        if (isExcludedItem(item.PROD_NM)) return false;

        if (warehouse !== "all") {
            if (!item.PROD_NM || !item.PROD_NM.includes(`(${warehouse})`)) {
                return false;
            }
        }

        const qty = parseFloat(item.QTY) || 0;
        const minQty = parseFloat(item.MIN_QTY) || 0;
        const isCritical = qty <= minQty;

        if (filterCriticalStatus === 'critical' && !isCritical) {
            return false;
        }

        if (keyword !== "") {
            const codeMatch = String(item.PROD_CD).toLowerCase().includes(keyword);
            const nameMatch = String(item.PROD_NM).toLowerCase().includes(keyword);
            if (!codeMatch && !nameMatch) return false;
        }

        return true;
    });

    renderMinMaxTable();
    renderCountTable();
    updateSummaryCards();
}

// ==========================================
// Summary Cards Rendering
// ==========================================

function updateSummaryCards() {
    const criticalList = filteredStockData.filter(item => {
        const qty = parseFloat(item.QTY) || 0;
        const minQty = parseFloat(item.MIN_QTY) || 0;
        return qty <= minQty;
    });

    const totalElem = document.getElementById("total-items");
    const criticalElem = document.getElementById("critical-items");

    if (totalElem) totalElem.innerText = `${filteredStockData.length.toLocaleString()} รายการ`;
    if (criticalElem) criticalElem.innerText = `${criticalList.length.toLocaleString()} รายการ`;

    updateCountCards();
}

function updateCountCards() {
    let countedCount = 0;
    let matchCount = 0;
    let diffMinusCount = 0;
    let diffPlusCount = 0;

    filteredStockData.forEach(item => {
        const code = item.PROD_CD;
        if (countedData.hasOwnProperty(code) && countedData[code] !== "" && countedData[code] !== null) {
            countedCount++;
            const actual = parseFloat(countedData[code]) || 0;
            const system = parseFloat(item.QTY) || 0;
            const diff = actual - system;

            if (diff === 0) matchCount++;
            else if (diff < 0) diffMinusCount++;
            else diffPlusCount++;
        }
    });

    const cardCounted = document.getElementById("card-counted");
    const cardMatch = document.getElementById("card-match");
    const cardDiffMinus = document.getElementById("card-diff-minus");
    const cardDiffPlus = document.getElementById("card-diff-plus");

    if (cardCounted) cardCounted.innerText = `${countedCount} / ${filteredStockData.length}`;
    if (cardMatch) cardMatch.innerText = matchCount;
    if (cardDiffMinus) cardDiffMinus.innerText = diffMinusCount;
    if (cardDiffPlus) cardDiffPlus.innerText = diffPlusCount;
}

// ==========================================
// Mode 1: Min/Max Table Rendering & Editing
// ==========================================

function renderMinMaxTable() {
    const tbody = document.getElementById("stock-table-body");
    if (!tbody) return;

    if (filteredStockData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-400">ไม่พบรายการสินค้าที่ตรงตามเงื่อนไข</td></tr>`;
        return;
    }

    let html = "";
    filteredStockData.forEach(item => {
        const isChecked = selectedMinMaxItems.has(item.PROD_CD) ? "checked" : "";
        const qty = parseFloat(item.QTY) || 0;
        const minQty = parseFloat(item.MIN_QTY) || 0;

        let badgeHtml = "";
        if (qty <= 0) {
            badgeHtml = `<span class="inline-block mt-1 px-2 py-0.5 text-[10px] bg-red-100 text-red-700 rounded-full font-bold">🚨 วิกฤต (สินค้าหมด)</span>`;
        } else if (qty <= minQty) {
            badgeHtml = `<span class="inline-block mt-1 px-2 py-0.5 text-[10px] bg-amber-100 text-amber-700 rounded-full font-bold">⚠️ ควรสั่งเพิ่ม</span>`;
        }

        const qtyClass = qty <= minQty ? "text-red-600 font-bold bg-red-50/50" : "text-slate-700 font-semibold";

        html += `
            <tr class="hover:bg-slate-50 transition border-b border-slate-100">
                <td class="py-2.5 px-4 text-center">
                    <input type="checkbox" onchange="toggleSelectItem('${item.PROD_CD}', this.checked)" ${isChecked} class="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer">
                </td>
                <td class="py-2.5 px-4 font-mono font-medium text-slate-800">${item.PROD_CD}</td>
                <td class="py-2.5 px-4">
                    <div class="font-medium text-slate-800">${item.PROD_NM}</div>
                    ${badgeHtml}
                </td>
                <td class="py-2.5 px-4 text-center">
                    <input type="number" id="min-${item.PROD_CD}" value="${item.MIN_QTY}" class="w-20 text-center border border-slate-300 rounded-md py-1 px-1 focus:ring-emerald-500 focus:border-emerald-500 text-xs">
                </td>
                <td class="py-2.5 px-4 text-center">
                    <input type="number" id="max-${item.PROD_CD}" value="${item.MAX_QTY}" class="w-20 text-center border border-slate-300 rounded-md py-1 px-1 focus:ring-emerald-500 focus:border-emerald-500 text-xs">
                </td>
                <td class="py-2.5 px-4 text-right ${qtyClass}">${qty.toFixed(2)}</td>
                <td class="py-2.5 px-4 text-center">
                    <button onclick="saveMinMax('${item.PROD_CD}')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1 rounded-md text-xs font-semibold shadow-sm transition flex items-center justify-center gap-1 mx-auto cursor-pointer">
                        <i class="fa-solid fa-floppy-disk"></i> บันทึกค่า
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
    updateSelectedCountUI();
}

async function saveMinMax(prodCode) {
    const minInput = document.getElementById(`min-${prodCode}`);
    const maxInput = document.getElementById(`max-${prodCode}`);
    const minVal = minInput ? minInput.value : 0;
    const maxVal = maxInput ? maxInput.value : 0;

    showToast(`กำลังบันทึกข้อมูล ${prodCode}...`, "info");

    try {
        const response = await fetch(`${PYTHON_API_URL}/save-minmax-item`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                PROD_CD: prodCode,
                MIN_QTY: minVal,
                MAX_QTY: maxVal
            })
        });

        const resData = await response.json();
        if (resData.status === "SUCCESS") {
            showToast(`บันทึก Min/Max ของ ${prodCode} ลง BigQuery และ ECOUNT เรียบร้อยแล้ว`, "success");
            const item = rawStockData.find(i => i.PROD_CD === prodCode);
            if (item) {
                item.MIN_QTY = parseFloat(minVal);
                item.MAX_QTY = parseFloat(maxVal);
            }
        } else {
            throw new Error(resData.message || "เซิร์ฟเวอร์ตอบกลับผิดพลาด");
        }
    } catch (error) {
        console.error("Save error:", error);
        showToast("เกิดข้อผิดพลาดในการบันทึก: " + error.message, "error");
    }
}

// 📌 เพิ่มฟังก์ชันสำหรับบันทึกกลุ่มสินค้าที่เลือกไว้ไปยัง BigQuery และ ECOUNT รวดเดียว
async function saveMinMaxBulk() {
    if (selectedMinMaxItems.size === 0) {
        showToast("กรุณาเลือกรายการสินค้าที่ต้องการบันทึกก่อน", "error");
        return;
    }

    const itemsToUpdate = [];
    selectedMinMaxItems.forEach(code => {
        const minInput = document.getElementById(`min-${code}`);
        const maxInput = document.getElementById(`max-${code}`);
        const minVal = minInput ? parseFloat(minInput.value) || 0 : 0;
        const maxVal = maxInput ? parseFloat(maxInput.value) || 0 : 0;

        itemsToUpdate.push({
            PROD_CD: code,
            MIN_QTY: minVal,
            MAX_QTY: maxVal
        });
    });

    showToast(`กำลังบันทึก ${itemsToUpdate.length} รายการไปยัง BigQuery & ECOUNT...`, "info");

    try {
        const response = await fetch(`${PYTHON_API_URL}/save-minmax-bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: itemsToUpdate })
        });

        const resData = await response.json();
        if (resData.status === "SUCCESS") {
            showToast(`บันทึกกลุ่มสินค้าสำเร็จ ${itemsToUpdate.length} รายการ`, "success");
            
            // อัปเดตข้อมูลในหน่วยความจำ local
            itemsToUpdate.forEach(up => {
                const item = rawStockData.find(i => i.PROD_CD === up.PROD_CD);
                if (item) {
                    item.MIN_QTY = up.MIN_QTY;
                    item.MAX_QTY = up.MAX_QTY;
                }
            });
        } else {
            throw new Error(resData.message || "เซิร์ฟเวอร์ตอบกลับผิดพลาด");
        }
    } catch (error) {
        console.error("Bulk save error:", error);
        showToast("เกิดข้อผิดพลาดในการบันทึกกลุ่ม: " + error.message, "error");
    }
}

function toggleSelectItem(code, isChecked) {
    if (isChecked) selectedMinMaxItems.add(code);
    else selectedMinMaxItems.delete(code);
    updateSelectedCountUI();
}

function toggleSelectAll(isChecked) {
    filteredStockData.forEach(item => {
        if (isChecked) selectedMinMaxItems.add(item.PROD_CD);
        else selectedMinMaxItems.delete(item.PROD_CD);
    });

    const chk1 = document.getElementById("select-all-checkbox");
    const chk2 = document.getElementById("select-all-checkbox-head");
    if (chk1) chk1.checked = isChecked;
    if (chk2) chk2.checked = isChecked;

    renderMinMaxTable();
}

function selectAllCritical() {
    selectedMinMaxItems.clear();
    filteredStockData.forEach(item => {
        const qty = parseFloat(item.QTY) || 0;
        const minQty = parseFloat(item.MIN_QTY) || 0;
        if (qty <= minQty) {
            selectedMinMaxItems.add(item.PROD_CD);
        }
    });
    renderMinMaxTable();
    showToast(`เลือกรายการสั่งซื้อวิกฤตแล้ว ${selectedMinMaxItems.size} รายการ`, "info");
}

function clearSelection() {
    selectedMinMaxItems.clear();
    const chk1 = document.getElementById("select-all-checkbox");
    const chk2 = document.getElementById("select-all-checkbox-head");
    if (chk1) chk1.checked = false;
    if (chk2) chk2.checked = false;
    renderMinMaxTable();
}

function updateSelectedCountUI() {
    const countElem = document.getElementById("selected-count");
    const badgeElem = document.getElementById("export-count-badge");

    if (countElem) countElem.innerText = selectedMinMaxItems.size;
    
    if (badgeElem) {
        if (selectedMinMaxItems.size > 0) {
            badgeElem.innerText = selectedMinMaxItems.size;
            badgeElem.classList.remove("hidden");
        } else {
            badgeElem.classList.add("hidden");
        }
    }
}

// ==========================================
// Mode 2: Physical Count Table & Direct Cell DOM Update
// ==========================================

function renderCountTable() {
    const tbody = document.getElementById("count-table-body");
    if (!tbody) return;

    if (filteredStockData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="py-8 text-center text-slate-400">ไม่พบรายการสินค้าที่ตรงตามเงื่อนไข</td></tr>`;
        return;
    }

    let html = "";
    filteredStockData.forEach((item, index) => {
        const code = item.PROD_CD;
        const systemQty = parseFloat(item.QTY) || 0;
        const actualVal = countedData.hasOwnProperty(code) ? countedData[code] : "";
        const isChecked = selectedCountItems.has(code) ? "checked" : "";

        let diffText = "-";
        let diffClass = "text-slate-400 font-medium";
        let statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">ยังไม่นับ</span>`;

        if (actualVal !== "" && actualVal !== null) {
            const actualQty = parseFloat(actualVal) || 0;
            const diff = actualQty - systemQty;

            if (diff === 0) {
                diffText = "0.00";
                diffClass = "text-emerald-600 font-bold";
                statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-700"><i class="fa-solid fa-check"></i> ตรงกัน</span>`;
            } else if (diff < 0) {
                diffText = diff.toFixed(2);
                diffClass = "text-rose-600 font-bold";
                statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700"><i class="fa-solid fa-minus"></i> สินค้าขาด</span>`;
            } else {
                diffText = "+" + diff.toFixed(2);
                diffClass = "text-amber-600 font-bold";
                statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700"><i class="fa-solid fa-plus"></i> สินค้าเกิน</span>`;
            }
        }

        html += `
            <tr data-prod-code="${code}" class="hover:bg-slate-50 transition border-b border-slate-100">
                <td class="py-2.5 px-4 text-center no-print">
                    <input type="checkbox" onchange="toggleSelectCountItem('${code}', this.checked)" ${isChecked} class="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer">
                </td>
                <td class="py-2.5 px-4 text-center text-slate-400 font-mono text-[11px]">${index + 1}</td>
                <td class="py-2.5 px-4 font-mono font-medium text-slate-800">${code}</td>
                <td class="py-2.5 px-6 font-medium text-slate-800">${item.PROD_NM}</td>
                <td class="py-2.5 px-4 text-right font-semibold text-slate-700">${systemQty.toFixed(2)}</td>
                <td class="py-2.5 px-4 text-center">
                    <input type="number" step="any" value="${actualVal}" onchange="updateCountVal('${code}', this.value, event)" placeholder="ป้อนค่านับ" class="w-28 text-center border-2 border-slate-300 focus:border-emerald-500 rounded-lg py-1 px-2 text-xs font-bold text-slate-800 focus:ring-0 no-print">
                    <span class="hidden print-inline font-bold">${actualVal !== "" ? actualVal : "-"}</span>
                </td>
                <td class="py-2.5 px-4 text-center font-mono ${diffClass}">${diffText}</td>
                <td class="py-2.5 px-4 text-center">${statusBadge}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
    updateSelectedCountPrintUI();
}

function updateCountVal(code, val, event) {
    if (val === "" || val === null) {
        delete countedData[code];
    } else {
        countedData[code] = val;
    }

    const item = rawStockData.find(i => String(i.PROD_CD) === String(code));
    const systemQty = item ? (parseFloat(item.QTY) || 0) : 0;

    let diffText = "-";
    let diffClass = "text-slate-400 font-medium";
    let statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">ยังไม่นับ</span>`;

    if (val !== "" && val !== null) {
        const actualQty = parseFloat(val) || 0;
        const diff = actualQty - systemQty;

        if (diff === 0) {
            diffText = "0.00";
            diffClass = "text-emerald-600 font-bold";
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-700"><i class="fa-solid fa-check"></i> ตรงกัน</span>`;
        } else if (diff < 0) {
            diffText = diff.toFixed(2);
            diffClass = "text-rose-600 font-bold";
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700"><i class="fa-solid fa-minus"></i> สินค้าขาด</span>`;
        } else {
            diffText = "+" + diff.toFixed(2);
            diffClass = "text-amber-600 font-bold";
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700"><i class="fa-solid fa-plus"></i> สินค้าเกิน</span>`;
        }
    }

    if (event && event.target) {
        const row = event.target.closest('tr');
        if (row) {
            const printSpan = row.cells[5].querySelector('span.print-inline');
            if (printSpan) printSpan.innerText = val !== "" ? val : "-";
            
            row.cells[6].className = `py-2.5 px-4 text-center font-mono ${diffClass}`;
            row.cells[6].innerText = diffText;
            row.cells[7].innerHTML = statusBadge;
        }
    }

    updateCountCards();
}

function toggleSelectCountItem(code, isChecked) {
    if (isChecked) selectedCountItems.add(code);
    else selectedCountItems.delete(code);
    updateSelectedCountPrintUI();
}

function toggleSelectAllCount(isChecked) {
    filteredStockData.forEach(item => {
        if (isChecked) selectedCountItems.add(item.PROD_CD);
        else selectedCountItems.delete(item.PROD_CD);
    });

    const chkTop = document.getElementById("select-all-count-top");
    const chkHead = document.getElementById("select-all-count-head");
    if (chkTop) chkTop.checked = isChecked;
    if (chkHead) chkHead.checked = isChecked;

    renderCountTable();
}

function clearSelectionCount() {
    selectedCountItems.clear();
    const chkTop = document.getElementById("select-all-count-top");
    const chkHead = document.getElementById("select-all-count-head");
    if (chkTop) chkTop.checked = false;
    if (chkHead) chkHead.checked = false;
    renderCountTable();
}

function updateSelectedCountPrintUI() {
    const printNumElem = document.getElementById("selected-count-print-num");
    if (printNumElem) printNumElem.innerText = selectedCountItems.size;
}

// ==========================================
// Print Diff Report Function
// ==========================================

function printDiffReport() {
    const viewMinMax = document.getElementById("view-minmax");
    const isMinMaxTab = viewMinMax && !viewMinMax.classList.contains("hidden");

    if (isMinMaxTab) {
        const rows = document.querySelectorAll("#stock-table-body tr");
        const hasSelection = selectedMinMaxItems.size > 0;

        rows.forEach(row => {
            const chk = row.querySelector("input[type='checkbox']");
            if (hasSelection && chk) {
                if (!chk.checked) {
                    row.classList.add("print-hidden-row");
                } else {
                    row.classList.remove("print-hidden-row");
                }
            } else {
                row.classList.remove("print-hidden-row");
            }
        });

        setTimeout(() => {
            window.print();
            setTimeout(() => {
                rows.forEach(row => row.classList.remove("print-hidden-row"));
            }, 500);
        }, 300);

    } else {
        const rows = document.querySelectorAll("#count-table-body tr");
        const hasSelection = selectedCountItems.size > 0;

        rows.forEach(row => {
            const prodCode = row.getAttribute("data-prod-code");
            if (hasSelection && prodCode) {
                if (!selectedCountItems.has(prodCode)) {
                    row.classList.add("print-hidden-row");
                } else {
                    row.classList.remove("print-hidden-row");
                }
            } else {
                row.classList.remove("print-hidden-row");
            }
        });

        setTimeout(() => {
            window.print();
            setTimeout(() => {
                rows.forEach(row => row.classList.remove("print-hidden-row"));
            }, 500);
        }, 300);
    }
}

// ==========================================
// Barcode & Camera Scanner Logic
// ==========================================

function openCameraScanner() {
    const modal = document.getElementById('camera-modal');
    if (modal) modal.classList.remove('hidden');

    if (!html5QrCode) {
        html5QrCode = new Html5Qrcode("interactive");
    }

    html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        onScanSuccess,
        onScanFailure
    ).catch(err => {
        console.error("Camera error:", err);
        showToast("ไม่สามารถเปิดกล้องสแกนได้: " + err, "error");
        closeCameraScanner();
    });
}

function onScanSuccess(decodedText, decodedResult) {
    const barcodeInput = document.getElementById('barcode-input');
    if (barcodeInput) {
        barcodeInput.value = decodedText;
        applyFilterAndSearch();
        showToast(`สแกนพบสินค้า: ${decodedText}`, "success");
    }
    closeCameraScanner();
}

function onScanFailure(error) {}

function closeCameraScanner() {
    const modal = document.getElementById('camera-modal');
    if (modal) modal.classList.add('hidden');

    if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().then(() => {
            console.log("กล้องถูกปิดแล้ว");
        }).catch(err => console.error("เกิดข้อผิดพลาดในการปิดกล้อง:", err));
    }
}

// ==========================================
// Export & UI Toast
// ==========================================

function exportToEcountExcel() {
    let exportList = [];

    if (selectedMinMaxItems.size > 0) {
        exportList = rawStockData.filter(item => selectedMinMaxItems.has(item.PROD_CD));
    } else {
        exportList = filteredStockData.filter(item => {
            const qty = parseFloat(item.QTY) || 0;
            const minQty = parseFloat(item.MIN_QTY) || 0;
            return qty <= minQty;
        });
    }

    if (exportList.length === 0) {
        showToast("ไม่มีรายการสินค้าที่ต้องส่งออก (กรุณาเลือกรายการหรือกรองสินค้าวิกฤต)", "error");
        return;
    }

    let csvContent = "\uFEFF"; 
    csvContent += "รหัสสินค้า,ชื่อสินค้า,ยอดคงเหลือ,จำนวนต่ำสุด (Min),จำนวนสูงสุด (Max),จำนวนแนะนำสั่งซื้อ\n";

    exportList.forEach(item => {
        const qty = parseFloat(item.QTY) || 0;
        const minQty = parseFloat(item.MIN_QTY) || 0;
        const maxQty = parseFloat(item.MAX_QTY) || 0;
        const suggestOrder = maxQty > qty ? (maxQty - qty) : 0;

        const nameClean = `"${(item.PROD_NM || '').replace(/"/g, '""')}"`;
        csvContent += `"${item.PROD_CD}",${nameClean},${qty},${minQty},${maxQty},${suggestOrder}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    link.setAttribute("href", url);
    link.setAttribute("download", `ใบสั่งซื้อ_ECOUNT_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast(`ส่งออกไฟล์สั่งซื้อ ECOUNT สำเร็จ (${exportList.length} รายการ)`, "success");
}

function showToast(message, type = "info") {
    const toast = document.getElementById("statusMessage");
    if (!toast) return;

    toast.innerText = message;
    toast.className = "p-3 rounded-lg text-xs font-semibold transition-all duration-300 shadow-md flex items-center justify-between";

    if (type === "success") {
        toast.classList.add("bg-emerald-600", "text-white");
    } else if (type === "error") {
        toast.classList.add("bg-rose-600", "text-white");
    } else {
        toast.classList.add("bg-slate-800", "text-slate-100");
    }

    toast.classList.remove("hidden");

    setTimeout(() => {
        toast.classList.add("hidden");
    }, 4000);
}