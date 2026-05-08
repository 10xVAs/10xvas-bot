// ============================================================
// 10X VAs — Telegram Bot v2.0
// Node.js + Express — Railway Deployment
// ============================================================

const express = require('express');
const axios   = require('axios');
const app     = express();
app.use(express.json());

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

const GRACE_MINS  = 4;
const EARLY_LIMIT = 30; // mins before shift = early warning
const BBL_MINS    = 90;
const LUNCH_MINS  = 60;
const MAX_HRS     = 8;
const TARGET_HRS  = 80; // cutoff target for VA/UYP
const CUTOFF_START_VA_MS = new Date('2026-05-02T09:00:00+08:00').getTime();
const CUTOFF_DAYS = 14;

// ============================================================
// ROSTER — hardcoded, Days: [Mon,Tue,Wed,Thu,Fri,Sat,Sun]
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
// STATE — in-memory
// ============================================================
const STATE = {};

// In-memory cutoff hours — seeded via /seed-cutoff, updated on /out
const CUTOFF = {};

function getState(uid) { return STATE[uid] || { status: 'out' }; }
function setState(uid, s) { STATE[uid] = s; }
function clearState(uid) { delete STATE[uid]; }

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
// GOOGLE SHEETS — via Service Account
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
  if (!SHEET_ID) return;
  try {
    const token = await getGoogleToken();
    if (!token) return;
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append`,
      { values },
      { params: { valueInputOption: 'USER_ENTERED' }, headers: { Authorization: `Bearer ${token}` } }
    );
  } catch(e) { console.error('sheetsAppend:', e.message); }
}

async function sheetsGet(range) {
  if (!SHEET_ID) return [];
  try {
    const token = await getGoogleToken();
    if (!token) return [];
    const res = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data.values || [];
  } catch(e) { console.error('sheetsGet:', e.message); return []; }
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

// ============================================================
// USER LOGS — column-per-user format
// Col layout per user: Activity | Start | End | Duration (4 cols)
// Row 1: User names (merged)
// Row 2: Headers
// Row 3+: Data
// ============================================================

// In-memory column map: { userId: colIndex (0-based) }
const USER_COL_MAP = {};
const COLS_PER_USER = 4;
let userLogsHeaders = null; // cached row 1

async function initUserLogMap() {
  try {
    const row1 = await sheetsGet("'User Logs'!1:1");
    if (!row1 || !row1[0]) return;
    userLogsHeaders = row1[0];
    for (let i = 0; i < userLogsHeaders.length; i += COLS_PER_USER) {
      const name = userLogsHeaders[i];
      if (!name) continue;
      const uid = Object.keys(ROSTER).find(k => ROSTER[k].name === name);
      if (uid) USER_COL_MAP[uid] = i;
    }
  } catch(e) { console.error('initUserLogMap:', e.message); }
}

function colLetter(idx) {
  // Convert 0-based column index to sheet letter (A, B, ... Z, AA, AB...)
  let col = '';
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    col = String.fromCharCode(65 + r) + col;
    n = Math.floor((n - 1) / 26);
  }
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

  // Find next empty row (get last row in user's activity column)
  const colA = colLetter(col);
  const data = await sheetsGet(`'User Logs'!${colA}3:${colA}1000`);
  const nextRow = 3 + (data ? data.length : 0);

  const actCol   = colLetter(col);
  const startCol = colLetter(col + 1);
  const range    = `'User Logs'!${actCol}${nextRow}:${startCol}${nextRow}`;
  await sheetsUpdate(range, [[activity, fmtTime(startTime)]]);
  return nextRow;
}

async function closeUserLogRow(uid, activity, endTime, startTime) {
  const col = await getUserLogCol(uid);
  if (col === undefined) return;

  const actCol = colLetter(col);
  const data   = await sheetsGet(`'User Logs'!${actCol}3:${actCol}1000`);
  if (!data) return;

  // Find last row with this activity and no end time
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][0] === activity) {
      const rowNum   = 3 + i;
      const endCol   = colLetter(col + 2);
      const durCol   = colLetter(col + 3);
      const duration = fmtDuration(msBetween(startTime, endTime));
      await sheetsUpdate(`'User Logs'!${endCol}${rowNum}:${durCol}${rowNum}`, [[fmtTime(endTime), duration]]);
      return;
    }
  }
}

// For Leaders: update existing Shift row's end time and duration
async function updateLeaderShiftRow(uid, endTime) {
  const col = await getUserLogCol(uid);
  if (col === undefined) return;

  const actCol = colLetter(col);
  const data   = await sheetsGet(`'User Logs'!${actCol}3:${actCol}1000`);
  if (!data) return;

  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][0] === 'Shift') {
      const rowNum    = 3 + i;
      const startCol  = colLetter(col + 1);
      const startData = await sheetsGet(`'User Logs'!${startCol}${rowNum}:${startCol}${rowNum}`);
      const startStr  = startData && startData[0] ? startData[0][0] : null;

      const endCol = colLetter(col + 2);
      const durCol = colLetter(col + 3);

      let durStr = '';
      if (startStr) {
        // Parse start time string back to Date for duration calc
        // Just store formatted times — duration calc done on logout
        const state = getState(uid);
        if (state.loginTime) {
          durStr = fmtDuration(msBetween(new Date(state.loginTime), endTime));
        }
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
  // Update in-memory first (instant, no sheet dependency)
  if (!CUTOFF[uid]) CUTOFF[uid] = { hours: 0, ot: 0 };
  CUTOFF[uid].hours = Math.round((CUTOFF[uid].hours + addHours) * 100) / 100;
  CUTOFF[uid].ot    = Math.round((CUTOFF[uid].ot + (addOT||0)) * 100) / 100;

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
        uid, name, role,
        fmtDate(co.start), fmtDate(co.end),
        Math.round(addHours * 100) / 100,
        Math.round((addOT||0) * 100) / 100,
        fmtTime(now),
      ]]);
    }
  } catch(e) { console.error('addCutoffHours:', e.message); }
}

// ============================================================
// PAYABLE HOURS CALCULATION
// ============================================================
function calcPayable(uid, state, logoutTime) {
  const role     = ROSTER[uid]?.role || 'VA';
  const isLeader = role === 'Leader';
  const login    = new Date(state.loginTime);
  const logout   = logoutTime;

  const manila  = manilaTime();
  const sched   = getSchedule(uid, manila) || ROSTER[uid];
  const dateStr = state.shiftDate || getManilaDateStr(manila);
  const win     = getShiftWindow(sched, dateStr);

  const effLogin  = login  > win.start ? login  : win.start;
  const effLogout = logout < win.end   ? logout : win.end;

  let lateMs = Math.max(0, effLogin.getTime() - win.start.getTime());
  if (lateMs <= GRACE_MINS * 60000) lateMs = 0;

  let grossMs = Math.max(0, effLogout.getTime() - effLogin.getTime());

  // Lunch deduction
  const diffMins = minsBetween(win.start, win.end);
  const hasLunch = diffMins >= 510;
  let lunchMs = 0;
  if (hasLunch) lunchMs = state.bblUsed ? LUNCH_MINS * 60000 : (state.lunchUsedMs || 0);

  let netMs = Math.max(0, grossMs - lunchMs - (state.overbreakMs||0) - (state.overlunchMs||0) - lateMs);
  let hours = netMs / 3600000;
  if (!isLeader) hours = Math.min(hours, MAX_HRS);

  let ot = 0;
  if (isLeader && login < win.start) {
    ot = Math.floor((win.start.getTime() - login.getTime()) / (30*60000)) * 0.5;
  }

  return {
    hours: Math.round(hours * 100) / 100,
    ot:    Math.round(ot * 100) / 100,
  };
}

// ============================================================
// HANDLERS
// ============================================================

async function handleIn(uid, name) {
  const manila = manilaTime();
  const sched  = getSchedule(uid, manila);
  const state  = getState(uid);
  const now    = new Date();

  // Already logged in
  if (state.status !== 'out' && state.status !== 'holiday' && state.status !== 'absent' && state.status !== 'leave' && state.status !== 'vto') {
    return `⚠️ Heads up, ${name} — you're already logged in! If this is an error, please contact your manager.`;
  }

  // No schedule today
  if (!sched) {
    return `📋 Hi ${name}, today doesn't seem to be a scheduled workday for you. If you think this is an error, please reach out to your manager.`;
  }

  const dateStr = getManilaDateStr(manila);
  const win     = getShiftWindow(sched, dateStr);
  const minsToShift = minsBetween(now, win.start);
  const minsLate    = minsBetween(win.start, now);

  // Determine status
  const isLate        = minsLate > GRACE_MINS;
  const isVeryEarly   = minsToShift > EARLY_LIMIT;  // more than 30 mins early
  const isSlightEarly = minsToShift > 0 && minsToShift <= EARLY_LIMIT; // within 30 mins early

  setState(uid, {
    status:      (isVeryEarly || isSlightEarly) ? 'pre-shift' : 'in',
    loginTime:   now.toISOString(),
    shiftDate:   dateStr,
    shiftStart:  win.start.toISOString(),
    breakUsed:   0,
    bblUsed:     false,
    lunchUsed:   false,
    lunchUsedMs: 0,
    overbreakMs: 0,
    overlunchMs: 0,
    breakStart:  null,
    breakType:   null,
    isLate:      isLate,
    lateMs:      isLate ? minsLate * 60000 : 0,
  });

  addUserLogRow(uid, 'Shift', now).catch(console.error);

  // Very early (30+ mins before shift) — accepted but show shift time
  if (isVeryEarly) {
    return `🌅 Log In confirmed — ${name}. You're early today! Your shift starts at ${fmtTime(win.start)} Manila. We'll mark you active then. 💪`;
  }

  // Slightly early (within 30 mins) — regular login message
  if (isSlightEarly) {
    return `✅ Log In confirmed — ${name}. Your shift for today starts at ${fmtTime(win.start)} Manila. Have a great shift! 💪`;
  }

  if (isLate) {
    return `⏰ Log In confirmed — ${name}. Your shift started at ${fmtTime(win.start)} Manila. You're ${minsLate} minute(s) late — this will be reflected in your hours.`;
  }

  return `✅ Log In confirmed — ${name}. Your shift for today starts at ${fmtTime(win.start)} Manila. Have a great shift! 💪`;
}

