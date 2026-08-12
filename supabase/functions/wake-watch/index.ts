// ============================================================
//  wake-watch — Supabase Edge Function (Deno), runs every minute
//  Web Push for the handful of moments worth interrupting a parent for.
//
//  This function used to hold its OWN copy of the wake window — 60 / 15 / 90 —
//  frozen at Leo's 4-month numbers. It kept pinging an hour early, every 15
//  minutes, for months. It now carries NO numbers of its own: it reads the
//  resolved config out of `settings`, which the app writes. If the read fails,
//  it degrades to elapsed-time pings and says so in the response.
//
//  Deploy:  npx supabase functions deploy wake-watch --no-verify-jwt
//  Secrets: npx supabase secrets set \
//             VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
//  Schedule: see schema-push.sql (pg_cron → http_post every minute).
//  Check:   curl ".../wake-watch?dry=1"  → evaluates, sends nothing, writes nothing.
//  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Fallback ONLY for when the settings table can't be read. Deliberately generous
// so a failed read can never reproduce the too-early pinging this replaced.
const FALLBACK = {
  month: null as number | null,
  band: "unknown",
  ww: { min: 150, target: 165, max: 180, firstOfDay: 150, lastOfDay: 180 },
  naps: { minCount: 2, maxCount: 3, totalDayMin: 150, totalDayMax: 210, lastNapCutoff: "17:15", minUsefulNap: 30 },
  night: { bedtimeEarliest: "19:00", bedtimeLatest: "20:45", morningWakeEarliest: "06:00", expectedNightSleep: [600, 720], feedGateMin: 180 },
};
const STEP_MIN = 15;

function fmtMin(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
const hhmmToMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };
const fmtClock = (min: number) => {
  const h24 = Math.floor(min / 60) % 24, m = Math.round(min) % 60;
  const ap = h24 >= 12 ? "PM" : "AM", h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
};

// ---- Local wall-clock in Leo's timezone. Every clock-based alert depends on
// this being right; UTC would put the 5:15pm nap cutoff at lunchtime.
function localParts(tz: string, at = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) if (part.type !== "literal") p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minOfDay: hour * 60 + Number(p.minute),
    label: `${p.year}-${p.month}-${p.day} ${String(hour).padStart(2, "0")}:${p.minute}`,
  };
}

