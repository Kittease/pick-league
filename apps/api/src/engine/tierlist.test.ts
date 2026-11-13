import { describe, expect, test } from 'bun:test';
import { role, vs, withAlly } from './fixtures.ts';
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
      role(PREV, 40, 'UTILITY', 600, 330), // …so previous patch (55 %)
      role(PREV, 111, 'UTILITY', 600, 300),
      role(CUR, 222, 'BOTTOM', 3000, 1500),
    ],
    vs: [],
    with: [],
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
    expect(naut?.patchUsed).toBe(CUR);
    expect(naut?.winRate).toBe(0.55);
    expect(naut?.pickRate).toBeCloseTo(2000 / t.roleGames, 4);
    expect(naut?.banRate).toBe(0.1);
    // Role average ≈ 50 %: delta ≈ +5 points, shrunk with k = 300.
    expect(naut?.score).toBeGreaterThan(0.04);
    expect(naut?.score).toBeLessThan(0.05);

    const janna = t.entries.find((e) => e.championId === 40);
    expect(janna?.patchUsed).toBe(PREV);
    expect(janna?.games).toBe(600);
    expect(janna?.pickRate).toBe(0.5); // 600 of 1200 role games on PREV
    expect(janna?.banRate).toBe(0.1);
    // Smaller sample than Nautilus with the same raw delta → shrunk harder.
    expect(janna?.score).toBeLessThan(naut?.score ?? 0);
    expect(janna?.confidence).toBeLessThan(naut?.confidence ?? 1);
  });

  test('best/worst lane matchups and best duos, shrunk and filtered by games', () => {
    const t = buildTierList(
      'UTILITY',
      data({
        vs: [
          vs(CUR, 111, 40, 'UTILITY', 400, 280), // 70 % → best
          vs(CUR, 111, 412, 'UTILITY', 400, 160), // 40 % → worst
          vs(CUR, 111, 222, 'BOTTOM', 400, 240), // 60 % → bot lane counts too
          vs(CUR, 111, 117, 'UTILITY', 5, 5), // too few games
          vs(CUR, 111, 64, 'JUNGLE', 400, 400), // not a lane opponent
        ],
        with: [
          withAlly(CUR, 111, 222, 'BOTTOM', 400, 260),
          withAlly(CUR, 111, 51, 'BOTTOM', 400, 180),
          withAlly(CUR, 111, 64, 'JUNGLE', 400, 400), // not a duo role
        ],
      }),
    );
    const naut = t.entries.find((e) => e.championId === 111);
    expect(naut?.bestMatchups.map((m) => m.championId)).toEqual([40, 222]);
    expect(naut?.bestMatchups[1]?.role).toBe('BOTTOM');
    expect(naut?.worstMatchups.map((m) => m.championId)).toEqual([412]);
    const best = naut?.bestMatchups[0];
    // +15 points raw, shrunk with k = 120 → 15 × 400 / 520.
    expect(best?.delta).toBeCloseTo((0.15 * 400) / 520, 3);
    expect(best?.winRate).toBe(0.7);
    expect(best?.games).toBe(400);
    expect(naut?.bestDuos.map((d) => d.championId)).toEqual([222]);
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
