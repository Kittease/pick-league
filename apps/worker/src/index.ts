/**
 * PickLeague worker: crawls high-elo ranked games from the Riot API into Postgres.
 * See docs/architecture.md ("Worker"). Config via env: RIOT_API_KEY, DATABASE_URL, PLATFORMS,
 * LOG_LEVEL, COLLECT_PREVIOUS_PATCH, LISTING_SKIP, DIAMOND_MAX_TRACKED,
 * OUTSIDE_MASTER_CHECKS_PER_HOUR, MASTERY_REFRESH_DAYS, PATCH_CHANGES.
 */
import { createDb, migrate } from '@pick-league/db';
import { createDdragonClient } from '@pick-league/shared';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger, errorMessage } from './log.ts';
import { createCdragonClient } from './patch-changes/cdragon.ts';
import { PatchChangesJob } from './patch-changes/job.ts';
import { PatchTracker } from './patches.ts';
import { RiotClient } from './riot/client.ts';
import { PlatformWorker } from './scheduler/platform-worker.ts';

const PROGRESS_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[worker] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const log = createLogger(config.logLevel, { service: 'worker' });
const db = createDb(config.databaseUrl, { max: 10 });

const { applied } = await migrate(db, { log: (m) => log.info(m) });
log.info('migrations ok', { applied: applied.length, platforms: config.platforms });
if (config.collectPreviousPatch) {
  log.warn('COLLECT_PREVIOUS_PATCH is on: the previous patch stays collected');
}
log.info('collection settings', {
  listingSkip: config.listingSkip,
  diamondMaxTracked: config.diamondMaxTracked,
  outsideMasterChecksPerHour: config.outsideMasterChecksPerHour,
  masteryRefreshDays: config.masteryRefreshDays,
  patchChanges: config.patchChanges,
});

const riot = new RiotClient({ apiKey: config.riotApiKey, log });
const patches = new PatchTracker(db, createDdragonClient(), { log });
const workers = config.platforms.map(
  (platform) =>
    new PlatformWorker({
      platform,
      db,
      riot,
      patches,
      log,
      requestCount: () => riot.requestsFor(platform),
      options: {
        collectPreviousPatch: config.collectPreviousPatch,
        listingSkip: config.listingSkip,
        diamondMaxTracked: config.diamondMaxTracked,
        outsideCheckMaxPerHour: config.outsideMasterChecksPerHour,
        masteryRefreshIntervalMs: config.masteryRefreshDays * 86_400_000,
      },
    }),
);

const controller = new AbortController();
const { signal } = controller;

let shuttingDown = false;
const shutdown = (reason: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down: finishing in-flight work', { reason });
  controller.abort();
  riot.close();
  setTimeout(() => {
    log.error('shutdown timed out, exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Patches first: matches can't be classified (kept/old/too new) without them.
try {
  await patches.refresh();
} catch (err) {
  log.error('initial patch refresh failed, will retry', { error: errorMessage(err) });
}

const progressTimer = setInterval(async () => {
  try {
    const platforms = await Promise.all(workers.map((w) => w.progress()));
    log.info('progress', {
      patches: { latest: patches.latest, previous: patches.previous },
      platforms,
      hosts: riot.hostStats().map((h) => ({
        host: h.host,
        rpm: h.grantedLastMinute,
        total: h.granted,
        waiting: h.waiting,
        rateLimited: h.rateLimited,
        serverErrors: h.serverErrors,
        appLimits: h.appLimits,
      })),
    });
  } catch (err) {
    log.warn('progress report failed', { error: errorMessage(err) });
  }
}, PROGRESS_INTERVAL_MS);

// Patch changes: a side job on Community Dragon. Its failures are logged, never stop the crawl.
const patchChanges = config.patchChanges
  ? new PatchChangesJob(db, createCdragonClient(), createDdragonClient(), { log })
      .run(signal)
      .catch((err) => log.error('patch changes job stopped', { error: errorMessage(err) }))
  : Promise.resolve();

let exitCode = 0;
await Promise.all(
  [patches.run(signal), ...workers.map((w) => w.start(signal))].map((task) =>
    task.catch((err) => {
      log.error('worker crashed', { error: errorMessage(err) });
      exitCode = 1;
      shutdown('crash');
    }),
  ),
);

await patchChanges;
clearInterval(progressTimer);
await db.end({ timeout: 5 });
log.info('stopped');
process.exit(exitCode);
