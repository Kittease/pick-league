import { describe, expect, test } from 'bun:test';
import { draftRequestSchema, type Position } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import { type DraftData, draftPairs, draftRoles, evaluateDraft } from './draft.ts';
import { names, role, traitsOf, vs, withAlly } from './fixtures.ts';
import { championGameLength, indexGameLength } from './game-length.ts';
import { formatDelta, formatGames, formatRate } from './math.ts';
import type { GameLengthRow } from './types.ts';

const CUR = '15.22';
const D = ENGINE_CONFIG.draft;
const K = ENGINE_CONFIG.picks.shrinkK;

/** Supports and ADCs at 50 %, except Thresh (55 % over 2,000 games). */
function data(overrides: Partial<DraftData> = {}): DraftData {
  return {
    currentPatch: CUR,
    previousPatch: null,
    roleStats: [
      role(CUR, 412, 'UTILITY', 2000, 1100), // Thresh
      role(CUR, 111, 'UTILITY', 2000, 1000), // Nautilus
      role(CUR, 117, 'UTILITY', 2000, 1000), // Lulu
      role(CUR, 89, 'UTILITY', 2000, 900), // Leona
      role(CUR, 222, 'BOTTOM', 2000, 1000), // Jinx
      role(CUR, 51, 'BOTTOM', 2000, 1000), // Caitlyn
    ],
    vs: [],
    with: [],
    championTraits: [],
    sides: [
      { patch: CUR, platform: 'EUW1', side: 'blue', games: 1000, wins: 480 },
      { patch: CUR, platform: 'EUW1', side: 'red', games: 1000, wins: 520 },
    ],
    names,
    ...overrides,
  };
}

const req = (body: unknown) => draftRequestSchema.parse(body);
/** Role average of the fixture's supports: (1,100 + 1,000 + 1,000 + 900) / 8,000. */
const SUPPORT_AVG = 4000 / 8000;

