-- Bug reports + feature requests filed by Osborn's workspace agent.
-- The Claude Code subprocess running on the user's Fly machine inserts directly
-- via the Supabase REST API using SUPABASE_SERVICE_ROLE_KEY. The bug-reporter
-- skill (agent/.claude/skills/bug-reporter/SKILL.md) instructs the agent on
-- WHEN to file (Osborn-itself problems, not the user's project code) and the
-- shape of the description/severity/tags it submits.

-- Postgres doesn't support CREATE TYPE IF NOT EXISTS, so wrap in DO blocks for re-runnability.
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

  -- Reporter (who hit the bug). reporter_user_id is taken from the active session's
  -- Supabase user; the agent receives it via env (OSBORN_REPORTER_USER_ID) so it can
  -- attribute reports filed during a voice session. reporter_email is a convenience
  -- copy for fast triage without joining auth.users.
  reporter_user_id uuid references auth.users(id) on delete set null,
  reporter_email text,

  -- Bug content
  title text not null,
  description text not null,
  reproduction_notes text,

  -- Context
  osborn_version text not null,
  voice_mode text, -- 'direct' | 'pipeline' | 'realtime'
  session_id text,
  sandbox_id text,

  -- Artifacts
  log_url text,           -- Supabase Storage path to the uploaded osborn.log tail
  transcript_excerpt text, -- last few user/agent turns from the JSONL
  metadata jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}'::text[],

  -- Triage
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fixed_at timestamptz,
  fixed_in_version text,
  resolution_notes text
);

-- Indices for the common triage queries
create index if not exists idx_bug_reports_status_created on public.bug_reports (status, created_at desc);
create index if not exists idx_bug_reports_type on public.bug_reports (type);
create index if not exists idx_bug_reports_reporter on public.bug_reports (reporter_user_id);
create index if not exists idx_bug_reports_tags on public.bug_reports using gin (tags);

-- Auto-update updated_at on row changes
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

-- Row-Level Security
-- The agent uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS, so it can always insert.
-- These policies are for the eventual frontend "my bug reports" UI where the
-- authenticated user can see and re-read their own reports.
alter table public.bug_reports enable row level security;

drop policy if exists "reporters can read own reports" on public.bug_reports;
create policy "reporters can read own reports" on public.bug_reports
  for select to authenticated
  using (reporter_user_id = auth.uid());

-- Authenticated users can also insert their own reports if a future frontend form
-- ever needs it. The agent path bypasses RLS via the service role.
drop policy if exists "auth users insert own reports" on public.bug_reports;
create policy "auth users insert own reports" on public.bug_reports
  for insert to authenticated
  with check (reporter_user_id = auth.uid());

comment on table public.bug_reports is 'Bug reports and feature requests filed by Osborn agents during user sessions. Inserted by the workspace agent via the bug-reporter skill.';
comment on column public.bug_reports.log_url is 'Supabase Storage path under osborn-storage/bug-logs/<id>.log';
comment on column public.bug_reports.metadata is 'Free-form JSON for fields not yet promoted to columns (browser, device, etc.)';
comment on column public.bug_reports.tags is 'Quick-filter tags: echo, interrupt, crash, memory, voice-quality, mode-specific, etc.';
