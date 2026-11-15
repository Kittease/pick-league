/**
 * Live game lookups (docs/architecture.md, "Live game lookups"): players of a game in progress
 * that the desktop asked about through the API. They are served above every crawl level
 * (`PRIORITY.LIVE_LOOKUP`), because someone is waiting for them.
 *
 * First the game (`live_games`): the League client's player ids are not the Riot API's, so the
 * desktop only sends the user's own Riot ID. account-v1 gives the user's puuid, spectator-v5 the
 * game and every participant's puuid; the players are then queued as lookups right away.
 *
 * Per player: league entries + mastery of the champion played (platform host, so every rank
 * shows within seconds), then the ids of the last `recentMatches` ranked solo matches and those
 * matches (match cluster: the slow part, 100 requests / 2 min). Matches already stored by the
 * crawler, or by a previous lookup of the player, or fetched for another looked-up player (duo
 * partners share matches), are not fetched again. Fetched matches are only summarised for the
 * player: they never go into the stats tables.
 *
 * Puuids are never logged; Riot error messages (whose paths contain them) are redacted.
 */
import {
  claimLiveGames,
  claimLiveLookups,
  type Db,
  failLiveGame,
  failLiveLookup,
  finishLiveLookup,
  type LiveGameJob,
  type LiveGameParticipant,
  type LiveLookupJob,
  type LiveRecentMatch,
  purgeLiveGames,
  purgeLiveLookups,
  requestLiveLookups,
  storedRecentMatches,
  storeLiveGame,
  storeLiveMastery,
  storeLiveRank,
  storeLiveRecent,
} from '@pick-league/db';
import { type MatchDto, type Platform, parsePosition } from '@pick-league/shared';
import type { Clock } from '../clock.ts';
import { errorMessage, type Logger } from '../log.ts';
import { durationSeconds, isRemakeMatch } from '../parser/parse-match.ts';
import { PRIORITY, type RiotApi } from '../riot/client.ts';
import { toSoloRank } from '../riot/ranks.ts';
import { classifyError, type ErrorKind } from './errors.ts';

const DAY = 86_400_000;

export interface LiveLookupOptions {
  /** Most recent ranked solo matches looked at per player (default 10). */
  recentMatches: number;
  /** Players whose recent matches are fetched at the same time (default 2): finished one by one. */
  playerConcurrency: number;
  /** How often PENDING lookups are polled for (default 1 s). */
  pollMs: number;
  /** Lookups not requested for this long are deleted (default 1 day). */
  purgeAfterMs: number;
  /** A lookup becomes FAILED on this attempt, by error kind. */
  maxAttempts: Record<'transient' | 'deterministic' | 'unknown', number>;
  /** A lookup that hit an error is retried after this, doubling with each attempt (default 5 s). */
  retryMs: number;
  /** Riot not showing the game yet (spectator 404) is asked again after this (default 10 s)… */
  gameNotFoundRetryMs: number;
  /** …up to this many times, then the game is FAILED as not found (default 12: two minutes). */
  gameNotFoundAttempts: number;
}

export const DEFAULT_LIVE_LOOKUP_OPTIONS: LiveLookupOptions = {
  recentMatches: 10,
  playerConcurrency: 2,
  pollMs: 1_000,
  purgeAfterMs: DAY,
  maxAttempts: { transient: 5, deterministic: 2, unknown: 3 },
  retryMs: 5_000,
  gameNotFoundRetryMs: 10_000,
  gameNotFoundAttempts: 12,
};

export interface LiveLookupDeps {
  platform: Platform;
  db: Db;
  riot: RiotApi;
  clock: Clock;
  log: Logger;
  options?: Partial<LiveLookupOptions>;
  /** Riot rejected the key: the worker pauses (the lookup stays PENDING). */
  onAuthError(err: unknown): void;
  /** A lookup failed (message already redacted), for `worker_status`. */
  onError(message: string): void;
}

