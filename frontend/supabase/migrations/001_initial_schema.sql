-- Osborn multi-user schema
-- Run in Supabase SQL Editor or via supabase db push

-- Instances (one per user — their Osborn server)
create table if not exists public.instances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  server_url text not null, -- e.g. https://osborn-abc123.fly.dev or http://localhost:8741
  instance_type text not null default 'local', -- 'cloud' | 'local'
  status text not null default 'running', -- 'provisioning' | 'running' | 'stopped' | 'error'
  livekit_room text, -- scoped LiveKit room name for this user
  last_seen timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id)
);

-- Agent sessions (mirrors Claude SDK session UUIDs)
create table if not exists public.agent_sessions (
  id uuid primary key, -- matches Claude SDK session UUID
  instance_id uuid references public.instances(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  title text,
  working_dir text,
  created_at timestamptz default now(),
  last_active timestamptz default now()
);

-- Always-allow tool paths (persisted across restarts)
create table if not exists public.always_allow_paths (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  tool_name text not null,
  path_pattern text not null,
  created_at timestamptz default now()
);

-- Row Level Security
alter table public.instances enable row level security;
alter table public.agent_sessions enable row level security;
alter table public.always_allow_paths enable row level security;

-- Users can only see/modify their own data
create policy "Users manage own instances" on public.instances
  for all using (auth.uid() = user_id);

create policy "Users manage own sessions" on public.agent_sessions
  for all using (auth.uid() = user_id);

create policy "Users manage own allow paths" on public.always_allow_paths
  for all using (auth.uid() = user_id);

-- Auto-update updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger instances_updated_at
  before update on public.instances
  for each row execute function public.handle_updated_at();
