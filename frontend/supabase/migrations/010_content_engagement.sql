-- 010: lightweight engagement counters on content_items + a public,
-- locked-down track function.
--
-- Owners already read their own rows (content_items_owner_select), so adding
-- counter columns is enough for the library to show engagement. Anonymous
-- visitors on a public /p page can ONLY bump a counter on a PUBLISHED item via
-- the SECURITY DEFINER content_track() — they can't read the table, can't touch
-- drafts, and can't change anything else.
--
-- Additive and idempotent.

alter table public.content_items add column if not exists view_count integer not null default 0;
alter table public.content_items add column if not exists talk_count integer not null default 0;

-- content_track(item, event) — increment a published item's view/talk counter.
create or replace function public.content_track(p_item_id uuid, p_event text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event = 'view' then
    update public.content_items set view_count = view_count + 1
      where id = p_item_id and status = 'published';
  elsif p_event = 'talk' then
    update public.content_items set talk_count = talk_count + 1
      where id = p_item_id and status = 'published';
  end if;
  -- any other event is a silent no-op
end;
$$;

revoke all on function public.content_track(uuid, text) from public;
grant execute on function public.content_track(uuid, text) to anon, authenticated;
