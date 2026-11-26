/**
 * Patch changes (0036): the game builds the worker read from Community Dragon, their gameplay
 * snapshot, and the diffs between builds. Kept for more patches than the stats, without a
 * foreign key to `patches`.
 */
import { comparePatches, type PatchId } from '@pick-league/shared';
import { inTransaction, type Queryable } from '../client.ts';

/** Change sets of this many patches are kept (newest first). */
export const PATCH_CHANGES_KEPT_PATCHES = 6;
/** Snapshots are kept for the newest build of this many patches (newest first). */
export const PATCH_CHANGES_SNAPSHOT_PATCHES = 2;

export type PatchChangeSetKind = 'patch' | 'hotfix';
export type PatchChangeSetSource = 'live' | 'backfill';
export type PatchChangeStatus = 'changed' | 'new' | 'removed';

export interface GameBuildRow {
  build: string;
  patch: PatchId;
  buildNumber: number;
  version: string;
  firstSeenAt: Date;
  champions: number;
  items: number;
  hasSnapshot: boolean;
}

export interface PatchChangeInput {
  kind: 'champion' | 'item';
  championId: number | null;
  itemId: number | null;
  name: string;
  status: PatchChangeStatus;
  slot: string | null;
  spellName: string | null;
  calculation: string | null;
  valueName: string | null;
  oldValues: number[] | null;
  newValues: number[] | null;
  path: string | null;
}

export interface PatchChangeSetInput {
  kind: PatchChangeSetKind;
  source: PatchChangeSetSource;
  basePatch: PatchId;
  baseBuild: string;
  changedChampions: number;
  changedItems: number;
  changes: PatchChangeInput[];
}

export interface GameBuildInput {
  build: string;
  patch: PatchId;
  buildNumber: number;
  version: string;
  champions: number;
  items: number;
  /** Gzipped snapshot (kept only while the build is the newest of one of the newest patches). */
  snapshot: Uint8Array | null;
  /** Its diff, if any (a build read only as the base of a diff has none). */
  changeSet: PatchChangeSetInput | null;
}

interface BuildDbRow {
  build: string;
  patch: string;
  build_number: string;
  version: string;
  first_seen_at: Date;
  champions: number;
  items: number;
  has_snapshot: boolean;
}

const toBuild = (r: BuildDbRow): GameBuildRow => ({
  build: r.build,
  patch: r.patch,
  buildNumber: Number(r.build_number),
  version: r.version,
  firstSeenAt: r.first_seen_at,
  champions: r.champions,
  items: r.items,
  hasSnapshot: r.has_snapshot,
});

export async function getGameBuild(q: Queryable, build: string): Promise<GameBuildRow | null> {
  const [row] = await q<BuildDbRow[]>`
    SELECT build, patch, build_number, version, first_seen_at, champions, items,
           snapshot IS NOT NULL AS has_snapshot
    FROM game_builds WHERE build = ${build}`;
  return row ? toBuild(row) : null;
}

/** The newest build of `patch` with a snapshot, with it; null when none. */
export async function newestGameBuildSnapshot(
  q: Queryable,
  patch: PatchId,
): Promise<{ build: GameBuildRow; snapshot: Uint8Array } | null> {
  const [row] = await q<(BuildDbRow & { snapshot: Uint8Array })[]>`
    SELECT build, patch, build_number, version, first_seen_at, champions, items,
           true AS has_snapshot, snapshot
    FROM game_builds WHERE patch = ${patch} AND snapshot IS NOT NULL
    ORDER BY build_number DESC LIMIT 1`;
  return row ? { build: toBuild(row), snapshot: row.snapshot } : null;
}

/** Whether `patch` has its patch diff (the hotfixes aside). */
export async function hasPatchDiff(q: Queryable, patch: PatchId): Promise<boolean> {
  const [row] = await q`
    SELECT 1 FROM patch_change_sets WHERE patch = ${patch} AND kind = 'patch' LIMIT 1`;
  return row !== undefined;
}

/**
 * Stores a build with its snapshot and its diff in one transaction, then prunes: change sets and
 * builds of patches older than the `PATCH_CHANGES_KEPT_PATCHES` newest, snapshots of all but the
 * newest build of the `PATCH_CHANGES_SNAPSHOT_PATCHES` newest patches. A build already stored is
 * left as it is, its diff added if it had none; returns false when nothing was stored.
 */
