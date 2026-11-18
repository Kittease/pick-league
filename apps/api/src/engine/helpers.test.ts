import { describe, expect, test } from 'bun:test';
import { stageReference } from './build.ts';
import { thresholds, traitsOf } from './fixtures.ts';
import {
  blendPatches,
  formatDelta,
  formatGames,
  mixLike,
  patchesLabel,
  patchesUsedFor,
  previousWeight,
  shrink,
  sumWeighted,
} from './math.ts';
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

describe('previous patch prior', () => {
  test('a previous-patch sample counts for at most the cap', () => {
    expect(previousWeight(0, 1200)).toBe(0);
    expect(previousWeight(600, 1200)).toBe(1);
    expect(previousWeight(19_000, 1200)).toBeCloseTo(1200 / 19_000, 6);
    expect(previousWeight(19_000, 1200)).toBeCloseTo(0.0632, 4);
  });

  test('worked example: 300 current games at +4 points, 19,000 previous at +1', () => {
    const b = blendPatches({ value: 0.04, games: 300 }, { value: 0.01, games: 19_000 }, 1200);
    expect(b.games).toBeCloseTo(1500, 9);
    expect(b.value).toBeCloseTo((300 * 0.04 + 1200 * 0.01) / 1500, 9);
    expect(b.value).toBeCloseTo(0.016, 9);
    expect(b.previousShare).toBeCloseTo(0.8, 9);
    expect(b.currentGames).toBe(300);
    expect(b.previousGames).toBe(19_000);
    expect(mixLike(b, 0.54, 0.51)).toBeCloseTo((300 * 0.54 + 1200 * 0.51) / 1500, 9);
  });

  test('missing samples', () => {
    const onlyCurrent = blendPatches({ value: 0.03, games: 500 }, undefined, 1200);
    expect(onlyCurrent).toMatchObject({ value: 0.03, games: 500, previousShare: 0 });
    // A previous sample with no games is absent too.
    expect(blendPatches({ value: 0.03, games: 500 }, { value: 0.5, games: 0 }, 1200)).toEqual(
      onlyCurrent,
    );
    const onlyPrevious = blendPatches(undefined, { value: -0.02, games: 5000 }, 1200);
    expect(onlyPrevious.value).toBeCloseTo(-0.02, 12);
    expect(onlyPrevious.games).toBeCloseTo(1200, 9);
    expect(onlyPrevious.previousShare).toBe(1);
    expect(blendPatches(undefined, { value: -0.02, games: 300 }, 1200).games).toBe(300);
    expect(blendPatches(undefined, undefined, 1200)).toMatchObject({
      value: 0,
      games: 0,
      previousShare: 0,
    });
  });

  test('continuity: no jump as current games grow (nothing happens at 150)', () => {
    const previous = { value: 0.05, games: 900 };
    const blends = Array.from({ length: 401 }, (_, n) =>
      blendPatches({ value: 0, games: n }, previous, 1200),
    );
    const values = blends.map((b) => b.value);
    const games = blends.map((b) => b.games);
    const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    // From 900 games at +5 points (n = 0) to 1,300 games at ~+3.5 points (n = 400).
    expect(values[0]).toBeCloseTo(0.05, 12);
    expect(values[400]).toBeCloseTo((0.05 * 900) / 1300, 12);
    expect(games[400]).toBe(1300);
    for (let n = 1; n <= 400; n++) {
      expect(Math.abs((values[n] as number) - (values[n - 1] as number))).toBeLessThan(
        0.01 * range(values),
      );
      expect(Math.abs((games[n] as number) - (games[n - 1] as number))).toBeLessThan(
        0.01 * range(games),
      );
    }
  });

  test('patchesUsedFor lists the previous patch from 10 % of the effective games', () => {
    expect(patchesLabel(['15.22', '15.21'])).toBe('15.22 + 15.21');
    const pair = { current: '15.22', previous: '15.21' };
    expect(patchesUsedFor(pair, 0.09)).toEqual(['15.22']);
    expect(patchesUsedFor(pair, 0.1)).toEqual(['15.22', '15.21']);
    expect(patchesUsedFor({ current: '15.22', previous: null }, 1)).toEqual(['15.22']);
  });
});

describe('sumWeighted', () => {
  const rows = [
    { key: 'a', patch: '15.22', games: 100, wins: 40 },
    { key: 'a', patch: '15.21', games: 1000, wins: 600 },
    { key: 'b', patch: '15.22', games: 5, wins: 1 },
    { key: 'c', patch: '15.21', games: 1, wins: 1 },
  ];
  test('weights of 1: plain sums', () => {
    expect(
      sumWeighted(
        rows,
        () => 1,
        (r) => r.key,
      ),
    ).toEqual([
      { key: 'a', patch: '15.22', games: 1100, wins: 640 },
      { key: 'b', patch: '15.22', games: 5, wins: 1 },
      { key: 'c', patch: '15.21', games: 1, wins: 1 },
    ]);
  });
  test('previous patch at 0.25: rounded games, same weighted win rate, empty groups dropped', () => {
    const out = sumWeighted(
      rows,
      (p) => (p === '15.21' ? 0.25 : 1),
      (r) => r.key,
    );
    // 100 + 0.25 × 1,000 = 350 games; (40 + 150) / 350 win rate. "c" rounds to 0 games.
    expect(out.map((r) => r.key)).toEqual(['a', 'b']);
    expect(out[0]?.games).toBe(350);
    expect((out[0]?.wins ?? 0) / (out[0]?.games ?? 1)).toBeCloseTo((150 + 40) / 350, 12);
    expect(out[1]).toEqual({ key: 'b', patch: '15.22', games: 5, wins: 1 });
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
