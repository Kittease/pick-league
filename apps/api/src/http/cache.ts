/** In-memory TTL cache with a size cap (oldest entries evicted first). */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

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

  /** Returns the cached value or computes, stores and returns it. */
  async getOrCompute(key: string, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const cached = this.get(key);
    if (cached !== undefined) return { value: cached, hit: true };
    const value = await compute();
    this.set(key, value);
    return { value, hit: false };
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const sortNums = (xs: readonly number[]) => [...new Set(xs)].sort((a, b) => a - b);

/** Cache key of a picks request: order-insensitive lists, unknown (null) picks dropped. */
export function picksCacheKey(req: {
  role: string;
  allies: readonly { championId: number | null; role: string | null }[];
  enemies: readonly (number | null)[];
  bans: readonly number[];
  availableChampionIds?: readonly number[];
  limit?: number;
  patch?: string;
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
  ]);
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
