-- PickLeague initial schema. Source of truth: docs/database-schema.md (approved).
-- Applied by the runner in packages/db/src/migrate.ts (recorded in schema_migrations).

CREATE TYPE platform AS ENUM ('KR', 'EUW1', 'NA1', 'VN2');
-- match-v5 routing cluster is derived in code: KR→asia, EUW1→europe, NA1→americas, VN2→sea

CREATE TYPE ladder_tier AS ENUM ('CHALLENGER', 'GRANDMASTER');

CREATE TYPE position AS ENUM ('TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY');

CREATE TYPE item_event_type AS ENUM ('PURCHASED', 'SOLD', 'DESTROYED', 'UNDO');

CREATE TYPE objective_type AS ENUM (
  'DRAGON', 'ELDER_DRAGON', 'BARON', 'RIFT_HERALD', 'VOIDGRUB', 'ATAKHAN',
  'TOWER', 'TURRET_PLATE', 'INHIBITOR'
);

CREATE TYPE fetch_status AS ENUM ('PENDING', 'DONE', 'SKIPPED_OLD_PATCH', 'FAILED');

CREATE TYPE solo_tier AS ENUM (
  'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND',
  'MASTER', 'GRANDMASTER', 'CHALLENGER'
);

CREATE TABLE patches (
  id              text PRIMARY KEY,          -- '15.22'  (major.minor, matches gameVersion prefix)
  ddragon_version text NOT NULL UNIQUE,      -- '15.22.1'
  detected_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE champions (
  patch       text     NOT NULL REFERENCES patches ON DELETE CASCADE,
  id          smallint NOT NULL,             -- numeric key, e.g. 266
  slug        text     NOT NULL,             -- 'Aatrox', 'MonkeyKing' (image file names)
  name        text     NOT NULL,             -- 'Aatrox', 'Wukong'
  tags        text[]   NOT NULL,             -- {'Fighter','Tank'}
  attack_range smallint NOT NULL,            -- melee/ranged signal for comp traits
  info        jsonb    NOT NULL,             -- {attack, defense, magic, difficulty}
  PRIMARY KEY (patch, id)
);

CREATE TABLE champion_spells (              -- needed to display skill orders (names + icons)
  patch       text     NOT NULL,
  champion_id smallint NOT NULL,
  slot        smallint NOT NULL,             -- 1=Q 2=W 3=E 4=R
  name        text     NOT NULL,
  image       text     NOT NULL,
  PRIMARY KEY (patch, champion_id, slot),
  FOREIGN KEY (patch, champion_id) REFERENCES champions ON DELETE CASCADE
);

CREATE TABLE items (
  patch        text    NOT NULL REFERENCES patches ON DELETE CASCADE,
  id           integer NOT NULL,
  name         text    NOT NULL,
  gold_total   integer NOT NULL,
  tags         text[]  NOT NULL,             -- {'Armor','GrievousWounds',...} used for build adaptation
  builds_from  integer[] NOT NULL DEFAULT '{}',
  builds_into  integer[] NOT NULL DEFAULT '{}',
  is_boots     boolean NOT NULL,
  is_completed boolean NOT NULL,             -- legendary / final item
  is_consumable boolean NOT NULL,
  stats        jsonb   NOT NULL,             -- Data Dragon stats object
  PRIMARY KEY (patch, id)
);

CREATE TABLE rune_trees (
  patch text     NOT NULL REFERENCES patches ON DELETE CASCADE,
  id    smallint NOT NULL,                   -- 8000 Precision, 8100 Domination, ...
  name  text     NOT NULL,
  icon  text     NOT NULL,
  PRIMARY KEY (patch, id)
);

CREATE TABLE runes (
  patch   text     NOT NULL,
  id      smallint NOT NULL,                 -- 8005 Press the Attack, ...
  tree_id smallint NOT NULL,
  row     smallint NOT NULL,                 -- 0 = keystone row
  name    text     NOT NULL,
  icon    text     NOT NULL,
  PRIMARY KEY (patch, id),
  FOREIGN KEY (patch, tree_id) REFERENCES rune_trees ON DELETE CASCADE
);

CREATE TABLE summoner_spells (
  patch text     NOT NULL REFERENCES patches ON DELETE CASCADE,
  id    smallint NOT NULL,                   -- 4 = Flash
  name  text     NOT NULL,
  image text     NOT NULL,
  PRIMARY KEY (patch, id)
);
-- Stat shards (5001, 5005, 5008, ...) are not in Data Dragon's runesReforged.json;
-- they are a small constant list in shared code.

-- Every player met in a kept match, plus every tracked ladder player.
CREATE TABLE players (
  puuid                 text PRIMARY KEY,
  platform              platform NOT NULL,
  game_name             text,                -- Riot ID: from the match payload, or account-v1 (daily) for tracked players
  tag_line              text,
  name_updated_at       timestamptz,
  -- solo queue rank: ladder players get it from ladder_entries;
  -- others from league-v4 entries/by-puuid (low priority)
  solo_tier             solo_tier,
  solo_division         smallint,            -- 1..4, NULL for Master+
  solo_lp               integer,
  solo_wins             integer,
  solo_losses           integer,
  rank_refreshed_at     timestamptz,
  masteries_refreshed_at timestamptz,
  matches_synced_until  timestamptz,         -- tracked players only: newest match already listed → `startTime` for match ids
  last_seen_in_match_at timestamptz,         -- used by cleanup and by the low-priority refresh rule
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- Cleanup: players that are neither tracked nor present in a kept match are deleted with the old patch.

-- Current Challenger/GM state. One league-v4 call per tier per platform refreshes it;
-- a change in wins+losses since the previous run means the player played → fetch their match ids.
CREATE TABLE ladder_entries (
  puuid         text PRIMARY KEY REFERENCES players ON DELETE CASCADE,
  platform      platform    NOT NULL,
  tier          ladder_tier NOT NULL,
  league_points integer     NOT NULL,
  wins          integer     NOT NULL,
  losses        integer     NOT NULL,
  updated_at    timestamptz NOT NULL
);
-- Players who drop off the ladder lose their ladder_entries row (no longer tracked);
-- their players row and the matches they appear in are kept.

CREATE TABLE champion_masteries (
  puuid          text     NOT NULL REFERENCES players ON DELETE CASCADE,
  champion_id    smallint NOT NULL,
  level          smallint NOT NULL,
  points         integer  NOT NULL,
  last_played_at timestamptz NOT NULL,
  PRIMARY KEY (puuid, champion_id)
);

CREATE TABLE matches (
  id               text PRIMARY KEY,         -- Riot match id, 'EUW1_7234567890'
  platform         platform    NOT NULL,
  patch            text        NOT NULL REFERENCES patches ON DELETE CASCADE,
  game_version     text        NOT NULL,     -- full '15.22.715.1234'
  queue_id         smallint    NOT NULL,     -- 420 = ranked solo/duo
  started_at       timestamptz NOT NULL,
  duration_s       integer     NOT NULL,
  is_remake        boolean     NOT NULL,     -- excluded from stats
  is_early_surrender boolean   NOT NULL,
  winning_team     smallint    NOT NULL,     -- 100 | 200
  fetched_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON matches (patch, platform);

CREATE TABLE match_teams (
  match_id         text     NOT NULL REFERENCES matches ON DELETE CASCADE,
  team_id          smallint NOT NULL,        -- 100 blue | 200 red
  win              boolean  NOT NULL,
  first_blood      boolean  NOT NULL,
  first_tower      boolean  NOT NULL,
  first_dragon     boolean  NOT NULL,
  first_baron      boolean  NOT NULL,
  champion_kills   smallint NOT NULL,
  tower_kills      smallint NOT NULL,
  inhibitor_kills  smallint NOT NULL,
  dragon_kills     smallint NOT NULL,
  baron_kills      smallint NOT NULL,
  herald_kills     smallint NOT NULL,
  voidgrub_kills   smallint NOT NULL,
  atakhan_kills    smallint NOT NULL,
  PRIMARY KEY (match_id, team_id)
);

CREATE TABLE match_bans (
  match_id    text     NOT NULL REFERENCES matches ON DELETE CASCADE,
  team_id     smallint NOT NULL,
  pick_turn   smallint NOT NULL,             -- 1..10
  champion_id smallint NOT NULL,             -- -1 = no ban
  PRIMARY KEY (match_id, pick_turn)
);

CREATE TABLE participants (
  match_id        text     NOT NULL REFERENCES matches ON DELETE CASCADE,
  participant_id  smallint NOT NULL,         -- 1..10, same ids as timeline events
  puuid           text     NOT NULL REFERENCES players,  -- players row created at match ingest
  team_id         smallint NOT NULL,
  champion_id     smallint NOT NULL,
  position        "position",                -- teamPosition; NULL if Riot couldn't infer it. Type name quoted: POSITION is a keyword that cannot be used unquoted as a type
  win             boolean  NOT NULL,

  -- loadout
  summoner_spell_1 smallint NOT NULL,        -- D key
  summoner_spell_2 smallint NOT NULL,        -- F key
  rune_primary_tree   smallint NOT NULL,
  rune_secondary_tree smallint NOT NULL,
  runes           smallint[] NOT NULL,       -- 6: keystone, 3 primary, 2 secondary (in order)
  stat_shards     smallint[] NOT NULL,       -- 3: offense, flex, defense
  final_items     integer[]  NOT NULL,       -- 7: item0..item6 (6 = trinket), 0 = empty

  -- end-of-game stats
  champ_level     smallint NOT NULL,
  kills           smallint NOT NULL,
  deaths          smallint NOT NULL,
  assists         smallint NOT NULL,
  lane_minions    smallint NOT NULL,
  jungle_minions  smallint NOT NULL,
  gold_earned     integer  NOT NULL,
  gold_spent      integer  NOT NULL,
  damage_to_champions          integer NOT NULL,
  physical_damage_to_champions integer NOT NULL,
  magic_damage_to_champions    integer NOT NULL,
  true_damage_to_champions     integer NOT NULL,
  damage_taken            integer NOT NULL,
  damage_self_mitigated   integer NOT NULL,
  damage_to_buildings     integer NOT NULL,
  damage_to_objectives    integer NOT NULL,
  healing_done            integer NOT NULL,
  heals_on_teammates      integer NOT NULL,
  shields_on_teammates    integer NOT NULL,
  cc_time_on_others_s     integer NOT NULL,    -- timeCCingOthers
  vision_score            smallint NOT NULL,
  wards_placed            smallint NOT NULL,
  wards_killed            smallint NOT NULL,
  control_wards_bought    smallint NOT NULL,

  -- timeline frames, one value per minute (index 1 = minute 0)
  gold_by_minute     integer[]  NOT NULL,      -- totalGold
  xp_by_minute       integer[]  NOT NULL,
  cs_by_minute       smallint[] NOT NULL,      -- lane + jungle minions
  level_by_minute    smallint[] NOT NULL,
  damage_to_champions_by_minute integer[] NOT NULL,
  position_x_by_minute smallint[] NOT NULL,
  position_y_by_minute smallint[] NOT NULL,

  PRIMARY KEY (match_id, participant_id)
);
CREATE INDEX ON participants (champion_id, position);
CREATE INDEX ON participants (puuid);

-- Every item event from the timeline, in order.
-- The build order shown in the helper is derived by replaying PURCHASED / UNDO
-- and ignoring consumables, trinkets and components later DESTROYED into a completed item.
CREATE TABLE item_events (
  match_id       text     NOT NULL,
  participant_id smallint NOT NULL,
  seq            smallint NOT NULL,          -- order within the participant's events
  at_ms          integer  NOT NULL,
  type           item_event_type NOT NULL,
  item_id        integer  NOT NULL,          -- for UNDO: the item that was undone (beforeId)
  undo_after_item_id integer,                -- UNDO only: afterId
  undo_gold_gain integer,                    -- UNDO only
  PRIMARY KEY (match_id, participant_id, seq),
  FOREIGN KEY (match_id, participant_id) REFERENCES participants ON DELETE CASCADE
);
CREATE INDEX ON item_events (item_id) WHERE type = 'PURCHASED';

CREATE TABLE skill_events (
  match_id       text     NOT NULL,
  participant_id smallint NOT NULL,
  seq            smallint NOT NULL,          -- 1 = first skill point
  at_ms          integer  NOT NULL,
  skill_slot     smallint NOT NULL,          -- 1=Q 2=W 3=E 4=R
  is_evolve      boolean  NOT NULL,          -- Kha'Zix / Kai'Sa / Viktor evolutions
  PRIMARY KEY (match_id, participant_id, seq),
  FOREIGN KEY (match_id, participant_id) REFERENCES participants ON DELETE CASCADE
);

CREATE TABLE kill_events (
  match_id       text     NOT NULL REFERENCES matches ON DELETE CASCADE,
  seq            smallint NOT NULL,
  at_ms          integer  NOT NULL,
  killer_participant_id smallint NOT NULL,   -- 0 = executed (tower/minion/monster)
  victim_participant_id smallint NOT NULL,
  assist_participant_ids smallint[] NOT NULL DEFAULT '{}',
  position_x     smallint NOT NULL,
  position_y     smallint NOT NULL,
  bounty         smallint NOT NULL,
  shutdown_bounty smallint NOT NULL,
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE objective_events (
  match_id       text     NOT NULL REFERENCES matches ON DELETE CASCADE,
  seq            smallint NOT NULL,
  at_ms          integer  NOT NULL,
  type           objective_type NOT NULL,
  subtype        text,                       -- dragon: 'FIRE_DRAGON'...; tower: 'OUTER_TURRET'...
  lane           text,                       -- towers/plates/inhibitors: 'TOP_LANE'...
  team_id        smallint NOT NULL,          -- team that took it
  killer_participant_id smallint,            -- NULL/0 when minions took it
  PRIMARY KEY (match_id, seq)
);

-- Match ids discovered but not fetched yet. Lets the worker stop/restart (or the PC sleep)
-- without losing work, and never fetches the same match twice across the 10 players in it.
CREATE TABLE match_fetch_queue (
  match_id      text PRIMARY KEY,
  platform      platform     NOT NULL,
  status        fetch_status NOT NULL DEFAULT 'PENDING',
  attempts      smallint     NOT NULL DEFAULT 0,
  last_error    text,
  discovered_at timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ON match_fetch_queue (platform, discovered_at) WHERE status = 'PENDING';
-- DONE / SKIPPED_OLD_PATCH rows are kept as a "seen" set and purged with their patch.

-- Lowest-priority work: mastery + rank for non-ladder players.
-- Only consumed when the higher-priority queues leave rate-limit budget unused.
CREATE TABLE player_enrichment_queue (
  puuid        text PRIMARY KEY REFERENCES players ON DELETE CASCADE,
  platform     platform    NOT NULL,
  attempts     smallint    NOT NULL DEFAULT 0,
  last_error   text,
  enqueued_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON player_enrichment_queue (platform, enqueued_at);

CREATE TABLE worker_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      platform    NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  requests_made integer     NOT NULL DEFAULT 0,
  players_polled integer    NOT NULL DEFAULT 0,
  matches_added integer     NOT NULL DEFAULT 0,
  error         text
);
