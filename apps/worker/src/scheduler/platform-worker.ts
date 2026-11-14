/**
 * One platform's crawler. Five kinds of work run concurrently and all wait on the same per-host
 * rate limiters, which serve the highest priority first (docs/architecture.md, "Worker"):
 *
 * 1. ladder refresh (hourly)            → platform host, priority 5
 * 2. match-id listing of "played" players → match cluster, priority 4
 * 3. match + timeline fetch             → match cluster, priority 3
 * 4. daily account + mastery refresh    → account cluster + platform host, priority 2
 * 5. enrichment (mastery + rank)        → platform host, priority 1
 *
 * So level 5 only gets a host's budget when nothing of a higher level is waiting for it.
 */
import {
  claimEnrichment,
  claimPendingMatches,
  clearWorkerAuthRejected,
  completeEnrichment,
  countEnrichmentQueue,
  countPendingMatches,
  type DailyRefreshCandidate,
  type Db,
  deferMatch,
  deferMatchAfterError,
  enqueueMatchIds,
  failEnrichment,
  finishListing,
  finishWorkerRun,
  getMatchesSyncedUntil,
  insertParsedMatch,
  type LadderEntryInput,
  type MasteryInput,
  markMatchFailed,
  markMatchSkipped,
  markWorkerAuthRejected,
  pickProbeMatch,
  playersNeedingDailyRefresh,
  playersWithListingRequested,
  type QueuedEnrichment,
  type QueuedMatch,
  recordWorkerError,
  replaceMasteries,
  type SoloRankInput,
  skipPendingMatchesUpTo,
  startWorkerRun,
  touchWorkerStatus,
  trackedPlayersNeverListed,
  updatePlayerRank,
  updatePlayerRiotId,
  upsertLadder,
} from '@pick-league/db';
import {
  type ChampionMasteryDto,
  divisionToNumber,
  isSoloTier,
  type LadderTier,
  type LeagueEntryDto,
  type LeagueListDto,
  type Platform,
  patchFromGameVersion,
  platformFromMatchId,
  RANKED_SOLO_QUEUE,
} from '@pick-league/shared';
import { type Clock, isAbortError, systemClock } from '../clock.ts';
import { DEFAULT_MASTER_PLAYERS } from '../config.ts';
import { errorMessage, type Logger, silentLogger } from '../log.ts';
import { MatchParseError, parseMatch } from '../parser/parse-match.ts';
import type { PatchVerdict } from '../patches.ts';
import { PRIORITY, type RiotApi, RiotAuthError } from '../riot/client.ts';
import { classifyError, DeterministicError } from './errors.ts';
import { WorkSource } from './work-source.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_LISTING_RETRY_MS = 6 * HOUR;

export interface SchedulerOptions {
  /** Ladder refresh period (default 1 h). */
  ladderIntervalMs: number;
  /**
   * First listing of a player goes back at most this far (default 14 days). It normally stops
   * sooner, at the start of the latest patch (the first older-patch match seen).
   */
  firstListingMaxMs: number;
  /**
   * `matches_synced_until` is set this far before the listing time, so games that were still
   * running during the listing (Riot filters on start time) are listed next time (default 1 h).
   */
  listingOverlapMs: number;
  /** A failed listing is retried after this, doubling with each failure up to 6 h (default 5 min). */
  listingRetryMs: number;
  /** Sleep when a kind of work has nothing to do (default 10 s). */
  idleMs: number;
  /** Matches deferred because of a too-new patch are retried after this (default 15 min). */
  deferMs: number;
  /** Pause after an auth error (expired key) (default 5 min). */
  authErrorPauseMs: number;
  /** `worker_status.heartbeat_at` is written this often while `start` runs (default 30 s). */
  heartbeatMs: number;
  /**
   * A loop whose item hit a transient error (Riot 429/5xx, network, database) sleeps this long,
   * doubling with each consecutive one up to `maxTransientBackoffMs` (default 5 s → 5 min).
   */
  transientBackoffMs: number;
  maxTransientBackoffMs: number;
  /** A match deferred this many times by transient errors becomes FAILED (default 10). */
  maxTransientErrors: number;
  concurrency: { listing: number; match: number; daily: number; enrichment: number };
  /** Master players tracked besides Challenger + Grandmaster: the top N by LP (default 1000). */
  masterPlayers: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  ladderIntervalMs: HOUR,
  firstListingMaxMs: 14 * DAY,
  listingOverlapMs: HOUR,
  listingRetryMs: 5 * 60_000,
  idleMs: 10_000,
  deferMs: 15 * 60_000,
  authErrorPauseMs: 5 * 60_000,
  heartbeatMs: 30_000,
  transientBackoffMs: 5_000,
  maxTransientBackoffMs: 5 * 60_000,
  maxTransientErrors: 10,
  concurrency: { listing: 2, match: 3, daily: 1, enrichment: 2 },
  masterPlayers: DEFAULT_MASTER_PLAYERS,
};

