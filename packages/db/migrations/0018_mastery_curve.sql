-- Mastery curve: games and wins per (patch, position, champion) by the player's mastery points on
-- the champion, for the mastery term of the picks (POST /recommendations/picks with `masteries`).
-- Buckets of `width_bucket` over the edges 5k / 20k / 50k / 100k / 200k / 500k points: bucket 0 =
-- under 5k points … bucket 6 = 500k and more. The edges mirror `ENGINE_CONFIG.mastery.bucketEdges`
-- in apps/api/src/engine/config.ts: keep them in sync.
-- The mastery is the player's current mastery when their masteries were last fetched by the worker
-- (champion_masteries), not the mastery at match time. Participants without a mastery row for the
-- champion they played are left out. Remakes and participants without a position are excluded like
-- in every stats view. At most 7 rows per champion + role per patch, refreshed CONCURRENTLY with the
-- other stats views (STATS_REFRESH_ORDER).

-- Built serially: parallel hash joins live in /dev/shm (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

CREATE MATERIALIZED VIEW stats_champion_mastery AS
SELECT
  m.patch, p.position, p.champion_id,
  width_bucket(cm.points, ARRAY[5000, 20000, 50000, 100000, 200000, 500000])::smallint AS bucket,
  count(*)::int AS games,
  count(*) FILTER (WHERE p.win)::int AS wins
FROM participants p
JOIN matches m ON m.id = p.match_id
JOIN champion_masteries cm ON cm.puuid = p.puuid AND cm.champion_id = p.champion_id
WHERE NOT m.is_remake AND p.position IS NOT NULL
GROUP BY m.patch, p.position, p.champion_id, 4;
CREATE UNIQUE INDEX stats_champion_mastery_pk
  ON stats_champion_mastery (patch, position, champion_id, bucket);
