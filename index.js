// ============================================================
// 10X VAs — Real-Time Attendance System v2.0
// Node.js + Express + Supabase (Postgres) + Redis (cache/ephemeral)
// ============================================================
//
// TABLE OF CONTENTS
// ~~~~~~~~~~~~~~~~~
//   §1  SETUP          — Timezone, Express, crash guards, CORS
//   §2  CONFIG         — Environment vars and system constants
//   §3  REDIS          — Connection + ephemeral key-value helpers
//   §4  POSTGRES       — Supabase pool + query helpers
//   §5  ROSTER         — User CRUD (Postgres primary, Redis fallback)
//   §6  CLIENTS        — Client CRUD (Postgres primary, Redis fallback)
//   §7  UTILITIES      — Time/date formatting, schedule resolution
//   §8  CUTOFF DATES   — Period boundaries and expected-hours calc
//   §9  STATE          — Live session state (Redis-only, ephemeral)
//   §10 CUTOFF HOURS   — Running accumulator (Postgres primary)
//   §11 SHIFT WINDOWS  — Per-window persistent records (Postgres primary)
//   §12 APPROVALS      — Request queue (Postgres primary)
//   §13 EDIT LOG       — Audit trail (Postgres primary, Sheets backup)
//   §14 FINANCIALS     — Rate config (Redis-only, to be migrated)
//   §15 SNAPSHOTS      — Cached dashboard snapshots (Redis-only)
//   §16 GOOGLE SHEETS  — Append-only audit log
//   §17 TELEGRAM       — Send helpers (group, DM, leader broadcast)
//   §18 DEDUP          — Webhook deduplication (Redis-only)
//   §19 PAYROLL CALC   — calcPayable() — payable hours computation
//   §20 COMMANDS       — handleIn/Out/Break/Lunch/BBL/Bio/Back/Override
//   §21 DAY OVERRIDES  — Holiday/Absent/Leave/VTO via approval
//   §22 OFFSET/OT      — Offset and OT session handlers
//   §23 WEBHOOK        — Telegram webhook route
//   §24 DASHBOARD API  — GET /dashboard + getDashboardData()
//   §25 ADMIN API      — Roster, cutoff, states, approvals, overrides
//   §26 MINI APP API   — /whoami, /me, /action, /request
//   §27 TASKS          — Client↔VA task system (Postgres primary)
//   §28 DAY PLANNER    — 30-min color-coded blocks (Redis-only)
//   §29 CLIENT SCHED   — Client schedule plotting
//   §30 CLIENT FEEDBACK— Feedback inbox (Redis-only, to be migrated)
//   §31 FINANCIALS API — Summary endpoint
//   §32 SCHEDULER      — Timed jobs: daily reset, cutoff, reports
//   §33 HEALTH/STARTUP — Health check, error handler, boot sequence
//
// ============================================================

// §1 SETUP
// CRITICAL: Set timezone before anything else.
// The entire system is built around 6PM Manila as the foundation.
// Without this, Date parsing on UTC servers produces wrong window dates.
process.env.TZ = 'Asia/Manila';

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const app     = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── CRASH GUARDS ──────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH GUARD] Unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught exception:', err.message);
});

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-pass,x-initdata');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// §2 CONFIG
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

// ─────────────────────────────────────────────────────────────
// TRUTH LAYER — all constants now live in Postgres tables
//   system_config: key/value pairs (grace_mins, lunch_mins, etc.)
//   role_config:   per-role rules (cap_hrs, is_internal, etc.)
//
// In-process caches refresh from Postgres every 60 seconds and
// on any admin change to those tables. Defaults below are ONLY
// used at first boot before the cache loads or if Postgres fails.
// ─────────────────────────────────────────────────────────────

// Safe defaults — used only if config cache hasn't loaded yet
const CONFIG_DEFAULTS = {
  grace_mins:       3,
  break_mins:       30,
  lunch_mins:       60,
  bbl_mins:         90,
  bio_warn_mins:    5,
  max_shift_hrs:    8,
  ot_block_mins:    30,
  daily_reset_hr:   18,
  finalize_hr:      2,
  cutoff_reset_hr:  9,
  cutoff_report_hr: 14,
  va_cutoff_anchor: '2026-05-16T09:00:00+08:00',
  va_cutoff_days:   14,
  currency:         'USD',
  default_timezone: 'Asia/Manila',
};

const ROLE_DEFAULTS = {
  'Owner':    { is_payroll_eligible:false, can_login:false, is_internal:false, is_management:false, cutoff_type:null,           cutoff_cap_hrs:null, daily_cap_hrs:null, can_request_ot:false, can_request_offset:false, default_in_snapshot:false },
  'Director': { is_payroll_eligible:false, can_login:false, is_internal:false, is_management:true,  cutoff_type:null,           cutoff_cap_hrs:null, daily_cap_hrs:null, can_request_ot:false, can_request_offset:false, default_in_snapshot:false },
  'Internal': { is_payroll_eligible:true,  can_login:true,  is_internal:true,  is_management:true,  cutoff_type:'bi-weekly',    cutoff_cap_hrs:90,   daily_cap_hrs:null, can_request_ot:true,  can_request_offset:true,  default_in_snapshot:true  },
  'Admin':    { is_payroll_eligible:true,  can_login:true,  is_internal:false, is_management:false, cutoff_type:'bi-weekly',    cutoff_cap_hrs:80,   daily_cap_hrs:8,    can_request_ot:true,  can_request_offset:true,  default_in_snapshot:true  },
  'VA I':     { is_payroll_eligible:true,  can_login:true,  is_internal:false, is_management:false, cutoff_type:'bi-weekly',    cutoff_cap_hrs:80,   daily_cap_hrs:8,    can_request_ot:true,  can_request_offset:true,  default_in_snapshot:true  },
  'VA II':    { is_payroll_eligible:true,  can_login:true,  is_internal:false, is_management:false, cutoff_type:'bi-weekly',    cutoff_cap_hrs:80,   daily_cap_hrs:8,    can_request_ot:true,  can_request_offset:true,  default_in_snapshot:true  },
  'UYP':      { is_payroll_eligible:true,  can_login:true,  is_internal:false, is_management:false, cutoff_type:'semi-monthly', cutoff_cap_hrs:null, daily_cap_hrs:8,    can_request_ot:true,  can_request_offset:true,  default_in_snapshot:true  },
  'Client':   { is_payroll_eligible:false, can_login:true,  is_internal:false, is_management:false, cutoff_type:null,           cutoff_cap_hrs:null, daily_cap_hrs:null, can_request_ot:false, can_request_offset:false, default_in_snapshot:false },
};

// In-process cache + refresh timestamp
let _configCache = { ...CONFIG_DEFAULTS };
let _roleCache   = { ...ROLE_DEFAULTS };
let _configLoadedAt = 0;
const CONFIG_TTL_MS = 60_000; // refresh every 60s

async function refreshConfigCache(force = false) {
  const now = Date.now();
  if (!force && (now - _configLoadedAt) < CONFIG_TTL_MS) return;
  try {
    const sysRows = await pgQuery('SELECT key, value FROM system_config').catch(() => null);
    if (sysRows && sysRows.length) {
      const next = { ...CONFIG_DEFAULTS };
      for (const r of sysRows) {
        // Coerce numeric fields
        const numericKeys = ['grace_mins','break_mins','lunch_mins','bbl_mins','bio_warn_mins',
          'max_shift_hrs','ot_block_mins','daily_reset_hr','finalize_hr','cutoff_reset_hr',
          'cutoff_report_hr','va_cutoff_days'];
        next[r.key] = numericKeys.includes(r.key) ? Number(r.value) : r.value;
      }
      _configCache = next;
    }
    const roleRows = await pgQuery('SELECT * FROM role_config').catch(() => null);
    if (roleRows && roleRows.length) {
      const next = {};
      for (const r of roleRows) {
        next[r.role] = {
          is_payroll_eligible: r.is_payroll_eligible,
          can_login:           r.can_login,
          is_internal:         r.is_internal,
          is_management:       r.is_management,
          cutoff_type:         r.cutoff_type,
          cutoff_cap_hrs:      r.cutoff_cap_hrs !== null ? parseFloat(r.cutoff_cap_hrs) : null,
          daily_cap_hrs:       r.daily_cap_hrs  !== null ? parseFloat(r.daily_cap_hrs)  : null,
          can_request_ot:      r.can_request_ot,
          can_request_offset:  r.can_request_offset,
          default_in_snapshot: r.default_in_snapshot,
        };
      }
      _roleCache = next;
    }
    _configLoadedAt = now;
  } catch(e) {
    console.error('[CONFIG] refreshConfigCache failed, using defaults:', e.message);
  }
}

// Synchronous getters — read from in-process cache (refreshed by refreshConfigCache)
function cfg(key) { return _configCache[key] ?? CONFIG_DEFAULTS[key]; }
function roleCfg(role) { return _roleCache[role] || ROLE_DEFAULTS[role] || ROLE_DEFAULTS['VA I']; }

// Numeric config shortcuts (preserves the old constant names for minimal code churn)
const GRACE_MINS       = () => cfg('grace_mins');
const BREAK_MINS       = () => cfg('break_mins');
const LUNCH_MINS       = () => cfg('lunch_mins');
const BBL_MINS         = () => cfg('bbl_mins');
const BIO_WARN_MINS    = () => cfg('bio_warn_mins');
const MAX_SHIFT_HRS    = () => cfg('max_shift_hrs');
const OT_BLOCK_MINS    = () => cfg('ot_block_mins');
const DAILY_RESET_HR   = () => cfg('daily_reset_hr');
const FINALIZE_HR      = () => cfg('finalize_hr');
const CUTOFF_RESET_HR  = () => cfg('cutoff_reset_hr');
const CUTOFF_REPORT_HR = () => cfg('cutoff_report_hr');
const VA_CUTOFF_ANCHOR = () => new Date(cfg('va_cutoff_anchor')).getTime();
const VA_CUTOFF_DAYS   = () => cfg('va_cutoff_days');

// Role helpers — now backed by role_config
function isInternal(role)   { return !!roleCfg(role).is_internal; }
function isManagement(role) { return !!roleCfg(role).is_management; }
function hasCutoff(role)    { return !!roleCfg(role).cutoff_type; }
function canLogin(role)     { return !!roleCfg(role).can_login; }
function getCutoffCap(role) { return roleCfg(role).cutoff_cap_hrs; } // null = no cap
function getDailyCap(role)  { return roleCfg(role).daily_cap_hrs; }  // null = no daily cap

// Management IDs cache — populated from roster on startup, kept in sync on changes
let MANAGEMENT_IDS = [];

// §3 REDIS — ephemeral cache, live state, dedup, scheduler locks
// ============================================================
let redisClient = null;
const MEM = {};

async function getRedis() {
  if (redisClient && redisClient.isReady) return redisClient;
  if (redisClient && !redisClient.isReady) {
    try { await redisClient.disconnect(); } catch(e) {}
    redisClient = null;
  }
  if (!REDIS_URL) return null;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({
      url: REDIS_URL,
      socket: { reconnectStrategy: (a) => Math.min(a * 100, 3000) },
    });
    redisClient.on('error', e => console.error('Redis error:', e.message));
    redisClient.on('ready', () => console.log('Redis ready'));
    await redisClient.connect();
    console.log('Redis connected');
    return redisClient;
  } catch(e) {
    console.error('Redis connect failed:', e.message);
    redisClient = null;
    return null;
  }
}

async function rGet(key) {
  try { const r = await getRedis(); if (r) return await r.get(key); } catch(e) {}
  return MEM[key] || null;
}
async function rSet(key, value, opts) {
  try {
    const r = await getRedis();
    if (r) { if (opts?.EX) await r.set(key, value, { EX: opts.EX }); else await r.set(key, value); return; }
  } catch(e) {}
  MEM[key] = value;
}
async function rDel(key) {
  try { const r = await getRedis(); if (r) { await r.del(key); return; } } catch(e) {}
  delete MEM[key];
}
async function rKeys(pattern) {
  try { const r = await getRedis(); if (r) return await r.keys(pattern); } catch(e) {}
  const re = new RegExp(pattern.replace(/\*/g, '.*'));
  return Object.keys(MEM).filter(k => re.test(k));
}
async function rSetNX(key, value, ttl) {
  try {
    const r = await getRedis();
    if (r) return await r.set(key, value, { NX: true, EX: ttl });
  } catch(e) {}
  if (MEM[key]) return null;
  MEM[key] = value;
  return 'OK';
}

// §4 POSTGRES (Supabase) — primary persistent store
// Redis stays for: live state, dedup, scheduler locks only
// ============================================================
const { Pool } = require('pg');

// Strip ?sslmode from connection string — we control SSL via the ssl config object
const PG_URL = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');

