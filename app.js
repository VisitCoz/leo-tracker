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

// ---- Wake-window thresholds (minutes) — exact per spec --------
const WAKE_TARGET = 90;            // window "closes" at 90 min
const ZONE = { green: 75, amber: 90, orange: 105 }; // >105 = red

// ---- App state ----------------------------------------------
let events = [];          // all events we've loaded, newest first
let chat = [];            // chat messages (from the `messages` table)
let tick = null;          // the 1-second clock interval
let alerted = false;      // so the 90-min alarm fires only once per wake window
let alarmsOn = false;     // browser-notification permission granted?
let statsRange = 1;       // Stats tab range in days (1 = today, 7 = week)
let sleepChart = null;    // Chart.js instance
let chatBusy = false;     // a chat reply is in flight

// ---- Leo's birthday → age ("4 mo 15 d") ----------------------
const BIRTH = new Date(2026, 0, 23); // 23 Jan 2026 (month is 0-indexed)
function ageString() {
  const t = now();
  let months = (t.getFullYear() - BIRTH.getFullYear()) * 12 + (t.getMonth() - BIRTH.getMonth());
  let days = t.getDate() - BIRTH.getDate();
  if (days < 0) { months -= 1; days += new Date(t.getFullYear(), t.getMonth(), 0).getDate(); }
  return `${months} mo ${days} d`;
}

// ---- Tiny helpers -------------------------------------------
const $ = (id) => document.getElementById(id);
const now = () => new Date();
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
}

async function showApp() {
  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("age-line").textContent = "Leo · " + ageString();
  await loadEvents();
  await loadMessages();
  subscribeRealtime();
  loadInsight();                               // cached, see below
  if (!tick) tick = setInterval(render, 1000); // live clocks update every second
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
  renderLog();       // (so the inline delete confirm isn't wiped mid-tap)
  renderStats();
  renderTimeline();
}

// Realtime: when ANY row in `events` is added/changed/removed (by either
// parent, on any device), reload so both screens stay in sync.
function subscribeRealtime() {
  sb.channel("events-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, loadEvents)
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, loadMessages)
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
  await sb.from("events").update({ end_at: new Date().toISOString() }).eq("id", row.id);
}

function openBottleModal() { openModal("bottle-modal"); $("bottle-ml").value = ""; setTimeout(() => $("bottle-ml").focus(), 50); }
async function saveBottle() {
  const ml = parseInt($("bottle-ml").value, 10);
  if (!ml || ml <= 0) { $("bottle-ml").focus(); return; }
  const ts = new Date().toISOString();
  await sb.from("events").insert({ type: "bottle", amount_ml: ml, end_at: ts });
  closeModal();
  await loadEvents();
}

