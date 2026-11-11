// ============================================================
//  Leo Tracker: the simple app. Three tabs: Sleep, Growth, Firsts.
//  Plain JavaScript, no build step. Loads after config.js and the
//  Supabase library (see index.html).
//
//  Data (same tables and columns as the old app, no schema change):
//    events  type 'bitacora'   subtype = a line of the sleep coach's sheet (see GROUPS), start_at = when,
//                              note = {"day":"YYYY-MM-DD"} (the sheet it is on). 'nfeed' = a night feed
//                              (any number per sheet); 'notes' = {"day","text"}, start_at = noon that day.
//    events  type 'sleep'      the old sleep log: kept in the database, no longer shown
//    events  type 'milestone'  note = what happened, start_at = when
//    growth  kind 'weight' (kg) | 'height' (cm), value, measured_at (a date)
// ============================================================

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LEO_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BIRTH = new Date(2026, 0, 23); // 23 Jan 2026 (month is 0-indexed)

let bitaRows = []; // bitacora rows from 3 days ago onward
let bita = {};     // the same rows grouped by sheet day (see byDay)
let pickedDay = null; // a sheet chosen with ‹ ›; null = the sheet the clock says
let skipTo = null, editKey = null, lastAct = null, heroSince = null;
let firsts = [];   // milestone rows, newest first
let growth = [];   // weight/height rows, newest first
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
  await Promise.all([loadBita(), loadFirsts(), loadGrowth()]);
  // Both phones stay in step: any change by the other parent reloads the data.
  // Subscribed once per page load, even after signing out and back in.
  if (live) return;
  live = true;
  sb.channel("leo-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, () => { loadBita(); loadFirsts(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "growth" }, loadGrowth)
    .subscribe();
}

// ============================================================
//  SLEEP: the Bitácora, the sleep coach's day sheet. One tap stamps one line.
// ============================================================
// The lines, in the sheet's order. Spanish labels are the coach's own; her form
// prints the fifth night wake-up as "Despertar 4" too, so it does here.
const NAP = (n) => [
  { k: `s${n}_crib`, en: "In crib", es: "Metí a la cuna" },
  { k: `s${n}_asleep`, en: "Fell asleep", es: "Se durmió" },
  { k: `s${n}_woke`, en: "Woke", es: "Despertar" },
  { k: `s${n}_end`, en: "Nap over", es: "Fin de siesta" },
  { k: `s${n}_out`, en: "Out of crib", es: "Salió de la cuna" },
];
const GROUPS = [
  { t: "Morning", steps: [{ k: "wake", en: "Woke up", es: "Despierta" }, { k: "feed1", en: "Milk", es: "Toma" }, { k: "bfast", en: "Breakfast", es: "Desayuno" }] },
  { t: "Nap 1", steps: NAP(1) },
  { t: "Midday", steps: [{ k: "feed2", en: "Milk", es: "Toma" }, { k: "lunch", en: "Lunch", es: "Lunch" }] },
  { t: "Nap 2", steps: NAP(2) },
  { t: "Afternoon", steps: [{ k: "feed3", en: "Milk", es: "Toma" }, { k: "comida", en: "Meal", es: "Comida" }] },
  { t: "Nap 3 (only if Isa says so)", steps: NAP(3) },
  { t: "Evening", steps: [{ k: "routine", en: "Bedtime routine started", es: "Rutina de noche" }] },
  { t: "Night", steps: [
    { k: "n_crib", en: "In crib", es: "Metí a la cuna" }, { k: "n_asleep", en: "Fell asleep", es: "Se durmió" },
    { k: "n_w1", en: "Night wake-up 1", es: "Despertar 1" }, { k: "n_w2", en: "Night wake-up 2", es: "Despertar 2" },
    { k: "n_w3", en: "Night wake-up 3", es: "Despertar 3" }, { k: "n_w4", en: "Night wake-up 4", es: "Despertar 4" },
    { k: "n_w5", en: "Night wake-up 5", es: "Despertar 4" }, { k: "n_end", en: "Night over, morning", es: "Fin de la noche" }] },
];
const STEPS = GROUPS.flatMap((g) => g.steps.map((s) => ({ ...s, g: g.t })));
const STEP = Object.fromEntries(STEPS.map((s) => [s.k, s]));

const json = (s) => { try { return JSON.parse(s || "{}") || {}; } catch (e) { return {}; } };
// "2:10 am", the way the coach's paper form writes times
const h12 = (d) => `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "am" : "pm"}`;

