/**
 * One platform's crawler. Five kinds of work run concurrently and all wait on the same per-host
 * rate limiters, which serve the highest priority first (docs/architecture.md, "Worker"):
 *
 * 1. ladder refresh (hourly, and when Master grows) → platform host, priority 5
 *    (with Diamond tracking: then the Diamond sweep → platform host, priority 4)
 * 2. match-id listing of "played" players → match cluster, priority 4
 * 3. match + timeline fetch             → match cluster, priority 3
 * 4. daily account + mastery refresh    → account cluster + platform host, priority 2
 * 5. enrichment (mastery + rank)        → platform host, priority 1
 * 6. listing of untracked players       → match cluster, priority 0
 *
 * So a level only gets a host's budget when nothing of a higher level is waiting for it.
 *
 * Players are tracked from the top of the ladder down: Challenger and Grandmaster, then Master by
 * LP, `masterStep` more each time the queues are nearly empty. Listings and match fetches follow
 * the ladder order too, so the best players' matches always come first. Riot's Master list stops
 * at 10,000 players: once all of them are tracked and the queues are nearly empty, the highest
 * ranked players seen in stored matches but not on the tracked ladder are listed too (level 6).
 *
 * Listing skip rule (`listingSkip` 'shadow' | 'on'): a tracked player whose new games are all
 * stored already (found through other players) needs no listing. For that the matches a listing
 * queues must be stored before the next players are decided, so a tracked player is only picked
 * for a listing once no match queued by a better-placed player is still to be fetched.
 *
 * Diamond tracking (`diamondMaxTracked` > 0): after each hourly ladder refresh the four Diamond
 * divisions are read page by page, and up to that many Diamond players are tracked after the apex
 * players: first those seen in a Master+ game lately, then Diamond I by LP when budget remains.
 */
import {
  claimEnrichment,
  claimPendingMatches,
  clearListingRequest,
  clearWorkerAuthRejected,
  completeEnrichment,
  countEnrichmentQueue,
  countPendingMatches,
  countStoredGamesEndedBetween,
  type DailyRefreshCandidate,
  type Db,
  deferMatch,
  deferMatchAfterError,
  enqueueNewMatchIds,
  extraListingCandidates,
  failEnrichment,
  finishListing,
  finishWorkerRun,
  getListingSkipState,
  getMatchesSyncedUntil,
  hasPendingMatchBefore,
  insertParsedMatch,
  inTransaction,
  type LadderEntryInput,
  type ListingSkipState,
  ladderOrder,
  type MasteryInput,
  markMatchFailed,
  markMatchSkipped,
  markWorkerAuthRejected,
  pickProbeMatch,
  platformHasMatchOnPatch,
  playersNeedingDailyRefresh,
  playersSeenWithMasterSince,
  playersWithListingRequested,
  type QueuedEnrichment,
  type QueuedMatch,
  recordListingSkipMiss,
  recordWorkerError,
  replaceMasteries,
  setListingBaseline,
  skipPendingMatchesUpTo,
  startWorkerRun,
  touchWorkerStatus,
  trackedDiamondEntries,
  trackedPlayersNeverListed,
  updatePlayerRank,
  upsertDiamondLadder,
  upsertLadder,
} from '@pick-league/db';
import {
  type ApexLadderTier,
  type ChampionMasteryDto,
  DIVISIONS,
  type Division,
  type LeagueEntryDto,
  type LeagueListDto,
  type Platform,
  patchFromGameVersion,
  platformFromMatchId,
  RANKED_SOLO_QUEUE,
  type SoloTier,
} from '@pick-league/shared';
import { abortError, type Clock, isAbortError, systemClock } from '../clock.ts';
import { errorMessage, type Logger, silentLogger } from '../log.ts';
import { MatchParseError, parseMatch } from '../parser/parse-match.ts';
import type { PatchVerdict } from '../patches.ts';
import { PRIORITY, type RiotApi, RiotAuthError } from '../riot/client.ts';
import { toSoloRank } from '../riot/ranks.ts';
import { classifyError, DeterministicError } from './errors.ts';
import { WorkSource } from './work-source.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_LISTING_RETRY_MS = 6 * HOUR;
/** A Diamond division that has not ended after this many pages fails the sweep (KR has ~250). */
const MAX_DIAMOND_PAGES = 5_000;

/**
 * Listing skip rule. 'off': every tracked player who played is listed. 'on': a player whose new
 * games are all stored already is not listed. 'shadow': the rule is evaluated the same way but
 * every listing still runs, and what a skipped listing would have missed is recorded.
 */
export const LISTING_SKIP_MODES = ['off', 'shadow', 'on'] as const;
export type ListingSkipMode = (typeof LISTING_SKIP_MODES)[number];