// ============================================================
//  4. SLEEP — start / end, auto nap vs night
// ============================================================
async function tapSleep() {
  const running = openSleep();
  if (running) {
    await sb.from("events").update({ end_at: new Date().toISOString() }).eq("id", running.id);
  } else {
    const h = now().getHours();
    const subtype = (h >= 19 || h < 7) ? "night" : "nap"; // 7pm–7am = night
    await sb.from("events").insert({ type: "sleep", subtype });
    alerted = false; // a new sleep resets the wake-window alarm
  }
  await loadEvents();
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
//  7. RENDER — runs every second to keep live timers fresh
// ============================================================
// Per-second tick: only the live timers. NOT the log/summary — rebuilding the
// log every second was wiping out the "Delete/Keep" confirm before you could tap.
function render() {
  renderWake();
  renderLive();
  renderFeedButtons();
  renderSleepButton();
  renderSinceFeed();
  renderFeedAwake();
  renderAgo();
}

function renderWake() {
  const card = $("wake-card");
  const sleeping = openSleep();
  if (sleeping) {
    // Asleep — show how long he's been sleeping.
    card.className = "card wake-card zone-green";
    $("wake-eyebrow").textContent = "Asleep for 💤";
    $("wake-time").textContent = dur(now() - new Date(sleeping.start_at));
    $("wake-status").textContent = "Tap End sleep when he wakes";
    return;
  }
  $("wake-eyebrow").textContent = "Awake for";
  const last = lastEndedSleep();
  if (!last) {
    $("wake-time").textContent = "—";
    $("wake-status").textContent = "Log a sleep to start the wake window";
    card.className = "card wake-card zone-green";
    return;
  }
  const wokeAt = new Date(last.end_at);
  const mins = (now() - wokeAt) / 60000;
  $("wake-time").textContent = dur(now() - wokeAt);

  const closesAt = new Date(wokeAt.getTime() + WAKE_TARGET * 60000);
  $("wake-status").textContent = `Window closes at ${clockTime(closesAt)}`;

  let zone = "green";
  if (mins > ZONE.orange) zone = "red";
  else if (mins > ZONE.amber) zone = "orange";
  else if (mins >= ZONE.green) zone = "amber";
  card.className = `card wake-card zone-${zone}`;

  // Fire the alarm once when we cross the 90-minute target.
  if (mins >= WAKE_TARGET && !alerted) { alerted = true; fireAlarm(); }
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

// Per-action "last done X ago" labels under each feed button + the sleep button.
// events is newest-first; a matching row with no end_at means it's running now.
function renderAgo() {
  const ago = (e) => {
    if (!e) return "never";
    if (!e.end_at) return "now";
    const mins = Math.floor((now() - new Date(e.end_at)) / 60000);
    return mins < 1 ? "just now" : `${clockMins(mins)} ago`;
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
    sleepLabel = mins < 1 ? "woke just now" : `last sleep ${clockMins(mins)} ago`;
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

  let sleepMs = 0, feedMs = 0;
  for (const e of today) {
    if (!e.end_at) continue;
    const span = new Date(e.end_at) - new Date(e.start_at);
    if (e.type === "sleep") sleepMs += span;
    if (e.type === "breast") feedMs += span;
  }
  $("t-feeds").textContent = feeds;
  $("t-sleep").textContent = (sleepMs / 3600000).toFixed(1) + "h";
  $("t-feedtime").textContent = Math.round(feedMs / 60000) + "m";
}

const EMOJI = { breast: "🤱", bottle: "🍼", sleep: "😴", milestone: "✨" };

function renderLog() {
  const list = $("log-list");
  const today = events.filter((e) => isToday(e.start_at));
  if (today.length === 0) { list.innerHTML = '<li class="log-empty">No entries yet today.</li>'; return; }

  list.innerHTML = "";
  for (const e of today) {
    const li = document.createElement("li");
    li.className = "log-item";

    const span = e.end_at ? new Date(e.end_at) - new Date(e.start_at) : 0;
    let title = "";
    if (e.type === "breast")    title = `Breast ${e.subtype === "left" ? "L" : "R"}` + (e.end_at ? ` · ${mmss(span)}` : " · running");
    else if (e.type === "bottle")    title = `Bottle · ${e.amount_ml || 0} ml`;
    else if (e.type === "sleep")     title = `Sleep (${e.subtype || "?"})` + (e.end_at ? ` · ${clockMins(span / 60000)}` : " · running");
    else if (e.type === "milestone") title = e.note || "Milestone";

    li.innerHTML = `
      <span class="log-emoji">${EMOJI[e.type] || "•"}</span>
      <div class="log-body">
        <div class="log-title"></div>
        <div class="log-meta">${clockTime(new Date(e.start_at))}</div>
      </div>
      ${e.photo_url ? `<img class="log-photo" src="${e.photo_url}" alt="" />` : ""}
    `;
    li.querySelector(".log-title").textContent = title; // textContent = safe against weird notes

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
  if (name === "stats") renderStats();
  if (name === "timeline") renderTimeline();
  if (name === "ask") scrollChat();
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
async function loadInsight(force) {
  const box = $("insight-text");
  const card = box.closest(".insight-card");
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(INSIGHT_KEY) || "null");
      if (c && Date.now() - c.at < 2 * 3600 * 1000) { box.textContent = c.text; return; }
    } catch (_) {}
  }
  card.classList.add("loading");
  box.textContent = "Thinking about Leo…";
  try {
    const { data, error } = await sb.functions.invoke("ask-leo", { body: { mode: "insight", activity: activitySummary() } });
    card.classList.remove("loading");
    if (error || !data || data.error || !data.reply) {
      box.textContent = "Couldn't reach the assistant yet. (Deploy the ask-leo function + set the API key.)";
      return;
    }
    box.textContent = data.reply;
    localStorage.setItem(INSIGHT_KEY, JSON.stringify({ text: data.reply, at: Date.now() }));
  } catch (_) {
    card.classList.remove("loading");
    box.textContent = "Couldn't reach the assistant yet.";
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
//  10f. TIMELINE — last 3 days, 24h band per day
// ============================================================
function renderTimeline() {
  const box = $("timeline");
  if (!box) return;
  const t = now();
  box.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
    const dayStart = d.getTime(), dayEnd = dayStart + 86400000;
    const wrap = document.createElement("div");
    wrap.className = "tl-day";
    const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "long" });
    wrap.innerHTML = `<div class="tl-date">${label} · ${d.toLocaleDateString([], { month: "short", day: "numeric" })}</div><div class="tl-track"></div><div class="tl-hours"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>`;
    const track = wrap.querySelector(".tl-track");
    for (const e of events) {
      const s = new Date(e.start_at).getTime();
      if (s < dayStart || s >= dayEnd) continue;
      const end = e.end_at ? new Date(e.end_at).getTime() : s + 5 * 60000;
      const left = ((s - dayStart) / 86400000) * 100;
      const width = Math.max(((Math.min(end, dayEnd) - s) / 86400000) * 100, 0.6);
      const blk = document.createElement("div");
      blk.className = "tl-block b-" + e.type;
      blk.style.left = left + "%";
      blk.style.width = width + "%";
      blk.title = `${e.type} ${clockTime(new Date(e.start_at))}`;
      track.appendChild(blk);
    }
    box.appendChild(wrap);
  }
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
    const { data, error } = await sb.functions.invoke("ask-leo", { body: { mode: "chat", messages: history, activity: activitySummary() } });
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

$("export-btn").addEventListener("click", exportCSV);

// v2: tabs, stats range, insight refresh, chat
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
  statsRange = Number(b.dataset.range);
  document.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  renderStats();
}));
$("insight-refresh").addEventListener("click", () => loadInsight(true));
$("chat-form").addEventListener("submit", sendChat);

// Close modals: backdrop click or any [data-close] button.
$("modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") closeModal(); });
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));

// ============================================================
//  12. PWA — register the service worker (installability)
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(console.error));
}
