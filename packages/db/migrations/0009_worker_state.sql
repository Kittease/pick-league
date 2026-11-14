-- Worker state that must survive restarts, and a health row per platform.

-- A tracked player "played" (ladder wins + losses changed): their match ids must be listed.
-- Set by the ladder upsert, cleared when a listing that started after it finishes.
ALTER TABLE players ADD COLUMN listing_requested_at timestamptz;
CREATE INDEX players_listing_requested_idx ON players (listing_requested_at)
  WHERE listing_requested_at IS NOT NULL;

-- Transient errors (Riot 429/5xx, network, database connection) defer a match without counting
-- an attempt; this caps how many times that can happen.
ALTER TABLE match_fetch_queue ADD COLUMN transient_errors smallint NOT NULL DEFAULT 0;

-- One row per platform loop, upserted by the worker (read by the API / desktop).
CREATE TABLE worker_status (
  platform            platform    PRIMARY KEY,
  heartbeat_at        timestamptz NOT NULL,  -- updated at least once a minute while that platform's loop runs
  auth_rejected_since timestamptz,           -- set when Riot rejects the key (401/403); cleared on the next successful Riot response
  last_error          text,                  -- last non-abort error (kind: message), truncated to 500 chars
  last_error_at       timestamptz
);
