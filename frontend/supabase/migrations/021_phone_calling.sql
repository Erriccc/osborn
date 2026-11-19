-- 021: phone calls in (#361 slice 1).
--
-- The caller's number is the one verified on their account: auth.users.phone
-- with phone_confirmed_at set (Supabase phone-change OTP, delivered on WhatsApp
-- by /api/phone/verify-hook). No phone table of our own.
--
--   1. instances.call_consent_at: when the user agreed to be called. Separate
--      from verification (holding a number is not consent). Server-written
--      only, like sandbox_id in 012: client roles may not set or change it, so
--      it cannot be backdated; set_call_consent() stamps now() or clears it.
--   2. public.set_call_consent(p_consent): SECURITY DEFINER, auth.uid()'s own
--      row only; consenting needs a verified number.
--   3. public.user_id_for_phone(p_phone): SECURITY DEFINER lookup for the
--      LiveKit webhook (service role only). Accepts +E.164 or digits; only a
--      confirmed number matches.
--
-- NOT APPLIED automatically. Apply before enabling the phone webhook.

-- ---------------------------------------------------------------------------
-- 1. Consent column, server-write-only.
-- ---------------------------------------------------------------------------
alter table public.instances
  add column if not exists call_consent_at timestamptz;

create or replace function public.guard_instances_call_consent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if (tg_op = 'INSERT' and new.call_consent_at is not null)
       or (tg_op = 'UPDATE' and new.call_consent_at is distinct from old.call_consent_at) then
      raise exception 'instances.call_consent_at is server-managed; use public.set_call_consent()'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_instances_call_consent on public.instances;
create trigger guard_instances_call_consent
  before insert or update of call_consent_at on public.instances
  for each row execute function public.guard_instances_call_consent();

-- ---------------------------------------------------------------------------
-- 2. Owner-only consent setter.
-- ---------------------------------------------------------------------------
create or replace function public.set_call_consent(p_consent boolean)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_at timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_consent and not exists (
    select 1 from auth.users
    where id = v_uid and phone is not null and phone <> '' and phone_confirmed_at is not null
  ) then
    raise exception 'verify a phone number first' using errcode = '22023';
  end if;
  v_at := case when p_consent then now() else null end;
  update public.instances set call_consent_at = v_at where user_id = v_uid;
  if not found then
    raise exception 'no instance row' using errcode = 'P0002';
  end if;
  return v_at;
end;
$$;

revoke all on function public.set_call_consent(boolean) from public, anon;
grant execute on function public.set_call_consent(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Verified number -> user (webhook lookup, service role only).
--    auth.users.phone is stored as digits without '+', and is unique.
-- ---------------------------------------------------------------------------
create or replace function public.user_id_for_phone(p_phone text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u
  where u.phone = regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
    and u.phone <> ''
    and u.phone_confirmed_at is not null
  limit 1;
$$;

revoke all on function public.user_id_for_phone(text) from public, anon, authenticated;
grant execute on function public.user_id_for_phone(text) to service_role;