async function handleOut(uid, name) {
  const state = getState(uid);
  const now   = new Date();

  // Auto-promote pre-shift to in if shift has started
  if (state.status === 'pre-shift' && state.shiftStart) {
    const shiftStart = new Date(state.shiftStart);
    if (new Date() >= shiftStart) {
      state.status = 'in';
      setState(uid, state);
    }
  }

  if (state.status === 'out') {
    return `⚠️ ${name}, you're not currently logged in. If this is an error, please contact your manager.`;
  }

  // Auto-close any open break
  if (state.status !== 'in') {
    const breakMins = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
    const allowed   = state.breakType==='bbl' ? BBL_MINS : state.breakType==='lunch' ? LUNCH_MINS : state.breakType==='30' ? 30 : 15;
    const over      = breakMins - allowed - GRACE_MINS;
    if (over > 0) {
      if (state.breakType==='lunch'||state.breakType==='bbl') state.overlunchMs=(state.overlunchMs||0)+over*60000;
      else state.overbreakMs=(state.overbreakMs||0)+over*60000;
    }
    // Close break row
    const breakLabels = {'15':'Break 15','30':'Break 30','lunch':'Lunch','bbl':'BBL'};
    if (state.breakType && state.breakStart) {
      closeUserLogRow(uid, breakLabels[state.breakType]||'Break', now, new Date(state.breakStart)).catch(console.error);
    }
  }

  const result = state.loginTime ? calcPayable(uid, state, now) : { hours: 0, ot: 0 };
  const role   = ROSTER[uid]?.role || 'VA';

  // Update User Logs
  if (role === 'Leader') {
    updateLeaderShiftRow(uid, now).catch(console.error);
  } else {
    closeUserLogRow(uid, 'Shift', now, new Date(state.loginTime)).catch(console.error);
  }

  // Update Cutoff Counter
  addCutoffHours(uid, name, role, result.hours, result.ot).catch(console.error);

  clearState(uid);

  const hoursStr = result.hours.toFixed(2);
  const otStr    = result.ot > 0 ? ` (+${result.ot.toFixed(2)}h OT)` : '';
  return `👋 Log Out confirmed — ${name}. Total hours for today: <b>${hoursStr}h${otStr}</b>. Contact your manager for any disputes.`;
}

