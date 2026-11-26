/** Loads the stats rows a request needs, then runs the pure engine. */
import { changedChampionIds, listPatches, type Queryable } from '@pick-league/db';
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
  DUO_ROLES,
  draftPairs,
  draftRoles,
  ENGINE_CONFIG,
  evaluateDraft,
  LANE_ROLES,
  type PatchChoice,
  patchesUsedFor,
  previousWeight,
  recommendBuild,
  recommendPicks,
  sideTraits,
  sumWeighted,
} from '../engine/index.ts';
import { ApiError } from '../errors.ts';
import * as repo from '../stats/repository.ts';
import { statsPatches } from './stats-patches.ts';

export interface PatchContext {
  current: PatchId;
  previous: PatchId | null;
  /** current + previous (when any). */
  patches: PatchId[];
  /**
   * Champions changed (or new) on the current patch per the game files (patch_changes): their own
   * strength takes a smaller previous-patch prior. Empty when the patch is forced (no previous
   * patch) or has no change set yet.
   */
  changedChampions: ReadonlySet<number>;
}

/**
 * Current/previous patch of the stats (see `pickStatsPatches`), or the forced one (`patch` in the
 * body: no previous patch added).
 */
export async function patchContext(q: Queryable, forced?: PatchId): Promise<PatchContext> {
  const kept = (await listPatches(q)).map((p) => p.id);
  if (forced !== undefined) {
    if (!kept.includes(forced)) throw new ApiError('NOT_FOUND', `Unknown patch ${forced}`);
    return { current: forced, previous: null, patches: [forced], changedChampions: new Set() };
  }
  const [stats, changed] = await Promise.all([statsPatches(q, kept), changedChampionIds(q, kept)]);
  if (!stats) throw new ApiError('NO_DATA', 'No patch ingested yet');
  const { current, previous } = stats;
  return {
    current,
    previous,
    patches: previous ? [current, previous] : [current],
    changedChampions: new Set(changed.get(current) ?? []),
  };
}

export async function picks(q: Queryable, req: PicksRequest): Promise<PicksResponse> {
  const ctx = await patchContext(q, req.patch);
  const enemyIds = req.enemies.filter((e): e is number => e !== null);
  const allyIds = req.allies.flatMap((a) => (a.championId !== null ? [a.championId] : []));
  const [
    roleStats,
    vs,
    withRows,
    compTraits,
    championTraits,
    thresholds,
    lanePhase,
    names,
    mastery,
  ] = await Promise.all([
    repo.loadRoleStats(q, ctx.patches),
    repo.loadVsByEnemies(q, ctx.patches, req.role, enemyIds),
    repo.loadWithByAllies(q, ctx.patches, req.role, allyIds),
    repo.loadCompTraits(q, ctx.patches, req.role),
    repo.loadChampionTraits(q, ctx.patches, [...enemyIds, ...allyIds]),
    repo.loadThresholds(q, ctx.patches),
    repo.loadLanePhaseByEnemies(q, ctx.patches, req.role, enemyIds),
    repo.loadNames(q, ctx.patches),
    // Only champion select on the desktop sends masteries: nobody else reads the view.
    req.masteries ? repo.loadMasteryRows(q, ctx.patches) : undefined,
  ]);
  if (!roleStats.some((r) => r.position === req.role)) {
    throw new ApiError('NO_DATA', `No stats for role ${req.role} yet`);
  }
  return recommendPicks(req, {
    currentPatch: ctx.current,
    previousPatch: ctx.previous,
    changedChampions: ctx.changedChampions,
    roleStats,
    vs,
    with: withRows,
    compTraits,
    championTraits,
    thresholds,
    lanePhase,
    mastery,
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
  // One weight for every previous-patch row of the champion+role (its choices, their contexts,
  // its pairs), so the choices stay comparable with each other and with the baseline.
  const curGames = cur?.games ?? 0;
  const prevGames = ctx.previous ? (prev?.games ?? 0) : 0;
  const w = previousWeight(prevGames, ENGINE_CONFIG.previousPatchPrior.build);
  const weights: repo.PatchWeight[] = [
    { patch: ctx.current, weight: 1 },
    ...(ctx.previous && w > 0 ? [{ patch: ctx.previous, weight: w }] : []),
  ];
  const effective = curGames + w * prevGames;
  const games = Math.round(effective);
  // Wins scaled like the loaders' (same win rate on the rounded games).
  const weightedWins = (cur?.wins ?? 0) + w * (prev?.wins ?? 0);
  const baseline = { games, wins: games > 0 ? (weightedWins * games) / effective : 0 };
  if (baseline.games === 0) {
    throw new ApiError('NO_DATA', `No games of champion ${req.championId} as ${req.role} yet`);
  }
  const previousShare = effective > 0 ? (w * prevGames) / effective : 0;
  const pc: PatchChoice = {
    patches: patchesUsedFor({ current: ctx.current, previous: ctx.previous }, previousShare),
    previousWeight: w,
    previousShare,
    currentGames: curGames,
  };
  const patches = weights.map((x) => x.patch);
  const weightOf = (patch: PatchId) => weights.find((x) => x.patch === patch)?.weight ?? 0;
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
    itemSwaps,
    items,
    names,
  ] = await Promise.all([
    repo.loadChoices(q, weights, req.championId, req.role),
    repo.loadChoiceMatchups(q, weights, req.championId, req.role, opponentIds),
    repo.loadChoiceTraits(q, weights, req.championId, req.role, enemyTraits),
    repo.loadChoiceDuos(q, weights, req.championId, req.role, partnerIds),
    repo.loadChoiceAllyTraits(q, weights, req.championId, req.role, allyTraits),
    repo.loadCompTraits(q, patches, req.role, req.championId),
    repo.loadVsForChampion(q, weights, req.championId, req.role, opponentIds),
    repo.loadWithForChampion(q, weights, req.championId, req.role, partnerIds),
    repo.loadLanePhaseOfChampion(q, patches, req.role, req.championId, opponentIds),
    // Both kept patches summed as they are (thin samples), whatever the build's patch weighting.
    repo.loadItemSwaps(q, ctx.patches, req.role, req.championId),
    repo.loadItems(q, ctx.current),
    repo.loadNames(q, ctx.patches),
  ]);
  const compTraits = sumWeighted(compTraitRows, weightOf, (r) => `${r.side}|${r.trait}`);
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
    itemSwaps,
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
      changedChampions: ctx.changedChampions,
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
