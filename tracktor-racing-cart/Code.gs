/**
 * Tractor Racing Cart – Google Apps Script Web App (backend)
 * ------------------------------------------------------------------
 * ฐานข้อมูล:  Google Sheet "TractorRacingCart_DB" (สร้างไว้ในโฟลเดอร์ของคุณแล้ว)
 * สำรองเซฟ:  ไฟล์ JSON รายผู้เล่นในโฟลเดอร์ Google Drive เดียวกัน
 *
 * วิธีติดตั้ง (ทำครั้งเดียว)
 *   1) เปิด https://script.google.com > New project > วางโค้ดนี้แทน Code.gs
 *   2) เลือกฟังก์ชัน setup แล้วกด Run (อนุญาตสิทธิ์ Sheets/Drive) – จะสร้างแท็บ Players, Scores, Races, Ghosts, Leaderboard
 *   3) Deploy > New deployment > Type: Web app
 *        Execute as: Me   |   Who has access: Anyone
 *   4) คัดลอก URL ที่ลงท้าย /exec ไปใส่ CONFIG.GAS_URL ในไฟล์ index.html
 *   *แก้โค้ดภายหลัง ต้อง Deploy > Manage deployments > Edit > New version ทุกครั้ง
 *
 * API
 *   GET  ?action=ping
 *   GET  ?action=leaderboard&level=1&limit=10&difficulty=normal → เวลาที่ดีที่สุดของแต่ละคน (easy / normal / hard)
 *   GET  ?action=loadPlayer&playerId=p_xxx        → เซฟล่าสุดของผู้เล่น
 *   POST {action:'submitScore', playerId, name, level, timeMs, stars, tractor, coinsEarned}
 *   POST {action:'savePlayer', save:{...ข้อมูลเซฟทั้งก้อน...}}
 *
 *   --- ผู้เล่นหลายคน (ข้อมูลระหว่างแข่งเก็บใน CacheService เพื่อความเร็ว, ผลแข่งบันทึกลงแท็บ Races) ---
 *   GET  ?action=mpRoom&code=ABCD&playerId=p_xxx  → สถานะห้อง + เวลาเซิร์ฟเวอร์ (ใช้ซิงก์นาฬิกา)
 *   POST {action:'mpCreate', playerId, name, tractor, level}
 *   POST {action:'mpJoin',   code, playerId, name, tractor}
 *   POST {action:'mpLeave',  code, playerId}
 *   POST {action:'mpReady',  code, playerId, ready, tractor}
 *   POST {action:'mpLevel',  code, playerId, level}         (เจ้าของห้องเท่านั้น)
 *   POST {action:'mpStart',  code, playerId}                (เจ้าของห้องเท่านั้น)
 *   POST {action:'mpSync',   code, playerId, raceId, s:[[t,x,y,a],...], fin, dnf}
 *
 *   --- ผู้ดูแล (โหมดเทพ) ---
 *   POST {action:'adminLogin', pin}       → { token } อายุ 12 ชม.
 *   GET  ?action=adminCheck&token=...
 *   ตั้งรหัส: Project Settings (รูปเฟือง) > Script Properties > Add property  ADMIN_PIN = รหัสที่ต้องการ
 *
 *   --- รถผี (บันทึกการขับรอบที่ดีที่สุดของแต่ละคนต่อด่าน ลงแท็บ Ghosts) ---
 *   GET  ?action=ghost&level=1&playerId=p_xxx
 *   POST {action:'saveGhost', playerId, name, level, timeMs, tractor, data}
 *   ฝั่งเกมส่ง POST ด้วย Content-Type: text/plain เพื่อเลี่ยง CORS preflight
 */

// ===== ตั้งค่า =====
const SPREADSHEET_ID = '1tkAQvTgCPb47E8S8U4mFdOZdmhv38L2ViQQUDnLA55s';   // TractorRacingCart_DB
const FOLDER_ID      = '1zyZpnzHZ29-BstTSpVYOo7gS11aBXo5s';              // โฟลเดอร์เก็บข้อมูล
const BACKUP_TO_DRIVE = true;     // เก็บไฟล์ save_<playerId>.json ในโฟลเดอร์ด้วย
const MAX_LEVEL = 8;
// เวลาต่ำสุดที่เป็นไปได้ต่อด่าน (มิลลิวินาที) – กันการส่งคะแนนปลอมแบบง่ายๆ
const MIN_TIME_MS = { 1: 8000, 2: 11000, 3: 14000, 4: 16000, 5: 20000, 6: 17000, 7: 27000, 8: 34000 };

