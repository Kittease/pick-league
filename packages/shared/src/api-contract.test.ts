import { describe, expect, test } from 'bun:test';
import {
  livePlayersRequestSchema,
  tierListQuerySchema,
  toTierListFilters,
} from './api-contract.ts';

describe('live players request', () => {
  const player = (n: number) => ({
    puuid: `fake-live-puuid-${n}`,
    championId: 412,
    position: 'UTILITY',
    team: n < 5 ? 'ally' : 'enemy',
  });

  test('accepts up to 10 distinct players of a crawled platform', () => {
    const players = Array.from({ length: 10 }, (_, i) => player(i));
    const parsed = livePlayersRequestSchema.parse({ platform: 'EUW1', players });
    expect(parsed.players).toHaveLength(10);
    expect(
      livePlayersRequestSchema.safeParse({
        platform: 'KR',
        players: [{ ...player(1), position: null }],
      }).success,
    ).toBe(true);
  });

  test('rejects bad platforms, sizes, duplicates and malformed players', () => {
    const valid = (body: unknown) => livePlayersRequestSchema.safeParse(body).success;
    expect(valid({ platform: 'EUW', players: [player(1)] })).toBe(false);
    expect(valid({ platform: 'EUW1', players: [] })).toBe(false);
    expect(
      valid({ platform: 'EUW1', players: Array.from({ length: 11 }, (_, i) => player(i)) }),
    ).toBe(false);
    expect(valid({ platform: 'EUW1', players: [player(1), player(1)] })).toBe(false);
    expect(valid({ platform: 'EUW1', players: [{ ...player(1), puuid: 'not a puuid/..' }] })).toBe(
      false,
    );
    expect(valid({ platform: 'EUW1', players: [{ ...player(1), team: 'blue' }] })).toBe(false);
    expect(valid({ platform: 'EUW1', players: [{ ...player(1), championId: 0 }] })).toBe(false);
    expect(valid({ platform: 'EUW1', players: [{ ...player(1), position: 'SUPPORT' }] })).toBe(
      false,
    );
  });
});

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
