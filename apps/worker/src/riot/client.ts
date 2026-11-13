/**
 * Riot HTTP client: one rate limiter per host, priority-aware, with retries.
 *
 * - 200 → parsed JSON; 404 → null ("not found" is a normal result).
 * - 429 → the scope named by `X-Rate-Limit-Type` is blocked for `Retry-After`; without
 *   `Retry-After` (service/underlying limit) the method backs off exponentially. Then retried.
 * - 5xx and network errors → retried with exponential backoff.
 * - 401/403 → RiotAuthError (bad or expired key), not retried.
 *
 * The API key only ever goes into the `X-Riot-Token` header: it is never logged.
 */
import {
  type AccountDto,
  accountBaseUrl,
  type ChampionMasteryDto,
  type LadderTier,
  type LeagueEntryDto,
  type LeagueListDto,
  type MatchDto,
  type MatchIdsDto,
  matchBaseUrl,
  type Platform,
  platformBaseUrl,
  RANKED_SOLO_QUEUE,
  RANKED_SOLO_QUEUE_ID,
  type TimelineDto,
} from '@pick-league/shared';
import { abortError, type Clock, isAbortError, systemClock } from '../clock.ts';
import { type Logger, silentLogger } from '../log.ts';
import { HostLimiter, type HostLimiterOptions, type HostLimiterStats } from './rate-limiter.ts';

/** Priority levels of docs/architecture.md (higher = served first). */
export const PRIORITY = {
  LADDER: 5,
  MATCH_IDS: 4,
  MATCH: 3,
  DAILY_REFRESH: 2,
  ENRICHMENT: 1,
} as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export class RiotHttpError extends Error {
  override name = 'RiotHttpError';
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
  ) {
    super(`Riot API ${method} failed with HTTP ${status} (${path})`);
  }
}

export class RiotAuthError extends RiotHttpError {
  override name = 'RiotAuthError';
  constructor(status: number, method: string, path: string) {
    super(status, method, path);
    this.message = `Riot API rejected the key (HTTP ${status}): RIOT_API_KEY is invalid or expired`;
  }
}

export interface MatchIdsQuery {
  /** Epoch seconds. */
  startTime?: number;
  start?: number;
  /** 1..100 */
  count?: number;
}

/** What the scheduler needs from Riot (a fake implements it in tests). */
export interface RiotApi {
  getLeague(platform: Platform, tier: LadderTier, signal?: AbortSignal): Promise<LeagueListDto>;
  getMatchIds(
    platform: Platform,
    puuid: string,
    query: MatchIdsQuery,
    signal?: AbortSignal,
  ): Promise<MatchIdsDto>;
  getMatch(platform: Platform, matchId: string, signal?: AbortSignal): Promise<MatchDto | null>;
  getTimeline(
    platform: Platform,
    matchId: string,
    signal?: AbortSignal,
  ): Promise<TimelineDto | null>;
  getAccount(
    platform: Platform,
    puuid: string,
    priority: Priority,
    signal?: AbortSignal,
  ): Promise<AccountDto | null>;
  getMasteries(
    platform: Platform,
    puuid: string,
    priority: Priority,
    signal?: AbortSignal,
  ): Promise<ChampionMasteryDto[] | null>;
  getLeagueEntries(
    platform: Platform,
    puuid: string,
    priority: Priority,
    signal?: AbortSignal,
  ): Promise<LeagueEntryDto[] | null>;
}

export interface RiotClientOptions {
  apiKey: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: Clock;
  log?: Logger;
  limiter?: HostLimiterOptions;
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
  /** Retries for 5xx / network errors (default 4). */
  maxServerRetries?: number;
  /** Retries after 429 (default 8). */
  maxRateLimitRetries?: number;
  /** Base backoff for 5xx / network errors and 429 without Retry-After (default 1 s). */
  backoffMs?: number;
}

export interface HostStats extends HostLimiterStats {
  rateLimited: number;
  serverErrors: number;
}

export class RiotClient implements RiotApi {
  private readonly limiters = new Map<string, HostLimiter>();
  private readonly hostCounters = new Map<string, { rateLimited: number; serverErrors: number }>();
  private readonly platformRequests = new Map<Platform, number>();
  /** Consecutive 429s without Retry-After, per host+method. */
  private readonly serviceBackoff = new Map<string, number>();
  private readonly doFetch: (url: string, init: RequestInit) => Promise<Response>;
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(private readonly options: RiotClientOptions) {
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? silentLogger;
  }

  getLeague(platform: Platform, tier: LadderTier, signal?: AbortSignal) {
    const kind = `${tier.toLowerCase()}leagues`;
    return this.getOrThrow<LeagueListDto>(
      platform,
      platformBaseUrl(platform),
      `league-v4.${kind}`,
      `/lol/league/v4/${kind}/by-queue/${RANKED_SOLO_QUEUE}`,
      PRIORITY.LADDER,
      signal,
    );
  }

  async getMatchIds(platform: Platform, puuid: string, q: MatchIdsQuery, signal?: AbortSignal) {
    const params = new URLSearchParams({
      queue: String(RANKED_SOLO_QUEUE_ID),
      type: 'ranked',
      start: String(q.start ?? 0),
      count: String(q.count ?? 100),
    });
    if (q.startTime !== undefined) params.set('startTime', String(Math.floor(q.startTime)));
    const ids = await this.request<MatchIdsDto>(
      platform,
      matchBaseUrl(platform),
      'match-v5.ids-by-puuid',
      `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?${params}`,
      PRIORITY.MATCH_IDS,
      signal,
    );
    return ids ?? [];
  }