describe('evaluateDraft', () => {
  test('an empty draft is a coin flip, apart from the side', () => {
    expect(evaluateDraft(req({}), data()).winProbability).toBe(0.5);
    const red = evaluateDraft(req({ side: 'red' }), data());
    expect(red.winProbability).toBeCloseTo(0.52, 4);
    expect(red.reasons).toEqual([
      expect.objectContaining({ kind: 'side', delta: 0.02, games: 1000 }),
    ]);
    expect(red.reasons[0]?.label).toBe(
      '+2.0% Red side: wins 52.0% of matches on 15.22 (1,000 games)',
    );
  });

  test("each champion's strength counts for its team, against the other team's", () => {
    const strength = (wins: number) => ((wins / 2000 - SUPPORT_AVG) * 2000) / (2000 + K.base);
    const thresh = evaluateDraft(req({ allies: [{ championId: 412, role: 'UTILITY' }] }), data());
    expect(thresh.winProbability).toBeCloseTo(0.5 + D.baseWeight * strength(1100), 4);
    expect(thresh.reasons[0]).toMatchObject({ kind: 'base', championIds: [412] });
    expect(thresh.reasons[0]?.label).toMatch(/^\+\d\.\d% Thresh: 55\.0% win rate as support/);

    const both = evaluateDraft(
      req({
        allies: [{ championId: 412, role: 'UTILITY' }],
        enemies: [{ championId: 89, role: 'UTILITY' }],
      }),
      data(),
    );
    expect(both.winProbability).toBeCloseTo(
      0.5 + D.baseWeight * (strength(1100) - strength(900)),
      4,
    );
    expect(both.reasons.find((r) => r.championIds?.[0] === 89)?.label).toMatch(
      /^\+\d\.\d% enemy Leona: 45\.0% win rate as support/,
    );
  });

  test('a lane matchup counts once, from both points of view, beyond what the role usually gets', () => {
    // Nautilus vs Lulu: +5 % for Nautilus (and −5 % for Lulu); every support does as usual
    // otherwise.
    const rows = [
      vs(CUR, 111, 117, 'UTILITY', 1000, 550),
      vs(CUR, 117, 111, 'UTILITY', 1000, 450),
      vs(CUR, 412, 117, 'UTILITY', 1000, 550),
      vs(CUR, 412, 111, 'UTILITY', 1000, 550),
      vs(CUR, 89, 117, 'UTILITY', 1000, 450),
      vs(CUR, 89, 111, 'UTILITY', 1000, 450),
    ];
    const r = evaluateDraft(
      req({
        allies: [{ championId: 111, role: 'UTILITY' }],
        enemies: [{ championId: 117, role: 'UTILITY' }],
      }),
      data({ vs: rows }),
    );
    // Usual vs Lulu: (5 + 0 + 0) / 3 points over Nautilus, Thresh, Leona → Nautilus +3.33 beyond.
    const mine = ((0.05 - 0.05 / 3) * 1000) / (1000 + K.matchup);
    const theirs = ((-0.05 - -0.05 / 3) * 1000) / (1000 + K.matchup);
    const expected = D.pairWeight * ((mine - theirs) / 2);
    const matchup = r.reasons.find((x) => x.kind === 'matchup');
    expect(matchup?.delta).toBeCloseTo(expected, 4);
    expect(matchup?.championIds).toEqual([111, 117]);
    expect(matchup?.label).toMatch(/^\+\d\.\d% Nautilus vs Lulu \(lane, 1,000 games\)$/);
    expect(r.winProbability).toBeCloseTo(0.5 + expected, 4);
  });

  test("teammates' synergy helps, the enemy's hurts", () => {
    // Lulu + Jinx: 56 %; the other supports with Jinx and the other ADC with Lulu do as usual.
    const rows = [
      withAlly(CUR, 117, 222, 'BOTTOM', 1000, 560),
      withAlly(CUR, 111, 222, 'BOTTOM', 1000, 500),
      withAlly(CUR, 222, 117, 'UTILITY', 1000, 560, 'BOTTOM'),
      withAlly(CUR, 51, 117, 'UTILITY', 1000, 500, 'BOTTOM'),
    ];
    const ally = evaluateDraft(
      req({
        allies: [
          { championId: 117, role: 'UTILITY' },
          { championId: 222, role: 'BOTTOM' },
        ],
      }),
      data({ with: rows }),
    );
    const duo = ally.reasons.find((x) => x.kind === 'duo');
    expect(duo?.delta).toBeGreaterThan(0);
    expect(duo?.label).toMatch(/^\+\d\.\d% Lulu \+ Jinx \(duo, 1,000 games\)$/);
    const enemy = evaluateDraft(
      req({
        enemies: [
          { championId: 117, role: 'UTILITY' },
          { championId: 222, role: 'BOTTOM' },
        ],
      }),
      data({ with: rows }),
    );
    expect(enemy.reasons.find((x) => x.kind === 'duo')?.delta).toBeCloseTo(-(duo?.delta ?? 0), 6);
  });

  test('unknown roles are guessed and the needed pairs listed for both points of view', () => {
    const r = req({
      allies: [{ championId: 412, role: null }],
      enemies: [{ championId: 222, role: null }],
    });
    const roles = draftRoles(r, data().roleStats);
    expect(roles.allies[0]).toMatchObject({ role: 'UTILITY', known: false });
    expect(draftPairs(roles).vs).toEqual([
      { position: 'UTILITY', otherId: 222, otherPosition: 'BOTTOM' },
      { position: 'BOTTOM', otherId: 412, otherPosition: 'UTILITY' },
    ]);
  });

  test('the probability stays within bounds', () => {
    const r = evaluateDraft(
      req({
        allies: [{ championId: 412, role: 'UTILITY' }],
        enemies: [{ championId: 89, role: 'UTILITY' }],
      }),
      data({
        roleStats: [
          role(CUR, 412, 'UTILITY', 100_000, 100_000),
          role(CUR, 89, 'UTILITY', 100_000, 0),
        ],
      }),
    );
    expect(r.winProbability).toBe(D.maxProbability);
  });

  test('damage per minute by type, summed per team', () => {
    const r = evaluateDraft(
      req({
        allies: [
          { championId: 412, role: 'UTILITY' },
          { championId: 222, role: 'BOTTOM' },
        ],
      }),
      data({
        championTraits: [
          traitsOf(CUR, 412, {
            damagePerMin: 300,
            physicalShare: 0.2,
            magicShare: 0.7,
            trueShare: 0.1,
          }),
          traitsOf(CUR, 222, {
            damagePerMin: 900,
            physicalShare: 0.9,
            magicShare: 0.05,
            trueShare: 0.05,
          }),
        ],
      }),
    );
    expect(r.damage.allies).toEqual({
      physical: 870,
      magic: 255,
      true: 75,
      champions: [
        { championId: 412, physical: 60, magic: 210, true: 30 },
        { championId: 222, physical: 810, magic: 45, true: 45 },
      ],
    });
    expect(r.damage.enemies).toEqual({ physical: 0, magic: 0, true: 0, champions: [] });
  });

  describe('game length profile', () => {
    const gl = (
      championId: number,
      position: Position,
      split: [number, number][],
    ): GameLengthRow[] =>
      split.map(([games, wins], bucket) => ({
        patch: CUR,
        position,
        championId,
        bucket: bucket as 0 | 1 | 2,
        games,
        wins,
      }));
    const rows = [
      ...gl(412, 'UTILITY', [
        [200, 120],
        [300, 150],
        [100, 40],
      ]), // Thresh: strong early
      ...gl(89, 'UTILITY', [
        [300, 130],
        [400, 200],
        [300, 170],
      ]), // Leona: strong late
      ...gl(111, 'UTILITY', [
        [800, 380],
        [1200, 600],
        [400, 210],
      ]), // Nautilus
      ...gl(222, 'BOTTOM', [
        [300, 140],
        [400, 200],
        [300, 165],
      ]), // Jinx: scales
      ...gl(51, 'BOTTOM', [
        [700, 360],
        [900, 450],
        [500, 240],
      ]), // Caitlyn
    ];
    const draftReq = req({
      allies: [
        { championId: 412, role: 'UTILITY' },
        { championId: 222, role: 'BOTTOM' },
      ],
      enemies: [{ championId: 89, role: null }], // guessed support
    });

    test("each team's sum of its champions' profiles, without changing the probability", () => {
      const index = indexGameLength(rows);
      const thresh = championGameLength(index, 'UTILITY', 412);
      const jinx = championGameLength(index, 'BOTTOM', 222);
      const leona = championGameLength(index, 'UTILITY', 89);
      expect(thresh && jinx && leona).toBeTruthy();
      const withRows = evaluateDraft(draftReq, data({ gameLength: rows }));
      const without = evaluateDraft(draftReq, data());
      expect(withRows.gameLength?.allies.champions).toBe(2);
      expect(withRows.gameLength?.allies.early).toBeCloseTo(
        (thresh?.early ?? 0) + (jinx?.early ?? 0),
        4,
      );
      expect(withRows.gameLength?.allies.late).toBeCloseTo(
        (thresh?.late ?? 0) + (jinx?.late ?? 0),
        4,
      );
      expect(withRows.gameLength?.enemies).toEqual({
        early: leona?.early ?? 0,
        late: leona?.late ?? 0,
        champions: 1,
      });
      expect(withRows.winProbability).toBe(without.winProbability);
      expect(withRows.reasons).toEqual(without.reasons);
    });

    test('without game-length rows: no gameLength property', () => {
      expect(evaluateDraft(draftReq, data())).not.toHaveProperty('gameLength');
    });
  });
});

