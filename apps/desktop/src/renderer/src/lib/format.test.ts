import { expect, test } from 'bun:test';
import { timeAgo } from './format';

test('timeAgo', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const ago = (s: number) => timeAgo(new Date(now - s * 1000).toISOString(), now);
  expect(ago(10)).toBe('just now');
  expect(ago(12 * 60)).toBe('12 min ago');
  expect(ago(3 * 3600)).toBe('3 h ago');
  expect(ago(3 * 86400)).toBe('3 d ago');
  expect(timeAgo(new Date(now + 5000).toISOString(), now)).toBe('just now');
});
