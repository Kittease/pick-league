/**
 * Held-out calibration of the picks engine's shrinkage constants.
 *
 * The held-out matches are by default the last ones of the patch by start time: statistics from
 * the earlier matches predict the later ones, as in production, where the stats only hold matches
 * played before the draft. A random split by a hash of the match id is still available, but it
 * flatters the engine: matches of the same day and of the same players land on both sides (the
 * summed score's slope was 0.98 with it on 16.22, 0.92 replaying 16.23 day by day).
 *
 * Statistics are built from the training matches the same way the engine builds them (a
 * champion's strength in its role, pair deltas measured against what the role usually does
 * vs/with that champion), then each component is summed per held-out match, blue minus red, and a
 * logistic regression on the result tells how much of it is real: a fitted weight of 1 means one
 * point of predicted win rate is one point of observed win rate. For each kind of pair, the `k`
 * to use is the one at which that weight is 1.
 *
 * Kept out of the engine barrel: only `apps/api/scripts/calibrate.ts` uses it. If the definition
 * of a delta changes in `picks.ts` / `draft.ts`, change it here too.
 */
import { POSITIONS, type Position } from '@pick-league/shared';
import { DUO_ROLES, LANE_ROLES } from './config.ts';

/** Component kinds of the picks score that can be rebuilt from picks alone. */
export type CalibrationKind =
  | 'base'
  | 'lane'
  | 'laneSecondary'
  | 'otherEnemy'
  | 'duo'
  | 'otherAlly';

export const CALIBRATION_KINDS: readonly CalibrationKind[] = [
  'base',
  'lane',
  'laneSecondary',
  'otherEnemy',
  'duo',
  'otherAlly',
];

type PairKind = Exclude<CalibrationKind, 'base'>;
const PAIR_KINDS: readonly PairKind[] = ['lane', 'laneSecondary', 'otherEnemy', 'duo', 'otherAlly'];

/**
 * Matches in a compact form: `champions[m * 10 + side * 5 + role]` (side 0 = blue, 1 = red; role
 * index in POSITIONS order), `blueWin[m]` and `test[m]` (1 = held out). Only matches with the five
 * roles filled once per team are kept (see `MatchCollector`).
 */
export interface CalibrationMatches {
  count: number;
  champions: Int16Array;
  blueWin: Uint8Array;
  test: Uint8Array;
}

interface PendingMatch {
  slots: Int16Array;
  blueWin: number;
  broken: boolean;
  /** Start time (ms since the epoch); NaN while no row gave one. */
  startedAt: number;
}

/**
 * How the held-out matches are chosen: the last `testShare` of the matches by start time (the
 * default), or 1 match in `testEvery` by a hash of its id.
 */
export type HoldOut = { by: 'time'; testShare: number } | { by: 'hash'; testEvery: number };

export const DEFAULT_HOLD_OUT: HoldOut = { by: 'time', testShare: 0.2 };

/** FNV-1a: a stable hash of a match id, so the held-out set does not depend on row order. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Collects participants row by row (any order) and yields the complete matches. */
export class MatchCollector {
  private readonly pending = new Map<string, PendingMatch>();

  add(
    matchId: string,
    teamId: number,
    championId: number,
    position: Position | null,
    win: boolean,
    startedAt?: Date | number | null,
  ): void {
    let match = this.pending.get(matchId);
    if (!match) {
      match = { slots: new Int16Array(10).fill(-1), blueWin: 0, broken: false, startedAt: NaN };
      this.pending.set(matchId, match);
    }
    if (startedAt !== undefined && startedAt !== null) match.startedAt = Number(startedAt);
    const side = teamId === 100 ? 0 : teamId === 200 ? 1 : -1;
    const role = position === null ? -1 : POSITIONS.indexOf(position);
    if (side < 0 || role < 0) {
      match.broken = true;
      return;
    }
    const slot = side * 5 + role;
    if (match.slots[slot] !== -1) match.broken = true;
    match.slots[slot] = championId;
    if (side === 0) match.blueWin = win ? 1 : 0;
    else match.blueWin = win ? 0 : 1;
  }

