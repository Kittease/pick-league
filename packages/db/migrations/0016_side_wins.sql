-- Results per side (team 100 = blue, 200 = red) per patch, remakes excluded: the side edge of the
-- draft evaluation (POST /recommendations/draft). Blue won 48.5 % of the 16.22 matches. Two rows
-- per patch, refreshed CONCURRENTLY with the other stats views (STATS_REFRESH_ORDER).
CREATE MATERIALIZED VIEW stats_side_wins AS
SELECT m.patch, t.team_id, count(*)::int AS games, count(*) FILTER (WHERE t.win)::int AS wins
FROM match_teams t
JOIN matches m ON m.id = t.match_id
WHERE NOT m.is_remake
GROUP BY m.patch, t.team_id;
CREATE UNIQUE INDEX stats_side_wins_pk ON stats_side_wins (patch, team_id);
