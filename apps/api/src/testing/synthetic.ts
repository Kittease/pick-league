/**
 * Synthetic match generator for tests and perf checks. Produces plausible `ParsedMatch` objects
 * (fake PUUIDs, real champion/item/rune ids) with a hidden win model that contains a few planted
 * effects the tests can assert on (see `PLANTED`).
 */
import type {
  ParsedItemEvent,
  ParsedMatch,
  ParsedParticipant,
  ParsedSkillEvent,
} from '@pick-league/db';
import type { Position, StaticItem, StaticPatchData } from '@pick-league/shared';

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

export type Rng = () => number;

/** mulberry32 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;
const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function weightedPick<T>(rng: Rng, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return (entries[entries.length - 1] as readonly [T, number])[0];
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

type Archetype =
  | 'bruiser'
  | 'tank'
  | 'ranged_top'
  | 'jungle_ad'
  | 'jungle_tank'
  | 'mage'
  | 'assassin'
  | 'adc'
  | 'engage'
  | 'enchanter';

interface SynthChampion {
  id: number;
  slug: string;
  name: string;
  role: Position;
  archetype: Archetype;
  range: number;
  tags: string[];
  /** Hidden base strength (logit). */
  strength: number;
  /** Max order, e.g. [1, 3, 2]. */
  maxOrder: [number, number, number];
  healing?: number;
}

const C = (
  id: number,
  slug: string,
  name: string,
  role: Position,
  archetype: Archetype,
  range: number,
  tags: string[],
  strength: number,
  maxOrder: [number, number, number],
  healing?: number,
): SynthChampion => ({ id, slug, name, role, archetype, range, tags, strength, maxOrder, healing });

export const SYNTH_CHAMPIONS: readonly SynthChampion[] = [
  C(122, 'Darius', 'Darius', 'TOP', 'bruiser', 175, ['Fighter', 'Tank'], 0.05, [1, 3, 2], 25),
  C(86, 'Garen', 'Garen', 'TOP', 'bruiser', 175, ['Fighter', 'Tank'], 0.0, [3, 1, 2]),
  C(54, 'Malphite', 'Malphite', 'TOP', 'tank', 125, ['Tank', 'Mage'], 0.02, [1, 3, 2]),
  C(114, 'Fiora', 'Fiora', 'TOP', 'bruiser', 150, ['Fighter', 'Assassin'], -0.02, [1, 3, 2], 20),
  C(17, 'Teemo', 'Teemo', 'TOP', 'ranged_top', 500, ['Marksman', 'Assassin'], -0.03, [3, 1, 2]),
  C(516, 'Ornn', 'Ornn', 'TOP', 'tank', 175, ['Tank', 'Fighter'], 0.03, [2, 1, 3]),
  C(64, 'LeeSin', 'Lee Sin', 'JUNGLE', 'jungle_ad', 125, ['Fighter', 'Assassin'], 0.0, [1, 2, 3]),
  C(254, 'Vi', 'Vi', 'JUNGLE', 'jungle_ad', 125, ['Fighter', 'Assassin'], 0.02, [1, 3, 2]),
  C(32, 'Amumu', 'Amumu', 'JUNGLE', 'jungle_tank', 125, ['Tank', 'Mage'], 0.03, [3, 1, 2]),
  C(19, 'Warwick', 'Warwick', 'JUNGLE', 'jungle_ad', 125, ['Fighter', 'Tank'], 0.01, [1, 2, 3], 60),
  C(104, 'Graves', 'Graves', 'JUNGLE', 'jungle_ad', 425, ['Marksman'], -0.01, [1, 3, 2]),
  C(113, 'Sejuani', 'Sejuani', 'JUNGLE', 'jungle_tank', 150, ['Tank', 'Fighter'], 0.0, [2, 1, 3]),
  C(103, 'Ahri', 'Ahri', 'MIDDLE', 'mage', 550, ['Mage', 'Assassin'], 0.02, [1, 3, 2]),
  C(238, 'Zed', 'Zed', 'MIDDLE', 'assassin', 125, ['Assassin'], -0.02, [1, 3, 2]),
  C(134, 'Syndra', 'Syndra', 'MIDDLE', 'mage', 550, ['Mage'], 0.0, [1, 2, 3]),
  C(157, 'Yasuo', 'Yasuo', 'MIDDLE', 'assassin', 175, ['Fighter', 'Assassin'], -0.03, [1, 3, 2]),
  C(61, 'Orianna', 'Orianna', 'MIDDLE', 'mage', 525, ['Mage', 'Support'], 0.01, [1, 2, 3]),
  C(1, 'Annie', 'Annie', 'MIDDLE', 'mage', 625, ['Mage'], 0.01, [1, 2, 3]),
  C(222, 'Jinx', 'Jinx', 'BOTTOM', 'adc', 525, ['Marksman'], 0.02, [1, 2, 3]),
  C(51, 'Caitlyn', 'Caitlyn', 'BOTTOM', 'adc', 650, ['Marksman'], 0.0, [1, 2, 3]),
  C(81, 'Ezreal', 'Ezreal', 'BOTTOM', 'adc', 550, ['Marksman', 'Mage'], -0.01, [1, 3, 2]),
  C(145, 'Kaisa', "Kai'Sa", 'BOTTOM', 'adc', 525, ['Marksman'], 0.01, [1, 3, 2]),
  C(202, 'Jhin', 'Jhin', 'BOTTOM', 'adc', 550, ['Marksman', 'Mage'], 0.01, [1, 2, 3]),
  C(360, 'Samira', 'Samira', 'BOTTOM', 'adc', 500, ['Marksman'], -0.02, [1, 3, 2], 20),
  C(412, 'Thresh', 'Thresh', 'UTILITY', 'engage', 450, ['Support', 'Fighter'], 0.01, [1, 3, 2]),
  C(89, 'Leona', 'Leona', 'UTILITY', 'engage', 125, ['Tank', 'Support'], 0.02, [3, 2, 1]),
  C(111, 'Nautilus', 'Nautilus', 'UTILITY', 'engage', 175, ['Tank', 'Support'], 0.0, [1, 3, 2]),
  C(117, 'Lulu', 'Lulu', 'UTILITY', 'enchanter', 550, ['Support', 'Mage'], 0.0, [3, 1, 2]),
  C(40, 'Janna', 'Janna', 'UTILITY', 'enchanter', 550, ['Support', 'Mage'], 0.01, [3, 2, 1], 30),
  C(16, 'Soraka', 'Soraka', 'UTILITY', 'enchanter', 550, ['Support', 'Mage'], 0.0, [2, 1, 3], 120),
  C(267, 'Nami', 'Nami', 'UTILITY', 'enchanter', 550, ['Support', 'Mage'], 0.0, [2, 3, 1], 60),
  C(201, 'Braum', 'Braum', 'UTILITY', 'engage', 125, ['Support', 'Tank'], 0.0, [1, 3, 2]),
];

