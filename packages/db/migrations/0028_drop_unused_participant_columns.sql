-- participants columns nothing ever read: no stats view, no query, no application.
--
-- Kept: what the views read (the loadout and final_items, the damage / healing / crowd-control
-- totals of stats_champion_traits, the per-minute gold / XP / CS frames of
-- stats_champion_lane_phase) and the keys.
--
-- Dropping a column is immediate and does not rewrite the table: rows written before keep the
-- bytes until they are rewritten (VACUUM FULL participants returns them at once, behind an
-- exclusive lock; otherwise the space comes back as old patches are deleted and replaced by
-- narrower rows).
ALTER TABLE participants
  -- end-of-game stats
  DROP COLUMN champ_level,
  DROP COLUMN kills,
  DROP COLUMN deaths,
  DROP COLUMN assists,
  DROP COLUMN lane_minions,
  DROP COLUMN jungle_minions,
  DROP COLUMN gold_earned,
  DROP COLUMN gold_spent,
  DROP COLUMN damage_to_buildings,
  DROP COLUMN damage_to_objectives,
  DROP COLUMN heals_on_teammates,
  DROP COLUMN shields_on_teammates,
  DROP COLUMN vision_score,
  DROP COLUMN wards_placed,
  DROP COLUMN wards_killed,
  DROP COLUMN control_wards_bought,
  -- timeline frames
  DROP COLUMN level_by_minute,
  DROP COLUMN damage_to_champions_by_minute,
  DROP COLUMN position_x_by_minute,
  DROP COLUMN position_y_by_minute;
