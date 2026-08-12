// ============================================================
//  Leo Tracker — app logic
//  Plain JavaScript, no build step. Loads after config.js and
//  the Supabase library (see index.html).
// ============================================================

// ---- 0. Connect to Supabase ---------------------------------
// createClient() opens the line to your database using the public URL + anon key.
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LEO_CONFIG;

// If config.js still has the placeholders, show a friendly note instead of
// crashing (the Supabase library throws on a fake URL).
const CONFIGURED = SUPABASE_URL.startsWith("http") && !SUPABASE_ANON_KEY.startsWith("PASTE");
if (!CONFIGURED) {
  document.getElementById("auth-msg").textContent =
    "Not connected yet — add your Supabase URL + anon key to config.js.";
}
const sb = CONFIGURED ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Wake-window thresholds used to live here as a flat 90 minutes. They are now
// age-driven and live in ONE place — see "0b. SLEEP MODEL" below.

// ---- App state ----------------------------------------------
let events = [];          // all events we've loaded, newest first
let chat = [];            // chat messages (from the `messages` table)
let tick = null;          // the 1-second clock interval
let alertTick = null;     // the 15-second alert re-evaluation
let alarmsOn = false;     // browser-notification permission granted?
let statsRange = 1;       // Stats tab range in days (1 = today, 7 = week)
let sleepChart = null;    // Chart.js instance
let chatBusy = false;     // a chat reply is in flight
let growth = [];          // weight/height measurements (growth table)
let growWChart = null;    // Chart.js — weight-for-age
let growHChart = null;    // Chart.js — height-for-age

// ---- Leo's birthday → age ("4 mo 15 d") ----------------------
const BIRTH = new Date(2026, 0, 23); // 23 Jan 2026 (month is 0-indexed)
function ageString() {
  const t = now();
  let months = (t.getFullYear() - BIRTH.getFullYear()) * 12 + (t.getMonth() - BIRTH.getMonth());
  let days = t.getDate() - BIRTH.getDate();
  if (days < 0) { months -= 1; days += new Date(t.getFullYear(), t.getMonth(), 0).getDate(); }
  return `${months} mo ${days} d`;
}

// ---- Age in whole months (for the target lookup) ------------
function ageMonths() {
  const t = now();
  let m = (t.getFullYear() - BIRTH.getFullYear()) * 12 + (t.getMonth() - BIRTH.getMonth());
  if (t.getDate() < BIRTH.getDate()) m -= 1;
  return Math.max(0, m);
}

// Extra context sent to the AI: real local time + the SAME resolved sleep config
// the screen is using + today's actuals. The AI no longer carries its own numbers.
function aiContext() {
  const st = sleepDayStats();
  const today = events.filter((e) => isToday(e.start_at));
  const feeds = today.filter((e) => e.type === "breast" || e.type === "bottle").length;
  return {
    age: ageString(),
    localTime: now().toLocaleString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cfg: cfgNow(),
    actuals: {
      sleepH: +(st.sleptMs / 3600000).toFixed(1),
      daySleepMin: st.napMins,
      naps: st.napCount,
      feeds,
    },
  };
}

// ---- Tiny helpers -------------------------------------------
const $ = (id) => document.getElementById(id);
// EVERY time read in this app goes through now(). TIME_SHIFT_MS lets window.leoDebug
// travel in time, so alerts can be tested against situations that haven't happened yet.
let TIME_SHIFT_MS = 0;
const now = () => new Date(Date.now() + TIME_SHIFT_MS);
const pad = (n) => String(n).padStart(2, "0");

// Format a span of milliseconds as m:ss (for feed timers).
function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
// Format minutes as a friendly H:MM string (used for color-zone math / finished spans).
function clockMins(mins) {
  const h = Math.floor(mins / 60), m = Math.floor(mins % 60);
  return h > 0 ? `${h}:${pad(m)}` : `0:${pad(m)}`;
}
// Live stopwatch: M:SS under an hour, H:MM:SS over — ticks every second.
function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
// Format a Date as a local clock time like "2:45 PM".
function clockTime(d) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ============================================================
//  0b. SLEEP MODEL — the ONE source of truth
// ============================================================
// This app used to keep the wake window in six places and they disagreed: a flat
// 90 minutes here, 135–180 in the Planner, 60/75/90 in the push sender, and "around
// the 4-month stage" in the AI prompt. Leo outgrew all of them and nobody noticed,
// so the app told us to put a not-tired baby to bed an hour early.
//
// Two rules keep that from happening again:
//   1. EVERY duration is integer MINUTES. Every clock time is an "HH:MM" local
//      string. No hours, no milliseconds, no Date objects in the config. (The
//      "4h26m more to reach 13h" bug was a partial-day number compared against a
//      whole-day one — a unit mistake wearing a UI costume.)
//   2. The band is looked up from his age on EVERY read, so it advances by itself
//      on his monthly birthday. No deploy, no cron, no reminder to anyone.
const MODEL_VERSION = 1;

// General guidelines, NOT medical advice. First row whose maxMonth ≥ age wins.
const AGE_DEFAULTS = [
  { maxMonth: 3,  band: "0–3 mo",
    ww:    { min: 60,  target: 75,  max: 90,  firstOfDay: 60,  lastOfDay: 90 },
    naps:  { minCount: 4, maxCount: 6, totalDayMin: 240, totalDayMax: 300, lastNapCutoff: "17:30", minUsefulNap: 20 },
    night: { bedtimeEarliest: "19:00", bedtimeLatest: "21:30", morningWakeEarliest: "06:00", expectedNightSleep: [540, 660], feedGateMin: 120 },
    feeds: { perDayMin: 8, perDayMax: 12 },
    totals:{ healthy24h: [840, 1020] } },

  { maxMonth: 5,  band: "4–5 mo",
    ww:    { min: 105, target: 120, max: 135, firstOfDay: 105, lastOfDay: 150 },
    naps:  { minCount: 3, maxCount: 4, totalDayMin: 180, totalDayMax: 240, lastNapCutoff: "17:00", minUsefulNap: 25 },
    night: { bedtimeEarliest: "18:30", bedtimeLatest: "20:30", morningWakeEarliest: "06:00", expectedNightSleep: [600, 720], feedGateMin: 180 },
    feeds: { perDayMin: 6, perDayMax: 8 },
    totals:{ healthy24h: [840, 960] } },

  // Leo is here as of Aug 2026. Wake windows 2.5–3h, 2–3 naps, 2.5–3.5h day sleep,
  // 10–12h night, 13–15h total. Nothing may nap past 5:15 PM.
  { maxMonth: 8,  band: "6–8 mo",
    ww:    { min: 150, target: 165, max: 180, firstOfDay: 150, lastOfDay: 180 },
    naps:  { minCount: 2, maxCount: 3, totalDayMin: 150, totalDayMax: 210, lastNapCutoff: "17:15", minUsefulNap: 30 },
    night: { bedtimeEarliest: "19:00", bedtimeLatest: "20:45", morningWakeEarliest: "06:00", expectedNightSleep: [600, 720], feedGateMin: 180 },
    feeds: { perDayMin: 5, perDayMax: 6 },
    totals:{ healthy24h: [780, 900] } },

  { maxMonth: 10, band: "9–10 mo",
    ww:    { min: 180, target: 195, max: 210, firstOfDay: 165, lastOfDay: 210 },
    naps:  { minCount: 2, maxCount: 2, totalDayMin: 120, totalDayMax: 180, lastNapCutoff: "16:30", minUsefulNap: 45 },
    night: { bedtimeEarliest: "18:45", bedtimeLatest: "20:30", morningWakeEarliest: "06:00", expectedNightSleep: [660, 720], feedGateMin: 240 },
    feeds: { perDayMin: 4, perDayMax: 5 },
    totals:{ healthy24h: [720, 870] } },

  { maxMonth: 12, band: "11–12 mo",
    ww:    { min: 195, target: 210, max: 225, firstOfDay: 180, lastOfDay: 225 },
    naps:  { minCount: 2, maxCount: 2, totalDayMin: 120, totalDayMax: 165, lastNapCutoff: "16:00", minUsefulNap: 45 },
    night: { bedtimeEarliest: "18:45", bedtimeLatest: "20:15", morningWakeEarliest: "06:00", expectedNightSleep: [660, 720], feedGateMin: 240 },
    feeds: { perDayMin: 4, perDayMax: 5 },
    totals:{ healthy24h: [720, 840] } },

  { maxMonth: 999, band: "13 mo+",
    ww:    { min: 240, target: 270, max: 300, firstOfDay: 210, lastOfDay: 300 },
    naps:  { minCount: 1, maxCount: 2, totalDayMin: 90, totalDayMax: 150, lastNapCutoff: "15:30", minUsefulNap: 45 },
    night: { bedtimeEarliest: "18:45", bedtimeLatest: "20:00", morningWakeEarliest: "06:00", expectedNightSleep: [660, 720], feedGateMin: 240 },
    feeds: { perDayMin: 3, perDayMax: 4 },
    totals:{ healthy24h: [660, 840] } },
];

// ---- Clock helpers: "HH:MM" ⇄ minutes-past-midnight ⇄ a Date today ----
function hhmmToMin(s) {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + (m || 0);
}
function minToHhmm(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
// "17:15" → a Date at 17:15 on the same calendar day as `ref` (defaults to now()).
function atToday(hhmm, ref) {
  const t = ref || now();
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  d.setMinutes(hhmmToMin(hhmm));
  return d;
}
// Minutes past local midnight for a Date/ISO.
function minOfDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getHours() * 60 + x.getMinutes() + x.getSeconds() / 60;
}

function defaultsForMonth(m) {
  return AGE_DEFAULTS.find((r) => m <= r.maxMonth) || AGE_DEFAULTS[AGE_DEFAULTS.length - 1];
}

// Overrides are a sparse dot-path map, e.g. { "ww.max": 190, "naps.lastNapCutoff": "17:00" }.
// Anything not listed keeps the age default, so a value Mike set at 6 months survives
// the jump to 7 months instead of being silently reverted.
function applyOverrides(row, overrides) {
  const cfg = JSON.parse(JSON.stringify(row));
  const overridden = [];
  for (const [path, value] of Object.entries(overrides || {})) {
    const [section, key] = path.split(".");
    if (!cfg[section] || !(key in cfg[section])) continue;   // ignore stale paths
    if (JSON.stringify(cfg[section][key]) === JSON.stringify(value)) continue;
    cfg[section][key] = value;
    overridden.push(path);
  }
  return { cfg, overridden };
}

// Pure: same inputs, same output. Testable from the console via leoDebug.cfg().
function resolveConfig(month, overrides) {
  const row = defaultsForMonth(month);
  const { cfg, overridden } = applyOverrides(row, overrides);
  delete cfg.maxMonth;
  return {
    month,
    band: row.band,
    ww: cfg.ww, naps: cfg.naps, night: cfg.night, feeds: cfg.feeds, totals: cfg.totals,
    meta: {
      version: MODEL_VERSION,
      source: overridden.length ? "custom" : "age-defaults",
      overridden,
      resolvedAt: now().toISOString(),
    },
  };
}

// Settings hydrated from Supabase (see loadSettings). Defaults stand in until then,
// so the app renders correct numbers offline and on first paint.
let SETTINGS = { overrides: {}, baby: { name: "Leo", birth_date: "2026-01-23", tz: "America/Cancun" } };
let settingsRev = 0;

// Memoized resolve. Called from render code, so it must never touch the network.
let _cfgCache = { key: null, value: null };
function cfgNow() {
  const month = ageMonths();
  const key = `${month}|${settingsRev}`;
  if (_cfgCache.key !== key) _cfgCache = { key, value: resolveConfig(month, SETTINGS.overrides) };
  return _cfgCache.value;
}

// ============================================================
//  0c. DERIVATIONS — two functions, read everywhere
// ============================================================
// "How long has he been awake" and "how much has he slept today" each used to have
// three implementations that quietly disagreed (one required end_at, one clipped at
// midnight, one didn't). Now there are two, and everything reads them.
//
// Both take (events, t) so they can be called against synthetic data at a fake time —
// that's how the alerts get tested. Both default to the live globals.

// Everything about the current wake window.
// Anchors on the sleep that ENDED most recently, which is what a parent means by
// "since he woke up" — and what wake-watch now does too, so they can't disagree.
function wakeState(evts, cfg, t) {
  const T = t || now();
  const list = evts || events;
  const c = cfg || cfgNow();
  const asleep = list.find((e) => e.type === "sleep" && !e.end_at) || null;
  const last = list.filter((e) => e.type === "sleep" && e.end_at)
                   .sort((a, b) => new Date(b.end_at) - new Date(a.end_at))[0] || null;

  const out = {
    asleep, last, wokeAt: null, awakeMin: 0, zone: "green",
    windowMin: c.ww.min, windowMax: c.ww.max, windowTarget: c.ww.target,
    opensAt: null, targetAt: null, closesAt: null,
    isFirstOfDay: false, isLastOfDay: false,
  };
  if (asleep || !last) return out;

  const st = sleepDayStats(list, T);
  const spread = Math.max(0, c.ww.max - c.ww.min);
  // The first window of the morning is the shortest, the one before bed the longest.
  out.isFirstOfDay = st.napCount === 0 && (last.subtype === "night" || minOfDay(new Date(last.end_at)) < hhmmToMin(c.night.morningWakeEarliest) + 180);
  out.isLastOfDay  = st.napCount >= c.naps.maxCount || minOfDay(T) >= hhmmToMin(c.naps.lastNapCutoff);
  if (out.isLastOfDay)       { out.windowMin = Math.max(0, c.ww.lastOfDay - spread); out.windowMax = c.ww.lastOfDay; }
  else if (out.isFirstOfDay) { out.windowMin = c.ww.firstOfDay; out.windowMax = c.ww.firstOfDay + spread; }
  out.windowTarget = Math.min(Math.max(c.ww.target, out.windowMin), out.windowMax);

  const wokeAt = new Date(last.end_at);
  out.wokeAt = wokeAt;
  out.awakeMin = (T - wokeAt) / 60000;
  out.opensAt  = new Date(wokeAt.getTime() + out.windowMin * 60000);
  out.targetAt = new Date(wokeAt.getTime() + out.windowTarget * 60000);
  out.closesAt = new Date(wokeAt.getTime() + out.windowMax * 60000);

  // Five states, not four. "Too early to be tired" and "put him down now" are
  // opposite instructions; collapsing them into one green means the headline is
  // green for two and a half hours and stops telling you anything.
  const a = out.awakeMin;
  if (a < out.windowMin)            out.zone = "early";
  else if (a < out.windowTarget)    out.zone = "green";
  else if (a <= out.windowMax)      out.zone = "amber";
  else if (a <= out.windowMax + 20) out.zone = "orange";
  else                              out.zone = "red";
  return out;
}

// Sleep clipped to the calendar day of `t`. One implementation for the day-bar,
// the totals, the alerts and the AI, so they can never print different numbers.
function sleepDayStats(evts, t) {
  const T = t || now();
  const list = evts || events;
  const dayStart = new Date(T.getFullYear(), T.getMonth(), T.getDate()).getTime();
  const dayMs = 86400000, dayEnd = dayStart + dayMs, nowMs = T.getTime();

  const blocks = [];
  let sleptMs = 0, napMins = 0, nightMins = 0, napCount = 0, lastNapEnd = null;

  const sleeps = list
    .filter((e) => e.type === "sleep" &&
      new Date(e.start_at).getTime() < dayEnd &&
      (e.end_at ? new Date(e.end_at).getTime() : nowMs) >= dayStart)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  for (const e of sleeps) {
    const rawStart = new Date(e.start_at).getTime();
    const rawEnd   = e.end_at ? new Date(e.end_at).getTime() : nowMs;
    const s  = Math.max(rawStart, dayStart);
    const en = Math.min(rawEnd, dayEnd, nowMs);
    if (en <= s) continue;
    const ms = en - s;
    const kind = e.subtype === "night" ? "night" : "nap";
    sleptMs += ms;
    if (kind === "nap") {
      // Count the nap he is in RIGHT NOW. The old code required end_at, so a
      // running nap read as zero and the "4th nap" warning could never fire.
      napCount++;
      napMins += ms / 60000;
      if (e.end_at) lastNapEnd = new Date(Math.max(lastNapEnd ? lastNapEnd.getTime() : 0, rawEnd));
    } else {
      nightMins += ms / 60000;
    }
    blocks.push({
      id: e.id, e, kind, index: kind === "nap" ? napCount : 0,
      left: (s - dayStart) / dayMs * 100,
      width: (en - s) / dayMs * 100,
      ms, mins: ms / 60000,
      fullMins: (rawEnd - rawStart) / 60000,   // unclipped — what "a 25-minute nap" means
      running: !e.end_at,
      startAt: new Date(rawStart), endAt: e.end_at ? new Date(rawEnd) : null,
    });
  }
  return {
    dayStart, dayMs, nowMs, sleptMs,
    napCount, napMins: Math.round(napMins), nightMins: Math.round(nightMins),
    lastNapEnd, blocks,
    naps: blocks.filter((b) => b.kind === "nap"),
  };
}

// Total sleep over a ROLLING 24 hours. The honest comparison against the 13–15h
// norm — the old code compared sleep-so-far-today against a whole-day target, which
// is why it spent every morning insisting Leo was hours short.
function sleepRolling24hMin(evts, t) {
  const T = t || now();
  const list = evts || events;
  const from = T.getTime() - 86400000, to = T.getTime();
  let ms = 0;
  for (const e of list) {
    if (e.type !== "sleep") continue;
    const s = Math.max(new Date(e.start_at).getTime(), from);
    const en = Math.min(e.end_at ? new Date(e.end_at).getTime() : to, to);
    if (en > s) ms += en - s;
  }
  return Math.round(ms / 60000);
}

