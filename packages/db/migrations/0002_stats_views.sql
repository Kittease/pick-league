-- Stats layer owned by apps/api: materialized views the recommendation engine reads.
-- Everything is keyed by patch and excludes remakes. Refreshed by the API (apps/api/src/stats/refresh.ts)
-- in the order of STATS_REFRESH_ORDER; "served" views have a unique index so they can be
-- refreshed CONCURRENTLY without blocking readers, intermediate ones are refreshed plainly.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Composition traits of a team from its mean champion profile.
-- v and t = [physical_share, magic_share, cc_per_min, healing_per_min, tankiness_per_min, ranged, melee]
-- (team means, and the patch's 75th percentile of 5-champion team means).
-- Mirrored by apps/api/src/engine/traits.ts (compTraits): keep both in sync.
CREATE FUNCTION pl_comp_traits(v float8[], t float8[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN v[1] >= t[1] THEN 'AD_HEAVY' END,
    CASE WHEN v[2] >= t[2] THEN 'AP_HEAVY' END,
    CASE WHEN v[3] >= t[3] THEN 'HIGH_CC' END,
    CASE WHEN v[4] >= t[4] THEN 'HIGH_HEALING' END,
    CASE WHEN v[5] >= t[5] THEN 'TANKY' END,
    CASE WHEN v[6] >= t[6] THEN 'POKE_RANGED' END,
    CASE WHEN v[7] >= t[7] THEN 'MELEE_HEAVY' END
  ], NULL)
$$;

-- Basic-ability max order from a skill-point sequence (1=Q 2=W 3=E 4=R): abilities sorted by the
-- level at which they got their 5th point, then by points. NULL below 9 points.
-- Mirrored by apps/api/src/engine/skills.ts (skillMaxOrder).
CREATE FUNCTION pl_skill_max_order(seq smallint[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  cnt int[] := ARRAY[0, 0, 0];
  fifth int[] := ARRAY[1000, 1000, 1000];
  s int;
BEGIN
  IF seq IS NULL OR cardinality(seq) < 9 THEN
    RETURN NULL;
  END IF;
  FOR i IN 1..cardinality(seq) LOOP
    s := seq[i];
    IF s BETWEEN 1 AND 3 THEN
      cnt[s] := cnt[s] + 1;
      IF cnt[s] = 5 THEN
        fifth[s] := i;
      END IF;
    END IF;
  END LOOP;
  RETURN (SELECT string_agg(x::text, ',' ORDER BY fifth[x], cnt[x] DESC, x) FROM generate_series(1, 3) x);
END
$$;

-- ---------------------------------------------------------------------------
-- Champion trait profiles (served): what a champion brings to a team composition.
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW stats_champion_traits AS
SELECT
  m.patch,
  p.champion_id,
  count(*)::int AS games,
  COALESCE(sum(p.physical_damage_to_champions)::float8 / NULLIF(sum(p.damage_to_champions), 0), 0) AS physical_share,
  COALESCE(sum(p.magic_damage_to_champions)::float8 / NULLIF(sum(p.damage_to_champions), 0), 0) AS magic_share,
  COALESCE(sum(p.true_damage_to_champions)::float8 / NULLIF(sum(p.damage_to_champions), 0), 0) AS true_share,
  COALESCE(sum(p.damage_to_champions)::float8 / NULLIF(sum(m.duration_s) / 60.0, 0), 0) AS damage_per_min,
  COALESCE(sum(p.cc_time_on_others_s)::float8 / NULLIF(sum(m.duration_s) / 60.0, 0), 0) AS cc_per_min,
  COALESCE(sum(p.healing_done)::float8 / NULLIF(sum(m.duration_s) / 60.0, 0), 0) AS healing_per_min,
  COALESCE(sum(p.damage_taken::bigint + p.damage_self_mitigated)::float8 / NULLIF(sum(m.duration_s) / 60.0, 0), 0) AS tankiness_per_min,
  COALESCE(max(c.attack_range), 0)::int AS attack_range,
  COALESCE(max(c.attack_range), 0) >= 300 AS is_ranged
FROM participants p
JOIN matches m ON m.id = p.match_id
LEFT JOIN champions c ON c.patch = m.patch AND c.id = p.champion_id
WHERE NOT m.is_remake
GROUP BY m.patch, p.champion_id;
CREATE UNIQUE INDEX stats_champion_traits_pk ON stats_champion_traits (patch, champion_id);

-- ---------------------------------------------------------------------------
-- Team composition sums per (match, team) (intermediate).
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW stats_team_comp AS
SELECT
  m.patch,
  p.match_id,
  p.team_id,
  count(*)::int AS champions,
  sum(t.physical_share) AS physical_share,
  sum(t.magic_share) AS magic_share,
  sum(t.cc_per_min) AS cc_per_min,
  sum(t.healing_per_min) AS healing_per_min,
  sum(t.tankiness_per_min) AS tankiness_per_min,
  sum(CASE WHEN t.is_ranged THEN 1 ELSE 0 END)::float8 AS ranged
FROM participants p
JOIN matches m ON m.id = p.match_id
JOIN stats_champion_traits t ON t.patch = m.patch AND t.champion_id = p.champion_id
WHERE NOT m.is_remake
GROUP BY m.patch, p.match_id, p.team_id;
CREATE UNIQUE INDEX stats_team_comp_pk ON stats_team_comp (match_id, team_id);

-- Trait thresholds per patch (served): 75th percentile of 5-champion team means.
CREATE MATERIALIZED VIEW stats_comp_thresholds AS
SELECT
  patch,
  count(*)::int AS teams,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY physical_share / champions) AS physical_share,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY magic_share / champions) AS magic_share,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY cc_per_min / champions) AS cc_per_min,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY healing_per_min / champions) AS healing_per_min,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY tankiness_per_min / champions) AS tankiness_per_min,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY ranged / champions) AS ranged,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY 1 - ranged / champions) AS melee
