-- Tier list filters (GET /tierlist?platform=…&rank=…). Same conventions as 0002_stats_views.sql:
-- keyed by patch, remakes excluded, refreshed by apps/api in the order of STATS_REFRESH_ORDER.
--
-- Two extra dimensions, kept at the finest grain and summed at request time:
-- - platform: the server of the match (matches.platform);
-- - rank_level: the participant's current solo tier (players.solo_tier, at refresh time, not at
--   match time): 2 = CHALLENGER, 1 = GRANDMASTER, 0 = anything else (MASTER, below Master or
--   unknown). Rank filter "Grandmaster+" = rank_level >= 1, "Challenger only" = rank_level = 2,
--   "Master+" (default) = every participant (the matches all come from Master+ ladder players).
-- The unfiltered tier list keeps reading stats_champion_roles / _vs / _with / _bans.
--
-- Only the pairs the tier list reads are kept: lane opponents (mirrors LANE_ROLES) and duo
-- partners (mirrors DUO_ROLES) of apps/api/src/engine/config.ts. Keep them in sync.

-- One row per participant of a non-remake match (intermediate), position may be NULL.
CREATE MATERIALIZED VIEW stats_tierlist_participants AS
SELECT
  m.patch, m.platform,
  (CASE pl.solo_tier WHEN 'CHALLENGER' THEN 2 WHEN 'GRANDMASTER' THEN 1 ELSE 0 END)::smallint AS rank_level,
  p.match_id, p.participant_id, p.team_id, p.champion_id, p.position, p.win
FROM participants p
JOIN matches m ON m.id = p.match_id
LEFT JOIN players pl ON pl.puuid = p.puuid
WHERE NOT m.is_remake;
CREATE UNIQUE INDEX stats_tierlist_participants_pk
  ON stats_tierlist_participants (match_id, participant_id);

-- Champion + role baseline per segment.
CREATE MATERIALIZED VIEW stats_tierlist_roles AS
SELECT patch, platform, rank_level, position, champion_id,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins
FROM stats_tierlist_participants
WHERE position IS NOT NULL
GROUP BY patch, platform, rank_level, position, champion_id;
CREATE UNIQUE INDEX stats_tierlist_roles_pk
  ON stats_tierlist_roles (patch, position, champion_id, platform, rank_level);

-- Lane matchups per segment (segment of the champion's player; the enemy's rank is not used).
CREATE MATERIALIZED VIEW stats_tierlist_vs AS
SELECT a.patch, a.platform, a.rank_level, a.position, a.champion_id,
       b.position AS enemy_position, b.champion_id AS enemy_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_tierlist_participants a
JOIN stats_tierlist_participants b ON b.match_id = a.match_id AND b.team_id <> a.team_id
WHERE b.position = a.position
   OR (a.position IN ('BOTTOM', 'UTILITY') AND b.position IN ('BOTTOM', 'UTILITY'))
GROUP BY a.patch, a.platform, a.rank_level, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_tierlist_vs_pk
  ON stats_tierlist_vs (patch, position, enemy_position, champion_id, enemy_id, platform, rank_level);

-- Duo partners per segment (segment of the champion's player).
CREATE MATERIALIZED VIEW stats_tierlist_with AS
SELECT a.patch, a.platform, a.rank_level, a.position, a.champion_id,
       b.position AS ally_position, b.champion_id AS ally_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_tierlist_participants a
JOIN stats_tierlist_participants b
  ON b.match_id = a.match_id AND b.team_id = a.team_id AND b.participant_id <> a.participant_id
WHERE (a.position, b.position) IN (
  ('TOP', 'JUNGLE'), ('JUNGLE', 'TOP'), ('JUNGLE', 'MIDDLE'), ('MIDDLE', 'JUNGLE'),
  ('BOTTOM', 'UTILITY'), ('UTILITY', 'BOTTOM'))
GROUP BY a.patch, a.platform, a.rank_level, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_tierlist_with_pk
  ON stats_tierlist_with (patch, position, ally_position, champion_id, ally_id, platform, rank_level);

-- Ban rates per segment, weighted per participant: ban rate = participants whose match had the
-- champion banned / participants. With every participant counted (server filter only) that is
-- exactly banned matches / matches, as in stats_champion_bans / stats_patch_matches.
CREATE MATERIALIZED VIEW stats_tierlist_bans AS
SELECT tp.patch, tp.platform, tp.rank_level, b.champion_id, count(*)::int AS participants
FROM (SELECT DISTINCT match_id, champion_id FROM match_bans WHERE champion_id > 0) b
JOIN stats_tierlist_participants tp ON tp.match_id = b.match_id
GROUP BY tp.patch, tp.platform, tp.rank_level, b.champion_id;
CREATE UNIQUE INDEX stats_tierlist_bans_pk
  ON stats_tierlist_bans (patch, champion_id, platform, rank_level);

-- Participants per segment (denominator of the ban rates above).
CREATE MATERIALIZED VIEW stats_tierlist_totals AS
SELECT patch, platform, rank_level, count(*)::int AS participants
FROM stats_tierlist_participants
GROUP BY patch, platform, rank_level;
CREATE UNIQUE INDEX stats_tierlist_totals_pk ON stats_tierlist_totals (patch, platform, rank_level);
