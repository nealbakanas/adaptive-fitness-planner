-- Adaptive Fitness Planner: one row per signed-in user holding their whole data.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again.

create table if not exists public.states (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  rev       bigint not null default 1,          -- bumped on every push; a push only lands if it names the rev it was based on
  saved_at  timestamptz not null default now(), -- when the pushing device last saved
  device    text,                               -- which device pushed, for "synced from ..." messages
  workouts  integer not null default 0,         -- counts for the restore prompt, so it needn't download the data
  sets      integer not null default 0,
  data      jsonb not null                      -- the app's whole state (about 300 KB)
);

alter table public.states enable row level security;

-- Nobody but the signed-in owner can touch a row; the anonymous (publishable key only) role gets nothing.
revoke all on public.states from anon;
grant select, insert, update, delete on public.states to authenticated;

drop policy if exists "own row: select" on public.states;
drop policy if exists "own row: insert" on public.states;
drop policy if exists "own row: update" on public.states;
drop policy if exists "own row: delete" on public.states;

create policy "own row: select" on public.states for select to authenticated using (user_id = (select auth.uid()));
create policy "own row: insert" on public.states for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own row: update" on public.states for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own row: delete" on public.states for delete to authenticated using (user_id = (select auth.uid()));
