// ============================================================
// 10X VAs — Telegram Bot v2.0 (Redis Persistent Edition)
// Node.js + Express — Railway Deployment
// ============================================================

const express = require('express');
const axios   = require('axios');
const redis   = require('redis');
const app     = express();
app.use(express.json());

// ============================================================
// REDIS CONNECTION (Persistent Notepad)
// ============================================================
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.log('Redis Error:', err));
redisClient.connect().then(() => console.log("Connected to Redis! 🚀"));

// ============================================================
// CONFIG
// ============================================================
const TOKEN        = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT = process.env.ALLOWED_CHAT;
const TOPIC_ID     = process.env.TOPIC_ID;
const WEBHOOK_URL  = process.env.WEBHOOK_URL;
const SHEET_ID     = process.env.SHEET_ID;
const GOOGLE_SA    = process.env.GOOGLE_SA ? JSON.parse(process.env.GOOGLE_SA) : null;
const PORT         = process.env.PORT || 8080;

const GRACE_MINS   = 4;
const EARLY_LIMIT  = 30; 
const BBL_MINS     = 90;
const LUNCH_MINS   = 60;
const MAX_HRS       = 8;
const TARGET_HRS    = 80;  
const LEADER_MAX_HRS = 90; 
const CUTOFF_START_VA_MS = new Date('2026-05-02T09:00:00+08:00').getTime();
const CUTOFF_DAYS = 14;