const SHEETS = {
  Players: ['playerId', 'name', 'coins', 'unlockedLevel', 'selectedTractor', 'ownedTractors', 'upgradesJSON', 'bestJSON', 'updatedAt', 'gadgetsJSON'],
  Scores:  ['timestamp', 'playerId', 'name', 'level', 'timeMs', 'timeText', 'stars', 'tractor', 'coinsEarned', 'difficulty'],
  Races:   ['timestamp', 'roomCode', 'raceId', 'level', 'place', 'playerId', 'name', 'tractor', 'timeMs', 'timeText', 'status'],
  Ghosts:  ['playerId', 'level', 'name', 'timeMs', 'tractor', 'data', 'updatedAt', 'difficulty'],
};

// ===== ผู้เล่นหลายคน =====
const MP = {
  MAX_PLAYERS: 4,          // คนต่อห้อง
  TTL: 21600,              // อายุข้อมูลห้องใน cache (วินาที, สูงสุดที่ CacheService รองรับ = 6 ชม.)
  START_DELAY_MS: 6000,    // เวลานับถอยหลังหลังเจ้าของห้องกดเริ่ม
  STALE_MS: 20000,         // ไม่ส่งข้อมูลเกินนี้ = หลุดการเชื่อมต่อ
  KEEP_SAMPLES: 45,        // ตำแหน่งล่าสุดที่เก็บต่อคน (~4.5 วินาที)
};
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // ตัดตัวที่สับสนง่าย (I, L, O, 0, 1)
const GHOST_MAX_CHARS = 48000;                          // เซลล์ชีตเก็บได้ไม่เกิน 50,000 ตัวอักษร

// ================================================================
// SETUP – รันครั้งแรกจากหน้า Editor
// ================================================================
function setup() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Object.keys(SHEETS).forEach(name => {
    const sh = getSheet_(ss, name);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold').setBackground('#F4C534');   // อัปเดตหัวตาราง (เพิ่มคอลัมน์ใหม่)
  });

  // แท็บสรุป: สูตร QUERY ดึงเวลาที่ดีที่สุดต่อด่าน/ผู้เล่น อัปเดตเองเมื่อมีคะแนนใหม่
  let sum = ss.getSheetByName('Leaderboard');
  if (!sum) sum = ss.insertSheet('Leaderboard');
  sum.clear();
  sum.getRange('A1').setValue('เวลาที่ดีที่สุดของผู้เล่นแต่ละคนในแต่ละด่าน (คำนวณจากแท็บ Scores)');
  sum.getRange('A2').setFormula(
    '=QUERY(Scores!A:J,"select J, D, C, min(E) where D is not null group by J, D, C order by J asc, D asc, min(E) asc label J \'ความยาก\', D \'ด่าน\', C \'ชื่อ\', min(E) \'เวลาดีที่สุด (ms)\'",1)');
  sum.getRange('A1').setFontWeight('bold');
  sum.setColumnWidths(1, 3, 160);

  // ลบแท็บเริ่มต้นที่ว่างอยู่
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('แผ่น1') || ss.getSheetByName('ชีต1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  Logger.log('ตั้งค่าเสร็จ (แท็บ: ' + ss.getSheets().map(s => s.getName()).join(', ') + '): ' + ss.getUrl());
}

