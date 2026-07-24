-- ============================================================
--  Leo Tracker — GROWTH table (weight / height + percentiles)
--  Run this once in Supabase → SQL Editor.
--  Mirrors the events table's security model: any signed-in
--  family member has full CRUD; realtime on so both phones sync.
-- ============================================================

create table if not exists growth (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,                       -- 'weight' | 'height'
  value       numeric not null,                    -- weight in kg, height in cm
  measured_at date not null default current_date,
  note        text,
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists growth_measured_idx on growth (measured_at desc);
create index if not exists growth_kind_idx     on growth (kind);

-- Row Level Security: only signed-in family members, full CRUD (same as events).
alter table growth enable row level security;

drop policy if exists "growth read"   on growth;
drop policy if exists "growth insert" on growth;
drop policy if exists "growth update" on growth;
drop policy if exists "growth delete" on growth;

create policy "growth read"   on growth for select using (auth.role() = 'authenticated');
create policy "growth insert" on growth for insert with check (auth.role() = 'authenticated');
create policy "growth update" on growth for update using (auth.role() = 'authenticated');
create policy "growth delete" on growth for delete using (auth.role() = 'authenticated');

-- Live sync between devices.
alter publication supabase_realtime add table growth;
