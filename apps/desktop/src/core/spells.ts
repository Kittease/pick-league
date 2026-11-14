import type { LcuMySelectionPatch } from './lcu-types.ts';

export const FLASH_SPELL_ID = 4;

/** Summoner spell key Flash goes on when spells are applied. */
export type FlashKey = 'D' | 'F';
export const FLASH_KEYS: readonly FlashKey[] = ['D', 'F'];

export function isFlashKey(value: unknown): value is FlashKey {
  return value === 'D' || value === 'F';
}

/**
 * Orders the recommended spells on the D/F keys. A pair with Flash puts Flash on `flashKey`
 * and the other spell on the other key. Otherwise a spell the user already has keeps its key,
 * and spells the user doesn't have yet go to the remaining key, in the recommended order.
 */
export function arrangeSpells(
  recommended: readonly [number, number],
  current: readonly [number, number],
  flashKey: FlashKey,
): [number, number] {
  const flashIndex = recommended.indexOf(FLASH_SPELL_ID);
  if (flashIndex === 0 || flashIndex === 1) {
    const other = recommended[1 - flashIndex] ?? 0;
    return flashKey === 'D' ? [FLASH_SPELL_ID, other] : [other, FLASH_SPELL_ID];
  }
  const slots: [number, number] = [0, 0];
  const placed = new Set<number>();
  for (const spell of recommended) {
    const key = current.indexOf(spell);
    if ((key === 0 || key === 1) && slots[key] === 0) {
      slots[key] = spell;
      placed.add(spell);
    }
  }
  for (const spell of recommended) {
    if (placed.has(spell)) continue;
    const free = slots[0] === 0 ? 0 : 1;
    slots[free] = spell;
    placed.add(spell);
  }
  return slots;
}

/** `PATCH /lol-champ-select/v1/session/my-selection` body, or null when nothing changes. */
export function spellsPatch(
  recommended: readonly [number, number],
  current: readonly [number, number],
  flashKey: FlashKey,
): LcuMySelectionPatch | null {
  const [spell1Id, spell2Id] = arrangeSpells(recommended, current, flashKey);
  if (spell1Id === current[0] && spell2Id === current[1]) return null;
  return { spell1Id, spell2Id };
}