function monthsBetween(birth: string, tz: string) {
  const b = new Date(birth + "T00:00:00Z");
  const l = localParts(tz);
  const [y, m, d] = l.date.split("-").map(Number);
  let months = (y - b.getUTCFullYear()) * 12 + (m - 1 - b.getUTCMonth());
  if (d < b.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") || "mailto:leo@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

// Send one payload to every subscribed device. Cleans up expired subscriptions.
async function sendToAll(payload: string): Promise<number> {
  const { data: subs } = await supabase.from("push_subscriptions").select("endpoint, sub");
  let sent = 0;
  for (const row of subs || []) {
    try {
      await webpush.sendNotification(row.sub, payload);
      sent++;
    } catch (err: any) {
      // 404/410 = subscription expired; clean it up so we don't keep retrying.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", row.endpoint);
      }
    }
  }
  return sent;
}

// ---- Live elapsed-time notification --------------------------------
// While a breast feed OR a sleep is running, refresh a lock-screen
// notification each minute ("🍼 Feeding 22m" / "💤 Asleep 1h 05m").
// The "live-timer" tag replaces the previous one in place (renotify
// off = no buzz on each minute). Clears once the activity ends.
async function liveTimer() {
  // Bottles are instantaneous, so only breast feeds + sleeps have a running state.
  const { data: open } = await supabase
    .from("events")
    .select("id, type, subtype, start_at")
    .is("end_at", null)
    .in("type", ["breast", "sleep"])
    .order("start_at", { ascending: false });
  const active = open?.[0] || null; // most recently started, if any

  const { data: state } = await supabase
    .from("live_notify").select("event_id").eq("id", true).maybeSingle();
  const prevId = state?.event_id ?? null;

  if (!active) {
    if (prevId) {
      // Activity just ended — replace the live notification with a brief "done"
      // summary. We show a notification (rather than a content-less "clear" push)
      // because on iOS a push that displays nothing can revoke the subscription.
      const { data: done } = await supabase
        .from("events").select("type, start_at, end_at").eq("id", prevId).maybeSingle();
      let title = "Leo Tracker", body = "Tap to open Leo";
      if (done?.end_at) {
        const mins = Math.max(0, Math.floor(
          (new Date(done.end_at).getTime() - new Date(done.start_at).getTime()) / 60000));
        title = done.type === "breast" ? `✓ Fed ${fmtMin(mins)}` : `✓ Slept ${fmtMin(mins)}`;
      }
      await sendToAll(JSON.stringify({
        title, body, tag: "live-timer", renotify: false, requireInteraction: false, silent: true,
      }));
      await supabase.from("live_notify")
        .upsert({ id: true, event_id: null, kind: null, updated_at: new Date().toISOString() });
      return { live: "done" };
    }
    return { live: "idle" };
  }

  const mins = Math.floor((Date.now() - new Date(active.start_at).getTime()) / 60000);
  const isFeed = active.type === "breast";
  const side = active.subtype === "left" ? "Left side · " : active.subtype === "right" ? "Right side · " : "";
  const payload = JSON.stringify({
    title: isFeed ? `🍼 Feeding ${fmtMin(mins)}` : `💤 Asleep ${fmtMin(mins)}`,
    body: isFeed ? `${side}tap to open Leo` : "Tap to open Leo",
    tag: "live-timer",
    renotify: false,           // update quietly each minute — no repeated buzz
    requireInteraction: false, // dismissible; replaced by the next minute's update
    silent: true,
  });
  const sent = await sendToAll(payload);
  await supabase.from("live_notify")
    .upsert({ id: true, event_id: active.id, kind: active.type, updated_at: new Date().toISOString() });
  return { live: isFeed ? "feeding" : "asleep", mins, sent };
}

// ---- Config: read, never derive. -----------------------------------
async function loadConfig() {
  const { data, error } = await supabase.from("settings").select("key, value").in("key", ["baby", "sleep_model"]);
  const baby = data?.find((r) => r.key === "baby")?.value
    ?? { name: "Leo", birth_date: "2026-01-23", tz: "America/Cancun" };
  const model = data?.find((r) => r.key === "sleep_model")?.value ?? null;
  const cfg = model ?? FALLBACK;
  const tz = baby.tz || "America/Cancun";
  const expectedMonth = monthsBetween(baby.birth_date, tz);
  // Fail LOUD, not silently wrong. If the app hasn't written this month's config
  // yet, skip everything clock-based rather than push last month's numbers.
  const stale = !model || (typeof cfg.month === "number" && cfg.month !== expectedMonth);
  return { cfg, tz, baby, stale, expectedMonth, missing: !model, error: error?.message ?? null };
}

// Anchor the wake window on the sleep that ENDED most recently — the same rule
// wakeState() uses in the app. This used to order by start_at, so one forgotten
// running nap from the morning made it conclude "no open wake window" and go
// silent for the rest of the day while the app happily showed a wake timer.
async function currentWake() {
  const { data: open } = await supabase
    .from("events").select("id, subtype, start_at").eq("type", "sleep").is("end_at", null).limit(1);
  if (open?.[0]) return { asleep: open[0], last: null, awakeMin: 0 };
  const { data: ended } = await supabase
    .from("events").select("id, subtype, start_at, end_at")
    .eq("type", "sleep").not("end_at", "is", null)
    .order("end_at", { ascending: false }).limit(1);
  const last = ended?.[0] ?? null;
  return {
    asleep: null, last,
    awakeMin: last ? Math.floor((Date.now() - new Date(last.end_at).getTime()) / 60000) : 0,
  };
}

// Only alerts that pass both tests get a push: the parent plausibly isn't looking
// at the phone, AND there's something time-boxed to do about it. Everything else
// stays on screen. A 2am buzz about a 7-day feed pattern is hostile.
// Deliberately a simplified copy of the app's nightState() — different runtime, no
// shared module, no build step. Clock-only is enough here because it's used purely
// to SUPPRESS, so erring toward "it's night" is the safe direction.
// The real rule lives in app.js §0c.
function isNightNow(cfg: any, tz: string) {
  const m = localParts(tz).minOfDay;
  return m >= hhmmToMin(cfg.night.bedtimeEarliest) || m < hhmmToMin(cfg.night.morningWakeEarliest);
}

async function evaluatePushAlerts(cfg: any, tz: string, w: any, todayDate: string) {
  // Nothing clock-driven may push between bedtime and morning. This is what sent
  // "Day sleep is full — 3h 30m" at 5am while the baby was asleep.
  if (isNightNow(cfg, tz)) return [];
  const nowMin = localParts(tz).minOfDay;
  const alerts: any[] = [];

  // 🔴 Nap running past the cutoff.
  if (w.asleep && w.asleep.subtype !== "night") {
    const cutoff = hhmmToMin(cfg.naps.lastNapCutoff);
    if (nowMin >= cutoff - 15) alerts.push({
      key: `latenap:${w.asleep.id}`,
      title: nowMin >= cutoff ? `Wake Leo — past ${fmtClock(cutoff)}` : `Wake Leo by ${fmtClock(cutoff)}`,
      body: "A nap past the cutoff spends the sleep pressure you need tonight.",
    });
  }

  if (!w.asleep && w.last) {
    // 🟡 Day sleep cap. Naps clipped to today, in Leo's timezone.
    const { data: today } = await supabase
      .from("events").select("subtype, start_at, end_at")
      .eq("type", "sleep").gte("start_at", `${todayDate}T00:00:00`);
    let napMin = 0;
    for (const e of today || []) {
      if (e.subtype === "night") continue;
      const end = e.end_at ? new Date(e.end_at).getTime() : Date.now();
      napMin += Math.max(0, (end - new Date(e.start_at).getTime()) / 60000);
    }
    if (napMin >= cfg.naps.totalDayMax) alerts.push({
      key: `daycap:${todayDate}`,
      title: `Day sleep is full — ${fmtMin(Math.round(napMin))}`,
      body: "More naps now usually means a harder bedtime and more night waking.",
    });

    // 🟡 Bedtime window is open and he's been awake long enough.
    const lo = hhmmToMin(cfg.night.bedtimeEarliest), hi = hhmmToMin(cfg.night.bedtimeLatest);
    const nightStarted = (today || []).some((e) => e.subtype === "night");
    if (nowMin >= lo && nowMin <= hi && w.awakeMin >= cfg.ww.min && !nightStarted) alerts.push({
      key: `bedtime:${todayDate}`,
      title: "Bedtime window open",
      body: `Awake ${fmtMin(w.awakeMin)}. Start the routine — calm and a bit later beats fast and too early.`,
    });
  }
  return alerts;
}

// ---- Elapsed-time check-ins. No clock involved, so these still run when stale.
async function wakeSnapshot(cfg: any, w: any, dry: boolean, tz: string) {
  if (w.asleep) return { skip: "asleep" };
  if (!w.last) return { skip: "no sleep logged yet" };
  // Wake windows do not apply at night. Without this, one night waking that nobody
  // logged back down produces "Leo's been awake 2h 30m" at 04:13 — and again every
  // 15 minutes until morning.
  if (isNightNow(cfg, tz)) return { skip: "night" };
  const start = cfg.ww.min;                       // first ping when the window OPENS
  if (w.awakeMin < start) return { skip: "window not open yet", awakeMin: w.awakeMin, opensAt: start };

  const threshold = start + Math.floor((w.awakeMin - start) / STEP_MIN) * STEP_MIN;
  const { data: prev } = await supabase
    .from("wake_alerts").select("last_min").eq("sleep_id", w.last.id).maybeSingle();
  const lastMin = prev?.last_min ?? 0;
  if (threshold <= lastMin) return { skip: "already sent", threshold, lastMin };

  const title = `Leo's been awake ${fmtMin(threshold)}`;
  const body = threshold < cfg.ww.target
    ? `In the window — aim for ${fmtMin(cfg.ww.min)}–${fmtMin(cfg.ww.max)} awake.`
    : threshold <= cfg.ww.max
      ? "Good time to wind down. 😴"
      : "Past the window — he may be getting overtired.";
  if (dry) return { would_send: { title, body }, threshold, awakeMin: w.awakeMin };

  const sent = await sendToAll(JSON.stringify({ title, body }));
  await supabase.from("wake_alerts").upsert({ sleep_id: w.last.id, last_min: threshold }, { onConflict: "sleep_id" });
  return { sent, threshold, awakeMin: w.awakeMin };
}

Deno.serve(async (req) => {
  try {
    const dry = new URL(req.url).searchParams.get("dry") === "1";
    const { cfg, tz, stale, expectedMonth, missing, error } = await loadConfig();
    const local = localParts(tz);
    const w = await currentWake();

    const live = dry ? { skipped: "dry run" } : await liveTimer();
    const wake = await wakeSnapshot(cfg, w, dry, tz);

    // Clock-based alerts are only trustworthy if the config matches his real age.
    let alerts: any[] = [];
    if (stale) {
      alerts = [{ skipped: "stale config", expected: expectedMonth, got: cfg.month ?? null }];
    } else {
      const found = await evaluatePushAlerts(cfg, tz, w, local.date);
      for (const a of found) {
        const { data: already } = await supabase.from("alert_sent").select("key").eq("key", a.key).maybeSingle();
        if (already) { alerts.push({ key: a.key, skipped: "already_sent" }); continue; }
        if (dry) { alerts.push({ key: a.key, would_send: a.title }); continue; }
        const sent = await sendToAll(JSON.stringify({ title: a.title, body: a.body, tag: a.key }));
        await supabase.from("alert_sent").insert({ key: a.key });
        alerts.push({ key: a.key, sent });
      }
    }

    return json({
      dry, tz, localTime: local.label,
      month: cfg.month ?? null, expectedMonth, stale, configMissing: missing, settingsError: error,
      cfg: { ww: cfg.ww, naps: cfg.naps, night: cfg.night },
      wakeAnchor: w.asleep ? { asleep: w.asleep.id } : { lastSleep: w.last?.id ?? null, awakeMin: w.awakeMin },
      live, wake, alerts,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
