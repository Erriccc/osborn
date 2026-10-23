-- Content renditions (slice 3: the refine studio).
--
-- A "rendition" is a polished, platform-specific rewrite of a raw library item,
-- produced by the content refine studio (a fast LLM + a chat-to-refine loop).
--
-- KEY ARCHITECTURAL DECISION (2026-10-22): a rendition is NOT a new entity. It
-- is itself a public.content_items row that links back to its source via a new
-- parent_source_id column. Because a rendition is a content_items row, it flows
-- through the EXISTING publish path unchanged: content_publish() flips it to
-- published and the /p/[handle]/[slug] public route serves it from the
-- public_content view with zero new public plumbing. The view already exposes
-- every published content_items row, so renditions are covered automatically.
--
-- RLS stays EXACTLY as migration 007 defined it:
--   - owner_select / owner_update (draft-only) / owner_delete unchanged.
--   - There is still NO client INSERT policy. Renditions are created only by the
--     SECURITY DEFINER function content_create_rendition below (mirroring how
--     content_ingest is the only machine write path).
--   - public_content is NOT weakened; it is left untouched.
--
-- The raw source rows keep parent_source_id = null. Renditions point at their
-- source. `type` holds the platform/format of the rendition (e.g. 'blog',
-- 'x_thread', 'linkedin', 'short', 'newsletter').
--
-- Additive and idempotent: safe to re-run, changes no existing behaviour.

-- ---------------------------------------------------------------------------
-- 1. parent_source_id — link a rendition back to the content_items row it was
--    derived from. ON DELETE SET NULL so deleting a source orphans (but does
--    not destroy) its published renditions.
-- ---------------------------------------------------------------------------
alter table public.content_items
  add column if not exists parent_source_id uuid
    references public.content_items(id) on delete set null;

create index if not exists content_items_parent_source_idx
  on public.content_items (parent_source_id)
  where parent_source_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Relax the `type` check constraint to admit platform/format values used by
--    renditions, while keeping the original raw-item types valid. Migration 007
--    constrained type to ('short','compilation','text_post','transcript',
--    'audio_video'); renditions add ('blog','x_thread','linkedin','newsletter')
--    (and reuse 'short'). Drop + recreate is idempotent.
-- ---------------------------------------------------------------------------
alter table public.content_items
  drop constraint if exists content_items_type_check;

alter table public.content_items
  add constraint content_items_type_check
  check (type in (
    -- raw source kinds (migration 007)
    'short', 'compilation', 'text_post', 'transcript', 'audio_video',
    -- rendition platforms/formats (migration 009)
    'blog', 'x_thread', 'linkedin', 'newsletter'
  ));

-- ---------------------------------------------------------------------------
-- 3. content_create_rendition(p_source_id, p_type, p_title, p_body, p_hook)
--    -> new rendition id.
--
--    AUTHZ (mirrors content_publish in 008): runs with the function owner's
--    rights so it can INSERT past the no-INSERT-policy RLS, therefore it MUST
--    verify auth.uid() owns the source itself. Granted to `authenticated` only.
--    The new row is always owner_user_id = auth.uid(), status = 'draft'.
-- ---------------------------------------------------------------------------
create or replace function public.content_create_rendition(
  p_source_id uuid,
  p_type      text,
  p_title     text,
  p_body      text,
  p_hook      text default null
)
returns uuid
language plpgsql
security definer
-- Pin search_path so a caller can't shadow public objects (standard
-- security-definer hardening).
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_id    uuid;
begin
  if auth.uid() is null then
    raise exception 'content_create_rendition: not authenticated' using errcode = '28000';
  end if;

  -- The source must exist and be owned by the caller.
  select c.owner_user_id into v_owner
  from public.content_items c
  where c.id = p_source_id;

  if v_owner is null then
    raise exception 'content_create_rendition: source not found' using errcode = 'P0002';
  end if;

  if v_owner <> auth.uid() then
    raise exception 'content_create_rendition: not the owner' using errcode = '42501';
  end if;

  if p_type is null
     or p_type not in ('blog', 'x_thread', 'linkedin', 'short', 'newsletter') then
    raise exception 'content_create_rendition: invalid platform type' using errcode = '22023';
  end if;

  -- SECURITY: status forced to 'draft'. owner_user_id forced to auth.uid().
  -- No slug/published_at/media here — publishing a rendition goes through the
  -- existing content_publish().
  insert into public.content_items (
    owner_user_id, type, status, title, hook, body, parent_source_id
  ) values (
    auth.uid(), p_type, 'draft', p_title, p_hook, p_body, p_source_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. content_update_rendition(p_item_id, p_title, p_body, p_hook) -> void.
--    Owner-checked, draft-only, and only for rows that are actually renditions
--    (parent_source_id is not null) so this can't be used to rewrite a raw
--    source item in place.
-- ---------------------------------------------------------------------------
create or replace function public.content_update_rendition(
  p_item_id uuid,
  p_title   text,
  p_body    text,
  p_hook    text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner  uuid;
  v_status text;
  v_parent uuid;
begin
  if auth.uid() is null then
    raise exception 'content_update_rendition: not authenticated' using errcode = '28000';
  end if;

  select c.owner_user_id, c.status, c.parent_source_id
    into v_owner, v_status, v_parent
  from public.content_items c
  where c.id = p_item_id;

  if v_owner is null then
    raise exception 'content_update_rendition: item not found' using errcode = 'P0002';
  end if;

  if v_owner <> auth.uid() then
    raise exception 'content_update_rendition: not the owner' using errcode = '42501';
  end if;

  if v_parent is null then
    raise exception 'content_update_rendition: not a rendition' using errcode = '22023';
  end if;

  -- Only a draft rendition may be edited in place. A published one must be
  -- unpublished first (mirrors the 007 draft-only owner_update RLS intent).
  if v_status <> 'draft' then
    raise exception 'content_update_rendition: rendition is not a draft' using errcode = '42501';
  end if;

  update public.content_items
     set title = p_title,
         hook  = p_hook,
         body  = p_body
   where id = p_item_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants. SECURITY: authenticated only — never anon. Both functions
--    authorize via auth.uid() internally.
-- ---------------------------------------------------------------------------
revoke all on function public.content_create_rendition(uuid, text, text, text, text) from public, anon;
grant execute on function public.content_create_rendition(uuid, text, text, text, text) to authenticated;

revoke all on function public.content_update_rendition(uuid, text, text, text) from public, anon;
grant execute on function public.content_update_rendition(uuid, text, text, text) to authenticated;
