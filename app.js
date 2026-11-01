// ============================================================
//  Leo Tracker: the simple app. Three tabs: Sleep, Growth, Firsts.
//  Plain JavaScript, no build step. Loads after config.js and the
//  Supabase library (see index.html).
//
//  Data (unchanged from the old app, same tables and columns):
//    events  type 'sleep'      subtype 'nap' | 'night', start_at, end_at (null = asleep now)
//    events  type 'milestone'  note = what happened, start_at = when
//    growth  kind 'weight' (kg) | 'height' (cm), value, measured_at (a date)
// ============================================================

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LEO_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BIRTH = new Date(2026, 0, 23); // 23 Jan 2026 (month is 0-indexed)

let sleeps = [];   // sleep rows from the day before yesterday onward, plus any still running
let firsts = [];   // milestone rows, newest first
let growth = [];   // weight/height rows, newest first
let logDay = 0;    // the sleep log shows 0 = today, 1 = yesterday
let editing = null; // the sleep row open in the "Fix this sleep" sheet
let started = false;
let live = false;  // realtime subscribed?

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clock = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayAgo = (n) => new Date(midnight(new Date()).getTime() - n * DAY);
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localInput = (d) => `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fromIsoDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const shortDate = (d) => `${d.getDate()} ${MON[d.getMonth()]}`;
const longDate = (d) => `${shortDate(d)} ${d.getFullYear()}`;

function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

// "9 months, 1 week old"
function ageLine() {
  const t = new Date();
  let months = (t.getFullYear() - BIRTH.getFullYear()) * 12 + (t.getMonth() - BIRTH.getMonth());
  if (t.getDate() < BIRTH.getDate()) months -= 1;
  const since = new Date(BIRTH.getFullYear(), BIRTH.getMonth() + months, BIRTH.getDate());
  const weeks = Math.floor((t - since) / (7 * DAY));
  const mo = `${months} month${months === 1 ? "" : "s"}`;
  return weeks ? `${mo}, ${weeks} week${weeks === 1 ? "" : "s"} old` : `${mo} old`;
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 2400);
}

// Every write goes through here: a failed save says so instead of failing silently.
async function save(promise, okMsg) {
  const { error } = await promise;
  if (error) { console.error(error); toast("Couldn't save: " + error.message); return false; }
  if (okMsg) toast(okMsg);
  return true;
}

// ============================================================
//  SIGN IN: the database only answers a signed-in family member
// ============================================================
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("auth-msg").textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  $("auth-msg").textContent = error ? error.message : "";
});
$("signout-btn").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  $("auth-view").classList.toggle("hidden", !!session);
  $("app-view").classList.toggle("hidden", !session);
  if (session && !started) start();
  if (!session) started = false;
});

async function start() {
  started = true;
  $("age-line").textContent = ageLine();
  await Promise.all([loadSleeps(), loadFirsts(), loadGrowth()]);
  // Both phones stay in step: any change by the other parent reloads the data.
  // Subscribed once per page load, even after signing out and back in.
  if (live) return;
  live = true;
  sb.channel("leo-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, () => { loadSleeps(); loadFirsts(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "growth" }, loadGrowth)
    .subscribe();
}

// ============================================================
//  SLEEP
// ============================================================
async function loadSleeps() {
  const from = dayAgo(2).toISOString();
  const { data, error } = await sb.from("events").select("*").eq("type", "sleep")
    .or(`start_at.gte.${from},end_at.is.null`).order("start_at", { ascending: false });
  if (error) { console.error(error); return; }
  sleeps = data || [];
  renderSleep();
}

// Nap or night is decided by the clock when he falls asleep: from 5 PM to 6 AM it is
// night, otherwise a nap. Wrong one? Tap the sleep in the log and switch it.
const kindAt = (d) => (d.getHours() >= 17 || d.getHours() < 6 ? "night" : "nap");

const running = () => sleeps.find((s) => !s.end_at);

// Older rows can carry wake-ups in `note`: {"pauses":[[start,end],...],"open":start}.
// Time awake inside a sleep is not sleep, the same rule the old app used.
function pausesOf(s) {
  try { const j = JSON.parse(s.note || "{}"); return { done: Array.isArray(j.pauses) ? j.pauses : [], open: j.open || null }; }
  catch (e) { return { done: [], open: null }; }
}
function sleptMs(s, nowMs) {
  const a = new Date(s.start_at).getTime();
  const b = s.end_at ? new Date(s.end_at).getTime() : nowMs;
  const p = pausesOf(s);
  const cuts = p.done.map(([x, y]) => [new Date(x).getTime(), new Date(y).getTime()]);
  if (p.open) cuts.push([new Date(p.open).getTime(), b]);
  let awake = 0;
  for (const [x, y] of cuts) awake += Math.max(0, Math.min(y, b) - Math.max(x, a));
  return Math.max(0, b - a - awake);
}

// The sleeps that started on a given day (0 = today, 1 = yesterday), newest first.
// Today also shows the sleep he is in right now, even if it began last evening.
function sleepsOn(n) {
  const from = dayAgo(n).getTime(), to = from + DAY;
  return sleeps.filter((s) => {
    const t = new Date(s.start_at).getTime();
    return (t >= from && t < to) || (n === 0 && !s.end_at);
  });
}

function renderSleep() {
  const nowMs = Date.now();
  const r = running();

  // Last night: the night sleeps that began between noon yesterday and noon today.
  const nFrom = dayAgo(1).getTime() + DAY / 2, nTo = nFrom + DAY;
  const night = sleeps.filter((s) => s.subtype === "night" && +new Date(s.start_at) >= nFrom && +new Date(s.start_at) < nTo);
  const nightMs = night.reduce((sum, s) => sum + sleptMs(s, nowMs), 0);
  $("pair-a").textContent = nightMs ? dur(nightMs) : "—";
  $("pair-a-lab").textContent = night.some((s) => !s.end_at) ? "asleep so far tonight" : "slept last night";

  // Naps today; before the first one, yesterday's count.
  const napsToday = sleepsOn(0).filter((s) => s.subtype === "nap" && new Date(s.start_at) >= dayAgo(0)).length;
  const napsYday = sleepsOn(1).filter((s) => s.subtype === "nap").length;
  $("pair-b").textContent = napsToday || napsYday;
  $("pair-b-lab").textContent = napsToday || !napsYday ? "naps today" : "naps yesterday";

  $("hero").className = "card hero " + (r ? "zone-asleep" : "zone-awake");
  $("hero-eye").textContent = r ? "Asleep for" : "Awake for";
  $("sleep-btn").textContent = r ? "☀️ He woke up" : "😴 He's asleep";
  const last = sleeps.filter((s) => s.end_at).sort((a, b) => new Date(b.end_at) - new Date(a.end_at))[0];
  $("hero-sub").textContent = r ? `Fell asleep at ${clock(new Date(r.start_at))}`
    : last ? `Woke up at ${clock(new Date(last.end_at))}` : "Tap the button when he falls asleep";

  const rows = sleepsOn(logDay);
  $("log").innerHTML = rows.length ? rows.map((s) => {
    const a = new Date(s.start_at);
    const night = s.subtype === "night";
    return `<li class="tap" data-id="${s.id}"><span class="em">${night ? "🌙" : "😴"}</span><div class="body">` +
      `<div class="t${s.end_at ? "" : " new"}">${night ? "Night sleep" : "Nap"} · ${s.end_at ? dur(sleptMs(s, nowMs)) : "asleep now"}</div>` +
      `<div class="m">${clock(a)} → ${s.end_at ? clock(new Date(s.end_at)) : "now"}</div></div><span class="m">✏️</span></li>`;
  }).join("") : `<li class="empty">No sleeps logged ${logDay ? "yesterday" : "today yet"}.</li>`;
  tick();
}

// The big clock: time since he fell asleep or woke up.
function tick() {
  const r = running();
  const last = sleeps.filter((s) => s.end_at).sort((a, b) => new Date(b.end_at) - new Date(a.end_at))[0];
  const since = r ? new Date(r.start_at) : last ? new Date(last.end_at) : null;
  if (!since) { $("hero-time").textContent = "—"; return; }
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  $("hero-time").innerHTML = (h ? `${h}h ${m}m` : `${m}m`) + `<small>${pad(s % 60)}s</small>`;
}
setInterval(() => { if (started) tick(); }, 1000);

let busy = false;
$("sleep-btn").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  const now = new Date();
  const r = running();
  if (r) {
    const fields = { end_at: now.toISOString() };
    // An old row still marked "awake" gets that wake-up closed, as the old app did.
    const p = pausesOf(r);
    if (p.open) fields.note = JSON.stringify({ pauses: [...p.done, [p.open, now.toISOString()]] });
    await save(sb.from("events").update(fields).eq("id", r.id), `Woke up at ${clock(now)}`);
  } else {
    const kind = kindAt(now);
    await save(sb.from("events").insert({ type: "sleep", subtype: kind, start_at: now.toISOString() }),
      `${kind === "night" ? "Night sleep" : "Nap"} started at ${clock(now)}`);
  }
  await loadSleeps();
  busy = false;
});

document.querySelectorAll(".daytabs button").forEach((b) => b.addEventListener("click", () => {
  logDay = +b.dataset.day;
  document.querySelectorAll(".daytabs button").forEach((x) => x.classList.toggle("on", x === b));
  renderSleep();
}));

// ---- Fix a sleep: times, nap or night, or delete it ----
$("log").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  editing = sleeps.find((s) => s.id === li.dataset.id);
  if (!editing) return;
  $("s-start").value = localInput(new Date(editing.start_at));
  $("s-end").value = editing.end_at ? localInput(new Date(editing.end_at)) : "";
  setKind(editing.subtype === "night" ? "night" : "nap");
  openSheet("bd-sleep");
});
let editKind = "nap";
function setKind(k) {
  editKind = k;
  document.querySelectorAll("#s-kind button").forEach((b) => b.classList.toggle("on", b.dataset.kind === k));
}
document.querySelectorAll("#s-kind button").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind)));

$("s-save").addEventListener("click", async () => {
  const a = $("s-start").value ? new Date($("s-start").value) : null;
  const b = $("s-end").value ? new Date($("s-end").value) : null;
  if (!a) { toast("Set when he fell asleep"); return; }
  if (b && b <= a) { toast("Woke up must be after fell asleep"); return; }
  if (!b && sleeps.some((s) => !s.end_at && s.id !== editing.id)) { toast("Another sleep is already running"); return; }
  const ok = await save(sb.from("events").update({ subtype: editKind, start_at: a.toISOString(), end_at: b ? b.toISOString() : null })
    .eq("id", editing.id), "Sleep updated");
  if (ok) { closeSheets(); await loadSleeps(); }
});
$("s-del").addEventListener("click", async () => {
  if (!confirm("Delete this sleep?")) return;
  const ok = await save(sb.from("events").delete().eq("id", editing.id), "Sleep deleted");
  if (ok) { closeSheets(); await loadSleeps(); }
});

// ============================================================
//  GROWTH
// ============================================================
async function loadGrowth() {
  const { data, error } = await sb.from("growth").select("*").order("measured_at", { ascending: false });
  if (error) { console.error(error); return; }
  growth = data || [];
  renderGrowth();
}

function renderGrowth() {
  const w = growth.filter((g) => g.kind === "weight");
  const h = growth.filter((g) => g.kind === "height");
  $("w-now").textContent = w[0] ? `${Number(w[0].value)} kg` : "—";
  $("w-date").textContent = w[0] ? `weight · ${shortDate(fromIsoDay(w[0].measured_at))}` : "weight";
  $("h-now").textContent = h[0] ? `${Number(h[0].value)} cm` : "—";
  $("h-date").textContent = h[0] ? `height · ${shortDate(fromIsoDay(h[0].measured_at))}` : "height";
  $("glist").innerHTML = growth.length ? growth.map((g) =>
    `<li><span class="em">${g.kind === "weight" ? "⚖️" : "📏"}</span><div class="body">` +
    `<div class="t">${Number(g.value)} ${g.kind === "weight" ? "kg" : "cm"}</div>` +
    `<div class="m">${longDate(fromIsoDay(g.measured_at))}</div></div>` +
    `<button class="del" data-id="${g.id}" aria-label="Delete">🗑</button></li>`).join("")
    : `<li class="empty">No measurements yet.</li>`;
  drawWeightChart(w.slice().reverse());
}

// WHO weight-for-age, boys: [age in months, L, M, S]. Used only to draw the
// 3rd / 50th / 97th percentile lines behind Leo's own weights.
const WHO_WFA_BOYS = [
  [0, 0.3487, 3.3464, 0.14602], [1, 0.2297, 4.4709, 0.13395], [2, 0.1970, 5.5675, 0.12385],
  [3, 0.1738, 6.3762, 0.11727], [4, 0.1553, 7.0023, 0.11316], [5, 0.1395, 7.5105, 0.11080],
  [6, 0.1257, 7.9340, 0.10958], [7, 0.1134, 8.2970, 0.10902], [8, 0.1021, 8.6151, 0.10882],
  [9, 0.0917, 8.9014, 0.10881], [10, 0.0820, 9.1649, 0.10891], [11, 0.0730, 9.4122, 0.10906],
  [12, 0.0644, 9.6479, 0.10925], [15, 0.0408, 10.3108, 0.10995], [18, 0.0194, 10.9385, 0.11080],
  [21, 0.0000, 11.5486, 0.11168], [24, -0.0181, 12.1515, 0.11250],
];
function whoWeight(months, z) {
  const t = WHO_WFA_BOYS;
  const m = Math.min(Math.max(months, 0), 24);
  let i = 0;
  while (i < t.length - 2 && m > t[i + 1][0]) i++;
  const f = (m - t[i][0]) / (t[i + 1][0] - t[i][0]);
  const [L, M, S] = [1, 2, 3].map((k) => t[i][k] + (t[i + 1][k] - t[i][k]) * f);
  return Math.abs(L) < 1e-6 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
}

function drawWeightChart(pts) {
  const svg = $("wchart");
  if (!pts.length) { svg.innerHTML = `<text x="170" y="90" fill="#b9a6b6" font-size="13" text-anchor="middle">No weight yet</text>`; return; }
  const days = (d) => (d - BIRTH) / DAY;
  const P = pts.map((g) => ({ x: days(fromIsoDay(g.measured_at)), y: Number(g.value) }));
  const x0 = Math.max(0, P[0].x - 20), x1 = Math.max(P[P.length - 1].x, days(new Date())) + 10;
  const Z = [[-1.881, "3rd"], [0, "50th"], [1.881, "97th"]];
  const ys = P.map((p) => p.y);
  for (const [z] of Z) for (const x of [x0, x1]) ys.push(whoWeight(x / 30.4375, z));
  const y0 = Math.floor(Math.min(...ys) - 0.2), y1 = Math.ceil(Math.max(...ys) + 0.2);
  const X = (x) => 30 + (x - x0) / (x1 - x0) * 270;
  const Y = (y) => 150 - (y - y0) / (y1 - y0) * 138;
  let s = "";
  const step = y1 - y0 > 6 ? 2 : 1;
  for (let k = y0; k <= y1; k += step) {
    s += `<line x1="30" x2="300" y1="${Y(k)}" y2="${Y(k)}" stroke="#36283d"/><text x="4" y="${Y(k) + 4}" fill="#b9a6b6" font-size="11">${k}</text>`;
  }
  // month labels on the 1st of each month in range
  for (let d = new Date(BIRTH.getFullYear(), BIRTH.getMonth() + 1, 1); days(d) <= x1; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    if (days(d) >= x0) s += `<text x="${X(days(d))}" y="166" fill="#b9a6b6" font-size="11" text-anchor="middle">${MON[d.getMonth()]}</text>`;
  }
  for (const [z, lab] of Z) {
    const line = [];
    for (let x = x0; x <= x1; x += (x1 - x0) / 24) line.push(`${X(x).toFixed(1)},${Y(whoWeight(x / 30.4375, z)).toFixed(1)}`);
    s += `<polyline fill="none" stroke="#6a5570" stroke-width="1.2" stroke-dasharray="4 4" points="${line.join(" ")}"/>`;
    s += `<text x="304" y="${Y(whoWeight(x1 / 30.4375, z)) + 4}" fill="#8a7790" font-size="10">${lab}</text>`;
  }
  s += `<polyline fill="none" stroke="#8fc0a9" stroke-width="2.5" points="${P.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}"/>`;
  P.forEach((p, i) => {
    const last = i === P.length - 1;
    s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${last ? 6 : 4.5}" fill="${last ? "#e98aa8" : "#8fc0a9"}"/>`;
    s += `<text x="${X(p.x)}" y="${Y(p.y) - 11}" fill="#f3e9ef" font-size="12" text-anchor="middle">${p.y}</text>`;
  });
  svg.innerHTML = s;
}

