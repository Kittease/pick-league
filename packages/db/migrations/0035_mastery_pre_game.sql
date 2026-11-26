-- Mastery curve from the masteries fetched before the game only. The worker stores a player's
-- mastery as Riot gives it when it fetches it, often right after storing one of their matches (a
-- first game on a champion asks for it at once): the points then include that game and the
-- later ones. A player who lost their first game on a champion stays under 1,000 points, one
-- who won keeps playing it: under 5k points the slots fetched after the game won 5.4 % (under
-- 1k) where those fetched before won 43.6 %, and the low-vs-high mastery gap of the curve was
-- ~10.5 points instead of ~3.7 (Nov 2026, 16.22 + 16.23). The picks see the user's points before
-- the game, so only those participants are counted now.
-- `last_played_at` is Riot's `lastPlayTime`: the end of the player's last game on the champion
-- (measured on production: within a minute of `started_at + duration_s` of the matching game).
-- `last_played_at < m.started_at`: the last game the points count ended before this one started,
-- so they do not include it. About 8.5 % of the participants with a mastery row (548k of 6.5M on
-- 16.22 + 16.23); more of the recent matches (their players' rows are older than the game until
-- the next fetch) than of the older ones.
-- Same name, columns, buckets and unique index as 0018 (the API reads it unchanged), refreshed
-- CONCURRENTLY with the other stats views (STATS_REFRESH_ORDER, without nested loops).

-- Built serially and with hash joins, like its refresh (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;
SET LOCAL enable_nestloop = off;

DROP MATERIALIZED VIEW stats_champion_mastery;
CREATE MATERIALIZED VIEW stats_champion_mastery AS
SELECT
  m.patch, p.position, p.champion_id,
  width_bucket(cm.points, ARRAY[5000, 20000, 50000, 100000, 200000, 500000])::smallint AS bucket,
  count(*)::int AS games,
  count(*) FILTER (WHERE p.win)::int AS wins
FROM participants p
JOIN matches m ON m.id = p.match_id
JOIN champion_masteries cm ON cm.puuid = p.puuid AND cm.champion_id = p.champion_id
WHERE NOT m.is_remake AND p.position IS NOT NULL AND cm.last_played_at < m.started_at
GROUP BY m.patch, p.position, p.champion_id, 4;
CREATE UNIQUE INDEX stats_champion_mastery_pk
  ON stats_champion_mastery (patch, position, champion_id, bucket);
