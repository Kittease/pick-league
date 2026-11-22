-- Masteries only for champions the player has a stored game on.
--
-- champion_masteries held every champion of every player (33 million rows, 10 GB at 442k matches)
-- while the stats only read it joined to a participant on (puuid, champion_id)
-- (0018_mastery_curve.sql): 96 % of the rows were never read. The worker now stores, of a mastery
-- answer, the rows of the champions the player has a participant row on, and asks for the
-- masteries again when a stored match brings a champion without one.
--
-- A DELETE of 96 % of the rows would leave the table at its size: the rows to keep are copied
-- aside (one primary-key lookup per (player, champion) pair of `participants`, in key order),
-- the table is truncated, which returns its space when this commits, and they are put back.
-- stats_champion_mastery keeps its contents: it only ever counted these rows.
SET LOCAL max_parallel_workers_per_gather = 0;

CREATE TEMP TABLE champion_masteries_kept ON COMMIT DROP AS
SELECT cm.puuid, cm.champion_id, cm.level, cm.points, cm.last_played_at
FROM (
  SELECT DISTINCT puuid, champion_id FROM participants ORDER BY puuid, champion_id
) played
CROSS JOIN LATERAL (
  SELECT *
  FROM champion_masteries m
  WHERE m.puuid = played.puuid AND m.champion_id = played.champion_id
  OFFSET 0  -- keeps the lookup per pair: no hash or sort of the whole table
) cm;

TRUNCATE champion_masteries;

INSERT INTO champion_masteries (puuid, champion_id, level, points, last_played_at)
SELECT puuid, champion_id, level, points, last_played_at
FROM champion_masteries_kept
ORDER BY puuid, champion_id;

ANALYZE champion_masteries;
