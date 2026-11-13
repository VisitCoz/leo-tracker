// ============================================================
//  Leo Tracker: the simple app. Three tabs: Sleep, Growth, Firsts.
//  Plain JavaScript, no build step. Loads after config.js and the
//  Supabase library (see index.html).
//
//  Data (same tables and columns as the old app, no schema change):
//    events  type 'bitacora'   subtype = a line of the sleep coach's sheet (see GROUPS), start_at = when,
//                              note = {"day":"YYYY-MM-DD"} (the sheet it is on). 'nfeed' = a night feed
//                              (any number per sheet); 'notes' = {"day","text"}, start_at = noon that day.
//                              One "Woke up" tap writes s{n}_woke, s{n}_end and s{n}_out with the same time;
//                              a resettled nap is s{n}_woke, then s{n}_back (back asleep), then s{n}_end + s{n}_out.
//    events  type 'coach_plan' one row (the latest by start_at), note = JSON: the coach's numbers and
//                              words, which stay out of this public code (see COACH PLAN)
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
let coach = null;  // the coach_plan row's JSON; null = the plan features stay hidden
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
  await Promise.all([loadCoach(), loadBita(), loadFirsts(), loadGrowth()]);
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
  { t: "Nap 1", n: 1, steps: NAP(1) },
  { t: "Midday", steps: [{ k: "feed2", en: "Milk", es: "Toma" }, { k: "lunch", en: "Lunch", es: "Lunch" }] },
  { t: "Nap 2", n: 2, steps: NAP(2) },
  { t: "Afternoon", steps: [{ k: "feed3", en: "Milk", es: "Toma" }, { k: "comida", en: "Meal", es: "Comida" }] },
  { t: "Nap 3 (only if Isa says so)", n: 3, steps: NAP(3) },
  { t: "Evening", steps: [{ k: "routine", en: "Bedtime routine started", es: "Rutina de noche" }] },
  { t: "Night", steps: [
    { k: "n_crib", en: "In crib", es: "Metí a la cuna" }, { k: "n_asleep", en: "Fell asleep", es: "Se durmió" },
    { k: "n_w1", en: "Night wake-up 1", es: "Despertar 1" }, { k: "n_w2", en: "Night wake-up 2", es: "Despertar 2" },
    { k: "n_w3", en: "Night wake-up 3", es: "Despertar 3" }, { k: "n_w4", en: "Night wake-up 4", es: "Despertar 4" },
    { k: "n_w5", en: "Night wake-up 5", es: "Despertar 4" }, { k: "n_end", en: "Night over, morning", es: "Fin de la noche" }] },
];
const BACK = (n) => ({ k: `s${n}_back`, en: "Back asleep", es: "Se volvió a dormir" }); // not on her form
const STEPS = GROUPS.flatMap((g) => g.steps.map((s) => ({ ...s, g: g.t })));
const STEP = Object.fromEntries([...STEPS, BACK(1), BACK(2), BACK(3)].map((s) => [s.k, s]));

const json = (s) => { try { return JSON.parse(s || "{}") || {}; } catch (e) { return {}; } };
// "2:10 am", the way the coach's paper form writes times
const h12 = (d) => `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "am" : "pm"}`;

