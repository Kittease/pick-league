import { describe, expect, test } from 'bun:test';
import { buildCacheKey, picksCacheKey, TtlCache, tierListCacheKey } from './cache.ts';
import { TokenBucketLimiter } from './rate-limit.ts';

describe('TtlCache', () => {
  test('expires entries and caps its size', async () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 2, () => now);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    now = 1500;
    expect(cache.get('c')).toBeUndefined();
    const r = await cache.getOrCompute('d', async () => 4);
    expect(r).toEqual({ value: 4, hit: false });
    expect(await cache.getOrCompute('d', async () => 5)).toEqual({ value: 4, hit: true });
  });

  test('cache keys are order-insensitive', () => {
    const base = { role: 'UTILITY', allies: [], bans: [] as number[] };
    expect(picksCacheKey({ ...base, enemies: [1, null, 2], bans: [5, 4] })).toBe(
      picksCacheKey({ ...base, enemies: [2, 1], bans: [4, 5] }),
    );
    expect(picksCacheKey({ ...base, enemies: [1] })).not.toBe(
      picksCacheKey({ ...base, enemies: [2] }),
    );
    const b = { championId: 1, role: 'TOP', allies: [] };
    expect(
      buildCacheKey({
        ...b,
        enemies: [
          { championId: 2, role: null },
          { championId: 3, role: 'TOP' },
        ],
      }),
    ).toBe(
      buildCacheKey({
        ...b,
        enemies: [
          { championId: 3, role: 'TOP' },
          { championId: 2, role: null },
        ],
      }),
    );
  });

  test('tier list cache keys include the server and rank filters', () => {
    const q = { role: 'UTILITY', patch: 'latest', platform: 'ALL', rank: 'MASTER' };
    const key = tierListCacheKey(q);
    expect(tierListCacheKey({ ...q })).toBe(key);
    expect(tierListCacheKey({ ...q, platform: 'KR' })).not.toBe(key);
    expect(tierListCacheKey({ ...q, rank: 'CHALLENGER' })).not.toBe(key);
    expect(tierListCacheKey({ ...q, platform: 'KR' })).not.toBe(
      tierListCacheKey({ ...q, rank: 'CHALLENGER' }),
    );
  });
});

describe('TokenBucketLimiter', () => {
  test('allows a burst then refills over time, per key', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ burst: 2, perMinute: 60, now: () => now });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    const refused = limiter.take('a');
    expect(refused).toMatchObject({ allowed: false, retryAfterS: 1 });
    expect(limiter.take('b').allowed).toBe(true);
    now = 1000;
    expect(limiter.take('a').allowed).toBe(true);
    now = 60_000;
    limiter.sweep();
    expect(limiter.take('a').remaining).toBe(1);
  });
});
