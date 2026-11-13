/**
 * Test database helpers: a dedicated database (`pickleague_api_test` by default) on the server
 * of `DATABASE_URL_TEST`, so the API tests never collide with other packages' tests.
 */
import {
  createDb,
  type Db,
  insertParsedMatch,
  migrate,
  upsertPatchStaticData,
} from '@pick-league/db';
import { type GenerateOptions, generateMatches, syntheticStaticData } from './synthetic.ts';

const BASE_URL = process.env.DATABASE_URL_TEST;
const API_DB_NAME = process.env.API_TEST_DATABASE ?? 'pickleague_api_test';

/** URL of the API test database, or undefined when `DATABASE_URL_TEST` is not set. */
export const API_TEST_DATABASE_URL = BASE_URL ? withDatabase(BASE_URL, API_DB_NAME) : undefined;

export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Creates the database if needed, drops everything in it and applies all migrations. */
export async function resetApiTestDb(url = API_TEST_DATABASE_URL): Promise<void> {
  if (!url || !BASE_URL) throw new Error('DATABASE_URL_TEST is not set');
  const name = new URL(url).pathname.slice(1);
  const admin = createDb(BASE_URL, { max: 1 });
  try {
    const [row] = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (!row) await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await admin.end();
  }
  const db = createDb(url, { max: 1 });
  try {
    await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
  } finally {
    await db.end();
  }
}

/** Inserts static data for `patch` and `count` synthetic matches (parallel inserts). */
export async function seedSyntheticPatch(
  db: Db,
  options: GenerateOptions,
  concurrency = 8,
): Promise<void> {
  await upsertPatchStaticData(db, syntheticStaticData(options.patch));
  const matches = generateMatches(options);
  let next = 0;
  const worker = async () => {
    while (next < matches.length) {
      const m = matches[next++];
      if (m) await insertParsedMatch(db, m, { enqueueEnrichment: false, markQueueDone: false });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
