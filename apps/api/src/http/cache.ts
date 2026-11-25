import { masteryBucket, masteryPoints } from '../engine/mastery.ts';

/**
 * In-memory TTL cache with a size cap (oldest entries evicted first).
 *
 * `getOrCompute` runs one compute per key at a time (concurrent callers share it) and only stores
 * its result if the cache was not cleared meanwhile: `clear()` starts a new generation, so a
 * response computed from the stats as they were before a refresh is never stored after it.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly pending = new Map<string, { generation: number; promise: Promise<T> }>();
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * Returns the cached value, or joins the compute of `key` already running in this generation,
   * or computes it and stores it unless `clear()` was called meanwhile. `hit` = served from the
   * cache. A failed compute is not stored.
   */
  async getOrCompute(key: string, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const cached = this.get(key);
    if (cached !== undefined) return { value: cached, hit: true };
    const running = this.pending.get(key);
    if (running && running.generation === this.generation) {
      return { value: await running.promise, hit: false };
    }
    const generation = this.generation;
    const job = { generation, promise: (async () => compute())() };
    this.pending.set(key, job);
    try {
      const value = await job.promise;
      if (generation === this.generation) this.set(key, value);
      return { value, hit: false };
    } finally {
      if (this.pending.get(key) === job) this.pending.delete(key);
    }
  }

  /** Drops every entry; computes already running will not store their results. */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const sortNums = (xs: readonly number[]) => [...new Set(xs)].sort((a, b) => a - b);

/**
 * The mastery profile of a picks request as `championId:bucket`, sorted. The answer only depends
 * on buckets, and bucket 0 is the same as not listed, so those champions are left out.
 */
function masteryKey(masteries: readonly { championId: number; points: number }[]): string[] {
  return [...masteryPoints(masteries)]
    .map(([championId, points]) => [championId, masteryBucket(points)] as const)
    .filter(([, bucket]) => bucket > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([championId, bucket]) => `${championId}:${bucket}`);
}

/** Cache key of a picks request: order-insensitive lists, unknown (null) picks dropped. */
export function picksCacheKey(req: {
  role: string;
  allies: readonly { championId: number | null; role: string | null }[];
  enemies: readonly (number | null)[];
  bans: readonly number[];
  availableChampionIds?: readonly number[];
  limit?: number;
  patch?: string;
  masteries?: readonly { championId: number; points: number }[];
}): string {
  return JSON.stringify([
    'picks',
    req.role,
    req.allies
      .filter((a) => a.championId !== null || a.role !== null)
      .map((a) => `${a.role ?? '?'}:${a.championId ?? '?'}`)
      .sort(),
    sortNums(req.enemies.filter((e): e is number => e !== null)),
    sortNums(req.bans),
    req.availableChampionIds ? sortNums(req.availableChampionIds) : null,
    req.limit ?? null,
    req.patch ?? null,
    // `[]` (masteries read, none above 0 points) still gets the mastery term: not the same as null.
    req.masteries ? masteryKey(req.masteries) : null,
  ]);
}

/** Cache key of a tier list request (parsed query: defaults filled in, so `?role=X` = all defaults). */
export function tierListCacheKey(query: {
  role: string;
  patch: string;
  platform: string;
  rank: string;
}): string {
  return JSON.stringify(['tierlist', query.role, query.patch, query.platform, query.rank]);
}

/** Cache key of a build request. */
export function buildCacheKey(req: {
  championId: number;
  role: string;
  allies: readonly { championId: number; role: string | null }[];
  enemies: readonly { championId: number; role: string | null }[];
  patch?: string;
}): string {
  const side = (xs: readonly { championId: number; role: string | null }[]) =>
    xs.map((x) => `${x.role ?? '?'}:${x.championId}`).sort();
  return JSON.stringify([
    'build',
    req.championId,
    req.role,
    side(req.allies),
    side(req.enemies),
    req.patch ?? null,
  ]);
}

/** Same draft whatever the order of each team's champions. */
export function draftCacheKey(req: {
  allies: readonly { championId: number; role: string | null }[];
  enemies: readonly { championId: number; role: string | null }[];
  side: string | null;
  platform?: string | null;
  patch?: string;
}): string {
  const team = (xs: readonly { championId: number; role: string | null }[]) =>
    xs.map((x) => `${x.role ?? '?'}:${x.championId}`).sort();
  return JSON.stringify([
    'draft',
    team(req.allies),
    team(req.enemies),
    req.side,
    req.platform ?? null,
    req.patch ?? null,
  ]);
}
