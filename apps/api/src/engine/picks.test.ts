import { describe, expect, test } from 'bun:test';
import { type PicksResponse, type Position, picksRequestSchema } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import { lane, names, role, thresholds, traitsOf, vs, withAlly } from './fixtures.ts';
import { shrink } from './math.ts';
import { type PicksData, recommendPicks } from './picks.ts';
import type { CompTraitRow, MasteryRow } from './types.ts';

const CUR = '15.22';
const PREV = '15.21';
const K = ENGINE_CONFIG.picks.shrinkK;

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
    // 6 % − the usual 1.5 %, shrunk with k = 900.
    expect(matchup?.delta).toBeCloseTo((0.045 * 1000) / (1000 + K.matchup), 3);
    expect(matchup?.label).toBe(
      '+2.4% vs Janna compared with other supports (likely lane, support, 1,000 games)',
    );
    expect(matchup?.championIds).toEqual([40]);
    const duo = result.candidates[1]?.reasons.find((r) => r.kind === 'duo');
    expect(duo?.delta).toBeCloseTo((0.045 * 1000) / (1000 + K.duo), 3);
    expect(duo?.label).toBe('+1.1% with Jinx compared with other supports (bot duo, 1,000 games)');
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

  test('mostly the previous patch while the current one has few games, and says so', () => {
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
    // 900 previous games are under the cap: they count fully.
    expect(naut).toMatchObject({ championId: 111, patchesUsed: [CUR, PREV], games: 940 });
    expect(naut?.winRate).toBeCloseTo(520 / 940, 4);
    expect(naut?.reasons[0]).toMatchObject({ kind: 'patch_fallback', games: 940 });
    expect(naut?.reasons[0]?.label).toBe(
      'Mostly 15.21 data: 40 games of Nautilus support on 15.22 so far',
    );
    expect(naut?.reasons.find((r) => r.kind === 'matchup')?.games).toBe(100);
  });

  test('no threshold: the previous patch fades as current games arrive', () => {
    const naut = (current: number, previous: number) =>
      recommendPicks(
        req({ role: 'UTILITY' }),
        data({
          roleStats: [
            role(CUR, 111, 'UTILITY', current, current / 2),
            role(PREV, 111, 'UTILITY', previous, previous / 2),
          ],
        }),
      ).candidates[0];
    const fallback = (c: ReturnType<typeof naut>) =>
      c?.reasons.some((r) => r.kind === 'patch_fallback');
    // 150 current games: the previous patch is still 900 / 1,050 = 86 % of the effective games.
    expect(naut(150, 900)).toMatchObject({ patchesUsed: [CUR, PREV], games: 1050 });
    expect(fallback(naut(150, 900))).toBe(true);
    // 2,000 current games: 900 / 2,900 = 31 %, listed but no reason.
    expect(naut(2000, 900)).toMatchObject({ patchesUsed: [CUR, PREV], games: 2900 });
    expect(fallback(naut(2000, 900))).toBe(false);
    // 60,000 current games: 6,500 previous count for 5,000, 7.7 %: not listed, so its games
    // are not shown either.
    expect(naut(60_000, 6500)).toMatchObject({ patchesUsed: [CUR], games: 60_000 });
  });

  test('continuity: the score does not jump when current games cross 150', () => {
    // Nautilus: 900 games at 55 % on 15.21 (Lulu 2,000 at 50 %), n games at 50 % on 15.22.
    const roleAvgPrev = (495 + 1000) / 2900;
    const prevDelta = 0.55 - roleAvgPrev;
    const scoreAt = (n: number) =>
      recommendPicks(
        req({ role: 'UTILITY' }),
        data({
          roleStats: [
            role(CUR, 111, 'UTILITY', n, n / 2),
            role(PREV, 111, 'UTILITY', 900, 495),
            role(CUR, 117, 'UTILITY', 2000, 1000),
            role(PREV, 117, 'UTILITY', 2000, 1000),
          ],
        }),
      ).candidates.find((c) => c.championId === 111)?.score ?? Number.NaN;
    let previous = scoreAt(100);
    for (let n = 102; n <= 200; n += 2) {
      const score = scoreAt(n);
      expect(Math.abs(score - previous)).toBeLessThan(0.001);
      previous = score;
      // 0 points on the n current games, +3.4 on the 900 previous ones, on n + 900 games.
      const blended = (prevDelta * 900) / (n + 900);
      expect(score).toBeCloseTo(shrink(blended, n + 900, K.base), 4);
    }
    expect(scoreAt(148)).toBeCloseTo(0.02391, 4);
    expect(scoreAt(152)).toBeCloseTo(0.02384, 4);
  });

  test('previous patch only: its strength on up to 5,000 games, and says so', () => {
    const result = recommendPicks(
      req({ role: 'UTILITY' }),
      data({
        roleStats: [
          role(PREV, 111, 'UTILITY', 20_000, 11_000), // 55 %, nothing on 15.22 yet
          role(CUR, 117, 'UTILITY', 2000, 1000),
          role(PREV, 117, 'UTILITY', 20_000, 9_000),
        ],
      }),
    );
    const naut = result.candidates.find((c) => c.championId === 111);
    // Against the previous patch's role average (50 %): +5 points, the old summed record's
    // delta, now on min(20,000, 5,000) games.
    const prevDelta = 0.55 - (11_000 + 9_000) / 40_000;
    expect(ENGINE_CONFIG.previousPatchPrior.strength).toBe(5000);
    expect(naut?.score).toBeCloseTo(shrink(prevDelta, Math.min(20_000, 5000), K.base), 5);
    expect(naut?.score).toBeCloseTo((0.05 * 5000) / (5000 + K.base), 5);
    // Shown: the real games of the patches listed, not the 5,000 they count for.
    expect(naut).toMatchObject({ games: 20_000, patchesUsed: [CUR, PREV] });
    expect(naut?.winRate).toBeCloseTo(0.55, 4);
    expect(naut?.reasons[0]).toMatchObject({
      kind: 'patch_fallback',
      label: '15.21 data: no games of Nautilus support on 15.22 yet',
      games: 20_000,
      delta: 0,
    });
  });

  test('whole role without current games: no patch reason, both patches listed', () => {
    const result = recommendPicks(
      req({ role: 'UTILITY' }),
      data({
        roleStats: [
          role(PREV, 111, 'UTILITY', 900, 500),
          role(PREV, 117, 'UTILITY', 900, 400),
          role(PREV, 412, 'UTILITY', 3000, 1500),
        ],
      }),
    );
    expect(result.candidates).toHaveLength(3);
    for (const c of result.candidates) {
      expect(c.patchesUsed).toEqual([CUR, PREV]);
      expect(c.reasons.some((r) => r.kind === 'patch_fallback')).toBe(false);
    }
    expect(result.candidates.find((c) => c.championId === 412)?.games).toBe(3000);
  });

  test('a champion buffed on the new patch does not shift its matchup deltas', () => {
    // Nautilus: 50 % on 15.21, 56 % on 15.22 (3,000 games each). Vs Janna it does exactly as
    // usual on each patch: 50 % on 15.21 (1,000 games), 56 % on 15.22 (50 games); Lulu, the
    // other support, is at 50 % overall and vs Janna on both patches.
    const result = recommendPicks(
      req({ role: 'UTILITY', enemies: [40] }),
      data({
        roleStats: [
          role(CUR, 111, 'UTILITY', 3000, 1680),
          role(PREV, 111, 'UTILITY', 3000, 1500),
          role(CUR, 117, 'UTILITY', 3000, 1500),
          role(PREV, 117, 'UTILITY', 3000, 1500),
          role(CUR, 40, 'UTILITY', 2000, 1000),
          role(PREV, 40, 'UTILITY', 2000, 1000),
        ],
        vs: [
          vs(CUR, 111, 40, 'UTILITY', 50, 28),
          vs(PREV, 111, 40, 'UTILITY', 1000, 500),
          vs(CUR, 117, 40, 'UTILITY', 1000, 500),
          vs(PREV, 117, 40, 'UTILITY', 1000, 500),
        ],
      }),
    );
    const matchup = result.candidates
      .find((c) => c.championId === 111)
      ?.reasons.find((r) => r.kind === 'matchup');
    expect(matchup?.games).toBe(1050);
    expect(Math.abs(matchup?.delta ?? 1)).toBeLessThan(0.002);
    expect(matchup?.delta).toBeCloseTo(0, 6);
    // Summed first, the matchup would have been 528 / 1,050 vs 3,180 / 6,000: ≈ −2.7 points.
    expect(528 / 1050 - 3180 / 6000).toBeLessThan(-0.025);
  });

  test('without a previous patch, previous-patch rows are ignored', () => {
    const body = req({
      role: 'UTILITY',
      enemies: [40],
      allies: [{ championId: 222, role: 'BOTTOM' }],
    });
    const cur = {
      roleStats: [
        role(CUR, 111, 'UTILITY', 40, 20),
        role(CUR, 117, 'UTILITY', 2000, 1100),
        role(CUR, 40, 'UTILITY', 2000, 1000),
        role(CUR, 222, 'BOTTOM', 2000, 1000),
      ],
      vs: [vs(CUR, 111, 40, 'UTILITY', 10, 6), vs(CUR, 117, 40, 'UTILITY', 500, 260)],
      with: [withAlly(CUR, 117, 222, 'BOTTOM', 500, 270)],
    };
    const prev = {
      roleStats: [role(PREV, 111, 'UTILITY', 900, 500), role(PREV, 117, 'UTILITY', 900, 400)],
      vs: [vs(PREV, 111, 40, 'UTILITY', 90, 54)],
      with: [withAlly(PREV, 117, 222, 'BOTTOM', 300, 100)],
    };
    const withPrevRows = recommendPicks(
      body,
      data({
        previousPatch: null,
        roleStats: [...cur.roleStats, ...prev.roleStats],
        vs: [...cur.vs, ...prev.vs],
        with: [...cur.with, ...prev.with],
      }),
    );
    expect(withPrevRows).toEqual(recommendPicks(body, data({ previousPatch: null, ...cur })));
    expect(withPrevRows.candidates.find((c) => c.championId === 111)).toMatchObject({
      games: 40,
      patchesUsed: [CUR],
    });
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
          lane(PREV, 111, 40, 'UTILITY', 900, { gold: -900, xp: 0, cs: 0 }), // under the cap: counts
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
    // 200 current + 900 previous matchups: gold (440 × 200 − 900 × 900) / 1,100, then shrunk.
    const keep = 1100 / 1120;
    const gold = Math.round(((440 * 200 - 900 * 900) / 1100) * keep);
    const xp = Math.round(((330 * 200) / 1100) * keep);
    expect([gold, xp]).toEqual([-645, 59]);
    expect(naut?.reasons.find((r) => r.kind === 'lane_phase')).toEqual({
      kind: 'lane_phase',
      label:
        'Lane at 10 min vs Janna: −645 gold, +0.4 CS, +59 XP (bot lane 2v2, likely support, 1,100 matchups)',
      delta: 0,
      games: 1100,
      championIds: [40],
      lane: { minute: 10, gold, xp, cs: 0.4, duo: true, games: 1100 },
    });
    const lulu = result.candidates.find((c) => c.championId === 117);
    expect(lulu?.reasons.some((r) => r.kind === 'lane_phase')).toBe(false);
  });
});

