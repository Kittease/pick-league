/**
 * GET /patch-notes: one change set (see `GET /patch-changes`) classified for the patch notes
 * page — buff / nerf per value weighted by the champion's damage split, a verdict per champion
 * and item, the observed win rate change, and who builds the changed items. Rules: the pure
 * `engine/patch-notes.ts`.
 */
import { getPatchChanges, listPatches, type Queryable } from '@pick-league/db';
import type {
  PatchId,
  PatchNotesChampion,
  PatchNotesItem,
  PatchNotesQuery,
  PatchNotesResponse,
} from '@pick-league/shared';
import {
  classifyChanges,
  compareVerdicts,
  damageSplitOf,
  groupBySlot,
  itemUsersOf,
  observedChanges,
  PATCH_NOTES_CONFIG,
  verdictOf,
} from '../engine/patch-notes.ts';
import type { ChampionTraitRow, RoleStatRow } from '../engine/types.ts';
import * as repo from '../stats/repository.ts';
import { findChangeSet, group, summary } from './patch-changes.ts';
import { statsPatches } from './stats-patches.ts';

export async function patchNotes(
  q: Queryable,
  query: PatchNotesQuery,
): Promise<PatchNotesResponse> {
  const { set, hotfixes } = await findChangeSet(q, query);
  const [rows, kept] = await Promise.all([
    getPatchChanges(q, set.id),
    listPatches(q).then((ps) => ps.map((p) => p.id)),
  ]);
  const { champions, items } = group(rows);
  const stats = kept.length > 0 ? await statsPatches(q, kept) : null;

  // Damage splits: the patch's own stats when they are kept, else the newest stats' patch.
  const statsKept = stats ? [stats.current, ...(stats.previous ? [stats.previous] : [])] : [];
  const traitPatches: PatchId[] = statsKept.includes(set.patch)
    ? [set.patch, ...statsKept.filter((p) => p !== set.patch)]
    : statsKept;
  const championIds = champions.map((c) => c.championId);
  // Win rates before / after: only for the patch the stats are served from, while they keep the
  // previous one.
  const observedPatches =
    stats?.previous && stats.current === set.patch
      ? { current: stats.current, previous: stats.previous }
      : null;
  const [traits, ratings, roleStats, itemRows] = await Promise.all([
    traitPatches.length > 0
      ? repo.loadChampionTraits(q, traitPatches, championIds)
      : Promise.resolve<ChampionTraitRow[]>([]),
    repo.loadChampionRatings(q, kept, championIds),
    observedPatches
      ? repo.loadRoleStats(q, [observedPatches.current, observedPatches.previous])
      : Promise.resolve<RoleStatRow[]>([]),
    stats
      ? repo.loadItemUsers(
          q,
          stats.current,
          items.map((i) => i.itemId),
          PATCH_NOTES_CONFIG.minRoleGames,
        )
      : Promise.resolve([]),
  ]);

  const notesChampions: PatchNotesChampion[] = champions.map((c) => {
    const own = traits
      .filter((t) => t.championId === c.championId)
      .sort((a, b) => traitPatches.indexOf(a.patch) - traitPatches.indexOf(b.patch));
    const damage = damageSplitOf(own, ratings.get(c.championId));
    const classified = classifyChanges(c.changes, damage);
    return {
      championId: c.championId,
      name: c.name,
      status: c.status,
      ...verdictOf(c.status, classified),
      damage,
      spells: groupBySlot(classified),
      observed: observedPatches
        ? observedChanges(
            c.championId,
            roleStats,
            observedPatches.current,
            observedPatches.previous,
          )
        : [],
    };
  });

  const notesItems: PatchNotesItem[] = items.map((i) => {
    const classified = classifyChanges(i.changes, null).map(({ slot: _slot, ...c }) => c);
    return {
      itemId: i.itemId,
      name: i.name,
      status: i.status,
      ...verdictOf(i.status, classified),
      changes: classified,
    };
  });
  notesChampions.sort(compareVerdicts);
  notesItems.sort(compareVerdicts);

  const users = itemUsersOf(itemRows);
  return {
    ...summary(set),
    hotfixes: hotfixes.map(summary),
    champions: notesChampions,
    items: notesItems,
    itemUsers: notesItems.map((i) => ({
      itemId: i.itemId,
      name: i.name,
      verdict: i.verdict,
      users: users.get(i.itemId) ?? [],
    })),
    statsPatch: stats?.current ?? null,
    observedPatches,
    thresholds: {
      minItemShare: PATCH_NOTES_CONFIG.minItemShare,
      minRoleGames: PATCH_NOTES_CONFIG.minRoleGames,
      minObservedGames: PATCH_NOTES_CONFIG.minObservedGames,
    },
  };
}
