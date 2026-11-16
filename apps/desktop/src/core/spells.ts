import {
  arrangeSpells,
  FLASH_KEYS,
  FLASH_SPELL_ID,
  type FlashKey,
  isFlashKey,
} from '@pick-league/ui/lib/spells';
import type { LcuMySelectionPatch } from './lcu-types.ts';

export { arrangeSpells, FLASH_KEYS, FLASH_SPELL_ID, type FlashKey, isFlashKey };

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
