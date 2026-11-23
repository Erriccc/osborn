-- 023: nothing calls record_demo_lead() any more; close its public entry point.
--
-- /api/demo-access was deleted (PR #510), but 017 left execute on
-- record_demo_lead(text) granted to anon and authenticated, so anyone holding the
-- public anon key could still insert emails into demo_leads. Revoke it.
-- 019 does not re-grant it. The function and the table are left in place; no data
-- is touched. 017 is already applied, hence a new file.
--
-- Additive and idempotent (revoke is a no-op when nothing is granted).

revoke all on function public.record_demo_lead(text) from public, anon, authenticated;
