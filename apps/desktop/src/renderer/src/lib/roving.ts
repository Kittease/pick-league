/**
 * Keyboard navigation inside a list or grid of items with a single tab stop ("roving
 * tabindex", the WAI-ARIA pattern for composite widgets): Tab enters the list on one item and
 * leaves it at the next one; arrows, Home and End move between items.
 */

/** Where an item is on screen (a `DOMRect` fits). */
export interface ItemBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type RovingOrientation = 'grid' | 'vertical';

/** Rows jumped by PageUp / PageDown in a vertical list. */
export const PAGE_ROWS = 10;

/**
 * Index of the item a key moves to from item `current`, or null when the key is not a
 * navigation key (left to the browser). Grid: Left/Right go to the previous/next item (reading
 * order, across rows), Up/Down to the item of the row above/below closest horizontally (from
 * the boxes, so wrapping and several sections just work). Vertical list: Up/Down step, PageUp /
 * PageDown jump `PAGE_ROWS`; Left/Right are left alone. Home/End: first/last item.
 */
export function rovingTarget(
  key: string,
  current: number,
  boxes: readonly ItemBox[],
  orientation: RovingOrientation = 'grid',
): number | null {
  const n = boxes.length;
  if (n === 0 || current < 0 || current >= n) return null;
  const last = n - 1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowRight':
      return orientation === 'grid' ? Math.min(last, current + 1) : null;
    case 'ArrowLeft':
      return orientation === 'grid' ? Math.max(0, current - 1) : null;
    case 'PageDown':
      return orientation === 'vertical' ? Math.min(last, current + PAGE_ROWS) : null;
    case 'PageUp':
      return orientation === 'vertical' ? Math.max(0, current - PAGE_ROWS) : null;
    case 'ArrowDown':
    case 'ArrowUp': {
      if (orientation === 'vertical') {
        return key === 'ArrowDown' ? Math.min(last, current + 1) : Math.max(0, current - 1);
      }
      return verticalNeighbour(boxes, current, key === 'ArrowDown');
    }
    default:
      return null;
  }
}

function verticalNeighbour(boxes: readonly ItemBox[], current: number, down: boolean): number {
  const from = boxes[current] as ItemBox;
  const centre = (b: ItemBox) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
  const c = centre(from);
  const half = Math.max(1, from.height / 2);
  const beyond = boxes
    .map((b, i) => ({ i, ...centre(b) }))
    .filter((b) => (down ? b.y > c.y + half : b.y < c.y - half));
  if (beyond.length === 0) return current;
  const rowY = down ? Math.min(...beyond.map((b) => b.y)) : Math.max(...beyond.map((b) => b.y));
  const row = beyond.filter((b) => Math.abs(b.y - rowY) < half);
  let best = row[0] as (typeof row)[number];
  for (const b of row) if (Math.abs(b.x - c.x) < Math.abs(best.x - c.x)) best = b;
  return best.i;
}
