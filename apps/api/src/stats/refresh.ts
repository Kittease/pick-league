/**
 * Refreshes the stats materialized views when the matches changed since the last refresh.
 * Runs in the background (never blocks requests): served views are refreshed CONCURRENTLY,
 * intermediate ones (only read by the refresh itself) plainly. A Postgres advisory lock keeps
 * several API instances from refreshing at the same time.
 */
import type { Db } from '@pick-league/db';

/** Refresh order (dependencies first). `concurrent` = read by requests. */
export const STATS_REFRESH_ORDER: readonly {
  view: string;
  concurrent: boolean;
  analyze?: boolean;
}[] = [
  { view: 'stats_champion_traits', concurrent: true },
  { view: 'stats_team_comp', concurrent: false, analyze: true },
  { view: 'stats_comp_thresholds', concurrent: true },
  { view: 'stats_participants', concurrent: false, analyze: true },
  { view: 'stats_champion_roles', concurrent: true },
  { view: 'stats_champion_vs', concurrent: true },
  { view: 'stats_champion_with', concurrent: true },
  { view: 'stats_champion_comp_traits', concurrent: true },
  { view: 'stats_choices', concurrent: true },
  { view: 'stats_choice_matchups', concurrent: true },
  { view: 'stats_choice_traits', concurrent: true },
];

export const STATS_REFRESH_LOCK_KEY = 7_316_221_905;

export interface RefreshResult {
  refreshed: boolean;
  reason: 'unchanged' | 'locked' | 'refreshed';
  matchCount: number;
  durationMs: number;
  /** Per-view durations (ms). */
  views: Record<string, number>;
}

export interface RefreshOptions {
  /** Refresh even if the matches did not change. */
  force?: boolean;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Session work_mem for the refresh (default '256MB'). */
  workMem?: string;
}

/** Match count + newest fetch time: changes whenever matches are added or deleted. */
async function matchSignature(db: Db): Promise<{ signature: string; matchCount: number }> {
  const [row] = await db<{ n: number; last: Date | null }[]>`
    SELECT count(*)::int AS n, max(fetched_at) AS last FROM matches`;
  const n = row?.n ?? 0;
  return { signature: `${n}|${row?.last?.toISOString() ?? '-'}`, matchCount: n };
}

export async function refreshStats(db: Db, options: RefreshOptions = {}): Promise<RefreshResult> {
  const started = performance.now();
  const conn = await db.reserve();
  const views: Record<string, number> = {};
  try {
    const [lock] = await conn<
      { ok: boolean }[]
    >`SELECT pg_try_advisory_lock(${STATS_REFRESH_LOCK_KEY}) AS ok`;
    if (!lock?.ok) {
      return { refreshed: false, reason: 'locked', matchCount: 0, durationMs: 0, views };
    }
    try {
      const { signature, matchCount } = await matchSignature(db);
      if (!options.force) {
        const [last] = await conn<{ signature: string }[]>`
          SELECT signature FROM stats_refresh_log
          WHERE finished_at IS NOT NULL AND error IS NULL
          ORDER BY id DESC LIMIT 1`;
        if (last?.signature === signature) {
          return { refreshed: false, reason: 'unchanged', matchCount, durationMs: 0, views };
        }
      }
      const [logRow] = await conn<{ id: number }[]>`
        INSERT INTO stats_refresh_log (signature, match_count) VALUES (${signature}, ${matchCount})
        RETURNING id`;
      try {
        await conn.unsafe(`SET work_mem = '${(options.workMem ?? '256MB').replace(/'/g, '')}'`);
        // Fresh planner statistics: the views join large tables whose size changes a lot.
        await conn.unsafe('ANALYZE matches, participants, item_events, skill_events');
        for (const step of STATS_REFRESH_ORDER) {
          const t = performance.now();
          await conn.unsafe(
            `REFRESH MATERIALIZED VIEW ${step.concurrent ? 'CONCURRENTLY ' : ''}${step.view}`,
          );
          if (step.analyze) await conn.unsafe(`ANALYZE ${step.view}`);
          views[step.view] = Math.round(performance.now() - t);
        }
        const durationMs = Math.round(performance.now() - started);
        await conn`
          UPDATE stats_refresh_log SET finished_at = now(), duration_ms = ${durationMs}
          WHERE id = ${logRow?.id ?? 0}`;
        options.log?.('stats refreshed', { matchCount, durationMs, views });
        return { refreshed: true, reason: 'refreshed', matchCount, durationMs, views };
      } catch (err) {
        await conn`
          UPDATE stats_refresh_log SET finished_at = now(), error = ${(err as Error).message}
          WHERE id = ${logRow?.id ?? 0}`;
        throw err;
      } finally {
        await conn.unsafe('RESET work_mem');
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(${STATS_REFRESH_LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}

export interface StatsRefresherOptions extends RefreshOptions {
  intervalMs: number;
  /** Called after a refresh that changed the views (e.g. to clear response caches). */
  onRefreshed?: () => void;
  onError?: (err: unknown) => void;
}

/** Runs `refreshStats` now and then every `intervalMs`, one run at a time. */
export class StatsRefresher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<RefreshResult | null> | null = null;

  constructor(
    private readonly db: Db,
    private readonly options: StatsRefresherOptions,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
  }

  /** Runs a refresh unless one is in progress (then returns the running one). */
  tick(force = false): Promise<RefreshResult | null> {
    if (this.running) return this.running;
    this.running = refreshStats(this.db, { ...this.options, force })
      .then((r) => {
        if (r.refreshed) this.options.onRefreshed?.();
        return r;
      })
      .catch((err) => {
        this.options.onError?.(err);
        return null;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
