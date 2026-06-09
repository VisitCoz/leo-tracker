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

const WAKE_TARGET_MIN = 90;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") || "mailto:leo@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async () => {
  try {
    // Most recent sleep defines the current wake window.
    const { data: sleeps } = await supabase
      .from("events")
      .select("id, end_at")
      .eq("type", "sleep")
      .order("start_at", { ascending: false })
      .limit(1);

    const last = sleeps?.[0];
    // No sleep yet, or he's asleep right now (end_at null) → no wake window.
    if (!last || !last.end_at) return json({ skip: "no open wake window" });

    const awakeMin = (Date.now() - new Date(last.end_at).getTime()) / 60000;
    if (awakeMin < WAKE_TARGET_MIN) return json({ skip: "within window", awakeMin });

    // Already alerted for this window? (one row per sleep id)
    const { data: already } = await supabase
      .from("wake_alerts").select("sleep_id").eq("sleep_id", last.id).maybeSingle();
    if (already) return json({ skip: "already alerted" });

    // Send to every subscribed device.
    const { data: subs } = await supabase.from("push_subscriptions").select("endpoint, sub");
    const payload = JSON.stringify({
      title: "Leo's wake window is closing",
      body: `Awake ${Math.round(awakeMin)} min — time to wind down for sleep. 😴`,
    });

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

    await supabase.from("wake_alerts").insert({ sleep_id: last.id });
    return json({ sent, awakeMin: Math.round(awakeMin) });
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