const pgPool = new Pool({
  connectionString: PG_URL,
  ssl: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pgPool.connect()
  .then(client => { console.log('✅ Supabase PostgreSQL connected'); client.release(); })
  .catch(err => console.error('❌ Supabase connection failed:', err.message));

async function pgQuery(sql, params = []) {
  const client = await pgPool.connect();
  try { const result = await client.query(sql, params); return result.rows; }
  finally { client.release(); }
}
async function pgOne(sql, params = []) {
  const rows = await pgQuery(sql, params);
  return rows[0] || null;
}

// §5 ROSTER — Postgres primary, Redis fallback, hardcoded emergency fallback
// ============================================================
const DEFAULT_ROSTER = [
  { id:'2009869833', name:'Queency', role:'VA I', schedules:[{ days:[1,1,1,1,1,0,0], start:'8:00 PM', end:'5:00 AM' }] },
  { id:'7831137596', name:'Maku',    role:'VA I', schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM', end:'5:00 AM' }] },
  { id:'1802251672', name:'Lovely',  role:'VA I', schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM', end:'5:00 AM' }] },
  { id:'8393347347', name:'Mary',    role:'VA I', schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM', end:'5:00 AM' }] },
  { id:'5359971666', name:'Pam',     role:'VA I', schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM', end:'5:00 AM' }] },
  { id:'6012486581', name:'Cris',    role:'VA I', schedules:[
    { days:[1,1,1,1,0,0,0], start:'9:00 PM', end:'5:00 AM' },
    { days:[0,0,0,0,1,0,0], start:'11:00 PM', end:'7:00 AM' },
  ]},
  { id:'5660256653', name:'Jude',    role:'VA I', schedules:[{ days:[1,1,1,1,1,0,0], start:'9:00 PM', end:'6:00 AM' }] },
  { id:'7207758648', name:'Noreen',  role:'VA I', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'8:00 AM' }] },
  { id:'8070441816', name:'John',    role:'VA I', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'6705167382', name:'Cha',     role:'VA I', schedules:[
    { days:[0,1,1,1,1,0,0], start:'12:00 AM', end:'9:00 AM' },
    { days:[1,0,0,0,0,0,0], start:'2:00 AM', end:'9:00 AM' },
  ]},
  { id:'7148499363', name:'Alexis',  role:'VA I', schedules:[{ days:[0,0,1,1,1,1,1], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'7514392042', name:'Kate',    role:'VA I', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'6088627916', name:'Nina',    role:'UYP', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'5685031197', name:'Kat',     role:'UYP', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'6132223983', name:'Yuqi',    role:'UYP', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'8044736892', name:'Bert',    role:'Internal', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'7240390530', name:'Moon',    role:'Internal', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'7830367843', name:'Nell',    role:'Internal', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'2018117745', name:'Gab',     role:'Internal', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'6971608069', name:'Kent',    role:'Admin', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
  { id:'8693973681', name:'Fourth',  role:'VA I', schedules:[{ days:[0,1,1,1,1,1,0], start:'12:00 AM', end:'9:00 AM' }] },
];

let rosterCache = null;

async function getRoster() {
  if (rosterCache) return rosterCache;
  try {
    const rows = await pgQuery(`
      SELECT u.id, u.name, u.role,
        COALESCE(json_agg(
          json_build_object('days',s.days_mask,'start',s.start_time,'end',s.end_time,'clientSet',s.client_set)
          ORDER BY s.id
        ) FILTER (WHERE s.id IS NOT NULL), '[]') as schedules
      FROM users u
      LEFT JOIN schedules s ON s.user_id = u.id
      GROUP BY u.id, u.name, u.role ORDER BY u.name
    `);
    if (rows.length > 0) { rosterCache = rows; return rows; }
  } catch(e) { console.error('[PG] getRoster:', e.message); }

  // One-time seed: only if (a) Postgres returned zero users AND (b) we haven't seeded before.
  // After first run, system_config.roster_seeded='true' prevents this from ever running again.
  // Admin can re-enable seeding by deleting that key (or by truncating users table).
  try {
    const seedFlag = await pgOne("SELECT value FROM system_config WHERE key='roster_seeded'");
    if (!seedFlag || seedFlag.value !== 'true') {
      console.log('[ROSTER] First-time seed: importing DEFAULT_ROSTER into Postgres');
      await saveRoster(DEFAULT_ROSTER);
      await pgQuery(
        `INSERT INTO system_config (key, value, description) VALUES ('roster_seeded', 'true', 'Prevents re-seeding of DEFAULT_ROSTER after first import')
         ON CONFLICT (key) DO UPDATE SET value='true', updated_at=now()`
      );
      return DEFAULT_ROSTER;
    }
  } catch(e) { console.error('[ROSTER] seed flag check:', e.message); }

  // No users in PG and seed already ran: system is intentionally empty.
  // Admin must add users via the admin panel.
  console.log('[ROSTER] Postgres empty and seed flag set — returning empty roster. Admin must add users.');
  rosterCache = [];
  return [];
}
async function saveRoster(roster) {
  // H5 fix: write Postgres first, then update caches
  // CRITICAL FIX #2: also DELETE users not in the new roster (was missing)
  try {
    // Get current PG users to determine which need deletion
    const existingRows = await pgQuery('SELECT id FROM users').catch(() => []);
    const existingIds = new Set(existingRows.map(r => r.id));
    const newIds = new Set(roster.map(u => String(u.id)));

    // Delete users that exist in PG but not in new roster
    for (const id of existingIds) {
      if (!newIds.has(id)) {
        await pgQuery('DELETE FROM users WHERE id=$1', [id]).catch(e =>
          console.error('[PG] saveRoster delete:', id, e.message)
        );
        console.log(`[PG] saveRoster: removed user ${id}`);
      }
    }

    // Insert/update remaining users + their schedules
    for (const user of roster) {
      await pgQuery(
        `INSERT INTO users (id,name,role) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET name=$2,role=$3,updated_at=now()`,
        [String(user.id), user.name, user.role||'VA I']
      );
      await pgQuery('DELETE FROM schedules WHERE user_id=$1', [String(user.id)]);
      for (const s of (user.schedules||[])) {
        await pgQuery(
          `INSERT INTO schedules (user_id,days_mask,start_time,end_time,client_set) VALUES ($1,$2::jsonb,$3,$4,$5)`,
          [String(user.id), JSON.stringify(s.days), s.start, s.end, s.clientSet||false]
        );
      }
    }
    rosterCache = roster;
    await rSet('roster', JSON.stringify(roster)).catch(()=>{});
  } catch(e) {
    // CRITICAL: PG write failed. Do NOT silently cache the new roster as if it succeeded.
    // The previous behavior (caching anyway) caused phantom users that disappeared on next reload.
    console.error('[PG] saveRoster FAILED — data NOT persisted:', e.message);
    console.error('[PG] saveRoster stack:', e.stack);
    // Invalidate cache so next read pulls actual PG state (which is correct truth)
    rosterCache = null;
    throw new Error('Roster save failed: ' + e.message);
  }
}
async function getUserById(uid) { return (await getRoster()).find(u => u.id === String(uid)) || null; }
async function getUserByName(name) {
  const lower = name.toLowerCase();
  return (await getRoster()).find(u => u.name.toLowerCase() === lower) || null;
}

// §6 CLIENTS — Postgres primary, Redis fallback
// ============================================================
async function getClients() {
  try {
    const rows = await pgQuery(`
      SELECT c.*,
        COALESCE(
          json_agg(
            json_build_object('id', cva.va_id, 'rate', cva.rate)
          ) FILTER (WHERE cva.va_id IS NOT NULL),
          '[]'
        ) as "assignedVAs"
      FROM clients c
      LEFT JOIN client_va_assignments cva ON cva.client_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    if (rows.length > 0) {
      // Normalize column names from snake_case PG → camelCase JS
      return rows.map(r => ({
        ...r,
        telegramId:       r.telegram_id,
        firstName:        r.first_name,
        lastName:         r.last_name,
        businessName:     r.business_name,
        billingFrequency: r.billing_frequency,
        affiliateRate:    parseFloat(r.affiliate_rate) || 0,
        ghlSubscription:  r.ghl_subscription,
        ghlRate:          parseFloat(r.ghl_rate) || 0,
        ghlStartDate:     r.ghl_start_date,
        ghlBillingFreq:       r.ghl_billing_freq,
        ghlBillingFrequency:   r.ghl_billing_freq, // alias for HTML compat
        startDate:        r.start_date,
        logo:             r.logo_url,
        photo:            r.photo_url,
        features:         typeof r.features === 'string' ? JSON.parse(r.features) : (r.features || {}),
        assignedVAs:      Array.isArray(r.assignedVAs) ? r.assignedVAs : [],
      }));
    }
  } catch(e) { console.error('[PG] getClients:', e.message); }
  try { const raw = await rGet('clients'); return raw ? JSON.parse(raw) : []; } catch(e) { return []; }
}
async function saveClients(clients) {
  // Write Postgres first (H5 pattern), then update Redis cache
  // CRITICAL FIX #3: DELETE clients not in the new list (was missing)
  try {
    // Get current PG clients to determine which need deletion
    const existingRows = await pgQuery('SELECT id FROM clients').catch(() => []);
    const existingIds = new Set(existingRows.map(r => r.id));
    const newIds = new Set(clients.map(c => c.id));

    // Delete clients that exist in PG but not in new list
    for (const id of existingIds) {
      if (!newIds.has(id)) {
        await pgQuery('DELETE FROM client_va_assignments WHERE client_id=$1', [id]).catch(()=>{});
        await pgQuery('DELETE FROM clients WHERE id=$1', [id]).catch(e =>
          console.error('[PG] saveClients delete:', id, e.message)
        );
        console.log(`[PG] saveClients: removed client ${id}`);
      }
    }

    for (const c of clients) {
      await pgQuery(
        `INSERT INTO clients (
           id, telegram_id, first_name, last_name, name, business_name, company,
           position, timezone, logo_url, photo_url, features, role,
           start_date, billing_frequency, affiliate, affiliate_rate,
           ghl_subscription, ghl_rate, ghl_start_date, ghl_billing_freq
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           $14,$15,$16,$17,$18,$19,$20,$21
         )
         ON CONFLICT (id) DO UPDATE SET
           telegram_id=$2, first_name=$3, last_name=$4, name=$5,
           business_name=$6, company=$7, position=$8, timezone=$9,
           logo_url=$10, photo_url=$11, features=$12, role=$13,
           start_date=$14, billing_frequency=$15, affiliate=$16,
           affiliate_rate=$17, ghl_subscription=$18, ghl_rate=$19,
           ghl_start_date=$20, ghl_billing_freq=$21, updated_at=now()`,
        [
          c.id,
          c.telegramId || null,
          c.firstName || null,
          c.lastName  || null,
          c.name      || null,
          c.businessName || null,
          c.company   || c.businessName || null,
          c.position  || null,
          c.timezone  || 'Asia/Manila',
          c.logo      || c.logo_url  || null,
          c.photo     || c.photo_url || null,
          JSON.stringify(c.features || {}),
          c.role      || 'Client',
          c.startDate || c.start_date || null,
          c.billingFrequency || c.billing_frequency || 'monthly',
          c.affiliate || null,
          parseFloat(c.affiliateRate || c.affiliate_rate) || 0,
          c.ghlSubscription ?? c.ghl_subscription ?? false,
          parseFloat(c.ghlRate || c.ghl_rate) || 0,
          c.ghlStartDate || c.ghl_start_date || null,
          c.ghlBillingFrequency || c.ghlBillingFreq || c.ghl_billing_freq || 'monthly',
        ]
      );

      // VA assignments with rates
      await pgQuery('DELETE FROM client_va_assignments WHERE client_id=$1', [c.id]);
      for (const va of (c.assignedVAs || [])) {
        const vid  = typeof va === 'object' ? (va.id || va) : va;
        const rate = typeof va === 'object' ? (parseFloat(va.rate) || 0) : 0;
        if (!vid) continue;
        await pgQuery(
          `INSERT INTO client_va_assignments (client_id, va_id, rate)
           VALUES ($1, $2, $3)
           ON CONFLICT (client_id, va_id) DO UPDATE SET rate=$3`,
          [c.id, String(vid), rate]
        ).catch(()=>{});
      }
    }
    // Update Redis cache only after PG succeeds
    await rSet('clients', JSON.stringify(clients)).catch(()=>{});
  } catch(e) {
    // Same critical fix as saveRoster — don't silently pretend success
    console.error('[PG] saveClients FAILED — data NOT persisted:', e.message);
    console.error('[PG] saveClients stack:', e.stack);
    throw new Error('Client save failed: ' + e.message);
  }
}

// §7 UTILITIES — time/date formatting, schedule resolution
// ============================================================
function manilaTime() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })); }
function manilaDateStr(d) { return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); }
function fmtTime(d) { return d.toLocaleString('en-US', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit', hour12:true }); }
function fmtDate(d) { return d.toLocaleString('en-US', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' }); }
function minsBetween(a, b) { return Math.round((b - a) / 60000); }

function to24h(ts) {
  const [time, period] = ts.trim().split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function getShiftWindow(sched, dateStr) {
  const start = new Date(`${dateStr}T${to24h(sched.start)}:00+08:00`);
  let end = new Date(`${dateStr}T${to24h(sched.end)}:00+08:00`);
  if (end <= start) end = new Date(end.getTime() + 86400000);
  return { start, end };
}

// The 6PM window date — the foundation of everything
function getWindowDate(manila) {
  const h = (manila || manilaTime()).getHours();
  const d = manila || manilaTime();
  if (h >= 18) return manilaDateStr(d);
  return manilaDateStr(new Date(d.getTime() - 86400000));
}

// Find schedule that falls within a 6PM window
function getScheduleForWindow(user, windowDate) {
  const d = new Date(windowDate + 'T12:00:00+08:00');
  const nextD = new Date(d.getTime() + 86400000);
  const wStart = new Date(windowDate + 'T18:00:00+08:00');
  const wEnd = new Date(wStart.getTime() + 86400000);

  const dow = (dt) => { const w = dt.getDay(); return w === 0 ? 6 : w - 1; };

  // Check window date's day of week
  for (const sched of (user.schedules || [])) {
    if (sched.days[dow(d)]) {
      const win = getShiftWindow(sched, windowDate);
      if (win.start >= wStart && win.start < wEnd) return { sched, dateStr: windowDate, win };
    }
  }
  // Check next day (e.g., 12AM shift on the next calendar date)
  const nextDateStr = manilaDateStr(nextD);
  for (const sched of (user.schedules || [])) {
    if (sched.days[dow(nextD)]) {
      const win = getShiftWindow(sched, nextDateStr);
      if (win.start >= wStart && win.start < wEnd) return { sched, dateStr: nextDateStr, win };
    }
  }
  return null;
}

function schedMins(sched, dateStr) {
  const win = getShiftWindow(sched, dateStr);
  return minsBetween(win.start, win.end);
}

function hasLunchEntitlement(sched, dateStr) {
  return schedMins(sched, dateStr) > 480; // >8h = has lunch
}

function graceDeduction(actual, allowed) {
  const over = actual - allowed;
  if (over <= GRACE_MINS()) return 0;
  return over - GRACE_MINS();
}

// §8 CUTOFF DATES — period boundaries and expected-hours calc
// ============================================================
function getCutoffDates(role) {
  // C6: Owner and Director have no cutoff — return null
  if (!hasCutoff(role)) return null;

  const now = new Date();
  if (role === 'UYP') {
    const s = manilaDateStr(now).split('-');
    const y = +s[0], m = +s[1], d = +s[2], pad = n => String(n).padStart(2,'0');
    if (d <= 15) return { start: new Date(`${y}-${pad(m)}-01T09:00:00+08:00`), end: new Date(`${y}-${pad(m)}-15T09:00:00+08:00`) };
    const last = new Date(y, m, 0).getDate();
    return { start: new Date(`${y}-${pad(m)}-16T09:00:00+08:00`), end: new Date(`${y}-${pad(m)}-${pad(last)}T09:00:00+08:00`) };
  }
  const interval = VA_CUTOFF_DAYS() * 86400000;
  const n = Math.floor((now - VA_CUTOFF_ANCHOR()) / interval);
  const start = new Date(VA_CUTOFF_ANCHOR() + n * interval);
  return { start, end: new Date(start.getTime() + interval) };
}

function isLastCutoffDay(role) {
  const dates = getCutoffDates(role);
  if (!dates) return false; // C6: no-payroll roles never trigger cutoff jobs
  return manilaDateStr() === manilaDateStr(dates.end);
}

// Expected hours for a user within their current cutoff (for offset missing hours calc)
async function getExpectedHours(user) {
  const dates = getCutoffDates(user.role);
  if (!dates) return 0; // no-payroll role

  // H7 fix: use end-of-current-6PM-window as boundary, not noon
  // This ensures a shift that started before 6PM today is included in expected hours
  const windowDate = getWindowDate();
  const windowEnd = new Date(windowDate + 'T18:00:00+08:00'); // 6PM boundary = end of current window

  let expected = 0;
  let cursor = new Date(dates.start);
  while (cursor <= windowEnd) {
    const wdStr = manilaDateStr(cursor);
    if (getScheduleForWindow(user, wdStr)) expected += MAX_SHIFT_HRS();
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return expected;
}

// §9 STATE — live session in Redis (ephemeral, survives restarts via Redis)
// ============================================================
async function getState(uid) {
  try { const raw = await rGet(`state:${uid}`); return raw ? JSON.parse(raw) : { status: 'out' }; } catch(e) { return { status: 'out' }; }
}
async function setState(uid, st) { await rSet(`state:${uid}`, JSON.stringify(st)); }
async function clearState(uid) { await rDel(`state:${uid}`); }

// §10 CUTOFF HOURS — running accumulator (Postgres primary, Redis fallback)
// ============================================================
async function getCutoff(uid) {
  // CRITICAL FIX: Always return zeros if no row exists for current period.
  // Never fall back to period-unaware Redis cache (caused old hours to persist
  // into new cutoff periods).
  try {
    const user = await getUserById(uid);
    const dates = getCutoffDates(user?.role||'VA I');
    if (!dates) return { hours: 0, ot: 0 }; // no-payroll role
    const { start } = dates;
    const startStr = start.toISOString().split('T')[0];
    const row = await pgOne(
      `SELECT hours_logged as hours, ot_hours as ot FROM cutoff_periods WHERE user_id=$1 AND period_start=$2`,
      [String(uid), startStr]
    );
    if (row) return { hours: parseFloat(row.hours)||0, ot: parseFloat(row.ot)||0 };
    // No row for current period = fresh period, return zeros (DO NOT fall back to Redis)
    return { hours: 0, ot: 0 };
  } catch(e) {
    console.error('[PG] getCutoff:', e.message);
    // Only fall back to Redis on actual PG error, AND only use period-scoped key
    try {
      const user = await getUserById(uid);
      const dates = getCutoffDates(user?.role||'VA I');
      if (!dates) return { hours: 0, ot: 0 };
      const startStr = dates.start.toISOString().split('T')[0];
      const raw = await rGet(`cutoff:${uid}:${startStr}`);
      return raw ? JSON.parse(raw) : { hours:0, ot:0 };
    } catch(e2) { return { hours:0, ot:0 }; }
  }
}
async function setCutoff(uid, data) {
  const userForRole = await getUserById(uid);
  const datesCheck = getCutoffDates(userForRole?.role||'VA I');
  if (!datesCheck) return; // C6/C7: no-payroll role
  try {
    const user = userForRole;
    const { start, end } = datesCheck;
    const startStr = start.toISOString().split('T')[0];
    const endStr   = end.toISOString().split('T')[0];
    // Postgres first (source of truth)
    await pgQuery(
      `INSERT INTO cutoff_periods (user_id,period_start,period_end,role_at_time,hours_logged,ot_hours)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id,period_start) DO UPDATE SET hours_logged=$5,ot_hours=$6,updated_at=now()`,
      [String(uid), startStr, endStr, user?.role||'VA I', data.hours||0, data.ot||0]
    );
    // Redis cache PERIOD-SCOPED — prevents stale data leaking across periods
    await rSet(`cutoff:${uid}:${startStr}`, JSON.stringify(data)).catch(()=>{});
  } catch(e) { console.error('[PG] setCutoff:', e.message); }
}
async function addCutoffHours(uid, role, addH, addOT) {
  // C6/C7: Owner and Director have no payroll — do nothing
  if (!hasCutoff(role)) return { hours: 0, ot: 0 };

  const co = await getCutoff(uid);

  // Cap logic — pulled from role_config.cutoff_cap_hrs (null = no cap)
  const cap = getCutoffCap(role);
  const newHours = Math.round((co.hours + addH) * 100) / 100;
  co.hours = (cap === null || cap === undefined) ? newHours : Math.min(newHours, cap);
  co.ot = Math.round((co.ot + (addOT || 0)) * 100) / 100;

  await setCutoff(uid, co);
  const user = await getUserById(uid);
  const name = user ? user.name : uid;
  sheetAppend('Cutoff Log', [[fmtDate(new Date()), fmtTime(new Date()), name, uid, role, addH.toFixed(2), (addOT||0).toFixed(2), co.hours.toFixed(2), co.ot.toFixed(2)]]).catch(console.error);
  return co;
}

// §11 SHIFT WINDOWS — per-window persistent record (Postgres primary, Redis fallback)
// Tracks: sessions (leader multi-login), break/lunch usage, daily totals
// ============================================================
async function getWindow(uid, windowDate) {
  try {
    const row = await pgOne(
      `SELECT * FROM shift_sessions WHERE user_id=$1 AND window_date=$2`,
      [String(uid), windowDate]
    );
    if (row) return {
      uid: row.user_id, name: row.name||'', role: row.role||'',
      windowDate: row.window_date instanceof Date ? row.window_date.toISOString().split('T')[0] : String(row.window_date),
      totalHours: parseFloat(row.total_hours)||0,
      totalOT: parseFloat(row.total_ot)||0,
      breakUsed: row.break_used, lunchUsed: row.lunch_used, bblUsed: row.bbl_used,
      bioCount: row.bio_count||0, lateMs: row.late_ms||0,
      overbreakMs: row.overbreak_ms||0, overlunchMs: row.overlunch_ms||0,
      status: row.status||'pending',
      sessions: row.sessions||[], events: row.events||[],
      adminOverride: row.admin_override?.status||null,
      adminOverrides: row.admin_override?.fields||null,
      // Both names map to login_time — firstLoginTime is the runtime name,
      // loginTime is for backward-compat. Source of truth = the column.
      firstLoginTime: row.login_time ? new Date(row.login_time).toISOString() : null,
      loginTime: row.login_time ? new Date(row.login_time).toISOString() : null,
      logoutTime: row.logout_time ? new Date(row.logout_time).toISOString() : null,
    };
  } catch(e) { console.error('[PG] getWindow:', e.message); }
  try {
    const raw = await rGet(`shiftwindow:${uid}:${windowDate}`);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

async function setWindow(uid, windowDate, data) {
  await rSet(`shiftwindow:${uid}:${windowDate}`, JSON.stringify({...data, updatedAt: new Date().toISOString()}), { EX: 14*86400 }).catch(()=>{});
  try {
    const user = await getUserById(uid);
    await pgQuery(
      `INSERT INTO shift_sessions (
        user_id,window_date,login_time,logout_time,
        total_hours,total_ot,break_used,lunch_used,bbl_used,bio_count,
        late_ms,overbreak_ms,overlunch_ms,status,sessions,events,admin_override,name,role
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (user_id,window_date) DO UPDATE SET
        login_time=$3,logout_time=$4,
        total_hours=$5,total_ot=$6,
        break_used=$7,lunch_used=$8,bbl_used=$9,bio_count=$10,
        late_ms=$11,overbreak_ms=$12,overlunch_ms=$13,status=$14,
        sessions=$15,events=$16,admin_override=$17,updated_at=now()`,
      [
        String(uid), windowDate,
        // Source of truth: firstLoginTime (set on first /in), fallback to loginTime, then null.
        // This is the single column for "when did this shift start" across PG and runtime.
        (data.firstLoginTime || data.loginTime) ? new Date(data.firstLoginTime || data.loginTime) : null,
        data.logoutTime ? new Date(data.logoutTime) : null,
        data.totalHours||0, data.totalOT||0,
        data.breakUsed||false, data.lunchUsed||false, data.bblUsed||false, data.bioCount||0,
        data.lateMs||0, data.overbreakMs||0, data.overlunchMs||0,
        data.status||'pending',
        JSON.stringify(data.sessions||[]),
        JSON.stringify(data.events||[]),
        data.adminOverride ? JSON.stringify({status:data.adminOverride, fields:data.adminOverrides||null}) : null,
        user?.name||data.name||'', user?.role||data.role||'VA',
      ]
    );
  } catch(e) { console.error('[PG] setWindow:', e.message); }
}

function newWindowRecord(uid, name, role, windowDate) {
  return {
    uid, name, role, windowDate,
    sessions: [],         // [{ in, out, hours }]
    totalHours: 0,        // accumulated payable for the day
    totalOT: 0,           // accumulated OT for the day
    breakUsed: false,
    lunchUsed: false,
    bblUsed: false,
    bioCount: 0,
    lateMs: 0,
    overbreakMs: 0,
    overlunchMs: 0,
    lunchSkipOffset: 0,   // hours credited from skipping lunch
    status: 'pending',    // pending | completed | finalized
    events: [],           // [{ action, time, detail }]
  };
}

async function appendWindowEvent(uid, windowDate, action, detail) {
  const wr = await getWindow(uid, windowDate);
  if (!wr) return;
  wr.events.push({ action, time: new Date().toISOString(), detail: detail || '' });
  await setWindow(uid, windowDate, wr);
}

// §12 APPROVALS — request queue (Postgres primary, Redis fallback)
// ============================================================
async function createApproval(uid, name, type, notes) {
  const id = `${uid}-${Date.now()}`;
  const req = { id, uid, name, type, notes: notes||'', status: 'pending', createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null };
  await rSet(`approval:${id}`, JSON.stringify(req), { EX: 7*86400 }).catch(()=>{});
  const idx = JSON.parse(await rGet('approval:index')||'[]');
  idx.push(id); await rSet('approval:index', JSON.stringify(idx)).catch(()=>{});
  try {
    await pgQuery(
      `INSERT INTO approvals (id,user_id,user_name,type,notes,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [id, String(uid), name, type, notes||'', new Date(Date.now()+7*86400000)]
    );
  } catch(e) { console.error('[PG] createApproval:', e.message); }
  return req;
}

async function getApprovals(filter) {
  try {
    const rows = await pgQuery(
      `SELECT * FROM approvals WHERE (expires_at IS NULL OR expires_at > now()) ORDER BY created_at desc`
    );
    const results = rows.map(r => ({
      id: r.id, uid: r.user_id, name: r.user_name,
      type: r.type, notes: r.notes, status: r.status,
      resolvedBy: r.resolved_by, resolvedAt: r.resolved_at,
      createdAt: r.created_at,
    }));
    return filter ? results.filter(filter) : results;
  } catch(e) { console.error('[PG] getApprovals:', e.message); }
  // Redis fallback
  const idx = JSON.parse(await rGet('approval:index')||'[]');
  const results = []; const validIds = [];
  for (const id of idx) {
    try {
      const raw = await rGet(`approval:${id}`);
      if (raw) { validIds.push(id); const a = JSON.parse(raw); if (!filter||filter(a)) results.push(a); }
    } catch(e) {}
  }
  if (validIds.length < idx.length) await rSet('approval:index', JSON.stringify(validIds)).catch(()=>{});
  return results.sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
}

async function resolveApproval(id, status, resolvedByUid) {
  const raw = await rGet(`approval:${id}`);
  const a = raw ? JSON.parse(raw) : null;
  const resolvedAt = new Date().toISOString();
  if (a) {
    a.status = status; a.resolvedAt = resolvedAt; a.resolvedBy = resolvedByUid;
    await rSet(`approval:${id}`, JSON.stringify(a), { EX: 7*86400 }).catch(()=>{});
  }
  try {
    const row = await pgOne(`UPDATE approvals SET status=$1,resolved_by=$2,resolved_at=$3 WHERE id=$4 RETURNING *`,
      [status, String(resolvedByUid), new Date(resolvedAt), id]);
    if (row && !a) return { id: row.id, uid: row.user_id, name: row.user_name, type: row.type, notes: row.notes, status: row.status, resolvedBy: row.resolved_by, resolvedAt: row.resolved_at, createdAt: row.created_at };
  } catch(e) { console.error('[PG] resolveApproval:', e.message); }
  return a;
}

// §13 EDIT LOG — audit trail (Postgres primary, Sheets backup)
// ============================================================
async function logEdit(actor, actorRole, action, target, before, after) {
  const entry = { ts: new Date().toISOString(), actor, actorRole, action, target, before: before||null, after: after||null };
  // Sheets (existing backup)
  sheetAppend('Edit Log', [[entry.ts, actor, actorRole, action, target, JSON.stringify(before), JSON.stringify(after)]]).catch(console.error);
  // Postgres (primary)
  try {
    await pgQuery(
      `INSERT INTO edit_log (actor,actor_role,action,target,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor, actorRole, action, String(target||''),
       before ? JSON.stringify(before) : null,
       after  ? JSON.stringify(after)  : null]
    );
  } catch(e) { console.error('[PG] logEdit:', e.message); }
  return entry;
}

// §14 FINANCIALS — staff_rates table (Postgres primary, Redis cache fallback)
// ============================================================
async function getFinancials() {
  try {
    const rows = await pgQuery('SELECT user_id, rate, ot_rate, currency FROM staff_rates');
    const rates = {};
    let currency = 'USD';
    for (const r of rows) {
      rates[r.user_id] = { rate: parseFloat(r.rate) || 0, otRate: parseFloat(r.ot_rate) || 0 };
      currency = r.currency || 'USD';
    }
    // Also get config currency from system_config
    const cfg = await pgQuery("SELECT value FROM system_config WHERE key='currency'").catch(()=>[]);
    if (cfg[0]) currency = cfg[0].value;
    const fin = { rates, currency, clientBilling: {} };
    await rSet('financials:config', JSON.stringify(fin)).catch(()=>{}); // keep Redis in sync
    return fin;
  } catch(e) {
    console.error('[PG] getFinancials:', e.message);
    try { const raw = await rGet('financials:config'); return raw ? JSON.parse(raw) : { rates: {}, currency: 'USD', clientBilling: {} }; } catch(e2) { return { rates: {}, currency: 'USD', clientBilling: {} }; }
  }
}
async function saveFinancials(data) {
  // Write to staff_rates table per user
  try {
    const currency = data.currency || 'USD';
    for (const [uid, r] of Object.entries(data.rates || {})) {
      await pgQuery(
        `INSERT INTO staff_rates (user_id, rate, ot_rate, currency)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET rate=$2, ot_rate=$3, currency=$4, updated_at=now()`,
        [uid, parseFloat(r.rate) || 0, parseFloat(r.otRate || r.ot_rate) || 0, currency]
      );
    }
    await pgQuery(
      `INSERT INTO system_config (key, value) VALUES ('currency', $1)
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`,
      [currency]
    );
    await rSet('financials:config', JSON.stringify(data)).catch(()=>{}); // keep Redis in sync
  } catch(e) {
    console.error('[PG] saveFinancials:', e.message);
    await rSet('financials:config', JSON.stringify(data)).catch(()=>{});
  }
}

// §15 SNAPSHOTS — cached dashboard data (Redis-only — TODO: migrate to Postgres)
// ============================================================
async function getSnapshot(windowDate) {
  try { const raw = await rGet(`snapshot:${windowDate}`); return raw ? JSON.parse(raw) : null; } catch(e) { return null; }
}
async function setSnapshot(windowDate, data) {
  await rSet(`snapshot:${windowDate}`, JSON.stringify(data), { EX: 3 * 86400 });
}

// §16 GOOGLE SHEETS — append-only audit log (no reads from bot)
// ============================================================
let _gToken = null, _gTokenExp = 0;

async function getGoogleToken() {
  if (_gToken && Date.now() < _gTokenExp) return _gToken;
  if (!GOOGLE_SA) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: GOOGLE_SA.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600, iat: now,
    })).toString('base64url');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(GOOGLE_SA.private_key, 'base64url');
    const res = await axios.post('https://oauth2.googleapis.com/token',
      new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${payload}.${sig}` })
    );
    _gToken = res.data.access_token;
    _gTokenExp = Date.now() + 3500000;
    return _gToken;
  } catch(e) { console.error('Google token error:', e.message); return null; }
}

async function sheetAppend(tab, values) {
  if (!SHEET_ID || !GOOGLE_SA) return;
  try {
    const token = await getGoogleToken();
    if (!token) return;
    const range = encodeURIComponent(`'${tab}'!A:Z`);
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append`,
      { values },
      { params: { valueInputOption: 'USER_ENTERED' }, headers: { Authorization: `Bearer ${token}` } }
    );
  } catch(e) {
    // If tab doesn't exist, create it and retry
    if (e.response?.status === 400 && e.response?.data?.error?.message?.includes('Unable to parse range')) {
      try { await createSheetTab(tab); await sheetAppend(tab, values); } catch(e2) {}
    } else {
      console.error('Sheet append error:', e.response?.data?.error?.message || e.message);
    }
  }
}

async function createSheetTab(title) {
  if (!SHEET_ID || !GOOGLE_SA) return;
  try {
    const token = await getGoogleToken();
    if (!token) return;
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
      { requests: [{ addSheet: { properties: { title } } }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[Sheets] Created tab: ${title}`);
  } catch(e) {
    // Tab might already exist
    if (!e.response?.data?.error?.message?.includes('already exists')) {
      console.error('Create tab error:', e.response?.data?.error?.message || e.message);
    }
  }
}

async function ensureSheetTabs() {
  if (!SHEET_ID || !GOOGLE_SA) return;
  const requiredTabs = ['Telegram Logs', 'Cutoff Log', 'Daily Snapshots', 'KPI Archive', 'Edit Log'];
  try {
    const token = await getGoogleToken();
    if (!token) return;
    const res = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const existing = (res.data.sheets || []).map(s => s.properties.title);
    for (const tab of requiredTabs) {
      if (!existing.includes(tab)) await createSheetTab(tab);
    }
    console.log(`[Sheets] Tabs verified: ${requiredTabs.join(', ')}`);
  } catch(e) { console.error('Sheet tab check error:', e.message); }
}

// §17 TELEGRAM — send helpers
// ============================================================
async function sendMsg(text, chatId, topicId) {
  try {
    const payload = { chat_id: chatId || ALLOWED_CHAT, text, parse_mode: 'HTML' };
    if (topicId || TOPIC_ID) payload.message_thread_id = parseInt(topicId || TOPIC_ID);
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, payload);
  } catch(e) { console.error('sendMsg:', e.message); }
}

async function sendDM(userId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: userId, text, parse_mode: 'HTML',
    });
  } catch(e) { console.error('sendDM to', userId, ':', e.message); }
}

async function notifyManagement(text) {
  // Always pull fresh management list from roster (survives role changes without restart)
  try {
    const roster = await getRoster();
    const leaderIds = roster.filter(u => isManagement(u.role)).map(u => u.id);
    MANAGEMENT_IDS = leaderIds; // Keep in sync
    for (const lid of leaderIds) {
      try {
        await sendDM(lid, text);
      } catch(e) {
        console.error(`[DM FAIL] Management ${lid}: ${e.message}`);
      }
    }
  } catch(e) {
    // Fallback to cached MANAGEMENT_IDS
    for (const lid of MANAGEMENT_IDS) {
      try { await sendDM(lid, text); } catch(e2) {}
    }
  }
}

async function sendGroupConfirmation(text) {
  await sendMsg(text, ALLOWED_CHAT, TOPIC_ID);
}

// §18 DEDUP — Telegram webhook deduplication (Redis, 48h TTL)
// ============================================================
async function isDuplicate(updateId) {
  const key = `dedup:${updateId}`;
  const result = await rSetNX(key, '1', 48 * 3600);
  return result === null; // null = already existed = duplicate
}

// §19 PAYROLL CALC — calcPayable()
// ============================================================
function calcPayable(user, state, logoutTime, windowRecord) {
  try {
    const role = user.role;
    const login = new Date(state.loginTime);
    const logout = logoutTime;
    const wd = state.windowDate || getWindowDate();
    const schedInfo = getScheduleForWindow(user, wd);

    // Leader with no schedule (rest day login) — all hours = raw
    if (isInternal(role) && !schedInfo) {
      const rawMs = Math.max(0, logout - login);
      const lunchMs = state.lunchDuration ? Math.min(state.lunchDuration, LUNCH_MINS()) * 60000 : 0;
      const overMs = (state.overbreakMs || 0) + (state.overlunchMs || 0);
      const netH = Math.max(0, (rawMs - lunchMs - overMs) / 3600000);
      return { hours: Math.round(netH * 100) / 100, ot: 0, isOffset: false };
    }

    if (!schedInfo) return { hours: 0, ot: 0, isOffset: false };

    const { sched, dateStr, win } = schedInfo;
    const totalSchedMins = minsBetween(win.start, win.end);
    const hasLunch = totalSchedMins > 480;

    if (isInternal(role)) {
      // Leader on scheduled day: raw time minus deductions
      const rawMs = Math.max(0, logout - login);
      const lateMins = Math.max(0, minsBetween(win.start, login));
      const lateDeduct = state.isFirstLogin ? graceDeduction(lateMins, 0) : 0;
      const lunchMs = state.lunchDuration ? Math.min(state.lunchDuration, LUNCH_MINS()) * 60000 : 0;
      const overMs = (state.overbreakMs || 0) + (state.overlunchMs || 0);
      const lateMs = lateDeduct * 60000;
      const netMs = Math.max(0, rawMs - lunchMs - overMs - lateMs);
      const netH = Math.round((netMs / 3600000) * 100) / 100;
      return { hours: netH, ot: 0, lateDeduct, isOffset: false };
    }

    // VA / UYP / Admin
    const grossMins = totalSchedMins; // Full schedule as basis
    const lateMins = login > win.start ? minsBetween(win.start, login) : 0;
    const lateDeduct = graceDeduction(lateMins, 0);

    let lunchDeduct = 0;
    if (hasLunch && (state.lunchUsed || state.bblUsed)) {
      lunchDeduct = Math.min(state.lunchDuration || LUNCH_MINS(), LUNCH_MINS());
    }

    const overbreakDeduct = Math.round((state.overbreakMs || 0) / 60000);
    const overlunchDeduct = Math.round((state.overlunchMs || 0) / 60000);

    // Early out deduction
    let earlyOutDeduct = 0;
    if (logout < win.end) {
      earlyOutDeduct = minsBetween(logout, win.end);
    }

    const netMins = grossMins - lunchDeduct - lateDeduct - overbreakDeduct - overlunchDeduct - earlyOutDeduct;
    const payableMins = Math.min(Math.max(0, netMins), MAX_SHIFT_HRS() * 60);
    const payableH = Math.round((payableMins / 60) * 100) / 100;

    // Lunch skip offset detection (9h shift, no lunch punched)
    let lunchSkipOffset = 0;
    if (hasLunch && !state.lunchUsed && !state.bblUsed && payableMins >= MAX_SHIFT_HRS() * 60) {
      // User completed full 8h without taking lunch on a 9h schedule
      // Extra time available for offset = schedule mins - 480 - deductions, capped at 60
      const extraMins = Math.min(60, Math.max(0, grossMins - lunchDeduct - lateDeduct - overbreakDeduct - overlunchDeduct - earlyOutDeduct - MAX_SHIFT_HRS() * 60));
      lunchSkipOffset = extraMins / 60;
    }

    return {
      hours: payableH,
      ot: 0,
      lateDeduct,
      lunchDeduct,
      overbreakDeduct,
      overlunchDeduct,
      earlyOutDeduct,
      lunchSkipOffset: Math.round(lunchSkipOffset * 100) / 100,
      isOffset: false,
    };
  } catch(e) {
    console.error('calcPayable error:', e.message);
    return { hours: 0, ot: 0, isOffset: false };
  }
}

// §20 COMMAND HANDLERS — handleIn/Out/Break/Lunch/BBL/Bio/Back
// ============================================================

async function handleIn(uid, name, isOverride) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user. Please contact your admin or supervisor.`;

  // C5: Owner and Director cannot clock in — no payroll tracking
  if (!canLogin(user.role)) {
    return `🚫 ${name}, the ${user.role} role does not participate in shift tracking.`;
  }

  const now = new Date();
  const manila = manilaTime();
  const windowDate = getWindowDate(manila);
  const state = await getState(uid);
  const wr = await getWindow(uid, windowDate);

  // Clear stale admin override if user is actively logging in (contradicts day-type override)
  if (wr && wr.adminOverride && ['absent','holiday','leave','vto','dayoff','offline'].includes(wr.adminOverride)) {
    wr.adminOverride = null;
    if (wr.adminOverrides) delete wr.adminOverrides.status;
    wr.events.push({ action: 'override-cleared', time: now.toISOString(), detail: `${name} logged in, clearing stale override` });
    await setWindow(uid, windowDate, wr);
  }

  // Already active?
  if (state.status !== 'out' && !['holiday','absent','leave','vto'].includes(state.status)) {
    return `⚠️ You're already logged in, ${name}. If this is an error, please contact your supervisor.`;
  }

  // Double-shift prevention for non-leaders
  if (!isInternal(user.role) && wr && wr.sessions && wr.sessions.length > 0) {
    return `⚠️ ${name}, you've already completed a shift in this window. Multiple logins are not allowed. Contact your supervisor for assistance.`;
  }

  const schedInfo = getScheduleForWindow(user, windowDate);

  // Non-leaders can't login on rest days
  if (!schedInfo && !isInternal(user.role)) {
    return `📋 Hi ${name}! Today is your day off. Enjoy your rest! If this is an error, please contact your supervisor.`;
  }

  // Leader rest day login — raw hours
  if (!schedInfo && isInternal(user.role)) {
    const newWr = wr || newWindowRecord(uid, name, user.role, windowDate);
    newWr.events.push({ action: 'in', time: now.toISOString(), detail: 'rest-day' });
    if (!newWr.firstLoginTime) newWr.firstLoginTime = now.toISOString();
    await setWindow(uid, windowDate, newWr);
    await setState(uid, {
      status: 'in', loginTime: now.toISOString(), windowDate,
      isFirstLogin: !wr || wr.sessions.length === 0,
      breakUsed: newWr.breakUsed, lunchUsed: newWr.lunchUsed, bblUsed: newWr.bblUsed,
      overbreakMs: 0, overlunchMs: 0, lunchDuration: 0,
      isRestDay: true,
    });
    sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'in', name, uid, 'rest-day']]).catch(console.error);
    return `✅ Log In confirmed — ${name}. Rest day session started. All hours count toward your cutoff.`;
  }

  const { sched, dateStr, win } = schedInfo;
  const minsToShift = minsBetween(now, win.start);
  const minsLate = minsBetween(win.start, now);
  const isLate = minsLate > GRACE_MINS();
  const isEarly = now < win.start;
  const isFirstLogin = !wr || wr.sessions.length === 0;

  // Initialize or update window record
  const newWr = wr || newWindowRecord(uid, name, user.role, windowDate);
  newWr.events.push({ action: 'in', time: now.toISOString(), detail: isLate ? `late-${minsLate}m` : isEarly ? 'early' : 'ontime' });
  if (!newWr.firstLoginTime) newWr.firstLoginTime = now.toISOString();
  if (isLate && isFirstLogin) {
    const deduct = graceDeduction(minsLate, 0);
    newWr.lateMs = deduct * 60000;
  }
  await setWindow(uid, windowDate, newWr);

  const newStatus = isEarly ? 'pre-shift' : 'in';
  await setState(uid, {
    status: newStatus,
    loginTime: now.toISOString(),
    windowDate,
    shiftStart: win.start.toISOString(),
    shiftEnd: win.end.toISOString(),
    isFirstLogin,
    isLate: isLate && isFirstLogin,
    breakUsed: newWr.breakUsed,
    lunchUsed: newWr.lunchUsed,
    bblUsed: newWr.bblUsed,
    overbreakMs: 0,
    overlunchMs: 0,
    lunchDuration: 0,
    breakStart: null,
    breakType: null,
  });

  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'in', name, uid, isLate ? 'late' : isEarly ? 'early' : 'ontime']]).catch(console.error);

  if (isEarly) return `🌅 Log In confirmed — ${name}. You're early! Your shift starts at ${fmtTime(win.start)}. We'll mark you active then. 💪`;
  if (isLate) return `⏰ Log In confirmed — ${name}. Your shift started at ${fmtTime(win.start)}. You're ${minsLate} min late — ${graceDeduction(minsLate, 0)} min will be deducted.`;
  return `✅ Log In confirmed — ${name}. Your shift starts at ${sched.start} Manila. Have a great shift! 💪`;
}

