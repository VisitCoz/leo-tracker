-- ============================================================
--  Leo Tracker — shared settings (run ONCE in the Supabase SQL editor)
-- ============================================================
--  Why this table exists:
--  The wake window used to live in six places — app.js, the Planner's own age
--  table, the wake-watch cron, the ask-leo prompt, and spec.md — and they all
--  disagreed. Leo outgrew every one of them and nothing said so, so the app spent
--  weeks telling us to put a not-tired baby down an hour early.
--
--  Now: app.js owns the AGE DEFAULTS (authoring), this table holds the RESOLVED
--  config (runtime). The app is the only writer. wake-watch reads it and carries
--  no numbers of its own. Change something here and both phones AND the push
--  sender pick it up — no redeploy.
--
--  Safe to re-run.
-- ============================================================

create table if not exists settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references auth.users(id) default auth.uid(),
  updated_at  timestamptz not null default now()
);

alter table settings enable row level security;

drop policy if exists "family read settings"   on settings;
drop policy if exists "family insert settings" on settings;
drop policy if exists "family update settings" on settings;
create policy "family read settings"   on settings for select to authenticated using (true);
create policy "family insert settings" on settings for insert to authenticated with check (true);
create policy "family update settings" on settings for update to authenticated using (true);

-- So a change on one phone reaches the other without a reload.
do $$
begin
  alter publication supabase_realtime add table settings;
exception when duplicate_object then null;
end $$;

-- ---- Seed -------------------------------------------------------------
-- The table must never be empty: wake-watch reads it every minute and would
-- otherwise have nothing to work from on the very first run.
--
-- `baby` also removes the birth date from two hardcoded places (app.js and
-- ask-leo/index.ts) and gives the edge functions an explicit IANA timezone.
-- America/Cancun is UTC-5 with no DST, so a fixed offset would appear to work —
-- store the zone anyway, because "appears to work" is how we got here.
insert into settings (key, value) values
  ('baby', '{"name":"Leo","birth_date":"2026-01-23","tz":"America/Cancun"}'::jsonb),
  ('sleep_model', '{
     "month": 6,
     "band": "6–8 mo",
     "ww":     {"min":150,"target":165,"max":180,"firstOfDay":150,"lastOfDay":180},
     "naps":   {"minCount":2,"maxCount":3,"totalDayMin":150,"totalDayMax":210,
                "lastNapCutoff":"17:15","minUsefulNap":30},
     "night":  {"bedtimeEarliest":"19:00","bedtimeLatest":"20:45","morningWakeEarliest":"06:00",
                "expectedNightSleep":[600,720],"feedGateMin":180},
     "feeds":  {"perDayMin":5,"perDayMax":6},
     "totals": {"healthy24h":[780,900]},
     "meta":   {"version":1,"source":"age-defaults","overridden":[]},
     "overrides": {}
   }'::jsonb)
on conflict (key) do nothing;

-- ---- Push dedupe ------------------------------------------------------
-- Keyed by the SAME occurrence strings the app uses for dismissal
-- (latenap:<sleep_id>, bedtime:<date>, daycap:<date>), so the phone and the
-- server agree on what "already handled" means.
-- The cron runs every minute; without this, three clock-triggered alerts become
-- sixty buzzes an hour at 3am.
create table if not exists alert_sent (
  key      text primary key,
  sent_at  timestamptz not null default now()
);
alter table alert_sent enable row level security;   -- service-role only, like wake_alerts
