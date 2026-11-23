import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  DIAMOND_FETCH_RANK,
  DIAMOND_ONE_FETCH_RANK,
  enqueueMatchIds,
  ladderOrder,
  listWorkerStatus,
  migrate,
  saveDiamondTracking,
  upsertPatchStaticData,
} from '@pick-league/db';
import type { Division, LeagueListDto } from '@pick-league/shared';
import { PRIORITY, RiotHttpError } from '../riot/client.ts';
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
  staticPatch,
} from './test-helpers.ts';

const URL = process.env.DATABASE_URL_TEST;
const d = URL ? describe : describe.skip;

const HOUR = 3_600_000;
const CHALLENGER = ladderPuuid(0);
const dia = (name: string) => `fake-diamond-${name}`;

d('PlatformWorker: Diamond players (Postgres)', () => {
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
    riot.leagues.CHALLENGER.entries = [apex(CHALLENGER, 900)];
  });

  afterAll(async () => {
    await db?.end();
  });

  type Options = SchedulerOptionsInput;
  const makeWorker = (options: Options = {}) =>
    new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock,
      options: { idleMs: 10, ...options },
    });

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

  /** Riot's Diamond division: [name, LP, wins?] per player. */
  const setDivision = (division: Division, players: [string, number, number?][]) => {
    riot.diamond[division] = players.map(([name, lp, wins]) =>
      diamondEntry(dia(name), division, lp, wins ?? 30),
    );
  };
  /** The players were in a stored match with a Master+ player `agoMs` ago. */
  const seenWithMaster = async (names: string[], agoMs = HOUR) => {
    for (const name of names) {
      await db`
        INSERT INTO players (puuid, platform, last_seen_with_master_at)
        VALUES (${dia(name)}, 'EUW1', ${new Date(t - agoMs)})
        ON CONFLICT (puuid) DO UPDATE SET
          last_seen_with_master_at = EXCLUDED.last_seen_with_master_at`;
    }
  };
  /** The Diamond target of the platform, as the worker left it earlier. */
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
  /** Tracked Diamond players in ladder order, without the 'fake-diamond-' prefix. */
  const trackedDiamonds = async () =>
    (await ladderOrder(db, 'EUW1'))
      .filter((r) => r.tier === 'DIAMOND')
      .map((r) => r.puuid.replace('fake-diamond-', ''));
  const diamondCalls = () => riot.calls.filter((c) => c.startsWith('diamond:'));
  const entryOf = async (name: string) => {
    const [row] = await db<
      { division: number; lp: number; games: number; seen: Date }[]
    >`SELECT division, league_points AS lp, wins + losses AS games, updated_at AS seen
      FROM ladder_entries WHERE puuid = ${dia(name)} AND tier = 'DIAMOND'`;
    return row ? { ...row } : null;
  };
  const waitFor = async (cond: () => boolean | Promise<boolean>, tries = 300) => {
    for (let i = 0; i < tries && !(await cond()); i++) await Bun.sleep(10);
  };

  /** Seven Diamond players over the four divisions; five were seen with a Master+ player. */
  const sevenPlayers = async () => {
    setDivision('I', [
      ['one-80', 80],
      ['one-60', 60],
      ['one-90', 90],
    ]);
    setDivision('II', [
      ['two-70', 70],
      ['two-95', 95],
    ]);
    setDivision('III', [['three-10', 10]]);
    setDivision('IV', [['four-50', 50]]);
    await seenWithMaster(['one-60', 'two-95', 'two-70', 'three-10', 'four-50']);
    // Too long ago to count.
    await seenWithMaster(['one-90'], 8 * DAY);
  };

  test('off by default: no Diamond request, nothing tracked', async () => {
    await sevenPlayers();
    const w = makeWorker({ concurrency: { daily: 0, enrichment: 0 } });
    await w.refreshLadder();
    expect(await w.refreshDiamonds()).toBeNull();
    await w.startBudgetCycle();
    await w.noteKeepingUp();
    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => riot.calls.includes(`ids:${CHALLENGER}:0`));
    await Bun.sleep(50);
    ac.abort();
    await running;
    expect(diamondCalls()).toEqual([]);
    expect(await trackedDiamonds()).toEqual([]);
    expect((await w.progress()).diamond).toBeNull();
    expect(await db`SELECT 1 FROM diamond_tracking`).toHaveLength(0);
  });

  test('a sweep reads every page; the best candidates are tracked, as many as the target: seen in a Master+ game first (by division then LP), then the other Diamond I players', async () => {
    await sevenPlayers();
    await setTarget(4);
    const w = makeWorker({ diamondMaxTracked: 10 });
    await w.refreshLadder();
    expect(await w.refreshDiamonds()).toBe(4);
    // Two entries per page: each division is read until an empty page.
    expect(diamondCalls().sort()).toEqual([
      'diamond:I:1',
      'diamond:I:2',
      'diamond:I:3',
      'diamond:II:1',
      'diamond:II:2',
      'diamond:III:1',
      'diamond:III:2',
      'diamond:IV:1',
      'diamond:IV:2',
    ]);
    expect(await trackedDiamonds()).toEqual(['one-60', 'two-95', 'two-70', 'three-10']);
    expect(await entryOf('two-95')).toEqual({
      division: 2,
      lp: 95,
      games: 40,
      seen: new Date(NOW),
    });
    const [player] = await db`
      SELECT solo_tier, solo_division, solo_lp FROM players WHERE puuid = ${dia('two-95')}`;
    expect(player).toEqual({ solo_tier: 'DIAMOND', solo_division: 2, solo_lp: 95 });
    expect(await w.progress()).toMatchObject({
      // The Challenger player and the four Diamond players are to be listed.
      playedToList: 5,
      masterTracked: 0,
      diamond: { seen: [3, 2, 1, 1], tracked: 4, trackedWithMaster: 4, target: 4, cap: 10 },
    });

    // They are listed in ladder order; their matches are queued in a band after every apex
    // player's (and after those of the Masters outside Riot's list).
    riot.matchIds.set(dia('two-95'), ['EUW1_7000000001']);
    riot.matchIds.set(CHALLENGER, ['EUW1_7000000002']);
    expect(await w.listTrackedPlayer(dia('two-95'))).toBe('listed');
    expect(await w.listTrackedPlayer(CHALLENGER)).toBe('listed');
    const queued = await db<{ match_id: string; fetch_rank: number }[]>`
      SELECT match_id, fetch_rank FROM match_fetch_queue ORDER BY match_id`;
    expect([...queued]).toEqual([
      { match_id: 'EUW1_7000000001', fetch_rank: DIAMOND_FETCH_RANK + 1 },
      { match_id: 'EUW1_7000000002', fetch_rank: 0 },
    ]);
    expect(riot.idQueries.map((q) => q.priority)).toEqual([PRIORITY.DIAMOND_MATCH_IDS, undefined]);

    // A larger target: the rest of the first group, then the other Diamond I players by LP.
    await setTarget(6);
    const wide = makeWorker({ diamondMaxTracked: 10 });
    await wide.refreshLadder();
    expect(await wide.refreshDiamonds()).toBe(2);
    expect(await trackedDiamonds()).toEqual([
      'one-90',
      'one-60',
      'two-95',
      'two-70',
      'three-10',
      'four-50',
    ]);
    expect((await wide.progress()).diamond).toMatchObject({
      seen: [3, 2, 1, 1],
      tracked: 6,
      trackedWithMaster: 5,
      target: 6,
      cap: 10,
    });
    // After a restart the tracked Diamond players are read back, in their band.
    const restarted = makeWorker({ diamondMaxTracked: 10 });
    await restarted.refreshLadder();
    expect((await restarted.progress()).diamond).toMatchObject({
      seen: null,
      tracked: 6,
      target: 6,
    });
    riot.matchIds.set(dia('four-50'), ['EUW1_7000000003']);
    await restarted.listTrackedPlayer(dia('four-50'));
    const [last] = await db<{ fetch_rank: number }[]>`
      SELECT fetch_rank FROM match_fetch_queue WHERE match_id = 'EUW1_7000000003'`;
    // The fifth of the players seen in a Master+ game, whatever the division of the others.
    expect(last?.fetch_rank).toBe(DIAMOND_FETCH_RANK + 4);
    // The Diamond I player who was not seen in one lately is in the band after them all.
    riot.matchIds.set(dia('one-90'), ['EUW1_7000000004']);
    riot.idQueries = [];
    await restarted.listTrackedPlayer(dia('one-90'));
    const [one] = await db<{ fetch_rank: number }[]>`
      SELECT fetch_rank FROM match_fetch_queue WHERE match_id = 'EUW1_7000000004'`;
    expect(one?.fetch_rank).toBe(DIAMOND_ONE_FETCH_RANK);
    expect(riot.idQueries.map((q) => q.priority)).toEqual([PRIORITY.DIAMOND_ONE_MATCH_IDS]);
  });

  test('only the players seen in a Master+ game and the Diamond I players are candidates', async () => {
    setDivision('I', [
      ['one-10', 10],
      ['one-70', 70],
    ]);
    setDivision('II', [
      ['two-40', 40],
      ['two-99', 99],
    ]);
    setDivision('III', [['three-80', 80]]);
    setDivision('IV', [
      ['four-90', 90],
      ['four-95', 95],
    ]);
    // Seen in a Master+ game: before everyone, whatever the division.
    await seenWithMaster(['four-90']);
    const tracked = async (target: number) => {
      await setTarget(target);
      const w = makeWorker({ diamondMaxTracked: 10 });
      await w.refreshLadder();
      await w.refreshDiamonds();
      return trackedDiamonds();
    };
    expect(await tracked(1)).toEqual(['four-90']);
    expect(await tracked(2)).toEqual(['one-70', 'four-90']);
    // Nobody of Diamond II to IV without a Master+ game, however large the target.
    expect(await tracked(10)).toEqual(['one-70', 'one-10', 'four-90']);
    // A Diamond II player turns up in one: tracked, before the Diamond I players.
    await seenWithMaster(['two-99']);
    expect(await tracked(10)).toEqual(['one-70', 'one-10', 'two-99', 'four-90']);
    // A smaller target drops the last candidates of that order; their players rows stay.
    expect(await tracked(3)).toEqual(['one-70', 'two-99', 'four-90']);
    expect(await tracked(2)).toEqual(['two-99', 'four-90']);
    expect(await db`SELECT 1 FROM players WHERE puuid = ${dia('one-70')}`).toHaveLength(1);
  });

  test("who played is read from wins + losses at each sweep, with the time of the player's page", async () => {
    await sevenPlayers();
    await setTarget(5);
    const w = makeWorker({ diamondMaxTracked: 10 });
    await w.refreshLadder();
    await w.refreshDiamonds();
    for (const name of ['one-60', 'two-95', 'two-70', 'three-10', 'four-50']) {
      await w.listTrackedPlayer(dia(name));
    }
    const requested = async () =>
      (
        await db<{ puuid: string; at: Date }[]>`
          SELECT puuid, listing_requested_at AS at FROM players
          WHERE listing_requested_at IS NOT NULL AND puuid LIKE 'fake-diamond-%'`
      ).map((r) => [r.puuid.replace('fake-diamond-', ''), r.at.getTime()]);
    expect(await requested()).toEqual([]);

    t += HOUR;
    expect(await w.refreshDiamonds()).toBe(0);
    setDivision('II', [
      ['two-70', 70],
      ['two-95', 110, 31],
    ]);
    t += HOUR;
    expect(await w.refreshDiamonds()).toBe(1);
    expect(await requested()).toEqual([['two-95', NOW + 2 * HOUR]]);
    expect(await entryOf('two-95')).toEqual({
      division: 2,
      lp: 110,
      games: 41,
      seen: new Date(NOW + 2 * HOUR),
    });
  });

  test('a sweep that fails part-way changes nothing: nobody removed, nobody taken as not having played', async () => {
    await sevenPlayers();
    await setTarget(5);
    const w = makeWorker({ diamondMaxTracked: 10 });
    await w.refreshLadder();
    await w.refreshDiamonds();
    const before = await trackedDiamonds();
    const progress = await w.progress();

    t += HOUR;
    riot.calls = [];
    // Riot's lists changed, but one page of the sweep fails.
    setDivision('I', [
      ['one-90', 90],
      ...Array.from({ length: 9 }, (_, i): [string, number] => [`one-other-${i}`, i]),
    ]);
    setDivision('II', [['two-95', 95, 35]]);
    setDivision('IV', [
      ['four-50', 50, 31],
      ['four-new', 20],
    ]);
    await seenWithMaster(['four-new']);
    riot.errors.set('diamond:III:1', [new RiotHttpError(503, 'league-v4.entries', '/x')]);
    await expect(w.refreshDiamonds()).rejects.toThrow(/503/);
    // The other divisions stop asking (division I has five pages).
    expect(diamondCalls()).toContain('diamond:I:1');
    expect(diamondCalls()).not.toContain('diamond:I:4');
    expect(await trackedDiamonds()).toEqual(before);
    expect(await entryOf('two-95')).toEqual({
      division: 2,
      lp: 95,
      games: 40,
      seen: new Date(NOW),
    });
    expect(await w.progress()).toEqual(progress);

    // The next sweep is complete: applied as a whole.
    t += HOUR;
    expect(await w.refreshDiamonds()).toBe(2);
    expect(await trackedDiamonds()).toEqual([
      'one-60', // not seen by this sweep: kept as it is (see the next test)
      'two-95',
      'two-70',
      'three-10',
      'four-50',
      // 'four-new' is a sixth candidate of the first group: beyond the target of five.
    ]);
    expect((await entryOf('two-95'))?.games).toBe(45);
  });

  test('a sweep that Riot answers with no player at all is not applied', async () => {
    await sevenPlayers();
    await setTarget(5);
    const w = makeWorker({ diamondMaxTracked: 10 });
    await w.refreshLadder();
    await w.refreshDiamonds();
    for (const division of ['I', 'II', 'III', 'IV'] as const) setDivision(division, []);
    t += 2 * DAY;
    expect(await w.refreshDiamonds()).toBeNull();
    expect(await trackedDiamonds()).toHaveLength(5);
  });

  test('a tracked player a complete sweep does not see is kept as is, and dropped after 24 h', async () => {
    await sevenPlayers();
    await setTarget(5);
    const w = makeWorker({ diamondMaxTracked: 10 });
    await w.refreshLadder();
    await w.refreshDiamonds();
    for (const name of ['one-60', 'two-95', 'two-70', 'three-10', 'four-50']) {
      await w.listTrackedPlayer(dia(name));
    }
    const kept = { division: 1, lp: 60, games: 40, seen: new Date(NOW) };

    // Not on any page of the next sweeps (moved between pages meanwhile, decayed…).
    setDivision('I', [
      ['one-80', 80],
      ['one-90', 90],
    ]);
    t = NOW + HOUR;
    expect(await w.refreshDiamonds()).toBe(0);
    expect(await entryOf('one-60')).toEqual(kept);
    expect(await trackedDiamonds()).toContain('one-60');
    expect((await w.progress()).diamond).toMatchObject({ seen: [2, 2, 1, 1], tracked: 5 });
    t = NOW + 23 * HOUR;
    expect(await w.refreshDiamonds()).toBe(0);
    expect(await entryOf('one-60')).toEqual(kept);

    // Seen again before that: an ordinary tracked player again, whose new game is noticed.
    setDivision('II', [['two-95', 95]]);
    t = NOW + 24 * HOUR;
    await w.refreshDiamonds();
    setDivision('II', [
      ['two-95', 95],
      ['two-70', 75, 31],
    ]);
    t = NOW + 25 * HOUR;
    expect(await w.refreshDiamonds()).toBe(1);
    expect(await entryOf('two-70')).toEqual({
      division: 2,
      lp: 75,
      games: 41,
      seen: new Date(NOW + 25 * HOUR),
    });

    // 24 hours after the last sweep that saw them: dropped (their players row stays), and the
    // place goes to the next candidate.
    expect(await entryOf('one-60')).toBeNull();
    expect(await trackedDiamonds()).toEqual(['one-90', 'two-95', 'two-70', 'three-10', 'four-50']);
    expect(await db`SELECT 1 FROM players WHERE puuid = ${dia('one-60')}`).toHaveLength(1);
  });

  test('a tracked Diamond player who reaches the apex ladder is left to it', async () => {
    await sevenPlayers();
    await setTarget(5);
    const w = makeWorker({ diamondMaxTracked: 10 });
    await w.refreshLadder();
    await w.refreshDiamonds();

    // Promoted between two sweeps: one into the tracked apex players, one into the part of
    // Riot's Master list that is not tracked yet. Riot's Diamond pages may still show them.
    t += HOUR;
    riot.leagues.CHALLENGER.entries = [apex(CHALLENGER, 900), apex(dia('two-95'), 500, 30)];
    riot.leagues.MASTER.entries = [apex(dia('two-70'), 20, 30)];
    await w.refreshLadder();
    expect((await ladderOrder(db, 'EUW1')).map((r) => [r.puuid, r.tier])).toEqual([
      [CHALLENGER, 'CHALLENGER'],
      [dia('two-95'), 'CHALLENGER'],
      [dia('one-60'), 'DIAMOND'],
      [dia('two-70'), 'DIAMOND'],
      [dia('three-10'), 'DIAMOND'],
      [dia('four-50'), 'DIAMOND'],
    ]);
    await w.refreshDiamonds();
    // Neither is a Diamond candidate any more: their places go to the next ones.
    expect((await ladderOrder(db, 'EUW1')).map((r) => [r.puuid, r.tier])).toEqual([
      [CHALLENGER, 'CHALLENGER'],
      [dia('two-95'), 'CHALLENGER'],
      [dia('one-90'), 'DIAMOND'],
      [dia('one-80'), 'DIAMOND'],
      [dia('one-60'), 'DIAMOND'],
      [dia('three-10'), 'DIAMOND'],
      [dia('four-50'), 'DIAMOND'],
    ]);
    expect(await w.progress()).toMatchObject({
      masterTracked: 0,
      masterTotal: 1,
      diamond: { tracked: 5, trackedWithMaster: 3 },
    });
  });

  test('only Master+ games mark players: a Diamond player met in one comes first, a Diamond lobby marks nobody', async () => {
    setDivision('I', [
      ['met-a-challenger', 40],
      ['met-a-diamond', 90],
    ]);
    await setTarget(1);
    const w = makeWorker({ diamondMaxTracked: 5 });
    await w.refreshLadder();
    await w.refreshDiamonds();
    // Nobody was seen in a Master+ game: the best by LP.
    expect(await trackedDiamonds()).toEqual(['met-a-diamond']);
    const fetch = async (id: string, players: string[]) => {
      riot.matches.set(id, makeTimedMatch(id, { startMs: t - HOUR, players }));
      await enqueueMatchIds(db, 'EUW1', [id]);
      expect(await w.processMatch({ matchId: id, platform: 'EUW1', attempts: 0 })).toBe('added');
    };
    const seen = async (name: string) => {
      const [row] = await db<{ at: Date | null }[]>`
        SELECT last_seen_with_master_at AS at FROM players WHERE puuid = ${dia(name)}`;
      return row?.at?.getTime() ?? null;
    };

    // A match of the tracked Challenger player.
    await fetch('EUW1_7000000001', [CHALLENGER, dia('met-a-challenger')]);
    expect(await seen('met-a-challenger')).toBe(NOW - HOUR);
    t += HOUR;
    await w.refreshDiamonds();
    expect(await trackedDiamonds()).toEqual(['met-a-challenger']);

    // A match the tracked Diamond player played with Diamond players only.
    await fetch('EUW1_7000000002', [dia('met-a-challenger'), dia('met-a-diamond')]);
    expect(await seen('met-a-diamond')).toBeNull();
    expect(await seen('met-a-challenger')).toBe(NOW - HOUR);
    t += HOUR;
    await w.refreshDiamonds();
    expect(await trackedDiamonds()).toEqual(['met-a-challenger']);

    // Seven days without a Master+ game: an ordinary candidate again, behind the better one.
    t = NOW - HOUR + 7 * DAY + 1;
    await w.refreshDiamonds();
    expect(await trackedDiamonds()).toEqual(['met-a-diamond']);
  });

  test('the skip rule holds for tracked Diamond players too', async () => {
    setDivision('II', [['two-95', 95, 30]]);
    await seenWithMaster(['two-95']);
    await setTarget(5);
    const w = makeWorker({ diamondMaxTracked: 5, listingSkip: 'on' });
    await w.refreshLadder();
    await w.refreshDiamonds();
    const p = dia('two-95');
    expect(await w.listTrackedPlayer(p)).toBe('listed');
    // Their next game is stored through the Challenger player's listing.
    const id = 'EUW1_7000000001';
    riot.matches.set(
      id,
      makeTimedMatch(id, { startMs: NOW + 10 * 60_000, players: [CHALLENGER, p] }),
    );
    await enqueueMatchIds(db, 'EUW1', [id]);
    await w.processMatch({ matchId: id, platform: 'EUW1', attempts: 0 });
    setDivision('II', [['two-95', 110, 31]]);
    t += HOUR;
    expect(await w.refreshDiamonds()).toBe(1);
    riot.calls = [];
    expect(await w.listTrackedPlayer(p)).toBe('skipped');
    expect(riot.calls).toEqual([]);
  });

  test('start(): each ladder cycle sweeps Diamond after the apex ladder; a failed sweep is tried again with the next cycle', async () => {
    await sevenPlayers();
    await setTarget(5);
    riot.errors.set('diamond:II:1', [new RiotHttpError(503, 'league-v4.entries', '/x')]);
    const w = makeWorker({
      diamondMaxTracked: 10,
      expansionCheckMs: 10,
      concurrency: { listing: 1, daily: 0, enrichment: 0 },
    });
    const ac = new AbortController();
    const running = w.start(ac.signal);
    const sweepError = async () =>
      (await listWorkerStatus(db))[0]?.lastError?.startsWith('diamond sweep:') ?? false;
    await waitFor(sweepError);
    await waitFor(() => riot.calls.includes(`ids:${CHALLENGER}:0`));
    // The apex ladder is in, its players are listed; no Diamond player yet, and no retry before
    // the next cycle.
    await Bun.sleep(100);
    expect(riot.calls.filter((c) => c === 'diamond:I:1')).toHaveLength(1);
    expect(riot.calls.indexOf('diamond:I:1')).toBeGreaterThan(riot.calls.indexOf('league:MASTER'));
    expect(await trackedDiamonds()).toEqual([]);

    t += HOUR;
    await waitFor(async () => (await trackedDiamonds()).length === 5);
    await waitFor(() => riot.calls.includes(`ids:${dia('four-50')}:0`));
    ac.abort();
    await running;
    expect(riot.calls.filter((c) => c === 'league:CHALLENGER')).toHaveLength(2);
    expect(await trackedDiamonds()).toHaveLength(5);
    // Listed after the Challenger player, top down.
    expect(riot.calls.filter((c) => c.startsWith('ids:'))).toEqual([
      `ids:${CHALLENGER}:0`,
      `ids:${dia('one-60')}:0`,
      `ids:${dia('two-95')}:0`,
      `ids:${dia('two-70')}:0`,
      `ids:${dia('three-10')}:0`,
      `ids:${dia('four-50')}:0`,
    ]);
  });
});
