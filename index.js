// ============================================================
// 10X VAs — Telegram Bot v3.0
// Node.js + Express + Redis — Railway Deployment
// Clean rebuild for May 16 cutoff launch
// ============================================================

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const app     = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — allow GHL and any origin to connect
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-pass');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================
// CONFIG
// ============================================================
const TOKEN        = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT = process.env.ALLOWED_CHAT;
const TOPIC_ID     = process.env.TOPIC_ID;
const WEBHOOK_URL  = process.env.WEBHOOK_URL;
const SHEET_ID     = process.env.SHEET_ID;
const GOOGLE_SA    = process.env.GOOGLE_SA ? JSON.parse(process.env.GOOGLE_SA) : null;
const REDIS_URL    = process.env.REDIS_URL;
const ADMIN_PASS   = process.env.ADMIN_PASS || '10xvas';
const PORT         = process.env.PORT || 8080;

const GRACE_MINS     = 4;
const EARLY_LIMIT    = 30;
const BBL_MINS       = 90;
const LUNCH_MINS     = 60;
const MAX_SHIFT_HRS  = 8;
const TARGET_HRS     = 80;   // VA/UYP/Admin cutoff target
const LEADER_MAX_HRS = 90;   // Leader hard cap
const DAILY_RESET_HR = 18;   // 6 PM Manila

// Cutoff anchors
const VA_CUTOFF_ANCHOR_MS = new Date('2026-05-16T09:00:00+08:00').getTime();
const VA_CUTOFF_DAYS      = 14;

// ============================================================
// REDIS CLIENT
// ============================================================
let redisClient = null;

async function getRedis() {
  if (redisClient) return redisClient;
  if (!REDIS_URL) return null;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', e => console.error('Redis error:', e.message));
    await redisClient.connect();
    console.log('Redis connected');
    return redisClient;
  } catch(e) {
    console.error('Redis connect failed:', e.message);
    return null;
  }
}

// In-memory fallback
const MEM = {};

async function redisGet(key) {
  try {
    const r = await getRedis();
    if (r) return await r.get(key);
  } catch(e) {}
  return MEM[key] || null;
}

async function redisSet(key, value) {
  try {
    const r = await getRedis();
    if (r) { await r.set(key, value); return; }
  } catch(e) {}
  MEM[key] = value;
}

async function redisDel(key) {
  try {
    const r = await getRedis();
    if (r) { await r.del(key); return; }
  } catch(e) {}
  delete MEM[key];
}

async function redisKeys(pattern) {
  try {
    const r = await getRedis();
    if (r) return await r.keys(pattern);
  } catch(e) {}
  return Object.keys(MEM).filter(k => {
    const p = pattern.replace('*', '.*');
    return new RegExp(p).test(k);
  });
}

// ============================================================
// ROSTER — stored in Redis, seeded from DEFAULT_ROSTER
// ============================================================
const DEFAULT_ROSTER = [
  { id:'2009869833', name:'Queency', role:'VA',     schedules:[{ days:[1,1,1,1,1,0,0], start:'8:00 PM',  end:'5:00 AM' }] },
  { id:'7831137596', name:'Maku',    role:'VA',     schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' }] },
  { id:'1802251672', name:'Lovely',  role:'VA',     schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' }] },
  { id:'8393347347', name:'Mary',    role:'VA',     schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' }] },
  { id:'5359971666', name:'Pam',     role:'VA',     schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'5:00 AM' }] },
  // Cris: Mon-Thu 9PM-5AM, Friday 11PM-7AM
  { id:'6012486581', name:'Cris',    role:'VA',     schedules:[
    { days:[1,1,1,1,0,0,0], start:'9:00 PM',  end:'5:00 AM' },
    { days:[0,0,0,0,1,0,0], start:'11:00 PM', end:'7:00 AM' },
  ]},
  { id:'5660256653', name:'Jude',    role:'VA',     schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM',  end:'6:00 AM' }] },
  { id:'7207758648', name:'Noreen',  role:'VA',     schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'8:00 AM' }] },
  { id:'8070441816', name:'John',    role:'VA',     schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  // Cha: Tue-Fri 12AM-9AM, Monday 2AM-9AM
  { id:'6705167382', name:'Cha',     role:'VA',     schedules:[
    { days:[0,1,1,1,1,0,0], start:'12:00 AM', end:'9:00 AM' },
    { days:[1,0,0,0,0,0,0], start:'2:00 AM',  end:'9:00 AM' },
  ]},
  { id:'7148499363', name:'Alexis',  role:'VA',     schedules:[{ days:[0,0,1,1,1,1,1], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'7514392042', name:'Kate',    role:'VA',     schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'6088627916', name:'Nina',    role:'UYP',    schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'5685031197', name:'Kat',     role:'UYP',    schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'6132223983', name:'Yuqi',    role:'UYP',    schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'8044736892', name:'Bert',    role:'Leader', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'7240390530', name:'Moon',    role:'Leader', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'7830367843', name:'Nell',    role:'Leader', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'2018117745', name:'Gab',     role:'Leader', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'6971608069', name:'Kent',    role:'Admin',  schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'8693973681', name:'Fourth',  role:'VA',     schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
];

// Roster cache
let rosterCache = null;

async function getRoster() {
  if (rosterCache) return rosterCache;
  try {
    const raw = await redisGet('roster');
    if (raw) {
      rosterCache = JSON.parse(raw);
      return rosterCache;
    }
  } catch(e) {}
  // Seed default
  await saveRoster(DEFAULT_ROSTER);
  return DEFAULT_ROSTER;
}

async function saveRoster(roster) {
  rosterCache = roster;
  await redisSet('roster', JSON.stringify(roster));
}

async function getUserById(uid) {
  const roster = await getRoster();
  return roster.find(u => u.id === String(uid)) || null;
}

// ============================================================
// UTILITIES
// ============================================================
function manilaTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone:'Asia/Manila' }));
}

