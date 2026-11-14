# PickLeague — Database schema

PostgreSQL 17, single database, run by Docker Compose next to the worker and the API.

## Principles

- **Store match facts, not aggregates.** Every table below holds what happened in a game (participants, every item event, every skill level-up, kills, objectives, per-minute stats). Recommendations are computed from these tables; materialized views can be added later for speed without changing the source data.
- **No raw payloads.** Match and timeline JSON are parsed and thrown away. Fields that don't serve picks, builds or plausible later analysis are dropped (e.g. the ~130 `challenges` fields, ward events — Riot gives them no map position).
- **Two patches only.** `patches` lists the patches we keep. When a new patch is detected, every match of the patch before the previous one is deleted (`ON DELETE CASCADE` cleans every child table). Postgres reuses the freed space for the new patch, so disk usage stays flat at ~2 patches.
- **Static data is per patch.** Champions, items, runes and summoner spells come from Data Dragon and are stored per patch, so an old match is always read with the item/rune data that existed when it was played.
- **All 10 players are identified.** Every `puuid` met in a match gets a `players` row. Riot IDs come for free in the match payload. Extra info (mastery, solo queue rank) is fetched with a priority scheme so it never slows match collection:
  0. live game lookups requested by the desktop (see "Live game lookups", kept apart from these tables) → 1. ladder refresh (Challenger, Grandmaster and the top Master players, more of them each time the queues empty) → 2. match ids of players who played → 3. matches + timelines → 4. daily refresh of tracked ladder players (account + mastery) → 5. **lowest priority:** mastery + rank of non-ladder players, only with leftover budget. Fetched once, refreshed only if the player shows up again and the data is older than 7 days.
- Riot timestamps are converted to `timestamptz`; in-game times are kept as milliseconds since game start (`int`).

## Overview

```
patches ─┬─< champions / champion_spells / items / rune_trees / runes / summoner_spells   (Data Dragon, per patch)
         └─< matches ─┬─< match_teams
                      ├─< match_bans
                      ├─< participants ─┬─< item_events
                      │                 └─< skill_events
                      ├─< kill_events
                      └─< objective_events

players ─┬── ladder_entries          (tracked set: current Challenger/GM/top Master state, used to detect who played)
         ├─< champion_masteries      (daily for tracked players, low priority for the others)
         └─< participants            (every player of every match)

player_enrichment_queue               (low-priority mastery/rank fetches for non-ladder players)

live_player_profiles ─< live_player_masteries   (players of the user's live game, looked up on request)

match_fetch_queue                     (worker backlog, survives restarts)
worker_runs                           (monitoring)
worker_status                         (health of each platform loop)
```

## Enums

```sql
CREATE TYPE platform AS ENUM ('KR', 'EUW1', 'NA1', 'VN2');
-- match-v5 routing cluster is derived in code: KR→asia, EUW1→europe, NA1→americas, VN2→sea

CREATE TYPE ladder_tier AS ENUM ('CHALLENGER', 'GRANDMASTER', 'MASTER');  -- MASTER: the top N by LP, N growing as the worker catches up

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
```

## Patches & Data Dragon

```sql
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
```

## Players

```sql
-- Every player met in a kept match, plus every tracked ladder player.
CREATE TABLE players (
  puuid                 text PRIMARY KEY,
  platform              platform NOT NULL,
  game_name             text,                -- Riot ID: from the match payload, or account-v1 (daily) for tracked players
  tag_line              text,
  name_updated_at       timestamptz,
  -- solo queue rank: ladder players get it from ladder_entries;
  -- others from league-v4 entries/by-puuid (low priority).
  -- Also the tier list rank filter (current tier, read when the stats views are refreshed).
  solo_tier             solo_tier,
  solo_division         smallint,            -- 1..4, NULL for Master+
  solo_lp               integer,
  solo_wins             integer,
  solo_losses           integer,
  rank_refreshed_at     timestamptz,
  masteries_refreshed_at timestamptz,
  matches_synced_until  timestamptz,         -- tracked players only: newest match already listed → `startTime` for match ids
  listing_requested_at  timestamptz,         -- tracked players only: "played" (ladder wins+losses changed), match ids not listed yet (0009)
  last_seen_in_match_at timestamptz,         -- used by cleanup and by the low-priority refresh rule
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- Cleanup: players that are neither tracked nor present in a kept match are deleted after an old
-- patch is deleted (in small batches, skipping rows a match insert is writing).
-- listing_requested_at survives worker restarts; it is cleared when a listing that started after
-- it finishes (a newer request that arrives during the listing is kept).
CREATE INDEX players_listing_requested_idx ON players (listing_requested_at)
  WHERE listing_requested_at IS NOT NULL;

-- Current Challenger/GM/top Master state. One league-v4 call per tier per platform refreshes it;
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
  champion_id    integer  NOT NULL,          -- not smallint: the API also returns ids like 60018
  level          smallint NOT NULL,
  points         integer  NOT NULL,
  last_played_at timestamptz NOT NULL,
  PRIMARY KEY (puuid, champion_id)
);
```