async function handleBreak(uid, name, breakType) {
  const state = getState(uid);
  const now   = new Date();

  // Auto-promote pre-shift if shift started
  if (state.status === 'pre-shift' && state.shiftStart && new Date() >= new Date(state.shiftStart)) {
    state.status = 'in';
    setState(uid, state);
  }

  if (state.status === 'out') {
    return `⚠️ ${name}, you need to log in first before taking a break!`;
  }
  if (state.status !== 'in') {
    return `⚠️ ${name}, you're already on a break! Please /back first before starting another.`;
  }

  const allowed = breakType==='bbl' ? BBL_MINS : breakType==='lunch' ? LUNCH_MINS : breakType==='30' ? 30 : 15;
  const back    = new Date(now.getTime() + allowed * 60000);

  // Break pool checks
  if (breakType === '15' || breakType === '30') {
    if (state.bblUsed) return `⚠️ ${name}, you've already used your BBL for this shift. No additional breaks available.`;
    const wouldUse = (state.breakUsed||0) + (breakType==='15' ? 15 : 30);
    if (wouldUse > 30) return `⚠️ ${name}, you've reached your break limit for this shift (30 minutes total).`;
  }
  if (breakType === 'bbl' && (state.bblUsed || (state.breakUsed||0) > 0)) {
    return `⚠️ ${name}, you've already used your break allowance for this shift.`;
  }
  if (breakType === 'lunch' && state.lunchUsed) {
    return `⚠️ ${name}, you've already taken your lunch for this shift.`;
  }

  setState(uid, { ...state, status: breakType, breakStart: now.toISOString(), breakType });

  // Log to User Logs
  const labels = {'15':'Break 15','30':'Break 30','lunch':'Lunch','bbl':'BBL'};
  addUserLogRow(uid, labels[breakType]||breakType, now).catch(console.error);

  if (breakType==='15')    return `⏸️ Break confirmed — ${name}. Be back by <b>${fmtTime(back)}</b>. ☕`;
  if (breakType==='30')    return `⏸️ Break confirmed — ${name}. Be back by <b>${fmtTime(back)}</b>. ☕`;
  if (breakType==='lunch') return `🍽️ Lunch confirmed — ${name}. Be back by <b>${fmtTime(back)}</b>. Enjoy!`;
  if (breakType==='bbl')   return `🍽️ Lunch & Break confirmed — ${name}. Be back by <b>${fmtTime(back)}</b>. Enjoy!`;
}

