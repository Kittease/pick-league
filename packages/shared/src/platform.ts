/**
 * Riot platforms crawled by PickLeague and their API routing.
 *
 * - Platform host (league-v4, champion-mastery-v4): `https://{host}.api.riotgames.com`
 * - Match cluster (match-v5): KR→asia, EUW1→europe, NA1→americas, VN2→sea
 */

export const PLATFORMS = ['KR', 'EUW1', 'NA1', 'VN2'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const REGIONAL_CLUSTERS = ['americas', 'asia', 'europe', 'sea'] as const;
export type RegionalCluster = (typeof REGIONAL_CLUSTERS)[number];

/** Lower-case routing value used in the platform host name. */
export const PLATFORM_HOST_ID: Record<Platform, string> = {
  KR: 'kr',
  EUW1: 'euw1',
  NA1: 'na1',
  VN2: 'vn2',
};

export const MATCH_CLUSTER: Record<Platform, RegionalCluster> = {
  KR: 'asia',
  EUW1: 'europe',
  NA1: 'americas',
  VN2: 'sea',
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** Parses a case-insensitive platform id; throws on unknown values. */
export function parsePlatform(value: string): Platform {
  const upper = value.trim().toUpperCase();
  if (!isPlatform(upper)) {
    throw new Error(`Unknown platform "${value}" (expected one of ${PLATFORMS.join(', ')})`);
  }
  return upper;
}

/** Parses a comma-separated list such as the `PLATFORMS` env var. Empty/undefined → all platforms. */
export function parsePlatformList(value: string | undefined): Platform[] {
  if (!value || value.trim() === '') return [...PLATFORMS];
  const list = value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map(parsePlatform);
  return [...new Set(list)];
}

/** `https://euw1.api.riotgames.com` */
export function platformBaseUrl(platform: Platform): string {
  return `https://${PLATFORM_HOST_ID[platform]}.api.riotgames.com`;
}

/** `https://europe.api.riotgames.com` (match-v5) */
export function matchBaseUrl(platform: Platform): string {
  return `https://${MATCH_CLUSTER[platform]}.api.riotgames.com`;
}

/** Platform of a match id such as `EUW1_7234567890`. Returns null for platforms we don't crawl. */
export function platformFromMatchId(matchId: string): Platform | null {
  const prefix = matchId.split('_')[0]?.toUpperCase() ?? '';
  return isPlatform(prefix) ? prefix : null;
}
