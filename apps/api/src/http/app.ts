import type { Db } from '@pick-league/db';
import { API_ROUTES, buildRequestSchema, picksRequestSchema } from '@pick-league/shared';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import type { z } from 'zod';
import { ApiError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import * as meta from '../services/meta.ts';
import * as reco from '../services/recommendations.ts';
import { buildCacheKey, picksCacheKey, type TtlCache } from './cache.ts';
import type { TokenBucketLimiter } from './rate-limit.ts';

export interface AppDeps {
  db: Db;
  cache: TtlCache<unknown>;
  limiter: TokenBucketLimiter | null;
  log: Logger;
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
    cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'] }),
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
