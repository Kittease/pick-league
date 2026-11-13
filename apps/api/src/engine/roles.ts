import { POSITIONS, type Position } from '@pick-league/shared';
import type { RoleStatRow } from './types.ts';

export interface RoleGuess {
  championId: number;
  role: Position;
  /** True when the role was given, false when inferred. */
  known: boolean;
  /** Share of the champion's games played in that role (1 when known). */
  probability: number;
}

/** games per (champion, role), summed over the given rows (e.g. both kept patches). */
export function rolePlayRates(rows: readonly RoleStatRow[]): Map<number, Map<Position, number>> {
  const out = new Map<number, Map<Position, number>>();
  for (const r of rows) {
    let m = out.get(r.championId);
    if (!m) {
      m = new Map();
      out.set(r.championId, m);
    }
    m.set(r.position, (m.get(r.position) ?? 0) + r.games);
  }
  return out;
}

/**
 * Assigns roles to champions whose role is unknown, among the roles not already taken, by
 * maximising the product of play rates (exhaustive search: at most 5! assignments).
 * `taken` roles are excluded (e.g. the user's role on the ally side).
 */
export function assignRoles(
  team: readonly { championId: number; role: Position | null }[],
  playRates: Map<number, Map<Position, number>>,
  taken: readonly Position[] = [],
): RoleGuess[] {
  const known: RoleGuess[] = [];
  const unknown: number[] = [];
  const used = new Set<Position>(taken);
  for (const m of team) {
    if (m.role && !used.has(m.role)) {
      used.add(m.role);
      known.push({ championId: m.championId, role: m.role, known: true, probability: 1 });
    } else {
      unknown.push(m.championId);
    }
  }
  const free = POSITIONS.filter((p) => !used.has(p));
  const prob = (id: number, role: Position) => {
    const rates = playRates.get(id);
    const total = rates ? [...rates.values()].reduce((s, n) => s + n, 0) : 0;
    return total > 0 ? (rates?.get(role) ?? 0) / total : 0;
  };

  let best: Position[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  const current: Position[] = [];
  const search = (i: number, remaining: Position[], score: number) => {
    if (i === unknown.length || remaining.length === 0) {
      if (score > bestScore) {
        bestScore = score;
        best = [...current];
      }
      return;
    }
    for (const role of remaining) {
      current.push(role);
      search(
        i + 1,
        remaining.filter((r) => r !== role),
        score + Math.log(prob(unknown[i] as number, role) + 1e-3),
      );
      current.pop();
    }
  };
  search(0, free, 0);

  const guessed = unknown.flatMap((id, i): RoleGuess[] => {
    const role = best[i];
    return role ? [{ championId: id, role, known: false, probability: prob(id, role) }] : [];
  });
  return [...known, ...guessed];
}
