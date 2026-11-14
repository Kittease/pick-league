import { expect, test } from 'bun:test';
import { autoView } from './views';

test('autoView: a champion select starting shows it, unless a champion is being read', () => {
  expect(autoView('tierlist', { wasInSelect: false, inSelect: true, busy: false })).toBe('select');
  expect(autoView('tierlist', { wasInSelect: false, inSelect: true, busy: true })).toBe('tierlist');
  expect(autoView('select', { wasInSelect: false, inSelect: true, busy: true })).toBe('select');
});

test('autoView: its end goes back to the tier list', () => {
  expect(autoView('select', { wasInSelect: true, inSelect: false, busy: false })).toBe('tierlist');
  expect(autoView('tierlist', { wasInSelect: true, inSelect: false, busy: true })).toBe('tierlist');
});

test('autoView: leaving a running champion select (nav, Escape) is not undone', () => {
  for (const busy of [false, true]) {
    expect(autoView('tierlist', { wasInSelect: true, inSelect: true, busy })).toBe('tierlist');
    expect(autoView('select', { wasInSelect: true, inSelect: true, busy })).toBe('select');
    expect(autoView('tierlist', { wasInSelect: false, inSelect: false, busy })).toBe('tierlist');
  }
});
