// ============================================================
// 10X VAs — Telegram Bot
// Node.js + Express — Railway Deployment
// ============================================================

const express  = require('express');
const axios    = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const TOKEN        = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT = process.env.ALLOWED_CHAT;
const TOPIC_ID     = process.env.TOPIC_ID;
const WEBHOOK_URL  = process.env.WEBHOOK_URL;
const PORT         = process.env.PORT || 3000;

const GRACE_MINS  = 5;
const BBL_MINS    = 90;
const LUNCH_MINS  = 60;
const MAX_HRS     = 8;

// ============================================================
// ROSTER
// Days: [Mon,Tue,Wed,Thu,Fri,Sat,Sun]
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
// STATE — in-memory (persists as long as server runs)
// ============================================================
const STATE = {};

function getState(uid) {
  return STATE[uid] || { status: 'out' };
}

function setState(uid, state) {
  STATE[uid] = state;
}

function clearState(uid) {
  delete STATE[uid];
}

// ============================================================
// UTILITIES
// ============================================================
function manilaTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
}

function fmtTime(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function fmtDate(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short', day: 'numeric'
  });
}

function minsBetween(a, b) {
  return Math.round((b - a) / 60000);
}

function to24h(timeStr) {
  const [time, period] = timeStr.trim().split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function getSchedule(uid, manila) {
  const r = ROSTER[uid];
  if (!r) return null;
  const dow = manila.getDay(); // 0=Sun
  const idx = dow === 0 ? 6 : dow - 1;
  return r.days[idx] ? r : null;
}

function getShiftWindow(sched, dateStr) {
  const start = new Date(`${dateStr}T${to24h(sched.start)}:00+08:00`);
  let   end   = new Date(`${dateStr}T${to24h(sched.end)}:00+08:00`);
  if (end <= start) end = new Date(end.getTime() + 86400000);
  return { start, end };
}

function getManilaDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // YYYY-MM-DD
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendMsg(text, chatId, topicId) {
  try {
    const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (topicId) payload.message_thread_id = parseInt(topicId);
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, payload);
  } catch(e) {
    console.error('sendMsg error:', e.message);
  }
}