function fmtTime(date) {
  return date.toLocaleString('en-US', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit', hour12:true });
}

function fmtDate(date) {
  return date.toLocaleString('en-US', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' });
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}:${String(m).padStart(2,'0')}`;
}

function minsBetween(a, b) { return Math.round((b - a) / 60000); }
function getManilaDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone:'Asia/Manila' });
}

function to24h(timeStr) {
  const [time, period] = timeStr.trim().split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function getShiftWindow(sched, dateStr) {
  const start = new Date(`${dateStr}T${to24h(sched.start)}:00+08:00`);
  let   end   = new Date(`${dateStr}T${to24h(sched.end)}:00+08:00`);
  if (end <= start) end = new Date(end.getTime() + 86400000);
  return { start, end };
}

function getTodaySchedule(user, manila) {
  const dow = manila.getDay(); // 0=Sun
  const idx = dow === 0 ? 6 : dow - 1; // Mon=0...Sun=6
  for (const sched of (user.schedules || [])) {
    if (sched.days[idx]) return sched;
  }
  return null;
}

function isLeader(role) { return role === 'Leader'; }
function isVAlike(role) { return ['VA','Admin','UYP'].includes(role); }

// ============================================================
// CUTOFF DATES
// ============================================================
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
  const anchor   = new Date(VA_CUTOFF_ANCHOR_MS);
  const interval = VA_CUTOFF_DAYS * 86400000;
  const n        = Math.floor((now - anchor) / interval);
  const start    = new Date(anchor.getTime() + n * interval);
  return { start, end: new Date(start.getTime() + interval) };
}

function isLastCutoffDay(role) {
  const now = new Date();
  const co  = getCutoffDates(role);
  return getManilaDateStr(now) === getManilaDateStr(co.end);
}

// ============================================================
// STATE — Redis
// ============================================================
async function getState(uid) {
  try {
    const raw = await redisGet(`state:${uid}`);
    return raw ? JSON.parse(raw) : { status:'out' };
  } catch(e) { return { status:'out' }; }
}

async function setState(uid, state) {
  await redisSet(`state:${uid}`, JSON.stringify(state));
}

async function clearState(uid) {
  await redisDel(`state:${uid}`);
}

// ============================================================
// CUTOFF HOURS — Redis
// ============================================================
async function getCutoffHours(uid) {
  try {
    const raw = await redisGet(`cutoff:${uid}`);
    return raw ? JSON.parse(raw) : { hours:0, ot:0 };
  } catch(e) { return { hours:0, ot:0 }; }
}

async function setCutoffHours(uid, data) {
  await redisSet(`cutoff:${uid}`, JSON.stringify(data));
}

async function addCutoffHours(uid, name, role, addHours, addOT) {
  const current = await getCutoffHours(uid);
  let newHours  = Math.round((current.hours + addHours) * 100) / 100;
  let newOT     = Math.round((current.ot + (addOT||0)) * 100) / 100;

  if (isLeader(role)) {
    const combined = newHours + newOT;
    if (combined > LEADER_MAX_HRS) {
      newHours = Math.min(newHours, LEADER_MAX_HRS);
      newOT    = Math.max(0, LEADER_MAX_HRS - newHours);
    }
  } else {
    newHours = Math.min(newHours, TARGET_HRS);
  }

  await setCutoffHours(uid, { hours:newHours, ot:newOT });

  // Async sheet log
  logCutoffToSheet(uid, name, role, newHours, newOT).catch(console.error);
}

async function resetCutoffForUser(uid) {
  await setCutoffHours(uid, { hours:0, ot:0 });
}

// ============================================================
// PAYABLE HOURS
// ============================================================
function calcPayable(user, state, logoutTime) {
  try {
    const role     = user.role;
    const login    = new Date(state.loginTime);
    const logout   = logoutTime;
    const shiftDay = state.shiftDate || getManilaDateStr(manilaTime());
    const sched    = user.schedules.find(s => s.days[[6,0,1,2,3,4,5][new Date(shiftDay + 'T12:00:00+08:00').getDay()]]);
    if (!sched) return { hours:0, ot:0 };

    const win = getShiftWindow(sched, shiftDay);
    const effLogin  = login  > win.start ? login  : win.start;
    const effLogout = logout < win.end   ? logout : win.end;

    let lateMs = Math.max(0, effLogin - win.start);
    if (lateMs <= GRACE_MINS * 60000) lateMs = 0;

    let grossMs = Math.max(0, effLogout - effLogin);

    const shiftMins = minsBetween(win.start, win.end);
    const hasLunch  = shiftMins >= 510;
    // Always use lunchUsedMs — stores actual time taken (set correctly on /back)
    let lunchMs = 0;
    if (hasLunch) lunchMs = state.lunchUsedMs || 0;

    let netMs = Math.max(0, grossMs - lunchMs - (state.overbreakMs||0) - (state.overlunchMs||0) - lateMs);
    let hours = netMs / 3600000;

    if (!isLeader(role)) hours = Math.min(hours, MAX_SHIFT_HRS);

    let ot = 0;
    if (isLeader(role) && login < win.start) {
      ot = Math.floor((win.start - login) / (30*60000)) * 0.5;
    }

    return { hours: Math.round(hours*100)/100, ot: Math.round(ot*100)/100 };
  } catch(e) {
    console.error('calcPayable:', e.message);
    return { hours:0, ot:0 };
  }
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendMsg(text, chatId, topicId) {
  try {
    const payload = { chat_id:chatId, text, parse_mode:'HTML' };
    if (topicId) payload.message_thread_id = parseInt(topicId);
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, payload);
  } catch(e) { console.error('sendMsg:', e.message); }
}

// ============================================================
// GOOGLE SHEETS — append only
// ============================================================
let _googleToken = null;
let _googleTokenExpiry = 0;

async function getGoogleToken() {
  if (_googleToken && Date.now() < _googleTokenExpiry) return _googleToken;
  if (!GOOGLE_SA) return null;
  try {
    const now    = Math.floor(Date.now()/1000);
    const header  = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss:   GOOGLE_SA.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud:   'https://oauth2.googleapis.com/token',
      exp:   now+3600, iat: now,
    })).toString('base64url');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(GOOGLE_SA.private_key, 'base64url');
    const jwt = `${header}.${payload}.${sig}`;
    const res = await axios.post('https://oauth2.googleapis.com/token',
      new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:jwt })
    );
    _googleToken = res.data.access_token;
    _googleTokenExpiry = Date.now() + 3500000;
    return _googleToken;
  } catch(e) { console.error('getGoogleToken:', e.message); return null; }
}

async function sheetAppend(sheetName, values) {
  if (!SHEET_ID || !GOOGLE_SA) return;
  try {
    const token = await getGoogleToken();
    if (!token) return;
    const range = encodeURIComponent(`'${sheetName}'!A:Z`);
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append`,
      { values },
      { params:{ valueInputOption:'USER_ENTERED' }, headers:{ Authorization:`Bearer ${token}` } }
    );
  } catch(e) { console.error('sheetAppend:', e.response?.data?.error?.message || e.message); }
}

