-- 011: Fix signup trigger failures caused by search_path.
--
-- Why: triggers on auth.users fire as the role supabase_auth_admin, whose
-- search_path is `auth`. public.set_username_default() referenced an
-- unqualified `profiles`, so every new signup (e.g. Google OAuth) failed with
-- `relation "profiles" does not exist`.
--
-- Fix: pin search_path = '' on both signup trigger functions and fully
-- qualify every table reference (public.profiles, auth.users). Also:
--   - base username is lowercased first, then stripped of disallowed chars
--   - collision suffix loop truncates the base so the result stays <= 30 chars
--   - short or NULL emails fall back to 'user'
-- set_username_default() remains SECURITY INVOKER.
--
-- Already applied to production 2026-10-24; this file records it.

create or replace function public.set_username_default()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare base text; newu text; i int; suf text;
begin
  base := regexp_replace(lower(split_part(coalesce((select email from auth.users where id = new.id), 'user'), '@', 1)), '[^a-z0-9-]', '', 'g');
  if base is null or length(base) < 3 then base := 'user'; end if;
  newu := left(base, 30); i := 2;
  while exists(select 1 from public.profiles u where u.username = newu and u.id <> new.id) loop
    suf := '-' || i::text; newu := left(base, 30 - length(suf)) || suf; i := i + 1;
  end loop;
  new.username := newu; return new;
end; $function$;

-- handle_new_user() already inserts into the qualified public.profiles;
-- pin its search_path too.
alter function public.handle_new_user() set search_path = '';
