import type { LcuMySelectionPatch } from './lcu-types.ts';

export const FLASH_SPELL_ID = 4;

/**
 * Orders the recommended spells on the D/F keys so that a spell the user already has keeps
 * its key — most importantly Flash: a "Flash on F" player keeps Flash on F. Spells the user
 * doesn't have yet go to the remaining key, in the recommended order.
 */
export function arrangeSpells(
  recommended: readonly [number, number],
  current: readonly [number, number],
): [number, number] {
  const slots: [number, number] = [0, 0];
  // Flash first so it wins its key even if the other spell also sits on it.
  const ordered = [...recommended].sort(
    (a, b) => Number(b === FLASH_SPELL_ID) - Number(a === FLASH_SPELL_ID),
  );
  const placed = new Set<number>();
  for (const spell of ordered) {
    const key = current.indexOf(spell);
    if (key === 0 || key === 1) {
      if (slots[key] === 0) {
        slots[key] = spell;
        placed.add(spell);
      }
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
): LcuMySelectionPatch | null {
  const [spell1Id, spell2Id] = arrangeSpells(recommended, current);
  if (spell1Id === current[0] && spell2Id === current[1]) return null;
  return { spell1Id, spell2Id };
}
