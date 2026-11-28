/**
 * The Masters outside Riot's list, followed by a check of their own solo queue entry on the
 * platform host; and what makes room for those checks on that host (ranks stored by the Diamond
 * sweep, enrichment without a rank request, the mastery refresh interval). Needs
 * DATABASE_URL_TEST.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  enqueueMatchIds,
  ladderOrder,
  migrate,
  saveDiamondTracking,
  upsertDiamondLadder,
  upsertPatchStaticData,
} from '@pick-league/db';
import type { Division, LeagueListDto } from '@pick-league/shared';
import { PRIORITY, RiotAuthError } from '../riot/client.ts';
import { PlatformWorker, type SchedulerOptionsInput } from './platform-worker.ts';
import {
  DAY,
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
const dia = (name: string) => `fake-diamond-${name}`;
const out = (name: string) => `fake-outside-master-${name}`;

d('PlatformWorker: Masters outside the ladder lists (Postgres)', () => {
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

  const makeWorker = (options: SchedulerOptionsInput = {}) =>
    new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock,
      options: { idleMs: 10, expansionCheckMs: 10, ...options },
    });
  /** One of each at a time: the requests come in work order. */
  const serial = {
    listing: 1,
    match: 1,
    daily: 0,
    enrichment: 0,
    outsideCheck: 1,
    outsideListing: 1,
  };
  const none = {
    listing: 0,
    match: 0,
    daily: 0,
    enrichment: 0,
    outsideCheck: 0,
    outsideListing: 0,
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
  const setDivision = (division: Division, players: [string, number][], games = 30) => {
    riot.diamond[division] = players.map(([name, lp]) =>
      diamondEntry(dia(name), division, lp, games),
    );
  };
  const setTarget = (target: number) =>
    saveDiamondTracking(
      db,
      'EUW1',
      {
        target,
        cycles: '',
        lastCycleAt: null,
        settleCyclesLeft: 0,
        changedAt: null,
        changedFrom: null,
        changeReason: null,
        shrunkAt: null,
      },
      new Date(t),
    );
  /** Riot's answer for the solo queue entry of an outside Master: `games` wins + losses. */
  const setGames = (name: string, games: number) => {
    riot.leagueEntries.set(out(name), [soloEntry(out(name), 'MASTER', games)]);
  };
  /**
   * A Master outside Riot's list (seen in stored matches, ranked by enrichment), with `games`
   * wins + losses at Riot; `listedAt`: when their match ids were last listed (never without it).
   */
  const outside = async (name: string, games: number, listedAt?: number) => {
    await db`
      INSERT INTO players (puuid, platform, solo_tier, solo_lp, matches_synced_until)
      VALUES (${out(name)}, 'EUW1', 'MASTER', 50,
              ${listedAt === undefined ? null : new Date(listedAt - HOUR)})`;
    setGames(name, games);
  };
  /**
   * A worker following 'm', an outside Master listed an hour ago with 100 games: their first
   * check was the starting counter, at NOW.
   */
  const following = async (options: SchedulerOptionsInput = {}) => {
    await outside('m', 100, NOW - HOUR);
    const w = makeWorker(options);
    await w.refreshLadder();
    await w.listTrackedPlayer(A);
    expect(await w.checkOutsideMaster(out('m'))).toBe('first');
    riot.calls = [];
    return w;
  };
  /** `ms` later, Riot says 'm' has `games` games: checked again. */
  const checkedLater = async (w: PlatformWorker, ms: number, games: number) => {
    t += ms;
    setGames('m', games);
    return w.checkOutsideMaster(out('m'));
  };
  /** Stores a match of `players` that ended at `endMs`, as found through someone else. */
  const store = async (w: PlatformWorker, id: string, endMs: number, players: string[]) => {
    const m = makeTimedMatch(id, { startMs: endMs - 1_800_000, players });
    riot.matches.set(id, m);
    await enqueueMatchIds(db, 'EUW1', [id]);
    expect(await w.processMatch({ matchId: id, platform: 'EUW1', attempts: 0 })).toBe('added');
    riot.calls = riot.calls.filter((c) => !c.endsWith(`:${id}`));
  };
  const row = async (name: string) => {
    const [r] = await db<
      {
        games: number | null;
        checked: Date | null;
        changed: Date | null;
        listed_games: number | null;
        listed_snapshot: Date | null;
        listed_at: Date | null;
      }[]
    >`SELECT games, checked_at AS checked, games_changed_at AS changed, listed_games,
             listed_snapshot_at AS listed_snapshot, listed_at
      FROM outside_masters WHERE puuid = ${out(name)}`;
    return r
      ? {
          games: r.games,
          checked: r.checked?.getTime() ?? null,
          changed: r.changed?.getTime() ?? null,
          baseline: [
            r.listed_games,
            r.listed_snapshot?.getTime() ?? null,
            r.listed_at?.getTime() ?? null,
          ],
        }
      : null;
  };
  const player = async (puuid: string) => {
    const [r] = await db<
      {
        tier: string | null;
        division: number | null;
        lp: number | null;
        wins: number | null;
        requested: Date | null;
        synced: Date | null;
        rank_at: Date | null;
      }[]
    >`SELECT solo_tier AS tier, solo_division AS division, solo_lp AS lp, solo_wins AS wins,
             listing_requested_at AS requested, matches_synced_until AS synced,
             rank_refreshed_at AS rank_at
      FROM players WHERE puuid = ${puuid}`;
    return r
      ? {
          tier: r.tier,
          division: r.division,
          lp: r.lp,
          wins: r.wins,
          requested: r.requested?.getTime() ?? null,
          synced: r.synced?.getTime() ?? null,
          rankAt: r.rank_at?.getTime() ?? null,
        }
      : null;
  };
  const waitFor = async (cond: () => boolean | Promise<boolean>, tries = 400) => {
    for (let i = 0; i < tries && !(await cond()); i++) await Bun.sleep(10);
  };
  const calls = (prefix: string) => riot.calls.filter((c) => c.startsWith(prefix));
  const listings = () => calls('ids:').map((c) => c.replace(/:0$/, ''));
  const checks = () =>
    calls('entries:').map((c) =>
      c
        .replace('entries:fake-outside-master-', '')
        .replace(new RegExp(`:${PRIORITY.OUTSIDE_MASTER_CHECK}$`), ''),
    );
  const trackedDiamonds = async () =>
    (await ladderOrder(db, 'EUW1'))
      .filter((r) => r.tier === 'DIAMOND')
      .map((r) => r.puuid.replace('fake-diamond-', ''));
  /** Runs the worker's loops until `stop` is called. */
  const running = (w: PlatformWorker) => {
    const ac = new AbortController();
    const done = w.start(ac.signal);
    return async () => {
      await Bun.sleep(80);
      ac.abort();
      await done;
    };
  };

  // ---------------------------------------------------------------------------
  // The check
  // ---------------------------------------------------------------------------

  test('a first check has nothing to compare: the starting counter for a player listed within the safety interval, one listing for the others', async () => {
    await outside('never', 100);
    await outside('recent', 100, NOW - 10 * HOUR);
    await outside('yesterday', 100, NOW - 71 * HOUR);
    await outside('old', 100, NOW - 73 * HOUR);
    const w = makeWorker();
    await w.refreshLadder();
    expect((await w.progress()).outsideMasters).toEqual({
      followed: 4,
      checkedLastHour: 0,
      neverChecked: 4,
      oldestCheckMinutes: null,
      toList: 0,
      matchesWaiting: 0,
    });

    expect(await w.checkOutsideMaster(out('never'))).toBe('first-listing');
    expect(await w.checkOutsideMaster(out('recent'))).toBe('first');
    expect(await w.checkOutsideMaster(out('yesterday'))).toBe('first');
    expect(await w.checkOutsideMaster(out('old'))).toBe('first-listing');
    // On the platform host, at the priority of the checks; nothing on the regional host.
    expect(calls('entries:')).toEqual(
      ['never', 'recent', 'yesterday', 'old'].map(
        (name) => `entries:${out(name)}:${PRIORITY.OUTSIDE_MASTER_CHECK}`,
      ),
    );
    expect(listings()).toEqual([]);
    expect((await player(out('never')))?.requested).toBe(NOW);
    expect((await player(out('recent')))?.requested).toBeNull();
    expect((await player(out('old')))?.requested).toBe(NOW);
    // The counter is kept either way, with no baseline for the skip rule yet.
    expect(await row('recent')).toEqual({
      games: 100,
      checked: NOW,
      changed: NOW,
      baseline: [null, null, null],
    });
    // The check also refreshed the stored rank.
    expect(await player(out('recent'))).toMatchObject({ tier: 'MASTER', wins: 100, rankAt: NOW });
    expect((await w.progress()).outsideMasters).toMatchObject({
      followed: 4,
      checkedLastHour: 4,
      neverChecked: 0,
      oldestCheckMinutes: 0,
      toList: 2,
    });
    // How old a listing may be is the safety interval of the outside Masters.
    await outside('short', 100, NOW - 10 * HOUR);
    const strict = makeWorker({ listingSkipSafetyMs: { outsideMaster: 5 * HOUR } });
    await strict.refreshLadder();
    expect(await strict.checkOutsideMaster(out('short'))).toBe('first-listing');
  });

  test('start(): a counter that did not move costs no regional request; one that moved gets the player listed', async () => {
    await outside('m', 100, NOW - HOUR);
    const w = makeWorker({ concurrency: serial });
    const stop = running(w);
    await waitFor(() => checks().length === 1 && listings().includes(`ids:${A}`));
    await Bun.sleep(150);
    // Checked once: not again within the hour, and nothing to list.
    expect(checks()).toEqual(['m']);
    expect(listings()).toEqual([`ids:${A}`]);

    // An hour later: checked again, the counter is the same.
    t += HOUR;
    await waitFor(() => checks().length === 2);
    await Bun.sleep(150);
    expect(listings()).toEqual([`ids:${A}`]);
    expect(await row('m')).toMatchObject({ games: 100, checked: NOW + HOUR, changed: NOW });

    // Another hour later they have played two games.
    setGames('m', 102);
    t += HOUR;
    await waitFor(() => listings().length === 2);
    await stop();
    expect(checks()).toEqual(['m', 'm', 'm']);
    expect(listings()).toEqual([`ids:${A}`, `ids:${out('m')}`]);
    expect(riot.idQueries.map((q) => q.priority)).toEqual([undefined, PRIORITY.EXTRA_MATCH_IDS]);
    // Listed from where their last listing stopped.
    expect(riot.idQueries[1]?.startTime).toBe(Math.floor((NOW - 2 * HOUR) / 1000));
    expect(await row('m')).toMatchObject({ games: 102, changed: NOW + 2 * HOUR });
    expect(await player(out('m'))).toMatchObject({ requested: null, synced: NOW + HOUR });
    expect(await w.progress()).toMatchObject({ outsideMasterChecks: 3, extraPlayersPolled: 1 });
  });

  test('start(): an outside Master whose counter moved is listed after the apex players and before any Diamond player', async () => {
    setDivision('I', [['one', 50]]);
    await setTarget(1);
    const before = await following({ diamondMaxTracked: 5 });
    await before.refreshDiamonds();
    await before.listTrackedPlayer(dia('one'));
    // An hour later all three have played; the outside Master's check has seen it.
    riot.leagues.CHALLENGER.entries = [apex(A, 900, 51)];
    setDivision('I', [['one', 50]], 31);
    expect(await checkedLater(before, HOUR, 101)).toBe('played');
    riot.calls = [];
    riot.idQueries = [];
    const [MA, MM] = ['EUW1_7000000701', 'EUW1_7000000702'] as const;
    riot.matchIds.set(A, [MA]);
    riot.matchIds.set(out('m'), [MM]);
    for (const id of [MA, MM]) riot.matches.set(id, makeTimedMatch(id, { startMs: NOW }));

    // The worker restarts: the request of the outside Master is still there.
    const w = makeWorker({
      diamondMaxTracked: 5,
      expandBelowPendingMatches: 0,
      concurrency: serial,
    });
    const stop = running(w);
    await waitFor(() => riot.calls.includes(`ids:${dia('one')}:0`));
    await stop();
    expect(listings()).toEqual([`ids:${A}`, `ids:${out('m')}`, `ids:${dia('one')}`]);
    expect(riot.idQueries.map((q) => q.priority)).toEqual([
      undefined,
      PRIORITY.EXTRA_MATCH_IDS,
      PRIORITY.DIAMOND_ONE_MATCH_IDS,
    ]);
    // Their match is fetched in the band of the outside Masters, before the Diamond listing.
    expect(riot.calls.indexOf(`timeline:${MA}`)).toBeLessThan(
      riot.calls.indexOf(`ids:${out('m')}:0`),
    );
    expect(riot.calls.indexOf(`timeline:${MM}`)).toBeLessThan(
      riot.calls.indexOf(`ids:${dia('one')}:0`),
    );
    expect(riot.matchPriorities.get(MM)).toBe(PRIORITY.EXTRA_MATCH);
  });

  test('the snapshot of a counter is when Riot answered, not when the request was made', async () => {
    const w = await following();
    setGames('m', 101);
    t += HOUR;
    // The request waits 20 minutes (the Diamond sweep goes first on that host).
    let answer = () => {};
    riot.entriesGate = new Promise<void>((r) => {
      answer = r;
    });
    const check = w.checkOutsideMaster(out('m'));
    await waitFor(() => calls('entries:').length === 1);
    t += 20 * MIN;
    riot.entriesGate = null;
    answer();
    expect(await check).toBe('played');
    expect(await row('m')).toMatchObject({
      games: 101,
      checked: NOW + 80 * MIN,
      changed: NOW + 80 * MIN,
    });
    expect((await player(out('m')))?.requested).toBe(NOW + 80 * MIN);
  });

  test('a check that fails sends the player to the back of the rotation, counter untouched', async () => {
    const w = await following();
    t += HOUR;
    riot.errors.set(`entries:${out('m')}`, [new Error('boom')]);
    await expect(w.checkOutsideMaster(out('m'))).rejects.toThrow('boom');
    expect(await row('m')).toMatchObject({ games: 100, checked: NOW + HOUR, changed: NOW });
    expect((await player(out('m')))?.requested).toBeNull();
  });

  test('start(): a player Riot answers 403 for fails their check, without pausing the platform as a rejected key would', async () => {
    await outside('a', 100, NOW - HOUR);
    await outside('b', 100, NOW - HOUR);
    riot.errors.set(`entries:${out('a')}`, [new RiotAuthError(403, 'league-v4.entries', '/x')]);
    const w = makeWorker({ concurrency: { ...none, outsideCheck: 1 } });
    const stop = running(w);
    await waitFor(() => checks().length === 2);
    await stop();
    // The next player was checked right away, and the key is not reported as rejected.
    expect(checks()).toEqual(['a', 'b']);
    expect(await row('a')).toMatchObject({ games: null, checked: NOW });
    expect(await row('b')).toMatchObject({ games: 100 });
    const [status] = await db`SELECT auth_rejected_since, last_error FROM worker_status`;
    expect(status?.auth_rejected_since).toBeNull();
    expect(status?.last_error).toContain(
      'outside check: league entry of an outside Master refused',
    );
  });

  test('start(): checks refused one after the other are a rejected key: the platform pauses', async () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      await outside(name, 100, NOW - HOUR);
      riot.errors.set(`entries:${out(name)}`, [new RiotAuthError(403, 'league-v4.entries', '/x')]);
    }
    const w = makeWorker({ concurrency: { ...none, outsideCheck: 1 } });
    const stop = running(w);
    await waitFor(() => checks().length === 3);
    await Bun.sleep(150);
    await stop();
    // The third refusal in a row paused the checks: the fourth player was not asked for.
    expect(checks()).toEqual(['a', 'b', 'c']);
    const [status] = await db`SELECT auth_rejected_since FROM worker_status`;
    expect(status?.auth_rejected_since).not.toBeNull();
    // None of them is retried at once when the key works again.
    expect(await row('c')).toMatchObject({ games: null, checked: NOW });
  });

  // ---------------------------------------------------------------------------
  // The rotation and its place on the platform host
  // ---------------------------------------------------------------------------

  test('start(): least recently checked first, never checked before anyone, nobody twice within the interval', async () => {
    await outside('a', 100, NOW - HOUR);
    await outside('b', 100, NOW - HOUR);
    await outside('c', 100, NOW - HOUR);
    const before = makeWorker();
    await before.refreshLadder();
    await before.listTrackedPlayer(A);
    // 'b' was checked at 12:00 and 'c' at 12:10; 'a' never.
    expect(await before.checkOutsideMaster(out('b'))).toBe('first');
    t += 10 * MIN;
    expect(await before.checkOutsideMaster(out('c'))).toBe('first');
    t += 2 * MIN;
    const w = makeWorker({ concurrency: { ...none, outsideCheck: 1 } });
    const stop = running(w);
    await waitFor(() => checks().length === 3);
    await Bun.sleep(100);
    expect(checks()).toEqual(['b', 'c', 'a']);
    // 13:05: only 'b' was checked more than an hour ago.
    t = NOW + 65 * MIN;
    await waitFor(() => checks().length === 4);
    await Bun.sleep(100);
    expect(checks()).toEqual(['b', 'c', 'a', 'b']);
    // 13:20: 'c' and 'a' are due, 'c' first.
    t = NOW + 80 * MIN;
    await waitFor(() => checks().length === 6);
    await stop();
    expect(checks()).toEqual(['b', 'c', 'a', 'b', 'c', 'a']);
    // Nothing of it touched the regional host (the only listing is the apex player's, before).
    expect(listings()).toEqual([`ids:${A}`]);
  });

  test('start(): at most so many checks an hour', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await outside(name, 100, NOW - HOUR);
    // Four an hour: two at once (half an hour's worth), then one every 15 minutes.
    const w = makeWorker({ outsideCheckMaxPerHour: 4, concurrency: { ...none, outsideCheck: 2 } });
    const stop = running(w);
    await waitFor(() => checks().length === 2);
    await Bun.sleep(150);
    expect(checks().sort()).toEqual(['a', 'b']);
    t += 15 * MIN;
    await waitFor(() => checks().length === 3);
    await Bun.sleep(150);
    expect(checks().sort()).toEqual(['a', 'b', 'c']);
    // A quiet half hour is caught up, not more.
    t += 3 * HOUR;
    await waitFor(() => checks().length === 5);
    await Bun.sleep(150);
    await stop();
    expect(checks().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);

    // 0: the outside Masters are not checked at all.
    riot.calls = [];
    t += 3 * HOUR;
    const off = makeWorker({
      outsideCheckMaxPerHour: 0,
      concurrency: { ...none, outsideCheck: 2 },
    });
    const stopOff = running(off);
    await Bun.sleep(200);
    await stopOff();
    expect(checks()).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // The skip rule
  // ---------------------------------------------------------------------------

  test('on: no baseline before their first real listing as an outside Master → listed, and the baseline is the counter of the check', async () => {
    const w = await following({ listingSkip: 'on' });
    await store(w, 'EUW1_7000000001', NOW + 30 * MIN, [out('m')]);
    expect(await checkedLater(w, HOUR, 101)).toBe('played');
    expect(await w.listOutsideMaster(out('m'))).toBe('listed');
    expect(listings()).toEqual([`ids:${out('m')}`]);
    expect(await row('m')).toMatchObject({ baseline: [101, NOW + HOUR, NOW + HOUR] });
    expect((await player(out('m')))?.requested).toBeNull();
  });

  /** 'm' was really listed at NOW + 1 h on a counter of 101 games seen then. */
  const withBaseline = async (options: SchedulerOptionsInput = {}) => {
    const w = await following({ listingSkip: 'on', ...options });
    expect(await checkedLater(w, HOUR, 101)).toBe('played');
    expect(await w.listOutsideMaster(out('m'))).toBe('listed');
    riot.calls = [];
    return w;
  };

  test('on: the new games are all stored already → skipped, without a regional request', async () => {
    const w = await withBaseline();
    // Two games since, found through tracked players; the check of 15:00 counts both.
    await store(w, 'EUW1_7000000001', NOW + 90 * MIN, [out('m')]);
    await store(w, 'EUW1_7000000002', NOW + 150 * MIN, [out('m')]);
    expect(await checkedLater(w, 2 * HOUR, 103)).toBe('played');
    expect(await w.listOutsideMaster(out('m'))).toBe('skipped');
    expect(listings()).toEqual([]);
    // The request is gone; neither the listing window nor the baseline moved.
    expect(await player(out('m'))).toMatchObject({ requested: null, synced: NOW });
    expect(await row('m')).toMatchObject({ games: 103, baseline: [101, NOW + HOUR, NOW + HOUR] });
    expect((await w.progress()).listingsSkipped).toBe(1);
    // One more game that nobody else brought: listed, from where the last real listing stopped.
    expect(await checkedLater(w, HOUR, 104)).toBe('played');
    expect(await w.listOutsideMaster(out('m'))).toBe('listed');
    expect(riot.idQueries.at(-1)?.startTime).toBe(Math.floor(NOW / 1000));
    expect(await row('m')).toMatchObject({ baseline: [104, NOW + 4 * HOUR, NOW + 4 * HOUR] });
  });

  test('on: a game that ended too shortly before the check may not be in the counter: it does not explain the new game', async () => {
    const w = await withBaseline();
    // Ended 5 minutes before the check that saw one more game.
    await store(w, 'EUW1_7000000001', NOW + 115 * MIN, [out('m')]);
    expect(await checkedLater(w, HOUR, 102)).toBe('played');
    expect(await w.listOutsideMaster(out('m'))).toBe('listed');
    expect(listings()).toEqual([`ids:${out('m')}`]);
  });

  test('on: a game that ended after the check does not explain it either, nor one from before the baseline', async () => {
    const w = await withBaseline();
    // Before the check the baseline was taken on: it may be one of the 101 games.
    await store(w, 'EUW1_7000000001', NOW + 50 * MIN, [out('m')]);
    expect(await checkedLater(w, HOUR, 102)).toBe('played');
    // After the check that saw 102 games, while the player waits for their listing.
    t += 40 * MIN;
    await store(w, 'EUW1_7000000002', NOW + 150 * MIN, [out('m')]);
    expect(await w.listOutsideMaster(out('m'))).toBe('listed');
  });

  test('shadow: a would-be-skipped listing of an outside Master runs, and what it found is recorded', async () => {
    const w = await withBaseline({ listingSkip: 'shadow' });
    await store(w, 'EUW1_7000000001', NOW + 90 * MIN, [out('m')]);
    expect(await checkedLater(w, HOUR, 102)).toBe('played');
    riot.matchIds.set(out('m'), ['EUW1_7000000009']);
    expect(await w.listOutsideMaster(out('m'))).toBe('listed');
    const misses = await db<{ puuid: string; expected: number; new_match_ids: string[] }[]>`
      SELECT puuid, expected, new_match_ids FROM listing_skip_misses`;
    expect([...misses]).toEqual([
      { puuid: out('m'), expected: 1, new_match_ids: ['EUW1_7000000009'] },
    ]);
    // The baseline did not move, as in 'on'.
    expect(await row('m')).toMatchObject({ baseline: [101, NOW + HOUR, NOW + HOUR] });
  });

  test('on: the safety listing is every 72 h for outside Masters and Diamond players, every 24 h for apex players', async () => {
    setDivision('I', [['one', 50]]);
    await setTarget(1);
    const w = await withBaseline({ diamondMaxTracked: 5 });
    // All three were really listed at NOW + 1 h.
    await w.refreshLadder();
    await w.refreshDiamonds();
    expect(await w.listTrackedPlayer(A)).toBe('listed');
    expect(await w.listTrackedPlayer(dia('one'))).toBe('listed');
    const allPlayed = async (hours: number, id: string, games: number) => {
      t = NOW + hours * HOUR;
      await store(w, id, t - HOUR, [A, dia('one'), out('m')]);
      riot.leagues.CHALLENGER.entries = [apex(A, 900, 50 + games)];
      setDivision('I', [['one', 50]], 30 + games);
      setGames('m', 101 + games);
      await w.refreshLadder();
      await w.refreshDiamonds();
      expect(await w.checkOutsideMaster(out('m'))).toBe('played');
    };
    // 30 hours after their last real listing, each has one new game, stored already.
    await allPlayed(31, 'EUW1_7000000001', 1);
    expect(await w.listTrackedPlayer(A)).toBe('listed');
    expect(await w.listTrackedPlayer(dia('one'))).toBe('skipped');
    expect(await w.listOutsideMaster(out('m'))).toBe('skipped');
    // 72 hours after it: listed whatever is stored.
    await allPlayed(73, 'EUW1_7000000002', 2);
    expect(await w.listTrackedPlayer(dia('one'))).toBe('listed');
    expect(await w.listOutsideMaster(out('m'))).toBe('listed');
  });

  // ---------------------------------------------------------------------------
  // Leaving the set
  // ---------------------------------------------------------------------------

  test('a player who dropped to Diamond leaves the set at their check, and is a Diamond candidate like any other', async () => {
    const w = await following({ diamondMaxTracked: 5 });
    await setTarget(1);
    riot.leagueEntries.set(out('m'), [soloEntry(out('m'), 'DIAMOND', 104, 75, 'I')]);
    t += HOUR;
    expect(await w.checkOutsideMaster(out('m'))).toBe('left');
    expect(await row('m')).toBeNull();
    expect(await player(out('m'))).toMatchObject({
      tier: 'DIAMOND',
      division: 1,
      lp: 75,
      requested: null,
    });
    expect((await w.progress()).outsideMasters).toMatchObject({ followed: 0 });
    // A ladder refresh does not bring them back; the Diamond sweep finds them in Diamond I.
    riot.diamond.I = [diamondEntry(out('m'), 'I', 75, 94)];
    await w.refreshLadder();
    await w.refreshDiamonds();
    expect(await row('m')).toBeNull();
    expect((await ladderOrder(db, 'EUW1')).map((r) => [r.puuid, r.tier])).toEqual([
      [A, 'CHALLENGER'],
      [out('m'), 'DIAMOND'],
    ]);
  });

  test('a Master the Diamond sweep sees in Diamond leaves the set without a check; an unranked one at their check', async () => {
    const w = await following({ diamondMaxTracked: 5 });
    await outside('gone', 100, NOW - HOUR);
    await w.refreshOutsideMasters();
    await setTarget(0);
    riot.diamond.II = [diamondEntry(out('m'), 'II', 20, 95)];
    t += HOUR;
    await w.refreshDiamonds();
    expect(await row('m')).toBeNull();
    expect(await player(out('m'))).toMatchObject({ tier: 'DIAMOND', division: 2, lp: 20 });
    expect(calls('entries:')).toEqual([]);

    riot.leagueEntries.set(out('gone'), []);
    expect(await w.checkOutsideMaster(out('gone'))).toBe('left');
    expect(await player(out('gone'))).toMatchObject({ tier: null, rankAt: t });
    expect((await w.progress()).outsideMasters).toMatchObject({ followed: 0 });
  });

  test("a player Riot's list picks up is followed by the ladder: listed as a new ladder player, never checked again", async () => {
    const w = await following();
    expect(await checkedLater(w, HOUR, 101)).toBe('played');
    // Riot's Master list now has them.
    riot.leagues.MASTER.entries = [apex(out('m'), 400, 91)];
    await w.trackMoreMasters();
    expect(await row('m')).toBeNull();
    expect((await ladderOrder(db, 'EUW1')).map((r) => r.puuid)).toEqual([A, out('m')]);
    expect(await w.progress()).toMatchObject({
      playedToList: 1,
      outsideMasters: { followed: 0, toList: 0 },
    });
    // Their request is the ladder's now: listed in tier 1, at the apex players' priority.
    riot.calls = [];
    riot.idQueries = [];
    await w.listTrackedPlayer(out('m'));
    expect(riot.idQueries.map((q) => q.priority)).toEqual([undefined]);
    t += HOUR;
    const stop = running(makeWorker({ concurrency: { ...none, outsideCheck: 1 } }));
    await Bun.sleep(200);
    await stop();
    expect(calls('entries:')).toEqual([]);

    // And back: dropped off Riot's list while still Master, they are followed by checks again.
    riot.leagues.MASTER.entries = [];
    await w.refreshLadder();
    expect(await row('m')).toMatchObject({ games: null, baseline: [null, null, null] });
    expect(await w.checkOutsideMaster(out('m'))).toBe('first');
  });

  // ---------------------------------------------------------------------------
  // Room on the platform host
  // ---------------------------------------------------------------------------

  test('the Diamond sweep stores the rank of the players already known, whatever their division, and creates nobody', async () => {
    await db`INSERT INTO players (puuid, platform) VALUES (${dia('known')}, 'EUW1')`;
    await db`
      INSERT INTO players (puuid, platform, solo_tier, solo_division, solo_lp, rank_refreshed_at)
      VALUES (${dia('emerald')}, 'EUW1', 'EMERALD', 1, 99, ${new Date(NOW - 5 * DAY)})`;
    setDivision('I', [['one', 50]]);
    setDivision('III', [
      ['known', 33],
      ['unknown', 80],
    ]);
    setDivision('IV', [['emerald', 5]]);
    await setTarget(0);
    const w = makeWorker({ diamondMaxTracked: 5 });
    await w.refreshLadder();
    await w.refreshDiamonds();
    expect(await player(dia('known'))).toMatchObject({
      tier: 'DIAMOND',
      division: 3,
      lp: 33,
      wins: 30,
      rankAt: NOW,
    });
    expect(await player(dia('emerald'))).toMatchObject({ tier: 'DIAMOND', division: 4, lp: 5 });
    expect(await player(dia('unknown'))).toBeNull();
    expect(await player(dia('one'))).toBeNull();

    // An hour later nothing moved: the ranks are left alone. Half a day later they are touched.
    t += HOUR;
    await w.refreshDiamonds();
    expect((await player(dia('known')))?.rankAt).toBe(NOW);
    t += 12 * HOUR;
    await w.refreshDiamonds();
    expect((await player(dia('known')))?.rankAt).toBe(NOW + 13 * HOUR);
    // A page that fails loses the sweep, not the ranks of the pages read before it.
    setDivision('III', [['known', 44]], 31);
    riot.errors.set('diamond:IV:1', [new Error('boom')]);
    t += HOUR;
    await expect(w.refreshDiamonds()).rejects.toThrow('boom');
    expect(await player(dia('known'))).toMatchObject({ lp: 44, wins: 31, rankAt: NOW + 14 * HOUR });
  });

  test('enrichment asks for the rank only when the stored one is old: masteries alone otherwise', async () => {
    const w = makeWorker();
    await w.refreshLadder();
    const m = makeTimedMatch('EUW1_7000000500', { startMs: NOW - HOUR });
    riot.matches.set('EUW1_7000000500', m);
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000500']);
    await w.processMatch({ matchId: 'EUW1_7000000500', platform: 'EUW1', attempts: 0 });
    const [fresh, stale, never] = m.match.info.participants.slice(1, 4).map((p) => p.puuid) as [
      string,
      string,
      string,
    ];
    // The sweep stored the first one's rank two hours ago; the second one's is 25 hours old.
    await db`
      UPDATE players SET solo_tier = 'DIAMOND', solo_division = 1, solo_lp = 77,
        rank_refreshed_at = ${new Date(NOW - 2 * HOUR)}
      WHERE puuid = ${fresh}`;
    await db`
      UPDATE players SET solo_tier = 'EMERALD', solo_division = 1, solo_lp = 12,
        rank_refreshed_at = ${new Date(NOW - 25 * HOUR)}
      WHERE puuid = ${stale}`;
    riot.calls = [];
    for (const puuid of [fresh, stale, never]) {
      await w.enrich({ puuid, platform: 'EUW1', attempts: 0 });
    }
    expect(riot.calls).toEqual([
      `mastery:${fresh}:${PRIORITY.ENRICHMENT}`,
      `mastery:${stale}:${PRIORITY.ENRICHMENT}`,
      `entries:${stale}:${PRIORITY.ENRICHMENT}`,
      `mastery:${never}:${PRIORITY.ENRICHMENT}`,
      `entries:${never}:${PRIORITY.ENRICHMENT}`,
    ]);
    // The fresh rank stays as it was; the others are what Riot said.
    expect(await player(fresh)).toMatchObject({
      tier: 'DIAMOND',
      division: 1,
      lp: 77,
      rankAt: NOW - 2 * HOUR,
    });
    expect(await player(stale)).toMatchObject({
      tier: 'DIAMOND',
      division: 2,
      lp: 42,
      rankAt: NOW,
    });
    expect(await player(never)).toMatchObject({ tier: 'DIAMOND', division: 2, rankAt: NOW });
    // All three have their masteries and left the queue.
    const left = await db<{ puuid: string }[]>`
      SELECT puuid FROM player_enrichment_queue WHERE puuid = ANY(${[fresh, stale, never]})`;
    expect([...left]).toEqual([]);
    const refreshed = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM players
      WHERE puuid = ANY(${[fresh, stale, never]}) AND masteries_refreshed_at IS NOT NULL`;
    expect(refreshed[0]?.n).toBe(3);
    expect(await w.progress()).toMatchObject({ enriched: 3, enrichedRankFresh: 1 });
    // How fresh is an option.
    const strict = makeWorker({ enrichmentRankFreshMs: HOUR });
    riot.calls = [];
    await db`INSERT INTO player_enrichment_queue (puuid, platform) VALUES (${fresh}, 'EUW1')`;
    await strict.enrich({ puuid: fresh, platform: 'EUW1', attempts: 0 });
    expect(riot.calls).toContain(`entries:${fresh}:${PRIORITY.ENRICHMENT}`);
  });

  test('start(): masteries of a tracked player are fetched again after three days, or the interval asked for', async () => {
    const masteries = () => calls(`mastery:${A}:${PRIORITY.DAILY_REFRESH}`).length;
    const w = makeWorker({ concurrency: { ...none, daily: 1 } });
    const stop = running(w);
    await waitFor(() => masteries() === 1);
    // A day later, then two: not yet.
    for (const days of [1, 2, 2.9]) {
      t = NOW + days * DAY;
      await Bun.sleep(120);
      expect(masteries()).toBe(1);
    }
    t = NOW + 3 * DAY + MIN;
    await waitFor(() => masteries() === 2);
    await stop();
    expect(masteries()).toBe(2);

    const daily = makeWorker({
      masteryRefreshIntervalMs: DAY,
      concurrency: { ...none, daily: 1 },
    });
    t += DAY + MIN;
    const stopDaily = running(daily);
    await waitFor(() => masteries() === 3);
    await stopDaily();
    expect(masteries()).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Diamond candidates
  // ---------------------------------------------------------------------------

  test('Diamond candidates: seen in a Master+ game first, then down the ladder; a player tracked before whom better candidates pass leaves', async () => {
    // As the previous version left them: a Diamond II and a Diamond I player, neither seen in a
    // Master+ game; and a Diamond IV player who was, an hour ago.
    await upsertDiamondLadder(
      db,
      'EUW1',
      [
        { puuid: dia('two'), tier: 'DIAMOND', division: 2, leaguePoints: 90, wins: 30, losses: 10 },
        { puuid: dia('one'), tier: 'DIAMOND', division: 1, leaguePoints: 10, wins: 30, losses: 10 },
      ],
      { keep: 'all', now: new Date(NOW - HOUR) },
    );
    await db`
      INSERT INTO players (puuid, platform, last_seen_with_master_at)
      VALUES (${dia('four')}, 'EUW1', ${new Date(NOW - HOUR)})`;
    setDivision('I', [
      ['one', 10],
      ['other-one', 60],
    ]);
    setDivision('II', [
      ['two', 90],
      ['other-two', 99],
    ]);
    setDivision('IV', [['four', 5]]);
    // Three: the Diamond IV player seen in a Master+ game, then the two Diamond I players; the
    // Diamond II players come after them.
    await setTarget(3);
    const w = makeWorker({ diamondMaxTracked: 10 });
    await w.refreshLadder();
    await w.refreshDiamonds();
    expect(await trackedDiamonds()).toEqual(['other-one', 'one', 'four']);
    expect((await w.progress()).diamond).toMatchObject({
      target: 3,
      tracked: 3,
      trackedWithMaster: 1,
    });
    // The player who left is not waiting for a listing any more (the apex player and the three
    // tracked Diamond players are: none was ever listed).
    expect((await w.progress()).playedToList).toBe(4);
    // A restart reads the same two groups from what is stored.
    const restarted = makeWorker({ diamondMaxTracked: 10 });
    expect((await restarted.progress()).diamond).toMatchObject({
      tracked: 3,
      trackedWithMaster: 1,
    });
  });
});
