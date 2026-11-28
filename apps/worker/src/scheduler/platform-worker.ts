/**
 * One platform's crawler. Several kinds of work run concurrently and all wait on the same per-host
 * rate limiters, which serve the highest priority first (docs/architecture.md, "Worker").
 *
 * Platform host, in this order: ladder refresh (hourly, and when Master grows; priority 5), the
 * Diamond sweep (4), the mastery refresh of tracked players (2), enrichment (masteries, and the
 * rank when the stored one is old; 1), then the checks of the Masters outside Riot's list (0, at
 * most `outsideCheckMaxPerHour`). Masteries and ranks feed the stats of the stored games; a late
 * check only delays an outside Master's games (their listing starts where the last one stopped).
 *
 * Match cluster (the scarce budget), three strict tiers:
 *
 * 1. the tracked apex players (Challenger, Grandmaster, Riot's Master list): listings of those
 *    who played (priority 4), then their matches (3);
 * 2. the Masters outside Riot's list (it stops at 10,000 players): each one's own solo queue
 *    entry is checked in rotation on the platform host, and those whose wins + losses moved are
 *    listed, only once tier 1 has caught up (their matches 0, their listings -1);
 * 3. the tracked Diamond players, only once tier 1 has caught up and tier 2 has nothing waiting:
 *    3a those seen in a Master+ game lately (listings -2, matches -3), then 3b the other Diamond
 *    players (division I first, down to IV), only once 3a has nothing waiting (listings -4, matches -5). How many are tracked is
 *    a target the worker sizes by itself.
 *
 * A tier is held back twice: its work is not handed out before its turn (below), and its requests
 * wait behind those of the tiers above in the limiter.
 *
 * Players are tracked from the top of the ladder down: Challenger and Grandmaster, then Master by
 * LP, `masterStep` more each time tier 1 has caught up. Listings and match fetches follow the
 * ladder order too, so the best players' matches always come first.
 *
 * Listing skip rule (`listingSkip` 'shadow' | 'on'): a player whose new games are all stored
 * already (found through other players) needs no listing. For that the matches a listing queues
 * must be stored before the next players are decided, so a player is only picked for a listing
 * once no match queued by a better-placed player is still to be fetched.
 *
 * Diamond tracking (`diamondMaxTracked` > 0): after each hourly ladder refresh the four Diamond
 * divisions are read page by page (the rank of every player already known is stored on the way),
 * and the best candidates are tracked, as many as the target says: first those seen in a Master+
 * game lately, by division then LP, then the other Diamond players by division (I down to IV)
 * then LP. The
 * target is sized on the day: it grows a step when the tiers ran out of work in a few hours of
 * the last day, and shrinks a step when they did not catch up once in a full day
 * (`startBudgetCycle`).
 */
import {
  claimEnrichment,
  claimPendingMatches,
  clearListingRequest,
  clearWorkerAuthRejected,
  completeEnrichment,
  countEnrichmentQueue,
  countPendingMatches,
  countPendingMatchesInBand,
  countStoredGamesEndedBetween,
  type DailyRefreshCandidate,
  type Db,
  DIAMOND_FETCH_RANK,
  DIAMOND_ONE_FETCH_RANK,
  type DiamondTracking,
  deferMatch,
  deferMatchAfterError,
  deferOutsideMasterCheck,
  EXTRA_FETCH_RANK,
  enqueueNewMatchIds,
  failEnrichment,
  finishListing,
  finishWorkerRun,
  getDiamondTracking,
  getListingSkipState,
  getMatchesSyncedUntil,
  getOutsideMasterSkipState,
  getRankRefreshedAt,
  hasPendingMatchBefore,
  insertParsedMatch,
  inTransaction,
  type LadderEntryInput,
  type ListingSkipState,
  ladderOrder,
  listWorkerStatus,
  type MasteryInput,
  markMatchFailed,
  markMatchSkipped,
  markWorkerAuthRejected,
  type OutsideMasterCheck,
  outsideMasterStats,
  outsideMastersToCheck,
  outsideMastersToList,
  pickProbeMatch,
  platformHasMatchOnPatch,
  playersNeedingDailyRefresh,
  playersSeenWithMasterSince,
  playersWithListingRequested,
  QUEUE_BACK_RANK,
  type QueuedEnrichment,
  type QueuedMatch,
  recordListingSkipMiss,
  recordOutsideMasterCheck,
  recordWorkerError,
  replaceMasteries,
  saveDiamondTracking,
  setListingBaseline,
  setOutsideMasterBaseline,
  skipPendingMatchesUpTo,
  startWorkerRun,
  syncOutsideMasters,
  touchWorkerStatus,
  trackedDiamondEntries,
  trackedPlayersNeverListed,
  updateKnownPlayerRanks,
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
} from '@pick-league/shared';
import { abortError, type Clock, isAbortError, systemClock } from '../clock.ts';
import { errorMessage, type Logger, silentLogger } from '../log.ts';
import { MatchParseError, parseMatch } from '../parser/parse-match.ts';
import type { PatchVerdict } from '../patches.ts';
import { PRIORITY, type Priority, type RiotApi, RiotAuthError } from '../riot/client.ts';
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

/** The groups of players that are listed: each has its own safety interval of the skip rule. */
export type ListingGroup = 'apex' | 'outsideMaster' | 'diamond';

export interface SchedulerOptions {
  /** Ladder refresh period (default 1 h). */
  ladderIntervalMs: number;
  /**
   * Master players added to the tracked set (top of the Master tier by LP first) each time the
   * first tier has caught up (default 500). Challenger and Grandmaster are always tracked.
   */
  masterStep: number;
  /**
   * "Nearly empty": a tier has caught up when none of its listings is waiting and at most this
   * many of its matches are PENDING (default 50).
   */
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
    /** Mastery refresh of tracked players. */
    daily: number;
    enrichment: number;
    /** Checks of the Masters outside Riot's list (platform host). */
    outsideCheck: number;
    /** Listings of those whose counter moved (tier 2). */
    outsideListing: number;
  };
  /**
   * Tier 2. The Master+ players outside Riot's list (seen in stored matches and ranked Master or
   * above, on no tracked ladder) are followed by their own solo queue entry, asked for on the
   * platform host in rotation, least recently checked first, once every Master player of Riot's
   * list is tracked. At most `outsideCheckMaxPerHour` checks an hour (default 1,500, half of what
   * a platform host allows; 0: none). The checks come last on that host, after the mastery
   * refresh and enrichment (the stats of the stored games read their masteries and ranks): they
   * get what those leave, which may be nothing while enrichment has a backlog. A late check only
   * delays a player's games: their listing starts where the last one stopped. What a busy hour
   * did not use is caught up, up to half an hour's worth. A player is not checked again within
   * `outsideCheckIntervalMs` (default 1 h, the pace of the ladder lists).
   */
  outsideCheckMaxPerHour: number;
  outsideCheckIntervalMs: number;
  /**
   * Masteries of a tracked player are fetched again when they are this old (default 3 days), and
   * at once after a first stored game on a champion.
   */
  masteryRefreshIntervalMs: number;
  /**
   * Enrichment does not ask for the rank of a player whose stored rank was refreshed less than
   * this ago (by a ladder, the Diamond sweep, a check or a previous enrichment; default 24 h): it
   * only fetches their masteries. The sweep keeps the rank of the Diamond players it sees at most
   * half this old.
   */
  enrichmentRankFreshMs: number;
  /**
   * Keep collecting the previous patch after the latest one is live (default false). For a
   * backfill of the previous patch by hand; while it is on, first listings go back up to
   * `firstListingMaxMs`.
   */
  collectPreviousPatch: boolean;
  /** Listing skip rule (default 'off': exactly the behaviour without it). */
  listingSkip: ListingSkipMode;
  /**
   * A player whose last real listing is older than this is listed whatever is stored, per group:
   * 24 h for the apex players, 72 h for the Masters outside Riot's list and the Diamond players
   * (at 20,000 players and more, a forced listing a day each is most of the regional budget). It
   * is also how old the last listing of an outside Master may be for their first check to be
   * taken as the starting counter without a listing.
   */
  listingSkipSafetyMs: Record<ListingGroup, number>;
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
   * Tier 3. Ceiling of the Diamond target (default 0: no Diamond player is tracked and no
   * Diamond request is made). The target itself is sized by the worker, `diamondStep` players
   * at a time (default 500), and kept in `diamond_tracking`. Tracked first (3a): those seen in a
   * Master+ game during `diamondWithMasterWindowMs` (default 7 days), by division then LP; then
   * (3b) every other Diamond player, by division (I down to IV) then LP: top players first,
   * nobody below Diamond IV.
   */
  diamondMaxTracked: number;
  diamondStep: number;
  diamondWithMasterWindowMs: number;
  /**
   * The target is sized on the day, not on the hour: the backlog the evening peak leaves is
   * caught up in the quiet hours, which would otherwise go unused. It grows a step when the last
   * `diamondGrowCycles` ladder cycles (default 24: a full day) hold at least
   * `diamondGrowMinKeptCycles` (default 3) kept ones, whatever was missed in between: hours in
   * which the three tiers ran out of work, so budget was left. A cycle is kept when the three
   * tiers had nothing waiting at least once during it; missed otherwise, unless patch data was
   * missing: that one is neither.
   */
  diamondGrowCycles: number;
  diamondGrowMinKeptCycles: number;
  /**
   * Fast start: while the target has never shrunk, or not for `diamondFastGrowAfterShrinkMs`
   * (default 7 days), it grows a step after only `diamondFastGrowCycles` kept cycles in a row
   * (default 2; 0 switches the fast start off). A platform with spare budget then finds what it
   * carries in a day or two instead of weeks; the first shrink says a day's budget is reached,
   * and the slow rule above takes over.
   */
  diamondFastGrowCycles: number;
  diamondFastGrowAfterShrinkMs: number;
  /**
   * The target shrinks a step once `diamondShrinkMissedCycles` cycles (default 24: a full day)
   * were missed since the last kept one: the backlog was not caught up even in the quiet hours.
   */
  diamondShrinkMissedCycles: number;
  /**
   * A growth step brings a burst of first listings: until the three tiers have nothing waiting
   * again, cycles are not recorded at all, for at most this many cycles that would have been
   * missed ones (default 24). The same after a stop of more than one ladder interval.
   */
  diamondSettleCycles: number;
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
  concurrency: {
    listing: 2,
    match: 3,
    daily: 1,
    // Four: each enrichment is one or two Riot round trips and a transaction, so two loops left
    // the platform host's slots to the checks below them (about 950 an hour on KR, Nov 2026).
    enrichment: 4,
    outsideCheck: 2,
    // Three at a time: with one, the listings of the outside Masters (1.2 new matches each on
    // KR on 2026-11-23) left a sixth of the regional budget unused while thousands waited.
    outsideListing: 3,
  },
  outsideCheckMaxPerHour: 1_500,
  outsideCheckIntervalMs: HOUR,
  masteryRefreshIntervalMs: 3 * DAY,
  enrichmentRankFreshMs: DAY,
  collectPreviousPatch: false,
  listingSkip: 'off',
  listingSkipSafetyMs: { apex: DAY, outsideMaster: 3 * DAY, diamond: 3 * DAY },
  listingSkipLadderLagMs: 15 * 60_000,
  listingGateMaxWaitMs: 5 * 60_000,
  listingGatePollMs: 1_000,
  diamondMaxTracked: 0,
  diamondStep: 1_000,
  diamondWithMasterWindowMs: 7 * DAY,
  diamondGrowCycles: 24,
  diamondGrowMinKeptCycles: 3,
  diamondFastGrowCycles: 2,
  diamondFastGrowAfterShrinkMs: 7 * DAY,
  diamondShrinkMissedCycles: 24,
  diamondSettleCycles: 24,
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
  options?: SchedulerOptionsInput;
}

