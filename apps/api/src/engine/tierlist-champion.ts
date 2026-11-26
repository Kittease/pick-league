/**
 * Detail of one tier list champion: every lane opponent, duo partner and other ally it has enough
 * games with, each as a win-rate delta vs the champion's own baseline, shrunk by sample size and
 * sorted best first. Each relation is measured inside each patch (vs the champion's own win rate
 * on that patch), then the two patches are blended with the previous one as a capped prior, like
 * the champion's tier list entry.
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
import {
  blendPatches,
  listedGames,
  mixLike,
  type PatchPair,
  round,
  sampleConfidence,
  shownGames,
  shrink,
  sumStats,
  winRate,
} from './math.ts';
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
  /**
   * Champions changed (or new) on the current patch, from the game files (patch_changes): their own
   * strength takes the previous patch as a smaller prior (`previousPatchPrior.changedStrength`).
   */
  changedChampions?: ReadonlySet<number>;
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
const PRIOR = ENGINE_CONFIG.previousPatchPrior;

/** Best first; ties: bigger sample, then champion id (stable output). */
const byDelta = (a: TierListRelation, b: TierListRelation) =>
  b.delta - a.delta || b.games - a.games || a.championId - b.championId;

function relations<R extends GamesWins & { patch: PatchId }>(
  rows: readonly R[],
  patches: PatchPair,
  ownWinRate: (patch: PatchId) => GamesWins | undefined,
  k: { shrink: number; confidence: number },
  idOf: (r: R) => number,
  roleOf: (r: R) => Position,
): TierListRelation[] {
  const groups = new Map<string, R[]>();
  for (const r of rows) {
    const key = `${idOf(r)}|${roleOf(r)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: TierListRelation[] = [];
  for (const group of groups.values()) {
    const first = group[0] as R;
    const on = (patch: PatchId | null) =>
      patch === null ? undefined : sumStats(group.filter((r) => r.patch === patch));
    // Per patch: the relation's win rate vs the champion's own win rate on that patch.
    const sample = (patch: PatchId | null) => {
      const s = on(patch);
      const own = patch === null ? undefined : ownWinRate(patch);
      return s && s.games > 0 && own && own.games > 0
        ? { value: winRate(s) - winRate(own), games: s.games }
        : undefined;
    };
    const blend = blendPatches(sample(patches.current), sample(patches.previous), PRIOR.pair);
    if (blend.games < TL.minRelationGames) continue;
    out.push({
      championId: idOf(first),
      role: roleOf(first),
      delta: round(shrink(blend.value, blend.games, k.shrink)),
      winRate: round(mixLike(blend, winRate(on(patches.current)), winRate(on(patches.previous)))),
      games: shownGames(blend.games),
      confidence: round(sampleConfidence(blend.games, k.confidence), 3),
    });
  }
  return out.sort(byDelta);
}

export function buildTierListChampion(
  role: Position,
  championId: number,
  data: TierListChampionData,
): TierListChampionDetail {
  const { currentPatch, previousPatch, changedChampions } = data;
  const pair: PatchPair = { current: currentPatch, previous: previousPatch, changedChampions };
  const rows = rowsByPatchAndChampion(data.roleStats, role);
  const roleWinRate = (patch: PatchId) =>
    winRate(sumStats(data.roleStats.filter((r) => r.position === role && r.patch === patch)));
  const b = championBaseline(pair, rows, roleWinRate, championId);
  const own = (patch: PatchId) => rows.get(`${patch}|${championId}`);
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
    patchesUsed: b.patches,
    games: listedGames(b.blend, b.patches),
    winRate: round(b.winRate),
    matchups: relations(
      vs,
      pair,
      own,
      { shrink: K.matchup, confidence: CK.matchup },
      enemy.id,
      enemy.role,
    ).map((m) => {
      const lane = lanePhaseDiff(
        lanePhaseRowsOf(data.lanePhase ?? [], championId, m.championId, m.role),
        pair,
        10,
      );
      return lane ? { ...m, lane } : m;
    }),
    duos: relations(
      allies.filter(isDuo),
      pair,
      own,
      { shrink: K.duo, confidence: CK.duo },
      ally.id,
      ally.role,
    ),
    synergies: relations(
      allies.filter((r) => !isDuo(r) && r.allyPosition !== role),
      pair,
      own,
      { shrink: K.synergy, confidence: CK.pair },
      ally.id,
      ally.role,
    ),
    ...(gameLength ? { gameLength } : {}),
  };
}
