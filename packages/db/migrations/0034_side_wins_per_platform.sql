-- Results per side per platform: the side edge of the draft evaluation is now per patch (the
-- previous patch as a capped prior) and per platform when the request names one. Blue won 48.6 %
-- of the 16.22 matches and 49.5 % of the 16.23 ones, and the platforms differ (16.22 / 16.23:
-- EUW1 46.9 / 48.3, KR 49.0 / 49.8, NA1 48.8 / 49.2, VN2 50.1 / 50.8).
--
-- A materialized view's query cannot be altered: stats_side_wins is rebuilt with a platform
-- column (two rows per patch and platform). An API of the previous version reads
-- `patch, team_id, games, wins` and sums the rows of a side on a patch: it keeps getting the same
-- all-platform numbers until it is restarted on this version.
DROP MATERIALIZED VIEW stats_side_wins;
CREATE MATERIALIZED VIEW stats_side_wins AS
SELECT m.patch, m.platform, t.team_id,
       count(*)::int AS games, count(*) FILTER (WHERE t.win)::int AS wins
FROM match_teams t
JOIN matches m ON m.id = t.match_id
WHERE NOT m.is_remake
GROUP BY m.patch, m.platform, t.team_id;
CREATE UNIQUE INDEX stats_side_wins_pk ON stats_side_wins (patch, platform, team_id);
