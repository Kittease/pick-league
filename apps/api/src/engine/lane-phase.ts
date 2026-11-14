/**
 * Lane-phase reasons: how the lane goes vs the lane opponent, as the average gold / XP / CS
 * difference at 10 or 15 min (stats_champion_lane_phase; bot lane = 2v2). They explain a
 * matchup and never change a score: `delta` is 0 and `games` is the sample size.
 */
import type { LanePhaseDiff, PatchId, Position, Reason } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import { round, shrink } from './math.ts';
import type { LanePhaseRow } from './types.ts';

const LP = ENGINE_CONFIG.lanePhase;

/** Bot laners are compared as a 2v2 (own + duo partner vs both enemy bot laners). */
export function isDuoLane(role: Position): boolean {
  return role === 'BOTTOM' || role === 'UTILITY';
}

const LANE_NAMES: Record<Position, string> = {
  TOP: 'top lane',
  JUNGLE: 'jungle',
  MIDDLE: 'mid lane',
  BOTTOM: 'bot lane 2v2',
  UTILITY: 'bot lane 2v2',
};

/** No "-0" in responses. */
const noNegativeZero = (x: number) => (x === 0 ? 0 : x);

/**
 * Lane-phase difference at `minute` of `rows` (one champion vs one opponent, one row per patch)
 * on `patches`: per-patch averages combined by matchups, then shrunk toward 0 with
 * `lanePhase.shrinkK`. Null below `lanePhase.minGames` matchups with frames at that minute.
 */
export function lanePhaseDiff(
  rows: readonly LanePhaseRow[],
  patches: readonly PatchId[],
  minute: 10 | 15,
): LanePhaseDiff | null {
  let games = 0;
  let gold = 0;
  let xp = 0;
  let cs = 0;
  for (const r of rows) {
    if (!patches.includes(r.patch)) continue;
    const n = minute === 10 ? r.games : r.games15;
    if (n <= 0) continue;
    games += n;
    gold += n * ((minute === 10 ? r.goldDiff10 : r.goldDiff15) ?? 0);
    xp += n * ((minute === 10 ? r.xpDiff10 : r.xpDiff15) ?? 0);
    cs += n * ((minute === 10 ? r.csDiff10 : r.csDiff15) ?? 0);
  }
  const first = rows[0];
  if (!first || games < LP.minGames) return null;
  const shrunk = (sum: number) => shrink(sum / games, games, LP.shrinkK);
  return {
    minute,
    gold: noNegativeZero(Math.round(shrunk(gold))),
    xp: noNegativeZero(Math.round(shrunk(xp))),
    cs: noNegativeZero(round(shrunk(cs), 1)),
    duo: isDuoLane(first.position),
    games,
  };
}

/** Rows of `championId` vs `enemyId` played as `enemyPosition`. */
export function lanePhaseRowsOf(
  rows: readonly LanePhaseRow[],
  championId: number,
  enemyId: number,
  enemyPosition: Position,
): LanePhaseRow[] {
  return rows.filter(
    (r) =>
      r.championId === championId && r.enemyId === enemyId && r.enemyPosition === enemyPosition,
  );
}

const intFormat = new Intl.NumberFormat('en-US');

/** 420 → "+420", -420 → "−420", 0 → "0" (minus sign like `formatDelta`). */
function signed(x: number, digits = 0): string {
  const s = intFormat.format(Math.abs(Number(x.toFixed(digits))));
  return x > 0 ? `+${s}` : x < 0 ? `−${s}` : '0';
}

/** "−420 gold, −8 CS, −310 XP" (CS with one decimal under 10). */
export function formatLanePhase(d: LanePhaseDiff): string {
  const cs = Math.abs(d.cs) < 10 ? signed(d.cs, 1) : signed(Math.round(d.cs));
  return `${signed(d.gold)} gold, ${cs} CS, ${signed(d.xp)} XP`;
}

/**
 * `lane_phase` reason vs `opponentName`, e.g.
 * "Lane at 10 min vs Leona: −420 gold, −8 CS, −310 XP (bot lane 2v2, 312 matchups)".
 * `note` adds context such as "likely support" when the opponent's role was guessed.
 */
export function lanePhaseReason(
  diff: LanePhaseDiff,
  role: Position,
  opponentId: number,
  opponentName: string,
  note?: string,
): Reason {
  const context = [LANE_NAMES[role], note, `${intFormat.format(diff.games)} matchups`]
    .filter(Boolean)
    .join(', ');
  return {
    kind: 'lane_phase',
    label: `Lane at ${diff.minute} min vs ${opponentName}: ${formatLanePhase(diff)} (${context})`,
    delta: 0,
    games: diff.games,
    championIds: [opponentId],
    lane: diff,
  };
}
