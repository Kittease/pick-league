import type { CompTrait } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import type { ChampionTraitRow, CompThresholdRow } from './types.ts';

/** Mean profile of a (partial) team. */
export interface CompProfile {
  champions: number;
  physicalShare: number;
  magicShare: number;
  ccPerMin: number;
  healingPerMin: number;
  tankinessPerMin: number;
  ranged: number;
  melee: number;
}

export function compProfile(champions: readonly ChampionTraitRow[]): CompProfile | null {
  const n = champions.length;
  if (n === 0) return null;
  const mean = (f: (c: ChampionTraitRow) => number) => champions.reduce((s, c) => s + f(c), 0) / n;
  const ranged = mean((c) => (c.isRanged ? 1 : 0));
  return {
    champions: n,
    physicalShare: mean((c) => c.physicalShare),
    magicShare: mean((c) => c.magicShare),
    ccPerMin: mean((c) => c.ccPerMin),
    healingPerMin: mean((c) => c.healingPerMin),
    tankinessPerMin: mean((c) => c.tankinessPerMin),
    ranged,
    melee: 1 - ranged,
  };
}

/**
 * Traits of a composition: a metric at or above the patch's 75th percentile of team means.
 * Mirrors the SQL function `pl_comp_traits` (0002_stats_views.sql) used to bucket matches.
 * Returns [] when fewer than `minTraitChampions` champions are known.
 */
export function compTraits(
  profile: CompProfile | null,
  t: CompThresholdRow | undefined,
  minChampions: number = ENGINE_CONFIG.minTraitChampions,
): CompTrait[] {
  if (!profile || !t || profile.champions < minChampions) return [];
  const out: CompTrait[] = [];
  if (profile.physicalShare >= t.physicalShare) out.push('AD_HEAVY');
  if (profile.magicShare >= t.magicShare) out.push('AP_HEAVY');
  if (profile.ccPerMin >= t.ccPerMin) out.push('HIGH_CC');
  if (profile.healingPerMin >= t.healingPerMin) out.push('HIGH_HEALING');
  if (profile.tankinessPerMin >= t.tankinessPerMin) out.push('TANKY');
  if (profile.ranged >= t.ranged) out.push('POKE_RANGED');
  if (profile.melee >= t.melee) out.push('MELEE_HEAVY');
  return out;
}
