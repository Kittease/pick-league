-- Ban rates for the tier list (GET /tierlist). Same conventions as 0002_stats_views.sql: keyed by
-- patch, remakes excluded, refreshed CONCURRENTLY by apps/api (STATS_REFRESH_ORDER).

-- Matches per patch (denominator of ban rates).
CREATE MATERIALIZED VIEW stats_patch_matches AS
SELECT patch, count(*)::int AS matches
FROM matches
WHERE NOT is_remake
GROUP BY patch;
CREATE UNIQUE INDEX stats_patch_matches_pk ON stats_patch_matches (patch);

-- Matches where a champion was banned (by either team; a double ban counts once).
CREATE MATERIALIZED VIEW stats_champion_bans AS
SELECT m.patch, b.champion_id, count(DISTINCT b.match_id)::int AS bans
FROM match_bans b
JOIN matches m ON m.id = b.match_id
WHERE NOT m.is_remake AND b.champion_id > 0
GROUP BY m.patch, b.champion_id;
CREATE UNIQUE INDEX stats_champion_bans_pk ON stats_champion_bans (patch, champion_id);
