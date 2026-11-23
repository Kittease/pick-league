import { describe, expect, test } from 'bun:test';
import {
  BestDiamonds,
  byDivisionThenLp,
  classifyMissedCycle,
  type DiamondEntry,
  nextDiamondTarget,
  passOpenedAt,
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

  test('one order for every candidate: seen in a Master+ game first, then the others, each by division then LP', () => {
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

  test('the lower divisions are candidates too, after Diamond I', () => {
    const all = [...candidates, entry('fake-three-50', 3, 50), entry('fake-two-60', 2, 60)];
    const s = selectDiamondPlayers(all, new Set(['fake-four-80']), 100);
    expect(puuids(s.tracked)).toEqual([
      'fake-four-80',
      'fake-one-90',
      'fake-one-70',
      'fake-one-40',
      'fake-one-20',
      'fake-two-99',
      'fake-two-60',
      'fake-two-10',
      'fake-three-50',
    ]);
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

describe('passOpenedAt', () => {
  const at = (iso: string) => Date.parse(iso);
  const iso = (ms: number) => new Date(ms).toISOString();

  test('the latest start hour of the local time, a fixed offset from UTC', () => {
    // 04:00 in Korea (UTC+9) is 19:00 UTC the day before.
    expect(iso(passOpenedAt(at('2026-11-13T12:00:00Z'), 4, 9))).toBe('2026-11-12T19:00:00.000Z');
    expect(iso(passOpenedAt(at('2026-11-13T19:00:00Z'), 4, 9))).toBe('2026-11-13T19:00:00.000Z');
    expect(iso(passOpenedAt(at('2026-11-13T18:59:59Z'), 4, 9))).toBe('2026-11-12T19:00:00.000Z');
    // 04:00 in central Europe (UTC+1) is 03:00 UTC.
    expect(iso(passOpenedAt(at('2026-11-13T02:59:00Z'), 4, 1))).toBe('2026-11-12T03:00:00.000Z');
    expect(iso(passOpenedAt(at('2026-11-13T03:00:00Z'), 4, 1))).toBe('2026-11-13T03:00:00.000Z');
    // 04:00 in North America (UTC-6) is 10:00 UTC.
    expect(iso(passOpenedAt(at('2026-11-13T09:00:00Z'), 4, -6))).toBe('2026-11-12T10:00:00.000Z');
    expect(iso(passOpenedAt(at('2026-11-13T12:00:00Z'), 4, -6))).toBe('2026-11-13T10:00:00.000Z');
    // 04:00 in Vietnam (UTC+7) is 21:00 UTC the day before.
    expect(iso(passOpenedAt(at('2026-11-13T12:00:00Z'), 4, 7))).toBe('2026-11-12T21:00:00.000Z');
  });

  test('another start hour', () => {
    expect(iso(passOpenedAt(at('2026-11-13T12:00:00Z'), 0, 0))).toBe('2026-11-13T00:00:00.000Z');
    expect(iso(passOpenedAt(at('2026-11-13T12:00:00Z'), 23, 0))).toBe('2026-11-12T23:00:00.000Z');
  });
});

describe('classifyMissedCycle', () => {
  const quiet = { pass: false, patch: false };

  test('missed, unless something excuses it', () => {
    expect(classifyMissedCycle('KKK', quiet, 3)).toBe('M');
    expect(classifyMissedCycle('', quiet, 3)).toBe('M');
    expect(classifyMissedCycle('KKK', { pass: true, patch: false }, 3)).toBe('P');
    expect(classifyMissedCycle('KKK', { pass: false, patch: true }, 3)).toBe('W');
  });

  test('the first cycles after the daily pass absorb its backlog', () => {
    expect(classifyMissedCycle('KKPP', quiet, 3)).toBe('R');
    expect(classifyMissedCycle('KKPPR', quiet, 3)).toBe('R');
    expect(classifyMissedCycle('KKPPRR', quiet, 3)).toBe('R');
    expect(classifyMissedCycle('KKPPRRR', quiet, 3)).toBe('M');
    expect(classifyMissedCycle('KKPPRRRM', quiet, 3)).toBe('M');
    // Once the platform kept up after the pass, the recovery is over.
    expect(classifyMissedCycle('KKPPRK', quiet, 3)).toBe('M');
    expect(classifyMissedCycle('KKPP', quiet, 0)).toBe('M');
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

  test('grows a step after a full day of cycles without a missed one', () => {
    expect(nextDiamondTarget('K'.repeat(23), at(1000), rules)).toBeNull();
    expect(nextDiamondTarget('K'.repeat(24), at(1000), rules)?.target).toBe(1500);
    // One missed cycle in the day (the evening peak): not yet.
    expect(nextDiamondTarget(`${'K'.repeat(12)}M${'K'.repeat(11)}`, at(1000), rules)).toBeNull();
    // It leaves the window a day later.
    expect(nextDiamondTarget(`M${'K'.repeat(24)}`, at(1000), rules)?.target).toBe(1500);
  });

  test('the cycles of the daily Master pass and of its recovery are neither kept nor missed', () => {
    const day = `${'K'.repeat(5)}${'P'.repeat(10)}RRR${'K'.repeat(6)}`;
    expect(day).toHaveLength(24);
    expect(nextDiamondTarget(day, at(1000), rules)?.target).toBe(1500);
    // But a day needs enough cycles that were really kept up with.
    const mostlyPass = `${'P'.repeat(16)}RRR${'K'.repeat(5)}`;
    expect(nextDiamondTarget(mostlyPass, at(1000), rules)).toBeNull();
    // They do not count towards a shrink either: five missed, the pass, then a kept cycle.
    expect(nextDiamondTarget(`KMMMMM${'P'.repeat(10)}RRR`, at(1000), rules)).toBeNull();
    expect(nextDiamondTarget(`KMMMMM${'P'.repeat(10)}RRRK`, at(1000), rules)).toBeNull();
    expect(nextDiamondTarget(`KMMMMM${'P'.repeat(10)}RRRM`, at(1000), rules)?.target).toBe(500);
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
    expect(nextDiamondTarget('KPK', at(1000), quick)?.target).toBe(1500);
    expect(nextDiamondTarget('KMM', at(1000), quick)?.target).toBe(500);
  });
});
