/** Loads the stats rows a request needs, then runs the pure engine. */
import { listPatches, type Queryable } from '@pick-league/db';
import type {
  BuildRequest,
  BuildResponse,
  CompTrait,
  DraftEvaluationResponse,
  DraftRequest,
  PatchId,
  PicksRequest,
  PicksResponse,
} from '@pick-league/shared';
import {
  choosePatches,
  DUO_ROLES,
  draftPairs,
  draftRoles,
  evaluateDraft,
  LANE_ROLES,
  recommendBuild,
  recommendPicks,
  sideTraits,
  sumByKey,
  sumStats,
} from '../engine/index.ts';
import { ApiError } from '../errors.ts';
import * as repo from '../stats/repository.ts';

export interface PatchContext {
  current: PatchId;
  previous: PatchId | null;
  /** current + previous (when any). */
  patches: PatchId[];
}

/** Current/previous patch, or the forced one (`patch` in the body: no previous patch added). */
export async function patchContext(q: Queryable, forced?: PatchId): Promise<PatchContext> {
  const kept = (await listPatches(q)).map((p) => p.id);
  if (forced !== undefined) {
    if (!kept.includes(forced)) throw new ApiError('NOT_FOUND', `Unknown patch ${forced}`);
    return { current: forced, previous: null, patches: [forced] };
  }
  const [current, previous] = kept;
  if (!current) throw new ApiError('NO_DATA', 'No patch ingested yet');
  return {
    current,
    previous: previous ?? null,
    patches: previous ? [current, previous] : [current],
  };
}

export async function picks(q: Queryable, req: PicksRequest): Promise<PicksResponse> {
  const ctx = await patchContext(q, req.patch);
  const enemyIds = req.enemies.filter((e): e is number => e !== null);
  const allyIds = req.allies.flatMap((a) => (a.championId !== null ? [a.championId] : []));
  const [roleStats, vs, withRows, compTraits, championTraits, thresholds, lanePhase, names] =
    await Promise.all([
      repo.loadRoleStats(q, ctx.patches),
      repo.loadVsByEnemies(q, ctx.patches, req.role, enemyIds),
      repo.loadWithByAllies(q, ctx.patches, req.role, allyIds),
      repo.loadCompTraits(q, ctx.patches, req.role),
      repo.loadChampionTraits(q, ctx.patches, [...enemyIds, ...allyIds]),
      repo.loadThresholds(q, ctx.patches),
      repo.loadLanePhaseByEnemies(q, ctx.patches, req.role, enemyIds),
      repo.loadNames(q, ctx.patches),
    ]);
  if (!roleStats.some((r) => r.position === req.role)) {
    throw new ApiError('NO_DATA', `No stats for role ${req.role} yet`);
  }
  return recommendPicks(req, {
    currentPatch: ctx.current,
    previousPatch: ctx.previous,
    roleStats,
    vs,
    with: withRows,
    compTraits,
    championTraits,
    thresholds,
    lanePhase,
    names,
  });
}

