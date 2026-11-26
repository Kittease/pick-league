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
  /**
   * Ceiling of the Diamond target, per platform (default 0: Diamond is not read at all). How many
   * Diamond players are tracked under it is sized by the worker.
   */
  diamondMaxTracked: number;
  /**
   * Most checks an hour, per platform, of the Masters outside Riot's list (their own solo queue
   * entry, on the platform host; default 1500, 0: they are not followed). What is left of that
   * host's 3,000 requests an hour goes to the mastery refresh and enrichment.
   */
  outsideMasterChecksPerHour: number;
  /** Masteries of a tracked player are fetched again after this many days (default 3). */
  masteryRefreshDays: number;
  /** Read each new game build from Community Dragon and store its changes (default true). */
  patchChanges: boolean;
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

  const rawDiamond = (env.DIAMOND_MAX_TRACKED ?? '').trim() || '0';
  let diamondMaxTracked = 0;
  if (/^\d{1,7}$/.test(rawDiamond)) diamondMaxTracked = Number(rawDiamond);
  else {
    problems.push(
      `DIAMOND_MAX_TRACKED must be a whole number of players, 0 to 9999999 (got "${rawDiamond}")`,
    );
  }

  const rawChecks = (env.OUTSIDE_MASTER_CHECKS_PER_HOUR ?? '').trim() || '1500';
  let outsideMasterChecksPerHour = 1500;
  if (/^\d{1,4}$/.test(rawChecks) && Number(rawChecks) <= 3000) {
    outsideMasterChecksPerHour = Number(rawChecks);
  } else {
    problems.push(
      `OUTSIDE_MASTER_CHECKS_PER_HOUR must be a whole number, 0 to 3000 (got "${rawChecks}")`,
    );
  }

  const rawMasteryDays = (env.MASTERY_REFRESH_DAYS ?? '').trim() || '3';
  let masteryRefreshDays = 3;
  if (/^\d{1,3}$/.test(rawMasteryDays) && Number(rawMasteryDays) >= 1) {
    masteryRefreshDays = Number(rawMasteryDays);
  } else {
    problems.push(
      `MASTERY_REFRESH_DAYS must be a whole number of days, 1 to 999 (got "${rawMasteryDays}")`,
    );
  }

  const rawPatchChanges = (env.PATCH_CHANGES ?? '').trim().toLowerCase() || 'true';
  let patchChanges = true;
  if (rawPatchChanges === 'false' || rawPatchChanges === '0') patchChanges = false;
  else if (rawPatchChanges !== 'true' && rawPatchChanges !== '1') {
    problems.push(`PATCH_CHANGES must be true or false (got "${rawPatchChanges}")`);
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
    diamondMaxTracked,
    outsideMasterChecksPerHour,
    masteryRefreshDays,
    patchChanges,
  };
}
