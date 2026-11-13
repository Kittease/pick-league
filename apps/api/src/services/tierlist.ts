/** GET /tierlist: loads the role's stats rows, then runs the pure tier list engine. */
import type { Queryable } from '@pick-league/db';
import type { TierListQuery, TierListResponse } from '@pick-league/shared';
import { buildTierList, DUO_ROLES, LANE_ROLES } from '../engine/index.ts';
import { ApiError } from '../errors.ts';
import * as repo from '../stats/repository.ts';
import { patchContext } from './recommendations.ts';

export async function tierList(q: Queryable, query: TierListQuery): Promise<TierListResponse> {
  const ctx = await patchContext(q, query.patch === 'latest' ? undefined : query.patch);
  const [roleStats, vs, withRows, bans, patchMatches] = await Promise.all([
    repo.loadRoleStats(q, ctx.patches),
    repo.loadVsForRole(q, ctx.patches, query.role, LANE_ROLES[query.role]),
    repo.loadWithForRole(q, ctx.patches, query.role, DUO_ROLES[query.role]),
    repo.loadBans(q, ctx.patches),
    repo.loadPatchMatches(q, ctx.patches),
  ]);
  if (!roleStats.some((r) => r.position === query.role)) {
    throw new ApiError('NO_DATA', `No stats for role ${query.role} yet`);
  }
  return buildTierList(query.role, {
    currentPatch: ctx.current,
    previousPatch: ctx.previous,
    roleStats,
    vs,
    with: withRows,
    bans,
    patchMatches,
  });
}
