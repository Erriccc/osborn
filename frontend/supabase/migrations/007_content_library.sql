-- Content library (slice 1: schema only).
-- Per-user library of OUTPUTS derived from sessions: shorts, compilations,
-- text posts, transcripts, audio/video. Raw sessions and raw audio never land
-- here, only redacted, derived items.
--
-- TWO-STATE MODEL (decided 2026-10-06): status is 'draft' or 'published'.
-- Every item starts as a draft. The user publishes each item by hand. Publishing
-- happens through a later server route/function, never from the browser client.
-- Published means public and indexable. There is no visibility/unlisted/indexable
-- column.
--
-- IDENTITY: the Fly machine never supplies a user id. It calls
-- content_ingest(token, payload) with its per-user OSBORN_SYNC_TOKEN. The
-- function resolves the token to instances.user_id server-side, so there is no
-- client-asserted userId and no service-role key.
--
-- PROFILES (decided 2026-10-06, team-only alpha): the existing legacy
-- public.profiles table (id/username/full_name/avatar_url/website, its
-- set_username_default_trigger, the on_auth_user_created/handle_new_user
-- trigger and its three policies) is REUSED AS-IS. username is the user's email
-- and doubles as the public handle for now. This migration does not alter,
-- rewrite or re-policy public.profiles in any way; it only reads
-- profiles.username in the public_content view.
--
-- Additive and idempotent: safe to re-run, and changes no existing behaviour.

-- ---------------------------------------------------------------------------
-- 1. instances.sync_token. Already used by src/app/api/sandbox/route.ts
--    (getSyncToken) but never defined in a migration (schema drift). Prod
--    already has it as text; this is a no-op there.
-- ---------------------------------------------------------------------------
alter table public.instances
  add column if not exists sync_token text;

-- Partial unique index: existing NULL/empty rows don't conflict, and a token
-- maps to at most one user (content_ingest relies on this).
create unique index if not exists instances_sync_token_key
  on public.instances (sync_token)
  where sync_token is not null and sync_token <> '';

-- ---------------------------------------------------------------------------
-- 2. content_items
-- ---------------------------------------------------------------------------
create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  type text not null
    check (type in ('short', 'compilation', 'text_post', 'transcript', 'audio_video')),
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  title text,
  hook text,
  body text,
  transcript text,                 -- redacted
  transcript_segments jsonb,       -- redacted speaker segments
  redaction_log jsonb,             -- COUNTS ONLY, never the redacted values
  source_session_id text check (source_session_id ~ '^[a-zA-Z0-9._-]{1,128}$'),
  source_anchors jsonb,            -- row/offset anchors back into the session
  source_kind text,
  content_hash text,               -- idempotency key for ingest
  slug text check (slug ~ '^[a-z0-9-]{1,80}$'),
  media_path text,                 -- object path in the (future) private content-media bucket
  poster_path text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_items_owner_slug_key unique (owner_user_id, slug),
  constraint content_items_owner_hash_key unique (owner_user_id, content_hash),
  constraint content_items_published_requires_slug
    check (status = 'draft' or (published_at is not null and slug is not null))
);

create index if not exists content_items_owner_status_idx
  on public.content_items (owner_user_id, status);

drop trigger if exists content_items_updated_at on public.content_items;
create trigger content_items_updated_at
  before update on public.content_items
  for each row execute function public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 3. RLS on content_items
--    - No INSERT policy at all: inserts happen only via content_ingest().
--    - The owner can select, update (draft only) and delete.
--    - There is NO anon/public select policy on the table. Public reads go only
--      through the public_content view (section 4), which exposes a safe
--      column list.
-- ---------------------------------------------------------------------------
alter table public.content_items enable row level security;

drop policy if exists "content_items_owner_select" on public.content_items;
create policy "content_items_owner_select" on public.content_items
  for select using (auth.uid() = owner_user_id);

-- The owner may edit content fields, but the resulting row must still be a
-- draft. The client therefore can never publish (draft -> published), and can't
-- edit a published item in place (which would bypass the publish-time rescan).
-- Unpublishing (published -> draft) is allowed. Publishing goes through a later
-- server route/function.
drop policy if exists "content_items_owner_update" on public.content_items;
create policy "content_items_owner_update" on public.content_items
  for update using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id and status = 'draft');

drop policy if exists "content_items_owner_delete" on public.content_items;
create policy "content_items_owner_delete" on public.content_items
  for delete using (auth.uid() = owner_user_id);

-- Removed: a direct published-select policy would expose every column
-- (owner_user_id, source_session_id, source_anchors, redaction_log, media_path,
-- content_hash) to anon. Dropped here in case an earlier draft created it.
drop policy if exists "content_items_public_select_published" on public.content_items;

