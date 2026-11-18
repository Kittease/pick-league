import type { LanePhaseDiff, Position, ReasonKind } from '@pick-league/shared';
import { type ConfidenceLevel, confidenceLevel } from './confidence';

export const ROLE_LABEL: Record<Position, string> = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'Bot',
  UTILITY: 'Support',
};

/** Sign of a delta once rounded for display (−0.0003 shows as 0.0 → 0). */
export function deltaSign(delta: number, digits = 1): -1 | 0 | 1 {
  const f = 10 ** digits;
  const r = Math.round(delta * 100 * f) / f;
  return r > 0 ? 1 : r < 0 ? -1 : 0;
}

/** +0.028 → "+2.8" (points); anything that rounds to zero → "0.0", without a sign. */
export function deltaPoints(delta: number, digits = 1): string {
  const sign = deltaSign(delta, digits);
  const s = Math.abs(delta * 100).toFixed(digits);
  return sign > 0 ? `+${s}` : sign < 0 ? `-${s}` : (0).toFixed(digits);
}

/** 0.513 → "51.3%". */
export function percent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

/** ["16.22", "16.21"] → "16.22 + 16.21" (patches whose stats were combined). */
export function patchesText(patches: readonly string[]): string {
  return patches.join(' + ');
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
  patch_fallback: 'Previous patch added',
  lane_phase: 'Lane phase',
  side: 'Side',
  mastery: 'Your mastery',
};

const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** 420 → "+420", -420 → "−420", 1240 → "+1,240"; anything that rounds to zero → "0". */
export function signedNumber(x: number, digits = 0): string {
  const r = Number(x.toFixed(digits));
  const s = intFormat.format(Math.abs(r));
  return r > 0 ? `+${s}` : r < 0 ? `−${s}` : '0';
}

/** CS difference: one decimal under 10 ("−0.4", "+8.5"), whole numbers above ("+12"). */
function csText(cs: number): string {
  return signedNumber(cs, Math.abs(cs) < 10 ? 1 : 0);
}

/** The gold part ("−420 gold") and the rest (" · −8 CS · −310 XP at 10 min"), styled apart. */
export function lanePhaseParts(lane: LanePhaseDiff): { gold: string; rest: string } {
  return {
    gold: `${signedNumber(lane.gold)} gold`,
    rest: ` · ${csText(lane.cs)} CS · ${signedNumber(lane.xp)} XP at ${lane.minute} min`,
  };
}

/** "−420 gold · −8 CS · −310 XP at 10 min" (the 2v2 is marked by the caller). */
export function lanePhaseText(lane: LanePhaseDiff): string {
  const { gold, rest } = lanePhaseParts(lane);
  return gold + rest;
}

/** Compact gold figure for a table cell: "+250g @10", "−1.2kg @10". */
export function laneGoldShort(lane: LanePhaseDiff): string {
  const gold =
    Math.abs(lane.gold) >= 1000 ? `${signedNumber(lane.gold / 1000, 1)}k` : signedNumber(lane.gold);
  return `${gold}g @${lane.minute}`;
}

/** Tooltip of a lane-phase figure: every number and the sample. */
export function laneTitle(lane: LanePhaseDiff): string {
  const where = lane.duo ? 'bot lane 2v2, with the duo partners' : '1v1';
  return `Lane at ${lane.minute} min (${where}): ${signedNumber(lane.gold)} gold, ${csText(lane.cs)} CS, ${signedNumber(lane.xp)} XP, average over ${intFormat.format(lane.games)} matchups (shrunk by sample size)`;
}

/** Sample-size confidence used to fade thin evidence: 0 games → 0.25, ≥ 1000 → 1. */
export function sampleWeight(games: number): number {
  return 0.25 + 0.75 * Math.min(1, games / 1000);
}

const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

export function confidenceLabel(confidence: number): string {
  return CONFIDENCE_LABEL[confidenceLevel(confidence)];
}

export const SKILL_KEY: Record<number, string> = { 1: 'Q', 2: 'W', 3: 'E', 4: 'R' };

/** ISO time → "just now", "12 min ago", "3 h ago", "2 d ago" (relative to `now`). */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
