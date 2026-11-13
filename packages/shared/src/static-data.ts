/**
 * Normalised per-patch static data (from Data Dragon). Field names are the camelCase
 * versions of the static tables in docs/database-schema.md.
 */

import type { PatchId } from './patch.ts';

export interface ChampionInfo {
  attack: number;
  defense: number;
  magic: number;
  difficulty: number;
}

export interface StaticChampionSpell {
  /** 1=Q 2=W 3=E 4=R */
  slot: number;
  name: string;
  /** Image file name, e.g. 'AatroxQ.png' → use `ddragonSpellImageUrl`. */
  image: string;
}

export interface StaticChampion {
  /** Numeric key, e.g. 266. */
  id: number;
  /** Data Dragon id used in image file names, e.g. 'MonkeyKing'. */
  slug: string;
  /** Display name, e.g. 'Wukong'. */
  name: string;
  /** e.g. ['Fighter', 'Tank'] */
  tags: string[];
  attackRange: number;
  info: ChampionInfo;
  /** Q, W, E, R in slot order. */
  spells: StaticChampionSpell[];
}

export interface StaticItem {
  id: number;
  name: string;
  goldTotal: number;
  tags: string[];
  buildsFrom: number[];
  buildsInto: number[];
  isBoots: boolean;
  /** Final item (legendary / finished boots); see `normaliseItems` for the heuristic. */
  isCompleted: boolean;
  isConsumable: boolean;
  /** Data Dragon `stats` object, e.g. { FlatPhysicalDamageMod: 40 }. */
  stats: Record<string, number>;
}

export interface StaticRuneTree {
  /** 8000 Precision, 8100 Domination, 8200 Sorcery, 8300 Inspiration, 8400 Resolve. */
  id: number;
  name: string;
  /** Path relative to `https://ddragon.leagueoflegends.com/cdn/img/` → `ddragonRuneIconUrl`. */
  icon: string;
}

export interface StaticRune {
  id: number;
  treeId: number;
  /** 0 = keystone row, 1..3 = minor rows. */
  row: number;
  name: string;
  icon: string;
}

export interface StaticSummonerSpell {
  /** Numeric key, e.g. 4 = Flash. */
  id: number;
  name: string;
  /** Image file name, e.g. 'SummonerFlash.png'. */
  image: string;
}

/** Everything ingested for one patch. */
export interface StaticPatchData {
  patch: PatchId;
  ddragonVersion: string;
  champions: StaticChampion[];
  items: StaticItem[];
  runeTrees: StaticRuneTree[];
  runes: StaticRune[];
  summonerSpells: StaticSummonerSpell[];
}

/** Stat shard rows of a rune page (not in Data Dragon's runesReforged.json). */
export const STAT_SHARD_ROWS = ['offense', 'flex', 'defense'] as const;
export type StatShardRow = (typeof STAT_SHARD_ROWS)[number];

export interface StatShard {
  id: number;
  name: string;
  /** Path relative to `https://ddragon.leagueoflegends.com/cdn/img/`. */
  icon: string;
}

const ADAPTIVE: StatShard = {
  id: 5008,
  name: 'Adaptive Force',
  icon: 'perk-images/StatMods/StatModsAdaptiveForceIcon.png',
};
const ATTACK_SPEED: StatShard = {
  id: 5005,
  name: 'Attack Speed',
  icon: 'perk-images/StatMods/StatModsAttackSpeedIcon.png',
};
const ABILITY_HASTE: StatShard = {
  id: 5007,
  name: 'Ability Haste',
  icon: 'perk-images/StatMods/StatModsCDRScalingIcon.png',
};
const MOVE_SPEED: StatShard = {
  id: 5010,
  name: 'Move Speed',
  icon: 'perk-images/StatMods/StatModsMovementSpeedIcon.png',
};
const HEALTH_SCALING: StatShard = {
  id: 5001,
  name: 'Health Scaling',
  icon: 'perk-images/StatMods/StatModsHealthScalingIcon.png',
};
const HEALTH: StatShard = {
  id: 5011,
  name: 'Health',
  icon: 'perk-images/StatMods/StatModsHealthPlusIcon.png',
};
const TENACITY: StatShard = {
  id: 5013,
  name: 'Tenacity and Slow Resist',
  icon: 'perk-images/StatMods/StatModsTenacityIcon.png',
};

/**
 * Current stat shard options per row (season 2024+ layout). Ids are what Riot returns in
 * `perks.statPerks` and what the LCU expects as the last 3 `selectedPerkIds` of a rune page.
 */
export const STAT_SHARDS: Record<StatShardRow, readonly StatShard[]> = {
  offense: [ADAPTIVE, ATTACK_SPEED, ABILITY_HASTE],
  flex: [ADAPTIVE, MOVE_SPEED, HEALTH_SCALING],
  defense: [HEALTH, TENACITY, HEALTH_SCALING],
};

/** All distinct stat shards by id. */
export const STAT_SHARDS_BY_ID: ReadonlyMap<number, StatShard> = new Map(
  Object.values(STAT_SHARDS)
    .flat()
    .map((s) => [s.id, s]),
);