// ============================================================
//  1. AUTH — login / logout
// ============================================================
async function handleLogin(e) {
  e.preventDefault();
  if (!sb) return; // not configured yet
  const msg = $("auth-msg");
  msg.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  if (error) { msg.textContent = error.message; return; }
  msg.textContent = "";
}

async function handleSignOut() {
  await sb.auth.signOut();
}

// React whenever the login state changes (also fires on page load).
if (sb) {
  sb.auth.onAuthStateChange((_event, session) => {
    if (session) showApp();
    else showAuth();
  });
}

function showAuth() {
  $("app-view").classList.add("hidden");
  $("auth-view").classList.remove("hidden");
  if (tick) { clearInterval(tick); tick = null; }
  if (alertTick) { clearInterval(alertTick); alertTick = null; }
}

async function showApp() {
  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("age-line").textContent = "Leo · " + ageString();
  // First run on a device: remember his age silently, so the "Leo turned N months"
  // card only appears on a real birthday, not the first time you open the app.
  try { if (localStorage.getItem(SEEN_MONTH_KEY) === null) localStorage.setItem(SEEN_MONTH_KEY, String(ageMonths())); } catch (e) {}
  await loadSettings();                        // before loadEvents — every render reads cfg
  await loadEvents();
  await loadMessages();
  await loadGrowth();
  subscribeRealtime();
  loadInsight();                               // cached, see below
  if (!tick) tick = setInterval(render, 1000); // live clocks update every second
  // Alerts on their own slow cadence. NOT in render(): a dismiss button that gets
  // rebuilt every second can't be tapped.
  if (!alertTick) alertTick = setInterval(() => renderAlerts(), 15000);
}

// ============================================================
//  2. DATA — load + live sync
// ============================================================
async function loadEvents() {
  const { data, error } = await sb
    .from("events")
    .select("*")
    .order("start_at", { ascending: false });
  if (error) { console.error(error); return; }
  events = data || [];
  render();
  renderSummary();   // data-driven: only redraw on change, not every second
  renderLog("log-list");       // old Home log (kept)
  renderLog("leo-log-list");   // new Leo home log — data-driven, not per-second
  renderRhythm();              // day-bar static layer — NOT per-second
  renderLeoData();             // budget + projection + tiles + night patterns
  renderAlerts();
  renderStats();
  if (tabOpen("sleep")) renderSleep();
}

// ============================================================
//  2b. SETTINGS — shared config, so both phones AND the push sender agree
// ============================================================
// The app is the only writer. The `settings` table is the runtime source for
// anything not running in a browser: wake-watch reads it instead of carrying its
// own copy of the numbers, which is how it ended up pinging at 60 minutes for a
// baby who needs 150.
const SETTINGS_CACHE_KEY = "leo_settings_v1";

async function loadSettings() {
  // localStorage first so the first paint is right even offline.
  try {
    const cached = JSON.parse(localStorage.getItem(SETTINGS_CACHE_KEY) || "null");
    if (cached) { SETTINGS = { ...SETTINGS, ...cached }; settingsRev++; }
  } catch (e) {}
  if (!sb) return;
  const { data, error } = await sb.from("settings").select("key,value");
  if (error) { console.warn("settings unavailable — using age defaults", error.message); return; }
  for (const row of data || []) {
    if (row.key === "baby") SETTINGS.baby = { ...SETTINGS.baby, ...row.value };
    if (row.key === "sleep_model") SETTINGS.overrides = (row.value && row.value.overrides) || {};
  }
  settingsRev++;
  try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ baby: SETTINGS.baby, overrides: SETTINGS.overrides })); } catch (e) {}
  await writeResolvedIfChanged();
}

// Push the RESOLVED config back so the server side never has to resolve anything.
// Also what makes his monthly birthday propagate without a deploy.
async function writeResolvedIfChanged(force) {
  if (!sb) return;
  const cfg = cfgNow();
  const value = { ...cfg, overrides: SETTINGS.overrides };
  const { data } = await sb.from("settings").select("value").eq("key", "sleep_model").maybeSingle();
  const cur = data && data.value;
  if (!force && cur && cur.month === cfg.month && cur.meta && cur.meta.version === MODEL_VERSION &&
      JSON.stringify(cur.overrides || {}) === JSON.stringify(SETTINGS.overrides)) return;
  const { error } = await sb.from("settings").upsert({ key: "sleep_model", value, updated_at: now().toISOString() }, { onConflict: "key" });
  if (error) console.warn("could not save sleep_model", error.message);
}

async function saveOverrides(next) {
  SETTINGS.overrides = next;
  settingsRev++;
  try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ baby: SETTINGS.baby, overrides: SETTINGS.overrides })); } catch (e) {}
  await writeResolvedIfChanged(true);
  renderSettings(); renderRhythm(); renderLeoData(); renderAlerts(true); render();
}

// Weight/height measurements (separate table, mirrors loadEvents).
async function loadGrowth() {
  if (!sb) return;
  const { data, error } = await sb.from("growth").select("*").order("measured_at", { ascending: true });
  if (error) { console.error(error); return; }   // table may not exist until schema-growth.sql is run
  growth = data || [];
  renderGrowth();
}

// Realtime: when ANY row in `events` is added/changed/removed (by either
// parent, on any device), reload so both screens stay in sync.
let realtimeOn = false;
function subscribeRealtime() {
  if (realtimeOn) return;   // onAuthStateChange can fire again (token refresh) — subscribe once
  realtimeOn = true;
  sb.channel("events-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, loadEvents)
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, loadMessages)
    .on("postgres_changes", { event: "*", schema: "public", table: "growth" }, loadGrowth)
    // Change a number on one phone, the other phone's headline updates without a reload.
    .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, onSettingsChanged)
    .subscribe();
}

// Convenience finders over the in-memory list ------------------
const openFeed  = () => events.find((e) => e.type === "breast" && !e.end_at);
const openSleep = () => events.find((e) => e.type === "sleep"  && !e.end_at);
const lastEndedSleep = () =>
  events.filter((e) => e.type === "sleep" && e.end_at)
        .sort((a, b) => new Date(b.end_at) - new Date(a.end_at))[0];
const lastFeed = () =>
  events.filter((e) => (e.type === "breast" || e.type === "bottle") && e.end_at)[0];

function isToday(iso) {
  const d = new Date(iso), t = now();
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}

// ============================================================
//  3. FEEDS — breast (live timer) + bottle (modal)
// ============================================================
// Tapping a side: start it / stop it / switch sides.
async function tapBreast(side) {
  const running = openFeed();
  if (running && running.subtype === side) {
    await stopFeed(running);               // same side → stop
  } else {
    if (running) await stopFeed(running);  // other side → stop current first
    await sb.from("events").insert({ type: "breast", subtype: side });
  }
  await loadEvents();
}
async function stopFeed(row) {
  await sb.from("events").update({ end_at: now().toISOString() }).eq("id", row.id);
}

function openBottleModal() { openModal("bottle-modal"); $("bottle-ml").value = ""; setTimeout(() => $("bottle-ml").focus(), 50); }
async function saveBottle() {
  const ml = parseInt($("bottle-ml").value, 10);
  if (!ml || ml <= 0) { $("bottle-ml").focus(); return; }
  const ts = now().toISOString();
  await sb.from("events").insert({ type: "bottle", amount_ml: ml, end_at: ts });
  closeModal();
  await loadEvents();
}

// ============================================================
//  4. SLEEP — start / end, auto nap vs night
// ============================================================
// Nap vs night used to be guessed from the clock — 7pm–7am was "night", set once
// at the start and impossible to correct. A 6:45pm bedtime was therefore filed as
// his fourth nap, and every nap-count alert built on top of that would be wrong.
// Now you say which one it is, and you can fix it afterwards in the edit modal.
async function startSleep(kind) {
  if (openSleep()) return;
  await sb.from("events").insert({ type: "sleep", subtype: kind, start_at: now().toISOString() });
  await loadEvents();
}
async function endSleep() {
  const running = openSleep();
  if (!running) return;
  await sb.from("events").update({ end_at: now().toISOString() }).eq("id", running.id);
  await loadEvents();
}
// Fallback for the old Home-tab button, which is a single toggle.
function defaultSleepKind(t) {
  const cfg = cfgNow(), m = minOfDay(t || now());
  return (m >= hhmmToMin(cfg.night.bedtimeEarliest) || m < hhmmToMin(cfg.night.morningWakeEarliest)) ? "night" : "nap";
}
async function tapSleep() {
  if (openSleep()) await endSleep();
  else await startSleep(defaultSleepKind());
}

// ============================================================
//  5. MILESTONES — note + optional photo (Supabase Storage)
// ============================================================
function openMilestoneModal() {
  openModal("milestone-modal");
  $("ms-note").value = ""; $("ms-photo").value = ""; $("ms-msg").textContent = "";
  setTimeout(() => $("ms-note").focus(), 50);
}
async function saveMilestone() {
  const note = $("ms-note").value.trim();
  const file = $("ms-photo").files[0];
  if (!note && !file) { $("ms-note").focus(); return; }
  $("ms-msg").textContent = "Saving…";

  let photo_url = null;
  if (file) {
    // Upload into the "photos" storage bucket under a timestamped name.
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${Date.now()}.${ext}`;
    const up = await sb.storage.from("photos").upload(path, file, { upsert: false });
    if (up.error) { $("ms-msg").textContent = "Photo upload failed: " + up.error.message; return; }
    photo_url = sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
  }

  const { error } = await sb.from("events").insert({ type: "milestone", note, photo_url });
  if (error) { $("ms-msg").textContent = error.message; return; }
  closeModal();
  await loadEvents();
}

// ============================================================
//  6. DELETE — inline confirm (never browser confirm())
// ============================================================
async function deleteEvent(id) {
  await sb.from("events").delete().eq("id", id);
  await loadEvents();
}

// ============================================================
//  6b. EDIT — fix a logged entry (forgotten stop, wrong ml/note/time)
// ============================================================
let editId = null;

// ISO (UTC) → value a <input type="datetime-local"> expects (local wall-clock "YYYY-MM-DDTHH:mm").
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function openEditModal(e) {
  editId = e.id;
  $("edit-msg").textContent = "";
  const hasEnd = e.type === "breast" || e.type === "sleep";
  $("edit-row-end").classList.toggle("hidden", !hasEnd);
  $("edit-row-ml").classList.toggle("hidden", e.type !== "bottle");
  $("edit-row-note").classList.toggle("hidden", e.type !== "milestone");
  $("edit-row-subtype").classList.toggle("hidden", e.type !== "sleep");
  if (e.type === "sleep") {
    const want = e.subtype === "night" ? "night" : "nap";
    $("edit-subtype").querySelectorAll(".seg-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.subtype === want));
  }
  $("edit-start").value = toLocalInput(e.start_at);
  $("edit-end").value   = hasEnd ? toLocalInput(e.end_at) : "";
  $("edit-ml").value    = e.type === "bottle" ? (e.amount_ml || "") : "";
  $("edit-note").value  = e.type === "milestone" ? (e.note || "") : "";
  openModal("edit-modal");
}

async function saveEdit() {
  if (!editId) return;
  const e = events.find((x) => x.id === editId);
  if (!e) { closeModal(); return; }
  const msg = $("edit-msg");

  const startVal = $("edit-start").value;
  if (!startVal) { msg.textContent = "Start time is required."; return; }
  const fields = { start_at: new Date(startVal).toISOString() };

  if (e.type === "breast" || e.type === "sleep") {
    const endVal = $("edit-end").value;
    if (endVal) {
      if (new Date(endVal) < new Date(startVal)) { msg.textContent = "End can't be before start."; return; }
      fields.end_at = new Date(endVal).toISOString();
    } else {
      fields.end_at = null; // re-open a running entry
    }
  }
  if (e.type === "sleep") {
    const on = $("edit-subtype").querySelector(".seg-btn.active");
    if (on) fields.subtype = on.dataset.subtype;
  }
  if (e.type === "bottle") {
    const ml = parseInt($("edit-ml").value, 10);
    if (!ml || ml <= 0) { msg.textContent = "Enter a milliliter amount."; return; }
    fields.amount_ml = ml;
  }
  if (e.type === "milestone") {
    fields.note = $("edit-note").value.trim();
  }

  const { error } = await sb.from("events").update(fields).eq("id", editId);
  if (error) { msg.textContent = error.message; return; }
  editId = null;
  closeModal();
  await loadEvents();
}

// ============================================================
//  6c. ALERTS — one pure function, priority-ordered, dismissible
// ============================================================
// evaluateAlerts() takes (events, cfg, t) and returns a list. No DOM, no globals,
// no side effects — so it can be run against a made-up day at a made-up time:
//   leoDebug.fakeDay("06:10 wake, 08:00-08:45 nap, 16:40- nap"); leoDebug.at("17:25");
//   leoDebug.alerts()
// That is the test suite. There isn't another one.

const SEV_RANK = { urgent: 0, warn: 1, info: 2 };
const ALERT_DISMISS_KEY = "leo_alert_dismissed_v1";
const SEEN_MONTH_KEY = "leo_seen_month";

const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sameDay = (a, b) => dateKey(a) === dateKey(b);

function dismissedMap() {
  try { return JSON.parse(localStorage.getItem(ALERT_DISMISS_KEY) || "{}"); } catch (e) { return {}; }
}
// Dismissal is per-device on purpose: Mike clearing a banner shouldn't clear it off
// Emma's phone. The key carries the date or the row id, so the NEXT occurrence has a
// different key and fires again — that's the whole re-trigger mechanism.
function dismissAlert(key) {
  const m = dismissedMap();
  m[key] = Date.now();
  const cutoff = Date.now() - 30 * 86400000;
  for (const k of Object.keys(m)) if (m[k] < cutoff) delete m[k];
  try { localStorage.setItem(ALERT_DISMISS_KEY, JSON.stringify(m)); } catch (e) {}
  if (key.startsWith("month:")) {
    try { localStorage.setItem(SEEN_MONTH_KEY, key.slice(6)); } catch (e) {}
  }
  renderAlerts(true);
}

function evaluateAlerts(evts, cfg, t) {
  const T = t || now();
  const list = evts || events;
  const c = cfg || cfgNow();
  const st = sleepDayStats(list, T);
  const w = wakeState(list, c, T);
  const dk = dateKey(T);
  const nowMin = minOfDay(T);
  const cutoffMin = hhmmToMin(c.naps.lastNapCutoff);
  const morningMin = hhmmToMin(c.night.morningWakeEarliest);
  const out = [];

  // 🔴 Put down before he was tired. The most common cause of a long bedtime.
  if (w.asleep && w.asleep.subtype === "night") {
    const startMs = new Date(w.asleep.start_at).getTime();
    const prev = list
      .filter((e) => e.type === "sleep" && e.end_at && new Date(e.end_at).getTime() <= startMs)
      .sort((a, b) => new Date(b.end_at) - new Date(a.end_at))[0];
    if (prev) {
      const awakeBefore = (startMs - new Date(prev.end_at).getTime()) / 60000;
      if (awakeBefore < c.ww.min) out.push({
        id: "undertired-bedtime", sev: "urgent", key: `undertired:${w.asleep.id}`, push: false,
        title: `Only ${plDur(Math.round(awakeBefore))} awake — likely undertired`,
        body: `He usually needs ${plDur(c.ww.min)}–${plDur(c.ww.max)} awake before bed. Bedtime fights are almost always caused by putting him down too early, not too late.`,
      });
    }
  }

  // 🔴 A nap running into the cutoff. Warn 15 min before, like a real heads-up.
  const runningNap = st.blocks.find((b) => b.running && b.kind === "nap");
  if (runningNap && nowMin >= cutoffMin - 15) {
    const past = nowMin >= cutoffMin;
    out.push({
      id: "late-nap", sev: "urgent", key: `latenap:${runningNap.id}`, push: true,
      title: past ? `Wake Leo — it's past ${plFmt(cutoffMin)}` : `Wake Leo by ${plFmt(cutoffMin)}`,
      body: `A nap past the cutoff spends the sleep pressure you need tonight. It works like a coffee at 6pm.`,
    });
  }

  // 🟡 Day sleep is full.
  if (st.napMins >= c.naps.totalDayMax) out.push({
    id: "day-cap", sev: "warn", key: `daycap:${dk}`, push: true,
    title: `Day sleep is full — ${plDur(st.napMins)}`,
    body: `More naps now usually means a harder bedtime and more night waking. The ${plDur(c.totals.healthy24h[0])}–${plDur(c.totals.healthy24h[1])} norm includes the night.`,
  });

  // 🟡 Bedtime window is open and he's ready.
  const bedLo = hhmmToMin(c.night.bedtimeEarliest), bedHi = hhmmToMin(c.night.bedtimeLatest);
  const nightStartedToday = list.some((e) =>
    e.type === "sleep" && e.subtype === "night" &&
    sameDay(new Date(e.start_at), T) && minOfDay(new Date(e.start_at)) >= bedLo - 90);
  if (!w.asleep && nowMin >= bedLo && nowMin <= bedHi && w.awakeMin >= w.windowMin && !nightStartedToday) out.push({
    id: "bedtime-open", sev: "warn", key: `bedtime:${dk}`, push: true,
    title: `Bedtime window open`,
    body: `Crib between ${clockTime(w.opensAt)} and ${clockTime(w.closesAt)}. Start the routine now — calm and a bit later beats fast and too early.`,
  });

  // 🔵 One nap too many.
  if (st.napCount > c.naps.maxCount) out.push({
    id: "extra-nap", sev: "info", key: `napover:${dk}:${st.napCount}`, push: false,
    title: `That's nap #${st.napCount}`,
    body: `At ${c.band}, ${c.naps.minCount}–${c.naps.maxCount} naps is the target. Consider holding him to bedtime instead.`,
  });

  // 🔵 Fragmented day — the pattern behind "he fights bedtime every night".
  const shortNaps = st.naps.filter((b) => !b.running && b.fullMins < c.naps.minUsefulNap);
  if (shortNaps.length >= 2) out.push({
    id: "snack-naps", sev: "info", key: `snack:${dk}:${shortNaps.length}`, push: false,
    title: `${shortNaps.length} short naps today`,
    body: `Naps under ${c.naps.minUsefulNap} min drain sleep pressure without restoring much. Expect to need the later end of the bedtime window.`,
  });

  // 🔵 Night feed spacing — INFORMATION, not a gate. Whether Leo needs a night feed
  // is a weight-and-pediatrician question; this app doesn't get a vote on it.
  if (nowMin >= 19 * 60 || nowMin < morningMin) {
    const lastNight = list
      .filter((e) => e.type === "breast" || e.type === "bottle")
      .map((e) => new Date(e.end_at || e.start_at))
      .filter((d) => d <= T && (T - d) <= 12 * 3600000 && (minOfDay(d) >= 19 * 60 || minOfDay(d) < morningMin))
      .sort((a, b) => b - a)[0];
    if (lastNight) out.push({
      id: "feed-gate", sev: "info", key: `feedgate:${lastNight.getTime()}`, push: false,
      title: `Last night feed ${clockTime(lastNight)} · ${plDur(Math.round((T - lastNight) / 60000))} ago`,
      body: `Typical spacing at ${c.band} is around ${plDur(c.night.feedGateMin)}. For reference only — feeding is a weight-and-doctor decision, not a clock decision.`,
    });
  }

  // 🔵 Up before morning.
  if (!w.asleep && w.last && w.last.subtype === "night" && w.last.end_at) {
    const endAt = new Date(w.last.end_at);
    const endM = minOfDay(endAt);
    if (endM >= 270 && endM < morningMin && (T - endAt) < 2 * 3600000) out.push({
      id: "early-wake", sev: "info", key: `earlywake:${w.last.id}`, push: false,
      title: `Before ${plFmt(morningMin)} is still night`,
      body: `Treat it as a night wake — dark, quiet, minimal handling. Morning starts at ${plFmt(morningMin)} with light and voices.`,
    });
  }

  // 🔵 He grew. The targets moved. Say so out loud.
  let seen = null;
  try { seen = localStorage.getItem(SEEN_MONTH_KEY); } catch (e) {}
  if (seen !== null && c.month > Number(seen)) {
    const prev = defaultsForMonth(Number(seen));
    out.push({
      id: "month-advance", sev: "info", key: `month:${c.month}`, push: false, action: "settings",
      title: `Leo turned ${c.month} months — targets updated`,
      body: `Wake windows ${plDur(prev.ww.min)}–${plDur(prev.ww.max)} → ${plDur(c.ww.min)}–${plDur(c.ww.max)}. Nap cap ${prev.naps.maxCount} → ${c.naps.maxCount}. Tap to review.`,
    });
  }

  return out.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev]);
}

