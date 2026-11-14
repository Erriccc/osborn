-- Every agent row carries its role (agent/src/agent-store.ts ROLES): what an
-- agent may do is never inferred from a saved row's tools. Rows saved before
-- roles existed get their built-in parent's role, else 'reader' (session
-- workspace only), so no existing agent gains a permission it did not have.

update public.user_agents
  set role = case
    when forked_from in ('researcher','reasoner','planner','writer','tester','steward','reviewer') then forked_from
    else 'reader'
  end
  where role is null;

alter table public.user_agents alter column role set default 'reader';
alter table public.user_agents alter column role set not null;
