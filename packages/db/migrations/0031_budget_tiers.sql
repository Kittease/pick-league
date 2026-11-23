-- Three tiers for the regional budget: the tracked apex players, the Masters outside Riot's list
-- (one pass a day), then as many Diamond players as the rest of the budget allows.

-- The Diamond target of a platform: how many Diamond players the worker tracks, sized by itself
-- under DIAMOND_MAX_TRACKED. One row per platform, written by the worker.
CREATE TABLE diamond_tracking (
  platform           platform    PRIMARY KEY,
  target             integer     NOT NULL,
  -- Outcome of the ladder cycles since the target last changed, oldest first, one letter each:
  -- K kept up, P daily Master pass running, R recovering from it, W waiting for patch data,
  -- M missed.
  cycles             text        NOT NULL DEFAULT '',
  last_cycle_at      timestamptz,           -- start of the last cycle in `cycles`
  -- After a growth step (or a long stop): cycles left to absorb the burst before they count.
  settle_cycles_left smallint    NOT NULL DEFAULT 0,
  changed_at         timestamptz,           -- last change of the target
  changed_from       integer,
  change_reason      text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- fetch_rank is now a band per tier: apex players keep their ladder position (below 100000), the
-- matches listed by a Master outside Riot's list get 100000, tracked Diamond players 200000 + their
-- position among the Diamond players; 1000000 stays the back of the queue. Until now a Diamond
-- player's rank was the number of apex players + their position, and an outside Master's the size
-- of the whole tracked ladder: the PENDING rows at or after the number of apex players move to the
-- Diamond band, in the same order. (The number of apex players moves a little from hour to hour,
-- so a few rows around the boundary may land on the other side.)
UPDATE match_fetch_queue q
SET fetch_rank = LEAST(200000 + q.fetch_rank - a.apex, 999999)
FROM (
  SELECT platform, count(*)::int AS apex FROM ladder_entries
  WHERE tier <> 'DIAMOND' GROUP BY platform
) a
WHERE q.platform = a.platform AND q.status = 'PENDING'
  AND q.fetch_rank >= a.apex AND q.fetch_rank < 1000000;
