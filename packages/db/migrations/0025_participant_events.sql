-- Item and skill events as arrays, one row per participant instead of one row per event.
--
-- item_events (one row per purchase / sale / undo, ~24 per participant) and skill_events (one
-- row per skill point, ~15) were three quarters of the database: at 442k matches 105 million
-- + 64 million rows, 20 GB + 7 GB, and the stats refresh spent 31 of its 43 minutes sorting and
-- hashing them (14 GB of temporary files). participant_events holds the same events as parallel
-- arrays in timeline order, so a participant's build is computed from its own row.
--
--   item_types[i]  what happened, one byte:
--                    'P' purchase              item_ids[i] = the item
--                    'S' sale                  item_ids[i] = the item
--                    'U' undo of a purchase    item_ids[i] = the item taken back (Riot beforeId)
--                    'u' undo of a sale        item_ids[i] = the item given back (Riot afterId;
--                                              its beforeId is 0)
--   item_ids[i]    see above
--   item_at_ms[i]  game time of the event, in milliseconds
--   skill_slots    the skill points in order (1=Q 2=W 3=E 4=R)
--
-- Read back as rows of the old item_events: (type, item_id, undo_after_item_id) =
-- 'P' -> (PURCHASED, id, NULL), 'S' -> (SOLD, id, NULL), 'U' -> (UNDO, id, 0),
-- 'u' -> (UNDO, 0, id). An UNDO with neither id is ('U', 0). An UNDO with both a beforeId and an
-- afterId (Riot's undo takes back one purchase or one sale: never seen) is stored as 'U' with its
-- beforeId, which is all the stats ever read of it.
--
-- Not kept, because nothing read them: undo_gold_gain, the time of a skill point, evolutions
-- (Kha'Zix, Kai'Sa, Viktor: skill_events.is_evolve, only ever read to leave them out), and the
-- seq numbers (the position in the arrays is the order).
--
-- This migration only adds the table and fills it from the old ones, which stay in place and
-- untouched: the stats views still read them until 0026 replaces them. A participant without any
-- event has no row.
--
-- The backfill streams: both old tables are read in primary-key order and aggregated group by
-- group (GroupAggregate over the index, then a merge join of the two), so nothing is sorted or
-- hashed whatever their size. The planner would rather hash or sort: both are switched off here.
SET LOCAL max_parallel_workers_per_gather = 0;
SET LOCAL enable_hashagg = off;
SET LOCAL enable_sort = off;
SET LOCAL enable_hashjoin = off;

CREATE TABLE participant_events (
  match_id       text       NOT NULL,
  participant_id smallint   NOT NULL,
  item_types     "char"[]   NOT NULL,
  item_ids       integer[]  NOT NULL,
  item_at_ms     integer[]  NOT NULL,
  skill_slots    smallint[] NOT NULL,
  CONSTRAINT participant_events_item_arrays_check CHECK (
    cardinality(item_types) = cardinality(item_ids)
    AND cardinality(item_types) = cardinality(item_at_ms)
  )
);

INSERT INTO participant_events
  (match_id, participant_id, item_types, item_ids, item_at_ms, skill_slots)
SELECT
  match_id, participant_id,
  COALESCE(i.item_types, '{}'), COALESCE(i.item_ids, '{}'), COALESCE(i.item_at_ms, '{}'),
  COALESCE(s.skill_slots, '{}')
FROM (
  SELECT
    match_id, participant_id,
    array_agg(
      (CASE type
         WHEN 'PURCHASED' THEN 'P'
         WHEN 'SOLD' THEN 'S'
         ELSE CASE WHEN item_id = 0 AND COALESCE(undo_after_item_id, 0) <> 0 THEN 'u' ELSE 'U' END
       END)::"char" ORDER BY seq
    ) AS item_types,
    array_agg(
      CASE WHEN type = 'UNDO' AND item_id = 0 THEN COALESCE(undo_after_item_id, 0) ELSE item_id END
      ORDER BY seq
    ) AS item_ids,
    array_agg(at_ms ORDER BY seq) AS item_at_ms
  FROM item_events
  WHERE type <> 'DESTROYED'  -- none is left since 0021
  GROUP BY match_id, participant_id
) i
FULL JOIN (
  SELECT match_id, participant_id, array_agg(skill_slot ORDER BY seq) AS skill_slots
  FROM skill_events
  WHERE NOT is_evolve
  GROUP BY match_id, participant_id
) s USING (match_id, participant_id);

-- Same key and cascade as the old tables: deleting a patch deletes its matches, their
-- participants and, through this, their events.
ALTER TABLE participant_events ADD PRIMARY KEY (match_id, participant_id);
ALTER TABLE participant_events
  ADD FOREIGN KEY (match_id, participant_id) REFERENCES participants ON DELETE CASCADE;

ANALYZE participant_events;