// ---- Rendering. Never called from render(): a dismiss button rebuilt every second
// is impossible to tap. (We already paid for that lesson once — see commit 6b6ebb3,
// "Fix delete confirm wiped by per-second rerender".) The DOM is only touched when
// the set of visible alerts actually changes.
let _alertSig = null;
let _lastUrgent = new Set();
function renderAlerts(force) {
  const host = $("leo-alerts");
  if (!host) return;
  const dis = dismissedMap();
  const live = evaluateAlerts().filter((a) => !dis[a.key]).slice(0, 3);
  const sig = live.map((a) => a.key).join("|");
  if (!force && sig === _alertSig) return;
  _alertSig = sig;

  host.innerHTML = "";
  for (const a of live) {
    const el = document.createElement("div");
    el.className = `alert alert-${a.sev}`;
    el.innerHTML = `<div class="alert-body"><div class="alert-title"></div><div class="alert-text"></div></div>`;
    el.querySelector(".alert-title").textContent = a.title;
    el.querySelector(".alert-text").textContent = a.body;
    if (a.action === "settings") {
      el.classList.add("tappable");
      el.addEventListener("click", (ev) => { if (!ev.target.closest(".alert-x")) switchTab("settings"); });
    }
    const x = document.createElement("button");
    x.className = "alert-x"; x.textContent = "✕"; x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", () => dismissAlert(a.key));
    el.appendChild(x);
    host.appendChild(el);
  }

  // The audible alarm used to fire from the old wake card at a flat 90 minutes.
  // It now rings once when a genuinely urgent alert first appears.
  const urgent = new Set(live.filter((a) => a.sev === "urgent").map((a) => a.key));
  for (const k of urgent) if (!_lastUrgent.has(k)) { fireAlarm(); break; }
  _lastUrgent = urgent;
}

// ============================================================
//  7. RENDER — runs every second to keep live timers fresh
// ============================================================
// Per-second tick: only the live timers. NOT the log/summary — rebuilding the
// log every second was wiping out the "Delete/Keep" confirm before you could tap.
const tabOpen = (name) => { const el = $("tab-" + name); return !!el && !el.classList.contains("hidden"); };

function render() {
  renderTopBanner();                       // sticky — the one timer visible on every tab
  // Only redraw what's actually on screen. This used to run twelve renderers a
  // second against hidden tabs — 86,400 pointless DOM writes a day, on a phone.
  if (tabOpen("leo")) {
    renderLeoWake();
    tickNow();                             // day-bar: moves ONE element, nothing else
  }
  if (tabOpen("home")) {
    renderLive();
    renderFeedButtons();
    renderSleepButton();
    renderSinceFeed();
    renderNextFeed();
    renderFeedAwake();
    renderAgo();
    renderClockNow();
  }
}

// Sticky banner (above the tabs) so the live wake/sleep timer is visible on every tab.
// Reuses the same math + color zones as the Home wake card; ticks every second via render().
function renderTopBanner() {
  const el = $("topbanner");
  if (!el) return;
  // On the Leo tab the headline card says all of this, ten pixels lower.
  if (tabOpen("leo")) { el.classList.add("hidden"); return; }
  const w = wakeState();
  if (w.asleep) {
    el.className = "topbanner zone-green";
    el.textContent = `${w.asleep.subtype === "night" ? "🌙" : "💤"} Asleep ${dur(now() - new Date(w.asleep.start_at))}`;
    el.classList.remove("hidden");
    return;
  }
  if (!w.wokeAt) { el.classList.add("hidden"); return; }
  el.className = `topbanner zone-${w.zone}`;
  el.textContent = `⏱ Awake ${dur(now() - w.wokeAt)} · window ${clockTime(w.opensAt)}–${clockTime(w.closesAt)}`;
  el.classList.remove("hidden");
}

function renderLive() {
  const banner = $("live-banner");
  const feed = openFeed();
  const sleep = openSleep();
  if (feed) {
    const feedDur = mmss(now() - new Date(feed.start_at));
    banner.innerHTML = `<span class="dot"></span> Feeding · Breast ${feed.subtype === "left" ? "L" : "R"} · ${feedDur}`;
    banner.classList.remove("hidden");
  } else if (sleep) {
    banner.innerHTML = `<span class="dot"></span> Asleep · ${dur(now() - new Date(sleep.start_at))}`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function renderFeedButtons() {
  const feed = openFeed();
  $("breast-left").classList.toggle("active", !!feed && feed.subtype === "left");
  $("breast-right").classList.toggle("active", !!feed && feed.subtype === "right");
  $("breast-left").textContent  = (feed && feed.subtype === "left")  ? "Stop L" : "Breast L";
  $("breast-right").textContent = (feed && feed.subtype === "right") ? "Stop R" : "Breast R";
}

function renderSleepButton() {
  const sleeping = openSleep();
  const btn = $("sleep-btn");
  btn.classList.toggle("active", !!sleeping);
  btn.textContent = sleeping ? "End sleep" : "Start sleep";
  $("sleep-status").textContent = sleeping
    ? `${sleeping.subtype} · ${dur(now() - new Date(sleeping.start_at))}`
    : "Awake";
}

function renderSinceFeed() {
  const f = lastFeed();
  if (!f) { $("since-feed").textContent = "—"; return; }
  const mins = Math.floor((now() - new Date(f.end_at || f.start_at)) / 60000);
  $("since-feed").textContent = mins < 1 ? "just now" : `${clockMins(mins)} ago`;
}

// Predicted next feed from his last feed + the age-appropriate interval.
// (Targets give feeds/day; e.g. Leo at 4 mo ≈ 6–8/day → roughly every ~3.4h.)
function nextFeedAt() {
  const f = lastFeed();
  if (!f) return null;
  const fd = cfgNow().feeds;
  const avgPerDay = (fd.perDayMin + fd.perDayMax) / 2;
  const intervalMs = ((24 * 60) / avgPerDay) * 60000;
  return new Date(new Date(f.end_at || f.start_at).getTime() + intervalMs);
}

// Friendly minutes: "22 min" / "1 hr 5 min".
function humanMins(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

function renderNextFeed() {
  const el = $("next-feed");
  if (!el) return;
  const due = nextFeedAt();
  if (!due) { el.className = "next-feed"; el.textContent = "Next feed — log a feed to predict"; return; }
  const diff = Math.round((due - now()) / 60000);
  let tail;
  if (diff > 1) { tail = `in ${humanMins(diff)}`; el.className = "next-feed"; }
  else if (diff >= -5) { tail = "due now"; el.className = "next-feed due"; }
  else { tail = `overdue ${humanMins(-diff)}`; el.className = "next-feed due"; }
  el.textContent = `Next feed ~${clockTime(due)} · ${tail}`;
}

// Live "as of HH:MM" so it's obvious the app is reading the real current time.
function renderClockNow() {
  const el = $("clock-now");
  if (el) el.textContent = `as of ${clockTime(now())}`;
}

// Per-action "last done X ago" labels under each feed button + the sleep button.
// events is newest-first; a matching row with no end_at means it's running now.
function renderAgo() {
  // Friendly "27 min ago" / "1 hr 20 min ago" wording.
  const words = (mins) => {
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} hr ${m} min ago` : `${h} hr ago`;
  };
  const ago = (e) => {
    if (!e) return "never";
    if (!e.end_at) return "now";
    return words(Math.floor((now() - new Date(e.end_at)) / 60000));
  };
  $("ago-left").textContent   = ago(events.find((e) => e.type === "breast" && e.subtype === "left"));
  $("ago-right").textContent  = ago(events.find((e) => e.type === "breast" && e.subtype === "right"));
  $("ago-bottle").textContent = ago(events.find((e) => e.type === "bottle"));

  const s = events.find((e) => e.type === "sleep");
  let sleepLabel;
  if (!s) sleepLabel = "no sleep yet";
  else if (!s.end_at) sleepLabel = "asleep now";
  else {
    const mins = Math.floor((now() - new Date(s.end_at)) / 60000);
    sleepLabel = mins < 1 ? "woke just now" : `last sleep ${words(mins)}`;
  }
  $("ago-sleep").textContent = sleepLabel;
}

// Clear "how long awake" readout shown on the Feed card.
function renderFeedAwake() {
  const el = $("feed-awake");
  if (!el) return;
  if (openSleep()) { el.textContent = "💤 Asleep"; return; }
  const last = lastEndedSleep();
  el.textContent = last ? "Awake for " + dur(now() - new Date(last.end_at)) : "Awake for —";
}

function renderSummary() {
  const today = events.filter((e) => isToday(e.start_at));
  const feeds = today.filter((e) => e.type === "breast" || e.type === "bottle").length;
  let feedMs = 0;
  for (const e of today) {
    if (e.type === "breast" && e.end_at) feedMs += new Date(e.end_at) - new Date(e.start_at);
  }
  // Same derivation the Leo tab uses, so the two screens can't print different totals.
  const st = sleepDayStats();
  $("t-feeds").textContent = feeds;
  $("t-sleep").textContent = (st.sleptMs / 3600000).toFixed(1) + "h";
  $("t-feedtime").textContent = Math.round(feedMs / 60000) + "m";
}

function barRow(label, pct, value, met) {
  return `<div class="progress-row">` +
    `<span class="progress-label">${label}</span>` +
    `<span class="bar"><span class="bar-fill${met ? " met" : ""}" style="width:${pct}%"></span></span>` +
    `<span class="progress-val">${value}</span>` +
    `</div>`;
}

function pipRow(label, count, low, high, value) {
  const filled = Math.min(count, high);
  const pips = "●".repeat(filled) + "○".repeat(Math.max(0, high - filled));
  const met = count >= low;
  return `<div class="progress-row">` +
    `<span class="progress-label">${label}</span>` +
    `<span class="pips${met ? " met" : ""}">${pips}</span>` +
    `<span class="progress-val">${value}</span>` +
    `</div>`;
}

const EMOJI = { breast: "🤱", bottle: "🍼", sleep: "😴", milestone: "✨" };

function renderLog(listId) {
  const list = $(listId || "log-list");
  if (!list) return;
  const today = events.filter((e) => isToday(e.start_at));
  if (today.length === 0) { list.innerHTML = '<li class="log-empty">No entries yet today.</li>'; return; }

  list.innerHTML = "";
  for (const e of today) {
    const li = document.createElement("li");
    li.className = "log-item";

    const span = e.end_at ? new Date(e.end_at) - new Date(e.start_at) : 0;
    const start = new Date(e.start_at);
    // meta shows the time range + total: "3:42 PM – 4:16 PM · 33m"
    let title = "", meta = clockTime(start);
    if (e.type === "breast") {
      title = `Breast ${e.subtype === "left" ? "L" : "R"}`;
      meta = e.end_at ? `${clockTime(start)} – ${clockTime(new Date(e.end_at))} · ${mmss(span)}` : `${clockTime(start)} – running`;
    } else if (e.type === "bottle") {
      title = `Bottle · ${e.amount_ml || 0} ml`;
    } else if (e.type === "sleep") {
      title = `Sleep (${e.subtype || "?"})`;
      meta = e.end_at ? `${clockTime(start)} – ${clockTime(new Date(e.end_at))} · ${clockMins(span / 60000)}` : `${clockTime(start)} – running`;
    } else if (e.type === "milestone") {
      title = e.note || "Milestone";
    }

    li.innerHTML = `
      <span class="log-emoji">${EMOJI[e.type] || "•"}</span>
      <div class="log-body">
        <div class="log-title"></div>
        <div class="log-meta"></div>
      </div>
      ${e.photo_url ? `<img class="log-photo" src="${e.photo_url}" alt="" />` : ""}
    `;
    li.querySelector(".log-title").textContent = title;   // textContent = safe against weird notes
    li.querySelector(".log-meta").textContent = meta;

    // Edit: open the edit modal pre-filled from this row.
    const edit = document.createElement("button");
    edit.className = "edit-btn"; edit.textContent = "✏️";
    edit.addEventListener("click", () => openEditModal(e));
    li.appendChild(edit);

    // Delete with an inline two-step confirm (no browser confirm()).
    const del = document.createElement("button");
    del.className = "del-btn"; del.textContent = "🗑";
    del.addEventListener("click", () => {
      const wrap = document.createElement("span");
      wrap.className = "del-confirm";
      wrap.innerHTML = `<button class="del-yes">Delete</button><button class="del-no">Keep</button>`;
      del.replaceWith(wrap);
      wrap.querySelector(".del-yes").addEventListener("click", () => deleteEvent(e.id));
      wrap.querySelector(".del-no").addEventListener("click", () => wrap.replaceWith(del));
    });
    li.appendChild(del);
    list.appendChild(li);
  }
}

// ============================================================
//  8. ALARM — vibrate + beep + browser notification at 90 min
// ============================================================
async function enableAlarms() {
  if (!("Notification" in window)) { alarmsOn = true; $("bell-btn").classList.add("armed"); return; }
  const perm = await Notification.requestPermission();
  alarmsOn = perm === "granted";
  $("bell-btn").classList.toggle("armed", alarmsOn);
  if (alarmsOn) subscribePush();   // also enable background push so alerts fire when the app is closed
}

// Register a Web Push subscription and store it in Supabase. The wake-watch
// function reads these to push the 90-min alert even when the app is closed.
async function subscribePush() {
  try {
    const key = window.LEO_CONFIG.VAPID_PUBLIC_KEY;
    if (!key || key.startsWith("PASTE")) return;                 // push not configured yet
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(key),
    });
    const json = sub.toJSON();
    await sb.from("push_subscriptions").upsert(
      { endpoint: json.endpoint, sub: json },
      { onConflict: "endpoint" },
    );
  } catch (err) { console.error("push subscribe failed", err); }
}

// VAPID public key (base64url) → Uint8Array, as the Push API expects.
function urlB64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function fireAlarm() {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  beep();
  if (alarmsOn && "Notification" in window) {
    new Notification("Leo's wake window is closing", { body: "It's been 90 minutes — time to wind down for sleep." });
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 880; osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch (_) { /* audio may be blocked until first tap — that's fine */ }
}

// ============================================================
//  9. CSV EXPORT — download all events
// ============================================================
function exportCSV() {
  const cols = ["type", "subtype", "start_at", "end_at", "amount_ml", "note", "created_at"];
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = events.map((e) => cols.map((c) => escape(e[c])).join(","));
  const csv = [cols.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `leo-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ============================================================
//  10. MODAL helpers
// ============================================================
function openModal(id) {
  $("modal-backdrop").classList.remove("hidden");
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
  $(id).classList.remove("hidden");
}
function closeModal() {
  $("modal-backdrop").classList.add("hidden");
}

// ============================================================
//  10b. TABS
// ============================================================
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.add("hidden"));
  $("tab-" + name).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "leo")      { renderLeoWake(); renderRhythm(); renderLeoData(); renderAlerts(true); }
  if (name === "grow")     renderGrowth();      // also (re)builds the charts now the canvas is visible
  if (name === "food")     renderFood();
  if (name === "planner")  renderPlanner();
  if (name === "sleep")    renderSleep();
  if (name === "settings") renderSettings();
  if (name === "ask")      scrollChat();
}

// ============================================================
//  10b-PLANNER. CARE PLANNER — age-based day rhythm + event guidance
//  Predictive (reads `events` for auto-fill; writes nothing).
// ============================================================

// The Planner's own age table used to live here. It is gone — see plCurrentBand(),
// which now translates the one sleep model into the shape the Planner speaks.
const WHY = [
  ["Why wake windows?","Adenosine (sleep pressure) builds the whole time Leo is awake. Too little before a nap and he won't settle; too much and he gets a cortisol surge — wired, not sleepy. The window just manages that pressure."],
  ["Why is the last window the longest?","Maximum sleep pressure right before bed gives the deepest, longest first night stretch and prevents 'false starts' where he pops awake 30–45 min after going down."],
  ["Why 'drowsy but awake'?","Around 4 months sleep matures into ~45–60 min cycles, and everyone briefly wakes between them. If Leo only falls asleep on the bottle, he needs it recreated at every cycle. Falling asleep on his own at bedtime is what lets him resettle on his own at 2am."],
  ["Why keep night feeds for now?","Leo is in catch-up growth and partly breastfed. Night-weaning is the LAST step — only once independent sleep is solid and the pediatrician signs off on weight. Onset first, longer stretches second, fewer feeds last."],
  ["Why morning light + fixed wake time?","Light sets the circadian clock. A consistent wake time plus morning light is the strongest anchor for the whole 24-hour rhythm — and the fix for early-morning waking."],
];

// Planner helpers (pl-prefixed so they never collide with the tracker's dur/fmt/etc.)
const plToMin = (s) => { const [h,m]=s.split(":").map(Number); return h*60+m; };
const plFmt = (min) => { min=((min%1440)+1440)%1440; let h=Math.floor(min/60),m=min%60; const ap=h>=12?"PM":"AM"; h=h%12||12; return `${h}:${pad(m)} ${ap}`; };
const plDur = (min) => { const h=Math.floor(min/60),m=min%60; return h?`${h}h${m?" "+m+"m":""}`:`${m}m`; };
const plIcon = (k) => ({wake:"☀️",feed:"🍼",nap:"💤",bed:"🌙"}[k]||"•");

// Age in whole weeks off the app's BIRTH constant.
function ageWeeks() { return Math.max(0, Math.floor((now() - BIRTH) / 6048e5)); } // 7*864e5 ms/week

function plGenerateDay(wakeMin, band, ww){
  const items=[]; const push=(t,kind,label,extra={})=>items.push({t,kind,label,...extra});
  push(wakeMin,"wake","Wake up"); push(wakeMin,"feed","Feed");
  let cur=wakeMin, used=0;
  for(let i=0;i<band.naps;i++){
    const down=cur+ww; if(i>0 && down>17*60) break;
    push(down,"nap",`Nap ${i+1}`,{len:band.napLen});
    const up=down+band.napLen; push(up,"wake",`Up from nap ${i+1}`); push(up+5,"feed","Feed");
    cur=up; used++;
  }
  const bed=cur+band.wwLast;
  push(bed-20,"feed","Bedtime feed"); push(bed,"bed","Bed"); push(bed+210,"feed","Dream feed (optional)");
  items.sort((a,b)=>a.t-b.t);
  return {items,bed,naps:used};
}
// realLastFeedMin: minutes-of-day of Leo's actual last logged feed (or null) — used for display.
function plAnalyzeEvent(day, band, evtMin, type, realLastFeedMin){
  const wakes=day.items.filter(i=>i.kind==="wake"&&i.t<=evtMin);
  const lastWake=wakes.length?wakes[wakes.length-1].t:day.items[0].t;
  const awake=evtMin-lastWake;
  const nextNap=day.items.find(i=>i.kind==="nap"&&i.t>=evtMin);
  const nextFeed=day.items.find(i=>i.kind==="feed"&&i.t>=evtMin);
  let windowStatus, statusClass;
  if(awake<band.wwMin){windowStatus=`Early in a wake window (~${plDur(awake)} awake). Fine — not tired yet.`;statusClass="ok";}
  else if(awake<=band.wwMax){windowStatus=`Inside his wake window (~${plDur(awake)} awake). Good timing.`;statusClass="ok";}
  else {windowStatus=`Past his window (~${plDur(awake)} awake — limit ~${plDur(band.wwMax)}). Expect fussiness; plan a nap into it.`;statusClass="warn";}
  const before=[],during=[],after=[];
  if(type==="travel"){
    before.push("Feed right before boarding so he's not hungry during taxi/takeoff.");
    before.push("Aim to start travel near a nap window so motion does the settling.");
    before.push(`Pack ${Math.ceil(band.feeds*1.5)} feeds minimum — 1.5× normal, split across separate bags.`);
    during.push("Feed or offer a pacifier during takeoff AND descent — sucking equalizes ear pressure.");
    during.push("Recreate sleep cues: white noise (phone), dark (cover carrier/bassinet), sleep sack.");
    during.push("If it's near bedtime, run the normal wind-down on board — same order, dark, calm.");
    after.push("Expect a rough first night in the new place — hold the routine, don't invent new props.");
    after.push("Reset to local morning light fast; it re-anchors his clock within a few days.");
  } else {
    before.push(`Feed before you leave (last feed was ${realLastFeedMin!=null?plFmt(realLastFeedMin):"—"}).`);
    if(statusClass==="warn") before.push("He'll be over his window — plan a motion nap (stroller/carrier) or shift the outing 30–45 min earlier.");
    during.push(nextNap?`Next nap due ~${plFmt(nextNap.t)}. If the event runs past it, do the nap on the move.`:"No nap due during this window — good window for an outing.");
    after.push(nextNap?`Get him down for a nap by ~${plFmt(nextNap.t)} (or soon after a motion nap).`:`Resume the rhythm; next feed ~${nextFeed?plFmt(nextFeed.t):"—"}.`);
    after.push("If a nap got skipped or cut short, move bedtime ~30 min earlier to avoid overtiredness.");
  }
  return {windowStatus,statusClass,lastFeedMin:realLastFeedMin,nextFeed,nextNap,before,during,after};
}

// Planner state — persisted under leoplan_* (separate from any tracker keys).
const plStore = {
  get(k,d){ try{ const v=localStorage.getItem("leoplan_"+k); return v===null?d:JSON.parse(v); }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem("leoplan_"+k, JSON.stringify(v)); }catch(e){} }
};
const planner = {
  view:    plStore.get("view","today"),
  wake:    "06:30",
  ww:      plStore.get("ww",null),
  evtType: plStore.get("evtType","outing"),
  evtTime: plStore.get("evtTime","08:30"),
  evtName: plStore.get("evtName","Breakfast"),
  open:    0,
};
let plWakeTouched = false; // false → re-seed wake from today's log on each render

