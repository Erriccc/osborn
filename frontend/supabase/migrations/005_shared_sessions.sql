-- Session sharing (0.9.123) — COPY model.
-- User A shares a specific session with user B (by email). A's frontend exports
-- the single session from A's machine (GET /sessions/export-one), uploads the
-- tar.gz to the private `session-shares` Storage bucket, and inserts a row here.
-- User B sees rows addressed to their email ("Shared with me"), downloads the
-- snapshot (via an owner-pre-signed long-lived URL stored on the row — no
-- service role needed), and imports it onto THEIR OWN machine (POST
-- /sessions/import). The two copies
-- then diverge independently — no cross-machine live access, nothing existing
-- is touched. Recipient is matched by EMAIL (from the JWT), so a share can be
-- created before B has ever logged in; it appears the moment they sign in.

create table if not exists public.shared_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  owner_email text not null,
  recipient_email text not null,
  session_id text not null check (session_id ~ '^[a-zA-Z0-9._-]{1,128}$'),
  session_title text not null default 'Shared session' check (char_length(session_title) <= 300),
  snapshot_path text not null,          -- object path inside the `session-shares` bucket
  snapshot_url text not null,           -- owner-pre-signed download URL (long expiry) — B fetches this directly
  status text not null default 'ready'  -- ready → the recipient can import; imported → they pulled it
    check (status in ('ready', 'imported')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shared_sessions enable row level security;

-- Normalize the recipient email so JWT-email matching is case-insensitive.
create or replace function public.lc_recipient_email()
returns trigger language plpgsql as $$
begin
  new.recipient_email := lower(trim(new.recipient_email));
  new.owner_email := lower(trim(new.owner_email));
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists shared_sessions_normalize on public.shared_sessions;
create trigger shared_sessions_normalize
  before insert or update on public.shared_sessions
  for each row execute function public.lc_recipient_email();

-- Owner: full control over shares they created.
drop policy if exists "shared_sessions_owner_all" on public.shared_sessions;
create policy "shared_sessions_owner_all" on public.shared_sessions
  for all using (auth.uid() = owner_user_id) with check (auth.uid() = owner_user_id);

-- Recipient: can SEE shares addressed to their email, and UPDATE them (to flip
-- status → 'imported'). Matched on the JWT email, lowercased both sides.
drop policy if exists "shared_sessions_recipient_select" on public.shared_sessions;
create policy "shared_sessions_recipient_select" on public.shared_sessions
  for select using (recipient_email = lower(auth.jwt() ->> 'email'));
drop policy if exists "shared_sessions_recipient_update" on public.shared_sessions;
create policy "shared_sessions_recipient_update" on public.shared_sessions
  for update using (recipient_email = lower(auth.jwt() ->> 'email'));

create index if not exists shared_sessions_recipient_idx on public.shared_sessions (recipient_email);
create index if not exists shared_sessions_owner_idx on public.shared_sessions (owner_user_id);

-- Private bucket for the session snapshots (tar.gz). Not public — the recipient
-- downloads via the owner-pre-signed URL stored on the shared_sessions row.
insert into storage.buckets (id, name, public)
  values ('session-shares', 'session-shares', false)
  on conflict (id) do nothing;

-- Owner can upload snapshots under their own uid prefix: `session-shares/<uid>/...`.
drop policy if exists "session_shares_owner_upload" on storage.objects;
create policy "session_shares_owner_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'session-shares'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "session_shares_owner_manage" on storage.objects;
create policy "session_shares_owner_manage" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'session-shares'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
-- Recipients never read the bucket directly — they use the owner-pre-signed URL.