// ============================================================
// GOOGLE SHEETS LOGGING (async, non-blocking)
// ============================================================
async function logToSheet(uid, name, action) {
  // Simple logging — runs in background, never blocks bot response
  try {
    const now = new Date();
    const res = await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${process.env.SHEET_ID}/values/Telegram%20Logs!A1:E1:append`,
      {
        values: [[fmtDate(now), fmtTime(now), action, name, uid]]
      },
      {
        params: { valueInputOption: 'RAW' },
        headers: { Authorization: `Bearer ${process.env.GOOGLE_TOKEN}` }
      }
    );
  } catch(e) {
    console.error('logToSheet error:', e.message);
  }
}

// ============================================================
// HANDLERS
// ============================================================
async function handleIn(uid, name) {
  const manila = manilaTime();
  const sched  = getSchedule(uid, manila);
  const start  = sched ? sched.start : '—';
  const state  = getState(uid);

  if (state.status !== 'out') {
    return `✅ Thanks for logging in, ${name}! Your shift starts at ${start} Manila.`;
  }

  setState(uid, {
    status:      'in',
    loginTime:   new Date().toISOString(),
    shiftDate:   getManilaDateStr(manila),
    breakUsed:   0,
    bblUsed:     false,
    lunchUsed:   false,
    lunchUsedMs: 0,
    overbreakMs: 0,
    overlunchMs: 0,
    breakStart:  null,
    breakType:   null,
  });

  logToSheet(uid, name, 'in'); // async, non-blocking
  return `✅ Thanks for logging in, ${name}! Your shift starts at ${start} Manila.`;
}

async function handleOut(uid, name) {
  clearState(uid);
  logToSheet(uid, name, 'out');
  return `👋 Thank you for logging out, ${name}! See you next shift.`;
}

async function handleBreak(uid, name, breakType) {
  const state = getState(uid);
  const mins  = breakType==='bbl' ? BBL_MINS : breakType==='lunch' ? LUNCH_MINS : breakType==='30' ? 30 : 15;
  const back  = new Date(Date.now() + mins * 60000);

  setState(uid, { ...state, status: breakType, breakStart: new Date().toISOString(), breakType });
  logToSheet(uid, name, breakType);

  if (breakType==='15')    return `☕ 15-min break, ${name}! Back by ${fmtTime(back)}.`;
  if (breakType==='30')    return `☕ 30-min break, ${name}! Back by ${fmtTime(back)}.`;
  if (breakType==='lunch') return `🍽️ Lunch break, ${name}! Back by ${fmtTime(back)}.`;
  if (breakType==='bbl')   return `🍽️ BBL, ${name}! Back by ${fmtTime(back)}.`;
}

async function handleBack(uid, name) {
  const state = getState(uid);
  const bt    = state.breakType || '15';
  const allowed = bt==='bbl' ? BBL_MINS : bt==='lunch' ? LUNCH_MINS : bt==='30' ? 30 : 15;
  const over    = state.breakStart ? minsBetween(new Date(state.breakStart), new Date()) - allowed - GRACE_MINS : 0;

  if (bt==='15')    state.breakUsed = (state.breakUsed||0) + 15;
  if (bt==='30')    state.breakUsed = (state.breakUsed||0) + 30;
  if (bt==='bbl')   { state.bblUsed=true; state.lunchUsedMs=LUNCH_MINS*60000; }
  if (bt==='lunch') { state.lunchUsed=true; state.lunchUsedMs=LUNCH_MINS*60000; }
  if (over > 0) {
    if (bt==='lunch'||bt==='bbl') state.overlunchMs=(state.overlunchMs||0)+over*60000;
    else state.overbreakMs=(state.overbreakMs||0)+over*60000;
  }

  state.status='in'; state.breakStart=null; state.breakType=null;
  setState(uid, state);
  logToSheet(uid, name, 'back');
  return `✅ Welcome back, ${name}!`;
}

// ============================================================
// WEBHOOK
// ============================================================
const processed = new Set(); // In-memory dedup

app.post('/webhook', async (req, res) => {
  // Return 200 immediately — Telegram never retries
  res.sendStatus(200);

  try {
    const update = req.body;
    const msg    = update.message || update.channel_post;
    if (!msg) return;

    const chatId  = String(msg.chat.id);
    const topicId = msg.message_thread_id ? String(msg.message_thread_id) : null;
    const uid     = String(msg.from.id);
    const text    = (msg.text || '').trim().toLowerCase();
    const name    = msg.from.first_name || msg.from.username || 'User';
    const updateId = String(update.update_id);

    // Filters
    if (chatId !== ALLOWED_CHAT) return;
    if (topicId !== TOPIC_ID)    return;
    if (!ROSTER[uid])            return;

    // Dedup
    if (processed.has(updateId)) return;
    processed.add(updateId);
    // Keep set small — remove old IDs after 1000
    if (processed.size > 1000) {
      const first = processed.values().next().value;
      processed.delete(first);
    }

    // Route
    let reply = null;
    if      (text==='/in'    || text==='in')    reply = await handleIn(uid, name);
    else if (text==='/out'   || text==='out')   reply = await handleOut(uid, name);
    else if (text==='/back'  || text==='back')  reply = await handleBack(uid, name);
    else if (text==='/15'    || text==='15')    reply = await handleBreak(uid, name, '15');
    else if (text==='/30'    || text==='30')    reply = await handleBreak(uid, name, '30');
    else if (text==='/lunch' || text==='lunch') reply = await handleBreak(uid, name, 'lunch');
    else if (text==='/bbl'   || text==='bbl')   reply = await handleBreak(uid, name, 'bbl');

    if (reply) await sendMsg(reply, chatId, topicId);

  } catch(err) {
    console.error('webhook error:', err.message);
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', bot: '10X VAs', time: new Date().toISOString() }));

// ============================================================
// DASHBOARD ENDPOINT
// ============================================================
app.get('/dashboard', (req, res) => {
  const cb   = req.query.callback;
  const data = getDashboardData();
  if (cb) {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`${cb}(${JSON.stringify(data)})`);
  } else {
    res.json(data);
  }
});

function getDashboardData() {
  const now    = new Date();
  const manila = manilaTime();
  const users  = [];

  for (const [uid, entry] of Object.entries(ROSTER)) {
    const state = getState(uid);
    const sched = getSchedule(uid, manila);
    let status = 'offline', label = 'Offline';
    let elapsed = '', shiftStart = '', shiftEnd = '';

    if (sched) {
      const dateStr = getManilaDateStr(manila);
      const win     = getShiftWindow(sched, dateStr);
      shiftStart    = fmtTime(win.start);
      shiftEnd      = fmtTime(win.end);

      if (state.status === 'out') {
        status = (now >= win.start && now <= win.end) ? 'missing' : 'offline';
        label  = status === 'missing' ? 'Missing' : 'Offline';
      } else if (state.status === 'in') {
        status = 'active'; label = 'Active';
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

    users.push({
      id: uid, name: entry.name, role: entry.role,
      status, statusLabel: label,
      shiftStart, shiftEnd, elapsed,
      runningHours: 0, otHours: 0,
      loginTime: state.loginTime ? fmtTime(new Date(state.loginTime)) : '',
      breakUsed: state.breakUsed || 0,
      bblUsed: state.bblUsed || false,
      cutoffEnd: '',
    });
  }

  const order = {active:0,'active-late':1,break:2,bbl:3,lunch:4,missing:5,offline:6};
  users.sort((a,b) => ((order[a.status]??7) - (order[b.status]??7)));

  return {
    timestamp:  fmtTime(now),
    date:       fmtDate(now),
    manilaTime: now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }),
    users,
  };
}

// ============================================================
// START
// ============================================================
app.listen(PORT, async () => {
  console.log(`10X VAs bot running on port ${PORT}`);
  // Register webhook with Telegram
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: `${WEBHOOK_URL}/webhook`,
      drop_pending_updates: true,
    });
    console.log('Webhook registered:', WEBHOOK_URL);
  } catch(e) {
    console.error('Webhook registration failed:', e.message);
  }
});
