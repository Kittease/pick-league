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

export interface PatchChoice {
  /** Patches whose stats are combined, newest first: [current], or [current, previous]. */
  patches: PatchId[];
  /** True when the previous patch is added because the current one lacks games. */
  merged: boolean;
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
    return { patches: [current], merged: false, currentGames };
  }
  return { patches: [current, previous], merged: true, currentGames };
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
