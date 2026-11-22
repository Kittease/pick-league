# PickLeague — Database schema

PostgreSQL 17, single database, run by Docker Compose next to the worker and the API.

## Principles

- **Store match facts, not aggregates.** Every table below holds what happened in a game (participants, every item event, every skill level-up, per-minute stats). Recommendations are computed from these tables; materialized views can be added later for speed without changing the source data.
- **No raw payloads.** Match and timeline JSON are parsed and thrown away. Fields that don't serve picks, builds or plausible later analysis are dropped (e.g. the ~130 `challenges` fields, ward events — Riot gives them no map position; kill and objective events, stored until `0020_drop_kill_and_objective_events.sql` and never read).
- **Two patches only.** `patches` lists the patches we keep. When a new patch is detected, every match of the patch before the previous one is deleted (`ON DELETE CASCADE` cleans every child table). Postgres reuses the freed space for the new patch, so disk usage stays flat at ~2 patches.
- **Static data is per patch.** Champions, items, runes and summoner spells come from Data Dragon and are stored per patch, so an old match is always read with the item/rune data that existed when it was played.
- **All 10 players are identified.** Every `puuid` met in a match gets a `players` row. Riot IDs come for free in the match payload. Extra info (mastery, solo queue rank) is fetched with a priority scheme so it never slows match collection:
  1. ladder refresh (Challenger, Grandmaster and the top Master players, more of them each time the queues empty) → 2. match ids of players who played → 3. matches + timelines → 4. daily refresh of tracked ladder players (mastery) → 5. **lowest priority:** mastery + rank of non-ladder players, only with leftover budget. Fetched once, refreshed only if the player shows up again and the data is older than 7 days.
- Riot timestamps are converted to `timestamptz`; in-game times are kept as milliseconds since game start (`int`).

## Overview

```
patches ─┬─< champions / champion_spells / items / rune_trees / runes / summoner_spells   (Data Dragon, per patch)
         └─< matches ─┬─< match_teams
                      ├─< match_bans
                      └─< participants ─┬─< item_events
                                        └─< skill_events

players ─┬── ladder_entries          (tracked set: current Challenger/GM/top Master state, plus tracked Diamond players; used to detect who played)
         ├─< champion_masteries      (daily for tracked players, low priority for the others)
         └─< participants            (every player of every match)

player_enrichment_queue               (low-priority mastery/rank fetches for non-ladder players)

match_fetch_queue                     (worker backlog, survives restarts)
listing_skip_misses                   (LISTING_SKIP=shadow: what a skipped listing would have missed)
worker_runs                           (monitoring)
worker_status                         (health of each platform loop)
```

## Enums