export const SYNTH_CHAMPIONS_BY_ID: ReadonlyMap<number, SynthChampion> = new Map(
  SYNTH_CHAMPIONS.map((c) => [c.id, c]),
);

/** Effects hidden in the win model, asserted by tests. */
export const PLANTED = {
  /** Nautilus (111) crushes Janna (40) in bot lane. */
  matchup: { championId: 111, opponentId: 40, logit: 0.9 },
  /** Lulu (117) + Jinx (222) bot duo. */
  duo: { championId: 117, allyId: 222, logit: 0.8 },
  /** Building anti-heal vs a healing-heavy enemy team. */
  antiHealVsHealing: 0.6,
  /** Leona (89) wins more with Aftershock (8439) than Glacial (8351) vs Thresh (412). */
  runeMatchup: { championId: 89, opponentId: 412, keystone: 8439, logit: 0.7 },
  /** Braum (201) is rarely picked on the current patch (the previous one is added). */
  rareOnCurrent: 201,
} as const;

interface ItemDef {
  id: number;
  name: string;
  gold: number;
  tags: string[];
  from?: number[];
  boots?: boolean;
  completed?: boolean;
  consumable?: boolean;
}

const ITEM_DEFS: ItemDef[] = [
  // consumables + trinkets + starters
  {
    id: 2003,
    name: 'Health Potion',
    gold: 50,
    tags: ['Consumable', 'HealthRegen'],
    consumable: true,
  },
  { id: 2055, name: 'Control Ward', gold: 75, tags: ['Consumable', 'Vision'], consumable: true },
  { id: 3340, name: 'Stealth Ward', gold: 0, tags: ['Trinket', 'Vision'] },
  { id: 3364, name: 'Oracle Lens', gold: 0, tags: ['Trinket', 'Vision'] },
  { id: 1055, name: "Doran's Blade", gold: 450, tags: ['Damage', 'LifeSteal', 'Lane'] },
  { id: 1056, name: "Doran's Ring", gold: 400, tags: ['SpellDamage', 'Mana', 'Lane'] },
  { id: 1054, name: "Doran's Shield", gold: 450, tags: ['Health', 'HealthRegen', 'Lane'] },
  { id: 3865, name: 'World Atlas', gold: 400, tags: ['GoldPer', 'Lane'] },
  // Support quest: Bounty of Worlds turns into the upgrade the player picks (end inventory only).
  { id: 3867, name: 'Bounty of Worlds', gold: 400, tags: ['GoldPer', 'Lane'] },
  {
    id: 3869,
    name: 'Celestial Opposition',
    gold: 400,
    tags: ['Health', 'GoldPer', 'Lane'],
    from: [3867],
  },
  {
    id: 3876,
    name: 'Solstice Sleigh',
    gold: 400,
    tags: ['Health', 'GoldPer', 'Lane'],
    from: [3867],
  },
  { id: 1101, name: 'Scorchclaw Pup', gold: 450, tags: ['Jungle'] },
  // components
  { id: 1001, name: 'Boots', gold: 300, tags: ['Boots'], boots: true },
  { id: 1036, name: 'Long Sword', gold: 350, tags: ['Damage'] },
  { id: 1052, name: 'Amplifying Tome', gold: 400, tags: ['SpellDamage'] },
  { id: 1028, name: 'Ruby Crystal', gold: 400, tags: ['Health'] },
  { id: 1029, name: 'Cloth Armor', gold: 300, tags: ['Armor'] },
  { id: 1033, name: 'Null-Magic Mantle', gold: 400, tags: ['SpellBlock'] },
  { id: 1018, name: 'Cloak of Agility', gold: 600, tags: ['CriticalStrike'] },
  { id: 3123, name: "Executioner's Calling", gold: 800, tags: ['Damage'], from: [1036] },
  { id: 3916, name: 'Oblivion Orb', gold: 800, tags: ['SpellDamage'], from: [1052] },
  { id: 3076, name: 'Bramble Vest', gold: 800, tags: ['Armor'], from: [1029] },
  { id: 3067, name: 'Kindlegem', gold: 800, tags: ['Health', 'AbilityHaste'], from: [1028] },
  // boots
  {
    id: 3006,
    name: "Berserker's Greaves",
    gold: 1100,
    tags: ['Boots', 'AttackSpeed'],
    from: [1001],
    boots: true,
    completed: true,
  },
  {
    id: 3020,
    name: "Sorcerer's Shoes",
    gold: 1100,
    tags: ['Boots', 'MagicPenetration'],
    from: [1001],
    boots: true,
    completed: true,
  },
  {
    id: 3047,
    name: 'Plated Steelcaps',
    gold: 1100,
    tags: ['Boots', 'Armor'],
    from: [1001],
    boots: true,
    completed: true,
  },
  {
    id: 3111,
    name: "Mercury's Treads",
    gold: 1250,
    tags: ['Boots', 'SpellBlock', 'Tenacity'],
    from: [1001],
    boots: true,
    completed: true,
  },
  {
    id: 3158,
    name: 'Ionian Boots of Lucidity',
    gold: 900,
    tags: ['Boots', 'AbilityHaste'],
    from: [1001],
    boots: true,
    completed: true,
  },
  // AD
  {
    id: 6672,
    name: 'Kraken Slayer',
    gold: 3100,
    tags: ['Damage', 'AttackSpeed', 'OnHit'],
    from: [1036, 1018],
    completed: true,
  },
  {
    id: 3031,
    name: 'Infinity Edge',
    gold: 3450,
    tags: ['Damage', 'CriticalStrike'],
    from: [1036, 1018],
    completed: true,
  },
  {
    id: 3094,
    name: 'Rapid Firecannon',
    gold: 2650,
    tags: ['CriticalStrike', 'AttackSpeed'],
    from: [1018],
    completed: true,
  },
  {
    id: 3036,
    name: "Lord Dominik's Regards",
    gold: 3100,
    tags: ['Damage', 'ArmorPenetration'],
    from: [1036],
    completed: true,
  },
  {
    id: 3033,
    name: 'Mortal Reminder',
    gold: 3000,
    tags: ['Damage', 'ArmorPenetration'],
    from: [3123],
    completed: true,
  },
  {
    id: 3071,
    name: 'Black Cleaver',
    gold: 3000,
    tags: ['Damage', 'Health', 'ArmorPenetration'],
    from: [1036, 1028],
    completed: true,
  },
  {
    id: 3078,
    name: 'Trinity Force',
    gold: 3333,
    tags: ['Damage', 'Health', 'AttackSpeed'],
    from: [1036, 1028],
    completed: true,
  },
  {
    id: 6333,
    name: "Death's Dance",
    gold: 3300,
    tags: ['Damage', 'Armor'],
    from: [1036, 1029],
    completed: true,
  },
  { id: 3053, name: "Sterak's Gage", gold: 3200, tags: ['Health'], from: [1028], completed: true },
  {
    id: 6609,
    name: 'Chempunk Chainsword',
    gold: 3100,
    tags: ['Damage', 'Health'],
    from: [3123, 1028],
    completed: true,
  },
  {
    id: 3139,
    name: 'Mercurial Scimitar',
    gold: 3200,
    tags: ['Damage', 'SpellBlock', 'Active'],
    from: [1036, 1033],
    completed: true,
  },
  // AP
  {
    id: 6655,
    name: "Luden's Companion",
    gold: 2900,
    tags: ['SpellDamage', 'Mana'],
    from: [1052],
    completed: true,
  },
  {
    id: 3089,
    name: "Rabadon's Deathcap",
    gold: 3600,
    tags: ['SpellDamage'],
    from: [1052],
    completed: true,
  },
  {
    id: 3135,
    name: 'Void Staff',
    gold: 3000,
    tags: ['SpellDamage', 'MagicPenetration'],
    from: [1052],
    completed: true,
  },
  {
    id: 3165,
    name: 'Morellonomicon',
    gold: 2950,
    tags: ['SpellDamage', 'Health'],
    from: [3916, 1028],
    completed: true,
  },
  {
    id: 3157,
    name: "Zhonya's Hourglass",
    gold: 3250,
    tags: ['SpellDamage', 'Armor', 'Active'],
    from: [1052, 1029],
    completed: true,
  },
  {
    id: 3102,
    name: "Banshee's Veil",
    gold: 3000,
    tags: ['SpellDamage', 'SpellBlock'],
    from: [1052, 1033],
    completed: true,
  },
  {
    id: 4645,
    name: 'Shadowflame',
    gold: 3200,
    tags: ['SpellDamage', 'MagicPenetration'],
    from: [1052],
    completed: true,
  },
  // tank
  {
    id: 3075,
    name: 'Thornmail',
    gold: 2450,
    tags: ['Armor', 'Health'],
    from: [3076, 1028],
    completed: true,
  },
  {
    id: 3065,
    name: 'Spirit Visage',
    gold: 2700,
    tags: ['SpellBlock', 'Health'],
    from: [1033, 1028],
    completed: true,
  },
  {
    id: 3068,
    name: 'Sunfire Aegis',
    gold: 2700,
    tags: ['Armor', 'Health'],
    from: [1029, 1028],
    completed: true,
  },
  {
    id: 3143,
    name: "Randuin's Omen",
    gold: 2700,
    tags: ['Armor', 'Health'],
    from: [1029, 1028],
    completed: true,
  },
  {
    id: 4401,
    name: 'Force of Nature',
    gold: 2800,
    tags: ['SpellBlock', 'Health'],
    from: [1033, 1028],
    completed: true,
  },
  {
    id: 3742,
    name: "Dead Man's Plate",
    gold: 2900,
    tags: ['Armor', 'Health'],
    from: [1029, 1028],
    completed: true,
  },
  // support
  {
    id: 3190,
    name: 'Locket of the Iron Solari',
    gold: 2200,
    tags: ['Health', 'Armor', 'SpellBlock', 'Aura'],
    from: [3067],
    completed: true,
  },
  {
    id: 3050,
    name: "Zeke's Convergence",
    gold: 2200,
    tags: ['Health', 'Armor'],
    from: [1029, 1028],
    completed: true,
  },
  {
    id: 3109,
    name: "Knight's Vow",
    gold: 2200,
    tags: ['Health', 'Armor'],
    from: [3067],
    completed: true,
  },
  {
    id: 3504,
    name: 'Ardent Censer',
    gold: 2200,
    tags: ['SpellDamage', 'ManaRegen'],
    from: [1052],
    completed: true,
  },
  {
    id: 6617,
    name: 'Moonstone Renewer',
    gold: 2200,
    tags: ['SpellDamage', 'Health', 'ManaRegen'],
    from: [1052, 1028],
    completed: true,
  },
  {
    id: 3107,
    name: 'Redemption',
    gold: 2300,
    tags: ['Health', 'ManaRegen', 'Active'],
    from: [1028],
    completed: true,
  },
  {
    id: 3222,
    name: "Mikael's Blessing",
    gold: 2300,
    tags: ['SpellBlock', 'ManaRegen', 'Active', 'Tenacity'],
    from: [1033],
    completed: true,
  },
  {
    id: 3011,
    name: 'Chemtech Putrifier',
    gold: 2300,
    tags: ['SpellDamage', 'ManaRegen'],
    from: [3916],
    completed: true,
  },
];

