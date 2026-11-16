/**
 * PickLeague API: migrations at startup, Hono app on Bun, stats views refreshed in the background.
 */
import { createDb, migrate } from '@pick-league/db';
import { loadConfig } from './config.ts';
import { createApp } from './http/app.ts';
import { TtlCache } from './http/cache.ts';
import { TokenBucketLimiter } from './http/rate-limit.ts';
import { createLogger } from './logger.ts';
import { StatsRefresher } from './stats/refresh.ts';

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[api] ${(err as Error).message}`);
    process.exit(1);
  }
})();
const log = createLogger(config.logLevel);

const db = createDb(config.databaseUrl, { max: 10 });
const { applied } = await migrate(db, { log: (m) => log.info(m) });
log.info('migrations ok', { applied: applied.length });

const cache = new TtlCache<unknown>(config.cacheTtlMs);
const limiter =
  config.rateLimitPerMinute > 0
    ? new TokenBucketLimiter({ burst: config.rateLimitBurst, perMinute: config.rateLimitPerMinute })
    : null;
const sweep = setInterval(() => limiter?.sweep(), 60_000);

// The refresh uses its own small pool so it never starves request queries.
const refreshDb = createDb(config.databaseUrl, { max: 2 });
const refresher = new StatsRefresher(refreshDb, {
  intervalMs: config.statsRefreshIntervalMs,
  parallelWorkers: config.statsRefreshParallelWorkers,
  workMem: config.statsRefreshWorkMem,
  statusDb: db,
  log: (msg, fields) => log.info(msg, fields),
  onRefreshed: () => cache.clear(),
  onError: (err) => log.error('stats refresh failed', { error: (err as Error).message }),
});
refresher.start();

const app = createApp({
  db,
  cache,
  limiter,
  log,
  stats: refresher,
  trustProxy: config.trustProxy,
  apiToken: config.apiToken,
});
const server = Bun.serve({ port: config.port, fetch: app.fetch });
log.info('listening', { port: server.port, auth: config.apiToken ? 'token' : 'none' });

const shutdown = async () => {
  log.info('shutting down');
  clearInterval(sweep);
  await server.stop();
  await refresher.stop();
  await Promise.all([db.end(), refreshDb.end()]);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
