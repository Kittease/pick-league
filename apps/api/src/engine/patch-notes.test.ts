import { describe, expect, test } from 'bun:test';
import type { PatchValueChange } from '@pick-league/shared';
import {
  classifyChange,
  classifyChanges,
  compareVerdicts,
  damageSplitOf,
  groupBySlot,
  humanize,
  itemUsersOf,
  observedChanges,
  ratioDamageType,
  relativeChange,
  ruleOf,
  verdictOf,
} from './patch-notes.ts';
import type { ChampionTraitRow, RoleStatRow } from './types.ts';

const change = (over: Partial<PatchValueChange>): PatchValueChange => ({
  slot: 'Q',
  spellName: 'TestQ',
  calculation: null,
  valueName: 'BaseDamage',
  oldValues: [100],
  newValues: [110],
  path: '',
  ...over,
});

/** Damage splits measured on 16.23 (stats_champion_traits). */
const EZREAL = { physical: 0.65, magic: 0.33 };
const SYNDRA = { physical: 0.04, magic: 0.9 };
const AZIR = { physical: 0.03, magic: 0.95 };

describe('value rules', () => {
  const direction = (over: Partial<PatchValueChange>) =>
    classifyChange(change(over), null).direction;

  test.each([
    // [value name, old, new, expected direction]
    ['BaseDamage', 100, 110, 'buff'],
    ['bonusAdRatio', 1, 1.15, 'buff'],
    ['apRatio', 0.4, 0.35, 'nerf'],
    ['Cooldown', 15, 17, 'nerf'],
    ['Cost', 50, 60, 'nerf'],
    ['spellCastTime', 0.25, 0.2, 'buff'],
    ['BaseShield', 50, 60, 'buff'],
    ['BaseHeal', 10, 20, 'buff'],
    ['SleepDuration', 2.5, 3, 'buff'],
    ['SlowDuration', 1, 1.5, 'buff'],
    ['AreaSlowAmount', 0.2, 0.3, 'buff'],
    ['RBuffDuration', 3.5, 4, 'buff'],
    ['castRangeValues', 600, 650, 'buff'],
    ['AttackSpeedMod', 0.6, 0.4, 'nerf'],
    ['MovementSpeedAmount', 28, 30, 'buff'],
    ['BonusASRanged', 35, 25, 'nerf'],
    ['DamageReduction', 0.3, 0.25, 'nerf'],
    ['CDRPerBlightStack', 0.13, 0.11, 'nerf'],
    ['AmmoRechargeTime', 18, 16, 'buff'],
    ['CritDamageMultiplier', 0.3, 0.45, 'buff'],
    ['PercentCurrentHPMelee', 9, 8, 'nerf'],
    ['BonusMRPercent', 0.6, 0.5, 'nerf'],
    ['MinionDamageCap', 100, 120, 'buff'],
    // Not classified with confidence: neutral.
    ['Effect1Amount', 925, 950, 'neutral'],
    ['BaseDuration', 6, 5, 'neutral'],
    ['ExplosionCount', 6, 7, 'neutral'],
    ['ReducedDamagePercent', 30, 25, 'neutral'],
    ['AffectsTypeFlags', 6794, 6826, 'neutral'],
    ['{6216bf7b}', 40, 50, 'neutral'],
  ] as const)('%s %d → %d is %s', (valueName, from, to, expected) => {
    expect(direction({ valueName, oldValues: [from], newValues: [to] })).toBe(expected);
  });

  test('item prices: higher is a nerf', () => {
    expect(direction({ slot: null, valueName: 'price', oldValues: [700], newValues: [800] })).toBe(
      'nerf',
    );
  });

  test('base stats are better higher, attack range counts double', () => {
    const range = classifyChange(
      change({ slot: 'base', valueName: 'attackRange', oldValues: [525], newValues: [550] }),
      AZIR,
    );
    expect(range.direction).toBe('buff');
    expect(range.relevance).toBe(2);
    expect(ruleOf({ slot: 'base', valueName: 'hpRegenPerLevel', calculation: null }).better).toBe(
      'higher',
    );
  });

  test("a formula's generic part takes its calculation's meaning", () => {
    const tibbers = change({
      slot: 'R',
      calculation: 'TibbersTotalHP',
      valueName: 'Level1Value',
      oldValues: [1150],
      newValues: [1275],
    });
    expect(classifyChange(tibbers, null).direction).toBe('buff');
    const unnamed = change({ calculation: '{232dac8a}', valueName: 'Number' });
    expect(classifyChange(unnamed, null).direction).toBe('neutral');
  });

  test("an item's calculation comes from its path", () => {
    const runaan = change({
      slot: null,
      valueName: 'Number',
      oldValues: [0.65],
      newValues: [0.6],
      path: 'Items/3085/mItemCalculations/BoltDamage/mFormulaParts/adRatio/mSubpart/mNumber',
    });
    const c = classifyChange(runaan, null);
    expect(c.calculation).toBe('BoltDamage');
    expect(c.direction).toBe('nerf');
  });

  test('a value present on one side only is neutral', () => {
    expect(direction({ valueName: 'BaseDamage', oldValues: null, newValues: [60] })).toBe(
      'neutral',
    );
  });

  test('a value 20 times larger changed its unit: neutral', () => {
    expect(direction({ valueName: 'BuffDuration', oldValues: [90], newValues: [25000] })).toBe(
      'neutral',
    );
  });
});

