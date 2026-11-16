import { describe, expect, test } from 'bun:test';
import { tierListQuerySchema, toTierListFilters } from './api-contract.ts';

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
