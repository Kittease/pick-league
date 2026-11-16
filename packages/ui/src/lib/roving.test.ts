import { describe, expect, test } from 'bun:test';
import { type ItemBox, PAGE_ROWS, rovingTarget } from './roving';

/** A grid of 70×64 tiles, `perRow` per row, `n` tiles. */
function grid(n: number, perRow: number, top = 0): ItemBox[] {
  return Array.from({ length: n }, (_, i) => ({
    left: (i % perRow) * 70,
    top: top + Math.floor(i / perRow) * 64,
    width: 70,
    height: 64,
  }));
}

describe('rovingTarget: grid', () => {
  const boxes = grid(10, 4); // rows: 0–3, 4–7, 8–9
  test('Left/Right in reading order, across rows, stopping at the ends', () => {
    expect(rovingTarget('ArrowRight', 3, boxes)).toBe(4);
    expect(rovingTarget('ArrowLeft', 4, boxes)).toBe(3);
    expect(rovingTarget('ArrowLeft', 0, boxes)).toBe(0);
    expect(rovingTarget('ArrowRight', 9, boxes)).toBe(9);
  });
  test('Up/Down to the closest item of the next row', () => {
    expect(rovingTarget('ArrowDown', 1, boxes)).toBe(5);
    expect(rovingTarget('ArrowUp', 5, boxes)).toBe(1);
    // Short last row: the closest one.
    expect(rovingTarget('ArrowDown', 7, boxes)).toBe(9);
    expect(rovingTarget('ArrowDown', 9, boxes)).toBe(9);
    expect(rovingTarget('ArrowUp', 2, boxes)).toBe(2);
  });
  test('Home/End, and other keys left alone', () => {
    expect(rovingTarget('Home', 6, boxes)).toBe(0);
    expect(rovingTarget('End', 2, boxes)).toBe(9);
    expect(rovingTarget('Enter', 2, boxes)).toBeNull();
    expect(rovingTarget('PageDown', 2, boxes)).toBeNull();
  });
  test('two sections (ranked, then the rest under a heading) navigate as one', () => {
    const two = [...grid(4, 4), ...grid(4, 4, 64 + 30)];
    expect(rovingTarget('ArrowDown', 2, two)).toBe(6);
    expect(rovingTarget('ArrowUp', 6, two)).toBe(2);
  });
  test('nothing to do without items or with an unknown current item', () => {
    expect(rovingTarget('ArrowDown', 0, [])).toBeNull();
    expect(rovingTarget('ArrowDown', 5, grid(3, 3))).toBeNull();
  });
});

describe('rovingTarget: vertical list', () => {
  const rows = grid(30, 1);
  test('Up/Down step, PageUp/PageDown jump, Left/Right are left alone', () => {
    expect(rovingTarget('ArrowDown', 0, rows, 'vertical')).toBe(1);
    expect(rovingTarget('ArrowUp', 0, rows, 'vertical')).toBe(0);
    expect(rovingTarget('PageDown', 0, rows, 'vertical')).toBe(PAGE_ROWS);
    expect(rovingTarget('PageDown', 25, rows, 'vertical')).toBe(29);
    expect(rovingTarget('PageUp', 5, rows, 'vertical')).toBe(0);
    expect(rovingTarget('ArrowRight', 3, rows, 'vertical')).toBeNull();
  });
});
