-- The Masters outside Riot's list (it stops at 10,000 players) are no longer listed blind once a
-- day: the worker asks for each one's solo queue entry on the platform host, in rotation, and
-- lists a player's match ids only when their wins + losses moved.

-- One row per Master+ player of a platform who is on no ladder the worker tracks: the last
-- counter a check saw, and the baseline of the listing skip rule. Rows are added and removed by
-- the worker (after each ladder refresh and each Diamond sweep); created empty, filled at its
-- first start.
CREATE TABLE outside_masters (
  puuid              text        PRIMARY KEY REFERENCES players ON DELETE CASCADE,
  platform           platform    NOT NULL,
  games              integer,               -- wins + losses at the last check (NULL: never checked)
  checked_at         timestamptz,           -- last check (or failed try)
  games_changed_at   timestamptz,           -- the check that first saw the current `games`
  -- Baseline of the listing skip rule, set by the player's last real match-id listing as an
  -- outside Master (same meaning as on ladder_entries).
  listed_games       integer,
  listed_snapshot_at timestamptz,
  listed_at          timestamptz
);
-- The rotation: never checked first, then least recently checked.
CREATE INDEX outside_masters_rotation_idx
  ON outside_masters (platform, checked_at NULLS FIRST, puuid);

-- The Diamond target was judged on cycles of the daily pass (P, R), which is gone: its history
-- starts over, and the first two days under the new rules (every outside Master gets a first
-- check, then a first real listing when they play) are not held against it.
UPDATE diamond_tracking
SET cycles = '', last_cycle_at = NULL, settle_cycles_left = 48, updated_at = now();
