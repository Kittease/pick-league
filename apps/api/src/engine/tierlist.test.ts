import { describe, expect, test } from 'bun:test';
import { ENGINE_CONFIG } from './config.ts';
import { role } from './fixtures.ts';
import { shrink } from './math.ts';
import { assignTiers, buildTierList, type TierListData } from './tierlist.ts';

const CUR = '15.22';
const PREV = '15.21';
const K_BASE = ENGINE_CONFIG.picks.shrinkK.base;
const CAP = ENGINE_CONFIG.previousPatchPrior.strength;

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
  test('ranks by shrunk delta vs role average, with rates and the previous patch as a prior', () => {
    const t = buildTierList('UTILITY', data());
    expect(t.role).toBe('UTILITY');
    expect(t.patch).toBe(CUR);
    expect(t.roleGames).toBe(2000 * 3 + 10 + 50);
    const ids = t.entries.map((e) => e.championId);
    expect(ids).not.toContain(89); // below minCandidateGames
    expect(ids).not.toContain(222); // other role
    expect(ids[0]).toBe(111);
    expect(ids.at(-1)).toBe(412);

    // Role averages per patch: 3,039 / 6,060 on 15.22, 630 / 1,200 on 15.21.
    const roleCur = 3039 / 6060;
    const rolePrev = 630 / 1200;
    const naut = t.entries[0];
    // 600 previous games (under the cap) count fully: 23 % of 2,600 effective games.
    expect(naut?.patchesUsed).toEqual([CUR, PREV]);
    expect(naut?.games).toBe(2600);
    expect(naut?.winRate).toBeCloseTo(1400 / 2600, 4);
    // Strength measured inside each patch, then blended: +4.85 points on 15.22, −2.5 on 15.21.
    const nautDelta = (2000 * (0.55 - roleCur) + 600 * (0.5 - rolePrev)) / 2600;
    expect(naut?.score).toBeCloseTo(shrink(nautDelta, 2600, K_BASE), 5);
    expect(naut?.score).toBeCloseTo(0.02877, 4);
    expect(naut?.pickRate).toBeCloseTo((2 * 2600) / 7260, 4);
    // Banned 300 times, all on 15.22; both patches' matches count.
    expect(naut?.banRate).toBeCloseTo(300 / 3600, 4);

    const janna = t.entries.find((e) => e.championId === 40);
    expect(janna?.patchesUsed).toEqual([CUR, PREV]);
    expect(janna?.games).toBe(650);
    expect(janna?.winRate).toBeCloseTo(360 / 650, 4);
    // 650 of the 3,630 matches' worth of support games on both patches (7,260 role games);
    // banned in 60 of 3,600 matches.
    expect(janna?.pickRate).toBeCloseTo((2 * 650) / 7260, 4);
    expect(janna?.banRate).toBeCloseTo(60 / 3600, 4);
    const jannaDelta = (50 * (0.6 - roleCur) + 600 * (0.55 - rolePrev)) / 650;
    expect(janna?.score).toBeCloseTo(shrink(jannaDelta, 650, K_BASE), 5);
    expect(janna?.score).toBeLessThan(naut?.score ?? 0);
    expect(janna?.confidence).toBeLessThan(naut?.confidence ?? 1);
  });

  test('pick rate is a share of matches: a champion in every match of the role is at 100 %', () => {
    // 1,000 matches, two support slots each: Nautilus on one team and Lulu on the other every time.
    const t = buildTierList(
      'UTILITY',
      data({
        previousPatch: null,
        roleStats: [role(CUR, 111, 'UTILITY', 1000, 550), role(CUR, 117, 'UTILITY', 1000, 450)],
        bans: [],
        patchMatches: [{ patch: CUR, matches: 1000 }],
      }),
    );
    expect(t.roleGames).toBe(2000);
    expect(t.entries.map((e) => e.pickRate)).toEqual([1, 1]);
  });

  test('a big current sample leaves the previous patch unlisted (under 10 %)', () => {
    const t = buildTierList(
      'UTILITY',
      data({
        roleStats: [
          role(CUR, 111, 'UTILITY', 20_000, 10_400),
          role(PREV, 111, 'UTILITY', 1300, 650),
          role(CUR, 117, 'UTILITY', 20_000, 9_600),
          role(PREV, 117, 'UTILITY', 1300, 650),
        ],
      }),
    );
    const naut = t.entries.find((e) => e.championId === 111);
    // 1,300 previous games count for 1,200: share 1,200 / 21,200 = 5.7 %, so only the current
    // patch's games are shown.
    expect(naut?.games).toBe(20_000);
    expect(naut?.patchesUsed).toEqual([CUR]);
    const w = CAP / 1300;
    expect(naut?.winRate).toBeCloseTo((10_400 + w * 650) / 21_200, 4);
    // Role at 50 % on both patches: +2 points on 15.22, 0 on 15.21.
    expect(naut?.score).toBeCloseTo(shrink((20_000 * 0.02) / 21_200, 21_200, K_BASE), 5);
  });

  test('previous patch only: the old summed record, capped at 1,200 games', () => {
    const t = buildTierList(
      'UTILITY',
      data({
        roleStats: [
          role(PREV, 111, 'UTILITY', 5000, 2750), // 55 %, nothing on 15.22 yet
          role(PREV, 117, 'UTILITY', 5000, 2250),
          role(CUR, 117, 'UTILITY', 1000, 500),
          role(CUR, 412, 'UTILITY', 1000, 500),
        ],
      }),
    );
    const naut = t.entries.find((e) => e.championId === 111);
    // Shown: its real 5,000 games; they count for 1,200.
    expect(naut?.games).toBe(5000);
    expect(naut?.patchesUsed).toEqual([CUR, PREV]);
    expect(naut?.winRate).toBeCloseTo(0.55, 4);
    // Against the previous patch's role average (50 %), on 1,200 games.
    const prevDelta = 0.55 - 0.5;
    expect(naut?.score).toBeCloseTo(shrink(prevDelta, 1200, K_BASE), 5);
    expect(naut?.score).toBeCloseTo((0.05 * 1200) / 1450, 5);
  });

  test('without a previous patch its rows are ignored', () => {
    const withoutPrevRows = data({
      previousPatch: null,
      roleStats: data().roleStats.filter((r) => r.patch === CUR),
      bans: data().bans.filter((b) => b.patch === CUR),
      patchMatches: data().patchMatches.filter((m) => m.patch === CUR),
    });
    expect(buildTierList('UTILITY', data({ previousPatch: null }))).toEqual(
      buildTierList('UTILITY', withoutPrevRows),
    );
    const naut = buildTierList('UTILITY', data({ previousPatch: null })).entries[0];
    expect(naut).toMatchObject({ championId: 111, games: 2000, patchesUsed: [CUR], banRate: 0.1 });
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

describe('buildTierList shown games', () => {
  // Nautilus: 100 games on 15.22 and 5,000 on 15.21 (counting for 1,200: listed), or 20,000 and
  // 1,300 (5.7 % of the effective games: not listed). Lulu is the rest of the role.
  const listed = [
    role(CUR, 111, 'UTILITY', 100, 55),
    role(PREV, 111, 'UTILITY', 5000, 2750),
    role(CUR, 117, 'UTILITY', 2000, 1000),
    role(PREV, 117, 'UTILITY', 5000, 2500),
  ];
  const unlisted = [
    role(CUR, 111, 'UTILITY', 20_000, 10_400),
    role(PREV, 111, 'UTILITY', 1300, 650),
    role(CUR, 117, 'UTILITY', 20_000, 9_600),
    role(PREV, 117, 'UTILITY', 1300, 650),
  ];
  const naut = (roleStats: TierListData['roleStats']) =>
    buildTierList('UTILITY', data({ roleStats, bans: [], patchMatches: [] })).entries.find(
      (e) => e.championId === 111,
    );

  test('the real games of the patches listed; score and confidence on the effective games', () => {
    // Both patches listed: 100 + 5,000 shown, scored on 100 + 1,200.
    expect(naut(listed)).toMatchObject({ patchesUsed: [CUR, PREV], games: 5100 });
    expect(naut(listed)?.score).toBeCloseTo(0.02243, 5);
    expect(naut(listed)?.confidence).toBe(0.867);
    // Previous patch not listed: the current patch's 20,000 shown, scored on 21,200.
    expect(naut(unlisted)).toMatchObject({ patchesUsed: [CUR], games: 20_000 });
    expect(naut(unlisted)?.score).toBeCloseTo(0.01865, 5);
    expect(naut(unlisted)?.confidence).toBe(0.991);
  });
});