/** Summary of one player's match from its payload; null when the player is not in it. */
export function recentMatchOf(match: MatchDto, puuid: string): LiveRecentMatch | null {
  const info = match.info;
  const p = info?.participants?.find((x) => x.puuid === puuid);
  const matchId = match.metadata?.matchId;
  if (!p || !matchId) return null;
  const endMs =
    info.gameEndTimestamp ?? (info.gameStartTimestamp ?? 0) + durationSeconds(info) * 1000;
  return {
    matchId,
    championId: p.championId,
    position: parsePosition(p.teamPosition),
    win: p.win === true,
    remake: isRemakeMatch(info),
    endedAt: new Date(endMs).toISOString(),
  };
}

/** Replaces a puuid (raw or URL-encoded) in a message: Riot error messages carry request paths. */
export function redactPuuid(message: string, puuid: string): string {
  let out = message;
  for (const s of new Set([puuid, encodeURIComponent(puuid)])) {
    if (s) out = out.split(s).join('<puuid>');
  }
  return out;
}

/** Summaries of matches fetched for lookups (every player of each), newest kept. */
class MatchSummaries {
  private readonly matches = new Map<string, Map<string, LiveRecentMatch>>();
  constructor(private readonly max: number) {}

  get(matchId: string, puuid: string): LiveRecentMatch | undefined {
    return this.matches.get(matchId)?.get(puuid);
  }

  add(match: MatchDto): void {
    const id = match.metadata?.matchId;
    if (!id) return;
    const byPlayer = new Map<string, LiveRecentMatch>();
    for (const p of match.info?.participants ?? []) {
      const m = p.puuid ? recentMatchOf(match, p.puuid) : null;
      if (m) byPlayer.set(p.puuid, m);
    }
    this.matches.delete(id);
    this.matches.set(id, byPlayer);
    while (this.matches.size > this.max) {
      const oldest = this.matches.keys().next().value;
      if (oldest === undefined) break;
      this.matches.delete(oldest);
    }
  }
}

/** At most `n` tasks at a time, started in call order. */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly n: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export type LiveLookupOutcome = 'ready' | 'pending' | 'retry' | 'failed' | 'stopped';
export type LiveGameOutcome = 'found' | 'retry' | 'failed' | 'stopped';

/**
 * The players of a spectator-v5 game (bots left out). A player Riot hides (null puuid, privacy
 * setting) is kept without an id, so the API can say so: never looked up.
 */
export function gameParticipants(
  participants: readonly {
    teamId: number;
    championId: number;
    puuid?: string | null;
    bot?: boolean;
  }[],
): LiveGameParticipant[] {
  return participants.flatMap((p) =>
    p.bot || !(p.championId > 0)
      ? []
      : [{ teamId: p.teamId, championId: p.championId, puuid: p.puuid || null }],
  );
}

export class LiveLookups {
  readonly options: LiveLookupOptions;
  private readonly inFlight = new Map<string, Promise<LiveLookupOutcome>>();
  /** Lookups that hit an error: not claimed again before this time. */
  private readonly retryAt = new Map<string, number>();
  private readonly matchSlots: Semaphore;
  private readonly summaries = new MatchSummaries(500);
  private readonly matchFetches = new Map<string, Promise<MatchDto | null>>();
  /** Games being found, and the ones waiting for a retry (by game id). */
  private readonly gamesInFlight = new Map<number, Promise<LiveGameOutcome>>();
  private readonly gameRetryAt = new Map<number, number>();
  /** The user's puuid by Riot ID (one account-v1 request per Riot ID). */
  private readonly accounts = new Map<string, string>();
  private lastPurge = Number.NEGATIVE_INFINITY;
  readonly counters = { ready: 0, failed: 0, matchesFetched: 0, matchesReused: 0, games: 0 };

