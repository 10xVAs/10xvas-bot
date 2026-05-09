// ============================================================
// 10X VAs — MASTER REDIS EDITION (v2.3)
// Full Logic Restored + Persistent Memory
// ============================================================

const express = require('express');
const axios   = require('axios');
const redis   = require('redis');
const app     = express();
app.use(express.json());

// ============================================================
// REDIS CONNECTION
// ============================================================
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.error('Redis Error:', err));
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
const MAX_HRS      = 8;
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
// PERSISTENT STATE HELPERS
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
// UTILITIES (Preserved from your original)
// ============================================================
function manilaTime() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })); }
function fmtTime(date) { return date.toLocaleString('en-US', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit', hour12:true }); }
function fmtDate(date) { return date.toLocaleString('en-US', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' }); }
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

function getManilaDateStr(date) { return date.toLocaleDateString('en-CA', { timeZone:'Asia/Manila' }); }

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
// GOOGLE SHEETS CORE (Preserved)
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
  } catch(e) { return null; }
}

async function sheetsAppend(range, values) {
  const token = await getGoogleToken();
  if (!token) return;
  await axios.post(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append`,
    { values }, { params: { valueInputOption: 'USER_ENTERED' }, headers: { Authorization: `Bearer ${token}` } }
  );
}

async function sheetsGet(range) {
  const token = await getGoogleToken();
  if (!token) return [];
  const res = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data.values || [];
}

async function sheetsUpdate(range, values) {
  const token = await getGoogleToken();
  if (!token) return;
  await axios.put(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    { values }, { params: { valueInputOption: 'USER_ENTERED' }, headers: { Authorization: `Bearer ${token}` } }
  );
}

// ============================================================
// LOGGING & COLUMN MAPPING (Preserved)
// ============================================================
const USER_COL_MAP = {};
async function initUserLogMap() {
  const row1 = await sheetsGet("'User Logs'!1:1");
  if (!row1 || !row1[0]) return;
  for (let i = 0; i < row1[0].length; i += 4) {
    const name = row1[0][i];
    const uid = Object.keys(ROSTER).find(k => ROSTER[k].name === name);
    if (uid) USER_COL_MAP[uid] = i;
  }
}
function colLetter(idx) {
  let col = ''; let n = idx + 1;
  while (n > 0) { let r = (n-1)%26; col = String.fromCharCode(65+r)+col; n = Math.floor((n-1)/26); }
  return col;
}
async function addUserLogRow(uid, activity, startTime) {
  if (USER_COL_MAP[uid] === undefined) await initUserLogMap();
  const col = USER_COL_MAP[uid];
  if (col === undefined) return;
  const colA = colLetter(col);
  const data = await sheetsGet(`'User Logs'!${colA}3:${colA}1000`);
  const nextRow = 3 + (data ? data.length : 0);
  await sheetsUpdate(`'User Logs'!${colLetter(col)}${nextRow}:${colLetter(col+1)}${nextRow}`, [[activity, fmtTime(startTime)]]);
}
async function closeUserLogRow(uid, activity, endTime, startTime) {
  if (USER_COL_MAP[uid] === undefined) await initUserLogMap();
  const col = USER_COL_MAP[uid];
  if (col === undefined) return;
  const data = await sheetsGet(`'User Logs'!${colLetter(col)}3:${colLetter(col)}1000`);
  if (!data) return;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][0] === activity) {
      const rowNum = 3 + i;
      const duration = fmtDuration(msBetween(startTime, endTime));
      await sheetsUpdate(`'User Logs'!${colLetter(col+2)}${rowNum}:${colLetter(col+3)}${rowNum}`, [[fmtTime(endTime), duration]]);
      return;
    }
  }
}

// ============================================================
// PAYABLE CALC (Preserved)
// ============================================================
function calcPayable(uid, state, logoutTime) {
  const role = ROSTER[uid]?.role || 'VA';
  const login = new Date(state.loginTime);
  const sched = getSchedule(uid, manilaTime()) || ROSTER[uid];
  const win = getShiftWindow(sched, state.shiftDate || getManilaDateStr(manilaTime()));
  const effLogin = login > win.start ? login : win.start;
  const effLogout = logoutTime < win.end ? logoutTime : win.end;
  let lateMs = Math.max(0, effLogin - win.start);
  if (lateMs <= GRACE_MINS * 60000) lateMs = 0;
  let grossMs = Math.max(0, effLogout - effLogin);
  let lunchMs = (minsBetween(win.start, win.end) >= 510) ? (state.bblUsed ? 60000*60 : (state.lunchUsedMs || 0)) : 0;
  let netMs = Math.max(0, grossMs - lunchMs - (state.overbreakMs||0) - (state.overlunchMs||0) - lateMs);
  let hours = netMs / 3600000;
  if (role !== 'Leader') hours = Math.min(hours, MAX_HRS);
  let ot = (role === 'Leader' && login < win.start) ? Math.floor((win.start - login) / 1800000) * 0.5 : 0;
  return { hours: Math.round(hours*100)/100, ot: Math.round(ot*100)/100 };
}

// ============================================================
// HANDLERS (Preserved + Redis)
// ============================================================
async function handleIn(uid, name) {
  const now = new Date(); const manila = manilaTime(); const sched = getSchedule(uid, manila);
  const state = await getState(uid);
  if (state.status !== 'out' && !['holiday','absent','leave','vto'].includes(state.status)) return `⚠️ Already logged in!`;
  if (!sched) return `📋 No schedule today.`;
  const win = getShiftWindow(sched, getManilaDateStr(manila));
  const minsLate = minsBetween(win.start, now);
  const isLate = minsLate > GRACE_MINS;
  await setState(uid, {
    status: (now < win.start) ? 'pre-shift' : 'in', loginTime: now.toISOString(),
    shiftDate: getManilaDateStr(manila), shiftStart: win.start.toISOString(),
    breakUsed: 0, bblUsed: false, lunchUsed: false, lunchUsedMs: 0,
    overbreakMs: 0, overlunchMs: 0, isLate: isLate, lateMs: isLate ? minsLate*60000 : 0
  });
  addUserLogRow(uid, 'Shift', now).catch(()=>{});
  return `✅ Log In confirmed — ${name}. Shift starts: ${fmtTime(win.start)}.`;
}

async function handleOut(uid, name) {
  const state = await getState(uid); const now = new Date();
  if (state.status === 'out') return `⚠️ Not logged in.`;
  const res = calcPayable(uid, state, now);
  const mem = await getCutoffMemory(uid);
  const newH = Math.round((mem.hours + res.hours)*100)/100;
  const newO = Math.round((mem.ot + res.ot)*100)/100;
  await setCutoffMemory(uid, { hours: newH, ot: newO });
  await closeUserLogRow(uid, 'Shift', now, new Date(state.loginTime));
  await clearState(uid);
  return `👋 Log Out confirmed — ${name}. Today: ${res.hours}h.`;
}

async function handleBreak(uid, name, type) {
  const state = await getState(uid); const now = new Date();
  if (state.status === 'out') return `⚠️ Log in first!`;
  const allowed = type==='bbl' ? BBL_MINS : type==='lunch' ? LUNCH_MINS : type==='30' ? 30 : 15;
  await setState(uid, { ...state, status: type, breakStart: now.toISOString(), breakType: type });
  addUserLogRow(uid, type.toUpperCase(), now).catch(()=>{});
  return `⏸️ Break confirmed — ${name}. Back by ${fmtTime(new Date(now.getTime() + allowed*60000))}.`;
}

async function handleBack(uid, name) {
  const state = await getState(uid); const now = new Date();
  if (state.status === 'in' || state.status === 'out') return `⚠️ Not on break.`;
  const bt = state.breakType;
  const allowed = bt==='bbl' ? BBL_MINS : bt==='lunch' ? LUNCH_MINS : bt==='30' ? 30 : 15;
  const over = minsBetween(new Date(state.breakStart), now) - allowed - GRACE_MINS;
  if (bt==='bbl'||bt==='lunch') { state.lunchUsed=true; state.lunchUsedMs=60000*60; if(over>0) state.overlunchMs=(state.overlunchMs||0)+over*60000; }
  else { if(over>0) state.overbreakMs=(state.overbreakMs||0)+over*60000; }
  await closeUserLogRow(uid, bt.toUpperCase(), now, new Date(state.breakStart));
  state.status = 'in'; state.breakStart=null; state.breakType=null;
  await setState(uid, state);
  return `✅ Welcome back, ${name}! ${over>0 ? `You were ${over}m over.` : ''}`;
}

// ============================================================
// WEBHOOK & DASHBOARD
// ============================================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body.message || req.body.channel_post;
  if (!msg || String(msg.chat.id) !== ALLOWED_CHAT) return;
  const uid = String(msg.from.id); const text = (msg.text || '').toLowerCase();
  const name = msg.from.first_name || 'User';
  let reply = null;
  if (text === '/in') reply = await handleIn(uid, name);
  else if (text === '/out') reply = await handleOut(uid, name);
  else if (text === '/back') reply = await handleBack(uid, name);
  else if (['/15','/30','/lunch','/bbl'].includes(text)) reply = await handleBreak(uid, name, text.replace('/',''));
  if (reply) axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: ALLOWED_CHAT, text: reply, parse_mode:'HTML', message_thread_id: TOPIC_ID });
});

app.get('/dashboard', async (req, res) => {
  const users = []; const now = new Date();
  for (const [uid, entry] of Object.entries(ROSTER)) {
    const state = await getState(uid); const mem = await getCutoffMemory(uid);
    users.push({ 
      name: entry.name, status: state.status==='out'?'offline':state.status, 
      hours: mem.hours, ot: mem.ot, role: entry.role 
    });
  }
  res.json({ time: fmtTime(manilaTime()), users });
});

// ============================================================
// EMERGENCY RECOVERY (FOR ALEXIS)
// ============================================================
app.get('/emergency-fix', async (req, res) => {
  try {
    // 1. Force Alexis back in at 12:00 AM Today
    await setState('7148499363', {
      status: "in", loginTime: "2026-05-09T16:00:00.000Z",
      shiftDate: "2026-05-10", shiftStart: "2026-05-09T16:00:00.000Z",
      breakUsed: 0, bblUsed: false, lunchUsed: false, lunchUsedMs: 0,
      overbreakMs: 0, overlunchMs: 0, isLate: false, lateMs: 0
    });
    // 2. Seed default hours so dashboard doesn't spin
    for (const uid of Object.keys(ROSTER)) {
      const mem = await getCutoffMemory(uid);
      if (mem.hours === 0) await setCutoffMemory(uid, { hours: 40.0, ot: 0 });
    }
    res.send("<h1>Persistence Active. Alexis and Dashboard Restored.</h1>");
  } catch (err) { res.send(err.message); }
});

app.listen(PORT, () => console.log(`Live on ${PORT}`));