async function handleBack(uid, name) {
  const state = getState(uid);
  const now   = new Date();

  // Auto-promote pre-shift if shift started
  if (state.status === 'pre-shift' && state.shiftStart && new Date() >= new Date(state.shiftStart)) {
    state.status = 'in';
    setState(uid, state);
  }

  if (state.status === 'out') {
    return `⚠️ ${name}, you're not currently logged in.`;
  }
  if (state.status === 'in') {
    return `⚠️ ${name}, you're not on a break! No need to punch back.`;
  }

  const bt      = state.breakType || '15';
  const allowed = bt==='bbl' ? BBL_MINS : bt==='lunch' ? LUNCH_MINS : bt==='30' ? 30 : 15;
  const actual  = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
  const over    = actual - allowed - GRACE_MINS;

  if (bt==='15')    state.breakUsed = (state.breakUsed||0) + 15;
  if (bt==='30')    state.breakUsed = (state.breakUsed||0) + 30;
  if (bt==='bbl')   { state.bblUsed=true; state.lunchUsedMs=LUNCH_MINS*60000; state.lunchUsed=true; }
  if (bt==='lunch') { state.lunchUsed=true; state.lunchUsedMs=LUNCH_MINS*60000; }

  let overMsg = '';
  if (over > 0) {
    if (bt==='lunch'||bt==='bbl') {
      state.overlunchMs=(state.overlunchMs||0)+over*60000;
      overMsg = ` You were ${over} minute(s) over your lunch — this will be reflected in your hours.`;
    } else {
      state.overbreakMs=(state.overbreakMs||0)+over*60000;
      overMsg = ` You were ${over} minute(s) over your break — this will be reflected in your hours.`;
    }
  }

  // Close break row in User Logs
  const labels = {'15':'Break 15','30':'Break 30','lunch':'Lunch','bbl':'BBL'};
  if (state.breakStart) {
    closeUserLogRow(uid, labels[bt]||bt, now, new Date(state.breakStart)).catch(console.error);
  }

  state.status='in'; state.breakStart=null; state.breakType=null;
  setState(uid, state);

  return `✅ Welcome back, ${name}!${overMsg}`;
}

async function handleOffsetIn(uid, name) {
  const now  = new Date();
  const state = getState(uid);

  // Block if within shift hours
  if (isWithinShift(uid, now)) {
    return `⚠️ ${name}, offset hours cannot be logged during your scheduled shift. Please use the regular /in command.`;
  }
  if (state.status === 'offset') {
    return `⚠️ ${name}, you already have an active offset session. Please /offset-out first.`;
  }

  const role = ROSTER[uid]?.role || 'VA';
  const current = await getCutoffHours(uid);
  const remaining = Math.max(0, TARGET_HRS - current.hours);
  const remainingStr = role === 'Leader' ? '' : ` Remaining this cutoff: <b>${remaining.toFixed(2)}h</b>`;

  setState(uid, { ...state, status:'offset', offsetStart: now.toISOString() });
  addUserLogRow(uid, 'Offset', now).catch(console.error);

  return `⏱️ Offset confirmed — ${name}.${remainingStr} Make it count! 💪`;
}

async function handleOffsetOut(uid, name) {
  const state = getState(uid);
  const now   = new Date();

  if (state.status !== 'offset') {
    return `⚠️ ${name}, you don't have an active offset session.`;
  }

  const startTime   = new Date(state.offsetStart);
  const durationMs  = msBetween(startTime, now);
  const durationHrs = durationMs / 3600000;

  const role    = ROSTER[uid]?.role || 'VA';
  const current = await getCutoffHours(uid);
  const newTotal = current.hours + durationHrs;
  const remaining = Math.max(0, TARGET_HRS - newTotal);
  const remainingStr = role === 'Leader' ? '' : ` Remaining this cutoff: <b>${remaining.toFixed(2)}h</b>`;

  // Update logs and cutoff
  closeUserLogRow(uid, 'Offset', now, startTime).catch(console.error);
  addCutoffHours(uid, name, role, durationHrs, 0).catch(console.error);

  setState(uid, { ...state, status:'out', offsetStart:null });

  return `✅ Offset hours logged — ${name}. Total: <b>${fmtDuration(durationMs)}</b>.${remainingStr}`;
}

