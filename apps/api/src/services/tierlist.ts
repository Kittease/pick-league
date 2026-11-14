/** GET /tierlist: loads the role's stats rows, then runs the pure tier list engine. */
import type { Queryable } from '@pick-league/db';
import type {
  PatchId,
  Position,
  TierListFilters,
  TierListQuery,
  TierListRank,
  TierListResponse,
} from '@pick-league/shared';
import { buildTierList, DUO_ROLES, LANE_ROLES, type TierListData } from '../engine/index.ts';
import { ApiError } from '../errors.ts';
import * as repo from '../stats/repository.ts';
import { patchContext } from './recommendations.ts';

/** Minimum `rank_level` of stats_tierlist_participants per rank filter. */
const MIN_RANK_LEVEL: Record<TierListRank, number> = { MASTER: 0, GRANDMASTER: 1, CHALLENGER: 2 };

/** Segment of the filtered views, or null for the defaults (every player: unfiltered views). */
export function tierListSegment(filters: TierListFilters): repo.TierListSegment | null {
  if (filters.platform === 'ALL' && filters.rank === 'MASTER') return null;
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
  const [roleStats, vs, withRows, bans, patchMatches] = segment
    ? await Promise.all([
        repo.loadSegmentRoleStats(q, patches, role, segment),
        repo.loadSegmentVsForRole(q, patches, role, LANE_ROLES[role], segment),
        repo.loadSegmentWithForRole(q, patches, role, DUO_ROLES[role], segment),
        repo.loadSegmentBans(q, patches, segment),
        repo.loadSegmentTotals(q, patches, segment),
      ])
    : await Promise.all([
        repo.loadRoleStats(q, patches),
        repo.loadVsForRole(q, patches, role, LANE_ROLES[role]),
        repo.loadWithForRole(q, patches, role, DUO_ROLES[role]),
        repo.loadBans(q, patches),
        repo.loadPatchMatches(q, patches),
      ]);
  return { roleStats, vs, with: withRows, bans, patchMatches };
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
    { currentPatch: ctx.current, previousPatch: ctx.previous, ...rows },
    filters,
  );
}