export interface SchedulerOptions {
  /** Ladder refresh period (default 1 h). */
  ladderIntervalMs: number;
  /**
   * Master players added to the tracked set (top of the Master tier by LP first) each time the
   * queues are nearly empty (default 500). Challenger and Grandmaster are always tracked.
   */
  masterStep: number;
  /** "Nearly empty": no listing waiting and at most this many PENDING matches (default 50). */
  expandBelowPendingMatches: number;
  /** How often the ladder loop checks whether it can track more Master players (default 1 min). */
  expansionCheckMs: number;
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
  concurrency: {
    listing: number;
    match: number;
    daily: number;
    enrichment: number;
    extraListing: number;
  };
  /**
   * Untracked players (seen in stored matches, ranked by enrichment) are listed once every
   * Master player of Riot's list is tracked and the queues are nearly empty: those of at least
   * this tier (default MASTER), highest ranked first, each at most once per
   * `extraListingIntervalMs` (default 6 h).
   */
  extraMinTier: SoloTier;
  extraListingIntervalMs: number;
  /**
   * Keep collecting the previous patch after the latest one is live (default false). For a
   * backfill of the previous patch by hand; while it is on, first listings go back up to
   * `firstListingMaxMs`.
   */
  collectPreviousPatch: boolean;
  /** Listing skip rule (default 'off': exactly the behaviour without it). */
  listingSkip: ListingSkipMode;
  /** A player whose last real listing is older than this is listed whatever is stored (default 24 h). */
  listingSkipSafetyMs: number;
  /**
   * Riot's ladder counts a finished game late: measured on 2026-11-22, 11 % of the games that
   * ended in the 2 minutes before a ladder refresh were in its wins + losses, 78 % of those that
   * ended 8 to 10 minutes before, all of them from 10 minutes. A stored game that ended less than
   * this before the ladder refresh may not be one of the new games, so it does not count for the
   * skip rule (default 15 min).
   */
  listingSkipLadderLagMs: number;
  /**
   * 'shadow' and 'on': a tracked player waits for the matches queued by better-placed players to
   * be fetched before being picked, at most this long (default 5 min), checking again after each
   * match and at least every `listingGatePollMs` (default 1 s).
   */
  listingGateMaxWaitMs: number;
  listingGatePollMs: number;
  /**
   * Diamond players tracked at most, after the apex players (default 0: none, and no Diamond
   * request is made). First those seen in a Master+ game during `diamondWithMasterWindowMs`
   * (default 7 days), by division then LP; then Diamond I players by LP, `diamondStep` more
   * (default 500) each time the platform has caught up, every Master player of Riot's list is
   * tracked and no untracked player is due for a listing.
   */
  diamondMaxTracked: number;
  diamondStep: number;
  diamondWithMasterWindowMs: number;
  /**
   * A tracked Diamond player missing from complete sweeps is kept as is, and dropped once the
   * last sweep that saw them is older than this (default 24 h).
   */
  diamondKeepMs: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  ladderIntervalMs: HOUR,
  masterStep: 500,
  expandBelowPendingMatches: 50,
  expansionCheckMs: 60_000,
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
  concurrency: { listing: 2, match: 3, daily: 1, enrichment: 2, extraListing: 1 },
  extraMinTier: 'MASTER',
  extraListingIntervalMs: 6 * HOUR,
  collectPreviousPatch: false,
  listingSkip: 'off',
  listingSkipSafetyMs: DAY,
  listingSkipLadderLagMs: 15 * 60_000,
  listingGateMaxWaitMs: 5 * 60_000,
  listingGatePollMs: 1_000,
  diamondMaxTracked: 0,
  diamondStep: 500,
  diamondWithMasterWindowMs: 7 * DAY,
  diamondKeepMs: DAY,
};

/**
 * What the worker needs to know about patches (the latest is collected, the previous one until the
 * latest is live on the platform).
 */
export interface PatchView {
  readonly ready: boolean;
  readonly generation: number;
  readonly latest: string | null;
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
  options?: Partial<Omit<SchedulerOptions, 'concurrency'>> & {
    concurrency?: Partial<SchedulerOptions['concurrency']>;
  };
}

/** 'retry': transient error, the match was deferred without counting an attempt. */
export type MatchOutcome = 'added' | 'exists' | 'skipped' | 'deferred' | 'retry' | 'failed';

/** Deterministic errors (404, parse, other 4xx) fail a match on its second attempt. */
const DETERMINISTIC_MAX_ATTEMPTS = 2;
/** Unclassified errors fail a match on its fifth attempt. */
const UNKNOWN_MAX_ATTEMPTS = 5;

export interface PlatformProgress {
  platform: Platform;
  /** Master players tracked, and in the whole Master tier (0 until the first ladder refresh). */
  masterTracked: number;
  masterTotal: number;
  playedToList: number;
  pendingMatches: number;
  enrichmentQueue: number;
  /** Whether this platform has stored a match of the latest patch. */
  latestPatchLive: boolean;
  matchesAdded: number;
  playersPolled: number;
  matchesSkipped: number;
  matchesFailed: number;
  matchesRetried: number;
  enriched: number;
  dailyRefreshed: number;
  /** Listings of untracked players (also counted in `playersPolled`). */
  extraPlayersPolled: number;
  /**
   * Listing skip rule: listings not made because the player's new games were all stored
   * ('shadow': listings that would not have been made; they ran and are in `playersPolled`).
   */
  listingsSkipped: number;
  /** 'shadow': would-be-skipped listings that queued new match ids (`listing_skip_misses` rows). */
  listingSkipMisses: number;
  /** Diamond tracking; null when it is off (`diamondMaxTracked` = 0). */
  diamond: DiamondProgress | null;
}

export interface DiamondProgress {
  /** Players of the last complete sweep per division (I, II, III, IV); null before the first one. */
  seen: [number, number, number, number] | null;
  /** Diamond players tracked. */
  tracked: number;
  /** Of them, as of the last complete sweep: seen in a Master+ game lately / Diamond I by LP. */
  trackedWithMaster: number | null;
  trackedDiamondOne: number | null;
  /** `diamondMaxTracked`. */
  cap: number;
}