async function handleDayOverride(uid, name, type) {
  const state = getState(uid);
  const now   = new Date();

  const validTypes = ['holiday','absent','leave','vto'];
  if (!validTypes.includes(type)) return null;

  // Check if already punched today
  if (state.dayOverride) {
    const typeNames = { holiday:'Holiday', absent:'Absent', leave:'Leave', vto:'VTO' };
    return `⚠️ ${name}, you've already logged <b>${typeNames[state.dayOverride]}</b> for today.`;
  }

  const addsHours = type === 'holiday' || type === 'leave';
  const role      = ROSTER[uid]?.role || 'VA';

  setState(uid, { ...state, status: type, dayOverride: type });

  if (addsHours) {
    addCutoffHours(uid, name, role, MAX_HRS, 0).catch(console.error);
  }

  // Log to User Logs
  addUserLogRow(uid, type.toUpperCase(), now).catch(console.error);

  const messages = {
    holiday: `🎉 Holiday logged — ${name}. Enjoy your day off! You're all set.`,
    absent:  `📋 Absent logged — ${name}. Please coordinate with your manager.`,
    leave:   `🌴 Leave logged — ${name}. Enjoy your time off!`,
    vto:     `✅ VTO logged — ${name}. Thank you for volunteering your time off!`,
  };

  return messages[type];
}

// ============================================================
// HIDDEN COMMANDS
// ============================================================

async function handleStatus(uid, name) {
  const state = getState(uid);
  const statusMap = {
    'out':     '🔴 Logged Out',
    'in':      '🟢 Active',
    '15':      '🔵 On 15-min Break',
    '30':      '🔵 On 30-min Break',
    'lunch':   '🔵 On Lunch',
    'bbl':     '🔵 On BBL',
    'offset':  '⏱️ On Offset',
    'holiday': '🎉 Holiday',
    'absent':  '📋 Absent',
    'leave':   '🌴 On Leave',
    'vto':     '✅ VTO',
  };

  const statusStr = statusMap[state.status] || '🔴 Logged Out';
  let msg = `📊 <b>Status — ${name}</b>\nCurrent: ${statusStr}`;

  if (state.loginTime && state.status === 'in') {
    const elapsed = minsBetween(new Date(state.loginTime), new Date());
    msg += `\nLogged in for: <b>${Math.floor(elapsed/60)}h ${elapsed%60}m</b>`;
  }
  if (state.breakStart) {
    const elapsed = minsBetween(new Date(state.breakStart), new Date());
    msg += `\nOn break for: <b>${elapsed}m</b>`;
  }

  return msg;
}

async function handleTotal(uid, name) {
  const role    = ROSTER[uid]?.role || 'VA';
  const current = await getCutoffHours(uid);
  const co      = getCutoffDates(role);
  const target  = role === 'Leader' ? 'Flexible' : `${TARGET_HRS}h`;
  const remaining = role === 'Leader' ? '—' : `${Math.max(0, TARGET_HRS - current.hours).toFixed(2)}h`;

  return `📈 <b>Cutoff Hours — ${name}</b>\n` +
    `Role: <b>${role}</b>\n` +
    `Period: <b>${fmtDate(co.start)} – ${fmtDate(co.end)}</b>\n` +
    `Logged: <b>${current.hours.toFixed(2)}h</b>${current.ot > 0 ? ` (+${current.ot.toFixed(2)}h OT)` : ''}\n` +
    `Target: <b>${target}</b>\n` +
    `Remaining: <b>${remaining}</b>`;
}

async function handleSched(uid, name) {
  const entry = ROSTER[uid];
  if (!entry) return `⚠️ ${name}, no schedule found.`;

  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const workDays = days.filter((d,i) => entry.days[i]);

  return `📅 <b>Schedule — ${name}</b>\n` +
    `Role: <b>${entry.role}</b>\n` +
    `Days: <b>${workDays.join(', ')}</b>\n` +
    `Shift: <b>${entry.start} – ${entry.end}</b>`;
}

async function handleCutoff(uid, name) {
  const role = ROSTER[uid]?.role || 'VA';
  const co   = getCutoffDates(role);
  const now  = new Date();
  const daysLeft = Math.ceil((co.end - now) / 86400000);

  const typeMap = {
    'VA':     'Bi-weekly (every 2 Saturdays)',
    'UYP':    'Semi-monthly (1st–15th, 16th–end)',
    'Leader': 'Bi-weekly (every 2 Saturdays)',
  };

  return `📆 <b>Cutoff Info — ${name}</b>\n` +
    `Type: <b>${typeMap[role] || 'Bi-weekly'}</b>\n` +
    `Start: <b>${fmtDate(co.start)}</b>\n` +
    `End: <b>${fmtDate(co.end)}</b>\n` +
    `Days remaining: <b>${daysLeft}</b>\n` +
    `Target hours: <b>${role === 'Leader' ? 'Flexible' : TARGET_HRS + 'h'}</b>`;
}

async function handleHelp(uid, name) {
  return `📖 <b>Available Commands — ${name}</b>\n\n` +
    `<b>Shift:</b>\n` +
    `/in — Log in\n` +
    `/out — Log out\n\n` +
    `<b>Breaks:</b>\n` +
    `/15 — 15-minute break\n` +
    `/30 — 30-minute break\n` +
    `/lunch — Lunch break\n` +
    `/bbl — Lunch & break combined\n` +
    `/back — Return from break\n\n` +
    `<b>Day Override:</b>\n` +
    `/holiday — Log holiday\n` +
    `/absent — Log absence\n` +
    `/leave — Log leave\n` +
    `/vto — Log VTO\n\n` +
    `<b>Info:</b>\n` +
    `/status — Your current status\n` +
    `/total — Your cutoff hours\n` +
    `/sched — Your weekly schedule\n` +
    `/cutoff — Cutoff period details`;
}