// ================================================================
// HTTP HANDLERS
// ================================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    switch (p.action) {
      case 'ping':        return json_({ ok: true, time: new Date().toISOString(), serverTime: Date.now() });
      case 'leaderboard': return json_(leaderboard_(Number(p.level) || 1, Math.min(50, Number(p.limit) || 10), cleanDiff_(p.difficulty)));
      case 'loadPlayer':  return json_(loadPlayer_(String(p.playerId || '')));
      case 'mpRoom':      return json_(mpRoom_(p));
      case 'ghost':       return json_(getGhost_(Number(p.level) || 1, String(p.playerId || ''), cleanDiff_(p.difficulty)));
      case 'adminCheck':  return json_(adminCheck_(String(p.token || '')));
      default:            return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'invalid JSON' }); }

  // mpSync ถูกเรียกถี่มาก (ทุก ~0.8 วินาทีต่อคน) และแต่ละคนเขียนคีย์ของตัวเอง จึงไม่ต้องล็อกทั้งสคริปต์
  if (body.action === 'mpSync') {
    try { return json_(mpSync_(body)); }
    catch (err) { return json_({ ok: false, error: String(err && err.message || err) }); }
  }

  // ล็อกกันเขียนชนกันเมื่อมีผู้เล่นส่งพร้อมกัน
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return json_({ ok: false, error: 'server busy' });
  try {
    switch (body.action) {
      case 'submitScore': return json_(submitScore_(body));
      case 'savePlayer':  return json_(savePlayer_(body.save));
      case 'saveGhost':   return json_(saveGhost_(body));
      case 'adminLogin':  return json_(adminLogin_(body));
      case 'mpCreate':    return json_(mpCreate_(body));
      case 'mpJoin':      return json_(mpJoin_(body));
      case 'mpLeave':     return json_(mpLeave_(body));
      case 'mpReady':     return json_(mpReady_(body));
      case 'mpLevel':     return json_(mpLevel_(body));
      case 'mpStart':     return json_(mpStart_(body));
      default:            return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
// ACTIONS
// ================================================================
function submitScore_(b) {
  const level = Number(b.level), timeMs = Math.round(Number(b.timeMs));
  if (!(level >= 1 && level <= MAX_LEVEL)) return { ok: false, error: 'bad level' };
  if (!(timeMs >= (MIN_TIME_MS[level] || 5000)) || timeMs > 30 * 60 * 1000) return { ok: false, error: 'bad time' };
  const playerId = cleanId_(b.playerId);
  if (!playerId) return { ok: false, error: 'missing playerId' };

  const sh = getSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), 'Scores');
  sh.appendRow([
    new Date(), playerId, cleanText_(b.name, 20), level, timeMs, fmtTime_(timeMs),
    clampInt_(b.stars, 0, 3), cleanText_(b.tractor, 12), clampInt_(b.coinsEarned, 0, 100000), cleanDiff_(b.difficulty),
  ]);
  return { ok: true, rank: rankOf_(level, playerId, cleanDiff_(b.difficulty)) };
}

function leaderboard_(level, limit, diff) {
  diff = diff || 'normal';
  const sh = getSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), 'Scores');
  const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS.Scores.length).getValues() : [];
  const best = {};   // เก็บเวลาดีที่สุดคนละ 1 แถว
  rows.forEach(r => {
    if (Number(r[3]) !== level || (String(r[9] || 'normal')) !== diff) return;   // แถวเก่าที่ไม่มีระดับ = ปกติ
    const id = r[1], t = Number(r[4]);
    if (!best[id] || t < best[id].timeMs) best[id] = { playerId: id, name: r[2], timeMs: t, stars: r[6], tractor: r[7] };
  });
  const list = Object.keys(best).map(k => best[k]).sort((a, b) => a.timeMs - b.timeMs).slice(0, limit);
  const ghosts = ghostIndex_(level, diff);
  list.forEach(r => r.hasGhost = !!ghosts[r.playerId]);
  return { ok: true, level, difficulty: diff, rows: list };
}

function rankOf_(level, playerId, diff) {
  const all = leaderboard_(level, 1000, diff).rows;
  const i = all.findIndex(r => r.playerId === playerId);
  return i < 0 ? null : i + 1;
}

function savePlayer_(save) {
  if (!save || typeof save !== 'object') return { ok: false, error: 'missing save' };
  const id = cleanId_(save.playerId);
  if (!id) return { ok: false, error: 'missing playerId' };
  const sh = getSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), 'Players');
  const row = [
    id, cleanText_(save.name, 20), clampInt_(save.coins, 0, 1e9), clampInt_(save.unlocked, 1, MAX_LEVEL),
    cleanText_(save.selected, 12), (save.owned || []).join(','), JSON.stringify(save.upgrades || {}),
    JSON.stringify(save.best || {}), new Date(),
    JSON.stringify({ owned: (save.gadgets || []).map(String).slice(0, 20), equipped: (save.equipped || []).map(String).slice(0, 4) }),
  ];
  const r = findRow_(sh, id);
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  if (BACKUP_TO_DRIVE) backupJson_(id, save);
  return { ok: true };
}

