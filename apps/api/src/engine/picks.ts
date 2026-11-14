/**
 * Pick recommendations: for each candidate champion in the requested role, a weighted sum of
 * shrunk win-rate deltas vs the champion's own baseline, in priority order
 * lane matchup > duo synergy > vs enemy composition > with ally composition (+ small base term).
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
import { DUO_ROLES, ENGINE_CONFIG, LANE_ROLES, ROLE_LABELS, TRAIT_LABELS } from './config.ts';
import { lanePhaseDiff, lanePhaseReason, lanePhaseRowsOf } from './lane-phase.ts';
import {
  choosePatches,
  formatDelta,
  formatGames,
  formatRate,
  patchesLabel,
  round,
  sampleConfidence,
  shrink,
  sumStats,
  winRate,
} from './math.ts';
import { assignRoles, type RoleGuess, rolePlayRates } from './roles.ts';
import { compProfile, compTraits } from './traits.ts';
import type {
  ChampionTraitRow,
  CompSide,
  CompThresholdRow,
  CompTraitRow,
  GamesWins,
  LanePhaseRow,
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
  names: NameLookup;
}

const W = ENGINE_CONFIG.picks.weights;
const K = ENGINE_CONFIG.picks.shrinkK;
const CK = ENGINE_CONFIG.confidenceK;

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
  vs_comp: 3,
  with_comp: 4,
  base: 5,
  popularity: 6,
  item_swap: 7,
  tag_rule: 8,
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

  // Role-wide effect of a trait (so a trait that helps every champion doesn't count), on the
  // patches used ("15.22" or "15.22+15.21").
  const roleTraitShift = memo((key: string) => {
    const [scope = '', side, trait] = key.split('|');
    const patches = scope.split('+');
    const withTrait = sumStats(
      data.compTraits.filter(
        (r) => patches.includes(r.patch) && r.side === side && r.trait === trait,
      ),
    );
    const all = sumStats(
      data.roleStats.filter((r) => patches.includes(r.patch) && r.position === role),
    );
    return withTrait.games > 0 && all.games > 0 ? winRate(withTrait) - winRate(all) : 0;
  });

  const championIds = new Set(
    data.roleStats.filter((r) => r.position === role).map((r) => r.championId),
  );
  const candidates: PickCandidate[] = [];

  for (const championId of championIds) {
    if (excluded.has(championId) || (available && !available.has(championId))) continue;
    const cur = roleRow.get(`${data.currentPatch}|${championId}|${role}`);
    const prev = data.previousPatch
      ? roleRow.get(`${data.previousPatch}|${championId}|${role}`)
      : undefined;
    const pc = choosePatches(
      data.currentPatch,
      data.previousPatch,
      cur?.games ?? 0,
      prev?.games ?? 0,
    );
    // Rows of a key on every patch used (one row, or one per patch when they are combined).
    const onPatches = <T>(index: ReadonlyMap<string, T[]>, key: string): T[] =>
      pc.patches.flatMap((p) => index.get(`${p}|${key}`) ?? []);
    const base = sumStats(
      pc.patches.flatMap((p) => roleRow.get(`${p}|${championId}|${role}`) ?? []),
    );
    if (base.games < ENGINE_CONFIG.minCandidateGames) continue;
    const scope = pc.patches.join('+');
    const baseWr = winRate(base);
    const champName = names.champion(championId);
    const components: Component[] = [];

    // Base
    const baseDelta = shrink(baseWr - 0.5, base.games, K.base);
    components.push({
      reason: {
        kind: 'base',
        label: `${formatRate(baseWr)} win rate as ${ROLE_LABELS[role]} (${formatGames(base.games)})`,
        delta: round(baseDelta),
        games: base.games,
      },
      contribution: W.base * baseDelta,
      weight: W.base,
      confidence: sampleConfidence(base.games, CK.base),
      order: 0,
    });

    // Enemies: lane opponent(s) first, others pairwise.
    for (const enemy of enemyRoles) {
      const lane = LANE_ROLES[role];
      const isLane = enemy.role === role;
      const isLaneSecondary = !isLane && lane.includes(enemy.role);
      const baseWeight = isLane ? W.matchup : isLaneSecondary ? W.laneSecondary : W.otherEnemy;
      const weight = baseWeight * (0.5 + 0.5 * enemy.probability);
      const rows = onPatches(vsIndex, `${championId}|${enemy.championId}`);
      const exact = sumStats(rows.filter((r) => r.enemyPosition === enemy.role));
      const stats: GamesWins = exact.games > 0 ? exact : sumStats(rows);
      const delta = stats.games > 0 ? winRate(stats) - baseWr : 0;
      const k = isLane || isLaneSecondary ? K.matchup : K.pair;
      const shrunk = shrink(delta, stats.games, k);
      const where = describeEnemyRole(enemy, isLane || isLaneSecondary);
      components.push({
        reason: {
          kind: 'matchup',
          label:
            stats.games > 0
              ? `${formatDelta(shrunk)} vs ${names.champion(enemy.championId)} (${where}, ${formatGames(stats.games)})`
              : `No games vs ${names.champion(enemy.championId)} yet (${where})`,
          delta: round(shrunk),
          games: stats.games,
          championIds: [enemy.championId],
        },
        contribution: weight * shrunk,
        weight,
        confidence: sampleConfidence(stats.games, isLane || isLaneSecondary ? CK.matchup : CK.pair),
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
      const diff = lanePhaseDiff(rows, pc.patches, 10);
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
      const rows = onPatches(withIndex, `${championId}|${ally.championId}`);
      const exact = sumStats(rows.filter((r) => r.allyPosition === ally.role));
      const stats: GamesWins = exact.games > 0 ? exact : sumStats(rows);
      const delta = stats.games > 0 ? winRate(stats) - baseWr : 0;
      const shrunk = shrink(delta, stats.games, isDuo ? K.duo : K.pair);
      const where = isDuo ? `${duoLabel(role, ally.role)} duo` : ROLE_LABELS[ally.role];
      components.push({
        reason: {
          kind: isDuo ? 'duo' : 'with_comp',
          label:
            stats.games > 0
              ? `${formatDelta(shrunk)} with ${names.champion(ally.championId)} (${where}, ${formatGames(stats.games)})`
              : `No games with ${names.champion(ally.championId)} yet (${where})`,
          delta: round(shrunk),
          games: stats.games,
          championIds: [ally.championId],
        },
        contribution: weight * shrunk,
        weight,
        confidence: sampleConfidence(stats.games, isDuo ? CK.duo : CK.pair),
        order: isDuo ? 0 : 5,
      });
    }

    // Composition traits.
    const addTraits = (side: CompSide, traits: readonly CompTrait[]) => {
      if (traits.length === 0) return;
      const weight = (side === 'enemy' ? W.vsComp : W.withComp) / traits.length;
      for (const trait of traits) {
        const row = sumStats(onPatches(compIndex, `${championId}|${side}|${trait}`));
        const games = row.games;
        const delta =
          games > 0 ? winRate(row) - baseWr - roleTraitShift(`${scope}|${side}|${trait}`) : 0;
        const shrunk = shrink(delta, games, K.comp);
        const what = `${side === 'enemy' ? 'vs' : 'with'} ${TRAIT_LABELS[trait]} ${side === 'enemy' ? 'teams' : 'allies'}`;
        components.push({
          reason: {
            kind: side === 'enemy' ? 'vs_comp' : 'with_comp',
            label:
              games > 0
                ? `${formatDelta(shrunk)} ${what} (${formatGames(games)})`
                : `No games ${what} yet`,
            delta: round(shrunk),
            games,
            trait,
          },
          contribution: weight * shrunk,
          weight,
          confidence: sampleConfidence(games, CK.comp),
          order: 1,
        });
      }
    };
    addTraits('enemy', enemyTraits);
    addTraits('ally', allyTraits);

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
          Math.abs(c.reason.delta) >= ENGINE_CONFIG.picks.minReasonDelta,
      )
      .sort(
        (a, b) =>
          KIND_ORDER[a.reason.kind] - KIND_ORDER[b.reason.kind] ||
          a.order - b.order ||
          Math.abs(b.contribution) - Math.abs(a.contribution),
      )
      .map((c) => c.reason);
    if (pc.merged) {
      reasons.unshift({
        kind: 'patch_fallback',
        label: `${patchesLabel(pc.patches)} data: only ${formatGames(pc.currentGames)} of ${champName} ${ROLE_LABELS[role]} on ${data.currentPatch}`,
        delta: 0,
        games: base.games,
      });
    }
    candidates.push({
      championId,
      score: round(score, 5),
      confidence: round(confidence, 3),
      patchesUsed: pc.patches,
      games: base.games,
      winRate: round(baseWr),
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
