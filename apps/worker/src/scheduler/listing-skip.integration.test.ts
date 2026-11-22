import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  enqueueMatchIds,
  getMatchesSyncedUntil,
  migrate,
  upsertPatchStaticData,
} from '@pick-league/db';
import { type ListingSkipMode, PlatformWorker, type SchedulerOptions } from './platform-worker.ts';
import {
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
const P = ladderPuuid(0);
const P1 = ladderPuuid(1);

d('PlatformWorker: listing skip rule (Postgres)', () => {
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
  });

  afterAll(async () => {
    await db?.end();
  });

  type Options = Partial<Omit<SchedulerOptions, 'concurrency'>> & {
    concurrency?: Partial<SchedulerOptions['concurrency']>;
  };
  const makeWorker = (listingSkip: ListingSkipMode | undefined, options: Options = {}) =>
    new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock,
      options: { idleMs: 10, ...(listingSkip ? { listingSkip } : {}), ...options },
    });

  /** The Challenger ladder: player i has `wins[i]` wins and 10 losses. */
  const setLadder = (wins: number[]) => {
    riot.leagues.CHALLENGER.entries = wins.map((w, i) => ({
      puuid: ladderPuuid(i),
      leaguePoints: 1000 - i,
      rank: 'I',
      wins: w,
      losses: 10,
      veteran: false,
      inactive: false,
      freshBlood: false,
      hotStreak: false,
    }));
  };

  /** Stores a match of `players` that ended at `endMs`, as found through someone else. */
  const store = async (
    w: PlatformWorker,
    id: string,
    endMs: number,
    players: readonly string[],
    remake = false,
  ) => {
    const durationS = remake ? 200 : 1800;
    const m = makeTimedMatch(id, { startMs: endMs - durationS * 1000, players, remake });
    riot.matches.set(id, m);
    await enqueueMatchIds(db, 'EUW1', [id]);
    expect(await w.processMatch({ matchId: id, platform: 'EUW1', attempts: 0 })).toBe('added');
    riot.calls = riot.calls.filter((c) => !c.endsWith(`:${id}`));
  };

  /**
   * P is tracked with 50 wins (60 games) at NOW and was really listed then: the baseline of the
   * rule is 60 games at NOW.
   */
  const tracked = async (mode: ListingSkipMode | undefined, options: Options = {}) => {
    const w = makeWorker(mode, options);
    setLadder([50]);
    await w.refreshLadder();
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    riot.calls = [];
    riot.idQueries = [];
    return w;
  };

  /** An hour later, the ladder shows P with `wins` wins: they played. */
  const anHourLater = async (w: PlatformWorker, wins: number) => {
    t += HOUR;
    setLadder([wins]);
    expect(await w.refreshLadder()).toBe(1);
  };

  const idsCalls = () => riot.calls.filter((c) => c.startsWith('ids:'));
  const baseline = async (puuid: string) => {
    const [row] = await db<
      { games: number | null; snapshot: Date | null; at: Date | null }[]
    >`SELECT listed_games AS games, listed_snapshot_at AS snapshot, listed_at AS at
      FROM ladder_entries WHERE puuid = ${puuid}`;
    return row ? [row.games, row.snapshot?.getTime() ?? null, row.at?.getTime() ?? null] : null;
  };
  const listingRequestedAt = async (puuid: string) => {
    const [row] = await db<{ t: Date | null }[]>`
      SELECT listing_requested_at AS t FROM players WHERE puuid = ${puuid}`;
    return row?.t?.getTime() ?? null;
  };
  const misses = async () =>
    [
      ...(await db`
        SELECT puuid, platform, checked_at, listed_snapshot_at, snapshot_at, expected, stored,
               new_match_ids FROM listing_skip_misses ORDER BY id`),
    ].map((r) => ({ ...r }));

  test('on: new games all stored → not listed; the request is cleared and nothing else moves', async () => {
    const w = await tracked('on');
    expect(await baseline(P)).toEqual([60, NOW, NOW]);
    await store(w, 'EUW1_7000000001', NOW + 40 * MIN, [P]);
    await anHourLater(w, 51);
    expect(await listingRequestedAt(P)).toBe(NOW + HOUR);

    expect(await w.listTrackedPlayer(P)).toBe('skipped');
    expect(idsCalls()).toEqual([]);
    expect(await listingRequestedAt(P)).toBeNull();
    expect(await getMatchesSyncedUntil(db, P)).toEqual(new Date(NOW - HOUR));
    expect(await baseline(P)).toEqual([60, NOW, NOW]);
    expect(await w.progress()).toMatchObject({
      listingsSkipped: 1,
      listingSkipMisses: 0,
      playersPolled: 1,
    });

    // The counts are cumulative: a second game, stored too, is explained as well.
    await store(w, 'EUW1_7000000002', NOW + 100 * MIN, [P]);
    await anHourLater(w, 52);
    expect(await w.listTrackedPlayer(P)).toBe('skipped');
    expect(await baseline(P)).toEqual([60, NOW, NOW]);

    // A third one that is not stored: a real listing, which covers the whole period.
    await anHourLater(w, 53);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(riot.idQueries.map((q) => q.startTime)).toEqual([Math.floor((NOW - HOUR) / 1000)]);
    expect(await baseline(P)).toEqual([63, NOW + 3 * HOUR, NOW + 3 * HOUR]);
    expect(await getMatchesSyncedUntil(db, P)).toEqual(new Date(NOW + 2 * HOUR));
    expect(await listingRequestedAt(P)).toBeNull();
    expect((await w.progress()).listingsSkipped).toBe(2);
  });

  test('on: one game missing → listed, and the baseline moves to that listing', async () => {
    const w = await tracked('on');
    await store(w, 'EUW1_7000000001', NOW + 20 * MIN, [P]);
    await anHourLater(w, 52);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(idsCalls()).toEqual([`ids:${P}:0`]);
    expect(await baseline(P)).toEqual([62, NOW + HOUR, NOW + HOUR]);
    expect((await w.progress()).listingsSkipped).toBe(0);
  });

  test('on: only games that ended after the baseline snapshot and by the current one count', async () => {
    const w = await tracked('on');
    // Ended after the ladder refresh that showed the new game: it is not that game.
    await store(w, 'EUW1_7000000001', NOW + HOUR + 5 * MIN, [P]);
    // Ended before the last real listing's snapshot: already counted then.
    await store(w, 'EUW1_7000000002', NOW - 10 * MIN, [P]);
    await store(w, 'EUW1_7000000003', NOW, [P]);
    await anHourLater(w, 51);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(await baseline(P)).toEqual([61, NOW + HOUR, NOW + HOUR]);

    // A game that ended 15 minutes before the snapshot is in the counters. The one stored above,
    // which ended 5 minutes after the previous snapshot, is in this window too: 2 expected, 2
    // stored.
    await store(w, 'EUW1_7000000004', NOW + 2 * HOUR - 15 * MIN, [P]);
    await anHourLater(w, 53);
    expect(await w.listTrackedPlayer(P)).toBe('skipped');
  });

  test('on: a game that ended shortly before the ladder refresh does not count (Riot counts it late)', async () => {
    const w = await tracked('on');
    // One new game on the ladder, and the only stored one ended 10 minutes before the refresh:
    // the ladder may not have it yet, so the counted game may be another one, not stored.
    await store(w, 'EUW1_7000000001', NOW + 50 * MIN, [P]);
    await anHourLater(w, 51);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(await baseline(P)).toEqual([61, NOW + HOUR, NOW + HOUR]);
  });

  test('on: the margin for games Riot counts late is an option', async () => {
    const w = await tracked('on', { listingSkipLadderLagMs: 5 * MIN });
    await store(w, 'EUW1_7000000001', NOW + 50 * MIN, [P]);
    await anHourLater(w, 51);
    expect(await w.listTrackedPlayer(P)).toBe('skipped');
  });

  test('on: a remake does not count', async () => {
    const w = await tracked('on');
    await store(w, 'EUW1_7000000001', NOW + 30 * MIN, [P], true);
    await anHourLater(w, 51);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
  });

  test('on: a game of other players does not count', async () => {
    const w = await tracked('on');
    await store(w, 'EUW1_7000000001', NOW + 30 * MIN, ['fake-other-player']);
    await anHourLater(w, 51);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
  });

  test('on: no baseline → listed', async () => {
    const w = makeWorker('on');
    setLadder([50]);
    await w.refreshLadder();
    await store(w, 'EUW1_7000000001', NOW - 30 * MIN, [P]);
    expect(await baseline(P)).toEqual([null, null, null]);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(idsCalls()).toEqual([`ids:${P}:0`]);
    expect(await baseline(P)).toEqual([60, NOW, NOW]);
  });

  test('on: counters that went down (season reset) → listed', async () => {
    const w = await tracked('on');
    await store(w, 'EUW1_7000000001', NOW + 30 * MIN, [P]);
    await anHourLater(w, 1);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(await baseline(P)).toEqual([11, NOW + HOUR, NOW + HOUR]);
  });

  test('on: a last real listing older than the safety interval → listed', async () => {
    const w = await tracked('on', { listingSkipSafetyMs: 3 * HOUR });
    await store(w, 'EUW1_7000000001', NOW + 30 * MIN, [P]);
    await anHourLater(w, 51);
    expect(await w.listTrackedPlayer(P)).toBe('skipped');
    await store(w, 'EUW1_7000000002', NOW + 90 * MIN, [P]);
    await anHourLater(w, 52);
    expect(await w.listTrackedPlayer(P)).toBe('skipped');
    // Three hours after the last real listing: listed although the new game is stored.
    await store(w, 'EUW1_7000000003', NOW + 150 * MIN, [P]);
    await anHourLater(w, 53);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(await baseline(P)).toEqual([63, NOW + 3 * HOUR, NOW + 3 * HOUR]);
    // By default the interval is 24 hours.
    const byDefault = makeWorker('on');
    await store(byDefault, 'EUW1_7000000004', NOW + 200 * MIN, [P]);
    t += 22 * HOUR;
    setLadder([54]);
    await byDefault.refreshLadder();
    expect(await byDefault.listTrackedPlayer(P)).toBe('skipped');
    await store(byDefault, 'EUW1_7000000005', NOW + 25 * HOUR + 30 * MIN, [P]);
    t += 2 * HOUR;
    setLadder([55]);
    await byDefault.refreshLadder();
    expect(await byDefault.listTrackedPlayer(P)).toBe('listed');
  });

  test('on: a player who left the tracked ladder meanwhile is listed as before', async () => {
    const w = await tracked('on');
    await db`DELETE FROM ladder_entries`;
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(idsCalls()).toEqual([`ids:${P}:0`]);
  });

  test('shadow: lists anyway, records what a skip would have missed, keeps the baseline', async () => {
    const w = await tracked('shadow');
    expect(await baseline(P)).toEqual([60, NOW, NOW]);
    await store(w, 'EUW1_7000000001', NOW + 40 * MIN, [P]);
    await anHourLater(w, 51);
    // The listing finds the stored match and one nobody knew.
    riot.matchIds.set(P, ['EUW1_7000000900', 'EUW1_7000000001']);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(idsCalls()).toEqual([`ids:${P}:0`]);
    expect(await misses()).toEqual([
      {
        puuid: P,
        platform: 'EUW1',
        checked_at: new Date(NOW + HOUR),
        listed_snapshot_at: new Date(NOW),
        snapshot_at: new Date(NOW + HOUR),
        expected: 1,
        stored: 1,
        new_match_ids: ['EUW1_7000000900'],
      },
    ]);
    // A real listing as far as the data goes; the baseline is where 'on' would have left it.
    expect(await getMatchesSyncedUntil(db, P)).toEqual(new Date(NOW));
    expect(await listingRequestedAt(P)).toBeNull();
    expect(await baseline(P)).toEqual([60, NOW, NOW]);
    expect(await w.progress()).toMatchObject({
      listingsSkipped: 1,
      listingSkipMisses: 1,
      playersPolled: 2,
    });

    // A would-be skip whose listing brings nothing new is counted, not recorded.
    await store(w, 'EUW1_7000000002', NOW + 100 * MIN, [P]);
    await anHourLater(w, 52);
    riot.matchIds.set(P, ['EUW1_7000000002']);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(await misses()).toHaveLength(1);
    expect(await baseline(P)).toEqual([60, NOW, NOW]);
    expect(await w.progress()).toMatchObject({ listingsSkipped: 2, listingSkipMisses: 1 });

    // Not explained: an ordinary listing, which sets the baseline.
    await anHourLater(w, 53);
    expect(await w.listTrackedPlayer(P)).toBe('listed');
    expect(await baseline(P)).toEqual([63, NOW + 3 * HOUR, NOW + 3 * HOUR]);
    expect(await w.progress()).toMatchObject({
      listingsSkipped: 2,
      listingSkipMisses: 1,
      playersPolled: 4,
    });
  });

  test.each([['off' as const], [undefined]])(
    'off (%p): every player who played is listed, no baseline, nothing counted',
    async (mode) => {
      const w = await tracked(mode);
      expect(await baseline(P)).toEqual([null, null, null]);
      await store(w, 'EUW1_7000000001', NOW + 40 * MIN, [P]);
      await anHourLater(w, 51);
      expect(await w.listTrackedPlayer(P)).toBe('listed');
      expect(idsCalls()).toEqual([`ids:${P}:0`]);
      expect(await baseline(P)).toEqual([null, null, null]);
      expect(await getMatchesSyncedUntil(db, P)).toEqual(new Date(NOW));
      expect(await misses()).toEqual([]);
      expect(await w.progress()).toMatchObject({
        listingsSkipped: 0,
        listingSkipMisses: 0,
        playersPolled: 2,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // The loops: a listing's matches before the next players are decided
  // ---------------------------------------------------------------------------

  const waitFor = async (cond: () => boolean | Promise<boolean>, tries = 300) => {
    for (let i = 0; i < tries && !(await cond()); i++) await Bun.sleep(10);
  };
  const riotWork = () =>
    riot.calls.filter((c) => /^(ids|match|timeline):/.test(c)).map((c) => c.replace(/:0$/, ''));
  /** One listing and one match at a time, so the order of the requests is the order of the work. */
  const serial = { listing: 1, match: 1, daily: 0, enrichment: 0, extraListing: 0 };
  const SHARED = 'EUW1_7000000100';

  /**
   * P and P1 were listed at NOW (baselines). An hour later the ladder shows one more game for
   * both: the same match, which only P's listing will bring.
   */
  const twoPlayersOneMatch = async (mode: ListingSkipMode) => {
    const before = makeWorker(mode);
    setLadder([50, 50]);
    await before.refreshLadder();
    await before.listTrackedPlayer(P);
    await before.listTrackedPlayer(P1);
    // The worker that runs the loops starts with nothing left to list.
    const w = makeWorker(mode, { concurrency: serial });
    t += HOUR;
    setLadder([51, 51]);
    riot.matches.set(SHARED, makeTimedMatch(SHARED, { startMs: NOW + 10 * MIN, players: [P, P1] }));
    riot.matchIds.set(P, [SHARED]);
    riot.matchIds.set(P1, [SHARED]);
    riot.calls = [];
    return w;
  };

  test('on, start(): the match a listing brings is stored before the next player is decided, who is then skipped', async () => {
    const w = await twoPlayersOneMatch('on');
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(async () => (await w.progress()).listingsSkipped === 1);
    await Bun.sleep(50);
    ac.abort();
    await running;

    expect(riotWork()).toEqual([`ids:${P}`, `match:${SHARED}`, `timeline:${SHARED}`]);
    expect(await listingRequestedAt(P1)).toBeNull();
    expect(await w.progress()).toMatchObject({
      listingsSkipped: 1,
      playedToList: 0,
      pendingMatches: 0,
    });
    expect(await baseline(P)).toEqual([61, NOW + HOUR, NOW + HOUR]);
    expect(await baseline(P1)).toEqual([60, NOW, NOW]);
  });

  test('shadow, start(): same order, and the second player is listed anyway', async () => {
    const w = await twoPlayersOneMatch('shadow');
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => riot.calls.includes(`ids:${P1}:0`));
    await Bun.sleep(50);
    ac.abort();
    await running;

    expect(riotWork()).toEqual([`ids:${P}`, `match:${SHARED}`, `timeline:${SHARED}`, `ids:${P1}`]);
    // P1's listing brought nothing new: a would-be skip without a miss.
    expect(await w.progress()).toMatchObject({ listingsSkipped: 1, listingSkipMisses: 0 });
    expect(await misses()).toEqual([]);
    expect(await baseline(P1)).toEqual([60, NOW, NOW]);
  });

  test('off, start(): both players are listed whatever is stored', async () => {
    const w = await twoPlayersOneMatch('off');
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(async () => (await w.progress()).pendingMatches === 0 && riotWork().length >= 4);
    ac.abort();
    await running;

    expect(riotWork().filter((c) => c.startsWith('ids:'))).toEqual([`ids:${P}`, `ids:${P1}`]);
    expect((await w.progress()).listingsSkipped).toBe(0);
  });

  test.each([['shadow' as const], ['on' as const]])(
    '%s, start(): a player waits for the matches of better-placed players, not for their own or later ones',
    async (mode) => {
      const w = makeWorker(mode, {
        concurrency: { listing: 1, match: 4, daily: 0, enrichment: 0, extraListing: 0 },
      });
      setLadder([50, 50, 50]);
      const P2 = ladderPuuid(2);
      // Four matches whose fetch hangs until released.
      const hanging = (id: string, players: string[] = []) => {
        riot.matches.set(id, makeTimedMatch(id, { startMs: NOW - HOUR, players }));
        let release = () => {};
        riot.matchGates.set(
          id,
          new Promise<void>((r) => {
            release = r;
          }),
        );
        return { id, release: () => release() };
      };
      const first = hanging('EUW1_7000000200', [P]); // brought by P's listing: rank 0
      const mine = hanging('EUW1_7000000201'); // listed by P1: rank 1
      const untracked = hanging('EUW1_7000000202'); // listed by an untracked player: rank 3
      const retried = hanging('EUW1_7000000203'); // at the back of the queue
      riot.matchIds.set(P, [first.id]);
      // P's listing is held while the three other matches are queued and claimed.
      let openIds = () => {};
      riot.idsGate = new Promise<void>((r) => {
        openIds = r;
      });
      const ids = () => riotWork().filter((c) => c.startsWith('ids:'));
      const fetching = (m: { id: string }) => riot.calls.includes(`match:${m.id}`);

      const ac = new AbortController();
      const running = w.start(ac.signal);
      await waitFor(() => riot.calls.includes(`ids:${P}:0`));
      await Bun.sleep(100);
      await enqueueMatchIds(db, 'EUW1', [mine.id], 1);
      await enqueueMatchIds(db, 'EUW1', [untracked.id], 3);
      await enqueueMatchIds(db, 'EUW1', [retried.id]);
      await waitFor(() => fetching(mine) && fetching(untracked) && fetching(retried));
      riot.idsGate = null;
      openIds();
      await waitFor(() => fetching(first));
      await Bun.sleep(150);
      // P1 and P2 wait for the match P's listing brought.
      expect(ids()).toEqual([`ids:${P}`]);
      expect((await w.progress()).playedToList).toBe(2);

      // Once it is stored P1 is listed: its own match, and those after it, do not hold it.
      first.release();
      await waitFor(() => ids().length === 2);
      await Bun.sleep(150);
      expect(ids()).toEqual([`ids:${P}`, `ids:${P1}`]);
      // P2 waits for P1's match only.
      mine.release();
      await waitFor(() => ids().length === 3);
      expect(ids()).toEqual([`ids:${P}`, `ids:${P1}`, `ids:${P2}`]);
      expect(riot.calls).not.toContain(`timeline:${untracked.id}`);
      expect(riot.calls).not.toContain(`timeline:${retried.id}`);

      untracked.release();
      retried.release();
      ac.abort();
      await running;
    },
  );

  test('on, start(): a match that stays unfetched holds the listings at most listingGateMaxWaitMs', async () => {
    const started = Date.now();
    const w = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      // Real time passes on this clock.
      clock: { ...fixedClock, now: () => NOW + (Date.now() - started) },
      options: {
        idleMs: 10,
        listingSkip: 'on',
        listingGateMaxWaitMs: 300,
        concurrency: serial,
      },
    });
    setLadder([50, 50]);
    const stuck = 'EUW1_7000000300';
    riot.matches.set(stuck, makeTimedMatch(stuck, { startMs: NOW - HOUR, players: [P] }));
    riot.matchIds.set(P, [stuck]);
    let open = () => {};
    riot.matchGates.set(
      stuck,
      new Promise<void>((r) => {
        open = r;
      }),
    );

    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => riot.calls.includes(`match:${stuck}`));
    const heldAt = Date.now();
    await waitFor(() => riot.calls.includes(`ids:${P1}:0`), 500);
    const held = Date.now() - heldAt;
    expect(riot.calls).toContain(`ids:${P1}:0`);
    expect(riot.calls).not.toContain(`timeline:${stuck}`);
    expect(held).toBeGreaterThanOrEqual(200);
    open();
    ac.abort();
    await running;
  });
});
