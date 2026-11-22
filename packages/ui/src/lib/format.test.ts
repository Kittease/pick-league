import { expect, test } from 'bun:test';
import type { LanePhaseDiff } from '@pick-league/shared';
import {
  deltaPoints,
  deltaSign,
  laneGoldShort,
  lanePhaseText,
  laneTitle,
  lateSwapText,
  signedNumber,
  timeAgo,
} from './format';

test('deltaPoints: no sign when the value rounds to zero', () => {
  expect(deltaPoints(0.028)).toBe('+2.8');
  expect(deltaPoints(-0.013)).toBe('-1.3');
  expect(deltaPoints(-0.0003)).toBe('0.0');
  expect(deltaPoints(0.0004)).toBe('0.0');
  expect(deltaPoints(0)).toBe('0.0');
  expect(deltaSign(-0.0003)).toBe(0);
  expect(deltaSign(-0.0006)).toBe(-1);
});

test('timeAgo', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const ago = (s: number) => timeAgo(new Date(now - s * 1000).toISOString(), now);
  expect(ago(10)).toBe('just now');
  expect(ago(12 * 60)).toBe('12 min ago');
  expect(ago(3 * 3600)).toBe('3 h ago');
  expect(ago(3 * 86400)).toBe('3 d ago');
  expect(timeAgo(new Date(now + 5000).toISOString(), now)).toBe('just now');
});

test('signedNumber: true minus, thousands, no sign at zero', () => {
  expect(signedNumber(420)).toBe('+420');
  expect(signedNumber(-1240)).toBe('−1,240');
  expect(signedNumber(-0.4)).toBe('0');
  expect(signedNumber(-0.44, 1)).toBe('−0.4');
  expect(signedNumber(0)).toBe('0');
});

test('lane phase texts', () => {
  const lane: LanePhaseDiff = { minute: 10, gold: -420, xp: -310, cs: -8, duo: true, games: 1312 };
  expect(lanePhaseText(lane)).toBe('−420 gold · −8 CS · −310 XP at 10 min');
  expect(lanePhaseText({ ...lane, cs: -12.4, minute: 15 })).toBe(
    '−420 gold · −12 CS · −310 XP at 15 min',
  );
  expect(lanePhaseText({ ...lane, cs: 0.5 })).toContain('+0.5 CS');
  expect(laneGoldShort({ ...lane, gold: 250 })).toBe('+250g @10');
  expect(laneGoldShort({ ...lane, gold: -1240 })).toBe('−1.2kg @10');
  expect(laneTitle(lane)).toBe(
    'Lane at 10 min (bot lane 2v2, with the duo partners): −420 gold, −8 CS, −310 XP, average over 1,312 matchups (shrunk by sample size)',
  );
  expect(laneTitle({ ...lane, duo: false })).toContain('(1v1)');
});

test('late-game swap: games and the rounded minute', () => {
  expect(lateSwapText({ games: 42, minute: 37.6 })).toBe('42 games · ~38 min');
  expect(lateSwapText({ games: 1240, minute: 31.2 })).toBe('1.2k games · ~31 min');
});
