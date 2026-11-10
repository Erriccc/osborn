-- 014_bug_reports_ensure.sql — ENSURE the `bug_reports` table exists in prod.
--
-- WHY THIS EXISTS (issues #88 and #54)
--   The in-app "Report a bug" button posts to /api/report, which inserts into
--   `public.bug_reports` as the signed-in user (RLS via their cookies). In
--   PRODUCTION that insert fails because the table was never created there:
--   migration 003_bug_reports.sql defines it, but it was never applied to the
--   live project, so every signed-in submit comes back as a failed insert
--   ("relation \"public.bug_reports\" does not exist" / PostgREST PGRST205
--   "Could not find the table ... in the schema cache").
--
--   This migration is the single idempotent file to apply to prod to make the
--   table (and its RLS) exist. It is a superset-safe re-statement of 003 plus an
--   explicit service_role policy, written so it is a NO-OP wherever the table
--   already exists (fresh dev DBs that did run 003). Every CREATE is guarded
--   (IF NOT EXISTS, duplicate_object DO blocks, or a pg_policies command check);
--   nothing is dropped, altered in place, or data-modifying.
--
-- SHAPE MATCHES WHAT THE API INSERTS
--   buildBugReportRow() in frontend/src/lib/bug-report.ts inserts exactly:
--     type, severity, title, description, reproduction_notes, tags,
--     reporter_user_id, reporter_email, osborn_version, voice_mode,
--     session_id, sandbox_id, metadata
--   All of those columns are created below. osborn_version is NOT NULL (the web
--   path stamps 'web'); reproduction_notes / reporter_email / voice_mode /
--   session_id / sandbox_id are nullable; tags and metadata default to empty.
--
-- BEFORE APPLYING ANYWHERE THAT ALREADY HAS `bug_reports`:
--   Running this MUST be a no-op. Confirm with these READ-ONLY queries in the
--   Supabase SQL editor (they only SELECT from catalog views):
--
--     select column_name, data_type, udt_name, is_nullable, column_default
--       from information_schema.columns
--      where table_schema = 'public' and table_name = 'bug_reports'
--      order by ordinal_position;
--
--     select policyname, cmd, roles, qual, with_check
--       from pg_policies
--      where schemaname = 'public' and tablename = 'bug_reports';
--
--   If prod differs, PROD WINS: edit this file to match prod before applying.
--
-- HOW TO APPLY (founder holds the Supabase PAT; writer agents never apply DDL):
--   Paste this file into the Supabase SQL editor for the production project and
--   run it once, OR: supabase db push (if the CLI is linked to prod).

-- Enum types. Postgres has no CREATE TYPE IF NOT EXISTS, so wrap in DO blocks.
do $$ begin
  create type public.report_type as enum ('bug', 'feature');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.report_status as enum ('open', 'investigating', 'fixed', 'wontfix', 'duplicate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.report_severity as enum ('low', 'medium', 'high', 'critical');
exception when duplicate_object then null; end $$;

create table if not exists public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  type public.report_type not null default 'bug',
  status public.report_status not null default 'open',
  severity public.report_severity default 'medium',

  -- Reporter (who hit the bug). reporter_user_id is the active session's Supabase
  -- user; reporter_email is a convenience copy for triage without joining auth.users.
  reporter_user_id uuid references auth.users(id) on delete set null,
  reporter_email text,

  -- Bug content
  title text not null,
  description text not null,
  reproduction_notes text,

  -- Context
  osborn_version text not null,
  voice_mode text,              -- 'direct' | 'pipeline' | 'realtime'
  session_id text,
  sandbox_id text,

  -- Artifacts / free-form
  log_url text,                 -- Supabase Storage path to an uploaded log tail
  transcript_excerpt text,      -- last few user/agent turns
  metadata jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}'::text[],

  -- Triage
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fixed_at timestamptz,
  fixed_in_version text,
  resolution_notes text
);

-- Indices for the common triage queries.
create index if not exists idx_bug_reports_status_created on public.bug_reports (status, created_at desc);
create index if not exists idx_bug_reports_type on public.bug_reports (type);
create index if not exists idx_bug_reports_reporter on public.bug_reports (reporter_user_id);
create index if not exists idx_bug_reports_tags on public.bug_reports using gin (tags);

-- Auto-update updated_at on row changes.
create or replace function public.bug_reports_set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bug_reports_updated_at on public.bug_reports;
create trigger trg_bug_reports_updated_at
  before update on public.bug_reports
  for each row execute function public.bug_reports_set_updated_at();

-- Row-Level Security. Enable it (secure default; no-op where already on).
alter table public.bug_reports enable row level security;

-- Policies are created guarded by COMMAND (not by name), so an environment that
-- already ran 003 — where the equivalent policies exist under their own names —
-- is left untouched and nothing is duplicated.
do $$
begin
  -- A signed-in user can INSERT their own report (/api/report sets
  -- reporter_user_id = auth.uid()).
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'bug_reports' and upper(cmd) in ('INSERT', 'ALL')
  ) then
    create policy "bug_reports owner insert" on public.bug_reports
      for insert to authenticated with check (reporter_user_id = auth.uid());
  end if;

  -- A signed-in user can read back their own reports (the insert's RETURNING id,
  -- and a future "my reports" view).
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'bug_reports' and upper(cmd) in ('SELECT', 'ALL')
  ) then
    create policy "bug_reports owner select" on public.bug_reports
      for select to authenticated using (reporter_user_id = auth.uid());
  end if;
end $$;

-- Service role has full access. service_role already BYPASSES RLS, so this is an
-- explicit belt-and-suspenders grant for the agent path (SUPABASE_SERVICE_ROLE_KEY)
-- and any server-side triage tooling. Uniquely named, so drop-if-exists is safe.
drop policy if exists "bug_reports service_role full access" on public.bug_reports;
create policy "bug_reports service_role full access" on public.bug_reports
  for all to service_role using (true) with check (true);

comment on table public.bug_reports is 'Bug reports and feature requests filed in-app (web modal + agent bug-reporter skill). Inserted via /api/report as the signed-in user, or by the agent via the service role.';
