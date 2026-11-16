import { describe, expect, test } from 'bun:test';
import { arrangeSpells, FLASH_SPELL_ID, isFlashKey } from './spells';

const FLASH = FLASH_SPELL_ID;
const IGNITE = 14;
const EXHAUST = 3;
const HEAL = 7;

describe('arrangeSpells', () => {
  test('puts Flash on F when F is chosen, whatever the recommended order', () => {
    expect(arrangeSpells([FLASH, EXHAUST], [IGNITE, HEAL], 'F')).toEqual([EXHAUST, FLASH]);
    expect(arrangeSpells([EXHAUST, FLASH], [IGNITE, HEAL], 'F')).toEqual([EXHAUST, FLASH]);
  });

  test('puts Flash on D when D is chosen, whatever the recommended order', () => {
    expect(arrangeSpells([FLASH, EXHAUST], [IGNITE, HEAL], 'D')).toEqual([FLASH, EXHAUST]);
    expect(arrangeSpells([EXHAUST, FLASH], [IGNITE, HEAL], 'D')).toEqual([FLASH, EXHAUST]);
  });

  test('moves Flash off the key the user had it on when the setting says otherwise', () => {
    expect(arrangeSpells([FLASH, IGNITE], [IGNITE, FLASH], 'D')).toEqual([FLASH, IGNITE]);
    expect(arrangeSpells([FLASH, IGNITE], [FLASH, IGNITE], 'F')).toEqual([IGNITE, FLASH]);
  });

  test('without Flash, keeps already-owned spells on their key', () => {
    expect(arrangeSpells([IGNITE, EXHAUST], [EXHAUST, HEAL], 'F')).toEqual([EXHAUST, IGNITE]);
    expect(arrangeSpells([IGNITE, EXHAUST], [EXHAUST, HEAL], 'D')).toEqual([EXHAUST, IGNITE]);
  });

  test('without Flash, a new spell takes the key Flash leaves free', () => {
    expect(arrangeSpells([IGNITE, EXHAUST], [IGNITE, FLASH], 'D')).toEqual([IGNITE, EXHAUST]);
  });

  test('without Flash or owned spells, uses the recommended order', () => {
    expect(arrangeSpells([IGNITE, EXHAUST], [FLASH, HEAL], 'F')).toEqual([IGNITE, EXHAUST]);
  });
});

describe('isFlashKey', () => {
  test('accepts only D and F', () => {
    expect(isFlashKey('D')).toBe(true);
    expect(isFlashKey('F')).toBe(true);
    expect(isFlashKey('d')).toBe(false);
    expect(isFlashKey(undefined)).toBe(false);
  });
});
