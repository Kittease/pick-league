/** Request limits and gateway auth, enforced before any database access (no Postgres needed). */
import { describe, expect, test } from 'bun:test';
import type { Db } from '@pick-league/db';
import {
  type ApiErrorResponse,
  MAX_AVAILABLE_CHAMPION_IDS,
  MAX_REQUEST_BODY_BYTES,
  type StatsStatusResponse,
} from '@pick-league/shared';
import { silentLogger } from '../logger.ts';
import { createApp, hasBearerToken } from './app.ts';
import { TtlCache } from './cache.ts';
import { TokenBucketLimiter } from './rate-limit.ts';

/** Any query fails: these requests must be refused before reaching the database. */
const db = new Proxy({} as Db, {
  get: () => {
    throw new Error('the database must not be used');
  },
});
const app = createApp({ db, cache: new TtlCache(60_000), limiter: null, log: silentLogger });

const errorCode = async (res: Response) => ((await res.json()) as ApiErrorResponse).error.code;

describe('request limits', () => {
  const big = JSON.stringify({ role: 'UTILITY', pad: 'x'.repeat(MAX_REQUEST_BODY_BYTES) });

  test('POST bodies over the limit get 413 PAYLOAD_TOO_LARGE', async () => {
    for (const path of ['/recommendations/picks', '/recommendations/build']) {
      const res = await app.request(path, {
        method: 'POST',
        body: big,
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(413);
      expect(await errorCode(res)).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  test('a streamed body without Content-Length is cut at the limit too', async () => {
    const bytes = new TextEncoder().encode(big);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.slice(i, i + 8192));
        controller.close();
      },
    });
    const res = await app.request('/recommendations/picks', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('PAYLOAD_TOO_LARGE');
  });

  test('availableChampionIds is capped', async () => {
    const ids = Array.from({ length: MAX_AVAILABLE_CHAMPION_IDS + 1 }, (_, i) => i + 1);
    const res = await app.request('/recommendations/picks', {
      method: 'POST',
      body: JSON.stringify({ role: 'UTILITY', availableChampionIds: ids }),
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.stringify({ availableChampionIds: ids }).length).toBeLessThan(
      MAX_REQUEST_BODY_BYTES,
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('BAD_REQUEST');
  });
});

describe('gateway token (API_TOKEN)', () => {
  const TOKEN = 'test-token-not-a-real-secret';
  const status: StatsStatusResponse = {
    refreshing: false,
    lastRefreshedAt: null,
    lastRefreshDurationMs: null,
    matchesIncluded: 0,
    matchesStored: 0,
    pendingMatches: 0,
    collection: { state: 'unknown', platforms: [] },
  };
  /** A database that is down: every query rejects. */
  const downDb = (() => Promise.reject(new Error('database down'))) as unknown as Db;
  const make = (apiToken?: string, burst = 0) =>
    createApp({
      db: downDb,
      cache: new TtlCache(60_000),
      limiter: burst > 0 ? new TokenBucketLimiter({ burst, perMinute: 1 }) : null,
      log: silentLogger,
      stats: { status: async () => status },
      apiToken,
    });
  const get = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string>) =>
    app.request(path, { headers });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  test('missing or wrong token: 401 UNAUTHORIZED on every route but GET /health', async () => {
    const app = make(TOKEN);
    for (const headers of [
      {},
      bearer('wrong'),
      bearer(`${TOKEN}x`),
      { authorization: TOKEN },
      { authorization: `Basic ${TOKEN}` },
    ]) {
      for (const path of ['/stats/status', '/patches', '/no/such/route']) {
        const res = await get(app, path, headers);
        expect(res.status).toBe(401);
        expect(await errorCode(res)).toBe('UNAUTHORIZED');
      }
      const post = await app.request('/recommendations/picks', {
        method: 'POST',
        body: '{}',
        headers: { ...headers, 'content-type': 'application/json' },
      });
      expect(post.status).toBe(401);
    }
  });

  test('GET /health needs no token', async () => {
    const res = await get(make(TOKEN), '/health', {});
    expect(res.status).not.toBe(401);
    // The database is down: health answers, and says so.
    expect(res.status).toBe(503);
  });

  test('the right token goes through', async () => {
    const res = await get(make(TOKEN), '/stats/status', bearer(TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  test('without API_TOKEN there is no auth', async () => {
    expect((await get(make(), '/stats/status', {})).status).toBe(200);
    expect((await get(make(''), '/stats/status', {})).status).toBe(200);
  });

  test('no CORS headers', async () => {
    const res = await get(make(), '/stats/status', { origin: 'https://example.test' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('with the token, the rate limit is per X-Client-IP (the visitor the gateway serves)', async () => {
    const app = make(TOKEN, 1);
    const visitor = (ip: string) =>
      get(app, '/stats/status', { ...bearer(TOKEN), 'x-client-ip': ip });
    expect((await visitor('203.0.113.1')).status).toBe(200);
    expect((await visitor('203.0.113.1')).status).toBe(429);
    // Same gateway, another visitor: their own bucket.
    expect((await visitor('203.0.113.2')).status).toBe(200);
  });

  test("the gateway's shared reads (token, no X-Client-IP) are not rate limited", async () => {
    const app = make(TOKEN, 1);
    for (let i = 0; i < 3; i++)
      expect((await get(app, '/stats/status', bearer(TOKEN))).status).toBe(200);
  });

  test('a wrong token without X-Client-IP is still refused', async () => {
    expect((await get(make(TOKEN, 1), '/stats/status', bearer('nope'))).status).toBe(401);
  });

  test('without the token, X-Client-IP is ignored', async () => {
    const app = make(undefined, 1);
    const call = (ip: string) => get(app, '/stats/status', { 'x-client-ip': ip });
    expect((await call('203.0.113.1')).status).toBe(200);
    // Same socket: the header does not buy a new bucket.
    expect((await call('203.0.113.2')).status).toBe(429);
  });

  test('hasBearerToken', () => {
    expect(hasBearerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(hasBearerToken(undefined, TOKEN)).toBe(false);
    expect(hasBearerToken('Bearer ', TOKEN)).toBe(false);
    expect(hasBearerToken('Bearer short', TOKEN)).toBe(false);
    expect(hasBearerToken(`bearer ${TOKEN}`, TOKEN)).toBe(false);
  });
});