async function logToSheet(uid, name, action, now) {
  await sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), action, name, uid]]);
}

async function logCutoffToSheet(uid, name, role, hours, ot) {
  await sheetAppend('Cutoff Log', [[fmtDate(new Date()), uid, name, role, hours, ot, fmtTime(new Date())]]);
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

async function handleIn(uid, name) {
  const user   = await getUserById(uid);
  const manila = manilaTime();
  const state  = await getState(uid);
  const now    = new Date();

  if (!user) return `🚫 Unauthorized user. Please contact your admin or supervisor.`;

  // Already active (not out, not day-override)
  const dayOverrides = ['holiday','absent','leave','vto'];
  if (state.status !== 'out' && !dayOverrides.includes(state.status)) {
    return `⚠️ You're already logged in, ${name}. If this is an error, please contact your supervisor.`;
  }

  const sched = getTodaySchedule(user, manila);
  if (!sched) {
    return `📋 Hi ${name}! Today doesn't appear to be a scheduled workday for you. If you think this is an error, please reach out to your supervisor.`;
  }

  const dateStr      = getManilaDateStr(manila);
  const win          = getShiftWindow(sched, dateStr);
  const minsToShift  = minsBetween(now, win.start);
  const minsLate     = minsBetween(win.start, now);
  const isVeryEarly  = minsToShift > EARLY_LIMIT;
  const isSlightEarly = minsToShift > 0 && minsToShift <= EARLY_LIMIT;
  const isLate       = minsLate > GRACE_MINS;

  // Leaders don't get pre-shift tagged
  const newStatus = (isVeryEarly || isSlightEarly) && !isLeader(user.role) ? 'pre-shift' : 'in';

  await setState(uid, {
    status:      newStatus,
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

  logToSheet(uid, name, 'in', now).catch(console.error);

  if (isVeryEarly && !isLeader(user.role))
    return `🌅 Log In confirmed — ${name}. You're early! Your shift starts at ${fmtTime(win.start)} Manila. We'll mark you active then. 💪`;
  if (isLate)
    return `⏰ Log In confirmed — ${name}. Your shift started at ${fmtTime(win.start)} Manila. You're ${minsLate} min late — this will be reflected in your hours.`;
  return `✅ Log In confirmed — ${name}. Your shift starts at ${sched.start} Manila. Have a great shift! 💪`;
}

async function handleOut(uid, name) {
  const user  = await getUserById(uid);
  const state = await getState(uid);
  const now   = new Date();

  if (!user) return `🚫 Unauthorized user. Please contact your admin or supervisor.`;

  if (state.status === 'out') {
    return `⚠️ You're not currently logged in, ${name}. If this is an error, please contact your supervisor.`;
  }

  // Auto-close open break
  if (state.breakStart && state.breakType) {
    const breakMins = minsBetween(new Date(state.breakStart), now);
    const allowed   = state.breakType==='bbl' ? BBL_MINS : state.breakType==='lunch' ? LUNCH_MINS : state.breakType==='30' ? 30 : 15;
    const over      = breakMins - allowed - GRACE_MINS;
    if (over > 0) {
      if (state.breakType==='lunch'||state.breakType==='bbl') state.overlunchMs=(state.overlunchMs||0)+over*60000;
      else state.overbreakMs=(state.overbreakMs||0)+over*60000;
    }
  }

  const savedState = JSON.parse(JSON.stringify(state));
  await clearState(uid);

  // Calculate and update cutoff hours
  try {
    if (savedState.loginTime && savedState.shiftDate) {
      const result = calcPayable(user, savedState, now);
      await addCutoffHours(uid, name, user.role, result.hours, result.ot);
      const hoursStr = result.hours.toFixed(2);
      const otStr    = result.ot > 0 ? ` (+${result.ot.toFixed(2)}h OT)` : '';
      logToSheet(uid, name, 'out', now).catch(console.error);
      return `👋 Log Out confirmed — ${name}. Total hours for today: <b>${hoursStr}h${otStr}</b>. Contact your manager for any disputes.`;
    }
  } catch(e) { console.error('handleOut:', e.message); }

  logToSheet(uid, name, 'out', now).catch(console.error);
  return `👋 Thank you for logging out, ${name}! See you next shift.`;
}

async function handleBreak(uid, name, breakType) {
  const user  = await getUserById(uid);
  const state = await getState(uid);
  const now   = new Date();

  if (!user) return `🚫 Unauthorized user. Please contact your admin or supervisor.`;

  // Auto-promote pre-shift if shift started
  if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) {
    state.status = 'in';
    await setState(uid, state);
  }

  if (state.status === 'out') return `⚠️ ${name}, you need to log in first before taking a break!`;
  if (state.status !== 'in') return `⚠️ ${name}, you're already on a break! Please /back first.`;

  const allowed = breakType==='bbl' ? BBL_MINS : breakType==='lunch' ? LUNCH_MINS : breakType==='30' ? 30 : 15;
  const back    = new Date(now.getTime() + allowed * 60000);

  // Validations
  if (breakType==='15'||breakType==='30') {
    if (state.bblUsed) return `⚠️ ${name}, you've already used your BBL for this shift.`;
    if ((state.breakUsed||0) + (breakType==='15'?15:30) > 30)
      return `⚠️ ${name}, you've reached your 30-minute break limit for this shift.`;
  }
  if (breakType==='bbl' && (state.bblUsed || (state.breakUsed||0) > 0))
    return `⚠️ ${name}, you've already used your break allowance for this shift.`;
  if (breakType==='lunch' && state.lunchUsed)
    return `⚠️ ${name}, you've already taken your lunch for this shift.`;

  // Check lunch eligibility
  if (breakType==='lunch'||breakType==='bbl') {
    const sched = getTodaySchedule(user, manilaTime());
    if (sched) {
      const shiftMins = minsBetween(getShiftWindow(sched, state.shiftDate||getManilaDateStr(manilaTime())).start,
                                    getShiftWindow(sched, state.shiftDate||getManilaDateStr(manilaTime())).end);
      if (shiftMins < 510) return `⚠️ ${name}, your shift doesn't include a lunch period.`;
    }
  }

  await setState(uid, { ...state, status:breakType, breakStart:now.toISOString(), breakType });
  logToSheet(uid, name, breakType, now).catch(console.error);

  const msgs = {
    '15':    `⏸️ Break confirmed — ${name}. Be back by <b>${fmtTime(back)}</b>. ☕`,
    '30':    `⏸️ Break confirmed — ${name}. Be back by <b>${fmtTime(back)}</b>. ☕`,
    'lunch': `🍽️ Lunch confirmed — ${name}. Be back by <b>${fmtTime(back)}</b>. Enjoy!`,
    'bbl':   `🍽️ Lunch & Break confirmed — ${name}. Be back by <b>${fmtTime(back)}</b>. Enjoy!`,
  };
  return msgs[breakType];
}

async function handleBack(uid, name) {
  const state = await getState(uid);
  const now   = new Date();

  // Auto-promote pre-shift
  if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) {
    state.status = 'in';
    await setState(uid, state);
  }

  if (state.status === 'out') return `⚠️ ${name}, you're not currently logged in.`;
  if (state.status === 'in')  return `⚠️ ${name}, you're not on a break! No need to punch back.`;

  const bt      = state.breakType || '15';
  const allowed = bt==='bbl' ? BBL_MINS : bt==='lunch' ? LUNCH_MINS : bt==='30' ? 30 : 15;
  const actual  = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
  const over    = actual - allowed - GRACE_MINS;

  if (bt==='15')    state.breakUsed = (state.breakUsed||0) + 15;
  if (bt==='30')    state.breakUsed = (state.breakUsed||0) + 30;
  if (bt==='bbl') {
    // Actual lunch portion = actual BBL time minus the 30-min break, capped at LUNCH_MINS
    const actualLunchMins = Math.min(Math.max(0, actual - 30), LUNCH_MINS);
    state.bblUsed     = true;
    state.lunchUsed   = true;
    state.lunchUsedMs = actualLunchMins * 60000;
  }
  if (bt==='lunch') {
    // Actual lunch taken, capped at LUNCH_MINS (any overflow already captured in overlunchMs)
    const actualLunchMins = Math.min(actual, LUNCH_MINS);
    state.lunchUsed   = true;
    state.lunchUsedMs = actualLunchMins * 60000;
  }

  let overMsg = '';
  if (over > 0) {
    if (bt==='lunch'||bt==='bbl') {
      state.overlunchMs=(state.overlunchMs||0)+over*60000;
      overMsg=` You were ${over} min over your lunch — this will be reflected in your hours.`;
    } else {
      state.overbreakMs=(state.overbreakMs||0)+over*60000;
      overMsg=` You were ${over} min over your break — this will be reflected in your hours.`;
    }
  }

  state.status='in'; state.breakStart=null; state.breakType=null;
  await setState(uid, state);
  logToSheet(uid, name, 'back', now).catch(console.error);
  return `✅ Welcome back, ${name}!${overMsg}`;
}

async function handleOffsetIn(uid, name) {
  const user  = await getUserById(uid);
  const state = await getState(uid);
  const now   = new Date();

  if (!user) return `🚫 Unauthorized user.`;
  if (isLeader(user.role)) return `⚠️ ${name}, Leaders don't need to log offset hours.`;

  const manila = manilaTime();
  const sched  = getTodaySchedule(user, manila);
  if (sched) {
    const dateStr = getManilaDateStr(manila);
    const win     = getShiftWindow(sched, dateStr);
    if (now >= win.start && now <= win.end)
      return `⚠️ ${name}, offset hours cannot be logged during your scheduled shift. Use /in instead.`;
  }

  if (state.status === 'offset') return `⚠️ ${name}, you already have an active offset session. Please /offset-out first.`;

  const co        = await getCutoffHours(uid);
  const remaining = Math.max(0, TARGET_HRS - co.hours).toFixed(2);

  await setState(uid, { ...state, status:'offset', offsetStart:now.toISOString() });
  logToSheet(uid, name, 'offset-in', now).catch(console.error);
  return `⏱️ Offset confirmed — ${name}. Remaining this cutoff: <b>${remaining}h</b>. Make it count! 💪`;
}

async function handleOffsetOut(uid, name) {
  const user  = await getUserById(uid);
  const state = await getState(uid);
  const now   = new Date();

  if (!user) return `🚫 Unauthorized user.`;
  if (state.status !== 'offset') return `⚠️ ${name}, you don't have an active offset session.`;

  const startTime   = new Date(state.offsetStart);
  const durationHrs = (now - startTime) / 3600000;
  const co          = await getCutoffHours(uid);
  const newTotal    = co.hours + durationHrs;
  const remaining   = Math.max(0, TARGET_HRS - newTotal).toFixed(2);

  await addCutoffHours(uid, name, user.role, durationHrs, 0);
  await setState(uid, { ...state, status:'out', offsetStart:null });
  logToSheet(uid, name, 'offset-out', now).catch(console.error);
  return `✅ Offset hours logged — ${name}. Duration: <b>${fmtDuration(now-startTime)}</b>. Remaining: <b>${remaining}h</b>.`;
}

async function handleDayOverride(uid, name, type) {
  const user  = await getUserById(uid);
  const state = await getState(uid);
  const now   = new Date();

  if (!user) return `🚫 Unauthorized user.`;

  const dayOverrides = ['holiday','absent','leave','vto'];
  if (dayOverrides.includes(state.status))
    return `⚠️ ${name}, you've already logged <b>${state.status}</b> for today.`;

  const addsHours = type==='holiday'||type==='leave';
  await setState(uid, { ...state, status:type, dayOverride:type });

  if (addsHours) await addCutoffHours(uid, name, user.role, MAX_SHIFT_HRS, 0);
  logToSheet(uid, name, type, now).catch(console.error);

  const msgs = {
    holiday: `🎉 Holiday logged — ${name}. Enjoy your day off!`,
    absent:  `📋 Absent logged — ${name}. Please coordinate with your manager.`,
    leave:   `🌴 Leave logged — ${name}. Enjoy your time off!`,
    vto:     `✅ VTO logged — ${name}. Thank you!`,
  };
  return msgs[type];
}

// Hidden commands
async function handleStatus(uid, name) {
  const state = await getState(uid);
  const statusMap = {
    out:'🔴 Logged Out', in:'🟢 Active', 'pre-shift':'🟣 Pre-Shift',
    '15':'🔵 15-min Break', '30':'🔵 30-min Break', lunch:'🔵 Lunch',
    bbl:'🔵 BBL', offset:'⏱️ Offset', holiday:'🎉 Holiday',
    absent:'📋 Absent', leave:'🌴 On Leave', vto:'✅ VTO',
  };
  let msg = `📊 <b>Status — ${name}</b>\n${statusMap[state.status]||'Unknown'}`;
  if (state.loginTime && state.status==='in') {
    const mins = minsBetween(new Date(state.loginTime), new Date());
    msg += `\nLogged in for: <b>${Math.floor(mins/60)}h ${mins%60}m</b>`;
  }
  return msg;
}

async function handleTotal(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;
  const co   = await getCutoffHours(uid);
  const co_dates = getCutoffDates(user.role);
  const target   = isLeader(user.role) ? `${LEADER_MAX_HRS}h cap` : `${TARGET_HRS}h`;
  const remaining = isLeader(user.role) ? '—' : `${Math.max(0, TARGET_HRS - co.hours).toFixed(2)}h`;
  return `📈 <b>Cutoff Hours — ${name}</b>\n` +
    `Role: <b>${user.role}</b>\n` +
    `Period: <b>${fmtDate(co_dates.start)} – ${fmtDate(co_dates.end)}</b>\n` +
    `Logged: <b>${co.hours.toFixed(2)}h</b>${co.ot > 0 ? ` (+${co.ot.toFixed(2)}h OT)` : ''}\n` +
    `Target: <b>${target}</b>\n` +
    `Remaining: <b>${remaining}</b>`;
}

async function handleSched(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let msg = `📅 <b>Schedule — ${name}</b>\nRole: <b>${user.role}</b>\n`;
  user.schedules.forEach((s, i) => {
    const workDays = days.filter((_,i) => s.days[i]).join(', ');
    msg += `${user.schedules.length > 1 ? `Block ${i+1}: ` : ''}${workDays} | ${s.start} – ${s.end}\n`;
  });
  return msg.trim();
}

async function handleCutoff(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;
  const co     = getCutoffDates(user.role);
  const now    = new Date();
  const daysLeft = Math.ceil((co.end - now) / 86400000);
  const typeMap  = { VA:'Bi-weekly', UYP:'Semi-monthly', Leader:'Bi-weekly', Admin:'Bi-weekly' };
  return `📆 <b>Cutoff Info — ${name}</b>\n` +
    `Type: <b>${typeMap[user.role]}</b>\n` +
    `Start: <b>${fmtDate(co.start)}</b>\n` +
    `End: <b>${fmtDate(co.end)}</b>\n` +
    `Days remaining: <b>${daysLeft}</b>\n` +
    `Target: <b>${isLeader(user.role) ? LEADER_MAX_HRS+'h cap' : TARGET_HRS+'h'}</b>`;
}

async function handleHelp(uid, name) {
  return `📖 <b>Commands — ${name}</b>\n\n` +
    `<b>Shift:</b> /in  /out\n` +
    `<b>Breaks:</b> /15  /30  /lunch  /bbl  /back\n` +
    `<b>Day:</b> /holiday  /absent  /leave  /vto\n` +
    `<b>Offset:</b> /offset-in  /offset-out\n` +
    `<b>Info:</b> /status  /total  /sched  /cutoff`;
}

// ============================================================
// WEBHOOK
// ============================================================
const processed = new Set();

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
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

    if (chatId !== ALLOWED_CHAT) return;
    if (topicId !== TOPIC_ID)    return;
    if (processed.has(updateId)) return;
    processed.add(updateId);
    if (processed.size > 2000) processed.delete(processed.values().next().value);

    // Check if user exists in roster
    const user = await getUserById(uid);
    if (!user) {
      await sendMsg(`🚫 Unauthorized user. Please contact your admin or supervisor.`, chatId, topicId);
      return;
    }

    const now    = new Date();
    let reply    = null;

    if      (text==='/in'        || text==='in')         reply = await handleIn(uid, name);
    else if (text==='/out'       || text==='out')        reply = await handleOut(uid, name);
    else if (text==='/back'      || text==='back')       reply = await handleBack(uid, name);
    else if (text==='/15'        || text==='15')         reply = await handleBreak(uid, name, '15');
    else if (text==='/30'        || text==='30')         reply = await handleBreak(uid, name, '30');
    else if (text==='/lunch'     || text==='lunch')      reply = await handleBreak(uid, name, 'lunch');
    else if (text==='/bbl'       || text==='bbl')        reply = await handleBreak(uid, name, 'bbl');
    else if (text==='/offset-in' || text==='offset-in')  reply = await handleOffsetIn(uid, name);
    else if (text==='/offset-out'|| text==='offset-out') reply = await handleOffsetOut(uid, name);
    else if (text==='/holiday'   || text==='holiday')    reply = await handleDayOverride(uid, name, 'holiday');
    else if (text==='/absent'    || text==='absent')     reply = await handleDayOverride(uid, name, 'absent');
    else if (text==='/leave'     || text==='leave')      reply = await handleDayOverride(uid, name, 'leave');
    else if (text==='/vto'       || text==='vto')        reply = await handleDayOverride(uid, name, 'vto');
    else if (text==='/status'    || text==='status')     reply = await handleStatus(uid, name);
    else if (text==='/total'     || text==='total')      reply = await handleTotal(uid, name);
    else if (text==='/sched'     || text==='sched')      reply = await handleSched(uid, name);
    else if (text==='/cutoff'    || text==='cutoff')     reply = await handleCutoff(uid, name);
    else if (text==='/help'      || text==='help')       reply = await handleHelp(uid, name);

    if (reply) await sendMsg(reply, chatId, topicId);
  } catch(e) { console.error('webhook:', e.message); }
});

