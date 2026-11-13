-- 017: record demo_leads' schema + a public, locked-down record function.
--
-- POST /api/demo-access ("Connect without account") wrote through
-- SUPABASE_SERVICE_ROLE_KEY, which is not set on Railway — the same constraint
-- migration 012 was written around. A guest has no session, so anon is the only
-- role the route can present, and record_demo_lead() is the single write path it
-- can use. demo_leads was created ad hoc and had no migration; this records it.
--
-- Anon can call the function directly with the public anon key, so it validates
-- its own input and writes nothing else. It cannot read the table — enumeration
-- stays closed. Same shape as content_track() in 010.
--
-- Additive and idempotent. NOT APPLIED automatically; until it is, the route
-- logs and falls through to the service-role client.

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
