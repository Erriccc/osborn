-- 012: make instances.sandbox_id server-only.
--
-- Why: instances.sandbox_id decides which Fly app / sprite a user controls
-- (/api/sandbox start/stop/delete/exec/update) and which LiveKit rooms
-- /api/token will mint for. The RLS policy "Users manage own instances"
-- (001) is `for all using (auth.uid() = user_id)` with no column restriction,
-- so any signed-in user could write ANOTHER user's app name into their own
-- row and pass every ownership check. See security-takeover-chain-2026-11-06.
--
-- What this does:
--   1. A trigger refuses any write that sets sandbox_id to a non-null value
--      when the writer is a client role (authenticated / anon). Clearing it to
--      NULL is still allowed (it only drops the caller's own claim). Writes from
--      SECURITY DEFINER functions (current_user = owner) and the service role
--      pass. A trigger is used instead of column privileges because Supabase
--      grants table-level INSERT/UPDATE to `authenticated`, and a column-level
--      REVOKE does not override a table-level grant.
--   2. public.set_instance_sandbox(p_sandbox_id): SECURITY DEFINER. Sets
--      sandbox_id on auth.uid()'s OWN existing row only, and only when no other
--      row claims that id and it is not another user's deterministic legacy app
--      name (osborn-<first 12 chars of their user id>). The frontend calls it via
--      rpc from the user's own client (no service-role key needed on Railway).
--   3. public.sandbox_claimed_by_other(p_sandbox_id): SECURITY DEFINER, returns
--      true when another user's row claims the id or it is another user's
--      deterministic app name. Used by /api/token and /api/sandbox (fail closed).
--   4. A partial UNIQUE index on sandbox_id.
--
-- Related (agent control binding, same PR): the frontend now bakes
-- OSBORN_OWNER_USER_ID into each machine's env so the agent only lets the
-- owner control it. EXISTING machines lack that env until their next create,
-- update-osborn or pool repoint, and stay in newest-joiner mode until then.
--
-- NOT APPLIED automatically. Apply this BEFORE deploying the matching frontend
-- (lib/sandbox-claims.ts): without these functions and without
-- SUPABASE_SERVICE_ROLE_KEY the ownership check fails closed and users with a
-- recorded sandbox_id are refused.

-- ---------------------------------------------------------------------------
-- 0. Duplicates. The UNIQUE index below fails (and, run as one transaction,
--    rolls back this whole migration) while any sandbox_id is claimed by more
--    than one row. Run this SELECT first and resolve every row it returns
--    (keep the real owner, set sandbox_id = NULL on the others) before applying.
-- ---------------------------------------------------------------------------
select sandbox_id, count(*) as claims, array_agg(user_id order by created_at) as user_ids
from public.instances
where sandbox_id is not null
group by sandbox_id
having count(*) > 1;

-- Also worth reviewing before applying (not enforced here): rows whose
-- sandbox_id is ANOTHER user's deterministic legacy app name.
--   select i.user_id, i.sandbox_id, u.id as legacy_owner
--   from public.instances i
--   join auth.users u
--     on i.sandbox_id = 'osborn-' || trim(both '-' from regexp_replace(lower(left(u.id::text, 12)), '[^a-z0-9]', '-', 'g'))
--   where u.id <> i.user_id;

-- ---------------------------------------------------------------------------
-- 1. Client roles may not set sandbox_id.
-- ---------------------------------------------------------------------------
create or replace function public.guard_instances_sandbox_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and new.sandbox_id is not null then
    if tg_op = 'INSERT' or new.sandbox_id is distinct from old.sandbox_id then
      raise exception 'instances.sandbox_id is server-managed; use public.set_instance_sandbox()'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_instances_sandbox_id on public.instances;
create trigger guard_instances_sandbox_id
  before insert or update of sandbox_id on public.instances
  for each row execute function public.guard_instances_sandbox_id();

-- ---------------------------------------------------------------------------
-- 1b. Is p_sandbox_id ANOTHER user's deterministic legacy app name?
--     lib/machines.ts appNameFromUserId = 'osborn-' + first 12 chars of the
--     user id. For a uuid those 12 chars are always 'xxxxxxxx-xxx' (lowercase
--     hex), which the slug step leaves unchanged. So only ids matching
--     ^osborn-[0-9a-f]{8}-[0-9a-f]{3}$ can be a legacy name, and the lookup is a
--     uuid RANGE on auth.users' primary key (index probe, no table scan).
--     Internal helper: not executable by client roles; the SECURITY DEFINER
--     functions below call it as their owner.
-- ---------------------------------------------------------------------------
create or replace function public.sandbox_is_others_legacy_app(p_sandbox_id text, p_uid uuid)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_prefix text;
begin
  if p_sandbox_id is null or p_sandbox_id !~ '^osborn-[0-9a-f]{8}-[0-9a-f]{3}$' then
    return false;
  end if;
  v_prefix := substr(p_sandbox_id, 8); -- 'xxxxxxxx-xxx'
  return exists (
    select 1 from auth.users u
    where u.id >= (v_prefix || '0-0000-0000-000000000000')::uuid
      and u.id <= (v_prefix || 'f-ffff-ffff-ffffffffffff')::uuid
      and u.id is distinct from p_uid
  );
end;
$$;

revoke all on function public.sandbox_is_others_legacy_app(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Owner-only setter (SECURITY DEFINER).
-- ---------------------------------------------------------------------------
create or replace function public.set_instance_sandbox(p_sandbox_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_rows int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_sandbox_id is null or length(p_sandbox_id) = 0 or length(p_sandbox_id) > 200 then
    raise exception 'invalid sandbox id' using errcode = '22023';
  end if;

  -- Another row already claims it.
  if exists (
    select 1 from public.instances
    where sandbox_id = p_sandbox_id and user_id <> v_uid
  ) then
    return false;
  end if;

  -- Another user's deterministic legacy app name (lib/machines.ts appNameFromUserId).
  if public.sandbox_is_others_legacy_app(p_sandbox_id, v_uid) then
    return false;
  end if;

  update public.instances set sandbox_id = p_sandbox_id where user_id = v_uid;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
exception
  when unique_violation then
    return false; -- lost a race with another claimant
end;
$$;

revoke all on function public.set_instance_sandbox(text) from public, anon;
grant execute on function public.set_instance_sandbox(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Duplicate-claim check for the caller (SECURITY DEFINER, read-only).
-- ---------------------------------------------------------------------------
create or replace function public.sandbox_claimed_by_other(p_sandbox_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is null
    or exists (
      select 1 from public.instances
      where sandbox_id = p_sandbox_id and user_id <> auth.uid()
    )
    or public.sandbox_is_others_legacy_app(p_sandbox_id, auth.uid());
$$;

revoke all on function public.sandbox_claimed_by_other(text) from public, anon;
grant execute on function public.sandbox_claimed_by_other(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. One owner per sandbox id. Replaces the non-unique index from 002.
-- ---------------------------------------------------------------------------
create unique index if not exists instances_sandbox_id_unique
  on public.instances (sandbox_id)
  where sandbox_id is not null;

drop index if exists public.idx_instances_sandbox_id;
