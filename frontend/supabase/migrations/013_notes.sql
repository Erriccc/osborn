-- 013_notes.sql — MIRROR of the live `notes` table (voice notes, UI item 26).
--
-- WHY THIS EXISTS
--   The `notes` table already exists in PRODUCTION and is used by
--   frontend/src/app/api/notes/route.ts (GET / POST / DELETE). It was created
--   by hand; no earlier migration creates it. This file lets a FRESH
--   environment match prod. It is written to be idempotent:
--   every CREATE is guarded (IF NOT EXISTS, or a pg_policies / pg_indexes
--   check), and nothing is dropped, altered in place, or replaced.
--
-- BEFORE APPLYING ANYWHERE THAT ALREADY HAS `notes` (i.e. prod):
--   Compare this file against the live schema. Run these READ-ONLY queries in
--   the Supabase SQL editor (they only SELECT from catalog views):
--
--     select column_name, data_type, udt_name, is_nullable, column_default
--       from information_schema.columns
--      where table_schema = 'public' and table_name = 'notes'
--      order by ordinal_position;
--
--     select c.relrowsecurity as rls_enabled
--       from pg_class c join pg_namespace n on n.oid = c.relnamespace
--      where n.nspname = 'public' and c.relname = 'notes';
--
--     select policyname, cmd, roles, qual, with_check
--       from pg_policies
--      where schemaname = 'public' and tablename = 'notes';
--
--     select indexname, indexdef
--       from pg_indexes
--      where schemaname = 'public' and tablename = 'notes';
--
--   Running this migration on prod MUST be a no-op. Expected prod shape:
--   columns id / user_id / text / attachments / created_at as below, RLS on,
--   owner-only select + insert + delete policies, an index leading on user_id.
--   If prod differs, PROD WINS: edit this file to match prod before applying.
--   Two differences are NOT cosmetic and must be raised before applying:
--     * rls_enabled = false  -> this file would turn RLS on (a behaviour
--       change on prod; it is the intended secure state, but decide first).
--     * a missing select/insert/delete policy -> this file would add one.
--   Policy guards check by table + command (not by name), so prod policies
--   under different names are left alone and not duplicated.
--
-- Never applied by a writer agent. Apply by hand after the comparison above.

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  text text not null,
  attachments text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- The first hand-made version (commit 3c0e053) had no attachments column;
-- 680b91a started writing it. Harmless no-op where it already exists.
alter table public.notes add column if not exists attachments text[] not null default '{}';

alter table public.notes enable row level security;

-- Owner-only policies, created only when no policy for that command exists.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'notes' and upper(cmd) in ('SELECT', 'ALL')
  ) then
    create policy "notes owner select" on public.notes
      for select to authenticated using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'notes' and upper(cmd) in ('INSERT', 'ALL')
  ) then
    create policy "notes owner insert" on public.notes
      for insert to authenticated with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'notes' and upper(cmd) in ('DELETE', 'ALL')
  ) then
    create policy "notes owner delete" on public.notes
      for delete to authenticated using (auth.uid() = user_id);
  end if;
end $$;

-- GET /api/notes: where user_id = $1 order by created_at desc limit 50.
-- Created only if no index on notes already leads with user_id (avoids a
-- duplicate index on prod under another name).
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'notes'
       and indexdef ~* '\(\s*user_id\s*[,)]'
  ) then
    create index if not exists notes_user_id_created_at_idx
      on public.notes (user_id, created_at desc);
  end if;
end $$;