$("grow-add").addEventListener("click", () => {
  $("g-w").value = ""; $("g-h").value = ""; $("g-d").value = isoDay(new Date());
  openSheet("bd-grow");
});
$("g-save").addEventListener("click", async () => {
  const w = parseFloat($("g-w").value), h = parseFloat($("g-h").value);
  const date = $("g-d").value || isoDay(new Date());
  const rows = [];
  if (w > 0) rows.push({ kind: "weight", value: w, measured_at: date });
  if (h > 0) rows.push({ kind: "height", value: h, measured_at: date });
  if (!rows.length) { toast("Type a weight or a height first"); return; }
  const ok = await save(sb.from("growth").insert(rows), "Saved");
  if (ok) { closeSheets(); await loadGrowth(); }
});
$("glist").addEventListener("click", async (e) => {
  const b = e.target.closest("button.del");
  if (!b || !confirm("Delete this measurement?")) return;
  if (await save(sb.from("growth").delete().eq("id", b.dataset.id), "Deleted")) await loadGrowth();
});

// ============================================================
//  FIRSTS
// ============================================================
// Same test the Leo wallpaper uses to pick which moments are "firsts".
const FIRST = /\b(first|1st|primer[ao]?)\b/i;

async function loadFirsts() {
  const { data, error } = await sb.from("events").select("*").eq("type", "milestone").order("start_at", { ascending: false });
  if (error) { console.error(error); return; }
  firsts = data || [];
  renderFirsts();
}