## Matches

```sql
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
  final_items     integer[]  NOT NULL,       -- 7: item0..item6 (6 = trinket), 0 = empty; the only record of the support quest upgrade (see stats_quest_items)

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

```

## Worker state

```sql
-- Match ids discovered but not fetched yet. Lets the worker stop/restart (or the PC sleep)
-- without losing work, and never fetches the same match twice across the 10 players in it.
CREATE TABLE match_fetch_queue (
  match_id      text PRIMARY KEY,
  platform      platform     NOT NULL,
  status        fetch_status NOT NULL DEFAULT 'PENDING',
  attempts      smallint     NOT NULL DEFAULT 0,  -- deterministic errors (404, parse, other 4xx: FAILED at 2) and unknown ones (FAILED at 5)
  transient_errors smallint  NOT NULL DEFAULT 0,  -- Riot 429/5xx, network, DB connection: deferred without an attempt, FAILED at 10 (0009)
  last_error    text,
  fetch_rank    integer      NOT NULL DEFAULT 1000000,  -- best ladder position among the players who listed it (0 = first Challenger); 1000000 = back of the queue (retried/deferred) (0011)
  discovered_at timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX match_fetch_queue_pending_idx
  ON match_fetch_queue (platform, fetch_rank, discovered_at, match_id) WHERE status = 'PENDING';
-- Claimed lowest fetch_rank first, so better-placed players' matches are fetched first.
-- DONE / SKIPPED_OLD_PATCH rows are kept as a "seen" set and purged with their patch.
-- Once a match turns out to be from an older patch, every PENDING row of that platform with a
-- lower or equal game id is marked SKIPPED_OLD_PATCH in one statement.

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

-- One row per platform loop, upserted by the worker (0009). Read by the API / desktop to show
-- whether collection is alive and whether the Riot key is rejected.
CREATE TABLE worker_status (
  platform            platform    PRIMARY KEY,
  heartbeat_at        timestamptz NOT NULL,  -- updated at least once a minute while that platform's loop runs
  auth_rejected_since timestamptz,           -- set when Riot rejects the key (401/403); cleared on the next successful Riot response
  last_error          text,                  -- last non-abort error (kind: message), truncated to 500 chars
  last_error_at       timestamptz
);
```

## Live game lookups

Players of the user's game in progress, looked up on request (`POST /live/players`, see
architecture) — never during champion select. The API writes the requests, the worker fetches
them from Riot at the highest priority (`0013_live_lookups.sql`). Only per-player summaries are
kept: looked-up matches never go into `matches` / `participants` / `players`, so the stats stay
high-elo ladder data. Rows are deleted a day after their last request.

```sql
CREATE TYPE live_lookup_status AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE live_player_profiles (
  puuid             text PRIMARY KEY,
  platform          platform           NOT NULL,
  status            live_lookup_status NOT NULL DEFAULT 'PENDING',
  request_seq       integer            NOT NULL DEFAULT 1,  -- bumped by each (re)request
  requested_at      timestamptz        NOT NULL DEFAULT now(),
  rank_seq          integer,          -- request_seq the rank was fetched for (NULL = never)
  rank_fetched_at   timestamptz,
  solo_tier         solo_tier,        -- all NULL = unranked (once rank_seq is set)
  solo_division     smallint,         -- 1..4, NULL for Master+
  solo_lp           integer,
  solo_wins         integer,
  solo_losses       integer,
  recent_seq        integer,          -- request_seq the recent matches were fetched for
  recent_fetched_at timestamptz,
  recent            jsonb,            -- newest first: [{matchId, championId, position, win, remake, endedAt}]
  attempts          smallint           NOT NULL DEFAULT 0,  -- failed attempts of the current request
  last_error        text,
  updated_at        timestamptz        NOT NULL DEFAULT now()
);
CREATE INDEX live_player_profiles_pending_idx
  ON live_player_profiles (platform, requested_at, puuid) WHERE status = 'PENDING';
CREATE INDEX live_player_profiles_requested_at_idx ON live_player_profiles (requested_at);

-- Mastery of the champion each player has in the looked-up game.
CREATE TABLE live_player_masteries (
  puuid       text     NOT NULL REFERENCES live_player_profiles ON DELETE CASCADE,
  champion_id integer  NOT NULL,
  level       smallint,                -- 0 / 0 when never played
  points      integer,
  fetched_at  timestamptz,             -- NULL = asked for, not fetched yet
  PRIMARY KEY (puuid, champion_id)
);
```

