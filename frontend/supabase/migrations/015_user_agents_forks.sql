-- Agent store: the built-in agents (researcher, reasoner, planner, writer,
-- tester, steward, reviewer) are core and locked. Users fork them under a new
-- name; forked_from records the origin. Core prompts run past 6000 chars, so
-- the prompt cap is raised to fit a fork.

alter table public.user_agents
  add column if not exists forked_from text
    check (forked_from is null or forked_from ~ '^[a-z0-9-]{1,40}$');

alter table public.user_agents drop constraint if exists user_agents_prompt_check;
alter table public.user_agents
  add constraint user_agents_prompt_check check (char_length(prompt) between 1 and 20000);

-- Rows that used a core name no longer apply. Removal tombstones go; real
-- overrides become forks named <name>-custom so the user keeps their prompt.
delete from public.user_agents
  where name in ('researcher','reasoner','planner','writer','tester','steward','reviewer')
    and enabled = false and description = '(removed built-in)';

update public.user_agents u
  set name = u.name || '-custom', forked_from = u.name, updated_at = now()
  where u.name in ('researcher','reasoner','planner','writer','tester','steward','reviewer')
    and not exists (
      select 1 from public.user_agents o
      where o.user_id = u.user_id and o.name = u.name || '-custom'
    );
