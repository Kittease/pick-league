import { describe, expect, test } from 'bun:test';
import { picksRequestSchema } from '@pick-league/shared';
import { lane, names, role, thresholds, traitsOf, vs, withAlly } from './fixtures.ts';
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
        // Nautilus +6 % vs Janna; Lulu +6 % with Jinx; same sample sizes. The other supports do
        // as usual, so supports usually get +1.5 % vs Janna and with Jinx.
        vs: [
          vs(CUR, 111, 40, 'UTILITY', 1000, 560),
          vs(CUR, 117, 40, 'UTILITY', 1000, 500),
          vs(CUR, 412, 40, 'UTILITY', 1000, 500),
          vs(CUR, 89, 40, 'UTILITY', 1000, 500),
        ],
        with: [
          withAlly(CUR, 117, 222, 'BOTTOM', 1000, 560),
          withAlly(CUR, 111, 222, 'BOTTOM', 1000, 500),
          withAlly(CUR, 412, 222, 'BOTTOM', 1000, 500),
          withAlly(CUR, 89, 222, 'BOTTOM', 1000, 500),
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
    // 6 % − the usual 1.5 %, shrunk with k = 1,200.
    expect(matchup?.delta).toBeCloseTo((0.045 * 1000) / 2200, 3);
    expect(matchup?.label).toBe(
      '+2.0% vs Janna compared with other supports (likely lane, support, 1,000 games)',
    );
    expect(matchup?.championIds).toEqual([40]);
    const duo = result.candidates[1]?.reasons.find((r) => r.kind === 'duo');
    expect(duo?.label).toBe('+1.7% with Jinx compared with other supports (bot duo, 1,000 games)');
  });

  test("an enemy's own strength does not favour candidates with small samples", () => {
    // Janna beats every support by 5 %: Nautilus (2,000 games) and Lulu (40 games) both do as
    // usual vs her, so neither gets a matchup edge.
    const result = recommendPicks(
      req({ role: 'UTILITY', enemies: [40] }),
      data({
        vs: [
          vs(CUR, 111, 40, 'UTILITY', 2000, 900),
          vs(CUR, 117, 40, 'UTILITY', 40, 18),
          vs(CUR, 412, 40, 'UTILITY', 2000, 900),
        ],
      }),
    );
    for (const id of [111, 117]) {
      const c = result.candidates.find((x) => x.championId === id);
      expect(c?.reasons.find((r) => r.kind === 'matchup')?.delta).toBeCloseTo(0, 4);
    }
  });

  test("the champion's own strength counts as much as its matchup", () => {
    // Thresh: 54 % overall, as usual vs Janna. Leona: 50 % overall, +4 % vs Janna (500 games).
    const result = recommendPicks(
      req({ role: 'UTILITY', enemies: [40] }),
      data({
        roleStats: [
          role(CUR, 412, 'UTILITY', 2000, 1080),
          role(CUR, 89, 'UTILITY', 2000, 1000),
          role(CUR, 111, 'UTILITY', 2000, 1000),
          role(CUR, 40, 'UTILITY', 2000, 1000),
        ],
        vs: [
          vs(CUR, 412, 40, 'UTILITY', 500, 270),
          vs(CUR, 89, 40, 'UTILITY', 500, 270),
          vs(CUR, 111, 40, 'UTILITY', 2000, 1000),
        ],
      }),
    );
    expect(result.candidates[0]?.championId).toBe(412);
    const base = result.candidates[0]?.reasons.find((r) => r.kind === 'base');
    // 54 % vs the role average (Janna included), shrunk with k = 250.
    expect(base?.delta).toBeCloseTo(((0.54 - 4080 / 8000) * 2000) / 2250, 4);
  });

  test('shrinkage keeps tiny samples from dominating', () => {
    const result = recommendPicks(
      req({ role: 'UTILITY', enemies: [40] }),
      data({
        vs: [
          vs(CUR, 111, 40, 'UTILITY', 10, 10), // +50 % on 10 games
          vs(CUR, 117, 40, 'UTILITY', 2000, 1200), // +10 % on 2,000 games
          vs(CUR, 412, 40, 'UTILITY', 2000, 1000), // as usual
          vs(CUR, 89, 40, 'UTILITY', 2000, 1000),
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

  test('lane phase vs the lane opponent next to its matchup, without changing the score', () => {
    const body = req({ role: 'UTILITY', enemies: [40, 64] });
    const without = recommendPicks(body, data({ vs: [vs(CUR, 111, 40, 'UTILITY', 1000, 560)] }));
    const result = recommendPicks(
      body,
      data({
        vs: [vs(CUR, 111, 40, 'UTILITY', 1000, 560)],
        lanePhase: [
          lane(CUR, 111, 40, 'UTILITY', 200, { gold: 440, xp: 330, cs: 2.2 }),
          lane(PREV, 111, 40, 'UTILITY', 900, { gold: -900, xp: 0, cs: 0 }), // patch not used
          lane(CUR, 117, 40, 'UTILITY', 10, { gold: 900, xp: 0, cs: 0 }), // too few matchups
          lane(CUR, 111, 40, 'BOTTOM', 500, { gold: 900, xp: 0, cs: 0 }), // Janna as ADC
        ],
      }),
    );
    expect(result.candidates.map((c) => [c.championId, c.score, c.confidence])).toEqual(
      without.candidates.map((c) => [c.championId, c.score, c.confidence]),
    );
    const naut = result.candidates.find((c) => c.championId === 111);
    const kinds = naut?.reasons.map((r) => r.kind);
    expect(kinds?.indexOf('lane_phase')).toBe((kinds?.indexOf('matchup') ?? -2) + 1);
    const keep = 200 / 220;
    expect(naut?.reasons.find((r) => r.kind === 'lane_phase')).toEqual({
      kind: 'lane_phase',
      label: `Lane at 10 min vs Janna: +${Math.round(440 * keep)} gold, +2 CS, +${Math.round(330 * keep)} XP (bot lane 2v2, likely support, 200 matchups)`,
      delta: 0,
      games: 200,
      championIds: [40],
      lane: { minute: 10, gold: 400, xp: 300, cs: 2, duo: true, games: 200 },
    });
    const lulu = result.candidates.find((c) => c.championId === 117);
    expect(lulu?.reasons.some((r) => r.kind === 'lane_phase')).toBe(false);
  });
});
