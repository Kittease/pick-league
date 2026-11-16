import 'server-only';
import type { ApiResult } from '@pick-league/ui/lib/types';
import { headers } from 'next/headers';
import { toApiResult, transportFailure } from './api-result.ts';
import { clientIpFrom } from './client-ip.ts';
import { UPSTREAM_TIMEOUT_MS, upstreamConfig, upstreamHeaders } from './upstream.ts';

/**
 * Server-side calls to the PickLeague API (Server Components and Server Actions). Every call
 * carries the gateway token and the visitor's IP (the API rate-limits per visitor). Failures come
 * back as `{ ok: false }`, never thrown, so they cross to the client as plain data.
 */

async function visitorIp(): Promise<string | null> {
  return clientIpFrom(await headers());
}

const NOT_CONFIGURED: ApiResult<never> = {
  ok: false,
  code: 'NOT_CONFIGURED',
  message: 'The PickLeague server is not configured (API_URL)',
};

/** Cached GET: answers are reused for `revalidate` seconds by the server's data cache. */
export async function apiGet<T>(
  path: string,
  cache: { revalidate: number; tags: string[] },
): Promise<ApiResult<T>> {
  const config = upstreamConfig(process.env);
  if (!config) return NOT_CONFIGURED;
  try {
    const res = await fetch(`${config.url}${path}`, {
      headers: upstreamHeaders(config, await visitorIp(), false),
      next: { revalidate: cache.revalidate, tags: cache.tags },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return toApiResult<T>(res.status, await res.text());
  } catch (e) {
    return transportFailure(e);
  }
}

/** Uncached POST (recommendations: computed for the request's draft). */
export async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const config = upstreamConfig(process.env);
  if (!config) return NOT_CONFIGURED;
  try {
    const res = await fetch(`${config.url}${path}`, {
      method: 'POST',
      headers: upstreamHeaders(config, await visitorIp(), true),
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return toApiResult<T>(res.status, await res.text());
  } catch (e) {
    return transportFailure(e);
  }
}
