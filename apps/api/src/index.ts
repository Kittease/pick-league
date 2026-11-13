/**
 * Placeholder entry point: applies migrations, then idles until SIGTERM/SIGINT.
 * Replaced by the real api implementation.
 */
import { createDb, migrate } from '@pick-league/db';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[api] DATABASE_URL is not set');
  process.exit(1);
}

const db = createDb(databaseUrl, { max: 2 });
const { applied } = await migrate(db, { log: (m) => console.log(`[api] ${m}`) });
console.log(`[api] migrations ok (${applied.length} applied)`);
console.log('[api] not implemented yet');

const keepAlive = setInterval(() => {}, 60_000);
const shutdown = async () => {
  clearInterval(keepAlive);
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