// ============================================================
// DASHBOARD API
// ============================================================
app.get('/dashboard', async (req, res) => {
  const cb   = req.query.callback;
  const data = await getDashboardData();
  if (cb) {
    res.setHeader('Content-Type','application/javascript');
    res.send(`${cb}(${JSON.stringify(data)})`);
  } else res.json(data);
});

async function getDashboardData() {
  const now    = new Date();
  const manila = manilaTime();
  const roster = await getRoster();
  const users  = [];

  for (const user of roster) {
    const state = await getState(user.id);
    const sched = getTodaySchedule(user, manila);
    const co    = await getCutoffHours(user.id);

    let status='offline', label='Offline', elapsed='', shiftStart='', shiftEnd='', shiftProgress=0;

    const dayOverrides = ['holiday','absent','leave','vto'];
    if (dayOverrides.includes(state.status)) {
      const lm = { holiday:'Holiday 🎉', absent:'Absent', leave:'On Leave 🌴', vto:'VTO' };
      status = state.status; label = lm[state.status];
    } else if (sched) {
      const dateStr = state.shiftDate || getManilaDateStr(manila);
      const win     = getShiftWindow(sched, dateStr);
      shiftStart    = fmtTime(win.start);
      shiftEnd      = fmtTime(win.end);
      const totalMs = win.end - win.start;
      shiftProgress = Math.round(Math.min(100, Math.max(0, (now - win.start) / totalMs * 100)));

      if (state.status === 'out') {
        status = (now >= win.start && now <= win.end) ? 'missing' : 'offline';
        label  = status === 'missing' ? 'Missing' : 'Offline';
      } else if (state.status === 'pre-shift') {
        if (now >= new Date(state.shiftStart||win.start)) {
          status='active'; label='Active';
          // Auto-promote
          setState(user.id, { ...state, status:'in' }).catch(()=>{});
        } else {
          status='pre-shift'; label='Pre-Shift';
        }
        if (state.loginTime) elapsed = minsBetween(new Date(state.loginTime), now) + 'm';
      } else if (state.status === 'in') {
        const hasOverbreak = (state.overbreakMs||0) > 0 || (state.overlunchMs||0) > 0;
        status = state.isLate ? 'late' : (hasOverbreak ? 'overbreak' : 'active');
        label  = state.isLate ? 'Active — Late In' : (hasOverbreak ? 'Active — Overbreak' : 'Active');
        if (state.loginTime) elapsed = minsBetween(new Date(state.loginTime), now) + 'm';
      } else {
        const bl={'15':'15-min Break','30':'30-min Break','lunch':'Lunch','bbl':'BBL'};
        const bs={'15':'break','30':'break','lunch':'lunch','bbl':'bbl'};
        status = bs[state.status]||'break';
        label  = bl[state.status]||'Break';
        if (state.breakStart) elapsed = minsBetween(new Date(state.breakStart), now) + 'm';
      }
    } else { label='Day Off'; }

    const coDates = getCutoffDates(user.role);

    // Real-time running hours: add current in-progress shift hours to stored total
    let liveHours = co.hours;
    if (state.loginTime && ['in','pre-shift','15','30','lunch','bbl'].includes(state.status)) {
      try {
        const dateStr2 = state.shiftDate || getManilaDateStr(manila);
        const sched2   = getTodaySchedule(user, new Date(dateStr2 + 'T12:00:00+08:00'));
        if (sched2) {
          const win2     = getShiftWindow(sched2, dateStr2);
          const login    = new Date(state.loginTime);
          const effLogin = login > win2.start ? login : win2.start;
          const effNow   = now < win2.end ? now : win2.end;
          let grossMs    = Math.max(0, effNow - effLogin);
          let lateMs     = Math.max(0, effLogin - win2.start);
          if (lateMs <= GRACE_MINS * 60000) lateMs = 0;
          const breakMs  = (state.overbreakMs||0) + (state.overlunchMs||0);
          const lunchMs  = state.lunchUsedMs || 0;
          let netMs      = Math.max(0, grossMs - lateMs - breakMs - lunchMs);
          let liveShift  = netMs / 3600000;
          if (!isLeader(user.role)) liveShift = Math.min(liveShift, MAX_SHIFT_HRS);
          liveHours = Math.round((co.hours + liveShift) * 100) / 100;
        }
      } catch(e) {}
    }

    const dispHours = isLeader(user.role) ? Math.min(liveHours, LEADER_MAX_HRS) : liveHours;
    const dispOT    = isLeader(user.role) ? Math.min(co.ot, Math.max(0, LEADER_MAX_HRS - liveHours)) : co.ot;

    users.push({
      id:user.id, name:user.name, role:user.role,
      status, statusLabel:label, shiftStart, shiftEnd, elapsed, shiftProgress,
      runningHours:dispHours, otHours:dispOT,
      loginTime:     state.loginTime || '',           // ISO string — exact timestamp
      loginTimeDisp: state.loginTime ? fmtTime(new Date(state.loginTime)) : '', // formatted for display
      breakStart:    state.breakStart || '',           // ISO string for break timer
      breakUsed: state.breakUsed||0, bblUsed: state.bblUsed||false,
      cutoffEnd: fmtDate(coDates.end),
    });
  }

  const statusOrder = {
    missing:0, absent:1, overbreak:2, late:3,
    break:4, lunch:5, bbl:6, active:7,
    'pre-shift':8, offset:9, holiday:10, leave:11, vto:12, offline:13,
  };
  const roleOrder = { Leader:0, UYP:1, VA:2, Admin:2 };
  users.sort((a,b) => {
    const sd = (statusOrder[a.status]??14) - (statusOrder[b.status]??14);
    if (sd !== 0) return sd;
    return (roleOrder[a.role]??3) - (roleOrder[b.role]??3);
  });

  const vaCo = getCutoffDates('VA');
  return {
    timestamp:  fmtTime(now),
    date:       fmtDate(now),
    manilaTime: manila.toLocaleString('en-US'),
    cutoffStart: fmtDate(vaCo.start),
    cutoffEnd:   fmtDate(vaCo.end),
    users,
  };
}

