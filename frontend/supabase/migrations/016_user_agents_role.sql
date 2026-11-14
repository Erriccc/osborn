-- Agent roles: what an agent may do follows its role (agent/src/agent-store.ts
-- ROLES), not its name. Rows without one get it in 018 (the built-in parent's,
-- else reader). forked_from also takes a catalog origin for agents
-- installed from the store: '<source>:<owner>/<repo>@<sha>/<path>'.

alter table public.user_agents
  add column if not exists role text
    check (role is null or role in ('reader','researcher','reasoner','planner','writer','tester','steward','reviewer'));

alter table public.user_agents drop constraint if exists user_agents_forked_from_check;
alter table public.user_agents
  add constraint user_agents_forked_from_check check (
    forked_from is null
    or forked_from ~ '^[a-z0-9-]{1,40}$'
    or forked_from ~ '^[a-z0-9-]+:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{7,40}/[A-Za-z0-9_./-]{1,200}$'
  );