function loadPlayer_(playerId) {
  const id = cleanId_(playerId);
  if (!id) return { ok: false, error: 'missing playerId' };
  const sh = getSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), 'Players');
  const r = findRow_(sh, id);
  if (!r) return { ok: false, error: 'not found' };
  const v = sh.getRange(r, 1, 1, SHEETS.Players.length).getValues()[0];
  return { ok: true, save: {
    playerId: v[0], name: v[1], coins: Number(v[2]), unlocked: Number(v[3]), selected: v[4],
    owned: String(v[5]).split(',').filter(String), upgrades: safeParse_(v[6], {}), best: safeParse_(v[7], {}),
    gadgets: (safeParse_(v[9], {}).owned || []), equipped: (safeParse_(v[9], {}).equipped || []),
  } };
}

// เขียนทับไฟล์ save_<id>.json เดิมในโฟลเดอร์ ถ้าไม่มีจึงสร้างใหม่
function backupJson_(id, save) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const name = 'save_' + id + '.json', content = JSON.stringify(save, null, 2);
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(content);
  else folder.createFile(name, content, MimeType.PLAIN_TEXT);
}


// ================================================================
// ผู้ดูแล: ตรวจรหัสที่ฝั่งเซิร์ฟเวอร์ (รหัสไม่อยู่ในโค้ดเกม) + ล็อกเมื่อใส่ผิดหลายครั้ง
// ================================================================
const ADMIN_MAX_FAIL = 8, ADMIN_LOCK_SEC = 900, ADMIN_TOKEN_SEC = 43200;
function adminLogin_(b) {
  const pin = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!pin) return { ok: false, error: 'no pin' };
  const c = cache_(), fails = Number(c.get('adm_fail') || 0);
  if (fails >= ADMIN_MAX_FAIL) return { ok: false, error: 'locked' };
  const given = String(b.pin || '');
  // เทียบทุกตัวอักษร (ไม่หยุดกลางทาง) ลดการเดารหัสจากเวลาตอบกลับ
  let diff = given.length ^ pin.length;
  for (let i = 0; i < Math.max(given.length, pin.length); i++) diff |= (given.charCodeAt(i) || 0) ^ (pin.charCodeAt(i) || 0);
  if (diff !== 0) { c.put('adm_fail', String(fails + 1), ADMIN_LOCK_SEC); Utilities.sleep(800); return { ok: false, error: 'bad pin' }; }
  c.remove('adm_fail');
  const token = Utilities.getUuid().replace(/-/g, '');
  c.put('adm_' + token, '1', ADMIN_TOKEN_SEC);
  return { ok: true, token, expiresIn: ADMIN_TOKEN_SEC };
}
function adminCheck_(token) {
  token = String(token).replace(/[^a-f0-9]/g, '');
  return token && cache_().get('adm_' + token) ? { ok: true } : { ok: false, error: 'expired' };
}

// ================================================================
// รถผี (GHOST) – เก็บรอบที่เร็วที่สุดของแต่ละคนต่อด่าน
// data = "t,x,y,a;t,x,y,a;..." (t = 1/100 วินาที, a = 1/100 เรเดียน, จำนวนเต็มทั้งหมด)
// ================================================================
function saveGhost_(b) {
  const level = Number(b.level), timeMs = Math.round(Number(b.timeMs));
  if (!(level >= 1 && level <= MAX_LEVEL)) return { ok: false, error: 'bad level' };
  if (!(timeMs >= (MIN_TIME_MS[level] || 5000)) || timeMs > 30 * 60 * 1000) return { ok: false, error: 'bad time' };
  const id = cleanId_(b.playerId);
  if (!id) return { ok: false, error: 'missing playerId' };
  const data = String(b.data || '');
  if (!data || data.length > GHOST_MAX_CHARS || !/^[-0-9,;]+$/.test(data)) return { ok: false, error: 'bad ghost data' };

  const diff = cleanDiff_(b.difficulty);
  const sh = getSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), 'Ghosts');
  const row = [id, level, cleanText_(b.name, 20), timeMs, cleanText_(b.tractor, 12), data, new Date(), diff];
  const r = findGhostRow_(sh, id, level, diff);
  if (r) {
    const old = Number(sh.getRange(r, 4).getValue());
    if (old && old <= timeMs) return { ok: true, kept: true };   // ของเดิมเร็วกว่า เก็บไว้
    sh.getRange(r, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }
  return { ok: true };
}

