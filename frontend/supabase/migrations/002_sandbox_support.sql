-- Add sandbox support to instances table
-- Tracks Daytona sandbox ID and URL for cloud-provisioned agents

alter table public.instances
  add column if not exists sandbox_id text,
  add column if not exists sandbox_url text,
  add column if not exists sandbox_status text default 'none'; -- 'none' | 'creating' | 'running' | 'stopped' | 'archived' | 'error'

-- Index for fast sandbox lookups
create index if not exists idx_instances_sandbox_id on public.instances(sandbox_id) where sandbox_id is not null;

comment on column public.instances.sandbox_id is 'Daytona sandbox ID (null for local instances)';
comment on column public.instances.sandbox_url is 'Daytona preview URL for agent HTTP API (port 8741)';
comment on column public.instances.sandbox_status is 'Sandbox lifecycle state';
