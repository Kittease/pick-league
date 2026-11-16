/** Where and how the server reaches the API (shared by the data layer and the gateway). */

/** Upstream request timeout. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

export interface UpstreamConfig {
  /** API base URL, without a trailing slash. */
  url: string;
  token: string | null;
}

/** `API_URL` / `API_TOKEN` from the environment; null when `API_URL` is missing. */
export function upstreamConfig(env: Record<string, string | undefined>): UpstreamConfig | null {
  const url = env.API_URL?.trim().replace(/\/+$/, '');
  if (!url) return null;
  return { url, token: env.API_TOKEN?.trim() || null };
}

/** Headers of an API call: the gateway token and the visitor's IP (the API rate-limits by it). */
export function upstreamHeaders(
  config: UpstreamConfig,
  clientIp: string | null,
  json: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (clientIp) headers['X-Client-IP'] = clientIp;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}
