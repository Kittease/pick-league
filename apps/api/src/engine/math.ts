import type { PatchId } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import type { GamesWins } from './types.ts';

/** wins / games, 0 when no games. */
export function winRate(s: GamesWins | undefined): number {
  return s && s.games > 0 ? s.wins / s.games : 0;
}

/** Empirical-Bayes style shrinkage toward 0: `delta * n / (n + k)`. */
export function shrink(delta: number, games: number, k: number): number {
  if (games <= 0) return 0;
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
  patch: PatchId;
  games: number;
  /** True when the previous patch is used because the current one lacks games. */
  fellBack: boolean;
  currentGames: number;
}

/**
 * Current patch when it has at least `patchFallbackMinGames` games for the champion+role,
 * else the previous patch if it has more games.
 */
export function choosePatch(
  current: PatchId,
  previous: PatchId | null,
  currentGames: number,
  previousGames: number,
  minGames: number = ENGINE_CONFIG.patchFallbackMinGames,
): PatchChoice {
  if (currentGames >= minGames || previous === null || previousGames <= currentGames) {
    return { patch: current, games: currentGames, fellBack: false, currentGames };
  }
  return { patch: previous, games: previousGames, fellBack: true, currentGames };
}
