-- Turbo mode: per-user preference to run all agents on a fast model.
-- Column lives on instances (one row per user via unique(user_id)) — no new table.
alter table public.instances
  add column if not exists turbo boolean not null default false;