// The lines the log shows for a nap: 3, as one "Woke up" tap stamps Despertar, Fin de siesta and
// Salió de la cuna together (also = the rows a line writes with its own k). After "Resettling"
// it is 5: woke, back asleep, woke up. An older sheet, tapped line by line, keeps its 5 lines.
function napLines(n, o) {
  const k = (x) => `s${n}_${x}`, m = (x) => o[k(x)] && Math.floor(new Date(o[k(x)].start_at) / 60000);
  const woke = m("woke"), end = m("end"), out = m("out");
  const head = [STEP[k("crib")], STEP[k("asleep")]];
  if (!o[k("back")] && (end || out) && !(woke && (!end || end === woke) && (!out || out === woke))) return NAP(n);
  if (o[k("back")] || (woke && !end && !out)) return [...head, { k: k("woke"), en: "Woke, resettling", es: "Despertar" }, BACK(n),
    { k: k("end"), also: [k("out")], en: "Woke up · out of crib", es: "Fin de siesta · Salió de la cuna", short: "Woke up" }];
  return [...head, { k: k("woke"), also: [k("end"), k("out")], en: "Woke up · out of crib", es: "Despertar · Salió de la cuna", short: "Woke up" }];
}
const lines = (o) => GROUPS.flatMap((g) => (g.n ? napLines(g.n, o) : g.steps).map((s) => ({ ...s, g: g.t })));
const lineOf = (o, k) => lines(o).find((s) => s.k === k) || { ...STEP[k], g: "" };

// One nap in minutes since the sheet's midnight. Length = asleep → woke, plus back → end after a resettle.
const minOf = (day, at) => Math.floor((new Date(at) - fromIsoDay(day)) / 60000);
function napOf(o, n, day) {
  const g = (x) => (o[`s${n}_${x}`] ? minOf(day, o[`s${n}_${x}`].start_at) : null);
  const crib = g("crib"), asleep = g("asleep"), woke = g("woke"), back = g("back"), end = g("end") ?? g("out");
  const started = crib != null || asleep != null, done = end != null;
  const total = asleep != null && woke != null && done ? woke - asleep + (back != null ? end - back : 0) : null;
  return { n, crib, asleep, woke, back, end, started, done, open: started && !done, total };
}
// "40 min", "1 h 24"; and minutes since midnight as "9:26 AM" or "9:26"
const dl = (d) => { d = Math.round(d); if (d < 60) return `${d} min`; const h = Math.floor(d / 60), r = d % 60; return r ? `${h} h ${pad(r)}` : `${h} h`; };
const fmt = (m) => { const h = Math.floor(m / 60) % 24; return `${h % 12 || 12}:${pad(m % 60)} ${h < 12 ? "AM" : "PM"}`; };
const fmtS = (m) => fmt(m).slice(0, -3);

// ============================================================
//  COACH PLAN: the next sleep time, under the big button. The coach's times, lengths and words
//  are not in this public code: they come from one events row (type 'coach_plan', the latest by
//  start_at), note = JSON. This is only the engine: the day type from a wake-up threshold, clock
//  lookups, shifts, floors, caps and {placeholder} text. No row, or one it can't read = the plan
//  line, the complete/wake line, the nap tags and the short-nap question stay hidden.
// ============================================================
async function loadCoach() {
  const { data, error } = await sb.from("events").select("note").eq("type", "coach_plan").order("start_at", { ascending: false }).limit(1);
  if (error) console.error(error);
  const c = json(data && data[0] && data[0].note);
  coach = c.days && c.days.early && c.days.normal && c.floor && c.min && c.text ? c : null;
  renderSleep();
}
const safe = (f) => { try { return f(); } catch (e) { console.error(e); return null; } };
const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const fill = (tpl, v) => String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : ""));
const full = (y) => y.total != null && y.total >= coach.min.complete;