/** What the worker needs to know about patches (only the latest is collected). */
export interface PatchView {
  readonly ready: boolean;
  readonly generation: number;
  classify(patch: string): PatchVerdict;
  requestRefresh(): void;
}

export interface PlatformWorkerDeps {
  platform: Platform;
  db: Db;
  riot: RiotApi;
  patches: PatchView;
  log?: Logger;
  clock?: Clock;
  /** Requests sent so far for this platform (for `worker_runs`). */
  requestCount?: () => number;
  options?: Partial<SchedulerOptions>;
}

/** 'retry': transient error, the match was deferred without counting an attempt. */
export type MatchOutcome = 'added' | 'exists' | 'skipped' | 'deferred' | 'retry' | 'failed';

/** Deterministic errors (404, parse, other 4xx) fail a match on its second attempt. */
const DETERMINISTIC_MAX_ATTEMPTS = 2;
/** Unclassified errors fail a match on its fifth attempt. */
const UNKNOWN_MAX_ATTEMPTS = 5;

export interface PlatformProgress {
  platform: Platform;
  playedToList: number;
  pendingMatches: number;
  enrichmentQueue: number;
  matchesAdded: number;
  playersPolled: number;
  matchesSkipped: number;
  matchesFailed: number;
  matchesRetried: number;
  enriched: number;
  dailyRefreshed: number;
}

/** Numeric part of 'EUW1_7234567890' (game ids grow with time on a platform). */
export function gameIdOf(matchId: string): number | null {
  const n = Number(matchId.split('_')[1]);
  return Number.isSafeInteger(n) ? n : null;
}

export function toLadderEntries(list: LeagueListDto, tier: LadderTier): LadderEntryInput[] {
  return (list.entries ?? [])
    .filter((e) => typeof e.puuid === 'string' && e.puuid !== '')
    .map((e) => ({
      puuid: e.puuid,
      tier,
      leaguePoints: e.leaguePoints ?? 0,
      wins: e.wins ?? 0,
      losses: e.losses ?? 0,
    }));
}

/** The `n` entries with the most LP (Riot lists a league in no particular order). */
export function topByLp(entries: LadderEntryInput[], n: number): LadderEntryInput[] {
  return [...entries].sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, n);
}

export function toMasteries(list: readonly ChampionMasteryDto[]): MasteryInput[] {
  return list.map((m) => ({
    championId: m.championId,
    level: m.championLevel ?? 0,
    points: m.championPoints ?? 0,
    lastPlayedAt: new Date(m.lastPlayTime ?? 0),
  }));
}

export function toSoloRank(entries: readonly LeagueEntryDto[]): SoloRankInput | null {
  const solo = entries.find((e) => e.queueType === RANKED_SOLO_QUEUE);
  if (!solo || !isSoloTier(solo.tier)) return null;
  return {
    tier: solo.tier,
    division: divisionToNumber(solo.tier, solo.rank),
    lp: solo.leaguePoints ?? 0,
    wins: solo.wins ?? 0,
    losses: solo.losses ?? 0,
  };
}

export class PlatformWorker {
  readonly platform: Platform;
  private readonly db: Db;
  private readonly riot: RiotApi;
  private readonly patches: PatchView;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly opts: SchedulerOptions;
  private readonly requestCount: () => number;