  constructor(private readonly deps: LiveLookupDeps) {
    this.options = {
      ...DEFAULT_LIVE_LOOKUP_OPTIONS,
      ...deps.options,
      maxAttempts: { ...DEFAULT_LIVE_LOOKUP_OPTIONS.maxAttempts, ...deps.options?.maxAttempts },
    };
    this.matchSlots = new Semaphore(Math.max(1, this.options.playerConcurrency));
  }

  get active(): number {
    return this.inFlight.size + this.gamesInFlight.size;
  }

  /**
   * Starts every PENDING lookup of the platform that is not running or waiting for a retry;
   * returns how many started. Also purges old lookups (hourly).
   */
  async poll(signal?: AbortSignal): Promise<number> {
    const now = this.deps.clock.now();
    if (now - this.lastPurge >= 3_600_000) {
      this.lastPurge = now;
      const purged = await purgeLiveLookups(
        this.deps.db,
        new Date(now - this.options.purgeAfterMs),
      );
      const games = await purgeLiveGames(this.deps.db, new Date(now - this.options.purgeAfterMs));
      if (purged + games > 0) this.deps.log.info('old live lookups purged', { purged, games });
    }
    await this.pollGames(now, signal);
    for (const [p, at] of this.retryAt) if (at <= now) this.retryAt.delete(p);
    const jobs = await claimLiveLookups(
      this.deps.db,
      this.deps.platform,
      20 + this.inFlight.size + this.retryAt.size,
    );
    let started = 0;
    for (const job of jobs) {
      if (this.inFlight.has(job.puuid) || this.retryAt.has(job.puuid)) continue;
      const run = this.run(job, signal).finally(() => this.inFlight.delete(job.puuid));
      this.inFlight.set(job.puuid, run);
      started++;
    }
    if (started > 0) this.deps.log.info('live lookups started', { players: started });
    return started;
  }