```sql
CREATE TYPE platform AS ENUM ('KR', 'EUW1', 'NA1', 'VN2');
-- match-v5 routing cluster is derived in code: KR→asia, EUW1→europe, NA1→americas, VN2→sea

CREATE TYPE ladder_tier AS ENUM ('CHALLENGER', 'GRANDMASTER', 'MASTER', 'DIAMOND');
-- In ladder order. MASTER: the top N by LP, N growing as the worker catches up.
-- DIAMOND (0023): only with DIAMOND_MAX_TRACKED, with ladder_entries.division.

CREATE TYPE position AS ENUM ('TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY');

CREATE TYPE item_event_type AS ENUM ('PURCHASED', 'SOLD', 'DESTROYED', 'UNDO');  -- 'DESTROYED' is no longer stored (0021)

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
  game_name             text,                -- Riot ID, from the match payload only (as of the player's last stored match)
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
  matches_synced_until  timestamptz,         -- listed players (tracked, or untracked Master+ ones): newest match already listed → `startTime` for match ids
  listing_requested_at  timestamptz,         -- tracked players only: "played" (ladder wins+losses changed), match ids not listed yet (0009)
  last_seen_in_match_at timestamptz,         -- used by cleanup and by the low-priority refresh rule
  last_seen_with_master_at timestamptz,      -- start of the newest stored match shared with a Master+ player (0024)
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- last_seen_with_master_at is set for all 10 participants when a match is stored and at least one
-- of them is known as Master, Grandmaster or Challenger at that moment (an apex row in
-- ladder_entries, or players.solo_tier); the greatest start is kept. Diamond players with one in
-- the last 7 days are tracked first (DIAMOND_MAX_TRACKED); a Diamond lobby found through a tracked
-- Diamond player sets nothing. 0024 backfilled it with last_seen_in_match_at (every match stored
-- until then was found through a Master+ player).
-- Cleanup: players that are neither tracked nor present in a kept match are deleted after an old
-- patch is deleted (in small batches, skipping rows a match insert is writing).
-- listing_requested_at survives worker restarts; it is cleared when a listing that started after
-- it finishes (a newer request that arrives during the listing is kept).
CREATE INDEX players_listing_requested_idx ON players (listing_requested_at)
  WHERE listing_requested_at IS NOT NULL;

-- Current Challenger/GM/top Master state. One league-v4 call per tier per platform refreshes it;
-- a change in wins+losses since the previous run means the player played → fetch their match ids.
-- With DIAMOND_MAX_TRACKED also the tracked Diamond players, refreshed by a sweep of the Diamond
-- division pages after each apex refresh (each row with the time of its own page).
CREATE TABLE ladder_entries (
  puuid         text PRIMARY KEY REFERENCES players ON DELETE CASCADE,
  platform      platform    NOT NULL,
  tier          ladder_tier NOT NULL,
  division      smallint,                -- 1..4 for DIAMOND, NULL for the apex tiers (0024)
  league_points integer     NOT NULL,
  wins          integer     NOT NULL,
  losses        integer     NOT NULL,
  updated_at    timestamptz NOT NULL,    -- last refresh that saw the player (DIAMOND: last complete sweep that did)
  games_changed_at timestamptz,          -- the refresh that produced the current wins + losses (NULL before 0024: read as updated_at)
  -- Baseline of the listing skip rule (LISTING_SKIP), set by the player's last real match-id
  -- listing and left alone by the ladder upserts (0024):
  listed_games       integer,            -- wins + losses the listing was decided on
  listed_snapshot_at timestamptz,        -- games_changed_at of those counters
  listed_at          timestamptz         -- when that listing ran
);
-- Players who drop off the ladder lose their ladder_entries row (no longer tracked), and with it
-- their baseline; their players row and the matches they appear in are kept.
-- Ladder order (listings, fetch_rank): tier, division NULLS FIRST, league_points DESC.
-- A tracked Diamond player a complete sweep did not see keeps their row untouched, and loses it
-- once updated_at is 24 h old; one who shows up on an apex list becomes an apex row.
-- Skip rule: with expected = wins + losses - listed_games, a player about to be listed is skipped
-- when expected > 0 and at least that many of their stored non-remake matches ended after
-- listed_snapshot_at and at least 15 minutes before games_changed_at (Riot's ladder counts a
-- finished game up to 10 minutes late); never when listed_at is 24 h old.

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

-- Purchases, sales and undos from the timeline, in order (ITEM_DESTROYED is not stored).
-- The build order shown in the helper is derived by replaying PURCHASED / UNDO; consumables,
-- trinkets and components are recognised from the item data (items), not from events.
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
-- Once a match turns out to be from a patch no longer collected (older than the previous one, or
-- the previous one once the platform has stored a match of the latest), every PENDING row of that
-- platform with a lower or equal game id is marked SKIPPED_OLD_PATCH in one statement.

-- LISTING_SKIP=shadow (0024): every listing still runs; one row per listing the skip rule would
-- have skipped that nevertheless added ids to match_fetch_queue. Recorded as is: a game that
-- ended after snapshot_at, or in the 10 minutes before it (not yet in Riot's counters), is
-- legitimately new, so real misses are found afterwards, e.g.
--   SELECT s.id, m.id, m.started_at FROM listing_skip_misses s
--   CROSS JOIN LATERAL unnest(s.new_match_ids) AS new_id
--   JOIN matches m ON m.id = new_id
--   WHERE NOT m.is_remake
--     AND m.started_at + make_interval(secs => m.duration_s) <= s.snapshot_at - interval '15 minutes';
-- No foreign key (rows outlive a purged player) and no cleanup: empty it by hand after analysis.
CREATE TABLE listing_skip_misses (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  puuid              text        NOT NULL,
  platform           platform    NOT NULL,
  checked_at         timestamptz NOT NULL,  -- when the rule was evaluated (just before the listing)
  listed_snapshot_at timestamptz NOT NULL,  -- start of the window (the baseline's snapshot)
  snapshot_at        timestamptz NOT NULL,  -- end of the window (the refresh of the current wins + losses)
  expected           integer     NOT NULL,  -- wins + losses now - at the baseline
  stored             integer     NOT NULL,  -- stored non-remake matches of the player that ended in the window
  new_match_ids      text[]      NOT NULL   -- ids the listing added to match_fetch_queue
);
CREATE INDEX listing_skip_misses_checked_at_idx ON listing_skip_misses (checked_at);

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

## Removed tables

`0017_drop_live_and_play_pause.sql` drops the live game lookups (`live_games`,
`live_player_profiles`, `live_player_masteries`, type `live_lookup_status`; added by 0013 / 0014)
and the play pause of the stats refresh (`client_activity`, 0014): single-user features of the
laptop era, gone since the stack runs on a shared server.

## Stats views (owned by apps/api)

Materialized views computed from the tables above, refreshed by the API in the order of
`STATS_REFRESH_ORDER` (`apps/api/src/stats/refresh.ts`): served views have a unique index and are
refreshed `CONCURRENTLY`, intermediate ones plainly. All are keyed by patch and exclude remakes.
Each statement of a refresh has a `statement_timeout` (2 h): a view that runs past it fails the
refresh, tried again at the next tick. `stats_participants` is refreshed with
`enable_nestloop = off`: the planner expects 1 row from its purchases (really ~100 million), so a
nested loop looks as cheap as a hash join and, once picked, never ends.
Definitions: `packages/db/migrations/0002_stats_views.sql` (traits, compositions, champion+role
baselines, pairwise vs/with, build choices), `0003_stats_bans.sql` (tier list ban rates),
`0006_tierlist_filters.sql` (tier list server/rank filters), `0007_support_quest_items.sql`,
`0008_deterministic_comp_traits.sql`, `0010_lane_phase.sql`, `0012_choice_ally_contexts.sql` and
`0015_items_done.sql`, `0016_side_wins.sql`, `0018_mastery_curve.sql`, `0019_game_length.sql` and `0022_item_swaps.sql` (all ten below).

`stats_participant_choices` lists every build/rune/spell/skill choice of a participant as `(kind, choice, pos)`; `stats_choices`, `stats_choice_matchups` and `stats_choice_traits` aggregate it per champion + role, vs a lane opponent and vs an enemy composition trait; `stats_choice_duos` and `stats_choice_ally_traits` (items only) with a duo partner and with an ally composition trait.

**Results per side** (`0016_side_wins.sql`). `stats_side_wins (patch, team_id, games, wins)`, unique `(patch, team_id)`: matches won by each side (team 100 = blue, 200 = red), remakes excluded, from `match_teams`. Two rows per patch; the side edge of the draft evaluation.

**Mastery curve** (`0018_mastery_curve.sql`). `stats_champion_mastery (patch, position, champion_id, bucket, games, wins)`, unique `(patch, position, champion_id, bucket)`: games and wins of each champion + role by the player's mastery points on the champion, in buckets 0–6 (`width_bucket` over the edges 5k / 20k / 50k / 100k / 200k / 500k: 0 = under 5k … 6 = 500k and more; mirrored by `ENGINE_CONFIG.mastery.bucketEdges`). Source: non-remake participants with a position joined to `champion_masteries` on puuid + champion — the player's current mastery when their masteries were last fetched, not the mastery at match time; participants without a mastery row are left out. At most 7 rows per champion + role per patch; the mastery term of the picks. Its refresh takes about 3 minutes at 300k matches per patch (index lookups in `champion_masteries`).

**Results by game length** (`0019_game_length.sql`). `stats_champion_game_length (patch, position, champion_id, bucket, games, wins)`, unique `(patch, position, champion_id, bucket)`: games and wins of a champion + role by length of the match (`matches.duration_s`), bucket `0` = under 25 min (< 1500 s), `1` = 25 to under 32 min, `2` = 32 min or more (≥ 1920 s; mirrors `GAME_LENGTH_MINUTES` of the API contract). One pass over `stats_tierlist_participants`, participants without a position excluded. Served (the early / late profile of `GET /tierlist/champion` and `POST /recommendations/draft`); explains, never scores.

**Late-game swaps** (`0022_item_swaps.sql`). The completed item a champion + role sells once its build is full and the completed item it buys in its place:

```sql
-- Served. games = participants who made the swap (a pair counts once per participant);
-- minute_sum = sum of the game minutes (at_ms / 60000) of their first such sale.
stats_item_swaps (patch, position, champion_id, sold_item_id, bought_item_id, games, minute_sum)
-- unique (patch, position, champion_id, sold_item_id, bought_item_id)  → build
```

A swap is, for a participant of a non-remake match with a position: a `SOLD` event of a completed item (`items.is_completed` on the match's patch, boots included) whose next event of that participant (by `seq`, among `PURCHASED` / `SOLD` / `UNDO`: a leftover `DESTROYED` row is skipped) is the `PURCHASED` of another completed item at most 60 s later, that purchase not being undone right after (the event after it is not an `UNDO` of the bought item), with at least 6 distinct completed items (boots included) purchased before the sale. A sale followed by an `UNDO` (item 0, `undo_after_item_id` = the item: 27 % of the sales of completed items) is a sale taken back and counts for nothing. On 8,000 matches the gap between the sale and the purchase has a median of 1.2 s and a 99th percentile of 34 s, and 1,200 of the 80,000 participants have a swap; without the 6-item rule most pairs are early boots changes and Mejai's sales. No `wins` column: players who can afford a swap are in long games they are winning, so the build shows the pair, its games and its average minute (`sum(minute_sum) / sum(games)` over the patches) and never a win rate. Unfiltered only.

`item_events` is the largest table and is neither sorted nor hashed by this view: one sequential pass finds the participants with a `SOLD` event of an item that is completed on some patch (a few percent of them), then only their events are read, in `seq` order through the primary key (one small subquery per such participant, with the two following events and the items purchased so far), and the patch, position and champion (from `stats_tierlist_participants`, hence refreshed after it) and the completed items of the patch are only looked up for the sales that pass the other rules. A few rows per champion + role per patch.

**Build stage of items** (`0015_items_done.sql`, kind `items_done`). One choice per participant: the number of completed items (`cardinality(stats_participants.core)`, 0–6, as text), in all five choice views (`stats_choice_duos` and `stats_choice_ally_traits` included). Players who complete more items win far more (≈ 37 % with one, 61 % with five on 16.22), so the build engine compares an item with the players who completed at least as many items as its usual slot (`avg_pos`, interpolated), not with every game. At most 7 rows per champion + role and per context.

**Ally contexts of items** (`0012_choice_ally_contexts.sql`). Situational items also answer the user's own team: completed-item choices (kind `item` only, read from `stats_participants.core`: the rows of `stats_participant_choices` with kind `item`) with a duo partner and when the ally composition has a trait. The champion's totals in those contexts come from `stats_champion_with` and `stats_champion_comp_traits` (side `ally`).

```sql
-- Served. Duo partners only (DUO_ROLES: UTILITY<->BOTTOM, MIDDLE<->JUNGLE, TOP<->JUNGLE).
stats_choice_duos (patch, champion_id, position, partner_position, partner_id,
                   kind, choice, games, wins)          -- kind = 'item' (choice = item id) or 'items_done' (0015)
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

