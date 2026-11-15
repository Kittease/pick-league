import postgres from 'postgres';

/** A connection pool. */
export type Db = postgres.Sql;
/** A pool or an open transaction: every query function accepts either. */
export type Queryable = postgres.Sql | postgres.TransactionSql;

export interface CreateDbOptions {
  /** Pool size (default 10). */
  max?: number;
  /** Seconds before an idle connection is closed (default 30). */
  idleTimeout?: number;
}

/**
 * Creates a `postgres` (porsager) pool. Column names are returned as-is (snake_case);
 * the query functions of this package map them to camelCase objects.
 * Call `await db.end()` on shutdown.
 */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}): Db {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    onnotice: () => {},
  });
}

/**
 * Runs `fn` in a transaction: a new one on a pool, a savepoint inside an existing transaction.
 */
export async function inTransaction<T>(
  q: Queryable,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if ('savepoint' in q) return (await q.savepoint(fn)) as T;
  return (await q.begin(fn)) as T;
}

/**
 * Sort order for rows upserted by puuid: concurrent transactions that lock the same players
 * must take the locks in one order, or Postgres aborts one of them with a deadlock.
 */
export function byPuuid(a: { puuid: string }, b: { puuid: string }): number {
  return a.puuid < b.puuid ? -1 : a.puuid > b.puuid ? 1 : 0;
}

/**
 * Rows per multi-row INSERT: Postgres takes at most 65535 bind parameters per statement, so a
 * row of up to 30 columns stays far below it.
 */
export const INSERT_CHUNK_ROWS = 2000;

/** `list` in slices of `size` (bulk inserts stay under the bind-parameter limit). */
export function* chunks<T>(list: readonly T[], size: number = INSERT_CHUNK_ROWS): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}
