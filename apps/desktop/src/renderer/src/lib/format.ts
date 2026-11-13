import type { Position, ReasonKind } from '@pick-league/shared';

export const ROLE_LABEL: Record<Position, string> = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'Bot',
  UTILITY: 'Support',
};

/** +0.028 → "+2.8" (points). */
export function deltaPoints(delta: number, digits = 1): string {
  const v = delta * 100;
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : v < 0 ? s : `±${Math.abs(v).toFixed(digits)}`;
}

/** 0.513 → "51.3%". */
export function percent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

/** 48213 → "48.2k". */
export function compact(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const REASON_KIND_LABEL: Record<ReasonKind, string> = {
  base: 'Baseline',
  matchup: 'Lane matchup',
  duo: 'Duo synergy',
  vs_comp: 'Vs enemy comp',
  with_comp: 'With ally comp',
  item_swap: 'Item swap',
  tag_rule: 'Item rule',
  popularity: 'Popularity',
  patch_fallback: 'Previous patch',
};

/** Sample-size confidence used to fade thin evidence: 0 games → 0.25, ≥ 1000 → 1. */
export function sampleWeight(games: number): number {
  return 0.25 + 0.75 * Math.min(1, games / 1000);
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.75) return 'High';
  if (confidence >= 0.4) return 'Medium';
  return 'Low';
}

export const SKILL_KEY: Record<number, string> = { 1: 'Q', 2: 'W', 3: 'E', 4: 'R' };