/** Numeric part of 'EUW1_7234567890' (game ids grow with time on a platform). */
export function gameIdOf(matchId: string): number | null {
  const n = Number(matchId.split('_')[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** A Diamond player as a sweep saw them (or, for one it missed, as stored). */
export interface DiamondEntry {
  puuid: string;
  /** 1..4 */
  division: number;
  leaguePoints: number;
  wins: number;
  losses: number;
  /** When their page was fetched. */
  seenAt: number;
}

type DiamondRank = Pick<DiamondEntry, 'puuid' | 'division' | 'leaguePoints'>;

/** Valid solo queue Diamond entries of a sweep page, as division `division` (1..4). */
export function toDiamondEntries(
  page: readonly LeagueEntryDto[],
  division: number,
  seenAt: number,
): DiamondEntry[] {
  return page
    .filter(
      (e) =>
        typeof e.puuid === 'string' &&
        e.puuid !== '' &&
        (e.tier === undefined || e.tier === 'DIAMOND') &&
        (e.queueType === undefined || e.queueType === RANKED_SOLO_QUEUE),
    )
    .map((e) => ({
      puuid: e.puuid,
      division,
      leaguePoints: e.leaguePoints ?? 0,
      wins: e.wins ?? 0,
      losses: e.losses ?? 0,
      seenAt,
    }));
}

/** Diamond players from the top down: division I first, then LP (most first). */
export function byDivisionThenLp(a: DiamondRank, b: DiamondRank): number {
  return (
    a.division - b.division ||
    b.leaguePoints - a.leaguePoints ||
    (a.puuid < b.puuid ? -1 : a.puuid > b.puuid ? 1 : 0)
  );
}

function toDiamondLadderEntry(e: DiamondEntry): LadderEntryInput {
  return {
    puuid: e.puuid,
    tier: 'DIAMOND',
    division: e.division,
    leaguePoints: e.leaguePoints,
    wins: e.wins,
    losses: e.losses,
    seenAt: new Date(e.seenAt),
  };
}

export interface DiamondSelection {
  /** Seen in a Master+ game lately, top down, at most `cap`. */
  withMaster: DiamondEntry[];
  /** Diamond I players by LP, at most `extra` and the room left under `cap`. */
  diamondOne: DiamondEntry[];
  /** The next Diamond I players by LP, not tracked. */
  reserve: DiamondEntry[];
}

/**
 * Which Diamond players to track: those of `seenWithMaster` first (division, then LP), then
 * Diamond I players by LP, at most `extra` of them; `cap` players in all.
 */
export function selectDiamondPlayers(
  candidates: readonly DiamondEntry[],
  seenWithMaster: ReadonlySet<string>,
  cap: number,
  extra: number,
): DiamondSelection {
  const first: DiamondEntry[] = [];
  const others: DiamondEntry[] = [];
  for (const c of candidates) {
    if (seenWithMaster.has(c.puuid)) first.push(c);
    else if (c.division === 1) others.push(c);
  }
  first.sort(byDivisionThenLp);
  others.sort(byDivisionThenLp);
  const withMaster = first.slice(0, Math.max(0, cap));
  const room = Math.max(0, Math.min(extra, cap - withMaster.length));
  return { withMaster, diamondOne: others.slice(0, room), reserve: others.slice(room) };
}

export function toLadderEntries(list: LeagueListDto, tier: ApexLadderTier): LadderEntryInput[] {
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

/** Entries by LP, most first (Riot lists a league in no particular order). */
export function byLp(entries: readonly LadderEntryInput[]): LadderEntryInput[] {
  return [...entries].sort(
    (a, b) =>
      b.leaguePoints - a.leaguePoints || (a.puuid < b.puuid ? -1 : a.puuid > b.puuid ? 1 : 0),
  );
}

/** Ladder position of a player not on the tracked ladder (listed after every tracked player). */
const UNRANKED = Number.MAX_SAFE_INTEGER;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function toMasteries(list: readonly ChampionMasteryDto[]): MasteryInput[] {
  return list.map((m) => ({
    championId: m.championId,
    level: m.championLevel ?? 0,
    points: m.championPoints ?? 0,
    lastPlayedAt: new Date(m.lastPlayTime ?? 0),
  }));
}

export { toSoloRank };

export class PlatformWorker {
  readonly platform: Platform;
  private readonly db: Db;
  private readonly riot: RiotApi;
  private readonly patches: PatchView;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly opts: SchedulerOptions;
  private readonly requestCount: () => number;

  /** Players to list (best ladder position first). Durable copy: `players.listing_requested_at`. */
  private readonly played = new Set<string>();
  /**
   * Ladder position of each tracked player (0 = first Challenger), from the last refresh: the
   * apex players (`apexOrder`), then the tracked Diamond players (`diamond.tracked`).
   */
  private ladderRank = new Map<string, number>();
  private apexOrder: string[] = [];
  /** Every player of Riot's three apex lists at the last refresh (tracked or not). */
  private apexPuuids = new Set<string>();
  /** Diamond tracking (`diamondMaxTracked` > 0). */
  private readonly diamond = {
    /** Tracked Diamond players, top down (division, then LP). */
    tracked: [] as DiamondRank[],
    /** Players per division of the last complete sweep. */
    seen: null as [number, number, number, number] | null,
    /** Tracked players of each group at the last complete sweep. */
    withMaster: null as number | null,
    diamondOne: null as number | null,
    /**
     * Diamond I players that may be tracked beyond those seen in a Master+ game: grows by
     * `diamondStep` when budget remains (null until the first complete sweep, which reads it
     * back from the stored rows).
     */
    extra: null as number | null,
    /** The next Diamond I players by LP, from the last complete sweep. */
    reserve: [] as DiamondEntry[],
  };
  /** Master players tracked: grows by `masterStep` when the queues are nearly empty. */
  private masterTracked = 0;
  /** Players in the whole Master tier at the last ladder refresh (0 = not refreshed yet). */
  private masterTotal = 0;
  /** Whether the stored ladder was read (it gives `masterTracked` after a restart). */
  private ladderLoaded = false;
  private readonly listingInFlight = new Set<string>();
  /** Failed listings: consecutive failures, and when the player may be listed again. */
  private readonly listingFailures = new Map<string, number>();
  private readonly listingCooldown = new Map<string, number>();
  /** Players whose listing started while `loadPendingListings` was querying (null otherwise). */
  private listingsStartedDuringLoad: Set<string> | null = null;
  /**
   * Highest game id seen with a patch that is no longer collected: older ids are skipped unfetched, and
   * listings stop there (the first previous-patch match bounds every history).
   */
  private oldPatchMaxGameId = 0;
  /** Start time of that match: first listings never go back further. */
  private oldPatchCutoffMs = 0;
  /** Lowest game id seen with a patch newer than Data Dragon: newer ids wait for the patch. */
  private tooNewMinGameId: number | null = null;
  /** Lowest game id seen with a patch that is still collected: newer ids are not from an old patch. */
  private keepMinGameId: number | null = null;
  /** Patch generation the bounds above belong to. */
  private generation = -1;
  /**
   * Whether this platform has stored a match of the latest patch (read from `matches` at each
   * patch generation, then set by the first one stored). Until then the patch is not live here
   * (Data Dragon publishes a patch about a day before the servers play it) and the previous
   * patch is still collected.
   */
  private latestLive = false;
  /** The read of `latestLive` for the current generation. */
  private liveness: Promise<void> = Promise.resolve();
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
  private readonly extraSource: WorkSource<string>;
  /** Untracked players whose listing failed: not listed again before this time. */
  private readonly extraCooldown = new Map<string, number>();

  private readonly counters = {
    matchesAdded: 0,
    playersPolled: 0,
    matchesSkipped: 0,
    matchesFailed: 0,
    matchesRetried: 0,
    enriched: 0,
    dailyRefreshed: 0,
    extraPlayersPolled: 0,
    listingsSkipped: 0,
    listingSkipMisses: 0,
  };
  /** Resolved (and replaced) each time a match loop finishes a match: wakes waiting listings. */
  private matchSettled = deferred();
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
    this.extraSource = new WorkSource(
      async (exclude) => {
        const now = this.clock.now();
        for (const [p, until] of this.extraCooldown) if (until <= now) this.extraCooldown.delete(p);
        const rows = await extraListingCandidates(this.db, this.platform, {
          minTier: this.opts.extraMinTier,
          syncedBefore: new Date(now - this.opts.extraListingIntervalMs),
          limit: 20 + exclude.size + this.extraCooldown.size,
        });
        return rows.filter((p) => !exclude.has(p) && !this.extraCooldown.has(p));
      },
      (p) => p,
    );
  }

  // -------------------------------------------------------------------------
  // Level 1: ladder
  // -------------------------------------------------------------------------

  /**
   * Fetches Challenger, Grandmaster and Master, upserts Challenger, Grandmaster and the top
   * `masterPlayers` of Master by LP (default: as many as tracked so far), marks who played.
   * Returns how many played.
   */
  async refreshLadder(signal?: AbortSignal, masterPlayers?: number): Promise<number> {
    if (!this.ladderLoaded) await this.loadLadderOrder();
    const [challenger, grandmaster, master] = await Promise.all([
      this.riot.getLeague(this.platform, 'CHALLENGER', signal),
      this.riot.getLeague(this.platform, 'GRANDMASTER', signal),
      this.riot.getLeague(this.platform, 'MASTER', signal),
    ]);
    const masters = byLp(toLadderEntries(master, 'MASTER'));
    this.masterTotal = masters.length;
    const tracked = masters.slice(0, Math.max(0, masterPlayers ?? this.masterTracked));
    const entries = [
      ...byLp(toLadderEntries(challenger, 'CHALLENGER')),
      ...byLp(toLadderEntries(grandmaster, 'GRANDMASTER')),
      ...tracked,
    ];
    if (entries.length === 0) {
      this.log.warn('empty ladder from Riot, not stored');
      return 0;
    }
    // With Diamond tracking the Diamond rows belong to the sweep; without it they are removed.
    const keepDiamond = this.opts.diamondMaxTracked > 0;
    const result = await upsertLadder(this.db, this.platform, entries, new Date(this.clock.now()), {
      keepDiamond,
    });
    this.apexOrder = entries.map((e) => e.puuid);
    if (keepDiamond) this.apexPuuids = new Set([...entries, ...masters].map((e) => e.puuid));
    else this.diamond.tracked = [];
    this.applyLadderOrder();
    this.masterTracked = tracked.length;
    for (const p of result.played) this.played.add(p);
    await this.loadPendingListings();
    this.log.info('ladder refreshed', {
      entries: entries.length,
      masterTracked: this.masterTracked,
      masterTotal: this.masterTotal,
      played: result.played.length,
      added: result.added.length,
      removed: result.removed,
      toList: this.played.size,
    });
    return result.played.length;
  }

  /**
   * Ladder positions, top down: every apex player, then the tracked Diamond players (a player in
   * both keeps the apex position).
   */
  private applyLadderOrder(): void {
    const rank = new Map<string, number>();
    for (const p of this.apexOrder) if (!rank.has(p)) rank.set(p, rank.size);
    for (const d of this.diamond.tracked) if (!rank.has(d.puuid)) rank.set(d.puuid, rank.size);
    this.ladderRank = rank;
  }

  private rankOf(puuid: string): number {
    return this.ladderRank.get(puuid) ?? UNRANKED;
  }

  /** The tracked ladder as stored, before this process refreshes it (at startup). */
  private async loadLadderOrder(): Promise<void> {
    const rows = await ladderOrder(this.db, this.platform);
    this.apexOrder = rows.filter((r) => r.tier !== 'DIAMOND').map((r) => r.puuid);
    this.diamond.tracked = rows
      .filter((r) => r.tier === 'DIAMOND')
      .map((r) => ({ puuid: r.puuid, division: r.division ?? 4, leaguePoints: r.leaguePoints }));
    this.applyLadderOrder();
    this.masterTracked = rows.filter((r) => r.tier === 'MASTER').length;
    this.ladderLoaded = true;
  }

  /**
   * Whether to track `masterStep` more Master players now: some are not tracked yet, no listing is
   * waiting (players cooling down after a failed listing don't count) and at most
   * `expandBelowPendingMatches` matches are PENDING.
   */
  async canTrackMoreMasters(): Promise<boolean> {
    if (this.masterTotal <= this.masterTracked) return false;
    return this.caughtUp();
  }

  /**
   * Whether to list untracked players now: every Master player of Riot's list is tracked (it
   * stops at 10,000) and the queues are nearly empty, as for `canTrackMoreMasters`.
   */
  async canListExtraPlayers(): Promise<boolean> {
    if (this.masterTotal === 0 || this.masterTracked < this.masterTotal) return false;
    return this.caughtUp();
  }

  /**
   * No listing of a tracked player is waiting (players cooling down after a failed listing don't
   * count) and at most `expandBelowPendingMatches` matches are PENDING.
   */
  private async caughtUp(): Promise<boolean> {
    if (!this.patches.ready || this.listingInFlight.size > 0) return false;
    const now = this.clock.now();
    for (const p of this.played) {
      const until = this.listingCooldown.get(p);
      if (until === undefined || until <= now) return false;
    }
    const pending = await countPendingMatches(this.db, this.platform);
    return pending <= this.opts.expandBelowPendingMatches;
  }

  /** Tracks the next `masterStep` Master players (by LP): refreshes the ladder with them. */
  async trackMoreMasters(signal?: AbortSignal): Promise<void> {
    const from = this.masterTracked;
    await this.refreshLadder(signal, from + this.opts.masterStep);
    this.log.info('tracking more Master players', {
      from,
      to: this.masterTracked,
      masterTotal: this.masterTotal,
    });
  }

  // -------------------------------------------------------------------------
  // Level 1, continued: Diamond players (`diamondMaxTracked` > 0)
  // -------------------------------------------------------------------------

  /**
   * Reads the four Diamond divisions page by page and tracks at most `diamondMaxTracked` Diamond
   * players: first those seen in a Master+ game during `diamondWithMasterWindowMs` (division,
   * then LP), then as many Diamond I players by LP as the budget allowed so far (`diamond.extra`,
   * see `trackMoreDiamonds`). Marks who played; returns how many (null: tracking is off, or Riot
   * answered with no player at all and nothing was changed).
   *
   * A page that fails throws and nothing is changed: nobody is removed nor taken as "did not
   * play". A tracked player the sweep did not see (moved between pages meanwhile, promoted,
   * decayed) is kept as is, until the last sweep that saw them is `diamondKeepMs` old; one who is
   * on Riot's apex lists now is left to the apex ladder.
   */
  async refreshDiamonds(signal?: AbortSignal): Promise<number | null> {
    const cap = this.opts.diamondMaxTracked;
    if (cap <= 0) return null;
    if (!this.ladderLoaded) await this.loadLadderOrder();
    // Read before the sweep (nothing else writes the Diamond rows meanwhile; a player marked
    // during the sweep is taken by the next one).
    const [stored, withMaster] = await Promise.all([
      trackedDiamondEntries(this.db, this.platform),
      playersSeenWithMasterSince(
        this.db,
        this.platform,
        new Date(this.clock.now() - this.opts.diamondWithMasterWindowMs),
      ),
    ]);
    const seenWithMaster = new Set(withMaster);
    const storedPuuids = new Set(stored.map((r) => r.puuid));
    // A sweep is up to 140,000 entries: only those that can be tracked (Diamond I, or seen in a
    // Master+ game) or are tracked are kept in memory, the others are counted as their page is read.
    const sweep = await this.sweepDiamond(
      (e) => e.division === 1 || seenWithMaster.has(e.puuid) || storedPuuids.has(e.puuid),
      signal,
    );
    const seen = sweep.seen;
    if (seen.every((n) => n === 0)) {
      this.log.warn('empty Diamond sweep from Riot, not applied');
      return null;
    }
    const now = this.clock.now();
    // A player seen twice (moved between pages or divisions meanwhile) keeps the latest entry.
    const swept = new Map<string, DiamondEntry>();
    for (const e of sweep.entries) {
      if (this.apexPuuids.has(e.puuid)) continue;
      const other = swept.get(e.puuid);
      if (!other || other.seenAt <= e.seenAt) swept.set(e.puuid, e);
    }

    // Tracked players the sweep did not see compete as they are stored.
    const candidates = [...swept.values()];
    const missing = new Set<string>();
    for (const row of stored) {
      if (swept.has(row.puuid) || this.apexPuuids.has(row.puuid)) continue;
      if (row.seenAt.getTime() <= now - this.opts.diamondKeepMs) continue;
      missing.add(row.puuid);
      candidates.push({
        puuid: row.puuid,
        division: row.division,
        leaguePoints: row.leaguePoints,
        wins: 0,
        losses: 0,
        seenAt: row.seenAt.getTime(),
      });
    }
    // After a restart: as many Diamond I players as were tracked beyond the first group.
    this.diamond.extra ??= stored.filter((r) => !seenWithMaster.has(r.puuid)).length;
    const selection = selectDiamondPlayers(candidates, seenWithMaster, cap, this.diamond.extra);
    const tracked = [...selection.withMaster, ...selection.diamondOne];

    const result = await upsertDiamondLadder(
      this.db,
      this.platform,
      tracked.filter((e) => !missing.has(e.puuid)).map(toDiamondLadderEntry),
      { keep: tracked.filter((e) => missing.has(e.puuid)).map((e) => e.puuid), now: new Date(now) },
    );
    this.diamond.tracked = tracked.sort(byDivisionThenLp);
    this.diamond.seen = seen;
    this.diamond.withMaster = selection.withMaster.length;
    this.diamond.diamondOne = selection.diamondOne.length;
    this.diamond.extra = selection.diamondOne.length;
    this.diamond.reserve = selection.reserve.filter((e) => !missing.has(e.puuid));
    this.applyLadderOrder();
    for (const p of result.played) this.played.add(p);
    await this.loadPendingListings();
    this.log.info('diamond sweep applied', {
      seen,
      tracked: tracked.length,
      withMaster: selection.withMaster.length,
      diamondOne: selection.diamondOne.length,
      cap,
      notSeenKept: missing.size,
      played: result.played.length,
      added: result.added.length,
      removed: result.removed,
      toList: this.played.size,
    });
    return result.played.length;
  }

  /**
   * Reads the four Diamond divisions, side by side: the entries `keep` holds for, and how many
   * each division has. Throws as soon as one page fails.
   */
  private async sweepDiamond(
    keep: (e: DiamondEntry) => boolean,
    signal?: AbortSignal,
  ): Promise<{ entries: DiamondEntry[]; seen: [number, number, number, number] }> {
    const stop = new AbortController();
    const linked = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const entries: DiamondEntry[] = [];
    const results = await Promise.allSettled(
      DIVISIONS.map(async (division, i) => {
        try {
          return await this.sweepDivision(division, i + 1, keep, entries, linked);
        } catch (err) {
          // The sweep is lost: the other divisions stop asking.
          stop.abort();
          throw err;
        }
      }),
    );
    const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (failures.length > 0) {
      if (signal?.aborted) throw abortError();
      // The failure that stopped the sweep, not the aborts it caused.
      throw failures.find((reason) => !isAbortError(reason)) ?? failures[0];
    }
    const seen = results.map((r) => (r.status === 'fulfilled' ? r.value : 0));
    return { entries, seen: [seen[0] ?? 0, seen[1] ?? 0, seen[2] ?? 0, seen[3] ?? 0] };
  }

  /**
   * The pages of one division, from 1 until an empty one: adds the entries `keep` holds for to
   * `out`, returns how many entries the division has.
   */
  private async sweepDivision(
    division: Division,
    number: number,
    keep: (e: DiamondEntry) => boolean,
    out: DiamondEntry[],
    signal: AbortSignal,
  ): Promise<number> {
    let seen = 0;
    for (let page = 1; page <= MAX_DIAMOND_PAGES; page++) {
      if (signal.aborted) throw abortError();
      const entries = await this.riot.getDiamondEntries(this.platform, division, page, signal);
      if (entries.length === 0) return seen;
      for (const e of toDiamondEntries(entries, number, this.clock.now())) {
        seen++;
        if (keep(e)) out.push(e);
      }
    }
    throw new Error(`Diamond ${division} did not end after ${MAX_DIAMOND_PAGES} pages`);
  }

  /**
   * Whether to track `diamondStep` more Diamond I players now ("with remaining budget"): the last
   * sweep has some left under the cap, every Master player of Riot's list is tracked, the queues
   * are nearly empty (as for `canTrackMoreMasters`) and no untracked player is due for a listing.
   */
  async canTrackMoreDiamonds(): Promise<boolean> {
    const cap = this.opts.diamondMaxTracked;
    if (cap <= 0 || this.diamond.reserve.length === 0) return false;
    if (this.diamond.tracked.length >= cap) return false;
    if (this.masterTotal === 0 || this.masterTracked < this.masterTotal) return false;
    if (!(await this.caughtUp())) return false;
    return !(await this.extraListingDue());
  }

  /** Whether an untracked player is due for a listing (level 6) and could be listed now. */
  private async extraListingDue(): Promise<boolean> {
    if (this.opts.concurrency.extraListing <= 0) return false;
    const now = this.clock.now();
    const coolingDown = (p: string) => (this.extraCooldown.get(p) ?? 0) > now;
    const rows = await extraListingCandidates(this.db, this.platform, {
      minTier: this.opts.extraMinTier,
      syncedBefore: new Date(now - this.opts.extraListingIntervalMs),
      limit: 1 + [...this.extraCooldown.keys()].filter(coolingDown).length,
    });
    return rows.some((p) => !coolingDown(p));
  }

  /**
   * Tracks the next `diamondStep` Diamond I players by LP of the last sweep (as that sweep saw
   * them; the next one refreshes them).
   */
  async trackMoreDiamonds(): Promise<void> {
    const room = this.opts.diamondMaxTracked - this.diamond.tracked.length;
    const next = this.diamond.reserve.slice(0, Math.max(0, Math.min(this.opts.diamondStep, room)));
    if (next.length === 0) return;
    const result = await upsertDiamondLadder(
      this.db,
      this.platform,
      next.map(toDiamondLadderEntry),
      { keep: 'all', now: new Date(this.clock.now()) },
    );
    this.diamond.reserve = this.diamond.reserve.slice(next.length);
    const from = this.diamond.diamondOne ?? 0;
    this.diamond.diamondOne = from + next.length;
    this.diamond.extra = (this.diamond.extra ?? 0) + next.length;
    this.diamond.tracked = [...this.diamond.tracked, ...next].sort(byDivisionThenLp);
    this.applyLadderOrder();
    for (const p of result.played) this.played.add(p);
    this.log.info('tracking more Diamond I players', {
      from,
      to: this.diamond.diamondOne,
      tracked: this.diamond.tracked.length,
      cap: this.opts.diamondMaxTracked,
    });
  }

  // -------------------------------------------------------------------------
  // Level 2: match ids
  // -------------------------------------------------------------------------

  /**
   * Adds the players with a listing requested in the database (they played: the request survives
   * restarts) and those never listed (e.g. a restart interrupted their first listing).
   */
  private async loadPendingListings(): Promise<void> {
    // The rows may be stale by the time they arrive: a listing that started meanwhile (or is
    // still running) already covers them. A genuinely new "played" signal comes from the ladder.
    const started = new Set<string>();
    this.listingsStartedDuringLoad = started;
    let pending: string[];
    try {
      pending = [
        ...(await playersWithListingRequested(this.db, this.platform)),
        ...(await trackedPlayersNeverListed(this.db, this.platform)),
      ];
    } finally {
      this.listingsStartedDuringLoad = null;
    }
    for (const p of pending) {
      if (!this.listingInFlight.has(p) && !started.has(p)) this.played.add(p);
    }
  }

  /**
   * The player to list next: the best ladder position first (ties: the first one added), skipping
   * players being listed or cooling down after a failure.
   */
  private peekPlayedPlayer(): string | null {
    const now = this.clock.now();
    let next: string | null = null;
    let nextRank = Number.POSITIVE_INFINITY;
    for (const p of this.played) {
      // A player being listed stays in the set: they played again, so they are listed again.
      if (this.listingInFlight.has(p)) continue;
      const until = this.listingCooldown.get(p);
      if (until !== undefined && until > now) continue;
      const rank = this.rankOf(p);
      if (rank < nextRank) {
        next = p;
        nextRank = rank;
        if (rank === 0) break;
      }
    }
    return next;
  }

  /** Starts the listing of a player of `played`; false when another loop took them meanwhile. */
  private takePlayedPlayer(puuid: string): boolean {
    if (!this.played.has(puuid) || this.listingInFlight.has(puuid)) return false;
    this.played.delete(puuid);
    this.listingInFlight.add(puuid);
    this.listingsStartedDuringLoad?.add(puuid);
    return true;
  }

  private nextPlayedPlayer(): string | null {
    const next = this.peekPlayedPlayer();
    return next !== null && this.takePlayedPlayer(next) ? next : null;
  }

  /**
   * `nextPlayedPlayer` for the skip rule ('shadow' and 'on'): the player is only handed out once
   * no match queued by a better-placed player is still to be fetched, so that whether their new
   * games are stored is decided on everything the players before them brought. Matches queued by
   * players below them, by untracked players, and retried or deferred ones (all with a higher
   * `fetch_rank`) are not waited for: a backlog of those never delays a listing. Neither does a
   * match that stays unfetched: after `listingGateMaxWaitMs` the player is listed anyway.
   */
  private async nextPlayedPlayerAfterMatches(signal: AbortSignal): Promise<string | null> {
    let waitingSince: number | null = null;
    for (;;) {
      const next = this.peekPlayedPlayer();
      if (next === null) return null;
      const now = this.clock.now();
      waitingSince ??= now;
      const open =
        now - waitingSince >= this.opts.listingGateMaxWaitMs ||
        !(await hasPendingMatchBefore(
          this.db,
          this.platform,
          Math.min(this.rankOf(next), this.ladderRank.size),
        ));
      if (open) {
        if (this.takePlayedPlayer(next)) return next;
        continue;
      }
      // Until a match loop finishes a match, or the poll interval.
      await Promise.race([
        this.matchSettled.promise,
        this.clock.sleep(this.opts.listingGatePollMs, signal),
      ]);
    }
  }

  /** A match loop finished a match (stored, skipped, failed or deferred). */
  private noteMatchSettled(): void {
    const settled = this.matchSettled;
    this.matchSettled = deferred();
    settled.resolve();
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

  /**
   * Lists a tracked player the ladder says played, unless the skip rule says their new games are
   * all stored already (`listingSkip`):
   *
   * - 'off': always listed.
   * - 'on': when the rule holds (`checkListingSkip`), the listing request is cleared without
   *   calling Riot; `matches_synced_until` and the baseline stay, so the next real listing still
   *   covers the whole period and the counts stay cumulative.
   * - 'shadow': always listed. When the rule holds the baseline stays, as in 'on', and if the
   *   listing queued new match ids they are recorded in `listing_skip_misses`.
   *
   * A real listing the rule did not hold for sets the baseline: the ladder counters it was decided
   * on, and now.
   */
  async listTrackedPlayer(puuid: string, signal?: AbortSignal): Promise<'listed' | 'skipped'> {
    const mode = this.opts.listingSkip;
    if (mode === 'off') {
      await this.listPlayerMatches(puuid, signal);
      return 'listed';
    }
    const checkedAt = this.clock.now();
    const check = await this.checkListingSkip(puuid, checkedAt);
    if (check.explained && mode === 'on') {
      await clearListingRequest(this.db, puuid, check.state.snapshotAt);
      this.counters.listingsSkipped++;
      this.log.debug('listing skipped', { expected: check.expected, stored: check.stored });
      return 'skipped';
    }
    const newIds: string[] = [];
    await this.listPlayerMatches(puuid, signal, false, newIds);
    if (check.explained) {
      this.counters.listingsSkipped++;
      if (newIds.length > 0) {
        await recordListingSkipMiss(this.db, {
          puuid,
          platform: this.platform,
          checkedAt: new Date(checkedAt),
          listedSnapshotAt: check.listedSnapshotAt,
          snapshotAt: check.state.snapshotAt,
          expected: check.expected,
          stored: check.stored,
          newMatchIds: newIds,
        });
        this.counters.listingSkipMisses++;
      }
    } else if (check.state) {
      await setListingBaseline(this.db, puuid, {
        games: check.state.gamesNow,
        snapshotAt: check.state.snapshotAt,
        listedAt: new Date(checkedAt),
      });
    }
    return 'listed';
  }

  /**
   * The skip rule for a tracked player about to be listed. With `games_now` the player's wins +
   * losses on the ladder, `snapshot` the ladder refresh that produced them, and the baseline of
   * their last real listing (`listed_games` at `listed_snapshot_at`, run at `listed_at`):
   * `explained` when `expected = games_now - listed_games` is positive and at least that many
   * stored non-remake matches of the player ended after `listed_snapshot_at` and at least
   * `listingSkipLadderLagMs` before `snapshot`. Never without a baseline, when the counters went down (season reset), or when
   * `listed_at` is `listingSkipSafetyMs` old (a game Riot never counted would otherwise hide a
   * later one for ever). A game that ended after the snapshot, or too shortly before it for Riot's
   * ladder to have counted it, may not be in `games_now`, so it must not stand for an older
   * missing one; counting too few only costs a listing.
   */
  private async checkListingSkip(
    puuid: string,
    now: number,
  ): Promise<
    | { explained: false; state: ListingSkipState | null }
    | {
        explained: true;
        state: ListingSkipState;
        listedSnapshotAt: Date;
        expected: number;
        stored: number;
      }
  > {
    const state = await getListingSkipState(this.db, puuid);
    if (state === null) return { explained: false, state };
    const { gamesNow, snapshotAt, listedGames, listedSnapshotAt, listedAt } = state;
    if (listedGames === null || listedSnapshotAt === null || listedAt === null) {
      return { explained: false, state };
    }
    if (listedAt.getTime() <= now - this.opts.listingSkipSafetyMs) {
      return { explained: false, state };
    }
    const expected = gamesNow - listedGames;
    if (expected <= 0) return { explained: false, state };
    // Games that ended in the last minutes before the ladder refresh may not be in its counters.
    const countedBy = new Date(snapshotAt.getTime() - this.opts.listingSkipLadderLagMs);
    const stored = await countStoredGamesEndedBetween(this.db, puuid, listedSnapshotAt, countedBy);
    if (stored < expected) return { explained: false, state };
    return { explained: true, state, listedSnapshotAt, expected, stored };
  }

  /**
   * Lists a player's ranked match ids since `matches_synced_until`; returns how many were new
   * (and adds them to `newIds`). Untracked players (`extra`) are listed at the lowest priority
   * and their matches are queued after every tracked player's.
   */
  async listPlayerMatches(
    puuid: string,
    signal?: AbortSignal,
    extra = false,
    newIds?: string[],
  ): Promise<number> {
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
        {
          startTime: Math.floor(startMs / 1000),
          start,
          count: 100,
          ...(extra ? { priority: PRIORITY.EXTRA_MATCH_IDS } : {}),
        },
        signal,
      );
      // Ids come newest first: once one is known to be from an older patch, the rest are too.
      // Only this platform's ids are comparable with the bound (game ids are per platform, and a
      // regional cluster lists the other platforms' matches too).
      const own = ids.filter((id) => platformFromMatchId(id) === this.platform);
      const oldAt = own.findIndex((id) => this.isKnownOldPatch(gameIdOf(id)));
      const kept = oldAt >= 0 ? own.slice(0, oldAt) : own;
      const fetchRank = extra ? this.ladderRank.size : this.rankOf(puuid);
      const queued = await enqueueNewMatchIds(this.db, this.platform, kept, fetchRank);
      added += queued.length;
      newIds?.push(...queued);
      // Skip rule: these matches are wanted before the next players are decided, so the match
      // loops must not first work through what they had already claimed (a probe is left alone).
      if (queued.length > 0 && !extra && this.opts.listingSkip !== 'off' && !this.probe.active) {
        this.matchSource.clear();
      }
      if (oldAt >= 0 || ids.length < 100) break;
    }
    // Clears the player's listing request, unless they played again since `now`.
    await finishListing(this.db, puuid, new Date(now - this.opts.listingOverlapMs), new Date(now));
    this.counters.playersPolled++;
    if (extra) this.counters.extraPlayersPolled++;
    if (this.run) this.run.players++;
    this.log.debug('match ids listed', { added, firstTime: since === null, extra });
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
    await this.syncGeneration();
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
    const generation = this.generation;
    if (verdict === 'old' || (verdict === 'previous' && !this.collectsPrevious())) {
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
    if (verdict === 'keep' && generation === this.patches.generation) {
      this.latestStored(matchId, gameId);
    }
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

  /**
   * New patch generation: the too-new / kept bounds are reset, a probe starts, and whether the
   * latest patch is live on this platform is read again.
   */
  private syncGeneration(): Promise<void> {
    if (this.generation !== this.patches.generation) {
      const generation = this.patches.generation;
      this.generation = generation;
      this.tooNewMinGameId = null;
      this.keepMinGameId = null;
      this.probe = { active: true, first: true, inFlight: this.probe.inFlight };
      this.probed.clear();
      // Not known yet: the previous patch stays collected meanwhile.
      this.latestLive = false;
      this.liveness = this.readLatestLive(generation).catch((err) => {
        // Read again at the next call.
        if (this.generation === generation) this.generation = -1;
        throw err;
      });
    }
    return this.liveness;
  }

  private async readLatestLive(generation: number): Promise<void> {
    const latest = this.patches.latest;
    if (latest === null) return;
    const live = await platformHasMatchOnPatch(this.db, this.platform, latest);
    // Never undo a flip that happened while reading, nor write into a newer generation.
    if (live && this.generation === generation) this.latestLive = true;
  }

  /**
   * The previous patch is collected until the latest one is live on this platform (or always,
   * with `collectPreviousPatch`).
   */
  private collectsPrevious(): boolean {
    return !this.latestLive || this.opts.collectPreviousPatch;
  }

  /**
   * A match of the latest patch is stored: the patch is live on this platform and the previous
   * one is old from now on. Ids kept so far may be from the previous patch, so the search for
   * where the latest patch starts begins again below this match.
   */
  private latestStored(matchId: string, gameId: number | null): void {
    if (this.latestLive) return;
    this.latestLive = true;
    this.keepMinGameId = gameId;
    this.probe = { active: true, first: true, inFlight: this.probe.inFlight };
    this.probed.clear();
    this.log.info('latest patch is live', { matchId });
  }

  /**
   * The next probe match (see `probe`), null while one is in flight (the other loops wait), or
   * undefined when not probing (claim in FIFO order).
   */
  private async nextProbe(exclude: ReadonlySet<string>): Promise<QueuedMatch | null | undefined> {
    if (!this.patches.ready) return undefined;
    await this.syncGeneration();
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
    const masteries = await this.riot.getMasteries(
      this.platform,
      c.puuid,
      PRIORITY.DAILY_REFRESH,
      signal,
    );
    await replaceMasteries(
      this.db,
      c.puuid,
      toMasteries(masteries ?? []),
      new Date(this.clock.now()),
    );
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
      // One transaction: a match of this player stored meanwhile waits for it (the player's row)
      // and, if it brings a champion without a mastery row, queues the player again.
      await inTransaction(this.db, async (tx) => {
        await replaceMasteries(tx, e.puuid, toMasteries(masteries ?? []), now);
        await updatePlayerRank(tx, e.puuid, toSoloRank(entries ?? []), now);
        await completeEnrichment(tx, e.puuid);
      });
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
    await this.loadLadderOrder();
    await this.loadPendingListings();
    await this.openRun();
    const c = this.opts.concurrency;
    const loops: Promise<void>[] = [this.heartbeatLoop(signal), this.ladderLoop(signal)];
    // Skip rule: listings wait for the matches of better-placed players (if anything fetches them).
    const afterMatches = this.opts.listingSkip !== 'off' && c.match > 0;
    for (let i = 0; i < c.listing; i++) {
      loops.push(
        this.workLoop(
          'listing',
          signal,
          async () =>
            afterMatches ? this.nextPlayedPlayerAfterMatches(signal) : this.nextPlayedPlayer(),
          async (p) => {
            await this.listTrackedPlayer(p, signal);
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
            this.noteMatchSettled();
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
    for (let i = 0; i < c.extraListing; i++) {
      loops.push(
        this.workLoop(
          'extra listing',
          signal,
          async () => ((await this.canListExtraPlayers()) ? this.extraSource.next() : null),
          async (p) => {
            try {
              await this.listPlayerMatches(p, signal, true);
              return 'ok';
            } catch (err) {
              if (!isAbortError(err)) this.extraCooldown.set(p, this.clock.now() + HOUR);
              throw err;
            }
          },
          (p) => this.extraSource.release(p),
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
      masterTracked: this.masterTracked,
      masterTotal: this.masterTotal,
      playedToList: new Set([...this.played, ...this.listingInFlight]).size,
      pendingMatches: await countPendingMatches(this.db, this.platform),
      enrichmentQueue: await countEnrichmentQueue(this.db, this.platform),
      latestPatchLive: this.latestLive,
      ...this.counters,
      diamond:
        this.opts.diamondMaxTracked > 0
          ? {
              seen: this.diamond.seen,
              tracked: this.diamond.tracked.length,
              trackedWithMaster: this.diamond.withMaster,
              trackedDiamondOne: this.diamond.diamondOne,
              cap: this.opts.diamondMaxTracked,
            }
          : null,
    };
  }

  /**
   * Refreshes the ladder every `ladderIntervalMs` (5 min after a failure), then sweeps the Diamond
   * divisions when they are tracked, and in between checks every `expansionCheckMs` whether to
   * track more Master players, then more Diamond I players.
   */
  private async ladderLoop(signal: AbortSignal): Promise<void> {
    let first = true;
    let refreshAt = this.clock.now();
    while (!signal.aborted) {
      try {
        await this.waitForAuth(signal);
        if (this.clock.now() >= refreshAt) {
          if (!first) await this.rotateRun();
          first = false;
          refreshAt = this.clock.now() + this.opts.ladderIntervalMs;
          await this.refreshLadder(signal);
          await this.refreshDiamondsOfCycle(signal);
        } else if (await this.canTrackMoreMasters()) {
          await this.trackMoreMasters(signal);
        } else if (await this.canTrackMoreDiamonds()) {
          await this.trackMoreDiamonds();
        }
      } catch (err) {
        if (isAbortError(err)) break;
        this.recordError('ladder', err);
        refreshAt = Math.min(refreshAt, this.clock.now() + 5 * 60_000);
      }
      const wait = Math.max(0, Math.min(this.opts.expansionCheckMs, refreshAt - this.clock.now()));
      if (!(await this.sleep(wait, signal))) break;
    }
  }

  /**
   * The Diamond sweep of a ladder cycle. A failed one changes nothing and is not retried before
   * the next cycle (a sweep is hundreds of requests): the tracked Diamond players stay as they are.
   */
  private async refreshDiamondsOfCycle(signal: AbortSignal): Promise<void> {
    if (this.opts.diamondMaxTracked <= 0) return;
    try {
      await this.refreshDiamonds(signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      this.recordError('diamond sweep', err);
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
      getDiamondEntries: (...a) => ok(riot.getDiamondEntries(...a)),
      getMatchIds: (...a) => ok(riot.getMatchIds(...a)),
      getMatch: (...a) => ok(riot.getMatch(...a)),
      getTimeline: (...a) => ok(riot.getTimeline(...a)),
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
