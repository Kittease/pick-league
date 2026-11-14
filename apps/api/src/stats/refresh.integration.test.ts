/**
 * Manual stats refresh: GET /stats/status, POST /stats/refresh, cooldown and locking.
 * Needs DATABASE_URL_TEST (bun run db:test:up); uses its own database so it never races
 * the endpoint tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type Db } from '@pick-league/db';
import type { StatsRefreshResponse, StatsStatusResponse } from '@pick-league/shared';
import { createApp } from '../http/app.ts';
import { TtlCache } from '../http/cache.ts';
import { TokenBucketLimiter } from '../http/rate-limit.ts';
import { silentLogger } from '../logger.ts';
import { resetApiTestDb, seedSyntheticPatch, withDatabase } from '../testing/seed.ts';
import {
  refreshStats,
  STATS_REFRESH_LOCK_KEY,
  type STATS_REFRESH_ORDER,
  StatsRefreshError,
  StatsRefresher,
} from './refresh.ts';

const BASE = process.env.DATABASE_URL_TEST;
const URL_ = BASE
  ? withDatabase(BASE, process.env.API_REFRESH_TEST_DATABASE ?? 'pickleague_api_refresh_test')
  : undefined;
const PATCH = '15.22';

describe.skipIf(!URL_)('manual stats refresh (Postgres)', () => {
  let db: Db;
  let batch = 0;

  /** Adds `count` new matches (fresh id prefix each time). */
  const addMatches = (count: number) =>
    seedSyntheticPatch(db, {
      patch: PATCH,
      count,
      seed: 100 + ++batch,
      idPrefix: `SYN_REFRESH_${batch}`,
    });
  /** Pretends the last refresh finished `seconds` ago. */
  const ageLastRefresh = (seconds: number) =>
    db`UPDATE stats_refresh_log SET finished_at = now() - make_interval(secs => ${seconds})`;

  const setup = (cooldownMs: number) => {
    const cache = new TtlCache<unknown>(60_000);
    let refreshed = 0;
    const refresher = new StatsRefresher(db, {
      intervalMs: 60_000,
      manualCooldownMs: cooldownMs,
      onRefreshed: () => {
        refreshed++;
        cache.clear();
      },
    });
    const app = createApp({ db, cache, limiter: null, log: silentLogger, stats: refresher });
    return { cache, refresher, app, refreshed: () => refreshed };
  };

  const status = async (app: ReturnType<typeof createApp>) =>
    (await (await app.request('/stats/status')).json()) as StatsStatusResponse;
  const trigger = async (app: ReturnType<typeof createApp>) => {
    const res = await app.request('/stats/refresh', { method: 'POST' });
    return { status: res.status, body: (await res.json()) as StatsRefreshResponse, res };
  };

  beforeAll(async () => {
    await resetApiTestDb(URL_);
    db = createDb(URL_ as string, { max: 6 });
    await addMatches(120);
    await refreshStats(db, { force: true });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await ageLastRefresh(3600);
  });

  test('status reports what the views include and what is pending', async () => {
    const { app } = setup(0);
    const before = await status(app);
    expect(before).toMatchObject({
      refreshing: false,
      matchesIncluded: 120,
      matchesStored: 120,
      pendingMatches: 0,
    });
    expect(before.lastRefreshedAt).not.toBeNull();
    expect(before.lastRefreshDurationMs).toBeGreaterThanOrEqual(0);

    await addMatches(30);
    expect(await status(app)).toMatchObject({
      matchesIncluded: 120,
      matchesStored: 150,
      pendingMatches: 30,
    });
  }, 60_000);

  test('POST starts a background refresh, clears the cache, then reports up_to_date', async () => {
    const { app, cache, refresher, refreshed } = setup(0);
    await addMatches(20);
    cache.set('stale', 1);

    const first = await trigger(app);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ started: true });
    expect((await status(app)).refreshing).toBe(true);

    await refresher.idle();
    const after = await status(app);
    expect(after.refreshing).toBe(false);
    expect(after.pendingMatches).toBe(0);
    expect(after.matchesIncluded).toBe(after.matchesStored);
    expect(refreshed()).toBe(1);
    expect(cache.size).toBe(0);

    const again = await trigger(app);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ started: false, reason: 'up_to_date' });
  }, 60_000);

  test('cooldown after any refresh, with Retry-After', async () => {
    const { app, refresher } = setup(60_000);
    await addMatches(10);
    await ageLastRefresh(15);

    const r = await trigger(app);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ started: false, reason: 'cooldown' });
    const retry = (r.body as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(retry).toBeGreaterThan(40);
    expect(retry).toBeLessThanOrEqual(45);
    expect(r.res.headers.get('retry-after')).toBe(String(retry));

    await ageLastRefresh(61);
    expect((await trigger(app)).body).toEqual({ started: true });
    await refresher.idle();
  }, 60_000);

  test('concurrent requests start a single refresh', async () => {
    const { app, refresher, refreshed } = setup(0);
    await addMatches(10);
    const results = await Promise.all([trigger(app), trigger(app), trigger(app)]);
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 202)) {
      expect(r.body).toEqual({ started: false, reason: 'already_running' });
    }
    // The timer path joins the running refresh instead of starting another one.
    const timerRun = refresher.tick();
    await refresher.idle();
    expect((await timerRun)?.reason).toBe('refreshed');
    expect(refreshed()).toBe(1);
  }, 60_000);

  test('a refresh failing after some views were refreshed still clears the cache', async () => {
    const cache = new TtlCache<unknown>(60_000);
    const errors: unknown[] = [];
    let refreshed = 0;
    const failing = (views: typeof STATS_REFRESH_ORDER) =>
      new StatsRefresher(db, {
        intervalMs: 60_000,
        views,
        onRefreshed: () => {
          refreshed++;
          cache.clear();
        },
        onError: (err) => errors.push(err),
      });
    const missing = { view: 'stats_no_such_view', concurrent: false };

    // Fails before any view was refreshed: nothing changed, the cache stays.
    cache.set('kept', 1);
    expect(await failing([missing]).tick(true)).toBeNull();
    expect(refreshed).toBe(0);
    expect(cache.get('kept')).toBe(1);

    // Fails after stats_champion_traits was refreshed: responses may mix old and new data.
    expect(
      await failing([{ view: 'stats_champion_traits', concurrent: true }, missing]).tick(true),
    ).toBeNull();
    expect(refreshed).toBe(1);
    expect(cache.size).toBe(0);
    expect(errors).toHaveLength(2);
    const last = errors[1] as StatsRefreshError;
    expect(last).toBeInstanceOf(StatsRefreshError);
    expect(last.refreshedViews).toEqual(['stats_champion_traits']);
    expect(last.message).toContain('stats_no_such_view');
  }, 60_000);

  test('a refresh holding the advisory lock elsewhere counts as running', async () => {
    const { app } = setup(0);
    await addMatches(10);
    const other = await db.reserve();
    try {
      await other`SELECT pg_advisory_lock(${STATS_REFRESH_LOCK_KEY})`;
      expect((await status(app)).refreshing).toBe(true);
      expect((await trigger(app)).body).toEqual({ started: false, reason: 'already_running' });
    } finally {
      await other`SELECT pg_advisory_unlock(${STATS_REFRESH_LOCK_KEY})`;
      other.release();
    }
    expect((await status(app)).refreshing).toBe(false);
  }, 60_000);

  test('POST /stats/refresh stays under the per-IP rate limit', async () => {
    const { refresher } = setup(0);
    const app = createApp({
      db,
      cache: new TtlCache(1000),
      limiter: new TokenBucketLimiter({ burst: 1, perMinute: 1 }),
      log: silentLogger,
      stats: refresher,
    });
    await app.request('/stats/status');
    const limited = await app.request('/stats/refresh', { method: 'POST' });
    expect(limited.status).toBe(429);
  });
});