// Adapter, not a second table: the Planner keeps its own vocabulary (wwMin/napLen/…)
// but every number behind it comes from the one sleep model.
function plCurrentBand(){
  const c = cfgNow();
  return {
    label:  c.band,
    wwMin:  c.ww.min,
    wwMax:  c.ww.max,
    wwLast: c.ww.lastOfDay,
    naps:   c.naps.maxCount,
    napLen: Math.round(c.naps.totalDayMax / c.naps.maxCount),
    feeds:  c.feeds.perDayMax,
    solids: c.month >= 6,
  };
}
function plEffectiveWw(){ const b=plCurrentBand(); const def=Math.round((b.wwMin+b.wwMax)/2); return planner.ww==null?def:Math.min(Math.max(planner.ww,b.wwMin),b.wwMax); }

// Morning wake from real data: earliest sleep that ENDED today (prefer night sleep), else 06:30.
function plDefaultWake(){
  const ended = events.filter(e=>e.type==="sleep"&&e.end_at&&isToday(e.end_at))
                      .sort((a,b)=>new Date(a.end_at)-new Date(b.end_at));
  const first = ended.find(e=>e.subtype==="night") || ended[0];
  if(first){ const d=new Date(first.end_at); return pad(d.getHours())+":"+pad(d.getMinutes()); }
  return "06:30";
}
// Real last logged feed → minutes-of-day (or null).
function plRealLastFeedMin(){ const f=lastFeed(); if(!f) return null; const d=new Date(f.start_at); return d.getHours()*60+d.getMinutes(); }

function plRenderAgebar(){
  const b=plCurrentBand();
  $("pl-agebar").innerHTML =
    `<div><span class="pl-num">${ageMonths()}</span><span class="pl-lab">months</span></div>
     <div><span class="pl-num">${ageWeeks()}</span><span class="pl-lab">weeks</span></div>
     <div class="pl-band">${b.label}<span>${b.naps} naps · ~${plDur(plEffectiveWw())} windows · ${b.solids?"+ solids":"milk only"}</span></div>`;
}

function buildPlToday(){
  if(!plWakeTouched) planner.wake = plDefaultWake();
  const b=plCurrentBand(), ww=plEffectiveWw();
  return `<section>
    <div class="pl-controls">
      <label>Morning wake <input type="time" id="pl-wake" value="${planner.wake}"></label>
      <label>Wake window: <b id="pl-wwval">${plDur(ww)}</b>
        <input type="range" id="pl-ww" min="${b.wwMin}" max="${b.wwMax}" value="${ww}">
        <span class="pl-hint">Auto-set from today's log · slide to adjust</span></label>
    </div>
    <div id="pl-today-out"></div></section>`;
}
function renderPlTodayOut(){
  const b=plCurrentBand(), ww=plEffectiveWw(), day=plGenerateDay(plToMin(planner.wake),b,ww);
  const late = day.bed>20*60+30;
  $("pl-today-out").innerHTML =
    `<div class="pl-summary">Predicted bedtime <b>${plFmt(day.bed)}</b> · ${day.naps} naps${late?' <em>— late; try an earlier wake or shorter windows.</em>':''}</div>
     <ul class="pl-timeline">${day.items.map(it=>`<li class="pl-k-${it.kind}"><span class="pl-tt">${plFmt(it.t)}</span><span class="pl-ic">${plIcon(it.kind)}</span><span class="pl-ll">${it.label}${it.len?` <em>· ${plDur(it.len)}</em>`:''}</span></li>`).join("")}</ul>`;
}
function buildPlEvent(){
  return `<section>
    <p class="pl-lead">Enter a fixed event — the planner shows what to do <b>before, during, and after</b> to keep Leo rested and fed.</p>
    <div class="pl-controls">
      <label>What <input type="text" id="pl-evtName" value="${planner.evtName}" placeholder="Breakfast / Flight"></label>
      <label>Time <input type="time" id="pl-evtTime" value="${planner.evtTime}"></label>
      <label>Type <select id="pl-evtType">
        <option value="outing"${planner.evtType==="outing"?" selected":""}>Outing / meal</option>
        <option value="appt"${planner.evtType==="appt"?" selected":""}>Appointment</option>
        <option value="travel"${planner.evtType==="travel"?" selected":""}>Travel / flight</option>
      </select></label>
    </div>
    <div id="pl-event-out"></div></section>`;
}
function renderPlEventOut(){
  const b=plCurrentBand(), ww=plEffectiveWw(), day=plGenerateDay(plToMin(planner.wake),b,ww);
  const e=plAnalyzeEvent(day,b,plToMin(planner.evtTime),planner.evtType,plRealLastFeedMin());
  $("pl-event-out").innerHTML =
    `<div class="pl-status ${e.statusClass}"><b>${planner.evtName||"Event"} at ${plFmt(plToMin(planner.evtTime))}</b><br>${e.windowStatus}</div>
     <div class="pl-bda">
       <div><h3>Before</h3><ul>${e.before.map(x=>`<li>${x}</li>`).join("")}</ul></div>
       <div><h3>During</h3><ul>${e.during.map(x=>`<li>${x}</li>`).join("")}</ul></div>
       <div><h3>After</h3><ul>${e.after.map(x=>`<li>${x}</li>`).join("")}</ul></div>
     </div>
     <div class="pl-mini"><span>Last feed before: <b>${e.lastFeedMin!=null?plFmt(e.lastFeedMin):"—"}</b></span><span>Next nap: <b>${e.nextNap?plFmt(e.nextNap.t):"none due"}</b></span><span>Next feed: <b>${e.nextFeed?plFmt(e.nextFeed.t):"—"}</b></span></div>`;
}
function buildPlWhy(){
  return `<section>${WHY.map((w,i)=>`<div class="acc${planner.open===i?' open':''}" data-i="${i}"><div class="accq">${w[0]}<span>${planner.open===i?'–':'+'}</span></div>${planner.open===i?`<div class="acca">${w[1]}</div>`:''}</div>`).join("")}
    <p class="pl-disc">Population guides, not medical advice. Defer to Dr. León Magaña for Leo's specifics.</p></section>`;
}

function renderPlanner(){
  plRenderAgebar();
  document.querySelectorAll("#pl-subtabs button").forEach(btn=>btn.classList.toggle("on",btn.dataset.v===planner.view));
  const c=$("pl-content");
  if(planner.view==="today"){
    c.innerHTML=buildPlToday(); renderPlTodayOut();
    $("pl-wake").addEventListener("input",e=>{planner.wake=e.target.value;plWakeTouched=true;renderPlTodayOut();});
    $("pl-ww").addEventListener("input",e=>{planner.ww=+e.target.value;plStore.set("ww",planner.ww);$("pl-wwval").textContent=plDur(planner.ww);renderPlTodayOut();});
  } else if(planner.view==="event"){
    c.innerHTML=buildPlEvent(); renderPlEventOut();
    $("pl-evtName").addEventListener("input",e=>{planner.evtName=e.target.value;plStore.set("evtName",planner.evtName);renderPlEventOut();});
    $("pl-evtTime").addEventListener("input",e=>{planner.evtTime=e.target.value;plStore.set("evtTime",planner.evtTime);renderPlEventOut();});
    $("pl-evtType").addEventListener("change",e=>{planner.evtType=e.target.value;plStore.set("evtType",planner.evtType);renderPlEventOut();});
  } else {
    c.innerHTML=buildPlWhy();
    c.querySelectorAll(".acc").forEach(a=>a.addEventListener("click",()=>{const i=+a.dataset.i;planner.open=planner.open===i?-1:i;renderPlanner();}));
  }
}

// ============================================================
//  10b-SLEEP. SLEEP PLAN — age-aware "when to start" + how-to
//  Reads `events` for the real-data progress block; writes nothing.
//  Research basis verified 2026-06 (see citations block at bottom):
//  Gradisar 2016 Pediatrics · Price 2012 Pediatrics · AASM 2006 ·
//  AAP Safe Sleep 2022 · AAP night-feeds guidance.
// ============================================================

// Readiness bands, keyed to age in weeks (reuses ageWeeks()/ageMonths()).
//  <17 wk (~<4 mo) → not yet · 17–25 wk (4–6 mo) → foundation · 26 wk+ (6 mo+) → full
function sleepBand(weeks){
  if (weeks < 17) return { key: "notyet", tone: "amber" };
  if (weeks < 26) return { key: "foundation", tone: "green" };
  return { key: "full", tone: "green" };
}

function sleepBannerHTML(){
  const w = ageWeeks(), mo = ageMonths(), b = sleepBand(w);
  const moWord = mo === 1 ? "month" : "months";
  const wksToSix = Math.max(0, 26 - w);
  if (b.key === "notyet") return `<div class="sl-banner amber">
    <div class="sl-banner-eyebrow">🔴 Not yet — and that's exactly right</div>
    <p>Leo is <b>${mo} ${moWord} (${w} weeks)</b>. Under about 4 months a baby's sleep isn't organized enough to learn to self-settle, and night feeds are still needed. For now: a calm, consistent wind-down — no training. This turns green around 4 months.</p></div>`;
  if (b.key === "foundation") return `<div class="sl-banner green">
    <div class="sl-banner-eyebrow">🟢 Now's the time to start the foundation</div>
    <p>Leo is <b>${mo} ${moWord} (${w} weeks)</b> — in the 4–6 month window where gentle sleep-shaping is appropriate. Start <b>Phase 1</b> below now: same bedtime and wake time, morning light, a short routine, and laying him down drowsy but awake. <b>Keep all his feeds.</b> The more active step (<b>Phase 2 — bedtime fading</b>) has its strongest research support from about 6 months — <b>~${wksToSix} ${wksToSix === 1 ? "week" : "weeks"} away</b> for Leo, so treat it as <em>coming soon</em>, not <em>now</em>.</p></div>`;
  return `<div class="sl-banner green">
    <div class="sl-banner-eyebrow">🟢 Green light — the full plan fits Leo now</div>
    <p>Leo is <b>${mo} ${moWord} (${w} weeks)</b> — past 6 months, where the research is strongest. Both phases below are well-supported. Use Phase 2 (bedtime fading) if he needs more help. Keep feeds unless Dr. León Magaña has guided otherwise.</p></div>`;
}

