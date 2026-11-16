import { describe, expect, test } from 'bun:test';
import { damageLabel, damageShares, roundedShares } from './outlook';

describe('damage shares', () => {
  test('split of the summed damage per minute', () => {
    const s = damageShares({ physical: 870, magic: 255, true: 75, champions: [] });
    expect(s?.perMinute).toBe(1200);
    expect(s?.physical).toBeCloseTo(0.725);
    expect(damageLabel(s as NonNullable<typeof s>)).toBe('AD 73% · AP 21% · true 6%');
  });

  test('null without damage', () => {
    expect(damageShares(null)).toBeNull();
    expect(damageShares({ physical: 0, magic: 0, true: 0, champions: [] })).toBeNull();
  });

  test('rounded percentages always add up to 100', () => {
    const r = roundedShares({ physical: 1 / 3, magic: 1 / 3, true: 1 / 3, perMinute: 3 });
    expect(r.physical + r.magic + r.true).toBe(100);
    expect(r).toEqual({ physical: 34, magic: 33, true: 33 });
  });
});
