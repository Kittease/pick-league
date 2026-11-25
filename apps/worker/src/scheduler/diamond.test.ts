import { describe, expect, test } from 'bun:test';
import {
  BestDiamonds,
  byDivisionThenLp,
  type DiamondEntry,
  nextDiamondTarget,
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

  test('seen in a Master+ game first (any division, by division then LP), then the other Diamond I players by LP', () => {
    const s = selectDiamondPlayers(candidates, withMaster, 10);
    expect(puuids(s.tracked)).toEqual([
      'fake-one-40',
      'fake-two-99',
      'fake-two-10',
      'fake-four-80',
      'fake-one-90',
      'fake-one-70',
      'fake-one-20',
    ]);
    expect(s.withMaster).toBe(4);
  });

  test('nobody else is a candidate: the lower divisions only through a Master+ game', () => {
    const all = [...candidates, entry('fake-three-50', 3, 50), entry('fake-two-60', 2, 60)];
    const s = selectDiamondPlayers(all, new Set(['fake-four-80']), 100);
    expect(puuids(s.tracked)).toEqual([
      'fake-four-80',
      'fake-one-90',
      'fake-one-70',
      'fake-one-40',
      'fake-one-20',
    ]);
    expect(s.withMaster).toBe(1);
  });

  test('the target holds for everyone: the best candidates of that order', () => {
    const five = selectDiamondPlayers(candidates, withMaster, 5);
    expect(puuids(five.tracked)).toEqual([
      'fake-one-40',
      'fake-two-99',
      'fake-two-10',
      'fake-four-80',
      'fake-one-90',
    ]);
    expect(five.withMaster).toBe(4);

    // No group is tracked without condition: a target under the first group cuts it.
    const three = selectDiamondPlayers(candidates, withMaster, 3);
    expect(puuids(three.tracked)).toEqual(['fake-one-40', 'fake-two-99', 'fake-two-10']);
    expect(three.withMaster).toBe(3);

    expect(selectDiamondPlayers(candidates, withMaster, 0).tracked).toEqual([]);
  });
});

describe('BestDiamonds', () => {
  test('keeps the best entries by division then LP, however many are added', () => {
    const best = new BestDiamonds(3);
    // 5,000 entries over the four divisions, in no particular order.
    const all = Array.from({ length: 5000 }, (_, i) =>
      entry(`fake-${String(i).padStart(4, '0')}`, 1 + (i % 4), (i * 7919) % 1009),
    );
    for (const e of all) best.add(e);
    expect(best.values()).toEqual([...all].sort(byDivisionThenLp).slice(0, 3));
    expect(best.values().every((e) => e.division === 1)).toBe(true);
  });

  test('nothing with a limit of 0', () => {
    const best = new BestDiamonds(0);
    best.add(entry('fake-a', 1, 10));
    expect(best.values()).toEqual([]);
  });
});

describe('nextDiamondTarget', () => {
  const rules = {
    cap: 5000,
    step: 500,
    growCycles: 24,
    growMinKeptCycles: 6,
    shrinkMissedCycles: 6,
  };
  const at = (target: number, tracked = target) => ({ target, tracked });

  test('grows a step after a full day with enough kept cycles, missed ones in between or not', () => {
    expect(nextDiamondTarget('K'.repeat(23), at(1000), rules)).toBeNull();
    expect(nextDiamondTarget('K'.repeat(24), at(1000), rules)?.target).toBe(1500);
    // The evening peak is missed, the quiet hours catch it up and run out of work: budget left.
    const day = `${'M'.repeat(18)}${'K'.repeat(6)}`;
    expect(nextDiamondTarget(day, at(1000), rules)?.target).toBe(1500);
    // Caught up in only five hours of the day: it stays.
    expect(nextDiamondTarget(`${'M'.repeat(19)}${'K'.repeat(5)}`, at(1000), rules)).toBeNull();
    // Only the last day counts.
    expect(nextDiamondTarget(`${'K'.repeat(6)}${'M'.repeat(5)}`, at(1000), rules)).toBeNull();
  });

  test('the cycles spent waiting for patch data are neither kept nor missed', () => {
    const day = `${'K'.repeat(5)}${'W'.repeat(13)}${'K'.repeat(6)}`;
    expect(day).toHaveLength(24);
    expect(nextDiamondTarget(day, at(1000), rules)?.target).toBe(1500);
    // But a day needs enough cycles that were really kept up with.
    const mostlyWaiting = `${'W'.repeat(19)}${'K'.repeat(5)}`;
    expect(nextDiamondTarget(mostlyWaiting, at(1000), rules)).toBeNull();
    // They do not count towards a shrink either: five missed, the wait, then a kept cycle.
    expect(nextDiamondTarget(`KMMMMM${'W'.repeat(13)}`, at(1000), rules)).toBeNull();
    expect(nextDiamondTarget(`KMMMMM${'W'.repeat(13)}K`, at(1000), rules)).toBeNull();
    expect(nextDiamondTarget(`KMMMMM${'W'.repeat(13)}M`, at(1000), rules)?.target).toBe(500);
  });

  test('a history written while the daily Master pass existed: its P and R cycles are neither', () => {
    const day = `${'K'.repeat(5)}${'P'.repeat(10)}RRR${'K'.repeat(6)}`;
    expect(nextDiamondTarget(day, at(1000), rules)?.target).toBe(1500);
    expect(nextDiamondTarget(`KMMMMM${'P'.repeat(10)}RRR`, at(1000), rules)).toBeNull();
  });

  test('shrinks a step once enough cycles were missed since the last kept one', () => {
    expect(nextDiamondTarget('KKMMMMM', at(1000), rules)).toBeNull();
    expect(nextDiamondTarget('KKMMMMMM', at(1000), rules)?.target).toBe(500);
    expect(nextDiamondTarget('MMMKMMMMM', at(1000), rules)).toBeNull();
    expect(nextDiamondTarget('MMMMMM', at(300), rules)?.target).toBe(0);
    expect(nextDiamondTarget('MMMMMM', at(0), rules)).toBeNull();
  });

  test('never above the ceiling, and only once the target is filled', () => {
    const day = 'K'.repeat(24);
    expect(nextDiamondTarget(day, at(4800), rules)?.target).toBe(5000);
    expect(nextDiamondTarget(day, at(5000), rules)).toBeNull();
    expect(nextDiamondTarget(day, at(1000, 700), rules)).toBeNull();
  });

  test('the thresholds are options', () => {
    const quick = { ...rules, growCycles: 3, growMinKeptCycles: 1, shrinkMissedCycles: 2 };
    expect(nextDiamondTarget('KWK', at(1000), quick)?.target).toBe(1500);
    expect(nextDiamondTarget('KMM', at(1000), quick)?.target).toBe(500);
  });
});