// Rows → { "2026-11-11": { wake: row, n_w1: row, …, notes: row, feeds: [rows, oldest first] } }
function byDay(rows) {
  const out = {};
  for (const r of rows) {
    const day = json(r.note).day;
    if (!day) continue;
    const o = out[day] || (out[day] = { feeds: [] });
    if (r.subtype === "nfeed") o.feeds.push(r); else o[r.subtype] = r;
  }
  for (const o of Object.values(out)) o.feeds.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  return out;
}

// The sheet "now" belongs on: today's, but yesterday's before 6 AM, or before noon
// while yesterday's night is still open (in crib, and no "Night over" yet).
function autoDay(now, days) {
  const y = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (now.getHours() < 6) return y;
  const o = days[y];
  if (now.getHours() < 12 && o && o.n_crib && !o.n_end) return y;
  return isoDay(now);
}

// The next line to stamp: the first empty one after the last filled one.
// An empty sheet starts at "Woke up", or at the bedtime routine from 4 PM today.
function nextKey(o, skip, now, isToday) {
  if (skip && !o[skip]) return skip;
  let last = -1;
  STEPS.forEach((s, i) => { if (o[s.k]) last = i; });
  if (last < 0) return now.getHours() >= 16 && isToday ? "routine" : "wake";
  const s = STEPS.slice(last + 1).find((x) => !o[x.k]);
  return s ? s.k : null;
}

// A typed "HH:MM" on a sheet. Night lines before noon are after midnight: the next calendar day.
function atTime(day, hm, night) {
  const [h, m] = hm.split(":").map(Number);
  const d = fromIsoDay(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (night && h < 12 ? 1 : 0), h, m);
}

const sheetDay = () => pickedDay || autoDay(new Date(), bita);
const cur = () => { const d = sheetDay(); return bita[d] || (bita[d] = { feeds: [] }); };
const next = () => nextKey(cur(), skipTo, new Date(), sheetDay() === isoDay(new Date()));

async function loadBita() {
  const { data, error } = await sb.from("events").select("*").eq("type", "bitacora")
    .gte("start_at", dayAgo(3).toISOString()).order("start_at");
  if (error) { console.error(error); return; }
  bitaRows = data || [];
  bita = byDay(bitaRows);
  renderSleep();
}

// The big clock, from the latest stamp: asleep, a night wake-up, or awake since he last woke.
function renderHero() {
  const stamps = bitaRows.filter((r) => STEP[r.subtype]).sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
  const top = stamps[0];
  const woke = stamps.find((r) => r.subtype === "wake" || r.subtype === "n_end" || /^s\d_woke$/.test(r.subtype));
  let eye = "Awake for", sub, asleep = false;
  heroSince = null;
  if (!top) { eye = "Sleep"; sub = "No times yet today"; }
  else if (top.subtype.endsWith("_asleep")) {
    heroSince = new Date(top.start_at); asleep = true;
    eye = "Asleep for"; sub = `Fell asleep at ${clock(heroSince)}`;
  } else if (top.subtype.startsWith("n_w")) {
    heroSince = new Date(top.start_at); asleep = true;
    eye = `Woke at ${clock(heroSince)}`; sub = STEP[top.subtype].en;
  } else if (woke) { heroSince = new Date(woke.start_at); sub = `Woke up at ${clock(heroSince)}`; }
  else { eye = "Awake"; sub = `${STEP[top.subtype].en} at ${clock(new Date(top.start_at))}`; }
  $("hero").className = "card hero " + (asleep ? "zone-asleep" : "zone-awake");
  $("hero-eye").textContent = eye;
  $("hero-sub").textContent = sub;

  // Night = fell asleep → night over, on last night's sheet (wake-ups included: the sheet
  // has no "back asleep" line). Naps = fell asleep → woke, summed over today's sheet.
  const span = (o, a, b) => (o && o[a] && o[b] ? Math.max(0, new Date(o[b].start_at) - new Date(o[a].start_at)) : 0);
  const night = span(bita[isoDay(dayAgo(1))], "n_asleep", "n_end");
  const naps = [1, 2, 3].reduce((sum, n) => sum + span(bita[isoDay(new Date())], `s${n}_asleep`, `s${n}_woke`), 0);
  $("pair-a").textContent = night ? dur(night) : "—";
  $("pair-b").textContent = naps ? dur(naps) : "—";
  tick();
}