export async function build(q: Queryable, req: BuildRequest): Promise<BuildResponse> {
  const ctx = await patchContext(q, req.patch);
  if (!(await repo.championExists(q, ctx.patches, req.championId))) {
    throw new ApiError('NOT_FOUND', `Unknown champion ${req.championId}`);
  }
  const enemyIds = req.enemies.map((e) => e.championId);
  const allyIds = req.allies.map((a) => a.championId);
  const [roleStats, championTraits, thresholds] = await Promise.all([
    repo.loadRoleStats(q, ctx.patches),
    repo.loadChampionTraits(q, ctx.patches, [req.championId, ...enemyIds, ...allyIds]),
    repo.loadThresholds(q, ctx.patches),
  ]);
  const find = (patch: PatchId | null) =>
    roleStats.find(
      (r) => r.patch === patch && r.championId === req.championId && r.position === req.role,
    );
  const cur = find(ctx.current);
  const prev = find(ctx.previous);
  const pc = choosePatches(ctx.current, ctx.previous, cur?.games ?? 0, prev?.games ?? 0);
  const baseline = sumStats(pc.merged ? [cur, prev].flatMap((r) => r ?? []) : cur ? [cur] : []);
  if (baseline.games === 0) {
    throw new ApiError('NO_DATA', `No games of champion ${req.championId} as ${req.role} yet`);
  }
  const { patches } = pc;
  // Only lane opponents matter for choice matchups; enemies with unknown roles are all candidates.
  const laneRoles = LANE_ROLES[req.role];
  const opponentIds = req.enemies
    .filter((e) => e.role === null || laneRoles.includes(e.role))
    .map((e) => e.championId);
  // Likewise only duo partners matter for item choices with an ally (unknown roles: candidates).
  const duoRoles = DUO_ROLES[req.role];
  const partnerIds = req.allies
    .filter((a) => a.role === null || duoRoles.includes(a.role))
    .map((a) => a.championId);
  const traitData = {
    championTraits,
    thresholds,
    currentPatch: ctx.current,
    previousPatch: ctx.previous,
  };
  const enemyTraits: CompTrait[] = sideTraits(enemyIds, traitData);
  const allyTraits: CompTrait[] = sideTraits(allyIds, traitData);
  const [
    choices,
    choiceMatchups,
    choiceTraits,
    choiceDuos,
    choiceAllyTraits,
    compTraitRows,
    vs,
    withRows,
    lanePhase,
    items,
    names,
  ] = await Promise.all([
    repo.loadChoices(q, patches, req.championId, req.role),
    repo.loadChoiceMatchups(q, patches, req.championId, req.role, opponentIds),
    repo.loadChoiceTraits(q, patches, req.championId, req.role, enemyTraits),
    repo.loadChoiceDuos(q, patches, req.championId, req.role, partnerIds),
    repo.loadChoiceAllyTraits(q, patches, req.championId, req.role, allyTraits),
    repo.loadCompTraits(q, patches, req.role, req.championId),
    repo.loadVsForChampion(q, patches, req.championId, req.role, opponentIds),
    repo.loadWithForChampion(q, patches, req.championId, req.role, partnerIds),
    repo.loadLanePhaseOfChampion(q, patches, req.role, req.championId, opponentIds),
    repo.loadItems(q, ctx.current),
    repo.loadNames(q, ctx.patches),
  ]);
  const compTraits = sumByKey(compTraitRows, (r) => `${r.side}|${r.trait}`);
  const result = recommendBuild(req, {
    currentPatch: ctx.current,
    previousPatch: ctx.previous,
    patch: pc,
    baseline,
    roleStats,
    choices,
    choiceMatchups,
    choiceTraits,
    choiceDuos,
    choiceAllyTraits,
    compTraits,
    vs,
    with: withRows,
    championTraits,
    thresholds,
    items,
    lanePhase,
    names,
  });
  if (!result)
    throw new ApiError('NO_DATA', `No build data for champion ${req.championId} as ${req.role}`);
  return result;
}

/** Win probability and damage profile of a draft in any state. */
export async function draft(q: Queryable, req: DraftRequest): Promise<DraftEvaluationResponse> {
  const ctx = await patchContext(q, req.patch);
  const roleStats = await repo.loadRoleStats(q, ctx.patches);
  if (roleStats.length === 0) throw new ApiError('NO_DATA', 'No stats yet');
  const roles = draftRoles(req, roleStats);
  const pairs = draftPairs(roles);
  const ids = [...req.allies, ...req.enemies].map((p) => p.championId);
  const [vs, withRows, championTraits, sides, names, gameLength] = await Promise.all([
    repo.loadVsPairs(q, ctx.patches, pairs.vs),
    repo.loadWithPairs(q, ctx.patches, pairs.with),
    repo.loadChampionTraits(q, ctx.patches, ids),
    repo.loadSideWins(q, ctx.patches),
    repo.loadNames(q, ctx.patches),
    repo.loadGameLength(q, ctx.patches),
  ]);
  return evaluateDraft(
    req,
    {
      currentPatch: ctx.current,
      previousPatch: ctx.previous,
      roleStats,
      vs,
      with: withRows,
      championTraits,
      sides,
      names,
      gameLength,
    },
    roles,
  );
}