function getGhost_(level, playerId, diff) {
  const id = cleanId_(playerId);
  if (!id) return { ok: false, error: 'missing playerId' };
  const sh = getSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), 'Ghosts');
  const r = findGhostRow_(sh, id, level, diff || 'normal');
  if (!r) return { ok: false, error: 'not found' };
  const v = sh.getRange(r, 1, 1, SHEETS.Ghosts.length).getValues()[0];
  return { ok: true, ghost: { playerId: v[0], level: Number(v[1]), name: v[2], timeMs: Number(v[3]), tractor: v[4], data: String(v[5]) } };
}

function findGhostRow_(sh, id, level, diff) {
  if (sh.getLastRow() < 2) return 0;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
  for (let i = 0; i < v.length; i++) if (v[i][0] === id && Number(v[i][1]) === level && String(v[i][7] || 'normal') === diff) return i + 2;
  return 0;
}

function ghostIndex_(level, diff) {
  const sh = getSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), 'Ghosts');
  const out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().forEach(r => { if (Number(r[1]) === level && String(r[7] || 'normal') === (diff || 'normal')) out[r[0]] = true; });
  return out;
}

// ================================================================
// ผู้เล่นหลายคน (ห้องแข่ง)
// - ข้อมูลห้อง:     cache 'room_<CODE>'
// - สัญญาณมีชีวิต:  cache 'hb_<CODE>_<playerId>'           (เวลาที่ติดต่อล่าสุด)
// - ตำแหน่งรถ:     cache 'pos_<CODE>_<raceId>_<playerId>' (ตัวอย่างตำแหน่งล่าสุด + เวลาเข้าเส้นชัย)
// - ผลแข่ง:        แท็บ Races (เขียนครั้งเดียวเมื่อทุกคนจบ/หลุด)
// ================================================================
function cache_() { return CacheService.getScriptCache(); }
function getRoom_(code) { const s = cache_().get('room_' + code); return s ? JSON.parse(s) : null; }
function putRoom_(room) { cache_().put('room_' + room.code, JSON.stringify(room), MP.TTL); }
function cleanCode_(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
function heartbeat_(code, id) { cache_().put('hb_' + code + '_' + id, String(Date.now()), MP.TTL); }
function posKey_(code, raceId, id) { return 'pos_' + code + '_' + raceId + '_' + id; }

function onlineMap_(room) {
  const ids = Object.keys(room.players);
  const got = cache_().getAll(ids.map(id => 'hb_' + room.code + '_' + id));
  const now = Date.now(), m = {};
  ids.forEach(id => { m[id] = now - Number(got['hb_' + room.code + '_' + id] || 0) < MP.STALE_MS; });
  return m;
}

function roomView_(room) {
  const on = onlineMap_(room);
  const players = Object.keys(room.players).map(id => {
    const p = room.players[id];
    return { id, name: p.name, tractor: p.tractor, gear: p.gear || '', ready: !!p.ready, color: p.color, joinedAt: p.joinedAt, online: !!on[id] };
  }).sort((a, b) => a.joinedAt - b.joinedAt);
  return { code: room.code, host: room.host, level: room.level, state: room.state,
    raceId: room.raceId, startAt: room.startAt, racers: room.racers || [], players };
}

function mpReply_(room, extra) {
  return Object.assign({ ok: true, serverTime: Date.now(), room: room ? roomView_(room) : null }, extra || {});
}

// ลบคนที่หลุดไปนานออกจากห้อง (เรียกตอนมีการเปลี่ยนแปลงห้อง ภายใต้ล็อก)
function pruneRoom_(room) {
  const on = onlineMap_(room);
  Object.keys(room.players).forEach(id => { if (!on[id] && id !== room.host) delete room.players[id]; });
  if (!room.players[room.host]) pickHost_(room);
}
function pickHost_(room) {
  const ids = Object.keys(room.players).sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt);
  room.host = ids[0] || '';
}
function freeColor_(room) {
  const used = Object.keys(room.players).map(id => room.players[id].color);
  for (let c = 0; c < MP.MAX_PLAYERS; c++) if (used.indexOf(c) < 0) return c;
  return 0;
}

