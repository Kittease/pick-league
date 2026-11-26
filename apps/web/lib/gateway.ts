import {
  API_ROUTES,
  type ApiErrorCode,
  type ApiErrorResponse,
  PATCH_CHANGES_INDEX_ROUTE,
  PATCH_CHANGES_ROUTE,
  PATCH_NOTES_ROUTE,
  patchIdSchema,
  TIER_LIST_CHAMPION_ROUTE,
  TIER_LIST_ROUTE,
} from '@pick-league/shared';
import { REVALIDATE } from './cache.ts';

/**
 * The public gateway (`/api/v1/<api path>`, used by the desktop app): only the API's public
 * contract routes go through, with their method; the rest is a 404.
 */
export interface GatewayRoute {
  method: 'GET' | 'POST';
  /** API path, query string included for GETs. */
  path: string;
  /** Seconds a CDN may keep a successful GET answer; null = never cached (POST). */
  maxAge: number | null;
}

const GET_ROUTES: Record<string, number> = {
  [API_ROUTES.health]: REVALIDATE.health,
  [API_ROUTES.patches]: REVALIDATE.patches,
  [API_ROUTES.statsStatus]: REVALIDATE.statsStatus,
  [TIER_LIST_ROUTE]: REVALIDATE.tierList,
  [TIER_LIST_CHAMPION_ROUTE]: REVALIDATE.tierListChampion,
  [PATCH_CHANGES_INDEX_ROUTE]: REVALIDATE.patchNotes,
  [PATCH_CHANGES_ROUTE]: REVALIDATE.patchNotes,
  [PATCH_NOTES_ROUTE]: REVALIDATE.patchNotes,
};

const POST_ROUTES: ReadonlySet<string> = new Set([
  API_ROUTES.picks,
  API_ROUTES.build,
  API_ROUTES.draft,
]);

/** `GET /static/:patch` with a patch id or 'latest'. */
function staticRoute(path: string): boolean {
  const prefix = API_ROUTES.static('latest').slice(0, -'latest'.length);
  if (!path.startsWith(prefix)) return false;
  const patch = path.slice(prefix.length);
  return patch === 'latest' || patchIdSchema.safeParse(patch).success;
}

/**
 * The API route a gateway request maps to, or null when it is not allowed. `segments`: the path
 * after `/api/v1/` (decoded); `search`: the request's query string (`?…` or empty), kept for GETs.
 */
export function gatewayRoute(
  method: string,
  segments: readonly string[],
  search: string,
): GatewayRoute | null {
  if (
    segments.length === 0 ||
    segments.some((s) => !/^[A-Za-z0-9._-]+$/.test(s) || /^\.+$/.test(s))
  )
    return null;
  const path = `/${segments.join('/')}`;
  if (method === 'GET' || method === 'HEAD') {
    const maxAge = GET_ROUTES[path] ?? (staticRoute(path) ? REVALIDATE.static : undefined);
    if (maxAge === undefined) return null;
    return { method: 'GET', path: `${path}${search === '?' ? '' : search}`, maxAge };
  }
  if (method === 'POST' && POST_ROUTES.has(path)) return { method: 'POST', path, maxAge: null };
  return null;
}

/** JSON error body in the API's own shape. */
export function errorBody(code: ApiErrorCode, message: string): string {
  const body: ApiErrorResponse = { error: { code, message } };
  return JSON.stringify(body);
}

export type CappedBody = { ok: true; bytes: Uint8Array } | { ok: false };

/** Reads a request body, giving up (`ok: false`) as soon as it exceeds `max` bytes. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<CappedBody> {
  if (!body) return { ok: true, bytes: new Uint8Array() };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export interface GatewayAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * What the gateway answers for an API response: its status, body and `Retry-After`, with a CDN
 * cache lifetime for successful GETs only. A non-JSON upstream body becomes a 502.
 */
export function gatewayAnswer(
  route: GatewayRoute,
  upstream: { status: number; retryAfter: string | null; text: string },
): GatewayAnswer {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  try {
    JSON.parse(upstream.text);
  } catch {
    return {
      status: 502,
      headers: { ...headers, 'Cache-Control': 'no-store' },
      body: errorBody('INTERNAL', `The API returned an invalid answer (${upstream.status})`),
    };
  }
  if (upstream.retryAfter) headers['Retry-After'] = upstream.retryAfter;
  headers['Cache-Control'] =
    route.maxAge !== null && upstream.status === 200
      ? `public, max-age=0, s-maxage=${route.maxAge}, stale-while-revalidate=${route.maxAge}`
      : 'no-store';
  return { status: upstream.status, headers, body: upstream.text };
}
