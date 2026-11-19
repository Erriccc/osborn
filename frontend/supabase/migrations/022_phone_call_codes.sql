-- 022: emailed code on phone calls (#362).
--
-- Supabase Auth makes, emails, stores (hashed) and single-uses the code itself
-- (signInWithOtp / verifyOtp, frontend/src/lib/phone-code.ts). This table adds
-- what Supabase does not, per call: a 5-minute window and at most 3 tries,
-- shared by every frontend instance (the agent's tries and the call's lines
-- can be served by different ones). It holds no code.
--
--   room_name    the call's LiveKit room (one per call, "call-…")
--   attempts     tries counted, each before its check runs (the try limit)
--   misses       tries whose check came back wrong (what the caller is told)
--   verified_at  set when the code matched; the agent then takes the call
--
-- Service role only: RLS on with no policies, and no grants to client roles.
-- Rows are swept a day after they expire, when the next call opens one.
--
-- NOT APPLIED automatically. Apply before turning PHONE_EMAIL_CODE_ENABLED on.

create table if not exists public.phone_call_codes (
  room_name text primary key check (room_name like 'call-%' and length(room_name) <= 128),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts smallint not null default 0 check (attempts >= 0),
  misses smallint not null default 0 check (misses >= 0),
  verified_at timestamptz
);

create index if not exists phone_call_codes_expires_at_idx on public.phone_call_codes (expires_at);

alter table public.phone_call_codes enable row level security;
revoke all on table public.phone_call_codes from public, anon, authenticated;
grant select, insert, update, delete on table public.phone_call_codes to service_role;
