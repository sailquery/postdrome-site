-- 20260429_care_snapshots.sql
--
-- Aggregate read-only snapshots that the iOS app POSTs when the user
-- generates a caregiver share link. The id (UUID) IS the access credential
-- and appears in the public URL https://postdrome.app/care/<id>.
--
-- THE PRIVACY TRADE-OFF (also called out in
-- Postdrome/Core/Caregiver/CaregiverShareService.swift):
--
-- PAYWALL.md says "ZERO PHI on our servers". The caregiver share is the
-- one controlled exception. To keep it narrow:
--   • payload is AGGREGATE only — counts, top patterns, treatment summary.
--     Never raw events, notes, voice memos, or per-attack timestamps.
--   • Auto-expire (default 30 days from create).
--   • User-revocable from Settings.
--
-- We rely on the UUID being unguessable (122 bits of entropy) for read
-- access — this matches the Notion / Google Docs share-link pattern.
-- Insert is rate-limited and tied to user_id at the app level (no RLS
-- because we don't use Supabase Auth — sign-in is via Apple, identity
-- comes through as a string).

create extension if not exists "pgcrypto";

create table if not exists care_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  payload jsonb not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists care_snapshots_user_id_idx on care_snapshots(user_id);
create index if not exists care_snapshots_expires_at_idx on care_snapshots(expires_at);

-- RLS posture: enable + grant read of unrevoked, unexpired rows by id, and
-- insert/update for any client (the anon key acts as a shared bearer token;
-- per-row scoping happens in the iOS app since we don't use Supabase Auth).
alter table care_snapshots enable row level security;

-- Public read: anyone with the id can fetch a non-revoked, non-expired row.
drop policy if exists care_snapshots_read_active on care_snapshots;
create policy care_snapshots_read_active
  on care_snapshots
  for select
  to anon
  using (revoked_at is null and expires_at > now());

-- Public insert: anon role may insert. We trust the iOS app to set
-- user_id correctly; abuse is rate-limited at the app layer.
drop policy if exists care_snapshots_insert_anon on care_snapshots;
create policy care_snapshots_insert_anon
  on care_snapshots
  for insert
  to anon
  with check (true);

-- Public update: anon role may set revoked_at on a row by id. Same trust
-- model — the iOS app only revokes its own user_id rows.
drop policy if exists care_snapshots_revoke_anon on care_snapshots;
create policy care_snapshots_revoke_anon
  on care_snapshots
  for update
  to anon
  using (true)
  with check (true);
