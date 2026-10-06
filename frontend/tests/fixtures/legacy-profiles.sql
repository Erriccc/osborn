-- Test fixture: reproduces the LEGACY prod public.profiles shape (verified
-- read-only on prod 2026-10-06). It is NOT a migration; no repo migration
-- creates this table. Requires auth.users(id, email, raw_user_meta_data) and
-- auth.uid() to exist first.
create table public.profiles (
  id uuid not null references auth.users(id) on delete cascade primary key,
  updated_at timestamptz,
  username text unique,
  full_name text,
  avatar_url text,
  website text
);

alter table public.profiles enable row level security;

create policy "Public profiles are viewable by everyone." on public.profiles
  for select using (true);
create policy "Users can insert their own profile." on public.profiles
  for insert with check (auth.uid() = id);
create policy "Users can update own profile." on public.profiles
  for update using (auth.uid() = id);

-- Copies the email into username on every profile insert (BEFORE INSERT, ROW).
create function public.set_username_default()
returns trigger language plpgsql as $function$
begin
  new.username := (select email from auth.users where id = new.id);
  return new;
end;
$function$;

create trigger set_username_default_trigger
  before insert on public.profiles
  for each row execute function public.set_username_default();

-- Creates a profile row for every new auth user.
create function public.handle_new_user()
returns trigger language plpgsql security definer as $function$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url');
  return new;
end;
$function$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
