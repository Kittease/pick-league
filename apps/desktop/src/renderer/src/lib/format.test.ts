import { expect, test } from 'bun:test';
import { deltaPoints, deltaSign, timeAgo } from './format';

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