/** Anti-heal items of the synthetic set (mirrors the engine config list). */
const ANTI_HEAL = new Set([3033, 6609, 3165, 3075, 3011]);

interface ArchetypeKit {
  starter: number[][];
  boots: number[];
  /** Core pool: first two are the usual first items, the rest fill slots 3..5. */
  core: number[];
  /** Anti-heal option replacing the 3rd item when built. */
  antiHeal: number;
  physical: number;
  magic: number;
  cc: number;
  tank: number;
  damage: number;
  pages: {
    primary: number;
    secondary: number;
    runes: readonly number[];
    shards: readonly number[];
  }[];
  spells: number[][];
}

const PAGE = {
  conqueror: {
    primary: 8000,
    secondary: 8400,
    runes: [8010, 9111, 9104, 8299, 8444, 8473],
    shards: [5005, 5008, 5011],
  },
  grasp: {
    primary: 8400,
    secondary: 8000,
    runes: [8437, 8446, 8473, 8242, 9111, 9104],
    shards: [5005, 5008, 5011],
  },
  aftershock: {
    primary: 8400,
    secondary: 8300,
    runes: [8439, 8401, 8473, 8242, 8345, 8347],
    shards: [5007, 5010, 5011],
  },
  glacial: {
    primary: 8300,
    secondary: 8400,
    runes: [8351, 8306, 8345, 8347, 8473, 8242],
    shards: [5007, 5010, 5011],
  },
  electrocute: {
    primary: 8100,
    secondary: 8200,
    runes: [8112, 8126, 8138, 8135, 8226, 8210],
    shards: [5008, 5008, 5011],
  },
  comet: {
    primary: 8200,
    secondary: 8300,
    runes: [8229, 8226, 8210, 8237, 8345, 8347],
    shards: [5008, 5008, 5011],
  },
  aery: {
    primary: 8200,
    secondary: 8300,
    runes: [8214, 8226, 8210, 8234, 8345, 8347],
    shards: [5007, 5008, 5011],
  },
  lethal: {
    primary: 8000,
    secondary: 8100,
    runes: [8008, 9111, 9104, 8014, 8139, 8135],
    shards: [5005, 5008, 5011],
  },
  pta: {
    primary: 8000,
    secondary: 8200,
    runes: [8005, 9111, 9104, 8014, 8226, 8210],
    shards: [5005, 5008, 5011],
  },
} as const;