  /**
   * The complete matches, the held-out ones flagged (see `HoldOut`). By time, a match without a
   * start time is dropped and the held-out set starts at `cutoff`, the start time of the first
   * match of the last `testShare` (every match started at that time or later is held out). By
   * hash, the set does not depend on row order. Matches come out sorted by id, so the result does
   * not depend on the order rows were added.
   */
  finish(
    holdOut: HoldOut = DEFAULT_HOLD_OUT,
  ): CalibrationMatches & { ids: string[]; dropped: number; cutoff: number | null } {
    const ids: string[] = [];
    let dropped = 0;
    for (const [id, match] of this.pending) {
      const untimed = holdOut.by === 'time' && Number.isNaN(match.startedAt);
      if (match.broken || match.slots.includes(-1) || untimed) dropped++;
      else ids.push(id);
    }
    ids.sort();
    let cutoff: number | null = null;
    if (holdOut.by === 'time' && ids.length > 0) {
      const starts = ids.map((id) => (this.pending.get(id) as PendingMatch).startedAt);
      starts.sort((a, b) => a - b);
      const first = Math.floor(starts.length * (1 - holdOut.testShare));
      cutoff = starts[Math.min(starts.length - 1, Math.max(0, first))] as number;
    }
    const heldOut = (id: string, match: PendingMatch) =>
      holdOut.by === 'time'
        ? match.startedAt >= (cutoff as number)
        : hashId(id) % holdOut.testEvery === 0;
    const count = ids.length;
    const champions = new Int16Array(count * 10);
    const blueWin = new Uint8Array(count);
    const test = new Uint8Array(count);
    ids.forEach((id, m) => {
      const match = this.pending.get(id) as PendingMatch;
      champions.set(match.slots, m * 10);
      blueWin[m] = match.blueWin;
      test[m] = heldOut(id, match) ? 1 : 0;
    });
    return { count, champions, blueWin, test, ids, dropped, cutoff };
  }
}

/** Solves `a · x = b` (a is n×n, row-major) by Gaussian elimination with partial pivoting. */
function solve(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const m = Float64Array.from(a);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r * n + col] as number) > Math.abs(m[pivot * n + col] as number)) pivot = r;
    }
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = m[col * n + c] as number;
        m[col * n + c] = m[pivot * n + c] as number;
        m[pivot * n + c] = t;
      }
      const t = x[col] as number;
      x[col] = x[pivot] as number;
      x[pivot] = t;
    }
    const d = m[col * n + col] as number;
    for (let r = col + 1; r < n; r++) {
      const f = (m[r * n + col] as number) / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++)
        m[r * n + c] = (m[r * n + c] as number) - f * (m[col * n + c] as number);
      x[r] = (x[r] as number) - f * (x[col] as number);
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r] as number;
    for (let c = r + 1; c < n; c++) s -= (m[r * n + c] as number) * (x[c] as number);
    x[r] = s / (m[r * n + r] as number);
  }
  return x;
}

/** Newton-Raphson logistic regression; `x` row-major with `columns` columns (add the intercept yourself). */
export function fitLogistic(
  x: Float64Array,
  columns: number,
  y: Uint8Array,
): { coefficients: number[]; standardErrors: number[] } {
  const rows = y.length;
  const p = columns;
  let beta = new Float64Array(p);
  const hessian = new Float64Array(p * p);
  for (let iteration = 0; iteration < 50; iteration++) {
    const gradient = new Float64Array(p);
    hessian.fill(0);
    for (let r = 0; r < rows; r++) {
      const o = r * p;
      let z = 0;
      for (let j = 0; j < p; j++) z += (beta[j] as number) * (x[o + j] as number);
      const q = 1 / (1 + Math.exp(-z));
      const e = (y[r] as number) - q;
      const w = q * (1 - q);
      for (let j = 0; j < p; j++) {
        const xj = x[o + j] as number;
        gradient[j] = (gradient[j] as number) + e * xj;
        for (let l = 0; l <= j; l++) {
          hessian[j * p + l] = (hessian[j * p + l] as number) + w * xj * (x[o + l] as number);
        }
      }
    }
    for (let j = 0; j < p; j++) {
      for (let l = j + 1; l < p; l++) hessian[j * p + l] = hessian[l * p + j] as number;
    }
    const step = solve(hessian, gradient, p);
    beta = beta.map((v, j) => v + (step[j] as number));
    if (step.every((s) => Math.abs(s) < 1e-10)) break;
  }
  // Standard errors from the inverse of the information matrix at the solution.
  const standardErrors: number[] = [];
  for (let j = 0; j < p; j++) {
    const unit = new Float64Array(p);
    unit[j] = 1;
    standardErrors.push(Math.sqrt(solve(hessian, unit, p)[j] as number));
  }
  return { coefficients: Array.from(beta), standardErrors };
}