- **Requests** (API, idempotent: the desktop repeats them while it polls): a player never seen, a
  READY profile whose rank or recent matches are older than 30 min, or a FAILED one older than
  5 min becomes PENDING with `request_seq + 1` (its mastery rows are asked for again); a PENDING
  one is left alone. A fresh READY profile asked about another champion goes back to PENDING for
  that mastery only.
- **Parts** are up to date when their `*_seq` equals `request_seq` (counters, so the API and worker
  clocks never need to agree). The worker fetches only what is missing, stores each part as soon
  as it has it (rank first) and marks the row READY once nothing is missing. Previous data stays
  readable while a stale profile is fetched again.
- **Failures**: `attempts` counts failed attempts of the current request; FAILED after a few.

## Stats views (owned by apps/api)

Materialized views computed from the tables above, refreshed by the API in the order of
`STATS_REFRESH_ORDER` (`apps/api/src/stats/refresh.ts`): served views have a unique index and are
refreshed `CONCURRENTLY`, intermediate ones plainly. All are keyed by patch and exclude remakes.
Definitions: `packages/db/migrations/0002_stats_views.sql` (traits, compositions, champion+role
baselines, pairwise vs/with, build choices), `0003_stats_bans.sql` (tier list ban rates),
`0006_tierlist_filters.sql` (tier list server/rank filters), `0007_support_quest_items.sql`,
`0008_deterministic_comp_traits.sql`, `0010_lane_phase.sql` and `0012_choice_ally_contexts.sql`
(all five below).

`stats_participant_choices` lists every build/rune/spell/skill choice of a participant as `(kind, choice, pos)`; `stats_choices`, `stats_choice_matchups` and `stats_choice_traits` aggregate it per champion + role, vs a lane opponent and vs an enemy composition trait; `stats_choice_duos` and `stats_choice_ally_traits` (items only) with a duo partner and with an ally composition trait.

**Ally contexts of items** (`0012_choice_ally_contexts.sql`). Situational items also answer the user's own team: completed-item choices (kind `item` only, read from `stats_participants.core`: the rows of `stats_participant_choices` with kind `item`) with a duo partner and when the ally composition has a trait. The champion's totals in those contexts come from `stats_champion_with` and `stats_champion_comp_traits` (side `ally`).

```sql
-- Served. Duo partners only (DUO_ROLES: UTILITY<->BOTTOM, MIDDLE<->JUNGLE, TOP<->JUNGLE).
stats_choice_duos (patch, champion_id, position, partner_position, partner_id,
                   kind, choice, games, wins)          -- kind = 'item', choice = item id
-- unique (patch, champion_id, position, partner_id, partner_position, kind, choice)  → build
-- Served. trait: one of stats_participants.ally_traits (the composition of the 4 teammates).
stats_choice_ally_traits (patch, champion_id, position, trait, kind, choice, games, wins)
-- unique (patch, champion_id, position, trait, kind, choice)                          → build
```

Size: one row per (champion, role, partner, item) and per (champion, role, trait, item). A participant has one duo partner (two for junglers: 1.2 on average, vs 1.4 lane opponents in `stats_choice_matchups`) and ~1.75 ally traits (7 traits, each set for about a quarter of the teams), times ~3 completed items. The duo view is smaller than the item rows of `stats_choice_matchups`; the trait one is bounded by champions × roles × 7 traits × items (a few hundred thousand rows). Kept to kind `item` to keep the refresh short: these are only read by situational items.

**Support quest upgrade** (`0007_support_quest_items.sql`, kind `quest_item`). The support item (World Atlas) is granted for free and upgrades itself through the quest: World Atlas → Runic Compass → Bounty of Worlds → the upgrade the player picks (Celestial Opposition, Dream Maker, Zaz'Zak's Realmspike, Solstice Sleigh, Bloodsong). The timeline only has `ITEM_DESTROYED` events for the first three; the picked upgrade almost never comes as `ITEM_PURCHASED`, and at 400 gold it is not a completed item. `stats_quest_items` (intermediate, one row per participant who had one) reads it from `final_items`, else from its last purchase event (sold before the end). Upgrades are recognised from Data Dragon, not by id: non-consumable, non-completed items tagged `GoldPer` that are built from an item and build into nothing.