function renderSleep() {
  renderHero();
  const now = new Date(), day = sheetDay(), o = cur(), today = isoDay(now);
  $("day-title").textContent = fromIsoDay(day).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "short" });
  $("day-sub").textContent = day === today ? "Today"
    : day === isoDay(dayAgo(1)) ? (o.n_crib && !o.n_end ? "Yesterday's sheet · night still open" : "Yesterday") : "";
  $("day-prev").disabled = day <= isoDay(dayAgo(3));
  $("day-next").disabled = day >= today;

  const nk = next();
  $("next-lbl").textContent = nk ? "Next step" : "Done";
  $("big").disabled = !nk;
  $("big").innerHTML = nk ? `${esc(STEP[nk].en)}<small>${esc(STEP[nk].g)} · tap to stamp ${clock(now)}</small>`
    : `Day complete<small>Open “Form for Isa” to send it</small>`;
  $("night-over").classList.toggle("hidden", !(o.n_asleep && !o.n_end && nk !== "n_end"));
  $("skip").disabled = !nk;
  $("feed").textContent = o.feeds.length ? `+ Night feed (${o.feeds.map((r) => clock(new Date(r.start_at))).join(", ")})` : "+ Night feed now";

  const typed = editKey && $("edit-time") ? $("edit-time").value : null; // keep a half-typed time across a live reload
  $("groups").innerHTML = GROUPS.map((g) => `<section class="card steps"><h2>${esc(g.t)}</h2>` + g.steps.map((s) => {
    const r = o[s.k];
    let h = `<button class="step${s.k === nk ? " next" : ""}" data-k="${s.k}"><span>${esc(s.en)}<small>${esc(s.es)}</small></span>` +
      `<b class="${r ? "" : "empty"}">${r ? clock(new Date(r.start_at)) : "tap"}</b></button>`;
    if (r && s.k === editKey) {
      h += `<div class="edit"><input type="time" id="edit-time" value="${typed || localInput(new Date(r.start_at)).slice(11)}">` +
        `<button class="btn btn-primary" data-act="save">Save</button><button class="btn btn-ghost" data-act="clear">Clear</button></div>`;
    }
    return h;
  }).join("") + `</section>`).join("");

  if (document.activeElement !== $("notes")) $("notes").value = o.notes ? json(o.notes.note).text || "" : "";
  renderPaper(day, o);
}

// "Form for Isa": the coach's own table, in Spanish, filled from the stamps. Screenshot it to send.
function renderPaper(day, o) {
  const t = (k) => (o[k] ? h12(new Date(o[k].start_at)) : "");
  const td = (txt, cls, span) => `<td class="${cls || ""}"${span ? ` colspan="${span}"` : ""}>${esc(txt)}</td>`;
  const single = (k) => `<tr>${td(STEP[k].es)}${td(t(k), "v")}${td("", "x", 4)}</tr>`;
  const block = (title, keys) => {
    const fill = keys.length < 5 ? td("", "x", 5 - keys.length) : "";
    return `<tr><th>${esc(title)}</th>${keys.map((k) => `<th>${esc(STEP[k].es)}</th>`).join("")}${fill}</tr>` +
      `<tr>${td("◷", "ic")}${keys.map((k) => td(t(k), "v")).join("")}${fill}</tr>`;
  };
  const nap = (n) => NAP(n).map((s) => s.k);
  const text = o.notes ? json(o.notes.note).text : "";
  $("paper").innerHTML =
    `<p class="ph">Bitácora de sueño día <span>${esc(fromIsoDay(day).toLocaleDateString("es-MX", { day: "numeric", month: "short" }))}</span></p>` +
    `<table>${single("wake")}${single("feed1")}${single("bfast")}${block("Siesta 1", nap(1))}${single("feed2")}${single("lunch")}` +
    `${block("Siesta 2", nap(2))}${single("feed3")}${single("comida")}${block("Siesta 3", nap(3))}${single("routine")}` +
    `${block("Sueño nocturno", ["n_crib", "n_asleep", "n_w1", "n_w2", "n_w3"])}${block("", ["n_w4", "n_w5", "n_end"])}</table>` +
    (o.feeds.length ? `<p class="pn">Tomas nocturnas: ${esc(o.feeds.map((r) => h12(new Date(r.start_at))).join(" · "))}</p>` : "") +
    (text ? `<p class="pn">Notas: ${esc(text)}</p>` : "");
}

