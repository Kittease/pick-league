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
  completeEnrichment,
  countEnrichmentQueue,
  countPendingMatches,
  type DailyRefreshCandidate,
  type Db,
  deferMatch,
  enqueueMatchIds,
  failEnrichment,
  finishWorkerRun,
  getMatchesSyncedUntil,
  insertParsedMatch,
  type LadderEntryInput,
  type MasteryInput,
  markMatchFailed,
  markMatchSkipped,
  playersNeedingDailyRefresh,
  type QueuedEnrichment,
  type QueuedMatch,
  replaceMasteries,
  type SoloRankInput,
  setMatchesSyncedUntil,
  startWorkerRun,
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
import { WorkSource } from './work-source.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
  /** Sleep when a kind of work has nothing to do (default 10 s). */
  idleMs: number;
  /** Matches deferred because of a too-new patch are retried after this (default 15 min). */
  deferMs: number;
  /** Pause after an auth error (expired key) (default 5 min). */
  authErrorPauseMs: number;
  concurrency: { listing: number; match: number; daily: number; enrichment: number };
  /** Master players tracked besides Challenger + Grandmaster: the top N by LP (default 1000). */
  masterPlayers: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  ladderIntervalMs: HOUR,
  firstListingMaxMs: 14 * DAY,
  listingOverlapMs: HOUR,
  idleMs: 10_000,
  deferMs: 15 * 60_000,
  authErrorPauseMs: 5 * 60_000,
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

export type MatchOutcome = 'added' | 'exists' | 'skipped' | 'deferred' | 'failed';

export interface PlatformProgress {
  platform: Platform;
  playedToList: number;
  pendingMatches: number;
  enrichmentQueue: number;
  matchesAdded: number;
  playersPolled: number;
  matchesSkipped: number;
  matchesFailed: number;
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

