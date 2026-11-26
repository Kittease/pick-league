/**
 * GET /tierlist and GET /tierlist/champion: load the stats rows, then run the pure tier list
 * engine.
 */
import type { Queryable } from '@pick-league/db';
import type {
  PatchId,
  Position,
  TierListChampionQuery,
  TierListChampionResponse,
  TierListFilters,
  TierListQuery,
  TierListRank,
  TierListResponse,
} from '@pick-league/shared';
import {
  buildTierList,
  buildTierListChampion,
  DUO_ROLES,
  LANE_ROLES,
  type TierListData,
} from '../engine/index.ts';
import { ApiError } from '../errors.ts';
import * as repo from '../stats/repository.ts';
import { patchContext } from './recommendations.ts';

/** Minimum `rank_level` of stats_tierlist_participants per rank filter. */
const MIN_RANK_LEVEL: Record<TierListRank, number> = {
  DIAMOND: 0,
  MASTER: 1,
  GRANDMASTER: 2,
  CHALLENGER: 3,
};

/** Segment of the filtered views, or null for the defaults (every player: unfiltered views). */
export function tierListSegment(filters: TierListFilters): repo.TierListSegment | null {
  if (filters.platform === 'ALL' && filters.rank === 'DIAMOND') return null;
  return {
    platform: filters.platform === 'ALL' ? null : filters.platform,
    minRankLevel: MIN_RANK_LEVEL[filters.rank],
  };
}

type TierListRows = Omit<TierListData, 'currentPatch' | 'previousPatch'>;

async function loadRows(
  q: Queryable,
  patches: PatchId[],
  role: Position,
  segment: repo.TierListSegment | null,
): Promise<TierListRows> {
  const [roleStats, bans, patchMatches] = segment
    ? await Promise.all([
        repo.loadSegmentRoleStats(q, patches, role, segment),
        repo.loadSegmentBans(q, patches, segment),
        repo.loadSegmentTotals(q, patches, segment),
      ])
    : await Promise.all([
        repo.loadRoleStats(q, patches),
        repo.loadBans(q, patches),
        repo.loadPatchMatches(q, patches),
      ]);
  return { roleStats, bans, patchMatches };
}

export async function tierList(q: Queryable, query: TierListQuery): Promise<TierListResponse> {
  const ctx = await patchContext(q, query.patch === 'latest' ? undefined : query.patch);
  const filters: TierListFilters = { platform: query.platform, rank: query.rank };
  const segment = tierListSegment(filters);
  const rows = await loadRows(q, ctx.patches, query.role, segment);
  // A filtered list may legitimately be empty (e.g. few Challenger players on a server).
  if (!segment && !rows.roleStats.some((r) => r.position === query.role)) {
    throw new ApiError('NO_DATA', `No stats for role ${query.role} yet`);
  }
  return buildTierList(
    query.role,
    {
      currentPatch: ctx.current,
      previousPatch: ctx.previous,
      changedChampions: ctx.changedChampions,
      ...rows,
    },
    filters,
  );
}

export async function tierListChampion(
  q: Queryable,
  query: TierListChampionQuery,
): Promise<TierListChampionResponse> {
  const { role, championId } = query;
  const ctx = await patchContext(q, query.patch === 'latest' ? undefined : query.patch);
  const filters: TierListFilters = { platform: query.platform, rank: query.rank };
  const segment = tierListSegment(filters);
  // The filtered views only hold lane opponents and duo partners: no synergies under filters.
  // Role baselines of every champion (the role must have data), relations of this one only.
  // Lane phase and game length are unfiltered only: no lane numbers or profile under filters.
  const [roleStats, vs, withRows, lanePhase, gameLength] = segment
    ? await Promise.all([
        repo.loadSegmentRoleStats(q, ctx.patches, role, segment),
        repo.loadSegmentVsForRole(q, ctx.patches, role, LANE_ROLES[role], segment, championId),
        repo.loadSegmentWithForRole(q, ctx.patches, role, DUO_ROLES[role], segment, championId),
        [],
        [],
      ])
    : await Promise.all([
        repo.loadRoleStats(q, ctx.patches),
        repo.loadLaneVsOfChampion(q, ctx.patches, role, championId, LANE_ROLES[role]),
        repo.loadAlliesOfChampion(q, ctx.patches, role, championId),
        repo.loadLanePhaseOfChampion(q, ctx.patches, role, championId),
        repo.loadGameLength(q, ctx.patches, role),
      ]);
  const inRole = roleStats.filter((r) => r.position === role);
  if (inRole.length === 0) throw new ApiError('NO_DATA', `No stats for role ${role} yet`);
  if (!inRole.some((r) => r.championId === championId)) {
    throw new ApiError('NOT_FOUND', `No games of champion ${championId} in role ${role}`);
  }
  const detail = buildTierListChampion(role, championId, {
    currentPatch: ctx.current,
    previousPatch: ctx.previous,
    changedChampions: ctx.changedChampions,
    roleStats,
    vs,
    with: withRows,
    lanePhase,
    gameLength,
  });
  return { ...detail, filters, synergies: segment ? null : detail.synergies };
}
