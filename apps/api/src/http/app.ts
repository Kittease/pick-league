import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '@pick-league/db';
import {
  API_ROUTES,
  buildRequestSchema,
  draftRequestSchema,
  MAX_REQUEST_BODY_BYTES,
  PATCH_CHANGES_INDEX_ROUTE,
  PATCH_CHANGES_ROUTE,
  PATCH_NOTES_ROUTE,
  patchChangesQuerySchema,
  patchNotesQuerySchema,
  picksRequestSchema,
  TIER_LIST_CHAMPION_ROUTE,
  TIER_LIST_ROUTE,
  tierListChampionQuerySchema,
  tierListQuerySchema,
} from '@pick-league/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { ApiError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import * as meta from '../services/meta.ts';
import * as patchChanges from '../services/patch-changes.ts';
import * as patchNotes from '../services/patch-notes.ts';
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
export type StatsControl = Pick<StatsRefresher, 'status'>;

export interface AppDeps {
  db: Db;
  cache: TtlCache<unknown>;
  limiter: TokenBucketLimiter | null;
  log: Logger;
  /** Serves GET /stats/status (404 when absent). */
  stats?: StatsControl;
  /** Use the first X-Forwarded-For address as client IP (behind a reverse proxy). */
  trustProxy?: boolean;
  /**
   * When set, every route but `GET /health` needs `Authorization: Bearer <apiToken>` (the
   * gateway's), and the client IP is the visitor's the gateway sends in `X-Client-IP`.
   */
  apiToken?: string;
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

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function hasBearerToken(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  // Both sides hashed to the same length: neither the length nor the content leaks by timing.
  return match?.[1] !== undefined && timingSafeEqual(digest(match[1]), digest(token));
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
  const apiToken = deps.apiToken || undefined;
  const app = new Hono<Env>();

  /**
   * The visitor's IP. Behind the gateway (token set, so the request carried it) that is the
   * `X-Client-IP` the gateway sends; otherwise the socket's, or `X-Forwarded-For` with
   * `trustProxy`.
   */
  const ipOf = (c: Context<Env>): string => {
    if (apiToken) {
      const visitor = c.req.header('x-client-ip')?.trim();
      if (visitor && hasBearerToken(c.req.header('authorization'), apiToken)) return visitor;
    }
    return clientIp(c, deps.trustProxy ?? false);
  };

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    log.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round((performance.now() - started) * 10) / 10,
      ip: ipOf(c),
      ...(c.get('cache') ? { cache: c.get('cache') } : {}),
    });
  });
  // No CORS: browsers never call the API, only the web app's server (the gateway) does.
  app.use('*', async (c, next) => {
    const open = c.req.method === 'GET' && c.req.path === API_ROUTES.health;
    if (apiToken && !open && !hasBearerToken(c.req.header('authorization'), apiToken)) {
      throw new ApiError('UNAUTHORIZED', 'Missing or invalid API token');
    }
    await next();
  });
  app.use('*', async (c, next) => {
    // The gateway's shared, cached reads (token, no visitor IP) are bounded by its cache, not by
    // a per-IP bucket: they would all share the gateway's own address.
    const gatewayShared =
      apiToken !== undefined &&
      !c.req.header('x-client-ip')?.trim() &&
      hasBearerToken(c.req.header('authorization'), apiToken);
    if (limiter && c.req.path !== API_ROUTES.health && !gatewayShared) {
      const decision = limiter.take(ipOf(c));
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

  app.get(PATCH_CHANGES_INDEX_ROUTE, (c) =>
    cached(c, 'patch-changes-index', () => patchChanges.patchChangesIndex(db)),
  );
  app.get(PATCH_CHANGES_ROUTE, (c) => {
    const parsed = patchChangesQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      throw new ApiError('BAD_REQUEST', 'Invalid query string', parsed.error.issues);
    const query = parsed.data;
    return cached(c, `patch-changes|${JSON.stringify(query)}`, () =>
      patchChanges.patchChanges(db, query),
    );
  });
  app.get(PATCH_NOTES_ROUTE, (c) => {
    const parsed = patchNotesQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      throw new ApiError('BAD_REQUEST', 'Invalid query string', parsed.error.issues);
    const query = parsed.data;
    return cached(c, `patch-notes|${JSON.stringify(query)}`, () =>
      patchNotes.patchNotes(db, query),
    );
  });

  if (deps.stats) {
    const stats = deps.stats;
    // Never cached: the desktop polls it while a refresh runs.
    app.get(API_ROUTES.statsStatus, async (c) => c.json(await stats.status()));
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
