/** Hand-built stat rows for engine unit tests. */
import type { Position } from '@pick-league/shared';
import type {
  ChampionTraitRow,
  CompThresholdRow,
  ItemInfo,
  LanePhaseRow,
  NameLookup,
  RoleStatRow,
  VsRow,
  WithRow,
} from './types.ts';

export const NAMES: Record<number, string> = {
  111: 'Nautilus',
  117: 'Lulu',
  412: 'Thresh',
  89: 'Leona',
  40: 'Janna',
  16: 'Soraka',
  222: 'Jinx',
  51: 'Caitlyn',
  64: 'Lee Sin',
  122: 'Darius',
  103: 'Ahri',
  19: 'Warwick',
};

export const ITEM_NAMES: Record<number, string> = {
  3190: 'Locket of the Iron Solari',
  3050: "Zeke's Convergence",
  3109: "Knight's Vow",
  3075: 'Thornmail',
  3065: 'Spirit Visage',
  3047: 'Plated Steelcaps',
  3111: "Mercury's Treads",
  3011: 'Chemtech Putrifier',
  3865: 'World Atlas',
  3869: 'Celestial Opposition',
  3876: 'Solstice Sleigh',
  2003: 'Health Potion',
  1001: 'Boots',
  3067: 'Kindlegem',
};

export const names: NameLookup = {
  champion: (id) => NAMES[id] ?? `Champion ${id}`,
  item: (id) => ITEM_NAMES[id] ?? `Item ${id}`,
  rune: (id) =>
    ({ 8439: 'Aftershock', 8351: 'Glacial Augment', 8465: 'Guardian' })[id] ?? `Rune ${id}`,
  summonerSpell: (id) =>
    ({ 4: 'Flash', 14: 'Ignite', 3: 'Exhaust', 1: 'Cleanse' })[id] ?? `Spell ${id}`,
};

export const items: Map<number, ItemInfo> = new Map(
  [
    [3190, ['Health', 'Armor', 'SpellBlock'], false, true],
    [3050, ['Health', 'Armor'], false, true],
    [3109, ['Health', 'Armor'], false, true],
    [3075, ['Armor', 'Health'], false, true],
    [3065, ['SpellBlock', 'Health'], false, true],
    [3011, ['SpellDamage'], false, true],
    [3047, ['Boots', 'Armor'], true, true],
    [3111, ['Boots', 'SpellBlock', 'Tenacity'], true, true],
  ].map(([id, tags, isBoots, isCompleted]) => [
    id as number,
    {
      id: id as number,
      name: ITEM_NAMES[id as number] ?? '',
      tags: tags as string[],
      isBoots: isBoots as boolean,
      isCompleted: isCompleted as boolean,
    },
  ]),
);

export const role = (
  patch: string,
  championId: number,
  position: Position,
  games: number,
  wins: number,
): RoleStatRow => ({ patch, championId, position, games, wins });

export const vs = (
  patch: string,
  championId: number,
  enemyId: number,
  enemyPosition: Position,
  games: number,
  wins: number,
  position: Position = 'UTILITY',
): VsRow => ({ patch, position, championId, enemyId, enemyPosition, games, wins });

export const withAlly = (
  patch: string,
  championId: number,
  allyId: number,
  allyPosition: Position,
  games: number,
  wins: number,
  position: Position = 'UTILITY',
): WithRow => ({ patch, position, championId, allyId, allyPosition, games, wins });

export const traitsOf = (
  patch: string,
  championId: number,
  p: Partial<ChampionTraitRow> = {},
): ChampionTraitRow => ({
  patch,
  championId,
  games: 1000,
  physicalShare: 0.5,
  magicShare: 0.45,
  trueShare: 0.05,
  damagePerMin: 600,
  ccPerMin: 0.5,
  healingPerMin: 10,
  tankinessPerMin: 1200,
  attackRange: 550,
  isRanged: true,
  ...p,
});

export const thresholds = (patch: string): CompThresholdRow => ({
  patch,
  teams: 10_000,
  physicalShare: 0.6,
  magicShare: 0.5,
  ccPerMin: 0.8,
  healingPerMin: 40,
  tankinessPerMin: 1500,
  ranged: 0.6,
  melee: 0.6,
});

/** Lane-phase row: averages at 10 min, and at 15 min over `games15` matchups (default all). */
export const lane = (
  patch: string,
  championId: number,
  enemyId: number,
  enemyPosition: Position,
  games: number,
  at10: { gold: number; xp: number; cs: number },
  at15: { games: number; gold: number; xp: number; cs: number } | null = null,
  position: Position = 'UTILITY',
): LanePhaseRow => ({
  patch,
  position,
  championId,
  enemyPosition,
  enemyId,
  games,
  goldDiff10: at10.gold,
  xpDiff10: at10.xp,
  csDiff10: at10.cs,
  games15: at15?.games ?? 0,
  goldDiff15: at15?.gold ?? null,
  xpDiff15: at15?.xp ?? null,
  csDiff15: at15?.cs ?? null,
});
