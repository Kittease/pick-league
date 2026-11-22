-- Tier list rank filter with a Master+ level: the worker now also tracks Diamond players
-- (DIAMOND_MAX_TRACKED), so "every stored game" is no longer "Master+".
--
-- rank_level of stats_tierlist_participants (the participant's current solo tier,
-- players.solo_tier at refresh time): 3 = CHALLENGER, 2 = GRANDMASTER, 1 = MASTER, 0 = anything
-- else (Diamond, below, unknown). It was 2 / 1 / 0 with Master in 0. Rank filters:
-- "Diamond+" (default) = every participant, read from the unfiltered views as before;
-- "Master+" = rank_level >= 1, "Grandmaster+" = rank_level >= 2, "Challenger only" = rank_level = 3.
--
-- A materialized view's query cannot be altered: stats_tierlist_participants is rebuilt, and with
-- it every view that reads it, unchanged (the five stats_tierlist_* aggregates of
-- 0006_tierlist_filters.sql, stats_champion_game_length of 0019, stats_item_swaps of 0026). As in
-- 0026, the new views are built next to the old ones under temporary names (*_0029) and swapped
-- in by the last statements, so an API of the previous version keeps answering meanwhile. That
-- API reads rank_level >= 1 for "Grandmaster+" and = 2 for "Challenger only": until it is
-- restarted on this version those two filters are one level too low.

