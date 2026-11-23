-- The per-participant part of the stats is kept up to date instead of being recomputed.
--
-- A stored match never changes, yet every refresh recomputed the build of every participant
-- (stats_participants: 8.4 of the 21 minutes of a refresh at 470,000 matches), looked for the
-- support quest upgrade of every participant (stats_quest_items: 3.0 min), regrouped every lane
-- (more than half of the 2.6 min of stats_champion_lane_phase) and looked into every sale
-- (stats_item_swaps: 0.6 min). Those four become ordinary tables that the refresh adds the new
-- matches to (pl_stats_fill, below), so that their cost follows the matches of the hour and no
-- longer the matches of two patches:
--
--   stats_matches            the matches whose rows are computed (the bookkeeping)
--   stats_participants       table, same rows as the materialized view of 0026 without the two
--                            composition trait columns (see below)
--   stats_quest_items        table, same rows as the materialized view of 0026
--   stats_lanes              one row per (match, lane): what stats_champion_lane_phase averages
--   stats_participant_swaps  one row per (participant, sold item, bought item): what
--                            stats_item_swaps counts
--   stats_patch_items        what the items of a patch were when its matches were computed
--
-- What a row holds must depend on its match alone, or the table would drift from a full
-- recomputation. Two things did not:
--   * the composition traits (enemy_traits / ally_traits of stats_participants) compare a team
--     with the 75th percentiles of every team of the patch (stats_comp_thresholds) through the
--     champion profiles of the patch (stats_champion_traits): both move with every new match.
--     They leave the row and are applied when the aggregates are computed: stats_team_traits
--     (materialized, one row per team, recomputed by every refresh) and the plain view
--     stats_participant_traits (a participant with the traits of both teams).
--   * what an item is (completed, boots, consumable, trinket, quest upgrade) comes from `items`,
--     which the worker replaces when Data Dragon publishes a new version of a kept patch.
--     stats_patch_items keeps a signature of the item flags each patch was computed with; when
--     it no longer matches, the rows of that patch are dropped and computed again.
-- The player's current rank (stats_tierlist_participants) changes without any new match: that
-- view stays a materialized view, recomputed by every refresh.
--
-- Every view built on the four is recreated (a materialized view's query cannot be altered, and
-- they depend on the materialized views that go): same names, columns, indexes and rows.
--
-- As in 0026 the old views stay readable until the end: the new aggregates are built next to them
-- (*_0030) and the last statements drop the old ones and rename, so an API of the previous version
-- keeps answering meanwhile. The two intermediate views that become tables (and the plain view
-- between them and the aggregates) are only read by the refresh: they are renamed out of the way
-- first (*_old; the old aggregates follow them, a view knows its sources by id, not by name).
-- That API's refresh must be off: it would fail afterwards anyway (REFRESH MATERIALIZED VIEW
-- stats_participants on a table). stats_participants is filled from the rows of the old
-- materialized view (no build is recomputed); the three other tables are computed here for the
-- same matches. A fresh database goes through the same statements with empty tables.
--
-- Measured on 40,000 synthetic matches: 62 s (the copy 6 s, the three other tables 13 s, the
-- aggregates 40 s), and every stats view holds the same rows before and after.

