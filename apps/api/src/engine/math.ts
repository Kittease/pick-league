import type { PatchId } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import type { GamesWins } from './types.ts';

/** wins / games, 0 when no games. */
export function winRate(s: GamesWins | undefined): number {
  return s && s.games > 0 ? s.wins / s.games : 0;
}

/** Empirical-Bayes style shrinkage toward 0: `delta * n / (n + k)`. */
export function shrink(delta: number, games: number, k: number): number {
  // k = Infinity: no measurable difference, every delta is 0 (never -0).
  if (games <= 0 || !Number.isFinite(k)) return 0;
  return (delta * games) / (games + k);
}

/** n / (n + k) in [0, 1). */
export function sampleConfidence(games: number, k: number): number {
  return games <= 0 ? 0 : games / (games + k);
}

export function sumStats(rows: readonly GamesWins[]): GamesWins {
  let games = 0;
  let wins = 0;
  for (const r of rows) {
    games += r.games;
    wins += r.wins;
  }
  return { games, wins };
}

const intFormat = new Intl.NumberFormat('en-US');

/** 1240 → "1,240 games", 1 → "1 game" */
export function formatGames(n: number): string {
  return `${intFormat.format(n)} ${n === 1 ? 'game' : 'games'}`;
}

export function formatMatches(n: number): string {
  return `${intFormat.format(n)} ${n === 1 ? 'match' : 'matches'}`;
}

/** 0.0281 → "+2.8%"; anything that rounds to zero → "0.0%", without a sign. */
export function formatDelta(delta: number): string {
  const pct = Math.round(delta * 1000) / 10;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** 0.5132 → "51.3%" */
export function formatRate(rate: number): string {
  return `${(Math.round(rate * 1000) / 10).toFixed(1)}%`;
}

export const round = (x: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

/** The two kept patches. `previous` is null on the first patch or when a patch is forced. */
export interface PatchPair {
  current: PatchId;
  previous: PatchId | null;
}

/** One statistic measured on one patch: a win rate, a delta, an average… over `games`. */
export interface PatchSample {
  value: number;
  games: number;
}

export interface Blend {
  /** Mean of the two values, weighted by current games and weight × previous games. */
  value: number;
  /** Effective games: current + weight × previous (not rounded). */
  games: number;
  currentGames: number;
  previousGames: number;
  /** min(1, cap / previousGames); 0 without previous games. */
  previousWeight: number;
  /** Share of the effective games that comes from the previous patch (0 when there are none). */
  previousShare: number;
}

/** Weight of a previous-patch sample: it counts for at most `cap` games. */
export function previousWeight(previousGames: number, cap: number): number {
  return previousGames > 0 ? Math.min(1, cap / previousGames) : 0;
}

/**
 * Blends one statistic's two per-patch samples (either may be missing or have 0 games): the
 * previous patch is a prior worth at most `cap` games, so it fades as the current patch is played.
 */
export function blendPatches(
  current: PatchSample | undefined,
  previous: PatchSample | undefined,
  cap: number,
): Blend {
  const currentGames = current && current.games > 0 ? current.games : 0;
  const previousGames = previous && previous.games > 0 ? previous.games : 0;
  const weight = previousWeight(previousGames, cap);
  const fromPrevious = weight * previousGames;
  const games = currentGames + fromPrevious;
  if (games <= 0) {
    return {
      value: 0,
      games: 0,
      currentGames,
      previousGames,
      previousWeight: weight,
      previousShare: 0,
    };
  }
  const value =
    ((current?.value ?? 0) * currentGames + (previous?.value ?? 0) * fromPrevious) / games;
  return {
    value,
    games,
    currentGames,
    previousGames,
    previousWeight: weight,
    previousShare: fromPrevious / games,
  };
}

/** Another value of the same cell (e.g. its win rate) mixed with the weights of `blend`. */
export function mixLike(blend: Blend, current: number, previous: number): number {
  if (blend.games <= 0) return 0;
  const fromPrevious = blend.previousWeight * blend.previousGames;
  return (current * blend.currentGames + previous * fromPrevious) / blend.games;
}

/** `[current]`, plus the previous patch when its share reaches `previousPatchPrior.listedShare`. */
export function patchesUsedFor(patches: PatchPair, previousShare: number): PatchId[] {
  return patches.previous !== null && previousShare >= ENGINE_CONFIG.previousPatchPrior.listedShare
    ? [patches.current, patches.previous]
    : [patches.current];
}

/** Effective games as shown in responses and labels. */
export const shownGames = (games: number): number => Math.round(games);

export interface PatchChoice {
  /** Patches listed as used (see `patchesUsedFor`), newest first. */
  patches: PatchId[];
  /** Weight of the previous patch's rows (0 = not used). */
  previousWeight: number;
  /** Share of the champion+role's effective games that comes from the previous patch. */
  previousShare: number;
  /** Games of champion+role on the current patch alone. */
  currentGames: number;
}

/**
 * The current patch alone when it has at least `patchFallbackMinGames` games for the
 * champion+role, else the current and previous patches combined (when the previous has any).
 */
export function choosePatches(
  current: PatchId,
  previous: PatchId | null,
  currentGames: number,
  previousGames: number,
  minGames: number = ENGINE_CONFIG.patchFallbackMinGames,
): PatchChoice {
  if (currentGames >= minGames || previous === null || previousGames === 0) {
    return { patches: [current], previousWeight: 0, previousShare: 0, currentGames };
  }
  return {
    patches: [current, previous],
    previousWeight: 1,
    previousShare: previousGames / (currentGames + previousGames),
    currentGames,
  };
}

/** "15.22" or "15.22 + 15.21" */
export function patchesLabel(patches: readonly PatchId[]): string {
  return patches.join(' + ');
}

/**
 * Rows summed per key (games and wins added, other fields from the first row), e.g. the same
 * matchup on both patches of a `PatchChoice`.
 */
export function sumByKey<T extends GamesWins>(rows: readonly T[], key: (r: T) => string): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const seen = out.get(k);
    out.set(k, seen ? { ...seen, games: seen.games + r.games, wins: seen.wins + r.wins } : r);
  }
  return [...out.values()];
}

/**
 * Rows summed per key with a weight per patch (other fields from the first row): games rounded,
 * wins scaled so that wins / games stays the weighted win rate; groups rounding to 0 games are
 * dropped. The same sum as the build loaders of the stats repository.
 */
export function sumWeighted<T extends GamesWins & { patch: PatchId }>(
  rows: readonly T[],
  weightOf: (patch: PatchId) => number,
  key: (r: T) => string,
): T[] {
  const groups = new Map<string, { first: T; games: number; wins: number }>();
  for (const r of rows) {
    const w = weightOf(r.patch);
    if (w <= 0) continue;
    const k = key(r);
    const g = groups.get(k) ?? { first: r, games: 0, wins: 0 };
    g.games += w * r.games;
    g.wins += w * r.wins;
    groups.set(k, g);
  }
  return [...groups.values()].flatMap(({ first, games, wins }) => {
    const rounded = Math.round(games);
    return rounded > 0 ? [{ ...first, games: rounded, wins: (wins * rounded) / games }] : [];
  });
}
