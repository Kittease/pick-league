import { describe, expect, test } from 'bun:test';
import { POSITIONS } from '@pick-league/shared';
import { createRng, type Rng } from '../testing/synthetic.ts';
import {
  type CalibrationKind,
  type CalibrationMatches,
  calibrate,
  fitLogistic,
  MatchCollector,
} from './calibration.ts';

describe('fitLogistic', () => {
  test('recovers known coefficients', () => {
    const rng = createRng(7);
    const rows = 20_000;
    const x = new Float64Array(rows * 2);
    const y = new Uint8Array(rows);
    for (let r = 0; r < rows; r++) {
      const v = 2 * rng() - 1;
      x[r * 2] = 1;
      x[r * 2 + 1] = v;
      y[r] = rng() < 1 / (1 + Math.exp(-(0.3 + 1.5 * v))) ? 1 : 0;
    }
    const { coefficients, standardErrors } = fitLogistic(x, 2, y);
    expect(Math.abs((coefficients[0] as number) - 0.3)).toBeLessThan(0.08);
    expect(Math.abs((coefficients[1] as number) - 1.5)).toBeLessThan(0.12);
    expect(standardErrors[0]).toBeGreaterThan(0);
    expect(standardErrors[1]).toBeGreaterThan(0);
  });
});

/** Ten participant rows of a complete match (champion ids 1–5 blue, 6–10 red). */
function fullMatch(id: string, blueWins: boolean) {
  return POSITIONS.flatMap((position, r) => [
    { id, team: 100, champion: r + 1, position, win: blueWins },
    { id, team: 200, champion: r + 6, position, win: !blueWins },
  ]);
}

describe('MatchCollector', () => {
  test('drops matches with a missing or duplicated role', () => {
    const collector = new MatchCollector();
    const rows = [
      ...fullMatch('EUW1_OK', true),
      ...fullMatch('EUW1_MISSING', true).filter((r) => !(r.team === 200 && r.position === 'TOP')),
      ...fullMatch('EUW1_NULL', false).map((r, i) => (i === 3 ? { ...r, position: null } : r)),
      ...fullMatch('EUW1_DUP', false).map((r, i) =>
        i === 0 ? { ...r, position: 'JUNGLE' as const } : r,
      ),
    ];
    for (const r of rows) collector.add(r.id, r.team, r.champion, r.position, r.win);
    const out = collector.finish({ by: 'hash', testEvery: 5 });
    expect(out.count).toBe(1);
    expect(out.dropped).toBe(3);
    expect(out.ids).toEqual(['EUW1_OK']);
    expect(Array.from(out.champions)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(out.blueWin[0]).toBe(1);
  });

  test('by hash, holds out about 1 match in N, by id, whatever the row order', () => {
    const rows = Array.from({ length: 2000 }, (_, m) => fullMatch(`NA1_${m}`, m % 2 === 0)).flat();
    const inOrder = new MatchCollector();
    for (const r of rows) inOrder.add(r.id, r.team, r.champion, r.position, r.win);
    const a = inOrder.finish({ by: 'hash', testEvery: 5 });

    const rng = createRng(3);
    const shuffled = [...rows];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [
        shuffled[j] as (typeof rows)[number],
        shuffled[i] as (typeof rows)[number],
      ];
    }
    const outOfOrder = new MatchCollector();
    for (const r of shuffled) outOfOrder.add(r.id, r.team, r.champion, r.position, r.win);
    const b = outOfOrder.finish({ by: 'hash', testEvery: 5 });

    expect(a.count).toBe(2000);
    const held = a.test.reduce((s, v) => s + v, 0);
    expect(held).toBeGreaterThan(400 * 0.8);
    expect(held).toBeLessThan(400 * 1.2);
    const flags = (m: typeof a) => new Map(m.ids.map((id, i) => [id, m.test[i]]));
    expect(flags(b)).toEqual(flags(a));
    expect(Array.from(b.blueWin)).toEqual(Array.from(a.blueWin));
  });

  test('by default, holds out the last matches by start time', () => {
    const start = Date.UTC(2026, 10, 18);
    const collector = new MatchCollector();
    // Ids in another order than the start times, one match without a start time.
    for (let m = 0; m < 100; m++) {
      const at = new Date(start + (99 - m) * 60_000);
      for (const r of fullMatch(`KR_${m}`, m % 2 === 0)) {
        collector.add(r.id, r.team, r.champion, r.position, r.win, at);
      }
    }
    for (const r of fullMatch('KR_UNTIMED', true)) {
      collector.add(r.id, r.team, r.champion, r.position, r.win);
    }
    const out = collector.finish();
    expect(out.count).toBe(100);
    expect(out.dropped).toBe(1);
    expect(out.cutoff).toBe(start + 80 * 60_000);
    // The 20 latest (ids 0–19) are held out, every earlier one is training.
    const held = out.ids.filter((_, i) => out.test[i] === 1).sort();
    expect(held).toEqual(Array.from({ length: 20 }, (_, m) => `KR_${m}`).sort());

    const third = collector.finish({ by: 'time', testShare: 1 / 3 });
    expect(third.test.reduce((s, v) => s + v, 0)).toBe(34);
    // The hash split keeps every complete match, timed or not.
    expect(collector.finish({ by: 'hash', testEvery: 5 }).count).toBe(101);
  });
});

