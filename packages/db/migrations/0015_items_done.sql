-- Build stage of items: a new choice kind 'items_done' (choice = completed items of the player,
-- 0–6, i.e. cardinality of stats_participants.core) in every choice view, so the build engine
-- compares an item with the players who got as far into their build, not with every game.
--
-- Players who complete more items win far more (≈ 37 % with one completed item, 61 % with five on
-- 16.22): compared with every game, an item looked better the later it is bought (+1.7 points on
-- average for first items, +12 for fifth items), which skewed situational swaps and item reasons.
-- At most 7 rows per champion + role (and per lane opponent, trait or duo partner).
--
-- A materialized view's query cannot be altered: the five choice views are dropped and recreated
-- (definitions of 0008_deterministic_comp_traits.sql / 0012_choice_ally_contexts.sql plus the new
-- kind). Creating them computes them once.
--
-- Built serially: parallel hash joins live in /dev/shm, only 64 MB in Docker (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

DROP MATERIALIZED VIEW stats_choices, stats_choice_matchups, stats_choice_traits,
  stats_choice_duos, stats_choice_ally_traits;

-- Every choice of a participant (plain view), with the new 'items_done' kind.
CREATE OR REPLACE VIEW stats_participant_choices AS
SELECT sp.patch, sp.match_id, sp.participant_id, sp.team_id, sp.champion_id, sp.position, sp.win,
       sp.enemy_traits, c.kind, c.choice, c.pos
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

-- Build/rune/spell/skill choices per champion + role (unchanged definition).
CREATE MATERIALIZED VIEW stats_choices AS
SELECT patch, champion_id, position, kind, choice,
       count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins,
       avg(pos)::float8 AS avg_pos
FROM stats_participant_choices
GROUP BY patch, champion_id, position, kind, choice;
CREATE UNIQUE INDEX stats_choices_pk ON stats_choices (patch, champion_id, position, kind, choice);

-- Choices vs a lane opponent, with 'items_done'.
CREATE MATERIALIZED VIEW stats_choice_matchups AS
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
CREATE UNIQUE INDEX stats_choice_matchups_pk
  ON stats_choice_matchups (patch, champion_id, position, opponent_id, opponent_position, kind, choice);

-- Choices when the enemy composition has a trait, with 'items_done'.
CREATE MATERIALIZED VIEW stats_choice_traits AS
SELECT c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice,
       count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices c
CROSS JOIN LATERAL unnest(c.enemy_traits) AS t(trait)
WHERE c.kind IN ('keystone', 'spells', 'boots', 'item', 'quest_item', 'items_done')
GROUP BY c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_traits_pk
  ON stats_choice_traits (patch, champion_id, position, trait, kind, choice);

-- Items (and now 'items_done') with a duo partner, read straight from stats_participants.core.
CREATE MATERIALIZED VIEW stats_choice_duos AS
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
CREATE UNIQUE INDEX stats_choice_duos_pk
  ON stats_choice_duos (patch, champion_id, position, partner_id, partner_position, kind, choice);

-- Items (and now 'items_done') when the ally composition has a trait.
CREATE MATERIALIZED VIEW stats_choice_ally_traits AS
SELECT sp.patch, sp.champion_id, sp.position, t.trait, x.kind, x.choice,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participants sp
CROSS JOIN LATERAL unnest(sp.ally_traits) AS t(trait)
CROSS JOIN LATERAL (
  SELECT 'item'::text AS kind, i.item_id::text AS choice FROM unnest(sp.core) AS i(item_id)
  UNION ALL
  SELECT 'items_done', COALESCE(cardinality(sp.core), 0)::text
) x
GROUP BY sp.patch, sp.champion_id, sp.position, t.trait, x.kind, x.choice;
CREATE UNIQUE INDEX stats_choice_ally_traits_pk
  ON stats_choice_ally_traits (patch, champion_id, position, trait, kind, choice);