// Real-data progress: last 7 days from the tracker's `events`.
function sleepProgress(){
  const weekAgo = now().getTime() - 7 * 86400000;
  const after = (iso) => new Date(iso).getTime() >= weekAgo;
  const nightSleeps = events.filter(e => e.type === "sleep" && e.subtype === "night" && e.end_at && after(e.start_at));
  // Longest single night block.
  let longest = 0;
  nightSleeps.forEach(e => { const d = new Date(e.end_at) - new Date(e.start_at); if (d > longest) longest = d; });
  // Typical bedtime: the EARLIEST evening (17:00–23:59) night-sleep onset per date, averaged.
  // (Excludes post-midnight resettles so the clock-average isn't dragged into the afternoon.)
  const firstByDate = {};
  nightSleeps.forEach(e => {
    const d = new Date(e.start_at);
    if (d.getHours() < 17) return;
    const key = d.toDateString(), mins = d.getHours() * 60 + d.getMinutes();
    if (firstByDate[key] === undefined || mins < firstByDate[key]) firstByDate[key] = mins;
  });
  const bedtimes = Object.values(firstByDate);
  const bedAvg = bedtimes.length ? Math.round(bedtimes.reduce((a, b) => a + b, 0) / bedtimes.length) : null;
  // Distinct nights = calendar dates with any night sleep.
  const nights = new Set(nightSleeps.map(e => new Date(e.start_at).toDateString())).size;
  // Independent onsets: a sleep NOT preceded by a feed ending within 20 min.
  const sleeps = events.filter(e => e.type === "sleep" && after(e.start_at));
  const feeds = events.filter(e => e.type === "breast" || e.type === "bottle");
  let indep = 0;
  sleeps.forEach(s => {
    const ss = new Date(s.start_at).getTime();
    const fedBefore = feeds.some(f => { const fe = new Date(f.end_at || f.start_at).getTime(); return fe <= ss && ss - fe <= 20 * 60000; });
    if (!fedBefore) indep++;
  });
  const pct = sleeps.length ? Math.round((indep / sleeps.length) * 100) : null;
  return { nights, longest, bedAvg, pct, total: sleeps.length };
}
function sleepProgressHTML(){
  const p = sleepProgress();
  if (p.total < 3) return `<div class="sl-progress"><p class="sl-prog-empty">Log a few nights of sleep and feeds and Leo's real numbers show up here.</p></div>`;
  const longest = p.longest ? plDur(Math.round(p.longest / 60000)) : "—";
  const bed = p.bedAvg != null ? plFmt(p.bedAvg) : "—";
  const pct = p.pct != null ? p.pct + "%" : "—";
  return `<div class="sl-progress">
    <div class="sl-prog-tiles">
      <div><span class="sl-prog-num">${longest}</span><span class="sl-prog-lab">longest night stretch</span></div>
      <div><span class="sl-prog-num">${bed}</span><span class="sl-prog-lab">typical bedtime</span></div>
      <div><span class="sl-prog-num">${pct}</span><span class="sl-prog-lab">onsets without a feed</span></div>
    </div>
    <p class="sl-prog-note">From Leo's last 7 days (${p.nights} ${p.nights === 1 ? "night" : "nights"} logged). The numbers to watch: <b>longest stretch trending up</b>, and <b>more onsets without a feed</b>.</p>
  </div>`;
}

// Static plan content (research-softened per the M0 ledger).
const SLEEP_GATE = `<div class="sl-gate"><b>One thing stays separate from all of this:</b> whether and when to drop night feeds is a <b>weight-and-doctor decision, not a sleep decision.</b> Leo is partly breastfed and was in catch-up growth, so his night feeds may be nutritionally important — <b>keep them until Dr. León Magaña reviews his weight and says otherwise.</b> You can teach Leo to fall asleep on his own <em>while keeping every feed.</em></div>`;

const SLEEP_REASSURE = `<div class="sl-reassure">
  <h2>First, what this is not</h2>
  <ul>
    <li>We are <b>not</b> leaving Leo to cry alone.</li>
    <li>We are <b>not</b> taking away his night feeds — he keeps them for now.</li>
    <li>We are <b>not</b> rushing. We move only as fast as he's ready.</li>
    <li>We are <b>not</b> following anyone's "rules" — we adjust to Leo.</li>
  </ul>
  <p class="sl-closer">A study that followed babies to age 6 found no harm to attachment, stress, or behaviour — and no lasting downside either. Gentle and effective aren't opposites.</p>
</div>`;

const SLEEP_BODY = `
  <h2>The one idea behind all of it</h2>
  <p class="sl-lead">Everything below comes from a single fact about how Leo sleeps now.</p>
  <div class="sl-card">
    <p>Around 4 months, a baby's sleep gradually matures into <span class="sl-big">cycles</span> of about 50–60 minutes, and Leo briefly surfaces between them. <b>Everyone does this, adults too</b> — we just roll over and drift back without remembering. (The popular "four-month sleep regression" is really this normal change, not a true regression.)</p>
    <p>The whole goal is helping Leo do the same — <b>drift back on his own.</b> If the only way he knows how to fall asleep is on the bottle or in our arms, then every time he surfaces at night he needs us to recreate that to get back down. Teaching him to fall asleep <em>by himself at bedtime</em> is what lets him resettle by himself at 2am.</p>
  </div>

  <h2>The order we follow</h2>
  <p class="sl-lead">This sequence matters — we don't skip ahead.</p>
  <div class="sl-card sl-order">
    <div class="sl-ostep"><div class="sl-onum">1</div><div><div class="sl-ot">Falling asleep on his own</div><div class="sl-od">At bedtime first. This is the whole foundation.</div></div></div>
    <div class="sl-ostep"><div class="sl-onum">2</div><div><div class="sl-ot">Longer stretches at night</div><div class="sl-od">These come naturally once step 1 clicks.</div></div></div>
    <div class="sl-ostep last"><div class="sl-onum">3</div><div><div class="sl-ot">Fewer night feeds — much later</div><div class="sl-od">Only when his weight &amp; the doctor say so. Not now.</div></div></div>
  </div>

  <h2>Our bedtime, in order</h2>
  <p class="sl-lead">Same steps, same order, every night. The key change: feed comes <em>early</em>, not last.</p>
  <div class="sl-flow">
    <span class="sl-chip">Feed (awake)</span><span class="sl-arrow">→</span>
    <span class="sl-chip">Sleep sack</span><span class="sl-arrow">→</span>
    <span class="sl-chip">Dark room</span><span class="sl-arrow">→</span>
    <span class="sl-chip">Book or song</span><span class="sl-arrow">→</span>
    <span class="sl-chip key">Into crib drowsy but awake</span>
  </div>
  <div class="sl-card">
    <p>The most important step is the last one: <b>laying Leo down while he's still awake</b> — sleepy, but eyes open. That's the moment he practices falling asleep himself. Many babies don't settle easily at first, so it's the <em>goal we aim for</em>, not a switch that flips overnight. Mike leads bedtime; the dream feed (~10:15) stays, in the dark.</p>
  </div>

  <h2>How we start</h2>
  <div class="sl-phase">
    <div class="sl-ph-head"><span>Phase 1 · Settle the basics</span><span class="sl-when">Nights 1–4</span></div>
    <div class="sl-ph-body">
      <ul>
        <li>Same bedtime (~6:30–7:00) and same morning wake time every day.</li>
        <li>Morning light soon after he's up — light is the body's main clock-setter and helps anchor his rhythm.</li>
        <li>Run the bedtime steps above, every night.</li>
        <li>Lay him down drowsy but awake. That's it — no "training" yet.</li>
      </ul>
      <p class="sl-note"><em>Many babies improve from this alone. We give it 4 nights before doing anything more.</em></p>
    </div>
  </div>
  <div class="sl-phase">
    <div class="sl-ph-head"><span>Phase 2 · Gentle help (only if needed)</span><span class="sl-when">Nights 5+ · ~6 mo</span></div>
    <div class="sl-ph-body">
      <ul>
        <li>If he's still fighting it, start bedtime at the time he <em>actually</em> falls asleep now — so going down feels easy and he succeeds.</li>
        <li>Then move bedtime ~15 minutes earlier every few nights, back toward our target.</li>
        <li>Always drowsy but awake. No leaving him alone to cry.</li>
      </ul>
      <p class="sl-note"><em>This "bedtime fading" is an established technique; its strongest evidence is from about 6 months — so it pairs with Leo reaching that mark. Naps are harder and come later; we don't judge progress by naps in the first week.</em></p>
    </div>
  </div>

  <div class="sl-together">
    <div class="sl-together-k">The thing that makes or breaks it</div>
    <p>We both have to do it <b>the same way.</b> If one of us lays Leo down awake and the other feeds him fully to sleep, he gets mixed signals and it takes much longer — and feels harder on him. So before each night: <b>same method, same steps, both of us.</b> When one of us is unsure, we check with each other, not switch on the fly.</p>
  </div>

  <h2>Easy slip-ups to avoid</h2>
  <div class="sl-miss"><div class="sl-mt">Keeping him up too long</div><div class="sl-mw">An overtired baby tends to sleep more fragmented and wake more overnight. Watch his cues, don't stretch the window.</div></div>
  <div class="sl-miss"><div class="sl-mt">Feeding all the way to sleep</div><div class="sl-mw">It's the comfiest shortcut, but it's the main reason for night wakings now. Feed early, settle separately.</div></div>
  <div class="sl-miss"><div class="sl-mt">Rushing in at the first sound</div><div class="sl-mw">A little noise between cycles is normal. Pause, listen — give him a chance to resettle before going in.</div></div>
  <div class="sl-miss"><div class="sl-mt">Stopping after a few nights</div><div class="sl-mw">If we start and then give up mid-way, it can teach him that fussing longer works. We pick a plan and hold it.</div></div>

  <h2>How we'll know</h2>
  <p class="sl-lead">Leo's real numbers from the tracker — plus what to look and watch for.</p>`;

const SLEEP_FLAGS = `
  <div class="sl-flags">
    <div class="sl-flag green">
      <div class="sl-ft">It's working when…</div>
      <ul>
        <li>His first stretch gets longer week by week</li>
        <li>He falls asleep within ~20 min without the bottle</li>
        <li>He settles back at some wake-ups on his own</li>
      </ul>
    </div>
    <div class="sl-flag red">
      <div class="sl-ft">Check with Dr. León Magaña if…</div>
      <ul>
        <li>His weight gain stalls or drops</li>
        <li>Snoring, gasping, or pauses in his breathing</li>
        <li>He seems genuinely hungry at night, not just habit</li>
        <li>Anything feels off to either of us — trust that</li>
      </ul>
    </div>
  </div>`;

const SLEEP_CITE = `
  <details class="sl-cite">
    <summary>The research behind this</summary>
    <ul>
      <li><b>Gentle methods don't harm babies</b> — a small randomized trial (Gradisar et al., 2016, <i>Pediatrics</i>; 43 infants 6–16 mo) found graduated extinction and bedtime fading improved sleep with no rise in stress hormones and no effect on attachment at 12 months.</li>
      <li><b>No lasting downside</b> — a 5-year follow-up (Price et al., 2012, <i>Pediatrics</i>) found no harm to behaviour, stress, or parent-child attachment at age 6 (and no lasting benefit either).</li>
      <li><b>Sleep cycles</b> mature gradually across ~3–6 months into ~50–60 min cycles, with brief arousals between them (pediatric sleep reviews).</li>
      <li><b>Bedtime fading</b> is an established behavioural technique (AASM practice parameters, Morgenthaler et al., 2006).</li>
      <li><b>Night feeds</b> are commonly still needed by breastfed babies under ~6 months; dropping them is a weight/medical decision (AAP / HealthyChildren.org).</li>
      <li><b>Safe sleep</b> (AAP, 2022): back to sleep, room-sharing without bed-sharing for at least the first 6 months, firm flat surface, no soft bedding.</li>
    </ul>
    <p class="sl-cite-note">Population research — not medical advice for Leo. Dr. León Magaña has the final word.</p>
  </details>`;

const SLEEP_FOOTER = `<div class="sl-footer"><p class="sl-heart">For Emma &amp; Leo 🤍</p><p>A plan, not a rulebook. Leo leads — we adjust with him, together.</p></div>`;

function renderSleep(){
  $("sleep-content").innerHTML =
    sleepBannerHTML() + SLEEP_REASSURE + SLEEP_GATE + SLEEP_BODY +
    sleepProgressHTML() + SLEEP_FLAGS + SLEEP_CITE + SLEEP_FOOTER;
}

// ============================================================
//  10c. ACTIVITY SUMMARY — compact text we send to Claude
// ============================================================
function activitySummary() {
  const today = events.filter((e) => isToday(e.start_at)).slice().reverse(); // chronological
  const lines = today.map((e) => {
    const t = clockTime(new Date(e.start_at));
    if (e.type === "breast") return `${t} Breast ${e.subtype === "left" ? "L" : "R"} (${e.end_at ? mmss(new Date(e.end_at) - new Date(e.start_at)) : "ongoing"})`;
    if (e.type === "bottle") return `${t} Bottle ${e.amount_ml || 0}ml`;
    if (e.type === "sleep") return `${t} Sleep ${e.subtype || "?"} (${e.end_at ? clockMins((new Date(e.end_at) - new Date(e.start_at)) / 60000) : "ongoing"})`;
    if (e.type === "milestone") return `${t} Milestone: ${e.note || ""}`;
    return `${t} ${e.type}`;
  });
  const sleeping = openSleep();
  let status;
  if (sleeping) status = "Right now: asleep.";
  else { const last = lastEndedSleep(); status = last ? `Right now: awake ${clockMins((now() - new Date(last.end_at)) / 60000)} since the last nap ended.` : "No sleep logged yet today."; }
  return (lines.length ? lines.join("\n") + "\n" : "") + status;
}

// ============================================================
//  10d. TODAY'S INSIGHT — Claude via the Edge Function (cached ~2h)
// ============================================================
const INSIGHT_KEY = "leo_insight_v1";
const INSIGHT_TTL = 30 * 60 * 1000; // 30 min — keep the tip aligned with the current part of the day

function setInsightStamp(at) {
  const el = $("insight-stamp");
  if (el) el.textContent = at ? `as of ${clockTime(new Date(at))}` : "";
}

async function loadInsight(force) {
  const box = $("insight-text");
  const card = box.closest(".insight-card");
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(INSIGHT_KEY) || "null"); } catch (_) {}

  if (!force && cached) {
    box.textContent = cached.text;            // show the cached tip instantly
    setInsightStamp(cached.at);
    if (Date.now() - cached.at < INSIGHT_TTL) return;   // still fresh — done
    // stale: refresh quietly in the background, keep the old tip on screen
  } else {
    card.classList.add("loading");
    box.textContent = "Thinking about Leo…";
  }

  try {
    const { data, error } = await sb.functions.invoke("ask-leo", { body: { mode: "insight", activity: activitySummary(), ...aiContext() } });
    card.classList.remove("loading");
    if (error || !data || data.error || !data.reply) {
      if (!cached) box.textContent = "Couldn't reach the assistant yet. (Deploy the ask-leo function + set the API key.)";
      return;
    }
    const at = Date.now();
    box.textContent = data.reply;
    setInsightStamp(at);
    localStorage.setItem(INSIGHT_KEY, JSON.stringify({ text: data.reply, at }));
  } catch (_) {
    card.classList.remove("loading");
    if (!cached) box.textContent = "Couldn't reach the assistant yet.";
  }
}

// ============================================================
//  10e. STATS
// ============================================================
function inRange(iso) {
  const d = new Date(iso), t = now();
  const start = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  start.setDate(start.getDate() - (statsRange - 1));
  return d >= start;
}
function renderStats() {
  if (!$("s-day")) return;   // Stats tab removed from the UI — nothing to draw
  const sel = events.filter((e) => inRange(e.start_at));
  let dayMs = 0, nightMs = 0, napCount = 0, breastMs = 0, breastCount = 0, bottleCount = 0, bottleMl = 0;
  for (const e of sel) {
    if (e.type === "sleep" && e.end_at) {
      const s = new Date(e.end_at) - new Date(e.start_at);
      if (e.subtype === "night") nightMs += s; else { dayMs += s; napCount++; }
    }
    if (e.type === "breast") { breastCount++; if (e.end_at) breastMs += new Date(e.end_at) - new Date(e.start_at); }
    if (e.type === "bottle") { bottleCount++; bottleMl += e.amount_ml || 0; }
  }
  const hrs = (ms) => `${(ms / 3600000).toFixed(1)}h`;
  $("s-day").textContent = `${napCount} · ${hrs(dayMs)}`;
  $("s-night").textContent = hrs(nightMs);
  $("s-total").textContent = hrs(dayMs + nightMs);
  $("s-avgnap").textContent = napCount ? `${Math.round(dayMs / napCount / 60000)}m` : "—";
  $("s-breast").textContent = breastCount;
  $("s-breasttime").textContent = `${Math.round(breastMs / 60000)}m`;
  $("s-bottle").textContent = bottleCount;
  $("s-bottleml").textContent = `${bottleMl} ml`;
  renderChart();
}
function renderChart() {
  const canvas = $("sleep-chart");
  if (!canvas || !window.Chart) return;
  if (!sleepChart && canvas.offsetParent === null) return; // hidden — build when tab opens
  const labels = [], dayData = [], nightData = [];
  const t = now();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
    labels.push(d.toLocaleDateString([], { weekday: "short" }));
    let day = 0, night = 0;
    for (const e of events) {
      if (e.type !== "sleep" || !e.end_at) continue;
      const s = new Date(e.start_at);
      if (s.getFullYear() === d.getFullYear() && s.getMonth() === d.getMonth() && s.getDate() === d.getDate()) {
        const h = (new Date(e.end_at) - s) / 3600000;
        if (e.subtype === "night") night += h; else day += h;
      }
    }
    dayData.push(+day.toFixed(1)); nightData.push(+night.toFixed(1));
  }
  if (sleepChart) {
    sleepChart.data.labels = labels;
    sleepChart.data.datasets[0].data = dayData;
    sleepChart.data.datasets[1].data = nightData;
    sleepChart.update();
    return;
  }
  sleepChart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [
      { label: "Day", data: dayData, backgroundColor: "#e0b15a" },
      { label: "Night", data: nightData, backgroundColor: "#5e9479" },
    ] },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#b9a6b6" } } },
      scales: {
        x: { stacked: true, ticks: { color: "#b9a6b6" }, grid: { display: false } },
        y: { stacked: true, ticks: { color: "#b9a6b6" }, grid: { color: "#36283d" } },
      },
    },
  });
}

