-- ============================================================
--  LEO TRACKER — AI chat schema (run AFTER schema.sql)
--  Supabase dashboard > SQL Editor > paste all > Run
-- ============================================================
-- Stores the conversation between the family and Claude so the
-- chat persists and syncs live between Mike's and Emma's phones.

create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  role        text not null,          -- 'user' | 'assistant'
  content     text not null,          -- the message text
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists messages_created_idx on messages (created_at);

-- Same simple security model as events: only logged-in family.
alter table messages enable row level security;

create policy "family read messages"   on messages for select to authenticated using (true);
create policy "family insert messages" on messages for insert to authenticated with check (true);
create policy "family delete messages" on messages for delete to authenticated using (true);

-- Live sync so both phones see the conversation update instantly.
alter publication supabase_realtime add table messages;
