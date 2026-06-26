// ฟังก์ชันเชื่อมโยงและอัปเดตข้อมูลแบบกลุ่ม Real-time
function updateContract() {
    // 1. ข้อมูลทั่วไปของเอกสาร
    document.getElementById('out_id').innerText = document.getElementById('in_id').value;
    document.getElementById('out_place').innerText = document.getElementById('in_place').value;
    document.getElementById('out_day').innerText = document.getElementById('in_day').value;
    document.getElementById('out_month').innerText = document.getElementById('in_month').value;
    document.getElementById('out_year').innerText = document.getElementById('in_year').value;
    
    // 2. ข้อมูลฝั่งผู้กู้ (รวมถึงจุดกระจายชื่อและลายเซ็นวงเล็บท้ายเล่ม)
    const borrowerName = document.getElementById('in_borrower').value;
    document.getElementById('out_borrower').innerText = borrowerName;
    document.getElementById('out_borrower2').innerText = borrowerName;
    document.getElementById('out_sig_borrower').innerText = borrowerName ? `( ${borrowerName} )` : '';
    
    // 3. ที่อยู่ผู้กู้
    document.getElementById('out_subdistrict').innerText = document.getElementById('in_subdistrict').value;
    document.getElementById('out_district').innerText = document.getElementById('in_district').value;
    document.getElementById('out_province').innerText = document.getElementById('in_province').value;
    document.getElementById('out_age').innerText = document.getElementById('in_age').value;
    document.getElementById('out_address').innerText = document.getElementById('in_address').value;
    
    // 4. ข้อมูลผู้ให้กู้
    const lenderName = document.getElementById('in_lender').value;
    document.getElementById('out_lender').innerText = lenderName;
    document.getElementById('out_lender2').innerText = lenderName;
    document.getElementById('out_sig_lender').innerText = lenderName ? `( ${lenderName} )` : '';
    
    // 5. รายละเอียดจำนวนเงินกู้ (ทำฟอร์แมตคอมมาแยกหลักพัน)
    const amount = document.getElementById('in_amount').value;
    document.getElementById('out_amount').innerText = amount ? Number(amount).toLocaleString('th-TH') : '';
    document.getElementById('out_amount_text').innerText = document.getElementById('in_amount_text').value;
    document.getElementById('out_satang').innerText = document.getElementById('in_satang').value;
    
    // 6. หลักประกันและเงื่อนไข
    document.getElementById('out_asset').innerText = document.getElementById('in_asset').value;
    document.getElementById('out_due_day').innerText = document.getElementById('in_due_day').value;
    document.getElementById('out_due_month').innerText = document.getElementById('in_due_month').value;
    document.getElementById('out_due_year').innerText = document.getElementById('in_due_year').value;
    document.getElementById('out_interest').innerText = document.getElementById('in_interest').value;
    
    // 7. พยาน บุคคลอ้างอิงท้ายเล่มสัญญา
    const w1 = document.getElementById('in_witness1').value;
    document.getElementById('out_sig_witness1').innerText = w1 ? `( ${w1} )` : '';
    
    const w2 = document.getElementById('in_witness2').value;
    document.getElementById('out_sig_witness2').innerText = w2 ? `( ${w2} )` : '';
    
    const writer = document.getElementById('in_writer').value;
    document.getElementById('out_sig_writer').innerText = writer ? `( ${writer} )` : '';
}

// รายชื่อ ID ฟิลด์ทั้งหมดเพื่อนำมาวนลูปดักจับ Event การคีย์ (Input)
const allInputIds = [
    'in_id', 'in_place', 'in_day', 'in_month', 'in_year',
    'in_borrower', 'in_age', 'in_address', 'in_subdistrict', 'in_district', 'in_province',
    'in_lender', 'in_amount', 'in_amount_text', 'in_satang',
    'in_asset', 'in_due_day', 'in_due_month', 'in_due_year', 'in_interest',
    'in_witness1', 'in_witness2', 'in_writer'
];

// ผูก Event Listener แบบอัตโนมัติให้ทุกช่องฟอร์มส่งข้อมูลไปยังพรีวิวแบบ Real-time
allInputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', updateContract);
    }
});

// สั่งทำงานครั้งแรกตอนเปิดหน้าเพจเพื่อวาดจุดไข่ปลาตั้งต้นมารอไว้
updateContract();