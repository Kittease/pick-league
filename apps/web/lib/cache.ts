/**
 * How long the API's GET answers are reused (seconds), by the server's data cache (`fetch`
 * `next.revalidate`) and by the CDN in front of the gateway (`s-maxage`). The API refreshes its
 * stats hourly and caches its own answers ~10 minutes; static data changes with the patch.
 */
export const REVALIDATE = {
  health: 60,
  statsStatus: 60,
  patches: 3600,
  static: 6 * 3600,
  tierList: 600,
  tierListChampion: 600,
  patchNotes: 600,
} as const;

/** Cache tags of the API's GET answers (for `revalidateTag`). */
export const TAGS = {
  health: 'api:health',
  statsStatus: 'api:stats-status',
  patches: 'api:patches',
  static: 'api:static',
  tierList: 'api:tierlist',
  patchNotes: 'api:patch-notes',
} as const;
