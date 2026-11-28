/**
 * The three tiers of the match cluster's budget: tracked apex players, then the Masters outside
 * Riot's list whose counter moved, then the Diamond players (those seen in a Master+ game, then
 * the other Diamond players, top divisions first), whose number the worker sizes by itself. Needs DATABASE_URL_TEST.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  DIAMOND_FETCH_RANK,
  DIAMOND_ONE_FETCH_RANK,
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
import { PlatformWorker, type SchedulerOptionsInput } from './platform-worker.ts';
import {
  count,
  diamondEntry,
  FakePatches,
  FakeRiot,
  fixedClock,
  ladderPuuid,
  makeTimedMatch,
  NOW,
  soloEntry,
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

  type Options = SchedulerOptionsInput;
  const makeWorker = (options: Options = {}, platform: Platform = 'EUW1') =>
    new PlatformWorker({
      platform,
      db,
      riot,
      patches,
      clock,
      // The fast start is off unless a test asks for it: these tests are about the slow rule.
      options: { idleMs: 10, expansionCheckMs: 10, diamondFastGrowCycles: 0, ...options },
    });
  /** One listing, one match and one outside Master at a time: the requests come in work order. */
  const serial = {
    listing: 1,
    match: 1,
    daily: 0,
    enrichment: 0,
    outsideCheck: 1,
    outsideListing: 1,
  };

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
        shrunkAt: null,
      },
      new Date(t),
    );
  /**
   * A Master outside Riot's list (seen in stored matches, ranked by enrichment), never listed:
   * their first check asks for a listing. Riot answers `games` wins + losses for them.
   */
  const outside = async (name: string, lp: number, games = 100) => {
    await db`
      INSERT INTO players (puuid, platform, solo_tier, solo_lp)
      VALUES (${out(name)}, 'EUW1', 'MASTER', ${lp})`;
    riot.leagueEntries.set(out(name), [soloEntry(out(name), 'MASTER', games, lp)]);
  };
  /** The same, followed by the worker and waiting for their listing. */
  const outsideWaiting = async (w: PlatformWorker, name: string, lp: number) => {
    await outside(name, lp);
    await w.refreshOutsideMasters();
    expect(await w.checkOutsideMaster(out(name))).toBe('first-listing');
  };
  /** A Diamond player seen in a Master+ game an hour ago (before any sweep saw them). */
  const seenWithMaster = async (name: string) => {
    await db`
      INSERT INTO players (puuid, platform, last_seen_with_master_at)
      VALUES (${dia(name)}, 'EUW1', ${new Date(t - HOUR)})`;
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
    await outside('m-50', 50);
    await outside('m-80', 80);
    const [MA, ME, MD, GONE] = [
      'EUW1_7000000101',
      'EUW1_7000000102',
      'EUW1_7000000103',
      'EUW1_7000000104',
    ] as const;
    riot.matchIds.set(A, [MA]);
    riot.matchIds.set(out('m-50'), [ME]);
    // A match Riot answers 404 for: it must not keep the Diamond players waiting.
    riot.matchIds.set(out('m-80'), [GONE]);
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
    // The apex listing hangs until both outside Masters were checked (on the platform host,
    // whatever the tiers are doing): from then on they wait for a listing.
    let open = () => {};
    riot.idsGate = new Promise<void>((r) => {
      open = r;
    });
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(async () => (await w.progress()).outsideMasters?.toList === 2);
    await waitFor(() => riot.calls.includes(`ids:${A}:0`));
    expect(listings()).toEqual([`ids:${A}`]);
    riot.idsGate = null;
    open();
    await waitFor(async () => riot.calls.includes(`timeline:${MD}`) && (await failed()));
    await Bun.sleep(80);
    ac.abort();
    await running;

    expect(listings()).toEqual([
      `ids:${A}`,
      `ids:${out('m-50')}`,
      `ids:${out('m-80')}`,
      `ids:${dia('one')}`,
    ]);
    // The outside Masters were asked for their own entry on the platform host, once each, after
    // the ladder lists and the Diamond pages in that host's order.
    expect(riot.calls.filter((c) => c.startsWith('entries:'))).toEqual([
      `entries:${out('m-50')}:${PRIORITY.OUTSIDE_MASTER_CHECK}`,
      `entries:${out('m-80')}:${PRIORITY.OUTSIDE_MASTER_CHECK}`,
    ]);
    // The outside Masters wait for the apex player's match, the Diamond player for theirs.
    expect(at(`timeline:${MA}`)).toBeLessThan(at(`ids:${out('m-50')}:0`));
    expect(at(`timeline:${ME}`)).toBeLessThan(at(`ids:${dia('one')}:0`));
    expect(at(`match:${GONE}`)).toBeLessThan(at(`ids:${dia('one')}:0`));
    expect(at(`ids:${dia('one')}:0`)).toBeLessThan(at(`match:${MD}`));
    // Each request with the priority of its tier.
    expect(riot.idQueries.map((q) => q.priority)).toEqual([
      undefined,
      PRIORITY.EXTRA_MATCH_IDS,
      PRIORITY.EXTRA_MATCH_IDS,
      // A Diamond I player nobody saw in a Master+ game: the last sub-tier.
      PRIORITY.DIAMOND_ONE_MATCH_IDS,
    ]);
    expect(riot.matchPriorities.get(MA)).toBe(PRIORITY.MATCH);
    expect(riot.matchPriorities.get(ME)).toBe(PRIORITY.EXTRA_MATCH);
    expect(riot.matchPriorities.get(MD)).toBe(PRIORITY.DIAMOND_ONE_MATCH);
    const queued = await db<{ match_id: string; fetch_rank: number; status: string }[]>`
      SELECT match_id, fetch_rank, status FROM match_fetch_queue ORDER BY match_id`;
    expect([...queued]).toEqual([
      { match_id: MA, fetch_rank: 0, status: 'DONE' },
      { match_id: ME, fetch_rank: EXTRA_FETCH_RANK, status: 'DONE' },
      { match_id: MD, fetch_rank: DIAMOND_ONE_FETCH_RANK, status: 'DONE' },
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
    expect(await w.canListOutsideMasters()).toBe(false);
    await w.trackMoreMasters();
    await w.listTrackedPlayer('fake-master-1');
    expect(await w.canListOutsideMasters()).toBe(true);
    // An apex player who played comes first again.
    riot.leagues.CHALLENGER.entries = [apex(A, 900, 51)];
    await w.refreshLadder();
    expect(await w.canListOutsideMasters()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Tier 2 before tier 3; inside tier 3, the players seen in a Master+ game first
  // ---------------------------------------------------------------------------

  test('start(): Diamond players wait while outside Masters wait for a listing, and are listed once they are', async () => {
    // A worker that restarts with the apex player listed: only tiers 2 and 3 have work.
    const before = makeWorker();
    await before.refreshLadder();
    await before.listTrackedPlayer(A);
    setDivision('I', [['one', 50]]);
    await setTarget(1);
    await outsideWaiting(before, 'm-50', 50);
    await outsideWaiting(before, 'm-80', 80);
    riot.calls = [];
    // The listings of the outside Masters hang.
    let open = () => {};
    riot.idsGate = new Promise<void>((r) => {
      open = r;
    });
    const w = makeWorker({ diamondMaxTracked: 5, concurrency: serial });
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => riot.calls.includes(`ids:${out('m-50')}:0`));
    await Bun.sleep(200);
    expect(listings()).toEqual([`ids:${out('m-50')}`]);
    expect(await w.progress()).toMatchObject({
      playedToList: 1,
      outsideMasters: { followed: 2, checkedLastHour: 2, neverChecked: 0, toList: 2 },
    });

    riot.idsGate = null;
    open();
    await waitFor(() => riot.calls.includes(`ids:${dia('one')}:0`));
    await Bun.sleep(80);
    ac.abort();
    await running;
    expect(listings()).toEqual([`ids:${out('m-50')}`, `ids:${out('m-80')}`, `ids:${dia('one')}`]);
    expect((await w.progress()).outsideMasters).toMatchObject({ followed: 2, toList: 0 });
  });

  test('start(): the Diamond players seen in a Master+ game (3a) and their matches come before any Diamond I player (3b)', async () => {
    // A Diamond III player seen in a Master+ game, and two Diamond I players who were not.
    await seenWithMaster('three');
    setDivision('I', [
      ['one-90', 90],
      ['one-80', 80],
    ]);
    setDivision('III', [['three', 10]]);
    await setTarget(3);
    const [M3, M1, M1B] = ['EUW1_7000000601', 'EUW1_7000000602', 'EUW1_7000000603'] as const;
    riot.matchIds.set(dia('three'), [M3]);
    riot.matchIds.set(dia('one-90'), [M1]);
    riot.matchIds.set(dia('one-80'), [M1B]);
    for (const id of [M3, M1, M1B]) {
      riot.matches.set(id, makeTimedMatch(id, { startMs: NOW - HOUR }));
    }
    const w = makeWorker({
      diamondMaxTracked: 5,
      expandBelowPendingMatches: 0,
      concurrency: { ...serial, outsideCheck: 0 },
    });
    await run(w, () => riot.calls.includes(`timeline:${M1B}`));

    expect(await trackedDiamonds()).toEqual(['one-90', 'one-80', 'three']);
    expect(listings()).toEqual([
      `ids:${A}`,
      `ids:${dia('three')}`,
      `ids:${dia('one-90')}`,
      `ids:${dia('one-80')}`,
    ]);
    // No Diamond I player is listed before the match of the 3a player is stored.
    expect(at(`timeline:${M3}`)).toBeLessThan(at(`ids:${dia('one-90')}:0`));
    expect(riot.idQueries.map((q) => q.priority)).toEqual([
      undefined,
      PRIORITY.DIAMOND_MATCH_IDS,
      PRIORITY.DIAMOND_ONE_MATCH_IDS,
      PRIORITY.DIAMOND_ONE_MATCH_IDS,
    ]);
    expect(riot.matchPriorities.get(M3)).toBe(PRIORITY.DIAMOND_MATCH);
    expect(riot.matchPriorities.get(M1)).toBe(PRIORITY.DIAMOND_ONE_MATCH);
    const queued = await db<{ match_id: string; fetch_rank: number }[]>`
      SELECT match_id, fetch_rank FROM match_fetch_queue ORDER BY match_id`;
    expect([...queued]).toEqual([
      { match_id: M3, fetch_rank: DIAMOND_FETCH_RANK },
      { match_id: M1, fetch_rank: DIAMOND_ONE_FETCH_RANK },
      { match_id: M1B, fetch_rank: DIAMOND_ONE_FETCH_RANK + 1 },
    ]);
    expect((await w.progress()).diamond).toMatchObject({ tracked: 3, trackedWithMaster: 1 });
  });

  test('start(): a backlog of 3a matches holds the Diamond I players, and a 3b match waits for a 3a listing', async () => {
    await seenWithMaster('three');
    setDivision('I', [['one', 90]]);
    setDivision('III', [['three', 10]]);
    await setTarget(2);
    // A worker that restarts with both tracked and the apex player listed.
    const before = makeWorker({ diamondMaxTracked: 5 });
    await before.refreshLadder();
    await before.refreshDiamonds();
    await before.listTrackedPlayer(A);
    await before.listTrackedPlayer(dia('one'));
    riot.calls = [];
    // 3b matches are queued; the 3a player still waits for a listing, which hangs.
    const backlog = Array.from({ length: 8 }, (_, i) => `EUW1_700000061${i}`);
    const M3 = 'EUW1_7000000609';
    for (const id of [...backlog, M3]) {
      riot.matches.set(id, makeTimedMatch(id, { startMs: NOW - HOUR }));
    }
    await enqueueMatchIds(db, 'EUW1', backlog, DIAMOND_ONE_FETCH_RANK);
    riot.matchIds.set(dia('three'), [M3]);
    const fetched = () => backlog.filter((id) => riot.calls.includes(`match:${id}`));
    let open = () => {};
    riot.idsGate = new Promise<void>((r) => {
      open = r;
    });
    const w = makeWorker({
      diamondMaxTracked: 5,
      expandBelowPendingMatches: 0,
      concurrency: { ...serial, outsideCheck: 0 },
    });
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => riot.calls.includes(`ids:${dia('three')}:0`));
    await Bun.sleep(300);
    // The search for the patch boundary at startup fetched a few of them, whatever their tier.
    // The others wait: a listing of a player seen in a Master+ game is running.
    const probed = fetched();
    expect(probed.length).toBeLessThan(backlog.length);
    await Bun.sleep(200);
    expect(fetched()).toEqual(probed);

    riot.idsGate = null;
    open();
    await waitFor(async () => (await count(db, 'matches')) === backlog.length + 1);
    await Bun.sleep(80);
    ac.abort();
    await running;
    // The match that listing found is fetched before the Diamond I players' matches.
    for (const id of backlog.filter((m) => !probed.includes(m))) {
      expect(at(`match:${id}`)).toBeGreaterThan(at(`timeline:${M3}`));
    }
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
      lastChange: { from: 2, reason: 'caught up in 24 of the last 24 cycles' },
    });
    expect(await trackedDiamonds()).toEqual(['d-90', 'd-80', 'd-70', 'd-60']);
    expect((await w.progress()).playedToList).toBe(2);

    // Their first listings wait for ten cycles: a burst, not "not keeping up". Nothing is
    // recorded, the target does not shrink.
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

  test('sized on the day: a backlog left by the peak hours and caught up later neither shrinks nor holds the target', async () => {
    const w = await tracking(2, ['d-90', 'd-80'], { diamondStep: 2 });
    await hours(w, 2);
    // A Diamond player played and is not listed for twenty hours (the evening peak).
    riot.diamond.I = riot.diamond.I.map((e) => (e.puuid === dia('d-80') ? { ...e, wins: 31 } : e));
    await hour(w);
    await hours(w, 20);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: `KK${'M'.repeat(20)}` });
    // Caught up in the quiet hours, which then run out of work: budget was left.
    await w.listTrackedPlayer(dia('d-80'));
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: `KK${'M'.repeat(20)}K` });
    await hour(w);
    expect(await diamond(w)).toMatchObject({
      target: 4,
      cycles: '',
      lastChange: { from: 2, reason: 'caught up in 4 of the last 24 cycles' },
    });
  }, 60_000);

  test('a full day without catching up once shrinks the target', async () => {
    const w = await tracking(4, ['d-90', 'd-80'], { diamondStep: 2 });
    // 'd-70' and 'd-60' are never listed.
    await hours(w, 24);
    expect(await diamond(w)).toMatchObject({ target: 4, cycles: 'M'.repeat(23) });
    await hour(w);
    expect(await diamond(w)).toMatchObject({
      target: 2,
      tracked: 2,
      lastChange: { from: 4, reason: 'not kept up: 24 cycles missed since the last kept one' },
    });
  }, 60_000);

  test('the target shrinks a step after six missed cycles: the last candidates leave the ladder, their matches stay', async () => {
    const w = await tracking(4, ['d-90', 'd-80'], { diamondStep: 2, diamondShrinkMissedCycles: 6 });
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

  test('fast start: the target grows after two kept cycles until it has shrunk once, then only after a full day', async () => {
    const quick = {
      diamondStep: 1,
      diamondFastGrowCycles: 2,
      diamondSettleCycles: 1,
      diamondShrinkMissedCycles: 2,
    };
    const w = await tracking(1, ['d-90'], quick);
    // Two kept cycles are enough while it has never shrunk.
    await hours(w, 3);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: '' });
    const [before] = await db<{ shrunk_at: Date | null }[]>`
      SELECT shrunk_at FROM diamond_tracking WHERE platform = 'EUW1'`;
    expect(before?.shrunk_at).toBeNull();
    // 'd-80' is never listed: one cycle of settling, two missed ones, and the step is undone.
    await hours(w, 3);
    expect(await diamond(w)).toMatchObject({ target: 1, tracked: 1, cycles: '' });
    const [after] = await db<{ shrunk_at: Date | null }[]>`
      SELECT shrunk_at FROM diamond_tracking WHERE platform = 'EUW1'`;
    expect(after?.shrunk_at).not.toBeNull();
    // It has shrunk: two kept cycles no longer grow it (the slow rule wants a full day).
    await hours(w, 4);
    expect(await diamond(w)).toMatchObject({ target: 1, cycles: 'KKKK' });
  });

  test('an outside Master waiting for a listing is tier 2 work like any other: the cycle is missed until they are listed', async () => {
    const options = { diamondStep: 1, diamondShrinkMissedCycles: 3 };
    const w = await tracking(2, ['d-90', 'd-80'], options);
    await hours(w, 2);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'K' });
    // Their counter moved and nothing lists them: the three tiers have something waiting.
    await outsideWaiting(w, 'm-80', 80);
    await hours(w, 2);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'KMM' });
    expect((await w.progress()).outsideMasters).toMatchObject({ followed: 1, toList: 1 });
    // Listed: the platform keeps up again, and the missed cycles are forgotten.
    await w.listOutsideMaster(out('m-80'));
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'KMMK' });
    expect((await w.progress()).outsideMasters).toMatchObject({ toList: 0 });
  });

  test('an outside Master who is checked and did not play costs the Diamond target nothing', async () => {
    const w = await tracking(2, ['d-90', 'd-80']);
    await outside('m-80', 80);
    await db`
      UPDATE players SET matches_synced_until = ${new Date(t - 2 * HOUR)}
      WHERE puuid = ${out('m-80')}`;
    await w.refreshOutsideMasters();
    // Listed two hours ago by the previous version: the first check is the starting counter.
    expect(await w.checkOutsideMaster(out('m-80'))).toBe('first');
    await hours(w, 3);
    expect(await w.checkOutsideMaster(out('m-80'))).toBe('unchanged');
    await hour(w);
    expect(await diamond(w)).toMatchObject({ target: 2, cycles: 'KKK' });
    expect(listings()).not.toContain(`ids:${out('m-80')}`);
  });

  test('the games an outside Master brought still being fetched keep tier 3 waiting, and the cycle is missed', async () => {
    const w = await tracking(1, ['d-90'], { expandBelowPendingMatches: 1 });
    await hour(w);
    await outsideWaiting(w, 'm-80', 80);
    riot.matchIds.set(out('m-80'), ['EUW1_7000000501', 'EUW1_7000000502']);
    await w.listOutsideMaster(out('m-80'));
    // Nobody waits for a listing any more, but the two matches are not stored yet.
    await hour(w);
    expect(await diamond(w)).toMatchObject({ cycles: 'M' });
    expect((await w.progress()).outsideMasters).toMatchObject({ toList: 0, matchesWaiting: 2 });
    // One is stored, the other fails and goes to the back of the queue: tier 2 is done.
    await db`UPDATE match_fetch_queue SET status = 'DONE' WHERE match_id = 'EUW1_7000000501'`;
    await w.processMatch({ matchId: 'EUW1_7000000502', platform: 'EUW1', attempts: 0 });
    await hour(w);
    expect(await diamond(w)).toMatchObject({ cycles: 'MK' });
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
    const before = await tracking(2, ['d-90'], { diamondShrinkMissedCycles: 6 });
    expect(await trackedDiamonds()).toEqual(['d-90', 'd-80']);
    // Five cycles missed so far ('d-80' is waiting for a listing); the worker stops.
    await setTarget(2, 'KMMMMM');
    await touchWorkerStatus(db, 'EUW1', new Date(t));
    expect(await diamond(before)).toMatchObject({ tracked: 2 });
    if (longStop) t += 3 * HOUR;
    else t += MIN;

    // The target is read when the worker starts.
    const w = makeWorker({ diamondMaxTracked: 5, diamondStep: 1, diamondShrinkMissedCycles: 6 });
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
});
