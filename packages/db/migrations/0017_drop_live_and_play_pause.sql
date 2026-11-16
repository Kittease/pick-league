-- The stack moved from the player's own machine to a shared server: live game lookups (0013,
-- 0014) and the play pause of the stats refresh (0014) are gone, with their tables. Their indexes
-- go with them.

DROP TABLE IF EXISTS live_player_masteries;
DROP TABLE IF EXISTS live_player_profiles;
DROP TABLE IF EXISTS live_games;
DROP TABLE IF EXISTS client_activity;
DROP TYPE IF EXISTS live_lookup_status;
