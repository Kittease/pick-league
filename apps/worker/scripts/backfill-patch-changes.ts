/**
 * One-off: stores the patch diffs of past patches from Community Dragon (both patches' final
 * builds, `source = 'backfill'`). Idempotent: a patch that has its patch diff is skipped.
 *   DATABASE_URL=postgres://… bun run apps/worker/scripts/backfill-patch-changes.ts 16.20 16.21 16.22 16.23
 * In the worker container: `docker compose exec worker bun run apps/worker/scripts/backfill-patch-changes.ts …`
 * (DATABASE_URL is set there). Applies pending migrations first, like the worker.
 */
import { createDb, migrate } from '@pick-league/db';
import { createDdragonClient, isPatchId } from '@pick-league/shared';
import { createLogger, errorMessage } from '../src/log.ts';
import { createCdragonClient } from '../src/patch-changes/cdragon.ts';
import { PatchChangesJob } from '../src/patch-changes/job.ts';

const patches = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || patches.length === 0 || !patches.every(isPatchId)) {
  console.error('usage: DATABASE_URL=… bun run backfill-patch-changes.ts <patch> [patch…]');
  process.exit(1);
}

const log = createLogger('info', { service: 'backfill-patch-changes' });
const db = createDb(url, { max: 2 });
try {
  await migrate(db, { log: (m) => log.info(m) });
  const job = new PatchChangesJob(db, createCdragonClient(), createDdragonClient(), { log });
  await job.backfill(patches);
  log.info('backfill done', { patches });
} catch (err) {
  log.error('backfill failed', { error: errorMessage(err) });
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 });
}
