import { type Db, setClientActivity } from '@pick-league/db';
import {
  API_ROUTES,
  buildRequestSchema,
  CLIENT_ACTIVITY_ROUTE,
  CLIENT_ACTIVITY_TTL_MS,
  type ClientActivityResponse,
  clientActivityRequestSchema,
  draftRequestSchema,
  isPlayingPhase,
  LIVE_PLAYERS_ROUTE,
  livePlayersRequestSchema,
  MAX_REQUEST_BODY_BYTES,
  picksRequestSchema,
  TIER_LIST_CHAMPION_ROUTE,
  TIER_LIST_ROUTE,
  tierListChampionQuerySchema,
  tierListQuerySchema,
} from '@pick-league/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { z } from 'zod';
import { ApiError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import * as live from '../services/live.ts';
import * as meta from '../services/meta.ts';
import * as reco from '../services/recommendations.ts';
import * as tiers from '../services/tierlist.ts';
import type { StatsRefresher } from '../stats/refresh.ts';
import {
  buildCacheKey,
  draftCacheKey,
  picksCacheKey,
  type TtlCache,
  tierListCacheKey,
} from './cache.ts';
import type { TokenBucketLimiter } from './rate-limit.ts';

/** What the HTTP layer needs from the stats refresher. */
export type StatsControl = Pick<StatsRefresher, 'status' | 'requestRefresh'> &
  Partial<Pick<StatsRefresher, 'activityChanged'>>;

export interface AppDeps {
  db: Db;
  cache: TtlCache<unknown>;
  limiter: TokenBucketLimiter | null;
  log: Logger;
  /** Serves GET /stats/status and POST /stats/refresh (404 when absent). */
  stats?: StatsControl;
  /** Use the first X-Forwarded-For address as client IP (behind a reverse proxy). */
  trustProxy?: boolean;
}

interface BunServerLike {
  requestIP?: (req: Request) => { address: string } | null;
}

type Env = {
  Bindings: BunServerLike | undefined;
  Variables: { cache: 'hit' | 'miss' | undefined };
};

export function clientIp(c: Context<Env>, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  try {
    return c.env?.requestIP?.(c.req.raw)?.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function parseBody<S extends z.ZodType>(c: Context<Env>, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError('BAD_REQUEST', 'Body must be valid JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError('BAD_REQUEST', 'Invalid request body', parsed.error.issues);
  return parsed.data;
}

export function createApp(deps: AppDeps): Hono<Env> {
  const { db, cache, limiter, log } = deps;
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    log.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round((performance.now() - started) * 10) / 10,
      ip: clientIp(c, deps.trustProxy ?? false),
      ...(c.get('cache') ? { cache: c.get('cache') } : {}),
    });
  });
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    }),
  );
  app.use('*', async (c, next) => {
    if (limiter && c.req.method !== 'OPTIONS' && c.req.path !== API_ROUTES.health) {
      const decision = limiter.take(clientIp(c, deps.trustProxy ?? false));
      if (!decision.allowed) {
        c.header('Retry-After', String(decision.retryAfterS));
        throw new ApiError('RATE_LIMITED', `Too many requests, retry in ${decision.retryAfterS}s`);
      }
    }
    await next();
  });
  // Bodies are read whole before validation: cap them (Content-Length, else while streaming).
  const limitBody = bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: () => {
      throw new ApiError(
        'PAYLOAD_TOO_LARGE',
        `Request body over ${MAX_REQUEST_BODY_BYTES / 1024} KB`,
      );
    },
  });
  app.use('*', (c, next) => (c.req.method === 'POST' ? limitBody(c, next) : next()));

  const cached = async <T>(c: Context<Env>, key: string, compute: () => Promise<T>) => {
    const { value, hit } = await cache.getOrCompute(key, compute);
    c.set('cache', hit ? 'hit' : 'miss');
    return c.json(value as T);
  };

  app.get(API_ROUTES.health, async (c) => {
    const h = await meta.health(db);
    return c.json(h, h.ok ? 200 : 503);
  });
  app.get(API_ROUTES.patches, (c) => cached(c, 'patches', () => meta.patches(db)));
  app.get('/static/:patch', (c) => {
    const patch = c.req.param('patch');
    return cached(c, `static|${patch}`, () => meta.staticData(db, patch));
  });
  app.post(API_ROUTES.picks, async (c) => {
    const req = await parseBody(c, picksRequestSchema);
    return cached(c, picksCacheKey(req), () => reco.picks(db, req));
  });
  app.post(API_ROUTES.build, async (c) => {
    const req = await parseBody(c, buildRequestSchema);
    return cached(c, buildCacheKey(req), () => reco.build(db, req));
  });
  app.post(API_ROUTES.draft, async (c) => {
    const req = await parseBody(c, draftRequestSchema);
    return cached(c, draftCacheKey(req), () => reco.draft(db, req));
  });
  app.get(TIER_LIST_ROUTE, (c) => {
    const parsed = tierListQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      throw new ApiError('BAD_REQUEST', 'Invalid query string', parsed.error.issues);
    const query = parsed.data;
    return cached(c, tierListCacheKey(query), () => tiers.tierList(db, query));
  });
  app.get(TIER_LIST_CHAMPION_ROUTE, (c) => {
    const parsed = tierListChampionQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      throw new ApiError('BAD_REQUEST', 'Invalid query string', parsed.error.issues);
    const query = parsed.data;
    // Every parsed field is in the key, so filters added to the query schema are too.
    return cached(c, `tierlist-champion|${JSON.stringify(query)}`, () =>
      tiers.tierListChampion(db, query),
    );
  });

  // Live game lookups: never cached (the desktop repeats it while the worker fills the answer).
  // Writes lookup requests only, and only for platforms the worker runs.
  app.post(LIVE_PLAYERS_ROUTE, async (c) => {
    const req = await parseBody(c, livePlayersRequestSchema);
    return c.json(await live.livePlayers(db, req));
  });

  // What the user does in the League client: from queue start to the end of the game the worker
  // stops collecting and the stats refresh waits (docs/architecture.md, "Playing"). Renewed by
  // the desktop while it lasts, so a closed app releases the pause by itself.
  app.put(CLIENT_ACTIVITY_ROUTE, async (c) => {
    const req = await parseBody(c, clientActivityRequestSchema);
    const playing = isPlayingPhase(req.phase);
    await setClientActivity(db, {
      client: 'desktop',
      phase: req.phase,
      busyForMs: playing ? CLIENT_ACTIVITY_TTL_MS : null,
    });
    await deps.stats?.activityChanged?.(playing);
    const body: ClientActivityResponse = { paused: playing };
    return c.json(body);
  });

  if (deps.stats) {
    const stats = deps.stats;
    // Never cached: the desktop polls it while a refresh runs.
    app.get(API_ROUTES.statsStatus, async (c) => c.json(await stats.status()));
    // Public and unauthenticated: guarded by the per-IP rate limit, a global cooldown and the
    // advisory lock (see StatsRefresher.requestRefresh).
    app.post(API_ROUTES.statsRefresh, async (c) => {
      const res = await stats.requestRefresh();
      if (!res.started && res.reason === 'cooldown' && res.retryAfterSeconds) {
        c.header('Retry-After', String(res.retryAfterSeconds));
      }
      return c.json(res, res.started ? 202 : 200);
    });
  }

  app.notFound(() => {
    throw new ApiError('NOT_FOUND', 'Unknown route');
  });
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
    log.error('unhandled error', {
      path: c.req.path,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return c.json(new ApiError('INTERNAL', 'Internal error').toBody(), 500);
  });
  return app;
}
