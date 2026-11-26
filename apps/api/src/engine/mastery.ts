/**
 * Mastery term of the picks: how players with the user's mastery points on a champion do compared
 * with the champion's average (stats_champion_mastery). The curve of all champions is the prior;
 * each champion's own deviation from it is shrunk toward it by its games in the bucket, since the
 * low-vs-high mastery gap really differs between champions.
 */
import type { Position, Reason } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import { formatDelta, formatGames, round, shrink } from './math.ts';
import type { MasteryRow } from './types.ts';

const M = ENGINE_CONFIG.mastery;
/** Buckets 0 … edges.length (the last one has no upper bound). */
const BUCKETS = M.bucketEdges.length + 1;

/** Bucket (0–6) of a number of mastery points. */
export function masteryBucket(points: number): number {
  if (!Number.isFinite(points) || points < 0) return 0;
  let bucket = 0;
  for (const edge of M.bucketEdges) if (edge <= points) bucket++;
  return bucket;
}

/** Highest points per champion → its bucket; a champion listed twice keeps its highest points. */
export function masteryPoints(
  masteries: readonly { championId: number; points: number }[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const { championId, points } of masteries) {
    const prev = out.get(championId);
    if (prev === undefined || points > prev) out.set(championId, points);
  }
  return out;
}

/** 850 → "850", 4_300 → "4.3k", 12_999 → "12k", 1_250_000 → "1.2M" (rounded down). */
export function formatPoints(points: number): string {
  // Rounded down, so a label never shows the next bucket's bound.
  if (points < 1000) return String(points);
  if (points < 10_000) return `${Math.floor(points / 100) / 10}k`;
  if (points < 1_000_000) return `${Math.floor(points / 1000)}k`;
  return `${Math.floor(points / 100_000) / 10}M`;
}

/** "under 5k points", "5k–20k points", …, "500k+ points". */
function bucketRange(bucket: number): string {
  const edges: readonly number[] = M.bucketEdges;
  const edge = (i: number) => formatPoints(edges[i] ?? 0);
  if (bucket <= 0) return `under ${edge(0)} points`;
  if (bucket >= edges.length) return `${edge(edges.length - 1)}+ points`;
  return `${edge(bucket - 1)}–${edge(bucket)} points`;
}

/** `xs[i]`, 0 when out of range. */
const at = (xs: readonly number[], i: number) => xs[i] ?? 0;

export interface MasteryEffect {
  /** Win-rate difference vs the champion's average at that mastery, after shrinkage. */
  delta: number;
  /** Games of the champion + role in the bucket. */
  championGames: number;
  /** Games of every champion in the bucket. */
  allGames: number;
}

export interface MasteryModel {
  effect(championId: number, role: Position, bucket: number): MasteryEffect;
}

interface ChampionCurve {
  games: number[];
  wins: number[];
  /** The champion + role's own win rate over every bucket. */
  winRate: number;
}

const key = (championId: number, position: Position) => `${championId}|${position}`;

/**
 * The mastery model of `rows`. Rows of every patch given are pooled (the curve is stable across
 * patches); rows whose bucket is not an integer in 0–6 are ignored. `shrinkK` is the prior
 * strength of a champion's own deviation (`ENGINE_CONFIG.mastery.shrinkK`; the calibration
 * script tries others).
 */
export function buildMasteryModel(
  rows: readonly MasteryRow[],
  shrinkK: number = M.shrinkK,
): MasteryModel {
  const curves = new Map<string, ChampionCurve>();
  for (const r of rows) {
    if (!Number.isInteger(r.bucket) || r.bucket < 0 || r.bucket >= BUCKETS) continue;
    const k = key(r.championId, r.position);
    let c = curves.get(k);
    if (!c) {
      c = { games: new Array(BUCKETS).fill(0), wins: new Array(BUCKETS).fill(0), winRate: 0 };
      curves.set(k, c);
    }
    c.games[r.bucket] = at(c.games, r.bucket) + r.games;
    c.wins[r.bucket] = at(c.wins, r.bucket) + r.wins;
  }

  // Curve of all champions: wins above each champion's own average, per game of the bucket.
  const excess = new Array<number>(BUCKETS).fill(0);
  const allGames = new Array<number>(BUCKETS).fill(0);
  for (const c of curves.values()) {
    const games = c.games.reduce((s, n) => s + n, 0);
    const wins = c.wins.reduce((s, n) => s + n, 0);
    c.winRate = games > 0 ? wins / games : 0;
    for (let b = 0; b < BUCKETS; b++) {
      excess[b] = at(excess, b) + at(c.wins, b) - at(c.games, b) * c.winRate;
      allGames[b] = at(allGames, b) + at(c.games, b);
    }
  }
  const curve = excess.map((x, b) => (at(allGames, b) > 0 ? x / at(allGames, b) : 0));

  return {
    effect(championId, role, bucket) {
      // Out of range or not an integer: `at` gives 0 games and a 0 curve.
      const g = at(curve, bucket);
      const c = curves.get(key(championId, role));
      const n = c ? at(c.games, bucket) : 0;
      const d = c && n > 0 ? at(c.wins, bucket) / n - c.winRate : 0;
      return {
        delta: g + shrink(d - g, n, shrinkK),
        championGames: n,
        allGames: at(allGames, bucket),
      };
    },
  };
}

/** The `mastery` reason of a candidate the user has `points` mastery points on. */
export function masteryReason(effect: MasteryEffect, points: number, championName: string): Reason {
  const delta = round(effect.delta);
  const range = bucketRange(masteryBucket(points));
  const mine = points === 0 ? 'no points yet' : `${formatPoints(points)} points`;
  const head = `${formatDelta(delta)} at your mastery (${mine})`;
  if (effect.championGames >= M.minChampionGames) {
    return {
      kind: 'mastery',
      label: `${head}: ${championName} players with ${range} vs ${championName}'s average (${formatGames(effect.championGames)})`,
      delta,
      games: effect.championGames,
    };
  }
  return {
    kind: 'mastery',
    label: `${head}: players with ${range} on their champion vs its average (all champions, ${formatGames(effect.allGames)})`,
    delta,
    games: effect.allGames,
  };
}