  getMatch(platform: Platform, matchId: string, signal?: AbortSignal) {
    return this.request<MatchDto>(
      platform,
      matchBaseUrl(platform),
      'match-v5.match',
      `/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
      PRIORITY.MATCH,
      signal,
    );
  }

  getTimeline(platform: Platform, matchId: string, signal?: AbortSignal) {
    return this.request<TimelineDto>(
      platform,
      matchBaseUrl(platform),
      'match-v5.timeline',
      `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`,
      PRIORITY.MATCH,
      signal,
    );
  }

  getAccount(platform: Platform, puuid: string, priority: Priority, signal?: AbortSignal) {
    return this.request<AccountDto>(
      platform,
      accountBaseUrl(platform),
      'account-v1.by-puuid',
      `/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`,
      priority,
      signal,
    );
  }

  getMasteries(platform: Platform, puuid: string, priority: Priority, signal?: AbortSignal) {
    return this.request<ChampionMasteryDto[]>(
      platform,
      platformBaseUrl(platform),
      'champion-mastery-v4.by-puuid',
      `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}`,
      priority,
      signal,
    );
  }

  getLeagueEntries(platform: Platform, puuid: string, priority: Priority, signal?: AbortSignal) {
    return this.request<LeagueEntryDto[]>(
      platform,
      platformBaseUrl(platform),
      'league-v4.entries-by-puuid',
      `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
      priority,
      signal,
    );
  }

  /** Per-host counters (requests/min, waiting, 429s…). */
  hostStats(): HostStats[] {
    return [...this.limiters.values()].map((l) => ({
      ...l.stats(),
      ...(this.hostCounters.get(l.host) ?? { rateLimited: 0, serverErrors: 0 }),
    }));
  }

  /** Requests sent on behalf of a platform since the client was created. */
  requestsFor(platform: Platform): number {
    return this.platformRequests.get(platform) ?? 0;
  }

  /** Rejects every request waiting for budget (shutdown). */
  close(): void {
    for (const l of this.limiters.values()) l.close();
  }

  private limiterFor(baseUrl: string): HostLimiter {
    const host = new URL(baseUrl).host;
    let limiter = this.limiters.get(host);
    if (!limiter) {
      // Warm-up probe outlasts the request timeout, so a lost probe never overlaps the next.
      limiter = new HostLimiter(host, this.clock, {
        warmUpProbeMs: (this.options.timeoutMs ?? 15_000) + 5_000,
        ...this.options.limiter,
      });
      this.limiters.set(host, limiter);
      this.hostCounters.set(host, { rateLimited: 0, serverErrors: 0 });
    }
    return limiter;
  }

  private async getOrThrow<T>(
    platform: Platform,
    baseUrl: string,
    method: string,
    path: string,
    priority: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.request<T>(platform, baseUrl, method, path, priority, signal);
    if (res === null) throw new RiotHttpError(404, method, path);
    return res;
  }

  private async request<T>(
    platform: Platform,
    baseUrl: string,
    method: string,
    path: string,
    priority: number,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const limiter = this.limiterFor(baseUrl);
    const counters = this.hostCounters.get(limiter.host) as {
      rateLimited: number;
      serverErrors: number;
    };
    const backoffKey = `${limiter.host} ${method}`;
    const base = this.options.backoffMs ?? 1000;
    let serverFailures = 0;
    let rateLimited = 0;

    for (;;) {
      await limiter.acquire(method, priority, signal);
      this.platformRequests.set(platform, (this.platformRequests.get(platform) ?? 0) + 1);

      let res: Response;
      try {
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
        res = await this.doFetch(`${baseUrl}${path}`, {
          headers: { 'X-Riot-Token': this.options.apiKey, Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw abortError();
        serverFailures++;
        if (serverFailures > (this.options.maxServerRetries ?? 4)) throw err;
        const wait = base * 2 ** (serverFailures - 1);
        this.log.warn('riot network error, retrying', {
          host: limiter.host,
          method,
          error: isAbortError(err) ? 'timeout' : String(err),
          retryInMs: wait,
        });
        await this.clock.sleep(wait, signal);
        continue;
      }

      limiter.observe(method, res.headers);

      if (res.ok) {
        this.serviceBackoff.delete(backoffKey);
        return (await res.json()) as T;
      }
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (res.status === 429) {
        await res.body?.cancel();
        counters.rateLimited++;
        rateLimited++;
        if (rateLimited > (this.options.maxRateLimitRetries ?? 8)) {
          throw new RiotHttpError(429, method, path);
        }
        const type = res.headers.get('x-rate-limit-type') ?? 'service';
        const retryAfter = Number(res.headers.get('retry-after'));
        let wait: number;
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          wait = retryAfter * 1000;
          limiter.block(type === 'application' ? null : method, this.clock.now() + wait);
        } else {
          // Service (underlying) limit: no Retry-After, back off this method exponentially.
          const n = (this.serviceBackoff.get(backoffKey) ?? 0) + 1;
          this.serviceBackoff.set(backoffKey, n);
          wait = Math.min(base * 2 ** (n - 1), 60_000);
          limiter.block(method, this.clock.now() + wait);
        }
        this.log.warn('riot 429', { host: limiter.host, method, type, retryInMs: wait });
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        throw new RiotAuthError(res.status, method, path);
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        counters.serverErrors++;
        serverFailures++;
        if (serverFailures > (this.options.maxServerRetries ?? 4)) {
          throw new RiotHttpError(res.status, method, path);
        }
        const wait = base * 2 ** (serverFailures - 1);
        this.log.warn('riot server error, retrying', {
          host: limiter.host,
          method,
          status: res.status,
          retryInMs: wait,
        });
        await this.clock.sleep(wait, signal);
        continue;
      }
      await res.body?.cancel();
      throw new RiotHttpError(res.status, method, path);
    }
  }
}
