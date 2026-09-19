-- ============================================================
-- Lets the Companion app log in and call RaidLead's backend directly,
-- instead of relaying through a browser-picked "bridge folder". This
-- project has no migration runner -- run this once, by hand, in the
-- Supabase SQL editor, same as every other schema change to date. Safe to
-- re-run: every statement is idempotent.
--
-- Note: sql/2026_09_loot_drops.sql's header comment claims "loot import is
-- authenticated by the normal team session, since the browser (not a
-- separate companion app) is what reads the addon's SavedVariables file...
-- and posts it here as the logged-in user." That's no longer true once this
-- ships -- the Companion app now has its own credential (companion_tokens
-- below) and uploads directly. See api/companion.js.
-- ============================================================

-- Short-lived pairing handshake: the Companion app creates one of these and
-- shows/polls it, the website (already logged in via the normal Battle.net
-- session) approves it, and the Companion app's own next poll claims it --
-- see api/companion.js's checkPairing for why the claim (and the actual
-- token mint) happens there instead of at approval time: it means the
-- plaintext bearer token is never written to any column, not even
-- momentarily.
create table if not exists companion_pairings (
  id           uuid primary key default gen_random_uuid(),
  pairing_code text not null unique,
  status       text not null default 'pending', -- 'pending' -> 'approved' -> 'claimed'
  account_id   uuid references accounts(id),     -- set on approve
  device_label text,                              -- e.g. hostname, set by the companion app; shown on the approve screen
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '10 minutes')
);

-- One row per Companion app install that's logged in. The bearer token
-- itself is never stored -- only its sha256 hash, same principle as a
-- password hash, so a database leak doesn't directly hand out live
-- credentials. Revoking access (a lost laptop, etc.) is just setting
-- revoked_at; nothing else needs to change since every companion-token
-- lookup already filters on `revoked_at is null`.
create table if not exists companion_tokens (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  token_hash    text not null unique,
  device_label  text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists companion_tokens_account_id_idx on companion_tokens(account_id);