const KITS: Record<Archetype, ArchetypeKit> = {
  bruiser: {
    starter: [[1055, 2003]],
    boots: [3047, 3111],
    core: [3078, 3053, 6333, 3071, 3065],
    antiHeal: 6609,
    physical: 0.85,
    magic: 0.05,
    cc: 0.4,
    tank: 1500,
    damage: 750,
    pages: [PAGE.conqueror, PAGE.grasp],
    spells: [
      [4, 12],
      [4, 14],
    ],
  },
  tank: {
    starter: [[1054, 2003]],
    boots: [3047, 3111],
    core: [3068, 3075, 4401, 3065, 3143],
    antiHeal: 3075,
    physical: 0.25,
    magic: 0.65,
    cc: 0.9,
    tank: 2200,
    damage: 450,
    pages: [PAGE.grasp, PAGE.aftershock],
    spells: [
      [4, 12],
      [4, 14],
    ],
  },
  ranged_top: {
    starter: [[1056, 2003]],
    boots: [3020, 3111],
    core: [6653, 3089, 3135, 3157, 4645],
    antiHeal: 3165,
    physical: 0.25,
    magic: 0.7,
    cc: 0.3,
    tank: 900,
    damage: 800,
    pages: [PAGE.comet, PAGE.pta],
    spells: [
      [4, 14],
      [4, 12],
    ],
  },
  jungle_ad: {
    starter: [[1101, 2003]],
    boots: [3047, 3111],
    core: [3071, 6333, 3053, 3078, 3036],
    antiHeal: 6609,
    physical: 0.85,
    magic: 0.05,
    cc: 0.4,
    tank: 1400,
    damage: 650,
    pages: [PAGE.conqueror, PAGE.electrocute],
    spells: [[4, 11]],
  },
  jungle_tank: {
    starter: [[1101, 2003]],
    boots: [3047, 3111],
    core: [3068, 3143, 4401, 3065, 3742],
    antiHeal: 3075,
    physical: 0.3,
    magic: 0.6,
    cc: 1.0,
    tank: 2100,
    damage: 420,
    pages: [PAGE.aftershock, PAGE.grasp],
    spells: [[4, 11]],
  },
  mage: {
    starter: [[1056, 2003, 2003]],
    boots: [3020, 3158],
    core: [6655, 3089, 3135, 3157, 4645],
    antiHeal: 3165,
    physical: 0.1,
    magic: 0.85,
    cc: 0.5,
    tank: 800,
    damage: 900,
    pages: [PAGE.comet, PAGE.electrocute],
    spells: [
      [4, 12],
      [4, 14],
    ],
  },
  assassin: {
    starter: [[1055, 2003]],
    boots: [3158, 3047],
    core: [3142, 6333, 3036, 3814, 3071],
    antiHeal: 3033,
    physical: 0.9,
    magic: 0.05,
    cc: 0.2,
    tank: 900,
    damage: 850,
    pages: [PAGE.electrocute, PAGE.conqueror],
    spells: [
      [4, 14],
      [4, 12],
    ],
  },
  adc: {
    starter: [[1055, 2003]],
    boots: [3006],
    core: [6672, 3031, 3094, 3036, 6333],
    antiHeal: 3033,
    physical: 0.9,
    magic: 0.05,
    cc: 0.15,
    tank: 700,
    damage: 950,
    pages: [PAGE.lethal, PAGE.pta],
    spells: [
      [4, 7],
      [4, 21],
    ],
  },
  engage: {
    starter: [[3865, 2003, 2003]],
    boots: [3047, 3111],
    core: [3190, 3050, 3109, 3075, 3065],
    antiHeal: 3075,
    physical: 0.3,
    magic: 0.6,
    cc: 1.4,
    tank: 1700,
    damage: 300,
    pages: [PAGE.aftershock, PAGE.glacial],
    spells: [
      [4, 14],
      [4, 3],
    ],
  },
  enchanter: {
    starter: [[3865, 2003, 2003]],
    boots: [3158],
    core: [6617, 3504, 3107, 3222, 3011],
    antiHeal: 3011,
    physical: 0.15,
    magic: 0.8,
    cc: 0.6,
    tank: 700,
    damage: 300,
    pages: [PAGE.aery, PAGE.comet],
    spells: [
      [4, 3],
      [4, 14],
    ],
  },
};