// ============================================================
// ADMIN API — password protected
// ============================================================
function checkAuth(req, res) {
  const pass = req.headers['x-admin-pass'] || req.query.pass || req.body?.pass;
  if (pass !== ADMIN_PASS) {
    res.status(401).json({ error:'Unauthorized' });
    return false;
  }
  return true;
}

// Get roster
app.get('/admin/roster', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const roster = await getRoster();
  res.json(roster);
});

// Update full roster
app.post('/admin/roster', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { roster } = req.body;
  if (!Array.isArray(roster)) return res.status(400).json({ error:'Invalid roster' });
  await saveRoster(roster);
  rosterCache = null;
  res.json({ ok:true, count:roster.length });
});

// Add/update single user
app.post('/admin/user', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { id, name, role, schedules } = req.body;
  if (!id||!name||!role||!schedules) return res.status(400).json({ error:'Missing fields' });
  const roster = await getRoster();
  const idx    = roster.findIndex(u => u.id === String(id));
  const user   = { id:String(id), name, role, schedules };
  if (idx >= 0) roster[idx] = user;
  else roster.push(user);
  await saveRoster(roster);
  rosterCache = null;
  res.json({ ok:true, user });
});

// Delete user
app.delete('/admin/user/:id', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const roster  = await getRoster();
  const filtered = roster.filter(u => u.id !== req.params.id);
  await saveRoster(filtered);
  rosterCache = null;
  res.json({ ok:true, removed: roster.length - filtered.length });
});