describe('ratioDamageType', () => {
  test.each([
    ['apRatio', 'magic'],
    ['APRatio', 'magic'],
    ['RAPRatio', 'magic'],
    ['DamageperSecondAPRatio', 'magic'],
    ['bonusAdRatio', 'physical'],
    ['adRatio', 'physical'],
    ['BADRatio', 'physical'],
    ['AttackDamageRatio', 'physical'],
    ['OnHitADRatio', 'physical'],
    ['bonusCurrentHealthRatio', null],
    ['PassiveShieldHealthRatio', null],
  ] as const)('%s → %s', (name, type) => {
    expect(ratioDamageType(name)).toBe(type);
  });
});

describe('relativeChange', () => {
  test('ranks averaged', () => {
    // Ezreal R: 350/550/750 → 350/600/850.
    expect(relativeChange([350, 550, 750], [350, 600, 850])).toBeCloseTo(
      (0 + 50 / 550 + 100 / 750) / 3,
    );
  });
  test('one value against every rank, each rank capped at ±100 %', () => {
    expect(relativeChange([10], [10, 20, 40])).toBeCloseTo((0 + 1 + 1) / 3);
    expect(relativeChange([0], [5])).toBe(1);
  });
  test('null when a side is missing', () => {
    expect(relativeChange(null, [1])).toBeNull();
  });
});

