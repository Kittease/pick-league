import { describe, expect, test } from 'bun:test';
import { diffChampion, diffItems, extractItems, ratioName, type ValueChange } from './diff.ts';

/** Trimmed Community Dragon files of 16.22 and 16.23 (champion records and a few spells, a few items). */
async function fixture(patch: '16.22' | '16.23', name: string): Promise<unknown> {
  return Bun.file(new URL(`./fixtures/${patch}/${name}.bin.json`, import.meta.url)).json();
}

async function diffFixture(alias: string) {
  return diffChampion(alias, await fixture('16.22', alias), await fixture('16.23', alias));
}

const brief = (c: ValueChange) => ({
  slot: c.slot,
  spellName: c.spellName,
  calculation: c.calculation,
  valueName: c.valueName,
  oldValues: c.oldValues,
  newValues: c.newValues,
});

describe('diffChampion', () => {
  test('Ezreal 16.23: per-rank values from rank 1 to the max rank, ratios named, Arena overrides ignored', async () => {
    const res = await diffFixture('ezreal');
    expect(res?.status).toBe('changed');
    expect(res?.changes.map(brief)).toEqual([
      {
        slot: 'W',
        spellName: 'EzrealW',
        calculation: null,
        valueName: 'APRatio',
        oldValues: [0.9, 0.9, 0.9, 0.9, 0.9],
        newValues: [1, 1, 1, 1, 1],
      },
      {
        slot: 'W',
        spellName: 'EzrealW',
        calculation: 'Damage',
        valueName: 'bonusAdRatio',
        oldValues: [1],
        newValues: [1.15],
      },
      {
        slot: 'R',
        spellName: 'EzrealR',
        calculation: null,
        valueName: 'BaseDamage',
        oldValues: [350, 550, 750],
        newValues: [350, 600, 850],
      },
      {
        slot: 'R',
        spellName: 'EzrealR',
        calculation: null,
        valueName: 'RAPRatio',
        oldValues: [1.1, 1.1, 1.1],
        newValues: [1.2, 1.2, 1.2],
      },
      {
        slot: 'R',
        spellName: 'EzrealR',
        calculation: 'Damage',
        valueName: 'bonusAdRatio',
        oldValues: [1],
        newValues: [1.1],
      },
    ]);
    expect(res?.changes[0]?.path).toBe(
      'Characters/Ezreal/Spells/EzrealWAbility/EzrealW/mSpell/DataValues/APRatio/values',
    );
  });

  test('Azir 16.23: a base stat', async () => {
    const res = await diffFixture('azir');
    expect(res?.changes.map(brief)).toEqual([
      {
        slot: 'base',
        spellName: null,
        calculation: null,
        valueName: 'attackRange',
        oldValues: [525],
        newValues: [550],
      },
    ]);
  });

  test.each([
    ['yorick', 'Arena values only'],
    ['sona', 'a skin and Arena values only'],
    ['jayce', 'recommended skill orders and tool data only'],
  ])('%s 16.23: %s, no change', async (alias) => {
    expect(await diffFixture(alias)).toBeNull();
  });

  test('a champion without a previous file is new', async () => {
    expect(diffChampion('azir', null, await fixture('16.23', 'azir'))).toEqual({
      key: 'azir',
      status: 'new',
      changes: [],
    });
  });

  test('a file without a character record is an error', () => {
    expect(() => diffChampion('x', {}, {})).toThrow('no character record');
  });

  const root = (spells: string[], extra: Record<string, unknown> = {}) => ({
    'Characters/Fake/CharacterRecords/Root': {
      mCharacterName: 'Fake',
      spells,
      mAbilities: spells.map((s) => s.slice(0, s.lastIndexOf('/'))),
      __type: 'CharacterRecord',
      ...extra,
    },
  });
  const spell = (name: string, mSpell: Record<string, unknown>) => ({
    ObjectName: name,
    mScriptName: name,
    mSpell,
    __type: 'SpellObject',
  });
  const SPELLS = ['Q', 'W', 'E', 'R'].map((s) => `Characters/Fake/Spells/Fake${s}Ability/Fake${s}`);

  test('slot 0 and the slots above the max rank are ignored; costs start at rank 1', () => {
    const file = (cd: number[], cost: number[]) => ({
      ...root(SPELLS),
      [SPELLS[3] as string]: spell('FakeR', {
        cooldownTime: cd,
        Cooldown: { values: cd, '{0a3e0478}': cd[1], __type: '{0a0eddc9}' },
        manaValues: { values: cost, '{0a3e0478}': cost[0], __type: '{630af303}' },
      }),
    });
    expect(
      diffChampion(
        'fake',
        file([10, 120, 100, 80, 10, 10, 10], [100, 100, 100, 100, 100, 100]),
        file([150, 120, 100, 80, 99, 99, 99], [100, 100, 100, 50, 50, 50]),
      ),
    ).toBeNull();
    const res = diffChampion(
      'fake',
      file([10, 120, 100, 80, 10, 10, 10], [100, 100, 100, 100, 100, 100]),
      file([10, 110, 100, 80, 10, 10, 10], [90, 100, 100, 100, 100, 100]),
    );
    expect(res?.changes.map((c) => [c.valueName, c.oldValues, c.newValues])).toEqual([
      ['Cooldown', [120, 100, 80], [110, 100, 80]],
      ['Cost', [100, 100, 100], [90, 100, 100]],
    ]);
  });

  test('a spell moved or re-keyed in the file is the same spell; a new one is one row', () => {
    const values = { DataValues: [{ name: 'BaseDamage', values: [0, 1, 2, 3, 4, 5, 6] }] };
    const before = {
      ...root(SPELLS),
      'Characters/Fake/Spells/FakeRMis': spell('FakeRMis', values),
    };
    const after = {
      ...root(SPELLS),
      '{5723d947}': spell('FakeRMis', values),
      'Characters/Fake/Spells/FakeQAbility/FakeQBuff': spell('FakeQBuff', values),
    };
    expect(diffChampion('fake', before, after)?.changes.map(brief)).toEqual([
      {
        slot: 'Q',
        spellName: 'FakeQBuff',
        calculation: null,
        valueName: 'added',
        oldValues: null,
        newValues: null,
      },
    ]);
  });

  test('a value left out of the file is its default, 0', () => {
    const file = (extra: Record<string, unknown>) => ({
      ...root(SPELLS),
      [SPELLS[0] as string]: spell('FakeQ', { flags: 4, ...extra }),
    });
    expect(diffChampion('fake', file({}), file({ RemoveWhenOnCooldown: false }))).toBeNull();
    expect(diffChampion('fake', file({}), file({ castConeDistance: 100 }))?.changes).toHaveLength(
      1,
    );
  });

  test('a field known only by its hash that appears or disappears is not a change', () => {
    const file = (extra: Record<string, unknown>) => ({
      ...root(SPELLS),
      [SPELLS[1] as string]: spell('FakeW', { flags: 4, ...extra }),
    });
    expect(diffChampion('fake', file({ '{bffdf499}': [18, 17, 16] }), file({}))).toBeNull();
    expect(
      diffChampion('fake', file({ '{bffdf499}': 1 }), file({ '{bffdf499}': 2 }))?.changes,
    ).toHaveLength(1);
  });

  test('an unnamed list entry that moved is not a change', () => {
    const file = (conditions: unknown[]) => ({
      ...root(SPELLS),
      [SPELLS[2] as string]: spell('FakeE', { mConditions: conditions }),
    });
    const a = { level: 1, __type: 'A' };
    const b = { InvertResult: true, __type: 'B' };
    expect(diffChampion('fake', file([a, b]), file([b, a]))).toBeNull();
    expect(diffChampion('fake', file([a, b]), file([b, { level: 2 }]))?.changes.map(brief)).toEqual(
      [
        {
          slot: 'E',
          spellName: 'FakeE',
          calculation: null,
          valueName: 'level',
          oldValues: [1],
          newValues: null,
        },
        {
          slot: 'E',
          spellName: 'FakeE',
          calculation: null,
          valueName: 'level',
          oldValues: null,
          newValues: [2],
        },
      ],
    );
  });

  test('a spell moved under its ultimate is compared on the ultimate ranks', () => {
    const missile = spell('FakeRMis', { cooldownTime: [10, 60, 60, 60, 10, 10, 10] });
    const moved = spell('FakeRMis', { cooldownTime: [10, 60, 60, 60, 0, 0, 0] });
    const before = { ...root(SPELLS), 'Characters/Fake/Spells/FakeRMis': missile };
    const after = { ...root(SPELLS), 'Characters/Fake/Spells/FakeRAbility/FakeRMis': moved };
    expect(diffChampion('fake', before, after)).toBeNull();
  });

  test('a transformed form ability takes its letter, the passive ability is P', () => {
    const file = (ratio: number) => ({
      ...root(SPELLS, {
        mAbilities: [
          ...SPELLS.map((s) => s.slice(0, s.lastIndexOf('/'))),
          'Characters/Fake/Spells/FakeBigQAbility',
          'Characters/Fake/Spells/FakeTraitAbility',
        ],
      }),
      'Characters/Fake/Spells/FakeTraitAbility': { mType: 3, __type: 'AbilityObject' },
      'Characters/Fake/Spells/FakeBigQAbility/FakeBigQ': spell('FakeBigQ', {
        mSpellCalculations: {
          Damage: {
            mFormulaParts: [
              { mDataValue: 'BaseDamage', __type: 'NamedDataValueCalculationPart' },
              { mStat: 2, mCoefficient: ratio, __type: 'StatByCoefficientCalculationPart' },
              { mCoefficient: ratio, __type: 'StatByCoefficientCalculationPart' },
            ],
          },
          DamageTooltip: {
            mFormulaParts: [{ mCoefficient: ratio, __type: 'StatByCoefficientCalculationPart' }],
          },
        },
      }),
      'Characters/Fake/Spells/FakeTraitAbility/FakeTrait': spell('FakeTrait', {
        DataValues: [
          { name: 'Heal', values: [ratio, ratio, ratio, ratio, ratio, ratio, ratio] },
          { name: 'CherryHeal', values: [ratio, ratio, ratio, ratio, ratio, ratio, ratio] },
        ],
      }),
    });
    const res = diffChampion('fake', file(1), file(2));
    expect(res?.changes.map((c) => [c.slot, c.spellName, c.calculation, c.valueName])).toEqual([
      ['P', 'FakeTrait', null, 'Heal'],
      ['Q', 'FakeBigQ', 'Damage', 'adRatio'],
      ['Q', 'FakeBigQ', 'Damage', 'apRatio'],
    ]);
    expect(res?.changes[0]?.newValues).toEqual([2, 2, 2, 2, 2, 2]);
  });
});