// → { main, why, flag } for a sheet at a moment, or null (the night has started).
function plan(o, day, nowAt) {
  if (o.n_crib) return null;
  const c = coach, x = c.text, m = c.min, now = minOf(day, nowAt);
  if (!o.wake) return { main: x.no_wake, why: x.no_wake_why };
  const early = minOf(day, o.wake.start_at) <= hm(c.early_by), t = c.days[early ? "early" : "normal"];
  const n1 = napOf(o, 1, day), n2 = napOf(o, 2, day), flags = [];
  const late = (n, start, at) => { if (start - at >= m.late_flag) flags.push(fill(x.late, { n, d: dl(start - at), planned: fmtS(at) })); };
  const out = (p) => { if (flags.length) p.flag = [p.flag, ...flags].filter(Boolean).join(" "); return p; };
  const open = (n, y) => {
    if (y.asleep == null) {
      if (now < y.crib + m.fall_asleep) return { main: fill(x.fall, { until: fmt(y.crib + m.fall_asleep) }), why: x.fall_why };
      if (n === 1) return { main: fill(x.retry, { at: fmt(y.crib + m.retry_after) }), why: x.retry_why };
      return { main: fill(x.bed, { at: fmt(hm(t.bed)) }), why: x.fixed_why, flag: x.last_missed_flag };
    }
    if (y.woke != null && y.back == null) return now <= y.woke + m.resettle
      ? { main: fill(x.resettle, { until: fmt(y.woke + m.resettle) }), why: x.resettle_why }
      : { main: fill(x.resettle_over, { at: fmt(y.woke + m.resettle) }), why: x.resettle_over_why };
    if (y.back != null) return { main: fill(x.wake_by, { at: fmt(y.back + m.max - (y.woke - y.asleep)) }), why: x.wake_by_back_why };
    return { main: fill(x.wake_by, { at: fmt(y.asleep + m.max) }), why: fill(x.wake_by_why, { complete: fmt(y.asleep + m.complete) }) };
  };

  if (n1.crib != null) late(1, n1.crib, hm(t.n1));
  if (!n1.started) return { main: fill(x.nap, { n: 1, at: fmt(hm(t.n1)) }), why: early ? x.n1_early : x.n1_normal };
  if (n1.open) return out(open(1, n1));
  // nap 1 is over: where nap 2 goes
  let n2t = hm(t.n2), why = x.nothing_moves;
  if (n1.asleep == null) { n2t = hm(c.missed_n2); why = x.after_missed; }
  else if (!full(n1)) { n2t -= m.short_shift; why = x.short; if (n2t < hm(c.floor.n2)) { n2t = hm(c.floor.n2); why = x.n2_floor; } }
  if (n2.crib != null) late(2, n2.crib, n2t);
  if (!n2.started) return out({ main: fill(x.nap, { n: 2, at: fmt(n2t) }), why });
  if (n2.open) return out(open(2, n2));
  // nap 2 is over: bed
  let bed = hm(t.bed), whyB = early ? x.bed_early : x.nothing_moves;
  if (!full(n2)) { bed -= m.short_shift; whyB = x.short; if (bed < hm(c.floor.bed)) { bed = hm(c.floor.bed); whyB = x.bed_floor; } }
  return out({ main: fill(x.bed, { at: fmt(bed) }), why: whyB });
}

// The hero's second line while a nap is open.
function heroPlan(y) {
  const x = coach.text, m = coach.min;
  if (y.back != null) return fill(x.hero_back, { wake: fmtS(y.back + m.max - (y.woke - y.asleep)) });
  if (y.woke != null) return fill(x.hero_resettle, { until: fmtS(y.woke + m.resettle) });
  return y.asleep != null ? fill(x.hero_asleep, { complete: fmtS(y.asleep + m.complete), wake: fmtS(y.asleep + m.max) }) : "";
}

