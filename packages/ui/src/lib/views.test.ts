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

test('autoView: a champion select starting leaves the draft planner, whatever busy says', () => {
  for (const busy of [false, true]) {
    expect(autoView('draft', { wasInSelect: false, inSelect: true, busy })).toBe('select');
  }
});

test('autoView: the draft planner is never left otherwise', () => {
  for (const busy of [false, true]) {
    // Opened during the champion select or its game: its end keeps it.
    expect(autoView('draft', { wasInSelect: true, inSelect: false, busy })).toBe('draft');
    expect(autoView('draft', { wasInSelect: true, inSelect: true, busy })).toBe('draft');
    expect(autoView('draft', { wasInSelect: false, inSelect: false, busy })).toBe('draft');
  }
});

test('autoView: the patch notes, like the draft planner, stay after a champion select ends', () => {
  expect(autoView('patches', { wasInSelect: true, inSelect: false, busy: false })).toBe('patches');
  expect(autoView('patches', { wasInSelect: false, inSelect: true, busy: false })).toBe('select');
});
