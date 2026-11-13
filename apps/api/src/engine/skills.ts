/**
 * Basic-ability max order from a skill-point sequence (1=Q 2=W 3=E 4=R): abilities sorted by the
 * level at which they got their 5th point, then by points, then slot. Null below 9 points.
 * Mirrors the SQL function `pl_skill_max_order` (0002_stats_views.sql).
 */
export function skillMaxOrder(seq: readonly number[]): number[] | null {
  if (seq.length < 9) return null;
  const count = [0, 0, 0, 0];
  const fifth = [1000, 1000, 1000, 1000];
  seq.forEach((s, i) => {
    if (s >= 1 && s <= 3) {
      count[s] = (count[s] ?? 0) + 1;
      if (count[s] === 5) fifth[s] = i + 1;
    }
  });
  return [1, 2, 3].sort(
    (a, b) => (fifth[a] ?? 0) - (fifth[b] ?? 0) || (count[b] ?? 0) - (count[a] ?? 0) || a - b,
  );
}

/**
 * Canonical 18-level sequence: the given first levels, R at 6/11/16, then points in max order.
 */
export function synthesiseSkillSequence(
  firstLevels: readonly number[],
  maxOrder: readonly number[],
): number[] {
  const count: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const seq: number[] = [];
  for (let level = 1; level <= 18; level++) {
    let slot: number;
    const first = firstLevels[level - 1];
    if (level <= firstLevels.length && first !== undefined) slot = first;
    else if (level === 6 || level === 11 || level === 16) slot = 4;
    else slot = maxOrder.find((s) => (count[s] ?? 0) < 5) ?? (maxOrder[0] as number);
    count[slot] = (count[slot] ?? 0) + 1;
    seq.push(slot);
  }
  return seq;
}

export const parseIntList = (key: string): number[] =>
  key === '' ? [] : key.split(',').map((x) => Number(x));
