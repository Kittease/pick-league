import { describe, expect, test } from 'bun:test';
import {
  damageLabel,
  damageShares,
  GAME_LENGTH_CLEAR,
  gameLengthTakeaway,
  gameLengthTitle,
  gameLengthVerdict,
  roundedShares,
  teamGameLengthText,
} from './outlook';

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

const team = (early: number, late: number, champions = 2) => ({ early, late, champions });

describe('team game length text', () => {
  test('strong, weak or even for each part', () => {
    expect(teamGameLengthText(team(0.024, -0.018))).toBe(
      'Stronger early (+2.4%) — falls off late (-1.8%)',
    );
    expect(teamGameLengthText(team(-0.024, 0.018))).toBe(
      'Weaker early (-2.4%) — scales late (+1.8%)',
    );
    expect(teamGameLengthText(team(0.01, 0.02))).toBe('Even early — scales late (+2.0%)');
    expect(teamGameLengthText(team(0.03, -0.01))).toBe('Stronger early (+3.0%) — even late');
  });

  test('both parts even, no champion with a profile, no data', () => {
    expect(teamGameLengthText(team(0.014, -0.014))).toBe('No clear early or late lean');
    expect(teamGameLengthText(team(0, 0, 0))).toBe('—');
    expect(teamGameLengthText(null)).toBe('—');
    expect(teamGameLengthText(undefined)).toBe('—');
  });

  test('title names the buckets and the champions counted', () => {
    expect(gameLengthTitle(team(0, 0, 3))).toContain('under 25 min and of 32 min or more');
    expect(gameLengthTitle(team(0, 0, 3))).toContain('(3 champions with enough games)');
    expect(gameLengthTitle(team(0, 0, 1))).toContain('(1 champion with enough games)');
  });
});

describe('game length verdict and takeaway', () => {
  const scale = { allies: team(-0.02, 0.03), enemies: team(0.02, -0.01) };
  const rush = { allies: scale.enemies, enemies: scale.allies };
  const even = { allies: team(0.01, 0.01), enemies: team(0, 0.01) };

  test('the late-minus-early gap between the teams decides', () => {
    expect(gameLengthVerdict(scale)).toBe('allies_scale');
    expect(gameLengthVerdict(rush)).toBe('enemies_scale');
    expect(gameLengthVerdict(even)).toBe('even');
    // Exactly at the threshold.
    expect(gameLengthVerdict({ allies: team(0, GAME_LENGTH_CLEAR), enemies: team(0, 0) })).toBe(
      'allies_scale',
    );
  });

  test('even while a team has no champion with a profile yet', () => {
    expect(gameLengthVerdict({ allies: scale.allies, enemies: team(0, 0, 0) })).toBe('even');
    expect(gameLengthVerdict({ allies: team(0, 0, 0), enemies: rush.enemies })).toBe('even');
  });

  test('takeaway sentences', () => {
    expect(gameLengthTakeaway(scale, 'Your team', 'Enemy', true)).toBe(
      'You outscale: play for late',
    );
    expect(gameLengthTakeaway(rush, 'Your team', 'Enemy', true)).toBe('They outscale: end early');
    expect(gameLengthTakeaway(scale, 'Blue', 'Red', false)).toBe(
      'Blue outscales: Red wants a short game',
    );
    expect(gameLengthTakeaway(rush, 'Blue', 'Red', false)).toBe(
      'Red outscales: Blue wants a short game',
    );
    expect(gameLengthTakeaway(even, 'Blue', 'Red', false)).toBeNull();
    expect(gameLengthTakeaway(undefined, 'Blue', 'Red', false)).toBeNull();
  });
});
