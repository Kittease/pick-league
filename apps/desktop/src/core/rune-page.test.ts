import { describe, expect, test } from 'bun:test';
import type { RunesRecommendation } from '@pick-league/shared';
import type { LcuPerkPage } from './lcu-types.ts';
import { planRunePageWrite, RUNE_PAGE_NAME, runePageInput } from './rune-page.ts';

const runes: RunesRecommendation = {
  primaryTreeId: 8200,
  secondaryTreeId: 8400,
  runeIds: [8214, 8226, 8210, 8237, 8473, 8453],
  statShardIds: [5008, 5008, 5011],
  selectedPerkIds: [8214, 8226, 8210, 8237, 8473, 8453, 5008, 5008, 5011],
  games: 900,
  winRate: 0.52,
  reasons: [],
};

function page(id: number, name: string, over: Partial<LcuPerkPage> = {}): LcuPerkPage {
  return {
    id,
    name,
    isEditable: true,
    isDeletable: true,
    current: false,
    primaryStyleId: 8000,
    subStyleId: 8100,
    selectedPerkIds: [],
    ...over,
  };
}

describe('runePageInput', () => {
  test('builds the LCU page body named PickLeague', () => {
    expect(runePageInput(runes)).toEqual({
      name: RUNE_PAGE_NAME,
      primaryStyleId: 8200,
      subStyleId: 8400,
      selectedPerkIds: [8214, 8226, 8210, 8237, 8473, 8453, 5008, 5008, 5011],
      current: true,
    });
  });

  test('falls back to runeIds + statShardIds', () => {
    expect(runePageInput({ ...runes, selectedPerkIds: [] }).selectedPerkIds).toEqual(
      runes.selectedPerkIds,
    );
  });

  test('rejects incomplete pages', () => {
    expect(() => runePageInput({ ...runes, selectedPerkIds: [8214, 8226] })).toThrow();
  });
});

describe('planRunePageWrite', () => {
  const preset = page(50, 'Domination', { isEditable: false, isDeletable: false });

  test('replaces the existing PickLeague page', () => {
    expect(
      planRunePageWrite([preset, page(1, 'Mine'), page(2, RUNE_PAGE_NAME)], { ownedPageCount: 2 }),
    ).toEqual({
      kind: 'replace',
      pageId: 2,
    });
  });

  test('creates a page when a slot is free (preset pages do not use slots)', () => {
    expect(planRunePageWrite([preset, page(1, 'Mine')], { ownedPageCount: 2 })).toEqual({
      kind: 'create',
    });
  });

  test('warns instead of deleting when every slot holds a user page', () => {
    const plan = planRunePageWrite([preset, page(1, 'Mine'), page(2, 'Also mine')], {
      ownedPageCount: 2,
    });
    expect(plan.kind).toBe('no_slot');
  });
});