describe('mastery', () => {
  const masteryRow = (
    patch: string,
    championId: number,
    position: Position,
    bucket: number,
    games: number,
    wins: number,
  ): MasteryRow => ({ patch, championId, position, bucket, games, wins });

  // Every support: 40 % under 5k points, 60 % from 500k (own average 50 %).
  const masteryRows = [111, 117, 412, 89].flatMap((id) => [
    masteryRow(CUR, id, 'UTILITY', 0, 100, 40),
    masteryRow(CUR, id, 'UTILITY', 6, 100, 60),
  ]);
  const draft = {
    role: 'UTILITY',
    allies: [{ championId: 222, role: 'BOTTOM' }],
    enemies: [40],
  };
  const draftData = () =>
    data({
      vs: [vs(CUR, 111, 40, 'UTILITY', 1000, 560)],
      with: [withAlly(CUR, 117, 222, 'BOTTOM', 1000, 560)],
    });
  const masteryReasons = (r: PicksResponse) =>
    r.candidates.flatMap((c) => c.reasons.filter((x) => x.kind === 'mastery'));

  test('no masteries in the request: the same answer, with or without the rows', () => {
    const without = recommendPicks(req(draft), draftData());
    const result = recommendPicks(req(draft), { ...draftData(), mastery: masteryRows });
    expect(result).toEqual(without);
    expect(masteryReasons(result)).toEqual([]);
  });

  test('masteries without the rows: no mastery reason, same scores', () => {
    const without = recommendPicks(req(draft), draftData());
    const result = recommendPicks(
      req({ ...draft, masteries: [{ championId: 117, points: 600_000 }] }),
      draftData(),
    );
    expect(result).toEqual(without);
    expect(masteryReasons(result)).toEqual([]);
  });

  test('one mastery reason per candidate, added to the score, after the lane and duo', () => {
    const without = recommendPicks(req(draft), draftData());
    const result = recommendPicks(
      req({ ...draft, masteries: [{ championId: 117, points: 600_000 }] }),
      { ...draftData(), mastery: masteryRows },
    );
    expect(result.candidates).toHaveLength(without.candidates.length);
    for (const c of result.candidates) {
      const kinds = c.reasons.map((r) => r.kind);
      expect(kinds.filter((k) => k === 'mastery')).toHaveLength(1);
      const at = kinds.indexOf('mastery');
      expect(at).toBeGreaterThan(kinds.indexOf('matchup'));
      expect(at).toBeGreaterThan(kinds.indexOf('duo'));
      expect(at).toBeLessThan(kinds.indexOf('base'));
      const before = without.candidates.find((x) => x.championId === c.championId);
      const reason = c.reasons[at];
      expect(c.score - (before?.score ?? Number.NaN)).toBeCloseTo(reason?.delta ?? Number.NaN, 3);
      expect(c.confidence).toBe(before?.confidence ?? Number.NaN);
    }
    const lulu = result.candidates.find((c) => c.championId === 117);
    expect(lulu?.reasons.find((r) => r.kind === 'mastery')?.delta).toBeCloseTo(0.1, 4);
  });

  test('a high mastery moves its champion first; champions not listed get the 0-point effect', () => {
    const body = { role: 'UTILITY', bans: [40] };
    const before = recommendPicks(req(body), data());
    expect(new Set(before.candidates.map((c) => c.score)).size).toBe(1);
    const result = recommendPicks(
      req({ ...body, masteries: [{ championId: 117, points: 600_000 }] }),
      data({ mastery: masteryRows }),
    );
    expect(result.candidates[0]?.championId).toBe(117);
    const others = result.candidates.slice(1);
    expect(others.map((c) => c.championId).sort()).toEqual([111, 412, 89].sort());
    const deltas = others.map((c) => c.reasons.find((r) => r.kind === 'mastery')?.delta);
    expect(new Set(deltas).size).toBe(1);
    expect(deltas[0]).toBeCloseTo(-0.1, 4);
    const naut = others.find((c) => c.championId === 111);
    expect(naut?.reasons.find((r) => r.kind === 'mastery')?.label).toBe(
      "−10.0% at your mastery (no points yet): Nautilus players with under 5k points vs Nautilus's average (100 games)",
    );
  });

  test('a champion listed twice uses its highest points; non-candidates are ignored', () => {
    const body = { role: 'UTILITY', bans: [40] };
    const twice = recommendPicks(
      req({
        ...body,
        masteries: [
          { championId: 117, points: 1_000 },
          { championId: 117, points: 600_000 },
          { championId: 222, points: 900_000 }, // an ADC: not a support candidate
          { championId: 9999, points: 900_000 }, // unknown champion
        ],
      }),
      data({ mastery: masteryRows }),
    );
    const once = recommendPicks(
      req({ ...body, masteries: [{ championId: 117, points: 600_000 }] }),
      data({ mastery: masteryRows }),
    );
    expect(twice).toEqual(once);
  });
});