export interface KindCalibration {
  kind: CalibrationKind;
  rows: { k: number; weight: number; standardError: number }[];
  /** The grid `k` whose weight is closest to 1. */
  bestK: number;
}

export interface CalibrationResult {
  trainMatches: number;
  testMatches: number;
  kinds: KindCalibration[];
  /** Slope of the engine's summed score with the given constants (1 = calibrated). */
  summed: { slope: number; standardError: number };
}

export interface CalibrationOptions {
  kGrid: readonly number[];
  config: {
    shrinkK: Record<CalibrationKind, number>;
    baseWeight: number;
    pairWeight: number;
  };
}

const shrink = (delta: number, games: number, k: number) =>
  games > 0 ? (delta * games) / (games + k) : 0;

/** Kind of the pair (champion in `role`, other champion in `otherRole`) seen from the first one. */
function pairKind(role: number, otherRole: number, enemy: boolean): PairKind {
  const p = POSITIONS[role] as Position;
  const q = POSITIONS[otherRole] as Position;
  if (enemy) {
    if (p === q) return 'lane';
    return LANE_ROLES[p].includes(q) ? 'laneSecondary' : 'otherEnemy';
  }
  return DUO_ROLES[p].includes(q) ? 'duo' : 'otherAlly';
}

export function calibrate(
  matches: CalibrationMatches,
  options: CalibrationOptions,
): CalibrationResult {
  const { count, champions, blueWin, test } = matches;
  const { kGrid, config } = options;

  // Champion ids → dense indexes, so every table is a flat typed array.
  const dense = new Map<number, number>();
  for (const c of champions) if (!dense.has(c)) dense.set(c, dense.size);
  const nk = 5 * dense.size;
  const slotKey = new Int32Array(count * 10);
  for (let i = 0; i < count * 10; i++) {
    slotKey[i] = (i % 5) * dense.size + (dense.get(champions[i] as number) as number);
  }
  const won = (m: number, slot: number) => (slot < 5 ? blueWin[m] : 1 - (blueWin[m] as number));

  // 1. Tables from the training matches.
  const games = new Float64Array(nk);
  const wins = new Float64Array(nk);
  const roleGames = new Float64Array(5);
  const roleWins = new Float64Array(5);
  let trainMatches = 0;
  for (let m = 0; m < count; m++) {
    if (test[m]) continue;
    trainMatches++;
    for (let s = 0; s < 10; s++) {
      const key = slotKey[m * 10 + s] as number;
      const w = won(m, s) as number;
      games[key] = (games[key] as number) + 1;
      wins[key] = (wins[key] as number) + w;
      roleGames[s % 5] = (roleGames[s % 5] as number) + 1;
      roleWins[s % 5] = (roleWins[s % 5] as number) + w;
    }
  }
  const winRate = (key: number) =>
    (games[key] as number) > 0 ? (wins[key] as number) / (games[key] as number) : 0.5;
  const roleWinRate = (role: number) =>
    (roleGames[role] as number) > 0
      ? (roleWins[role] as number) / (roleGames[role] as number)
      : 0.5;

  // Pairs: [games, wins] of the first champion, per (champion in role, other champion in role);
  // "usual" per (role, other champion in role): [games, wins, expected wins], where the expected
  // wins sum the playing champion's own role win rate, so (wins − expected) / games is the
  // games-weighted mean delta of the role vs/with that champion.
  const vs = new Float64Array(nk * nk * 2);
  const withAlly = new Float64Array(nk * nk * 2);
  const usualVs = new Float64Array(5 * nk * 3);
  const usualWith = new Float64Array(5 * nk * 3);
  for (let m = 0; m < count; m++) {
    if (test[m]) continue;
    for (let i = 0; i < 10; i++) {
      const ki = slotKey[m * 10 + i] as number;
      const wi = won(m, i) as number;
      const expected = winRate(ki);
      for (let j = 0; j < 10; j++) {
        if (i === j) continue;
        const kj = slotKey[m * 10 + j] as number;
        const enemy = i < 5 !== j < 5;
        const pairs = enemy ? vs : withAlly;
        const usual = enemy ? usualVs : usualWith;
        const pk = (ki * nk + kj) * 2;
        pairs[pk] = (pairs[pk] as number) + 1;
        pairs[pk + 1] = (pairs[pk + 1] as number) + wi;
        const uk = ((i % 5) * nk + kj) * 3;
        usual[uk] = (usual[uk] as number) + 1;
        usual[uk + 1] = (usual[uk + 1] as number) + wi;
        usual[uk + 2] = (usual[uk + 2] as number) + expected;
      }
    }
  }

  // 2. Features of each test match, blue minus red, in win-rate units.
  const testIndex: number[] = [];
  for (let m = 0; m < count; m++) if (test[m]) testIndex.push(m);
  const testMatches = testIndex.length;
  const y = new Uint8Array(testMatches);
  const gridOf = (kind: CalibrationKind) =>
    [...new Set([...kGrid, config.shrinkK[kind]])].sort((a, b) => a - b);
  const grids = Object.fromEntries(CALIBRATION_KINDS.map((k) => [k, gridOf(k)])) as Record<
    CalibrationKind,
    number[]
  >;
  const features = Object.fromEntries(
    CALIBRATION_KINDS.map((kind) => [kind, grids[kind].map(() => new Float64Array(testMatches))]),
  ) as Record<CalibrationKind, Float64Array[]>;

  testIndex.forEach((m, t) => {
    y[t] = blueWin[m] as number;
    for (let i = 0; i < 10; i++) {
      const sign = i < 5 ? 1 : -1;
      const ki = slotKey[m * 10 + i] as number;
      const role = i % 5;
      const strength = winRate(ki) - roleWinRate(role);
      grids.base.forEach((k, g) => {
        const f = features.base[g] as Float64Array;
        f[t] = (f[t] as number) + sign * shrink(strength, games[ki] as number, k);
      });
      for (let j = 0; j < 10; j++) {
        if (i === j) continue;
        const kj = slotKey[m * 10 + j] as number;
        const enemy = i < 5 !== j < 5;
        const pairs = enemy ? vs : withAlly;
        const usual = enemy ? usualVs : usualWith;
        const pk = (ki * nk + kj) * 2;
        const pairGames = pairs[pk] as number;
        if (pairGames === 0) continue;
        const uk = (role * nk + kj) * 3;
        const usualDelta =
          ((usual[uk + 1] as number) - (usual[uk + 2] as number)) / (usual[uk] as number);
        const delta = (pairs[pk + 1] as number) / pairGames - winRate(ki) - usualDelta;
        // Each pair counts once, averaged over both points of view (as the draft evaluation).
        const kind = pairKind(role, j % 5, enemy);
        grids[kind].forEach((k, g) => {
          const f = features[kind][g] as Float64Array;
          f[t] = (f[t] as number) + 0.5 * sign * shrink(delta, pairGames, k);
        });
      }
    }
  });

  const feature = (kind: CalibrationKind, k: number) =>
    features[kind][grids[kind].indexOf(k)] as Float64Array;
  /** Logistic fit of the test results on the given features; ×4 so that 1 = calibrated near 50 %. */
  const fit = (columns: Float64Array[]) => {
    const p = columns.length + 1;
    const x = new Float64Array(testMatches * p);
    for (let t = 0; t < testMatches; t++) {
      x[t * p] = 1;
      columns.forEach((c, j) => {
        x[t * p + j + 1] = 4 * (c[t] as number);
      });
    }
    return fitLogistic(x, p, y);
  };

  // 3. Per kind and per k (pair kinds next to the champion's strength at its configured k).
  const baseAtConfig = feature('base', config.shrinkK.base);
  const kinds: KindCalibration[] = CALIBRATION_KINDS.map((kind) => {
    const rows = kGrid.map((k) => {
      const f = kind === 'base' ? fit([feature('base', k)]) : fit([baseAtConfig, feature(kind, k)]);
      const j = kind === 'base' ? 1 : 2;
      return {
        k,
        weight: f.coefficients[j] as number,
        standardError: f.standardErrors[j] as number,
      };
    });
    const best = rows.reduce((a, b) => (Math.abs(b.weight - 1) < Math.abs(a.weight - 1) ? b : a));
    return { kind, rows, bestK: best.k };
  });

  // 4. The engine's summed score with the configured constants.
  const score = new Float64Array(testMatches);
  for (let t = 0; t < testMatches; t++) {
    let pairs = 0;
    for (const kind of PAIR_KINDS) pairs += feature(kind, config.shrinkK[kind])[t] as number;
    score[t] = config.baseWeight * (baseAtConfig[t] as number) + config.pairWeight * pairs;
  }
  const summedFit = fit([score]);

  return {
    trainMatches,
    testMatches,
    kinds,
    summed: {
      slope: summedFit.coefficients[1] as number,
      standardError: summedFit.standardErrors[1] as number,
    },
  };
}