describe('evaluateDraft with a previous patch', () => {
  const PREV = '15.21';
  const CAP = ENGINE_CONFIG.previousPatchPrior.strength;

  test("a champion's strength blends its patches, the previous one capped", () => {
    // Thresh: 100 games at 55 % on 15.22, 5,000 at 55 % on 15.21 (counting for 1,200).
    const roleStats = [
      role(CUR, 412, 'UTILITY', 100, 55),
      role(PREV, 412, 'UTILITY', 5000, 2750),
      role(CUR, 111, 'UTILITY', 2000, 1000),
      role(PREV, 111, 'UTILITY', 5000, 2500),
      role(CUR, 89, 'UTILITY', 2000, 900),
    ];
    const r = evaluateDraft(
      req({ allies: [{ championId: 412, role: 'UTILITY' }] }),
      data({ previousPatch: PREV, roleStats }),
    );
    const roleCur = (55 + 1000 + 900) / 4100;
    const rolePrev = (2750 + 2500) / 10_000;
    const games = 100 + CAP;
    const delta = (100 * (0.55 - roleCur) + CAP * (0.55 - rolePrev)) / games;
    const strength = (delta * games) / (games + K.base);
    expect(r.winProbability).toBeCloseTo(0.5 + D.baseWeight * strength, 4);
    // Shown: the real games of both patches, not the 1,300 they count for.
    expect(r.reasons[0]).toMatchObject({ kind: 'base', games: 5100, championIds: [412] });
    expect(r.reasons[0]?.label).toMatch(/Thresh: 55\.0% win rate as support \(5,100 games\)$/);
    expect(r.patchesUsed).toEqual([CUR, PREV]);
  });

  test('a champion buffed on the new patch does not shift its matchup', () => {
    // Nautilus: 50 % on 15.21, 56 % on 15.22. Vs Lulu it does as usual on each patch (as Thresh
    // does), and Lulu does vs Nautilus what supports usually do vs him on each patch.
    const roleStats = [
      role(CUR, 111, 'UTILITY', 3000, 1680),
      role(PREV, 111, 'UTILITY', 3000, 1500),
      role(CUR, 117, 'UTILITY', 3000, 1500),
      role(PREV, 117, 'UTILITY', 3000, 1500),
      role(CUR, 412, 'UTILITY', 3000, 1500),
      role(PREV, 412, 'UTILITY', 3000, 1500),
    ];
    const rows = [
      vs(CUR, 111, 117, 'UTILITY', 50, 28),
      vs(PREV, 111, 117, 'UTILITY', 1000, 500),
      vs(CUR, 117, 111, 'UTILITY', 50, 22),
      vs(PREV, 117, 111, 'UTILITY', 1000, 500),
      vs(CUR, 412, 117, 'UTILITY', 1000, 500),
      vs(PREV, 412, 117, 'UTILITY', 1000, 500),
      vs(CUR, 412, 111, 'UTILITY', 1000, 440),
      vs(PREV, 412, 111, 'UTILITY', 1000, 500),
    ];
    const body = req({
      allies: [{ championId: 111, role: 'UTILITY' }],
      enemies: [{ championId: 117, role: 'UTILITY' }],
    });
    const r = evaluateDraft(body, data({ previousPatch: PREV, roleStats, vs: rows }));
    const only = evaluateDraft(body, data({ previousPatch: PREV, roleStats, vs: [] }));
    // The pair adds nothing beyond Nautilus' own strength (the reason may be under the display
    // floor, so compare the probabilities).
    expect(Math.abs(r.winProbability - only.winProbability)).toBeLessThan(0.002);
    expect(r.winProbability).toBeCloseTo(only.winProbability, 6);
    // The pair is read from both patches: a real edge on 15.21 shows, on 1,050 games.
    const edge = evaluateDraft(
      body,
      data({
        previousPatch: PREV,
        roleStats,
        vs: rows.map((x) =>
          x.patch === PREV && x.championId === 111 && x.enemyId === 117 ? { ...x, wins: 550 } : x,
        ),
      }),
    );
    expect(edge.reasons.find((x) => x.kind === 'matchup')).toMatchObject({ games: 1050 });
    expect(edge.winProbability).toBeGreaterThan(only.winProbability + 0.005);
    // Summed first, Nautilus vs Lulu would read 528 / 1,050 vs 3,180 / 6,000: ≈ −2.7 points.
    expect(528 / 1050 - 3180 / 6000).toBeLessThan(-0.025);
  });

  test('patchesUsed lists the previous patch only when a drafted champion leans on it', () => {
    const roleStats = [
      role(CUR, 111, 'UTILITY', 20_000, 10_000),
      role(PREV, 111, 'UTILITY', 1300, 650),
      role(CUR, 117, 'UTILITY', 100, 50),
      role(PREV, 117, 'UTILITY', 900, 450),
    ];
    const ally = { championId: 111, role: 'UTILITY' };
    expect(
      evaluateDraft(req({ allies: [ally] }), data({ previousPatch: PREV, roleStats })).patchesUsed,
    ).toEqual([CUR]);
    expect(
      evaluateDraft(
        req({ allies: [ally], enemies: [{ championId: 117, role: 'UTILITY' }] }),
        data({ previousPatch: PREV, roleStats }),
      ).patchesUsed,
    ).toEqual([CUR, PREV]);
  });

  test('the side edge is the current patch with the previous one as a capped prior', () => {
    const cap = ENGINE_CONFIG.previousPatchPrior.side;
    const previousGames = 4 * cap;
    const r = evaluateDraft(
      req({ side: 'blue' }),
      data({
        previousPatch: PREV,
        sides: [
          { patch: CUR, platform: 'KR', side: 'blue', games: 1000, wins: 440 },
          { patch: CUR, platform: 'EUW1', side: 'blue', games: 1000, wins: 460 },
          {
            patch: PREV,
            platform: 'KR',
            side: 'blue',
            games: previousGames,
            wins: previousGames / 2,
          },
          { patch: CUR, platform: 'KR', side: 'red', games: 1000, wins: 560 },
        ],
      }),
    );
    // Current: 900 / 2,000 (45 %); the previous patch's 50 % counts for `cap` games.
    const expected = (900 + 0.5 * cap) / (2000 + cap);
    expect(r.winProbability).toBeCloseTo(expected, 4);
    expect(r.reasons[0]).toMatchObject({ kind: 'side', games: 2000 + previousGames });
    expect(r.reasons[0]?.label).toBe(
      `${formatDelta(expected - 0.5)} Blue side: wins ${formatRate(expected)} of matches on 15.22 + 15.21 (${formatGames(2000 + previousGames)})`,
    );
    // Summed unweighted, the previous patch would hide the current one's edge.
    expect(expected).toBeLessThan((900 + previousGames / 2) / (2000 + previousGames) - 0.002);
  });

  test('a previous patch that weighs little is not named', () => {
    const r = evaluateDraft(
      req({ side: 'red' }),
      data({
        previousPatch: PREV,
        sides: [
          { patch: CUR, platform: 'NA1', side: 'red', games: 500_000, wins: 255_000 },
          { patch: PREV, platform: 'NA1', side: 'red', games: 500_000, wins: 250_000 },
        ],
      }),
    );
    expect(r.reasons[0]).toMatchObject({ kind: 'side', games: 500_000 });
    expect(r.reasons[0]?.label).toMatch(/ of matches on 15\.22 \(500,000 games\)$/);
  });

  test("with a platform, the side edge is that platform's, else every platform's", () => {
    const cap = ENGINE_CONFIG.previousPatchPrior.sidePlatform;
    const sides: DraftData['sides'] = [
      { patch: CUR, platform: 'EUW1', side: 'blue', games: 2000, wins: 940 },
      { patch: CUR, platform: 'VN2', side: 'blue', games: 2000, wins: 1020 },
      { patch: PREV, platform: 'EUW1', side: 'blue', games: 2 * cap, wins: 0.46 * 2 * cap },
    ];
    const at = (platform: string | null) =>
      evaluateDraft(req({ side: 'blue', platform }), data({ previousPatch: PREV, sides }));

    const euw = at('EUW1');
    expect(euw.winProbability).toBeCloseTo((940 + 0.46 * cap) / (2000 + cap), 4);
    expect(euw.reasons[0]?.label).toMatch(/ of EUW1 matches on 15\.22 \+ 15\.21 /);

    // VN2: no previous-patch row, its own current patch only.
    expect(at('VN2').winProbability).toBeCloseTo(0.51, 4);
    expect(at('VN2').reasons[0]?.label).toMatch(/ of VN2 matches on 15\.22 \(2,000 games\)$/);

    // Every platform: both platforms' current games, the previous patch capped at `side`.
    const weight = Math.min(1, ENGINE_CONFIG.previousPatchPrior.side / (2 * cap));
    const all = (1960 + 0.46 * 2 * cap * weight) / (4000 + 2 * cap * weight);
    expect(at(null).winProbability).toBeCloseTo(all, 4);
    expect(at(null).reasons[0]?.label).toMatch(/ of matches on /);

    // A platform without any result falls back to every platform.
    expect(at('KR').winProbability).toBeCloseTo(all, 4);
    expect(at('KR').reasons[0]?.label).toMatch(/ of matches on /);
  });

  test('the platform is optional and must be a known one', () => {
    expect(draftRequestSchema.parse({ side: 'blue' }).platform).toBeUndefined();
    expect(draftRequestSchema.safeParse({ side: 'blue', platform: 'OC1' }).success).toBe(false);
  });
});

describe('evaluateDraft shown games', () => {
  const PREV = '15.21';
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
  const evaluate = (roleStats: DraftData['roleStats']) =>
    evaluateDraft(
      req({ allies: [{ championId: 111, role: 'UTILITY' }] }),
      data({ previousPatch: PREV, roleStats, sides: [] }),
    );

  test('base reasons show the real games of the patches listed, the strength unchanged', () => {
    const one = evaluate(listed);
    expect(one.winProbability).toBeCloseTo(0.5224, 4);
    expect(one.reasons).toEqual([
      {
        kind: 'base',
        label: '+2.2% Nautilus: 55.0% win rate as support (5,100 games)',
        delta: 0.0224,
        games: 5100,
        championIds: [111],
      },
    ]);
    const two = evaluate(unlisted);
    expect(two.winProbability).toBeCloseTo(0.5186, 4);
    expect(two.reasons).toEqual([
      {
        kind: 'base',
        label: '+1.9% Nautilus: 51.9% win rate as support (20,000 games)',
        delta: 0.0186,
        games: 20_000,
        championIds: [111],
      },
    ]);
  });
});
