/**
 * Stats refresh: GET /stats/status, the timer-driven refresh, failures and locking.
 * Needs DATABASE_URL_TEST (bun run db:test:up); uses its own database so it never races
 * the endpoint tests.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, type Db } from '@pick-league/db';
import type { StatsStatusResponse } from '@pick-league/shared';
import { createApp } from '../http/app.ts';
import { TtlCache } from '../http/cache.ts';
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

describe.skipIf(!URL_)('stats refresh (Postgres)', () => {
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
  const setup = () => {
    const cache = new TtlCache<unknown>(60_000);
    let refreshed = 0;
    const refresher = new StatsRefresher(db, {
      intervalMs: 60_000,
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

  beforeAll(async () => {
    await resetApiTestDb(URL_);
    db = createDb(URL_ as string, { max: 6 });
    await addMatches(120);
    await refreshStats(db, { force: true });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
  });

  test('status reports what the views include and what is pending', async () => {
    const { app } = setup();
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

  test('a tick refreshes the views and clears the cache, then finds them up to date', async () => {
    const { app, cache, refresher, refreshed } = setup();
    await addMatches(20);
    cache.set('stale', 1);

    const run = refresher.tick();
    expect((await status(app)).refreshing).toBe(true);
    expect((await run)?.reason).toBe('refreshed');
    const after = await status(app);
    expect(after.refreshing).toBe(false);
    expect(after.pendingMatches).toBe(0);
    expect(after.matchesIncluded).toBe(after.matchesStored);
    expect(refreshed()).toBe(1);
    expect(cache.size).toBe(0);

    expect((await refresher.tick())?.reason).toBe('unchanged');
    expect(refreshed()).toBe(1);
  }, 60_000);

  test('concurrent ticks share a single refresh', async () => {
    const { refresher, refreshed } = setup();
    await addMatches(10);
    const runs = await Promise.all([refresher.tick(), refresher.tick(), refresher.tick()]);
    expect(runs.map((r) => r?.reason)).toEqual(['refreshed', 'refreshed', 'refreshed']);
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
    const { app } = setup();
    await addMatches(10);
    const other = await db.reserve();
    try {
      await other`SELECT pg_advisory_lock(${STATS_REFRESH_LOCK_KEY})`;
      expect((await status(app)).refreshing).toBe(true);
      expect((await setup().refresher.tick())?.reason).toBe('locked');
    } finally {
      await other`SELECT pg_advisory_unlock(${STATS_REFRESH_LOCK_KEY})`;
      other.release();
    }
    expect((await status(app)).refreshing).toBe(false);
  }, 60_000);

  test('there is no manual refresh endpoint', async () => {
    const { app } = setup();
    expect((await app.request('/stats/refresh', { method: 'POST' })).status).toBe(404);
  });
});