FROM stats_team_comp
WHERE champions = 5
GROUP BY patch;
CREATE UNIQUE INDEX stats_comp_thresholds_pk ON stats_comp_thresholds (patch);

-- ---------------------------------------------------------------------------
-- One row per participant with a known position (intermediate): derived build, runes, spells,
-- skill order and the traits of both compositions.
--
-- Item purchases are replayed with UNDO: per (participant, item), PURCHASED = +1 and UNDO = -1 in
-- seq order; a purchase is undone when the running balance later drops below its own level
-- (stack matching). Starter = purchases in the first 60 s (trinkets excluded). Consumables and
-- trinkets are ignored elsewhere; core = first 6 distinct completed non-boots items in buy order;
-- early = distinct components first bought after 60 s and before the first completed item;
-- boots = first completed boots, boots_pos = completed items bought before them.
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW stats_participants AS
WITH base AS (
  SELECT
    m.patch, p.match_id, p.participant_id, p.team_id, p.champion_id, p.position, p.win,
    p.summoner_spell_1, p.summoner_spell_2, p.rune_primary_tree, p.rune_secondary_tree,
    p.runes, p.stat_shards
  FROM participants p
  JOIN matches m ON m.id = p.match_id
  WHERE NOT m.is_remake AND p.position IS NOT NULL
),
-- Only (participant, item) groups that contain an UNDO need the stack replay.
undo_groups AS (
  SELECT DISTINCT match_id, participant_id, item_id
  FROM item_events
  WHERE type = 'UNDO' AND item_id > 0
),
undone AS (
  SELECT match_id, participant_id, seq
  FROM (
    SELECT
      x.*,
      min(x.balance) OVER (
        PARTITION BY x.match_id, x.participant_id, x.item_id ORDER BY x.seq
        ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
      ) AS min_after
    FROM (
      SELECT
        e.match_id, e.participant_id, e.item_id, e.seq, e.type,
        sum(CASE WHEN e.type = 'PURCHASED' THEN 1 ELSE -1 END)
          OVER (PARTITION BY e.match_id, e.participant_id, e.item_id ORDER BY e.seq) AS balance
      FROM item_events e
      JOIN undo_groups g
        ON g.match_id = e.match_id AND g.participant_id = e.participant_id AND g.item_id = e.item_id
      WHERE e.type IN ('PURCHASED', 'UNDO')
    ) x
  ) y
  WHERE type = 'PURCHASED' AND min_after < balance
),
-- match_id in the "C" collation: the per-participant sorts below compare bytes, not locale rules.
purchases AS (
  SELECT
    e.match_id COLLATE "C" AS match_id, e.participant_id, e.seq, e.at_ms, e.item_id,
    i.is_completed, i.is_boots, i.is_consumable, ('Trinket' = ANY (i.tags)) AS is_trinket
  FROM item_events e
  JOIN matches m ON m.id = e.match_id
  JOIN items i ON i.patch = m.patch AND i.id = e.item_id
  WHERE e.type = 'PURCHASED' AND NOT m.is_remake
    AND NOT EXISTS (
      SELECT 1 FROM undone u
      WHERE u.match_id = e.match_id AND u.participant_id = e.participant_id AND u.seq = e.seq
    )
),
starters AS (
  SELECT match_id, participant_id, array_agg(item_id ORDER BY item_id) AS starter
  FROM purchases
  WHERE at_ms <= 60000 AND NOT is_trinket
  GROUP BY match_id, participant_id
),
-- First purchase of each non-consumable item.
first_buys AS (
  SELECT match_id, participant_id, item_id, is_completed, is_boots,
         min(seq) AS seq, min(at_ms) AS at_ms
  FROM purchases
  WHERE NOT is_consumable AND NOT is_trinket
  GROUP BY match_id, participant_id, item_id, is_completed, is_boots
),
milestones AS (
  SELECT match_id, participant_id,
         min(seq) FILTER (WHERE is_completed AND NOT is_boots) AS first_completed_seq,
         min(seq) FILTER (WHERE is_completed AND is_boots) AS boots_seq
  FROM first_buys
  GROUP BY match_id, participant_id
),
builds AS (
  SELECT
    f.match_id, f.participant_id,
    array_agg(f.item_id ORDER BY f.seq) FILTER (
      WHERE NOT f.is_completed AND f.at_ms > 60000 AND f.seq < COALESCE(ms.first_completed_seq, 32767)
    ) AS early,
    (array_agg(f.item_id ORDER BY f.seq) FILTER (WHERE f.is_completed AND NOT f.is_boots))[1:6] AS core,
    min(f.item_id) FILTER (WHERE f.seq = ms.boots_seq) AS boots,
    CASE WHEN ms.boots_seq IS NOT NULL THEN
      (count(*) FILTER (WHERE f.is_completed AND NOT f.is_boots AND f.seq < ms.boots_seq))::int
    END AS boots_pos
  FROM first_buys f
  JOIN milestones ms ON ms.match_id = f.match_id AND ms.participant_id = f.participant_id
  GROUP BY f.match_id, f.participant_id, ms.first_completed_seq, ms.boots_seq
),
skills AS (
  SELECT match_id, participant_id, (array_agg(skill_slot ORDER BY seq))[1:18] AS seq
  FROM skill_events
  WHERE NOT is_evolve
  GROUP BY match_id, participant_id
)
SELECT
  b.patch, b.match_id, b.participant_id, b.team_id, b.champion_id, b.position, b.win,
  b.runes[1]::int AS keystone,
  concat_ws('|', b.rune_primary_tree, b.rune_secondary_tree,
    array_to_string(b.runes, ','), array_to_string(b.stat_shards, ',')) AS rune_page,
  least(b.summoner_spell_1, b.summoner_spell_2) || ',' || greatest(b.summoner_spell_1, b.summoner_spell_2) AS spells,
  NULLIF(array_to_string(st.starter, ','), '') AS starter,
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
FROM base b
LEFT JOIN builds bu ON bu.match_id = b.match_id COLLATE "C" AND bu.participant_id = b.participant_id
LEFT JOIN starters st ON st.match_id = b.match_id COLLATE "C" AND st.participant_id = b.participant_id
LEFT JOIN skills sk ON sk.match_id = b.match_id AND sk.participant_id = b.participant_id
LEFT JOIN stats_team_comp own ON own.match_id = b.match_id AND own.team_id = b.team_id
LEFT JOIN stats_team_comp opp ON opp.match_id = b.match_id AND opp.team_id <> b.team_id
LEFT JOIN stats_champion_traits ct ON ct.patch = b.patch AND ct.champion_id = b.champion_id
LEFT JOIN stats_comp_thresholds th ON th.patch = b.patch;
CREATE UNIQUE INDEX stats_participants_pk ON stats_participants (match_id, participant_id);

