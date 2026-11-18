/** Which kept patches the stats are served from. */
import { listPatches, type Queryable } from '@pick-league/db';
import type { PatchId } from '@pick-league/shared';

export interface StatsPatches {
  current: PatchId;
  previous: PatchId | null;
}

/**
 * `kept` is newest first. The current patch is the newest one the refreshed stats have matches
 * for: Data Dragon publishes a patch about a day before the servers play it, and its first
 * matches only count once a stats refresh has included them. Until then the patch before it stays
 * current. Without any stats (new database) the newest patch is current. Null without a patch.
 */
export function pickStatsPatches(
  kept: readonly PatchId[],
  withStats: readonly PatchId[],
): StatsPatches | null {
  const has = new Set(withStats);
  const at = kept.findIndex((p) => has.has(p));
  const i = Math.max(at, 0);
  const current = kept[i];
  if (current === undefined) return null;
  return { current, previous: kept[i + 1] ?? null };
}

/** Kept patches with matches in the refreshed stats (stats_patch_matches). */
export async function statsPatches(
  q: Queryable,
  kept?: readonly PatchId[],
): Promise<StatsPatches | null> {
  const patches = kept ?? (await listPatches(q)).map((p) => p.id);
  const rows = await q<{ patch: string }[]>`
    SELECT patch FROM stats_patch_matches WHERE matches > 0`;
  return pickStatsPatches(
    patches,
    rows.map((r) => r.patch),
  );
}