function renderFirsts() {
  $("f-count").textContent = firsts.length || "";
  $("flist").innerHTML = firsts.length ? firsts.map((f, i) => {
    const star = FIRST.test(f.note || "");
    const photo = f.photo_url ? ` · <a href="${esc(f.photo_url)}" target="_blank" rel="noopener">photo</a>` : "";
    return `<li class="${i === 0 ? "newest" : ""}"><span class="star${star ? "" : " dim"}">${star ? "★" : "•"}</span>` +
      `<div><div class="lab">${esc(f.note || "")}</div><div class="d">${longDate(new Date(f.start_at))}${photo}</div></div>` +
      `<button class="del" data-id="${f.id}" aria-label="Delete">🗑</button></li>`;
  }).join("") : `<li class="empty">No firsts yet.</li>`;
}

$("first-add").addEventListener("click", () => {
  $("f-t").value = ""; $("f-d").value = isoDay(new Date());
  openSheet("bd-first");
  setTimeout(() => $("f-t").focus(), 50);
});
$("f-save").addEventListener("click", async () => {
  const note = $("f-t").value.trim();
  if (!note) { toast("Type what happened first"); return; }
  const d = $("f-d").value;
  // Today = right now; another day = midday that day, so the date never slips across midnight.
  const at = !d || d === isoDay(new Date()) ? new Date() : new Date(fromIsoDay(d).getTime() + DAY / 2);
  const ok = await save(sb.from("events").insert({ type: "milestone", note, start_at: at.toISOString() }), "Saved");
  if (ok) { closeSheets(); await loadFirsts(); }
});
$("flist").addEventListener("click", async (e) => {
  const b = e.target.closest("button.del");
  if (!b || !confirm("Delete this moment?")) return;
  if (await save(sb.from("events").delete().eq("id", b.dataset.id), "Deleted")) await loadFirsts();
});

// ============================================================
//  TABS + SHEETS
// ============================================================
document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".nav button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== b.dataset.tab));
  window.scrollTo(0, 0);
}));

function openSheet(id) { $(id).classList.add("on"); }
function closeSheets() { document.querySelectorAll(".backdrop").forEach((b) => b.classList.remove("on")); }
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheets));
document.querySelectorAll(".backdrop").forEach((b) => b.addEventListener("click", (e) => { if (e.target === b) closeSheets(); }));

// ============================================================
//  OFFLINE SHELL: the service worker caches the app's own files
// ============================================================
if ("serviceWorker" in navigator) {
  // A new version takes over → reload once so the phone shows it straight away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(console.error));
}
