import { describe, expect, test } from 'bun:test';
import type { PatchId } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import { items } from './fixtures.ts';
import { lateSwaps } from './late-swaps.ts';
import type { ItemSwapRow } from './types.ts';

const CUR = '15.22';
const PREV = '15.21';

/** `games` swaps of `sold` → `bought`, all at `minute`. */
const swap = (
  patch: PatchId,
  soldItemId: number,
  boughtItemId: number,
  games: number,
  minute: number,
): ItemSwapRow => ({ patch, soldItemId, boughtItemId, games, minuteSum: games * minute });

/** Every item of the fixtures counts as shown by the build, unless a test says otherwise. */
const ALL = [...items.keys()];

describe('lateSwaps', () => {
  test('thresholds are the configured ones', () => {
    expect(ENGINE_CONFIG.lateSwaps).toEqual({ minGames: 10, maxShown: 3 });
  });

  test('no rows: an empty list', () => {
    expect(lateSwaps([], items, ALL)).toEqual([]);
  });

  test('a pair is shown from 10 games, with the average minute to one decimal', () => {
    expect(
      lateSwaps([swap(CUR, 3047, 3111, 10, 31.26), swap(CUR, 3190, 3065, 9, 35)], items, ALL),
    ).toEqual([{ sellItemId: 3047, buyItemId: 3111, games: 10, minute: 31.3 }]);
  });

  test('the current and previous patches are summed, unweighted', () => {
    // 4 games at minute 30 and 8 at minute 36 → 12 games at minute 34: neither patch alone has 10.
    expect(
      lateSwaps([swap(CUR, 3047, 3111, 4, 30), swap(PREV, 3047, 3111, 8, 36)], items, ALL),
    ).toEqual([{ sellItemId: 3047, buyItemId: 3111, games: 12, minute: 34 }]);
  });

  test('most frequent first, at most 3, ties by item ids whatever the row order', () => {
    const rows = [
      swap(CUR, 3190, 3065, 20, 33),
      swap(CUR, 3047, 3111, 50, 30),
      swap(CUR, 3111, 3047, 20, 32),
      swap(PREV, 3075, 3065, 30, 34),
      swap(CUR, 3050, 3109, 15, 35),
    ];
    const expected = [
      { sellItemId: 3047, buyItemId: 3111, games: 50, minute: 30 },
      { sellItemId: 3075, buyItemId: 3065, games: 30, minute: 34 },
      { sellItemId: 3111, buyItemId: 3047, games: 20, minute: 32 },
    ];
    expect(lateSwaps(rows, items, ALL)).toEqual(expected);
    expect(lateSwaps([...rows].reverse(), items, ALL)).toEqual(expected);
  });

  test('the two directions of a pair are two swaps', () => {
    expect(
      lateSwaps([swap(CUR, 3047, 3111, 12, 30), swap(CUR, 3111, 3047, 11, 31)], items, ALL).map(
        (s) => [s.sellItemId, s.buyItemId],
      ),
    ).toEqual([
      [3047, 3111],
      [3111, 3047],
    ]);
  });

  test('a pair with an item the current patch no longer has is left out', () => {
    expect(
      lateSwaps(
        [
          swap(PREV, 9999, 3111, 40, 30),
          swap(PREV, 3047, 9999, 40, 30),
          swap(PREV, 3047, 3111, 12, 30),
        ],
        items,
        ALL,
      ),
    ).toEqual([{ sellItemId: 3047, buyItemId: 3111, games: 12, minute: 30 }]);
  });

  test('a swap only sells an item the build shows, or one bought by a swap listed before', () => {
    const pairs = (shown: number[], rows: ItemSwapRow[]) =>
      lateSwaps(rows, items, shown).map((s) => [s.sellItemId, s.buyItemId]);
    // The three most frequent swaps all sell 3065, which the build (3047, 3190) never shows: the
    // swap that buys it comes first, then the most frequent ones that sell it.
    const rows = [
      swap(CUR, 3065, 3075, 90, 36),
      swap(CUR, 3065, 3109, 80, 36),
      swap(CUR, 3065, 3050, 70, 36),
      swap(CUR, 3047, 3065, 40, 33),
    ];
    expect(pairs([3047, 3190], rows)).toEqual([
      [3047, 3065],
      [3065, 3075],
      [3065, 3109],
    ]);
    // Without a swap that buys it, nothing sells it.
    expect(pairs([3047, 3190], rows.slice(0, 3))).toEqual([]);
    // The swap that brings it in needs its 10 games too.
    expect(pairs([3047, 3190], [...rows.slice(0, 3), swap(CUR, 3047, 3065, 9, 33)])).toEqual([]);
    // Among the swaps that can be shown, the most frequent first: a known item's own swap goes
    // before the one that only opens the way to others.
    expect(pairs([3047, 3190], [...rows, swap(CUR, 3190, 3111, 60, 34)])).toEqual([
      [3190, 3111],
      [3047, 3065],
      [3065, 3075],
    ]);
    // An item shown by the build needs no swap before it.
    expect(pairs([3065], rows)).toEqual([
      [3065, 3075],
      [3065, 3109],
      [3065, 3050],
    ]);
  });
});