// Get all states (admin view)
app.get('/admin/states', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const keys   = await redisKeys('state:*');
  const states = {};
  for (const k of keys) {
    const uid = k.replace('state:','');
    states[uid] = await getState(uid);
  }
  res.json(states);
});

// Reset all states
app.post('/admin/reset-states', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const keys = await redisKeys('state:*');
  for (const k of keys) await redisDel(k);
  // Re-register webhook with drop_pending
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: `${WEBHOOK_URL}/webhook`,
      drop_pending_updates: true,
    });
  } catch(e) {}
  res.json({ ok:true, cleared:keys.length });
});

// Seed cutoff hours
app.post('/admin/seed-cutoff', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { data } = req.body; // [{ id, hours, ot }]
  if (!Array.isArray(data)) return res.status(400).json({ error:'Invalid data' });
  for (const d of data) await setCutoffHours(d.id, { hours:d.hours||0, ot:d.ot||0 });
  res.json({ ok:true, seeded:data.length });
});

// Get cutoff hours
app.get('/admin/cutoff', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const roster = await getRoster();
  const result = {};
  for (const u of roster) result[u.id] = { name:u.name, role:u.role, ...(await getCutoffHours(u.id)) };
  res.json(result);
});

// ============================================================
// RESET ENDPOINTS (legacy support)
// ============================================================
app.get('/shift-reset', async (req, res) => {
  const keys = await redisKeys('state:*');
  for (const k of keys) await redisDel(k);
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: `${WEBHOOK_URL}/webhook`, drop_pending_updates: true,
    });
  } catch(e) {}
  res.json({ ok:true, cleared:keys.length });
});

