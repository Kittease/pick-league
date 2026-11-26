/** Patch changes read by the worker from the game files (0036): the selector index and one diff. */
import {
  getPatchChanges,
  listPatchChangeSets,
  type PatchChangeRow,
  type PatchChangeSetRow,
  type Queryable,
} from '@pick-league/db';
import type {
  PatchChampionChange,
  PatchChangeSetSummary,
  PatchChangesIndexResponse,
  PatchChangesQuery,
  PatchChangesResponse,
  PatchItemChange,
  PatchValueChange,
} from '@pick-league/shared';
import { ApiError } from '../errors.ts';

function summary(s: PatchChangeSetRow): PatchChangeSetSummary {
  return {
    patch: s.patch,
    build: s.build,
    kind: s.kind,
    source: s.source,
    basePatch: s.basePatch,
    baseBuild: s.baseBuild,
    detectedAt: s.firstSeenAt.toISOString(),
    changedChampions: s.changedChampions,
    changedItems: s.changedItems,
    gameplayChanged: s.changedChampions + s.changedItems > 0,
  };
}

export async function patchChangesIndex(q: Queryable): Promise<PatchChangesIndexResponse> {
  const patches: PatchChangesIndexResponse['patches'] = [];
  for (const s of await listPatchChangeSets(q)) {
    const last = patches.at(-1);
    if (last?.patch === s.patch) last.sets.push(summary(s));
    else patches.push({ patch: s.patch, sets: [summary(s)] });
  }
  return { patches };
}

/** Rows (in their stored order) grouped by champion / item, values as the contract shows them. */
function group(rows: PatchChangeRow[]): Pick<PatchChangesResponse, 'champions' | 'items'> {
  const champions = new Map<number, PatchChampionChange>();
  const items = new Map<number, PatchItemChange>();
  const entityOf = (r: PatchChangeRow): PatchChampionChange | PatchItemChange => {
    const base = { name: r.name, status: r.status, changes: [] };
    if (r.kind === 'champion') {
      const id = r.championId as number;
      const found = champions.get(id) ?? { championId: id, ...base };
      champions.set(id, found);
      return found;
    }
    const id = r.itemId as number;
    const found = items.get(id) ?? { itemId: id, ...base };
    items.set(id, found);
    return found;
  };
  for (const r of rows) {
    const entity = entityOf(r);
    if (r.valueName === null) continue; // a new or removed entity: no value
    const change: PatchValueChange = {
      slot: r.slot,
      spellName: r.spellName,
      calculation: r.calculation,
      valueName: r.valueName,
      oldValues: r.oldValues,
      newValues: r.newValues,
      path: r.path ?? '',
    };
    entity.changes.push(change);
  }
  return { champions: [...champions.values()], items: [...items.values()] };
}

/**
 * The patch diff of `patch` ('latest': the newest patch with one), or the diff of one of its
 * builds, with the patch's hotfixes listed. 404 when there is none.
 */
export async function patchChanges(
  q: Queryable,
  query: PatchChangesQuery,
): Promise<PatchChangesResponse> {
  const sets = await listPatchChangeSets(q);
  const patch =
    query.patch === 'latest' ? sets.find((s) => s.kind === 'patch')?.patch : query.patch;
  const ofPatch = sets.filter((s) => s.patch === patch);
  const set =
    query.build === undefined
      ? ofPatch.find((s) => s.kind === 'patch')
      : ofPatch.find((s) => s.build === query.build);
  if (!set) {
    const what = query.build ? `build ${query.build} of patch ${patch}` : `patch ${patch}`;
    throw new ApiError('NOT_FOUND', `No patch changes for ${what}`);
  }
  return {
    ...summary(set),
    ...group(await getPatchChanges(q, set.id)),
    hotfixes: ofPatch.filter((s) => s.kind === 'hotfix').map(summary),
  };
}
