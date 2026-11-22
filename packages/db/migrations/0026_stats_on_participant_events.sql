-- The stats views read participant_events (0025) instead of item_events / skill_events, which are
-- dropped: stats_participants, stats_quest_items and stats_item_swaps are rewritten on the arrays
-- with the same columns and the same values, and every view built on stats_participants is
-- recreated unchanged (a materialized view's query cannot be altered).
--
-- stats_participants was 31 of the 43 minutes of a refresh at 442k matches: it sorted and hashed
-- the 105 million item events and the 64 million skill events as sets (the purchases without their
-- undone ones, the first purchase of each item, the builds, the skill orders: 14 GB of temporary
-- files). It now computes each participant's build from that participant's own row, in two short
-- passes over its item arrays (a few dozen elements): nothing about the events is sorted, hashed
-- or joined as a whole, and the time grows with the number of participants only.
--
-- Old views stay readable until the end: an API of the previous version keeps serving requests
-- while this runs (as long as a refresh of all these views). The new views are built next to the
-- old ones under temporary names (*_0026); the last statements drop the old ones with the two
-- event tables and give the new views and their indexes the final names, so readers wait for
-- moments only. A fresh database goes through the same statements with empty tables.
--
-- Built serially: parallel hash joins live in /dev/shm (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

-- The final statements take the old views away from requests that may be reading two of them in
-- one query. Should that ever deadlock, the request must be the one that fails and is retried,
-- not this transaction: it is the one that notices the deadlock, long before this one looks.
-- (deadlock_timeout can only be set by a superuser: without the right, the default stays.)
DO $$
BEGIN
  SET LOCAL deadlock_timeout = '10min';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END
$$;

-- The event tables are dropped below, and 0025 copied what they held when it ran. A worker of the
-- previous version started in between would have stored matches with their events in the old
-- tables only: refuse to go on rather than lose them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM matches
    WHERE fetched_at > (SELECT applied_at FROM schema_migrations WHERE version = '0025')
  ) THEN
    RAISE EXCEPTION 'matches were stored after migration 0025 copied the item and skill events: stop every worker, run "DROP TABLE participant_events; DELETE FROM schema_migrations WHERE version = ''0025'';" and start the new worker again (0025 then copies the events again)';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Positions (in the item arrays of participant_events) of the purchases taken back by an undo:
-- each undo of a purchase ('U' of an item) cancels the latest purchase ('P') of that item before
-- it that is not cancelled yet; an undo with no such purchase cancels nothing. Same result as the
-- running-balance replay of the previous stats_participants (0008). Only called for participants
-- with an undo.
CREATE FUNCTION pl_undone_purchases(types "char"[], ids integer[]) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  undone integer[] := '{}';
BEGIN
  FOR j IN 1..cardinality(ids) LOOP
    IF types[j] = 'U' AND ids[j] > 0 THEN
      FOR i IN REVERSE j - 1..1 LOOP
        IF types[i] = 'P' AND ids[i] = ids[j] AND NOT (i = ANY (undone)) THEN
          undone := undone || i;
          EXIT;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN undone;
END
$$;

-- pl_skill_max_order (0002_stats_views.sql) ran a query per call to sort its three abilities: at
-- one call per participant that was minutes of every refresh. Same result, without the query:
-- abilities sorted by the level of their 5th point (1000 without one), then by points (most
-- first), then by slot. Mirrored by apps/api/src/engine/skills.ts (skillMaxOrder).
CREATE OR REPLACE FUNCTION pl_skill_max_order(seq smallint[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  q integer[];
  w integer[];
  e integer[];
  q_before_w boolean;
  q_before_e boolean;
  w_before_e boolean;
BEGIN
  IF seq IS NULL OR cardinality(seq) < 9 THEN
    RETURN NULL;
  END IF;
  -- Levels (positions in seq) at which each ability got a point.
  q := array_positions(seq, 1::smallint);
  w := array_positions(seq, 2::smallint);
  e := array_positions(seq, 3::smallint);
  q_before_w := (COALESCE(q[5], 1000), -cardinality(q)) <= (COALESCE(w[5], 1000), -cardinality(w));
  q_before_e := (COALESCE(q[5], 1000), -cardinality(q)) <= (COALESCE(e[5], 1000), -cardinality(e));
  w_before_e := (COALESCE(w[5], 1000), -cardinality(w)) <= (COALESCE(e[5], 1000), -cardinality(e));
  IF q_before_w AND q_before_e THEN
    RETURN CASE WHEN w_before_e THEN '1,2,3' ELSE '1,3,2' END;
  ELSIF w_before_e AND NOT q_before_w THEN
    RETURN CASE WHEN q_before_e THEN '2,1,3' ELSE '2,3,1' END;
  ELSE
    RETURN CASE WHEN q_before_w THEN '3,1,2' ELSE '3,2,1' END;
  END IF;
END
$$;

-- pl_comp_traits (0002_stats_views.sql) was a SQL function the planner could not inline (its
-- arguments are computed arrays used seven times each), so every call started an executor of its
-- own, twice per participant. Same expression in PL/pgSQL, which evaluates it directly.
-- Mirrored by apps/api/src/engine/traits.ts (compTraits): keep both in sync.
CREATE OR REPLACE FUNCTION pl_comp_traits(v float8[], t float8[]) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN array_remove(ARRAY[
    CASE WHEN v[1] >= t[1] THEN 'AD_HEAVY' END,
    CASE WHEN v[2] >= t[2] THEN 'AP_HEAVY' END,
    CASE WHEN v[3] >= t[3] THEN 'HIGH_CC' END,
    CASE WHEN v[4] >= t[4] THEN 'HIGH_HEALING' END,
    CASE WHEN v[5] >= t[5] THEN 'TANKY' END,
    CASE WHEN v[6] >= t[6] THEN 'POKE_RANGED' END,
    CASE WHEN v[7] >= t[7] THEN 'MELEE_HEAVY' END
  ], NULL);
END
$$;

-- ---------------------------------------------------------------------------
-- stats_participants: one row per participant with a known position (intermediate).
-- ---------------------------------------------------------------------------
-- Same columns and values as 0008_deterministic_comp_traits.sql (rules of 0002_stats_views.sql).
--
-- item_flags (one row, computed once per refresh): what an item is on each patch, as one smallint
-- per (patch, item id) in a two-dimensional array, so that looking an item up is a subscript and
-- not a join. flags[n][id], n being the position of the patch in `patches`:
--   0 = no such item on that patch, else 1
--     + 2  completed (items.is_completed)
--     + 4  boots (items.is_boots)
--     + 8  never part of a build order: consumable or trinket
--     + 16 trinket (tag 'Trinket')
-- It is only read through scalar subqueries, which are evaluated once: joined as a table it would
-- be copied into every row (one smallint for every item id up to the largest one, per patch).
--
-- Per participant (`bu`), from its own participant_events row:
--   pass 1 (`first_pass`) over the item events: `flags` of an event is the item's flags when the
--     event is a purchase that was not undone, else 0. Sorted by item then position (one small
--     sort), it gives the starter (purchases of the first 60 s, trinkets excluded, by item id),
--     the kept purchases as three arrays in that order (`kept` item, `kept_ord` position,
--     `kept_flags`), the items bought in the first 60 s, and the positions of the first completed
--     item and of the first completed boots.
--   pass 2 (`second_pass`) over the kept purchases, first purchase of each item only (the first
--     one array_position finds: they are sorted by item then position), in purchase order: the
--     early items (not completed, first bought after 60 s and before the first completed item),
--     the completed items, and how many of them came before the boots.
CREATE MATERIALIZED VIEW stats_participants_0026 AS
WITH item_flags AS MATERIALIZED (
  SELECT array_agg(per_patch.patch ORDER BY per_patch.patch) AS patches,
         array_agg(per_patch.flags ORDER BY per_patch.patch) AS flags
  FROM (
    SELECT pt.patch, (
      SELECT array_agg(COALESCE(i.flags, 0)::smallint ORDER BY n.id)
      FROM generate_series(1, (SELECT max(id) FROM items)) AS n(id)
      LEFT JOIN (
        SELECT id,
               1 + (CASE WHEN is_completed THEN 2 ELSE 0 END)
                 + (CASE WHEN is_boots THEN 4 ELSE 0 END)
                 + (CASE WHEN is_consumable OR 'Trinket' = ANY (tags) THEN 8 ELSE 0 END)
                 + (CASE WHEN 'Trinket' = ANY (tags) THEN 16 ELSE 0 END) AS flags
        FROM items
        WHERE patch = pt.patch
      ) i ON i.id = n.id
    ) AS flags
    FROM (SELECT DISTINCT patch FROM items) pt
  ) per_patch
)
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
  CASE WHEN cardinality(sk.seq) >= 9 THEN array_to_string(sk.seq, ',') END AS skill_seq,
  COALESCE(pl_comp_traits(
    ARRAY[opp.physical_share / opp.champions, opp.magic_share / opp.champions,
          opp.cc_per_min / opp.champions, opp.healing_per_min / opp.champions,
          opp.tankiness_per_min / opp.champions, opp.ranged / opp.champions,
          1 - opp.ranged / opp.champions],
    ARRAY[th.physical_share, th.magic_share, th.cc_per_min, th.healing_per_min,
          th.tankiness_per_min, th.ranged, th.melee]
  ), '{}') AS enemy_traits,
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
FROM participants p
JOIN matches m ON m.id = p.match_id
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
             THEN COALESCE(((SELECT f.flags FROM item_flags f))[c.patch_idx][pe.item_ids[g.ord]], 0)
             ELSE 0
        END AS flags
      FROM (
        -- Once per participant: its patch in item_flags, and its undone purchases.
        SELECT
          array_position((SELECT f.patches FROM item_flags f), m.patch) AS patch_idx,
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
LEFT JOIN stats_team_comp own ON own.match_id = p.match_id AND own.team_id = p.team_id
LEFT JOIN stats_team_comp opp ON opp.match_id = p.match_id AND opp.team_id <> p.team_id
LEFT JOIN stats_champion_traits ct ON ct.patch = m.patch AND ct.champion_id = p.champion_id
LEFT JOIN stats_comp_thresholds th ON th.patch = m.patch
WHERE NOT m.is_remake AND p.position IS NOT NULL;
CREATE UNIQUE INDEX stats_participants_0026_pk
  ON stats_participants_0026 (match_id, participant_id);
ANALYZE stats_participants_0026;

-- ---------------------------------------------------------------------------
-- stats_quest_items: the support quest upgrade of a participant (intermediate).
-- ---------------------------------------------------------------------------
-- Same rows as 0007_support_quest_items.sql: the upgrade in the end-of-game inventory, else the
-- last purchase of one. The purchase is now found in the participant's own row: only rows whose
-- items overlap the patch's upgrades (a handful of ids) are looked into.
CREATE MATERIALIZED VIEW stats_quest_items_0026 AS
WITH upgrades AS (
  SELECT patch, id
  FROM items
  WHERE NOT is_completed AND NOT is_consumable AND NOT is_boots AND 'GoldPer' = ANY (tags)
    AND cardinality(builds_from) > 0 AND cardinality(builds_into) = 0
),
upgrade_ids AS (
  SELECT patch, array_agg(id) AS ids FROM upgrades GROUP BY patch
),
from_inventory AS (
  SELECT DISTINCT ON (p.match_id, p.participant_id) p.match_id, p.participant_id, f.item_id
  FROM participants p
  JOIN matches m ON m.id = p.match_id
  CROSS JOIN LATERAL unnest(p.final_items) WITH ORDINALITY AS f(item_id, slot)
  JOIN upgrades u ON u.patch = m.patch AND u.id = f.item_id
  WHERE NOT m.is_remake
  ORDER BY p.match_id, p.participant_id, f.slot
),
from_events AS (
  SELECT pe.match_id, pe.participant_id, pe.item_ids[last_purchase.ord] AS item_id
  FROM participant_events pe
  JOIN matches m ON m.id = pe.match_id
  JOIN upgrade_ids u ON u.patch = m.patch
  CROSS JOIN LATERAL (
    SELECT max(g.ord) AS ord
    FROM (SELECT generate_series(1, cardinality(pe.item_ids)) AS ord) g
    WHERE pe.item_types[g.ord] = 'P' AND pe.item_ids[g.ord] = ANY (u.ids)
  ) last_purchase
  WHERE NOT m.is_remake AND pe.item_ids && u.ids AND last_purchase.ord IS NOT NULL
)
SELECT match_id, participant_id, item_id FROM from_inventory
UNION ALL
SELECT ev.match_id, ev.participant_id, ev.item_id
FROM from_events ev
WHERE NOT EXISTS (
  SELECT 1 FROM from_inventory i
  WHERE i.match_id = ev.match_id AND i.participant_id = ev.participant_id
);
CREATE UNIQUE INDEX stats_quest_items_0026_pk
  ON stats_quest_items_0026 (match_id, participant_id);
ANALYZE stats_quest_items_0026;

-- ---------------------------------------------------------------------------
-- Views built on stats_participants: definitions of 0008_deterministic_comp_traits.sql and
-- 0015_items_done.sql, unchanged.
-- ---------------------------------------------------------------------------

CREATE VIEW stats_participant_choices_0026 AS
SELECT sp.patch, sp.match_id, sp.participant_id, sp.team_id, sp.champion_id, sp.position, sp.win,
       sp.enemy_traits, c.kind, c.choice, c.pos
FROM stats_participants_0026 sp
LEFT JOIN stats_quest_items_0026 q ON q.match_id = sp.match_id AND q.participant_id = sp.participant_id
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

CREATE MATERIALIZED VIEW stats_champion_roles_0026 AS
SELECT patch, champion_id, position,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins
FROM stats_participants_0026
GROUP BY patch, champion_id, position;
CREATE UNIQUE INDEX stats_champion_roles_0026_pk
  ON stats_champion_roles_0026 (patch, champion_id, position);

CREATE MATERIALIZED VIEW stats_champion_vs_0026 AS
SELECT a.patch, a.position, a.champion_id, b.position AS enemy_position, b.champion_id AS enemy_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_participants_0026 a
JOIN stats_participants_0026 b ON b.match_id = a.match_id AND b.team_id <> a.team_id
GROUP BY a.patch, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_champion_vs_0026_pk
  ON stats_champion_vs_0026 (patch, position, enemy_id, enemy_position, champion_id);
CREATE INDEX stats_champion_vs_0026_champion ON stats_champion_vs_0026 (patch, champion_id, position);

CREATE MATERIALIZED VIEW stats_champion_with_0026 AS
SELECT a.patch, a.position, a.champion_id, b.position AS ally_position, b.champion_id AS ally_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_participants_0026 a
JOIN stats_participants_0026 b
  ON b.match_id = a.match_id AND b.team_id = a.team_id AND b.participant_id <> a.participant_id
GROUP BY a.patch, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_champion_with_0026_pk
  ON stats_champion_with_0026 (patch, position, ally_id, ally_position, champion_id);
CREATE INDEX stats_champion_with_0026_champion ON stats_champion_with_0026 (patch, champion_id, position);

CREATE MATERIALIZED VIEW stats_champion_comp_traits_0026 AS
SELECT sp.patch, sp.position, sp.champion_id, t.side, t.trait,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participants_0026 sp
CROSS JOIN LATERAL (
  SELECT 'enemy'::text AS side, unnest(sp.enemy_traits) AS trait
  UNION ALL
  SELECT 'ally'::text, unnest(sp.ally_traits)
) t
GROUP BY sp.patch, sp.position, sp.champion_id, t.side, t.trait;
CREATE UNIQUE INDEX stats_champion_comp_traits_0026_pk
  ON stats_champion_comp_traits_0026 (patch, position, champion_id, side, trait);

CREATE MATERIALIZED VIEW stats_choices_0026 AS
SELECT patch, champion_id, position, kind, choice,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins,
       avg(pos)::float8 AS avg_pos
FROM stats_participant_choices_0026
GROUP BY patch, champion_id, position, kind, choice;
CREATE UNIQUE INDEX stats_choices_0026_pk
  ON stats_choices_0026 (patch, champion_id, position, kind, choice);

CREATE MATERIALIZED VIEW stats_choice_matchups_0026 AS
SELECT c.patch, c.champion_id, c.position, o.position AS opponent_position, o.champion_id AS opponent_id,
       c.kind, c.choice, count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices_0026 c
JOIN stats_participants_0026 o
  ON o.match_id = c.match_id AND o.team_id <> c.team_id
 AND (o.position = c.position
      OR (c.position IN ('BOTTOM', 'UTILITY') AND o.position IN ('BOTTOM', 'UTILITY')))
WHERE c.kind IN ('keystone', 'spells', 'starter', 'boots', 'item', 'skill_max', 'skill_first3',
                 'quest_item', 'items_done')
GROUP BY c.patch, c.champion_id, c.position, o.position, o.champion_id, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_matchups_0026_pk
  ON stats_choice_matchups_0026 (patch, champion_id, position, opponent_id, opponent_position, kind, choice);

CREATE MATERIALIZED VIEW stats_choice_traits_0026 AS
SELECT c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice,
       count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices_0026 c
CROSS JOIN LATERAL unnest(c.enemy_traits) AS t(trait)
WHERE c.kind IN ('keystone', 'spells', 'boots', 'item', 'quest_item', 'items_done')
GROUP BY c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_traits_0026_pk
  ON stats_choice_traits_0026 (patch, champion_id, position, trait, kind, choice);

CREATE MATERIALIZED VIEW stats_choice_duos_0026 AS
SELECT sp.patch, sp.champion_id, sp.position, o.position AS partner_position,
       o.champion_id AS partner_id, x.kind, x.choice,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participants_0026 sp
JOIN stats_participants_0026 o
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
CREATE UNIQUE INDEX stats_choice_duos_0026_pk
  ON stats_choice_duos_0026 (patch, champion_id, position, partner_id, partner_position, kind, choice);

CREATE MATERIALIZED VIEW stats_choice_ally_traits_0026 AS
SELECT sp.patch, sp.champion_id, sp.position, t.trait, x.kind, x.choice,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participants_0026 sp
CROSS JOIN LATERAL unnest(sp.ally_traits) AS t(trait)
CROSS JOIN LATERAL (
  SELECT 'item'::text AS kind, i.item_id::text AS choice FROM unnest(sp.core) AS i(item_id)
  UNION ALL
  SELECT 'items_done', COALESCE(cardinality(sp.core), 0)::text
) x
GROUP BY sp.patch, sp.champion_id, sp.position, t.trait, x.kind, x.choice;
CREATE UNIQUE INDEX stats_choice_ally_traits_0026_pk
  ON stats_choice_ally_traits_0026 (patch, champion_id, position, trait, kind, choice);

-- ---------------------------------------------------------------------------
-- stats_item_swaps: late-game swaps (served).
-- ---------------------------------------------------------------------------
-- Same rules and rows as 0022_item_swaps.sql, read from the participant's own arrays: event i is
-- a sale ('S'), event i + 1 the purchase ('P') of another item at most 60 s later, event i + 2 is
-- not the undo of that purchase ('U' of the same item; the undo of a sale, 'u', takes back no
-- purchase), both items are completed on the match's patch and at least 6 distinct completed
-- items were purchased before the sale. Only participants with a sale are looked into.
CREATE MATERIALIZED VIEW stats_item_swaps_0026 AS
WITH completed AS (
  SELECT patch, array_agg(id) AS item_ids FROM items WHERE is_completed GROUP BY patch
),
-- Sales followed within 60 s by the purchase of another item that is not undone right after.
candidates AS (
  SELECT pe.match_id, pe.participant_id, pe.item_types, pe.item_ids, s.ord,
         pe.item_at_ms[s.ord] AS at_ms,
         pe.item_ids[s.ord] AS sold_item_id,
         pe.item_ids[s.ord + 1] AS bought_item_id
  FROM participant_events pe
  CROSS JOIN LATERAL (SELECT generate_series(1, cardinality(pe.item_ids) - 1) AS ord) s
  WHERE 'S' = ANY (pe.item_types)
    AND pe.item_types[s.ord] = 'S'
    AND pe.item_types[s.ord + 1] = 'P'
    AND pe.item_ids[s.ord + 1] <> pe.item_ids[s.ord]
    AND pe.item_at_ms[s.ord + 1] - pe.item_at_ms[s.ord] <= 60000
    AND (pe.item_types[s.ord + 2] IS DISTINCT FROM 'U'
         OR pe.item_ids[s.ord + 2] IS DISTINCT FROM pe.item_ids[s.ord + 1])
),
-- Both items completed on the match's patch and a full build before the sale; one row per
-- participant and pair (the first time they made it).
swaps AS (
  SELECT tp.patch, tp.position, tp.champion_id, k.match_id, k.participant_id,
         k.sold_item_id, k.bought_item_id, min(k.at_ms) AS at_ms
  FROM candidates k
  JOIN stats_tierlist_participants tp
    ON tp.match_id = k.match_id AND tp.participant_id = k.participant_id
  JOIN completed c ON c.patch = tp.patch
  WHERE tp.position IS NOT NULL
    AND k.sold_item_id = ANY (c.item_ids)
    AND k.bought_item_id = ANY (c.item_ids)
    AND (
      SELECT count(DISTINCT k.item_ids[b.ord])
      FROM generate_series(1, k.ord - 1) AS b(ord)
      WHERE k.item_types[b.ord] = 'P' AND k.item_ids[b.ord] = ANY (c.item_ids)
    ) >= 6
  GROUP BY tp.patch, tp.position, tp.champion_id, k.match_id, k.participant_id,
           k.sold_item_id, k.bought_item_id
)
SELECT patch, position, champion_id, sold_item_id, bought_item_id,
       count(*)::int AS games,
       (sum(at_ms)::numeric / 60000)::float8 AS minute_sum
FROM swaps
GROUP BY patch, position, champion_id, sold_item_id, bought_item_id;
CREATE UNIQUE INDEX stats_item_swaps_0026_pk
  ON stats_item_swaps_0026 (patch, position, champion_id, sold_item_id, bought_item_id);

-- ---------------------------------------------------------------------------
-- The switch: readers are blocked from here to the end of the transaction (moments).
-- ---------------------------------------------------------------------------

DROP MATERIALIZED VIEW stats_item_swaps;
DROP MATERIALIZED VIEW stats_choices, stats_choice_matchups, stats_choice_traits,
  stats_choice_duos, stats_choice_ally_traits;
DROP VIEW stats_participant_choices;
DROP MATERIALIZED VIEW stats_champion_roles, stats_champion_vs, stats_champion_with,
  stats_champion_comp_traits;
DROP MATERIALIZED VIEW stats_quest_items;
DROP MATERIALIZED VIEW stats_participants;

-- Nothing reads the event tables any more (the worker writes participant_events).
DROP TABLE item_events;
DROP TABLE skill_events;
DROP TYPE item_event_type;

ALTER MATERIALIZED VIEW stats_participants_0026 RENAME TO stats_participants;
ALTER INDEX stats_participants_0026_pk RENAME TO stats_participants_pk;
ALTER MATERIALIZED VIEW stats_quest_items_0026 RENAME TO stats_quest_items;
ALTER INDEX stats_quest_items_0026_pk RENAME TO stats_quest_items_pk;
ALTER VIEW stats_participant_choices_0026 RENAME TO stats_participant_choices;
ALTER MATERIALIZED VIEW stats_champion_roles_0026 RENAME TO stats_champion_roles;
ALTER INDEX stats_champion_roles_0026_pk RENAME TO stats_champion_roles_pk;
ALTER MATERIALIZED VIEW stats_champion_vs_0026 RENAME TO stats_champion_vs;
ALTER INDEX stats_champion_vs_0026_pk RENAME TO stats_champion_vs_pk;
ALTER INDEX stats_champion_vs_0026_champion RENAME TO stats_champion_vs_champion;
ALTER MATERIALIZED VIEW stats_champion_with_0026 RENAME TO stats_champion_with;
ALTER INDEX stats_champion_with_0026_pk RENAME TO stats_champion_with_pk;
ALTER INDEX stats_champion_with_0026_champion RENAME TO stats_champion_with_champion;
ALTER MATERIALIZED VIEW stats_champion_comp_traits_0026 RENAME TO stats_champion_comp_traits;
ALTER INDEX stats_champion_comp_traits_0026_pk RENAME TO stats_champion_comp_traits_pk;
ALTER MATERIALIZED VIEW stats_choices_0026 RENAME TO stats_choices;
ALTER INDEX stats_choices_0026_pk RENAME TO stats_choices_pk;
ALTER MATERIALIZED VIEW stats_choice_matchups_0026 RENAME TO stats_choice_matchups;
ALTER INDEX stats_choice_matchups_0026_pk RENAME TO stats_choice_matchups_pk;
ALTER MATERIALIZED VIEW stats_choice_traits_0026 RENAME TO stats_choice_traits;
ALTER INDEX stats_choice_traits_0026_pk RENAME TO stats_choice_traits_pk;
ALTER MATERIALIZED VIEW stats_choice_duos_0026 RENAME TO stats_choice_duos;
ALTER INDEX stats_choice_duos_0026_pk RENAME TO stats_choice_duos_pk;
ALTER MATERIALIZED VIEW stats_choice_ally_traits_0026 RENAME TO stats_choice_ally_traits;
ALTER INDEX stats_choice_ally_traits_0026_pk RENAME TO stats_choice_ally_traits_pk;
ALTER MATERIALIZED VIEW stats_item_swaps_0026 RENAME TO stats_item_swaps;
ALTER INDEX stats_item_swaps_0026_pk RENAME TO stats_item_swaps_pk;
