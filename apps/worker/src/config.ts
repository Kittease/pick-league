import { type Platform, parsePlatformList } from '@pick-league/shared';
import { isLogLevel, LOG_LEVELS, type LogLevel } from './log.ts';
import { LISTING_SKIP_MODES, type ListingSkipMode } from './scheduler/platform-worker.ts';

export interface WorkerConfig {
  riotApiKey: string;
  databaseUrl: string;
  platforms: Platform[];
  logLevel: LogLevel;
  /** Keep collecting the previous patch after the latest one is live (backfill by hand). */
  collectPreviousPatch: boolean;
  /**
   * Listing skip rule: 'off' (default), 'shadow' (evaluated and recorded, every listing still
   * runs) or 'on' (a tracked player whose new games are all stored is not listed).
   */
  listingSkip: ListingSkipMode;
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

  const rawCollect = (env.COLLECT_PREVIOUS_PATCH ?? '').trim().toLowerCase();
  let collectPreviousPatch = false;
  if (rawCollect === 'true' || rawCollect === '1') collectPreviousPatch = true;
  else if (rawCollect !== '' && rawCollect !== 'false' && rawCollect !== '0') {
    problems.push(`COLLECT_PREVIOUS_PATCH must be true or false (got "${rawCollect}")`);
  }

  const rawSkip = (env.LISTING_SKIP ?? '').trim().toLowerCase() || 'off';
  let listingSkip: ListingSkipMode = 'off';
  if ((LISTING_SKIP_MODES as readonly string[]).includes(rawSkip)) {
    listingSkip = rawSkip as ListingSkipMode;
  } else {
    problems.push(
      `LISTING_SKIP must be one of ${LISTING_SKIP_MODES.join(', ')} (got "${rawSkip}")`,
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid worker configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return {
    riotApiKey,
    databaseUrl,
    platforms,
    logLevel,
    collectPreviousPatch,
    listingSkip,
  };
}