  /** Players to list (insertion order = FIFO). Durable copy: `players.listing_requested_at`. */
  private readonly played = new Set<string>();
  private readonly listingInFlight = new Set<string>();
  /** Failed listings: consecutive failures, and when the player may be listed again. */
  private readonly listingFailures = new Map<string, number>();
  private readonly listingCooldown = new Map<string, number>();
  /**
   * Highest game id seen with a patch older than the latest: older ids are skipped unfetched, and
   * listings stop there (the first previous-patch match bounds every history).
   */
  private oldPatchMaxGameId = 0;
  /** Start time of that match: first listings never go back further. */
  private oldPatchCutoffMs = 0;
  /** Lowest game id seen with a patch newer than Data Dragon: newer ids wait for the patch. */
  private tooNewMinGameId: number | null = null;
  /** Lowest game id seen with the latest patch (or newer): newer ids are not from an old patch. */
  private keepMinGameId: number | null = null;
  /** Patch generation the bounds above belong to. */
  private generation = -1;
  /**
   * After a patch change (and at startup), the backlog may hold a lot of matches of the patch that
   * just became old. Before claiming in FIFO order, single matches are fetched by game id: the
   * highest pending first, then the median of the ids still between the two bounds. An old one
   * skips every pending id below it in one statement; a kept one is stored as usual. So finding
   * where the latest patch starts costs O(log n) match requests instead of one per stale row.
   */
  private probe = { active: false, first: true, inFlight: null as string | null };
  private readonly probed = new Set<string>();
  private readonly deferredUntil = new Map<string, number>();
  private readonly dailyCooldown = new Map<string, number>();

  private readonly matchSource: WorkSource<QueuedMatch>;
  private readonly dailySource: WorkSource<DailyRefreshCandidate>;
  private readonly enrichmentSource: WorkSource<QueuedEnrichment>;

  private readonly counters = {
    matchesAdded: 0,
    playersPolled: 0,
    matchesSkipped: 0,
    matchesFailed: 0,
    matchesRetried: 0,
    enriched: 0,
    dailyRefreshed: 0,
  };
  private run: { id: number; requestsAtStart: number; matches: number; players: number } | null =
    null;
  private lastError: string | null = null;
  private authPausedUntil = 0;
  /** Whether Riot accepts the key, as last seen ('unknown' until the first response). */
  private authState: 'unknown' | 'ok' | 'rejected' = 'unknown';
  private statusWrites: Promise<void> = Promise.resolve();

  constructor(deps: PlatformWorkerDeps) {
    this.platform = deps.platform;
    this.db = deps.db;
    this.riot = this.observeRiot(deps.riot);
    this.patches = deps.patches;
    this.log = (deps.log ?? silentLogger).child({ platform: deps.platform });
    this.clock = deps.clock ?? systemClock;
    this.requestCount = deps.requestCount ?? (() => 0);
    this.opts = {
      ...DEFAULT_SCHEDULER_OPTIONS,
      ...deps.options,
      concurrency: { ...DEFAULT_SCHEDULER_OPTIONS.concurrency, ...deps.options?.concurrency },
    };

    this.matchSource = new WorkSource(
      async (exclude) => {
        const now = this.clock.now();
        for (const [id, until] of this.deferredUntil)
          if (until <= now) this.deferredUntil.delete(id);
        const probe = await this.nextProbe(exclude);
        if (probe !== undefined) return probe ? [probe] : [];
        const rows = await claimPendingMatches(this.db, this.platform, 50 + exclude.size);
        return rows.filter((r) => !exclude.has(r.matchId) && !this.deferredUntil.has(r.matchId));
      },
      (m) => m.matchId,
    );
    this.dailySource = new WorkSource(
      async (exclude) => {
        const now = this.clock.now();
        for (const [p, until] of this.dailyCooldown) if (until <= now) this.dailyCooldown.delete(p);
        const rows = await playersNeedingDailyRefresh(
          this.db,
          this.platform,
          20 + exclude.size + this.dailyCooldown.size,
          24,
          new Date(now),
        );
        return rows.filter((r) => !exclude.has(r.puuid) && !this.dailyCooldown.has(r.puuid));
      },
      (c) => c.puuid,
    );
    this.enrichmentSource = new WorkSource(
      async (exclude) => {
        const rows = await claimEnrichment(this.db, this.platform, 20 + exclude.size);
        return rows.filter((r) => !exclude.has(r.puuid));
      },
      (e) => e.puuid,
    );
  }

  // -------------------------------------------------------------------------
  // Level 1: ladder
  // -------------------------------------------------------------------------

