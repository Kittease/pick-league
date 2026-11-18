import { describe, expect, test } from 'bun:test';
import { pickStatsPatches } from './stats-patches.ts';

describe('pickStatsPatches', () => {
  test('both kept patches have stats: the newest is current', () => {
    expect(pickStatsPatches(['15.23', '15.22'], ['15.23', '15.22'])).toEqual({
      current: '15.23',
      previous: '15.22',
    });
  });

  test('the newest patch has no stats yet: the one before it is current', () => {
    expect(pickStatsPatches(['15.23', '15.22'], ['15.22'])).toEqual({
      current: '15.22',
      previous: null,
    });
    expect(pickStatsPatches(['15.23', '15.22', '15.21'], ['15.22', '15.21'])).toEqual({
      current: '15.22',
      previous: '15.21',
    });
  });

  test('no stats at all (new database): the newest patch is current', () => {
    expect(pickStatsPatches(['15.23', '15.22'], [])).toEqual({
      current: '15.23',
      previous: '15.22',
    });
  });

  test('a single kept patch', () => {
    expect(pickStatsPatches(['15.22'], ['15.22'])).toEqual({ current: '15.22', previous: null });
  });

  test('no patch: null', () => {
    expect(pickStatsPatches([], [])).toBeNull();
  });

  test('a patch with stats that is no longer kept is ignored', () => {
    expect(pickStatsPatches(['15.23', '15.22'], ['15.21'])).toEqual({
      current: '15.23',
      previous: '15.22',
    });
  });
});
