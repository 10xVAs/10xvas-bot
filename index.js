// ============================================================
// 10X VAs — FULL REDIS RESTORATION (v2.2)
// ============================================================
const express = require('express');
const axios   = require('axios');
const redis   = require('redis');
const app     = express();
app.use(express.json());

// --- REDIS ---
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.log('Redis Error:', err));
redisClient.connect().then(() => console.log("Connected to Redis! 🚀"));

// --- CONFIG ---
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

// --- REDIS HELPERS ---
async function getState(uid) {
    const data = await redisClient.get(`state:${uid}`);
    return data ? JSON.parse(data) : { status: 'out' };
}
async function setState(uid, s) {
    await redisClient.set(`state:${uid}`, JSON.stringify(s));
}
async function getCutoffMemory(uid) {
    const data = await redisClient.get(`cutoff:${uid}`);
    return data ? JSON.parse(data) : { hours: 0, ot: 0 };
}
async function setCutoffMemory(uid, c) {
    await redisClient.set(`cutoff:${uid}`, JSON.stringify(c));
}

// --- UTILS ---
function fmtTime(date) {
  return date.toLocaleString('en-US', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit', hour12:true });
}

// --- EMERGENCY ENDPOINT (Fixes Alexis & Dash) ---
app.get('/emergency-fix', async (req, res) => {
  try {
    for (const uid of Object.keys(ROSTER)) {
        await setCutoffMemory(uid, { hours: 40.0, ot: 0 }); 
    }
    await setState('7148499363', {
      status: "in", loginTime: "2026-05-09T16:00:00.000Z",
      shiftDate: "2026-05-10", shiftStart: "2026-05-09T16:00:00.000Z",
      breakUsed: 0, bblUsed: false, lunchUsed: false, lunchUsedMs: 0,
      overbreakMs: 0, overlunchMs: 0, isLate: false, lateMs: 0
    });
    res.send("<h1>Full Recovery Executed!</h1>");
  } catch (err) { res.send("Error: " + err.message); }
});

// --- DASHBOARD (Exact names for your HTML) ---
app.get('/dashboard', async (req, res) => {
  try {
    const users = [];
    for (const [uid, entry] of Object.entries(ROSTER)) {
      const state = await getState(uid);
      const mem = await getCutoffMemory(uid);
      // We use 'offline' to match your HTML's CSS classes
      let currentStatus = state.status;
      if (currentStatus === 'out' || !currentStatus) currentStatus = 'offline';

      users.push({ 
        name: entry.name, 
        status: currentStatus, 
        hours: mem.hours || 0,
        ot: mem.ot || 0
      });
    }
    res.json({ time: fmtTime(new Date()), users });
  } catch (err) { res.status(500).json({ error: "Dash Fail" }); }
});

app.get('/', (req, res) => res.json({ status:'ok', redis:'connected' }));

app.listen(PORT, async () => {
  console.log(`Live on ${PORT}`);
  await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, { url: `${WEBHOOK_URL}/webhook` }).catch(()=>{});
});
