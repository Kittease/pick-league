-- Listing skip rule (LISTING_SKIP) and Diamond tracking (DIAMOND_MAX_TRACKED).
-- Every new column is nullable without a default (no table rewrite), so the previous worker keeps
-- running against this schema.

ALTER TABLE ladder_entries
  -- 1..4 for DIAMOND rows, NULL for the apex tiers.
  ADD COLUMN division smallint,
  -- The ladder refresh that produced the current wins + losses (NULL on rows written before this
  -- migration: read as updated_at).
  ADD COLUMN games_changed_at timestamptz,
  -- Baseline of the listing skip rule, set by the player's last real match-id listing:
  -- wins + losses and games_changed_at as they were when that listing was decided, and when it ran.
  ADD COLUMN listed_games integer,
  ADD COLUMN listed_snapshot_at timestamptz,
  ADD COLUMN listed_at timestamptz;

-- Start of the newest stored match the player shared with a Master, Grandmaster or Challenger
-- player (known as such when the match was stored). Diamond players with a recent one are tracked
-- first. Every match stored so far was found through a Master+ player.
ALTER TABLE players ADD COLUMN last_seen_with_master_at timestamptz;
UPDATE players SET last_seen_with_master_at = last_seen_in_match_at
WHERE last_seen_in_match_at IS NOT NULL;

-- LISTING_SKIP=shadow: listings the skip rule would have skipped that still queued new match ids.
-- Not every row is a miss (a game that started after the snapshot is legitimately new): compare
-- matches.started_at of new_match_ids with snapshot_at.
CREATE TABLE listing_skip_misses (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  puuid              text        NOT NULL,
  platform           platform    NOT NULL,
  checked_at         timestamptz NOT NULL,  -- when the rule was evaluated (just before the listing)
  listed_snapshot_at timestamptz NOT NULL,  -- start of the window (the baseline's snapshot)
  snapshot_at        timestamptz NOT NULL,  -- end of the window (the ladder refresh of the current wins + losses)
  expected           integer     NOT NULL,  -- wins + losses now - at the baseline
  stored             integer     NOT NULL,  -- stored non-remake matches of the player that ended in the window
  new_match_ids      text[]      NOT NULL   -- ids the listing added to match_fetch_queue
);
CREATE INDEX listing_skip_misses_checked_at_idx ON listing_skip_misses (checked_at);
