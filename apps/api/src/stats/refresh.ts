/**
 * Refreshes the stats when the matches changed since the last refresh. Runs in the background
 * (never blocks requests). Two kinds of steps:
 * - the per-participant tables (`STATS_INCREMENTAL_TABLES`, 0030_incremental_stats.sql) only get
 *   the rows of the matches they do not hold yet (`pl_stats_fill`): their cost follows the matches
 *   stored since the last refresh, not the matches of two patches;
 * - the aggregates are materialized views recomputed from them: served ones are refreshed
 *   CONCURRENTLY, intermediate ones (only read by the refresh itself) plainly.
 * A Postgres advisory lock keeps several API instances from refreshing at the same time.
 */
import type { Db, Queryable } from '@pick-league/db';
import type { StatsStatusResponse } from '@pick-league/shared';
import { readCollectionStatus } from './collection.ts';

/**
 * A materialized view to refresh. `concurrent` = read by requests. `noNestedLoops` = refreshed
 * with `enable_nestloop = off`. `serial` = refreshed without parallel workers.
 */
export interface StatsViewStep {
  view: string;
  concurrent: boolean;
  analyze?: boolean;
  noNestedLoops?: boolean;
  serial?: boolean;
}

/** The per-participant tables brought up to date (`pl_stats_fill`, until no match is left). */
export interface StatsIncrementalStep {
  incremental: true;
}

export type StatsRefreshStep = StatsViewStep | StatsIncrementalStep;

/**
 * The tables `pl_stats_fill` adds the new matches to, in the order it reports them:
 * `stats_matches` is the bookkeeping (the matches whose rows are computed), the others hold one
 * row per participant, lane or swap of those matches. Their entries in the per-step durations of
 * a refresh are the time spent adding to each; `stats_patch_items` is the time spent checking
 * that the items of each patch are still the ones its rows were computed with.
 */
export const STATS_INCREMENTAL_TABLES = [
  'stats_matches',
  'stats_participants',
  'stats_quest_items',
  'stats_lanes',
  'stats_participant_swaps',
] as const;

/** Refresh order (dependencies first). */
export const STATS_REFRESH_ORDER: readonly StatsRefreshStep[] = [
  // First, so that every match the aggregates below see through these tables is also in the
  // views computed after it (its teams' compositions, the thresholds of its patch).
  // Each call of pl_stats_fill computes at most `batchMatches` matches in one transaction, with
  // the per-participant queries of the materialized views these tables were (0026): the build
  // from the participant's own participant_events row, a nested loop per participant by design.
  // The joins around it start from the list of the new matches, analyzed, so the planner knows
  // how many there are: index lookups by match for the matches of an hour (reading `participants`
  // whole for them would be the old cost again). Serial inside the function: with parallel
  // workers, hash joins are parallel hash joins, each allowed work_mem x 2 x (workers + 1) of
  // Postgres's 1 GB /dev/shm, and several at once did not fit ("could not resize shared memory
  // segment", every other refresh on 2026-11-23); the per-participant passes cannot run in
  // workers anyway.
  { incremental: true },
  { view: 'stats_champion_traits', concurrent: true },
  { view: 'stats_team_comp', concurrent: false, analyze: true },
  { view: 'stats_comp_thresholds', concurrent: true },
  // The composition traits of each team against the thresholds just computed
  // (0030_incremental_stats.sql): they move with every match of the patch, so they are applied
  // here and not kept in the per-participant rows. Read by stats_participant_traits (plain view)
  // and stats_choice_traits.
  { view: 'stats_team_traits', concurrent: false, analyze: true },
  { view: 'stats_champion_roles', concurrent: true },
  { view: 'stats_champion_vs', concurrent: true },
  { view: 'stats_champion_with', concurrent: true },
  { view: 'stats_champion_comp_traits', concurrent: true },
  { view: 'stats_choices', concurrent: true },
  { view: 'stats_choice_matchups', concurrent: true },
  { view: 'stats_choice_traits', concurrent: true },
  // Item choices with a duo partner / an ally composition trait (0012_choice_ally_contexts.sql).
  { view: 'stats_choice_duos', concurrent: true },
  { view: 'stats_choice_ally_traits', concurrent: true },
  // Lane-phase gold/XP/CS differences (0010_lane_phase.sql), averaged from stats_lanes.
  { view: 'stats_champion_lane_phase', concurrent: true },
  // Tier list ban rates (0003_stats_bans.sql).
  { view: 'stats_patch_matches', concurrent: true },
  { view: 'stats_champion_bans', concurrent: true },
  // Results per side, for the draft evaluation (0016_side_wins.sql).
  { view: 'stats_side_wins', concurrent: true },
  // Win rate by the player's mastery of the champion, for the picks' mastery term
  // (0018_mastery_curve.sql). Since champion_masteries only keeps the champions of stored games
  // (0027), the planner reads each mastery row's player through the puuid index of participants,
  // expecting one row where a tracked player has hundreds: over 6 minutes on 2026-11-23, against
  // 7 s with hash joins.
  { view: 'stats_champion_mastery', concurrent: true, noNestedLoops: true },
  // Tier list filters by server and rank (0006_tierlist_filters.sql). Recomputed whole: the rank
  // is the player's current one (players.solo_tier), which changes without any new match.
  { view: 'stats_tierlist_participants', concurrent: false, analyze: true },
  // Results by game length, for the early / late profile (0019_game_length.sql).
  { view: 'stats_champion_game_length', concurrent: true },
  // Late-game item swaps of the build (0022_item_swaps.sql), counted from stats_participant_swaps.
  { view: 'stats_item_swaps', concurrent: true },
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
  /** Per-step durations (ms): each materialized view, and each incremental table. */
  views: Record<string, number>;
  /** Matches whose per-participant rows this refresh computed. */
  matchesComputed: number;
  /**
   * Of those, matches that had rows and lost them first: the items of their patch were replaced
   * since they were computed (a new Data Dragon version of a kept patch).
   */
  matchesRecomputed: number;
}

