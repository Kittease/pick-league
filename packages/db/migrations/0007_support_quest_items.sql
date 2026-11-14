-- Support quest upgrades (Celestial Opposition, Dream Maker, Solstice Sleigh, Bloodsong,
-- Zaz'Zak's Realmspike, ...) as a build choice of kind 'quest_item'.
--
-- The support item (World Atlas) is granted for free and upgrades itself through the quest
-- (World Atlas -> Runic Compass -> Bounty of Worlds -> the upgrade the player picks). The timeline
-- only has ITEM_DESTROYED events for the first three; the chosen upgrade almost never comes as an
-- ITEM_PURCHASED (and costs < 1000 gold, so it is not a "completed" item either). It is read from
-- the end-of-game inventory (participants.final_items), else from a purchase event (players who
-- sold it before the end).
--
-- Upgrades are recognised from Data Dragon data, not by id: non-consumable, non-completed items
-- tagged GoldPer that are built from another item and build into nothing.

CREATE MATERIALIZED VIEW stats_quest_items AS
WITH upgrades AS (
  SELECT patch, id
  FROM items
  WHERE NOT is_completed AND NOT is_consumable AND NOT is_boots AND 'GoldPer' = ANY (tags)
    AND cardinality(builds_from) > 0 AND cardinality(builds_into) = 0
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
  SELECT DISTINCT ON (e.match_id, e.participant_id) e.match_id, e.participant_id, e.item_id
  FROM item_events e
  JOIN matches m ON m.id = e.match_id
  JOIN upgrades u ON u.patch = m.patch AND u.id = e.item_id
  WHERE e.type = 'PURCHASED' AND NOT m.is_remake
  ORDER BY e.match_id, e.participant_id, e.seq DESC
)
SELECT match_id, participant_id, item_id FROM from_inventory
UNION ALL
SELECT ev.match_id, ev.participant_id, ev.item_id
FROM from_events ev
WHERE NOT EXISTS (
  SELECT 1 FROM from_inventory i
  WHERE i.match_id = ev.match_id AND i.participant_id = ev.participant_id
);
CREATE UNIQUE INDEX stats_quest_items_pk ON stats_quest_items (match_id, participant_id);

-- Same view as in 0002, plus the 'quest_item' kind (pos = NULL).
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
    ('quest_item', q.item_id::text, NULL::int)
  ) AS k(kind, choice, pos)
  UNION ALL
  SELECT 'item', i.item_id::text, i.ord::int FROM unnest(sp.core) WITH ORDINALITY AS i(item_id, ord)
  UNION ALL
  SELECT 'early_item', i.item_id::text, i.ord::int FROM unnest(sp.early) WITH ORDINALITY AS i(item_id, ord)
) c
WHERE c.choice IS NOT NULL;

-- stats_choice_matchups and stats_choice_traits: same as 0002, with 'quest_item' in the kinds.
DROP MATERIALIZED VIEW stats_choice_matchups;
CREATE MATERIALIZED VIEW stats_choice_matchups AS
SELECT c.patch, c.champion_id, c.position, o.position AS opponent_position, o.champion_id AS opponent_id,
       c.kind, c.choice, count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices c
JOIN stats_participants o
  ON o.match_id = c.match_id AND o.team_id <> c.team_id
 AND (o.position = c.position
      OR (c.position IN ('BOTTOM', 'UTILITY') AND o.position IN ('BOTTOM', 'UTILITY')))
WHERE c.kind IN ('keystone', 'spells', 'starter', 'boots', 'item', 'skill_max', 'skill_first3',
                 'quest_item')
GROUP BY c.patch, c.champion_id, c.position, o.position, o.champion_id, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_matchups_pk
  ON stats_choice_matchups (patch, champion_id, position, opponent_id, opponent_position, kind, choice);

DROP MATERIALIZED VIEW stats_choice_traits;
CREATE MATERIALIZED VIEW stats_choice_traits AS
SELECT c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice,
       count(*)::int AS games, count(*) FILTER (WHERE c.win)::int AS wins
FROM stats_participant_choices c
CROSS JOIN LATERAL unnest(c.enemy_traits) AS t(trait)
WHERE c.kind IN ('keystone', 'spells', 'boots', 'item', 'quest_item')
GROUP BY c.patch, c.champion_id, c.position, t.trait, c.kind, c.choice;
CREATE UNIQUE INDEX stats_choice_traits_pk
  ON stats_choice_traits (patch, champion_id, position, trait, kind, choice);
