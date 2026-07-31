-- Per-user named agents (DB-backed sub-agent definitions).
-- The frontend fetches the signed-in user's rows and sends them to the agent
-- via the set_agents data-channel message after agent_ready; the agent merges
-- them OVER the built-in NAMED_AGENTS (same-name rows shadow built-ins) and
-- injects them into the Claude Agent SDK query() at session start.
-- SDK constraint: agents are fixed at query creation, so edits apply to the
-- NEXT session, not the live one.

create table if not exists public.user_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9-]{1,40}$'),
  description text not null check (char_length(description) between 1 and 500),
  prompt text not null check (char_length(prompt) between 1 and 6000),
  tools text[] not null default '{}',
  model text not null default 'inherit'
    check (model in ('sonnet','opus','haiku','fable','inherit') or model like 'claude-%'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.user_agents enable row level security;

-- Users manage only their own agent definitions.
create policy "user_agents_select_own" on public.user_agents
  for select using (auth.uid() = user_id);
create policy "user_agents_insert_own" on public.user_agents
  for insert with check (auth.uid() = user_id);
create policy "user_agents_update_own" on public.user_agents
  for update using (auth.uid() = user_id);
create policy "user_agents_delete_own" on public.user_agents
  for delete using (auth.uid() = user_id);

create index if not exists user_agents_user_id_idx on public.user_agents (user_id);