async function handleOut(uid, name, isOverride, skipEarlyCheck) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;

  const state = await getState(uid);
  const now = new Date();

  if (state.status === 'out') return `⚠️ You're not currently logged in, ${name}.`;
  if (state.status === 'offset') return `⚠️ ${name}, you have an active offset session. Please end it first.`;
  if (state.status === 'ot') return `⚠️ ${name}, you have an active OT session. Please end it first.`;

  // Early out detection (non-leaders, non-override)
  if (!isOverride && !skipEarlyCheck && !isInternal(user.role) && state.shiftEnd) {
    const shiftEnd = new Date(state.shiftEnd);
    if (now < shiftEnd) {
      // Store pending confirmation in state
      await setState(uid, { ...state, pendingOut: true, pendingOutTime: now.toISOString() });
      return `⚠️ ${name}, your shift ends at ${fmtTime(shiftEnd)}. Are you sure you want to log out early? Please confirm in the Mini App.`;
    }
  }

  // Auto-close open break/lunch/bio
  if (state.breakStart && state.breakType) {
    const breakMins = minsBetween(new Date(state.breakStart), now);
    if (state.breakType === 'break') {
      const deduct = graceDeduction(breakMins, BREAK_MINS());
      if (deduct > 0) state.overbreakMs = (state.overbreakMs || 0) + deduct * 60000;
    } else if (state.breakType === 'lunch') {
      const deduct = graceDeduction(breakMins, LUNCH_MINS());
      if (deduct > 0) state.overlunchMs = (state.overlunchMs || 0) + deduct * 60000;
      state.lunchDuration = Math.min(breakMins, LUNCH_MINS());
      state.lunchUsed = true;
    } else if (state.breakType === 'bbl') {
      const deduct = graceDeduction(breakMins, BBL_MINS());
      if (deduct > 0) state.overlunchMs = (state.overlunchMs || 0) + deduct * 60000;
      state.lunchDuration = Math.min(Math.max(0, breakMins - BREAK_MINS()), LUNCH_MINS());
      state.lunchUsed = true;
      state.bblUsed = true;
    }
    // bio: no deductions
  }

  const result = calcPayable(user, state, now);
  const windowDate = state.windowDate || getWindowDate();
  const wr = await getWindow(uid, windowDate) || newWindowRecord(uid, name, user.role, windowDate);

  // Record session
  wr.sessions.push({ in: state.loginTime, out: now.toISOString(), hours: result.hours });
  wr.totalHours = Math.round((wr.totalHours + result.hours) * 100) / 100;
  wr.breakUsed = state.breakUsed || wr.breakUsed;
  wr.lunchUsed = state.lunchUsed || wr.lunchUsed;
  wr.bblUsed = state.bblUsed || wr.bblUsed;
  wr.overbreakMs = (wr.overbreakMs || 0) + (state.overbreakMs || 0);
  wr.overlunchMs = (wr.overlunchMs || 0) + (state.overlunchMs || 0);
  wr.lateMs = wr.lateMs || 0;
  wr.events.push({ action: 'out', time: now.toISOString(), detail: `${result.hours}h` });
  wr.status = 'completed';

  // Lunch skip offset (non-leaders, 9h schedule, no lunch taken)
  let offsetMsg = '';
  if (!isInternal(user.role) && result.lunchSkipOffset > 0) {
    const co = await getCutoff(uid);
    const expected = await getExpectedHours(user);
    const missing = Math.max(0, expected - co.hours);
    const credit = Math.min(result.lunchSkipOffset, missing);
    if (credit > 0) {
      await addCutoffHours(uid, user.role, credit, 0);
      wr.lunchSkipOffset = credit;
      offsetMsg = `\n📊 Lunch skipped — ${(credit * 60).toFixed(0)} min credited as offset.`;
    } else {
      offsetMsg = '\n📊 Lunch skipped — no offset hours needed, no credit applied.';
    }
  }

  // Add hours to cutoff
  await addCutoffHours(uid, user.role, result.hours, result.ot);
  await setWindow(uid, windowDate, wr);
  await clearState(uid);

  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'out', name, uid, `${result.hours}h`]]).catch(console.error);

  const hoursStr = result.hours.toFixed(2);
  return `👋 Log Out confirmed — ${name}. Hours today: <b>${hoursStr}h</b>. Contact your manager for any disputes.${offsetMsg}`;
}

