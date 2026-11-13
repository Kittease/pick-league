/** HTTP client for the PickLeague API (contract in @pick-league/shared/api-contract). */

import {
  API_ROUTES,
  type ApiErrorResponse,
  type BuildRequestInput,
  type BuildResponse,
  type HealthResponse,
  type PicksRequestInput,
  type PicksResponse,
  type StaticDataResponse,
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
}

export function normaliseApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function createApiClient(
  baseUrl: string,
  doFetch: typeof fetch = globalThis.fetch,
): ApiClient {
  const base = normaliseApiUrl(baseUrl);

  async function call<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
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
  };
}
