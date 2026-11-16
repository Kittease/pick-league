import type { ApiResult, Loadable } from '@pick-league/ui/lib/types';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Changes made in quick succession only ask the API once they settle. */
const DEBOUNCE_MS = 250;
/** Answers kept per call kind, so undo / redo of the same state is instant. */
const CACHE_LIMIT = 60;

/**
 * One-off API call for a request built from the UI state (draft planner, champion select):
 * debounced, stale answers dropped, answers cached per request (cleared when `apiKey`, the
 * identity of the API data, changes). `keepWhileLoading` keeps showing the previous answer until
 * the new one lands.
 */
export function useApiCall<Req, Res>(
  request: Req | null,
  call: (request: Req) => Promise<ApiResult<Res>>,
  apiKey: string,
  keepWhileLoading: boolean,
): { result: Loadable<Res>; retry: () => void } {
  const key = request === null ? null : JSON.stringify(request);
  const latest = useRef({ request, call });
  latest.current = { request, call };
  const cache = useRef(new Map<string, Res>());
  const lastApiKey = useRef(apiKey);
  const [result, setResult] = useState<Loadable<Res>>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the request is read through `latest` (its key is the dependency); nonce re-runs the call on retry
  useEffect(() => {
    if (lastApiKey.current !== apiKey) {
      cache.current.clear();
      lastApiKey.current = apiKey;
    }
    const { request: body, call: send } = latest.current;
    if (key === null || body === null) {
      setResult({ status: 'idle' });
      return;
    }
    const hit = cache.current.get(key);
    if (hit) {
      setResult({ status: 'ok', data: hit });
      return;
    }
    setResult((prev) => ({
      status: 'loading',
      data: keepWhileLoading && prev.status !== 'idle' ? prev.data : null,
    }));
    let alive = true;
    const timer = setTimeout(() => {
      void send(body).then((r) => {
        if (!alive) return;
        if (!r.ok) {
          setResult({ status: 'error', code: r.code, message: r.message, data: null });
          return;
        }
        cache.current.set(key, r.data);
        const oldest = cache.current.keys().next();
        if (cache.current.size > CACHE_LIMIT && !oldest.done) cache.current.delete(oldest.value);
        setResult({ status: 'ok', data: r.data });
      });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, apiKey, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { result, retry };
}

/** Identity of the API data: a new API, patch or stats refresh drops the cached answers. */
export function apiDataKey(state: {
  api: { url: string; latestPatch: string | null; state: string };
  stats: { status: { lastRefreshedAt: string | null } | null };
}): string {
  const lastRefreshedAt = state.stats.status?.lastRefreshedAt ?? null;
  return `${state.api.url}|${state.api.latestPatch}|${state.api.state === 'ok'}|${lastRefreshedAt}`;
}