function mpRoom_(p) {
  const code = cleanCode_(p.code), id = cleanId_(p.playerId);
  const room = getRoom_(code);
  if (!room) return { ok: false, error: 'room not found', serverTime: Date.now() };
  if (id && room.players[id]) heartbeat_(code, id);
  return mpReply_(room);
}

function mpCreate_(b) {
  const id = cleanId_(b.playerId);
  if (!id) return { ok: false, error: 'missing playerId' };
  let code = '';
  for (let tries = 0; tries < 20 && !code; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    if (!getRoom_(c)) code = c;
  }
  if (!code) return { ok: false, error: 'สร้างรหัสห้องไม่ได้ ลองใหม่อีกครั้ง' };
  const now = Date.now();
  const room = { code, host: id, level: clampInt_(b.level, 1, MAX_LEVEL), state: 'lobby', raceId: 0, startAt: 0, racers: [], created: now,
    players: {} };
  room.players[id] = { name: cleanText_(b.name, 20), tractor: cleanText_(b.tractor, 12), gear: cleanGear_(b.gear), ready: true, joinedAt: now, color: 0 };
  putRoom_(room); heartbeat_(code, id);
  return mpReply_(room);
}

function mpJoin_(b) {
  const code = cleanCode_(b.code), id = cleanId_(b.playerId);
  if (!id) return { ok: false, error: 'missing playerId' };
  const room = getRoom_(code);
  if (!room) return { ok: false, error: 'ไม่พบห้อง ' + code + ' ตรวจรหัสอีกครั้ง' };
  if (room.players[id]) {
    room.players[id].name = cleanText_(b.name, 20);
    room.players[id].tractor = cleanText_(b.tractor, 12);
    room.players[id].gear = cleanGear_(b.gear);
  } else {
    pruneRoom_(room);
    if (Object.keys(room.players).length >= MP.MAX_PLAYERS) return { ok: false, error: 'ห้องเต็มแล้ว (สูงสุด ' + MP.MAX_PLAYERS + ' คน)' };
    room.players[id] = { name: cleanText_(b.name, 20), tractor: cleanText_(b.tractor, 12), gear: cleanGear_(b.gear), ready: false, joinedAt: Date.now(), color: freeColor_(room) };
  }
  putRoom_(room); heartbeat_(code, id);
  return mpReply_(room);
}

function mpLeave_(b) {
  const code = cleanCode_(b.code), id = cleanId_(b.playerId);
  const room = getRoom_(code);
  if (!room || !room.players[id]) return { ok: true };
  delete room.players[id];
  cache_().remove('hb_' + code + '_' + id);
  if (!Object.keys(room.players).length) { cache_().remove('room_' + code); return { ok: true }; }
  if (room.host === id) pickHost_(room);
  putRoom_(room);
  return { ok: true };
}

function mpReady_(b) {
  const code = cleanCode_(b.code), id = cleanId_(b.playerId);
  const room = getRoom_(code);
  if (!room || !room.players[id]) return { ok: false, error: 'room not found' };
  room.players[id].ready = !!b.ready;
  if (b.tractor) room.players[id].tractor = cleanText_(b.tractor, 12);
  if (b.gear != null) room.players[id].gear = cleanGear_(b.gear);
  putRoom_(room); heartbeat_(code, id);
  return mpReply_(room);
}

function mpLevel_(b) {
  const code = cleanCode_(b.code), id = cleanId_(b.playerId);
  const room = getRoom_(code);
  if (!room || !room.players[id]) return { ok: false, error: 'room not found' };
  if (room.host !== id) return { ok: false, error: 'เฉพาะเจ้าของห้องเท่านั้น' };
  if (room.state === 'race') return { ok: false, error: 'กำลังแข่งอยู่' };
  room.level = clampInt_(b.level, 1, MAX_LEVEL);
  putRoom_(room);
  return mpReply_(room);
}