// Two items missing from ITEM_DEFS but used by kits.
ITEM_DEFS.push(
  {
    id: 6653,
    name: "Liandry's Torment",
    gold: 3000,
    tags: ['SpellDamage', 'Health'],
    from: [1052, 1028],
    completed: true,
  },
  {
    id: 3142,
    name: "Youmuu's Ghostblade",
    gold: 2800,
    tags: ['Damage', 'ArmorPenetration'],
    from: [1036],
    completed: true,
  },
  {
    id: 3814,
    name: 'Edge of Night',
    gold: 2800,
    tags: ['Damage', 'Health'],
    from: [1036, 1028],
    completed: true,
  },
);

const RUNE_TREES = [
  { id: 8000, name: 'Precision', icon: 'perk-images/Styles/7201_Precision.png' },
  { id: 8100, name: 'Domination', icon: 'perk-images/Styles/7200_Domination.png' },
  { id: 8200, name: 'Sorcery', icon: 'perk-images/Styles/7202_Sorcery.png' },
  { id: 8300, name: 'Inspiration', icon: 'perk-images/Styles/7203_Whimsy.png' },
  { id: 8400, name: 'Resolve', icon: 'perk-images/Styles/7204_Resolve.png' },
];

const RUNES: [number, number, number, string][] = [
  [8005, 8000, 0, 'Press the Attack'],
  [8008, 8000, 0, 'Lethal Tempo'],
  [8010, 8000, 0, 'Conqueror'],
  [9111, 8000, 1, 'Triumph'],
  [9104, 8000, 2, 'Legend: Alacrity'],
  [8014, 8000, 3, 'Coup de Grace'],
  [8299, 8000, 3, 'Last Stand'],
  [8112, 8100, 0, 'Electrocute'],
  [8126, 8100, 1, 'Cheap Shot'],
  [8139, 8100, 1, 'Taste of Blood'],
  [8138, 8100, 2, 'Eyeball Collection'],
  [8135, 8100, 3, 'Treasure Hunter'],
  [8214, 8200, 0, 'Summon Aery'],
  [8229, 8200, 0, 'Arcane Comet'],
  [8226, 8200, 1, 'Manaflow Band'],
  [8210, 8200, 2, 'Transcendence'],
  [8234, 8200, 2, 'Celerity'],
  [8237, 8200, 3, 'Scorch'],
  [8351, 8300, 0, 'Glacial Augment'],
  [8306, 8300, 1, 'Hextech Flashtraption'],
  [8345, 8300, 2, 'Biscuit Delivery'],
  [8347, 8300, 3, 'Cosmic Insight'],
  [8437, 8400, 0, 'Grasp of the Undying'],
  [8439, 8400, 0, 'Aftershock'],
  [8446, 8400, 1, 'Demolish'],
  [8401, 8400, 1, 'Shield Bash'],
  [8444, 8400, 2, 'Second Wind'],
  [8473, 8400, 2, 'Bone Plating'],
  [8242, 8400, 3, 'Unflinching'],
];

