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

  /** A compute the test resolves (or rejects) by hand. */
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  test('concurrent identical computes run once', async () => {
    const cache = new TtlCache<number>(1000);
    const d = deferred<number>();
    let calls = 0;
    const compute = () => {
      calls++;
      return d.promise;
    };
    const a = cache.getOrCompute('k', compute);
    const b = cache.getOrCompute('k', compute);
    d.resolve(7);
    expect(await Promise.all([a, b])).toEqual([
      { value: 7, hit: false },
      { value: 7, hit: false },
    ]);
    expect(calls).toBe(1);
    expect(await cache.getOrCompute('k', compute)).toEqual({ value: 7, hit: true });
  });

  test('a compute started before clear() is not stored nor joined after it', async () => {
    const cache = new TtlCache<string>(1000);
    const old = deferred<string>();
    const before = cache.getOrCompute('k', () => old.promise);
    cache.clear(); // e.g. the stats were refreshed while the old response was being computed
    const fresh = deferred<string>();
    const after = cache.getOrCompute('k', () => fresh.promise);
    old.resolve('stale');
    expect(await before).toEqual({ value: 'stale', hit: false });
    expect(cache.get('k')).toBeUndefined();
    fresh.resolve('fresh');
    expect(await after).toEqual({ value: 'fresh', hit: false });
    expect(cache.get('k')).toBe('fresh');
  });

  test('a failed compute is shared by its waiters and not stored', async () => {
    const cache = new TtlCache<number>(1000);
    const d = deferred<number>();
    const a = cache.getOrCompute('k', () => d.promise);
    const b = cache.getOrCompute('k', () => Promise.resolve(1));
    d.reject(new Error('db down'));
    const settled = await Promise.allSettled([a, b]);
    for (const r of settled) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect(((r as PromiseRejectedResult).reason as Error).message).toBe('db down');
    }
    expect(cache.size).toBe(0);
    expect(await cache.getOrCompute('k', async () => 2)).toEqual({ value: 2, hit: false });
    const sync = cache.getOrCompute('s', () => {
      throw new Error('sync');
    });
    await expect(sync).rejects.toThrow('sync');
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

  test('picks cache keys separate mastery profiles by bucket', () => {
    const base = { role: 'UTILITY', allies: [], enemies: [], bans: [] as number[] };
    const key = picksCacheKey({
      ...base,
      masteries: [
        { championId: 89, points: 12_000 },
        { championId: 40, points: 600_000 },
      ],
    });
    // Reordered, or other points in the same bucket (5k–20k): same answer, same key.
    expect(
      picksCacheKey({
        ...base,
        masteries: [
          { championId: 40, points: 900_000 },
          { championId: 89, points: 19_000 },
        ],
      }),
    ).toBe(key);
    // Another bucket.
    expect(
      picksCacheKey({
        ...base,
        masteries: [
          { championId: 89, points: 20_000 },
          { championId: 40, points: 600_000 },
        ],
      }),
    ).not.toBe(key);
    // 0 points = not listed.
    expect(
      picksCacheKey({
        ...base,
        masteries: [
          { championId: 89, points: 12_000 },
          { championId: 40, points: 600_000 },
          { championId: 117, points: 0 },
        ],
      }),
    ).toBe(key);
    // Masteries sent (none above 0 points) still change the answer: not the same as no field.
    expect(picksCacheKey({ ...base, masteries: [] })).not.toBe(picksCacheKey(base));
    expect(picksCacheKey({ ...base, masteries: [{ championId: 117, points: 0 }] })).toBe(
      picksCacheKey({ ...base, masteries: [] }),
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
