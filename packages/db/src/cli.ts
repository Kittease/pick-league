/**
 * `bun run --filter @pick-league/db migrate` (or `bun run db:migrate` at the root).
 * Applies pending migrations to `DATABASE_URL`.
 */
import { createDb } from './client.ts';
import { migrate } from './migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = createDb(url, { max: 1 });
try {
  const { applied } = await migrate(db, { log: (m) => console.log(m) });
  console.log(
    applied.length === 0 ? 'database is up to date' : `applied ${applied.length} migration(s)`,
  );
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await db.end();
}
