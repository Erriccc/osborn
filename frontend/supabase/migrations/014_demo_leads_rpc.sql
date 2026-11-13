-- 014: let the guest email gate record a lead without the service-role key.
--
-- Why: POST /api/demo-access ("Connect without account") built its Supabase
-- client from SUPABASE_SERVICE_ROLE_KEY, which is NOT set on Railway — the same
-- constraint migration 012 was written around (see lib/sandbox-claims.ts, which
-- prefers SECURITY DEFINER RPCs through the caller's own client for exactly this
-- reason). With the key absent the route took its `!url || !key` branch and
-- answered 500 "Server not configured." for every visitor, and the login page
-- turns a non-ok response into a blocking on-page error. Guest onboarding was
-- therefore completely closed: a first-time visitor could not start a session.
--
-- demo_leads was created ad hoc and had no migration, so this file also records
-- its schema. Everything here is idempotent and safe on a database that already
-- has the table.
--
-- What this does:
--   1. Records public.demo_leads (email primary key, source, created_at,
--      last_seen_at) if it does not already exist, with RLS enabled and NO
--      policies — direct client reads/writes stay refused.
--   2. public.record_demo_lead(p_email): SECURITY DEFINER upsert that keeps the
--      earliest created_at and only bumps last_seen_at on a repeat. Granted to
--      anon as well as authenticated, because a guest has no Supabase session at
--      all — anon is the only role the route can present without the key.
--
-- Exposure: anon may call this RPC directly with the public anon key, bypassing
-- the route's per-IP rate limit, so the leads table can be filled with
-- valid-looking addresses. That is the same exposure as any public email-capture
-- form; the function validates shape and length, writes no other table, and
-- returns nothing a caller could not already guess. It cannot read the table —
-- enumeration stays closed.
--
-- NOT APPLIED automatically. Apply before (or with) the matching frontend; the
-- route falls back to the service-role client, so applying it late degrades to
-- today's behaviour rather than breaking a working path.

-- ---------------------------------------------------------------------------
-- 1. The table, as the route has always used it.
-- ---------------------------------------------------------------------------
create table if not exists public.demo_leads (
  email text primary key,
  source text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table public.demo_leads enable row level security;

-- ---------------------------------------------------------------------------
-- 2. The only write path for a guest (SECURITY DEFINER).
--    Mirrors the route's upsert: insert once, then only bump last_seen_at.
-- ---------------------------------------------------------------------------
create or replace function public.record_demo_lead(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
begin
  if v_email is null or length(v_email) > 320 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;

  insert into public.demo_leads (email, source)
  values (v_email, 'login')
  on conflict (email) do update set last_seen_at = now();
end;
$$;

revoke all on function public.record_demo_lead(text) from public;
grant execute on function public.record_demo_lead(text) to anon, authenticated;