// ============================================================
// ROSTER
// ============================================================
const ROSTER = {
  '2009869833': { name:'Queency', role:'VA',     days:[1,1,1,1,1,0,0], start:'8:00 PM',  end:'5:00 AM' },
  '7831137596': { name:'Maku',    role:'VA',     days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' },
  '1802251672': { name:'Lovely',  role:'VA',     days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' },
  '8393347347': { name:'Mary',    role:'VA',     days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' },
  '5359971666': { name:'Pam',     role:'VA',     days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' },
  '6012486581': { name:'Cris',    role:'VA',     days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' },
  '5660256653': { name:'Jude',    role:'VA',     days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'6:00 AM' },
  '7207758648': { name:'Noreen',  role:'VA',     days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'8:00 AM' },
  '8070441816': { name:'John',    role:'VA',     days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '6705167382': { name:'Cha',     role:'VA',     days:[1,1,1,1,0,0,1], start:'12:00 AM', end:'9:00 AM' },
  '7148499363': { name:'Alexis',  role:'VA',     days:[0,0,1,1,1,1,1], start:'12:00 AM', end:'9:00 AM' },
  '7514392042': { name:'Kate',    role:'VA',     days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '5685031197': { name:'Kat',     role:'UYP',    days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '6132223983': { name:'Yuqi',    role:'UYP',    days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '6088627916': { name:'Nina',    role:'UYP',    days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '8044736892': { name:'Bert',    role:'Leader', days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '7240390530': { name:'Moon',    role:'Leader', days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '7830367843': { name:'Nell',    role:'Leader', days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '2018117745': { name:'Gab',     role:'Leader', days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' },
  '8781315526': { name:'Alice',   role:'VA',     days:[0,0,0,1,0,0,0], start:'4:00 PM',  end:'5:55 PM' },
};

// ============================================================
// STATE HELPERS (Now using Redis)
// ============================================================
async function getState(uid) {
    const data = await redisClient.get(`state:${uid}`);
    return data ? JSON.parse(data) : { status: 'out' };
}

async function setState(uid, s) {
    await redisClient.set(`state:${uid}`, JSON.stringify(s));
}

async function clearState(uid) {
    await redisClient.del(`state:${uid}`);
}

async function getCutoffMemory(uid) {
    const data = await redisClient.get(`cutoff:${uid}`);
    return data ? JSON.parse(data) : { hours: 0, ot: 0 };
}

async function setCutoffMemory(uid, c) {
    await redisClient.set(`cutoff:${uid}`, JSON.stringify(c));
}

// ============================================================
// UTILITIES
// ============================================================
function manilaTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
}

function fmtTime(date) {
  return date.toLocaleString('en-US', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit', hour12:true });
}

function fmtDate(date) {
  return date.toLocaleString('en-US', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' });
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h + ':' + String(m).padStart(2,'0');
}

function minsBetween(a, b) { return Math.round((b - a) / 60000); }
function msBetween(a, b)   { return b - a; }

function to24h(timeStr) {
  const [time, period] = timeStr.trim().split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function getManilaDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone:'Asia/Manila' });
}

function getShiftWindow(sched, dateStr) {
  const start = new Date(`${dateStr}T${to24h(sched.start)}:00+08:00`);
  let   end   = new Date(`${dateStr}T${to24h(sched.end)}:00+08:00`);
  if (end <= start) end = new Date(end.getTime() + 86400000);
  return { start, end };
}

function getSchedule(uid, manila) {
  const r = ROSTER[uid];
  if (!r) return null;
  const dow = manila.getDay();
  const idx = dow === 0 ? 6 : dow - 1;
  return r.days[idx] ? r : null;
}

function isWithinShift(uid, now) {
  const manila = manilaTime();
  const sched  = getSchedule(uid, manila);
  if (!sched) return false;
  const dateStr = getManilaDateStr(manila);
  const win = getShiftWindow(sched, dateStr);
  return now >= win.start && now <= win.end;
}

function getCutoffDates(role) {
  const now = new Date();
  if (role === 'UYP') {
    const s = getManilaDateStr(now).split('-');
    const y = parseInt(s[0]), m = parseInt(s[1]), d = parseInt(s[2]);
    const p = n => String(n).padStart(2,'0');
    if (d <= 15) return {
      start: new Date(`${y}-${p(m)}-01T09:00:00+08:00`),
      end:   new Date(`${y}-${p(m)}-15T09:00:00+08:00`),
    };
    const last = new Date(y, m, 0).getDate();
    return {
      start: new Date(`${y}-${p(m)}-16T09:00:00+08:00`),
      end:   new Date(`${y}-${p(m)}-${p(last)}T09:00:00+08:00`),
    };
  }
  const anchor   = new Date(CUTOFF_START_VA_MS);
  const interval = CUTOFF_DAYS * 86400000;
  const n        = Math.floor((now - anchor) / interval);
  const start    = new Date(anchor.getTime() + n * interval);
  return { start, end: new Date(start.getTime() + interval) };
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendMsg(text, chatId, topicId) {
  try {
    const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (topicId) payload.message_thread_id = parseInt(topicId);
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, payload);
  } catch(e) { console.error('sendMsg:', e.message); }
}

// ============================================================
// GOOGLE SHEETS
// ============================================================
let googleToken = null;
let googleTokenExpiry = 0;

async function getGoogleToken() {
  if (googleToken && Date.now() < googleTokenExpiry) return googleToken;
  if (!GOOGLE_SA) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const header  = Buffer.from(JSON.stringify({ alg:'RS256', typ:'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: GOOGLE_SA.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })).toString('base64url');

    const crypto = require('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(GOOGLE_SA.private_key, 'base64url');
    const jwt = `${header}.${payload}.${sig}`;

    const res = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }));
    googleToken = res.data.access_token;
    googleTokenExpiry = Date.now() + 3500000;
    return googleToken;
  } catch(e) {
    console.error('getGoogleToken:', e.message);
    return null;
  }
}

async function sheetsAppend(range, values) {
  if (!SHEET_ID || !GOOGLE_SA) return;
  try {
    const token = await getGoogleToken();
    if (!token) { console.error('sheetsAppend: no token'); return; }
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append`,
      { values },
      { params: { valueInputOption: 'USER_ENTERED' }, headers: { Authorization: `Bearer ${token}` } }
    );
  } catch(e) {
    console.error('sheetsAppend error:', range, e.response?.data || e.message);
  }
}

async function sheetsGet(range) {
  if (!SHEET_ID || !GOOGLE_SA) return [];
  try {
    const token = await getGoogleToken();
    if (!token) return [];
    const res = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data.values || [];
  } catch(e) {
    if (!e.message.includes('400') && !e.message.includes('404')) {
      console.error('sheetsGet:', e.message);
    }
    return [];
  }
}

async function sheetsUpdate(range, values) {
  if (!SHEET_ID) return;
  try {
    const token = await getGoogleToken();
    if (!token) return;
    await axios.put(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
      { values },
      { params: { valueInputOption: 'USER_ENTERED' }, headers: { Authorization: `Bearer ${token}` } }
    );
  } catch(e) { console.error('sheetsUpdate:', e.message); }
}

async function logAction(uid, name, action, now) {
  try {
    const token = await getGoogleToken();
    if (!token) return;
    const range = encodeURIComponent("'Telegram Logs'!A:E");
    await axios.post(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append`,
      { values: [[fmtDate(now), fmtTime(now), action, name, uid]] },
      { params: { valueInputOption: 'USER_ENTERED' }, headers: { Authorization: `Bearer ${token}` } }
    );
  } catch(e) { console.error('logAction error:', e.message); }
}

// ============================================================
// USER LOGS
// ============================================================
const USER_COL_MAP = {};
const COLS_PER_USER = 4;

async function initUserLogMap() {
  if (!SHEET_ID || !GOOGLE_SA) return;
  try {
    const row1 = await sheetsGet("'User Logs'!1:1");
    if (!row1 || !row1[0]) return;
    const headers = row1[0];
    for (let i = 0; i < headers.length; i += COLS_PER_USER) {
      const name = headers[i];
      if (!name) continue;
      const uid = Object.keys(ROSTER).find(k => ROSTER[k].name === name);
      if (uid) USER_COL_MAP[uid] = i;
    }
  } catch(e) { console.error('initUserLogMap:', e.message); }
}

function colLetter(idx) {
  let col = ''; let n = idx + 1;
  while (n > 0) { const r = (n - 1) % 26; col = String.fromCharCode(65 + r) + col; n = Math.floor((n - 1) / 26); }
  return col;
}

async function getUserLogCol(uid) {
  if (USER_COL_MAP[uid] !== undefined) return USER_COL_MAP[uid];
  await initUserLogMap();
  return USER_COL_MAP[uid];
}

async function addUserLogRow(uid, activity, startTime) {
  const col = await getUserLogCol(uid);
  if (col === undefined) return null;
  const colA = colLetter(col);
  const data = await sheetsGet(`'User Logs'!${colA}3:${colA}1000`);
  const nextRow = 3 + (data ? data.length : 0);
  const actCol   = colLetter(col);
  const startCol = colLetter(col + 1);
  await sheetsUpdate(`'User Logs'!${actCol}${nextRow}:${startCol}${nextRow}`, [[activity, fmtTime(startTime)]]);
  return nextRow;
}

async function closeUserLogRow(uid, activity, endTime, startTime) {
  const col = await getUserLogCol(uid);
  if (col === undefined) return;
  const actCol = colLetter(col);
  const data   = await sheetsGet(`'User Logs'!${actCol}3:${actCol}1000`);
  if (!data) return;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][0] === activity) {
      const rowNum    = 3 + i;
      const endCol    = colLetter(col + 2);
      const durCol    = colLetter(col + 3);
      const duration = fmtDuration(msBetween(startTime, endTime));
      await sheetsUpdate(`'User Logs'!${endCol}${rowNum}:${durCol}${rowNum}`, [[fmtTime(endTime), duration]]);
      return;
    }
  }
}

async function updateLeaderShiftRow(uid, endTime) {
  const col = await getUserLogCol(uid);
  if (col === undefined) return;
  const actCol = colLetter(col);
  const data   = await sheetsGet(`'User Logs'!${actCol}3:${actCol}1000`);
  if (!data) return;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][0] === 'Shift') {
      const rowNum    = 3 + i;
      const endCol = colLetter(col + 2);
      const durCol = colLetter(col + 3);
      let durStr = '';
      const state = await getState(uid);
      if (state.loginTime) {
        durStr = fmtDuration(msBetween(new Date(state.loginTime), endTime));
      }
      await sheetsUpdate(`'User Logs'!${endCol}${rowNum}:${durCol}${rowNum}`, [[fmtTime(endTime), durStr]]);
      return;
    }
  }
}

// ============================================================
// CUTOFF COUNTER
// ============================================================
async function getCutoffHours(uid) {
  const data = await sheetsGet("'Cutoff Counter'!A:H");
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === uid) {
      return { hours: parseFloat(data[i][5]) || 0, ot: parseFloat(data[i][6]) || 0, row: i + 1 };
    }
  }
  return { hours: 0, ot: 0, row: null };
}

async function addCutoffHours(uid, name, role, addHours, addOT) {
  let mem = await getCutoffMemory(uid);
  const newHours = Math.round((mem.hours + addHours) * 100) / 100;
  const newOT    = Math.round((mem.ot + (addOT||0)) * 100) / 100;
  
  if (role === 'Leader') {
    const combined = newHours + newOT;
    if (combined > LEADER_MAX_HRS) {
      mem.hours = Math.min(newHours, LEADER_MAX_HRS);
      mem.ot    = Math.max(0, LEADER_MAX_HRS - mem.hours);
    } else { mem.hours = newHours; mem.ot = newOT; }
  } else { mem.hours = newHours; mem.ot = newOT; }
  
  await setCutoffMemory(uid, mem);

  try {
    const current = await getCutoffHours(uid);
    const now     = new Date();
    const co      = getCutoffDates(role);
    if (current.row) {
      await sheetsUpdate(`'Cutoff Counter'!F${current.row}:H${current.row}`, [[
        Math.round((current.hours + addHours) * 100) / 100,
        Math.round((current.ot + (addOT||0)) * 100) / 100,
        fmtTime(now),
      ]]);
    } else {
      await sheetsAppend("'Cutoff Counter'!A:H", [[
        uid, name, role, fmtDate(co.start), fmtDate(co.end),
        Math.round(addHours * 100) / 100, Math.round((addOT||0) * 100) / 100, fmtTime(now),
      ]]);
    }
  } catch(e) { console.error('addCutoffHours error:', e.message); }
}

// ============================================================
// PAYABLE CALC
// ============================================================
function calcPayable(uid, state, logoutTime) {
  const role     = ROSTER[uid]?.role || 'VA';
  const isLeader = role === 'Leader';
  const login    = new Date(state.loginTime);
  const manila   = manilaTime();
  const sched    = getSchedule(uid, manila) || ROSTER[uid];
  const dateStr  = state.shiftDate || getManilaDateStr(manila);
  const win      = getShiftWindow(sched, dateStr);
  const effLogin  = login  > win.start ? login  : win.start;
  const effLogout = logoutTime < win.end ? logoutTime : win.end;
  let lateMs = Math.max(0, effLogin.getTime() - win.start.getTime());
  if (lateMs <= GRACE_MINS * 60000) lateMs = 0;
  let grossMs = Math.max(0, effLogout.getTime() - effLogin.getTime());
  const diffMins = minsBetween(win.start, win.end);
  const hasLunch = diffMins >= 510;
  let lunchMs = 0;
  if (hasLunch) lunchMs = state.bblUsed ? LUNCH_MINS * 60000 : (state.lunchUsedMs || 0);
  let netMs = Math.max(0, grossMs - lunchMs - (state.overbreakMs||0) - (state.overlunchMs||0) - lateMs);
  let hours = netMs / 3600000;
  if (!isLeader) hours = Math.min(hours, MAX_HRS);
  let ot = 0;
  if (role === 'Leader' && login < win.start) {
    const preShiftMs = win.start.getTime() - login.getTime();
    ot = Math.floor(preShiftMs / (30 * 60000)) * 0.5;
  }
  return { hours: Math.round(hours * 100) / 100, ot: Math.round(ot * 100) / 100 };
}

// ============================================================
// HANDLERS
// ============================================================
async function handleIn(uid, name) {
  const manila = manilaTime();
  const sched  = getSchedule(uid, manila);
  const state  = await getState(uid);
  const now    = new Date();
  if (state.status !== 'out' && !['holiday','absent','leave','vto'].includes(state.status)) {
    return `⚠️ Heads up, ${name} — you're already logged in!`;
  }
  if (!sched) return `📋 Hi ${name}, today doesn't seem to be a scheduled workday.`;
  const dateStr = getManilaDateStr(manila);
  const win     = getShiftWindow(sched, dateStr);
  const minsToShift = minsBetween(now, win.start);
  const minsLate    = minsBetween(win.start, now);
  const isLate        = minsLate > GRACE_MINS;
  const isVeryEarly   = minsToShift > EARLY_LIMIT;
  const isSlightEarly = minsToShift > 0 && minsToShift <= EARLY_LIMIT;

  await setState(uid, {
    status: (isVeryEarly || isSlightEarly) ? 'pre-shift' : 'in',
    loginTime: now.toISOString(),
    shiftDate: dateStr,
    shiftStart: win.start.toISOString(),
    breakUsed: 0, bblUsed: false, lunchUsed: false, lunchUsedMs: 0,
    overbreakMs: 0, overlunchMs: 0, breakStart: null, breakType: null,
    isLate: isLate, lateMs: isLate ? minsLate * 60000 : 0,
  });

  addUserLogRow(uid, 'Shift', now).catch(console.error);
  logAction(uid, name, 'in', now).catch(console.error);
  if (isVeryEarly) return `🌅 Log In confirmed — ${name}. You're early! Shift starts at ${fmtTime(win.start)}.`;
  if (isSlightEarly) return `✅ Log In confirmed — ${name}. Shift starts at ${fmtTime(win.start)}.`;
  if (isLate) return `⏰ Log In confirmed — ${name}. You're ${minsLate} minute(s) late.`;
  return `✅ Log In confirmed — ${name}. Have a great shift! 💪`;
}

async function handleOut(uid, name) {
  const state = await getState(uid);
  const now   = new Date();
  if (state.status === 'out') return `⚠️ ${name}, you're not logged in.`;

  if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) state.status = 'in';

  if (state.status !== 'in' && state.status !== 'pre-shift') {
    const bt = state.breakType;
    const allowed = bt==='bbl' ? BBL_MINS : bt==='lunch' ? LUNCH_MINS : bt==='30' ? 30 : 15;
    const actual = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
    const over = actual - allowed - GRACE_MINS;
    if (over > 0) {
        if (bt==='lunch'||bt==='bbl') state.overlunchMs=(state.overlunchMs||0)+over*60000;
        else state.overbreakMs=(state.overbreakMs||0)+over*60000;
    }
    const labels = {'15':'Break 15','30':'Break 30','lunch':'Lunch','bbl':'BBL'};
    if (bt && state.breakStart) closeUserLogRow(uid, labels[bt]||'Break', now, new Date(state.breakStart)).catch(console.error);
  }

  const result = state.loginTime ? calcPayable(uid, state, now) : { hours: 0, ot: 0 };
  const role   = ROSTER[uid]?.role || 'VA';
  if (role === 'Leader') updateLeaderShiftRow(uid, now).catch(console.error);
  else closeUserLogRow(uid, 'Shift', now, new Date(state.loginTime)).catch(console.error);

  await addCutoffHours(uid, name, role, result.hours, result.ot);
  await clearState(uid);
  return `👋 Log Out confirmed — ${name}. Today: <b>${result.hours.toFixed(2)}h${result.ot > 0 ? ` (+${result.ot.toFixed(2)}h OT)` : ''}</b>.`;
}

async function handleBreak(uid, name, breakType) {
  const state = await getState(uid);
  const now   = new Date();
  if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) state.status = 'in';
  if (state.status === 'out') return `⚠️ ${name}, login first!`;
  if (state.status !== 'in') return `⚠️ ${name}, already on break!`;

  if (breakType === '15' || breakType === '30') {
    if (state.bblUsed) return `⚠️ Already used BBL.`;
    if ((state.breakUsed||0) + (breakType==='15' ? 15 : 30) > 30) return `⚠️ Break limit reached.`;
  }
  if (breakType === 'bbl' && (state.bblUsed || (state.breakUsed||0) > 0)) return `⚠️ Break already used.`;
  if (breakType === 'lunch' && state.lunchUsed) return `⚠️ Lunch already taken.`;

  state.status = breakType; state.breakStart = now.toISOString(); state.breakType = breakType;
  await setState(uid, state);
  const labels = {'15':'Break 15','30':'Break 30','lunch':'Lunch','bbl':'BBL'};
  addUserLogRow(uid, labels[breakType]||breakType, now).catch(console.error);
  const allowed = breakType==='bbl' ? BBL_MINS : breakType==='lunch' ? LUNCH_MINS : breakType==='30' ? 30 : 15;
  return `⏸️ Break confirmed — ${name}. Back by <b>${fmtTime(new Date(now.getTime() + allowed * 60000))}</b>.`;
}

async function handleBack(uid, name) {
  const state = await getState(uid);
  const now   = new Date();
  if (state.status === 'out') return `⚠️ ${name}, not logged in.`;
  if (state.status === 'in') return `⚠️ ${name}, not on break.`;

  const bt = state.breakType;
  const allowed = bt==='bbl' ? BBL_MINS : bt==='lunch' ? LUNCH_MINS : bt==='30' ? 30 : 15;
  const actual = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
  const over = actual - allowed - GRACE_MINS;

  if (bt==='15') state.breakUsed = (state.breakUsed||0) + 15;
  if (bt==='30') state.breakUsed = (state.breakUsed||0) + 30;
  if (bt==='bbl') { state.bblUsed=true; state.lunchUsed=true; state.lunchUsedMs=LUNCH_MINS*60000; }
  if (bt==='lunch') { state.lunchUsed=true; state.lunchUsedMs=LUNCH_MINS*60000; }

  let overMsg = over > 0 ? ` You were ${over}m over.` : '';
  if (over > 0) {
    if (bt==='lunch'||bt==='bbl') state.overlunchMs=(state.overlunchMs||0)+over*60000;
    else state.overbreakMs=(state.overbreakMs||0)+over*60000;
  }
  const labels = {'15':'Break 15','30':'Break 30','lunch':'Lunch','bbl':'BBL'};
  if (state.breakStart) closeUserLogRow(uid, labels[bt]||bt, now, new Date(state.breakStart)).catch(console.error);

  state.status='in'; state.breakStart=null; state.breakType=null;
  await setState(uid, state);
  return `✅ Welcome back, ${name}!${overMsg}`;
}

async function handleOffsetIn(uid, name) {
  const now = new Date(); const state = await getState(uid);
  if (isWithinShift(uid, now)) return `⚠️ Cannot log offset during shift.`;
  if (state.status === 'offset') return `⚠️ Offset already active.`;
  const role = ROSTER[uid]?.role || 'VA';
  const cur = await getCutoffHours(uid);
  const rem = Math.max(0, TARGET_HRS - cur.hours);
  await setState(uid, { ...state, status:'offset', offsetStart: now.toISOString() });
  addUserLogRow(uid, 'Offset', now).catch(console.error);
  return `⏱️ Offset confirmed — ${name}.${role==='Leader'?'':` Remaining: ${rem.toFixed(2)}h`}`;
}

async function handleOffsetOut(uid, name) {
  const state = await getState(uid); const now = new Date();
  if (state.status !== 'offset') return `⚠️ No active offset.`;
  const start = new Date(state.offsetStart);
  const durMs = msBetween(start, now); const durHrs = durMs/3600000;
  const role = ROSTER[uid]?.role || 'VA';
  const cur = await getCutoffHours(uid);
  const rem = Math.max(0, TARGET_HRS - (cur.hours + durHrs));
  closeUserLogRow(uid, 'Offset', now, start).catch(console.error);
  await addCutoffHours(uid, name, role, durHrs, 0);
  await setState(uid, { ...state, status:'out', offsetStart:null });
  return `✅ Offset logged — ${name}. Total: ${fmtDuration(durMs)}.${role==='Leader'?'':` Remaining: ${rem.toFixed(2)}h`}`;
}

async function handleDayOverride(uid, name, type) {
  const state = await getState(uid); const now = new Date();
  if (state.dayOverride) return `⚠️ Already logged ${state.dayOverride}.`;
  const addsHours = type === 'holiday' || type === 'leave';
  const role = ROSTER[uid]?.role || 'VA';
  await setState(uid, { ...state, status: type, dayOverride: type });
  if (addsHours) await addCutoffHours(uid, name, role, MAX_HRS, 0);
  addUserLogRow(uid, type.toUpperCase(), now).catch(console.error);
  return `✅ ${type.toUpperCase()} logged — ${name}.`;
}

async function handleStatus(uid, name) {
  const state = await getState(uid);
  const sm = { 'out':'🔴 Out','in':'🟢 Active','15':'🔵 Break','30':'🔵 Break','lunch':'🔵 Lunch','bbl':'🔵 BBL','offset':'⏱️ Offset' };
  let msg = `📊 Status: ${sm[state.status]||'🔴 Out'}`;
  if (state.loginTime && state.status==='in') msg += `\nIn for: ${fmtDuration(msBetween(new Date(state.loginTime), new Date()))}`;
  return msg;
}

async function handleTotal(uid, name) {
  const role = ROSTER[uid]?.role || 'VA';
  const cur = await getCutoffHours(uid);
  const co = getCutoffDates(role);
  return `📈 <b>Cutoff — ${name}</b>\nLogged: ${cur.hours.toFixed(2)}h${cur.ot>0?` (+${cur.ot.toFixed(2)}h OT)` : ''}\nPeriod: ${fmtDate(co.start)} - ${fmtDate(co.end)}`;
}

async function handleSched(uid, name) {
  const entry = ROSTER[uid]; if (!entry) return `⚠️ No schedule.`;
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const wd = days.filter((d,i) => entry.days[i]);
  return `📅 <b>Sched — ${name}</b>\nDays: ${wd.join(', ')}\nShift: ${entry.start} - ${entry.end}`;
}

async function handleHelp() {
  return `📖 <b>Commands:</b>\n/in, /out\n/15, /30, /lunch, /bbl, /back\n/holiday, /absent, /leave\n/status, /total, /sched`;
}

// ============================================================
// WEBHOOK & ENDPOINTS
// ============================================================
const processed = new Set();
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body; const msg = update.message || update.channel_post; if (!msg) return;
    const cid = String(msg.chat.id); const tid = msg.message_thread_id ? String(msg.message_thread_id) : null;
    const uid = String(msg.from.id); const text = (msg.text || '').trim().toLowerCase();
    const name = msg.from.first_name || 'User';
    if (cid !== ALLOWED_CHAT || tid !== TOPIC_ID || !ROSTER[uid]) return;
    if (processed.has(update.update_id)) return; processed.add(update.update_id);
    let reply = null;
    if (text==='/in' || text==='in') reply = await handleIn(uid, name);
    else if (text==='/out' || text==='out') reply = await handleOut(uid, name);
    else if (text==='/back' || text==='back') reply = await handleBack(uid, name);
    else if (['/15','15','/30','30','/lunch','lunch','/bbl','bbl'].includes(text)) reply = await handleBreak(uid, name, text.replace('/',''));
    else if (text==='/status') reply = await handleStatus(uid, name);
    else if (text==='/total') reply = await handleTotal(uid, name);
    else if (text==='/sched') reply = await handleSched(uid, name);
    else if (text==='/help') reply = await handleHelp();
    if (reply) await sendMsg(reply, cid, tid);
  } catch(e) { console.error('webhook error:', e.message); }
});

app.get('/dashboard', async (req, res) => {
  const users = []; const now = new Date(); const manila = manilaTime();
  for (const [uid, entry] of Object.entries(ROSTER)) {
    const state = await getState(uid); const mem = await getCutoffMemory(uid);
    users.push({ name: entry.name, status: state.status, hours: mem.hours });
  }
  res.json({ time: fmtTime(now), users });
});

app.get('/reset-states', async (req, res) => {
    const keys = await redisClient.keys('state:*');
    if (keys.length > 0) await redisClient.del(keys);
    res.json({ ok: true, cleared: keys.length });
});

app.get('/', (req, res) => res.json({ status:'ok', version:'2.0-Redis' }));

app.listen(PORT, async () => {
  console.log(`Bot running on port ${PORT}`);
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, { url: `${WEBHOOK_URL}/webhook`, drop_pending_updates: true });
  } catch(e) { console.error('Webhook failed:', e.message); }
  initUserLogMap().catch(console.error);
});
