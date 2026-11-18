/**
 * Pick recommendations: for each candidate champion in the requested role, an estimate of its
 * win-rate difference, summed from shrunk deltas: its own strength vs the role average, then each
 * enemy and ally (lane matchup, duo synergy, other pairs) and the composition traits.
 *
 * A pair delta is the candidate's win rate vs/with that champion minus its own baseline, minus
 * what the role usually gets vs/with it (games-weighted over every candidate): a strong enemy
 * lowers everyone's win rate, which says nothing about which candidate to pick. Without that,
 * popular candidates (whose big samples keep the enemy's strength after shrinkage) were
 * penalised vs strong enemies and favoured vs weak ones.
 *
 * Every delta is measured inside one patch (against that patch's baseline, role average and usual
 * term), then the current and previous patches are blended, the previous one as a prior worth a
 * capped number of games (`previousPatchPrior`): a champion buffed on the new patch must not see
 * its mostly-previous-patch matchups compared with its new, higher win rate.
 */
import type {
  CompTrait,
  PatchId,
  PickCandidate,
  PicksRequest,
  PicksResponse,
  Position,
  Reason,
} from '@pick-league/shared';
import {
  DUO_ROLES,
  ENGINE_CONFIG,
  LANE_ROLES,
  ROLE_LABELS,
  ROLE_PLURALS,
  TRAIT_LABELS,
} from './config.ts';
import { lanePhaseDiff, lanePhaseReason, lanePhaseRowsOf } from './lane-phase.ts';
import { buildMasteryModel, masteryBucket, masteryPoints, masteryReason } from './mastery.ts';
import {
  type Blend,
  blendPatches,
  formatDelta,
  formatGames,
  formatRate,
  type PatchPair,
  type PatchSample,
  round,
  sampleConfidence,
  shownGames,
  shrink,
  sumStats,
  winRate,
} from './math.ts';
import { assignRoles, type RoleGuess, rolePlayRates } from './roles.ts';
import { championBaseline, rowsByPatchAndChampion } from './tierlist.ts';
import { compProfile, compTraits } from './traits.ts';
import type {
  ChampionTraitRow,
  CompSide,
  CompThresholdRow,
  CompTraitRow,
  GamesWins,
  LanePhaseRow,
  MasteryRow,
  NameLookup,
  RoleStatRow,
  VsRow,
  WithRow,
} from './types.ts';

export interface PicksData {
  currentPatch: PatchId;
  previousPatch: PatchId | null;
  /** stats_champion_roles of both patches (all champions, all roles). */
  roleStats: readonly RoleStatRow[];
  /** stats_champion_vs with position = request role and enemy in the request's enemies. */
  vs: readonly VsRow[];
  /** stats_champion_with with position = request role and ally in the request's allies. */
  with: readonly WithRow[];
  /** stats_champion_comp_traits with position = request role. */
  compTraits: readonly CompTraitRow[];
  /** stats_champion_traits of the request's allies and enemies. */
  championTraits: readonly ChampionTraitRow[];
  thresholds: readonly CompThresholdRow[];
  /**
   * stats_champion_lane_phase with position = request role and enemy in the request's enemies
   * (optional: no lane_phase reasons without it).
   */
  lanePhase?: readonly LanePhaseRow[];
  /**
   * stats_champion_mastery of every champion and role (optional: loaded only when the request
   * carries the player's masteries; no mastery reasons without it).
   */
  mastery?: readonly MasteryRow[];
  names: NameLookup;
}

const W = ENGINE_CONFIG.picks.weights;
const K = ENGINE_CONFIG.picks.shrinkK;
const CK = ENGINE_CONFIG.confidenceK;
const PRIOR = ENGINE_CONFIG.previousPatchPrior;

interface Component {
  reason: Reason;
  /** weight × shrunk delta */
  contribution: number;
  weight: number;
  confidence: number;
  order: number;
}

const KIND_ORDER: Record<Reason['kind'], number> = {
  patch_fallback: 0,
  matchup: 1,
  // Same rank as matchup: placed right after the lane matchup it explains (see `order`).
  lane_phase: 1,
  duo: 2,
  // After the lane and the duo, before the composition traits.
  mastery: 2.5,
  vs_comp: 3,
  with_comp: 4,
  base: 5,
  popularity: 6,
  item_swap: 7,
  tag_rule: 8,
  side: 9,
};