const SUMMONER_SPELLS: [number, string, string][] = [
  [1, 'Cleanse', 'SummonerBoost.png'],
  [3, 'Exhaust', 'SummonerExhaust.png'],
  [4, 'Flash', 'SummonerFlash.png'],
  [7, 'Heal', 'SummonerHeal.png'],
  [11, 'Smite', 'SummonerSmite.png'],
  [12, 'Teleport', 'SummonerTeleport.png'],
  [14, 'Ignite', 'SummonerDot.png'],
  [21, 'Barrier', 'SummonerBarrier.png'],
];

const ITEMS_BY_ID = new Map(ITEM_DEFS.map((i) => [i.id, i]));

/** Static data matching the synthetic matches, for `upsertPatchStaticData`. */
export function syntheticStaticData(patch: string, ddragonVersion = `${patch}.1`): StaticPatchData {
  const buildsInto = new Map<number, number[]>();
  for (const item of ITEM_DEFS) {
    for (const f of item.from ?? []) buildsInto.set(f, [...(buildsInto.get(f) ?? []), item.id]);
  }
  const items: StaticItem[] = ITEM_DEFS.map((i) => ({
    id: i.id,
    name: i.name,
    goldTotal: i.gold,
    tags: i.tags,
    buildsFrom: i.from ?? [],
    buildsInto: buildsInto.get(i.id) ?? [],
    isBoots: i.boots === true,
    isCompleted: i.completed === true,
    isConsumable: i.consumable === true,
    stats: {},
  })).sort((a, b) => a.id - b.id);
  return {
    patch,
    ddragonVersion,
    champions: SYNTH_CHAMPIONS.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      tags: c.tags,
      attackRange: c.range,
      info: { attack: 5, defense: 5, magic: 5, difficulty: 5 },
      spells: (['Q', 'W', 'E', 'R'] as const).map((k, i) => ({
        slot: i + 1,
        name: `${c.name} ${k}`,
        image: `${c.slug}${k}.png`,
      })),
    })),
    items,
    runeTrees: RUNE_TREES,
    runes: RUNES.map(([id, treeId, row, name]) => ({
      id,
      treeId,
      row,
      name,
      icon: `perk-images/Styles/${name.replace(/\W/g, '')}.png`,
    })),
    summonerSpells: SUMMONER_SPELLS.map(([id, name, image]) => ({ id, name, image })),
  };
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  patch: string;
  count: number;
  seed?: number;
  /** Prefix of match ids (default `SYN_<patch>`). */
  idPrefix?: string;
  /** Pick weight multipliers per champion id (default 1). */
  pickWeights?: Record<number, number>;
  startedAt?: Date;
}