// ============================================================
//  10g. CHAT — talk to Claude about Leo
// ============================================================
async function loadMessages() {
  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: true });
  if (error) { console.error(error); return; }
  chat = data || [];
  renderChat();
}
function scrollChat() { const l = $("chat-list"); if (l) l.scrollTop = l.scrollHeight; }
function renderChat() {
  const list = $("chat-list");
  if (!list) return;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (!chat.length && !chatBusy) {
    list.innerHTML = '<div class="chat-hint">Ask Claude anything about Leo — sleep, naps, feeding, milestones. Answers use his age, your gentle-parenting approach, and his logged data. 💞</div>';
    return;
  }
  list.innerHTML = "";
  for (const m of chat) {
    const b = document.createElement("div");
    b.className = "bubble " + (m.role === "assistant" ? "assistant" : "user");
    b.textContent = m.content;
    list.appendChild(b);
  }
  if (chatBusy) {
    const tb = document.createElement("div");
    tb.className = "bubble typing";
    tb.textContent = "Claude is thinking…";
    list.appendChild(tb);
  }
  if (atBottom || chatBusy) scrollChat();
}
async function sendChat(e) {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || chatBusy) return;
  input.value = "";
  await sb.from("messages").insert({ role: "user", content: text });
  await loadMessages();
  chatBusy = true;
  renderChat();
  const history = chat.slice(-20).map((m) => ({ role: m.role, content: m.content }));
  try {
    const { data, error } = await sb.functions.invoke("ask-leo", { body: { mode: "chat", messages: history, activity: activitySummary(), ...aiContext() } });
    chatBusy = false;
    const reply = (!error && data && !data.error && data.reply)
      ? data.reply
      : "(Sorry — I couldn't reach the assistant. Make sure the ask-leo function is deployed and the API key is set.)";
    await sb.from("messages").insert({ role: "assistant", content: reply });
    await loadMessages();
  } catch (_) {
    chatBusy = false;
    renderChat();
  }
}

// ============================================================
//  10h. LEO HOME — sleep-first default screen
//  Everything here reads wakeState() / sleepDayStats() / cfgNow().
//  renderLeoWake + tickNow are live (per second). renderRhythm,
//  renderLeoData and renderNightMetrics are data-driven (loadEvents).
// ============================================================

const pctOfDay = (min) => Math.max(0, Math.min(100, (min / 1440) * 100));

// ---- Headline. The window is shown as a RANGE. A single "closes at 7:17"
// is what produced the panic put-downs: it reads as a deadline you're failing,
// so you put down a baby who isn't tired yet and bedtime turns into a fight.
function renderLeoWake() {
  const card = $("leo-wake");
  if (!card) return;
  const cfg = cfgNow();
  const w = wakeState(null, cfg);
  const track = $("leo-ww-track");
  renderSleepActions(w, cfg);

  if (w.asleep) {
    const night = w.asleep.subtype === "night";
    card.className = "card wake-card zone-green";
    $("leo-wake-eyebrow").textContent = night ? "Asleep for the night 🌙" : "Napping for 💤";
    $("leo-wake-time").textContent = dur(now() - new Date(w.asleep.start_at));
    $("leo-wake-status").textContent = night
      ? "Tap End sleep when he's up for the day"
      : `Wake him by ${plFmt(hhmmToMin(cfg.naps.lastNapCutoff))} — later steals bedtime`;
    track.classList.add("hidden");
    return;
  }

  $("leo-wake-eyebrow").textContent = "Awake for";
  if (!w.wokeAt) {
    $("leo-wake-time").textContent = "—";
    $("leo-wake-status").textContent = "Log a sleep to start the wake window";
    card.className = "card wake-card zone-green";
    track.classList.add("hidden");
    return;
  }

  $("leo-wake-time").textContent = dur(now() - w.wokeAt);
  const label = w.isLastOfDay ? "Bedtime window" : w.isFirstOfDay ? "First window" : "Window";
  $("leo-wake-status").innerHTML = w.zone === "early"
    ? `${label} opens <b>${clockTime(w.opensAt)}</b> — not tired yet`
    : `${label}: <b>${clockTime(w.opensAt)} – ${clockTime(w.closesAt)}</b>`;
  card.className = `card wake-card zone-${w.zone}`;

  track.classList.remove("hidden");
  const scale = w.windowMax + 30;                 // headroom so overshoot stays visible
  $("leo-ww-fill").style.width = Math.min(100, (w.awakeMin / scale) * 100) + "%";
  const band = $("leo-ww-band");
  band.style.left  = (w.windowMin / scale) * 100 + "%";
  band.style.width = ((w.windowMax - w.windowMin) / scale) * 100 + "%";
}

// ---- Start nap / Start bedtime. Rebuilt only when the choice actually changes,
// because replacing a button every second makes it impossible to tap.
let _sleepActionsSig = null;
function renderSleepActions(w, cfg) {
  const host = $("leo-sleep-actions");
  if (!host) return;
  // Bedtime only becomes a plausible choice within ~3h of the earliest bedtime.
  const bedtimeNear = minOfDay(now()) >= hhmmToMin(cfg.night.bedtimeEarliest) - 180;
  const sig = w.asleep ? `end:${w.asleep.id}` : `start:${bedtimeNear}`;
  if (sig === _sleepActionsSig) return;
  _sleepActionsSig = sig;
  host.innerHTML = "";

  const mk = (cls, text, fn) => {
    const b = document.createElement("button");
    b.className = `btn ${cls}`;
    b.textContent = text;
    b.addEventListener("click", fn);
    host.appendChild(b);
    return b;
  };
  if (w.asleep) {
    mk("btn-sleep btn-block active", "End sleep", () => endSleep());
  } else if (bedtimeNear) {
    mk("btn-sleep", "😴 Start nap", () => startSleep("nap"));
    mk("btn-ghost", "🌙 Start bedtime", () => startSleep("night"));
  } else {
    mk("btn-sleep btn-block", "😴 Start nap", () => startSleep("nap"));
  }
}

// ---- Today's rhythm. Static layer rebuilt on data change only.
function renderRhythm() {
  const host = $("leo-db-static");
  if (!host) return;
  const cfg = cfgNow();
  const st = sleepDayStats();
  const w = wakeState(null, cfg);

  const cutoff = pctOfDay(hhmmToMin(cfg.naps.lastNapCutoff));
  const bedLo  = pctOfDay(hhmmToMin(cfg.night.bedtimeEarliest));
  const bedHi  = pctOfDay(hhmmToMin(cfg.night.bedtimeLatest));

  let html = "";
  // Everything after the nap cutoff is dimmed and hatched — a nap in there is
  // the single most reliable way to wreck bedtime.
  html += `<div class="db-cutoff-fill" style="left:${cutoff}%"></div>`;
  html += `<div class="db-bedwin" style="left:${bedLo}%;width:${Math.max(0, bedHi - bedLo)}%"></div>`;
  html += `<div class="db-cutoff-mark" style="left:${cutoff}%" data-t="${plFmt(hhmmToMin(cfg.naps.lastNapCutoff))}"></div>`;
  for (const b of st.blocks) {
    html += `<div class="leo-blk ${b.kind}${b.running ? " running" : ""}" style="left:${b.left}%;width:${b.width}%"></div>`;
  }
  // Ghost block: where the next sleep is predicted to land.
  if (!w.asleep && w.opensAt) {
    const l = pctOfDay(minOfDay(w.opensAt)), r = pctOfDay(minOfDay(w.closesAt));
    if (r > l) html += `<div class="db-proj" style="left:${l}%;width:${r - l}%"></div>`;
  }
  host.innerHTML = html;

  // Chips carry the nap text. At 375px a 45-minute nap is 10 pixels wide inside
  // the bar — no label was ever going to fit in there.
  const chips = $("leo-nap-chips");
  chips.innerHTML = st.naps.length
    ? st.naps.map((b, i) =>
        `<span class="db-chip${b.running ? " on" : ""}${!b.running && b.fullMins < cfg.naps.minUsefulNap ? " short" : ""}">` +
        `Nap ${i + 1} · ${clockTime(b.startAt)} · ${b.running ? "now" : plDur(Math.round(b.fullMins))}</span>`).join("")
    : `<span class="db-chip muted">No naps logged yet</span>`;

  const cap = cfg.naps.maxCount;
  $("leo-nap-pips").innerHTML =
    `<span class="pips${st.napCount >= cfg.naps.minCount && st.napCount <= cap ? " met" : ""}">` +
    "●".repeat(Math.min(st.napCount, cap)) + "○".repeat(Math.max(0, cap - st.napCount)) +
    (st.napCount > cap ? "●".repeat(st.napCount - cap) : "") + `</span>` +
    `<span class="db-pips-lab">${st.napCount} of ${cfg.naps.minCount}–${cap} naps` +
    (st.napCount > cap ? " · over the usual cap" : st.napCount === cap ? " · cap reached" : "") + `</span>`;

  $("leo-db-total").textContent = `${plDur(st.napMins)} day sleep`;
  tickNow();
}

// ---- The ONLY thing the per-second tick touches on the day-bar.
function tickNow() {
  const el = $("leo-db-now");
  if (!el) return;
  const t = now();
  el.style.left = pctOfDay(minOfDay(t)) + "%";
  const st = sleepDayStats(null, t);
  const w = wakeState(null, null, t);
  let tail;
  if (w.asleep) tail = `asleep now for ${dur(t - new Date(w.asleep.start_at))}`;
  else if (w.wokeAt) tail = `awake now for ${dur(t - w.wokeAt)}`;
  else tail = "no sleep logged yet";
  const s = $("leo-db-summary");
  if (s) s.textContent = `${plDur(Math.round(st.sleptMs / 60000))} asleep so far today · ${tail}`;
}

// Average of today's completed wake windows (gap between a sleep ending and the next starting).
function avgWakeWindowMins() {
  const s = events.filter((e) => e.type === "sleep" && isToday(e.start_at))
                  .slice().sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const gaps = [];
  for (let i = 0; i < s.length; i++) {
    if (!s[i].end_at) continue;
    const wakeEnd = new Date(s[i].end_at).getTime();
    const next = s.slice(i + 1).find((x) => new Date(x.start_at).getTime() >= wakeEnd);
    if (next) gaps.push((new Date(next.start_at).getTime() - wakeEnd) / 60000);
  }
  return gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
}

// Average morning wake over the last 7 nights, for the bedtime projection.
function averageMorningWake(cfg, t) {
  const T = t || now();
  const from = T.getTime() - 7 * 86400000;
  const mins = [];
  for (const e of events) {
    if (e.type !== "sleep" || e.subtype !== "night" || !e.end_at) continue;
    const d = new Date(e.end_at);
    if (d.getTime() < from) continue;
    const m = minOfDay(d);
    if (m >= 240 && m <= 600) mins.push(m);         // 4–10am counts as "up for the day"
  }
  const avg = mins.length >= 3
    ? mins.reduce((a, b) => a + b, 0) / mins.length
    : hhmmToMin(cfg.night.morningWakeEarliest);
  const d = new Date(T.getFullYear(), T.getMonth(), T.getDate() + 1);
  d.setMinutes(Math.round(avg));
  return d;
}

// Projected bedtime: last nap end + the longest window of the day, clamped into
// the age-appropriate bedtime window. A projection, not a target — it moves with him.
function projectTonight(cfg, st, t) {
  const T = t || now();
  const anchor = st.lastNapEnd || (wakeState(null, cfg, T).wokeAt);
  if (!anchor) return null;
  let bed = new Date(anchor.getTime() + cfg.ww.lastOfDay * 60000);
  const lo = atToday(cfg.night.bedtimeEarliest, T), hi = atToday(cfg.night.bedtimeLatest, T);
  if (bed < lo) bed = lo;
  if (bed > hi) bed = hi;
  const wake = averageMorningWake(cfg, T);
  return { bed, wake, mins: Math.round((wake - bed) / 60000) };
}

// ---- Sleep budget. This card used to say "~4h 26m more to reach 13h", which was
// wrong twice over: the 13–15h norm INCLUDES night sleep, and it compared a
// part-day number to a whole-day goal. Now it tracks DAY sleep against the day
// cap, and projects the night separately.
function renderLeoData() {
  const g = $("leo-gauge");
  if (!g) return;
  const cfg = cfgNow();
  const st = sleepDayStats();
  const day = st.napMins;
  const { totalDayMin, totalDayMax } = cfg.naps;

  const fillPct = Math.min(100, (day / totalDayMax) * 100);
  const bandLeft = (totalDayMin / totalDayMax) * 100;
  const over = day > totalDayMax;
  const inRange = day >= totalDayMin && !over;

  const proj = projectTonight(cfg, st);
  const r24 = sleepRolling24hMin();
  const [n24lo, n24hi] = cfg.totals.healthy24h;

  g.innerHTML =
    `<div class="leo-gauge-num">${plDur(day)} <small>day sleep · target ${plDur(totalDayMin)}–${plDur(totalDayMax)}</small></div>` +
    `<div class="leo-gauge-bar">` +
      `<div class="leo-gauge-fill${over ? " over" : inRange ? " met" : ""}" style="width:${fillPct}%"></div>` +
      `<div class="leo-gauge-band" style="left:${bandLeft}%;right:0"></div>` +
    `</div>` +
    (proj
      ? `<div class="leo-proj"><span class="leo-proj-lab">Tonight, projected</span>` +
        `<span class="leo-proj-val">asleep ~<b>${clockTime(proj.bed)}</b> → ~<b>${clockTime(proj.wake)}</b> ≈ ${plDur(proj.mins)}</span></div>`
      : "");

  const cap = $("leo-gauge-cap");
  const r24line = `<span class="leo-24h">${plDur(r24)} in the last 24h — norm ${plDur(n24lo)}–${plDur(n24hi)}.</span>`;
  if (over) {
    cap.innerHTML = `Day sleep is <b>over the usual cap</b>. More naps now usually means a harder bedtime and more night waking, not less. ${r24line}`;
  } else if (inRange) {
    cap.innerHTML = `Day sleep is in range for ${cfg.band} ✓ The rest should come overnight. ${r24line}`;
  } else {
    cap.innerHTML = `${plDur(Math.max(0, totalDayMin - day))} below the usual day-sleep range — fine if bedtime is close. ${r24line}`;
  }

  const p = sleepProgress();
  $("leo-longest").textContent = p.longest ? plDur(Math.round(p.longest / 60000)) : "—";
  const aww = avgWakeWindowMins();
  $("leo-avgww").textContent = aww != null ? plDur(aww) : "—";

  renderProvenance(cfg);
  renderNightMetrics(cfg);
}

// ---- The line that makes a wrong setting impossible to hide. It prints the band
// the numbers came from, right next to the numbers. That is the whole point: the
// old 90-minute window survived three months because nothing ever showed its age.
function renderProvenance(cfg) {
  const el = $("leo-cfg-prov");
  if (!el) return;
  const short = (m) => (m % 60 ? `${Math.floor(m / 60)}h${pad(m % 60)}` : `${Math.floor(m / 60)}h`);
  const n = cfg.meta.overridden.length;
  el.textContent = `${cfg.band} · ${short(cfg.ww.min)}–${short(cfg.ww.max)}` + (n ? ` · ${n} custom` : "") + " ›";
}

// ---- Night patterns: day/night feed split + wakes per night (7 days).
// Both are pure derivations over rows we already have — no new logging.
function feedRatio7d(t) {
  const T = t || now();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(T.getFullYear(), T.getMonth(), T.getDate() - i);
    const s = d.getTime(), e = s + 86400000;
    let night = 0, total = 0;
    for (const ev of events) {
      if (ev.type !== "breast" && ev.type !== "bottle") continue;
      const at = new Date(ev.start_at).getTime();
      if (at < s || at >= e) continue;
      total++;
      const m = minOfDay(new Date(at));
      if (m >= 19 * 60 || m < 6 * 60) night++;      // 7pm–6am
    }
    days.push({ d, night, total, pct: total ? (night / total) * 100 : 0 });
  }
  const tn = days.reduce((a, x) => a + x.night, 0), tt = days.reduce((a, x) => a + x.total, 0);
  const nightPct = tt ? (tn / tt) * 100 : 0;
  return { days, nightPct, flag: tt >= 10 && nightPct > 35 };
}

