-- 1. Live games: the League client's player ids are not the Riot API's (the API answers 400 to
--    them), so the desktop no longer sends any. It sends the user's own Riot ID and game id; the
--    worker finds the user's account (account-v1 by Riot ID), then the game (spectator-v5), whose
--    participants carry the API puuids the player lookups (0013) need.
-- 2. Client activity: the desktop says when the user is queued, in champion select or in game.
--    Meanwhile the worker stops collecting (live lookups only, the full rate limit for them) and
--    the API does not refresh its stats (the refresh is heavy and made the game stutter).

CREATE TABLE live_games (
  platform     platform           NOT NULL,
  game_id      bigint             NOT NULL,
  -- The user's own Riot ID (to find the game); never another player's.
  game_name    text               NOT NULL,
  tag_line     text               NOT NULL,
  status       live_lookup_status NOT NULL DEFAULT 'PENDING',
  -- Once READY: [{teamId, championId, puuid}] from spectator-v5 (puuid null when Riot hides the
  -- player), and the user's team (100/200).
  participants jsonb,
  my_team_id   smallint,
  attempts     smallint           NOT NULL DEFAULT 0,  -- failed attempts of the current request
  last_error   text,                                   -- 'not_found: …' when Riot has no such game
  requested_at timestamptz        NOT NULL DEFAULT now(),
  updated_at   timestamptz        NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, game_id)
);
CREATE INDEX live_games_pending_idx ON live_games (platform, requested_at) WHERE status = 'PENDING';
CREATE INDEX live_games_requested_at_idx ON live_games (requested_at);

-- One row per client ('desktop'). Busy while busy_until is in the future: the desktop renews it
-- every few seconds while the user plays, so a closed or crashed app releases it by itself.
CREATE TABLE client_activity (
  client     text        PRIMARY KEY,
  phase      text        NOT NULL,
  busy_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
