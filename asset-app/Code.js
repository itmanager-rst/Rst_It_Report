function doGet(e)  { return main(e); }

function doPost(e) {
  try {
    // 1. ตรวจสอบการรับ Webhook จาก LINE
    if (e && e.postData && e.postData.contents) {
      var contents = e.postData.contents;
      // หาก LINE ส่ง Webhook เข้ามา (หรือกด Verify) ให้ไปทำงานที่ lineWebhook
      if (contents.indexOf('"events"') > -1 || contents.indexOf('destination') > -1) {
        return lineWebhook(e);
      }
    }
    // 2. หากเป็นการส่งข้อมูลแบบ POST ทั่วไป ให้ไปทำงานที่ main
    return main(e);
  } catch (err) {
    // ตอบกลับ 200 OK เพื่อให้ LINE Verify ผ่านเสมอ แม้เกิดข้อผิดพลาด
    return ContentService.createTextOutput('OK');
  }
}

function main(e) {
  try {
    var param  = e && e.parameter ? e.parameter : {};
    var action = param.action || '';
    var cb     = param.cb     || '';

    // ── test: ตรวจว่าเชื่อมต่อได้ ──────────────────────
    if (action === 'test') {
      var names = SpreadsheetApp.getActiveSpreadsheet()
                    .getSheets().map(function(s){ return s.getName(); });
      return out({ status:'ok', msg:'connected', sheets:names }, cb);
    }

    // ── LINE: แจ้งเตือน / ตั้งค่า (ไม่ต้องใช้ Sheet) ──
    if (action.indexOf('line') === 0 || action === 'sendLine') {
      return handleLine(action, param, cb);
    }

    // ── หา Sheet ────────────────────────────────────────
    var sheetName = param.sheet || '';
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getActiveSheet();
    if (!sheet) {
      return out({ status:'error', msg:'Sheet not found: ' + sheetName }, cb);
    }

    // ── getAll: ดึงข้อมูลทั้งหมด (ไม่จำกัด row) ────────
    if (action === 'getAll') {
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) {
        return out({ status:'ok', rows:[] }, cb);  // ยังไม่มีข้อมูล
      }
      var lastCol = Math.max(sheet.getLastColumn(), 1);
      var vals    = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      var rows    = [];
      for (var i = 0; i < vals.length; i++) {
        var first = vals[i][0];
        if (first !== '' && first !== null && first !== undefined) {
          rows.push(vals[i]);
        }
      }
      return out({ status:'ok', rows:rows }, cb);
    }

    // ── add: เพิ่มแถวใหม่ ────────────────────────────────
    if (action === 'add') {
      var row  = JSON.parse(param.row).map(function (v) { return v === null || v === undefined ? '' : v; });
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);   // กันหลายเครื่องบันทึกพร้อมกันแล้วแถวซ้อน/เลขชน
      try {
        var key  = String(row[0]);
        var last = sheet.getLastRow();
        var target = 0;
        if (last >= 2) {
          // ถ้ามี _k นี้อยู่แล้ว (Sync ซ้ำ) → เขียนทับแถวเดิม ไม่เพิ่มแถวใหม่
          var keys = sheet.getRange(2, 1, last - 1, 1).getValues();
          for (var i = keys.length - 1; i >= 0; i--) {
            if (String(keys[i][0]) === key) { target = i + 2; break; }
          }
        }
        if (!target) target = last + 1;
        // คอลัมน์ A (_k) และ B (รหัส) เก็บเป็นข้อความ — กัน Sheets แปลง 030 → 30 หรือเป็นวันที่
        sheet.getRange(target, 1, 1, Math.min(2, row.length)).setNumberFormat('@');
        sheet.getRange(target, 1, 1, row.length).setValues([row]);
        SpreadsheetApp.flush();
      } finally {
        lock.releaseLock();
      }
      return out({ status:'ok' }, cb);
    }

    // ── update: แก้ไขแถวที่ key ตรง ─────────────────────
    if (action === 'update') {
      var key  = String(param.key);
      var row  = JSON.parse(param.row);
      var data = sheet.getDataRange().getValues();
      for (var i = data.length - 1; i >= 1; i--) {
        if (String(data[i][0]) === key) {
          sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
          SpreadsheetApp.flush();
          return out({ status:'ok' }, cb);
        }
      }
      return out({ status:'error', msg:'key not found: ' + key }, cb);
    }

    // ── delete: ลบแถวที่ key ตรง ─────────────────────────
    if (action === 'delete') {
      var key  = String(param.key);
      var data = sheet.getDataRange().getValues();
      for (var i = data.length - 1; i >= 1; i--) {
        if (String(data[i][0]) === key) {
          sheet.deleteRow(i + 1);
          SpreadsheetApp.flush();
          return out({ status:'ok' }, cb);
        }
      }
      return out({ status:'error', msg:'key not found: ' + key }, cb);
    }

    return out({ status:'error', msg:'unknown action: ' + action }, cb);

  } catch(err) {
    return out({ status:'error', msg: err.message || String(err) },
               e && e.parameter ? e.parameter.cb || '' : '');
  }
}

// helper: สร้าง ContentService output (JSON หรือ JSONP)
function out(obj, cb) {
  var json = JSON.stringify(obj);
  var body = cb ? cb + '(' + json + ')' : json;
  var mime = cb ? ContentService.MimeType.JAVASCRIPT
                : ContentService.MimeType.JSON;
  return ContentService.createTextOutput(body).setMimeType(mime);
}

// ═══════════════════════════════════════════════════
// LINE Messaging API — IT Asset (RuamsinthaiGroup)
// ═══════════════════════════════════════════════════
var LINE_DEFAULT_EVENTS = { ticket: true, close: true, asset: true, transfer: false };