-- Built serially: parallel hash joins live in /dev/shm (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

-- The final statements take the old views away from requests that may be reading two of them in
-- one query: should that ever deadlock, the request must be the one that fails (see 0026).
DO $$
BEGIN
  SET LOCAL deadlock_timeout = '10min';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END
$$;

-- No stats refresh while this runs (STATS_REFRESH_LOCK_KEY of apps/api/src/stats/refresh.ts): one
-- in progress is waited for, one that starts finds the lock taken and gives up until its next tick.
SELECT pg_advisory_xact_lock(7316221905);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The names of the two tables are freed first (no request reads these three).
ALTER MATERIALIZED VIEW stats_participants RENAME TO stats_participants_old;
ALTER INDEX stats_participants_pk RENAME TO stats_participants_old_pk;
ALTER MATERIALIZED VIEW stats_quest_items RENAME TO stats_quest_items_old;
ALTER INDEX stats_quest_items_pk RENAME TO stats_quest_items_old_pk;
ALTER VIEW stats_participant_choices RENAME TO stats_participant_choices_old;

-- The matches whose rows are in the tables below (remakes included: they have none). Everything
-- computed from a match hangs from its row here: deleting the match, or only this row, deletes
-- it all, and a match without a row is computed by the next refresh. Each of the four tables
-- below references it (match_id, ON DELETE CASCADE): those foreign keys are added once the tables
-- are filled, further down (one check of the whole table instead of one per row).
CREATE TABLE stats_matches (
  match_id text PRIMARY KEY REFERENCES matches ON DELETE CASCADE
);

-- Signature of the item flags (pl_stats_item_flags) the rows of a patch were computed with;
-- '' = the patch had no item.
CREATE TABLE stats_patch_items (
  patch     text PRIMARY KEY REFERENCES patches ON DELETE CASCADE,
  signature text NOT NULL
);

-- One row per participant with a position of a non-remake match: loadout, build, skill order.
CREATE TABLE stats_participants (
  patch          text       NOT NULL,
  match_id       text       NOT NULL,
  participant_id smallint   NOT NULL,
  team_id        smallint   NOT NULL,
  champion_id    smallint   NOT NULL,
  position       "position" NOT NULL,
  win            boolean    NOT NULL,
  keystone       integer,
  rune_page      text,
  spells         text,
  starter        text,
  early          integer[],
  core           integer[],
  boots          integer,
  boots_pos      integer,
  skill_first3   text,
  skill_max      text,
  skill_seq      text,
  CONSTRAINT stats_participants_pk PRIMARY KEY (match_id, participant_id)
);

-- The support quest upgrade of a participant of a non-remake match (with or without a position).
CREATE TABLE stats_quest_items (
  match_id       text     NOT NULL,
  participant_id smallint NOT NULL,
  item_id        integer  NOT NULL,
  CONSTRAINT stats_quest_items_pk PRIMARY KEY (match_id, participant_id)
);

-- One row per lane of a non-remake match with both sides complete and their frames at 10 min
-- (rules of 0010_lane_phase.sql): the players of each side and blue minus red.
CREATE TABLE stats_lanes (
  match_id       text         NOT NULL,
  lane           text         NOT NULL,    -- 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOT' (BOTTOM + UTILITY)
  patch          text         NOT NULL,
  blue_ids       smallint[]   NOT NULL,    -- champions of team 100, by position, participant id
  blue_positions "position"[] NOT NULL,    -- their positions, in the same order
  red_ids        smallint[]   NOT NULL,
  red_positions  "position"[] NOT NULL,
  has_15         boolean      NOT NULL,    -- every player has the frame of minute 15
  gold_10        integer      NOT NULL,
  xp_10          integer      NOT NULL,
  cs_10          integer      NOT NULL,
  gold_15        integer,                  -- only read when has_15
  xp_15          integer,
  cs_15          integer,
  CONSTRAINT stats_lanes_pk PRIMARY KEY (match_id, lane)
);

-- One row per participant (with a position, non-remake match) and late-game swap (rules of
-- 0022_item_swaps.sql): the first time they sold that item for that one.
CREATE TABLE stats_participant_swaps (
  match_id       text       NOT NULL,
  participant_id smallint   NOT NULL,
  patch          text       NOT NULL,
  position       "position" NOT NULL,
  champion_id    smallint   NOT NULL,
  sold_item_id   integer    NOT NULL,
  bought_item_id integer    NOT NULL,
  at_ms          integer    NOT NULL,
  CONSTRAINT stats_participant_swaps_pk
    PRIMARY KEY (match_id, participant_id, sold_item_id, bought_item_id)
);

-- ---------------------------------------------------------------------------
-- The derivation: functions the refresh calls for the matches not computed yet
-- ---------------------------------------------------------------------------
-- A migration that changes what one of them computes must leave no row of the old rule behind:
-- replace the function, then either empty everything (TRUNCATE stats_matches CASCADE, after
-- taking the refresh lock as above: the next refresh computes every match again, and the served
-- views keep their rows until it has) or rebuild next to the old objects as this migration does.

-- What an item is on each patch, as one smallint per (patch, item id) in a two-dimensional array,
-- so that looking an item up is a subscript and not a join. flags[n][id], n being the position of
-- the patch in `patches`:
--   0 = no such item on that patch, else 1
--     + 2  completed (items.is_completed)
--     + 4  boots (items.is_boots)
--     + 8  never part of a build order: consumable or trinket
--     + 16 trinket (tag 'Trinket')
--     + 32 support quest upgrade (0007_support_quest_items.sql): not completed, not a consumable,
--          not boots, tagged 'GoldPer', built from an item and building into nothing
-- signatures[n]: a hash of the items of that patch with their flags, the same for the same flags
-- whatever the other patches hold. One statement, hence one state of `items`.
CREATE FUNCTION pl_stats_item_flags(
  OUT patches text[], OUT flags smallint[], OUT signatures text[]
)
LANGUAGE sql STABLE AS $$
  WITH item AS MATERIALIZED (
    SELECT patch, id,
           (1 + (CASE WHEN is_completed THEN 2 ELSE 0 END)
              + (CASE WHEN is_boots THEN 4 ELSE 0 END)
              + (CASE WHEN is_consumable OR 'Trinket' = ANY (tags) THEN 8 ELSE 0 END)
              + (CASE WHEN 'Trinket' = ANY (tags) THEN 16 ELSE 0 END)
              + (CASE WHEN NOT is_completed AND NOT is_consumable AND NOT is_boots
                           AND 'GoldPer' = ANY (tags) AND cardinality(builds_from) > 0
                           AND cardinality(builds_into) = 0
                      THEN 32 ELSE 0 END))::smallint AS flags
    FROM items
  )
  SELECT array_agg(per_patch.patch ORDER BY per_patch.patch),
         array_agg(per_patch.flags ORDER BY per_patch.patch),
         array_agg(per_patch.signature ORDER BY per_patch.patch)
  FROM (
    SELECT pt.patch,
           (SELECT array_agg(COALESCE(i.flags, 0)::smallint ORDER BY n.id)
            FROM generate_series(1, (SELECT max(id) FROM item)) AS n(id)
            LEFT JOIN item i ON i.patch = pt.patch AND i.id = n.id) AS flags,
           (SELECT md5(string_agg(i.id::text || ':' || i.flags::text, ',' ORDER BY i.id))
            FROM item i WHERE i.patch = pt.patch) AS signature
    FROM (SELECT DISTINCT patch FROM item) pt
  ) per_patch
$$;

-- The four functions below add the rows of the matches listed in the session's temporary table
-- stats_fill_matches (match_id, patch): non-remake matches with a row in stats_matches and no row
-- in the table yet. pl_stats_fill makes that list; item_patches / item_flags are the arrays of
-- pl_stats_item_flags. They read nothing but those matches' own rows and the arrays.

-- stats_participants: the query of 0026_stats_on_participant_events.sql (which explains the two
-- passes over the item events) for the listed matches, without the composition traits.
CREATE FUNCTION pl_stats_fill_participants(item_patches text[], item_flags smallint[])
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  added bigint;
BEGIN
  INSERT INTO stats_participants (
    patch, match_id, participant_id, team_id, champion_id, position, win, keystone, rune_page,
    spells, starter, early, core, boots, boots_pos, skill_first3, skill_max, skill_seq)
  SELECT
    m.patch, p.match_id, p.participant_id, p.team_id, p.champion_id, p.position, p.win,
    p.runes[1]::int AS keystone,
    concat_ws('|', p.rune_primary_tree, p.rune_secondary_tree,
      array_to_string(p.runes, ','), array_to_string(p.stat_shards, ',')) AS rune_page,
    least(p.summoner_spell_1, p.summoner_spell_2) || ',' || greatest(p.summoner_spell_1, p.summoner_spell_2) AS spells,
    NULLIF(array_to_string(bu.starter, ','), '') AS starter,
    bu.early,
    bu.core,
    bu.boots,
    bu.boots_pos,
    CASE WHEN cardinality(sk.seq) >= 3 THEN array_to_string(sk.seq[1:3], ',') END AS skill_first3,
    pl_skill_max_order(sk.seq) AS skill_max,
    CASE WHEN cardinality(sk.seq) >= 9 THEN array_to_string(sk.seq, ',') END AS skill_seq
  FROM pg_temp.stats_fill_matches m
  JOIN participants p ON p.match_id = m.match_id
  LEFT JOIN participant_events pe
    ON pe.match_id = p.match_id AND pe.participant_id = p.participant_id
  -- The first 18 skill points (evolutions are not stored); NULL without any.
  LEFT JOIN LATERAL (SELECT NULLIF(pe.skill_slots[1:18], '{}') AS seq) sk ON true
  LEFT JOIN LATERAL (
    SELECT
      first_pass.starter,
      second_pass.early,
      second_pass.core,
      pe.item_ids[first_pass.boots_ord] AS boots,
      CASE WHEN first_pass.boots_ord IS NOT NULL THEN second_pass.before_boots END AS boots_pos
    FROM (
      SELECT
        array_agg(e.item_id ORDER BY e.item_id, e.ord) FILTER (WHERE e.flags > 0) AS kept,
        array_agg(e.ord ORDER BY e.item_id, e.ord) FILTER (WHERE e.flags > 0) AS kept_ord,
        array_agg(e.flags ORDER BY e.item_id, e.ord) FILTER (WHERE e.flags > 0) AS kept_flags,
        array_agg(e.item_id ORDER BY e.item_id)
          FILTER (WHERE e.flags > 0 AND e.flags & 16 = 0 AND e.at_ms <= 60000) AS starter,
        COALESCE(array_agg(e.item_id) FILTER (WHERE e.flags > 0 AND e.at_ms <= 60000), '{}')
          AS first_minute,
        min(e.ord) FILTER (WHERE e.flags & 14 = 2) AS first_completed_ord,
        min(e.ord) FILTER (WHERE e.flags & 14 = 6) AS boots_ord
      FROM (
        SELECT
          g.ord,
          pe.item_ids[g.ord] AS item_id,
          pe.item_at_ms[g.ord] AS at_ms,
          CASE WHEN pe.item_types[g.ord] = 'P' AND NOT (g.ord = ANY (c.undone))
               THEN COALESCE(item_flags[c.patch_idx][pe.item_ids[g.ord]], 0)
               ELSE 0
          END AS flags
        FROM (
          -- Once per participant: its patch in item_flags, and its undone purchases.
          SELECT
            array_position(item_patches, m.patch) AS patch_idx,
            CASE WHEN 'U' = ANY (pe.item_types)
                 THEN pl_undone_purchases(pe.item_types, pe.item_ids)
                 ELSE '{}'
            END AS undone
          OFFSET 0
        ) c
        CROSS JOIN LATERAL (SELECT generate_series(1, cardinality(pe.item_ids)) AS ord) g
        OFFSET 0
      ) e
    ) first_pass
    CROSS JOIN LATERAL (
      SELECT
        array_agg(k.item_id ORDER BY k.ord) FILTER (
          WHERE k.flags & 10 = 0 AND NOT (k.item_id = ANY (first_pass.first_minute))
            AND k.ord < COALESCE(first_pass.first_completed_ord, 2147483647)
        ) AS early,
        (array_agg(k.item_id ORDER BY k.ord) FILTER (WHERE k.flags & 14 = 2))[1:6] AS core,
        (count(*) FILTER (WHERE k.flags & 14 = 2 AND k.ord < first_pass.boots_ord))::int
          AS before_boots
      FROM (
        SELECT first_pass.kept[g.n] AS item_id, first_pass.kept_ord[g.n] AS ord,
               first_pass.kept_flags[g.n] AS flags
        FROM (SELECT generate_series(1, cardinality(first_pass.kept)) AS n) g
        WHERE first_pass.kept_flags[g.n] & 8 = 0
          AND array_position(first_pass.kept, first_pass.kept[g.n]) = g.n
        OFFSET 0
      ) k
    ) second_pass
  ) bu ON true
  WHERE p.position IS NOT NULL;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;

-- stats_quest_items: the rows of 0026 (rules of 0007_support_quest_items.sql) for the listed
-- matches: the first quest upgrade of the end-of-game inventory (by slot), else the last purchase
-- of one. An upgrade is recognised by its flag instead of a join with the upgrades of the patch.
CREATE FUNCTION pl_stats_fill_quest_items(item_patches text[], item_flags smallint[])
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  added bigint;
BEGIN
  INSERT INTO stats_quest_items (match_id, participant_id, item_id)
  SELECT q.match_id, q.participant_id, q.item_id
  FROM (
    SELECT p.match_id, p.participant_id,
           COALESCE(
             (SELECT f.item_id
              FROM unnest(p.final_items) WITH ORDINALITY AS f(item_id, slot)
              WHERE COALESCE(item_flags[c.patch_idx][f.item_id], 0) & 32 <> 0
              ORDER BY f.slot
              LIMIT 1),
             (SELECT pe.item_ids[max(g.ord)]
              FROM (SELECT generate_series(1, cardinality(pe.item_ids)) AS ord) g
              WHERE pe.item_types[g.ord] = 'P'
                AND COALESCE(item_flags[c.patch_idx][pe.item_ids[g.ord]], 0) & 32 <> 0)
           ) AS item_id
    FROM pg_temp.stats_fill_matches m
    JOIN participants p ON p.match_id = m.match_id
    LEFT JOIN participant_events pe
      ON pe.match_id = p.match_id AND pe.participant_id = p.participant_id
    CROSS JOIN LATERAL (SELECT array_position(item_patches, m.patch) AS patch_idx OFFSET 0) c
    OFFSET 0
  ) q
  WHERE q.item_id IS NOT NULL;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;

-- stats_lanes: the `lanes` of 0010_lane_phase.sql for the listed matches. Two players of a team
-- on one position are listed by participant id (0010 left their order open, which changes
-- nothing in the averages but would let two computations of the same lane differ).
CREATE FUNCTION pl_stats_fill_lanes()
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  added bigint;
BEGIN
  INSERT INTO stats_lanes (
    match_id, lane, patch, blue_ids, blue_positions, red_ids, red_positions, has_15,
    gold_10, xp_10, cs_10, gold_15, xp_15, cs_15)
  SELECT
    p.match_id,
    CASE WHEN p.position IN ('BOTTOM', 'UTILITY') THEN 'BOT' ELSE p.position::text END AS lane,
    m.patch,
    array_agg(p.champion_id ORDER BY p.position, p.participant_id)
      FILTER (WHERE p.team_id = 100) AS blue_ids,
    array_agg(p.position ORDER BY p.position, p.participant_id)
      FILTER (WHERE p.team_id = 100) AS blue_positions,
    array_agg(p.champion_id ORDER BY p.position, p.participant_id)
      FILTER (WHERE p.team_id <> 100) AS red_ids,
    array_agg(p.position ORDER BY p.position, p.participant_id)
      FILTER (WHERE p.team_id <> 100) AS red_positions,
    bool_and(p.gold_by_minute[16] IS NOT NULL AND p.xp_by_minute[16] IS NOT NULL
             AND p.cs_by_minute[16] IS NOT NULL) AS has_15,
    sum(CASE WHEN p.team_id = 100 THEN p.gold_by_minute[11] ELSE -p.gold_by_minute[11] END) AS gold_10,
    sum(CASE WHEN p.team_id = 100 THEN p.xp_by_minute[11] ELSE -p.xp_by_minute[11] END) AS xp_10,
    sum(CASE WHEN p.team_id = 100 THEN p.cs_by_minute[11] ELSE -p.cs_by_minute[11] END) AS cs_10,
    sum(CASE WHEN p.team_id = 100 THEN p.gold_by_minute[16] ELSE -p.gold_by_minute[16] END) AS gold_15,
    sum(CASE WHEN p.team_id = 100 THEN p.xp_by_minute[16] ELSE -p.xp_by_minute[16] END) AS xp_15,
    sum(CASE WHEN p.team_id = 100 THEN p.cs_by_minute[16] ELSE -p.cs_by_minute[16] END) AS cs_15
  FROM pg_temp.stats_fill_matches m
  JOIN participants p ON p.match_id = m.match_id
  WHERE p.position IS NOT NULL
  GROUP BY m.patch, p.match_id,
           CASE WHEN p.position IN ('BOTTOM', 'UTILITY') THEN 'BOT' ELSE p.position::text END
  HAVING count(*) FILTER (WHERE p.team_id = 100) = count(*) FILTER (WHERE p.team_id <> 100)
     AND count(*) = CASE WHEN min(p.position) IN ('BOTTOM', 'UTILITY') THEN 4 ELSE 2 END
     AND bool_and(p.gold_by_minute[11] IS NOT NULL AND p.xp_by_minute[11] IS NOT NULL
                  AND p.cs_by_minute[11] IS NOT NULL);
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;

-- stats_participant_swaps: the `swaps` of 0026 (rules of 0022_item_swaps.sql) for the listed
-- matches. A completed item is recognised by its flag instead of the list of the patch.
CREATE FUNCTION pl_stats_fill_swaps(item_patches text[], item_flags smallint[])
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  added bigint;
BEGIN
  INSERT INTO stats_participant_swaps (
    match_id, participant_id, patch, position, champion_id, sold_item_id, bought_item_id, at_ms)
  SELECT k.match_id, k.participant_id, k.patch, k.position, k.champion_id,
         k.sold_item_id, k.bought_item_id, min(k.at_ms)
  FROM (
    -- Sales followed within 60 s by the purchase of another item that is not undone right after.
    SELECT m.patch, p.position, p.champion_id, pe.match_id, pe.participant_id,
           pe.item_types, pe.item_ids, s.ord,
           array_position(item_patches, m.patch) AS patch_idx,
           pe.item_at_ms[s.ord] AS at_ms,
           pe.item_ids[s.ord] AS sold_item_id,
           pe.item_ids[s.ord + 1] AS bought_item_id
    FROM pg_temp.stats_fill_matches m
    JOIN participants p ON p.match_id = m.match_id
    JOIN participant_events pe
      ON pe.match_id = p.match_id AND pe.participant_id = p.participant_id
    CROSS JOIN LATERAL (SELECT generate_series(1, cardinality(pe.item_ids) - 1) AS ord) s
    WHERE p.position IS NOT NULL
      AND 'S' = ANY (pe.item_types)
      AND pe.item_types[s.ord] = 'S'
      AND pe.item_types[s.ord + 1] = 'P'
      AND pe.item_ids[s.ord + 1] <> pe.item_ids[s.ord]
      AND pe.item_at_ms[s.ord + 1] - pe.item_at_ms[s.ord] <= 60000
      AND (pe.item_types[s.ord + 2] IS DISTINCT FROM 'U'
           OR pe.item_ids[s.ord + 2] IS DISTINCT FROM pe.item_ids[s.ord + 1])
    OFFSET 0
  ) k
  -- Both items completed on the match's patch and a full build before the sale.
  WHERE COALESCE(item_flags[k.patch_idx][k.sold_item_id], 0) & 2 <> 0
    AND COALESCE(item_flags[k.patch_idx][k.bought_item_id], 0) & 2 <> 0
    AND (
      SELECT count(DISTINCT k.item_ids[b.ord])
      FROM generate_series(1, k.ord - 1) AS b(ord)
      WHERE k.item_types[b.ord] = 'P'
        AND COALESCE(item_flags[k.patch_idx][k.item_ids[b.ord]], 0) & 2 <> 0
    ) >= 6
  GROUP BY k.patch, k.position, k.champion_id, k.match_id, k.participant_id,
           k.sold_item_id, k.bought_item_id;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;

-- One step of the refresh (apps/api/src/stats/refresh.ts calls it until it marks fewer than
-- max_matches): computes the rows of at most max_matches matches that have none, in the
-- transaction of the call, and says what it did, one row per step with its duration:
--   stats_patch_items        matches whose rows were dropped because the items of their patch
--                            changed since they were computed (they are computed again)
--   stats_matches            matches taken (remakes included)
--   stats_participants, stats_quest_items, stats_lanes, stats_participant_swaps: rows added
--
-- Why the tables always hold what a recomputation of everything would:
--   * a match is stored in one transaction and never updated: its rows depend on its own rows
--     (participants, participant_events) and on the item flags only;
--   * the item flags are read once (pl_stats_item_flags, one statement) and every row of the call
--     is computed from those arrays. A patch whose stored signature is not the one of the arrays
--     loses its rows first, and gets the new signature in the same transaction: at commit, every
--     row of a patch was computed with the flags of its stored signature, and a later change of
--     `items` is seen by the next call;
--   * the matches are locked (FOR KEY SHARE) before anything is computed: they cannot be deleted
--     until the call commits, and the delete then takes the rows with it (ON DELETE CASCADE). One
--     that is being deleted is left alone (SKIP LOCKED);
--   * a call that fails leaves nothing (one transaction); matches stored meanwhile have no row in
--     stats_matches and are taken by the next call.
-- Serial: see stats/refresh.ts. Planned on the list's real size (ANALYZE): index lookups by match
-- for the matches of an hour. Without JIT: compiling these queries costs half a second per call
-- and gains nothing on a few thousand matches (measured: 1.0 s against 0.5 s for 400 matches).
CREATE FUNCTION pl_stats_fill(max_matches integer)
RETURNS TABLE (step text, ms double precision, row_count bigint)
LANGUAGE plpgsql
SET max_parallel_workers_per_gather = 0
SET jit = off
AS $$
DECLARE
  item_patches text[];
  item_flags smallint[];
  item_signatures text[];
  stale record;
  started timestamptz;
  dropped bigint := 0;
  affected bigint;
BEGIN
  started := clock_timestamp();
  SELECT f.patches, f.flags, f.signatures INTO item_patches, item_flags, item_signatures
  FROM pl_stats_item_flags() f;
  FOR stale IN
    SELECT p.id,
           COALESCE(item_signatures[array_position(item_patches, p.id)], '') AS signature
    FROM patches p
    LEFT JOIN stats_patch_items s ON s.patch = p.id
    WHERE s.signature IS DISTINCT FROM
          COALESCE(item_signatures[array_position(item_patches, p.id)], '')
    FOR KEY SHARE OF p SKIP LOCKED
  LOOP
    DELETE FROM stats_matches sm USING matches mt
    WHERE mt.id = sm.match_id AND mt.patch = stale.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    dropped := dropped + affected;
    INSERT INTO stats_patch_items (patch, signature) VALUES (stale.id, stale.signature)
    ON CONFLICT (patch) DO UPDATE SET signature = EXCLUDED.signature;
  END LOOP;
  step := 'stats_patch_items';
  ms := extract(epoch FROM clock_timestamp() - started) * 1000;
  row_count := dropped;
  RETURN NEXT;

  started := clock_timestamp();
  DROP TABLE IF EXISTS pg_temp.stats_fill_matches;
  CREATE TEMP TABLE stats_fill_matches (
    match_id text NOT NULL, patch text NOT NULL, is_remake boolean NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.stats_fill_matches (match_id, patch, is_remake)
  SELECT mt.id, mt.patch, mt.is_remake
  FROM matches mt
  WHERE NOT EXISTS (SELECT 1 FROM stats_matches sm WHERE sm.match_id = mt.id)
  LIMIT max_matches
  FOR KEY SHARE OF mt SKIP LOCKED;
  INSERT INTO stats_matches (match_id) SELECT f.match_id FROM pg_temp.stats_fill_matches f;
  GET DIAGNOSTICS affected = ROW_COUNT;
  DELETE FROM pg_temp.stats_fill_matches f WHERE f.is_remake;
  ANALYZE pg_temp.stats_fill_matches;
  step := 'stats_matches';
  ms := extract(epoch FROM clock_timestamp() - started) * 1000;
  row_count := affected;
  RETURN NEXT;

  started := clock_timestamp();
  row_count := pl_stats_fill_participants(item_patches, item_flags);
  step := 'stats_participants';
  ms := extract(epoch FROM clock_timestamp() - started) * 1000;
  RETURN NEXT;

  started := clock_timestamp();
  row_count := pl_stats_fill_quest_items(item_patches, item_flags);
  step := 'stats_quest_items';
  ms := extract(epoch FROM clock_timestamp() - started) * 1000;
  RETURN NEXT;

  started := clock_timestamp();
  row_count := pl_stats_fill_lanes();
  step := 'stats_lanes';
  ms := extract(epoch FROM clock_timestamp() - started) * 1000;
  RETURN NEXT;

  started := clock_timestamp();
  row_count := pl_stats_fill_swaps(item_patches, item_flags);
  step := 'stats_participant_swaps';
  ms := extract(epoch FROM clock_timestamp() - started) * 1000;
  RETURN NEXT;
END
$$;

-- ---------------------------------------------------------------------------
-- The tables as of the old materialized views
-- ---------------------------------------------------------------------------

-- The matches of the old stats_participants that still exist are the computed ones. Each has all
-- its rows there (a match is stored in one transaction and the view was refreshed from one
-- snapshot), and each row is the build pl_stats_fill_participants would compute again: same query,
-- as long as the items of its patch were not replaced since that refresh. Matches stored since
-- then, remakes and matches without any participant with a position are taken by the next refresh.
-- Copied in key order: the rows of a match end up next to each other, as the rows the refresh
-- will add (the old view held them in the order of a hash join, a match scattered over the file).
INSERT INTO stats_matches (match_id)
SELECT m.id
FROM matches m
WHERE EXISTS (SELECT 1 FROM stats_participants_old sp WHERE sp.match_id = m.id)
ORDER BY m.id;
ANALYZE stats_matches;

INSERT INTO stats_participants (
  patch, match_id, participant_id, team_id, champion_id, position, win, keystone, rune_page,
  spells, starter, early, core, boots, boots_pos, skill_first3, skill_max, skill_seq)
SELECT sp.patch, sp.match_id, sp.participant_id, sp.team_id, sp.champion_id, sp.position, sp.win,
       sp.keystone, sp.rune_page, sp.spells, sp.starter, sp.early, sp.core, sp.boots,
       sp.boots_pos, sp.skill_first3, sp.skill_max, sp.skill_seq
FROM stats_participants_old sp
JOIN stats_matches sm ON sm.match_id = sp.match_id
ORDER BY sp.match_id, sp.participant_id;

-- The three other tables are computed for those matches: the old stats_quest_items may be of an
-- older refresh than stats_participants (a refresh that failed between the two), and the lanes
-- and the swaps were not kept anywhere.
CREATE TEMP TABLE stats_fill_matches ON COMMIT DROP AS
SELECT m.id AS match_id, m.patch
FROM matches m
JOIN stats_matches sm ON sm.match_id = m.id
WHERE NOT m.is_remake;
ANALYZE pg_temp.stats_fill_matches;

DO $$
DECLARE
  item_patches text[];
  item_flags smallint[];
  item_signatures text[];
BEGIN
  SELECT f.patches, f.flags, f.signatures INTO item_patches, item_flags, item_signatures
  FROM pl_stats_item_flags() f;
  INSERT INTO stats_patch_items (patch, signature)
  SELECT p.id, COALESCE(item_signatures[array_position(item_patches, p.id)], '')
  FROM patches p;
  PERFORM pl_stats_fill_quest_items(item_patches, item_flags);
  PERFORM pl_stats_fill_lanes();
  PERFORM pl_stats_fill_swaps(item_patches, item_flags);
END
$$;
DROP TABLE pg_temp.stats_fill_matches;

ALTER TABLE stats_participants ADD CONSTRAINT stats_participants_match_fk
  FOREIGN KEY (match_id) REFERENCES stats_matches ON DELETE CASCADE;
ALTER TABLE stats_quest_items ADD CONSTRAINT stats_quest_items_match_fk
  FOREIGN KEY (match_id) REFERENCES stats_matches ON DELETE CASCADE;
ALTER TABLE stats_lanes ADD CONSTRAINT stats_lanes_match_fk
  FOREIGN KEY (match_id) REFERENCES stats_matches ON DELETE CASCADE;
ALTER TABLE stats_participant_swaps ADD CONSTRAINT stats_participant_swaps_match_fk
  FOREIGN KEY (match_id) REFERENCES stats_matches ON DELETE CASCADE;

ANALYZE stats_participants;
ANALYZE stats_quest_items;
ANALYZE stats_lanes;
ANALYZE stats_participant_swaps;

-- ---------------------------------------------------------------------------
-- Composition traits, applied where they are read
-- ---------------------------------------------------------------------------

-- The traits of each team's own composition against the thresholds of its patch (intermediate,
-- recomputed by every refresh after stats_comp_thresholds). A participant's enemy_traits are the
-- traits of the other team of its match: the same expression as in the stats_participants of
-- 0026, evaluated once per team instead of once per participant.
CREATE MATERIALIZED VIEW stats_team_traits AS
SELECT
  tc.match_id, tc.team_id,
  pl_comp_traits(
    ARRAY[tc.physical_share / tc.champions, tc.magic_share / tc.champions,
          tc.cc_per_min / tc.champions, tc.healing_per_min / tc.champions,
          tc.tankiness_per_min / tc.champions, tc.ranged / tc.champions,
          1 - tc.ranged / tc.champions],
    ARRAY[th.physical_share, th.magic_share, th.cc_per_min, th.healing_per_min,
          th.tankiness_per_min, th.ranged, th.melee]
  ) AS traits
FROM stats_team_comp tc
LEFT JOIN stats_comp_thresholds th ON th.patch = tc.patch;
CREATE UNIQUE INDEX stats_team_traits_pk ON stats_team_traits (match_id, team_id);
ANALYZE stats_team_traits;

-- stats_participants with the two columns it had as a materialized view: the columns and values
-- of the stats_participants of 0026. Read by the aggregates that need a trait; the others read
-- the table.
CREATE VIEW stats_participant_traits AS
SELECT
  sp.patch, sp.match_id, sp.participant_id, sp.team_id, sp.champion_id, sp.position, sp.win,
  sp.keystone, sp.rune_page, sp.spells, sp.starter, sp.early, sp.core, sp.boots, sp.boots_pos,
  sp.skill_first3, sp.skill_max, sp.skill_seq,
  COALESCE(et.traits, '{}') AS enemy_traits,
  COALESCE(pl_comp_traits(
    ARRAY[(own.physical_share - ct.physical_share) / NULLIF(own.champions - 1, 0),
          (own.magic_share - ct.magic_share) / NULLIF(own.champions - 1, 0),
          (own.cc_per_min - ct.cc_per_min) / NULLIF(own.champions - 1, 0),
          (own.healing_per_min - ct.healing_per_min) / NULLIF(own.champions - 1, 0),
          (own.tankiness_per_min - ct.tankiness_per_min) / NULLIF(own.champions - 1, 0),
          (own.ranged - (CASE WHEN ct.is_ranged THEN 1 ELSE 0 END)) / NULLIF(own.champions - 1, 0),
          1 - (own.ranged - (CASE WHEN ct.is_ranged THEN 1 ELSE 0 END)) / NULLIF(own.champions - 1, 0)],
    ARRAY[th.physical_share, th.magic_share, th.cc_per_min, th.healing_per_min,
          th.tankiness_per_min, th.ranged, th.melee]
  ), '{}') AS ally_traits
FROM stats_participants sp
LEFT JOIN stats_team_traits et ON et.match_id = sp.match_id AND et.team_id <> sp.team_id
LEFT JOIN stats_team_comp own ON own.match_id = sp.match_id AND own.team_id = sp.team_id
LEFT JOIN stats_champion_traits ct ON ct.patch = sp.patch AND ct.champion_id = sp.champion_id
LEFT JOIN stats_comp_thresholds th ON th.patch = sp.patch;

-- ---------------------------------------------------------------------------
-- Views built on the tables: definitions of 0026, unchanged but for their source
-- ---------------------------------------------------------------------------

-- Without enemy_traits (only stats_choice_traits read it: it now joins stats_team_traits).
CREATE VIEW stats_participant_choices AS
SELECT sp.patch, sp.match_id, sp.participant_id, sp.team_id, sp.champion_id, sp.position, sp.win,
       c.kind, c.choice, c.pos
FROM stats_participants sp
LEFT JOIN stats_quest_items q ON q.match_id = sp.match_id AND q.participant_id = sp.participant_id
CROSS JOIN LATERAL (
  SELECT k.kind, k.choice, k.pos
  FROM (VALUES
    ('rune_page', sp.rune_page, NULL::int),
    ('keystone', sp.keystone::text, NULL::int),
    ('spells', sp.spells, NULL::int),
    ('starter', sp.starter, NULL::int),
    ('boots', sp.boots::text, sp.boots_pos),
    ('core3', CASE WHEN cardinality(sp.core) >= 3 THEN array_to_string(sp.core[1:3], ',') END, NULL::int),
    ('skill_first3', sp.skill_first3, NULL::int),
    ('skill_max', sp.skill_max, NULL::int),
    ('skill_seq', sp.skill_seq, NULL::int),
    ('quest_item', q.item_id::text, NULL::int),
    ('items_done', COALESCE(cardinality(sp.core), 0)::text, NULL::int)
  ) AS k(kind, choice, pos)
  UNION ALL
  SELECT 'item', i.item_id::text, i.ord::int FROM unnest(sp.core) WITH ORDINALITY AS i(item_id, ord)
  UNION ALL
  SELECT 'early_item', i.item_id::text, i.ord::int FROM unnest(sp.early) WITH ORDINALITY AS i(item_id, ord)
) c
WHERE c.choice IS NOT NULL;

CREATE MATERIALIZED VIEW stats_champion_roles_0030 AS
SELECT patch, champion_id, position,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins
FROM stats_participants
GROUP BY patch, champion_id, position;
CREATE UNIQUE INDEX stats_champion_roles_0030_pk
  ON stats_champion_roles_0030 (patch, champion_id, position);

CREATE MATERIALIZED VIEW stats_champion_vs_0030 AS
SELECT a.patch, a.position, a.champion_id, b.position AS enemy_position, b.champion_id AS enemy_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_participants a
JOIN stats_participants b ON b.match_id = a.match_id AND b.team_id <> a.team_id
GROUP BY a.patch, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_champion_vs_0030_pk
  ON stats_champion_vs_0030 (patch, position, enemy_id, enemy_position, champion_id);
CREATE INDEX stats_champion_vs_0030_champion ON stats_champion_vs_0030 (patch, champion_id, position);

CREATE MATERIALIZED VIEW stats_champion_with_0030 AS
SELECT a.patch, a.position, a.champion_id, b.position AS ally_position, b.champion_id AS ally_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_participants a
JOIN stats_participants b
  ON b.match_id = a.match_id AND b.team_id = a.team_id AND b.participant_id <> a.participant_id
GROUP BY a.patch, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_champion_with_0030_pk
  ON stats_champion_with_0030 (patch, position, ally_id, ally_position, champion_id);
CREATE INDEX stats_champion_with_0030_champion ON stats_champion_with_0030 (patch, champion_id, position);

CREATE MATERIALIZED VIEW stats_champion_comp_traits_0030 AS
SELECT sp.patch, sp.position, sp.champion_id, t.side, t.trait,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participant_traits sp
CROSS JOIN LATERAL (
  SELECT 'enemy'::text AS side, unnest(sp.enemy_traits) AS trait
  UNION ALL
  SELECT 'ally'::text, unnest(sp.ally_traits)
) t
GROUP BY sp.patch, sp.position, sp.champion_id, t.side, t.trait;
CREATE UNIQUE INDEX stats_champion_comp_traits_0030_pk
  ON stats_champion_comp_traits_0030 (patch, position, champion_id, side, trait);

CREATE MATERIALIZED VIEW stats_choices_0030 AS
SELECT patch, champion_id, position, kind, choice,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins,
       avg(pos)::float8 AS avg_pos
FROM stats_participant_choices
GROUP BY patch, champion_id, position, kind, choice;
CREATE UNIQUE INDEX stats_choices_0030_pk
  ON stats_choices_0030 (patch, champion_id, position, kind, choice);

CREATE MATERIALIZED VIEW stats_choice_matchups_0030 AS
SELECT c.patch, c.champion_id, c.position, o.position AS opponent_position, o.champion_id AS opponent_id,
       c.kind, c.choice, count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices c
JOIN stats_participants o
  ON o.match_id = c.match_id AND o.team_id <> c.team_id
 AND (o.position = c.position
      OR (c.position IN ('BOTTOM', 'UTILITY') AND o.position IN ('BOTTOM', 'UTILITY')))
WHERE c.kind IN ('keystone', 'spells', 'starter', 'boots', 'item', 'skill_max', 'skill_first3',
                 'quest_item', 'items_done')
GROUP BY c.patch, c.champion_id, c.position, o.position, o.champion_id, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_matchups_0030_pk
  ON stats_choice_matchups_0030 (patch, champion_id, position, opponent_id, opponent_position, kind, choice);

-- The enemy traits of a choice's participant: the traits of the other team of the match.
CREATE MATERIALIZED VIEW stats_choice_traits_0030 AS
SELECT c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice,
       count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices c
JOIN stats_team_traits et ON et.match_id = c.match_id AND et.team_id <> c.team_id
CROSS JOIN LATERAL unnest(et.traits) AS t(trait)
WHERE c.kind IN ('keystone', 'spells', 'boots', 'item', 'quest_item', 'items_done')
GROUP BY c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_traits_0030_pk
  ON stats_choice_traits_0030 (patch, champion_id, position, trait, kind, choice);

CREATE MATERIALIZED VIEW stats_choice_duos_0030 AS
SELECT sp.patch, sp.champion_id, sp.position, o.position AS partner_position,
       o.champion_id AS partner_id, x.kind, x.choice,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participants sp
JOIN stats_participants o
  ON o.match_id = sp.match_id AND o.team_id = sp.team_id AND o.participant_id <> sp.participant_id
 AND (sp.position, o.position) IN (
   ('TOP', 'JUNGLE'), ('JUNGLE', 'TOP'), ('JUNGLE', 'MIDDLE'), ('MIDDLE', 'JUNGLE'),
   ('BOTTOM', 'UTILITY'), ('UTILITY', 'BOTTOM'))
CROSS JOIN LATERAL (
  SELECT 'item'::text AS kind, i.item_id::text AS choice FROM unnest(sp.core) AS i(item_id)
  UNION ALL
  SELECT 'items_done', COALESCE(cardinality(sp.core), 0)::text
) x
GROUP BY sp.patch, sp.champion_id, sp.position, o.position, o.champion_id, x.kind, x.choice;
CREATE UNIQUE INDEX stats_choice_duos_0030_pk
  ON stats_choice_duos_0030 (patch, champion_id, position, partner_id, partner_position, kind, choice);

CREATE MATERIALIZED VIEW stats_choice_ally_traits_0030 AS
SELECT sp.patch, sp.champion_id, sp.position, t.trait, x.kind, x.choice,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participant_traits sp
CROSS JOIN LATERAL unnest(sp.ally_traits) AS t(trait)
CROSS JOIN LATERAL (
  SELECT 'item'::text AS kind, i.item_id::text AS choice FROM unnest(sp.core) AS i(item_id)
  UNION ALL
  SELECT 'items_done', COALESCE(cardinality(sp.core), 0)::text
) x
GROUP BY sp.patch, sp.champion_id, sp.position, t.trait, x.kind, x.choice;
CREATE UNIQUE INDEX stats_choice_ally_traits_0030_pk
  ON stats_choice_ally_traits_0030 (patch, champion_id, position, trait, kind, choice);

-- stats_champion_lane_phase (0010_lane_phase.sql): the same averages, the lanes read from
-- stats_lanes instead of regrouped from participants.
CREATE MATERIALIZED VIEW stats_champion_lane_phase_0030 AS
WITH sides AS (
  SELECT patch, blue_ids AS own_ids, blue_positions AS own_positions, red_ids AS enemy_ids,
         red_positions AS enemy_positions, has_15,
         gold_10::bigint AS gold_10, xp_10::bigint AS xp_10, cs_10::bigint AS cs_10,
         gold_15::bigint AS gold_15, xp_15::bigint AS xp_15, cs_15::bigint AS cs_15
  FROM stats_lanes
  UNION ALL
  SELECT patch, red_ids, red_positions, blue_ids, blue_positions, has_15,
         -(gold_10::bigint), -(xp_10::bigint), -(cs_10::bigint),
         -(gold_15::bigint), -(xp_15::bigint), -(cs_15::bigint)
  FROM stats_lanes
)
SELECT
  s.patch, own.position, own.champion_id, enemy.position AS enemy_position,
  enemy.champion_id AS enemy_id,
  count(*)::int AS games,
  avg(s.gold_10)::float8 AS gold_diff_10,
  avg(s.xp_10)::float8 AS xp_diff_10,
  avg(s.cs_10)::float8 AS cs_diff_10,
  count(*) FILTER (WHERE s.has_15)::int AS games_15,
  (avg(s.gold_15) FILTER (WHERE s.has_15))::float8 AS gold_diff_15,
  (avg(s.xp_15) FILTER (WHERE s.has_15))::float8 AS xp_diff_15,
  (avg(s.cs_15) FILTER (WHERE s.has_15))::float8 AS cs_diff_15
FROM sides s
CROSS JOIN LATERAL unnest(s.own_ids, s.own_positions) AS own(champion_id, position)
CROSS JOIN LATERAL unnest(s.enemy_ids, s.enemy_positions) AS enemy(champion_id, position)
GROUP BY s.patch, own.position, own.champion_id, enemy.position, enemy.champion_id;
CREATE UNIQUE INDEX stats_champion_lane_phase_0030_pk
  ON stats_champion_lane_phase_0030 (patch, position, enemy_id, enemy_position, champion_id);
CREATE INDEX stats_champion_lane_phase_0030_champion
  ON stats_champion_lane_phase_0030 (patch, champion_id, position);

-- stats_item_swaps (0022_item_swaps.sql): the same counts, from stats_participant_swaps.
CREATE MATERIALIZED VIEW stats_item_swaps_0030 AS
SELECT patch, position, champion_id, sold_item_id, bought_item_id,
       count(*)::int AS games,
       (sum(at_ms)::numeric / 60000)::float8 AS minute_sum
FROM stats_participant_swaps
GROUP BY patch, position, champion_id, sold_item_id, bought_item_id;
CREATE UNIQUE INDEX stats_item_swaps_0030_pk
  ON stats_item_swaps_0030 (patch, position, champion_id, sold_item_id, bought_item_id);

-- ---------------------------------------------------------------------------
-- The switch: readers are blocked from here to the end of the transaction (moments).
-- ---------------------------------------------------------------------------

DROP MATERIALIZED VIEW stats_item_swaps, stats_champion_lane_phase;
DROP MATERIALIZED VIEW stats_choices, stats_choice_matchups, stats_choice_traits,
  stats_choice_duos, stats_choice_ally_traits;
DROP VIEW stats_participant_choices_old;
DROP MATERIALIZED VIEW stats_champion_roles, stats_champion_vs, stats_champion_with,
  stats_champion_comp_traits;
DROP MATERIALIZED VIEW stats_quest_items_old;
DROP MATERIALIZED VIEW stats_participants_old;

ALTER MATERIALIZED VIEW stats_champion_roles_0030 RENAME TO stats_champion_roles;
ALTER INDEX stats_champion_roles_0030_pk RENAME TO stats_champion_roles_pk;
ALTER MATERIALIZED VIEW stats_champion_vs_0030 RENAME TO stats_champion_vs;
ALTER INDEX stats_champion_vs_0030_pk RENAME TO stats_champion_vs_pk;
ALTER INDEX stats_champion_vs_0030_champion RENAME TO stats_champion_vs_champion;
ALTER MATERIALIZED VIEW stats_champion_with_0030 RENAME TO stats_champion_with;
ALTER INDEX stats_champion_with_0030_pk RENAME TO stats_champion_with_pk;
ALTER INDEX stats_champion_with_0030_champion RENAME TO stats_champion_with_champion;
ALTER MATERIALIZED VIEW stats_champion_comp_traits_0030 RENAME TO stats_champion_comp_traits;
ALTER INDEX stats_champion_comp_traits_0030_pk RENAME TO stats_champion_comp_traits_pk;
ALTER MATERIALIZED VIEW stats_choices_0030 RENAME TO stats_choices;
ALTER INDEX stats_choices_0030_pk RENAME TO stats_choices_pk;
ALTER MATERIALIZED VIEW stats_choice_matchups_0030 RENAME TO stats_choice_matchups;
ALTER INDEX stats_choice_matchups_0030_pk RENAME TO stats_choice_matchups_pk;
ALTER MATERIALIZED VIEW stats_choice_traits_0030 RENAME TO stats_choice_traits;
ALTER INDEX stats_choice_traits_0030_pk RENAME TO stats_choice_traits_pk;
ALTER MATERIALIZED VIEW stats_choice_duos_0030 RENAME TO stats_choice_duos;
ALTER INDEX stats_choice_duos_0030_pk RENAME TO stats_choice_duos_pk;
ALTER MATERIALIZED VIEW stats_choice_ally_traits_0030 RENAME TO stats_choice_ally_traits;
ALTER INDEX stats_choice_ally_traits_0030_pk RENAME TO stats_choice_ally_traits_pk;
ALTER MATERIALIZED VIEW stats_champion_lane_phase_0030 RENAME TO stats_champion_lane_phase;
ALTER INDEX stats_champion_lane_phase_0030_pk RENAME TO stats_champion_lane_phase_pk;
ALTER INDEX stats_champion_lane_phase_0030_champion RENAME TO stats_champion_lane_phase_champion;
ALTER MATERIALIZED VIEW stats_item_swaps_0030 RENAME TO stats_item_swaps;
ALTER INDEX stats_item_swaps_0030_pk RENAME TO stats_item_swaps_pk;
