-- Game length profile: results of a champion + role in short, medium and long games.
-- bucket 0 = under 25 min (duration_s < 1500), 1 = 25 to under 32 min, 2 = 32 min or more
-- (mirrors GAME_LENGTH_MINUTES of packages/shared/src/api-contract.ts; keep them in sync).
-- Remakes and participants without a position are excluded like in every stats view. One pass
-- over stats_tierlist_participants (one narrow row per participant of a non-remake match).
-- Served (GET /tierlist/champion, POST /recommendations/draft): explains, never scores.

-- Built serially: parallel hash joins live in /dev/shm, only 64 MB in Docker (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

CREATE MATERIALIZED VIEW stats_champion_game_length AS
SELECT tp.patch, tp.position, tp.champion_id,
       (CASE WHEN m.duration_s < 1500 THEN 0 WHEN m.duration_s < 1920 THEN 1 ELSE 2 END)::smallint AS bucket,
       count(*)::int AS games,
       count(*) FILTER (WHERE tp.win)::int AS wins
FROM stats_tierlist_participants tp
JOIN matches m ON m.id = tp.match_id
WHERE tp.position IS NOT NULL
GROUP BY tp.patch, tp.position, tp.champion_id, 4;
-- Unique (REFRESH ... CONCURRENTLY): one role's champions (tier list), or every role (draft).
CREATE UNIQUE INDEX stats_champion_game_length_pk
  ON stats_champion_game_length (patch, position, champion_id, bucket);