  /** Players to list (insertion order = FIFO). */
  private readonly played = new Set<string>();
  private readonly listingInFlight = new Set<string>();
  /**
   * Highest game id seen with a patch older than the latest: older ids are skipped unfetched, and
   * listings stop there (the first previous-patch match bounds every history).
   */
  private oldPatchMaxGameId = 0;
  /** Start time of that match: first listings never go back further. */
  private oldPatchCutoffMs = 0;
  /** Lowest game id seen with a patch newer than Data Dragon: newer ids wait for the patch. */
  private tooNewMinGameId: number | null = null;
  private tooNewGeneration = -1;
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
    enriched: 0,
    dailyRefreshed: 0,
  };
  private run: { id: number; requestsAtStart: number; matches: number; players: number } | null =
    null;
  private lastError: string | null = null;
  private authPausedUntil = 0;

  constructor(deps: PlatformWorkerDeps) {
    this.platform = deps.platform;
    this.db = deps.db;
    this.riot = deps.riot;
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
    // Players whose first listing never completed (e.g. restart in between).
    for (const p of await trackedPlayersNeverListed(this.db, this.platform)) {
      if (!this.listingInFlight.has(p)) this.played.add(p);
    }
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
    await setMatchesSyncedUntil(this.db, puuid, new Date(now - this.opts.listingOverlapMs));
    this.counters.playersPolled++;
    if (this.run) this.run.players++;
    this.log.debug('match ids listed', { puuid, added, firstTime: since === null });
    return added;
  }

  // -------------------------------------------------------------------------
  // Level 3: match + timeline
  // -------------------------------------------------------------------------

  async processMatch(queued: QueuedMatch, signal?: AbortSignal): Promise<MatchOutcome> {
    const { matchId } = queued;
    const gameId = gameIdOf(matchId);
    if (this.tooNewGeneration !== this.patches.generation) {
      this.tooNewMinGameId = null;
      this.tooNewGeneration = this.patches.generation;
    }
    if (this.isKnownOldPatch(gameId)) {
      await markMatchSkipped(this.db, matchId);
      this.counters.matchesSkipped++;
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
    if (match === null) return this.fail(matchId, 'match not found (404)');
    let patch: string;
    try {
      patch = patchFromGameVersion(match.info?.gameVersion ?? '');
    } catch (err) {
      return this.fail(matchId, errorMessage(err));
    }

    const verdict = this.patches.classify(patch);
    if (verdict === 'old') {
      await markMatchSkipped(this.db, matchId);
      this.counters.matchesSkipped++;
      if (gameId !== null && gameId > this.oldPatchMaxGameId) {
        this.oldPatchMaxGameId = gameId;
        this.oldPatchCutoffMs = Math.max(this.oldPatchCutoffMs, match.info.gameStartTimestamp ?? 0);
        this.log.debug('old patch boundary moved', { matchId, patch });
      }
      return 'skipped';
    }
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
    if (timeline === null) return this.fail(matchId, 'timeline not found (404)');
    let parsed: ReturnType<typeof parseMatch>;
    try {
      parsed = parseMatch(match, timeline);
    } catch (err) {
      if (err instanceof MatchParseError) return this.fail(matchId, `parse: ${err.message}`);
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

  /** A game id of this platform at or below the old-patch bound (unparseable ids are not). */
  private isKnownOldPatch(gameId: number | null): boolean {
    return gameId !== null && gameId <= this.oldPatchMaxGameId;
  }

  private async fail(matchId: string, error: string): Promise<MatchOutcome> {
    const status = await markMatchFailed(this.db, matchId, error);
    this.counters.matchesFailed++;
    this.log.warn('match fetch failed', { matchId, error, status });
    return 'failed';
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
    for (const p of await trackedPlayersNeverListed(this.db, this.platform)) this.played.add(p);
    await this.openRun();
    const c = this.opts.concurrency;
    const loops: Promise<void>[] = [this.ladderLoop(signal)];
    for (let i = 0; i < c.listing; i++) {
      loops.push(
        this.workLoop(
          'listing',
          signal,
          async () => this.nextPlayedPlayer(),
          (p) => this.listPlayerMatches(p, signal),
          (p, ok) => {
            this.listingInFlight.delete(p);
            if (!ok) this.played.add(p);
          },
        ),
      );
    }
    for (let i = 0; i < c.match; i++) {
      loops.push(
        this.workLoop(
          'match',
          signal,
          () => this.matchSource.next(),
          async (m) => {
            try {
              await this.processMatch(m, signal);
            } catch (err) {
              if (!isAbortError(err) && !(err instanceof RiotAuthError)) {
                await this.fail(m.matchId, errorMessage(err));
                return;
              }
              throw err;
            }
          },
          (m) => this.matchSource.release(m),
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
          (e) => this.enrich(e, signal),
          (e) => this.enrichmentSource.release(e),
        ),
      );
    }
    await Promise.all(loops);
    await this.closeRun();
  }

  async progress(): Promise<PlatformProgress> {
    return {
      platform: this.platform,
      playedToList: this.played.size + this.listingInFlight.size,
      pendingMatches: await countPendingMatches(this.db, this.platform),
      enrichmentQueue: await countEnrichmentQueue(this.db, this.platform),
      ...this.counters,
    };
  }

  private nextPlayedPlayer(): string | null {
    for (const p of this.played) {
      this.played.delete(p);
      if (this.listingInFlight.has(p)) continue;
      this.listingInFlight.add(p);
      return p;
    }
    return null;
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
    handle: (item: T) => Promise<unknown>,
    release: (item: T, ok: boolean) => void,
  ): Promise<void> {
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
      try {
        await handle(item);
        ok = true;
      } catch (err) {
        if (!isAbortError(err)) this.recordError(kind, err);
      } finally {
        release(item, ok);
      }
    }
  }

  private recordError(kind: string, err: unknown): void {
    this.lastError = `${kind}: ${errorMessage(err)}`;
    if (err instanceof RiotAuthError) {
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