describe('16.23 champions', () => {
  test('Ezreal: AD ratios count, his AP ratios are minor; overall buff', () => {
    const changes = classifyChanges(
      [
        change({
          slot: 'W',
          spellName: 'EzrealW',
          valueName: 'APRatio',
          oldValues: [0.9, 0.9, 0.9, 0.9, 0.9],
          newValues: [1, 1, 1, 1, 1],
        }),
        change({
          slot: 'W',
          spellName: 'EzrealW',
          calculation: 'Damage',
          valueName: 'bonusAdRatio',
          oldValues: [1],
          newValues: [1.15],
        }),
        change({
          slot: 'R',
          spellName: 'EzrealR',
          valueName: 'BaseDamage',
          oldValues: [350, 550, 750],
          newValues: [350, 600, 850],
        }),
        change({
          slot: 'R',
          spellName: 'EzrealR',
          valueName: 'RAPRatio',
          oldValues: [1.1, 1.1, 1.1],
          newValues: [1.2, 1.2, 1.2],
        }),
        change({
          slot: 'R',
          spellName: 'EzrealR',
          calculation: 'Damage',
          valueName: 'bonusAdRatio',
          oldValues: [1],
          newValues: [1.1],
        }),
      ],
      EZREAL,
    );
    const [wAp, wAd, rBase, rAp, rAd] = changes;
    expect(changes.every((c) => c.direction === 'buff')).toBe(true);
    expect(wAp?.minor).toBe(true);
    expect(rAp?.minor).toBe(true);
    expect(wAd?.minor).toBe(false);
    expect(rAd?.minor).toBe(false);
    expect(rBase?.minor).toBe(false);
    // AD ratio: +15 % × (0.1 + 0.9 × 0.65); AP ratio: +11 % × (0.1 + 0.9 × 0.33).
    expect(wAd?.weight).toBeCloseTo(0.15 * (0.1 + 0.9 * 0.65));
    expect(wAp?.weight).toBeCloseTo((0.1 / 0.9) * (0.1 + 0.9 * 0.33));
    expect(wAd?.unit).toBe('percent');
    expect(wAd?.label).toBe('Damage · bonus AD ratio');
    expect(verdictOf('changed', changes).verdict).toBe('buff');
  });

  test('Syndra: E cooldown and cost up, merged across SyndraE / SyndraE5: nerf', () => {
    const cd = {
      slot: 'E',
      valueName: 'Cooldown',
      oldValues: [15, 15, 15, 15, 15],
      newValues: [17, 16.5, 16, 15.5, 15],
    };
    const cost = {
      slot: 'E',
      valueName: 'Cost',
      oldValues: [50, 50, 50, 50, 50],
      newValues: [60, 60, 60, 60, 60],
    };
    const changes = classifyChanges(
      [
        change({ ...cd, spellName: 'SyndraE' }),
        change({ ...cost, spellName: 'SyndraE' }),
        change({ ...cd, spellName: 'SyndraE5' }),
        change({ ...cost, spellName: 'SyndraE5' }),
      ],
      SYNDRA,
    );
    expect(changes).toHaveLength(2);
    expect(changes[0]?.spellNames).toEqual(['SyndraE', 'SyndraE5']);
    expect(changes[0]?.unit).toBe('seconds');
    expect(changes.map((c) => c.direction)).toEqual(['nerf', 'nerf']);
    expect(verdictOf('changed', changes).verdict).toBe('nerf');
  });

  test('Azir: attack range and W on-hit multiplier up: buff', () => {
    const changes = classifyChanges(
      [
        change({
          slot: 'base',
          spellName: null,
          valueName: 'attackRange',
          oldValues: [525],
          newValues: [550],
        }),
        change({
          slot: 'W',
          spellName: 'AzirW',
          valueName: 'OnHitMultiplier',
          oldValues: [0.5, 0.5, 0.5, 0.5, 0.5],
          newValues: [0.67, 0.67, 0.67, 0.67, 0.67],
        }),
      ],
      AZIR,
    );
    expect(changes.map((c) => c.direction)).toEqual(['buff', 'buff']);
    expect(changes[0]?.weight).toBeCloseTo((25 / 525) * 2);
    expect(changes[1]?.unit).toBe('percent');
    expect(verdictOf('changed', changes).verdict).toBe('buff');
  });

  test('Voltaic Cyclosword: current HP damage down: nerf', () => {
    const changes = classifyChanges(
      [
        change({
          slot: null,
          spellName: null,
          valueName: 'PercentCurrentHPMelee',
          oldValues: [9],
          newValues: [8],
        }),
        change({
          slot: null,
          spellName: null,
          valueName: 'PercentCurrentHPRanged',
          oldValues: [7],
          newValues: [6],
        }),
      ],
      null,
    );
    expect(changes[0]?.unit).toBe('percentPoints');
    expect(verdictOf('changed', changes).verdict).toBe('nerf');
  });
});

describe('verdictOf', () => {
  const weighted = (weight: number, over: Partial<PatchValueChange> = {}) => ({
    ...classifyChange(change(over), null),
    spellNames: [],
    weight,
  });

  test('balanced buffs and nerfs are mixed, small totals adjusted', () => {
    expect(verdictOf('changed', [weighted(0.2), weighted(-0.12)]).verdict).toBe('mixed');
    expect(verdictOf('changed', [weighted(0.2), weighted(-0.05)]).verdict).toBe('buff');
    expect(verdictOf('changed', [weighted(0.01)]).verdict).toBe('adjusted');
  });

  test('five values appearing or disappearing: reworked; status wins', () => {
    const rework = Array.from({ length: 5 }, () => weighted(0, { oldValues: null }));
    expect(verdictOf('changed', rework).verdict).toBe('reworked');
    expect(verdictOf('new', []).verdict).toBe('new');
  });

  test('order: buffs (biggest first), …, nerfs (biggest last)', () => {
    const list = [
      { name: 'A', verdict: 'nerf', score: -0.3, buffWeight: 0, nerfWeight: 0.3 },
      { name: 'B', verdict: 'buff', score: 0.1, buffWeight: 0.1, nerfWeight: 0 },
      { name: 'C', verdict: 'mixed', score: 0, buffWeight: 0.1, nerfWeight: 0.1 },
      { name: 'D', verdict: 'buff', score: 0.4, buffWeight: 0.4, nerfWeight: 0 },
      { name: 'E', verdict: 'nerf', score: -0.1, buffWeight: 0, nerfWeight: 0.1 },
    ] as const;
    expect([...list].sort(compareVerdicts).map((x) => x.name)).toEqual(['D', 'B', 'C', 'E', 'A']);
  });
});