function lineProps() { return PropertiesService.getScriptProperties(); }

function lineGetConfig() {
  var p = lineProps();
  var events = LINE_DEFAULT_EVENTS;
  try { events = JSON.parse(p.getProperty('LINE_EVENTS') || 'null') || LINE_DEFAULT_EVENTS; } catch (err) {}
  var targets = String(p.getProperty('LINE_TARGETS') || '')
    .split(/[\s,;]+/).filter(function (x) { return x; });
  return { token: p.getProperty('LINE_TOKEN') || '', targets: targets, events: events };
}

function linePush(token, to, text) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  return { ok: code === 200, code: code, body: code === 200 ? '' : res.getContentText().slice(0, 300) };
}

function linePushAll(token, targets, text) {
  var sent = 0, errors = [];
  targets.forEach(function (to) {
    try {
      var r = linePush(token, to, text);
      if (r.ok) sent++; else errors.push(to.slice(0, 6) + '…: HTTP ' + r.code + ' ' + r.body);
    } catch (err) { errors.push(to.slice(0, 6) + '…: ' + err.message); }
  });
  return { status: errors.length ? (sent ? 'partial' : 'error') : 'ok', sent: sent, failed: errors.length, errors: errors };
}

function lineReply(token, replyToken, text) {
  if (!token || !replyToken) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
}

function handleLine(action, p, cb) {
  var props = lineProps();
  var cfg = lineGetConfig();

  if (action === 'lineStatus') {
    return out({
      status: 'ok',
      configured: !!(cfg.token && cfg.targets.length),
      hasToken: !!cfg.token,
      tokenHint: cfg.token ? '••••' + cfg.token.slice(-4) : '',
      targets: cfg.targets,
      events: cfg.events,
      hasAdminKey: !!props.getProperty('LINE_ADMIN_KEY'),
      lastSource: props.getProperty('LINE_LAST_SOURCE') || ''
    }, cb);
  }

  if (action === 'lineSetConfig') {
    var key = props.getProperty('LINE_ADMIN_KEY');
    var given = String(p.adminKey || '');
    if (!key) {
      if (given.length < 4) return out({ status: 'error', msg: 'ตั้ง Admin Key อย่างน้อย 4 ตัวอักษร' }, cb);
      props.setProperty('LINE_ADMIN_KEY', given);
    } else if (given !== key) {
      return out({ status: 'error', msg: 'Admin Key ไม่ถูกต้อง' }, cb);
    }
    if (p.token) props.setProperty('LINE_TOKEN', String(p.token).trim());
    if (p.targets !== undefined) props.setProperty('LINE_TARGETS', String(p.targets));
    if (p.events) { try { props.setProperty('LINE_EVENTS', JSON.stringify(JSON.parse(p.events))); } catch (err) {} }
    return out({ status: 'ok', msg: 'saved' }, cb);
  }

  if (action === 'lineNotify') {
    if (!cfg.token || !cfg.targets.length) return out({ status: 'error', msg: 'not_configured' }, cb);
    var ev = String(p.event || '');
    if (ev && cfg.events[ev] === false) return out({ status: 'skipped', msg: 'ปิดแจ้งเตือนประเภท ' + ev }, cb);
    
    // ── แนบลิงก์ Web App ต่อท้ายข้อความอัตโนมัติ ──
    var appUrl = "https://itmanager-rst.github.io/Rst_It_Report/asset-app/index.html";
    var text = String(p.msg || '').slice(0, 4400) + "\n\n🔗 เข้าสู่ระบบเพื่อตรวจสอบ/อนุมัติ:\n" + appUrl;
    
    if (!p.msg) return out({ status: 'error', msg: 'empty message' }, cb);
    return out(linePushAll(cfg.token, cfg.targets, text), cb);
  }

  if (action === 'sendLine') {
    if (!p.token || !p.userId) return out({ status: 'error', msg: 'missing token/userId' }, cb);
    var appUrl = "https://itmanager-rst.github.io/Rst_It_Report/asset-app/index.html";
    var text = String(p.msg || '').slice(0, 4400) + "\n\n🔗 เข้าสู่ระบบเพื่อตรวจสอบ/อนุมัติ:\n" + appUrl;
    var r = linePush(p.token, p.userId, text);
    return out({ status: r.ok ? 'ok' : 'error', code: r.code, msg: r.body }, cb);
  }

  return out({ status: 'error', msg: 'unknown line action: ' + action }, cb);
}

// ── Webhook จาก LINE: ตอบรับ HTTP 200 ทุกกรณี ──
function lineWebhook(e) {
  var cfg = lineGetConfig();
  var body = {};
  try { 
    body = JSON.parse(e.postData.contents); 
  } catch (err) {}

  if (body.events && Array.isArray(body.events)) {
    body.events.forEach(function (ev) {
      var src = ev.source || {};
      var id = src.groupId || src.roomId || src.userId;
      if (!id) return;
      lineProps().setProperty('LINE_LAST_SOURCE', id + '|' + (src.type || '') + '|' + new Date().toISOString());
      var txt = ev.message && ev.message.type === 'text' ? String(ev.message.text).trim().toLowerCase() : '';
      if (ev.type === 'join' || ev.type === 'follow' || txt === 'id' || txt === 'ไอดี') {
        lineReply(cfg.token, ev.replyToken,
          'ID สำหรับรับแจ้งเตือน IT Asset:\n' + id + '\n\nนำไปใส่ในหน้า ตั้งค่า → แจ้งเตือน LINE');
      }
    });
  }
  return ContentService.createTextOutput('OK');
}