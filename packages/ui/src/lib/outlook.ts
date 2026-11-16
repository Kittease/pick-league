import type { TeamDamage } from '@pick-league/shared';

export interface DamageShares {
  physical: number;
  magic: number;
  true: number;
  /** Damage to champions per minute of the whole team. */
  perMinute: number;
}

/** Share of each damage type in a team's damage; null before any champion with data. */
export function damageShares(team: TeamDamage | null | undefined): DamageShares | null {
  if (!team) return null;
  const total = team.physical + team.magic + team.true;
  if (total <= 0) return null;
  return {
    physical: team.physical / total,
    magic: team.magic / total,
    true: team.true / total,
    perMinute: total,
  };
}

/** Whole-number percentages that add up to 100 (largest remainders get the rounding). */
export function roundedShares(s: DamageShares): { physical: number; magic: number; true: number } {
  const keys = ['physical', 'magic', 'true'] as const;
  const raw = keys.map((k) => s[k] * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, rest: v - Math.floor(v) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return { physical: floors[0] ?? 0, magic: floors[1] ?? 0, true: floors[2] ?? 0 };
}

/** "AD 62% · AP 33% · true 5%" */
export function damageLabel(s: DamageShares): string {
  const r = roundedShares(s);
  return `AD ${r.physical}% · AP ${r.magic}% · true ${r.true}%`;
}
