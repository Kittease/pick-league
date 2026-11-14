import { describe, expect, test } from 'bun:test';
import { role } from './fixtures.ts';
import { assignTiers, buildTierList, type TierListData } from './tierlist.ts';

const CUR = '15.22';
const PREV = '15.21';

function data(overrides: Partial<TierListData> = {}): TierListData {
  return {
    currentPatch: CUR,
    previousPatch: PREV,
    roleStats: [
      role(CUR, 111, 'UTILITY', 2000, 1100), // Nautilus 55 %
      role(CUR, 117, 'UTILITY', 2000, 1000), // Lulu 50 %
      role(CUR, 412, 'UTILITY', 2000, 900), // Thresh 45 %
      role(CUR, 89, 'UTILITY', 10, 9), // Leona: too few games everywhere
      role(CUR, 40, 'UTILITY', 50, 30), // Janna: few games on current…
      role(PREV, 40, 'UTILITY', 600, 330), // …so both patches combined (360 / 650)
      role(PREV, 111, 'UTILITY', 600, 300),
      role(CUR, 222, 'BOTTOM', 3000, 1500),
    ],
    bans: [
      { patch: CUR, championId: 111, bans: 300 },
      { patch: PREV, championId: 40, bans: 60 },
    ],
    patchMatches: [
      { patch: CUR, matches: 3000 },
      { patch: PREV, matches: 600 },
    ],
    ...overrides,
  };
}

describe('buildTierList', () => {
  test('ranks by shrunk delta vs role average, with rates and patch fallback', () => {
    const t = buildTierList('UTILITY', data());
    expect(t.role).toBe('UTILITY');
    expect(t.patch).toBe(CUR);
    expect(t.roleGames).toBe(2000 * 3 + 10 + 50);
    const ids = t.entries.map((e) => e.championId);
    expect(ids).not.toContain(89); // below minCandidateGames
    expect(ids).not.toContain(222); // other role
    expect(ids[0]).toBe(111);
    expect(ids.at(-1)).toBe(412);

    const naut = t.entries[0];
    expect(naut?.patchesUsed).toEqual([CUR]);
    expect(naut?.winRate).toBe(0.55);
    expect(naut?.pickRate).toBeCloseTo(2000 / t.roleGames, 4);
    expect(naut?.banRate).toBe(0.1);
    // Role average ≈ 50 %: delta ≈ +5 points, shrunk with k = 300.
    expect(naut?.score).toBeGreaterThan(0.04);
    expect(naut?.score).toBeLessThan(0.05);

    const janna = t.entries.find((e) => e.championId === 40);
    expect(janna?.patchesUsed).toEqual([CUR, PREV]);
    expect(janna?.games).toBe(650);
    expect(janna?.winRate).toBeCloseTo(360 / 650, 4);
    // 650 of the role's 6,060 + 1,200 games on both patches; banned in 60 of 3,600 matches.
    expect(janna?.pickRate).toBeCloseTo(650 / 7260, 4);
    expect(janna?.banRate).toBeCloseTo(60 / 3600, 4);
    // Smaller sample than Nautilus with the same raw delta → shrunk harder.
    expect(janna?.score).toBeLessThan(naut?.score ?? 0);
    expect(janna?.confidence).toBeLessThan(naut?.confidence ?? 1);
  });

  test('empty role', () => {
    const t = buildTierList('TOP', data());
    expect(t.entries).toEqual([]);
    expect(t.roleGames).toBe(0);
  });
});

describe('assignTiers', () => {
  test('spreads a role over S..D by percentile', () => {
    const scores = Array.from({ length: 20 }, (_, i) => 0.05 - i * 0.005);
    const tiers = assignTiers(scores);
    const count = (t: string) => tiers.filter((x) => x === t).length;
    expect(tiers[0]).toBe('S');
    expect(tiers.at(-1)).toBe('D');
    expect([count('S'), count('A'), count('B'), count('C'), count('D')]).toEqual([2, 4, 7, 4, 3]);
  });

  test('non-positive scores are capped at B; ties share a tier', () => {
    expect(assignTiers([0, -0.01, -0.02])).toEqual(['B', 'B', 'C']);
    expect(assignTiers([0.02, 0.02, 0.02, 0.02])).toEqual(['A', 'A', 'A', 'A']);
    expect(assignTiers([0.01])).toEqual(['B']);
  });
});