  /** Resolves once every started lookup (and game search) is over. */
  async drain(): Promise<void> {
    while (this.inFlight.size + this.gamesInFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values(), ...this.gamesInFlight.values()]);
    }
  }

  /** Starts finding every PENDING game not being found or waiting for a retry. */
  private async pollGames(now: number, signal?: AbortSignal): Promise<void> {
    for (const [id, at] of this.gameRetryAt) if (at <= now) this.gameRetryAt.delete(id);
    const games = await claimLiveGames(
      this.deps.db,
      this.deps.platform,
      5 + this.gamesInFlight.size + this.gameRetryAt.size,
    );
    for (const game of games) {
      if (this.gamesInFlight.has(game.gameId) || this.gameRetryAt.has(game.gameId)) continue;
      const run = this.findGame(game, signal).finally(() => this.gamesInFlight.delete(game.gameId));
      this.gamesInFlight.set(game.gameId, run);
    }
  }

  /**
   * Finds the user's game: account-v1 (the user's puuid), then spectator-v5. Every participant is
   * queued as a lookup at once (the API would on its next poll). Never rejects.
   */
  async findGame(job: LiveGameJob, signal?: AbortSignal): Promise<LiveGameOutcome> {
    const { riot, db, platform, log } = this.deps;
    const riotId = `${job.gameName}#${job.tagLine}`.toLowerCase();
    let puuid = this.accounts.get(riotId) ?? null;
    try {
      if (!puuid) {
        const account = await riot.getAccountByRiotId(
          platform,
          job.gameName,
          job.tagLine,
          PRIORITY.LIVE_LOOKUP,
          signal,
        );
        if (!account?.puuid) {
          await failLiveGame(
            db,
            platform,
            job.gameId,
            'not_found: no account with this Riot ID',
            1,
            this.date(),
          );
          log.warn('live game not found: unknown Riot ID', { gameId: job.gameId });
          return 'failed';
        }
        puuid = account.puuid;
        this.accounts.set(riotId, puuid);
      }
      const game = await riot.getActiveGame(platform, puuid, PRIORITY.LIVE_LOOKUP, signal);
      if (!game) {
        // Spectator data may lag the client by a few seconds: asked again shortly.
        this.gameRetryAt.set(job.gameId, this.deps.clock.now() + this.options.gameNotFoundRetryMs);
        const status = await failLiveGame(
          db,
          platform,
          job.gameId,
          'not_found: Riot does not show this game',
          this.options.gameNotFoundAttempts,
          this.date(),
        );
        if (status === 'FAILED') log.warn('live game not found', { gameId: job.gameId });
        return status === 'FAILED' ? 'failed' : 'retry';
      }
      if (game.gameId !== job.gameId) {
        // One active game per account: the ids should match. The players are matched by
        // champion anyway, so a mismatch shows as players not found.
        log.warn('active game id differs from the client one', {
          gameId: job.gameId,
          activeGameId: game.gameId,
        });
      }
      const participants = gameParticipants(game.participants ?? []);
      const myTeamId = participants.find((p) => p.puuid === puuid)?.teamId ?? null;
      await storeLiveGame(db, platform, job.gameId, participants, myTeamId, this.date());
      await requestLiveLookups(
        db,
        platform,
        participants.flatMap((p) =>
          p.puuid ? [{ puuid: p.puuid, championId: p.championId }] : [],
        ),
        { now: this.date() },
      );
      this.counters.games++;
      log.info('live game found', { gameId: job.gameId, players: participants.length });
      return 'found';
    } catch (err) {
      const kind: ErrorKind = classifyError(err);
      if (kind === 'abort') return 'stopped';
      if (kind === 'auth') {
        this.deps.onAuthError(err);
        return 'stopped';
      }
      const message = puuid ? redactPuuid(errorMessage(err), puuid) : errorMessage(err);
      const attempt = job.attempts + 1;
      this.gameRetryAt.set(
        job.gameId,
        this.deps.clock.now() + this.options.retryMs * 2 ** Math.min(attempt - 1, 10),
      );
      this.deps.onError(message);
      let status: 'PENDING' | 'READY' | 'FAILED' = 'PENDING';
      try {
        status = await failLiveGame(
          db,
          platform,
          job.gameId,
          `${kind}: ${message}`,
          this.options.maxAttempts[kind],
          this.date(),
        );
      } catch (dbErr) {
        log.warn('live game failure not recorded', { error: errorMessage(dbErr) });
      }
      log.warn('live game search failed', { kind, error: message, attempt, status });
      return status === 'FAILED' ? 'failed' : 'retry';
    }
  }

  /**
   * One lookup: only the parts not up to date are fetched, each stored as soon as it is in.
   * Never rejects: errors are recorded on the lookup (or reported, for auth errors).
   */
  async run(job: LiveLookupJob, signal?: AbortSignal): Promise<LiveLookupOutcome> {
    try {
      await this.platformPart(job, signal);
      if (job.needsRecent) await this.matchSlots.use(() => this.matchPart(job, signal));
      if (await finishLiveLookup(this.deps.db, job.puuid, this.date())) {
        this.counters.ready++;
        return 'ready';
      }
      // Asked again meanwhile (another champion, a newer request): claimed again for the rest.
      return 'pending';
    } catch (err) {
      return this.failed(job, err);
    }
  }

  /** Rank and mastery (platform host). */
  private async platformPart(job: LiveLookupJob, signal?: AbortSignal): Promise<void> {
    const { riot, db, platform } = this.deps;
    const tasks: Promise<void>[] = [];
    if (job.needsRank) {
      tasks.push(
        (async () => {
          const entries = await riot.getLeagueEntries(
            platform,
            job.puuid,
            PRIORITY.LIVE_LOOKUP,
            signal,
          );
          await storeLiveRank(
            db,
            job.puuid,
            job.requestSeq,
            toSoloRank(entries ?? []),
            this.date(),
          );
        })(),
      );
    }
    for (const championId of job.masteryChampionIds) {
      tasks.push(
        (async () => {
          const m = await riot.getChampionMastery(
            platform,
            job.puuid,
            championId,
            PRIORITY.LIVE_LOOKUP,
            signal,
          );
          await storeLiveMastery(
            db,
            job.puuid,
            championId,
            { level: m?.championLevel ?? 0, points: m?.championPoints ?? 0 },
            this.date(),
          );
        })(),
      );
    }
    // Every part that works is stored before the lookup is failed for the one that did not.
    const failure = (await Promise.allSettled(tasks)).find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /** One request per match, even when several lookups need it at once (duo partners). */
  private fetchMatch(id: string, signal?: AbortSignal): Promise<MatchDto | null> {
    let pending = this.matchFetches.get(id);
    if (!pending) {
      this.counters.matchesFetched++;
      pending = this.deps.riot
        .getMatch(this.deps.platform, id, signal, PRIORITY.LIVE_LOOKUP)
        .then((match) => {
          if (match) this.summaries.add(match);
          return match;
        })
        .finally(() => this.matchFetches.delete(id));
      this.matchFetches.set(id, pending);
    }
    return pending;
  }

  /** Recent ranked solo matches (match cluster), reusing every match we already know. */
  private async matchPart(job: LiveLookupJob, signal?: AbortSignal): Promise<void> {
    const { riot, db, platform } = this.deps;
    const ids = await riot.getMatchIds(
      platform,
      job.puuid,
      { start: 0, count: this.options.recentMatches, priority: PRIORITY.LIVE_LOOKUP },
      signal,
    );
    const known = new Map<string, LiveRecentMatch>();
    const previous = new Map(job.previousRecent.map((m) => [m.matchId, m]));
    for (const id of ids) {
      const m = previous.get(id) ?? this.summaries.get(id, job.puuid);
      if (m) known.set(id, m);
    }
    const unknown = ids.filter((id) => !known.has(id));
    for (const m of await storedRecentMatches(db, job.puuid, unknown)) known.set(m.matchId, m);
    const toFetch = ids.filter((id) => !known.has(id));
    this.counters.matchesReused += ids.length - toFetch.length;
    const fetches = await Promise.allSettled(
      toFetch.map(async (id) => {
        const match = await this.fetchMatch(id, signal);
        const m = match ? recentMatchOf(match, job.puuid) : null; // 404: left out
        if (m) known.set(id, m);
      }),
    );
    // The matches that came are kept (summaries) for the retry.
    const failure = fetches.find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
    const recent = ids.flatMap((id) => known.get(id) ?? []);
    await storeLiveRecent(db, job.puuid, job.requestSeq, recent, this.date());
  }

  private async failed(job: LiveLookupJob, err: unknown): Promise<LiveLookupOutcome> {
    const kind: ErrorKind = classifyError(err);
    if (kind === 'abort') return 'stopped';
    if (kind === 'auth') {
      this.deps.onAuthError(err);
      return 'stopped';
    }
    const message = redactPuuid(errorMessage(err), job.puuid);
    const attempt = job.attempts + 1;
    this.retryAt.set(
      job.puuid,
      this.deps.clock.now() + this.options.retryMs * 2 ** Math.min(attempt - 1, 10),
    );
    this.deps.onError(message);
    let status: 'PENDING' | 'READY' | 'FAILED' = 'PENDING';
    try {
      status = await failLiveLookup(
        this.deps.db,
        job.puuid,
        `${kind}: ${message}`,
        this.options.maxAttempts[kind],
        this.date(),
      );
    } catch (dbErr) {
      this.deps.log.warn('live lookup failure not recorded', { error: errorMessage(dbErr) });
    }
    this.deps.log.warn('live lookup failed', { kind, error: message, attempt, status });
    if (status === 'FAILED') {
      this.counters.failed++;
      return 'failed';
    }
    return 'retry';
  }

  private date(): Date {
    return new Date(this.deps.clock.now());
  }
}