describe('recommendPicks shown games', () => {
  // Nautilus: 100 games on 15.22 and 20,000 on 15.21 (counting for 5,000: listed), or 60,000
  // and 6,500 (7.7 % of the effective games: not listed). Lulu is the rest of the role.
  const listed = [
    role(CUR, 111, 'UTILITY', 100, 55),
    role(PREV, 111, 'UTILITY', 20_000, 11_000),
    role(CUR, 117, 'UTILITY', 2000, 1000),
    role(PREV, 117, 'UTILITY', 20_000, 10_000),
  ];
  const unlisted = [
    role(CUR, 111, 'UTILITY', 60_000, 31_200),
    role(PREV, 111, 'UTILITY', 6500, 3250),
    role(CUR, 117, 'UTILITY', 60_000, 28_800),
    role(PREV, 117, 'UTILITY', 6500, 3250),
  ];
  const naut = (roleStats: PicksData['roleStats']) =>
    recommendPicks(req({ role: 'UTILITY' }), data({ roleStats })).candidates.find(
      (c) => c.championId === 111,
    );

  test('the real games of the patches listed; score and confidence on the effective games', () => {
    const one = naut(listed);
    expect(one).toMatchObject({ patchesUsed: [CUR, PREV], games: 20_100 });
    expect(one?.score).toBeCloseTo(0.02425, 5);
    expect(one?.confidence).toBe(0.962);
    expect(one?.reasons[0]).toMatchObject({ kind: 'patch_fallback', games: 20_100 });
    expect(one?.reasons[1]).toMatchObject({
      kind: 'base',
      label: '55.0% win rate as support (20,100 games)',
      delta: 0.0243,
      games: 20_100,
    });
    const two = naut(unlisted);
    expect(two).toMatchObject({ patchesUsed: [CUR], games: 60_000 });
    expect(two?.score).toBeCloseTo(0.01839, 5);
    expect(two?.confidence).toBe(0.997);
    expect(two?.reasons[0]).toMatchObject({
      kind: 'base',
      label: '51.8% win rate as support (60,000 games)',
      delta: 0.0184,
      games: 60_000,
    });
  });
});
