import { describe, expect, test } from 'bun:test';
import {
  byDivisionThenLp,
  type DiamondEntry,
  selectDiamondPlayers,
  toDiamondEntries,
} from './platform-worker.ts';
import { diamondEntry } from './test-helpers.ts';

const entry = (puuid: string, division: number, leaguePoints: number): DiamondEntry => ({
  puuid,
  division,
  leaguePoints,
  wins: 10,
  losses: 10,
  seenAt: 0,
});
const puuids = (list: readonly DiamondEntry[]) => list.map((e) => e.puuid);

describe('toDiamondEntries', () => {
  test('keeps the solo queue Diamond entries with a puuid, as the division asked for', () => {
    const page = [
      diamondEntry('fake-d-1', 'II', 75, 40),
      { ...diamondEntry('fake-flex', 'II', 10, 1), queueType: 'RANKED_FLEX_SR' },
      { ...diamondEntry('fake-emerald', 'II', 10, 1), tier: 'EMERALD' },
      { ...diamondEntry('', 'II', 10, 1) },
    ];
    expect(toDiamondEntries(page, 2, 1234)).toEqual([
      { puuid: 'fake-d-1', division: 2, leaguePoints: 75, wins: 40, losses: 10, seenAt: 1234 },
    ]);
  });
});

describe('selectDiamondPlayers', () => {
  const candidates = [
    entry('fake-one-40', 1, 40),
    entry('fake-two-99', 2, 99),
    entry('fake-one-90', 1, 90),
    entry('fake-four-80', 4, 80),
    entry('fake-one-70', 1, 70),
    entry('fake-two-10', 2, 10),
    entry('fake-one-20', 1, 20),
  ];
  const withMaster = new Set(['fake-two-99', 'fake-one-40', 'fake-four-80', 'fake-two-10']);

  test('Diamond players are ordered by division, then LP', () => {
    expect(puuids([...candidates].sort(byDivisionThenLp))).toEqual([
      'fake-one-90',
      'fake-one-70',
      'fake-one-40',
      'fake-one-20',
      'fake-two-99',
      'fake-two-10',
      'fake-four-80',
    ]);
  });

  test('those seen in a Master+ game first, whatever the budget; no one else without it', () => {
    const s = selectDiamondPlayers(candidates, withMaster, 10, 0);
    expect(puuids(s.withMaster)).toEqual([
      'fake-one-40',
      'fake-two-99',
      'fake-two-10',
      'fake-four-80',
    ]);
    expect(s.diamondOne).toEqual([]);
    // What the budget could add next: Diamond I only, by LP.
    expect(puuids(s.reserve)).toEqual(['fake-one-90', 'fake-one-70', 'fake-one-20']);
  });

  test('then Diamond I players by LP, as many as the budget allows', () => {
    const s = selectDiamondPlayers(candidates, withMaster, 10, 2);
    expect(puuids(s.withMaster)).toHaveLength(4);
    expect(puuids(s.diamondOne)).toEqual(['fake-one-90', 'fake-one-70']);
    expect(puuids(s.reserve)).toEqual(['fake-one-20']);
  });

  test('the cap holds for both groups together, the first group first', () => {
    const five = selectDiamondPlayers(candidates, withMaster, 5, 3);
    expect(puuids(five.withMaster)).toHaveLength(4);
    expect(puuids(five.diamondOne)).toEqual(['fake-one-90']);
    expect(puuids(five.reserve)).toEqual(['fake-one-70', 'fake-one-20']);

    const three = selectDiamondPlayers(candidates, withMaster, 3, 3);
    expect(puuids(three.withMaster)).toEqual(['fake-one-40', 'fake-two-99', 'fake-two-10']);
    expect(three.diamondOne).toEqual([]);

    const none = selectDiamondPlayers(candidates, withMaster, 0, 3);
    expect([...none.withMaster, ...none.diamondOne]).toEqual([]);
  });
});
