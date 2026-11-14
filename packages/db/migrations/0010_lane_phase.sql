-- Lane phase: how the lane goes in a matchup, from the per-minute timeline frames.
--
-- stats_champion_lane_phase (served): per (patch, position, champion, lane opponent), the average
-- total-gold / XP / CS difference at 10 and 15 minutes (frame index 11 and 16: index 1 =
-- minute 0). Lane opponents are the enemies of the same lane: same position, and for the bot
-- lane both enemy bot laners (like stats_choice_matchups / LANE_ROLES).
--   - TOP / JUNGLE / MIDDLE: 1v1, the player's own frames minus the opponent's.
--   - BOTTOM / UTILITY: 2v2, the player + duo partner minus the two enemy bot laners (support gold
--     alone says little about the lane). Both enemy bot laners give the same 2v2 difference, each
--     row conditions it on one of them.
-- Remakes and participants without a position are excluded like in every stats view. A lane is
-- only counted when both sides are complete (one player per solo lane, two in the bot lane) and
-- every one of its players has the frame of that minute (short matches have shorter arrays):
-- `games` counts matchups with frames at 10 min, `games_15` those with frames at 15 min.
-- Averages are exact (numeric) means cast to float8; combining patches is
-- sum(avg * games) / sum(games). Unfiltered data only (no server / rank segments).
--
-- One pass over participants: each (match, lane) row holds both sides (blue = team 100 minus
-- red = team 200), then every (own player, enemy player) pair of the lane gets the difference
-- from its side. No self-join of participants.

-- Built serially: parallel hash joins live in /dev/shm, only 64 MB in Docker (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

CREATE MATERIALIZED VIEW stats_champion_lane_phase AS
WITH lanes AS (
  SELECT
    m.patch,
    array_agg(p.champion_id ORDER BY p.position) FILTER (WHERE p.team_id = 100) AS blue_ids,
    array_agg(p.position ORDER BY p.position) FILTER (WHERE p.team_id = 100) AS blue_positions,
    array_agg(p.champion_id ORDER BY p.position) FILTER (WHERE p.team_id <> 100) AS red_ids,
    array_agg(p.position ORDER BY p.position) FILTER (WHERE p.team_id <> 100) AS red_positions,
    bool_and(p.gold_by_minute[16] IS NOT NULL AND p.xp_by_minute[16] IS NOT NULL
             AND p.cs_by_minute[16] IS NOT NULL) AS has_15,
    sum(CASE WHEN p.team_id = 100 THEN p.gold_by_minute[11] ELSE -p.gold_by_minute[11] END) AS gold_10,
    sum(CASE WHEN p.team_id = 100 THEN p.xp_by_minute[11] ELSE -p.xp_by_minute[11] END) AS xp_10,
    sum(CASE WHEN p.team_id = 100 THEN p.cs_by_minute[11] ELSE -p.cs_by_minute[11] END) AS cs_10,
    sum(CASE WHEN p.team_id = 100 THEN p.gold_by_minute[16] ELSE -p.gold_by_minute[16] END) AS gold_15,
    sum(CASE WHEN p.team_id = 100 THEN p.xp_by_minute[16] ELSE -p.xp_by_minute[16] END) AS xp_15,
    sum(CASE WHEN p.team_id = 100 THEN p.cs_by_minute[16] ELSE -p.cs_by_minute[16] END) AS cs_15
  FROM participants p
  JOIN matches m ON m.id = p.match_id
  WHERE NOT m.is_remake AND p.position IS NOT NULL
  GROUP BY m.patch, p.match_id,
           CASE WHEN p.position IN ('BOTTOM', 'UTILITY') THEN 'BOT' ELSE p.position::text END
  HAVING count(*) FILTER (WHERE p.team_id = 100) = count(*) FILTER (WHERE p.team_id <> 100)
     AND count(*) = CASE WHEN min(p.position) IN ('BOTTOM', 'UTILITY') THEN 4 ELSE 2 END
     AND bool_and(p.gold_by_minute[11] IS NOT NULL AND p.xp_by_minute[11] IS NOT NULL
                  AND p.cs_by_minute[11] IS NOT NULL)
),
-- Each lane from both sides: own team minus the enemy team.
sides AS (
  SELECT patch, blue_ids AS own_ids, blue_positions AS own_positions, red_ids AS enemy_ids,
         red_positions AS enemy_positions, has_15, gold_10, xp_10, cs_10, gold_15, xp_15, cs_15
  FROM lanes
  UNION ALL
  SELECT patch, red_ids, red_positions, blue_ids, blue_positions, has_15,
         -gold_10, -xp_10, -cs_10, -gold_15, -xp_15, -cs_15
  FROM lanes
)
SELECT
  s.patch, own.position, own.champion_id, enemy.position AS enemy_position,
  enemy.champion_id AS enemy_id,
  count(*)::int AS games,
  avg(s.gold_10)::float8 AS gold_diff_10,
  avg(s.xp_10)::float8 AS xp_diff_10,
  avg(s.cs_10)::float8 AS cs_diff_10,
  count(*) FILTER (WHERE s.has_15)::int AS games_15,
  (avg(s.gold_15) FILTER (WHERE s.has_15))::float8 AS gold_diff_15,
  (avg(s.xp_15) FILTER (WHERE s.has_15))::float8 AS xp_diff_15,
  (avg(s.cs_15) FILTER (WHERE s.has_15))::float8 AS cs_diff_15
FROM sides s
CROSS JOIN LATERAL unnest(s.own_ids, s.own_positions) AS own(champion_id, position)
CROSS JOIN LATERAL unnest(s.enemy_ids, s.enemy_positions) AS enemy(champion_id, position)
GROUP BY s.patch, own.position, own.champion_id, enemy.position, enemy.champion_id;
-- Unique (REFRESH ... CONCURRENTLY), like stats_champion_vs: candidates vs given enemies (picks).
CREATE UNIQUE INDEX stats_champion_lane_phase_pk
  ON stats_champion_lane_phase (patch, position, enemy_id, enemy_position, champion_id);
-- One champion's lane opponents (build, GET /tierlist/champion).
CREATE INDEX stats_champion_lane_phase_champion
  ON stats_champion_lane_phase (patch, champion_id, position);