function mpStart_(b) {
  const code = cleanCode_(b.code), id = cleanId_(b.playerId);
  const room = getRoom_(code);
  if (!room || !room.players[id]) return { ok: false, error: 'room not found' };
  if (room.host !== id) return { ok: false, error: 'เฉพาะเจ้าของห้องเท่านั้น' };
  const now = Date.now();
  // กันห้องค้างสถานะแข่ง: เริ่มใหม่ได้ถ้ารอบเดิมเลยมา 5 นาทีแล้ว
  if (room.state === 'race' && now < room.startAt + 5 * 60 * 1000) return { ok: false, error: 'รอบนี้ยังแข่งไม่จบ' };
  heartbeat_(code, id);
  pruneRoom_(room);
  const on = onlineMap_(room);
  const racers = Object.keys(room.players).filter(pid => on[pid] || pid === id);
  const notReady = racers.filter(pid => pid !== room.host && !room.players[pid].ready);
  if (notReady.length) return { ok: false, error: 'ยังมีผู้เล่นที่ไม่พร้อม ' + notReady.length + ' คน' };
  room.state = 'race';
  room.raceId = (room.raceId || 0) + 1;
  room.startAt = now + MP.START_DELAY_MS;
  room.racers = racers;
  racers.forEach(pid => { if (pid !== room.host) room.players[pid].ready = false; });   // รอบหน้าต้องกดพร้อมใหม่
  putRoom_(room);
  return mpReply_(room);
}

function mpSync_(b) {
  const code = cleanCode_(b.code), id = cleanId_(b.playerId), raceId = Number(b.raceId);
  const room = getRoom_(code);
  if (!room) return { ok: false, error: 'room not found', serverTime: Date.now() };
  if (!room.players[id] || (room.racers || []).indexOf(id) < 0) return { ok: false, error: 'not in race', serverTime: Date.now() };
  heartbeat_(code, id);

  const now = Date.now();
  const racers = room.racers || [];
  const keys = racers.map(pid => posKey_(code, raceId, pid));
  const got = cache_().getAll(keys);
  const mineKey = posKey_(code, raceId, id);
  const mine = got[mineKey] ? JSON.parse(got[mineKey]) : { s: [], fin: null, dnf: false };

  // รวมตำแหน่งใหม่เข้ากับของเดิม (เก็บเฉพาะล่าสุด)
  const incoming = Array.isArray(b.s) ? b.s.slice(-200) : [];
  const last = mine.s.length ? mine.s[mine.s.length - 1][0] : -1;
  incoming.forEach(p => {
    if (!Array.isArray(p) || p.length !== 4) return;
    const q = p.map(Number);
    if (q.every(isFinite) && q[0] > last) mine.s.push([q[0], Math.round(q[1]), Math.round(q[2]), Math.round(q[3] * 100) / 100]);
  });
  mine.s = mine.s.slice(-MP.KEEP_SAMPLES);
  const fin = Math.round(Number(b.fin));
  if (mine.fin == null && fin >= (MIN_TIME_MS[room.level] || 5000) && fin < 30 * 60 * 1000) mine.fin = fin;   // ตั้งได้ครั้งเดียว
  if (b.dnf && mine.fin == null) mine.dnf = true;
  mine.t = now;
  cache_().put(mineKey, JSON.stringify(mine), MP.TTL);
  got[mineKey] = JSON.stringify(mine);

  // สถานะทุกคน
  const others = [];
  let done = room.state === 'race' && room.raceId === raceId;
  const standings = [];
  racers.forEach(pid => {
    const d = got[posKey_(code, raceId, pid)] ? JSON.parse(got[posKey_(code, raceId, pid)]) : null;
    const stale = d ? now - d.t > MP.STALE_MS : now > room.startAt + MP.STALE_MS;
    const finished = d && d.fin != null;
    if (!finished && !(d && d.dnf) && !stale) done = false;
    standings.push({ pid, fin: finished ? d.fin : null, status: finished ? 'finish' : (d && d.dnf) ? 'dnf' : stale ? 'disconnected' : 'racing' });
    if (pid !== id) others.push({ id: pid, s: d ? d.s : [], fin: finished ? d.fin : null, dnf: !!(d && d.dnf), stale });
  });

  if (done) finalizeRace_(code, raceId, standings);
  const r2 = done ? getRoom_(code) || room : room;
  return { ok: true, serverTime: now, state: r2.raceId === raceId ? r2.state : 'lobby', done: done || r2.raceId !== raceId || r2.state !== 'race', others };
}

