/**
 * Late-game swaps: the completed item a champion+role sells once its build is full and the
 * completed item it buys in its place (stats_item_swaps). The rows of every patch given are
 * summed. It explains a build and never changes it: no win rate, no delta.
 */
import type { LateSwap } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import { round } from './math.ts';
import type { ItemInfo, ItemSwapRow } from './types.ts';

const LS = ENGINE_CONFIG.lateSwaps;

interface Pair {
  sold: number;
  bought: number;
  games: number;
  minutes: number;
}

/**
 * The swaps of `rows` (one champion+role, every patch given summed, unweighted) the build can
 * show: pairs seen in at least `lateSwaps.minGames` games whose sold item the reader has already
 * seen, i.e. an item of the core builds shown (`shownItemIds`), any pair of boots (the build
 * shows one, and players wearing another swap theirs the same way) or the item bought by a swap
 * listed before. Without that, a champion's three most frequent swaps could all sell an item its builds
 * never mention (Xayah's sold Guardian Angel, which she only gets through a swap): the swap that
 * buys it comes first. Picked one at a time, the most frequent showable pair first (ties: lowest
 * item ids), at most `lateSwaps.maxShown`; the list is in that order. Pairs with an item unknown
 * to `items` (the current patch's: an item removed since the previous patch has no name or icon)
 * are left out.
 */
export function lateSwaps(
  rows: readonly ItemSwapRow[],
  items: ReadonlyMap<number, ItemInfo>,
  shownItemIds: Iterable<number>,
): LateSwap[] {
  const pairs = new Map<string, Pair>();
  for (const r of rows) {
    if (r.games <= 0 || !items.has(r.soldItemId) || !items.has(r.boughtItemId)) continue;
    const key = `${r.soldItemId}|${r.boughtItemId}`;
    const pair = pairs.get(key) ?? {
      sold: r.soldItemId,
      bought: r.boughtItemId,
      games: 0,
      minutes: 0,
    };
    pairs.set(key, pair);
    pair.games += r.games;
    pair.minutes += r.minuteSum;
  }
  const candidates = [...pairs.values()]
    .filter((p) => p.games >= LS.minGames)
    .sort((a, b) => b.games - a.games || a.sold - b.sold || a.bought - b.bought);
  const known = new Set(shownItemIds);
  const shown: Pair[] = [];
  while (shown.length < LS.maxShown) {
    const next = candidates.find(
      (p) => (known.has(p.sold) || items.get(p.sold)?.isBoots === true) && !shown.includes(p),
    );
    if (!next) break;
    shown.push(next);
    known.add(next.bought);
  }
  return shown.map((p) => ({
    sellItemId: p.sold,
    buyItemId: p.bought,
    games: p.games,
    minute: round(p.minutes / p.games, 1),
  }));
}
