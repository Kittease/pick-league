import { describe, expect, test } from 'bun:test';
import { stageReference } from './build.ts';
import { thresholds, traitsOf } from './fixtures.ts';
import { choosePatches, formatDelta, formatGames, patchesLabel, shrink, sumByKey } from './math.ts';
import { assignRoles, rolePlayRates } from './roles.ts';
import { skillMaxOrder, synthesiseSkillSequence } from './skills.ts';
import { compProfile, compTraits } from './traits.ts';

describe('shrinkage', () => {
  test('delta * n / (n + k)', () => {
    expect(shrink(0.1, 100, 100)).toBeCloseTo(0.05);
    expect(shrink(0.1, 900, 100)).toBeCloseTo(0.09);
    expect(shrink(0.1, 0, 100)).toBe(0);
  });
});

describe('formatting', () => {
  test('deltas and games', () => {
    expect(formatDelta(0.0281)).toBe('+2.8%');
    expect(formatDelta(-0.013)).toBe('−1.3%');
    expect(formatDelta(0.0001)).toBe('0.0%');
    expect(formatDelta(-0.0004)).toBe('0.0%');
    expect(formatGames(1240)).toBe('1,240 games');
    expect(formatGames(1)).toBe('1 game');
  });
});

describe('choosePatches', () => {
  test('keeps the current patch alone from the threshold on', () => {
    expect(choosePatches('15.22', '15.21', 150, 900, 150)).toEqual({
      patches: ['15.22'],
      merged: false,
      currentGames: 150,
    });
  });
  test('adds the previous patch below the threshold', () => {
    expect(choosePatches('15.22', '15.21', 40, 10, 150)).toEqual({
      patches: ['15.22', '15.21'],
      merged: true,
      currentGames: 40,
    });
    expect(patchesLabel(['15.22', '15.21'])).toBe('15.22 + 15.21');
  });
  test('stays on the current patch when there is no previous data', () => {
    expect(choosePatches('15.22', '15.21', 40, 0, 150).merged).toBe(false);
    expect(choosePatches('15.22', null, 40, 0, 150).patches).toEqual(['15.22']);
  });
});

describe('sumByKey', () => {
  test('adds games and wins of rows sharing a key', () => {
    const rows = [
      { id: 1, patch: '15.22', games: 10, wins: 6 },
      { id: 2, patch: '15.22', games: 5, wins: 1 },
      { id: 1, patch: '15.21', games: 90, wins: 40 },
    ];
    expect(sumByKey(rows, (r) => String(r.id))).toEqual([
      { id: 1, patch: '15.22', games: 100, wins: 46 },
      { id: 2, patch: '15.22', games: 5, wins: 1 },
    ]);
  });
});

describe('compTraits', () => {
  const t = thresholds('15.22');
  test('buckets a team by the patch thresholds', () => {
    const profile = compProfile([
      traitsOf('15.22', 1, {
        physicalShare: 0.9,
        magicShare: 0.05,
        isRanged: false,
        healingPerMin: 80,
      }),
      traitsOf('15.22', 2, {
        physicalShare: 0.8,
        magicShare: 0.15,
        isRanged: false,
        healingPerMin: 30,
      }),
      traitsOf('15.22', 3, {
        physicalShare: 0.7,
        magicShare: 0.25,
        isRanged: true,
        healingPerMin: 20,
      }),
    ]);
    expect(compTraits(profile, t)).toEqual(['AD_HEAVY', 'HIGH_HEALING', 'MELEE_HEAVY']);
  });
  test('needs at least two known champions', () => {
    expect(compTraits(compProfile([traitsOf('15.22', 1, { physicalShare: 1 })]), t)).toEqual([]);
    expect(compTraits(null, t)).toEqual([]);
  });
});

describe('assignRoles', () => {
  const rates = rolePlayRates([
    { patch: 'p', championId: 412, position: 'UTILITY', games: 900, wins: 450 },
    { patch: 'p', championId: 222, position: 'BOTTOM', games: 900, wins: 450 },
    { patch: 'p', championId: 103, position: 'MIDDLE', games: 600, wins: 300 },
    { patch: 'p', championId: 103, position: 'UTILITY', games: 400, wins: 200 },
  ]);
  test('maximises the joint play rate', () => {
    const guesses = assignRoles(
      [
        { championId: 103, role: null },
        { championId: 412, role: null },
      ],
      rates,
    );
    expect(guesses.find((g) => g.championId === 412)?.role).toBe('UTILITY');
    expect(guesses.find((g) => g.championId === 103)?.role).toBe('MIDDLE');
  });
  test('keeps known roles and skips taken ones', () => {
    const guesses = assignRoles(
      [
        { championId: 222, role: 'BOTTOM' },
        { championId: 103, role: null },
      ],
      rates,
      ['MIDDLE'],
    );
    expect(guesses).toContainEqual({
      championId: 222,
      role: 'BOTTOM',
      known: true,
      probability: 1,
    });
    expect(guesses.find((g) => g.championId === 103)).toMatchObject({
      role: 'UTILITY',
      known: false,
    });
  });
});

describe('skills', () => {
  test('max order from the 5th point', () => {
    expect(skillMaxOrder([1, 3, 2, 1, 1, 4, 1, 1, 3, 3, 4, 3, 3, 2, 2, 4, 2, 2])).toEqual([
      1, 3, 2,
    ]);
    expect(skillMaxOrder([1, 2, 3])).toBeNull();
  });
  test('synthesised sequence puts R at 6/11/16', () => {
    const seq = synthesiseSkillSequence([3, 1, 2], [3, 2, 1]);
    expect(seq).toHaveLength(18);
    expect([seq[5], seq[10], seq[15]]).toEqual([4, 4, 4]);
    expect(skillMaxOrder(seq)).toEqual([3, 2, 1]);
  });
});

describe('stageReference', () => {
  const done = (choice: string, games: number, wins: number) => ({
    kind: 'items_done' as const,
    choice,
    games,
    wins,
  });
  test('players with at least that many items, interpolated between whole counts', () => {
    const rows = [done('2', 100, 40), done('3', 100, 50), done('4', 100, 60)];
    expect(stageReference(rows, 3)).toEqual({ games: 200, wins: 110 });
    expect(stageReference(rows, 3.5)).toEqual({ games: 150, wins: 85 });
  });
  test('null without items_done rows', () => {
    expect(stageReference([], 2)).toBeNull();
  });
});
