/**
 * Error classes for the work loops: what is worth retrying later, and what will fail again.
 */
import { isAbortError } from '../clock.ts';
import { MatchParseError } from '../parser/parse-match.ts';
import { RiotAuthError, RiotHttpError, RiotNetworkError } from '../riot/client.ts';

/**
 * - `abort`: shutdown.
 * - `auth`: Riot rejected the key (401/403): every loop pauses.
 * - `transient`: Riot 429/5xx/408 after the client's retries, network errors and timeouts,
 *   database connection/lock errors. Retrying later should work: no attempt is counted.
 * - `deterministic`: the same request fails the same way (parse error, 404, other 4xx).
 * - `unknown`: anything else (a bug, a constraint violation…): counted as an attempt.
 */
export type ErrorKind = 'abort' | 'auth' | 'transient' | 'deterministic' | 'unknown';

/** Socket-level codes (Node/Bun and postgres.js). */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ConnectionRefused',
  'ConnectionClosed',
  'ConnectionReset',
  'FailedToOpenSocket',
  // postgres.js
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

/**
 * Postgres SQLSTATEs worth retrying: connection exceptions (08), serialization failure, deadlock,
 * insufficient resources (53), lock not available, query cancelled, server shutting down.
 */
function isTransientSqlState(code: string): boolean {
  return (
    code.startsWith('08') ||
    code.startsWith('53') ||
    ['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03'].includes(code)
  );
}

export class DeterministicError extends Error {
  override name = 'DeterministicError';
}

export function classifyError(err: unknown): ErrorKind {
  if (isAbortError(err)) return 'abort';
  if (err instanceof RiotAuthError) return 'auth';
  if (err instanceof RiotHttpError) {
    const s = err.status;
    return s === 429 || s === 408 || s >= 500 ? 'transient' : 'deterministic';
  }
  if (err instanceof RiotNetworkError) return 'transient';
  if (err instanceof MatchParseError || err instanceof DeterministicError) return 'deterministic';
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return 'transient';
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (NETWORK_CODES.has(code)) return 'transient';
      if (err.name === 'PostgresError' && isTransientSqlState(code)) return 'transient';
    }
  }
  return 'unknown';
}
