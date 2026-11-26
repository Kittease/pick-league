import { describe, expect, test } from 'bun:test';
import type { Position } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import {
  buildMasteryModel,
  formatPoints,
  type MasteryEffect,
  masteryBucket,
  masteryPoints,
  masteryReason,
} from './mastery.ts';
import type { MasteryRow } from './types.ts';

const CUR = '15.22';
const PREV = '15.21';
/** A finite prior for the champions' own deviations (the config's is Infinity: the curve only). */
const K = 1000;

const row = (
  patch: string,
  championId: number,
  position: Position,
  bucket: number,
  games: number,
  wins: number,
): MasteryRow => ({ patch, championId, position, bucket, games, wins });

describe('masteryBucket', () => {
  test('number of edges at or below the points', () => {
    expect(masteryBucket(0)).toBe(0);
    expect(masteryBucket(4_999)).toBe(0);
    expect(masteryBucket(5_000)).toBe(1);
    expect(masteryBucket(19_999)).toBe(1);
    expect(masteryBucket(20_000)).toBe(2);
    expect(masteryBucket(499_999)).toBe(5);
    expect(masteryBucket(500_000)).toBe(6);
    expect(masteryBucket(1e9)).toBe(6);
  });

  test('negative or non-finite points are bucket 0', () => {
    expect(masteryBucket(-1)).toBe(0);
    expect(masteryBucket(Number.NaN)).toBe(0);
    expect(masteryBucket(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('formatPoints', () => {
  test('rounded down so a label never shows the next bound', () => {
    expect(formatPoints(0)).toBe('0');
    expect(formatPoints(850)).toBe('850');
    expect(formatPoints(4_300)).toBe('4.3k');
    expect(formatPoints(5_000)).toBe('5k');
    expect(formatPoints(12_999)).toBe('12k');
    expect(formatPoints(499_999)).toBe('499k');
    expect(formatPoints(1_250_000)).toBe('1.2M');
  });
});

describe('masteryPoints', () => {
  test('a champion listed twice keeps its highest points', () => {
    const points = masteryPoints([
      { championId: 89, points: 12_000 },
      { championId: 40, points: 300 },
      { championId: 89, points: 600_000 },
      { championId: 89, points: 7 },
    ]);
    expect([...points.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [40, 300],
      [89, 600_000],
    ]);
  });
});

describe('buildMasteryModel', () => {
  // A and B: 50 % on average, 40 % under 5k points and 60 % from 500k.
  const same = [
    row(CUR, 1, 'TOP', 0, 100, 40),
    row(CUR, 1, 'TOP', 6, 100, 60),
    row(CUR, 2, 'MIDDLE', 0, 100, 40),
    row(CUR, 2, 'MIDDLE', 6, 100, 60),
  ];

  test('the curve of all champions is recovered', () => {
    const model = buildMasteryModel(same, K);
    // Both champions agree with the curve: shrinkage changes nothing.
    expect(model.effect(1, 'TOP', 0).delta).toBeCloseTo(-0.1, 10);
    expect(model.effect(1, 'TOP', 6).delta).toBeCloseTo(0.1, 10);
    expect(model.effect(1, 'TOP', 0)).toMatchObject({ championGames: 100, allGames: 200 });
  });

  test("a champion's own deviation is shrunk toward the curve", () => {
    // C: 50 % on average, 30 % under 5k and 70 % from 500k (−20 / +20 points).
    const rows = [
      ...same,
      row(CUR, 3, 'JUNGLE', 0, 1000, 300),
      row(CUR, 3, 'JUNGLE', 6, 1000, 700),
    ];
    const model = buildMasteryModel(rows, K);
    const g0 = (-0.1 * 100 - 0.1 * 100 - 0.2 * 1000) / 1200;
    expect(g0).toBeCloseTo(-0.18333, 5);
    const c = model.effect(3, 'JUNGLE', 0);
    expect(c.delta).toBeCloseTo(g0 + ((-0.2 - g0) * 1000) / (1000 + K), 6);
    expect(c.delta).toBeCloseTo(-0.19167, 5);
    expect(c).toMatchObject({ championGames: 1000, allGames: 1200, ownCurve: true });
    const a = model.effect(1, 'TOP', 0);
    expect(a.delta).toBeCloseTo(g0 + ((-0.1 - g0) * 100) / (100 + K), 6);
    expect(a.delta).toBeCloseTo(-0.17576, 5);

    // The config (shrinkK = Infinity): every champion gets the curve.
    expect(ENGINE_CONFIG.mastery.shrinkK).toBe(Number.POSITIVE_INFINITY);
    const curveOnly = buildMasteryModel(rows);
    expect(curveOnly.effect(3, 'JUNGLE', 0)).toEqual({
      delta: expect.closeTo(g0, 10),
      championGames: 1000,
      ownCurve: false,
      allGames: 1200,
    });
    expect(curveOnly.effect(1, 'TOP', 0).delta).toBeCloseTo(g0, 10);
  });

  test('missing bucket, unknown champion, bucket nobody played', () => {
    const model = buildMasteryModel([...same, row(CUR, 2, 'MIDDLE', 3, 50, 25)], K);
    // Bucket 3 only has B, at 50 % like its own average (125 / 250): the curve is 0 there, and
    // A, without a row in it, gets the curve.
    const g3 = model.effect(99, 'TOP', 3).delta;
    expect(g3).toBeCloseTo(0, 10);
    expect(model.effect(1, 'TOP', 3)).toEqual({
      delta: g3,
      championGames: 0,
      ownCurve: false,
      allGames: 50,
    });
    // Unknown champion (or champion in another role): the curve.
    expect(model.effect(99, 'TOP', 0).delta).toBeCloseTo(-0.1, 10);
    expect(model.effect(1, 'JUNGLE', 6).delta).toBeCloseTo(0.1, 10);
    expect(model.effect(99, 'TOP', 0).championGames).toBe(0);
    // Bucket 2: no games at all.
    expect(model.effect(1, 'TOP', 2)).toEqual({
      delta: 0,
      championGames: 0,
      ownCurve: false,
      allGames: 0,
    });
  });

  test('rows of several patches are pooled; out-of-range buckets are ignored', () => {
    const model = buildMasteryModel(
      [
        row(CUR, 1, 'TOP', 0, 60, 24),
        row(PREV, 1, 'TOP', 0, 40, 16),
        row(CUR, 1, 'TOP', 6, 100, 60),
        row(CUR, 1, 'TOP', 7, 1000, 0),
        row(CUR, 1, 'TOP', 1.5, 1000, 0),
        row(CUR, 1, 'TOP', -1, 1000, 0),
      ],
      K,
    );
    expect(model.effect(1, 'TOP', 0)).toMatchObject({ championGames: 100, allGames: 100 });
    expect(model.effect(1, 'TOP', 0).delta).toBeCloseTo(-0.1, 10);
    expect(model.effect(1, 'TOP', 6).delta).toBeCloseTo(0.1, 10);
  });
});

describe('masteryReason', () => {
  const own: MasteryEffect = {
    delta: -0.081234,
    championGames: 1127,
    ownCurve: true,
    allGames: 90_000,
  };
  const few: MasteryEffect = {
    delta: 0.015,
    championGames: ENGINE_CONFIG.mastery.minChampionGames - 1,
    ownCurve: true,
    allGames: 250_000,
  };

  test("the champion's own sample", () => {
    expect(masteryReason(own, 12_000, 'Rengar')).toEqual({
      kind: 'mastery',
      label:
        "−8.1% at your mastery (12k points): Rengar players with 5k–20k points vs Rengar's average (1,127 games)",
      delta: -0.0812,
      games: 1127,
    });
  });

  test('every champion when its own sample is small', () => {
    expect(masteryReason(few, 650_000, 'Bard')).toEqual({
      kind: 'mastery',
      label:
        '+1.5% at your mastery (650k points): players with 500k+ points on their champion vs its average (all champions, 250,000 games)',
      delta: 0.015,
      games: 250_000,
    });
  });

  test("every champion when the champion's own deviation is not used (the curve)", () => {
    expect(masteryReason({ ...own, ownCurve: false }, 12_000, 'Rengar')).toEqual({
      kind: 'mastery',
      label:
        '−8.1% at your mastery (12k points): players with 5k–20k points on their champion vs its average (all champions, 90,000 games)',
      delta: -0.0812,
      games: 90_000,
    });
  });

  test('no points yet', () => {
    expect(masteryReason(own, 0, 'Rengar').label).toBe(
      "−8.1% at your mastery (no points yet): Rengar players with under 5k points vs Rengar's average (1,127 games)",
    );
  });
});