/**
 * Synthetic matches: 6 champions per role, each with a strength drawn once from ±0.04;
 * P(blue wins) = 0.5 + Σ blue strengths − Σ red strengths (+ the lane terms, antisymmetric:
 * `lane(a, b) = −lane(b, a)`, for each role's blue vs red champion). Each team draws its champions
 * independently (mirror picks allowed, so every champion faces the same opponents on average).
 * Half the matches are held out: with fewer, the fitted weight's own noise (±0.14 on 6,000 test
 * matches, even with the true effects as the feature) is as large as the tolerances.
 */
function synthetic(
  rng: Rng,
  count: number,
  lane: ((role: number, a: number, b: number) => number) | null,
): CalibrationMatches {
  const perRole = 6;
  const strength = Array.from({ length: 5 * perRole }, () => 0.08 * rng() - 0.04);
  const champions = new Int16Array(count * 10);
  const blueWin = new Uint8Array(count);
  const test = new Uint8Array(count);
  for (let m = 0; m < count; m++) {
    let p = 0.5;
    for (let role = 0; role < 5; role++) {
      const blue = Math.floor(rng() * perRole);
      const red = Math.floor(rng() * perRole);
      champions[m * 10 + role] = 100 + role * perRole + blue;
      champions[m * 10 + 5 + role] = 100 + role * perRole + red;
      p += (strength[role * perRole + blue] as number) - (strength[role * perRole + red] as number);
      if (lane) p += lane(role, blue, red);
    }
    p = Math.min(0.95, Math.max(0.05, p));
    blueWin[m] = rng() < p ? 1 : 0;
    test[m] = m % 2;
  }
  return { count, champions, blueWin, test };
}

const K_GRID = [100, 1000, 3000];
/** The `k` at which each planted effect is recovered at ~1; unplanted kinds are shrunk away. */
const MATCHING_K: Record<CalibrationKind, number> = {
  base: 100,
  lane: 100,
  laneSecondary: 10_000,
  otherEnemy: 10_000,
  duo: 10_000,
  otherAlly: 10_000,
};
const config = { shrinkK: MATCHING_K, baseWeight: 1, pairWeight: 1 };

/** ±0.06 for a third of the same-role pairs, −0.06 for another third, antisymmetric. */
function plantedLane(rng: Rng): (role: number, a: number, b: number) => number {
  const table = new Map<string, number>();
  for (let role = 0; role < 5; role++) {
    for (let a = 0; a < 6; a++) {
      for (let b = a + 1; b < 6; b++) {
        const draw = rng();
        const v = draw < 1 / 3 ? 0.06 : draw < 2 / 3 ? -0.06 : 0;
        table.set(`${role}|${a}|${b}`, v);
        table.set(`${role}|${b}|${a}`, -v);
      }
    }
  }
  return (role, a, b) => table.get(`${role}|${a}|${b}`) ?? 0;
}

const weightAt = (kinds: ReturnType<typeof calibrate>['kinds'], kind: CalibrationKind) =>
  kinds.find((k) => k.kind === kind)?.rows ?? [];

describe('calibrate', () => {
  test('finds a planted champion strength calibrated', () => {
    const matches = synthetic(createRng(11), 60_000, null);
    const result = calibrate(matches, { kGrid: K_GRID, config });
    expect(result.trainMatches).toBe(30_000);
    expect(result.testMatches).toBe(30_000);
    const base = weightAt(result.kinds, 'base')[0];
    expect(base?.k).toBe(100);
    expect(base?.weight).toBeGreaterThan(0.8);
    expect(base?.weight).toBeLessThan(1.2);
  });

  test('a planted lane effect is found, an unplanted duo effect is not, the sum is calibrated', () => {
    const rng = createRng(12);
    const matches = synthetic(rng, 60_000, plantedLane(rng));
    const result = calibrate(matches, { kGrid: K_GRID, config });

    const lane = weightAt(result.kinds, 'lane');
    // More shrinkage needs a bigger weight to give the same prediction.
    for (let i = 1; i < lane.length; i++) {
      expect(lane[i]?.weight).toBeGreaterThan(lane[i - 1]?.weight ?? 0);
    }
    expect(lane[0]?.weight).toBeGreaterThan(0.7);
    expect(lane[0]?.weight).toBeLessThan(1.3);

    const duo = weightAt(result.kinds, 'duo')[0];
    expect(Math.abs(duo?.weight ?? 1)).toBeLessThan(3 * (duo?.standardError ?? 0));

    expect(result.summed.slope).toBeGreaterThan(0.75);
    expect(result.summed.slope).toBeLessThan(1.25);
  });
});