// ============================================================
// WEBHOOK
// ============================================================
const processed = new Set();

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always return 200 immediately

  try {
    const update  = req.body;
    const msg     = update.message || update.channel_post;
    if (!msg) return;

    const chatId   = String(msg.chat.id);
    const topicId  = msg.message_thread_id ? String(msg.message_thread_id) : null;
    const uid      = String(msg.from.id);
    const text     = (msg.text || '').trim().toLowerCase();
    const name     = msg.from.first_name || msg.from.username || 'User';
    const updateId = String(update.update_id);

    // Filters
    if (chatId !== ALLOWED_CHAT) return;
    if (topicId !== TOPIC_ID)    return;

    // Unknown user
    if (!ROSTER[uid]) {
      await sendMsg(`🚫 Unregistered user. Please contact your manager to get set up.`, chatId, topicId);
      return;
    }

    // Dedup
    if (processed.has(updateId)) return;
    processed.add(updateId);
    if (processed.size > 1000) processed.delete(processed.values().next().value);

    // Route commands
    let reply = null;

    if      (text==='/in'        || text==='in')        reply = await handleIn(uid, name);
    else if (text==='/out'       || text==='out')       reply = await handleOut(uid, name);
    else if (text==='/back'      || text==='back')      reply = await handleBack(uid, name);
    else if (text==='/15'        || text==='15')        reply = await handleBreak(uid, name, '15');
    else if (text==='/30'        || text==='30')        reply = await handleBreak(uid, name, '30');
    else if (text==='/lunch'     || text==='lunch')     reply = await handleBreak(uid, name, 'lunch');
    else if (text==='/bbl'       || text==='bbl')       reply = await handleBreak(uid, name, 'bbl');
    else if (text==='/offset-in' || text==='offset-in') reply = await handleOffsetIn(uid, name);
    else if (text==='/offset-out'|| text==='offset-out')reply = await handleOffsetOut(uid, name);
    else if (text==='/holiday'   || text==='holiday')   reply = await handleDayOverride(uid, name, 'holiday');
    else if (text==='/absent'    || text==='absent')    reply = await handleDayOverride(uid, name, 'absent');
    else if (text==='/leave'     || text==='leave')     reply = await handleDayOverride(uid, name, 'leave');
    else if (text==='/vto'       || text==='vto')       reply = await handleDayOverride(uid, name, 'vto');
    else if (text==='/status'    || text==='status')    reply = await handleStatus(uid, name);
    else if (text==='/total'     || text==='total')     reply = await handleTotal(uid, name);
    else if (text==='/sched'     || text==='sched')     reply = await handleSched(uid, name);
    else if (text==='/cutoff'    || text==='cutoff')    reply = await handleCutoff(uid, name);
    else if (text==='/help'      || text==='help')      reply = await handleHelp(uid, name);

    if (reply) await sendMsg(reply, chatId, topicId);

  } catch(err) {
    console.error('webhook error:', err.message);
  }
});

// ============================================================
// DASHBOARD ENDPOINT
// ============================================================
app.get('/dashboard', async (req, res) => {
  const cb   = req.query.callback;
  const data = await getDashboardData();
  if (cb) {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`${cb}(${JSON.stringify(data)})`);
  } else {
    res.json(data);
  }
});

