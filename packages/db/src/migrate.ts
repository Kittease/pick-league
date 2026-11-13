import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './client.ts';

/** Directory holding `NNNN_name.sql` files (shipped with the package). */
export const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

/** Arbitrary constant key for `pg_advisory_lock`, shared by every process that migrates. */
export const MIGRATION_LOCK_KEY = 7_316_221_904;

const FILE_PATTERN = /^(\d{4})_[\w-]+\.sql$/;

export interface MigrateOptions {
  /** Defaults to this package's `migrations/` directory. */
  dir?: string;
  /** Called once per applied file. */
  log?: (message: string) => void;
}

export interface MigrateResult {
  /** File names applied by this call (empty when already up to date). */
  applied: string[];
}

export interface MigrationFile {
  version: string;
  name: string;
  path: string;
}

/** Lists migration files sorted by version. Throws on duplicate versions. */
export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir))
    .filter((f) => FILE_PATTERN.test(f))
    .sort()
    .map((name) => ({ version: name.slice(0, 4), name, path: join(dir, name) }));
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.version)) throw new Error(`Duplicate migration version ${f.version}`);
    seen.add(f.version);
  }
  return files;
}

/**
 * Applies pending migrations in order, each in its own transaction, recording them in
 * `schema_migrations`. Safe to call concurrently from several processes (worker + API at
 * startup): a session-level `pg_advisory_lock` serialises runners, and the second one finds
 * nothing left to do.
 */
export async function migrate(db: Db, options: MigrateOptions = {}): Promise<MigrateResult> {
  const files = await listMigrationFiles(options.dir);
  const conn = await db.reserve();
  const applied: string[] = [];
  try {
    await conn`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await conn`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    text PRIMARY KEY,
          name       text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`;
      const done = new Set(
        (await conn<{ version: string }[]>`SELECT version FROM schema_migrations`).map(
          (r) => r.version,
        ),
      );
      for (const file of files) {
        if (done.has(file.version)) continue;
        const content = await Bun.file(file.path).text();
        await conn.unsafe('BEGIN');
        try {
          await conn.unsafe(content);
          await conn`INSERT INTO schema_migrations (version, name) VALUES (${file.version}, ${file.name})`;
          await conn.unsafe('COMMIT');
        } catch (err) {
          await conn.unsafe('ROLLBACK');
          throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, {
            cause: err,
          });
        }
        applied.push(file.name);
        options.log?.(`applied migration ${file.name}`);
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
  return { applied };
}
