import { describe, expect, test } from 'bun:test';
import { picksRequestSchema } from '@pick-league/shared';
import { names, role, thresholds, traitsOf, vs, withAlly } from './fixtures.ts';
import { type PicksData, recommendPicks } from './picks.ts';
import type { CompTraitRow } from './types.ts';

const CUR = '15.22';
const PREV = '15.21';

/** Four supports with a 50 % baseline, plus enemy/ally role rows. */
function data(overrides: Partial<PicksData> = {}): PicksData {
  return {
    currentPatch: CUR,
    previousPatch: PREV,
    roleStats: [
      role(CUR, 111, 'UTILITY', 2000, 1000), // Nautilus
      role(CUR, 117, 'UTILITY', 2000, 1000), // Lulu
      role(CUR, 412, 'UTILITY', 2000, 1000), // Thresh
      role(CUR, 89, 'UTILITY', 2000, 1000), // Leona
      role(CUR, 40, 'UTILITY', 2000, 1000), // Janna (enemy)
      role(CUR, 222, 'BOTTOM', 2000, 1000), // Jinx
      role(CUR, 51, 'BOTTOM', 2000, 1000), // Caitlyn
      role(CUR, 64, 'JUNGLE', 2000, 1000), // Lee Sin
    ],
    vs: [],
    with: [],
    compTraits: [],
    championTraits: [],
    thresholds: [thresholds(CUR)],
    names,
    ...overrides,
  };
}

const req = (body: unknown) => picksRequestSchema.parse(body);

describe('recommendPicks', () => {
  test('lane matchup outranks duo synergy of the same size', () => {
    const result = recommendPicks(
      req({ role: 'UTILITY', allies: [{ championId: 222, role: 'BOTTOM' }], enemies: [40] }),
      data({
        // Nautilus +6 % vs Janna; Lulu +6 % with Jinx; same sample sizes.
        vs: [vs(CUR, 111, 40, 'UTILITY', 1000, 560), vs(CUR, 117, 40, 'UTILITY', 1000, 500)],
        with: [
          withAlly(CUR, 117, 222, 'BOTTOM', 1000, 560),
          withAlly(CUR, 111, 222, 'BOTTOM', 1000, 500),
        ],
      }),
    );
    const ids = result.candidates.map((c) => c.championId);
    expect(ids[0]).toBe(111);
    expect(ids[1]).toBe(117);
    expect(result.patch).toBe(CUR);
    const naut = result.candidates[0];
    const matchup = naut?.reasons.find((r) => r.kind === 'matchup');
    expect(matchup?.games).toBe(1000);
    expect(matchup?.delta).toBeCloseTo((0.06 * 1000) / 1120, 3);
    expect(matchup?.label).toBe('+5.4% vs Janna (likely lane, support, 1,000 games)');
    expect(matchup?.championIds).toEqual([40]);
    const duo = result.candidates[1]?.reasons.find((r) => r.kind === 'duo');
    expect(duo?.label).toBe('+5.4% with Jinx (bot duo, 1,000 games)');
  });

  test('shrinkage keeps tiny samples from dominating', () => {
    const result = recommendPicks(
      req({ role: 'UTILITY', enemies: [40] }),
      data({
        vs: [
          vs(CUR, 111, 40, 'UTILITY', 10, 10), // +50 % on 10 games
          vs(CUR, 117, 40, 'UTILITY', 2000, 1200), // +10 % on 2,000 games
        ],
      }),
    );
    expect(result.candidates[0]?.championId).toBe(117);
  });

  test('excludes bans, picked champions and unavailable ones', () => {
    const result = recommendPicks(
      req({
        role: 'UTILITY',
        allies: [{ championId: 412, role: null }],
        enemies: [40],
        bans: [89],
        availableChampionIds: [111, 117, 89, 412],
      }),
      data(),
    );
    expect(result.candidates.map((c) => c.championId).sort()).toEqual([111, 117]);
  });

  test('adds the previous patch when the current one has too few games, and says so', () => {
    const result = recommendPicks(
      req({ role: 'UTILITY', enemies: [40] }),
      data({
        roleStats: [
          role(CUR, 111, 'UTILITY', 40, 20),
          role(PREV, 111, 'UTILITY', 900, 500),
          role(CUR, 40, 'UTILITY', 2000, 1000),
        ],
        vs: [vs(CUR, 111, 40, 'UTILITY', 10, 6), vs(PREV, 111, 40, 'UTILITY', 90, 54)],
      }),
    );
    const naut = result.candidates[0];
    expect(naut).toMatchObject({ championId: 111, patchesUsed: [CUR, PREV], games: 940 });
    expect(naut?.winRate).toBeCloseTo(520 / 940, 4);
    expect(naut?.reasons[0]).toMatchObject({ kind: 'patch_fallback', games: 940 });
    expect(naut?.reasons[0]?.label).toBe(
      '15.22 + 15.21 data: only 40 games of Nautilus support on 15.22',
    );
    expect(naut?.reasons.find((r) => r.kind === 'matchup')?.games).toBe(100);
  });

  test('keeps the current patch alone from the threshold on', () => {
    const result = recommendPicks(
      req({ role: 'UTILITY' }),
      data({
        roleStats: [role(CUR, 111, 'UTILITY', 150, 75), role(PREV, 111, 'UTILITY', 900, 500)],
      }),
    );
    expect(result.candidates[0]).toMatchObject({ patchesUsed: [CUR], games: 150 });
    expect(result.candidates[0]?.reasons.some((r) => r.kind === 'patch_fallback')).toBe(false);
  });

  test('vs enemy composition traits, net of the role-wide effect', () => {
    const comp = (championId: number, games: number, wins: number): CompTraitRow => ({
      patch: CUR,
      position: 'UTILITY',
      championId,
      side: 'enemy',
      trait: 'HIGH_HEALING',
      games,
      wins,
    });
    const result = recommendPicks(
      req({ role: 'UTILITY', enemies: [16, 19] }),
      data({
        championTraits: [
          traitsOf(CUR, 16, { healingPerMin: 120 }),
          traitsOf(CUR, 19, { healingPerMin: 60 }),
        ],
        compTraits: [
          comp(111, 1000, 500),
          comp(117, 1000, 600),
          comp(412, 1000, 500),
          comp(89, 1000, 500),
        ],
      }),
    );
    expect(result.candidates[0]?.championId).toBe(117);
    const reason = result.candidates[0]?.reasons.find((r) => r.kind === 'vs_comp');
    expect(reason).toMatchObject({ trait: 'HIGH_HEALING', games: 1000 });
    expect(reason?.label).toMatch(/^\+\d\.\d% vs heal-heavy teams \(1,000 games\)$/);
  });

  test('scores, confidence and limit', () => {
    const result = recommendPicks(req({ role: 'UTILITY', limit: 2 }), data());
    expect(result.candidates).toHaveLength(2);
    for (const c of result.candidates) {
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThan(1);
      expect(c.reasons.some((r) => r.kind === 'base')).toBe(true);
    }
  });
});
