import { type Platform, parsePlatformList } from '@pick-league/shared';
import { isLogLevel, LOG_LEVELS, type LogLevel } from './log.ts';

export interface WorkerConfig {
  riotApiKey: string;
  databaseUrl: string;
  platforms: Platform[];
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads and validates the worker's environment. Throws a ConfigError listing every problem. */
export function loadConfig(env: Record<string, string | undefined>): WorkerConfig {
  const problems: string[] = [];

  const riotApiKey = env.RIOT_API_KEY?.trim() ?? '';
  if (riotApiKey === '') {
    problems.push(
      'RIOT_API_KEY is not set: get a key at https://developer.riotgames.com and put it in .env',
    );
  } else if (!/^RGAPI-[0-9a-f-]+$/i.test(riotApiKey)) {
    problems.push('RIOT_API_KEY does not look like a Riot key (expected "RGAPI-…")');
  }

  const databaseUrl = env.DATABASE_URL?.trim() ?? '';
  if (databaseUrl === '') problems.push('DATABASE_URL is not set');

  let platforms: Platform[] = [];
  try {
    platforms = parsePlatformList(env.PLATFORMS);
  } catch (err) {
    problems.push(`PLATFORMS: ${(err as Error).message}`);
  }

  const rawLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase() || 'info';
  let logLevel: LogLevel = 'info';
  if (isLogLevel(rawLevel)) logLevel = rawLevel;
  else problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${rawLevel}")`);

  if (problems.length > 0) {
    throw new ConfigError(`Invalid worker configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return { riotApiKey, databaseUrl, platforms, logLevel };
}
