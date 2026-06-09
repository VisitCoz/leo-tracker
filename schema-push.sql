-- ============================================================
--  LEO TRACKER — Web Push schema (background wake-window alerts)
--  Run in: Supabase dashboard > SQL Editor > paste all > Run
--  Pairs with the wake-watch Edge Function + sw.js push handler.
-- ============================================================

-- ---- Devices subscribed to push ----------------------------
-- One row per browser/device that tapped 🔔 and granted alerts.
-- `sub` is the full PushSubscription JSON (endpoint + keys) the
-- wake-watch function needs to send a Web Push.
create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text not null unique,
  sub         jsonb not null,
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

alter table push_subscriptions enable row level security;
create policy "family read push"   on push_subscriptions for select to authenticated using (true);
create policy "family insert push" on push_subscriptions for insert to authenticated with check (true);
create policy "family update push" on push_subscriptions for update to authenticated using (true);
create policy "family delete push" on push_subscriptions for delete to authenticated using (true);

-- ---- De-dupe log: one alert per wake window ----------------
-- The wake window is defined by the sleep that just ended; we key
-- by that sleep's id so we send the 90-min alert at most once.
create table if not exists wake_alerts (
  sleep_id  uuid primary key references events(id) on delete cascade,
  sent_at   timestamptz not null default now()
);

alter table wake_alerts enable row level security;
-- Only the service-role (used by wake-watch) writes here; no client policies needed.

-- ============================================================
--  Schedule wake-watch to run every minute (pg_cron + pg_net).
--  Replace <PROJECT_REF> and <ANON_OR_SERVICE_KEY> below, then run.
--  If pg_cron/pg_net aren't enabled: Dashboard > Database > Extensions.
-- ============================================================
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.schedule(
--   'wake-watch-every-minute',
--   '* * * * *',
--   $$
--   select net.http_post(
--     url     := 'https://<PROJECT_REF>.functions.supabase.co/wake-watch',
--     headers := '{"Content-Type":"application/json","Authorization":"Bearer <ANON_OR_SERVICE_KEY>"}'::jsonb,
--     body    := '{}'::jsonb
--   );
--   $$
-- );