- **Your owned champions, your mastery, the live champion select, helper settings** (auto-apply toggle, API address): read from the League client by the desktop helper and kept on your machine. Your mastery points are sent with champion select picks requests (when "Rank picks for my mastery" is on) to compute the answer, and are not stored.
- **Recommendation results**: computed by the API from the tables above at request time (with in-memory caching, since data changes at most hourly).

## Size estimate

Measured on 16.22 (Nov 2026: 305k matches, 39 GB in all), per match with indexes: item events (~240 rows since `DESTROYED` is no longer stored, was ~460) ~26 KB, skill events (~145 rows) ~16 KB, participants ~12 KB, bans ~1 KB, plus ~9 KB of stats views → **~62 KB/match**.

A full patch is ~300k matches (every Master+ player of the four servers over two weeks) → ~19 GB. `champion_masteries` adds ~8 GB whatever the number of patches (28M rows: one set per player, ladder or not).

Two full patches, at the end of a patch and before the older one is deleted → **~46 GB**. The stats refresh also needs temporary space while it runs (over 13 GB at 430k matches). The disk must hold both. There is no backup.

Low-priority enrichment volume: roughly 6–8 non-ladder players per match → tens of thousands of new players per region per patch, 2 requests each (mastery + rank). At leftover budget this takes a few days to catch up after the first run, then keeps pace.