  /**
   * Fetches Challenger, Grandmaster and the top `masterPlayers` of Master, upserts them, marks who
   * played. Returns how many played.
   */
  async refreshLadder(signal?: AbortSignal): Promise<number> {
    const masterPlayers = this.opts.masterPlayers;
    const [challenger, grandmaster, master] = await Promise.all([
      this.riot.getLeague(this.platform, 'CHALLENGER', signal),
      this.riot.getLeague(this.platform, 'GRANDMASTER', signal),
      masterPlayers > 0 ? this.riot.getLeague(this.platform, 'MASTER', signal) : null,
    ]);
    const entries = [
      ...toLadderEntries(challenger, 'CHALLENGER'),
      ...toLadderEntries(grandmaster, 'GRANDMASTER'),
      ...(master ? topByLp(toLadderEntries(master, 'MASTER'), masterPlayers) : []),
    ];
    if (entries.length === 0) {
      this.log.warn('empty ladder from Riot, not stored');
      return 0;
    }
    const result = await upsertLadder(this.db, this.platform, entries, new Date(this.clock.now()));
    for (const p of result.played) this.played.add(p);
    await this.loadPendingListings();
    this.log.info('ladder refreshed', {
      entries: entries.length,
      played: result.played.length,
      added: result.added.length,
      removed: result.removed,
      toList: this.played.size,
    });
    return result.played.length;
  }

  // -------------------------------------------------------------------------
  // Level 2: match ids
  // -------------------------------------------------------------------------

  /**
   * Adds the players with a listing requested in the database (they played: the request survives
   * restarts) and those never listed (e.g. a restart interrupted their first listing).
   */
  private async loadPendingListings(): Promise<void> {
    for (const p of await playersWithListingRequested(this.db, this.platform)) this.played.add(p);
    for (const p of await trackedPlayersNeverListed(this.db, this.platform)) this.played.add(p);
  }

  /** Next player to list: FIFO, skipping players being listed or cooling down after a failure. */
  private nextPlayedPlayer(): string | null {
    const now = this.clock.now();
    for (const p of this.played) {
      // A player being listed stays in the set: they played again, so they are listed again.
      if (this.listingInFlight.has(p)) continue;
      const until = this.listingCooldown.get(p);
      if (until !== undefined && until > now) continue;
      this.played.delete(p);
      this.listingInFlight.add(p);
      return p;
    }
    return null;
  }

  private listingDone(puuid: string, ok: boolean): void {
    this.listingInFlight.delete(puuid);
    if (ok) {
      this.listingFailures.delete(puuid);
      this.listingCooldown.delete(puuid);
      return;
    }
    // Retried after a cooldown that doubles with each failure (its request stays in the database).
    const failures = (this.listingFailures.get(puuid) ?? 0) + 1;
    this.listingFailures.set(puuid, failures);
    const wait = Math.min(
      this.opts.listingRetryMs * 2 ** Math.min(failures - 1, 20),
      MAX_LISTING_RETRY_MS,
    );
    this.listingCooldown.set(puuid, this.clock.now() + wait);
    this.played.add(puuid);
  }

  /** Lists a player's ranked match ids since `matches_synced_until`; returns how many were new. */
  async listPlayerMatches(puuid: string, signal?: AbortSignal): Promise<number> {
    const now = this.clock.now();
    const since = await getMatchesSyncedUntil(this.db, puuid);
    const startMs =
      since !== null
        ? since.getTime()
        : Math.max(now - this.opts.firstListingMaxMs, this.oldPatchCutoffMs);
    let added = 0;
    for (let start = 0; ; start += 100) {
      const ids = await this.riot.getMatchIds(
        this.platform,
        puuid,
        { startTime: Math.floor(startMs / 1000), start, count: 100 },
        signal,
      );
      // Ids come newest first: once one is known to be from an older patch, the rest are too.
      // Only this platform's ids are comparable with the bound (game ids are per platform, and a
      // regional cluster lists the other platforms' matches too).
      const own = ids.filter((id) => platformFromMatchId(id) === this.platform);
      const oldAt = own.findIndex((id) => this.isKnownOldPatch(gameIdOf(id)));
      const kept = oldAt >= 0 ? own.slice(0, oldAt) : own;
      added += await enqueueMatchIds(this.db, this.platform, kept);
      if (oldAt >= 0 || ids.length < 100) break;
    }
    // Clears the player's listing request, unless they played again since `now`.
    await finishListing(this.db, puuid, new Date(now - this.opts.listingOverlapMs), new Date(now));
    this.counters.playersPolled++;
    if (this.run) this.run.players++;
    this.log.debug('match ids listed', { puuid, added, firstTime: since === null });
    return added;
  }

  // -------------------------------------------------------------------------
  // Level 3: match + timeline
  // -------------------------------------------------------------------------

