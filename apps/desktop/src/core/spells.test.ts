import { describe, expect, test } from 'bun:test';
import { arrangeSpells, FLASH_SPELL_ID, spellsPatch } from './spells.ts';

const FLASH = FLASH_SPELL_ID;
const IGNITE = 14;
const EXHAUST = 3;
const HEAL = 7;

describe('arrangeSpells', () => {
  test('keeps Flash on F for an F-flash player', () => {
    expect(arrangeSpells([FLASH, EXHAUST], [IGNITE, FLASH])).toEqual([EXHAUST, FLASH]);
  });

  test('keeps Flash on D for a D-flash player', () => {
    expect(arrangeSpells([EXHAUST, FLASH], [FLASH, HEAL])).toEqual([FLASH, EXHAUST]);
  });

  test('uses the recommended order when the user has no Flash', () => {
    expect(arrangeSpells([FLASH, EXHAUST], [IGNITE, HEAL])).toEqual([FLASH, EXHAUST]);
  });

  test('Flash wins its key over another spell already on the other key', () => {
    expect(arrangeSpells([IGNITE, FLASH], [FLASH, IGNITE])).toEqual([FLASH, IGNITE]);
  });

  test('keeps other already-owned spells on their key', () => {
    expect(arrangeSpells([IGNITE, EXHAUST], [EXHAUST, HEAL])).toEqual([EXHAUST, IGNITE]);
  });
});

describe('spellsPatch', () => {
  test('null when the spells are already right', () => {
    expect(spellsPatch([FLASH, IGNITE], [IGNITE, FLASH])).toBeNull();
  });

  test('patch body otherwise', () => {
    expect(spellsPatch([FLASH, EXHAUST], [IGNITE, FLASH])).toEqual({
      spell1Id: EXHAUST,
      spell2Id: FLASH,
    });
  });
});
