/**
 * Detail of one tier list champion: every lane opponent, duo partner and other ally it has enough
 * games with, each as a win-rate delta vs the champion's own baseline, shrunk by sample size and
 * sorted best first. Uses the same per-champion patch choice as its tier list entry.
 */
import type {
  PatchId,
  Position,
  TierListChampionResponse,
  TierListRelation,
} from '@pick-league/shared';
import { DUO_ROLES, ENGINE_CONFIG, LANE_ROLES } from './config.ts';
import { championGameLength, indexGameLength } from './game-length.ts';
import { lanePhaseDiff, lanePhaseRowsOf } from './lane-phase.ts';
import { round, sampleConfidence, shrink, sumByKey, winRate } from './math.ts';
import { championBaseline, rowsByPatchAndChampion } from './tierlist.ts';
import type {
  GameLengthRow,
  GamesWins,
  LanePhaseRow,
  RoleStatRow,
  VsRow,
  WithRow,
} from './types.ts';

export interface TierListChampionData {
  currentPatch: PatchId;
  previousPatch: PatchId | null;
  /** stats_champion_roles of the patches (at least the champion in the role). */
  roleStats: readonly RoleStatRow[];
  /** stats_champion_vs of the champion in the role (lane opponents are filtered here). */
  vs: readonly VsRow[];
  /** stats_champion_with of the champion in the role, every ally role. */
  with: readonly WithRow[];
  /**
   * stats_champion_lane_phase of the champion in the role, per patch: adds `lane` (10 min) to
   * the matchups. Omitted (or empty) with server/rank filters: lane phase is unfiltered only.
   */
  lanePhase?: readonly LanePhaseRow[];
  /**
   * stats_champion_game_length of the role on the patches (all summed): adds `gameLength`.
   * Omitted (or empty) with server/rank filters: the game-length profile is unfiltered only.
   */
  gameLength?: readonly GameLengthRow[];
}

/** The response without its filters; synergies always computed (the service drops them when filtered). */
export type TierListChampionDetail = Omit<TierListChampionResponse, 'filters' | 'synergies'> & {
  synergies: TierListRelation[];
};

const TL = ENGINE_CONFIG.tierList;
const K = ENGINE_CONFIG.tierList.shrinkK;
const CK = ENGINE_CONFIG.confidenceK;

/** Best first; ties: bigger sample, then champion id (stable output). */
const byDelta = (a: TierListRelation, b: TierListRelation) =>
  b.delta - a.delta || b.games - a.games || a.championId - b.championId;

function relations<R extends GamesWins & { patch: PatchId }>(
  rows: readonly R[],
  patches: readonly PatchId[],
  baseWr: number,
  k: { shrink: number; confidence: number },
  idOf: (r: R) => number,
  roleOf: (r: R) => Position,
): TierListRelation[] {
  return sumByKey(
    rows.filter((r) => patches.includes(r.patch)),
    (r) => `${idOf(r)}|${roleOf(r)}`,
  )
    .filter((r) => r.games >= TL.minRelationGames)
    .map((r) => ({
      championId: idOf(r),
      role: roleOf(r),
      delta: round(shrink(winRate(r) - baseWr, r.games, k.shrink)),
      winRate: round(winRate(r)),
      games: r.games,
      confidence: round(sampleConfidence(r.games, k.confidence), 3),
    }))
    .sort(byDelta);
}

export function buildTierListChampion(
  role: Position,
  championId: number,
  data: TierListChampionData,
): TierListChampionDetail {
  const { currentPatch, previousPatch } = data;
  const { patches, base } = championBaseline(
    currentPatch,
    previousPatch,
    rowsByPatchAndChampion(data.roleStats, role),
    championId,
  );
  const baseWr = winRate(base);
  const vs = data.vs.filter(
    (r) =>
      r.position === role &&
      r.championId === championId &&
      LANE_ROLES[role].includes(r.enemyPosition),
  );
  const allies = data.with.filter((r) => r.position === role && r.championId === championId);
  const isDuo = (r: WithRow) => DUO_ROLES[role].includes(r.allyPosition);
  const enemy = { id: (r: VsRow) => r.enemyId, role: (r: VsRow) => r.enemyPosition };
  const ally = { id: (r: WithRow) => r.allyId, role: (r: WithRow) => r.allyPosition };
  const gameLength = data.gameLength?.length
    ? championGameLength(indexGameLength(data.gameLength), role, championId)
    : null;
  return {
    role,
    patch: currentPatch,
    championId,
    patchesUsed: patches,
    games: base.games,
    winRate: round(baseWr),
    matchups: relations(
      vs,
      patches,
      baseWr,
      { shrink: K.matchup, confidence: CK.matchup },
      enemy.id,
      enemy.role,
    ).map((m) => {
      const lane = lanePhaseDiff(
        lanePhaseRowsOf(data.lanePhase ?? [], championId, m.championId, m.role),
        { current: currentPatch, previous: patches.length > 1 ? previousPatch : null },
        10,
      );
      return lane ? { ...m, lane } : m;
    }),
    duos: relations(
      allies.filter(isDuo),
      patches,
      baseWr,
      { shrink: K.duo, confidence: CK.duo },
      ally.id,
      ally.role,
    ),
    synergies: relations(
      allies.filter((r) => !isDuo(r) && r.allyPosition !== role),
      patches,
      baseWr,
      { shrink: K.synergy, confidence: CK.pair },
      ally.id,
      ally.role,
    ),
    ...(gameLength ? { gameLength } : {}),
  };
}