**Deterministic composition traits** (`0008_deterministic_comp_traits.sql`). `stats_team_comp` sums the per-champion trait values of a team as `numeric` (exact, cast back to `float8`): float8 sums depended on the order rows reached the aggregate, so a team mean sitting on a `stats_comp_thresholds` percentile could switch traits between two refreshes of the same matches. The views built on it (`stats_comp_thresholds`, `stats_participants` and everything derived from it) are recreated unchanged otherwise. Also adds `stats_champion_with_champion (patch, champion_id, position)`, like `stats_champion_vs_champion`, for one champion's allies (`GET /tierlist/champion`).

**Lane phase** (`0010_lane_phase.sql`). The first reader of the per-minute frames (`gold_by_minute`, `xp_by_minute`, `cs_by_minute`; index 1 = minute 0, so minute 10 = index 11 and minute 15 = index 16):

```sql
-- Served. Lane opponents only: same position, and both enemy bot laners for BOTTOM / UTILITY.
stats_champion_lane_phase (patch, position, champion_id, enemy_position, enemy_id,
                           games,                                   -- matchups with frames at 10 min
                           gold_diff_10, xp_diff_10, cs_diff_10,    -- float8 averages, own − enemy
                           games_15,                                -- matchups with frames at 15 min
                           gold_diff_15, xp_diff_15, cs_diff_15)    -- NULL when games_15 = 0
-- unique (patch, position, enemy_id, enemy_position, champion_id)  → picks (candidates vs an enemy)
-- index  (patch, champion_id, position)                            → build, GET /tierlist/champion
```

TOP / JUNGLE / MIDDLE compare the two players (1v1). BOTTOM / UTILITY compare the bot lanes as a 2v2 (own + duo partner − enemy BOTTOM − enemy UTILITY): support gold alone says little about how the lane went; the rows vs the enemy ADC and vs the enemy support hold the same difference, each conditioned on that opponent. Remakes and participants without a position are excluded like everywhere; a lane counts only when both sides are complete (1 player, or 2 in the bot lane) and every player in it has the frame of that minute (shorter matches have shorter arrays), hence the separate `games_15`. Averages are exact `numeric` means cast to `float8`; patches are combined as `sum(avg × games) / sum(games)`. Computed in one pass over `participants` (each (match, lane) group holds both teams, then every own × enemy player pair of the lane gets the difference), so it refreshes in about the time of `stats_champion_roles`. Unfiltered only: the tier list server/rank filters do not apply to it.

**Tier list filters** (`0006_tierlist_filters.sql`):

```sql
-- rank_level = 2 CHALLENGER, 1 GRANDMASTER, 0 anything else (MASTER, below Master, unknown),
-- from players.solo_tier at refresh time. Filter "Grandmaster+" = rank_level >= 1,
-- "Challenger only" = 2; "Master+" (default) and "all servers" read the unfiltered views.

-- Intermediate: one row per participant of a non-remake match (position may be NULL).
stats_tierlist_participants (patch, platform, rank_level, match_id, participant_id,
                             team_id, champion_id, position, win)           -- unique (match_id, participant_id)

-- Served, summed over the requested (platform, rank_level) segments at request time.
stats_tierlist_roles  (patch, platform, rank_level, position, champion_id, games, wins)
stats_tierlist_vs     (patch, platform, rank_level, position, champion_id,
                       enemy_position, enemy_id, games, wins)   -- lane opponents only (LANE_ROLES)
stats_tierlist_with   (patch, platform, rank_level, position, champion_id,
                       ally_position, ally_id, games, wins)     -- duo partners only (DUO_ROLES)
stats_tierlist_bans   (patch, platform, rank_level, champion_id,
                       participants)  -- counted participants whose match banned the champion
stats_tierlist_totals (patch, platform, rank_level, participants)  -- ban rate denominator
```

The segment of a vs/with row is the one of the champion's own player. Ban rates under filters are
weighted per counted participant (a match counts once per counted player in it), which is exactly
banned matches / matches when every participant of a server is counted.

## Not in the database

- **Your owned champions, your mastery, the live champion select, helper settings** (auto-apply toggle, API address): read from the League client by the desktop helper and kept on your machine.
- **Recommendation results**: computed by the API from the tables above at request time (with in-memory caching, since data changes at most hourly).

## Size estimate

Per match, roughly: participants ~5 KB, item events (~45 per player → ~450 rows) ~30 KB, skill events (~180 rows) ~12 KB, kills + objectives ~5 KB, indexes included → **~50 KB/match**.
~150k matches/patch × 2 patches → **~15 GB** steady state, plus a few hundred MB for players and masteries.

Low-priority enrichment volume: roughly 6–8 non-ladder players per match → tens of thousands of new players per region per patch, 2 requests each (mastery + rank). At leftover budget this takes a few days to catch up after the first run, then keeps pace.
