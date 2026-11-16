-- 019: demo_leads is reachable only through record_demo_lead().
--
-- Supabase default privileges grant ALL on new relations to anon/authenticated,
-- and 017 enabled RLS without revoking them — so a policy added later, or RLS
-- switched off to debug, would expose the lead list. Same form as
-- 007_content_library.sql:140. 017 is already applied, hence a new file.

revoke all on public.demo_leads from public, anon, authenticated;