async function handleBreak(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;

  const state = await getState(uid);
  const now = new Date();

  // Auto-promote pre-shift
  if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) {
    state.status = 'in';
    await setState(uid, state);
  }

  if (state.status === 'out') return `⚠️ ${name}, you need to log in first!`;
  if (!['in'].includes(state.status)) return `⚠️ ${name}, you're already on a break or offline activity. Please type "back" first.`;

  // Check if break already used (from window record for leaders)
  const windowDate = state.windowDate || getWindowDate();
  const wr = await getWindow(uid, windowDate);
  if ((wr && wr.breakUsed) || state.breakUsed) {
    return `⚠️ ${name}, you've already used your break for this shift.`;
  }

  const back = new Date(now.getTime() + BREAK_MINS() * 60000);
  await setState(uid, { ...state, status: 'break', breakStart: now.toISOString(), breakType: 'break' });
  await appendWindowEvent(uid, windowDate, 'break', '');
  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'break', name, uid]]).catch(console.error);

  return `⏸️ Break confirmed — ${name}. 30 minutes paid break. Be back by <b>${fmtTime(back)}</b>. ☕`;
}

async function handleLunch(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;

  const state = await getState(uid);
  const now = new Date();

  if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) {
    state.status = 'in'; await setState(uid, state);
  }

  if (state.status === 'out') return `⚠️ ${name}, you need to log in first!`;
  if (!['in'].includes(state.status)) return `⚠️ ${name}, please type "back" first.`;

  if (state.lunchUsed || state.bblUsed) return `⚠️ ${name}, you've already taken your lunch.`;

  // Check lunch entitlement
  const windowDate = state.windowDate || getWindowDate();
  const schedInfo = getScheduleForWindow(user, windowDate);
  if (schedInfo && !hasLunchEntitlement(schedInfo.sched, schedInfo.dateStr)) {
    return `⚠️ ${name}, your 8-hour schedule doesn't include a lunch period.`;
  }

  const back = new Date(now.getTime() + LUNCH_MINS() * 60000);
  await setState(uid, { ...state, status: 'lunch', breakStart: now.toISOString(), breakType: 'lunch' });
  await appendWindowEvent(uid, windowDate, 'lunch', '');
  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'lunch', name, uid]]).catch(console.error);

  return `🍽️ Lunch confirmed — ${name}. 1 hour unpaid. Be back by <b>${fmtTime(back)}</b>. Enjoy!`;
}

async function handleBBL(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;

  const state = await getState(uid);
  const now = new Date();

  if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) {
    state.status = 'in'; await setState(uid, state);
  }

  if (state.status === 'out') return `⚠️ ${name}, you need to log in first!`;
  if (!['in'].includes(state.status)) return `⚠️ ${name}, please type "back" first.`;

  if (state.breakUsed || state.lunchUsed || state.bblUsed) return `⚠️ ${name}, you've already used your break or lunch.`;

  const windowDate = state.windowDate || getWindowDate();
  const schedInfo = getScheduleForWindow(user, windowDate);
  if (schedInfo && !hasLunchEntitlement(schedInfo.sched, schedInfo.dateStr)) {
    return `⚠️ ${name}, your 8-hour schedule doesn't include a lunch period. Use "break" for your 30-minute paid break.`;
  }

  const back = new Date(now.getTime() + BBL_MINS() * 60000);
  await setState(uid, { ...state, status: 'bbl', breakStart: now.toISOString(), breakType: 'bbl' });
  await appendWindowEvent(uid, windowDate, 'bbl', '');
  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'bbl', name, uid]]).catch(console.error);

  return `🍽️ Break + Lunch confirmed — ${name}. 90 minutes (30 paid break + 60 unpaid lunch). Be back by <b>${fmtTime(back)}</b>. Enjoy!`;
}

async function handleBio(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;

  const state = await getState(uid);
  const now = new Date();

  if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) {
    state.status = 'in'; await setState(uid, state);
  }

  if (state.status === 'out') return `⚠️ ${name}, you need to log in first!`;
  if (!['in'].includes(state.status)) return `⚠️ ${name}, please type "back" first.`;

  const windowDate = state.windowDate || getWindowDate();
  await setState(uid, { ...state, status: 'bio', breakStart: now.toISOString(), breakType: 'bio' });
  await appendWindowEvent(uid, windowDate, 'bio', '');
  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'bio', name, uid]]).catch(console.error);

  return `🚻 Bio break — ${name}. No time penalty. Please return when ready.`;
}

async function handleBack(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;

  const state = await getState(uid);
  const now = new Date();

  if (state.status === 'out') return `⚠️ ${name}, you're not currently logged in.`;
  if (state.status === 'in') return `⚠️ ${name}, you're not on a break! No need to punch back.`;
  if (state.status === 'pre-shift') return `⚠️ ${name}, you're in pre-shift status, not on a break.`;

  const bt = state.breakType || 'break';
  const breakMins = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
  const windowDate = state.windowDate || getWindowDate();
  let overMsg = '';

  if (bt === 'break') {
    const deduct = graceDeduction(breakMins, BREAK_MINS());
    if (deduct > 0) {
      state.overbreakMs = (state.overbreakMs || 0) + deduct * 60000;
      overMsg = ` ⚠️ You were ${deduct} min over your break — this will be deducted.`;
    }
    state.breakUsed = true;
  } else if (bt === 'lunch') {
    const deduct = graceDeduction(breakMins, LUNCH_MINS());
    if (deduct > 0) {
      state.overlunchMs = (state.overlunchMs || 0) + deduct * 60000;
      overMsg = ` ⚠️ You were ${deduct} min over your lunch — this will be deducted.`;
    }
    state.lunchDuration = Math.min(breakMins, LUNCH_MINS());
    state.lunchUsed = true;
  } else if (bt === 'bbl') {
    const deduct = graceDeduction(breakMins, BBL_MINS());
    if (deduct > 0) {
      state.overlunchMs = (state.overlunchMs || 0) + deduct * 60000;
      overMsg = ` ⚠️ You were ${deduct} min over your break + lunch — this will be deducted.`;
    }
    state.lunchDuration = Math.min(Math.max(0, breakMins - BREAK_MINS()), LUNCH_MINS());
    state.breakUsed = true;
    state.lunchUsed = true;
    state.bblUsed = true;
  }
  // bio: no deductions, no flags

  state.status = 'in';
  state.breakStart = null;
  state.breakType = null;
  await setState(uid, state);

  // Update window record
  const wr = await getWindow(uid, windowDate);
  if (wr) {
    wr.breakUsed = state.breakUsed || wr.breakUsed;
    wr.lunchUsed = state.lunchUsed || wr.lunchUsed;
    wr.bblUsed = state.bblUsed || wr.bblUsed;
    wr.overbreakMs = (wr.overbreakMs || 0) + (state.overbreakMs || 0);
    wr.overlunchMs = (wr.overlunchMs || 0) + (state.overlunchMs || 0);
    wr.events.push({ action: 'back', time: now.toISOString(), detail: `${bt}-${breakMins}m` });
    await setWindow(uid, windowDate, wr);
  }

  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'back', name, uid, `from-${bt}`]]).catch(console.error);
  return `✅ Welcome back, ${name}!${overMsg}`;
}

// §21 DAY OVERRIDES — Holiday/Absent/Leave/VTO
async function applyDayOverride(uid, name, type, approvedBy) {
  const user = await getUserById(uid);
  if (!user) return `🚫 User not found.`;

  const windowDate = getWindowDate();
  const addsHours = type === 'holiday' || type === 'leave';

  await setState(uid, { status: type, windowDate });

  const wr = await getWindow(uid, windowDate) || newWindowRecord(uid, name, user.role, windowDate);
  wr.status = type;
  wr.totalHours = addsHours ? MAX_SHIFT_HRS() : 0;
  wr.events.push({ action: type, time: new Date().toISOString(), detail: `approved by ${approvedBy}` });
  await setWindow(uid, windowDate, wr);

  if (addsHours) await addCutoffHours(uid, user.role, MAX_SHIFT_HRS(), 0);

  sheetAppend('Telegram Logs', [[fmtDate(new Date()), fmtTime(new Date()), type, name, uid, `approved:${approvedBy}`]]).catch(console.error);

  const msgs = { holiday: `🎉 Holiday logged — ${name}. +8h.`, absent: `📋 Absent logged — ${name}. 0h.`, leave: `🌴 Leave logged — ${name}. +8h.`, vto: `✅ VTO logged — ${name}. 0h.` };
  return msgs[type] || `${type} logged — ${name}.`;
}

// §22 OFFSET HANDLERS
async function handleOffsetIn(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;
  if (isInternal(user.role)) return `⚠️ ${name}, leaders don't use offset. All hours auto-count.`;

  const state = await getState(uid);
  if (state.status !== 'out') return `⚠️ ${name}, you need to be logged out to start an offset.`;

  const windowDate = getWindowDate();
  const schedInfo = getScheduleForWindow(user, windowDate);

  // Check: not during scheduled shift
  if (schedInfo) {
    const now = new Date();
    if (now >= schedInfo.win.start && now <= schedInfo.win.end) {
      return `⚠️ ${name}, you can't start an offset during your scheduled shift. Use /in instead.`;
    }
  }

  // Check 2AM finalization lockout on cutoff day
  if (isLastCutoffDay(user.role)) {
    const h = manilaTime().getHours();
    if (h >= FINALIZE_HR()) return `⚠️ ${name}, offset is no longer available today (past 2AM cutoff finalization).`;
  }

  const co = await getCutoff(uid);
  const expected = await getExpectedHours(user);
  const missing = Math.max(0, expected - co.hours);

  await setState(uid, { status: 'offset', offsetStart: new Date().toISOString(), windowDate });
  await appendWindowEvent(uid, windowDate, 'offset-in', `missing:${missing.toFixed(2)}h`);
  sheetAppend('Telegram Logs', [[fmtDate(new Date()), fmtTime(new Date()), 'offset-in', name, uid]]).catch(console.error);

  return `⏱️ Offset started — ${name}. Missing hours: <b>${missing.toFixed(2)}h</b>. Make it count! 💪`;
}

async function handleOffsetOut(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;

  const state = await getState(uid);
  if (state.status !== 'offset') return `⚠️ ${name}, you don't have an active offset session.`;

  const now = new Date();
  const start = new Date(state.offsetStart);
  const durationH = (now - start) / 3600000;
  const windowDate = state.windowDate || getWindowDate();

  const co = await getCutoff(uid);
  const expected = await getExpectedHours(user);
  const missingBefore = Math.max(0, expected - co.hours);
  const credit = Math.min(durationH, missingBefore); // Cap at missing hours

  if (credit > 0) await addCutoffHours(uid, user.role, credit, 0);

  const wr = await getWindow(uid, windowDate);
  if (wr) {
    wr.events.push({ action: 'offset-out', time: now.toISOString(), detail: `${credit.toFixed(2)}h credited` });
    await setWindow(uid, windowDate, wr);
  }

  await clearState(uid);
  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'offset-out', name, uid, `${credit.toFixed(2)}h`]]).catch(console.error);

  const remaining = Math.max(0, missingBefore - credit);
  return `✅ Offset complete — ${name}. Duration: ${(durationH * 60).toFixed(0)} min. Credited: <b>${credit.toFixed(2)}h</b>. Remaining missing: <b>${remaining.toFixed(2)}h</b>.`;
}

// §22 OT HANDLERS
async function handleOTIn(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;
  if (isInternal(user.role)) return `⚠️ ${name}, leaders don't use OT commands. All hours auto-count.`;

  const state = await getState(uid);
  if (state.status !== 'out') return `⚠️ ${name}, you need to be logged out to start OT.`;

  const windowDate = getWindowDate();
  const schedInfo = getScheduleForWindow(user, windowDate);
  const now = new Date();

  // Check: not during shift
  if (schedInfo) {
    if (now >= schedInfo.win.start && now <= schedInfo.win.end) {
      return `⚠️ ${name}, you can't start OT during your scheduled shift.`;
    }
    // Check: at least 30 min before shift starts
    const minsToShift = minsBetween(now, schedInfo.win.start);
    if (minsToShift > 0 && minsToShift < OT_BLOCK_MINS()) {
      return `⚠️ ${name}, you need at least 30 minutes before your shift to start OT. Your shift starts in ${minsToShift} min.`;
    }
  }

  // Check: at least 30 min before daily reset
  const manila = manilaTime();
  const resetToday = new Date(manilaDateStr(manila) + 'T18:00:00+08:00');
  if (manila.getHours() < 18) {
    const minsToReset = minsBetween(now, resetToday);
    if (minsToReset < OT_BLOCK_MINS()) {
      return `⚠️ ${name}, less than 30 minutes before shift reset. OT cannot be started.`;
    }
  }

  await setState(uid, { status: 'ot', otStart: now.toISOString(), windowDate });
  await appendWindowEvent(uid, windowDate, 'ot-in', '');
  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'ot-in', name, uid]]).catch(console.error);

  return `⏱️ OT started — ${name}. Remember: 30-minute blocks only. Incomplete blocks won't count.`;
}

async function handleOTOut(uid, name) {
  const user = await getUserById(uid);
  if (!user) return `🚫 Unauthorized user.`;

  const state = await getState(uid);
  if (state.status !== 'ot') return `⚠️ ${name}, you don't have an active OT session.`;

  const now = new Date();
  const start = new Date(state.otStart);
  const durationMin = minsBetween(start, now);
  const blocks = Math.floor(durationMin / OT_BLOCK_MINS());
  const otHours = blocks * 0.5;
  const windowDate = state.windowDate || getWindowDate();

  if (otHours > 0) {
    await addCutoffHours(uid, user.role, 0, otHours);
  }

  const wr = await getWindow(uid, windowDate);
  if (wr) {
    wr.totalOT = (wr.totalOT || 0) + otHours;
    wr.events.push({ action: 'ot-out', time: now.toISOString(), detail: `${durationMin}min=${blocks}blocks=${otHours}h` });
    await setWindow(uid, windowDate, wr);
  }

  await clearState(uid);
  sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'ot-out', name, uid, `${otHours}h OT`]]).catch(console.error);

  if (otHours === 0) return `⏱️ OT ended — ${name}. Duration: ${durationMin} min. Less than 30 min — <b>0h OT credited</b>.`;
  return `✅ OT complete — ${name}. Duration: ${durationMin} min. Credited: <b>${otHours}h OT</b> (${blocks} block${blocks > 1 ? 's' : ''}).`;
}

// §22 LEADER OVERRIDE — execute commands on behalf of another user
async function handleOverride(leaderUid, leaderName, targetIdentifier, command) {
  // Find target user by name or ID
  let targetUser = await getUserById(targetIdentifier);
  if (!targetUser) targetUser = await getUserByName(targetIdentifier);
  if (!targetUser) return `🚫 User "${targetIdentifier}" not found.`;

  const tuid = targetUser.id;
  const tname = targetUser.name;
  let reply;

  switch (command) {
    case 'in':      reply = await handleIn(tuid, tname, true); break;
    case 'out':     reply = await handleOut(tuid, tname, true, true); break;
    case 'break':   reply = await handleBreak(tuid, tname); break;
    case 'lunch':   reply = await handleLunch(tuid, tname); break;
    case 'bbl':     reply = await handleBBL(tuid, tname); break;
    case 'bio':     reply = await handleBio(tuid, tname); break;
    case 'back':    reply = await handleBack(tuid, tname); break;
    case 'absent':  reply = await applyDayOverride(tuid, tname, 'absent', leaderName); break;
    case 'leave':   reply = await applyDayOverride(tuid, tname, 'leave', leaderName); break;
    case 'holiday': reply = await applyDayOverride(tuid, tname, 'holiday', leaderName); break;
    case 'vto':     reply = await applyDayOverride(tuid, tname, 'vto', leaderName); break;
    case 'offset-in':  reply = await handleOffsetIn(tuid, tname); break;
    case 'offset-out': reply = await handleOffsetOut(tuid, tname); break;
    case 'ot-in':      reply = await handleOTIn(tuid, tname); break;
    case 'ot-out':     reply = await handleOTOut(tuid, tname); break;
    default: return `🚫 Unknown command "${command}".`;
  }

  // Log the override
  await logEdit(leaderName, 'Leader', `override-${command}`, tname, null, { command, by: leaderName });

  // Notify the target user via DM
  await sendDM(tuid, `🔄 <b>Override by ${leaderName}</b>\nCommand: ${command}\n${reply}`);

  return `🔄 Override executed — ${tname} → ${command}\n${reply}`;
}

// §23 WEBHOOK — Telegram bot webhook
// ============================================================
const PRIMARY_COMMANDS = ['in','out','break','lunch','bbl','bio','back'];
// Secondary commands redirect to Mini App for request submission
const SECONDARY_COMMANDS = ['absent','leave','holiday','vto','offset-in','offset-out','ot-in','ot-out'];

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body;
    const msg = update.message || update.channel_post;
    if (!msg) return;

    const chatId = String(msg.chat.id);
    const topicId = msg.message_thread_id ? String(msg.message_thread_id) : null;
    const uid = String(msg.from.id);
    const text = (msg.text || '').trim().toLowerCase().replace(/^\//, '');
    const name = msg.from.first_name || msg.from.username || 'User';
    const updateId = String(update.update_id);

    if (chatId !== ALLOWED_CHAT) return;
    if (topicId !== TOPIC_ID) return;
    if (await isDuplicate(updateId)) return;

    const user = await getUserById(uid);
    if (!user) { await sendGroupConfirmation(`🚫 Unauthorized user (${name}). Contact your admin.`); return; }

    let reply = null;

    // Primary commands
    if (text === 'in') reply = await handleIn(uid, name);
    else if (text === 'out') reply = await handleOut(uid, name);
    else if (text === 'break') reply = await handleBreak(uid, name);
    else if (text === 'lunch') reply = await handleLunch(uid, name);
    else if (text === 'bbl') reply = await handleBBL(uid, name);
    else if (text === 'bio') reply = await handleBio(uid, name);
    else if (text === 'back') reply = await handleBack(uid, name);
    // Secondary commands → redirect to Mini App
    else if (SECONDARY_COMMANDS.includes(text)) {
      reply = `📱 ${name}, please use the Mini App to submit ${text} requests.`;
    }

    if (reply) await sendGroupConfirmation(reply);
  } catch(e) { console.error('Webhook error:', e.message); }
});

// §24 DASHBOARD API
// ============================================================
app.get('/dashboard', async (req, res) => {
  try {
    const data = await getDashboardData();
    const cb = req.query.callback;
    if (cb) { res.setHeader('Content-Type', 'application/javascript'); res.send(`${cb}(${JSON.stringify(data)})`); }
    else res.json(data);
  } catch(e) { console.error('/dashboard:', e.message); res.status(500).json({ error: e.message }); }
});