const POSITIONS: Position[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

/** Deterministic small matchup noise in [-0.15, 0.15]. */
function pairNoise(a: number, b: number): number {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.3;
}

interface Loadout {
  champ: SynthChampion;
  kit: ArchetypeKit;
  core: number[];
  boots: number;
  page: ArchetypeKit['pages'][number];
  spells: number[];
  antiHeal: boolean;
}

function loadout(rng: Rng, champ: SynthChampion): Loadout {
  const kit = KITS[champ.archetype];
  const core = rng() < 0.5 ? [...kit.core] : [kit.core[1], kit.core[0], ...kit.core.slice(2)];
  const tail = core.slice(2).sort(() => rng() - 0.5);
  const fullCore = [core[0], core[1], ...tail] as number[];
  const antiHeal = rng() < 0.3;
  if (antiHeal && !fullCore.includes(kit.antiHeal)) fullCore.splice(2, 0, kit.antiHeal);
  return {
    champ,
    kit,
    core: fullCore.slice(0, 5),
    boots: weightedPick(
      rng,
      kit.boots.map((b, i) => [b, i === 0 ? 3 : 1] as const),
    ),
    page: weightedPick(
      rng,
      kit.pages.map((p, i) => [p, i === 0 ? 2 : 1] as const),
    ),
    spells: weightedPick(
      rng,
      kit.spells.map((s, i) => [s, i === 0 ? 3 : 1] as const),
    ),
    antiHeal: antiHeal || fullCore.slice(0, 4).includes(kit.antiHeal),
  };
}

function itemEvents(
  rng: Rng,
  participantId: number,
  l: Loadout,
  durationS: number,
): ParsedItemEvent[] {
  const events: ParsedItemEvent[] = [];
  const push = (atMs: number, type: ParsedItemEvent['type'], itemId: number) =>
    events.push({
      participantId,
      seq: events.length + 1,
      atMs,
      type,
      itemId,
      undoAfterItemId: type === 'UNDO' ? 0 : null,
      undoGoldGain: type === 'UNDO' ? (ITEMS_BY_ID.get(itemId)?.gold ?? 0) : null,
    });
  push(2000, 'PURCHASED', 3340);
  // Sometimes buy the wrong starter and undo it.
  if (rng() < 0.15) {
    push(5000, 'PURCHASED', 1054);
    push(6000, 'UNDO', 1054);
  }
  const starter = l.kit.starter[0] ?? [];
  for (const [i, id] of starter.entries()) push(8000 + i * 500, 'PURCHASED', id);

  let t = 240_000;
  const step = 2 * Math.floor(Math.max(150_000, (durationS * 1000 - 300_000) / 6) / 2);
  const buy = (itemId: number) => {
    const def = ITEMS_BY_ID.get(itemId);
    for (const comp of def?.from ?? []) {
      push(t, 'PURCHASED', comp);
      t += 1000;
    }
    t += step / 2;
    for (const comp of def?.from ?? []) push(t, 'DESTROYED', comp);
    push(t, 'PURCHASED', itemId);
    if (rng() < 0.3) push(t, 'PURCHASED', 2003);
    t += step / 2;
  };
  // First back: boots + a control ward.
  push(t, 'PURCHASED', 1001);
  push(t + 100, 'PURCHASED', 2055);
  t += 1000;
  buy(l.core[0] as number);
  push(t, 'DESTROYED', 1001);
  push(t, 'PURCHASED', l.boots);
  t += 1000;
  for (const id of l.core.slice(1)) {
    if (t > durationS * 1000) break;
    buy(id);
  }
  return events;
}

function skillEvents(participantId: number, champ: SynthChampion, rng: Rng): ParsedSkillEvent[] {
  const [a, b, c] = champ.maxOrder;
  const first3 = rng() < 0.7 ? [a, b, c] : [a, c, b];
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const seq: number[] = [];
  for (let level = 1; level <= 18; level++) {
    let slot: number;
    if (level <= 3) slot = first3[level - 1] as number;
    else if (level === 6 || level === 11 || level === 16) slot = 4;
    else slot = [a, b, c].find((s) => (counts[s] ?? 0) < 5) ?? a;
    counts[slot] = (counts[slot] ?? 0) + 1;
    seq.push(slot);
  }
  return seq.slice(0, 16).map((skillSlot, i) => ({
    participantId,
    seq: i + 1,
    atMs: 60_000 * (i + 1),
    skillSlot,
    isEvolve: false,
  }));
}

/** Generates `count` matches; deterministic for a given seed. */
export function generateMatches(options: GenerateOptions): ParsedMatch[] {
  const rng = createRng(options.seed ?? 42);
  const prefix = options.idPrefix ?? `SYN${options.patch.replace('.', '')}`;
  const start = options.startedAt ?? new Date('2026-11-01T00:00:00Z');
  const byRole = new Map<Position, SynthChampion[]>(
    POSITIONS.map((p) => [p, SYNTH_CHAMPIONS.filter((c) => c.role === p)]),
  );
  const out: ParsedMatch[] = [];
  for (let n = 0; n < options.count; n++) {
    const used = new Set<number>();
    const teams: Loadout[][] = [[], []];
    for (const team of teams) {
      for (const role of POSITIONS) {
        const pool = (byRole.get(role) ?? []).filter((c) => !used.has(c.id));
        const champ = weightedPick(
          rng,
          pool.map((c) => [c, options.pickWeights?.[c.id] ?? 1] as const),
        );
        used.add(champ.id);
        team.push(loadout(rng, champ));
      }
    }
    const [blue, red] = teams as [Loadout[], Loadout[]];
    const teamHealing = (t: Loadout[]) => t.reduce((s, l) => s + (l.champ.healing ?? 0), 0);
    const logit = (own: Loadout[], opp: Loadout[]) => {
      let x = 0;
      own.forEach((l, i) => {
        const o = opp[i] as Loadout;
        x += l.champ.strength + pairNoise(l.champ.id, o.champ.id);
        if (
          l.champ.id === PLANTED.matchup.championId &&
          opp.some((e) => e.champ.id === PLANTED.matchup.opponentId)
        ) {
          x += PLANTED.matchup.logit;
        }
        if (
          l.champ.id === PLANTED.runeMatchup.championId &&
          opp.some((e) => e.champ.id === PLANTED.runeMatchup.opponentId)
        ) {
          x +=
            l.page.runes[0] === PLANTED.runeMatchup.keystone
              ? PLANTED.runeMatchup.logit
              : -PLANTED.runeMatchup.logit;
        }
        if (
          l.champ.id === PLANTED.duo.championId &&
          own.some((a) => a.champ.id === PLANTED.duo.allyId)
        ) {
          x += PLANTED.duo.logit;
        }
        if (l.antiHeal && teamHealing(opp) >= 120) x += PLANTED.antiHealVsHealing;
      });
      return x;
    };
    const blueWins = rng() < sigmoid(logit(blue, red) - logit(red, blue));
    const isRemake = rng() < 0.01;
    const durationS = isRemake ? 210 : Math.round(between(rng, 1400, 2300));
    const minutes = Math.floor(durationS / 60) + 1;
    const id = `${prefix}_${n + 1}`;

    const participants: ParsedParticipant[] = [];
    const itemEv: ParsedItemEvent[] = [];
    const skillEv: ParsedSkillEvent[] = [];
    [blue, red].forEach((team, ti) => {
      const teamId = (ti === 0 ? 100 : 200) as 100 | 200;
      const win = (teamId === 100) === blueWins;
      team.forEach((l, i) => {
        const participantId = ti * 5 + i + 1;
        const k = l.kit;
        const dmg = Math.round(k.damage * (durationS / 60) * between(rng, 0.7, 1.3));
        const trueShare = 0.05;
        const phys = Math.round(dmg * k.physical);
        const magic = Math.round(dmg * k.magic);
        // Supports end with a quest upgrade, 7 times out of 8 Celestial Opposition (engage) or
        // Solstice Sleigh (enchanters); deterministic so the other draws are unchanged.
        const quest =
          POSITIONS[i] !== 'UTILITY'
            ? null
            : (l.champ.archetype === 'engage') === ((n + participantId) % 8 !== 0)
              ? 3869
              : 3876;
        const finalItems =
          quest === null
            ? [...l.core.slice(0, 5), l.boots, 3340]
            : [quest, ...l.core.slice(0, 4), l.boots, 3340];
        participants.push({
          participantId,
          puuid: `synthetic-puuid-${id}-${participantId}`,
          riotIdGameName: `Synthetic ${participantId}`,
          riotIdTagLine: 'SYN',
          teamId,
          championId: l.champ.id,
          position: POSITIONS[i] as Position,
          win,
          summonerSpell1: l.spells[0] as number,
          summonerSpell2: l.spells[1] as number,
          runePrimaryTree: l.page.primary,
          runeSecondaryTree: l.page.secondary,
          runes: [...l.page.runes],
          statShards: [...l.page.shards],
          finalItems,
          champLevel: 15,
          kills: Math.floor(rng() * 10),
          deaths: Math.floor(rng() * 8),
          assists: Math.floor(rng() * 15),
          laneMinions: 150,
          jungleMinions: 10,
          goldEarned: 11000,
          goldSpent: 10500,
          damageToChampions: dmg,
          physicalDamageToChampions: phys,
          magicDamageToChampions: magic,
          trueDamageToChampions: Math.max(0, Math.round(dmg * trueShare)),
          damageTaken: Math.round(k.tank * 0.6 * (durationS / 60) * between(rng, 0.8, 1.2)),
          damageSelfMitigated: Math.round(k.tank * 0.4 * (durationS / 60) * between(rng, 0.8, 1.2)),
          damageToBuildings: 2000,
          damageToObjectives: 4000,
          healingDone: Math.round(
            (l.champ.healing ?? 5) * (durationS / 60) * between(rng, 0.8, 1.2),
          ),
          healsOnTeammates: 0,
          shieldsOnTeammates: 0,
          ccTimeOnOthersS: Math.round(k.cc * (durationS / 60) * between(rng, 0.7, 1.3)),
          visionScore: 25,
          wardsPlaced: 10,
          wardsKilled: 3,
          controlWardsBought: 2,
          goldByMinute: Array.from({ length: minutes }, (_, m) => 500 + m * 400),
          xpByMinute: Array.from({ length: minutes }, (_, m) => m * 450),
          csByMinute: Array.from({ length: minutes }, (_, m) => m * 7),
          levelByMinute: Array.from({ length: minutes }, (_, m) =>
            Math.min(18, 1 + Math.floor(m / 2)),
          ),
          damageToChampionsByMinute: Array.from({ length: minutes }, (_, m) => m * 500),
          positionXByMinute: Array.from({ length: minutes }, () => 7000),
          positionYByMinute: Array.from({ length: minutes }, () => 7000),
        });
        if (!isRemake) {
          itemEv.push(...itemEvents(rng, participantId, l, durationS));
          skillEv.push(...skillEvents(participantId, l.champ, rng));
        }
      });
    });

    const bansPool = SYNTH_CHAMPIONS.filter((c) => !used.has(c.id));
    out.push({
      match: {
        id,
        platform: (['KR', 'EUW1', 'NA1', 'VN2'] as const)[n % 4] ?? 'EUW1',
        patch: options.patch,
        gameVersion: `${options.patch}.700.1`,
        queueId: 420,
        startedAt: new Date(start.getTime() + n * 60_000),
        durationS,
        isRemake,
        isEarlySurrender: isRemake,
        winningTeam: blueWins ? 100 : 200,
      },
      teams: ([100, 200] as const).map((teamId) => ({
        teamId,
        win: (teamId === 100) === blueWins,
        firstBlood: false,
        firstTower: false,
        firstDragon: false,
        firstBaron: false,
        championKills: 20,
        towerKills: 5,
        inhibitorKills: 1,
        dragonKills: 2,
        baronKills: 0,
        heraldKills: 0,
        voidgrubKills: 3,
        atakhanKills: 0,
      })),
      bans: Array.from({ length: 10 }, (_, i) => ({
        teamId: (i < 5 ? 100 : 200) as 100 | 200,
        pickTurn: i + 1,
        championId: pick(rng, bansPool).id,
      })),
      participants,
      itemEvents: itemEv,
      skillEvents: skillEv,
      killEvents: [],
      objectiveEvents: [],
    });
  }
  return out;
}

export { ANTI_HEAL as SYNTH_ANTI_HEAL_ITEMS };