-- Built serially: parallel hash joins live in /dev/shm (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

-- One row per participant of a non-remake match (intermediate), position may be NULL.
CREATE MATERIALIZED VIEW stats_tierlist_participants_0029 AS
SELECT
  m.patch, m.platform,
  (CASE pl.solo_tier WHEN 'CHALLENGER' THEN 3 WHEN 'GRANDMASTER' THEN 2 WHEN 'MASTER' THEN 1 ELSE 0 END)::smallint AS rank_level,
  p.match_id, p.participant_id, p.team_id, p.champion_id, p.position, p.win
FROM participants p
JOIN matches m ON m.id = p.match_id
LEFT JOIN players pl ON pl.puuid = p.puuid
WHERE NOT m.is_remake;
CREATE UNIQUE INDEX stats_tierlist_participants_0029_pk
  ON stats_tierlist_participants_0029 (match_id, participant_id);

-- Champion + role baseline per segment.
CREATE MATERIALIZED VIEW stats_tierlist_roles_0029 AS
SELECT patch, platform, rank_level, position, champion_id,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins
FROM stats_tierlist_participants_0029
WHERE position IS NOT NULL
GROUP BY patch, platform, rank_level, position, champion_id;
CREATE UNIQUE INDEX stats_tierlist_roles_0029_pk
  ON stats_tierlist_roles_0029 (patch, position, champion_id, platform, rank_level);

-- Lane matchups per segment (segment of the champion's player; the enemy's rank is not used).
CREATE MATERIALIZED VIEW stats_tierlist_vs_0029 AS
SELECT a.patch, a.platform, a.rank_level, a.position, a.champion_id,
       b.position AS enemy_position, b.champion_id AS enemy_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_tierlist_participants_0029 a
JOIN stats_tierlist_participants_0029 b ON b.match_id = a.match_id AND b.team_id <> a.team_id
WHERE b.position = a.position
   OR (a.position IN ('BOTTOM', 'UTILITY') AND b.position IN ('BOTTOM', 'UTILITY'))
GROUP BY a.patch, a.platform, a.rank_level, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_tierlist_vs_0029_pk
  ON stats_tierlist_vs_0029 (patch, position, enemy_position, champion_id, enemy_id, platform, rank_level);

-- Duo partners per segment (segment of the champion's player).
CREATE MATERIALIZED VIEW stats_tierlist_with_0029 AS
SELECT a.patch, a.platform, a.rank_level, a.position, a.champion_id,
       b.position AS ally_position, b.champion_id AS ally_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_tierlist_participants_0029 a
JOIN stats_tierlist_participants_0029 b
  ON b.match_id = a.match_id AND b.team_id = a.team_id AND b.participant_id <> a.participant_id
WHERE (a.position, b.position) IN (
  ('TOP', 'JUNGLE'), ('JUNGLE', 'TOP'), ('JUNGLE', 'MIDDLE'), ('MIDDLE', 'JUNGLE'),
  ('BOTTOM', 'UTILITY'), ('UTILITY', 'BOTTOM'))
GROUP BY a.patch, a.platform, a.rank_level, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_tierlist_with_0029_pk
  ON stats_tierlist_with_0029 (patch, position, ally_position, champion_id, ally_id, platform, rank_level);

-- Ban rates per segment, weighted per participant: ban rate = participants whose match had the
-- champion banned / participants. With every participant counted (server filter only) that is
-- exactly banned matches / matches, as in stats_champion_bans / stats_patch_matches.
CREATE MATERIALIZED VIEW stats_tierlist_bans_0029 AS
SELECT tp.patch, tp.platform, tp.rank_level, b.champion_id, count(*)::int AS participants
FROM (SELECT DISTINCT match_id, champion_id FROM match_bans WHERE champion_id > 0) b
JOIN stats_tierlist_participants_0029 tp ON tp.match_id = b.match_id
GROUP BY tp.patch, tp.platform, tp.rank_level, b.champion_id;
CREATE UNIQUE INDEX stats_tierlist_bans_0029_pk
  ON stats_tierlist_bans_0029 (patch, champion_id, platform, rank_level);

-- Participants per segment (denominator of the ban rates above).
CREATE MATERIALIZED VIEW stats_tierlist_totals_0029 AS
SELECT patch, platform, rank_level, count(*)::int AS participants
FROM stats_tierlist_participants_0029
GROUP BY patch, platform, rank_level;
CREATE UNIQUE INDEX stats_tierlist_totals_0029_pk ON stats_tierlist_totals_0029 (patch, platform, rank_level);

-- Game length profile (0019_game_length.sql), unchanged.
CREATE MATERIALIZED VIEW stats_champion_game_length_0029 AS
SELECT tp.patch, tp.position, tp.champion_id,
       (CASE WHEN m.duration_s < 1500 THEN 0 WHEN m.duration_s < 1920 THEN 1 ELSE 2 END)::smallint AS bucket,
       count(*)::int AS games,
       count(*) FILTER (WHERE tp.win)::int AS wins
FROM stats_tierlist_participants_0029 tp
JOIN matches m ON m.id = tp.match_id
WHERE tp.position IS NOT NULL
GROUP BY tp.patch, tp.position, tp.champion_id, 4;
-- Unique (REFRESH ... CONCURRENTLY): one role's champions (tier list), or every role (draft).
CREATE UNIQUE INDEX stats_champion_game_length_0029_pk
  ON stats_champion_game_length_0029 (patch, position, champion_id, bucket);

-- Late-game swaps (0026_stats_on_participant_events.sql), unchanged.
CREATE MATERIALIZED VIEW stats_item_swaps_0029 AS
WITH completed AS (
  SELECT patch, array_agg(id) AS item_ids FROM items WHERE is_completed GROUP BY patch
),
-- Sales followed within 60 s by the purchase of another item that is not undone right after.
candidates AS (
  SELECT pe.match_id, pe.participant_id, pe.item_types, pe.item_ids, s.ord,
         pe.item_at_ms[s.ord] AS at_ms,
         pe.item_ids[s.ord] AS sold_item_id,
         pe.item_ids[s.ord + 1] AS bought_item_id
  FROM participant_events pe
  CROSS JOIN LATERAL (SELECT generate_series(1, cardinality(pe.item_ids) - 1) AS ord) s
  WHERE 'S' = ANY (pe.item_types)
    AND pe.item_types[s.ord] = 'S'
    AND pe.item_types[s.ord + 1] = 'P'
    AND pe.item_ids[s.ord + 1] <> pe.item_ids[s.ord]
    AND pe.item_at_ms[s.ord + 1] - pe.item_at_ms[s.ord] <= 60000
    AND (pe.item_types[s.ord + 2] IS DISTINCT FROM 'U'
         OR pe.item_ids[s.ord + 2] IS DISTINCT FROM pe.item_ids[s.ord + 1])
),
-- Both items completed on the match's patch and a full build before the sale; one row per
-- participant and pair (the first time they made it).
swaps AS (
  SELECT tp.patch, tp.position, tp.champion_id, k.match_id, k.participant_id,
         k.sold_item_id, k.bought_item_id, min(k.at_ms) AS at_ms
  FROM candidates k
  JOIN stats_tierlist_participants_0029 tp
    ON tp.match_id = k.match_id AND tp.participant_id = k.participant_id
  JOIN completed c ON c.patch = tp.patch
  WHERE tp.position IS NOT NULL
    AND k.sold_item_id = ANY (c.item_ids)
    AND k.bought_item_id = ANY (c.item_ids)
    AND (
      SELECT count(DISTINCT k.item_ids[b.ord])
      FROM generate_series(1, k.ord - 1) AS b(ord)
      WHERE k.item_types[b.ord] = 'P' AND k.item_ids[b.ord] = ANY (c.item_ids)
    ) >= 6
  GROUP BY tp.patch, tp.position, tp.champion_id, k.match_id, k.participant_id,
           k.sold_item_id, k.bought_item_id
)
SELECT patch, position, champion_id, sold_item_id, bought_item_id,
       count(*)::int AS games,
       (sum(at_ms)::numeric / 60000)::float8 AS minute_sum
FROM swaps
GROUP BY patch, position, champion_id, sold_item_id, bought_item_id;
CREATE UNIQUE INDEX stats_item_swaps_0029_pk
  ON stats_item_swaps_0029 (patch, position, champion_id, sold_item_id, bought_item_id);

-- ---------------------------------------------------------------------------
-- Swap: the old views go, the new ones take their names.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW stats_item_swaps, stats_champion_game_length;
DROP MATERIALIZED VIEW stats_tierlist_roles, stats_tierlist_vs, stats_tierlist_with,
  stats_tierlist_bans, stats_tierlist_totals;
DROP MATERIALIZED VIEW stats_tierlist_participants;

ALTER MATERIALIZED VIEW stats_tierlist_participants_0029 RENAME TO stats_tierlist_participants;
ALTER MATERIALIZED VIEW stats_tierlist_roles_0029 RENAME TO stats_tierlist_roles;
ALTER MATERIALIZED VIEW stats_tierlist_vs_0029 RENAME TO stats_tierlist_vs;
ALTER MATERIALIZED VIEW stats_tierlist_with_0029 RENAME TO stats_tierlist_with;
ALTER MATERIALIZED VIEW stats_tierlist_bans_0029 RENAME TO stats_tierlist_bans;
ALTER MATERIALIZED VIEW stats_tierlist_totals_0029 RENAME TO stats_tierlist_totals;
ALTER MATERIALIZED VIEW stats_champion_game_length_0029 RENAME TO stats_champion_game_length;
ALTER MATERIALIZED VIEW stats_item_swaps_0029 RENAME TO stats_item_swaps;
ALTER INDEX stats_champion_game_length_0029_pk RENAME TO stats_champion_game_length_pk;
ALTER INDEX stats_item_swaps_0029_pk RENAME TO stats_item_swaps_pk;
ALTER INDEX stats_tierlist_bans_0029_pk RENAME TO stats_tierlist_bans_pk;
ALTER INDEX stats_tierlist_participants_0029_pk RENAME TO stats_tierlist_participants_pk;
ALTER INDEX stats_tierlist_roles_0029_pk RENAME TO stats_tierlist_roles_pk;
ALTER INDEX stats_tierlist_totals_0029_pk RENAME TO stats_tierlist_totals_pk;
ALTER INDEX stats_tierlist_vs_0029_pk RENAME TO stats_tierlist_vs_pk;
ALTER INDEX stats_tierlist_with_0029_pk RENAME TO stats_tierlist_with_pk;