function nightWakes7d(t) {
  const T = t || now();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    // A "night" is the evening of day i through the following morning.
    const d = new Date(T.getFullYear(), T.getMonth(), T.getDate() - i);
    const from = d.getTime() + 19 * 60 * 60000, to = d.getTime() + 30 * 60 * 60000; // 7pm → 6am
    let fed = 0, unfed = 0;
    for (const ev of events) {
      if (ev.type !== "sleep" || ev.subtype !== "night" || !ev.end_at) continue;
      const end = new Date(ev.end_at).getTime();
      if (end < from || end >= to) continue;
      // Only a wake if he went back to sleep — otherwise it's the morning.
      const back = events.some((x) => x.type === "sleep" && new Date(x.start_at).getTime() > end &&
                                      new Date(x.start_at).getTime() < end + 4 * 3600000);
      if (!back) continue;
      const withFeed = events.some((x) => (x.type === "breast" || x.type === "bottle") &&
        Math.abs(new Date(x.start_at).getTime() - end) <= 20 * 60000);
      if (withFeed) fed++; else unfed++;
    }
    days.push({ d, fed, unfed, total: fed + unfed });
  }
  return days;
}

function renderNightMetrics(cfg) {
  const host = $("leo-night-metrics");
  if (!host) return;
  const fr = feedRatio7d();
  const nw = nightWakes7d();
  const maxW = Math.max(1, ...nw.map((x) => x.total));
  const dayLab = (d) => ["S", "M", "T", "W", "T", "F", "S"][d.getDay()];

  // Seven empty boxes read as "broken", not as "no data yet". Say which it is.
  const anyFeeds = fr.days.some((x) => x.total > 0);
  const anyWakes = nw.some((x) => x.total > 0);
  if (!anyFeeds && !anyWakes) {
    $("leo-night-flag").textContent = "—";
    host.innerHTML = `<p class="nm-lab">Nothing to compare yet. These build up over a week of logged feeds and night wakes.</p>`;
    return;
  }

  $("leo-night-flag").textContent = fr.flag ? "⚠️ night-heavy" : anyFeeds ? `${Math.round(fr.nightPct)}% at night` : "—";

  host.innerHTML =
    `<p class="nm-lab">Feeds at night (7pm–6am), last 7 days</p>` +
    `<div class="nm-row">` + fr.days.map((x) =>
      `<span class="nm-col"><span class="nm-bar"><span class="nm-fill${x.pct > 35 ? " hot" : ""}" style="height:${Math.round(x.pct)}%"></span></span>` +
      `<span class="nm-day">${dayLab(x.d)}</span></span>`).join("") + `</div>` +
    (fr.flag
      ? `<p class="nm-note">More than a third of his feeds are at night. That can be reverse cycling — worth mentioning to Dr. León Magaña rather than fixing with the clock.</p>`
      : "") +
    `<p class="nm-lab">Night wakes — <i class="nm-key fed"></i>with a feed <i class="nm-key unfed"></i>without</p>` +
    `<div class="nm-row">` + nw.map((x) =>
      `<span class="nm-col"><span class="nm-bar">` +
      `<span class="nm-fill unfed" style="height:${Math.round((x.unfed / maxW) * 100)}%"></span>` +
      `<span class="nm-fill fed" style="height:${Math.round((x.fed / maxW) * 100)}%"></span>` +
      `</span><span class="nm-day">${dayLab(x.d)}</span></span>`).join("") + `</div>`;
}

// ============================================================
//  10h-2. SETTINGS — the numbers, editable, without a deploy
// ============================================================
// Reached from ⋯ More, but the path people actually use is the provenance line on
// the home screen — because that's where you are when you doubt a number.
async function onSettingsChanged(payload) {
  const row = payload && payload.new;
  if (!row) return;
  if (row.key === "baby") SETTINGS.baby = { ...SETTINGS.baby, ...row.value };
  if (row.key === "sleep_model") SETTINGS.overrides = (row.value && row.value.overrides) || {};
  settingsRev++;
  try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ baby: SETTINGS.baby, overrides: SETTINGS.overrides })); } catch (e) {}
  render(); renderRhythm(); renderLeoData(); renderAlerts(true); renderSettings();
}

// Minutes get a number box, clock times get a time box. Deliberately not sliders:
// you use this at 3am and a slider can't hit 17:15.
const SETTINGS_FIELDS = [
  { section: "ww", title: "Wake windows", help: "How long he can be happily awake between sleeps. Too short is what causes bedtime fights.", fields: [
    { key: "min", label: "Shortest", type: "min" },
    { key: "target", label: "Typical", type: "min" },
    { key: "max", label: "Longest", type: "min" },
    { key: "firstOfDay", label: "First of the day", type: "min" },
    { key: "lastOfDay", label: "Before bedtime", type: "min" },
  ]},
  { section: "naps", title: "Naps", help: "Day sleep competes with night sleep. The cap matters more than the count.", fields: [
    { key: "minCount", label: "Fewest naps", type: "count" },
    { key: "maxCount", label: "Most naps", type: "count" },
    { key: "totalDayMin", label: "Day sleep — least", type: "min" },
    { key: "totalDayMax", label: "Day sleep — cap", type: "min" },
    { key: "lastNapCutoff", label: "Last nap ends by", type: "time" },
    { key: "minUsefulNap", label: "A nap counts from", type: "min" },
  ]},
  { section: "night", title: "Night", help: "Bedtime is a window, not a time.", fields: [
    { key: "bedtimeEarliest", label: "Bedtime — earliest", type: "time" },
    { key: "bedtimeLatest", label: "Bedtime — latest", type: "time" },
    { key: "morningWakeEarliest", label: "Morning starts at", type: "time" },
    { key: "feedGateMin", label: "Typical feed spacing", type: "min" },
  ]},
  { section: "feeds", title: "Feeds", help: "Only used to predict the next feed.", fields: [
    { key: "perDayMin", label: "Fewest per day", type: "count" },
    { key: "perDayMax", label: "Most per day", type: "count" },
  ]},
];

function nextBandChange() {
  const m = ageMonths(), cur = defaultsForMonth(m);
  if (cur.maxMonth >= 999) return null;
  const d = new Date(BIRTH.getFullYear(), BIRTH.getMonth() + cur.maxMonth + 1, BIRTH.getDate());
  return { at: d, band: defaultsForMonth(cur.maxMonth + 1).band };
}

function renderSettings() {
  const host = $("settings-content");
  if (!host || !tabOpen("settings")) return;
  const cfg = cfgNow();
  const base = defaultsForMonth(cfg.month);
  const nb = nextBandChange();
  host.innerHTML = "";

  const head = document.createElement("section");
  head.className = "card";
  head.innerHTML =
    `<div class="card-head"><h2>Sleep settings</h2></div>` +
    `<p class="set-band">Age band <b>${cfg.band}</b> — chosen from his age, automatically.` +
    (nb ? ` Next change ${nb.at.toLocaleDateString([], { day: "numeric", month: "short" })} → ${nb.band}.` : "") + `</p>` +
    `<p class="set-note">These are guidelines, not medical advice. Everything below auto-updates as Leo grows; change a number only when you have a reason, and it will stick through his next birthday.</p>`;
  host.appendChild(head);

  for (const group of SETTINGS_FIELDS) {
    const card = document.createElement("section");
    card.className = "card";
    const changed = group.fields.some((f) => cfg.meta.overridden.includes(`${group.section}.${f.key}`));
    card.innerHTML = `<div class="card-head"><h2>${group.title}</h2>` +
      (changed ? `<button class="link-btn" data-reset="${group.section}">Reset</button>` : "") + `</div>` +
      `<p class="set-help">${group.help}</p>`;

    const grid = document.createElement("div");
    grid.className = "set-grid";
    for (const f of group.fields) {
      const path = `${group.section}.${f.key}`;
      const val = cfg[group.section][f.key];
      const def = base[group.section][f.key];
      const isCustom = cfg.meta.overridden.includes(path);

      const row = document.createElement("label");
      row.className = "set-row" + (isCustom ? " custom" : "");
      const lab = document.createElement("span");
      lab.className = "set-lab";
      lab.textContent = f.label;
      const inp = document.createElement("input");
      if (f.type === "time") { inp.type = "time"; inp.value = val; }
      else {
        inp.type = "number"; inp.inputMode = "numeric";
        inp.step = f.type === "min" ? "5" : "1";
        inp.min = "0";
        inp.value = val;
      }
      inp.className = "set-inp";
      inp.addEventListener("change", () => {
        const next = { ...SETTINGS.overrides };
        const raw = f.type === "time" ? inp.value : Number(inp.value);
        if (!raw && raw !== 0) { inp.value = val; return; }
        if (JSON.stringify(raw) === JSON.stringify(def)) delete next[path];
        else next[path] = raw;
        saveOverrides(next);
      });
      const hint = document.createElement("span");
      hint.className = "set-hint";
      hint.textContent = f.type === "time" ? `norm ${plFmt(hhmmToMin(def))}` : `norm ${def}${f.type === "min" ? "m" : ""}`;
      row.append(lab, inp, hint);
      grid.appendChild(row);
    }
    card.appendChild(grid);
    host.appendChild(card);
  }

  const foot = document.createElement("section");
  foot.className = "card";
  foot.innerHTML =
    `<p class="set-ref">Reference for ${cfg.band}: about ${plDur(cfg.night.expectedNightSleep[0])}–${plDur(cfg.night.expectedNightSleep[1])} at night, ` +
    `${plDur(cfg.totals.healthy24h[0])}–${plDur(cfg.totals.healthy24h[1])} in 24 hours <b>including</b> the night.</p>` +
    (cfg.meta.overridden.length
      ? `<p class="set-ref">${cfg.meta.overridden.length} value${cfg.meta.overridden.length === 1 ? "" : "s"} changed from the age norm.</p>` +
        `<div id="set-reset-all"><button class="btn btn-ghost btn-block" data-reset="ALL">Reset everything to age norms</button></div>`
      : `<p class="set-ref">Every value is at the age norm.</p>`);
  host.appendChild(foot);

  // Inline two-step confirm — never confirm(), per spec.md.
  host.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => {
    const scope = b.dataset.reset;
    const wrap = document.createElement("span");
    wrap.className = "del-confirm";
    wrap.innerHTML = `<button class="del-yes">Reset</button><button class="del-no">Keep</button>`;
    b.replaceWith(wrap);
    wrap.querySelector(".del-no").addEventListener("click", () => wrap.replaceWith(b));
    wrap.querySelector(".del-yes").addEventListener("click", () => {
      const next = {};
      if (scope !== "ALL") {
        for (const [k, v] of Object.entries(SETTINGS.overrides)) if (!k.startsWith(scope + ".")) next[k] = v;
      }
      saveOverrides(next);
    });
  }));
}

// ============================================================
//  10i. GROWTH — weight/height + WHO percentiles + curves
//  WHO Child Growth Standards, boys. LMS anchors (interpolated
//  between); dense 0–12 mo, sparser after. Percentiles approximate
//  and clearly flagged — confirm with the pediatrician.
// ============================================================

// weight-for-age (kg): [ageMonths, L, M, S]
const WHO_WFA_BOYS = [
  [0,  0.3487, 3.3464, 0.14602],
  [1,  0.2297, 4.4709, 0.13395],
  [2,  0.1970, 5.5675, 0.12385],
  [3,  0.1738, 6.3762, 0.11727],
  [4,  0.1553, 7.0023, 0.11316],
  [5,  0.1395, 7.5105, 0.11080],
  [6,  0.1257, 7.9340, 0.10958],
  [7,  0.1134, 8.2970, 0.10902],
  [8,  0.1021, 8.6151, 0.10882],
  [9,  0.0917, 8.9014, 0.10881],
  [10, 0.0820, 9.1649, 0.10891],
  [11, 0.0730, 9.4122, 0.10906],
  [12, 0.0644, 9.6479, 0.10925],
  [15, 0.0408, 10.3108, 0.10995],
  [18, 0.0194, 10.9385, 0.11080],
  [21, 0.0000, 11.5486, 0.11168],
  [24, -0.0181, 12.1515, 0.11250],
];
// length/height-for-age (cm): WHO uses L=1 → [ageMonths, M, S]
const WHO_LFA_BOYS = [
  [0,  49.8842, 0.03795],
  [1,  54.7244, 0.03557],
  [2,  58.4249, 0.03424],
  [3,  61.4292, 0.03328],
  [4,  63.8860, 0.03257],
  [5,  65.9026, 0.03204],
  [6,  67.6236, 0.03165],
  [7,  69.1645, 0.03139],
  [8,  70.5994, 0.03119],
  [9,  71.9687, 0.03102],
  [10, 73.2812, 0.03089],
  [11, 74.5388, 0.03077],
  [12, 75.7488, 0.03068],
  [15, 79.1458, 0.03048],
  [18, 82.2587, 0.03051],
  [21, 85.0499, 0.03060],
  [24, 87.1161, 0.03157],
];

// Age in (fractional) months at a given date, off the app's BIRTH constant.
function ageMonthsAt(dateStr) { return Math.max(0, (new Date(dateStr) - BIRTH) / (30.4375 * 86400000)); }

// Gaussian CDF via an erf approximation (Abramowitz & Stegun 7.1.26).
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// Linear-interpolate LMS at a (fractional) age from the anchor table.
function interpLMS(anchors, months, hasL) {
  months = Math.min(Math.max(months, anchors[0][0]), anchors[anchors.length - 1][0]);
  let lo = anchors[0], hi = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length - 1; i++) {
    if (months >= anchors[i][0] && months <= anchors[i + 1][0]) { lo = anchors[i]; hi = anchors[i + 1]; break; }
  }
  const span = hi[0] - lo[0], f = span ? (months - lo[0]) / span : 0;
  const mix = (a, b) => a + (b - a) * f;
  if (hasL) return { L: mix(lo[1], hi[1]), M: mix(lo[2], hi[2]), S: mix(lo[3], hi[3]) };
  return { L: 1, M: mix(lo[1], hi[1]), S: mix(lo[2], hi[2]) };
}

