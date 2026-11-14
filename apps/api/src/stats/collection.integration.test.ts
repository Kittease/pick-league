/**
 * GET /stats/status `collection`: worker heartbeats, rejected key, newest match per platform.
 * Needs DATABASE_URL_TEST (bun run db:test:up); uses its own database so it never races
 * the other API tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type Db } from '@pick-league/db';
import type { Platform, StatsStatusResponse } from '@pick-league/shared';
import { createApp } from '../http/app.ts';
import { TtlCache } from '../http/cache.ts';
import { silentLogger } from '../logger.ts';
import { resetApiTestDb, seedSyntheticPatch, withDatabase } from '../testing/seed.ts';
import { StatsRefresher } from './refresh.ts';

const BASE = process.env.DATABASE_URL_TEST;
const URL_ = BASE ? withDatabase(BASE, 'pickleague_api_collection_test') : undefined;

describe.skipIf(!URL_)('stats status: collection (Postgres)', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;

  const collection = async () => {
    const res = await app.request('/stats/status');
    expect(res.status).toBe(200);
    return ((await res.json()) as StatsStatusResponse).collection;
  };

  /** A worker_status row whose heartbeat is `heartbeatMin` minutes old (database clock). */
  const seedStatus = (
    platform: Platform,
    heartbeatMin: number,
    extra: { rejectedMin?: number; error?: string } = {},
  ) => {
    const minutesAgo = (m: number | null) => db`now() - ${m}::float8 * interval '1 minute'`;
    return db`
      INSERT INTO worker_status (platform, heartbeat_at, auth_rejected_since, last_error, last_error_at)
      VALUES (${platform}, ${minutesAgo(heartbeatMin)}, ${minutesAgo(extra.rejectedMin ?? null)},
        ${extra.error ?? null}, ${minutesAgo(extra.error ? 0 : null)})`;
  };

  beforeAll(async () => {
    await resetApiTestDb(URL_);
    db = createDb(URL_ as string, { max: 4 });
    // 8 synthetic matches spread over the 4 platforms.
    await seedSyntheticPatch(db, { patch: '15.22', count: 8, seed: 7, idPrefix: 'SYN_COLLECT' });
    await db`UPDATE matches SET fetched_at = '2026-11-14T10:00:00Z' WHERE platform = 'KR'`;
    const refresher = new StatsRefresher(db, { intervalMs: 60_000 });
    app = createApp({
      db,
      cache: new TtlCache(1000),
      limiter: null,
      log: silentLogger,
      stats: refresher,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await db`DELETE FROM worker_status`;
  });

  test('unknown while the worker never wrote worker_status', async () => {
    expect(await collection()).toEqual({ state: 'unknown', platforms: [] });
  });

  test('collecting: rows per platform with their newest stored match', async () => {
    await seedStatus('KR', 0.5);
    await seedStatus('EUW1', 1, { error: 'transient: 503 from match-v5' });
    const c = await collection();
    expect(c.state).toBe('collecting');
    expect(c.platforms.map((p) => p.platform)).toEqual(['KR', 'EUW1']);
    const [kr, euw] = c.platforms;
    expect(kr).toMatchObject({
      platform: 'KR',
      authRejectedSince: null,
      lastError: null,
      lastErrorAt: null,
      lastMatchStoredAt: '2026-11-14T10:00:00.000Z',
    });
    expect(Date.now() - Date.parse(kr?.heartbeatAt ?? '')).toBeLessThan(5 * 60_000);
    expect(euw?.lastError).toBe('transient: 503 from match-v5');
    expect(euw?.lastErrorAt).not.toBeNull();
    expect(euw?.lastMatchStoredAt).not.toBeNull();
  });

  test('stalled when no platform heartbeated for 3 minutes', async () => {
    await seedStatus('KR', 4);
    await seedStatus('NA1', 12);
    const c = await collection();
    expect(c.state).toBe('stalled');
    expect(c.platforms).toHaveLength(2);
  });

  test('key_rejected when Riot rejects the key on any platform', async () => {
    await seedStatus('KR', 0.2);
    await seedStatus('VN2', 0.1, { rejectedMin: 20 });
    const c = await collection();
    expect(c.state).toBe('key_rejected');
    const vn = c.platforms.find((p) => p.platform === 'VN2');
    expect(vn?.authRejectedSince).not.toBeNull();
    expect(c.platforms.find((p) => p.platform === 'KR')?.authRejectedSince).toBeNull();
  });
});
