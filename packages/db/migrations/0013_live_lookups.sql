-- Live game lookups: the desktop asks (through the API) for the rank, recent ranked solo matches
-- and champion mastery of the 10 players of the game it is in; the worker fetches them from Riot
-- at the highest priority. Only these per-player summaries are kept: looked-up matches never go
-- into `matches` / `participants` (the stats stay high-elo ladder data).

CREATE TYPE live_lookup_status AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE live_player_profiles (
  puuid             text PRIMARY KEY,
  platform          platform           NOT NULL,
  status            live_lookup_status NOT NULL DEFAULT 'PENDING',
  -- Bumped by the API each time it asks for a (re)fetch; a part is up to date when its *_seq
  -- equals it (counters, not timestamps: the API and worker clocks may differ).
  request_seq       integer            NOT NULL DEFAULT 1,
  requested_at      timestamptz        NOT NULL DEFAULT now(),
  -- Solo queue rank (league-v4 entries by puuid); all NULL = unranked once rank_seq is set.
  rank_seq          integer,
  rank_fetched_at   timestamptz,
  solo_tier         solo_tier,
  solo_division     smallint,          -- 1..4, NULL for Master+
  solo_lp           integer,
  solo_wins         integer,
  solo_losses       integer,
  -- Most recent ranked solo matches, newest first:
  -- [{matchId, championId, position, win, remake, endedAt}] (position NULL when Riot had none).
  recent_seq        integer,
  recent_fetched_at timestamptz,
  recent            jsonb,
  attempts          smallint           NOT NULL DEFAULT 0,  -- failed attempts of the current request
  last_error        text,
  updated_at        timestamptz        NOT NULL DEFAULT now()
);
CREATE INDEX live_player_profiles_pending_idx
  ON live_player_profiles (platform, requested_at, puuid) WHERE status = 'PENDING';
CREATE INDEX live_player_profiles_requested_at_idx ON live_player_profiles (requested_at);

-- Mastery of the champion each player has in the looked-up game (one row per champion asked for).
CREATE TABLE live_player_masteries (
  puuid       text     NOT NULL REFERENCES live_player_profiles ON DELETE CASCADE,
  champion_id integer  NOT NULL,
  level       smallint,                 -- 0 / 0 when the player never played it
  points      integer,
  fetched_at  timestamptz,              -- NULL = asked for, not fetched yet
  PRIMARY KEY (puuid, champion_id)
);