  /**
   * Fetches, parses and stores one queued match. Errors are classified (`classifyError`):
   * transient ones defer the match without counting an attempt ('retry'), deterministic ones fail
   * it for good on the second attempt, unknown ones on the fifth. Abort and auth errors are thrown.
   */
  async processMatch(queued: QueuedMatch, signal?: AbortSignal): Promise<MatchOutcome> {
    try {
      return await this.fetchMatch(queued, signal);
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'abort' || kind === 'auth') throw err;
      if (kind === 'transient') return this.retryLater(queued.matchId, err);
      return this.fail(
        queued.matchId,
        errorMessage(err),
        kind === 'deterministic' ? DETERMINISTIC_MAX_ATTEMPTS : UNKNOWN_MAX_ATTEMPTS,
      );
    }
  }

  private async fetchMatch(queued: QueuedMatch, signal?: AbortSignal): Promise<MatchOutcome> {
    const { matchId } = queued;
    const gameId = gameIdOf(matchId);
    this.syncGeneration();
    if (this.isKnownOldPatch(gameId)) {
      if (await markMatchSkipped(this.db, matchId)) this.counters.matchesSkipped++;
      return 'skipped';
    }
    if (
      !this.patches.ready ||
      (gameId !== null && this.tooNewMinGameId !== null && gameId >= this.tooNewMinGameId)
    ) {
      // Moved to the back of the queue so it doesn't hide fetchable matches.
      await deferMatch(this.db, matchId, 'waiting for the patch data');
      this.deferredUntil.set(matchId, this.clock.now() + this.opts.deferMs);
      return 'deferred';
    }

    const match = await this.riot.getMatch(this.platform, matchId, signal);
    if (match === null) throw new DeterministicError('match not found (404)');
    let patch: string;
    try {
      patch = patchFromGameVersion(match.info?.gameVersion ?? '');
    } catch (err) {
      throw new DeterministicError(errorMessage(err));
    }

    const verdict = this.patches.classify(patch);
    if (verdict === 'old') {
      if (await markMatchSkipped(this.db, matchId)) this.counters.matchesSkipped++;
      if (gameId !== null && gameId > this.oldPatchMaxGameId) {
        this.oldPatchMaxGameId = gameId;
        this.oldPatchCutoffMs = Math.max(this.oldPatchCutoffMs, match.info.gameStartTimestamp ?? 0);
        // Every pending id below is older still: skipped without fetching them one by one.
        const skipped = await skipPendingMatchesUpTo(this.db, this.platform, gameId);
        this.counters.matchesSkipped += skipped;
        this.log.info('old patch boundary moved', { matchId, patch, skipped });
      }
      return 'skipped';
    }
    if (gameId !== null) this.keepMinGameId = Math.min(this.keepMinGameId ?? gameId, gameId);
    if (verdict === 'too_new') {
      await deferMatch(this.db, matchId, `patch ${patch} is newer than Data Dragon`);
      this.deferredUntil.set(matchId, this.clock.now() + this.opts.deferMs);
      if (gameId !== null) {
        this.tooNewMinGameId = Math.min(this.tooNewMinGameId ?? gameId, gameId);
      }
      this.patches.requestRefresh();
      this.log.info('match deferred: patch newer than Data Dragon', { matchId, patch });
      return 'deferred';
    }

    const timeline = await this.riot.getTimeline(this.platform, matchId, signal);
    if (timeline === null) throw new DeterministicError('timeline not found (404)');
    let parsed: ReturnType<typeof parseMatch>;
    try {
      parsed = parseMatch(match, timeline);
    } catch (err) {
      if (err instanceof MatchParseError) throw new DeterministicError(`parse: ${err.message}`);
      throw err;
    }
    const result = await insertParsedMatch(this.db, parsed);
    if (!result.inserted) return 'exists';
    this.counters.matchesAdded++;
    if (this.run) this.run.matches++;
    this.log.debug('match stored', {
      matchId,
      patch,
      itemEvents: parsed.itemEvents.length,
      enrichmentEnqueued: result.enrichmentEnqueued,
    });
    return 'added';
  }

  /** New patch generation: the too-new / kept bounds are reset and a probe starts. */
  private syncGeneration(): void {
    if (this.generation === this.patches.generation) return;
    this.generation = this.patches.generation;
    this.tooNewMinGameId = null;
    this.keepMinGameId = null;
    this.probe = { active: true, first: true, inFlight: this.probe.inFlight };
    this.probed.clear();
  }

  /**
   * The next probe match (see `probe`), null while one is in flight (the other loops wait), or
   * undefined when not probing (claim in FIFO order).
   */
  private async nextProbe(exclude: ReadonlySet<string>): Promise<QueuedMatch | null | undefined> {
    if (!this.patches.ready) return undefined;
    this.syncGeneration();
    if (!this.probe.active) return undefined;
    if (this.probe.inFlight !== null) return null;
    const m = await pickProbeMatch(this.db, this.platform, {
      aboveGameId: this.oldPatchMaxGameId,
      belowGameId: this.keepMinGameId,
      exclude: [...exclude, ...this.deferredUntil.keys(), ...this.probed],
      pick: this.probe.first ? 'highest' : 'median',
    });
    if (m === null) {
      this.probe.active = false;
      this.log.info('old patch boundary found', {
        oldPatchMaxGameId: this.oldPatchMaxGameId,
        keepMinGameId: this.keepMinGameId,
        probes: this.probed.size,
      });
      return undefined;
    }
    this.probe.first = false;
    this.probe.inFlight = m.matchId;
    this.probed.add(m.matchId);
    return m;
  }

  /** A game id of this platform at or below the old-patch bound (unparseable ids are not). */
  private isKnownOldPatch(gameId: number | null): boolean {
    return gameId !== null && gameId <= this.oldPatchMaxGameId;
  }

  /** Counts an attempt; FAILED once `maxAttempts` is reached. */
  private async fail(matchId: string, error: string, maxAttempts: number): Promise<MatchOutcome> {
    const status = await markMatchFailed(this.db, matchId, error, maxAttempts);
    this.counters.matchesFailed++;
    this.noteError('match', `${matchId} ${error}`);
    this.log.warn('match fetch failed', { matchId, error, status });
    return 'failed';
  }

  /**
   * Transient error: the match goes to the back of the queue without counting an attempt (and is
   * not claimed again for `deferMs`), up to `maxTransientErrors` times.
   */
  private async retryLater(matchId: string, err: unknown): Promise<MatchOutcome> {
    const error = errorMessage(err);
    this.deferredUntil.set(matchId, this.clock.now() + this.opts.deferMs);
    this.counters.matchesRetried++;
    this.noteError('match', `${matchId} ${error}`);
    let status: 'PENDING' | 'FAILED' = 'PENDING';
    try {
      status = await deferMatchAfterError(this.db, matchId, error, this.opts.maxTransientErrors);
    } catch (dbErr) {
      // The database itself is down: the row stays PENDING as it is.
      if (classifyError(dbErr) !== 'transient') throw dbErr;
    }
    if (status === 'FAILED') {
      this.counters.matchesFailed++;
      this.log.warn('match fetch failed: too many transient errors', { matchId, error });
      return 'failed';
    }
    this.log.warn('match deferred after a transient error', { matchId, error });
    return 'retry';
  }

  // -------------------------------------------------------------------------
  // Level 4: daily refresh of tracked players
  // -------------------------------------------------------------------------

  async dailyRefresh(c: DailyRefreshCandidate, signal?: AbortSignal): Promise<void> {
    const now = () => new Date(this.clock.now());
    if (c.needsAccount) {
      const account = await this.riot.getAccount(
        this.platform,
        c.puuid,
        PRIORITY.DAILY_REFRESH,
        signal,
      );
      if (account) {
        await updatePlayerRiotId(
          this.db,
          c.puuid,
          account.gameName ?? null,
          account.tagLine ?? null,
          now(),
        );
      } else {
        // Unknown account: keep the name we have, try again tomorrow.
        this.dailyCooldown.set(c.puuid, this.clock.now() + DAY);
      }
    }
    if (c.needsMastery) {
      const masteries = await this.riot.getMasteries(
        this.platform,
        c.puuid,
        PRIORITY.DAILY_REFRESH,
        signal,
      );
      await replaceMasteries(this.db, c.puuid, toMasteries(masteries ?? []), now());
    }
    this.counters.dailyRefreshed++;
  }

  // -------------------------------------------------------------------------
  // Level 5: enrichment of non-ladder players
  // -------------------------------------------------------------------------

  async enrich(e: QueuedEnrichment, signal?: AbortSignal): Promise<void> {
    try {
      const masteries = await this.riot.getMasteries(
        this.platform,
        e.puuid,
        PRIORITY.ENRICHMENT,
        signal,
      );
      const entries = await this.riot.getLeagueEntries(
        this.platform,
        e.puuid,
        PRIORITY.ENRICHMENT,
        signal,
      );
      const now = new Date(this.clock.now());
      await replaceMasteries(this.db, e.puuid, toMasteries(masteries ?? []), now);
      await updatePlayerRank(this.db, e.puuid, toSoloRank(entries ?? []), now);
      await completeEnrichment(this.db, e.puuid);
      this.counters.enriched++;
    } catch (err) {
      if (isAbortError(err) || err instanceof RiotAuthError) throw err;
      await failEnrichment(this.db, e.puuid, errorMessage(err));
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------

  /** Runs every loop until `signal` aborts; resolves once in-flight work has finished. */
  async start(signal: AbortSignal): Promise<void> {
    await this.loadPendingListings();
    await this.openRun();
    const c = this.opts.concurrency;
    const loops: Promise<void>[] = [this.heartbeatLoop(signal), this.ladderLoop(signal)];
    for (let i = 0; i < c.listing; i++) {
      loops.push(
        this.workLoop(
          'listing',
          signal,
          async () => this.nextPlayedPlayer(),
          async (p) => {
            await this.listPlayerMatches(p, signal);
            return 'ok';
          },
          (p, ok) => this.listingDone(p, ok),
        ),
      );
    }
    for (let i = 0; i < c.match; i++) {
      loops.push(
        this.workLoop(
          'match',
          signal,
          () => this.matchSource.next(),
          async (m) => ((await this.processMatch(m, signal)) === 'retry' ? 'retry' : 'ok'),
          (m) => {
            this.matchSource.release(m);
            if (this.probe.inFlight === m.matchId) this.probe.inFlight = null;
          },
        ),
      );
    }
    for (let i = 0; i < c.daily; i++) {
      loops.push(
        this.workLoop(
          'daily',
          signal,
          () => this.dailySource.next(),
          async (d) => {
            try {
              await this.dailyRefresh(d, signal);
              return 'ok';
            } catch (err) {
              this.dailyCooldown.set(d.puuid, this.clock.now() + HOUR);
              throw err;
            }
          },
          (d) => this.dailySource.release(d),
        ),
      );
    }
    for (let i = 0; i < c.enrichment; i++) {
      loops.push(
        this.workLoop(
          'enrichment',
          signal,
          () => this.enrichmentSource.next(),
          async (e) => {
            await this.enrich(e, signal);
            return 'ok';
          },
          (e) => this.enrichmentSource.release(e),
        ),
      );
    }
    await Promise.all(loops);
    await this.closeRun();
    await this.statusWrites;
  }

  async progress(): Promise<PlatformProgress> {
    return {
      platform: this.platform,
      playedToList: new Set([...this.played, ...this.listingInFlight]).size,
      pendingMatches: await countPendingMatches(this.db, this.platform),
      enrichmentQueue: await countEnrichmentQueue(this.db, this.platform),
      ...this.counters,
    };
  }

  private async ladderLoop(signal: AbortSignal): Promise<void> {
    let first = true;
    while (!signal.aborted) {
      let wait = this.opts.ladderIntervalMs;
      try {
        await this.waitForAuth(signal);
        if (!first) await this.rotateRun();
        first = false;
        await this.refreshLadder(signal);
      } catch (err) {
        if (isAbortError(err)) break;
        this.recordError('ladder', err);
        wait = Math.min(wait, 5 * 60_000);
      }
      if (!(await this.sleep(wait, signal))) break;
    }
  }

  private async workLoop<T>(
    kind: string,
    signal: AbortSignal,
    next: () => Promise<T | null>,
    handle: (item: T) => Promise<'ok' | 'retry'>,
    release: (item: T, ok: boolean) => void,
  ): Promise<void> {
    /** Consecutive items of this loop that hit a transient error. */
    let transientStreak = 0;
    while (!signal.aborted) {
      let item: T | null = null;
      try {
        await this.waitForAuth(signal);
        item = await next();
      } catch (err) {
        if (isAbortError(err)) break;
        this.recordError(kind, err);
        if (!(await this.sleep(this.opts.idleMs, signal))) break;
        continue;
      }
      if (item === null) {
        if (!(await this.sleep(this.opts.idleMs, signal))) break;
        continue;
      }
      let ok = false;
      let transient = false;
      try {
        transient = (await handle(item)) === 'retry';
        ok = true;
      } catch (err) {
        if (!isAbortError(err)) {
          this.recordError(kind, err);
          transient = classifyError(err) === 'transient';
        }
      } finally {
        release(item, ok);
      }
      if (transient) {
        transientStreak++;
        const backoff = Math.min(
          this.opts.transientBackoffMs * 2 ** Math.min(transientStreak - 1, 20),
          this.opts.maxTransientBackoffMs,
        );
        if (!(await this.sleep(backoff, signal))) break;
      } else if (ok) {
        transientStreak = 0;
      }
    }
  }

  private recordError(kind: string, err: unknown): void {
    this.lastError = `${kind}: ${errorMessage(err)}`;
    this.noteError(kind, errorMessage(err));
    if (err instanceof RiotAuthError) {
      if (this.authState !== 'rejected') {
        this.authState = 'rejected';
        const since = new Date(this.clock.now());
        this.writeStatus(() => markWorkerAuthRejected(this.db, this.platform, since));
      }
      if (this.clock.now() >= this.authPausedUntil) {
        this.log.error('Riot rejected the API key, pausing', {
          kind,
          error: err.message,
          pauseMs: this.opts.authErrorPauseMs,
        });
      }
      this.authPausedUntil = this.clock.now() + this.opts.authErrorPauseMs;
      return;
    }
    this.log.error(`${kind} failed`, { error: errorMessage(err) });
  }

  // -------------------------------------------------------------------------
  // worker_status
  // -------------------------------------------------------------------------

  /** Last error of this platform, for `worker_status` ('kind: message'). */
  private noteError(kind: string, message: string): void {
    const at = new Date(this.clock.now());
    this.writeStatus(() => recordWorkerError(this.db, this.platform, `${kind}: ${message}`, at));
  }

  /** Any Riot response other than 401/403: the key works (clears a rejection, once). */
  private riotAccepted(): void {
    if (this.authState === 'ok') return;
    this.authState = 'ok';
    this.writeStatus(() => clearWorkerAuthRejected(this.db, this.platform));
  }

  /** Status writes run one after the other (in order) and never fail the caller. */
  private writeStatus(write: () => Promise<void>): void {
    this.statusWrites = this.statusWrites
      .then(write)
      .catch((err) => this.log.warn('worker status update failed', { error: errorMessage(err) }));
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = new Date(this.clock.now());
      this.writeStatus(() => touchWorkerStatus(this.db, this.platform, now));
      if (!(await this.sleep(this.opts.heartbeatMs, signal))) break;
    }
  }

  /** The Riot client, reporting each successful response to `riotAccepted`. */
  private observeRiot(riot: RiotApi): RiotApi {
    const ok = <T>(p: Promise<T>): Promise<T> =>
      p.then((v) => {
        this.riotAccepted();
        return v;
      });
    return {
      getLeague: (...a) => ok(riot.getLeague(...a)),
      getMatchIds: (...a) => ok(riot.getMatchIds(...a)),
      getMatch: (...a) => ok(riot.getMatch(...a)),
      getTimeline: (...a) => ok(riot.getTimeline(...a)),
      getAccount: (...a) => ok(riot.getAccount(...a)),
      getMasteries: (...a) => ok(riot.getMasteries(...a)),
      getLeagueEntries: (...a) => ok(riot.getLeagueEntries(...a)),
    };
  }

  private async waitForAuth(signal: AbortSignal): Promise<void> {
    const wait = this.authPausedUntil - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait, signal);
  }

  /** false when aborted. */
  private async sleep(ms: number, signal: AbortSignal): Promise<boolean> {
    try {
      await this.clock.sleep(ms, signal);
      return true;
    } catch (err) {
      if (isAbortError(err)) return false;
      throw err;
    }
  }

  private async openRun(): Promise<void> {
    const id = await startWorkerRun(this.db, this.platform);
    this.run = { id, requestsAtStart: this.requestCount(), matches: 0, players: 0 };
    this.lastError = null;
  }

  private async closeRun(): Promise<void> {
    if (!this.run) return;
    const run = this.run;
    this.run = null;
    await finishWorkerRun(this.db, run.id, {
      requestsMade: this.requestCount() - run.requestsAtStart,
      playersPolled: run.players,
      matchesAdded: run.matches,
      error: this.lastError,
    });
  }

  /** A `worker_runs` row covers one ladder cycle. */
  private async rotateRun(): Promise<void> {
    await this.closeRun();
    await this.openRun();
  }
}