async function getDashboardData() {
  const now = new Date();
  const manila = manilaTime();
  const windowDate = getWindowDate(manila);
  const roster = await getRoster();

  const [allStates, allCutoffs, allWindows] = await Promise.all([
    Promise.all(roster.map(u => getState(u.id))),
    Promise.all(roster.map(u => getCutoff(u.id))),
    Promise.all(roster.map(u => getWindow(u.id, windowDate))),
  ]);

  const users = [];

  for (const [idx, user] of roster.entries()) {
    // M1: Owner and Director have no payroll/shift tracking — exclude from snapshot
    if (!hasCutoff(user.role)) continue;

    const state = allStates[idx];
    const co = allCutoffs[idx];
    const wr = allWindows[idx];
    const schedInfo = getScheduleForWindow(user, windowDate);

    let status = 'offline', label = 'Offline';
    let shiftStart = '', shiftEnd = '', shiftProgress = 0;
    let productiveHours = 0;
    let offlineActivity = null;

    // Admin override takes priority over computed status
    if (wr && wr.adminOverride) {
      status = wr.adminOverride;
      const overrideLabels = { active:'Active','late-in':'Late In',missing:'Missing',absent:'Absent',holiday:'Holiday 🎉',leave:'On Leave 🌴',vto:'VTO',offline:'Offline',dayoff:'Day Off' };
      label = overrideLabels[status] || status;
      if (schedInfo) { shiftStart = fmtTime(schedInfo.win.start); shiftEnd = fmtTime(schedInfo.win.end); }
      if (wr.totalHours) productiveHours = wr.totalHours;
    } else {

    const dayOverrides = ['holiday', 'absent', 'leave', 'vto'];
    if (dayOverrides.includes(state.status)) {
      status = state.status;
      const lm = { holiday: 'Holiday 🎉', absent: 'Absent', leave: 'On Leave 🌴', vto: 'VTO' };
      label = lm[state.status] || state.status;
    } else if (state.status === 'offset') {
      status = 'offset'; label = 'Offset';
    } else if (state.status === 'ot') {
      status = 'ot'; label = 'OT';
    } else if (schedInfo || state.isRestDay) {
      if (schedInfo) {
        shiftStart = fmtTime(schedInfo.win.start);
        shiftEnd = fmtTime(schedInfo.win.end);
        const totalMs = schedInfo.win.end - schedInfo.win.start;
        shiftProgress = Math.round(Math.min(100, Math.max(0, (now - schedInfo.win.start) / totalMs * 100)));
      }

      if (state.status === 'out') {
        if (wr && wr.status === 'completed') {
          status = 'done'; label = 'Done ✓';
          productiveHours = wr.totalHours;
        } else if (schedInfo && now >= schedInfo.win.start && now <= schedInfo.win.end) {
          status = 'missing'; label = 'Missing';
        } else {
          status = 'offline'; label = 'Offline';
        }
      } else if (state.status === 'pre-shift') {
        if (state.shiftStart && now >= new Date(state.shiftStart)) {
          status = 'active'; label = 'Active';
          try { await setState(user.id, { ...state, status: 'in' }); } catch(e) {}
        } else {
          status = 'pre-shift'; label = 'Pre-Shift';
        }
      } else if (state.status === 'in') {
        if (state.isLate) { status = 'late-in'; label = 'Late In'; }
        else if ((state.overbreakMs || 0) > 0 || (state.overlunchMs || 0) > 0) { status = 'active'; label = 'Active'; }
        else { status = 'active'; label = 'Active'; }
      } else if (state.status === 'break') {
        const elapsed = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
        if (elapsed > BREAK_MINS()) { status = 'overbreak'; label = 'Over Break'; }
        else { status = 'break'; label = 'Break'; }
        offlineActivity = { type: 'break', elapsed, allowed: BREAK_MINS() };
      } else if (state.status === 'lunch') {
        const elapsed = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
        if (elapsed > LUNCH_MINS()) { status = 'overlunch'; label = 'Over Lunch'; }
        else { status = 'lunch'; label = 'Lunch'; }
        offlineActivity = { type: 'lunch', elapsed, allowed: LUNCH_MINS() };
      } else if (state.status === 'bbl') {
        const elapsed = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
        if (elapsed > BBL_MINS()) { status = 'overlunch'; label = 'Over Lunch'; }
        else { status = 'bbl'; label = 'Break + Lunch'; }
        offlineActivity = { type: 'bbl', elapsed, allowed: BBL_MINS() };
      } else if (state.status === 'bio') {
        const elapsed = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
        if (elapsed > BIO_WARN_MINS()) { status = 'excessive-bio'; label = 'Excessive Bio Break'; }
        else { status = 'bio'; label = 'Bio Break'; }
        offlineActivity = { type: 'bio', elapsed, allowed: BIO_WARN_MINS() };
      }
    } else {
      // No schedule, not active — day off
      if (state.status !== 'out' && isInternal(user.role)) {
        status = 'active'; label = 'Active (Rest Day)';
      } else {
        status = 'dayoff'; label = 'Day Off';
      }
    }
    } // close adminOverride else block

    // Calculate live productive hours for active users
    if (['active', 'late-in', 'break', 'overbreak', 'lunch', 'overlunch', 'bbl', 'bio', 'excessive-bio'].includes(status) && state.loginTime) {
      const login = new Date(state.loginTime);
      if (schedInfo && !state.isRestDay) {
        const effLogin = login > schedInfo.win.start ? login : schedInfo.win.start;
        const effNow = now < schedInfo.win.end ? now : schedInfo.win.end;
        let grossMs = Math.max(0, effNow - effLogin);
        const lateMins = state.isLate ? graceDeduction(minsBetween(schedInfo.win.start, login), 0) : 0;
        const lunchMs = state.lunchDuration ? Math.min(state.lunchDuration, LUNCH_MINS()) * 60000 : 0;
        const overMs = (state.overbreakMs || 0) + (state.overlunchMs || 0);
        // Subtract currently active break/lunch/bbl/bio time
        let activeBreakMs = 0;
        if (state.breakStart && ['break', 'overbreak', 'lunch', 'overlunch', 'bbl', 'bio', 'excessive-bio'].includes(status)) {
          activeBreakMs = Math.max(0, now - new Date(state.breakStart));
        }
        const netMs = Math.max(0, grossMs - lateMins * 60000 - lunchMs - overMs - activeBreakMs);
        productiveHours = Math.min(Math.round((netMs / 3600000) * 100) / 100, MAX_SHIFT_HRS());
      } else {
        // Leader rest day or no schedule
        const rawMs = Math.max(0, now - login);
        let activeBreakMs = 0;
        if (state.breakStart && ['break', 'overbreak', 'lunch', 'overlunch', 'bbl', 'bio', 'excessive-bio'].includes(status)) {
          activeBreakMs = Math.max(0, now - new Date(state.breakStart));
        }
        productiveHours = Math.round(((rawMs - activeBreakMs) / 3600000) * 100) / 100;
      }
    }

    // Add window record hours for completed sessions (leader multi-login)
    if (wr && wr.sessions.length > 0 && state.status !== 'out') {
      const pastSessionHours = wr.sessions.reduce((sum, s) => sum + (s.hours || 0), 0);
      if (state.loginTime) productiveHours += pastSessionHours; // Current session + past sessions
    }

    // Get login/logout time — prefer state for active, window record for completed
    let loginTime = state.loginTime || '';
    if (!loginTime && wr && wr.firstLoginTime) loginTime = wr.firstLoginTime;
    if (!loginTime && wr && wr.sessions && wr.sessions.length > 0) loginTime = wr.sessions[0].in || '';

    let logoutTime = '';
    if (wr && wr.sessions && wr.sessions.length > 0) {
      const lastSession = wr.sessions[wr.sessions.length - 1];
      if (lastSession.out) logoutTime = lastSession.out;
    }

    // Parse break/lunch event history from window record
    let breakEvents = null;
    if (wr && wr.events && wr.events.length > 0) {
      const be = { breakStart: null, breakEnd: null, breakMins: null, lunchStart: null, lunchEnd: null, lunchMins: null, bblStart: null, bblEnd: null, bblMins: null };
      for (const ev of wr.events) {
        if (ev.action === 'break') be.breakStart = ev.time;
        else if (ev.action === 'lunch') be.lunchStart = ev.time;
        else if (ev.action === 'bbl') be.bblStart = ev.time;
        else if (ev.action === 'back') {
          const d = ev.detail || '';
          if (d.startsWith('break-')) { be.breakEnd = ev.time; be.breakMins = parseInt(d.split('-')[1]) || 0; }
          else if (d.startsWith('lunch-')) { be.lunchEnd = ev.time; be.lunchMins = parseInt(d.split('-')[1]) || 0; }
          else if (d.startsWith('bbl-')) { be.bblEnd = ev.time; be.bblMins = parseInt(d.split('-')[1]) || 0; }
        }
      }
      // Only include if there's actual break data
      if (be.breakStart || be.lunchStart || be.bblStart) breakEvents = be;
    }

    // Apply column-level admin overrides
    if (wr && wr.adminOverrides) {
      if (wr.adminOverrides.loginTime) loginTime = wr.adminOverrides.loginTime;
      if (wr.adminOverrides.logoutTime) logoutTime = wr.adminOverrides.logoutTime;
      if (wr.adminOverrides.hours !== undefined) productiveHours = parseFloat(wr.adminOverrides.hours) || 0;
    }

    users.push({
      id: user.id, name: user.name, role: user.role,
      status, statusLabel: label,
      shiftStart, shiftEnd, shiftProgress,
      scheduleClientSet: schedInfo?.sched?.clientSet === true,
      productiveHours: Math.round(productiveHours * 100) / 100,
      cutoffHours: co.hours, cutoffOT: co.ot,
      cutoffEnd: getCutoffDates(user.role) ? fmtDate(getCutoffDates(user.role).end) : '',
      loginTime,   // ← uses computed fallback chain (state → firstLoginTime → sessions[0].in)
      logoutTime,
      offlineActivity,
      breakEvents,
      windowRecord: wr ? { totalHours: wr.totalHours, totalOT: wr.totalOT, sessions: wr.sessions.length, events: wr.events } : null,
    });
  }

  // Sort: Missing first, then active statuses, then offline
  const ORDER = { missing:0, 'excessive-bio':1, overbreak:2, overlunch:3, 'late-in':4, bio:5, break:6, lunch:7, bbl:8, active:9, 'pre-shift':10, offset:11, ot:12, holiday:13, leave:14, vto:15, absent:16, done:17, dayoff:18, offline:19 };
  users.sort((a, b) => (ORDER[a.status] ?? 20) - (ORDER[b.status] ?? 20));

  // Default cutoff display uses bi-weekly anchor (VA I/II/Admin/Internal)
  const defaultDates = getCutoffDates('VA I');
  return {
    timestamp: fmtTime(now), date: fmtDate(now), windowDate,
    cutoffStart: defaultDates ? fmtDate(defaultDates.start) : '',
    cutoffEnd:   defaultDates ? fmtDate(defaultDates.end)   : '',
    users,
  };
}