async function getDashboardData() {
  const now    = new Date();
  const manila = manilaTime();
  const users  = [];

  // Use in-memory CUTOFF (always up to date, no sheet read needed)
  const cutoffMap = CUTOFF;

  for (const [uid, entry] of Object.entries(ROSTER)) {
    const state = getState(uid);
    const sched = getSchedule(uid, manila);
    const co    = cutoffMap[uid] || { hours:0, ot:0 };

    let status = 'offline', label = 'Offline';
    let elapsed = '', shiftStart = '', shiftEnd = '';
    let shiftProgress = 0;

    // Day override statuses
    if (['holiday','absent','leave','vto'].includes(state.status)) {
      const labelMap = { holiday:'Holiday 🎉', absent:'Absent', leave:'On Leave 🌴', vto:'VTO' };
      status = state.status;
      label  = labelMap[state.status];
    } else if (sched) {
      const dateStr = getManilaDateStr(manila);
      const win     = getShiftWindow(sched, dateStr);
      shiftStart    = fmtTime(win.start);
      shiftEnd      = fmtTime(win.end);

      // Shift progress percentage
      const totalShiftMs  = win.end - win.start;
      const elapsedShiftMs = Math.min(Math.max(0, now - win.start), totalShiftMs);
      shiftProgress = Math.round((elapsedShiftMs / totalShiftMs) * 100);

      if (state.status === 'out') {
        status = (now >= win.start && now <= win.end) ? 'missing' : 'offline';
        label  = status === 'missing' ? 'Missing' : 'Offline';
      } else if (state.status === 'pre-shift') {
        // Auto-promote if shift has started
        if (state.shiftStart && now >= new Date(state.shiftStart)) {
          state.status = 'in';
          setState(uid, state);
          status = 'active'; label = 'Active';
        } else {
          status = 'pre-shift'; label = 'Pre-Shift';
        }
        if (state.loginTime) elapsed = minsBetween(new Date(state.loginTime), now) + 'm';
      } else if (state.status === 'in') {
        const isOverbreak = (state.overbreakMs||0) > 0 || (state.overlunchMs||0) > 0;
        status = state.isLate ? 'late' : (isOverbreak ? 'overbreak' : 'active');
        label  = state.isLate ? 'Active — Late In' : (isOverbreak ? 'Active — Overbreak' : 'Active');
        if (state.loginTime) elapsed = minsBetween(new Date(state.loginTime), now) + 'm';
      } else {
        const bl = {'15':'15-min Break','30':'30-min Break','lunch':'Lunch','bbl':'BBL'};
        const bs = {'15':'break','30':'break','lunch':'lunch','bbl':'bbl'};
        status  = bs[state.status] || 'break';
        label   = bl[state.status] || 'Break';
        if (state.breakStart) elapsed = minsBetween(new Date(state.breakStart), now) + 'm';
      }
    } else {
      label = 'Day Off';
    }

    const coDates = getCutoffDates(entry.role);

    users.push({
      id: uid, name: entry.name, role: entry.role,
      status, statusLabel: label,
      shiftStart, shiftEnd, elapsed, shiftProgress,
      runningHours: co.hours, otHours: co.ot,
      loginTime: state.loginTime ? fmtTime(new Date(state.loginTime)) : '',
      breakUsed: state.breakUsed || 0, bblUsed: state.bblUsed || false,
      cutoffEnd: fmtDate(coDates.end),
      isLate: state.isLate || false,
      lateMs: state.lateMs || 0,
    });
  }

  // Sort: Bad statuses first, then by role
  const statusOrder = {
    missing:   0,
    absent:    1,
    overbreak: 2,
    late:      3,
    break:     4,
    lunch:     5,
    bbl:       6,
    active:    7,
    'pre-shift': 8,
    holiday:   9,
    leave:     10,
    vto:       11,
    offset:    12,
    offline:   13,
  };
  const roleOrder = { Leader:0, UYP:1, VA:2 };

  users.sort((a, b) => {
    const sA = statusOrder[a.status] ?? 13;
    const sB = statusOrder[b.status] ?? 13;
    if (sA !== sB) return sA - sB;
    return (roleOrder[a.role]??3) - (roleOrder[b.role]??3);
  });

  const vaCo = getCutoffDates('VA');
  return {
    timestamp:   fmtTime(now),
    date:        fmtDate(now),
    manilaTime:  manila.toLocaleString('en-US'),
    cutoffStart: fmtDate(vaCo.start),
    cutoffEnd:   fmtDate(vaCo.end),
    users,
  };
}

