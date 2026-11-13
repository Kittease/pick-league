import { describe, expect, test } from 'bun:test';
import { thresholds, traitsOf } from './fixtures.ts';
import { choosePatch, formatDelta, formatGames, shrink } from './math.ts';
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
    expect(formatDelta(0.0001)).toBe('±0.0%');
    expect(formatGames(1240)).toBe('1,240');
  });
});

describe('choosePatch', () => {
  test('keeps the current patch above the threshold', () => {
    expect(choosePatch('15.22', '15.21', 150, 900, 150)).toMatchObject({
      patch: '15.22',
      fellBack: false,
    });
  });
  test('falls back to the previous patch when it has more games', () => {
    expect(choosePatch('15.22', '15.21', 40, 900, 150)).toMatchObject({
      patch: '15.21',
      fellBack: true,
      games: 900,
      currentGames: 40,
    });
  });
  test('stays on the current patch when the previous one is no better', () => {
    expect(choosePatch('15.22', '15.21', 40, 10, 150).patch).toBe('15.22');
    expect(choosePatch('15.22', null, 40, 0, 150).patch).toBe('15.22');
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