// ============================================================
// SCHEDULER — daily reset + cutoff reset
// ============================================================

function getManilaHHMM() {
  const now = new Date();
  const manila = new Date(now.toLocaleString('en-US', { timeZone:'Asia/Manila' }));
  return { h: manila.getHours(), m: manila.getMinutes(), dateStr: getManilaDateStr(manila) };
}

async function runDailyReset() {
  console.log('[Scheduler] Running daily reset (6PM Manila)');
  try {
    const keys = await redisKeys('state:*');
    for (const key of keys) {
      await redisDel(key);
    }
    console.log(`[Scheduler] Daily reset: cleared ${keys.length} states`);

    // Re-register webhook with drop_pending
    await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: `${WEBHOOK_URL}/webhook`, drop_pending_updates: true,
    });
    console.log('[Scheduler] Webhook refreshed');
  } catch(e) { console.error('[Scheduler] Daily reset error:', e.message); }
}

async function runCutoffReset() {
  console.log('[Scheduler] Running cutoff reset (9AM Manila)');
  try {
    const roster = await getRoster();

    for (const user of roster) {
      // Check if today is the last day of their cutoff
      if (!isLastCutoffDay(user.role)) continue;

      // Reset cutoff hours to 0
      await resetCutoffForUser(user.id);
      console.log(`[Scheduler] Reset cutoff for ${user.name} (${user.role})`);
    }

    // Also clear all states at cutoff reset
    const keys = await redisKeys('state:*');
    for (const key of keys) await redisDel(key);
    console.log(`[Scheduler] Cutoff reset: cleared ${keys.length} states`);

    // Refresh webhook
    await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: `${WEBHOOK_URL}/webhook`, drop_pending_updates: true,
    });
    console.log('[Scheduler] Cutoff reset complete');
  } catch(e) { console.error('[Scheduler] Cutoff reset error:', e.message); }
}

