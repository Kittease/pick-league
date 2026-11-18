import { describe, expect, test } from 'bun:test';
import { ENGINE_CONFIG } from './config.ts';
import { lane } from './fixtures.ts';
import { lanePhaseDiff, lanePhaseReason } from './lane-phase.ts';

const CUR = '15.22';
const PREV = '15.21';
const K = ENGINE_CONFIG.lanePhase.shrinkK;
const CAP = ENGINE_CONFIG.previousPatchPrior.pair;
const BOTH = { current: CUR, previous: PREV };
const CUR_ONLY = { current: CUR, previous: null };

describe('lanePhaseDiff', () => {
  const rows = [
    lane(CUR, 117, 89, 'UTILITY', 60, { gold: -400, xp: -300, cs: -6 }),
    lane(PREV, 117, 89, 'UTILITY', 40, { gold: -200, xp: -100, cs: -2 }),
  ];

  test('a previous row under the cap is summed with the current one, then shrunk toward 0', () => {
    // 100 matchups: gold (−400 × 60 − 200 × 40) / 100 = −320, kept × 100 / (100 + k).
    const keep = 100 / (100 + K);
    expect(lanePhaseDiff(rows, BOTH, 10)).toEqual({
      minute: 10,
      gold: Math.round(-320 * keep),
      xp: Math.round(-220 * keep),
      cs: Math.round(-4.4 * keep * 10) / 10,
      duo: true,
      games: 100,
    });
  });

  test('without a previous patch its rows are ignored, and rows of other patches always', () => {
    expect(lanePhaseDiff(rows, CUR_ONLY, 10)?.gold).toBe(Math.round((-400 * 60) / (60 + K)));
    expect(lanePhaseDiff(rows, { current: '15.20', previous: null }, 10)).toBeNull();
    expect(lanePhaseDiff(rows, { current: '15.20', previous: '15.19' }, 10)).toBeNull();
  });

  test('a previous row over the cap counts for the cap', () => {
    const big = [
      lane(CUR, 117, 89, 'UTILITY', 300, { gold: -400, xp: -300, cs: -6 }),
      lane(PREV, 117, 89, 'UTILITY', 5000, { gold: 200, xp: 100, cs: 2 }),
    ];
    // 300 + 1,200 effective matchups: gold (−400 × 300 + 200 × 1,200) / 1,500 = +80.
    const n = 300 + CAP;
    const keep = n / (n + K);
    expect(lanePhaseDiff(big, BOTH, 10)).toEqual({
      minute: 10,
      gold: Math.round(((-400 * 300 + 200 * CAP) / n) * keep),
      xp: Math.round(((-300 * 300 + 100 * CAP) / n) * keep),
      cs: Math.round(((-6 * 300 + 2 * CAP) / n) * keep * 10) / 10,
      duo: true,
      games: 1500,
    });
    expect(lanePhaseDiff(big, BOTH, 10)?.gold).toBe(Math.round(80 * (1500 / (1500 + K))));
  });

  test('null under the minimum sample; 15 min uses its own count', () => {
    const min = ENGINE_CONFIG.lanePhase.minGames;
    const few = [lane(CUR, 117, 89, 'UTILITY', min - 1, { gold: -900, xp: 0, cs: 0 })];
    expect(lanePhaseDiff(few, CUR_ONLY, 10)).toBeNull();
    const enough = [lane(CUR, 117, 89, 'UTILITY', min, { gold: -900, xp: 0, cs: 0 })];
    expect(lanePhaseDiff(enough, CUR_ONLY, 10)?.games).toBe(min);
    // No 15-minute frames at all, then too few of them.
    expect(lanePhaseDiff(rows, BOTH, 15)).toBeNull();
    const at15 = [
      lane(
        CUR,
        117,
        89,
        'UTILITY',
        80,
        { gold: 0, xp: 0, cs: 0 },
        { games: 30, gold: 600, xp: 0, cs: 0 },
      ),
      lane(PREV, 117, 89, 'UTILITY', 10, { gold: 0, xp: 0, cs: 0 }),
    ];
    expect(lanePhaseDiff(at15, BOTH, 15)).toMatchObject({
      minute: 15,
      games: 30,
      gold: Math.round((600 * 30) / (30 + K)),
      xp: 0,
      cs: 0,
    });
  });

  test('1v1 outside the bot lane', () => {
    const top = [lane(CUR, 122, 54, 'TOP', 50, { gold: 300, xp: 200, cs: 5 }, null, 'TOP')];
    expect(lanePhaseDiff(top, CUR_ONLY, 10)?.duo).toBe(false);
  });
});

describe('lanePhaseReason', () => {
  test('explains without scoring, with the numbers for the UI', () => {
    const diff = { minute: 10, gold: -420, xp: -310, cs: -8, duo: true, games: 312 } as const;
    expect(lanePhaseReason(diff, 'UTILITY', 89, 'Leona')).toEqual({
      kind: 'lane_phase',
      label: 'Lane at 10 min vs Leona: −420 gold, −8 CS, −310 XP (bot lane 2v2, 312 matchups)',
      delta: 0,
      games: 312,
      championIds: [89],
      lane: diff,
    });
  });

  test('signs, thousands, CS decimals and a guessed role', () => {
    const r = lanePhaseReason(
      { minute: 15, gold: 1240, xp: 0, cs: 12.4, duo: false, games: 1500 },
      'MIDDLE',
      103,
      'Ahri',
      'likely mid',
    );
    expect(r.label).toBe(
      'Lane at 15 min vs Ahri: +1,240 gold, +12 CS, 0 XP (mid lane, likely mid, 1,500 matchups)',
    );
  });
});