// ทุกคนจบ/หลุดแล้ว → บันทึกผลลงแท็บ Races ครั้งเดียว แล้วเปลี่ยนห้องเป็น 'done'
function finalizeRace_(code, raceId, standings) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const room = getRoom_(code);
    if (!room || room.state !== 'race' || room.raceId !== raceId) return;
    standings.sort((a, b) => (a.fin == null ? 1e12 : a.fin) - (b.fin == null ? 1e12 : b.fin));
    const sh = getSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), 'Races');
    const ts = new Date();
    const rows = standings.map((s, i) => {
      const p = room.players[s.pid] || { name: '', tractor: '' };
      return [ts, code, raceId, room.level, s.fin != null ? i + 1 : '', s.pid, p.name, p.tractor,
        s.fin != null ? s.fin : '', s.fin != null ? fmtTime_(s.fin) : '', s.status];
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    room.state = 'done';
    putRoom_(room);
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
// HELPERS
// ================================================================
function getSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    const head = SHEETS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#F4C534');
    sh.setFrozenRows(1);
  }
  return sh;
}
function findRow_(sh, id) {
  if (sh.getLastRow() < 2) return 0;
  const hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function cleanId_(s) { return String(s || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40); }
function cleanText_(s, n) { return String(s == null ? '' : s).replace(/^[=+\-@]/, "'").slice(0, n); }   // กันสูตรแปลกปลอม (CSV/formula injection)
function cleanDiff_(s) { s = String(s || 'normal'); return s === 'easy' || s === 'hard' ? s : 'normal'; }
function cleanGear_(s) { return String(s || '').replace(/[^a-z,]/g, '').slice(0, 40); }   // อุปกรณ์เสริมที่ติดตั้ง เช่น "jet,wing"
function clampInt_(v, a, b) { v = Math.round(Number(v) || 0); return Math.max(a, Math.min(b, v)); }
function safeParse_(s, d) { try { return JSON.parse(s); } catch (e) { return d; } }
function fmtTime_(ms) { const t = ms / 1000, m = Math.floor(t / 60); return m + ':' + (t - m * 60).toFixed(2).padStart(5, '0'); }

// ทดสอบจาก Editor: เลือกฟังก์ชันนี้แล้ว Run ดูผลใน Execution log
function testLocal() {
  Logger.log(submitScore_({ playerId: 'p_test', name: 'ทดสอบ', level: 1, timeMs: 25340, stars: 2, tractor: 'tp25', coinsEarned: 300 }));
  Logger.log(JSON.stringify(leaderboard_(1, 5)));
}

// ทดสอบระบบห้องแข่งจาก Editor (จำลองผู้เล่น 2 คน)
function testMultiplayer() {
  const a = mpCreate_({ playerId: 'p_hostA', name: 'เจ้าของห้อง', tractor: 'tp25', level: 1 });
  Logger.log('สร้างห้อง: ' + a.room.code);
  const code = a.room.code;
  Logger.log(JSON.stringify(mpJoin_({ code, playerId: 'p_guestB', name: 'เพื่อน', tractor: 'kl40' }).room.players));
  mpReady_({ code, playerId: 'p_guestB', ready: true });
  const s = mpStart_({ code, playerId: 'p_hostA' });
  Logger.log('เริ่มแข่ง raceId=' + s.room.raceId + ' racers=' + s.room.racers);
  mpSync_({ code, playerId: 'p_hostA', raceId: s.room.raceId, s: [[0.1, 200, 0, 0], [0.2, 210, 0, 0]], fin: 25000 });
  const r = mpSync_({ code, playerId: 'p_guestB', raceId: s.room.raceId, s: [[0.1, 200, 0, 0]], fin: 27000 });
  Logger.log('จบ: ' + r.done + ' สถานะห้อง: ' + r.state + ' (ดูแท็บ Races)');
  mpLeave_({ code, playerId: 'p_guestB' }); mpLeave_({ code, playerId: 'p_hostA' });
}