// Track last run dates to avoid double-firing
let lastDailyReset   = '';
let lastCutoffReset  = '';

// Run every minute — check if it's time to fire
setInterval(async () => {
  try {
    const { h, m, dateStr } = getManilaHHMM();

    // Daily reset: 6:00 PM Manila (18:00) — skip on cutoff reset days
    if (h === 18 && m === 0 && lastDailyReset !== dateStr) {
      const roster = await getRoster();
      // Only run daily reset if today is NOT the last cutoff day for any group
      // (cutoff reset takes precedence and handles state clearing)
      const isCutoffDay = roster.some(u => isLastCutoffDay(u.role));
      if (!isCutoffDay) {
        lastDailyReset = dateStr;
        await runDailyReset();
      } else {
        console.log('[Scheduler] Skipping daily reset — cutoff day takes precedence');
        lastDailyReset = dateStr;
      }
    }

    // Cutoff reset: 9:00 AM Manila (09:00)
    if (h === 9 && m === 0 && lastCutoffReset !== dateStr) {
      const roster = await getRoster();
      const hasCutoffToday = roster.some(u => isLastCutoffDay(u.role));
      if (hasCutoffToday) {
        lastCutoffReset = dateStr;
        await runCutoffReset();
      }
    }
  } catch(e) { console.error('[Scheduler] Tick error:', e.message); }
}, 60 * 1000); // check every 60 seconds

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => res.json({
  status:'ok', bot:'10X VAs v3.0',
  redis: REDIS_URL ? 'configured' : 'not configured',
  sheets: GOOGLE_SA ? 'configured' : 'not configured',
  time: new Date().toISOString(),
}));

// ============================================================
// START
// ============================================================
app.listen(PORT, async () => {
  console.log(`10X VAs bot v3.0 on port ${PORT}`);
  await getRedis();
  await getRoster(); // seed roster if not exists
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: `${WEBHOOK_URL}/webhook`, drop_pending_updates: true,
    });
    console.log('Webhook registered');
  } catch(e) { console.error('Webhook failed:', e.message); }
});

// ============================================================
// MINI APP ENDPOINTS
// ============================================================

// GET /me/:uid — returns user state for the mini app
app.get('/me/:uid', async (req, res) => {
  const uid  = req.params.uid;
  const user = await getUserById(uid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const state  = await getState(uid);
  const co     = await getCutoffHours(uid);
  const manila = manilaTime();
  const sched  = getTodaySchedule(user, manila);

  // Shift window
  let shiftStart = '', shiftEnd = '', shiftProgress = 0, hasLunch = false;
  if (sched) {
    const dateStr = state.shiftDate || getManilaDateStr(manila);
    const win     = getShiftWindow(sched, dateStr);
    shiftStart    = fmtTime(win.start);
    shiftEnd      = fmtTime(win.end);
    const totalMs = win.end - win.start;
    const now     = new Date();
    shiftProgress = Math.round(Math.min(100, Math.max(0, (now - win.start) / totalMs * 100)));
    hasLunch      = minsBetween(win.start, win.end) >= 510;
  }

  // Live running hours
  let liveHours = co.hours;
  if (state.loginTime && ['in','pre-shift','15','30','lunch','bbl'].includes(state.status)) {
    try {
      const dateStr2 = state.shiftDate || getManilaDateStr(manila);
      const sched2   = getTodaySchedule(user, new Date(dateStr2 + 'T12:00:00+08:00'));
      if (sched2) {
        const win2     = getShiftWindow(sched2, dateStr2);
        const login    = new Date(state.loginTime);
        const now      = new Date();
        const effLogin = login > win2.start ? login : win2.start;
        const effNow   = now < win2.end ? now : win2.end;
        let grossMs    = Math.max(0, effNow - effLogin);
        let lateMs     = Math.max(0, effLogin - win2.start);
        if (lateMs <= GRACE_MINS * 60000) lateMs = 0;
        const breakMs  = (state.overbreakMs||0) + (state.overlunchMs||0);
        const lunchMs  = state.lunchUsedMs || 0;
        let netMs      = Math.max(0, grossMs - lateMs - breakMs - lunchMs);
        let liveShift  = netMs / 3600000;
        if (!isLeader(user.role)) liveShift = Math.min(liveShift, MAX_SHIFT_HRS);
        liveHours = Math.round((co.hours + liveShift) * 100) / 100;
      }
    } catch(e) {}
  }

  const coDates = getCutoffDates(user.role);

  res.json({
    id:           user.id,
    name:         user.name,
    role:         user.role,
    state,
    shiftStart,
    shiftEnd,
    shiftProgress,
    hasLunch,
    runningHours: liveHours,
    otHours:      co.ot,
    cutoffEnd:    fmtDate(coDates.end),
  });
});

// POST /action — executes a command on behalf of the mini app user
app.post('/action', async (req, res) => {
  const { uid, action } = req.body;
  if (!uid || !action) return res.status(400).json({ error: 'Missing uid or action' });

  const user = await getUserById(uid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const name = user.name;
  let reply  = null;

  try {
    if      (action === 'in')     reply = await handleIn(uid, name);
    else if (action === 'out')    reply = await handleOut(uid, name);
    else if (action === 'back')   reply = await handleBack(uid, name);
    else if (action === '15')     reply = await handleBreak(uid, name, '15');
    else if (action === '30')     reply = await handleBreak(uid, name, '30');
    else if (action === 'lunch')  reply = await handleBreak(uid, name, 'lunch');
    else if (action === 'bbl')    reply = await handleBreak(uid, name, 'bbl');
    else return res.status(400).json({ error: 'Unknown action' });

    // Strip HTML tags for clean mini app messages
    const clean = reply.replace(/<[^>]+>/g, '');
    res.json({ ok: true, message: clean });
  } catch(e) {
    console.error('action endpoint:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});
