// ============================================================
//  wake-watch — Supabase Edge Function (Deno), runs every minute
//  Sends a Web Push "wake window closing" alert when Leo has been
//  awake ≥ 90 min, even if the app is closed. Fires once per window.
//
//  Deploy:  npx supabase functions deploy wake-watch --no-verify-jwt
//  Secrets: npx supabase secrets set \
//             VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
//  Schedule: see schema-push.sql (pg_cron → http_post every minute).
//  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Periodic snapshot check-ins: first at 60 min, then every 15 min.
// 90 min is the key "wind down" snapshot. Each threshold fires once per wake window.
const CHECK_START_MIN = 60;
const STEP_MIN = 15;
const WIND_DOWN_MIN = 90;

function fmtMin(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
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

// ---- Wake-window snapshot check-ins --------------------------------
async function wakeSnapshot() {
  // Most recent sleep defines the current wake window.
  const { data: sleeps } = await supabase
    .from("events")
    .select("id, end_at")
    .eq("type", "sleep")
    .order("start_at", { ascending: false })
    .limit(1);

  const last = sleeps?.[0];
  // No sleep yet, or he's asleep right now (end_at null) → no wake window.
  if (!last || !last.end_at) return { skip: "no open wake window" };

  const awakeMin = Math.floor((Date.now() - new Date(last.end_at).getTime()) / 60000);
  if (awakeMin < CHECK_START_MIN) return { skip: "within window", awakeMin };

  // Highest snapshot threshold reached so far (60, 75, 90, 105, …).
  const threshold = CHECK_START_MIN + Math.floor((awakeMin - CHECK_START_MIN) / STEP_MIN) * STEP_MIN;

  // Which threshold did we last send for this wake window? (0 = none yet)
  const { data: prev } = await supabase
    .from("wake_alerts").select("last_min").eq("sleep_id", last.id).maybeSingle();
  const lastMin = prev?.last_min ?? 0;
  if (threshold <= lastMin) return { skip: "snapshot already sent", threshold, lastMin };

  // The notification shows the elapsed time; tone shifts around the 90-min wind-down mark.
  const t = fmtMin(threshold);
  const title = `Leo's been awake ${t}`;
  const body = threshold < WIND_DOWN_MIN
    ? "Getting close to wind-down (target ~90 min)."
    : threshold === WIND_DOWN_MIN
      ? "Time to wind down for sleep. 😴"
      : "Past the wake window — he may be getting overtired.";
  // Default "wake-window" tag (in sw.js) keeps these separate from the live timer.
  const sent = await sendToAll(JSON.stringify({ title, body }));

  // Record the threshold so we don't repeat it this window.
  await supabase.from("wake_alerts").upsert({ sleep_id: last.id, last_min: threshold }, { onConflict: "sleep_id" });
  return { sent, threshold, awakeMin };
}

Deno.serve(async () => {
  try {
    // Both run every minute and use distinct notification tags, so they coexist.
    const live = await liveTimer();
    const wake = await wakeSnapshot();
    return json({ live, wake });
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