export async function storeGameBuild(q: Queryable, input: GameBuildInput): Promise<boolean> {
  return inTransaction(q, async (tx) => {
    const inserted = await tx`
      INSERT INTO game_builds (build, patch, build_number, version, champions, items, snapshot)
      VALUES (${input.build}, ${input.patch}, ${input.buildNumber}, ${input.version},
              ${input.champions}, ${input.items}, ${input.snapshot})
      ON CONFLICT (build) DO NOTHING
      RETURNING build`;
    const set = input.changeSet;
    if (inserted.length === 0) {
      // Already read (e.g. as the base of the next patch's diff): only its missing diff is added.
      if (!set) return false;
      const [existing] = await tx`SELECT 1 FROM patch_change_sets WHERE build = ${input.build}`;
      if (existing) return false;
    }
    if (set) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO patch_change_sets
          (patch, build, kind, source, base_patch, base_build, changed_champions, changed_items)
        VALUES (${input.patch}, ${input.build}, ${set.kind}, ${set.source}, ${set.basePatch},
                ${set.baseBuild}, ${set.changedChampions}, ${set.changedItems})
        RETURNING id`;
      const setId = (row as { id: number }).id;
      const rows = set.changes.map((c, ord) => ({
        set_id: setId,
        ord,
        kind: c.kind,
        champion_id: c.championId,
        item_id: c.itemId,
        name: c.name,
        status: c.status,
        slot: c.slot,
        spell_name: c.spellName,
        calculation: c.calculation,
        value_name: c.valueName,
        old_values: c.oldValues,
        new_values: c.newValues,
        path: c.path,
      }));
      // In chunks: a large set (a new champion's rework) stays under the bind parameter limit.
      for (let i = 0; i < rows.length; i += 2000) {
        await tx`INSERT INTO patch_changes ${tx(rows.slice(i, i + 2000))}`;
      }
    }
    await prunePatchChanges(tx);
    return true;
  });
}

/** See `storeGameBuild`. */
export async function prunePatchChanges(q: Queryable): Promise<void> {
  const rows = await q<{ patch: string }[]>`SELECT DISTINCT patch FROM game_builds`;
  const patches = rows.map((r) => r.patch).sort((a, b) => comparePatches(b, a));
  const old = patches.slice(PATCH_CHANGES_KEPT_PATCHES);
  if (old.length > 0) await q`DELETE FROM game_builds WHERE patch = ANY(${old})`;
  const withSnapshot = patches.slice(0, PATCH_CHANGES_SNAPSHOT_PATCHES);
  await q`
    UPDATE game_builds g SET snapshot = NULL
    WHERE snapshot IS NOT NULL
      AND (NOT (patch = ANY(${withSnapshot}))
           OR EXISTS (SELECT 1 FROM game_builds n
                      WHERE n.patch = g.patch AND n.build_number > g.build_number
                        AND n.snapshot IS NOT NULL))`;
}

export interface PatchChangeSetRow {
  id: number;
  patch: PatchId;
  build: string;
  buildNumber: number;
  kind: PatchChangeSetKind;
  source: PatchChangeSetSource;
  basePatch: PatchId;
  baseBuild: string;
  /** When the worker first read the build. */
  firstSeenAt: Date;
  changedChampions: number;
  changedItems: number;
}

/** Every change set, newest patch first, then its builds in order (the patch diff first). */
export async function listPatchChangeSets(q: Queryable): Promise<PatchChangeSetRow[]> {
  const rows = await q<
    {
      id: number;
      patch: string;
      build: string;
      build_number: string;
      kind: PatchChangeSetKind;
      source: PatchChangeSetSource;
      base_patch: string;
      base_build: string;
      first_seen_at: Date;
      changed_champions: number;
      changed_items: number;
    }[]
  >`
    SELECT s.id, s.patch, s.build, g.build_number, s.kind, s.source, s.base_patch, s.base_build,
           g.first_seen_at, s.changed_champions, s.changed_items
    FROM patch_change_sets s JOIN game_builds g ON g.build = s.build`;
  return rows
    .map((r) => ({
      id: r.id,
      patch: r.patch,
      build: r.build,
      buildNumber: Number(r.build_number),
      kind: r.kind,
      source: r.source,
      basePatch: r.base_patch,
      baseBuild: r.base_build,
      firstSeenAt: r.first_seen_at,
      changedChampions: r.changed_champions,
      changedItems: r.changed_items,
    }))
    .sort((a, b) => comparePatches(b.patch, a.patch) || a.buildNumber - b.buildNumber);
}

export interface PatchChangeRow extends PatchChangeInput {
  ord: number;
}

/** The changes of one set, in order. */
export async function getPatchChanges(q: Queryable, setId: number): Promise<PatchChangeRow[]> {
  const rows = await q<
    {
      ord: number;
      kind: 'champion' | 'item';
      champion_id: number | null;
      item_id: number | null;
      name: string;
      status: PatchChangeStatus;
      slot: string | null;
      spell_name: string | null;
      calculation: string | null;
      value_name: string | null;
      old_values: number[] | null;
      new_values: number[] | null;
      path: string | null;
    }[]
  >`
    SELECT ord, kind, champion_id, item_id, name, status, slot, spell_name, calculation,
           value_name, old_values, new_values, path
    FROM patch_changes WHERE set_id = ${setId} ORDER BY ord`;
  return rows.map((r) => ({
    ord: r.ord,
    kind: r.kind,
    championId: r.champion_id,
    itemId: r.item_id,
    name: r.name,
    status: r.status,
    slot: r.slot,
    spellName: r.spell_name,
    calculation: r.calculation,
    valueName: r.value_name,
    oldValues: r.old_values,
    newValues: r.new_values,
    path: r.path,
  }));
}

/**
 * Champions changed (or new) on each of `patches`: in its patch diff or one of its hotfixes.
 * Patches without a change set are absent.
 */
export async function changedChampionIds(
  q: Queryable,
  patches: readonly PatchId[],
): Promise<Map<PatchId, number[]>> {
  const rows = await q<{ patch: string; champion_id: number }[]>`
    SELECT DISTINCT s.patch, c.champion_id
    FROM patch_change_sets s JOIN patch_changes c ON c.set_id = s.id
    WHERE s.patch = ANY(${patches as PatchId[]}) AND c.kind = 'champion'
      AND c.status IN ('changed', 'new')
    ORDER BY c.champion_id`;
  const out = new Map<PatchId, number[]>();
  for (const r of rows) out.set(r.patch, [...(out.get(r.patch) ?? []), r.champion_id]);
  return out;
}