// ============================================================
// SET STATES — GET /set-states (run once to set everyone as logged in)
// ============================================================
app.get('/set-states', (req, res) => {
  try {
    const manila = manilaTime();
    const dateStr = getManilaDateStr(manila);

    // Define login times per user (Manila time)
    const logins = [
      // 12:00 AM shift — logged in at 11:45 PM May 8
      { uid:'8044736892', loginHour:23, loginMin:45, prevDay:true },
      { uid:'7240390530', loginHour:23, loginMin:45, prevDay:true },
      { uid:'7830367843', loginHour:23, loginMin:45, prevDay:true },
      { uid:'2018117745', loginHour:23, loginMin:45, prevDay:true },
      { uid:'7207758648', loginHour:23, loginMin:45, prevDay:true },
      { uid:'8070441816', loginHour:23, loginMin:45, prevDay:true },
      { uid:'7148499363', loginHour:23, loginMin:45, prevDay:true },
      { uid:'7514392042', loginHour:23, loginMin:45, prevDay:true },
      { uid:'5685031197', loginHour:23, loginMin:45, prevDay:true },
      { uid:'6132223983', loginHour:23, loginMin:45, prevDay:true },
      { uid:'6088627916', loginHour:23, loginMin:45, prevDay:true },
      // Cha - 12 AM shift, Mon-Thu (today is Fri so day off - skip)
      // Alexis - 12 AM shift, Wed-Sun (works today Fri)
      { uid:'7148499363', loginHour:23, loginMin:45, prevDay:true },
      // 8:00 PM shift — Queency
      { uid:'2009869833', loginHour:20, loginMin:0,  prevDay:true },
      // 9:00 PM shifts
      { uid:'7831137596', loginHour:21, loginMin:0,  prevDay:true },
      { uid:'1802251672', loginHour:21, loginMin:0,  prevDay:true },
      { uid:'8393347347', loginHour:21, loginMin:0,  prevDay:true },
      { uid:'5359971666', loginHour:21, loginMin:0,  prevDay:true },
      { uid:'6012486581', loginHour:21, loginMin:0,  prevDay:true },
      { uid:'5660256653', loginHour:21, loginMin:0,  prevDay:true },
    ];

    const now = new Date();
    // Get yesterday's date string
    const yesterday = new Date(now.getTime() - 86400000);
    const yDateStr = getManilaDateStr(yesterday);

    let count = 0;
    const set = new Set();

    for (const u of logins) {
      if (set.has(u.uid)) continue; // skip duplicates
      set.add(u.uid);

      const entry = ROSTER[u.uid];
      if (!entry) continue;

      const shiftDateStr = u.prevDay ? yDateStr : dateStr;
      const loginDateStr = u.prevDay ? yDateStr : dateStr;
      const loginTime = new Date(`${loginDateStr}T${String(u.loginHour).padStart(2,'0')}:${String(u.loginMin).padStart(2,'0')}:00+08:00`);
      const win = getShiftWindow(entry, shiftDateStr);

      setState(u.uid, {
        status:      'in',
        loginTime:   loginTime.toISOString(),
        shiftDate:   shiftDateStr,
        shiftStart:  win.start.toISOString(),
        breakUsed:   0,
        bblUsed:     false,
        lunchUsed:   false,
        lunchUsedMs: 0,
        overbreakMs: 0,
        overlunchMs: 0,
        breakStart:  null,
        breakType:   null,
        isLate:      false,
        lateMs:      0,
      });
      count++;
    }

    res.json({ ok:true, statesSet: count });
  } catch(e) {
    res.json({ ok:false, error: e.message });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => res.json({ status:'ok', bot:'10X VAs v2.0', time: new Date().toISOString() }));

// ============================================================
// SEED CUTOFF — GET /seed-cutoff (run once)
// ============================================================
app.get('/seed-cutoff', async (req, res) => {
  try {
    const now = new Date();
    const seed = [
      // 5 shifts completed as of May 9
      // Leaders: 40h base + cumulative OT (Bert:6, Moon:7, Nell:3.5, Gab:2)
      ['8044736892','Bert',   'Leader','May 2, 2026','May 16, 2026', 40.0, 6.0,  fmtTime(now)],
      ['7240390530','Moon',   'Leader','May 2, 2026','May 16, 2026', 40.0, 7.0,  fmtTime(now)],
      ['7830367843','Nell',   'Leader','May 2, 2026','May 16, 2026', 40.0, 3.5,  fmtTime(now)],
      ['2018117745','Gab',    'Leader','May 2, 2026','May 16, 2026', 40.0, 2.0,  fmtTime(now)],
      // VAs: 5 shifts x 8h = 40h (Noreen had 1 absent = 32h)
      ['2009869833','Queency','VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['7831137596','Maku',   'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['1802251672','Lovely', 'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['8393347347','Mary',   'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['5359971666','Pam',    'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['6012486581','Cris',   'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['5660256653','Jude',   'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['7207758648','Noreen', 'VA',    'May 2, 2026','May 16, 2026', 32.0, 0,    fmtTime(now)],
      ['8070441816','John',   'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['6705167382','Cha',    'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['7148499363','Alexis', 'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      ['7514392042','Kate',   'VA',    'May 2, 2026','May 16, 2026', 40.0, 0,    fmtTime(now)],
      // UYP: 5 shifts x 8h = 40h (Kat had 1 absent = 32h)
      ['5685031197','Kat',    'UYP',   'May 1, 2026','May 15, 2026', 32.0, 0,    fmtTime(now)],
      ['6132223983','Yuqi',   'UYP',   'May 1, 2026','May 15, 2026', 40.0, 0,    fmtTime(now)],
      ['6088627916','Nina',   'UYP',   'May 1, 2026','May 15, 2026', 40.0, 0,    fmtTime(now)],
    ];

    // Clear existing data first
    const token = await getGoogleToken();
    if (token) {
      await axios.put(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent("'Cutoff Counter'!A2:H100")}`,
        { values: Array(99).fill(Array(8).fill('')) },
        { params: { valueInputOption: 'USER_ENTERED' }, headers: { Authorization: `Bearer ${token}` } }
      );
    }

    // Write seed data to sheet
    await sheetsAppend("'Cutoff Counter'!A:H", seed);

    // Also populate in-memory CUTOFF
    for (const r of seed) {
      CUTOFF[r[0]] = { hours: parseFloat(r[6]) || 0, ot: parseFloat(r[7]) || 0 };
    }

    res.json({ ok: true, seeded: seed.length });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, async () => {
  console.log(`10X VAs bot v2.0 running on port ${PORT}`);
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: `${WEBHOOK_URL}/webhook`,
      drop_pending_updates: true,
    });
    console.log('Webhook registered:', WEBHOOK_URL);
  } catch(e) {
    console.error('Webhook registration failed:', e.message);
  }
  // Init user log column map
  if (SHEET_ID) initUserLogMap().catch(console.error);
});