/** Scheduler options to override: any of them, and any part of the grouped ones. */
export type SchedulerOptionsInput = Partial<
  Omit<SchedulerOptions, 'concurrency' | 'listingSkipSafetyMs'>
> & {
  concurrency?: Partial<SchedulerOptions['concurrency']>;
  listingSkipSafetyMs?: Partial<SchedulerOptions['listingSkipSafetyMs']>;
};

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
  /** Enrichments that did not ask for the rank: the stored one was fresh (also in `enriched`). */
  enrichedRankFresh: number;
  /** Mastery refreshes of tracked players. */
  dailyRefreshed: number;
  /** Checks of Masters outside Riot's list (platform host). */
  outsideMasterChecks: number;
  /** Listings of Masters outside Riot's list (also counted in `playersPolled`). */
  extraPlayersPolled: number;
  /**
   * Listing skip rule: listings not made because the player's new games were all stored
   * ('shadow': listings that would not have been made; they ran and are in `playersPolled`).
   */
  listingsSkipped: number;
  /** 'shadow': would-be-skipped listings that queued new match ids (`listing_skip_misses` rows). */
  listingSkipMisses: number;
  /** Tier 2, the Masters outside Riot's list; null when they are not followed. */
  outsideMasters: OutsideMastersProgress | null;
  /** Diamond tracking; null when it is off (`diamondMaxTracked` = 0). */
  diamond: DiamondProgress | null;
}

export interface OutsideMastersProgress {
  /** Master+ players outside Riot's list that are followed. */
  followed: number;
  /** Of them, checked in the last hour. */
  checkedLastHour: number;
  /** Not checked yet. */
  neverChecked: number;
  /** Age of the oldest check, in minutes (null: nobody was checked yet). */
  oldestCheckMinutes: number | null;
  /** Waiting for a match-id listing: their counter moved. */
  toList: number;
  /** Matches their listings queued that are still to be fetched (tier 3 waits for them too). */
  matchesWaiting: number;
}

export interface DiamondProgress {
  /** Players of the last complete sweep per division (I, II, III, IV); null before the first one. */
  seen: [number, number, number, number] | null;
  /** Diamond players tracked. */
  tracked: number;
  /** Of them, seen in a Master+ game lately (3a); the others are of 3b (every other Diamond player). */
  trackedWithMaster: number;
  /** Diamond players to track: sized by the worker, at most `cap`. */
  target: number;
  /** `diamondMaxTracked`. */
  cap: number;
  /**
   * The last ladder cycles since the target changed (at most `diamondGrowCycles`), oldest first:
   * K kept up, W waiting for patch data, M missed; and how many of them were kept up with.
   */
  cycles: string;
  keptCycles: number;
  /** Cycles left to absorb a growth step (or a long stop); they are not recorded meanwhile. */
  settleCyclesLeft: number;
  /** The last grow / shrink of the target and why. */
  lastChange: { at: string; from: number | null; reason: string | null } | null;
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
  /** The players to track, best candidate first: those seen in a Master+ game, then the others. */
  tracked: DiamondEntry[];
  /** How many of them were seen in a Master+ game lately. */
  withMaster: number;
}

/**
 * Which Diamond players to track, `target` at most. Two groups, in this order: (3a) those of
 * `seenWithMaster`, whatever their division, by division (I first) then LP; (3b) every other
 * Diamond player, by division (I down to IV) then LP.
 */
export function selectDiamondPlayers(
  candidates: readonly DiamondEntry[],
  seenWithMaster: ReadonlySet<string>,
  target: number,
): DiamondSelection {
  const first: DiamondEntry[] = [];
  const others: DiamondEntry[] = [];
  for (const c of candidates) {
    if (seenWithMaster.has(c.puuid)) first.push(c);
    else others.push(c);
  }
  first.sort(byDivisionThenLp);
  others.sort(byDivisionThenLp);
  const tracked = [...first, ...others].slice(0, Math.max(0, target));
  return { tracked, withMaster: Math.min(first.length, tracked.length) };
}

/**
 * The best `limit` Diamond entries (division, then LP) of those added, without holding them all:
 * a sweep is up to 140,000 entries a platform.
 */
export class BestDiamonds {
  private entries: DiamondEntry[] = [];

  constructor(private readonly limit: number) {}

  add(e: DiamondEntry): void {
    if (this.limit <= 0) return;
    this.entries.push(e);
    if (this.entries.length >= 2 * this.limit + 1024) this.trim();
  }

  values(): DiamondEntry[] {
    this.trim();
    return this.entries;
  }

  private trim(): void {
    this.entries.sort(byDivisionThenLp);
    if (this.entries.length > this.limit) this.entries.length = this.limit;
  }
}

/**
 * Outcome of a ladder cycle, as recorded in `diamond_tracking.cycles`: K kept up (the three tiers
 * had nothing waiting at least once), W waiting for patch data, M missed. (A history written
 * before the daily Master pass was removed may hold P and R: neither kept nor missed.)
 */
export type CycleOutcome = 'K' | 'W' | 'M';

export interface DiamondTargetRules {
  /** `diamondMaxTracked`. */
  cap: number;
  step: number;
  growCycles: number;
  growMinKeptCycles: number;
  shrinkMissedCycles: number;
}

/**
 * The next Diamond target after the cycles of `history` (those since it last changed), or null
 * to keep it. Shrinks a step once `shrinkMissedCycles` cycles were missed since the last kept
 * one; grows a step, up to the ceiling, when the last `growCycles` cycles hold at least
 * `growMinKeptCycles` kept ones (missed ones in between do not matter: the backlog of the peak
 * hours is caught up in the quiet ones), and `tracked` players fill the target.
 */