-- Every build/rune/spell/skill choice of a participant as (kind, choice key, position in order).
-- Plain view: only read by the refresh of the aggregates below.
CREATE VIEW stats_participant_choices AS
SELECT sp.patch, sp.match_id, sp.participant_id, sp.team_id, sp.champion_id, sp.position, sp.win,
       sp.enemy_traits, c.kind, c.choice, c.pos
FROM stats_participants sp
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
    ('skill_seq', sp.skill_seq, NULL::int)
  ) AS k(kind, choice, pos)
  UNION ALL
  SELECT 'item', i.item_id::text, i.ord::int FROM unnest(sp.core) WITH ORDINALITY AS i(item_id, ord)
  UNION ALL
  SELECT 'early_item', i.item_id::text, i.ord::int FROM unnest(sp.early) WITH ORDINALITY AS i(item_id, ord)
) c
WHERE c.choice IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Served aggregates.
-- ---------------------------------------------------------------------------

-- Champion + role baseline.
CREATE MATERIALIZED VIEW stats_champion_roles AS
SELECT patch, champion_id, position,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins
FROM stats_participants
GROUP BY patch, champion_id, position;
CREATE UNIQUE INDEX stats_champion_roles_pk ON stats_champion_roles (patch, champion_id, position);

-- Champion (in a role) vs. each enemy champion (in its role). Lane matchups = same position.
CREATE MATERIALIZED VIEW stats_champion_vs AS
SELECT a.patch, a.position, a.champion_id, b.position AS enemy_position, b.champion_id AS enemy_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_participants a
JOIN stats_participants b ON b.match_id = a.match_id AND b.team_id <> a.team_id
GROUP BY a.patch, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_champion_vs_pk
  ON stats_champion_vs (patch, position, enemy_id, enemy_position, champion_id);
