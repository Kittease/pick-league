/**
 * Refreshes the stats materialized views when the matches changed since the last refresh.
 * Runs in the background (never blocks requests): served views are refreshed CONCURRENTLY,
 * intermediate ones (only read by the refresh itself) plainly. A Postgres advisory lock keeps
 * several API instances from refreshing at the same time.
 */
import type { Db, Queryable } from '@pick-league/db';
import type { StatsRefreshResponse, StatsStatusResponse } from '@pick-league/shared';

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
  // Support quest upgrades (0007_support_quest_items.sql), read by stats_participant_choices.
  { view: 'stats_quest_items', concurrent: false, analyze: true },
  { view: 'stats_champion_roles', concurrent: true },
  { view: 'stats_champion_vs', concurrent: true },
  { view: 'stats_champion_with', concurrent: true },
  { view: 'stats_champion_comp_traits', concurrent: true },
  { view: 'stats_choices', concurrent: true },
  { view: 'stats_choice_matchups', concurrent: true },
  { view: 'stats_choice_traits', concurrent: true },
  // Tier list ban rates (0003_stats_bans.sql).
  { view: 'stats_patch_matches', concurrent: true },
  { view: 'stats_champion_bans', concurrent: true },
  // Tier list filters by server and rank (0006_tierlist_filters.sql).
  { view: 'stats_tierlist_participants', concurrent: false, analyze: true },
  { view: 'stats_tierlist_roles', concurrent: true },
  { view: 'stats_tierlist_vs', concurrent: true },
  { view: 'stats_tierlist_with', concurrent: true },
  { view: 'stats_tierlist_bans', concurrent: true },
  { view: 'stats_tierlist_totals', concurrent: true },
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
  /** Views to refresh, in order (default `STATS_REFRESH_ORDER`; tests use a shorter list). */
  views?: typeof STATS_REFRESH_ORDER;
}

/**
 * A refresh that failed part-way. `refreshedViews` already hold new data while the others still
 * hold the old one: responses computed before are stale either way, so caches must be cleared
 * when it is not empty.
 */
export class StatsRefreshError extends Error {
  constructor(
    readonly refreshedViews: readonly string[],
    cause: unknown,
  ) {
    super((cause as Error)?.message ?? String(cause), { cause });
    this.name = 'StatsRefreshError';
  }
}

/** Match count + newest fetch time: changes whenever matches are added or deleted. */
function signatureOf(matchCount: number, lastFetchedAt: Date | null): string {
  return `${matchCount}|${lastFetchedAt?.toISOString() ?? '-'}`;
}

async function matchSignature(db: Queryable): Promise<{ signature: string; matchCount: number }> {
  const [row] = await db<{ n: number; last: Date | null }[]>`
    SELECT count(*)::int AS n, max(fetched_at) AS last FROM matches`;
  const n = row?.n ?? 0;
  return { signature: signatureOf(n, row?.last ?? null), matchCount: n };
}

/** `pg_locks` shows a bigint advisory key as classid = high 32 bits, objid = low 32 bits. */
const LOCK_CLASSID = Math.floor(STATS_REFRESH_LOCK_KEY / 2 ** 32);
const LOCK_OBJID = STATS_REFRESH_LOCK_KEY % 2 ** 32;

export interface StatsRefreshState {
  /** Some session (any API instance) holds the refresh advisory lock. */
  locked: boolean;
  matchesStored: number;
  /** Signature of the matches now. */
  signature: string;
  /** Last successful refresh. */
  lastOk: {
    signature: string;
    matchCount: number;
    finishedAt: Date;
    durationMs: number | null;
  } | null;
  /** Milliseconds since the last refresh (successful or not) finished, by the database clock. */
  msSinceLastFinished: number | null;
}

