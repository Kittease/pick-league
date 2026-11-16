import type { ApiErrorResponse } from '@pick-league/shared';
import type { ApiResult } from '@pick-league/ui/lib/types';

/** Shapes an API answer (status + body text) as the plain `ApiResult` the views expect. */
export function toApiResult<T>(status: number, text: string): ApiResult<T> {
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    return { ok: false, code: 'BAD_RESPONSE', message: `API returned non-JSON (${status})` };
  }
  if (status >= 200 && status < 300) {
    if (json === undefined) {
      return { ok: false, code: 'BAD_RESPONSE', message: `API returned an empty body (${status})` };
    }
    return { ok: true, data: json as T };
  }
  const err = (json as Partial<ApiErrorResponse> | undefined)?.error;
  return {
    ok: false,
    code: typeof err?.code === 'string' ? err.code : null,
    message: typeof err?.message === 'string' ? err.message : `API error ${status}`,
  };
}

/** A call that never got an answer (network error, timeout), as an `ApiResult`. */
export function transportFailure(e: unknown): ApiResult<never> {
  const timeout = e instanceof Error && e.name === 'TimeoutError';
  return timeout
    ? { ok: false, code: 'TIMEOUT', message: 'The PickLeague server did not answer in time' }
    : { ok: false, code: 'UNREACHABLE', message: 'Cannot reach the PickLeague server' };
}

/** Invalid arguments from the browser, as an `ApiResult` (the API's own code for it). */
export function badRequest(message: string): ApiResult<never> {
  return { ok: false, code: 'BAD_REQUEST', message };
}
