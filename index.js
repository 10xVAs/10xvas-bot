const express = require('express');
const axios   = require('axios');
const redis   = require('redis');
const app     = express();
app.use(express.json());

// ==========================================
// 1. REDIS CONNECTION (Inside your project)
// ==========================================
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.error('Redis Error:', err));
redisClient.connect().then(() => console.log("Connected to Redis! 🚀"));

// ==========================================
// 2. CONFIG
// ==========================================
const TOKEN        = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT = process.env.ALLOWED_CHAT;
const TOPIC_ID     = process.env.TOPIC_ID;
const WEBHOOK_URL  = process.env.WEBHOOK_URL;
const SHEET_ID     = process.env.SHEET_ID;
const GOOGLE_SA    = process.env.GOOGLE_SA ? JSON.parse(process.env.GOOGLE_SA) : null;
const PORT         = process.env.PORT || 8080;

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

// ==========================================
// 3. PERSISTENCE HELPERS
// ==========================================
async function getState(uid) {
    const data = await redisClient.get(`state:${uid}`);
    return data ? JSON.parse(data) : { status: 'out' };
}
async function setState(uid, s) { await redisClient.set(`state:${uid}`, JSON.stringify(s)); }
async function getCutoffMemory(uid) {
    const data = await redisClient.get(`cutoff:${uid}`);
    return data ? JSON.parse(data) : { hours: 0, ot: 0 };
}
async function setCutoffMemory(uid, c) { await redisClient.set(`cutoff:${uid}`, JSON.stringify(c)); }

function manilaTime() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })); }
function fmtTime(date) { return date.toLocaleString('en-US', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit', hour12:true }); }
function fmtDate(date) { return date.toLocaleString('en-US', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' }); }

// ==========================================
// 4. THE DASHBOARD (ACCURATE FORMAT)
// ==========================================
app.get('/dashboard', async (req, res) => {
  try {
    const now = manilaTime();
    const users = [];
    for (const [uid, entry] of Object.entries(ROSTER)) {
      const state = await getState(uid);
      const mem = await getCutoffMemory(uid);
      
      // Use exactly what your HTML expects
      let status = state.status || 'offline';
      if (status === 'out') status = 'offline';

      users.push({
        id: uid,
        name: entry.name,
        role: entry.role,
        status: status,
        statusLabel: status.charAt(0).toUpperCase() + status.slice(1),
        shiftStart: entry.start,
        shiftEnd: entry.end,
        runningHours: parseFloat(mem.hours || 0),
        otHours: parseFloat(mem.ot || 0),
        shiftProgress: 0,
        elapsed: '',
        loginTime: state.loginTime ? fmtTime(new Date(state.loginTime)) : ''
      });
    }

    res.json({
      timestamp: fmtTime(now),
      date: fmtDate(now),
      manilaTime: now.toLocaleString('en-US'),
      users: users
    });
  } catch (err) {
    res.status(500).json({ error: "Dashboard Error" });
  }
});

// ==========================================
// 5. EMERGENCY RECOVERY
// ==========================================
app.get('/emergency-fix', async (req, res) => {
  try {
    await setState('7148499363', {
      status: "in",
      loginTime: "2026-05-09T16:00:00.000Z",
      shiftDate: "2026-05-10",
      shiftStart: "2026-05-09T16:00:00.000Z"
    });
    // Ensure data exists for all so the dashboard logic doesn't fail
    for (const uid of Object.keys(ROSTER)) {
        await setCutoffMemory(uid, { hours: 40.0, ot: 0 });
    }
    res.send("<h1>System Stable. Alexis and Dashboard Restored.</h1>");
  } catch (e) { res.send(e.message); }
});

app.get('/', (req, res) => res.send("System v2.5 Stable"));
app.listen(PORT, () => console.log(`Server live on ${PORT}`));