// A nap group's header, once the nap is over: "· 1 h 24 · complete".
function napTag(o, n, day) {
  const y = napOf(o, n, day);
  if (y.done && y.asleep == null) return ` <span class="res short">· never fell asleep</span>`;
  if (y.done && y.total != null) {
    const ok = coach && safe(() => full(y)), tag = coach && coach.text[ok ? "complete_tag" : "short_tag"];
    const parts = y.back != null ? ` (${dl(y.woke - y.asleep)} + ${dl(y.end - y.back)})` : "";
    return ` <span class="res${tag ? (ok ? " ok" : " short") : ""}">· ${dl(y.total)}${tag ? ` · ${esc(tag)}` : ""}${parts}</span>`;
  }
  return y.open && y.woke != null && y.back == null ? ` <span class="res short">· resettling</span>` : "";
}

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
// From 4 PM today, once nap 2 is over, the routine is next. Nap 3 is never proposed (tap it by hand).
function nextKey(o, skip, now, isToday) {
  if (skip && !o[skip]) return skip;
  const steps = lines(o);
  let last = -1;
  steps.forEach((s, i) => { if (o[s.k]) last = i; });
  if (last < 0) return now.getHours() >= 16 && isToday ? "routine" : "wake";
  if (now.getHours() >= 16 && isToday && napOf(o, 2, isoDay(now)).done && !o.routine && !o.n_crib) return "routine";
  const s = steps.slice(last + 1).find((x) => !o[x.k] && !x.k.startsWith("s3_"));
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
  // The nap a row belongs to, measured on its own sheet.
  const napAt = (r) => { const m = r && /^s(\d)_/.exec(r.subtype), day = r && json(r.note).day; return m && bita[day] ? napOf(bita[day], +m[1], day) : null; };
  // He woke for good: the morning, the night's end, or a nap's wake-up (its end, after a resettle).
  const woke = stamps.find((r) => r.subtype === "wake" || r.subtype === "n_end" ||
    (/^s\d_(woke|end)$/.test(r.subtype) && napAt(r) && (napAt(r).back != null) === r.subtype.endsWith("_end")));
  const nap = napAt(top);
  let eye = "Awake for", sub, sub2 = "", asleep = false;
  heroSince = null;
  if (!top) { eye = "Sleep"; sub = "No times yet today"; }
  else if (/_(asleep|back)$/.test(top.subtype)) {
    heroSince = new Date(top.start_at); asleep = true;
    eye = "Asleep for"; sub = `${top.subtype.endsWith("_back") ? "Back asleep" : "Fell asleep"} at ${clock(heroSince)}`;
  } else if (top.subtype.startsWith("n_w")) {
    heroSince = new Date(top.start_at); asleep = true;
    eye = `Woke at ${clock(heroSince)}`; sub = STEP[top.subtype].en;
  } else if (nap && nap.open && nap.woke != null && top.subtype.endsWith("_woke")) {
    heroSince = new Date(top.start_at); eye = "Resettling"; sub = `Woke at ${clock(heroSince)}`;
  } else if (woke) {
    heroSince = new Date(woke.start_at); sub = `Woke up at ${clock(heroSince)}`;
    const y = napAt(woke);
    if (y && y.done && y.total != null) sub2 = `Last nap: ${dl(y.total)}`;
  } else { eye = "Awake"; sub = `${STEP[top.subtype].en} at ${clock(new Date(top.start_at))}`; }
  if (coach && nap && nap.open && /_(asleep|back|woke)$/.test(top.subtype)) sub2 = safe(() => heroPlan(nap)) || "";
  $("hero").className = "card hero " + (asleep ? "zone-asleep" : "zone-awake");
  $("hero-eye").textContent = eye;
  $("hero-sub").textContent = sub;
  $("hero-sub2").textContent = sub2;
  $("hero-sub2").classList.toggle("hidden", !sub2);

  // Night = fell asleep → night over, on last night's sheet (wake-ups included: the sheet
  // has no "back asleep" line). Naps = each nap's length (both blocks of a resettled nap), summed over today's sheet.
  const span = (o, a, b) => (o && o[a] && o[b] ? Math.max(0, new Date(o[b].start_at) - new Date(o[a].start_at)) : 0);
  const night = span(bita[isoDay(dayAgo(1))], "n_asleep", "n_end");
  const td = isoDay(new Date()), ot = bita[td];
  const naps = ot ? [1, 2, 3].reduce((sum, n) => sum + Math.max(0, napOf(ot, n, td).total || 0), 0) * 60000 : 0;
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

  const nk = next(), L = nk && lineOf(o, nk);
  $("next-lbl").textContent = nk ? "Next step" : "Done";
  $("big").disabled = !nk;
  $("big").innerHTML = nk ? `${esc(L.short || L.en)}<small>${esc(L.g)} · tap to stamp ${clock(now)}</small>`
    : `Day complete<small>Open “Form for Isa” to send it</small>`;
  const p = coach && safe(() => plan(o, day, now));
  $("plan").innerHTML = p ? `<div class="isa"><div class="isa-h"><b>${esc(coach.label || "")}</b><span class="tag">${esc(coach.tag || "")}</span></div>` +
    `<p class="isa-main">${esc(p.main)}${p.why ? ` <span>· ${esc(p.why)}</span>` : ""}</p>` +
    (p.flag ? `<div class="isa-flag">⚠ ${esc(p.flag)}</div>` : "") + `</div>` : "";
  $("night-over").classList.toggle("hidden", !(o.n_asleep && !o.n_end && nk !== "n_end"));
  $("skip").disabled = !nk;
  $("feed").textContent = o.feeds.length ? `+ Night feed (${o.feeds.map((r) => clock(new Date(r.start_at))).join(", ")})` : "+ Night feed now";

  const typed = editKey && $("edit-time") ? $("edit-time").value : null; // keep a half-typed time across a live reload
  $("groups").innerHTML = GROUPS.map((g) => `<section class="card steps"><h2>${esc(g.t)}${g.n ? napTag(o, g.n, day) : ""}</h2>` +
    (g.n ? napLines(g.n, o) : g.steps).map((s) => {
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
  // A resettled nap gets a line in the notes, written from its times (not stored).
  const auto = [1, 2, 3].filter((n) => o[`s${n}_woke`] && o[`s${n}_back`])
    .map((n) => `Siesta ${n}: despertó ${t(`s${n}_woke`)}, se volvió a dormir ${t(`s${n}_back`)}.`);
  const text = [...auto, o.notes ? json(o.notes.note).text : ""].filter(Boolean).join(" ");
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

// Every change to a line goes through here. keys = the rows the line writes together (one tap
// on "Woke up" = three rows); at = null clears them. The previous state is kept so "Undo" can put
// it back. stamp = a new stamp: the bar can then move it a few minutes earlier.
let busy = false;
async function write(keys, at, msg, stamp) {
  if (busy) return;
  busy = true;
  const day = sheetDay(), o = cur();
  const rows = keys.filter((k) => at || o[k]).map((k) => ({ k, row: o[k] || null, id: o[k] ? o[k].id : crypto.randomUUID() }));
  const q = !at ? sb.from("events").delete().in("id", rows.map((r) => r.id))
    : sb.from("events").upsert(rows.map(({ k, row, id }) => ({ id, type: "bitacora", subtype: k, start_at: at.toISOString(), note: row ? row.note : JSON.stringify({ day }) })));
  if (rows.length && await save(q)) {
    lastAct = { k: keys[0], at, label: msg.split(" · ")[0], rows: rows.map(({ row, id }) => ({ id, prev: row && { id, type: row.type, subtype: row.subtype, start_at: row.start_at, note: row.note } })) };
    skipTo = null; editKey = null;
    showBar(msg, stamp);
  }
  await loadBita();
  busy = false;
}

// A tap on a line. "Woke up" under the coach's complete length first asks: resettling, or nap over?
let shortTap = null;
function stampNow(k) {
  const o = cur(), day = sheetDay(), L = lineOf(o, k), now = new Date(), m = /^s(\d)_woke$/.exec(k);
  const y = m && L.also && coach && napOf(o, +m[1], day);
  if (y && y.asleep != null && minOf(day, now) - y.asleep < coach.min.complete) {
    shortTap = { n: +m[1], at: now };
    $("short-h").textContent = `He slept ${dl(minOf(day, now) - y.asleep)}.`;
    $("short-p").textContent = coach.text.sheet || "";
    openSheet("bd-short");
    return;
  }
  write([k, ...(L.also || [])], now, `${L.short || L.en} · Stamped ${clock(now)}`, true);
}
$("short-resettle").addEventListener("click", () => {
  if (!shortTap) return;
  const { n, at } = shortTap;
  shortTap = null; closeSheets();
  write([`s${n}_woke`], at, `Woke, resettling · Stamped ${clock(at)}`, true);
});
$("short-over").addEventListener("click", () => {
  if (!shortTap) return;
  const { n, at } = shortTap;
  shortTap = null; closeSheets();
  write([`s${n}_woke`, `s${n}_end`, `s${n}_out`], at, `Woke up · Stamped ${clock(at)}`, true);
});

// The bar after a change: Undo for about 8 seconds, and after a stamp "5 min ago · 10 · 15 · other"
// for a tap made late.
let barTimer;
function showBar(msg, moves) {
  $("undo-msg").textContent = msg;
  $("late").classList.toggle("hidden", !moves);
  $("late-other").classList.toggle("hidden", lastAct.k === "nfeed");
  $("undo-bar").classList.remove("hidden");
  const line = $("undo-line");
  line.classList.remove("run"); void line.offsetWidth; line.classList.add("run");
  clearTimeout(barTimer);
  barTimer = setTimeout(hideBar, 8000);
}
function hideBar() { clearTimeout(barTimer); lastAct = null; $("undo-bar").classList.add("hidden"); }

$("big").addEventListener("click", () => { const k = next(); if (k) stampNow(k); });
$("night-over").addEventListener("click", () => stampNow("n_end"));
$("feed").addEventListener("click", () => write(["nfeed"], new Date(), `Night feed · Stamped ${clock(new Date())}`, true));
$("skip").addEventListener("click", () => {
  const k = next(), o = cur(), steps = lines(o);
  const s = k && steps.slice(steps.findIndex((x) => x.k === k) + 1).find((x) => !o[x.k]);
  if (s) { skipTo = s.k; renderSleep(); }
});
$("undo").addEventListener("click", async () => {
  if (!lastAct || busy) return;
  const { rows } = lastAct;
  hideBar();
  const prev = rows.filter((r) => r.prev).map((r) => r.prev), added = rows.filter((r) => !r.prev).map((r) => r.id);
  if ((!prev.length || await save(sb.from("events").upsert(prev))) && (!added.length || await save(sb.from("events").delete().in("id", added)))) toast("Undone");
  await loadBita();
});
$("late").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || !lastAct || busy) return;
  const a = lastAct;
  if (b.dataset.min === "other") {
    hideBar(); editKey = a.k; renderSleep();
    const row = document.querySelector(`[data-k="${a.k}"]`);
    if (row) row.scrollIntoView({ block: "center" });
    return;
  }
  busy = true;
  const at = new Date(a.at.getTime() - b.dataset.min * 60000);
  if (await save(sb.from("events").update({ start_at: at.toISOString() }).in("id", a.rows.map((r) => r.id)))) {
    showBar(`${a.label} · Moved to ${clock(at)} (${b.dataset.min} min earlier)`, true);
  }
  await loadBita();
  busy = false;
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
    const at = atTime(sheetDay(), v, editKey.startsWith("n_")), L = lineOf(o, editKey);
    write([editKey, ...(L.also || [])], at, `${L.en} → ${clock(at)}`);
  } else if (b.dataset.act === "clear") {
    const L = lineOf(o, editKey);
    write([editKey, ...(L.also || [])], null, `Cleared: ${L.en}`);
  }
});

function openDay(step) {
  const d = fromIsoDay(sheetDay());
  const nd = isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + step));
  pickedDay = nd === autoDay(new Date(), bita) ? null : nd;
  skipTo = null; editKey = null;
  hideBar();
  renderSleep();
}
// Back on screen after hours in the background: return to the sheet the clock says.
document.addEventListener("visibilitychange", () => { if (!document.hidden && started) { pickedDay = null; loadBita(); loadCoach(); } });
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