export interface RefreshOptions {
  /** Refresh even if the matches did not change. */
  force?: boolean;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Session work_mem for the refresh (default '256MB'). */
  workMem?: string;
  /**
   * Parallel workers per query (`max_parallel_workers_per_gather`, default 0). Their hash tables
   * live in /dev/shm: only raise it where Postgres has enough of it (the compose file gives 1 GB).
   */
  parallelWorkers?: number;
  /**
   * `statement_timeout` of each statement of the refresh (default '2h', several times the slowest
   * view). A view that runs past it fails the refresh, which is tried again at the next tick,
   * rather than holding the refresh lock and its table locks with no end.
   */
  statementTimeout?: string;
  /** Steps to run, in order (default `STATS_REFRESH_ORDER`; tests use a shorter list). */
  views?: readonly StatsRefreshStep[];
  /**
   * Empties the incremental tables first, so that this refresh computes every stored match again
   * (about as long as a refresh took before 0030; implies `force`). The served views keep their
   * rows until they are refreshed from the rebuilt tables. For a doubt about the tables, or after
   * changing what the functions of 0030_incremental_stats.sql compute without emptying them.
   */
  rebuild?: boolean;
  /**
   * Matches computed per call of `pl_stats_fill`, i.e. per transaction (default 20,000: the
   * matches of several hours in one call, a rebuild in calls of a minute or so each).
   */
  batchMatches?: number;
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
      locked: boolean;
    }[]
  >`
    SELECT m.stored, m.last_fetched,
      ok.signature AS ok_signature, ok.match_count AS ok_match_count,
      ok.finished_at AS ok_finished_at, ok.duration_ms AS ok_duration_ms,
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
  };
}

const NOTHING_DONE = {
  refreshed: false,
  durationMs: 0,
  matchesComputed: 0,
  matchesRecomputed: 0,
} as const;

/**
 * Brings the incremental tables up to date: `pl_stats_fill` (0030_incremental_stats.sql) until it
 * finds fewer matches than a call may take. Each call is one transaction that computes the rows
 * of matches that have none and records those matches in `stats_matches`: a failure loses that
 * call only, and the next refresh goes on from there. The durations are added to `views`, per
 * table. With `rebuild`, the tables are emptied first.
 */
async function fillIncrementalTables(
  conn: Queryable,
  views: Record<string, number>,
  options: RefreshOptions,
): Promise<{ computed: number; recomputed: number }> {
  const batch = Math.max(1, Math.floor(options.batchMatches ?? 20_000));
  const spent: Record<string, number> = {};
  const add = (step: string, ms: number) => {
    spent[step] = (spent[step] ?? 0) + ms;
    views[step] = Math.round(spent[step] ?? 0);
  };
  let computed = 0;
  let recomputed = 0;
  if (options.rebuild) {
    const t = performance.now();
    // Every table of rows computed from a match references stats_matches (ON DELETE CASCADE).
    await conn.unsafe('TRUNCATE stats_matches CASCADE');
    add('stats_matches', performance.now() - t);
  }
  for (;;) {
    const steps = await conn<{ step: string; ms: number; row_count: string }[]>`
      SELECT step, ms, row_count FROM pl_stats_fill(${batch}::int)`;
    let taken = 0;
    for (const s of steps) {
      add(s.step, s.ms);
      if (s.step === 'stats_matches') taken = Number(s.row_count);
      if (s.step === 'stats_patch_items') recomputed += Number(s.row_count);
    }
    computed += taken;
    if (taken < batch) break;
  }
  // The aggregates join these tables: statistics of what they hold now (rows were added here, or
  // deleted with their matches since the last refresh). A sample, whatever the size of the table.
  for (const table of STATS_INCREMENTAL_TABLES) {
    const t = performance.now();
    await conn.unsafe(`ANALYZE ${table}`);
    add(table, performance.now() - t);
  }
  return { computed, recomputed };
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
      return { ...NOTHING_DONE, reason: 'locked', matchCount: 0, views };
    }
    try {
      const { signature, matchCount } = await matchSignature(db);
      if (!options.force && !options.rebuild) {
        const [last] = await conn<{ signature: string }[]>`
          SELECT signature FROM stats_refresh_log
          WHERE finished_at IS NOT NULL AND error IS NULL
          ORDER BY id DESC LIMIT 1`;
        if (last?.signature === signature) {
          return { ...NOTHING_DONE, reason: 'unchanged', matchCount, views };
        }
      }
      const [logRow] = await conn<{ id: number }[]>`
        INSERT INTO stats_refresh_log (signature, match_count) VALUES (${signature}, ${matchCount})
        RETURNING id`;
      try {
        await conn.unsafe(`SET work_mem = '${(options.workMem ?? '256MB').replace(/'/g, '')}'`);
        // Serial by default: parallel workers keep their hash tables in /dev/shm (64 MB in Docker by
        // default), and with this work_mem the big joins failed with "could not resize shared
        // memory segment" past ~65k matches. Serial plans spill to disk instead.
        const workers = Math.max(0, Math.floor(options.parallelWorkers ?? 0));
        await conn.unsafe(`SET max_parallel_workers_per_gather = ${workers}`);
        await conn.unsafe(
          `SET statement_timeout = '${(options.statementTimeout ?? '2h').replace(/'/g, '')}'`,
        );
        // Fresh planner statistics: the views join large tables whose size changes a lot.
        await conn.unsafe('ANALYZE matches, participants, participant_events');
        const filled = { computed: 0, recomputed: 0 };
        for (const step of options.views ?? STATS_REFRESH_ORDER) {
          if ('incremental' in step) {
            const done = await fillIncrementalTables(conn, views, options);
            filled.computed += done.computed;
            filled.recomputed += done.recomputed;
            continue;
          }
          const t = performance.now();
          if (step.noNestedLoops) await conn.unsafe('SET enable_nestloop = off');
          if (step.serial) await conn.unsafe('SET max_parallel_workers_per_gather = 0');
          try {
            await conn.unsafe(
              `REFRESH MATERIALIZED VIEW ${step.concurrent ? 'CONCURRENTLY ' : ''}${step.view}`,
            );
          } finally {
            if (step.noNestedLoops) await conn.unsafe('RESET enable_nestloop');
            if (step.serial) {
              await conn.unsafe(`SET max_parallel_workers_per_gather = ${workers}`);
            }
          }
          if (step.analyze) await conn.unsafe(`ANALYZE ${step.view}`);
          views[step.view] = Math.round(performance.now() - t);
        }
        const durationMs = Math.round(performance.now() - started);
        await conn`
          UPDATE stats_refresh_log SET finished_at = now(), duration_ms = ${durationMs}
          WHERE id = ${logRow?.id ?? 0}`;
        const matchesComputed = filled.computed;
        const matchesRecomputed = filled.recomputed;
        options.log?.('stats refreshed', {
          matchCount,
          durationMs,
          matchesComputed,
          matchesRecomputed,
          views,
        });
        return {
          refreshed: true,
          reason: 'refreshed',
          matchCount,
          durationMs,
          views,
          matchesComputed,
          matchesRecomputed,
        };
      } catch (err) {
        await conn`
          UPDATE stats_refresh_log SET finished_at = now(), error = ${(err as Error).message}
          WHERE id = ${logRow?.id ?? 0}`;
        throw new StatsRefreshError(Object.keys(views), err);
      } finally {
        await conn.unsafe('RESET work_mem');
        await conn.unsafe('RESET max_parallel_workers_per_gather');
        await conn.unsafe('RESET statement_timeout');
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(${STATS_REFRESH_LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}

export interface StatsRefresherOptions extends RefreshOptions {
  /** Timer period; the timer only refreshes when the matches changed. 0 = no refresh at all. */
  intervalMs: number;
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
 * Runs `refreshStats` now and then every `intervalMs`, one run at a time within an instance (the
 * advisory lock serialises instances), clearing caches after every run that changed the views.
 */
export class StatsRefresher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<RefreshResult | null> | null = null;

  constructor(
    private readonly db: Db,
    private readonly options: StatsRefresherOptions,
  ) {}

  /** Refreshes now, then on the timer. An `intervalMs` of 0 switches both off (nothing runs). */
  start(): void {
    if (this.options.intervalMs <= 0) return;
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
    const q = this.options.statusDb ?? this.db;
    const [s, collection] = await Promise.all([readStatsRefreshState(q), readCollectionStatus(q)]);
    const included = s.lastOk?.matchCount ?? 0;
    return {
      refreshing: this.running !== null || s.locked,
      lastRefreshedAt: s.lastOk?.finishedAt.toISOString() ?? null,
      lastRefreshDurationMs: s.lastOk?.durationMs ?? null,
      matchesIncluded: included,
      matchesStored: s.matchesStored,
      pendingMatches: Math.max(0, s.matchesStored - included),
      collection,
    };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