// Measured value → percentile (0–100) via the LMS z-score.
function lmsToPercentile(value, L, M, S) {
  const z = Math.abs(L) < 1e-6 ? Math.log(value / M) / S : (Math.pow(value / M, L) - 1) / (L * S);
  return Math.min(99.9, Math.max(0.1, normCdf(z) * 100));
}
// A WHO percentile curve across 0–24 mo for a given z (P3=-1.881, P50=0, P97=1.881).
function whoCurve(anchors, hasL, z) {
  const pts = [];
  for (let m = 0; m <= 24; m++) {
    const { L, M, S } = interpLMS(anchors, m, hasL);
    const v = Math.abs(L) < 1e-6 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
    pts.push({ x: m, y: +v.toFixed(2) });
  }
  return pts;
}
function ordinal(n) { n = Math.round(n); const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

async function saveGrowth() {
  const msg = $("grow-msg");
  const w = parseFloat($("grow-weight").value);
  const h = parseFloat($("grow-height").value);
  const date = $("grow-date").value || new Date().toISOString().slice(0, 10);
  if ((!w || w <= 0) && (!h || h <= 0)) { msg.textContent = "Enter a weight and/or height."; return; }
  msg.textContent = "Saving…";
  const rows = [];
  if (w > 0) rows.push({ kind: "weight", value: w, measured_at: date });
  if (h > 0) rows.push({ kind: "height", value: h, measured_at: date });
  const { error } = await sb.from("growth").insert(rows);
  if (error) {
    msg.textContent = /relation|does not exist|schema cache/i.test(error.message)
      ? "Growth table not found — run schema-growth.sql in Supabase first." : error.message;
    return;
  }
  $("grow-weight").value = ""; $("grow-height").value = ""; msg.textContent = "Saved ✓";
  await loadGrowth();
}
async function deleteGrowth(id) { await sb.from("growth").delete().eq("id", id); await loadGrowth(); }

function growStatHTML(v, p, label) {
  return `<div class="grow-stat"><div class="v">${v}</div><div class="p">~${ordinal(p)} percentile</div><div class="l">${label} · WHO boys</div></div>`;
}
function renderGrowth() {
  const statsEl = $("grow-stats");
  if (!statsEl) return;
  if ($("grow-date") && !$("grow-date").value) $("grow-date").value = new Date().toISOString().slice(0, 10);
  const weights = growth.filter((g) => g.kind === "weight");
  const heights = growth.filter((g) => g.kind === "height");
  const lw = weights[weights.length - 1], lh = heights[heights.length - 1];
  let html = "";
  if (lw) { const a = ageMonthsAt(lw.measured_at); const { L, M, S } = interpLMS(WHO_WFA_BOYS, a, true);  html += growStatHTML(lw.value + " kg", lmsToPercentile(lw.value, L, M, S), "Weight"); }
  if (lh) { const a = ageMonthsAt(lh.measured_at); const { L, M, S } = interpLMS(WHO_LFA_BOYS, a, false); html += growStatHTML(lh.value + " cm", lmsToPercentile(lh.value, L, M, S), "Height"); }
  statsEl.innerHTML = html || `<p class="grow-lead">Save his first measurement to see percentiles.</p>`;
  renderGrowList();
  renderGrowCharts();
}
function renderGrowList() {
  const list = $("grow-list");
  if (!list) return;
  if (!growth.length) { list.innerHTML = '<li class="log-empty">No measurements yet.</li>'; return; }
  list.innerHTML = "";
  growth.slice().reverse().forEach((g) => {
    const li = document.createElement("li"); li.className = "log-item";
    li.innerHTML = `<span class="log-emoji">${g.kind === "weight" ? "⚖️" : "📏"}</span><div class="log-body"><div class="log-title"></div><div class="log-meta"></div></div>`;
    li.querySelector(".log-title").textContent = `${g.value} ${g.kind === "weight" ? "kg" : "cm"}`;
    li.querySelector(".log-meta").textContent = new Date(g.measured_at).toLocaleDateString();
    const del = document.createElement("button"); del.className = "del-btn"; del.textContent = "🗑";
    del.addEventListener("click", () => {
      const wrap = document.createElement("span"); wrap.className = "del-confirm";
      wrap.innerHTML = `<button class="del-yes">Delete</button><button class="del-no">Keep</button>`;
      del.replaceWith(wrap);
      wrap.querySelector(".del-yes").addEventListener("click", () => deleteGrowth(g.id));
      wrap.querySelector(".del-no").addEventListener("click", () => wrap.replaceWith(del));
    });
    li.appendChild(del); list.appendChild(li);
  });
}
function renderGrowCharts() {
  if (!window.Chart) return;
  growWChart = buildGrowChart(growWChart, "grow-weight-chart", WHO_WFA_BOYS, true,  growth.filter((g) => g.kind === "weight"), "kg");
  growHChart = buildGrowChart(growHChart, "grow-height-chart", WHO_LFA_BOYS, false, growth.filter((g) => g.kind === "height"), "cm");
}
const LEO_RED = "#ff2d55";   // Leo's own points — bright red, easy to spot vs the WHO curves
function buildGrowChart(inst, canvasId, anchors, hasL, rows, unit) {
  const canvas = $(canvasId);
  if (!canvas) return inst;
  if (canvas.offsetParent === null) return inst;   // hidden — (re)build when the tab opens
  if (inst) { inst.destroy(); inst = null; }        // rebuild fresh so Leo's point never gets stuck hidden
  const leo = rows.map((g) => ({ x: +ageMonthsAt(g.measured_at).toFixed(2), y: g.value })).sort((a, b) => a.x - b.x);
  const data = { datasets: [
    { label: "P3",  data: whoCurve(anchors, hasL, -1.88079), borderColor: "#4a5a72", borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, order: 3 },
    { label: "P50", data: whoCurve(anchors, hasL, 0),        borderColor: "#8f99b8", borderWidth: 2, pointRadius: 0, fill: false, order: 2 },
    { label: "P97", data: whoCurve(anchors, hasL, 1.88079),  borderColor: "#4a5a72", borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, order: 3 },
    { label: "Leo", data: leo, borderColor: LEO_RED, backgroundColor: LEO_RED,
      pointBackgroundColor: LEO_RED, pointBorderColor: "#fff", pointBorderWidth: 2,
      borderWidth: 3, pointRadius: 6, pointHoverRadius: 8, showLine: true, spanGaps: true, order: -1 },
  ] };
  return new Chart(canvas, {
    type: "line", data,
    options: {
      responsive: true, parsing: false,
      plugins: { legend: { labels: { color: "#b9a6b6", boxWidth: 12 } } },
      scales: {
        x: { type: "linear", min: 0, max: 24, title: { display: true, text: "age (months)", color: "#b9a6b6" }, ticks: { color: "#b9a6b6", stepSize: 3 }, grid: { color: "#36283d" } },
        y: { title: { display: true, text: unit, color: "#b9a6b6" }, ticks: { color: "#b9a6b6" }, grid: { color: "#36283d" } },
      },
    },
  });
}

// ============================================================
//  10j. FOOD — starting solids (research-based, age-aware)
//  Static content; reuses the sleep-tab (.sl-*) styles.
// ============================================================
function foodBannerHTML() {
  const mo = ageMonths(), w = ageWeeks();
  const moWord = mo === 1 ? "month" : "months";
  if (w < 17) return `<div class="sl-banner amber"><div class="sl-banner-eyebrow">🔴 Not yet — milk only</div>
    <p>Leo is <b>${mo} ${moWord}</b>. Under ~4 months it's breast/formula only. This section turns green as he nears 6 months — the window to begin.</p></div>`;
  if (w < 26) return `<div class="sl-banner green"><div class="sl-banner-eyebrow">🟡 Almost time — get ready</div>
    <p>Leo is <b>${mo} ${moWord}</b>. Watch for the four readiness signs below; most babies start solids at 6 months. Milk stays the main nutrition to age 1.</p></div>`;
  return `<div class="sl-banner green"><div class="sl-banner-eyebrow">🟢 Green light — he's in the window</div>
    <p>Leo is <b>${mo} ${moWord}</b> — the right time to begin solids. Start iron-rich, go slow, keep milk as the main nutrition to age 1.</p></div>`;
}
const FOOD_BODY = `
  <h2>1 · Is he ready?</h2>
  <p class="sl-lead">Look for all four signs, not just age (~6 months):</p>
  <div class="sl-card"><ul>
    <li>Sits with support &amp; holds his head steady</li>
    <li>Lost the tongue-thrust reflex (doesn't push food straight back out)</li>
    <li>Watches your food, reaches, opens his mouth</li>
    <li>Can move food back and swallow</li>
  </ul></div>

  <h2>2 · The one principle: start with iron</h2>
  <div class="sl-card">
    <p>A baby's iron stores run out around 6 months and breastmilk is low in iron — and iron fuels brain development now. So <b>first foods should be iron-rich</b>. The old "rice cereal first" rule is out; order doesn't matter medically, so lead with iron. Pair it with a little vitamin C (bell pepper, tomato, citrus) to boost absorption.</p>
    <p class="sl-note"><em>Ask Dr. León about a vitamin D drop (400 IU/day) — recommended for all breastfed babies.</em></p>
  </div>

  <h2>3 · Exactly where to start</h2>
  <div class="sl-card sl-order">
    <div class="sl-ostep"><div class="sl-onum">🥣</div><div><div class="sl-ot">Iron-fortified oat cereal</div><div class="sl-od">Easiest first step. Mix with breastmilk/formula to a thin puree.</div></div></div>
    <div class="sl-ostep"><div class="sl-onum">🍗</div><div><div class="sl-ot">Pureed chicken or beef</div><div class="sl-od">The most absorbable iron there is.</div></div></div>
    <div class="sl-ostep"><div class="sl-onum">🫘</div><div><div class="sl-ot">Well-cooked black beans / lentils</div><div class="sl-od">Cozumel staple — iron + protein, cooked very soft, no salt.</div></div></div>
    <div class="sl-ostep last"><div class="sl-onum">🥑</div><div><div class="sl-ot">Avocado (aguacate)</div><div class="sl-od">Local, perfect texture, brain-healthy fats. Great pairing food.</div></div></div>
  </div>
  <p class="sl-lead">Then add color: sweet potato (camote), squash (calabaza), banana, pear, mango.</p>

  <h2>4 · How to cook &amp; serve</h2>
  <div class="sl-card"><ul>
    <li><b>Steam, boil, or roast</b> until fork-soft, then blend/mash. Thin with breastmilk, formula, or the cooking water.</li>
    <li><b>Season with nothing</b> — no salt, no sugar, no honey. Herbs/cinnamon are fine.</li>
    <li><b>Texture ladder:</b> smooth puree → thicker mash → soft lumps → soft finger foods over the coming weeks.</li>
    <li><b>Batch &amp; freeze</b> in ice-cube trays — a week of food in one cook.</li>
    <li><b>Start with 1–2 teaspoons</b> once a day, mid-morning. Milk still comes first for now.</li>
  </ul></div>

  <h2>5 · Introduce allergens early &amp; often</h2>
  <div class="sl-card">
    <p>The old "wait and delay" advice was <b>wrong</b>. Introducing peanut and egg <b>early</b> (around 6 months, once a couple first foods go well) <b>lowers</b> allergy risk — proven by the LEAP trial.</p>
    <ul>
      <li>Thin smooth peanut butter into puree (never a thick spoonful — choking).</li>
      <li>Well-cooked egg, dairy (yogurt/cheese — not cow's milk as a drink yet), wheat, soy, fish.</li>
      <li>One allergen at a time, in the <b>morning</b>, so you can watch him all day. Keep offering once tolerated.</li>
    </ul>
  </div>

  <h2>6 · First 4 weeks</h2>
  <div class="sl-card sl-order">
    <div class="sl-ostep"><div class="sl-onum">1</div><div><div class="sl-ot">Week 1</div><div class="sl-od">One iron food (oat cereal or pureed chicken/beans), thin puree, once/day. Learn the spoon.</div></div></div>
    <div class="sl-ostep"><div class="sl-onum">2</div><div><div class="sl-ot">Week 2</div><div class="sl-od">Add avocado + one veg (camote/calabaza). New food every 2–3 days.</div></div></div>
    <div class="sl-ostep"><div class="sl-onum">3</div><div><div class="sl-ot">Week 3</div><div class="sl-od">Add a fruit (banana/pear/mango) + first allergen (thinned peanut, then egg).</div></div></div>
    <div class="sl-ostep last"><div class="sl-onum">4</div><div><div class="sl-ot">Week 4</div><div class="sl-od">Toward 2 meals/day, more allergens, soft lumps.</div></div></div>
  </div>

  <h2>7 · Never before age 1 / choking</h2>
  <div class="sl-flags"><div class="sl-flag red"><div class="sl-ft">The hard no-list</div><ul>
    <li><b>Honey</b> — botulism risk until 12 months</li>
    <li><b>Cow's milk as a drink</b> — until 12 months (fine cooked in / as yogurt)</li>
    <li><b>Added salt &amp; sugar</b></li>
    <li><b>Choking shapes</b> — whole grapes/cherry tomatoes (quarter them), nuts, popcorn, hard chunks, hot dogs, globs of nut butter</li>
    <li><b>Unpasteurized</b> cheese/juice</li>
  </ul></div></div>

  <h2>Start here tonight</h2>
  <div class="sl-card">
    <p><b>Sweet-potato + chicken puree</b> (iron-rich):</p>
    <div class="sl-order">
      <div class="sl-ostep"><div class="sl-onum">1</div><div><div class="sl-od">Steam ½ peeled sweet potato + 1 small skinless chicken thigh until fork-soft (~15 min).</div></div></div>
      <div class="sl-ostep"><div class="sl-onum">2</div><div><div class="sl-od">Blend smooth with breastmilk/formula or the steaming water to a thin, drippy puree.</div></div></div>
      <div class="sl-ostep last"><div class="sl-onum">3</div><div><div class="sl-od">Cool to lukewarm. Milk first, then 1–2 teaspoons. Stop when he turns away. Freeze the rest.</div></div></div>
    </div>
  </div>

  <details class="sl-cite">
    <summary>The research behind this</summary>
    <ul>
      <li><b>Start ~6 months, iron first</b> — WHO complementary feeding; AAP / HealthyChildren.org.</li>
      <li><b>Early allergen introduction</b> lowers risk — LEAP trial (2015) &amp; NIAID 2017 guidelines.</li>
      <li><b>No honey before 12 months</b> — infant botulism (AAP / CDC).</li>
      <li><b>Vitamin D 400 IU/day</b> for breastfed babies (AAP).</li>
    </ul>
    <p class="sl-cite-note">General guidance for a healthy full-term baby — confirm specifics with Dr. León Magaña.</p>
  </details>`;
function renderFood() {
  const el = $("food-content");
  if (el) el.innerHTML = foodBannerHTML() + FOOD_BODY;
}

// ============================================================
//  11. WIRING — every button via addEventListener (no inline onclick)
// ============================================================
$("login-form").addEventListener("submit", handleLogin);
$("signout-btn").addEventListener("click", handleSignOut);
$("bell-btn").addEventListener("click", enableAlarms);

$("breast-left").addEventListener("click", () => tapBreast("left"));
$("breast-right").addEventListener("click", () => tapBreast("right"));
$("bottle-btn").addEventListener("click", openBottleModal);
$("bottle-save").addEventListener("click", saveBottle);

$("sleep-btn").addEventListener("click", tapSleep);

$("milestone-btn").addEventListener("click", openMilestoneModal);
$("ms-save").addEventListener("click", saveMilestone);
$("edit-save").addEventListener("click", saveEdit);

$("export-btn").addEventListener("click", exportCSV);

// New Leo home + growth wiring.
// NB: the sleep buttons are built by renderSleepActions() — they carry their own
// listeners because the choice (nap only, or nap vs bedtime) changes during the day.
$("leo-cfg-prov").addEventListener("click", () => switchTab("settings"));
$("leo-export-btn").addEventListener("click", exportCSV);
$("leo-ask-card").addEventListener("click", () => switchTab("ask"));
$("leo-fix-btn").addEventListener("click", () => {
  const s = openSleep() || lastEndedSleep();   // fix a mislogged/forgotten sleep time
  if (s) openEditModal(s);
});
$("grow-save").addEventListener("click", saveGrowth);

// "⋯ More" menu — the old screens, kept just in case
$("more-btn").addEventListener("click", (e) => { e.stopPropagation(); $("more-menu").classList.toggle("hidden"); });
$("more-menu").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => { switchTab(b.dataset.tab); $("more-menu").classList.add("hidden"); }));
document.addEventListener("click", (e) => {
  if (!$("more-menu").classList.contains("hidden") && !e.target.closest("#more-menu") && e.target.id !== "more-btn")
    $("more-menu").classList.add("hidden");
});

// v2: tabs, stats range, insight refresh, chat
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
$("pl-subtabs").addEventListener("click", (e) => {
  if (e.target.dataset.v) { planner.view = e.target.dataset.v; plStore.set("view", planner.view); renderPlanner(); }
});
// Scoped to [data-range]: the edit modal now has .seg-btn buttons too, and an
// unscoped selector here would set statsRange to NaN when you pick "Nap".
document.querySelectorAll(".seg-btn[data-range]").forEach((b) => b.addEventListener("click", () => {
  statsRange = Number(b.dataset.range);
  document.querySelectorAll(".seg-btn[data-range]").forEach((x) => x.classList.toggle("active", x === b));
  renderStats();
}));
$("edit-subtype").querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
  $("edit-subtype").querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
}));
$("insight-refresh").addEventListener("click", () => loadInsight(true));
$("chat-form").addEventListener("submit", sendChat);

// Close modals: backdrop click or any [data-close] button.
$("modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") closeModal(); });
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));

// ============================================================
//  11b. leoDebug — time travel. This is the test suite.
// ============================================================
// There is no test runner in this project, and the alerts are all about time of
// day, so they're untestable by waiting. Open the console (Mac Safari → Develop →
// iPhone works on the installed PWA) and:
//
//   leoDebug.fakeDay("06:10 wake, 08:00-08:45 nap, 11:30-12:50 nap, 16:40- nap")
//   leoDebug.at("17:25")
//   leoDebug.alerts()      → late-nap should be there, with key latenap:<id>
//   leoDebug.clear()       → back to the real clock; reload to drop the fake data
function _redrawAll() { render(); renderRhythm(); renderLeoData(); renderAlerts(true); renderSettings(); }

window.leoDebug = {
  // Jump to a wall-clock time today. Everything reads now(), so everything moves.
  at(hhmm) {
    TIME_SHIFT_MS = 0;
    TIME_SHIFT_MS = atToday(hhmm).getTime() - Date.now();
    _redrawAll();
    return `now() = ${now().toLocaleString()}`;
  },
  clear() { TIME_SHIFT_MS = 0; _redrawAll(); return `now() = ${now().toLocaleString()} (real)`; },
  cfg() { return cfgNow(); },
  state() {
    const w = wakeState(), st = sleepDayStats();
    return {
      zone: w.zone, awake: w.awakeMin ? plDur(Math.round(w.awakeMin)) : null,
      window: w.opensAt ? `${clockTime(w.opensAt)}–${clockTime(w.closesAt)}` : null,
      firstOfDay: w.isFirstOfDay, lastOfDay: w.isLastOfDay,
      naps: st.napCount, daySleep: plDur(st.napMins), total: plDur(Math.round(st.sleptMs / 60000)),
      rolling24h: plDur(sleepRolling24hMin()),
    };
  },
  alerts() {
    const d = dismissedMap();
    return evaluateAlerts().map((a) => ({ id: a.id, sev: a.sev, key: a.key, push: !!a.push, dismissed: !!d[a.key], title: a.title }));
  },
  // "06:10 wake, 08:00-08:45 nap, 11:30-12:50 nap, 16:40- nap" (open end = running).
  // In memory only — nothing is written to Supabase. Reload to get real data back.
  fakeDay(spec) {
    const base = now();
    const day0 = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    const mk = (m) => new Date(day0 + m * 60000).toISOString();
    const out = [];
    let n = 0;
    for (const raw of String(spec).split(",")) {
      const s = raw.trim();
      if (!s) continue;
      const parts = s.split(/\s+/);
      const range = parts[0], kind = (parts[1] || "nap").toLowerCase();
      if (kind === "wake") {          // "he was up for the day at" → last night's sleep
        out.push({ id: `fake-${++n}`, type: "sleep", subtype: "night", start_at: mk(-240), end_at: mk(plToMin(range)) });
        continue;
      }
      const [a, b] = range.split("-");
      out.push({
        id: `fake-${++n}`, type: "sleep", subtype: kind === "night" ? "night" : "nap",
        start_at: mk(plToMin(a)), end_at: b ? mk(plToMin(b)) : null,
      });
    }
    events = out.sort((x, y) => new Date(y.start_at) - new Date(x.start_at));   // newest first
    _redrawAll();
    return `${events.length} fake events in memory — reload to restore real data`;
  },
  // Full control when fakeDay's shorthand isn't enough — e.g. checking that an
  // alert re-fires for a DIFFERENT row id. (`events` is a module-scope `let`, so
  // assigning window.events from the console silently does nothing.)
  setEvents(rows) {
    events = (rows || []).slice().sort((x, y) => new Date(y.start_at) - new Date(x.start_at));
    _redrawAll();
    return `${events.length} events in memory`;
  },
  events() { return events; },
  undismissAll() {
    try { localStorage.removeItem(ALERT_DISMISS_KEY); } catch (e) {}
    renderAlerts(true);
    return "dismissals cleared";
  },
};

// ============================================================
//  12. PWA — register the service worker (installability)
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(console.error));
}
