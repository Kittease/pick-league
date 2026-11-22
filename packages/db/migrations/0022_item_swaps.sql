-- Late-game swaps: the completed item a champion + role sells once its build is full, and the
-- completed item it buys in its place (Guardian Angel -> Bloodthirster, Mejai's Soulstealer ->
-- Rabadon's Deathcap, one pair of boots -> another...).
--
-- stats_item_swaps (served): per (patch, position, champion, sold item, bought item), the
-- participants who made the swap (`games`: a pair counts once per participant) and the sum of the
-- game minutes of their first such sale (`minute_sum`; average minute = minute_sum / games,
-- patches are combined by summing both columns). A swap is, for a participant of a non-remake
-- match with a position:
--   - a SOLD event of a completed item (items.is_completed: boots included),
--   - whose next event (by seq, among PURCHASED / SOLD / UNDO) is the PURCHASED of another
--     completed item, at most 60 s later (median 1.2 s, 99th percentile 34 s on 8,000 matches;
--     a sale followed by an UNDO, 27 % of them, is a sale taken back),
--   - that purchase not being undone right away (the event after it is not its UNDO),
--   - with a full build: at least 6 distinct completed items (boots included) bought before the
--     sale. Without it, most pairs are early boots changes and Mejai's sales.
-- On those 8,000 matches, 1,200 of the 80,000 participants have one. No wins: players who can
-- afford a swap are in long games they are winning, a win rate would say nothing about the swap.
-- Served by POST /recommendations/build: explains, never scores. Unfiltered data only.
--
-- item_events is the largest table (~240 rows per match) and is never sorted or hashed here:
--   1. `sellers`: one pass over it for the participants with a SOLD event of an item that is a
--      completed item on some patch (a few percent of the participants).
--   2. `candidates`: for each of them only, their events read in seq order through the primary
--      key (a subquery per seller: a few dozen rows, no sort), each with the two events that
--      follow it and the items purchased so far.
--   3. `swaps`: who the participant is (stats_tierlist_participants: one narrow row per
--      participant of a non-remake match, hence refreshed after it, see STATS_REFRESH_ORDER) and
--      the item data of the match's patch (its completed items, as an array) are only looked at
--      for the sales that pass every other rule.

-- Built serially: parallel hash joins live in /dev/shm, only 64 MB in Docker (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

CREATE MATERIALIZED VIEW stats_item_swaps AS
WITH completed AS (
  SELECT patch, array_agg(id) AS item_ids FROM items WHERE is_completed GROUP BY patch
),
sellers AS (
  SELECT DISTINCT e.match_id, e.participant_id
  FROM item_events e
  WHERE e.type = 'SOLD' AND e.item_id IN (SELECT id FROM items WHERE is_completed)
),
-- Sales followed within 60 s by the purchase of another item that is not undone right after.
candidates AS (
  SELECT s.match_id, s.participant_id,
         r.at_ms, r.item_id AS sold_item_id, r.next_item_id AS bought_item_id, r.purchased
  FROM sellers s
  CROSS JOIN LATERAL (
    SELECT
      e.at_ms, e.type, e.item_id,
      lead(e.type) OVER w AS next_type,
      lead(e.item_id) OVER w AS next_item_id,
      lead(e.at_ms) OVER w AS next_at_ms,
      lead(e.type, 2) OVER w AS after_type,
      lead(e.item_id, 2) OVER w AS after_item_id,
      -- Every item purchased up to this event (a few dozen ids at most).
      array_agg(e.item_id) FILTER (WHERE e.type = 'PURCHASED') OVER w AS purchased
    FROM item_events e
    WHERE e.match_id = s.match_id AND e.participant_id = s.participant_id
      AND e.type IN ('PURCHASED', 'SOLD', 'UNDO')
    WINDOW w AS (ORDER BY e.seq)
  ) r
  WHERE r.type = 'SOLD'
    AND r.next_type = 'PURCHASED'
    AND r.next_item_id <> r.item_id
    AND r.next_at_ms - r.at_ms <= 60000
    AND (r.after_type IS DISTINCT FROM 'UNDO' OR r.after_item_id IS DISTINCT FROM r.next_item_id)
),
-- Both items completed on the match's patch and a full build before the sale; one row per
-- participant and pair (the first time they made it).
swaps AS (
  SELECT tp.patch, tp.position, tp.champion_id, k.match_id, k.participant_id,
         k.sold_item_id, k.bought_item_id, min(k.at_ms) AS at_ms
  FROM candidates k
  JOIN stats_tierlist_participants tp
    ON tp.match_id = k.match_id AND tp.participant_id = k.participant_id
  JOIN completed c ON c.patch = tp.patch
  WHERE tp.position IS NOT NULL
    AND k.sold_item_id = ANY (c.item_ids)
    AND k.bought_item_id = ANY (c.item_ids)
    AND (
      SELECT count(DISTINCT p.item_id)
      FROM unnest(k.purchased) AS p(item_id)
      WHERE p.item_id = ANY (c.item_ids)
    ) >= 6
  GROUP BY tp.patch, tp.position, tp.champion_id, k.match_id, k.participant_id,
           k.sold_item_id, k.bought_item_id
)
SELECT patch, position, champion_id, sold_item_id, bought_item_id,
       count(*)::int AS games,
       (sum(at_ms)::numeric / 60000)::float8 AS minute_sum
FROM swaps
GROUP BY patch, position, champion_id, sold_item_id, bought_item_id;
-- Unique (REFRESH ... CONCURRENTLY): the swaps of one champion + role (build).
CREATE UNIQUE INDEX stats_item_swaps_pk
  ON stats_item_swaps (patch, position, champion_id, sold_item_id, bought_item_id);
