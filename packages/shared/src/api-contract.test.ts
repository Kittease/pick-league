import { describe, expect, test } from 'bun:test';
import {
  MAX_MASTERIES,
  picksRequestSchema,
  tierListQuerySchema,
  toTierListFilters,
} from './api-contract.ts';

describe('tier list filters', () => {
  test('query defaults to every server and Master+', () => {
    expect(tierListQuerySchema.parse({ role: 'UTILITY' })).toEqual({
      role: 'UTILITY',
      patch: 'latest',
      platform: 'ALL',
      rank: 'MASTER',
    });
    expect(
      tierListQuerySchema.parse({ role: 'TOP', platform: 'VN2', rank: 'CHALLENGER' }),
    ).toMatchObject({ platform: 'VN2', rank: 'CHALLENGER' });
    expect(tierListQuerySchema.safeParse({ role: 'TOP', platform: 'EUW' }).success).toBe(false);
    expect(tierListQuerySchema.safeParse({ role: 'TOP', rank: 'DIAMOND' }).success).toBe(false);
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
    expect(toTierListFilters(null)).toEqual({ platform: 'ALL', rank: 'MASTER' });
    expect(toTierListFilters('KR')).toEqual({ platform: 'ALL', rank: 'MASTER' });
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