test('groupBySlot: P Q W E R base other', () => {
  const changes = classifyChanges(
    [
      change({ slot: 'R', valueName: 'BaseDamage' }),
      change({ slot: 'base', valueName: 'baseHP' }),
      change({ slot: 'P', valueName: 'BaseDamage', spellName: 'P' }),
      change({ slot: 'Q', valueName: 'Cooldown' }),
    ],
    null,
  );
  expect(groupBySlot(changes).map((g) => g.slot)).toEqual(['P', 'Q', 'R', 'base']);
});

test('humanize', () => {
  expect(humanize('bonusAdRatio')).toBe('Bonus AD ratio');
  expect(humanize('BaseDamage')).toBe('Base damage');
  expect(humanize('BADRatio')).toBe('Bonus AD ratio');
  expect(humanize('AStoADChampion')).toBe('AS to AD champion');
  expect(humanize('HealCapLevel1Value')).toBe('Heal cap level 1 value');
  expect(humanize('{6216bf7b}')).toBe('Unnamed value');
});

describe('damageSplitOf', () => {
  const trait = (patch: string, games: number, physicalShare: number): ChampionTraitRow => ({
    patch,
    championId: 81,
    games,
    physicalShare,
    magicShare: 1 - physicalShare,
    trueShare: 0,
    damagePerMin: 0,
    ccPerMin: 0,
    healingPerMin: 0,
    tankinessPerMin: 0,
    attackRange: 550,
    isRanged: true,
  });

  test('the first row with enough games, else Data Dragon ratings, else half and half', () => {
    expect(
      damageSplitOf([trait('15.22', 50, 0.9), trait('15.21', 5000, 0.6)], undefined),
    ).toMatchObject({
      physical: 0.6,
      source: 'stats',
      patch: '15.21',
    });
    expect(damageSplitOf([], { attack: 7, magic: 3 })).toMatchObject({
      physical: 0.7,
      source: 'ddragon',
    });
    expect(damageSplitOf([], undefined)).toMatchObject({ physical: 0.5, source: 'none' });
  });
});

test('observedChanges: main roles, centred on the role average, enough games on both patches', () => {
  const r = (
    patch: string,
    championId: number,
    position: RoleStatRow['position'],
    games: number,
    wins: number,
  ): RoleStatRow => ({
    patch,
    championId,
    position,
    games,
    wins,
  });
  const rows = [
    r('15.22', 1, 'MIDDLE', 1000, 550),
    r('15.21', 1, 'MIDDLE', 1000, 500),
    r('15.22', 2, 'MIDDLE', 1000, 450),
    r('15.21', 2, 'MIDDLE', 1000, 500),
    // Too few games: not a main role.
    r('15.22', 1, 'TOP', 50, 40),
    r('15.21', 1, 'TOP', 600, 300),
  ];
  const out = observedChanges(1, rows, '15.22', '15.21');
  expect(out).toHaveLength(1);
  // 55 % vs a 50 % role average, against 50 % vs 50 %: +5 points.
  expect(out[0]?.role).toBe('MIDDLE');
  expect(out[0]?.delta).toBeCloseTo(0.05);
});

test('itemUsersOf: shares at 15 % or more, most frequent first', () => {
  const users = itemUsersOf([
    { itemId: 6699, championId: 1, position: 'JUNGLE', games: 900, roleGames: 1000 },
    { itemId: 6699, championId: 2, position: 'MIDDLE', games: 100, roleGames: 1000 },
    { itemId: 6699, championId: 3, position: 'TOP', games: 500, roleGames: 1000 },
  ]);
  expect(users.get(6699)?.map((u) => [u.championId, u.share])).toEqual([
    [1, 0.9],
    [3, 0.5],
  ]);
});