export function nextDiamondTarget(
  history: string,
  current: { target: number; tracked: number },
  rules: DiamondTargetRules,
): { target: number; reason: string } | null {
  const { target } = current;
  const sinceKept = history.slice(history.lastIndexOf('K') + 1);
  const missed = sinceKept.split('M').length - 1;
  if (missed >= rules.shrinkMissedCycles && target > 0) {
    return {
      target: Math.max(0, target - rules.step),
      reason: `not kept up: ${missed} cycles missed since the last kept one`,
    };
  }
  const window = history.slice(-rules.growCycles);
  const kept = window.split('K').length - 1;
  if (
    window.length >= rules.growCycles &&
    kept >= rules.growMinKeptCycles &&
    target < rules.cap &&
    current.tracked >= target
  ) {
    return {
      target: Math.min(rules.cap, target + rules.step),
      reason: `caught up in ${kept} of the last ${window.length} cycles`,
    };
  }
  return null;
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

/** Cycles kept in `diamond_tracking.cycles` at most. */
const MAX_RECORDED_CYCLES = 96;

/** A ladder cycle in progress, as far as the Diamond target is concerned. */
interface BudgetCycle {
  startedAt: number;
  /** The three tiers had nothing waiting at least once (recorded at once). */
  kept: boolean;
  /** Matches were waiting for patch data. */
  patch: boolean;
}

/** Rate-limit priority of the match request of a queued match: its tier's. */
function matchPriority(fetchRank: number | undefined): Priority {
  if (fetchRank === undefined || fetchRank < EXTRA_FETCH_RANK) return PRIORITY.MATCH;
  if (fetchRank < DIAMOND_FETCH_RANK) return PRIORITY.EXTRA_MATCH;
  if (fetchRank < DIAMOND_ONE_FETCH_RANK) return PRIORITY.DIAMOND_MATCH;
  if (fetchRank < QUEUE_BACK_RANK) return PRIORITY.DIAMOND_ONE_MATCH;
  // Retried and deferred matches may be anyone's.
  return PRIORITY.MATCH;
}

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
   * `fetch_rank` of each tracked player, from the last refresh: the ladder position of the apex
   * players (`apexOrder`, 0 = first Challenger); for the tracked Diamond players
   * (`diamond.tracked`), `DIAMOND_FETCH_RANK` + their position among those seen in a Master+ game
   * lately, `DIAMOND_ONE_FETCH_RANK` + their position among the others. Listings follow it too.
   */
  private ladderRank = new Map<string, number>();
  private apexOrder: string[] = [];
  /** Every player of Riot's three apex lists at the last refresh (tracked or not). */
  private apexPuuids = new Set<string>();
  /** Diamond tracking (`diamondMaxTracked` > 0). */
  private readonly diamond = {
    /**
     * Tracked Diamond players: those seen in a Master+ game lately (3a; division, then LP), then
     * the other Diamond players (3b; division, then LP).
     */
    tracked: [] as DiamondRank[],
    /** How many of `tracked`, from its start, are of 3a. */
    withMaster: 0,
    /** Players per division of the last complete sweep. */
    seen: null as [number, number, number, number] | null,
    /** Ranks of known players stored by the sweep in progress. */
    ranksWritten: 0,
    /** The target and its history (`diamond_tracking`), once read. */
    state: null as DiamondTracking | null,
    loading: null as Promise<DiamondTracking> | null,
    /** The ladder cycle in progress. */
    cycle: null as BudgetCycle | null,
  };
  /** Whether an outside Master is waiting for a listing, as last read (null: read again). */
  private outsideDue: { checkedAt: number; due: boolean } | null = null;
  /**
   * Per-player requests (outside-Master checks, mastery refresh, enrichment) refused with a
   * 401/403 in a row: Riot refuses some players whatever the key, so a single one is the player's.
   */
  private playerRequestsRefused = 0;
  /** What is left of the hourly allowance of outside-Master checks (`outsideCheckMaxPerHour`). */
  private readonly checkBudget = { tokens: 0, at: 0 };
  /** Whether a ladder refresh succeeded in this process. */
  private ladderRefreshed = false;
  /** Master players tracked: grows by `masterStep` when tier 1 has caught up. */
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
  private readonly outsideCheckSource: WorkSource<string>;
  private readonly outsideListSource: WorkSource<string>;
  /** Outside Masters whose listing failed: not listed again before this time. */
  private readonly outsideListCooldown = new Map<string, number>();

  private readonly counters = {
    matchesAdded: 0,
    playersPolled: 0,
    matchesSkipped: 0,
    matchesFailed: 0,
    matchesRetried: 0,
    enriched: 0,
    enrichedRankFresh: 0,
    dailyRefreshed: 0,
    outsideMasterChecks: 0,
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
      listingSkipSafetyMs: {
        ...DEFAULT_SCHEDULER_OPTIONS.listingSkipSafetyMs,
        ...deps.options?.listingSkipSafetyMs,
      },
    };
    this.checkBudget = { tokens: this.checkBudgetCapacity(), at: this.clock.now() };

    this.matchSource = new WorkSource(
      async (exclude) => {
        const now = this.clock.now();
        for (const [id, until] of this.deferredUntil)
          if (until <= now) this.deferredUntil.delete(id);
        const probe = await this.nextProbe(exclude);
        if (probe !== undefined) return probe ? [probe] : [];
        // The Diamond players' matches only when it is their tier's turn.
        const heldFrom = await this.matchesHeldFrom();
        const rows = await claimPendingMatches(
          this.db,
          this.platform,
          50 + exclude.size,
          heldFrom === null ? {} : { heldFrom },
        );
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
          this.opts.masteryRefreshIntervalMs / HOUR,
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
    this.outsideCheckSource = new WorkSource(
      async (exclude) => {
        const rows = await outsideMastersToCheck(this.db, this.platform, {
          checkedBefore: new Date(this.clock.now() - this.opts.outsideCheckIntervalMs),
          limit: 20 + exclude.size,
        });
        return rows.filter((p) => !exclude.has(p));
      },
      (p) => p,
    );
    this.outsideListSource = new WorkSource(
      async (exclude) => {
        const now = this.clock.now();
        for (const [p, until] of this.outsideListCooldown) {
          if (until <= now) this.outsideListCooldown.delete(p);
        }
        const rows = await outsideMastersToList(
          this.db,
          this.platform,
          20 + exclude.size + this.outsideListCooldown.size,
        );
        return rows.filter((p) => !exclude.has(p) && !this.outsideListCooldown.has(p));
      },
      (p) => p,
    );
  }

  // -------------------------------------------------------------------------
  // Ladder
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
    // A restart counts the MASTER rows it finds, a few short of Riot's list when tracked Masters
    // moved up a tier meanwhile; until the next expansion step (which waits for the Diamond sweep,
    // half an hour on EUW1) the outside Masters and Diamond players then had no turn at all. Less
    // than 1 % short of the whole list: track it all now.
    const wanted = Math.max(0, masterPlayers ?? this.masterTracked);
    const short = masters.length - wanted;
    const tracked = masters.slice(
      0,
      masterPlayers === undefined && short > 0 && short <= Math.floor(masters.length / 100)
        ? masters.length
        : wanted,
    );
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
    else {
      this.diamond.tracked = [];
      this.diamond.withMaster = 0;
    }
    this.applyLadderOrder();
    this.masterTracked = tracked.length;
    this.ladderRefreshed = true;
    for (const p of result.played) this.played.add(p);
    await this.loadPendingListings();
    // Players who left the tracked ladder are outside Masters now; those it took are not.
    await this.refreshOutsideMasters();
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
   * The `fetch_rank` of every tracked player, top down: the apex players by ladder position, then
   * the tracked Diamond players in their two bands, those seen in a Master+ game first (a player
   * in both keeps the apex position).
   */
  private applyLadderOrder(): void {
    const rank = new Map<string, number>();
    for (const p of this.apexOrder) {
      if (!rank.has(p)) rank.set(p, Math.min(rank.size, EXTRA_FETCH_RANK - 1));
    }
    let position = DIAMOND_FETCH_RANK;
    let onePosition = DIAMOND_ONE_FETCH_RANK;
    this.diamond.tracked.forEach((d, i) => {
      if (rank.has(d.puuid)) return;
      if (i < this.diamond.withMaster) {
        rank.set(d.puuid, Math.min(position++, DIAMOND_ONE_FETCH_RANK - 1));
      } else {
        rank.set(d.puuid, Math.min(onePosition++, QUEUE_BACK_RANK - 1));
      }
    });
    this.ladderRank = rank;
  }

  private rankOf(puuid: string): number {
    return this.ladderRank.get(puuid) ?? UNRANKED;
  }

  /** A tracked apex player (tier 1); anyone else of `played` is of tier 3. */
  private isApex(puuid: string): boolean {
    return this.rankOf(puuid) < EXTRA_FETCH_RANK;
  }

  /**
   * Of tier 3, a Diamond player seen in a Master+ game lately (3a); the others (3b) are the
   * other Diamond players, and those who left the tracked ladder while waiting.
   */
  private isDiamondWithMaster(puuid: string): boolean {
    const rank = this.rankOf(puuid);
    return rank >= DIAMOND_FETCH_RANK && rank < DIAMOND_ONE_FETCH_RANK;
  }

  /** The tracked ladder as stored, before this process refreshes it (at startup). */
  private async loadLadderOrder(): Promise<void> {
    const rows = await ladderOrder(this.db, this.platform);
    this.apexOrder = rows.filter((r) => r.tier !== 'DIAMOND').map((r) => r.puuid);
    // The two Diamond groups as the next sweep will see them (rows come by division, then LP).
    const since = this.clock.now() - this.opts.diamondWithMasterWindowMs;
    const diamonds = rows.filter((r) => r.tier === 'DIAMOND');
    const seenLately = (r: (typeof rows)[number]) =>
      (r.lastSeenWithMasterAt?.getTime() ?? 0) >= since;
    const withMaster = diamonds.filter(seenLately);
    const others = diamonds.filter((r) => !seenLately(r));
    this.diamond.tracked = [...withMaster, ...others].map((r) => ({
      puuid: r.puuid,
      division: r.division ?? 4,
      leaguePoints: r.leaguePoints,
    }));
    this.diamond.withMaster = withMaster.length;
    this.applyLadderOrder();
    this.masterTracked = rows.filter((r) => r.tier === 'MASTER').length;
    this.ladderLoaded = true;
  }

  // -------------------------------------------------------------------------
  // The three tiers of the match cluster's budget
  // -------------------------------------------------------------------------

  /**
   * Whether to track `masterStep` more Master players now: some are not tracked yet and tier 1
   * has caught up.
   */
  async canTrackMoreMasters(): Promise<boolean> {
    if (this.masterTotal <= this.masterTracked) return false;
    return this.apexCaughtUp();
  }

  /** Every Master player of Riot's list is tracked (it stops at 10,000). */
  private apexComplete(): boolean {
    return this.ladderRefreshed && this.masterTracked >= this.masterTotal;
  }

  /**
   * Tier 1 has caught up: no listing of a tracked apex player is waiting or running (players
   * cooling down after a failed listing don't count) and at most `expandBelowPendingMatches` of
   * their matches are PENDING. Nothing of the tiers below is looked at: a backlog of Diamond
   * matches never holds tier 2 back. Neither are the retried and deferred matches at the back of
   * the queue: they must not hold anything for long.
   */
  private async apexCaughtUp(): Promise<boolean> {
    if (!this.patches.ready) return false;
    for (const p of this.listingInFlight) if (this.isApex(p)) return false;
    const next = this.peekPlayedPlayer();
    if (next !== null && this.isApex(next)) return false;
    return this.fewPendingMatchesBefore(EXTRA_FETCH_RANK);
  }

  /** At most `expandBelowPendingMatches` PENDING matches have a `fetch_rank` below `rank`. */
  private async fewPendingMatchesBefore(rank: number): Promise<boolean> {
    const limit = this.opts.expandBelowPendingMatches + 1;
    const pending = await countPendingMatchesInBand(
      this.db,
      this.platform,
      { from: 0, below: rank },
      limit,
    );
    return pending < limit;
  }

  /**
   * Tier 2's turn: whether to list the Masters outside Riot's list whose counter moved. Every
   * Master player of that list is tracked and tier 1 has caught up.
   */
  async canListOutsideMasters(): Promise<boolean> {
    return this.apexComplete() && (await this.apexCaughtUp());
  }

  /** Whether the Masters outside Riot's list are followed at all. */
  private followsOutsideMasters(): boolean {
    const c = this.opts.concurrency;
    return c.outsideCheck > 0 || c.outsideListing > 0;
  }

  /**
   * Brings the set of outside Masters in line with the stored ranks and the tracked ladders
   * (after each ladder refresh and each Diamond sweep): the Master+ players on no tracked ladder
   * join it, those a ladder follows now or who are ranked lower leave it.
   */
  async refreshOutsideMasters(): Promise<void> {
    if (!this.followsOutsideMasters()) return;
    const { added, removed } = await syncOutsideMasters(this.db, this.platform);
    this.outsideDue = null;
    if (removed > 0) {
      this.outsideCheckSource.clear();
      this.outsideListSource.clear();
    }
    if (added > 0 || removed > 0) this.log.info('outside Masters updated', { added, removed });
  }

  /**
   * Whether an outside Master is waiting for a listing and could be listed now (those cooling
   * down after a failed listing could not). Read at most every `idleMs`, and again after each
   * check that asked for a listing and each of their listings.
   */
  private async outsideListingWaiting(): Promise<boolean> {
    if (this.opts.concurrency.outsideListing <= 0) return false;
    const now = this.clock.now();
    const last = this.outsideDue;
    if (last !== null && now - last.checkedAt < this.opts.idleMs) return last.due;
    const coolingDown = (p: string) => (this.outsideListCooldown.get(p) ?? 0) > now;
    const rows = await outsideMastersToList(
      this.db,
      this.platform,
      1 + [...this.outsideListCooldown.keys()].filter(coolingDown).length,
    );
    const due = rows.some((p) => !coolingDown(p));
    this.outsideDue = { checkedAt: now, due };
    return due;
  }

  /**
   * Tier 2 has nothing waiting: no outside Master is waiting for a listing (and could be
   * listed), none of their listings is running, and the matches queued by tiers 1 and 2 are
   * fetched, all but `expandBelowPendingMatches` at most. A match that fails or is deferred goes
   * to the back of the queue at once, out of these bands, so one that cannot be fetched never
   * keeps tier 2 open. The checks themselves (platform host) are not waited for.
   */
  private async outsideTierDone(): Promise<boolean> {
    if (await this.outsideListingWaiting()) return false;
    if (this.outsideListSource.active > 0) return false;
    return this.fewPendingMatchesBefore(DIAMOND_FETCH_RANK);
  }

  /**
   * Tier 3's turn: whether a tracked Diamond player may be listed, or one of their matches
   * fetched, now. Tier 1 has caught up and tier 2 has nothing waiting.
   */
  private async diamondTurn(): Promise<boolean> {
    if (!this.apexComplete() || !(await this.apexCaughtUp())) return false;
    return this.outsideTierDone();
  }

  /**
   * Turn of the other Diamond players (3b), inside tier 3: the Diamond players seen in a Master+ game
   * (3a) have nothing waiting. None of their listings is waiting or running (players cooling
   * down after a failed listing aside) and at most `expandBelowPendingMatches` of their matches
   * are PENDING.
   */
  private async diamondOneTurn(): Promise<boolean> {
    return (await this.diamondTurn()) && (await this.diamondWithMasterDone());
  }

  /** The Diamond players seen in a Master+ game (3a) have nothing waiting (see above). */
  private async diamondWithMasterDone(): Promise<boolean> {
    for (const p of this.listingInFlight) if (this.isDiamondWithMaster(p)) return false;
    const next = this.peekPlayedPlayer();
    if (next !== null && this.isDiamondWithMaster(next)) return false;
    return this.fewPendingMatchesBefore(DIAMOND_ONE_FETCH_RANK);
  }

  /**
   * The first band of `fetch_rank` whose matches must wait now, up to the back of the queue
   * (null: none): every Diamond player's when it is not tier 3's turn, those of the other
   * Diamond players (3b) when the players seen in a Master+ game still have something waiting.
   */
  private async matchesHeldFrom(): Promise<number | null> {
    if (!(await this.diamondTurn())) return DIAMOND_FETCH_RANK;
    if (!(await this.diamondWithMasterDone())) return DIAMOND_ONE_FETCH_RANK;
    return null;
  }

  /**
   * The three tiers have nothing waiting: no listing waiting or running (of a tracked player or
   * of an outside Master), at most `expandBelowPendingMatches` matches PENDING (retried and
   * deferred ones aside).
   */
  private async nothingWaiting(): Promise<boolean> {
    if (!this.patches.ready || !this.apexComplete()) return false;
    if (this.listingInFlight.size > 0) return false;
    if (this.peekPlayedPlayer() !== null) return false;
    if (!(await this.outsideTierDone())) return false;
    return this.fewPendingMatchesBefore(QUEUE_BACK_RANK);
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
  // Tier 3: the Diamond target (`diamondMaxTracked` > 0)
  // -------------------------------------------------------------------------

  /**
   * The Diamond target of this platform and its history (`diamond_tracking`), read once. On the
   * very first start it is the number of Diamond players tracked so far. A target above the
   * ceiling comes down to it. After a stop of more than one ladder interval, the backlog of the
   * stop is given `diamondSettleCycles` cycles before cycles count again.
   */
  private diamondState(): Promise<DiamondTracking> {
    this.diamond.loading ??= this.loadDiamondState().catch((err) => {
      this.diamond.loading = null;
      throw err;
    });
    return this.diamond.loading;
  }

  private async loadDiamondState(): Promise<DiamondTracking> {
    if (!this.ladderLoaded) await this.loadLadderOrder();
    const cap = this.opts.diamondMaxTracked;
    const now = this.clock.now();
    const settle = this.opts.diamondSettleCycles;
    const stored = await getDiamondTracking(this.db, this.platform);
    let state: DiamondTracking;
    let changed = false;
    if (stored === null) {
      const tracked = this.diamond.tracked.length;
      state = {
        target: Math.min(tracked, cap),
        cycles: '',
        lastCycleAt: null,
        // Their first listings may still be waiting.
        settleCyclesLeft: tracked > 0 ? settle : 0,
        changedAt: new Date(now),
        changedFrom: null,
        changeReason: `first start: ${tracked} Diamond players were tracked`,
        shrunkAt: null,
      };
      changed = true;
    } else {
      state = stored;
      if (state.target > cap) {
        state = {
          ...state,
          target: cap,
          cycles: '',
          changedAt: new Date(now),
          changedFrom: stored.target,
          changeReason: 'above the ceiling (DIAMOND_MAX_TRACKED)',
        };
        changed = true;
      }
      const status = (await listWorkerStatus(this.db)).find((w) => w.platform === this.platform);
      const stoppedFor = status ? now - status.heartbeatAt.getTime() : 0;
      if (stoppedFor > this.opts.ladderIntervalMs && state.settleCyclesLeft < settle) {
        state = { ...state, settleCyclesLeft: settle };
        changed = true;
        this.log.info('diamond target: settling after a stop', { stoppedForMs: stoppedFor });
      }
    }
    if (changed) await saveDiamondTracking(this.db, this.platform, state, new Date(now));
    this.diamond.state = state;
    return state;
  }

  /**
   * Start of a ladder cycle (before the hourly refresh and sweep): the cycle that ends is
   * recorded, and the Diamond target grows or shrinks a step when its history says so
   * (`nextDiamondTarget`); the sweep that follows applies it.
   *
   * Growing brings a burst of first listings. So that it is not taken for "not keeping up", the
   * history starts over at each change and, after a growth step, cycles are not recorded until
   * the three tiers have nothing waiting again (at most `diamondSettleCycles` cycles that would
   * have been missed ones): the next change is decided on cycles that ran at the new size, after
   * the burst.
   */
  async startBudgetCycle(): Promise<void> {
    if (this.opts.diamondMaxTracked <= 0) return;
    const state = await this.diamondState();
    const cycle = this.diamond.cycle;
    if (cycle !== null) {
      await this.noteKeepingUp();
      if (!cycle.kept) {
        const outcome: CycleOutcome = cycle.patch ? 'W' : 'M';
        if (state.settleCyclesLeft === 0) {
          await this.recordCycle(cycle, outcome);
        } else if (outcome === 'M') {
          // Settling: not recorded. A cycle without patch data does not use up the time to settle.
          state.settleCyclesLeft -= 1;
          await this.saveDiamondState();
        }
      }
    }
    await this.adjustDiamondTarget();
    this.diamond.cycle = { startedAt: this.clock.now(), kept: false, patch: false };
  }

  /**
   * Looks at the cycle in progress (every `expansionCheckMs`): the first time the three tiers
   * have nothing waiting, the cycle is recorded as kept up with. Also notes what excuses a cycle
   * that is not: matches waiting for patch data. Tier 2 has no excuse of its own any more: its
   * listings are spread over the day (only the players whose counter moved), so an hour in which
   * tiers 1 and 2 leave nothing to the Diamond players is an hour the platform did not keep up.
   */
  async noteKeepingUp(): Promise<void> {
    const cycle = this.diamond.cycle;
    if (this.opts.diamondMaxTracked <= 0 || cycle === null || cycle.kept) return;
    await this.diamondState();
    if (!this.patches.ready || this.tooNewMinGameId !== null) {
      cycle.patch = true;
      return;
    }
    if (!(await this.nothingWaiting())) return;
    cycle.kept = true;
    await this.recordCycle(cycle, 'K');
  }

  /**
   * Adds a cycle to the history. A cycle that started less than a ladder interval after the last
   * recorded one is the same cycle (the worker restarted, or the refresh was retried): it only
   * turns that one into a kept cycle. A kept cycle ends the settling after a growth step.
   */
  private async recordCycle(cycle: BudgetCycle, outcome: CycleOutcome): Promise<void> {
    const state = await this.diamondState();
    if (outcome === 'K') state.settleCyclesLeft = 0;
    const sameCycle =
      state.cycles !== '' &&
      state.lastCycleAt !== null &&
      cycle.startedAt - state.lastCycleAt.getTime() < this.opts.ladderIntervalMs;
    if (sameCycle) {
      if (outcome !== 'K' || state.cycles.endsWith('K')) return;
      state.cycles = `${state.cycles.slice(0, -1)}K`;
    } else {
      state.cycles = (state.cycles + outcome).slice(-MAX_RECORDED_CYCLES);
      state.lastCycleAt = new Date(cycle.startedAt);
    }
    await this.saveDiamondState();
  }

  private async saveDiamondState(): Promise<void> {
    const state = await this.diamondState();
    await saveDiamondTracking(this.db, this.platform, state, new Date(this.clock.now()));
  }

  /** Grows or shrinks the Diamond target a step when its history says so. */
  private async adjustDiamondTarget(): Promise<void> {
    const state = await this.diamondState();
    const now = this.clock.now();
    const fast =
      this.opts.diamondFastGrowCycles > 0 &&
      (state.shrunkAt === null ||
        now - state.shrunkAt.getTime() >= this.opts.diamondFastGrowAfterShrinkMs);
    const next = nextDiamondTarget(
      state.cycles,
      { target: state.target, tracked: this.diamond.tracked.length },
      {
        cap: this.opts.diamondMaxTracked,
        step: this.opts.diamondStep,
        // Fast start until the first shrink (and again long after the last one).
        growCycles: fast ? this.opts.diamondFastGrowCycles : this.opts.diamondGrowCycles,
        growMinKeptCycles: fast
          ? this.opts.diamondFastGrowCycles
          : this.opts.diamondGrowMinKeptCycles,
        shrinkMissedCycles: this.opts.diamondShrinkMissedCycles,
      },
    );
    if (next === null) return;
    const from = state.target;
    const grows = next.target > from;
    if (!grows) state.shrunkAt = new Date(now);
    this.log.info(grows ? 'diamond target grows' : 'diamond target shrinks', {
      from,
      to: next.target,
      reason: next.reason,
      cycles: state.cycles.slice(-this.opts.diamondGrowCycles),
      fastStart: fast,
    });
    state.target = next.target;
    state.cycles = '';
    state.settleCyclesLeft = grows ? this.opts.diamondSettleCycles : 0;
    state.changedAt = new Date(this.clock.now());
    state.changedFrom = from;
    state.changeReason = next.reason;
    await this.saveDiamondState();
  }

  /**
   * Reads the four Diamond divisions page by page and tracks the best candidates, as many as the
   * target says (`diamond_tracking`, at most `diamondMaxTracked`): first (3a) those seen in a
   * Master+ game during `diamondWithMasterWindowMs`, whatever their division, by division then
   * LP; then (3b) every other Diamond player by division (I down to IV) then LP. Marks who played; returns how many
   * (null: tracking is off, or Riot answered with no player at all and nothing was changed).
   *
   * On the way, each page's tier, division, LP and counters are stored for the players already
   * known (`updateKnownPlayerRanks`), so enrichment does not ask for them again; that part is
   * kept even when the sweep fails later (each page is true when it is read).
   *
   * A page that fails throws and nothing is changed: nobody is removed nor taken as "did not
   * play". A tracked player the sweep did not see (moved between pages meanwhile, promoted,
   * decayed) is kept as is, until the last sweep that saw them is `diamondKeepMs` old; one who is
   * on Riot's apex lists now is left to the apex ladder. A player who is no longer among the
   * best (the target shrank, others passed them) leaves `ladder_entries` like any player leaving
   * the ladder, and is no longer waiting for a listing.
   */
  async refreshDiamonds(signal?: AbortSignal): Promise<number | null> {
    const cap = this.opts.diamondMaxTracked;
    if (cap <= 0) return null;
    if (!this.ladderLoaded) await this.loadLadderOrder();
    const target = Math.min((await this.diamondState()).target, cap);
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
    // A sweep is up to 140,000 entries. Only those who can end up tracked are kept in memory:
    // the players seen in a Master+ game and the tracked ones, and of the other Diamond players
    // the best by division then LP, as many as the target (and a margin for players seen twice).
    const first: DiamondEntry[] = [];
    const others = new BestDiamonds(target + this.opts.diamondStep);
    this.diamond.ranksWritten = 0;
    const seen = await this.sweepDiamond((e) => {
      if (this.apexPuuids.has(e.puuid)) return;
      if (seenWithMaster.has(e.puuid) || storedPuuids.has(e.puuid)) first.push(e);
      else others.add(e);
    }, signal);
    if (seen.every((n) => n === 0)) {
      this.log.warn('empty Diamond sweep from Riot, not applied');
      return null;
    }
    const now = this.clock.now();
    // A player seen twice (moved between pages or divisions meanwhile) keeps the latest entry.
    const swept = new Map<string, DiamondEntry>();
    for (const e of [...first, ...others.values()]) {
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
    const selection = selectDiamondPlayers(candidates, seenWithMaster, target);
    const tracked = selection.tracked;

    const result = await upsertDiamondLadder(
      this.db,
      this.platform,
      tracked.filter((e) => !missing.has(e.puuid)).map(toDiamondLadderEntry),
      { keep: tracked.filter((e) => missing.has(e.puuid)).map((e) => e.puuid), now: new Date(now) },
    );
    const before = this.diamond.tracked;
    this.diamond.tracked = tracked;
    this.diamond.seen = seen;
    this.diamond.withMaster = selection.withMaster;
    this.applyLadderOrder();
    // Players who are no longer tracked are not listed any more.
    for (const d of before) {
      if (this.ladderRank.has(d.puuid)) continue;
      this.played.delete(d.puuid);
      this.listingCooldown.delete(d.puuid);
      this.listingFailures.delete(d.puuid);
    }
    for (const p of result.played) this.played.add(p);
    await this.loadPendingListings();
    // A Master outside Riot's list the sweep saw in Diamond is not one any more.
    await this.refreshOutsideMasters();
    this.log.info('diamond sweep applied', {
      seen,
      ranksStored: this.diamond.ranksWritten,
      tracked: tracked.length,
      withMaster: selection.withMaster,
      target,
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
   * Reads the four Diamond divisions, side by side: hands every entry to `collect`, returns how
   * many each division has. Throws as soon as one page fails.
   */
  private async sweepDiamond(
    collect: (e: DiamondEntry) => void,
    signal?: AbortSignal,
  ): Promise<[number, number, number, number]> {
    const stop = new AbortController();
    const linked = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const results = await Promise.allSettled(
      DIVISIONS.map(async (division, i) => {
        try {
          return await this.sweepDivision(division, i + 1, collect, linked);
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
    return [seen[0] ?? 0, seen[1] ?? 0, seen[2] ?? 0, seen[3] ?? 0];
  }

  /**
   * The pages of one division, from 1 until an empty one: hands the entries to `collect`,
   * returns how many entries the division has.
   */
  private async sweepDivision(
    division: Division,
    number: number,
    collect: (e: DiamondEntry) => void,
    signal: AbortSignal,
  ): Promise<number> {
    let seen = 0;
    for (let page = 1; page <= MAX_DIAMOND_PAGES; page++) {
      if (signal.aborted) throw abortError();
      const entries = await this.riot.getDiamondEntries(this.platform, division, page, signal);
      if (entries.length === 0) return seen;
      const seenAt = this.clock.now();
      const players = toDiamondEntries(entries, number, seenAt);
      for (const e of players) {
        seen++;
        collect(e);
      }
      await this.storeSweptRanks(players, seenAt);
    }
    throw new Error(`Diamond ${division} did not end after ${MAX_DIAMOND_PAGES} pages`);
  }

  /**
   * Stores the rank of the players of a Diamond page that are already known (not the players of
   * Riot's apex lists: a player may be on both for a moment). Only what changed is written, and
   * a rank that would otherwise get older than half of `enrichmentRankFreshMs`. A failure here
   * never fails the sweep.
   */
  private async storeSweptRanks(players: readonly DiamondEntry[], seenAt: number): Promise<void> {
    try {
      this.diamond.ranksWritten += await updateKnownPlayerRanks(
        this.db,
        this.platform,
        players.filter((e) => !this.apexPuuids.has(e.puuid)),
        new Date(seenAt),
        new Date(seenAt - this.opts.enrichmentRankFreshMs / 2),
      );
    } catch (err) {
      this.log.warn('ranks of a Diamond page not stored', { error: errorMessage(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Listings: match ids
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

  /**
   * The player to list next whose tier may be listed now: an apex player always, a Diamond
   * player seen in a Master+ game only when it is tier 3's turn, another Diamond player (3b, or one
   * who left the tracked ladder) only when those have nothing waiting either.
   */
  private async peekListablePlayer(): Promise<string | null> {
    const next = this.peekPlayedPlayer();
    if (next === null || this.isApex(next)) return next;
    const turn = this.isDiamondWithMaster(next) ? this.diamondTurn() : this.diamondOneTurn();
    return (await turn) ? next : null;
  }

  private async nextPlayedPlayer(): Promise<string | null> {
    const next = await this.peekListablePlayer();
    return next !== null && this.takePlayedPlayer(next) ? next : null;
  }

  /**
   * `nextPlayedPlayer` for the skip rule ('shadow' and 'on'): the player is only handed out once
   * no match queued by a better-placed player is still to be fetched, so that whether their new
   * games are stored is decided on everything the players before them brought. Matches queued by
   * players below them and retried or deferred ones (all with a higher `fetch_rank`) are not
   * waited for: a backlog of those never delays a listing. An apex player never waits for a match
   * of tier 2 or 3 (their bands come after every apex position); a Diamond player waits for the
   * matches of the tiers above too. Neither does a match that stays unfetched hold anyone: after
   * `listingGateMaxWaitMs` the player is listed anyway.
   */
  private async nextPlayedPlayerAfterMatches(signal: AbortSignal): Promise<string | null> {
    let waitingSince: number | null = null;
    for (;;) {
      const next = await this.peekListablePlayer();
      if (next === null) return null;
      const now = this.clock.now();
      waitingSince ??= now;
      const open =
        now - waitingSince >= this.opts.listingGateMaxWaitMs ||
        !(await hasPendingMatchBefore(
          this.db,
          this.platform,
          Math.min(this.rankOf(next), QUEUE_BACK_RANK),
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
   * all stored already (`listWithSkipRule`).
   */
  async listTrackedPlayer(puuid: string, signal?: AbortSignal): Promise<'listed' | 'skipped'> {
    // This listing answers the player's request (the loops have taken it out already).
    this.played.delete(puuid);
    return this.listWithSkipRule(puuid, this.isApex(puuid) ? 'apex' : 'diamond', signal);
  }

  /**
   * Lists a Master outside Riot's list whose counter moved (tier 2), unless the skip rule says
   * their new games are all stored already. Same rule as for a tracked player, on the counters
   * of their checks: the snapshot of a counter is the moment the check that first saw it was
   * answered.
   */
  async listOutsideMaster(puuid: string, signal?: AbortSignal): Promise<'listed' | 'skipped'> {
    try {
      return await this.listWithSkipRule(puuid, 'outsideMaster', signal);
    } finally {
      // One fewer is waiting: read again whether anyone is left.
      this.outsideDue = null;
    }
  }

  /**
   * Lists a player whose counter says they played, unless the skip rule says their new games are
   * all stored already (`listingSkip`):
   *
   * - 'off': always listed.
   * - 'on': when the rule holds (`checkListingSkip`), the listing request is cleared without
   *   calling Riot; `matches_synced_until` and the baseline stay, so the next real listing still
   *   covers the whole period and the counts stay cumulative.
   * - 'shadow': always listed. When the rule holds the baseline stays, as in 'on', and if the
   *   listing queued new match ids they are recorded in `listing_skip_misses`.
   *
   * A real listing the rule did not hold for sets the baseline: the counters it was decided on,
   * and now.
   */
  private async listWithSkipRule(
    puuid: string,
    group: ListingGroup,
    signal?: AbortSignal,
  ): Promise<'listed' | 'skipped'> {
    const outside = group === 'outsideMaster';
    const mode = this.opts.listingSkip;
    if (mode === 'off') {
      await this.listPlayerMatches(puuid, signal, outside);
      return 'listed';
    }
    const checkedAt = this.clock.now();
    const check = await this.checkListingSkip(puuid, group, checkedAt);
    if (check.explained && mode === 'on') {
      await clearListingRequest(this.db, puuid, check.state.snapshotAt);
      this.counters.listingsSkipped++;
      this.log.debug('listing skipped', { group, expected: check.expected, stored: check.stored });
      return 'skipped';
    }
    const newIds: string[] = [];
    await this.listPlayerMatches(puuid, signal, outside, newIds);
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
      const baseline = {
        games: check.state.gamesNow,
        snapshotAt: check.state.snapshotAt,
        listedAt: new Date(checkedAt),
      };
      if (outside) await setOutsideMasterBaseline(this.db, puuid, baseline);
      else await setListingBaseline(this.db, puuid, baseline);
    }
    return 'listed';
  }

  /**
   * The skip rule for a player about to be listed. With `games_now` the player's wins + losses,
   * `snapshot` when they were first seen (the ladder refresh that produced them; for an outside
   * Master, the answer of the check that did), and the baseline of their last real listing
   * (`listed_games` at `listed_snapshot_at`, run at `listed_at`): `explained` when
   * `expected = games_now - listed_games` is positive and at least that many stored non-remake
   * matches of the player ended after `listed_snapshot_at` and at least `listingSkipLadderLagMs`
   * before `snapshot`. Never without a baseline, when the counters went down (season reset), or
   * when `listed_at` is as old as the safety interval of the player's group
   * (`listingSkipSafetyMs`: a game Riot never counted would otherwise hide a later one for ever).
   * A game that ended after the snapshot, or too shortly before it for Riot to have counted it,
   * may not be in `games_now`, so it must not stand for an older missing one; counting too few
   * only costs a listing.
   */
  private async checkListingSkip(
    puuid: string,
    group: ListingGroup,
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
    const state =
      group === 'outsideMaster'
        ? await getOutsideMasterSkipState(this.db, puuid)
        : await getListingSkipState(this.db, puuid);
    if (state === null) return { explained: false, state };
    const { gamesNow, snapshotAt, listedGames, listedSnapshotAt, listedAt } = state;
    if (listedGames === null || listedSnapshotAt === null || listedAt === null) {
      return { explained: false, state };
    }
    if (listedAt.getTime() <= now - this.opts.listingSkipSafetyMs[group]) {
      return { explained: false, state };
    }
    const expected = gamesNow - listedGames;
    if (expected <= 0) return { explained: false, state };
    // Games that ended in the last minutes before the snapshot may not be in its counters.
    const countedBy = new Date(snapshotAt.getTime() - this.opts.listingSkipLadderLagMs);
    const stored = await countStoredGamesEndedBetween(this.db, puuid, listedSnapshotAt, countedBy);
    if (stored < expected) return { explained: false, state };
    return { explained: true, state, listedSnapshotAt, expected, stored };
  }

  /**
   * Lists a player's ranked match ids since `matches_synced_until`; returns how many were new
   * (and adds them to `newIds`). The request and the matches it queues take the priority of the
   * player's tier: an apex player's ladder position, then the Masters outside Riot's list
   * (`extra`), then the Diamond players seen in a Master+ game, then the other Diamond players.
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
    const priority = extra
      ? PRIORITY.EXTRA_MATCH_IDS
      : this.isApex(puuid)
        ? undefined
        : this.isDiamondWithMaster(puuid)
          ? PRIORITY.DIAMOND_MATCH_IDS
          : PRIORITY.DIAMOND_ONE_MATCH_IDS;
    let added = 0;
    for (let start = 0; ; start += 100) {
      const ids = await this.riot.getMatchIds(
        this.platform,
        puuid,
        {
          startTime: Math.floor(startMs / 1000),
          start,
          count: 100,
          ...(priority !== undefined ? { priority } : {}),
        },
        signal,
      );
      // Ids come newest first: once one is known to be from an older patch, the rest are too.
      // Only this platform's ids are comparable with the bound (game ids are per platform, and a
      // regional cluster lists the other platforms' matches too).
      const own = ids.filter((id) => platformFromMatchId(id) === this.platform);
      const oldAt = own.findIndex((id) => this.isKnownOldPatch(gameIdOf(id)));
      const kept = oldAt >= 0 ? own.slice(0, oldAt) : own;
      const fetchRank = extra ? EXTRA_FETCH_RANK : this.rankOf(puuid);
      const queued = await enqueueNewMatchIds(this.db, this.platform, kept, fetchRank);
      added += queued.length;
      newIds?.push(...queued);
      // The match loops must not first work through what they had already claimed: these may be
      // of a better tier, and the skip rule wants a tracked player's matches before the next
      // players are decided (a probe is left alone).
      if (queued.length > 0 && !this.probe.active) this.matchSource.clear();
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
  // Matches: match + timeline
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

    // The match request waits behind the tiers above; once it is granted the match is finished
    // (the timeline keeps the first tier's priority), so the loop is soon free again.
    const priority =
      this.probe.inFlight === matchId ? PRIORITY.MATCH : matchPriority(queued.fetchRank);
    const match = await this.riot.getMatch(this.platform, matchId, signal, priority);
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
  // The Masters outside Riot's list: checks of their own entry (platform host)
  // -------------------------------------------------------------------------

  /** Checks an hour's allowance can hold at most: half an hour's worth. */
  private checkBudgetCapacity(): number {
    return Math.max(
      this.opts.outsideCheckMaxPerHour > 0 ? 1 : 0,
      this.opts.outsideCheckMaxPerHour / 2,
    );
  }

  /** What is left of the allowance of checks now (it fills at `outsideCheckMaxPerHour`). */
  private checksAllowed(): number {
    const now = this.clock.now();
    const budget = this.checkBudget;
    const earned = (Math.max(0, now - budget.at) * this.opts.outsideCheckMaxPerHour) / HOUR;
    budget.tokens = Math.min(this.checkBudgetCapacity(), budget.tokens + earned);
    budget.at = now;
    return budget.tokens;
  }

  /**
   * The next outside Master to check: the least recently checked (never checked first), once
   * every Master of Riot's list is tracked, while the allowance of the hour is not used up.
   */
  private async nextOutsideCheck(): Promise<string | null> {
    if (!this.apexComplete() || this.checksAllowed() < 1) return null;
    // Taken before waiting for the database, so two loops never share one; given back if unused.
    this.checkBudget.tokens -= 1;
    const next = await this.outsideCheckSource.next();
    if (next === null) this.checkBudget.tokens += 1;
    return next;
  }

  /**
   * Asks for the solo queue entry of a Master outside Riot's list (platform host, last: after the
   * ladder lists, the Diamond sweep, the mastery refresh and enrichment) and stores what it says
   * (`recordOutsideMasterCheck`): their rank, and whether their wins + losses moved since the
   * last check, in which case a listing is requested (tier 2). A first check has nothing to
   * compare: it is the starting counter when the player's match ids were listed within the
   * safety interval of the skip rule (by the daily pass of the previous version, or as a tracked
   * player), and asks for one listing otherwise. A player who is no longer Master or above
   * leaves the set.
   *
   * The snapshot of the counter is the moment Riot answered, not when the request was made (it
   * may have waited for the host's budget): a game that ended before it may still be missing
   * from the counter, never one that ended after. A failed check sends the player to the back
   * of the rotation, a 401/403 included: alone it is that player's failure, not a rejected key
   * (three in a row, or a key another request has seen rejected, pause the platform as usual).
   */
  async checkOutsideMaster(puuid: string, signal?: AbortSignal): Promise<OutsideMasterCheck> {
    let entries: LeagueEntryDto[] | null;
    try {
      entries = await this.riot.getLeagueEntries(
        this.platform,
        puuid,
        PRIORITY.OUTSIDE_MASTER_CHECK,
        signal,
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      await deferOutsideMasterCheck(this.db, puuid, new Date(this.clock.now()));
      // Riot answers 403 for some players whatever the key: that fails this check, it must not
      // pause the platform every time the rotation comes back to them. A key that is really
      // rejected shows on every request: another kind of work has seen it already, or the checks
      // are refused one after the other.
      if (err instanceof RiotAuthError) {
        throw this.playerRequestRefused(err, 'league entry of an outside Master');
      }
      throw err;
    }
    this.playerRequestsRefused = 0;
    const now = this.clock.now();
    const safety = this.opts.listingSkipSafetyMs.outsideMaster;
    const outcome = await recordOutsideMasterCheck(this.db, puuid, toSoloRank(entries ?? []), {
      now: new Date(now),
      // `matches_synced_until` is `listingOverlapMs` before the listing itself.
      listedSince: new Date(now - safety - this.opts.listingOverlapMs),
    });
    this.counters.outsideMasterChecks++;
    if (outcome === 'played' || outcome === 'first-listing') this.outsideDue = null;
    this.log.debug('outside Master checked', { outcome });
    return outcome;
  }

  /**
   * The next outside Master to list, when it is tier 2's turn. With the skip rule (`afterMatches`)
   * the player is only handed out once the matches queued by the apex players and by the outside
   * Masters listed before are fetched (at most `listingGateMaxWaitMs` later), so that whether
   * their new games are stored is decided on everything those brought.
   */
  private async nextOutsideListing(
    signal: AbortSignal,
    afterMatches: boolean,
  ): Promise<string | null> {
    let waitingSince: number | null = null;
    for (;;) {
      if (!(await this.canListOutsideMasters())) return null;
      if (!afterMatches) return this.outsideListSource.next();
      if (!(await this.outsideListingWaiting())) return null;
      const now = this.clock.now();
      waitingSince ??= now;
      const open =
        now - waitingSince >= this.opts.listingGateMaxWaitMs ||
        !(await hasPendingMatchBefore(this.db, this.platform, DIAMOND_FETCH_RANK));
      if (open) return this.outsideListSource.next();
      await Promise.race([
        this.matchSettled.promise,
        this.clock.sleep(this.opts.listingGatePollMs, signal),
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // Mastery refresh of tracked players
  // -------------------------------------------------------------------------

  /** Fetches a tracked player's masteries again (due every `masteryRefreshIntervalMs`). */
  async dailyRefresh(c: DailyRefreshCandidate, signal?: AbortSignal): Promise<void> {
    let masteries: Awaited<ReturnType<RiotApi['getMasteries']>>;
    try {
      masteries = await this.riot.getMasteries(
        this.platform,
        c.puuid,
        PRIORITY.DAILY_REFRESH,
        signal,
      );
    } catch (err) {
      // The player waits an hour (the loop's cooldown), the platform does not pause.
      if (err instanceof RiotAuthError) throw this.playerRequestRefused(err, 'masteries');
      throw err;
    }
    this.playerRequestsRefused = 0;
    await replaceMasteries(
      this.db,
      c.puuid,
      toMasteries(masteries ?? []),
      new Date(this.clock.now()),
    );
    this.counters.dailyRefreshed++;
  }

  // -------------------------------------------------------------------------
  // Enrichment of non-ladder players
  // -------------------------------------------------------------------------

  /**
   * Masteries of a queued player, and their rank unless the stored one was refreshed less than
   * `enrichmentRankFreshMs` ago (by the Diamond sweep, a check, a ladder or a previous
   * enrichment): one request instead of two for most players.
   */
  async enrich(e: QueuedEnrichment, signal?: AbortSignal): Promise<void> {
    try {
      const masteries = await this.riot.getMasteries(
        this.platform,
        e.puuid,
        PRIORITY.ENRICHMENT,
        signal,
      );
      const rankAt = await getRankRefreshedAt(this.db, e.puuid);
      const rankFresh =
        rankAt !== null && this.clock.now() - rankAt.getTime() < this.opts.enrichmentRankFreshMs;
      const entries = rankFresh
        ? null
        : await this.riot.getLeagueEntries(this.platform, e.puuid, PRIORITY.ENRICHMENT, signal);
      const now = new Date(this.clock.now());
      // One transaction: a match of this player stored meanwhile waits for it (the player's row)
      // and, if it brings a champion without a mastery row, queues the player again.
      await inTransaction(this.db, async (tx) => {
        await replaceMasteries(tx, e.puuid, toMasteries(masteries ?? []), now);
        if (!rankFresh) await updatePlayerRank(tx, e.puuid, toSoloRank(entries ?? []), now);
        await completeEnrichment(tx, e.puuid);
      });
      this.playerRequestsRefused = 0;
      this.counters.enriched++;
      if (rankFresh) this.counters.enrichedRankFresh++;
    } catch (err) {
      if (isAbortError(err)) throw err;
      // A refusal for this player fails their enrichment (dropped after three tries) instead of
      // pausing the platform each time the queue comes back to them.
      const failure =
        err instanceof RiotAuthError
          ? this.playerRequestRefused(err, 'masteries / rank of a queued player')
          : err;
      if (failure instanceof RiotAuthError) throw failure;
      await failEnrichment(this.db, e.puuid, errorMessage(failure));
      throw failure;
    }
  }

  // -------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------

  /** Runs every loop until `signal` aborts; resolves once in-flight work has finished. */
  async start(signal: AbortSignal): Promise<void> {
    await this.loadLadderOrder();
    // Before the first heartbeat: it reads how long the worker was stopped.
    if (this.opts.diamondMaxTracked > 0) await this.diamondState();
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
          () => this.nextMatch(),
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
    for (let i = 0; i < c.outsideCheck; i++) {
      loops.push(
        this.workLoop(
          'outside check',
          signal,
          () => this.nextOutsideCheck(),
          async (p) => {
            await this.checkOutsideMaster(p, signal);
            return 'ok';
          },
          (p) => this.outsideCheckSource.release(p),
        ),
      );
    }
    for (let i = 0; i < c.outsideListing; i++) {
      loops.push(
        this.workLoop(
          'outside listing',
          signal,
          () => this.nextOutsideListing(signal, afterMatches),
          async (p) => {
            try {
              await this.listOutsideMaster(p, signal);
              return 'ok';
            } catch (err) {
              if (!isAbortError(err)) this.outsideListCooldown.set(p, this.clock.now() + HOUR);
              throw err;
            }
          },
          (p) => {
            this.outsideListSource.release(p);
            this.outsideDue = null;
          },
        ),
      );
    }
    await Promise.all(loops);
    await this.closeRun();
    await this.statusWrites;
  }

  /**
   * The next queued match for a match loop. A Diamond player's match is only handed out when it
   * is its turn: tier 3's, and for a 3b player's when the players seen in a Master+ game
   * have nothing waiting either (checked again here: what was claimed a moment ago may have to
   * wait now); otherwise the queue is read again without them.
   */
  private async nextMatch(): Promise<QueuedMatch | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const m = await this.matchSource.next();
      if (m === null || this.probe.inFlight === m.matchId) return m;
      const rank = m.fetchRank ?? 0;
      if (rank < DIAMOND_FETCH_RANK || rank >= QUEUE_BACK_RANK) return m;
      const turn = rank < DIAMOND_ONE_FETCH_RANK ? this.diamondTurn() : this.diamondOneTurn();
      if (await turn) return m;
      this.matchSource.release(m);
      this.matchSource.clear();
    }
    return null;
  }

  /** Tier 2 for the `progress` log: the outside Masters, their checks and who waits for a listing. */
  private async outsideMastersProgress(): Promise<OutsideMastersProgress | null> {
    if (!this.followsOutsideMasters()) return null;
    const now = this.clock.now();
    const stats = await outsideMasterStats(this.db, this.platform, new Date(now - HOUR));
    return {
      followed: stats.followed,
      checkedLastHour: stats.checkedSince,
      neverChecked: stats.neverChecked,
      oldestCheckMinutes:
        stats.oldestCheckAt === null
          ? null
          : Math.round((now - stats.oldestCheckAt.getTime()) / 60_000),
      toList: stats.toList,
      matchesWaiting: await countPendingMatchesInBand(
        this.db,
        this.platform,
        { from: EXTRA_FETCH_RANK, below: DIAMOND_FETCH_RANK },
        1_000_000,
      ),
    };
  }

  private async diamondProgress(): Promise<DiamondProgress | null> {
    if (this.opts.diamondMaxTracked <= 0) return null;
    const state = await this.diamondState();
    const cycles = state.cycles.slice(-this.opts.diamondGrowCycles);
    return {
      seen: this.diamond.seen,
      tracked: this.diamond.tracked.length,
      trackedWithMaster: this.diamond.withMaster,
      target: state.target,
      cap: this.opts.diamondMaxTracked,
      cycles,
      keptCycles: cycles.split('K').length - 1,
      settleCyclesLeft: state.settleCyclesLeft,
      lastChange: state.changedAt
        ? {
            at: state.changedAt.toISOString(),
            from: state.changedFrom,
            reason: state.changeReason,
          }
        : null,
    };
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
      outsideMasters: await this.outsideMastersProgress(),
      diamond: await this.diamondProgress(),
    };
  }

  /**
   * Refreshes the ladder every `ladderIntervalMs` (5 min after a failure), then sweeps the Diamond
   * divisions when they are tracked (a cycle; the Diamond target is adjusted at its start), and in
   * between checks every `expansionCheckMs` whether the platform is keeping up and whether to
   * track more Master players.
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
          await this.startBudgetCycle();
          await this.refreshLadder(signal);
          await this.refreshDiamondsOfCycle(signal);
        } else {
          await this.noteKeepingUp();
          if (await this.canTrackMoreMasters()) await this.trackMoreMasters(signal);
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

  /**
   * A 401/403 on a request about one player: the error to throw. Riot answers 403 for some
   * players whatever the key, so that fails only this player's item, and the platform does not
   * pause each time a queue comes back to them. A key that is really rejected shows on every
   * request: another kind of work has seen it already, or three per-player requests are refused
   * in a row; then it is the key's error (the platform pauses).
   */
  private playerRequestRefused(err: RiotAuthError, what: string): Error {
    this.playerRequestsRefused += 1;
    if (this.authState === 'rejected' || this.playerRequestsRefused >= 3) return err;
    return new Error(`${what} refused for this player (HTTP ${err.status})`);
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