-- ---------------------------------------------------------------------------
-- 4. public_content: the ONLY public read path for content items.
--    Explicit safe column list, published rows only, plus the owner's handle
--    (legacy profiles.username, which is the email during the alpha).
--    Runs with the view owner's rights (not security_invoker), so it bypasses
--    content_items RLS by design and exposes only these columns.
-- ---------------------------------------------------------------------------
create or replace view public.public_content as
  select c.id,
         c.type,
         c.title,
         c.hook,
         c.body,
         c.transcript,
         c.transcript_segments,
         c.slug,
         c.poster_path,
         c.published_at,
         p.username as handle
  from public.content_items c
  left join public.profiles p on p.id = c.owner_user_id
  where c.status = 'published';

-- A simple view is auto-updatable, and writes through it would run with the
-- view owner's rights (bypassing RLS). Supabase default privileges grant ALL on
-- new relations to anon/authenticated, so strip everything and grant SELECT only.
revoke all on public.public_content from public, anon, authenticated;
grant select on public.public_content to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. content_ingest(token, payload): the ONLY write path from a machine.
-- ---------------------------------------------------------------------------
create or replace function public.content_ingest(p_token text, p_payload jsonb)
returns uuid
language plpgsql
security definer
-- Pin search_path so a caller can't shadow public objects (standard
-- security-definer hardening).
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_type  text;
  v_hash  text;
  v_id    uuid;
begin
  -- SECURITY: anon can execute this, so the token IS the credential. Reject
  -- missing or short tokens before touching any table. Real tokens are two
  -- UUIDs (~73 chars), see route.ts getSyncToken.
  if p_token is null or length(p_token) < 32 then
    raise exception 'content_ingest: invalid token' using errcode = '28000';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'content_ingest: payload must be a JSON object' using errcode = '22023';
  end if;

  -- SECURITY: cap the payload size (256 KiB of JSON text) so the anon-callable
  -- function can't be used to write unbounded data.
  if length(p_payload::text) > 262144 then
    raise exception 'content_ingest: payload too large' using errcode = '22023';
  end if;

  -- SECURITY: the owner comes ONLY from the token lookup. Any owner_user_id /
  -- user_id in the payload is ignored (never read below). This runs as the
  -- function owner, so it can read instances despite RLS. Callers learn
  -- nothing beyond "valid" or "invalid".
  select i.user_id into v_owner
  from public.instances i
  where i.sync_token = p_token;

  if v_owner is null then
    raise exception 'content_ingest: invalid token' using errcode = '28000';
  end if;

  v_type := p_payload ->> 'type';
  if v_type is null
     or v_type not in ('short', 'compilation', 'text_post', 'transcript', 'audio_video') then
    raise exception 'content_ingest: invalid type' using errcode = '22023';
  end if;

  v_hash := nullif(btrim(p_payload ->> 'content_hash'), '');
  if v_hash is null then
    raise exception 'content_ingest: content_hash is required' using errcode = '22023';
  end if;

  -- SECURITY: status is forced to 'draft'. status/published_at in the payload
  -- are ignored, so a machine can never publish. slug/media_path/poster_path
  -- are also not accepted here: they're set by the publish and media steps, so
  -- a machine can't point an item at another user's storage path.
  insert into public.content_items (
    owner_user_id, type, status,
    title, hook, body, transcript, transcript_segments, redaction_log,
    source_session_id, source_anchors, source_kind, content_hash
  ) values (
    v_owner, v_type, 'draft',
    p_payload ->> 'title',
    p_payload ->> 'hook',
    p_payload ->> 'body',
    p_payload ->> 'transcript',
    nullif(p_payload -> 'transcript_segments', 'null'::jsonb),
    nullif(p_payload -> 'redaction_log', 'null'::jsonb),
    p_payload ->> 'source_session_id',
    nullif(p_payload -> 'source_anchors', 'null'::jsonb),
    p_payload ->> 'source_kind',
    v_hash
  )
  on conflict (owner_user_id, content_hash) do update set
    type                = excluded.type,
    title               = excluded.title,
    hook                = excluded.hook,
    body                = excluded.body,
    transcript          = excluded.transcript,
    transcript_segments = excluded.transcript_segments,
    redaction_log       = excluded.redaction_log,
    source_session_id   = excluded.source_session_id,
    source_anchors      = excluded.source_anchors,
    source_kind         = excluded.source_kind
    -- Never touch status. Never overwrite a PUBLISHED item from the machine.
    where public.content_items.status = 'draft'
  returning id into v_id;

  -- A conflict with a published row updates nothing and returns no row, so
  -- return the existing id (idempotent).
  if v_id is null then
    select c.id into v_id
    from public.content_items c
    where c.owner_user_id = v_owner and c.content_hash = v_hash;
  end if;

  return v_id;
end;
$$;

-- SECURITY: no default PUBLIC execute. Only the API roles may call it, and the
-- token check above is the actual authorization.
revoke all on function public.content_ingest(text, jsonb) from public;
grant execute on function public.content_ingest(text, jsonb) to anon, authenticated;
