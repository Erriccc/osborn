-- Content publish / unpublish (slice 2: the publish server functions).
--
-- Migration 007 deliberately left publishing to "a later server route/function,
-- never the browser client": the owner_update RLS policy forces every
-- client-side write to land as a draft (with check status = 'draft'), so the
-- draft -> published transition can only happen through a SECURITY DEFINER
-- function like the two defined here.
--
-- AUTHORIZATION model (mirrors content_ingest in 007): these run with the
-- function owner's rights, so they can flip status past RLS — therefore they
-- MUST verify auth.uid() = owner_user_id themselves. They are granted to
-- `authenticated` ONLY (never anon): the caller is a signed-in user acting on
-- their own item, identified by their JWT (auth.uid()), not by a token.
--
-- SLUG model: content_items already has
--   slug check (slug ~ '^[a-z0-9-]{1,80}$')
--   constraint content_items_owner_slug_key unique (owner_user_id, slug)
-- so slugs are per-owner unique and format-validated at the column level.
-- content_publish resolves a slug (slugify the title when none is supplied),
-- enforces the same ^[a-z0-9-]{1,80}$ shape, and on a per-owner collision
-- appends a short random suffix rather than failing.
--
-- Additive and idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. content_publish(p_item_id, p_slug) -> (slug, published_at)
--    Draft -> published for an item the caller owns.
-- ---------------------------------------------------------------------------
create or replace function public.content_publish(
  p_item_id uuid,
  p_slug    text default null
)
returns table (slug text, published_at timestamptz)
language plpgsql
security definer
-- Pin search_path so a caller can't shadow public objects (standard
-- security-definer hardening).
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_title text;
  v_slug  text;
  v_base  text;
  v_try   int := 0;
begin
  -- AUTHZ: the caller must be signed in and must own the item. We read owner +
  -- title in one lookup; a NULL owner means the item doesn't exist.
  if auth.uid() is null then
    raise exception 'content_publish: not authenticated' using errcode = '28000';
  end if;

  select c.owner_user_id, c.title
    into v_owner, v_title
  from public.content_items c
  where c.id = p_item_id;

  if v_owner is null then
    raise exception 'content_publish: item not found' using errcode = 'P0002';
  end if;

  if v_owner <> auth.uid() then
    raise exception 'content_publish: not the owner' using errcode = '42501';
  end if;

  -- Resolve the slug. Prefer the caller-supplied one; otherwise slugify the
  -- title. Slugify: lowercase, non-alphanumerics -> '-', collapse + trim '-'.
  v_base := nullif(btrim(coalesce(p_slug, '')), '');
  if v_base is null then
    v_base := regexp_replace(lower(coalesce(v_title, '')), '[^a-z0-9]+', '-', 'g');
    v_base := btrim(v_base, '-');
  else
    v_base := regexp_replace(lower(v_base), '[^a-z0-9]+', '-', 'g');
    v_base := btrim(v_base, '-');
  end if;

  -- Fall back to the item id if slugification produced nothing.
  if v_base is null or v_base = '' then
    v_base := left(replace(p_item_id::text, '-', ''), 12);
  end if;

  -- Clamp to the column's 80-char limit, leaving room for a '-xxxx' suffix.
  v_base := left(v_base, 74);
  v_slug := v_base;

  -- Enforce the column's shape up front so a bad slug raises a clear error
  -- rather than a raw constraint-violation message.
  if v_slug !~ '^[a-z0-9-]{1,80}$' then
    raise exception 'content_publish: invalid slug' using errcode = '22023';
  end if;

  -- On a per-owner collision with a DIFFERENT item, append a short random
  -- suffix and retry a handful of times. (A collision with THIS item's own
  -- existing slug is fine — it'll just keep its slug.)
  loop
    if not exists (
      select 1 from public.content_items c
      where c.owner_user_id = v_owner
        and c.slug = v_slug
        and c.id <> p_item_id
    ) then
      exit;
    end if;
    v_try := v_try + 1;
    if v_try > 5 then
      raise exception 'content_publish: could not allocate a unique slug' using errcode = '23505';
    end if;
    v_slug := left(v_base, 74) || '-' || substr(md5(random()::text), 1, 4);
  end loop;

  -- Flip to published. published_at is only set the first time (so re-publishing
  -- keeps the original date); slug is (re)written to the resolved value.
  update public.content_items c
     set status       = 'published',
         slug         = v_slug,
         published_at = coalesce(c.published_at, now())
   where c.id = p_item_id
   returning c.slug, c.published_at into v_slug, published_at;

  slug := v_slug;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. content_unpublish(p_item_id) -> void. Published -> draft.
-- ---------------------------------------------------------------------------
create or replace function public.content_unpublish(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'content_unpublish: not authenticated' using errcode = '28000';
  end if;

  select c.owner_user_id into v_owner
  from public.content_items c
  where c.id = p_item_id;

  if v_owner is null then
    raise exception 'content_unpublish: item not found' using errcode = 'P0002';
  end if;

  if v_owner <> auth.uid() then
    raise exception 'content_unpublish: not the owner' using errcode = '42501';
  end if;

  -- Keep slug + published_at so re-publishing restores the same URL; just move
  -- the item out of the public view by setting status back to 'draft'.
  update public.content_items
     set status = 'draft'
   where id = p_item_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants. SECURITY: authenticated only — never anon. The functions
--    authorize via auth.uid() internally.
-- ---------------------------------------------------------------------------
revoke all on function public.content_publish(uuid, text) from public, anon;
grant execute on function public.content_publish(uuid, text) to authenticated;

revoke all on function public.content_unpublish(uuid) from public, anon;
grant execute on function public.content_unpublish(uuid) to authenticated;
