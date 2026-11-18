import { describe, expect, test } from 'bun:test';
import type { PatchId, Position } from '@pick-league/shared';
import { championGameLength, indexGameLength, teamGameLength } from './game-length.ts';
import type { GameLengthRow } from './types.ts';

const CUR = '15.22';
const PREV = '15.21';

function gl(
  patch: PatchId,
  position: Position,
  championId: number,
  bucket: 0 | 1 | 2,
  games: number,
  wins: number,
): GameLengthRow {
  return { patch, position, championId, bucket, games, wins };
}

/** [games, wins] of buckets 0, 1, 2. */
type Split = [[number, number], [number, number], [number, number]];

function rowsOf(patch: PatchId, position: Position, championId: number, split: Split) {
  return split.map(([games, wins], bucket) =>
    gl(patch, position, championId, bucket as 0 | 1 | 2, games, wins),
  );
}

// The champion wins more in short games and less in long ones; the role is at 50 % everywhere.
const CHAMPION: Split = [
  [200, 120],
  [300, 150],
  [100, 40],
];
const OTHER: Split = [
  [800, 380],
  [1200, 600],
  [400, 210],
];

describe('championGameLength', () => {
  test('bucket vs the champion other games, net of the role, shrunk on the effective sample', () => {
    const index = indexGameLength([
      ...rowsOf(CUR, 'UTILITY', 1, CHAMPION),
      ...rowsOf(CUR, 'UTILITY', 2, OTHER),
    ]);
    // early: raw 0.1 − 310/600 + 0.5 = 0.083333, nEff 133.33 → 0.0256;
    // late: raw −0.1 − 0.016667 = −0.116667, nEff 83.33 → −0.0254.
    expect(championGameLength(index, 'UTILITY', 1)).toEqual({
      early: 0.0256,
      late: -0.0254,
      earlyGames: 200,
      lateGames: 100,
    });
  });

  test('the patches given are summed', () => {
    const half = (s: Split): Split => s.map(([g, w]) => [g / 2, w / 2]) as Split;
    const index = indexGameLength([
      ...rowsOf(CUR, 'UTILITY', 1, half(CHAMPION)),
      ...rowsOf(PREV, 'UTILITY', 1, half(CHAMPION)),
      ...rowsOf(CUR, 'UTILITY', 2, half(OTHER)),
      ...rowsOf(PREV, 'UTILITY', 2, half(OTHER)),
    ]);
    expect(championGameLength(index, 'UTILITY', 1)).toEqual({
      early: 0.0256,
      late: -0.0254,
      earlyGames: 200,
      lateGames: 100,
    });
  });

  test('a bucket under minGames is null; both under → no profile', () => {
    const lateShort = indexGameLength([
      ...rowsOf(CUR, 'UTILITY', 1, [
        [200, 120],
        [300, 150],
        [99, 40],
      ]),
      ...rowsOf(CUR, 'UTILITY', 2, OTHER),
    ]);
    const profile = championGameLength(lateShort, 'UTILITY', 1);
    expect(profile?.late).toBeNull();
    expect(profile?.early).toBeNumber();
    expect(profile?.lateGames).toBe(99);

    const bothShort = indexGameLength([
      ...rowsOf(CUR, 'UTILITY', 1, [
        [99, 50],
        [300, 150],
        [99, 40],
      ]),
      ...rowsOf(CUR, 'UTILITY', 2, OTHER),
    ]);
    expect(championGameLength(bothShort, 'UTILITY', 1)).toBeNull();
  });

  test('no other games to compare with → null for that bucket', () => {
    // Every game is short: early has nothing to compare with, late has no games.
    const index = indexGameLength([
      gl(CUR, 'UTILITY', 1, 0, 300, 160),
      ...rowsOf(CUR, 'UTILITY', 2, OTHER),
    ]);
    expect(championGameLength(index, 'UTILITY', 1)).toBeNull();
  });

  test('unknown champion, other role or empty rows → null', () => {
    const index = indexGameLength([
      ...rowsOf(CUR, 'UTILITY', 1, CHAMPION),
      ...rowsOf(CUR, 'UTILITY', 2, OTHER),
    ]);
    expect(championGameLength(index, 'UTILITY', 3)).toBeNull();
    expect(championGameLength(index, 'TOP', 1)).toBeNull();
    expect(championGameLength(indexGameLength([]), 'UTILITY', 1)).toBeNull();
  });

  test('a champion at the role rates in every bucket → 0, never -0', () => {
    const index = indexGameLength([
      ...rowsOf(CUR, 'MIDDLE', 1, [
        [200, 100],
        [300, 150],
        [200, 100],
      ]),
      ...rowsOf(CUR, 'MIDDLE', 2, [
        [800, 400],
        [1200, 600],
        [400, 200],
      ]),
    ]);
    const profile = championGameLength(index, 'MIDDLE', 1);
    expect(profile?.early).toBe(0);
    expect(profile?.late).toBe(0);
  });
});

describe('teamGameLength', () => {
  const index = indexGameLength([
    ...rowsOf(CUR, 'UTILITY', 1, CHAMPION),
    ...rowsOf(CUR, 'UTILITY', 2, OTHER),
    ...rowsOf(CUR, 'TOP', 3, CHAMPION),
    ...rowsOf(CUR, 'TOP', 4, OTHER),
  ]);

  test('sums the members with a profile; one without counts 0', () => {
    const top = championGameLength(index, 'TOP', 3);
    expect(top).not.toBeNull();
    expect(
      teamGameLength(index, [
        { championId: 1, role: 'UTILITY' },
        { championId: 3, role: 'TOP' },
        { championId: 99, role: 'JUNGLE' },
      ]),
    ).toEqual({ early: 0.0512, late: -0.0508, champions: 2 });
  });

  test('empty team', () => {
    expect(teamGameLength(index, [])).toEqual({ early: 0, late: 0, champions: 0 });
  });
});
