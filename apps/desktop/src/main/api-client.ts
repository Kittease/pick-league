/** HTTP client for the PickLeague API (contract in @pick-league/shared/api-contract). */

import {
  API_ROUTES,
  type ApiErrorResponse,
  type BuildRequestInput,
  type BuildResponse,
  CLIENT_ACTIVITY_ROUTE,
  type ClientActivityRequest,
  type ClientActivityResponse,
  DEFAULT_TIER_LIST_FILTERS,
  type HealthResponse,
  LIVE_PLAYERS_ROUTE,
  type LivePlayersRequest,
  type LivePlayersResponse,
  type PicksRequestInput,
  type PicksResponse,
  type Position,
  type StaticDataResponse,
  type StatsRefreshResponse,
  type StatsStatusResponse,
  TIER_LIST_CHAMPION_ROUTE,
  TIER_LIST_ROUTE,
  type TierListChampionResponse,
  type TierListFilters,
  type TierListResponse,
} from '@pick-league/shared';

const TIMEOUT_MS = 10_000;

export class ApiClientError extends Error {
  constructor(
    /** Contract error code, or UNREACHABLE / TIMEOUT / BAD_RESPONSE for transport failures. */
    readonly code: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiClient {
  readonly baseUrl: string;
  health(): Promise<HealthResponse>;
  staticData(patch?: string): Promise<StaticDataResponse>;
  picks(request: PicksRequestInput): Promise<PicksResponse>;
  build(request: BuildRequestInput): Promise<BuildResponse>;
  statsStatus(): Promise<StatsStatusResponse>;
  /** Asks the API to refresh its stats views now (answers immediately). */
  statsRefresh(): Promise<StatsRefreshResponse>;
  /** Queues the lookups of a game's players; repeat until `done` (never cached). */
  livePlayers(request: LivePlayersRequest): Promise<LivePlayersResponse>;
  /** Says what the user does in the League client (collection pauses while they play). */
  clientActivity(request: ClientActivityRequest): Promise<ClientActivityResponse>;
  tierList(role: Position, filters?: TierListFilters, patch?: string): Promise<TierListResponse>;
  tierListChampion(
    role: Position,
    championId: number,
    filters?: TierListFilters,
    patch?: string,
  ): Promise<TierListChampionResponse>;
}

export function normaliseApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function createApiClient(
  baseUrl: string,
  doFetch: typeof fetch = globalThis.fetch,
): ApiClient {
  const base = normaliseApiUrl(baseUrl);

  async function call<T>(path: string, body?: unknown, method?: 'POST' | 'PUT'): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      throw new ApiClientError(
        timeout ? 'TIMEOUT' : 'UNREACHABLE',
        timeout
          ? `API did not answer within ${TIMEOUT_MS / 1000}s`
          : `Cannot reach the API at ${base}`,
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiClientError('BAD_RESPONSE', `API returned non-JSON (${res.status})`, res.status);
    }
    if (!res.ok) {
      const err = (json as ApiErrorResponse | undefined)?.error;
      throw new ApiClientError(
        err?.code ?? 'INTERNAL',
        err?.message ?? `API error ${res.status}`,
        res.status,
      );
    }
    return json as T;
  }

  return {
    baseUrl: base,
    health: () => call(API_ROUTES.health),
    staticData: (patch = 'latest') => call(API_ROUTES.static(patch)),
    picks: (request) => call(API_ROUTES.picks, request),
    build: (request) => call(API_ROUTES.build, request),
    statsStatus: () => call(API_ROUTES.statsStatus),
    statsRefresh: () => call(API_ROUTES.statsRefresh, undefined, 'POST'),
    livePlayers: (request) => call(LIVE_PLAYERS_ROUTE, request),
    clientActivity: (request) => call(CLIENT_ACTIVITY_ROUTE, request, 'PUT'),
    tierList: (role, filters = DEFAULT_TIER_LIST_FILTERS, patch = 'latest') =>
      call(`${TIER_LIST_ROUTE}?${new URLSearchParams({ role, patch, ...filters })}`),
    tierListChampion: (role, championId, filters = DEFAULT_TIER_LIST_FILTERS, patch = 'latest') =>
      call(
        `${TIER_LIST_CHAMPION_ROUTE}?${new URLSearchParams({ role, championId: String(championId), patch, ...filters })}`,
      ),
  };
}
