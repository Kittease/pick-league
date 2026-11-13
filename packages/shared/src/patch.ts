/**
 * Patch helpers. A patch id is `major.minor` (e.g. '15.22'): the prefix of a match's
 * `info.gameVersion` ('15.22.715.1234') and of a Data Dragon version ('15.22.1').
 */

export type PatchId = string;

const PATCH_PREFIX = /^(\d+)\.(\d+)(?:\.|$)/;

function majorMinor(version: string): PatchId {
  const m = PATCH_PREFIX.exec(version.trim());
  if (!m) throw new Error(`Invalid version "${version}" (expected major.minor[...])`);
  return `${Number(m[1])}.${Number(m[2])}`;
}

/** '15.22.715.1234' → '15.22' */
export function patchFromGameVersion(gameVersion: string): PatchId {
  return majorMinor(gameVersion);
}

/** '15.22.1' → '15.22'. Throws for non-patch entries such as 'lolpatch_7.20'. */
export function patchFromDdragonVersion(ddragonVersion: string): PatchId {
  return majorMinor(ddragonVersion);
}

export function isPatchId(value: string): boolean {
  return /^\d+\.\d+$/.test(value);
}

/** Numeric comparison: negative if a < b, 0 if equal, positive if a > b ('15.9' < '15.10'). */
export function comparePatches(a: PatchId, b: PatchId): number {
  const [aMaj = 0, aMin = 0] = a.split('.').map(Number);
  const [bMaj = 0, bMin = 0] = b.split('.').map(Number);
  return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
}

/** Sorts patch ids newest first (returns a new array). */
export function sortPatchesDesc(patches: readonly PatchId[]): PatchId[] {
  return [...patches].sort((a, b) => comparePatches(b, a));
}

/** Newest patch of the list, or null if empty. */
export function latestPatch(patches: readonly PatchId[]): PatchId | null {
  return sortPatchesDesc(patches)[0] ?? null;
}
