import type { RunesRecommendation } from '@pick-league/shared';
import type { LcuPerkInventory, LcuPerkPage, LcuPerkPageInput } from './lcu-types.ts';

/** The only rune page the helper ever writes. */
export const RUNE_PAGE_NAME = 'PickLeague';

/** LCU rune page body from a build's runes (keystone, 3 primary, 2 secondary, 3 shards). */
export function runePageInput(runes: RunesRecommendation): LcuPerkPageInput {
  const selectedPerkIds =
    runes.selectedPerkIds.length > 0
      ? [...runes.selectedPerkIds]
      : [...runes.runeIds, ...runes.statShardIds];
  if (
    selectedPerkIds.length !== 9 ||
    selectedPerkIds.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    throw new Error(`Invalid rune page: expected 9 perk ids, got [${selectedPerkIds.join(', ')}]`);
  }
  return {
    name: RUNE_PAGE_NAME,
    primaryStyleId: runes.primaryTreeId,
    subStyleId: runes.secondaryTreeId,
    selectedPerkIds,
    current: true,
  };
}

export type RunePagePlan =
  | { kind: 'replace'; pageId: number }
  | { kind: 'create' }
  /** No free slot and no PickLeague page: never delete a user page, warn instead. */
  | { kind: 'no_slot'; message: string };

/** Decides how to write the PickLeague page without ever touching the user's own pages. */
export function planRunePageWrite(
  pages: readonly LcuPerkPage[],
  inventory: LcuPerkInventory,
): RunePagePlan {
  const ours = pages.find((p) => p.name === RUNE_PAGE_NAME && p.isEditable);
  if (ours) return { kind: 'replace', pageId: ours.id };
  const customPages = pages.filter((p) => p.isDeletable).length;
  if (customPages < inventory.ownedPageCount) return { kind: 'create' };
  return {
    kind: 'no_slot',
    message: `All ${inventory.ownedPageCount} rune page slots are used. Rename one of your pages to "${RUNE_PAGE_NAME}" (or free a slot) so the helper can write its runes there.`,
  };
}