/** Resolves the traits of a side from champion profiles (current patch, else previous). */
export function sideTraits(
  championIds: readonly number[],
  data: Pick<PicksData, 'championTraits' | 'thresholds' | 'currentPatch' | 'previousPatch'>,
): CompTrait[] {
  const profiles = championIds.flatMap((id) => {
    const cur = data.championTraits.find(
      (t) => t.championId === id && t.patch === data.currentPatch,
    );
    const prev = data.championTraits.find(
      (t) => t.championId === id && t.patch === data.previousPatch,
    );
    const row = cur && cur.games > 0 ? cur : prev;
    return row ? [row] : [];
  });
  const threshold =
    data.thresholds.find((t) => t.patch === data.currentPatch && t.teams > 0) ??
    data.thresholds.find((t) => t.patch === data.previousPatch);
  return compTraits(compProfile(profiles), threshold);
}

export function recommendPicks(req: PicksRequest, data: PicksData): PicksResponse {
  const role = req.role;
  const names = data.names;
  const knownEnemies = req.enemies.filter((e): e is number => e !== null);
  const knownAllies = req.allies.filter(
    (a): a is { championId: number; role: Position | null } => a.championId !== null,
  );
  const excluded = new Set<number>([
    ...req.bans,
    ...knownEnemies,
    ...knownAllies.map((a) => a.championId),
  ]);
  const available = req.availableChampionIds ? new Set(req.availableChampionIds) : null;
  // The player's own masteries (champion select on the desktop only).
  const masteryModel = req.masteries && data.mastery ? buildMasteryModel(data.mastery) : null;
  const myPoints = masteryPoints(req.masteries ?? []);

  const playRates = rolePlayRates(data.roleStats);
  const enemyRoles = assignRoles(
    knownEnemies.map((championId) => ({ championId, role: null })),
    playRates,
  );
  const allyRoles = assignRoles(knownAllies, playRates, [role]);
  // The lane opponent the lane phase is shown for: the enemy in the same role, else (bot lane)
  // the other enemy bot laner.
  const laneOpponent =
    enemyRoles.find((e) => e.role === role) ??
    enemyRoles.find((e) => LANE_ROLES[role].includes(e.role));
  const enemyTraits = sideTraits(knownEnemies, data);
  const allyTraits = sideTraits(
    knownAllies.map((a) => a.championId),
    data,
  );

  // Indexes
  const roleRow = new Map<string, RoleStatRow>();
  for (const r of data.roleStats) roleRow.set(`${r.patch}|${r.championId}|${r.position}`, r);
  const vsIndex = groupBy(data.vs, (r) => `${r.patch}|${r.championId}|${r.enemyId}`);
  const withIndex = groupBy(data.with, (r) => `${r.patch}|${r.championId}|${r.allyId}`);
  const compIndex = groupBy(
    data.compTraits,
    (r) => `${r.patch}|${r.championId}|${r.side}|${r.trait}`,
  );

  // Role-wide effect of a trait on one patch (so a trait that helps every champion doesn't count).
  const roleTraitShift = memo((key: string) => {
    const [patch, side, trait] = key.split('|');
    const withTrait = sumStats(
      data.compTraits.filter((r) => r.patch === patch && r.side === side && r.trait === trait),
    );
    const all = sumStats(data.roleStats.filter((r) => r.patch === patch && r.position === role));
    return withTrait.games > 0 && all.games > 0 ? winRate(withTrait) - winRate(all) : 0;
  });

  // Role baseline on one patch.
  const roleWinRate = memo((patch: string) =>
    winRate(sumStats(data.roleStats.filter((r) => r.patch === patch && r.position === role))),
  );
  const baselineOn = (championId: number, patch: PatchId): GamesWins | undefined =>
    roleRow.get(`${patch}|${championId}|${role}`);
  const inRole = rowsByPatchAndChampion(data.roleStats, role);
  const patchPair: PatchPair = { current: data.currentPatch, previous: data.previousPatch };
  const roleHasCurrentGames = data.roleStats.some(
    (r) => r.patch === data.currentPatch && r.position === role && r.games > 0,
  );

  // What the role usually gets vs/with a champion on one patch: games-weighted mean of (win rate
  // with that pair − own baseline) over every candidate. `exact` = only rows with the other
  // champion in the guessed role (same choice as the candidate's own rows).
  const usualDelta = memo((key: string) => {
    const [side, patch, otherId, otherRole, exact] = key.split('|');
    const rows: (GamesWins & {
      championId: number;
      position: Position;
      otherPosition: Position;
    })[] =
      side === 'vs'
        ? data.vs
            .filter((r) => r.enemyId === Number(otherId) && r.patch === patch)
            .map((r) => ({ ...r, otherPosition: r.enemyPosition }))
        : data.with
            .filter((r) => r.allyId === Number(otherId) && r.patch === patch)
            .map((r) => ({ ...r, otherPosition: r.allyPosition }));
    const perCandidate = new Map<number, GamesWins>();
    for (const r of rows) {
      if (r.position !== role || (exact === '1' && r.otherPosition !== otherRole)) continue;
      const s = perCandidate.get(r.championId) ?? { games: 0, wins: 0 };
      perCandidate.set(r.championId, { games: s.games + r.games, wins: s.wins + r.wins });
    }
    let games = 0;
    let sum = 0;
    for (const [championId, s] of perCandidate) {
      const base = baselineOn(championId, patch as PatchId);
      if (!base || base.games === 0 || s.games === 0) continue;
      sum += (winRate(s) - winRate(base)) * s.games;
      games += s.games;
    }
    return games > 0 ? sum / games : 0;
  });

  /** One sample per patch, blended (the previous one only when there is a previous patch). */
  const perPatch = (sample: (patch: PatchId) => PatchSample | undefined): Blend =>
    blendPatches(
      sample(data.currentPatch),
      data.previousPatch ? sample(data.previousPatch) : undefined,
      PRIOR.pair,
    );

  const championIds = new Set(
    data.roleStats.filter((r) => r.position === role).map((r) => r.championId),
  );
  const candidates: PickCandidate[] = [];

  for (const championId of championIds) {
    if (excluded.has(championId) || (available && !available.has(championId))) continue;
    const b = championBaseline(patchPair, inRole, roleWinRate, championId);
    if (b.games < ENGINE_CONFIG.minCandidateGames) continue;
    const champName = names.champion(championId);
    const components: Component[] = [];
    /** The candidate's delta with a pair on one patch: vs its own baseline and the usual term. */
    const pairSample = (
      stats: GamesWins,
      patch: PatchId,
      usual: () => number,
    ): PatchSample | undefined => {
      const own = baselineOn(championId, patch);
      if (stats.games === 0 || !own || own.games === 0) return undefined;
      return { value: winRate(stats) - winRate(own) - usual(), games: stats.games };
    };

    // Base: own strength vs the role average.
    const baseDelta = shrink(b.delta, b.games, K.base);
    components.push({
      reason: {
        kind: 'base',
        label: `${formatRate(b.winRate)} win rate as ${ROLE_LABELS[role]} (${formatGames(shownGames(b.games))})`,
        delta: round(baseDelta),
        games: shownGames(b.games),
      },
      contribution: W.base * baseDelta,
      weight: W.base,
      confidence: sampleConfidence(b.games, CK.base),
      order: 0,
    });

    // Enemies: lane opponent(s) first, others pairwise.
    for (const enemy of enemyRoles) {
      const lane = LANE_ROLES[role];
      const isLane = enemy.role === role;
      const isLaneSecondary = !isLane && lane.includes(enemy.role);
      const baseWeight = isLane ? W.matchup : isLaneSecondary ? W.laneSecondary : W.otherEnemy;
      const weight = baseWeight * (0.5 + 0.5 * enemy.probability);
      const rowsOn = (p: PatchId) => vsIndex.get(`${p}|${championId}|${enemy.championId}`) ?? [];
      // Rows with the enemy in its guessed role when there are any (on either patch), else all.
      const exact = [data.currentPatch, data.previousPatch].some(
        (p) => p !== null && rowsOn(p).some((r) => r.enemyPosition === enemy.role && r.games > 0),
      );
      const blend = perPatch((p) =>
        pairSample(
          sumStats(rowsOn(p).filter((r) => !exact || r.enemyPosition === enemy.role)),
          p,
          () => usualDelta(`vs|${p}|${enemy.championId}|${enemy.role}|${exact ? 1 : 0}`),
        ),
      );
      const k = isLane ? K.matchup : isLaneSecondary ? K.laneSecondary : K.otherEnemy;
      const shrunk = shrink(blend.value, blend.games, k);
      const games = shownGames(blend.games);
      const where = describeEnemyRole(enemy, isLane || isLaneSecondary);
      components.push({
        reason: {
          kind: 'matchup',
          label:
            blend.games > 0
              ? `${formatDelta(shrunk)} vs ${names.champion(enemy.championId)} compared with other ${ROLE_PLURALS[role]} (${where}, ${formatGames(games)})`
              : `No games vs ${names.champion(enemy.championId)} yet (${where})`,
          delta: round(shrunk),
          games,
          championIds: [enemy.championId],
        },
        contribution: weight * shrunk,
        weight,
        confidence: sampleConfidence(blend.games, isLane || isLaneSecondary ? CK.matchup : CK.pair),
        order: isLane ? 0 : isLaneSecondary ? 1 : 2,
      });
    }

    // Lane phase vs the lane opponent: explains, never scores (weight 0).
    if (laneOpponent && data.lanePhase) {
      const rows = lanePhaseRowsOf(
        data.lanePhase,
        championId,
        laneOpponent.championId,
        laneOpponent.role,
      );
      const diff = lanePhaseDiff(rows, patchPair, 10);
      if (diff) {
        components.push({
          reason: lanePhaseReason(
            diff,
            role,
            laneOpponent.championId,
            names.champion(laneOpponent.championId),
            laneOpponent.known ? undefined : `likely ${ROLE_LABELS[laneOpponent.role]}`,
          ),
          contribution: 0,
          weight: 0,
          confidence: 0,
          // Right after its matchup reason (order 0 = same role, 1 = other bot laner).
          order: (laneOpponent.role === role ? 0 : 1) + 0.5,
        });
      }
    }

    // Allies: duo partner(s), then others pairwise.
    for (const ally of allyRoles) {
      const isDuo = DUO_ROLES[role].includes(ally.role);
      const weight = (isDuo ? W.duo : W.otherAlly) * (0.5 + 0.5 * ally.probability);
      const rowsOn = (p: PatchId) => withIndex.get(`${p}|${championId}|${ally.championId}`) ?? [];
      const exact = [data.currentPatch, data.previousPatch].some(
        (p) => p !== null && rowsOn(p).some((r) => r.allyPosition === ally.role && r.games > 0),
      );
      const blend = perPatch((p) =>
        pairSample(
          sumStats(rowsOn(p).filter((r) => !exact || r.allyPosition === ally.role)),
          p,
          () => usualDelta(`with|${p}|${ally.championId}|${ally.role}|${exact ? 1 : 0}`),
        ),
      );
      const shrunk = shrink(blend.value, blend.games, isDuo ? K.duo : K.otherAlly);
      const games = shownGames(blend.games);
      const where = isDuo ? `${duoLabel(role, ally.role)} duo` : ROLE_LABELS[ally.role];
      components.push({
        reason: {
          kind: isDuo ? 'duo' : 'with_comp',
          label:
            blend.games > 0
              ? `${formatDelta(shrunk)} with ${names.champion(ally.championId)} compared with other ${ROLE_PLURALS[role]} (${where}, ${formatGames(games)})`
              : `No games with ${names.champion(ally.championId)} yet (${where})`,
          delta: round(shrunk),
          games,
          championIds: [ally.championId],
        },
        contribution: weight * shrunk,
        weight,
        confidence: sampleConfidence(blend.games, isDuo ? CK.duo : CK.pair),
        order: isDuo ? 0 : 5,
      });
    }

    // Composition traits.
    const addTraits = (side: CompSide, traits: readonly CompTrait[]) => {
      if (traits.length === 0) return;
      const weight = (side === 'enemy' ? W.vsComp : W.withComp) / traits.length;
      for (const trait of traits) {
        const blend = perPatch((p) =>
          pairSample(sumStats(compIndex.get(`${p}|${championId}|${side}|${trait}`) ?? []), p, () =>
            roleTraitShift(`${p}|${side}|${trait}`),
          ),
        );
        const games = shownGames(blend.games);
        const shrunk = shrink(blend.value, blend.games, K.comp);
        const what = `${side === 'enemy' ? 'vs' : 'with'} ${TRAIT_LABELS[trait]} ${side === 'enemy' ? 'teams' : 'allies'}`;
        components.push({
          reason: {
            kind: side === 'enemy' ? 'vs_comp' : 'with_comp',
            label:
              blend.games > 0
                ? `${formatDelta(shrunk)} ${what} (${formatGames(games)})`
                : `No games ${what} yet`,
            delta: round(shrunk),
            games,
            trait,
          },
          contribution: weight * shrunk,
          weight,
          confidence: sampleConfidence(blend.games, CK.comp),
          order: 1,
        });
      }
    };
    addTraits('enemy', enemyTraits);
    addTraits('ally', allyTraits);

    // The player's mastery of the candidate: how players at that level do compared with the
    // champion's average. It takes no part in the confidence (weight 0): that says how well the
    // champion's stats are known, not how well the player knows the champion.
    if (masteryModel) {
      const points = myPoints.get(championId) ?? 0;
      const effect = masteryModel.effect(championId, role, masteryBucket(points));
      components.push({
        reason: masteryReason(effect, points, champName),
        contribution: ENGINE_CONFIG.mastery.weight * effect.delta,
        weight: 0,
        confidence: 0,
        order: 0,
      });
    }

    const score = components.reduce((s, c) => s + c.contribution, 0);
    const totalWeight = components.reduce((s, c) => s + c.weight, 0);
    const confidence =
      totalWeight > 0
        ? components.reduce((s, c) => s + c.weight * c.confidence, 0) / totalWeight
        : 0;

    const reasons = components
      .filter(
        (c) =>
          c.reason.kind === 'matchup' ||
          c.reason.kind === 'lane_phase' ||
          c.reason.kind === 'duo' ||
          c.reason.kind === 'base' ||
          c.reason.kind === 'mastery' ||
          Math.abs(c.reason.delta) >= ENGINE_CONFIG.picks.minReasonDelta,
      )
      .sort(
        (a, b) =>
          KIND_ORDER[a.reason.kind] - KIND_ORDER[b.reason.kind] ||
          a.order - b.order ||
          Math.abs(b.contribution) - Math.abs(a.contribution),
      )
      .map((c) => c.reason);
    // Said while the previous patch weighs most, unless the whole role has no current games yet
    // (every candidate would carry the same line).
    if (data.previousPatch && roleHasCurrentGames && b.blend.previousShare >= PRIOR.reasonShare) {
      const who = `${champName} ${ROLE_LABELS[role]} on ${data.currentPatch}`;
      reasons.unshift({
        kind: 'patch_fallback',
        label:
          b.blend.currentGames > 0
            ? `Mostly ${data.previousPatch} data: ${formatGames(b.blend.currentGames)} of ${who} so far`
            : `${data.previousPatch} data: no games of ${who} yet`,
        delta: 0,
        games: shownGames(b.games),
      });
    }
    candidates.push({
      championId,
      score: round(score, 5),
      confidence: round(confidence, 3),
      patchesUsed: b.patches,
      games: shownGames(b.games),
      winRate: round(b.winRate),
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.games - a.games || a.championId - b.championId);
  return {
    role,
    patch: data.currentPatch,
    candidates: candidates.slice(0, req.limit ?? ENGINE_CONFIG.picks.defaultLimit),
  };
}

function describeEnemyRole(enemy: RoleGuess, lane: boolean): string {
  const role = ROLE_LABELS[enemy.role];
  const prefix = enemy.known ? '' : 'likely ';
  return lane ? `${prefix}lane, ${role}` : `${prefix}${role}`;
}

function duoLabel(role: Position, allyRole: Position): string {
  const pair = new Set([role, allyRole]);
  if (pair.has('UTILITY') && pair.has('BOTTOM')) return 'bot';
  if (pair.has('MIDDLE')) return 'mid–jungle';
  return 'top–jungle';
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function memo<T>(fn: (key: string) => T): (key: string) => T {
  const cache = new Map<string, T>();
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key));
    return cache.get(key) as T;
  };
}
