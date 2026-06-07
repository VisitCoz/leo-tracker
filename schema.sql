-- ============================================================
--  LEO TRACKER — Supabase database schema
--  How to use: Supabase dashboard > SQL Editor > paste all > Run
-- ============================================================

create extension if not exists "pgcrypto";

-- ---- Core event log -----------------------------------------
-- One table holds everything: feeds, sleeps, milestones.
-- type        : 'breast' | 'bottle' | 'sleep' | 'milestone'
-- subtype      : breast -> 'left'|'right'   sleep -> 'nap'|'night'
-- start_at      : when it began
-- end_at        : when it ended (NULL = still running, e.g. a live feed or sleep)
-- amount_ml     : bottles
-- note          : milestone text / free notes
-- photo_url     : link to a photo in Storage
-- created_by    : which parent logged it
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,
  subtype     text,
  start_at    timestamptz not null default now(),
  end_at      timestamptz,
  amount_ml   integer,
  note        text,
  photo_url   text,
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists events_start_idx on events (start_at desc);
create index if not exists events_type_idx  on events (type);

-- ---- Security: only logged-in family members can touch data --
-- (Simple model: you + Emma share one private project, so any
--  authenticated user gets full access. Fine for a 2-person app.)
alter table events enable row level security;

create policy "family read"   on events for select to authenticated using (true);
create policy "family insert" on events for insert to authenticated with check (true);
create policy "family update" on events for update to authenticated using (true);
create policy "family delete" on events for delete to authenticated using (true);

-- ---- Realtime: both phones update the instant one logs ------
alter publication supabase_realtime add table events;

-- ---- Handy views for later AI / reporting ------------------
create or replace view daily_summary as
select
  date_trunc('day', start_at) as day,
  count(*) filter (where type in ('breast','bottle'))                as feeds,
  count(*) filter (where type = 'sleep')                             as sleeps,
  round(sum(extract(epoch from (end_at - start_at)))
        filter (where type = 'sleep') / 3600.0, 1)                   as sleep_hours,
  round(avg(extract(epoch from (end_at - start_at)))
        filter (where type = 'sleep') / 60.0, 0)                     as avg_sleep_min
from events
where end_at is not null
group by 1
order by 1 desc;
