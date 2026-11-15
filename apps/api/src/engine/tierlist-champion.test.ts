import { describe, expect, test } from 'bun:test';
import { ENGINE_CONFIG } from './config.ts';
import { lane, role, vs, withAlly } from './fixtures.ts';
import { buildTierListChampion, type TierListChampionData } from './tierlist-champion.ts';

const CUR = '15.22';
const PREV = '15.21';
const K = ENGINE_CONFIG.tierList.shrinkK;

function data(overrides: Partial<TierListChampionData> = {}): TierListChampionData {
  return {
    currentPatch: CUR,
    previousPatch: PREV,
    roleStats: [
      role(CUR, 111, 'UTILITY', 2000, 1000), // Nautilus 50 %: enough games on current alone
      role(PREV, 111, 'UTILITY', 600, 300),
      role(CUR, 40, 'UTILITY', 50, 25), // Janna: few games on current…
      role(PREV, 40, 'UTILITY', 450, 225), // …so both patches combined (250 / 500)
      role(CUR, 64, 'JUNGLE', 1000, 500), // Lee Sin
    ],
    vs: [],
    with: [],
    ...overrides,
  };
}

const ids = (rows: { championId: number }[]) => rows.map((r) => r.championId);

describe('buildTierListChampion', () => {
  test('every lane matchup with enough games, best first, shrunk', () => {
    const d = buildTierListChampion(
      'UTILITY',
      111,
      data({
        vs: [
          vs(CUR, 111, 40, 'UTILITY', 400, 280), // 70 %
          vs(CUR, 111, 412, 'UTILITY', 400, 160), // 40 %
          vs(CUR, 111, 222, 'BOTTOM', 400, 240), // 60 %: the enemy ADC is a bot lane matchup
          vs(CUR, 111, 51, 'BOTTOM', 300, 135), // 45 %
          vs(CUR, 111, 89, 'UTILITY', 200, 110), // 55 %
          vs(CUR, 111, 16, 'UTILITY', 100, 48), // 48 %
          vs(CUR, 111, 117, 'UTILITY', 4, 4), // under the floor
          vs(CUR, 111, 64, 'JUNGLE', 400, 400), // not a lane opponent
          vs(CUR, 40, 412, 'UTILITY', 400, 400), // another champion
          vs(PREV, 111, 267, 'UTILITY', 400, 400), // patch not used
        ],
      }),
    );
    expect(d).toMatchObject({
      role: 'UTILITY',
      patch: CUR,
      championId: 111,
      patchesUsed: [CUR],
      games: 2000,
      winRate: 0.5,
    });
    // Not capped: every opponent over the floor, worst ones at the end.
    expect(ids(d.matchups)).toEqual([40, 222, 89, 16, 51, 412]);
    expect(d.matchups[1]?.role).toBe('BOTTOM');
    // +20 points raw, shrunk with k = 120 → 20 × 400 / 520.
    expect(d.matchups[0]).toEqual({
      championId: 40,
      role: 'UTILITY',
      delta: expect.closeTo((0.2 * 400) / (400 + K.matchup), 4),
      winRate: 0.7,
      games: 400,
    });
    expect(d.matchups.at(-1)?.delta).toBeCloseTo((-0.1 * 400) / (400 + K.matchup), 4);
  });

  test('a tiny perfect record ranks below a solid delta on a big sample', () => {
    const d = buildTierListChampion(
      'UTILITY',
      111,
      data({
        vs: [
          vs(CUR, 111, 40, 'UTILITY', 5, 5), // 100 % over 5 games → at most +2 points
          vs(CUR, 111, 412, 'UTILITY', 100, 56), // +6 points over 100 games
        ],
      }),
    );
    expect(ids(d.matchups)).toEqual([412, 40]);
    expect(d.matchups[1]?.delta).toBeLessThan(0.021);
  });

  test('support: bot laner allies are duos, the others are synergies', () => {
    const d = buildTierListChampion(
      'UTILITY',
      111,
      data({
        with: [
          withAlly(CUR, 111, 222, 'BOTTOM', 400, 260), // 65 %
          withAlly(CUR, 111, 51, 'BOTTOM', 400, 180), // 45 %
          withAlly(CUR, 111, 64, 'JUNGLE', 300, 180), // 60 %
          withAlly(CUR, 111, 103, 'MIDDLE', 300, 140),
          withAlly(CUR, 111, 122, 'TOP', 200, 110),
          withAlly(CUR, 111, 19, 'JUNGLE', 3, 3), // under the floor
        ],
      }),
    );
    expect(ids(d.duos)).toEqual([222, 51]);
    expect(d.duos.every((r) => r.role === 'BOTTOM')).toBe(true);
    expect(ids(d.synergies)).toEqual([64, 122, 103]);
    expect(d.synergies.map((r) => r.role)).toEqual(['JUNGLE', 'TOP', 'MIDDLE']);
    // Synergies use the pairwise prior strength.
    expect(d.synergies[0]?.delta).toBeCloseTo((0.1 * 300) / (300 + K.synergy), 4);
  });

  test('jungle: mid and top allies are duos, bot lane allies are synergies', () => {
    const d = buildTierListChampion(
      'JUNGLE',
      64,
      data({
        vs: [
          vs(CUR, 64, 19, 'JUNGLE', 50, 30, 'JUNGLE'),
          vs(CUR, 64, 103, 'MIDDLE', 50, 40, 'JUNGLE'), // not the jungle's lane opponent
        ],
        with: [
          withAlly(CUR, 64, 103, 'MIDDLE', 50, 30, 'JUNGLE'),
          withAlly(CUR, 64, 122, 'TOP', 50, 20, 'JUNGLE'),
          withAlly(CUR, 64, 111, 'UTILITY', 50, 30, 'JUNGLE'),
          withAlly(CUR, 64, 222, 'BOTTOM', 50, 25, 'JUNGLE'),
        ],
      }),
    );
    expect(ids(d.matchups)).toEqual([19]);
    expect(ids(d.duos)).toEqual([103, 122]);
    expect(ids(d.synergies)).toEqual([111, 222]);
  });

  test('a champion with few games on the current patch sums both patches, like its entry', () => {
    const d = buildTierListChampion(
      'UTILITY',
      40,
      data({
        vs: [vs(CUR, 40, 412, 'UTILITY', 3, 3), vs(PREV, 40, 412, 'UTILITY', 97, 77)],
        with: [withAlly(CUR, 40, 222, 'BOTTOM', 2, 2), withAlly(PREV, 40, 222, 'BOTTOM', 8, 4)],
      }),
    );
    expect(d.patchesUsed).toEqual([CUR, PREV]);
    expect(d.games).toBe(500);
    // Rows of both patches are summed: 3 + 97 games, 2 + 8 games.
    expect(d.matchups).toEqual([expect.objectContaining({ championId: 412, games: 100 })]);
    expect(d.matchups[0]?.winRate).toBe(0.8);
    expect(d.duos).toEqual([expect.objectContaining({ championId: 222, games: 10, winRate: 0.6 })]);
  });

  test('no relations: empty lists', () => {
    const d = buildTierListChampion('UTILITY', 111, data());
    expect(d.matchups).toEqual([]);
    expect(d.duos).toEqual([]);
    expect(d.synergies).toEqual([]);
  });

  test('matchups carry the lane phase at 10 min on the patches used, when the sample allows', () => {
    const keep = (n: number) => n / (n + ENGINE_CONFIG.lanePhase.shrinkK);
    const d = buildTierListChampion(
      'UTILITY',
      40, // Janna: both patches combined
      data({
        vs: [
          vs(CUR, 40, 111, 'UTILITY', 30, 12, 'UTILITY'),
          vs(PREV, 40, 111, 'UTILITY', 70, 28, 'UTILITY'),
          vs(CUR, 40, 222, 'BOTTOM', 50, 25, 'UTILITY'),
          vs(CUR, 40, 412, 'UTILITY', 50, 25, 'UTILITY'),
        ],
        lanePhase: [
          lane(CUR, 40, 111, 'UTILITY', 30, { gold: -500, xp: -200, cs: -4 }),
          lane(PREV, 40, 111, 'UTILITY', 70, { gold: -300, xp: -100, cs: -2 }),
          lane(CUR, 40, 222, 'UTILITY', 50, { gold: 900, xp: 0, cs: 0 }), // Jinx as support: not this row
          lane(CUR, 40, 412, 'UTILITY', 10, { gold: 900, xp: 0, cs: 0 }), // too few
        ],
      }),
    );
    const byId = new Map(d.matchups.map((m) => [m.championId, m]));
    // (−500 × 30 − 300 × 70) / 100 = −360.
    expect(byId.get(111)?.lane).toEqual({
      minute: 10,
      gold: Math.round(-360 * keep(100)),
      xp: Math.round(-130 * keep(100)),
      cs: Math.round(-2.6 * keep(100) * 10) / 10,
      duo: true,
      games: 100,
    });
    expect(byId.get(222)).not.toHaveProperty('lane');
    expect(byId.get(412)).not.toHaveProperty('lane');
    expect(d.duos.every((r) => r.lane === undefined)).toBe(true);
  });
});
