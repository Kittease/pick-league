import { describe, expect, test } from 'bun:test';
import { FLASH_SPELL_ID, spellsPatch } from './spells.ts';

const FLASH = FLASH_SPELL_ID;
const IGNITE = 14;
const EXHAUST = 3;

describe('spellsPatch', () => {
  test('null when the spells are already right', () => {
    expect(spellsPatch([FLASH, IGNITE], [IGNITE, FLASH], 'F')).toBeNull();
    expect(spellsPatch([IGNITE, FLASH], [FLASH, IGNITE], 'D')).toBeNull();
  });

  test('patch body otherwise', () => {
    expect(spellsPatch([FLASH, EXHAUST], [IGNITE, FLASH], 'F')).toEqual({
      spell1Id: EXHAUST,
      spell2Id: FLASH,
    });
    expect(spellsPatch([FLASH, EXHAUST], [IGNITE, FLASH], 'D')).toEqual({
      spell1Id: FLASH,
      spell2Id: EXHAUST,
    });
  });
});
