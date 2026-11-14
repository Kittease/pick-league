-- Situational items from the user's own team: item choices with a given duo partner and when the
-- ally composition has a trait (the build engine only had enemy contexts: stats_choice_matchups
-- and stats_choice_traits).
--
-- Only kind 'item' (completed items, the situational candidates), read straight from
-- stats_participants.core: the same rows as stats_participant_choices with kind = 'item'
-- (choice = item id as text), without its other kinds and the stats_quest_items join. The `kind`
-- column is kept so the rows read like the other choice views. New views: nothing existing is
-- dropped or recreated. Creating them computes them once.
--
-- Built serially: parallel hash joins live in /dev/shm, only 64 MB in Docker (see stats/refresh.ts).
SET LOCAL max_parallel_workers_per_gather = 0;

-- Items with a duo partner (UTILITY<->BOTTOM, MIDDLE<->JUNGLE, TOP<->JUNGLE: DUO_ROLES, as
-- stats_tierlist_with). Champion totals with that partner are in stats_champion_with.
CREATE MATERIALIZED VIEW stats_choice_duos AS
SELECT sp.patch, sp.champion_id, sp.position, o.position AS partner_position,
       o.champion_id AS partner_id, 'item'::text AS kind, i.item_id::text AS choice,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participants sp
JOIN stats_participants o
  ON o.match_id = sp.match_id AND o.team_id = sp.team_id AND o.participant_id <> sp.participant_id
 AND (sp.position, o.position) IN (
   ('TOP', 'JUNGLE'), ('JUNGLE', 'TOP'), ('JUNGLE', 'MIDDLE'), ('MIDDLE', 'JUNGLE'),
   ('BOTTOM', 'UTILITY'), ('UTILITY', 'BOTTOM'))
CROSS JOIN LATERAL unnest(sp.core) AS i(item_id)
GROUP BY sp.patch, sp.champion_id, sp.position, o.position, o.champion_id, i.item_id;
CREATE UNIQUE INDEX stats_choice_duos_pk
  ON stats_choice_duos (patch, champion_id, position, partner_id, partner_position, kind, choice);

-- Items when the ally composition (the 4 teammates, stats_participants.ally_traits) has a trait.
-- Champion totals in that case are in stats_champion_comp_traits (side 'ally').
CREATE MATERIALIZED VIEW stats_choice_ally_traits AS
SELECT sp.patch, sp.champion_id, sp.position, t.trait, 'item'::text AS kind,
       i.item_id::text AS choice,
       count(*)::int AS games, count(*) FILTER (WHERE sp.win)::int AS wins
FROM stats_participants sp
CROSS JOIN LATERAL unnest(sp.ally_traits) AS t(trait)
CROSS JOIN LATERAL unnest(sp.core) AS i(item_id)
GROUP BY sp.patch, sp.champion_id, sp.position, t.trait, i.item_id;
CREATE UNIQUE INDEX stats_choice_ally_traits_pk
  ON stats_choice_ally_traits (patch, champion_id, position, trait, kind, choice);
