/**
 * The three tiers of the match cluster's budget: tracked apex players, then the daily pass over
 * the Masters outside Riot's list, then the Diamond players, whose number the worker sizes by
 * itself. Needs DATABASE_URL_TEST.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  DIAMOND_FETCH_RANK,
  EXTRA_FETCH_RANK,
  enqueueMatchIds,
  getDiamondTracking,
  ladderOrder,
  migrate,
  saveDiamondTracking,
  touchWorkerStatus,
  upsertDiamondLadder,
  upsertPatchStaticData,
} from '@pick-league/db';
import type { Division, LeagueListDto, Platform } from '@pick-league/shared';
import { PRIORITY } from '../riot/client.ts';
import { PlatformWorker, type SchedulerOptions } from './platform-worker.ts';
import {
  count,
  DAY,
  diamondEntry,
  FakePatches,
  FakeRiot,
  fixedClock,
  ladderPuuid,
  makeTimedMatch,
  NOW,
  staticPatch,
} from './test-helpers.ts';

const URL = process.env.DATABASE_URL_TEST;
const d = URL ? describe : describe.skip;

const HOUR = 3_600_000;
const MIN = 60_000;
const A = ladderPuuid(0);
const B = ladderPuuid(1);
const dia = (name: string) => `fake-diamond-${name}`;
const out = (name: string) => `fake-outside-master-${name}`;

d('PlatformWorker: budget tiers (Postgres)', () => {
  let db: Db;
  let riot: FakeRiot;
  let patches: FakePatches;
  /** The clock of the workers below: moved by hand. */
  let t = NOW;
  const clock = { ...fixedClock, now: () => t };

  beforeEach(async () => {
    await db?.end();
    db = createDb(URL as string, { max: 4 });
    await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await upsertPatchStaticData(db, staticPatch('15.21'));
    await upsertPatchStaticData(db, staticPatch('15.22'));
    riot = new FakeRiot();
    patches = new FakePatches();
    t = NOW;
    riot.leagues.CHALLENGER.entries = [apex(A, 900)];
  });

  afterAll(async () => {
    await db?.end();
  });

  type Options = Partial<Omit<SchedulerOptions, 'concurrency'>> & {
    concurrency?: Partial<SchedulerOptions['concurrency']>;
  };
  const makeWorker = (options: Options = {}, platform: Platform = 'EUW1') =>
    new PlatformWorker({
      platform,
      db,
      riot,
      patches,
      clock,
      options: { idleMs: 10, expansionCheckMs: 10, ...options },
    });
  /** One listing, one match and one outside Master at a time: the requests come in work order. */
  const serial = { listing: 1, match: 1, daily: 0, enrichment: 0, extraListing: 1 };

  const apex = (puuid: string, lp: number, wins = 50) =>
    ({
      puuid,
      leaguePoints: lp,
      rank: 'I',
      wins,
      losses: 10,
      veteran: false,
      inactive: false,
      freshBlood: false,
      hotStreak: false,
    }) as LeagueListDto['entries'][number];

  /** Riot's Diamond division: [name, LP] per player. */
  const setDivision = (division: Division, players: [string, number][]) => {
    riot.diamond[division] = players.map(([name, lp]) => diamondEntry(dia(name), division, lp, 30));
  };
  /** Six Diamond I players, 'd-90' (90 LP) down to 'd-40'. */
  const sixDiamonds = () =>
    setDivision(
      'I',
      [90, 80, 70, 60, 50, 40].map((lp) => [`d-${lp}`, lp]),
    );
  /** The Diamond target of the platform, as a worker left it earlier. */
  const setTarget = (target: number, cycles = '', platform: Platform = 'EUW1') =>
    saveDiamondTracking(
      db,
      platform,
      {
        target,
        cycles,
        lastCycleAt: cycles === '' ? null : new Date(t - HOUR),
        settleCyclesLeft: 0,
        changedAt: null,
        changedFrom: null,
        changeReason: null,
      },
      new Date(t),
    );
  /**
   * A Master outside Riot's list (seen in stored matches, ranked by enrichment); `listedAt`: when
   * their match ids were last listed (never without it).
   */
  const outside = async (
    name: string,
    lp: number,
    platform: Platform = 'EUW1',
    listedAt?: number,
  ) => {
    await db`
      INSERT INTO players (puuid, platform, solo_tier, solo_lp, matches_synced_until)
      VALUES (${out(name)}, ${platform}, 'MASTER', ${lp},
              ${listedAt === undefined ? null : new Date(listedAt - HOUR)})`;
  };
  const trackedDiamonds = async () =>
    (await ladderOrder(db, 'EUW1'))
      .filter((r) => r.tier === 'DIAMOND')
      .map((r) => r.puuid.replace('fake-diamond-', ''));
  const waitFor = async (cond: () => boolean | Promise<boolean>, tries = 400) => {
    for (let i = 0; i < tries && !(await cond()); i++) await Bun.sleep(10);
  };
  /** Match-id listings so far, as 'ids:<puuid>'. */
  const listings = () =>
    riot.calls.filter((c) => c.startsWith('ids:')).map((c) => c.replace(/:0$/, ''));
  const outsideListings = () =>
    listings()
      .filter((c) => c.startsWith('ids:fake-outside-master-'))
      .map((c) => c.replace('ids:fake-outside-master-', ''));
  const at = (call: string) => riot.calls.indexOf(call);
  /** Runs the worker's loops until `until` holds (and a little longer). */
  const run = async (w: PlatformWorker, until: () => boolean | Promise<boolean>) => {
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(until);
    await Bun.sleep(80);
    ac.abort();
    await running;
  };
  /**
   * The next ladder cycle, as the ladder loop runs it an hour later: the cycle that ends is
   * recorded and the target adjusted, then the ladder is refreshed and Diamond swept.
   */
  const hour = async (w: PlatformWorker) => {
    t += HOUR;
    await w.startBudgetCycle();
    await w.refreshLadder();
    await w.refreshDiamonds();
  };
  const hours = async (w: PlatformWorker, n: number) => {
    for (let i = 0; i < n; i++) await hour(w);
  };
  const diamond = async (w: PlatformWorker) => {
    const progress = (await w.progress()).diamond;
    if (progress === null) throw new Error('Diamond tracking is off');
    return progress;
  };
  /** A worker that tracks the best `target` of the six Diamond players, those of `listed` listed. */
  const tracking = async (target: number, listed: string[], options: Options = {}) => {
    sixDiamonds();
    await setTarget(target);
    const w = makeWorker({ diamondMaxTracked: 5, ...options });
    await w.refreshLadder();
    await w.refreshDiamonds();
    await w.listTrackedPlayer(A);
    for (const name of listed) await w.listTrackedPlayer(dia(name));
    return w;
  };

  // ---------------------------------------------------------------------------
  // The order of the tiers
  // ---------------------------------------------------------------------------

  test("start(): apex players and their matches, then the Masters outside Riot's list and theirs, then Diamond players", async () => {
    setDivision('I', [['one', 50]]);
    await setTarget(1);
    await outside('m-80', 80);
    await outside('m-50', 50);
    const [MA, ME, MD, GONE] = [
      'EUW1_7000000101',
      'EUW1_7000000102',
      'EUW1_7000000103',
      'EUW1_7000000104',
    ] as const;
    riot.matchIds.set(A, [MA]);
    riot.matchIds.set(out('m-80'), [ME]);
    // A match Riot answers 404 for: it must not keep the Diamond players waiting.
    riot.matchIds.set(out('m-50'), [GONE]);
    riot.matchIds.set(dia('one'), [MD]);
    for (const id of [MA, ME, MD]) {
      riot.matches.set(id, makeTimedMatch(id, { startMs: NOW - HOUR }));
    }
    const w = makeWorker({
      diamondMaxTracked: 5,
      expandBelowPendingMatches: 0,
      concurrency: serial,
    });
    const failed = async () =>
      (await db`SELECT 1 FROM match_fetch_queue WHERE status = 'FAILED'`).length === 1;
    await run(w, async () => riot.calls.includes(`timeline:${MD}`) && (await failed()));

    expect(listings()).toEqual([
      `ids:${A}`,
      `ids:${out('m-80')}`,
      `ids:${out('m-50')}`,
      `ids:${dia('one')}`,
    ]);
    // The outside Masters wait for the apex player's match, the Diamond player for theirs.
    expect(at(`timeline:${MA}`)).toBeLessThan(at(`ids:${out('m-80')}:0`));
    expect(at(`timeline:${ME}`)).toBeLessThan(at(`ids:${dia('one')}:0`));
    expect(at(`match:${GONE}`)).toBeLessThan(at(`ids:${dia('one')}:0`));
    expect(at(`ids:${dia('one')}:0`)).toBeLessThan(at(`match:${MD}`));
    // Each request with the priority of its tier.
    expect(riot.idQueries.map((q) => q.priority)).toEqual([
      undefined,
      PRIORITY.EXTRA_MATCH_IDS,
      PRIORITY.EXTRA_MATCH_IDS,
      PRIORITY.DIAMOND_MATCH_IDS,
    ]);
    expect(riot.matchPriorities.get(MA)).toBe(PRIORITY.MATCH);
    expect(riot.matchPriorities.get(ME)).toBe(PRIORITY.EXTRA_MATCH);
    expect(riot.matchPriorities.get(MD)).toBe(PRIORITY.DIAMOND_MATCH);
    const queued = await db<{ match_id: string; fetch_rank: number; status: string }[]>`
      SELECT match_id, fetch_rank, status FROM match_fetch_queue ORDER BY match_id`;
    expect([...queued]).toEqual([
      { match_id: MA, fetch_rank: 0, status: 'DONE' },
      { match_id: ME, fetch_rank: EXTRA_FETCH_RANK, status: 'DONE' },
      { match_id: MD, fetch_rank: DIAMOND_FETCH_RANK, status: 'DONE' },
      // Failed twice, at the back of the queue from the first time.
      { match_id: GONE, fetch_rank: 1_000_000, status: 'FAILED' },
    ]);
  });

  test("start(): a backlog of Diamond matches holds neither the apex players nor the Masters outside Riot's list", async () => {
    riot.leagues.CHALLENGER.entries = [apex(A, 900), apex(B, 800)];
    setDivision('I', [['one', 50]]);
    await setTarget(1);
    await outside('m-80', 80);
    // More Diamond matches waiting than "nearly empty".
    const backlog = Array.from({ length: 8 }, (_, i) => `EUW1_700000020${i}`);
    for (const id of backlog) riot.matches.set(id, makeTimedMatch(id, { startMs: NOW - HOUR }));
    await enqueueMatchIds(db, 'EUW1', backlog, DIAMOND_FETCH_RANK + 3);
    const fetched = () => backlog.filter((id) => riot.calls.includes(`match:${id}`));
    // The first apex listing hangs.
    let open = () => {};
    riot.idsGate = new Promise<void>((r) => {
      open = r;
    });
    const w = makeWorker({
      diamondMaxTracked: 5,
      // With the skip rule a listing waits for the matches of better-placed players.
      listingSkip: 'on',
      expandBelowPendingMatches: 2,
      concurrency: serial,
    });
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => riot.calls.includes(`ids:${A}:0`));
    await Bun.sleep(300);
    // The search for the patch boundary at startup fetched a few of them, whatever their tier
    // (highest game id, then medians). The others wait: an apex listing is running.
    const probed = fetched();
    expect(probed.length).toBeLessThan(backlog.length);
    await Bun.sleep(200);
    expect(fetched()).toEqual(probed);
    expect(listings()).toEqual([`ids:${A}`]);

    riot.idsGate = null;
    open();
    await waitFor(async () => (await count(db, 'matches')) === backlog.length);
    await Bun.sleep(80);
    ac.abort();
    await running;
    // The apex players and the outside Master did not wait for the Diamond matches.
    expect(listings()).toEqual([`ids:${A}`, `ids:${B}`, `ids:${out('m-80')}`, `ids:${dia('one')}`]);
    for (const id of backlog.filter((m) => !probed.includes(m))) {
      expect(at(`match:${id}`)).toBeGreaterThan(at(`ids:${out('m-80')}:0`));
    }
  });

  test('a Diamond backlog does not count for tier 1: more Master players are tracked, outside Masters listed', async () => {
    riot.leagues.MASTER.entries = [apex('fake-master-1', 100)];
    setDivision('I', [['one', 50]]);
    await setTarget(1);
    const w = makeWorker({ diamondMaxTracked: 5, expandBelowPendingMatches: 1 });
    await w.refreshLadder();
    await w.refreshDiamonds();
    await w.listTrackedPlayer(A);
    // A Diamond player waits for a listing, and Diamond matches for their fetch.
    await enqueueMatchIds(
      db,
      'EUW1',
      ['EUW1_7000000301', 'EUW1_7000000302', 'EUW1_7000000303'],
      DIAMOND_FETCH_RANK,
    );
    expect(await w.canTrackMoreMasters()).toBe(true);
    expect(await w.canListExtraPlayers()).toBe(false);
    await w.trackMoreMasters();
    await w.listTrackedPlayer('fake-master-1');
    expect(await w.canListExtraPlayers()).toBe(true);
    // An apex player who played comes first again.
    riot.leagues.CHALLENGER.entries = [apex(A, 900, 51)];
    await w.refreshLadder();
    expect(await w.canListExtraPlayers()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Tier 2: one pass a day
  // ---------------------------------------------------------------------------

  test('start(): the pass opens at 04:00 local time of the platform; each player is listed once per pass, again the next day', async () => {
    // NOW is 21:00 in Korea (UTC+9). Both were listed in today's pass, which opened at 04:00.
    await outside('m-80', 80, 'KR', NOW - 2 * HOUR);
    await outside('m-50', 50, 'KR', NOW - 3 * HOUR);
    const w = makeWorker({ concurrency: serial }, 'KR');
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => riot.calls.includes(`ids:${A}:0`));
    await Bun.sleep(150);
    expect(outsideListings()).toEqual([]);
    expect((await w.progress()).extraPass).toEqual({
      open: false,
      openedAt: '2026-11-12T19:00:00.000Z',
      remaining: 0,
      matchesWaiting: 0,
    });

    // 03:59 in Korea: not yet.
    t = Date.parse('2026-11-13T18:59:00Z');
    await Bun.sleep(150);
    expect(outsideListings()).toEqual([]);
    // 04:00: everyone is due, highest rank first.
    t = Date.parse('2026-11-13T19:00:30Z');
    await waitFor(() => outsideListings().length === 2);
    expect(outsideListings()).toEqual(['m-80', 'm-50']);
    await waitFor(async () => (await w.progress()).extraPass?.open === false);
    expect((await w.progress()).extraPass).toEqual({
      open: false,
      openedAt: '2026-11-13T19:00:00.000Z',
      remaining: 0,
      matchesWaiting: 0,
    });
    // Once: not again that day, however long after.
    for (const later of ['2026-11-13T23:00:00Z', '2026-11-14T10:00:00Z', '2026-11-14T18:59:00Z']) {
      t = Date.parse(later);
      await Bun.sleep(120);
      expect(outsideListings()).toHaveLength(2);
    }
    // The next day's pass.
    t = Date.parse('2026-11-14T19:00:30Z');
    await waitFor(() => outsideListings().length === 4);
    await Bun.sleep(120);
    ac.abort();
    await running;
    expect(outsideListings()).toEqual(['m-80', 'm-50', 'm-80', 'm-50']);
  });

  test('the start hour and the UTC offset of a platform are options', async () => {
    const openedAt = async (options: Options, platform: Platform) => {
      const w = makeWorker(options, platform);
      return (await w.progress()).extraPass?.openedAt;
    };
    // NOW is 2026-11-13 12:00 UTC.
    expect(await openedAt({}, 'KR')).toBe('2026-11-12T19:00:00.000Z');
    expect(await openedAt({}, 'VN2')).toBe('2026-11-12T21:00:00.000Z');
    expect(await openedAt({}, 'EUW1')).toBe('2026-11-13T03:00:00.000Z');
    expect(await openedAt({}, 'NA1')).toBe('2026-11-13T10:00:00.000Z');
    expect(await openedAt({ extraPassStartHour: 3 }, 'EUW1')).toBe('2026-11-13T02:00:00.000Z');
    expect(await openedAt({ extraPassStartHour: 15 }, 'EUW1')).toBe('2026-11-12T14:00:00.000Z');
    expect(await openedAt({ extraPassUtcOffsetHours: { EUW1: 2 } }, 'EUW1')).toBe(
      '2026-11-13T02:00:00.000Z',
    );
  });

  test('start(): a restart during the pass lists nobody twice; a worker stopped at the start hour runs the pass when it comes back', async () => {
    // 04:30 in Korea: the pass opened half an hour ago.
    t = Date.parse('2026-11-13T19:30:00Z');
    await outside('m-80', 80, 'KR', t - 20 * HOUR);
    await outside('m-50', 50, 'KR');
    const options = { concurrency: serial };
    await run(makeWorker(options, 'KR'), () => outsideListings().length === 2);
    expect(outsideListings()).toEqual(['m-80', 'm-50']);

    // The worker restarts ten minutes later, while another player of the pass is still due.
    await outside('m-60', 60, 'KR', t - 20 * HOUR);
    t += 10 * MIN;
    riot.calls = [];
    await run(makeWorker(options, 'KR'), () => outsideListings().length === 1);
    expect(outsideListings()).toEqual(['m-60']);

    // Stopped over the next start hour: the pass runs when the worker is back, three hours late.
    t = Date.parse('2026-11-14T22:00:00Z');
    riot.calls = [];
    await run(makeWorker(options, 'KR'), () => outsideListings().length === 3);
    expect(outsideListings()).toEqual(['m-80', 'm-60', 'm-50']);
  });

  test('start(): Diamond players wait during the pass and are listed once it is over', async () => {
    // A worker that restarts with the apex player listed: only tiers 2 and 3 have work.
    const before = makeWorker();
    await before.refreshLadder();
    await before.listTrackedPlayer(A);
    riot.calls = [];
    setDivision('I', [['one', 50]]);
    await setTarget(1);
    await outside('m-80', 80);
    await outside('m-50', 50);
    // The listings of the pass hang.
    let open = () => {};
    riot.idsGate = new Promise<void>((r) => {
      open = r;
    });
    const w = makeWorker({ diamondMaxTracked: 5, concurrency: serial });
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => riot.calls.includes(`ids:${out('m-80')}:0`));
    await Bun.sleep(200);
    expect(listings()).toEqual([`ids:${out('m-80')}`]);
    expect(await w.progress()).toMatchObject({
      playedToList: 1,
      extraPass: { open: true, openedAt: '2026-11-13T03:00:00.000Z', remaining: 2 },
    });

    riot.idsGate = null;
    open();
    await waitFor(() => riot.calls.includes(`ids:${dia('one')}:0`));
    await Bun.sleep(80);
    ac.abort();
    await running;
    expect(listings()).toEqual([`ids:${out('m-80')}`, `ids:${out('m-50')}`, `ids:${dia('one')}`]);
    expect((await w.progress()).extraPass).toMatchObject({ open: false, remaining: 0 });
  });

  // ---------------------------------------------------------------------------
  // Tier 3: the Diamond target
  // ---------------------------------------------------------------------------

  test('the target grows a step only after a full day of keeping up; the burst of a step does not count; never above the ceiling', async () => {
    const w = await tracking(2, ['d-90', 'd-80'], { diamondStep: 2 });
    // The first call opens a cycle; each of the next ones records the cycle that ends.
    await hours(w, 24);
    expect(await diamond(w)).toMatchObject({
      target: 2,
      tracked: 2,
      cycles: 'K'.repeat(23),
      keptCycles: 23,
    });
    // The twenty-fourth cycle kept up with: two more players, tracked by the sweep that follows.
    await hour(w);
    expect(await diamond(w)).toMatchObject({
      target: 4,
      tracked: 4,
      cap: 5,
      cycles: '',
      settleCyclesLeft: 24,
      lastChange: { from: 2, reason: 'kept up for 24 cycles (24 kept, none missed)' },
    });
    expect(await trackedDiamonds()).toEqual(['d-90', 'd-80', 'd-70', 'd-60']);
    expect((await w.progress()).playedToList).toBe(2);

    // Their first listings wait for ten cycles: a burst, not "not keeping up". Nothing is
    // recorded, the target does not shrink (six missed cycles would do it).
    await hours(w, 10);
    expect(await diamond(w)).toMatchObject({ target: 4, cycles: '', settleCyclesLeft: 14 });
    // Absorbed: the day at the new size starts with the first cycle kept up with.
    await w.listTrackedPlayer(dia('d-70'));
    await w.listTrackedPlayer(dia('d-60'));
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 4, cycles: 'K', settleCyclesLeft: 0 });
    await hours(w, 22);
    expect(await diamond(w)).toMatchObject({ target: 4, keptCycles: 23 });
    // The next step stops at the ceiling (DIAMOND_MAX_TRACKED = 5).
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 5, tracked: 5, cycles: '' });
    await w.listTrackedPlayer(dia('d-50'));
    await hours(w, 26);
    expect(await diamond(w)).toMatchObject({ target: 5, tracked: 5, keptCycles: 24 });
    expect(await trackedDiamonds()).toEqual(['d-90', 'd-80', 'd-70', 'd-60', 'd-50']);
  }, 60_000);

  test('one missed cycle in the day (the evening peak) holds the growth', async () => {
    const w = await tracking(2, ['d-90', 'd-80'], { diamondStep: 2 });
    await hours(w, 13);
    // A Diamond player played and is not listed within the hour.
    riot.diamond.I = riot.diamond.I.map((e) => (e.puuid === dia('d-80') ? { ...e, wins: 31 } : e));
    await hour(w);
    await hour(w);
    await w.listTrackedPlayer(dia('d-80'));
    await hours(w, 10);
    const progress = await diamond(w);
    expect(progress).toMatchObject({ target: 2, keptCycles: 23 });
    expect(progress.cycles).toBe(`${'K'.repeat(13)}M${'K'.repeat(10)}`);
    // The missed cycle leaves the last 24 cycles: a full day kept up with.
    await hours(w, 13);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: `M${'K'.repeat(23)}` });
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 4 });
  }, 60_000);

  test('the target shrinks a step after six missed cycles: the last candidates leave the ladder, their matches stay', async () => {
    const w = await tracking(4, ['d-90', 'd-80'], { diamondStep: 2 });
    expect(await trackedDiamonds()).toEqual(['d-90', 'd-80', 'd-70', 'd-60']);
    // A stored match of a player who will be dropped.
    const id = 'EUW1_7000000401';
    riot.matches.set(id, makeTimedMatch(id, { startMs: NOW - HOUR, players: [dia('d-60')] }));
    await enqueueMatchIds(db, 'EUW1', [id]);
    await w.processMatch({ matchId: id, platform: 'EUW1', attempts: 0 });

    // 'd-70' and 'd-60' are never listed: the platform does not keep up.
    await hours(w, 6);
    expect(await diamond(w)).toMatchObject({ target: 4, tracked: 4, cycles: 'MMMMM' });
    expect((await w.progress()).playedToList).toBe(2);
    await hour(w);
    expect(await diamond(w)).toMatchObject({
      target: 2,
      tracked: 2,
      cycles: '',
      settleCyclesLeft: 0,
      lastChange: { from: 4, reason: 'not kept up: 6 cycles missed since the last kept one' },
    });
    expect(await trackedDiamonds()).toEqual(['d-90', 'd-80']);
    // They are no longer waiting for a listing; their players rows and the match stay.
    expect((await w.progress()).playedToList).toBe(0);
    expect(await db`SELECT 1 FROM players WHERE puuid = ${dia('d-60')}`).toHaveLength(1);
    expect(await db`SELECT 1 FROM participants WHERE puuid = ${dia('d-60')}`).toHaveLength(1);
    expect(await count(db, 'matches')).toBe(1);
    // Now the platform keeps up; a restart does not bring the dropped players back.
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'K' });
    const restarted = makeWorker({ diamondMaxTracked: 5, diamondStep: 2 });
    await restarted.refreshLadder();
    expect(await restarted.progress()).toMatchObject({
      playedToList: 0,
      diamond: { target: 2, tracked: 2 },
    });
  });

  test('a growth step that is not absorbed within the settling time is undone, once', async () => {
    const quick = {
      diamondStep: 1,
      diamondGrowCycles: 3,
      diamondGrowMinKeptCycles: 1,
      diamondSettleCycles: 2,
      diamondShrinkMissedCycles: 2,
    };
    const w = await tracking(1, ['d-90'], quick);
    await hours(w, 4);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: '', settleCyclesLeft: 2 });
    // 'd-80' is never listed. Two cycles of settling, then two missed ones.
    await hours(w, 2);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: '', settleCyclesLeft: 0 });
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'M' });
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 1, tracked: 1, cycles: '' });
    // Back at a size it keeps up with: it takes a whole new window to try again.
    await hours(w, 2);
    expect(await diamond(w)).toMatchObject({ target: 1, tracked: 1, cycles: 'KK' });
  });

  test('the cycles of the daily pass do not use up the time a growth step has to settle', async () => {
    const quick = {
      diamondStep: 1,
      diamondGrowCycles: 3,
      diamondGrowMinKeptCycles: 1,
      diamondSettleCycles: 2,
      diamondShrinkMissedCycles: 2,
    };
    // 23:00 on EUW1; the outside Master was listed in today's pass, the next one opens at 04:00.
    t = Date.parse('2026-11-13T22:00:00Z');
    await outside('m-80', 80, 'EUW1', t - HOUR);
    const w = await tracking(1, ['d-90'], quick);
    await hours(w, 4);
    expect(t).toBe(Date.parse('2026-11-14T02:00:00Z'));
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: '', settleCyclesLeft: 2 });
    // 'd-80' is not listed yet, and the pass runs for five cycles: tier 3 could do nothing.
    await hours(w, 5);
    expect((await w.progress()).extraPass).toMatchObject({ open: true, remaining: 1 });
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: '', settleCyclesLeft: 2 });
    // Once the pass is over the burst gets its two cycles, then is absorbed.
    await w.listPlayerMatches(out('m-80'), undefined, true);
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: '', settleCyclesLeft: 1 });
    await w.listTrackedPlayer(dia('d-80'));
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'K', settleCyclesLeft: 0 });
  });

  test('the cycles of the daily pass and of its recovery are neither kept nor missed', async () => {
    const options = {
      diamondStep: 1,
      diamondShrinkMissedCycles: 2,
      diamondPassRecoveryCycles: 1,
    };
    // 'd-80' waits for a listing all along: without the pass every cycle would be missed.
    const w = await tracking(2, ['d-90'], options);
    await outside('m-80', 80);
    await hours(w, 5);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'PPPP' });
    expect((await w.progress()).extraPass).toMatchObject({ open: true, remaining: 1 });

    // The pass is over (the outside Master is listed): one cycle of recovery, then they count.
    await w.listPlayerMatches(out('m-80'), undefined, true);
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'PPPPR' });
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'PPPPRM' });
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 1, tracked: 1, cycles: '' });
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 1, cycles: 'K' });
  });

  test('a player who turns up once the pass is over does not make a pass cycle', async () => {
    // 'd-80' waits for a listing; nobody is due in today's pass.
    const w = await tracking(2, ['d-90']);
    await hours(w, 2);
    expect(await diamond(w)).toMatchObject({ cycles: 'M' });
    expect((await w.progress()).extraPass).toMatchObject({ open: false, remaining: 0 });
    // A Master outside Riot's list is seen for the first time: due, but not "the pass".
    await outside('m-80', 80);
    await hour(w);
    expect(await diamond(w)).toMatchObject({ cycles: 'MM' });
    expect((await w.progress()).extraPass).toMatchObject({ open: false, remaining: 1 });
  });

  test('the games found by the pass still being fetched keep tier 3 waiting, and the cycle is a pass cycle', async () => {
    const w = await tracking(1, ['d-90'], { expandBelowPendingMatches: 1 });
    await outside('m-80', 80);
    riot.matchIds.set(out('m-80'), ['EUW1_7000000501', 'EUW1_7000000502']);
    await hour(w);
    await w.listPlayerMatches(out('m-80'), undefined, true);
    // Nobody is due any more, but the two matches are not stored yet.
    await hour(w);
    expect(await diamond(w)).toMatchObject({ cycles: 'P' });
    expect((await w.progress()).extraPass).toMatchObject({
      open: false,
      remaining: 0,
      matchesWaiting: 2,
    });
    // One is stored, the other fails and goes to the back of the queue: tier 2 is done.
    await db`UPDATE match_fetch_queue SET status = 'DONE' WHERE match_id = 'EUW1_7000000501'`;
    await w.processMatch({ matchId: 'EUW1_7000000502', platform: 'EUW1', attempts: 0 });
    await hour(w);
    expect(await diamond(w)).toMatchObject({ cycles: 'PK' });
  });

  // ---------------------------------------------------------------------------
  // Restarts
  // ---------------------------------------------------------------------------

  test('a restart keeps the target and its history; the cycle it interrupts is not counted twice', async () => {
    const quick = { diamondStep: 1, diamondGrowCycles: 6, diamondGrowMinKeptCycles: 1 };
    const first = await tracking(2, ['d-90', 'd-80'], quick);
    await hours(first, 4);
    // The cycle in progress is already kept up with when the worker stops.
    await first.noteKeepingUp();
    expect(await diamond(first)).toMatchObject({ target: 2, cycles: 'KKKK' });

    // It restarts ten minutes later.
    t += 10 * MIN;
    const second = makeWorker({ diamondMaxTracked: 5, ...quick });
    expect(await diamond(second)).toMatchObject({ target: 2, tracked: 2, cycles: 'KKKK' });
    t -= HOUR;
    await hour(second);
    // What is left of the interrupted cycle is the same cycle.
    await hour(second);
    expect(await diamond(second)).toMatchObject({ target: 2, cycles: 'KKKK' });
    await hour(second);
    expect(await diamond(second)).toMatchObject({ target: 2, cycles: 'KKKKK' });
    // The window is complete over both runs: the target grows, and a third run reads it back.
    await hour(second);
    expect(await diamond(second)).toMatchObject({ target: 3, tracked: 3 });
    const third = makeWorker({ diamondMaxTracked: 5, ...quick });
    expect(await diamond(third)).toMatchObject({
      target: 3,
      tracked: 3,
      cycles: '',
      settleCyclesLeft: 24,
      lastChange: { from: 2 },
    });
    expect((await getDiamondTracking(db, 'EUW1'))?.target).toBe(3);
  });

  test.each([
    ['a short restart: the missed cycles go on counting', false],
    ['a stop of three hours: its backlog is not held against the target', true],
  ])('%s', async (_name, longStop) => {
    const before = await tracking(2, ['d-90']);
    expect(await trackedDiamonds()).toEqual(['d-90', 'd-80']);
    // Five cycles missed so far ('d-80' is waiting for a listing); the worker stops.
    await setTarget(2, 'KMMMMM');
    await touchWorkerStatus(db, 'EUW1', new Date(t));
    expect(await diamond(before)).toMatchObject({ tracked: 2 });
    if (longStop) t += 3 * HOUR;
    else t += MIN;

    // The target is read when the worker starts.
    const w = makeWorker({ diamondMaxTracked: 5, diamondStep: 1 });
    expect(await diamond(w)).toMatchObject({ settleCyclesLeft: longStop ? 24 : 0 });
    await hours(w, 2);
    if (longStop) {
      expect(await diamond(w)).toMatchObject({
        target: 2,
        cycles: 'KMMMMM',
        settleCyclesLeft: 23,
      });
      await hours(w, 5);
      expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'KMMMMM' });
    } else {
      expect(await diamond(w)).toMatchObject({
        target: 1,
        tracked: 1,
        cycles: '',
        lastChange: { from: 2 },
      });
    }
  });

  test('first start with Diamond players already tracked: the target starts at their number, under the ceiling, with time to list them', async () => {
    // As the previous version left them: tracked, no target stored.
    await upsertDiamondLadder(
      db,
      'EUW1',
      [90, 80, 70].map((lp) => ({
        puuid: dia(`d-${lp}`),
        tier: 'DIAMOND' as const,
        division: 1,
        leaguePoints: lp,
        wins: 30,
        losses: 10,
      })),
      { keep: 'all', now: new Date(NOW - HOUR) },
    );
    sixDiamonds();
    const w = makeWorker({ diamondMaxTracked: 5 });
    const progress = await diamond(w);
    expect(progress).toMatchObject({
      target: 3,
      tracked: 3,
      cap: 5,
      cycles: '',
      settleCyclesLeft: 24,
      lastChange: { from: null, reason: 'first start: 3 Diamond players were tracked' },
    });
    // Their first listings are waiting: not held against the target for a day.
    await hours(w, 12);
    expect(await diamond(w)).toMatchObject({ target: 3, tracked: 3, cycles: '' });

    // A ceiling below what is stored brings the target down to it.
    const capped = makeWorker({ diamondMaxTracked: 2 });
    expect(await diamond(capped)).toMatchObject({
      target: 2,
      cap: 2,
      lastChange: { from: 3, reason: 'above the ceiling (DIAMOND_MAX_TRACKED)' },
    });
    await capped.refreshLadder();
    await capped.refreshDiamonds();
    expect(await trackedDiamonds()).toEqual(['d-90', 'd-80']);
  });

  test('a full day with the daily pass in it: the cycles of the pass do not stop the growth', async () => {
    const w = await tracking(1, ['d-90'], { diamondStep: 1 });
    await outside('m-80', 80, 'EUW1', NOW - HOUR);
    for (let i = 0; i < 25; i++) {
      await hour(w);
      // 04:00 to 07:00 local time: the outside Master is due and not listed yet.
      if (t === Date.parse('2026-11-14T06:00:00Z')) {
        await w.listPlayerMatches(out('m-80'), undefined, true);
      }
    }
    expect(t - NOW).toBe(DAY + HOUR);
    expect(await diamond(w)).toMatchObject({
      target: 2,
      lastChange: { from: 1, reason: 'kept up for 24 cycles (20 kept, none missed)' },
    });
  }, 60_000);
});