CREATE INDEX stats_champion_vs_champion ON stats_champion_vs (patch, champion_id, position);

-- Champion (in a role) with each ally champion (in its role). Duo synergies are a subset.
CREATE MATERIALIZED VIEW stats_champion_with AS
SELECT a.patch, a.position, a.champion_id, b.position AS ally_position, b.champion_id AS ally_id,
       count(*)::int AS games, count(*) FILTER (WHERE a.win)::int AS wins
FROM stats_participants a
JOIN stats_participants b
  ON b.match_id = a.match_id AND b.team_id = a.team_id AND b.participant_id <> a.participant_id
GROUP BY a.patch, a.position, a.champion_id, b.position, b.champion_id;
CREATE UNIQUE INDEX stats_champion_with_pk
  ON stats_champion_with (patch, position, ally_id, ally_position, champion_id);

-- Champion (in a role) when the enemy (or its own) composition has a trait.
CREATE MATERIALIZED VIEW stats_champion_comp_traits AS
SELECT sp.patch, sp.position, sp.champion_id, t.side, t.trait,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participants sp
CROSS JOIN LATERAL (
  SELECT 'enemy'::text AS side, unnest(sp.enemy_traits) AS trait
  UNION ALL
  SELECT 'ally'::text, unnest(sp.ally_traits)
) t
GROUP BY sp.patch, sp.position, sp.champion_id, t.side, t.trait;
CREATE UNIQUE INDEX stats_champion_comp_traits_pk
  ON stats_champion_comp_traits (patch, position, champion_id, side, trait);

-- Build/rune/spell/skill choices per champion + role. avg_pos: mean position in buy order
-- (items, early items) or completed items bought before (boots).
CREATE MATERIALIZED VIEW stats_choices AS
SELECT patch, champion_id, position, kind, choice,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins,
       avg(pos)::float8 AS avg_pos
FROM stats_participant_choices
GROUP BY patch, champion_id, position, kind, choice;
CREATE UNIQUE INDEX stats_choices_pk ON stats_choices (patch, champion_id, position, kind, choice);

-- Choices vs. a lane opponent (same position; for bot lane, both enemy BOTTOM and UTILITY).
CREATE MATERIALIZED VIEW stats_choice_matchups AS
SELECT c.patch, c.champion_id, c.position, o.position AS opponent_position, o.champion_id AS opponent_id,
       c.kind, c.choice, count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices c
JOIN stats_participants o
  ON o.match_id = c.match_id AND o.team_id <> c.team_id
 AND (o.position = c.position
      OR (c.position IN ('BOTTOM', 'UTILITY') AND o.position IN ('BOTTOM', 'UTILITY')))
WHERE c.kind IN ('keystone', 'spells', 'starter', 'boots', 'item', 'skill_max', 'skill_first3')
GROUP BY c.patch, c.champion_id, c.position, o.position, o.champion_id, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_matchups_pk
  ON stats_choice_matchups (patch, champion_id, position, opponent_id, opponent_position, kind, choice);

-- Choices when the enemy composition has a trait (situational items, boots, spells, keystone).
CREATE MATERIALIZED VIEW stats_choice_traits AS
SELECT c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice,
       count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices c
CROSS JOIN LATERAL unnest(c.enemy_traits) AS t(trait)
WHERE c.kind IN ('keystone', 'spells', 'boots', 'item')
GROUP BY c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_traits_pk
  ON stats_choice_traits (patch, champion_id, position, trait, kind, choice);

-- ---------------------------------------------------------------------------
-- Refresh bookkeeping: the API refreshes only when the matches changed since the last run.
-- ---------------------------------------------------------------------------

CREATE TABLE stats_refresh_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  signature    text NOT NULL,              -- match count + newest fetched_at at refresh start
  match_count  integer NOT NULL,
  duration_ms  integer,
  error        text
);
