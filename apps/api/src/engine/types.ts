/**
 * Rows of the stats materialized views (packages/db/migrations/0002_stats_views.sql), camelCased.
 * The engine is pure: it only sees these rows and static lookups.
 */
import type { CompTrait, PatchId, Position } from '@pick-league/shared';

export interface GamesWins {
  games: number;
  wins: number;
}

/** stats_champion_roles */
export interface RoleStatRow extends GamesWins {
  patch: PatchId;
  championId: number;
  position: Position;
}

/** stats_champion_vs */
export interface VsRow extends GamesWins {
  patch: PatchId;
  position: Position;
  championId: number;
  enemyPosition: Position;
  enemyId: number;
}

/** stats_champion_with */
export interface WithRow extends GamesWins {
  patch: PatchId;
  position: Position;
  championId: number;
  allyPosition: Position;
  allyId: number;
}

export type CompSide = 'enemy' | 'ally';

/** stats_champion_comp_traits */
export interface CompTraitRow extends GamesWins {
  patch: PatchId;
  position: Position;
  championId: number;
  side: CompSide;
  trait: CompTrait;
}

/** stats_champion_traits */
export interface ChampionTraitRow {
  patch: PatchId;
  championId: number;
  games: number;
  physicalShare: number;
  magicShare: number;
  trueShare: number;
  damagePerMin: number;
  ccPerMin: number;
  healingPerMin: number;
  tankinessPerMin: number;
  attackRange: number;
  isRanged: boolean;
}

/** stats_comp_thresholds */
export interface CompThresholdRow {
  patch: PatchId;
  teams: number;
  physicalShare: number;
  magicShare: number;
  ccPerMin: number;
  healingPerMin: number;
  tankinessPerMin: number;
  ranged: number;
  melee: number;
}

export type ChoiceKind =
  | 'rune_page'
  | 'keystone'
  | 'spells'
  | 'starter'
  | 'boots'
  | 'core3'
  | 'skill_first3'
  | 'skill_max'
  | 'skill_seq'
  | 'item'
  | 'early_item'
  /** Support quest upgrade picked when the support item's quest completes. */
  | 'quest_item'
  /** Completed items of the player (choice = count, 0–6): the build stage of an item (0015). */
  | 'items_done';

/** stats_choices */
export interface ChoiceRow extends GamesWins {
  kind: ChoiceKind;
  choice: string;
  /** Mean position in buy order (items), completed items before (boots); null otherwise. */
  avgPos: number | null;
}

/** stats_choice_matchups (for one champion + role + patch) */
export interface ChoiceMatchupRow extends GamesWins {
  opponentId: number;
  opponentPosition: Position;
  kind: ChoiceKind;
  choice: string;
}

/** stats_choice_duos (for one champion + role + patch): items with a duo partner. */
export interface ChoiceDuoRow extends GamesWins {
  partnerId: number;
  partnerPosition: Position;
  kind: ChoiceKind;
  choice: string;
}

/**
 * stats_choice_traits (enemy composition) or stats_choice_ally_traits (ally composition, items
 * only), for one champion + role + patch.
 */
export interface ChoiceTraitRow extends GamesWins {
  trait: CompTrait;
  kind: ChoiceKind;
  choice: string;
}

/**
 * stats_champion_lane_phase (0010_lane_phase.sql): average lane-phase differences (own − lane
 * opponent; bot lane 2v2) at 10 and 15 min, per patch.
 */
export interface LanePhaseRow {
  patch: PatchId;
  position: Position;
  championId: number;
  enemyPosition: Position;
  enemyId: number;
  /** Matchups with frames at 10 min. */
  games: number;
  goldDiff10: number;
  xpDiff10: number;
  csDiff10: number;
  /** Matchups with frames at 15 min (≤ games). */
  games15: number;
  /** Null when `games15` is 0. */
  goldDiff15: number | null;
  xpDiff15: number | null;
  csDiff15: number | null;
}

/** Static item info the build engine needs. */
export interface ItemInfo {
  id: number;
  name: string;
  tags: readonly string[];
  isBoots: boolean;
  isCompleted: boolean;
}

/** Display names for reasons. */
export interface NameLookup {
  champion(id: number): string;
  item(id: number): string;
  rune(id: number): string;
  summonerSpell(id: number): string;
}
