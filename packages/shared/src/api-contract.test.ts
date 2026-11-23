import { describe, expect, test } from 'bun:test';
import {
  type BuildResponse,
  type ItemsRecommendation,
  type LateSwap,
  MAX_MASTERIES,
  picksRequestSchema,
  tierListQuerySchema,
  toTierListFilters,
} from './api-contract.ts';

describe('tier list filters', () => {
  test('query defaults to every server and Diamond+', () => {
    expect(tierListQuerySchema.parse({ role: 'UTILITY' })).toEqual({
      role: 'UTILITY',
      patch: 'latest',
      platform: 'ALL',
      rank: 'DIAMOND',
    });
    expect(
      tierListQuerySchema.parse({ role: 'TOP', platform: 'VN2', rank: 'CHALLENGER' }),
    ).toMatchObject({ platform: 'VN2', rank: 'CHALLENGER' });
    expect(tierListQuerySchema.safeParse({ role: 'TOP', platform: 'EUW' }).success).toBe(false);
    expect(tierListQuerySchema.parse({ role: 'TOP', rank: 'MASTER' }).rank).toBe('MASTER');
    expect(tierListQuerySchema.safeParse({ role: 'TOP', rank: 'EMERALD' }).success).toBe(false);
  });

  test('untrusted filters fall back to the defaults field by field', () => {
    expect(toTierListFilters({ platform: 'KR', rank: 'GRANDMASTER' })).toEqual({
      platform: 'KR',
      rank: 'GRANDMASTER',
    });
    expect(toTierListFilters({ platform: 'OC1', rank: 'CHALLENGER' })).toEqual({
      platform: 'ALL',
      rank: 'CHALLENGER',
    });
    expect(toTierListFilters(null)).toEqual({ platform: 'ALL', rank: 'DIAMOND' });
    expect(toTierListFilters('KR')).toEqual({ platform: 'ALL', rank: 'DIAMOND' });
  });
});

describe('picks request masteries', () => {
  const base = { role: 'UTILITY' as const };

  test('accepted with integer points; absent stays undefined', () => {
    const parsed = picksRequestSchema.parse({
      ...base,
      masteries: [
        { championId: 89, points: 123_456 },
        { championId: 40, points: 0 },
      ],
    });
    expect(parsed.masteries).toEqual([
      { championId: 89, points: 123_456 },
      { championId: 40, points: 0 },
    ]);
    const without = picksRequestSchema.parse(base);
    expect('masteries' in without).toBe(false);
    expect(without.masteries).toBeUndefined();
  });

  test('negative or fractional points and invalid champions are rejected', () => {
    for (const m of [
      { championId: 89, points: -1 },
      { championId: 89, points: 1.5 },
      { championId: 0, points: 1000 },
    ]) {
      expect(picksRequestSchema.safeParse({ ...base, masteries: [m] }).success).toBe(false);
    }
  });

  test('capped at MAX_MASTERIES entries', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ championId: i + 1, points: 1000 }));
    expect(picksRequestSchema.safeParse({ ...base, masteries: many(MAX_MASTERIES) }).success).toBe(
      true,
    );
    expect(
      picksRequestSchema.safeParse({ ...base, masteries: many(MAX_MASTERIES + 1) }).success,
    ).toBe(false);
  });
});

describe('build response late-game swaps', () => {
  test('part of the items, always a list; a swap has nothing to score with', () => {
    const swap: LateSwap = { sellItemId: 3026, buyItemId: 3072, games: 42, minute: 37.6 };
    const items: ItemsRecommendation = {
      starting: [],
      early: [],
      core: [],
      coreBuilds: [],
      situational: [],
      late: [],
      lateSwaps: [swap],
    };
    const fromBuild: BuildResponse['items']['lateSwaps'] = items.lateSwaps;
    expect(fromBuild).toEqual([swap]);
    // No win rate, no delta, no reasons: the swap explains and never scores.
    const scoring: Extract<keyof LateSwap, 'winRate' | 'delta' | 'reasons' | 'wins'> extends never
      ? true
      : false = true;
    expect(scoring).toBe(true);
    expect(Object.keys(swap).sort()).toEqual(['buyItemId', 'games', 'minute', 'sellItemId']);
  });
});