describe('diffItems', () => {
  test('16.23: Voltaic Cyclosword and Perplexity; Arena copies and particles ignored', async () => {
    const res = diffItems(
      extractItems(await fixture('16.22', 'items.cdtb')),
      extractItems(await fixture('16.23', 'items.cdtb')),
    );
    expect(
      res.map((r) => ({ id: r.key, status: r.status, changes: r.changes.map(brief) })),
    ).toEqual([
      {
        id: 4015,
        status: 'changed',
        changes: [
          {
            slot: null,
            spellName: null,
            calculation: null,
            valueName: 'percentBaseMPRegenMod',
            oldValues: null,
            newValues: [5],
          },
        ],
      },
      {
        id: 6699,
        status: 'changed',
        changes: [
          {
            slot: null,
            spellName: null,
            calculation: null,
            valueName: 'PercentCurrentHPMelee',
            oldValues: [9],
            newValues: [8],
          },
          {
            slot: null,
            spellName: null,
            calculation: null,
            valueName: 'PercentCurrentHPRanged',
            oldValues: [7],
            newValues: [6],
          },
        ],
      },
    ]);
  });

  test('new and removed items', () => {
    const item = (id: number) => ({ itemID: id, price: 300, __type: 'ItemData' });
    const res = diffItems(
      extractItems({ 'Items/1001': item(1001), 'Items/1004': item(1004) }),
      extractItems({ 'Items/1001': item(1001), 'Items/1006': item(1006) }),
    );
    expect(res.map((r) => [r.key, r.status])).toEqual([
      [1004, 'removed'],
      [1006, 'new'],
    ]);
  });
});

test('ratioName', () => {
  expect(ratioName(2, 2)).toBe('bonusAdRatio');
  expect(ratioName(0, 0)).toBe('apRatio');
  expect(ratioName(11, 1)).toBe('baseHealthRatio');
  expect(ratioName(99, 0)).toBe('stat99Ratio');
});