// §25 ADMIN API
// ============================================================
function checkAuth(req, res) {
  // AUTH DISABLED — operators were losing sessions. To re-enable:
  // const pass = req.headers['x-admin-pass'] || req.query.pass || req.body?.pass;
  // if (pass !== ADMIN_PASS) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// Roster
app.get('/admin/roster', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try { res.json(await getRoster()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/roster', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const { roster } = req.body;
    if (!Array.isArray(roster)) return res.status(400).json({ error: 'Invalid' });
    const before = await getRoster();
    await saveRoster(roster);
    await logEdit('admin', 'Admin', 'roster-update', 'roster', { count: before.length }, { count: roster.length });
    MANAGEMENT_IDS = roster.filter(u => isManagement(u.role)).map(u => u.id);
    res.json({ ok: true, count: roster.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/user/:id', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const { name, role, schedules } = req.body;
    const roster = await getRoster();
    const idx = roster.findIndex(u => u.id === String(req.params.id));
    const oldUser = idx >= 0 ? roster[idx] : null;
    const user = { id: String(req.params.id), name, role, schedules };
    if (idx >= 0) roster[idx] = user; else roster.push(user);
    await saveRoster(roster);
    rosterCache = null;
    MANAGEMENT_IDS = roster.filter(u => isManagement(u.role)).map(u => u.id);
    await logEdit('admin', 'Admin', idx >= 0 ? 'user-update' : 'user-add', name, oldUser, user);

    // Notify VA if their schedule changed (parity with client schedule edit)
    if (oldUser) {
      const schedChanged = JSON.stringify(oldUser.schedules || []) !== JSON.stringify(schedules || []);
      if (schedChanged) {
        await sendDM(user.id, `📅 <b>Schedule Updated</b>\nYour shift schedule was updated by an administrator. Please check the Mini App for the new times.`).catch(e => {});
      }
      // Notify if role changed (could affect cutoff, OT eligibility, etc.)
      if (oldUser.role !== role) {
        await notifyManagement(`👤 <b>Role Change</b>\n${name}: ${oldUser.role} → ${role}`);
      }
    }
    res.json({ ok: true, user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/user/:id', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const uid = req.params.id;
    const roster = await getRoster();
    const target = roster.find(u => u.id === uid);
    const filtered = roster.filter(u => u.id !== uid);

    // Save first — FK CASCADE handles users → schedules → cutoff_periods → shift_sessions →
    // task_assignments → staff_rates → client_va_assignments
    await saveRoster(filtered);
    rosterCache = null;
    MANAGEMENT_IDS = filtered.filter(u => isManagement(u.role)).map(u => u.id);

    // Clear Redis keys that don't cascade (state, shiftwindow, cutoff cache)
    await rDel(`state:${uid}`).catch(()=>{});
    const keys = await rKeys(`shiftwindow:${uid}:*`).catch(() => []);
    for (const k of keys) await rDel(k).catch(()=>{});
    const cks = await rKeys(`cutoff:${uid}:*`).catch(() => []);
    for (const k of cks) await rDel(k).catch(()=>{});

    // Cancel any pending approvals for this user
    await pgQuery(`UPDATE approvals SET status='cancelled', resolved_at=now() WHERE user_id=$1 AND status='pending'`, [uid]).catch(()=>{});

    await logEdit('admin', 'Admin', 'user-delete', target?.name || uid, target || null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clients
app.get('/admin/clients', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try { res.json(await getClients()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/client', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const clients = await getClients();
    const { client } = req.body;
    const idx = clients.findIndex(c => c.id === client.id);
    if (idx >= 0) clients[idx] = client; else clients.push(client);
    await saveClients(clients);
    await logEdit('admin', 'Admin', idx >= 0 ? 'client-update' : 'client-add', client.name, null, client);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/client/:id', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const clients = await getClients();
    const target = clients.find(c => c.id === req.params.id);
    const filtered = clients.filter(c => c.id !== req.params.id);
    await saveClients(filtered);

    // Cancel orphan tasks belonging to this client
    if (target) {
      const clientIdent = target.telegramId || target.id;
      // H4 fix: query Postgres directly for orphan task cancellation
      const orphanRows = await pgQuery(
        `SELECT id FROM tasks WHERE client_id=$1 AND status NOT IN ('done','cancelled')`,
        [clientIdent]
      ).catch(() => []);
      let cancelledCount = 0;
      for (const row of orphanRows) {
        const t = await getTask(row.id);
        if (t) {
          t.status = 'cancelled';
          t.updatedAt = new Date().toISOString();
          t.notes.push({ author: 'System', authorType: 'system', text: 'Client account removed — task cancelled', time: new Date().toISOString() });
          await saveTask(t);
          cancelledCount++;
        }
      }
      if (cancelledCount > 0) console.log(`[Client Delete] Cancelled ${cancelledCount} orphan tasks for ${target.name}`);
    }

    await logEdit('admin', 'Admin', 'client-delete', target?.name || req.params.id, target, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cutoff
app.get('/admin/cutoff', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const roster = await getRoster();
    const result = {};
    for (const u of roster) {
      if (!hasCutoff(u.role)) continue; // Owner/Director have no cutoff
      result[u.id] = { name: u.name, role: u.role, ...(await getCutoff(u.id)) };
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cutoff/:uid', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const before = await getCutoff(req.params.uid);
    await setCutoff(req.params.uid, { hours: req.body.hours || 0, ot: req.body.ot || 0 });
    await logEdit('admin', 'Admin', 'cutoff-edit', req.params.uid, before, req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// States
app.get('/admin/states', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const windowDate = getWindowDate();
    const states = {};

    // PRIMARY: Postgres shift_sessions for today — any user with a login_time
    // and no logout_time is considered active. This survives Redis loss.
    try {
      const rows = await pgQuery(
        `SELECT user_id, login_time, logout_time, status, sessions, events, name, role
         FROM shift_sessions WHERE window_date = $1`,
        [windowDate]
      );
      for (const r of rows) {
        // Skip cleanly completed sessions
        if (r.status === 'completed' && r.logout_time) continue;
        // Reconstruct a state-shaped object from PG so Active States tab can render it
        states[r.user_id] = {
          status: 'in', // assumed; Redis state below will refine
          loginTime: r.login_time ? new Date(r.login_time).toISOString() : null,
          windowDate,
          _source: 'pg', // marker so we know this came from PG, not Redis
        };
      }
    } catch(e) { console.error('[admin/states] PG fallback:', e.message); }

    // OVERRIDE: live Redis state — this is the authoritative current state.
    // Any user with a state:{uid} key gets their full live state.
    try {
      const keys = await rKeys('state:*');
      for (const k of keys) {
        const uid = k.replace('state:', '');
        const st = await getState(uid);
        if (st && st.status && st.status !== 'out') {
          states[uid] = { ...st, _source: 'redis' };
        }
      }
    } catch(e) { console.error('[admin/states] Redis read:', e.message); }

    res.json(states);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/state/:uid/clear', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    await logEdit('admin', 'Admin', 'state-clear', req.params.uid, await getState(req.params.uid), null);
    await clearState(req.params.uid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Approvals
app.get('/admin/approvals', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const filter = req.query.status ? (a => a.status === req.query.status) : null;
    res.json(await getApprovals(filter));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/approval/:id/:action', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const { id, action } = req.params;
    if (!['approve', 'deny'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const approval = await resolveApproval(id, action === 'approve' ? 'approved' : 'denied', req.body.resolvedBy || 'admin');
    if (!approval) return res.status(404).json({ error: 'Request not found' });

    await logEdit(req.body.resolvedBy || 'admin', 'Leader', `approval-${action}`, approval.name, null, approval);

    // If approved, execute the action
    if (action === 'approve') {
      const dayTypes = ['absent', 'leave', 'holiday', 'vto'];
      if (dayTypes.includes(approval.type)) {
        const reply = await applyDayOverride(approval.uid, approval.name, approval.type, req.body.resolvedBy || 'admin');
        await sendGroupConfirmation(reply);
      }
      // For offset-in / ot-in: auto-start the session so the dashboard reflects immediately.
      // Previously this required the user to manually trigger via the mini app — confusing UX.
      else if (approval.type === 'offset-in') {
        try {
          const reply = await handleOffsetIn(approval.uid, approval.name);
          await sendGroupConfirmation(reply);
        } catch(e) { console.error('Auto offset-in failed:', e.message); }
      }
      else if (approval.type === 'ot-in') {
        try {
          const reply = await handleOTIn(approval.uid, approval.name);
          await sendGroupConfirmation(reply);
        } catch(e) { console.error('Auto ot-in failed:', e.message); }
      }
      await sendDM(approval.uid, `✅ Your ${approval.type} request has been <b>approved</b>.`);
      await notifyManagement(`✅ ${approval.name}'s ${approval.type} request approved by ${req.body.resolvedBy || 'admin'}.`);
    } else {
      await sendDM(approval.uid, `❌ Your ${approval.type} request has been <b>denied</b>.`);
    }

    res.json({ ok: true, approval });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Window records
app.get('/admin/windows', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const date = req.query.date || getWindowDate();
    const roster = await getRoster();
    const records = {};
    for (const u of roster) {
      const wr = await getWindow(u.id, date);
      if (wr) records[u.id] = wr;
    }
    res.json(records);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit log — reads from Postgres edit_log table (primary)
app.get('/admin/editlog', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const rows = await pgQuery(
      `SELECT id, created_at as ts, actor, actor_role as "actorRole", action, target, before_data as before, after_data as after
       FROM edit_log ORDER BY created_at DESC LIMIT 200`
    );
    const entries = rows.map(r => ({
      ts: r.ts, actor: r.actor, actorRole: r.actorRole,
      action: r.action, target: r.target,
      before: r.before ? (typeof r.before === 'string' ? JSON.parse(r.before) : r.before) : null,
      after: r.after ? (typeof r.after === 'string' ? JSON.parse(r.after) : r.after) : null,
    }));
    res.json(entries);
  } catch(e) {
    // Fallback: try Redis (legacy data)
    try {
      const keys = await rKeys('editlog:*');
      const entries = [];
      for (const k of keys) {
        try { const raw = await rGet(k); if (raw) entries.push(JSON.parse(raw)); } catch(e2) {}
      }
      entries.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      res.json(entries.slice(0, 200));
    } catch(e2) { res.status(500).json({ error: e.message }); }
  }
});

// Financials
app.get('/admin/financials', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try { res.json(await getFinancials()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/financials', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try { await saveFinancials(req.body); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// Snapshot override — TRUTH REWRITE
// Admin's override becomes the actual login time, status, hours, etc.
// Writes propagate to shift_sessions, state Redis, and cutoff_periods.
// The original sequence of events is preserved in shift_sessions.events for audit.
//
// HTML time inputs (<input type="time">) send "HH:MM" strings without a date.
// This helper converts to a full ISO timestamp anchored to today's Manila date.
function parseTimeOverride(input) {
  if (!input) return null;
  // Already a full ISO date? Return as-is.
  if (/^\d{4}-\d{2}-\d{2}T/.test(input)) {
    const d = new Date(input);
    return isNaN(d) ? null : d.toISOString();
  }
  // Plain "HH:MM" or "HH:MM:SS" → anchor to current Manila date
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(input)) {
    const manilaDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // YYYY-MM-DD
    const t = input.length === 5 ? input + ':00' : input;
    // Construct ISO with Manila offset (+08:00)
    const d = new Date(`${manilaDateStr}T${t}+08:00`);
    return isNaN(d) ? null : d.toISOString();
  }
  // Anything else — try parsing, return null if invalid
  const d = new Date(input);
  return isNaN(d) ? null : d.toISOString();
}

app.post('/admin/snapshot/override', async (req, res) => {
  try {
    const { uid, fields } = req.body;
    const windowDate = getWindowDate();
    const user = await getUserById(uid);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const wr = await getWindow(uid, windowDate) || newWindowRecord(uid, user.name, user.role, windowDate);
    if (!wr.events) wr.events = [];

    // Pre-parse time fields (HTML <input type="time"> sends "HH:MM")
    const parsedLogin  = fields.loginTime  !== undefined ? parseTimeOverride(fields.loginTime)  : undefined;
    const parsedLogout = fields.logoutTime !== undefined ? parseTimeOverride(fields.logoutTime) : undefined;

    // ─ STATE STATUS OVERRIDE ─────────────────────────────────
    // Map the override status to a complete Redis state object.
    // Day types (holiday/absent/leave/vto/dayoff/offline) → state with that status, no break info.
    // Shift statuses (active/late-in/in/missing) → state.status='in', with loginTime from override or now.
    // Break statuses (break/lunch/bbl/bio) → state.status=that, with breakStart=now.
    // Offset / OT → state.status=that, with offsetStart/otStart=now.
    if (fields.status !== undefined) {
      const dayTypes = ['holiday','absent','leave','vto','dayoff','offline','out'];
      const shiftActive = ['active','late-in','in','missing'];
      const breakStatus = ['break','lunch','bbl','bio'];
      const offsetOt = ['offset','ot'];

      let newState = null;
      if (!fields.status || fields.status === 'out' || fields.status === 'offline' || fields.status === 'dayoff') {
        // Clear active state (logged out / day off)
        await clearState(uid);
        wr.adminOverride = null;
      } else if (dayTypes.includes(fields.status)) {
        // Day-type override: set state to that day type
        newState = { status: fields.status === 'dayoff' ? 'out' : fields.status, windowDate };
        wr.adminOverride = fields.status;
        // Holiday/leave credit +8h
        if (fields.status === 'holiday' || fields.status === 'leave') {
          wr.totalHours = MAX_SHIFT_HRS();
          await addCutoffHours(uid, user.role, MAX_SHIFT_HRS(), 0);
        }
      } else if (shiftActive.includes(fields.status)) {
        // Active shift override: set state.status='in' with loginTime
        const loginTime = parsedLogin || new Date().toISOString();
        newState = {
          status: 'in', loginTime, windowDate,
          isLate: fields.status === 'late-in',
          shiftStart: null, shiftEnd: null,
        };
        wr.adminOverride = fields.status;
        wr.firstLoginTime = wr.firstLoginTime || loginTime;
      } else if (breakStatus.includes(fields.status)) {
        newState = {
          status: fields.status, breakType: fields.status === 'bbl' ? 'bbl' : fields.status,
          breakStart: new Date().toISOString(), windowDate,
        };
        wr.adminOverride = fields.status;
      } else if (offsetOt.includes(fields.status)) {
        newState = {
          status: fields.status,
          [fields.status === 'offset' ? 'offsetStart' : 'otStart']: new Date().toISOString(),
          windowDate,
        };
        wr.adminOverride = fields.status;
      } else {
        console.warn('[Snapshot Override] Unknown status:', fields.status);
      }

      if (newState) await setState(uid, newState);
    }

    // ─ TIME OVERRIDES — written as REAL columns on shift_sessions ─
    if (fields.loginTime !== undefined) {
      wr.firstLoginTime = parsedLogin;
      wr.events.push({ action: 'admin-set-login', time: new Date().toISOString(), detail: `login=${parsedLogin||'cleared'}` });
      // Also update the live state's loginTime if there is one — and if no status override fired above,
      // we still need to make the user appear "active" with the new login time.
      let st = await getState(uid);
      if (!st || st.status === 'out') {
        // No active state but admin is setting a login time → assume they should be active
        if (parsedLogin) {
          st = { status: 'in', loginTime: parsedLogin, windowDate, isFirstLogin: true };
          await setState(uid, st);
        }
      } else if (parsedLogin) {
        st.loginTime = parsedLogin;
        await setState(uid, st);
      }
    }
    if (fields.logoutTime !== undefined) {
      wr.logoutTime = parsedLogout;
      wr.events.push({ action: 'admin-set-logout', time: new Date().toISOString(), detail: `logout=${parsedLogout||'cleared'}` });
      if (parsedLogout) {
        await clearState(uid);
        wr.status = 'completed';
      }
    }

    // ─ HOURS OVERRIDE — truth rewrite ─
    if (fields.hours !== undefined) {
      const newHours = parseFloat(fields.hours) || 0;
      const oldHours = wr.totalHours || 0;
      wr.totalHours = newHours;
      const delta = newHours - oldHours;
      if (delta !== 0 && hasCutoff(user.role)) {
        const co = await getCutoff(uid);
        co.hours = Math.max(0, (co.hours || 0) + delta);
        await setCutoff(uid, co);
      }
      wr.events.push({ action: 'admin-set-hours', time: new Date().toISOString(), detail: `hours: ${oldHours} → ${newHours}` });
    }

    if (fields.breakMins !== undefined) wr.events.push({ action: 'admin-set-break-mins', time: new Date().toISOString(), detail: `${fields.breakMins}` });
    if (fields.lunchMins !== undefined) wr.events.push({ action: 'admin-set-lunch-mins', time: new Date().toISOString(), detail: `${fields.lunchMins}` });

    if (fields.cutoffHours !== undefined && hasCutoff(user.role)) {
      const co = await getCutoff(uid);
      const oldCo = co.hours;
      co.hours = parseFloat(fields.cutoffHours) || 0;
      await setCutoff(uid, co);
      wr.events.push({ action: 'admin-set-cutoff', time: new Date().toISOString(), detail: `cutoff: ${oldCo} → ${co.hours}` });
    }

    await setWindow(uid, windowDate, wr);

    await logEdit('admin', 'Admin', 'snapshot-override', user.name, null, fields);
    res.json({ ok: true });
  } catch(e) {
    console.error('snapshot override error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Edit active state directly
app.put('/admin/state/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    const { fields } = req.body;
    if (!fields) return res.status(400).json({ error: 'No fields provided' });
    const state = await getState(uid);
    const before = { ...state };
    Object.assign(state, fields);
    await setState(uid, state);
    await logEdit('admin', 'Admin', 'state-edit', uid, before, state);
    res.json({ ok: true, state });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual reset endpoints
app.post('/admin/reset/daily', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const dateStr = manilaDateStr();
    const locked = await rSetNX(`lock:daily:${dateStr}`, '1', 120);
    if (!locked) return res.status(409).json({ error: 'Daily reset already running (scheduler tick or another admin click). Try again in 2 minutes.' });
    await runDailyReset();
    await logEdit('admin', 'Admin', 'manual-daily-reset', 'system', null, { time: new Date().toISOString() });
    res.json({ ok: true, message: 'Daily reset executed' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// One-time Redis cleanup — wipes stale period-unaware keys from before the period-scoped fix
// Config management — admin can view/edit system_config and role_config
app.get('/admin/config', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const sys = await pgQuery('SELECT key, value, description FROM system_config ORDER BY key');
    const roles = await pgQuery('SELECT * FROM role_config ORDER BY display_order, role');
    res.json({ system: sys, roles });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/config/system/:key', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    const before = await pgOne('SELECT value FROM system_config WHERE key=$1', [key]);
    await pgQuery(
      `INSERT INTO system_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
      [key, String(value)]
    );
    await refreshConfigCache(true);
    await logEdit('admin', 'Admin', 'config-system-edit', key, before, { value });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/config/role/:role', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const { role } = req.params;
    const f = req.body || {};
    const before = await pgOne('SELECT * FROM role_config WHERE role=$1', [role]);
    if (!before) return res.status(404).json({ error: 'Role not found' });

    // Allow editing only the configurable fields (not the role name itself)
    const editable = [
      'hierarchy_level','is_payroll_eligible','can_login','is_internal','is_management',
      'cutoff_type','cutoff_cap_hrs','daily_cap_hrs','can_request_ot','can_request_offset',
      'default_timezone','default_in_snapshot','notes'
    ];
    const sets = [], vals = [role];
    for (const k of editable) {
      if (f[k] !== undefined) { sets.push(`${k}=$${vals.length+1}`); vals.push(f[k]); }
    }
    if (!sets.length) return res.json({ ok: true, changed: 0 });
    await pgQuery(
      `UPDATE role_config SET ${sets.join(',')}, updated_at=now() WHERE role=$1`,
      vals
    );
    await refreshConfigCache(true);
    // Roster cache also needs refresh since management_ids depends on role.is_management
    rosterCache = null;
    const roster = await getRoster();
    MANAGEMENT_IDS = roster.filter(u => isManagement(u.role)).map(u => u.id);
    await logEdit('admin', 'Admin', 'config-role-edit', role, before, f);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Force config reload (useful after manual SQL changes)
app.post('/admin/config/reload', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    await refreshConfigCache(true);
    res.json({ ok: true, system: Object.keys(_configCache).length, roles: Object.keys(_roleCache).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/redis/clear-stale', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const r = await getRedis();
    if (!r) return res.status(503).json({ error: 'Redis unavailable' });
    let removed = 0;
    // Old period-unaware cutoff keys (replaced by cutoff:{uid}:{date})
    const oldCutoffKeys = await r.keys('cutoff:*');
    for (const k of oldCutoffKeys) {
      // Keep only the period-scoped ones (cutoff:UID:YYYY-MM-DD = 3 segments)
      const parts = k.split(':');
      if (parts.length < 3) {
        await r.del(k);
        removed++;
      }
    }
    // Stale flat-list cache
    await r.del('roster').then(() => removed++).catch(()=>{});
    await r.del('clients').then(() => removed++).catch(()=>{});
    // Old feedback inbox (now in PG)
    await r.del('feedback:inbox').then(() => removed++).catch(()=>{});
    // Old financials config (now in PG staff_rates)
    await r.del('financials:config').then(() => removed++).catch(()=>{});
    // Old task index (now in PG)
    await r.del('task:index').then(() => removed++).catch(()=>{});
    // Reset roster cache
    rosterCache = null;
    await logEdit('admin', 'Admin', 'redis-clear-stale', 'system', null, { removed });
    res.json({ ok: true, removed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/reset/cutoff', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const dateStr = manilaDateStr();
    const locked = await rSetNX(`lock:cutoff:${dateStr}`, '1', 120);
    if (!locked) return res.status(409).json({ error: 'Cutoff reset already running. Try again in 2 minutes.' });
    await runCutoffReset();
    await logEdit('admin', 'Admin', 'manual-cutoff-reset', 'system', null, { time: new Date().toISOString() });
    res.json({ ok: true, message: 'Cutoff reset executed' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear all states
app.post('/admin/states/clear-all', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const keys = await rKeys('state:*');
    for (const k of keys) await rDel(k);
    await logEdit('admin', 'Admin', 'clear-all-states', 'system', { count: keys.length }, null);
    res.json({ ok: true, cleared: keys.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// §26 MINI APP API
// ============================================================

// Validate Telegram initData
function validateInitData(initDataStr) {
  if (!initDataStr || !TOKEN) return null;
  try {
    const params = new URLSearchParams(initDataStr);
    const hash = params.get('hash');
    params.delete('hash');
    const keys = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckStr = keys.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckStr).digest('hex');
    if (computed !== hash) return null;
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch(e) { return null; }
}

// User data for Mini App
app.get('/whoami/:telegramId', async (req, res) => {
  try {
    const tid = String(req.params.telegramId);

    // PRIORITY 1: Owner/Director enrolled in clients table win over roster.
    // This is intentional: Owner/Director should be enrolled via the clients table
    // (not the roster), because they have no shift tracking and the enrollment form
    // lives there. If the same Telegram ID appears in both tables, the Owner/Director
    // entry takes precedence so the user lands on the Owner mini app.
    const clients = await getClients();
    const clientUser = clients.find(c => c.telegramId === tid);
    if (clientUser && (clientUser.role === 'Owner' || clientUser.role === 'Director')) {
      const clientName = clientUser.firstName ? `${clientUser.firstName} ${clientUser.lastName||''}`.trim() : clientUser.name;
      return res.json({
        found: true, type: 'owner',
        role: clientUser.role,
        name: clientName, id: clientUser.id || clientUser.telegramId,
        firstName: clientUser.firstName || '', lastName: clientUser.lastName || '',
        company: clientUser.company || clientUser.businessName || '',
        logo: clientUser.logo || null, photo: clientUser.photo || null,
        timezone: clientUser.timezone || roleCfg(clientUser.role).default_timezone || 'America/Los_Angeles',
        assignedVAs: clientUser.assignedVAs || [],
      });
    }

    // PRIORITY 2: Roster (Internal / Admin / VA I / VA II / UYP)
    const roster = await getRoster();
    const rosterUser = roster.find(u => u.id === tid);
    if (rosterUser) {
      let type = 'user';
      if (isInternal(rosterUser.role)) type = 'internal';
      // Note: Owner/Director shouldn't be in roster (validation enforced on save),
      // but if they somehow are, route to owner mini app
      else if (rosterUser.role === 'Owner' || rosterUser.role === 'Director') type = 'owner';

      return res.json({
        found: true, type,
        role: rosterUser.role, name: rosterUser.name, id: rosterUser.id,
      });
    }

    // PRIORITY 3: Regular Client
    if (clientUser) {
      const clientName = clientUser.firstName ? `${clientUser.firstName} ${clientUser.lastName||''}`.trim() : clientUser.name;
      return res.json({
        found: true, type: 'client',
        role: clientUser.role || 'Client',
        name: clientName, id: clientUser.id || clientUser.telegramId,
        firstName: clientUser.firstName || '', lastName: clientUser.lastName || '',
        position: clientUser.position || '', businessName: clientUser.businessName || '',
        company: clientUser.company || clientUser.businessName || '',
        logo: clientUser.logo || null, photo: clientUser.photo || null,
        timezone: clientUser.timezone || 'America/Los_Angeles',
        assignedVAs: clientUser.assignedVAs || [],
        features: clientUser.features || { ghl: false, ghostLine: false },
      });
    }

    return res.json({ found: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// User data for Mini App
app.get('/me/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    const user = await getUserById(uid);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const state = await getState(uid);
    const co = await getCutoff(uid);
    const windowDate = getWindowDate();
    const wr = await getWindow(uid, windowDate);
    const schedInfo = getScheduleForWindow(user, windowDate);

    let shiftStart = '', shiftEnd = '', hasLunch = false;
    if (schedInfo) {
      shiftStart = fmtTime(schedInfo.win.start);
      shiftEnd = fmtTime(schedInfo.win.end);
      hasLunch = hasLunchEntitlement(schedInfo.sched, schedInfo.dateStr);
    }

    // Missing hours calculation
    const expected = await getExpectedHours(user);
    const missing = Math.max(0, expected - co.hours);

    // Check for approved but unused offset/OT permissions
    const pendingApprovals = await getApprovals(a => a.uid === uid && a.status === 'pending');
    const approvedPermissions = await getApprovals(a => a.uid === uid && a.status === 'approved' &&
      ['offset-in', 'ot-in'].includes(a.type) &&
      new Date(a.resolvedAt).toDateString() === new Date().toDateString());

    res.json({
      id: user.id, name: user.name, role: user.role,
      state, cutoff: co, windowDate,
      shiftStart, shiftEnd, hasLunch,
      scheduleClientSet: schedInfo?.sched?.clientSet === true,
      missingHours: Math.round(missing * 100) / 100,
      expectedHours: expected,
      windowRecord: wr,
      pendingApprovals,
      approvedPermissions,
      cutoffEnd: getCutoffDates(user.role) ? fmtDate(getCutoffDates(user.role).end) : '',
    });
  } catch(e) { console.error('/me error:', e.message); res.status(500).json({ error: e.message }); }
});

// Execute command from Mini App
app.post('/action', async (req, res) => {
  try {
    const { uid, action, notes } = req.body;
    if (!uid || !action) return res.status(400).json({ error: 'Missing uid or action' });

    const user = await getUserById(uid);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const name = user.name;
    let reply = null;

    // Primary commands — execute immediately
    if (action === 'in') reply = await handleIn(uid, name);
    else if (action === 'out') {
      // Mini App out: if early-out detected, the frontend should have already confirmed
      reply = await handleOut(uid, name, false, true);
    }
    else if (action === 'break') reply = await handleBreak(uid, name);
    else if (action === 'lunch') reply = await handleLunch(uid, name);
    else if (action === 'bbl') reply = await handleBBL(uid, name);
    else if (action === 'bio') reply = await handleBio(uid, name);
    else if (action === 'back') reply = await handleBack(uid, name);
    // Leader direct secondary commands (no approval needed)
    else if (['holiday','leave','absent','vto'].includes(action) && isInternal(user.role)) {
      reply = await applyDayOverride(uid, name, action, name);
    }
    // Offset/OT — leaders don't use these (their hours auto-count), non-leaders need approval
    else if (action === 'offset-in') {
      if (isInternal(user.role)) return res.status(400).json({ error: 'Leaders don\'t use offset. All hours auto-count toward your cutoff.' });
      const approved = await getApprovals(a => a.uid === uid && a.status === 'approved' && a.type === 'offset-in');
      if (approved.length === 0) return res.status(403).json({ error: 'Offset not approved. Please submit a request first.' });
      reply = await handleOffsetIn(uid, name);
    }
    else if (action === 'offset-out') reply = await handleOffsetOut(uid, name);
    else if (action === 'ot-in') {
      if (isInternal(user.role)) return res.status(400).json({ error: 'Leaders don\'t use OT commands. All hours auto-count toward your cutoff.' });
      const approved = await getApprovals(a => a.uid === uid && a.status === 'approved' && a.type === 'ot-in');
      if (approved.length === 0) return res.status(403).json({ error: 'OT not approved. Please submit a request first.' });
      reply = await handleOTIn(uid, name);
    }
    else if (action === 'ot-out') reply = await handleOTOut(uid, name);
    // Check early-out status (Mini App calls this to decide whether to show confirmation)
    else if (action === 'check-early-out') {
      const state = await getState(uid);
      if (state.shiftEnd && !isInternal(user.role)) {
        const shiftEnd = new Date(state.shiftEnd);
        if (new Date() < shiftEnd) {
          return res.json({ earlyOut: true, shiftEnd: fmtTime(shiftEnd), message: `Your shift ends at ${fmtTime(shiftEnd)}. Are you sure you want to log out early?` });
        }
      }
      return res.json({ earlyOut: false });
    }
    // Emergency alert
    else if (action === 'emergency') {
      await notifyManagement(`🚨 <b>EMERGENCY ALERT</b>\n${name} needs immediate assistance!\nTime: ${fmtTime(new Date())}`);
      await sendGroupConfirmation(`🚨 <b>EMERGENCY</b> — ${name} needs immediate assistance!`);
      return res.json({ ok: true, message: '🚨 Emergency alert sent to all leaders!' });
    }
    else return res.status(400).json({ error: 'Unknown action' });

    // Send confirmation to group topic
    if (reply) {
      const clean = reply.replace(/<[^>]+>/g, '');
      await sendGroupConfirmation(`${reply}\n<i>(via Mini App)</i>`);
      res.json({ ok: true, message: clean });
    } else {
      res.json({ ok: true, message: 'Action processed.' });
    }
  } catch(e) { console.error('/action error:', e.message); res.status(500).json({ error: e.message }); }
});

// Submit approval request from Mini App
app.post('/request', async (req, res) => {
  try {
    const { uid, type, notes } = req.body;
    const user = await getUserById(uid);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const validTypes = ['absent', 'leave', 'holiday', 'vto', 'offset-in', 'ot-in'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid request type' });

    const approval = await createApproval(uid, user.name, type, notes);

    // Notify leaders via DM
    await notifyManagement(`📋 <b>New Request</b>\n${user.name} → ${type}\nNotes: ${notes || 'none'}\n\nReview in Admin Panel → Approvals tab.`);

    res.json({ ok: true, approval });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Client API
app.get('/client/:clientId/vas', async (req, res) => {
  try {
    const clients = await getClients();
    const client = clients.find(c => c.telegramId === req.params.clientId || c.id === req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const roster = await getRoster();
    const windowDate = getWindowDate();
    const assignedVAs = (client.assignedVAs || []).map(va => {
      const vaId = typeof va === 'object' ? va.id : va;
      return roster.find(u => u.id === vaId) ? vaId : null;
    }).filter(Boolean);

    const vaData = [];
    for (const vaId of assignedVAs) {
      const user = roster.find(u => u.id === vaId);
      if (!user) continue;
      const state = await getState(vaId);
      const wr = await getWindow(vaId, windowDate);
      const schedInfo = getScheduleForWindow(user, windowDate);
      const now = new Date();
      // Full status calculation (no cutoff info exposed to clients)
      let status = 'offline', label = 'Offline';
      const dayOverrides = ['holiday', 'absent', 'leave', 'vto'];
      if (dayOverrides.includes(state.status)) {
        status = state.status;
        const lm = { holiday: 'Holiday', absent: 'Absent', leave: 'On Leave', vto: 'VTO' };
        label = lm[state.status] || state.status;
      } else if (state.status === 'offset') { status = 'offset'; label = 'Offset'; }
      else if (state.status === 'ot') { status = 'ot'; label = 'OT'; }
      else if (state.status === 'bbl') {
        const elapsed = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
        status = elapsed > BBL_MINS() ? 'overlunch' : 'bbl'; label = elapsed > BBL_MINS() ? 'Over Lunch' : 'Break + Lunch';
      } else if (state.status === 'break') {
        const elapsed = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
        status = elapsed > BREAK_MINS() ? 'overbreak' : 'break'; label = elapsed > BREAK_MINS() ? 'Over Break' : 'Break';
      } else if (state.status === 'lunch') {
        const elapsed = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
        status = elapsed > LUNCH_MINS() ? 'overlunch' : 'lunch'; label = elapsed > LUNCH_MINS() ? 'Over Lunch' : 'Lunch';
      } else if (state.status === 'bio') {
        const elapsed = state.breakStart ? minsBetween(new Date(state.breakStart), now) : 0;
        status = elapsed > BIO_WARN_MINS() ? 'excessive-bio' : 'bio'; label = elapsed > BIO_WARN_MINS() ? 'Bio (Long)' : 'Bio Break';
      } else if (state.status === 'in') { status = 'active'; label = 'Active'; }
      else if (state.status === 'pre-shift') {
        if (state.shiftStart && now >= new Date(state.shiftStart)) { status = 'active'; label = 'Active'; }
        else { status = 'pre-shift'; label = 'Pre-Shift'; }
      } else if (state.status === 'out') {
        if (wr && wr.status === 'completed') { status = 'done'; label = 'Done'; }
        else if (schedInfo && now >= schedInfo.win.start && now <= schedInfo.win.end) { status = 'missing'; label = 'Missing'; }
        else if (!schedInfo) { status = 'dayoff'; label = 'Day Off'; }
      }

      const co = await getCutoff(vaId);
      vaData.push({ id: user.id, name: user.name, status, statusLabel: label, productiveHours: Math.round((wr?.totalHours||0)*100)/100, loginTime: state.loginTime||null, cutoffHours: co.hours||0 });
    }

    res.json({ client: { id: client.id, telegramId: client.telegramId, firstName: client.firstName || '', lastName: client.lastName || '', name: client.firstName ? `${client.firstName} ${client.lastName}` : client.name, position: client.position || '', businessName: client.businessName, logo: client.logo || null, photo: client.photo || null, timezone: client.timezone || 'Asia/Manila', features: client.features || { ghl: false, ghostLine: false }, assignedVAs: client.assignedVAs || [] }, vas: vaData });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// §27 TASK SYSTEM — Postgres primary, Redis fallback
// ============================================================

// H4 fix: task index now reads from Postgres directly — Redis index removed
// getTaskIndex() kept for backward compat but reads from PG
async function getTaskIndex() {
  try {
    const rows = await pgQuery('SELECT id FROM tasks ORDER BY created_at DESC');
    return rows.map(r => r.id);
  } catch(e) {
    console.error('[PG] getTaskIndex:', e.message);
    return JSON.parse(await rGet('task:index')||'[]'); // fallback
  }
}
// saveTaskIndex is now a no-op — Postgres is the source of truth for task listing
async function saveTaskIndex(idx) { /* no-op: Postgres is now the task index */ }

async function getTask(id) {
  try {
    const task = await pgOne('SELECT * FROM tasks WHERE id=$1', [id]);
    if (task) {
      const assignments = await pgQuery('SELECT va_id FROM task_assignments WHERE task_id=$1', [id]);
      const notes = await pgQuery('SELECT * FROM task_notes WHERE task_id=$1 ORDER BY created_at', [id]);
      return {
        ...task,
        assignedTo: assignments.map(r => r.va_id),
        notes: notes.map(n => ({ author: n.author, authorType: n.author_type, text: n.text, time: n.created_at })),
        clientId: task.client_id, clientName: task.client_name,
        deadlineRaw: task.deadline_raw, deadlineTz: task.deadline_tz,
        createdAt: task.created_at, updatedAt: task.updated_at,
      };
    }
  } catch(e) { console.error('[PG] getTask:', e.message); }
  const raw = await rGet(`task:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveTask(t) {
  await rSet(`task:${t.id}`, JSON.stringify(t)).catch(()=>{});
  try {
    await pgQuery(
      `INSERT INTO tasks (id,client_id,client_name,title,description,priority,status,deadline,deadline_raw,deadline_tz,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         title=$4,description=$5,priority=$6,status=$7,deadline=$8,deadline_raw=$9,deadline_tz=$10,updated_at=now()`,
      [t.id, t.clientId, t.clientName, t.title, t.description||'',
       t.priority||'medium', t.status||'new',
       t.deadline ? new Date(t.deadline) : null,
       t.deadlineRaw||null, t.deadlineTz||'Asia/Manila',
       new Date(t.createdAt||Date.now()), new Date(t.updatedAt||Date.now())]
    );
    await pgQuery('DELETE FROM task_assignments WHERE task_id=$1', [t.id]);
    for (const vaId of (t.assignedTo||[])) {
      await pgQuery('INSERT INTO task_assignments (task_id,va_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [t.id, vaId]).catch(()=>{});
    }
    for (const note of (t.notes||[])) {
      await pgQuery(
        `INSERT INTO task_notes (task_id,author,author_type,text,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [t.id, note.author||'unknown', note.authorType||'system', note.text, new Date(note.time||Date.now())]
      ).catch(()=>{});
    }
  } catch(e) { console.error('[PG] saveTask:', e.message); }
}

// Create task
app.post('/task', async (req, res) => {
  try {
    const { clientId, assignedTo, title, description, priority, deadline, clientTimezone } = req.body;
    if (!clientId || !title || !assignedTo?.length) return res.status(400).json({ error: 'Missing required fields' });
    const clients = await getClients();
    const client = clients.find(c => c.telegramId === clientId || c.id === clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const clientName = client.firstName ? `${client.firstName} ${client.lastName}` : client.name || 'Client';
    const tz = clientTimezone || client.timezone || 'Asia/Manila';

    // Normalize deadline: client picked "2026-05-30" in their timezone — interpret as EOD in that timezone
    let normalizedDeadline = null;
    if (deadline) {
      try {
        // "2026-05-30" → EOD that day in client TZ → ISO string
        const eod = new Date(`${deadline}T23:59:59`);
        // Adjust for the difference between local interpretation and intended timezone
        const intendedInTz = new Date(eod.toLocaleString('en-US', { timeZone: tz }));
        const intendedLocal = new Date(eod.toLocaleString('en-US'));
        const diff = intendedInTz - intendedLocal;
        const adjusted = new Date(eod.getTime() - diff);
        normalizedDeadline = adjusted.toISOString();
      } catch(e) {
        normalizedDeadline = deadline; // Fallback to raw string
      }
    }

    const id = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const task = {
      id, clientId: client.telegramId || client.id, clientName,
      assignedTo: Array.isArray(assignedTo) ? assignedTo : [assignedTo],
      title, description: description || '', priority: priority || 'medium',
      deadline: normalizedDeadline, deadlineRaw: deadline || null, deadlineTz: tz,
      status: 'new',
      notes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await saveTask(task);
    const idx = await getTaskIndex();
    idx.push(id);
    await saveTaskIndex(idx);

    // Notify assigned VAs via DM
    const roster = await getRoster();
    for (const vaId of task.assignedTo) {
      const va = roster.find(u => u.id === vaId);
      if (va) {
        const pIcon = { high: '🔴', medium: '🟡', low: '🟢' }[task.priority] || '⚪';
        await sendDM(vaId, `📋 <b>New Task from ${clientName}</b>\n${pIcon} ${task.priority.toUpperCase()}\n\n<b>${task.title}</b>\n${task.description || 'No description'}\n${task.deadline ? `📅 Due: ${task.deadline}` : ''}`).catch(e => console.error(`Task DM fail ${vaId}:`, e.message));
      }
    }

    await logEdit(clientId, 'Client', 'task-create', task.id, null, { title: task.title, assignedTo: task.assignedTo, priority: task.priority });
    res.json({ ok: true, task });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get tasks for client
app.get('/tasks/client/:clientId', async (req, res) => {
  try {
    const cid = req.params.clientId;
    // H4 fix: query Postgres directly, no Redis index dependency
    const rows = await pgQuery(
      `SELECT t.id FROM tasks t WHERE t.client_id=$1 ORDER BY t.created_at DESC`,
      [cid]
    );
    const tasks = [];
    for (const row of rows) {
      const t = await getTask(row.id);
      if (t) tasks.push(t);
    }
    res.json(tasks);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get tasks for VA
app.get('/tasks/va/:vaId', async (req, res) => {
  try {
    const vid = req.params.vaId;
    // H4 fix: query Postgres directly via task_assignments join
    const rows = await pgQuery(
      `SELECT t.id FROM tasks t
       JOIN task_assignments ta ON ta.task_id = t.id
       WHERE ta.va_id=$1 AND t.status != 'cancelled'
       ORDER BY t.created_at DESC`,
      [vid]
    );
    const tasks = [];
    for (const row of rows) {
      const t = await getTask(row.id);
      if (t) tasks.push(t);
    }
    res.json(tasks);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get single task
app.get('/task/:id', async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update task (status, notes, edit)
app.put('/task/:id', async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const { status, note, authorName, authorType, title, description, priority, deadline, assignedTo } = req.body;

    if (status) { task.status = status; }
    if (note && authorName) {
      task.notes.push({ author: authorName, authorType: authorType || 'va', text: note, time: new Date().toISOString() });
    }
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (priority) task.priority = priority;
    if (deadline !== undefined) task.deadline = deadline;
    if (assignedTo) task.assignedTo = Array.isArray(assignedTo) ? assignedTo : [assignedTo];
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    // Notify client via DM on urgent task completion
    if (status === 'done' && task.priority === 'high') {
      const clients = await getClients();
      const client = clients.find(c => c.telegramId === task.clientId || c.id === task.clientId);
      if (client?.telegramId) {
        const roster = await getRoster();
        const vaName = roster.find(u => task.assignedTo.includes(u.id))?.name || 'Your VA';
        await sendDM(client.telegramId, `✅ <b>Task Completed</b>\n${vaName} completed: <b>${task.title}</b>`).catch(e => console.error('Client task DM fail:', e.message));
      }
    }

    if (status || note || title || description || priority || deadline || assignedTo) {
      await logEdit(req.body.authorName || 'system', req.body.authorType === 'client' ? 'Client' : 'VA', 'task-update', task.id, null, { status, hasNote: !!note, changedFields: Object.keys(req.body).filter(k => k !== 'authorName' && k !== 'authorType') });
    }

    res.json({ ok: true, task });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete/cancel task
app.delete('/task/:id', async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    task.status = 'cancelled';
    task.updatedAt = new Date().toISOString();
    await saveTask(task);
    await logEdit('client', 'Client', 'task-cancel', task.id, { title: task.title, status: 'active' }, { status: 'cancelled' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear completed tasks for client
app.post('/tasks/clear-completed', async (req, res) => {
  try {
    const { clientId } = req.body;
    // H4 fix: delete from Postgres directly, also clean up Redis cache keys
    const rows = await pgQuery(
      `SELECT id FROM tasks WHERE client_id=$1 AND status IN ('done','cancelled')`,
      [clientId]
    );
    let removed = 0;
    for (const row of rows) {
      await pgQuery('DELETE FROM task_notes WHERE task_id=$1', [row.id]).catch(()=>{});
      await pgQuery('DELETE FROM task_assignments WHERE task_id=$1', [row.id]).catch(()=>{});
      await pgQuery('DELETE FROM tasks WHERE id=$1', [row.id]).catch(()=>{});
      await rDel(`task:${row.id}`);
      removed++;
    }
    res.json({ ok: true, removed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// §28 DAY PLANNER — 30-min color-coded blocks (Redis-only — TODO: migrate)
// ============================================================

app.post('/dayplan', async (req, res) => {
  try {
    const { clientId, vaId, date, blocks } = req.body;
    if (!clientId || !vaId || !date) return res.status(400).json({ error: 'Missing fields' });
    await rSet(`dayplan:${clientId}:${vaId}:${date}`, JSON.stringify({ blocks: blocks || [], updatedAt: new Date().toISOString() }), { EX: 30 * 86400 });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/dayplan/:clientId/:vaId/:date', async (req, res) => {
  try {
    const raw = await rGet(`dayplan:${req.params.clientId}:${req.params.vaId}:${req.params.date}`);
    res.json(raw ? JSON.parse(raw) : { blocks: [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// §29 CLIENT SCHEDULE PLOTTING
// ============================================================

app.post('/client/schedule', async (req, res) => {
  try {
    const { clientId, vaId, day, start, end, clientTimezone } = req.body;
    if (!vaId || !day) return res.status(400).json({ error: 'Missing fields' });
    const roster = await getRoster();
    const user = roster.find(u => u.id === vaId);
    if (!user) return res.status(404).json({ error: 'VA not found' });

    // Convert client timezone to Manila if provided
    let manilaStart = start, manilaEnd = end;
    if (clientTimezone && clientTimezone !== 'Asia/Manila' && start && end) {
      const convertToManila = (timeStr, tz) => {
        const [h, m] = timeStr.split(':').map(Number);
        const ref = new Date(); ref.setHours(h, m, 0, 0);
        const inTz = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
        const inManila = new Date(ref.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
        const diff = inManila - inTz;
        const converted = new Date(ref.getTime() + diff);
        return `${String(converted.getHours()).padStart(2, '0')}:${String(converted.getMinutes()).padStart(2, '0')}`;
      };
      manilaStart = convertToManila(start, clientTimezone);
      manilaEnd = convertToManila(end, clientTimezone);
    }

    // Convert "20:00" → "8:00 PM" for canonical user.schedules format
    const to12h = (t24) => {
      if (!t24) return null;
      const [h, m] = t24.split(':').map(Number);
      const period = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}:${String(m).padStart(2,'0')} ${period}`;
    };
    const startStr = to12h(manilaStart);
    const endStr = to12h(manilaEnd);

    // Day name → day index (Mon=0, Sun=6)
    const dayIdx = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(day);
    if (dayIdx < 0) return res.status(400).json({ error: 'Invalid day name' });

    // Write to user.schedules (the field bot actually reads)
    if (!user.schedules) user.schedules = [];

    // Remove this day from every existing schedule block (split if needed)
    user.schedules = user.schedules.map(sched => {
      const newDays = [...(sched.days || [0,0,0,0,0,0,0])];
      if (newDays[dayIdx]) newDays[dayIdx] = 0;
      return { ...sched, days: newDays };
    }).filter(sched => sched.days.some(d => d === 1));

    // Add new schedule block for this day if start/end provided (else day stays Off)
    if (startStr && endStr) {
      const newDays = [0,0,0,0,0,0,0];
      newDays[dayIdx] = 1;
      user.schedules.push({ days: newDays, start: startStr, end: endStr, clientSet: true });
    }

    await saveRoster(roster);
    await logEdit(clientId, 'Client', 'schedule-update', user.name, null, { day, start, end, clientTimezone, manilaStart, manilaEnd });

    // Notify VA and leaders
    const clients = await getClients();
    const client = clients.find(c => c.telegramId === clientId || c.id === clientId);
    const clientName = client?.firstName ? `${client.firstName} ${client.lastName}` : client?.name || 'Client';
    await sendDM(vaId, `📅 <b>Schedule Update from ${clientName}</b>\n${day}: ${start || 'Off'} – ${end || 'Off'} (${clientTimezone || 'Manila'})\nManila time: ${startStr || 'Off'} – ${endStr || 'Off'}`).catch(e => {});
    await notifyManagement(`📅 <b>Client Schedule Change</b>\n${clientName} updated ${user.name}'s ${day} schedule\n${startStr || 'Off'} – ${endStr || 'Off'} Manila`);

    res.json({ ok: true, manilaStart: startStr, manilaEnd: endStr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// §30 CLIENT FEEDBACK — Postgres primary (feedback table)
// ============================================================

app.post('/client/feedback', async (req, res) => {
  try {
    const { clientId, type, message } = req.body;
    if (!clientId || !message) return res.status(400).json({ error: 'Missing fields' });
    const clients = await getClients();
    const client = clients.find(c => c.telegramId === clientId || c.id === clientId);
    const clientName = client?.firstName ? `${client.firstName} ${client.lastName||''}`.trim() : client?.name || 'Client';
    const biz = client?.businessName || '';
    const icons = { feedback: '💬', support: '🆘', suggestion: '💡' };
    const icon = icons[type] || '📩';

    const fbId = `fb_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

    // Persist to Postgres (primary)
    await pgQuery(
      `INSERT INTO feedback (id, client_id, client_name, business_name, type, message, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'new')`,
      [fbId, clientId, clientName, biz, type || 'feedback', message]
    );

    await notifyManagement(`${icon} <b>Client ${type?.charAt(0).toUpperCase() + type?.slice(1) || 'Message'}</b>\nFrom: ${clientName}${biz ? ` (${biz})` : ''}\n\n${message}\n\n<i>Logged to feedback inbox.</i>`);
    await logEdit(clientId, 'Client', `feedback-${type}`, clientName, null, { fbId, hasMessage: true });

    res.json({ ok: true, fbId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: read feedback inbox
app.get('/admin/feedback', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const rows = await pgQuery(
      `SELECT id, client_id as "clientId", client_name as "clientName",
              business_name as "businessName", type, message, status,
              resolved_at as "resolvedAt", created_at as "createdAt"
       FROM feedback
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json({ items: rows, total: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: mark feedback as resolved/read
app.put('/admin/feedback/:id', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const { id } = req.params;
    const { status } = req.body;
    await pgQuery(
      `UPDATE feedback SET status=$1, resolved_at=now() WHERE id=$2`,
      [status || 'read', id]
    );
    res.json({ ok: true, updated: 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// §31 FINANCIALS SUMMARY API
// ============================================================

app.get('/admin/financials-summary', async (req, res) => {
  try {
    const roster = await getRoster();
    const clients = await getClients();
    // Calculate income from clients
    let totalIncome = 0;
    const clientSummary = [];
    for (const client of clients) {
      const vaRates = (client.assignedVAs || []);
      let clientTotal = 0;
      const vas = [];
      for (const va of vaRates) {
        const vaId = typeof va === 'object' ? va.id : va;
        const vaRate = typeof va === 'object' ? (va.rate || 0) : 0;
        clientTotal += vaRate;
        const rUser = roster.find(u => u.id === vaId);
        vas.push({ id: vaId, name: rUser?.name || vaId, rate: vaRate });
      }
      const ghlRate = client.ghlSubscription ? (client.ghlRate || 0) : 0;
      clientTotal += ghlRate;
      const affiliateRate = client.affiliateRate || 0;
      totalIncome += clientTotal;
      clientSummary.push({
        id: client.id || client.telegramId,
        name: client.firstName ? `${client.firstName} ${client.lastName}` : client.name,
        businessName: client.businessName,
        vas, ghlRate, affiliateRate,
        totalRate: clientTotal,
        billingFrequency: client.billingFrequency || 'monthly',
      });
    }

    // Calculate payroll from roster using staff_rates from Postgres
    let totalPayroll = 0;
    const staffSummary = [];
    const fin = await getFinancials();
    for (const user of roster) {
      if (!hasCutoff(user.role)) continue; // skip Owner/Director
      const co = await getCutoff(user.id);
      const rates = fin.rates[user.id] || { rate: 0, otRate: 0 };
      const regularPay = co.hours * (rates.rate || 0);
      const otPay      = co.ot   * (rates.otRate || 0);
      const totalPay   = regularPay + otPay;
      totalPayroll += totalPay;
      staffSummary.push({
        id: user.id, name: user.name, role: user.role,
        cutoffHours: co.hours, cutoffOT: co.ot,
        rate: rates.rate || 0, otRate: rates.otRate || 0,
        regularPay: Math.round(regularPay * 100) / 100,
        otPay:      Math.round(otPay      * 100) / 100,
        totalPay:   Math.round(totalPay   * 100) / 100,
        currency:   fin.currency || 'USD',
      });
    }
    totalPayroll = Math.round(totalPayroll * 100) / 100;

    res.json({ totalIncome, totalPayroll, clientSummary, staffSummary, currency: fin.currency || 'USD' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// §32 SCHEDULED JOBS — daily reset, cutoff finalization, cutoff reset, reports
// ============================================================

function getManilaHHMM() {
  const manila = manilaTime();
  return { h: manila.getHours(), m: manila.getMinutes(), dateStr: manilaDateStr(manila) };
}

// Graceful auto-logout for resets
async function gracefulAutoLogout(user, state, now, reason) {
  try {
    // Auto-close open breaks
    if (state.breakStart && state.breakType) {
      const breakMins = minsBetween(new Date(state.breakStart), now);
      if (reason === 'cutoff-finalization') {
        // 2AM: assume clean return, no overbreak
      } else {
        if (state.breakType === 'break') {
          const d = graceDeduction(breakMins, BREAK_MINS());
          if (d > 0) state.overbreakMs = (state.overbreakMs || 0) + d * 60000;
        } else if (state.breakType === 'lunch') {
          const d = graceDeduction(breakMins, LUNCH_MINS());
          if (d > 0) state.overlunchMs = (state.overlunchMs || 0) + d * 60000;
          state.lunchDuration = Math.min(breakMins, LUNCH_MINS());
          state.lunchUsed = true;
        } else if (state.breakType === 'bbl') {
          const d = graceDeduction(breakMins, BBL_MINS());
          if (d > 0) state.overlunchMs = (state.overlunchMs || 0) + d * 60000;
          state.lunchDuration = Math.min(Math.max(0, breakMins - BREAK_MINS()), LUNCH_MINS());
          state.lunchUsed = true; state.bblUsed = true;
        }
      }
      state.breakStart = null; state.breakType = null;
    }

    if (!state.loginTime) return;

    const result = calcPayable(user, state, now);
    if (result.hours > 0) await addCutoffHours(user.id, user.role, result.hours, result.ot);

    // Update window record
    const wd = state.windowDate || getWindowDate();
    const wr = await getWindow(user.id, wd) || newWindowRecord(user.id, user.name, user.role, wd);
    wr.sessions.push({ in: state.loginTime, out: now.toISOString(), hours: result.hours });
    wr.totalHours = Math.round((wr.totalHours + result.hours) * 100) / 100;
    wr.status = 'completed';
    wr.events.push({ action: 'auto-out', time: now.toISOString(), detail: reason });
    await setWindow(user.id, wd, wr);

    await sendGroupConfirmation(`🔄 <b>Auto Log Out — ${user.name}</b>\n${reason}. Hours: <b>${result.hours.toFixed(2)}h</b>.`);
    sheetAppend('Telegram Logs', [[fmtDate(now), fmtTime(now), 'auto-out', user.name, user.id, reason]]).catch(console.error);
  } catch(e) { console.error('gracefulAutoLogout:', user.name, e.message); }
}

// Archive snapshot to Postgres + Sheets
async function archiveSnapshot(windowDate) {
  try {
    const data = await getDashboardData();

    // Write to Postgres daily_snapshots table
    for (const u of data.users) {
      await pgQuery(
        `INSERT INTO daily_snapshots
           (window_date, user_id, user_name, user_role, status, status_label,
            shift_start, shift_end, hours, cutoff_hours, cutoff_ot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, window_date) DO UPDATE SET
           status=$5, status_label=$6, shift_start=$7, shift_end=$8,
           hours=$9, cutoff_hours=$10, cutoff_ot=$11`,
        [
          windowDate, u.id, u.name, u.role,
          u.status, u.statusLabel,
          u.shiftStart || null, u.shiftEnd || null,
          parseFloat(u.productiveHours) || 0,
          parseFloat(u.cutoffHours) || 0,
          parseFloat(u.cutoffOT) || 0,
        ]
      ).catch(e => console.error('[PG] daily_snapshots insert:', u.name, e.message));
    }

    // Also append to Sheets (keep as backup)
    const sheetRows = data.users.map(u => [
      windowDate, u.name, u.role, u.statusLabel,
      u.shiftStart, u.shiftEnd,
      u.productiveHours, u.cutoffHours, u.cutoffOT,
    ]);
    if (sheetRows.length) await sheetAppend('Daily Snapshots', sheetRows);
    console.log(`[Archive] Snapshot for ${windowDate} → ${data.users.length} rows (PG + Sheets)`);
  } catch(e) { console.error('archiveSnapshot:', e.message); }
}

// 6PM Daily Reset
async function runDailyReset() {
  console.log('[Scheduler] Running 6PM daily reset');
  try {
    const now = new Date();
    const windowDate = getWindowDate(manilaTime());
    const roster = await getRoster();

    // 1. Archive snapshot
    await archiveSnapshot(windowDate);

    // 2. Drop pending Telegram messages
    try {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`, { drop_pending_updates: true });
      await new Promise(r => setTimeout(r, 1000));
      await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, { url: `${WEBHOOK_URL}/webhook` });
    } catch(e) { console.error('Webhook reset:', e.message); }

    // 3. Graceful auto-logout
    const keys = await rKeys('state:*');
    for (const key of keys) {
      const uid = key.replace('state:', '');
      const user = roster.find(u => u.id === uid);
      const state = await getState(uid);
      if (user && state.status !== 'out') {
        await gracefulAutoLogout(user, state, now, 'daily reset (6PM)');
      }
      await rDel(key);
    }

    console.log(`[Scheduler] Daily reset complete: ${keys.length} states cleared`);
  } catch(e) { console.error('Daily reset error:', e.message); }
}

// 2AM Cutoff Finalization
async function runCutoffFinalization() {
  console.log('[Scheduler] Running 2AM cutoff finalization');
  try {
    const now = new Date();
    const roster = await getRoster();
    const windowDate = getWindowDate(manilaTime());

    const keys = await rKeys('state:*');
    for (const key of keys) {
      const uid = key.replace('state:', '');
      const user = roster.find(u => u.id === uid);
      if (!user || !isLastCutoffDay(user.role)) continue;

      const state = await getState(uid);

      // Missing → 0h, set to offline
      if (state.status === 'out') {
        const wr = await getWindow(uid, windowDate);
        if (!wr || wr.status === 'pending') {
          // No activity today → 0h
          const finalWr = wr || newWindowRecord(uid, user.name, user.role, windowDate);
          finalWr.status = 'finalized';
          finalWr.totalHours = 0;
          finalWr.events.push({ action: 'finalized', time: now.toISOString(), detail: 'missing-0h' });
          await setWindow(uid, windowDate, finalWr);
        }
        continue;
      }

      // Active users mid-break → close breaks cleanly (no overbreak)
      if (['break', 'lunch', 'bbl', 'bio'].includes(state.status)) {
        state.breakStart = null;
        state.breakType = null;
        if (state.status === 'lunch' || state.status === 'bbl') {
          state.lunchUsed = true;
          state.lunchDuration = state.status === 'bbl' ? LUNCH_MINS() : LUNCH_MINS();
          if (state.status === 'bbl') { state.breakUsed = true; state.bblUsed = true; }
        }
        if (state.status === 'break') state.breakUsed = true;
        state.status = 'in';
        await setState(uid, state);
      }

      // Lunch skip offset disabled after 2AM → flag it
      const wr = await getWindow(uid, windowDate);
      if (wr) {
        wr.events.push({ action: 'cutoff-finalized', time: now.toISOString(), detail: 'lunch-skip-offset-disabled' });
        await setWindow(uid, windowDate, wr);
      }
    }

    // Finalize window records for missing users (no state key)
    for (const user of roster) {
      if (!isLastCutoffDay(user.role)) continue;
      const wr = await getWindow(user.id, windowDate);
      if (!wr && getScheduleForWindow(user, windowDate)) {
        // Had a schedule, never logged in → 0h
        const finalWr = newWindowRecord(user.id, user.name, user.role, windowDate);
        finalWr.status = 'finalized';
        finalWr.events.push({ action: 'finalized', time: now.toISOString(), detail: 'missing-0h' });
        await setWindow(user.id, windowDate, finalWr);
      }
    }

    console.log('[Scheduler] 2AM cutoff finalization complete');
  } catch(e) { console.error('Cutoff finalization error:', e.message); }
}

// 9AM Cutoff Reset
async function runCutoffReset() {
  console.log('[Scheduler] Running 9AM cutoff reset');
  try {
    const now = new Date();
    const roster = await getRoster();

    // Drop pending
    try {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`, { drop_pending_updates: true });
      await new Promise(r => setTimeout(r, 1000));
      await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, { url: `${WEBHOOK_URL}/webhook` });
    } catch(e) {}

    // Auto-logout active users
    const keys = await rKeys('state:*');
    for (const key of keys) {
      const uid = key.replace('state:', '');
      const user = roster.find(u => u.id === uid);
      const state = await getState(uid);
      if (user && state.status !== 'out' && isLastCutoffDay(user.role)) {
        await gracefulAutoLogout(user, state, now, 'cutoff reset (9AM)');
        await rDel(key);
      }
    }

    // Archive KPI summary to Sheets
    const kpiRows = [];
    for (const user of roster) {
      if (!isLastCutoffDay(user.role)) continue;
      if (!hasCutoff(user.role)) continue; // M2: skip Owner/Director
      const co = await getCutoff(user.id);
      const dates = getCutoffDates(user.role);
      // Target pulled from role_config.cutoff_cap_hrs.
      // UYP has null cap, but uses expected-hours (dynamic per period) as target instead.
      let target;
      if (user.role === 'UYP') {
        target = await getExpectedHours(user); // dynamic: scheduled shifts × 8h
      } else {
        target = getCutoffCap(user.role); // Internal=90, VA/Admin=80
      }
      const adherence = target > 0 ? ((co.hours / target) * 100).toFixed(1) + '%' : 'N/A';
      kpiRows.push([
        fmtDate(dates.start) + ' - ' + fmtDate(dates.end),
        user.name, user.role, co.hours, co.ot, target || 'dynamic',
        adherence,
      ]);
    }
    if (kpiRows.length) await sheetAppend('KPI Archive', kpiRows);

    // Also write KPI archive to Postgres
    for (const user of roster) {
      if (!isLastCutoffDay(user.role)) continue;
      if (!hasCutoff(user.role)) continue;
      const co = await getCutoff(user.id);
      const dates = getCutoffDates(user.role);
      let tgt;
      if (user.role === 'UYP') { tgt = await getExpectedHours(user); }
      else { tgt = getCutoffCap(user.role); }
      const pct = tgt > 0 ? Math.round((co.hours / tgt) * 10000) / 100 : null;
      await pgQuery(
        `INSERT INTO kpi_archive
           (user_id, user_name, user_role, period_start, period_end,
            hours_logged, ot_hours, target_hours, adherence_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          user.id, user.name, user.role,
          fmtDate(dates.start), fmtDate(dates.end),
          co.hours, co.ot, tgt || null, pct,
        ]
      ).catch(e => console.error('[PG] kpi_archive insert:', user.name, e.message));
    }

    // Reset cutoff hours and clear window records (so double-shift prevention allows re-login)
    const windowDate = getWindowDate(manilaTime());
    for (const user of roster) {
      if (!isLastCutoffDay(user.role)) continue;
      await setCutoff(user.id, { hours: 0, ot: 0 });
      // C3 fix: clear BOTH Redis and Postgres shift window record
      // Without clearing Postgres, getWindow() returns the old record and VAs hit double-shift block
      await rDel(`shiftwindow:${user.id}:${windowDate}`);
      await pgQuery(
        `DELETE FROM shift_sessions WHERE user_id=$1 AND window_date=$2`,
        [String(user.id), windowDate]
      ).catch(e => console.error(`[PG] shift_sessions clear fail ${user.name}:`, e.message));
      console.log(`[Scheduler] Reset cutoff + window: ${user.name}`);
    }

    console.log('[Scheduler] 9AM cutoff reset complete');
  } catch(e) { console.error('Cutoff reset error:', e.message); }
}

// 2PM Cutoff Report
async function runCutoffReport() {
  console.log('[Scheduler] Running 2PM cutoff report');
  try {
    const roster = await getRoster();
    // Group by cutoff type so the report has context
    const groups = {};
    for (const user of roster) {
      if (!isLastCutoffDay(user.role)) continue;
      if (!hasCutoff(user.role)) continue; // Owner/Director skipped
      const co = await getCutoff(user.id);
      const coType = user.role === 'UYP' ? 'UYP' : (isInternal(user.role) ? 'Internal' : 'VA/Admin');
      if (!groups[coType]) {
        const dates = getCutoffDates(user.role);
        groups[coType] = { start: fmtDate(dates.start), end: fmtDate(dates.end), lines: [] };
      }
      groups[coType].lines.push(`${user.name} — ${co.hours.toFixed(2)}h${co.ot > 0 ? ` (+${co.ot.toFixed(2)}h OT)` : ''}`);
    }

    for (const [type, group] of Object.entries(groups)) {
      if (!group.lines.length) continue;
      const report = `📊 <b>Cut-Off Hours Report</b>\n${group.start} to ${group.end}\n\n${group.lines.join('\n')}\n\n⚠️ Please double-check the hours for any discrepancies or errors.`;
      await notifyManagement(report);
    }

    console.log('[Scheduler] 2PM cutoff report sent to leaders');
  } catch(e) { console.error('Cutoff report error:', e.message); }
}

// Scheduler state persistence
let lastDailyReset = '', lastFinalize = '', lastCutoffReset = '', lastCutoffReport = '';

async function loadSchedulerState() {
  try {
    const raw = await rGet('scheduler:last_resets');
    if (raw) {
      const d = JSON.parse(raw);
      lastDailyReset = d.daily || '';
      lastFinalize = d.finalize || '';
      lastCutoffReset = d.cutoff || '';
      lastCutoffReport = d.report || '';
    }
  } catch(e) {}
}

async function saveSchedulerState() {
  await rSet('scheduler:last_resets', JSON.stringify({
    daily: lastDailyReset, finalize: lastFinalize, cutoff: lastCutoffReset, report: lastCutoffReport,
  }));
}

// Scheduler tick — every 60 seconds
setInterval(async () => {
  try {
    const { h, m, dateStr } = getManilaHHMM();
    const roster = await getRoster();

    // 6PM Daily Reset — runs EVERY day (tolerance: 18:00 to 18:04)
    if (h === DAILY_RESET_HR() && m < 5 && lastDailyReset !== dateStr) {
      const locked = await rSetNX(`lock:daily:${dateStr}`, '1', 120);
      if (!locked) { lastDailyReset = dateStr; return; }
      lastDailyReset = dateStr;
      await saveSchedulerState();
      await runDailyReset();
    }

    // 2AM Cutoff Finalization (cutoff day only — tolerance: 02:00 to 02:04)
    if (h === FINALIZE_HR() && m < 5 && lastFinalize !== dateStr) {
      if (roster.some(u => isLastCutoffDay(u.role))) {
        const locked = await rSetNX(`lock:finalize:${dateStr}`, '1', 120);
        if (!locked) { lastFinalize = dateStr; return; }
        lastFinalize = dateStr;
        await saveSchedulerState();
        await runCutoffFinalization();
      }
    }

    // 9AM Cutoff Reset (cutoff day only — tolerance: 09:00 to 09:04)
    if (h === CUTOFF_RESET_HR() && m < 5 && lastCutoffReset !== dateStr) {
      if (roster.some(u => isLastCutoffDay(u.role))) {
        const locked = await rSetNX(`lock:cutoff:${dateStr}`, '1', 120);
        if (!locked) { lastCutoffReset = dateStr; return; }
        lastCutoffReset = dateStr;
        await saveSchedulerState();
        await runCutoffReset();
      }
    }

    // 2PM Cutoff Report (cutoff day only — tolerance: 14:00 to 14:04)
    if (h === CUTOFF_REPORT_HR() && m < 5 && lastCutoffReport !== dateStr) {
      if (roster.some(u => isLastCutoffDay(u.role))) {
        // H6 fix: add dedup lock to prevent duplicate DMs on slow event loop ticks
        const locked = await rSetNX(`lock:report:${dateStr}`, '1', 120);
        if (!locked) { lastCutoffReport = dateStr; return; }
        lastCutoffReport = dateStr;
        await saveSchedulerState();
        await runCutoffReport();
      }
    }

    // Auto-promote pre-shift users and auto-stop OT at shift boundary
    // (lazy evaluation on dashboard polls handles most of this,
    //  but this catches users who aren't being polled)
    const keys = await rKeys('state:*');
    for (const key of keys) {
      try {
        const uid = key.replace('state:', '');
        const state = await getState(uid);
        const user = await getUserById(uid);
        if (!user) continue;
        const now = new Date();

        // Pre-shift → Active
        if (state.status === 'pre-shift' && state.shiftStart && now >= new Date(state.shiftStart)) {
          await setState(uid, { ...state, status: 'in' });
        }

        // OT auto-stop at shift boundary
        if (state.status === 'ot') {
          const windowDate = state.windowDate || getWindowDate();
          const schedInfo = getScheduleForWindow(user, windowDate);
          if (schedInfo && now >= schedInfo.win.start) {
            // Auto-stop OT and transition to shift
            const otStart = new Date(state.otStart);
            const durationMin = minsBetween(otStart, schedInfo.win.start);
            const blocks = Math.floor(durationMin / OT_BLOCK_MINS());
            const otHours = blocks * 0.5;
            if (otHours > 0) await addCutoffHours(uid, user.role, 0, otHours);

            // Clear OT state and auto-login for shift
            await clearState(uid);
            const inReply = await handleIn(uid, user.name, true);
            await sendGroupConfirmation(`⏱️ OT auto-stopped — ${user.name}. ${otHours}h OT credited. Transitioning to regular shift.\n${inReply}`);
          }
        }
      } catch(e) {}
    }
  } catch(e) { console.error('[Scheduler] tick error:', e.message); }
}, 60 * 1000);

// §33 HEALTH CHECK
// ============================================================
app.get('/', (req, res) => res.json({
  status: 'ok', bot: '10X VAs RTA v2.0',
  redis: REDIS_URL ? 'configured' : 'missing',
  sheets: GOOGLE_SA ? 'configured' : 'missing',
  time: new Date().toISOString(),
  windowDate: getWindowDate(),
}));

// §33 EXPRESS ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  console.error('[EXPRESS]', req.method, req.path, err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// §33 STARTUP
// ============================================================
app.listen(PORT, async () => {
  console.log(`10X VAs RTA v2.0 on port ${PORT}`);

  // Validate required env vars
  const missing = [];
  if (!TOKEN) missing.push('TELEGRAM_TOKEN');
  if (!ALLOWED_CHAT) missing.push('ALLOWED_CHAT');
  if (!TOPIC_ID) missing.push('TOPIC_ID');
  if (!WEBHOOK_URL) missing.push('WEBHOOK_URL');
  if (missing.length) {
    console.error(`\n⚠️  MISSING REQUIRED ENV VARS: ${missing.join(', ')}`);
    console.error('The bot will start but Telegram commands will NOT work.\n');
  }
  if (!REDIS_URL) console.warn('⚠️  REDIS_URL not set — using in-memory storage (data lost on restart)');
  if (!SHEET_ID || !GOOGLE_SA) console.warn('⚠️  SHEET_ID or GOOGLE_SA not set — Google Sheets logging disabled');

  await getRedis();

  // Load config from Postgres BEFORE doing anything else (so role checks use truth)
  await refreshConfigCache(true);
  console.log(`[CONFIG] Loaded ${Object.keys(_configCache).length} system keys, ${Object.keys(_roleCache).length} roles`);

  // Auto-refresh config every 60s in case admin edits role_config or system_config
  setInterval(() => refreshConfigCache().catch(()=>{}), 60_000);

  const roster = await getRoster();
  MANAGEMENT_IDS = roster.filter(u => isManagement(u.role)).map(u => u.id);
  await loadSchedulerState();
  await ensureSheetTabs();

  // Drop pending + register webhook
  if (TOKEN && WEBHOOK_URL) {
    try {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`, { drop_pending_updates: true });
      await new Promise(r => setTimeout(r, 1000));
      await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, { url: `${WEBHOOK_URL}/webhook` });
      console.log('Webhook registered');
    } catch(e) { console.error('Webhook setup:', e.message); }
  }

  console.log(`Management: ${MANAGEMENT_IDS.length} | Roster: ${roster.length} | Window: ${getWindowDate()}`);
});