// The big clock ticks every second.
function tick() {
  if (!heroSince) { $("hero-time").textContent = "—"; return; }
  const s = Math.max(0, Math.floor((Date.now() - heroSince) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  $("hero-time").innerHTML = (h ? `${h}h ${m}m` : `${m}m`) + `<small>${pad(s % 60)}s</small>`;
}
setInterval(() => { if (started) tick(); }, 1000);
// Once a minute: the "tap to stamp" time, and the sheet moving to a new day.
setInterval(() => { if (started && !editKey && document.activeElement !== $("notes")) renderSleep(); }, 60000);

// Every change to a line goes through here. row = the line's row now (null = new);
// at = null clears the line. The previous state is kept so "Undo" can put it back.
let busy = false;
async function write(k, at, row, msg) {
  if (busy) return;
  busy = true;
  const day = sheetDay();
  const id = row ? row.id : crypto.randomUUID();
  const q = !at ? sb.from("events").delete().eq("id", id)
    : row ? sb.from("events").update({ start_at: at.toISOString() }).eq("id", id)
    : sb.from("events").insert({ id, type: "bitacora", subtype: k, start_at: at.toISOString(), note: JSON.stringify({ day }) });
  if (await save(q)) {
    lastAct = { id, prev: row && { id, type: row.type, subtype: row.subtype, start_at: row.start_at, note: row.note } };
    skipTo = null; editKey = null;
    $("undo-msg").textContent = msg;
    $("undo-bar").classList.remove("hidden");
  }
  await loadBita();
  busy = false;
}
const stampNow = (k) => write(k, new Date(), cur()[k] || null, `${STEP[k].en} · ${clock(new Date())}`);

$("big").addEventListener("click", () => { const k = next(); if (k) stampNow(k); });
$("night-over").addEventListener("click", () => stampNow("n_end"));
$("feed").addEventListener("click", () => write("nfeed", new Date(), null, `Night feed · ${clock(new Date())}`));
$("skip").addEventListener("click", () => {
  const k = next(), o = cur();
  const s = k && STEPS.slice(STEPS.findIndex((x) => x.k === k) + 1).find((x) => !o[x.k]);
  if (s) { skipTo = s.k; renderSleep(); }
});
$("undo").addEventListener("click", async () => {
  if (!lastAct || busy) return;
  const { id, prev } = lastAct;
  lastAct = null;
  $("undo-bar").classList.add("hidden");
  await save(prev ? sb.from("events").upsert(prev) : sb.from("events").delete().eq("id", id), "Undone");
  await loadBita();
});

// Tap an empty line = stamp it now. Tap a filled line = fix its time or clear it.
$("groups").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const o = cur();
  if (b.dataset.k) {
    if (!o[b.dataset.k]) stampNow(b.dataset.k);
    else { editKey = editKey === b.dataset.k ? null : b.dataset.k; renderSleep(); }
  } else if (b.dataset.act === "save") {
    const v = $("edit-time").value;
    if (!v) return;
    const at = atTime(sheetDay(), v, editKey.startsWith("n_"));
    write(editKey, at, o[editKey], `${STEP[editKey].en} → ${clock(at)}`);
  } else if (b.dataset.act === "clear") {
    write(editKey, null, o[editKey], `Cleared: ${STEP[editKey].en}`);
  }
});

function openDay(step) {
  const d = fromIsoDay(sheetDay());
  const nd = isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + step));
  pickedDay = nd === autoDay(new Date(), bita) ? null : nd;
  skipTo = null; editKey = null; lastAct = null;
  $("undo-bar").classList.add("hidden");
  renderSleep();
}
$("day-prev").addEventListener("click", () => openDay(-1));
$("day-next").addEventListener("click", () => openDay(1));

// Notes: one row per sheet, saved a moment after typing stops.
const notesId = {}; // a new sheet's notes keep one id even before the first save comes back
let notesTimer;
$("notes").addEventListener("input", () => {
  clearTimeout(notesTimer);
  const day = sheetDay(), text = $("notes").value, r = cur().notes;
  const id = r ? r.id : notesId[day] || (notesId[day] = crypto.randomUUID());
  notesTimer = setTimeout(() => save(sb.from("events").upsert({ id, type: "bitacora", subtype: "notes",
    start_at: new Date(fromIsoDay(day).getTime() + DAY / 2).toISOString(), note: JSON.stringify({ day, text }) })), 800);
});

document.querySelectorAll("#bview button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#bview button").forEach((x) => x.classList.toggle("on", x === b));
  $("bita-log").classList.toggle("hidden", b.dataset.view !== "log");
  $("bita-form").classList.toggle("hidden", b.dataset.view !== "form");
}));

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
