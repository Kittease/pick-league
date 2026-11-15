import { describe, expect, test } from 'bun:test';
import { draftRequestSchema } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import { type DraftData, draftPairs, draftRoles, evaluateDraft } from './draft.ts';
import { names, role, traitsOf, vs, withAlly } from './fixtures.ts';

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
      { patch: CUR, side: 'blue', games: 1000, wins: 480 },
      { patch: CUR, side: 'red', games: 1000, wins: 520 },
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
});
