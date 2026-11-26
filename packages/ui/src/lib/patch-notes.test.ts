import { describe, expect, test } from 'bun:test';
import type { PatchChangeSetSummary, PatchNoteChange } from '@pick-league/shared';
import {
  changeText,
  formatValue,
  formatValues,
  itemsByChampion,
  patchSelection,
  sameSelection,
  selectorPatches,
  shortDate,
  visibleChanges,
} from './patch-notes';

const set = (over: Partial<PatchChangeSetSummary>): PatchChangeSetSummary => ({
  patch: '15.22',
  build: '15.22.200',
  kind: 'patch',
  source: 'live',
  basePatch: '15.21',
  baseBuild: '15.21.100',
  detectedAt: '2026-11-20T10:00:00.000Z',
  changedChampions: 3,
  changedItems: 1,
  gameplayChanged: true,
  ...over,
});

describe('selectorPatches', () => {
  test('gameplay hotfixes listed under their patch, quiet ones counted', () => {
    const entries = selectorPatches({
      patches: [
        {
          patch: '15.22',
          sets: [
            set({}),
            set({
              build: '15.22.300',
              kind: 'hotfix',
              changedChampions: 0,
              changedItems: 0,
              gameplayChanged: false,
            }),
            set({
              build: '15.22.400',
              kind: 'hotfix',
              changedChampions: 1,
              changedItems: 0,
              detectedAt: '2026-11-21T09:00:00.000Z',
            }),
          ],
        },
        { patch: '15.21', sets: [set({ patch: '15.21', build: '15.21.100', source: 'backfill' })] },
      ],
    });
    expect(entries.map((e) => e.patch)).toEqual(['15.22', '15.21']);
    expect(entries[0]?.hotfixes.map((h) => h.build)).toEqual(['15.22.400']);
    expect(entries[0]?.quietHotfixes).toBe(1);
    expect(entries[1]?.diff?.source).toBe('backfill');
    expect(patchSelection(entries[0] as never)).toEqual({ patch: '15.22' });
  });

  test('a patch seen through its hotfixes only selects the first one', () => {
    const [entry] = selectorPatches({
      patches: [{ patch: '15.22', sets: [set({ kind: 'hotfix', build: '15.22.300' })] }],
    });
    expect(entry && patchSelection(entry)).toEqual({ patch: '15.22', build: '15.22.300' });
  });

  test('sameSelection', () => {
    expect(sameSelection({ patch: '15.22' }, { patch: '15.22' })).toBe(true);
    expect(sameSelection({ patch: '15.22' }, { patch: '15.22', build: '15.22.300' })).toBe(false);
    expect(sameSelection(null, { patch: '15.22' })).toBe(false);
  });
});

describe('formatting', () => {
  test('values in their unit', () => {
    expect(formatValue(1.15, 'percent')).toBe('115%');
    expect(formatValue(0.075, 'percent')).toBe('7.5%');
    expect(formatValue(9, 'percentPoints')).toBe('9%');
    expect(formatValue(16.5, 'seconds')).toBe('16.5s');
    expect(formatValue(0.66667, 'flat')).toBe('0.67');
  });

  test('ranks joined, a value repeated on every rank once, absent as a dash', () => {
    expect(formatValues([350, 550, 750], 'flat')).toBe('350 / 550 / 750');
    expect(formatValues([15, 15, 15, 15, 15], 'seconds')).toBe('15s');
    expect(formatValues([17, 16.5, 16, 15.5, 15], 'seconds')).toBe(
      '17s / 16.5s / 16s / 15.5s / 15s',
    );
    expect(formatValues(null, 'flat')).toBe('—');
    expect(changeText({ oldValues: [1], newValues: [1.15], unit: 'percent' })).toEqual({
      from: '100%',
      to: '115%',
    });
  });

  test('shortDate', () => {
    expect(shortDate('2026-11-21T09:00:00.000Z')).toBe('Nov 21');
  });
});

test('itemsByChampion: each champion with the changed items it builds, most built first', () => {
  const links = itemsByChampion([
    {
      itemId: 1,
      name: 'A',
      verdict: 'nerf',
      users: [{ championId: 81, role: 'BOTTOM', share: 0.3, games: 300 }],
    },
    {
      itemId: 2,
      name: 'B',
      verdict: 'buff',
      users: [
        { championId: 81, role: 'BOTTOM', share: 0.6, games: 600 },
        { championId: 81, role: 'MIDDLE', share: 0.7, games: 70 },
      ],
    },
  ]);
  expect(links.get(81)?.map((l) => [l.itemId, l.role])).toEqual([
    [2, 'MIDDLE'],
    [1, 'BOTTOM'],
  ]);
});

test('visibleChanges hides technical values and the groups they empty', () => {
  const change = (category: PatchNoteChange['category']) => ({ category }) as PatchNoteChange;
  const groups = [
    { slot: 'Q', changes: [change('damage'), change('technical')] },
    { slot: 'W', changes: [change('technical')] },
  ];
  expect(visibleChanges(groups, false).map((g) => [g.slot, g.changes.length])).toEqual([['Q', 1]]);
  expect(visibleChanges(groups, true)).toHaveLength(2);
});