/** One cheap round trip: match count (as /health), last refresh log rows, lock holder. */
export async function readStatsRefreshState(q: Queryable): Promise<StatsRefreshState> {
  const [row] = await q<
    {
      stored: number;
      last_fetched: Date | null;
      ok_signature: string | null;
      ok_match_count: number | null;
      ok_finished_at: Date | null;
      ok_duration_ms: number | null;
      since_finished_ms: number | null;
      locked: boolean;
    }[]
  >`
    SELECT m.stored, m.last_fetched,
      ok.signature AS ok_signature, ok.match_count AS ok_match_count,
      ok.finished_at AS ok_finished_at, ok.duration_ms AS ok_duration_ms,
      (SELECT (extract(epoch FROM now() - max(finished_at)) * 1000)::float8
         FROM stats_refresh_log) AS since_finished_ms,
      EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND classid = ${LOCK_CLASSID}::oid AND objid = ${LOCK_OBJID}::oid
      ) AS locked
    FROM (SELECT count(*)::int AS stored, max(fetched_at) AS last_fetched FROM matches) m
    LEFT JOIN LATERAL (
      SELECT signature, match_count, finished_at, duration_ms FROM stats_refresh_log
      WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    ) ok ON true`;
  const stored = row?.stored ?? 0;
  return {
    locked: row?.locked ?? false,
    matchesStored: stored,
    signature: signatureOf(stored, row?.last_fetched ?? null),
    lastOk:
      row?.ok_signature != null && row.ok_finished_at
        ? {
            signature: row.ok_signature,
            matchCount: row.ok_match_count ?? 0,
            finishedAt: row.ok_finished_at,
            durationMs: row.ok_duration_ms,
          }
        : null,
    msSinceLastFinished: row?.since_finished_ms ?? null,
  };
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
        for (const step of options.views ?? STATS_REFRESH_ORDER) {
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
        throw new StatsRefreshError(Object.keys(views), err);
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
  /** Timer period; the timer only refreshes when the matches changed. */
  intervalMs: number;
  /**
   * Manual refreshes (`requestRefresh`) are refused until this long after the previous refresh
   * (timer or manual, any instance) finished. 0 disables the cooldown.
   */
  manualCooldownMs?: number;
  /** Pool for the cheap status queries (default: the refresh pool). */
  statusDb?: Queryable;
  /**
   * Called after a refresh that changed the views (e.g. to clear response caches), including a
   * failed one that had already refreshed some of them.
   */
  onRefreshed?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Runs `refreshStats` now and then every `intervalMs`, one run at a time, and on demand
 * (`requestRefresh`). Timer and manual runs share `tick`, so they never overlap within an
 * instance, always clear caches the same way, and the advisory lock serialises instances.
 */
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
        if (err instanceof StatsRefreshError && err.refreshedViews.length > 0) {
          this.options.onRefreshed?.();
        }
        this.options.onError?.(err);
        return null;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Resolves when the refresh in progress in this instance (if any) is over. */
  async idle(): Promise<void> {
    await this.running;
  }

  async status(): Promise<StatsStatusResponse> {
    const s = await readStatsRefreshState(this.options.statusDb ?? this.db);
    const included = s.lastOk?.matchCount ?? 0;
    return {
      refreshing: this.running !== null || s.locked,
      lastRefreshedAt: s.lastOk?.finishedAt.toISOString() ?? null,
      lastRefreshDurationMs: s.lastOk?.durationMs ?? null,
      matchesIncluded: included,
      matchesStored: s.matchesStored,
      pendingMatches: Math.max(0, s.matchesStored - included),
    };
  }

  /**
   * Manual trigger: starts a background refresh when none is running anywhere, the matches
   * changed since the last successful refresh and the cooldown is over. Never waits for it.
   */
  async requestRefresh(): Promise<StatsRefreshResponse> {
    if (this.running) return { started: false, reason: 'already_running' };
    const s = await readStatsRefreshState(this.options.statusDb ?? this.db);
    // Re-checked after the await: a concurrent request may have started one meanwhile.
    if (this.running || s.locked) return { started: false, reason: 'already_running' };
    if (s.lastOk?.signature === s.signature) return { started: false, reason: 'up_to_date' };
    const cooldownMs = this.options.manualCooldownMs ?? 0;
    if (cooldownMs > 0 && s.msSinceLastFinished !== null && s.msSinceLastFinished < cooldownMs) {
      return {
        started: false,
        reason: 'cooldown',
        retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - s.msSinceLastFinished) / 1000)),
      };
    }
    void this.tick();
    return { started: true };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
