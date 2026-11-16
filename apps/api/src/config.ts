import { API_DEFAULT_PORT } from '@pick-league/shared';
import type { LogLevel } from './logger.ts';

export interface ApiConfig {
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
  /** Response cache TTL. */
  cacheTtlMs: number;
  /** Token bucket per client IP; 0 disables rate limiting. */
  rateLimitPerMinute: number;
  rateLimitBurst: number;
  trustProxy: boolean;
  /**
   * Bearer token every route but `GET /health` requires (the gateway's), which then also gives
   * the visitor IP in `X-Client-IP`. Unset (local dev): no auth.
   */
  apiToken: string | undefined;
  /** How often to check whether the stats views need a refresh. */
  statsRefreshIntervalMs: number;
}

function int(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const level = (env.LOG_LEVEL ?? 'info') as LogLevel;
  return {
    port: int(env, 'PORT', API_DEFAULT_PORT),
    databaseUrl,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    cacheTtlMs: int(env, 'CACHE_TTL_SECONDS', 600) * 1000,
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 120),
    rateLimitBurst: int(env, 'RATE_LIMIT_BURST', 30),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    apiToken: env.API_TOKEN?.trim() || undefined,
    statsRefreshIntervalMs: int(env, 'STATS_REFRESH_MINUTES', 60) * 60_000,
  };
}
