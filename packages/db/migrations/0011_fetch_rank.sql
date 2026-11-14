-- Matches are fetched from the top of the ladder down: a queued match carries the ladder position
-- of the best-placed tracked player who listed it (0 = first Challenger). Retried and deferred
-- matches go to the back (1000000, also the value for rows queued before this column existed).
ALTER TABLE match_fetch_queue ADD COLUMN fetch_rank integer NOT NULL DEFAULT 1000000;

DROP INDEX IF EXISTS match_fetch_queue_platform_discovered_at_idx;
CREATE INDEX match_fetch_queue_pending_idx
  ON match_fetch_queue (platform, fetch_rank, discovered_at, match_id) WHERE status = 'PENDING';
