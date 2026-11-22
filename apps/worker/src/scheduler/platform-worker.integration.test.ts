import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  enqueueMatchIds,
  getMatchesSyncedUntil,
  listWorkerStatus,
  migrate,
  upsertPatchStaticData,
} from '@pick-league/db';
import type { LeagueListDto } from '@pick-league/shared';
import { PRIORITY, RiotAuthError, RiotHttpError, RiotNetworkError } from '../riot/client.ts';
import { PlatformWorker } from './platform-worker.ts';
import {
  count,
  DAY,
  FakePatches,
  FakeRiot,
  fixedClock,
  ladderPuuid,
  makeMatch,
  NOW,
  staticPatch,
} from './test-helpers.ts';

const URL = process.env.DATABASE_URL_TEST;
const d = URL ? describe : describe.skip;
if (!URL)
  console.warn('[worker] DATABASE_URL_TEST is not set: skipping scheduler integration tests');

d('PlatformWorker (Postgres)', () => {
  let db: Db;
  let riot: FakeRiot;
  let patches: FakePatches;
  let worker: PlatformWorker;

  beforeEach(async () => {
    await db?.end();
    db = createDb(URL as string, { max: 4 });
    await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await upsertPatchStaticData(db, staticPatch('15.21'));
    await upsertPatchStaticData(db, staticPatch('15.22'));
    riot = new FakeRiot();
    patches = new FakePatches();
    worker = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
      options: { idleMs: 10 },
    });
  });

  afterAll(async () => {
    await db?.end();
  });

  /** Stores one match of the latest patch (a high game id): the patch is live on EUW1. */
  const goLive = async (w: PlatformWorker = worker, id = 'EUW1_7000009000') => {
    riot.matches.set(id, makeMatch(id, '15.22.715.1234'));
    await enqueueMatchIds(db, 'EUW1', [id]);
    expect(await w.processMatch({ matchId: id, platform: 'EUW1', attempts: 0 })).toBe('added');
    riot.calls = [];
  };

  const ladder = (n: number, games: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({
      puuid: ladderPuuid(i),
      leaguePoints: 1000 - i,
      rank: 'I',
      wins: games(i),
      losses: 10,
      veteran: false,
      inactive: false,
      freshBlood: false,
      hotStreak: false,
    }));

  test('ladder refresh stores both tiers and detects who played', async () => {
    riot.leagues.CHALLENGER.entries = ladder(3, () => 50);
    riot.leagues.GRANDMASTER.entries = [
      { ...ladder(1, () => 40)[0], puuid: 'fake-gm-puuid' } as LeagueListDto['entries'][number],
    ];
    expect(await worker.refreshLadder()).toBe(4);
    const n = await count(db, 'ladder_entries');
    expect(n).toBe(4);

    riot.leagues.CHALLENGER.entries = ladder(3, (i) => (i === 1 ? 51 : 50));
    expect(await worker.refreshLadder()).toBe(1);
    expect((await worker.progress()).playedToList).toBe(4);
  });

  const master = (lp: number) =>
    ({
      ...ladder(1, () => 30)[0],
      puuid: `fake-master-${lp}`,
      leaguePoints: lp,
    }) as LeagueListDto['entries'][number];
  const trackedMasters = async () =>
    (
      await db<{ puuid: string }[]>`
        SELECT puuid FROM ladder_entries WHERE tier = 'MASTER' ORDER BY league_points DESC`
    ).map((r) => r.puuid);

  test('ladder refresh tracks Challenger and Grandmaster, then only the Master players asked for', async () => {
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    riot.leagues.MASTER.entries = [master(100), master(300), master(200)];
    expect(await worker.refreshLadder()).toBe(1);
    expect(riot.calls).toEqual(['league:CHALLENGER', 'league:GRANDMASTER', 'league:MASTER']);
    expect(await trackedMasters()).toEqual([]);
    expect(await worker.progress()).toMatchObject({ masterTracked: 0, masterTotal: 3 });

    expect(await worker.refreshLadder(undefined, 2)).toBe(2);
    expect(await trackedMasters()).toEqual(['fake-master-300', 'fake-master-200']);
    // Later refreshes keep that many, also after a restart (read back from ladder_entries).
    riot.leagues.MASTER.entries = [master(100), master(300), master(250)];
    const restarted = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
    });
    await restarted.refreshLadder();
    expect(await trackedMasters()).toEqual(['fake-master-300', 'fake-master-250']);
  });

  test('start(): Master players are added top down, a step at a time, once the queues are empty', async () => {
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    riot.leagues.MASTER.entries = [master(100), master(300), master(200)];
    riot.matchIds.set(ladderPuuid(0), ['EUW1_7000000900']);
    riot.matchIds.set('fake-master-200', ['EUW1_7000000902']);
    riot.matchIds.set('fake-master-300', ['EUW1_7000000901', 'EUW1_7000000900']);
    const w = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
      options: {
        idleMs: 10,
        expansionCheckMs: 10,
        masterStep: 2,
        expandBelowPendingMatches: 5,
        concurrency: { listing: 1, match: 0, daily: 0, enrichment: 0 },
      },
    });
    const ac = new AbortController();
    const running = w.start(ac.signal);
    for (let i = 0; i < 200 && !riot.calls.includes('ids:fake-master-100:0'); i++) {
      await Bun.sleep(10);
    }
    ac.abort();
    await running;

    // Challenger first; then the best two Master players, best first; then the last one.
    expect(riot.calls.filter((c) => c.startsWith('ids:'))).toEqual([
      `ids:${ladderPuuid(0)}:0`,
      'ids:fake-master-300:0',
      'ids:fake-master-200:0',
      'ids:fake-master-100:0',
    ]);
    expect(await trackedMasters()).toEqual([
      'fake-master-300',
      'fake-master-200',
      'fake-master-100',
    ]);
    expect((await w.progress()).masterTracked).toBe(3);
    // Matches are queued with the best ladder position of the players who listed them.
    const queued = await db<{ match_id: string; fetch_rank: number }[]>`
      SELECT match_id, fetch_rank FROM match_fetch_queue ORDER BY match_id`;
    expect([...queued]).toEqual([
      { match_id: 'EUW1_7000000900', fetch_rank: 0 },
      { match_id: 'EUW1_7000000901', fetch_rank: 1 },
      { match_id: 'EUW1_7000000902', fetch_rank: 2 },
    ]);
  });

  test('more Master players only once no listing waits and few matches are queued', async () => {
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    riot.leagues.MASTER.entries = [master(100)];
    const deps = {
      platform: 'EUW1' as const,
      db,
      riot,
      patches,
      clock: fixedClock,
      options: { expandBelowPendingMatches: 1 },
    };
    const w = new PlatformWorker(deps);
    await w.refreshLadder();
    // The Challenger player waits for a listing.
    expect(await w.canTrackMoreMasters()).toBe(false);

    riot.matchIds.set(ladderPuuid(0), ['EUW1_7000000002', 'EUW1_7000000001']);
    await w.listPlayerMatches(ladderPuuid(0));
    // Nothing left to list, but two matches queued.
    const idle = new PlatformWorker(deps);
    await idle.refreshLadder();
    expect(await idle.canTrackMoreMasters()).toBe(false);
    await db`UPDATE match_fetch_queue SET status = 'DONE' WHERE match_id = 'EUW1_7000000001'`;
    expect(await idle.canTrackMoreMasters()).toBe(true);
  });

  /** A player seen in matches (not on the tracked ladder) with an enrichment rank. */
  const untracked = async (puuid: string, tier: string, lp: number, division: number | null) => {
    await db`
      INSERT INTO players (puuid, platform, solo_tier, solo_division, solo_lp)
      VALUES (${puuid}, 'EUW1', ${tier}::solo_tier, ${division}, ${lp})`;
  };

  test('untracked players are listed only once every Master player is tracked and the queues are nearly empty', async () => {
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    riot.leagues.MASTER.entries = [master(100)];
    /** A worker that restarted with nothing left to list (its listings were done by `w`). */
    const restarted = async () => {
      const r = new PlatformWorker({
        platform: 'EUW1',
        db,
        riot,
        patches,
        clock: fixedClock,
        options: { expandBelowPendingMatches: 1 },
      });
      await r.refreshLadder();
      return r;
    };
    const w = await restarted();
    expect(await w.canListExtraPlayers()).toBe(false);
    await w.listPlayerMatches(ladderPuuid(0));
    // One Master player of Riot's list is not tracked yet: track more Masters first.
    let idle = await restarted();
    expect(await idle.canTrackMoreMasters()).toBe(true);
    expect(await idle.canListExtraPlayers()).toBe(false);

    await w.refreshLadder(undefined, 1);
    await w.listPlayerMatches('fake-master-100');
    idle = await restarted();
    expect(await idle.canTrackMoreMasters()).toBe(false);
    expect(await idle.canListExtraPlayers()).toBe(true);

    // Too many matches waiting: the tracked players' matches come first.
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000001', 'EUW1_7000000002']);
    expect(await idle.canListExtraPlayers()).toBe(false);
  });

  test('start(): untracked players are listed highest ranked first, at the lowest priority, their matches queued last', async () => {
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    riot.leagues.MASTER.entries = [master(100)];
    await untracked('fake-extra-master-50', 'MASTER', 50, null);
    await untracked('fake-extra-gm', 'GRANDMASTER', 10, null);
    await untracked('fake-extra-master-80', 'MASTER', 80, null);
    await untracked('fake-extra-diamond', 'DIAMOND', 90, 1);
    await untracked('fake-extra-recent', 'MASTER', 70, null);
    await untracked('fake-extra-ladder-dropout', 'MASTER', 60, null);
    // Listed less than `extraListingIntervalMs` ago: not again yet.
    await db`
      UPDATE players SET matches_synced_until = ${new Date(NOW - 3_600_000)}
      WHERE puuid = 'fake-extra-recent'`;
    // Listed long ago: due again.
    await db`
      UPDATE players SET matches_synced_until = ${new Date(NOW - 7 * 3_600_000)}
      WHERE puuid = 'fake-extra-ladder-dropout'`;
    riot.matchIds.set(ladderPuuid(0), ['EUW1_7000000900']);
    riot.matchIds.set('fake-extra-gm', ['EUW1_7000000910', 'EUW1_7000000900']);
    const w = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
      options: {
        idleMs: 10,
        expansionCheckMs: 10,
        expandBelowPendingMatches: 5,
        concurrency: { listing: 1, match: 0, daily: 0, enrichment: 0, extraListing: 1 },
      },
    });
    const ac = new AbortController();
    const running = w.start(ac.signal);
    for (let i = 0; i < 200 && !riot.calls.includes('ids:fake-extra-master-50:0'); i++) {
      await Bun.sleep(10);
    }
    await Bun.sleep(50);
    ac.abort();
    await running;

    const ids = riot.calls.filter((c) => c.startsWith('ids:'));
    expect(ids).toEqual([
      `ids:${ladderPuuid(0)}:0`,
      'ids:fake-master-100:0',
      'ids:fake-extra-gm:0',
      'ids:fake-extra-master-80:0',
      'ids:fake-extra-ladder-dropout:0',
      'ids:fake-extra-master-50:0',
    ]);
    expect(riot.idQueries.map((q) => q.priority)).toEqual([
      undefined,
      undefined,
      PRIORITY.EXTRA_MATCH_IDS,
      PRIORITY.EXTRA_MATCH_IDS,
      PRIORITY.EXTRA_MATCH_IDS,
      PRIORITY.EXTRA_MATCH_IDS,
    ]);
    // A match an untracked player shares with a tracked one keeps the tracked player's rank.
    const queued = await db<{ match_id: string; fetch_rank: number }[]>`
      SELECT match_id, fetch_rank FROM match_fetch_queue ORDER BY match_id`;
    expect([...queued]).toEqual([
      { match_id: 'EUW1_7000000900', fetch_rank: 0 },
      { match_id: 'EUW1_7000000910', fetch_rank: 2 },
    ]);
    expect((await w.progress()).extraPlayersPolled).toBe(4);
  });

  test('first listing goes back 14 days, paginates, then continues from matches_synced_until', async () => {
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    await worker.refreshLadder();
    const p = ladderPuuid(0);
    riot.matchIds.set(
      p,
      Array.from({ length: 130 }, (_, i) => `EUW1_${7000001000 - i}`),
    );
    expect(await worker.listPlayerMatches(p)).toBe(130);
    expect(riot.idQueries.map((q) => [q.start, q.startTime])).toEqual([
      [0, Math.floor((NOW - 14 * DAY) / 1000)],
      [100, Math.floor((NOW - 14 * DAY) / 1000)],
    ]);
    const [row] = await db`SELECT matches_synced_until FROM players WHERE puuid = ${p}`;
    expect((row?.matches_synced_until as Date | undefined)?.getTime()).toBe(NOW - 3_600_000);

    riot.idQueries = [];
    expect(await worker.listPlayerMatches(p)).toBe(0);
    expect(riot.idQueries[0]?.startTime).toBe(Math.floor((NOW - 3_600_000) / 1000));
  });

  const listingRequestedAt = async (puuid: string) => {
    const [row] = await db<{ t: Date | null }[]>`
      SELECT listing_requested_at AS t FROM players WHERE puuid = ${puuid}`;
    return row?.t ?? null;
  };

  test('pending listings survive a restart', async () => {
    riot.leagues.CHALLENGER.entries = ladder(2, () => 50);
    await worker.refreshLadder();
    await worker.listPlayerMatches(ladderPuuid(0));
    await worker.listPlayerMatches(ladderPuuid(1));
    riot.leagues.CHALLENGER.entries = ladder(2, (i) => (i === 0 ? 51 : 50));
    expect(await worker.refreshLadder()).toBe(1);
    expect(await listingRequestedAt(ladderPuuid(0))).toEqual(new Date(NOW));

    // Restart before the listing: the ladder has not changed since, yet the player is still due.
    const restarted = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
    });
    expect(await restarted.refreshLadder()).toBe(0);
    expect((await restarted.progress()).playedToList).toBe(1);
    await restarted.listPlayerMatches(ladderPuuid(0));
    expect(await listingRequestedAt(ladderPuuid(0))).toBeNull();
  });

  test('a player who plays again during their listing is listed again; a failed listing waits', async () => {
    let t = NOW;
    const clock = { ...fixedClock, now: () => t };
    const w = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock,
      options: { idleMs: 10, concurrency: { listing: 2, match: 0, daily: 0, enrichment: 0 } },
    });
    const p = ladderPuuid(0);
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    let open = () => {};
    riot.idsGate = new Promise<void>((r) => {
      open = r;
    });
    const idsCalls = () => riot.calls.filter((c) => c.startsWith('ids:')).length;
    const waitFor = async (cond: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await cond()); i++) await Bun.sleep(10);
    };

    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(() => idsCalls() === 1);
    // The player plays again while being listed; the next listing will fail.
    t += 60_000;
    riot.leagues.CHALLENGER.entries = ladder(1, () => 51);
    await w.refreshLadder();
    riot.errors.set(`ids:${p}:0`, [new RiotHttpError(400, 'match-v5.ids-by-puuid', '/x')]);
    riot.idsGate = null;
    open();
    await waitFor(() => idsCalls() === 2);
    await Bun.sleep(200);
    ac.abort();
    await running;

    // Listed again (the second listing failed): no immediate retry, and the newer request is kept.
    expect(idsCalls()).toBe(2);
    expect(await listingRequestedAt(p)).toEqual(new Date(NOW + 60_000));
    expect(await getMatchesSyncedUntil(db, p)).toEqual(new Date(NOW - 3_600_000));
  });

  test('match of a kept patch is stored with all child tables and enriches others', async () => {
    const m = makeMatch('EUW1_7000000500', '15.22.715.1234');
    riot.matches.set('EUW1_7000000500', m);
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000500']);
    expect(
      await worker.processMatch({ matchId: 'EUW1_7000000500', platform: 'EUW1', attempts: 0 }),
    ).toBe('added');
    const counts = await db<{ t: string; n: number }[]>`
      SELECT 'participants' AS t, count(*)::int AS n FROM participants
      UNION ALL SELECT 'item_events', count(*)::int FROM item_events
      UNION ALL SELECT 'skill_events', count(*)::int FROM skill_events
      UNION ALL SELECT 'match_bans', count(*)::int FROM match_bans
      UNION ALL SELECT 'enrichment', count(*)::int FROM player_enrichment_queue`;
    expect(Object.fromEntries(counts.map((c) => [c.t, c.n]))).toEqual({
      participants: 10,
      item_events: 7,
      skill_events: 4,
      match_bans: 10,
      enrichment: 10,
    });
    const [q] = await db`SELECT status FROM match_fetch_queue WHERE match_id = 'EUW1_7000000500'`;
    expect(q?.status).toBe('DONE');
  });

  test('previous patch: skipped, and older ids are skipped without fetching nor listing', async () => {
    await goLive();
    riot.matches.set('EUW1_7000000100', makeMatch('EUW1_7000000100', '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000100', 'EUW1_7000000050']);
    const q = (matchId: string) => ({ matchId, platform: 'EUW1' as const, attempts: 0 });
    expect(await worker.processMatch(q('EUW1_7000000100'))).toBe('skipped');
    riot.calls = [];
    expect(await worker.processMatch(q('EUW1_7000000050'))).toBe('skipped');
    expect(riot.calls).toEqual([]);
    const statuses = await db`SELECT status FROM match_fetch_queue ORDER BY match_id`;
    expect(statuses.map((s) => s.status)).toEqual([
      'SKIPPED_OLD_PATCH',
      'SKIPPED_OLD_PATCH',
      'DONE', // the latest-patch match stored by goLive
    ]);

    // Listing stops at the first id known to be from an old patch.
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    await worker.refreshLadder();
    riot.matchIds.set(ladderPuuid(0), [
      'EUW1_7000000300',
      'EUW1_7000000200',
      'EUW1_7000000090',
      'EUW1_7000000080',
    ]);
    expect(await worker.listPlayerMatches(ladderPuuid(0))).toBe(2);
  });

  test("listing cut-off ignores other platforms' ids and unparseable ids", async () => {
    await goLive();
    riot.matches.set('EUW1_7000000100', makeMatch('EUW1_7000000100', '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000100']);
    const q = { matchId: 'EUW1_7000000100', platform: 'EUW1' as const, attempts: 0 };
    expect(await worker.processMatch(q)).toBe('skipped');

    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    await worker.refreshLadder();
    // EUN1 ids share the cluster but not the id sequence: a small EUN1 id says nothing about EUW1.
    riot.matchIds.set(ladderPuuid(0), [
      'EUW1_7000000400',
      'EUN1_3000000000',
      'EUW1_not-a-number',
      'EUW1_7000000300',
      'EUW1_7000000090',
      'EUW1_7000000080',
    ]);
    expect(await worker.listPlayerMatches(ladderPuuid(0))).toBe(3);
    const rows = await db<{ match_id: string }[]>`
      SELECT match_id FROM match_fetch_queue WHERE status = 'PENDING' ORDER BY match_id`;
    expect(rows.map((r) => r.match_id)).toEqual([
      'EUW1_7000000300',
      'EUW1_7000000400',
      'EUW1_not-a-number',
    ]);
  });

  const pendingCount = async () => {
    const [row] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM match_fetch_queue WHERE status = 'PENDING'`;
    return row?.n ?? -1;
  };
  /** Runs the match loops until the queue has no PENDING row left. */
  const drainQueue = async (w: PlatformWorker) => {
    const ac = new AbortController();
    const running = w.start(ac.signal);
    for (let i = 0; i < 400 && (await pendingCount()) > 0; i++) await Bun.sleep(25);
    ac.abort();
    await running;
  };
  const oldIds = (n: number) => Array.from({ length: n }, (_, i) => `EUW1_${7000001000 + i}`);

  test('an old match skips every pending id below it in one statement', async () => {
    await goLive();
    const ids = oldIds(30);
    for (const id of ids) riot.matches.set(id, makeMatch(id, '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', [...ids, 'EUW1_7000005000']);
    const highest = ids[ids.length - 1] as string;
    expect(await worker.processMatch(queued(highest))).toBe('skipped');
    expect(riot.calls).toEqual([`match:${highest}`]);
    expect(await pendingCount()).toBe(1);
    expect((await worker.progress()).matchesSkipped).toBe(30);
  });

  test('rollover: a backlog of old-patch matches is skipped with one match request', async () => {
    await goLive();
    const ids = oldIds(50);
    for (const id of ids) riot.matches.set(id, makeMatch(id, '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ids);
    await drainQueue(worker);
    expect(riot.calls.filter((c) => c.startsWith('match:'))).toEqual(['match:EUW1_7000001049']);
    const [row] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM match_fetch_queue WHERE status = 'SKIPPED_OLD_PATCH'`;
    expect(row?.n).toBe(50);
  });

  test('rollover: old and new patch matches mixed, the boundary costs O(log n) requests', async () => {
    const old = oldIds(64);
    const kept = Array.from({ length: 4 }, (_, i) => `EUW1_${7000002000 + i}`);
    for (const id of old) riot.matches.set(id, makeMatch(id, '15.21.700.1'));
    for (const id of kept) riot.matches.set(id, makeMatch(id, '15.22.1.1'));
    // Discovered newest first, so FIFO claims alone would fetch every new one before any old one.
    await enqueueMatchIds(db, 'EUW1', kept);
    await enqueueMatchIds(db, 'EUW1', old);
    await drainQueue(worker);
    const oldFetched = riot.calls.filter((c) => old.some((id) => c === `match:${id}`));
    expect(oldFetched.length).toBeLessThanOrEqual(7);
    // The first probe stores a 15.22 match: the patch turns live. 15.21 matches fetched before that
    // one were still collected (the previous patch is kept until then), so they may be stored too.
    const stored = await db<{ id: string }[]>`SELECT id FROM matches WHERE patch = '15.22'`;
    expect(stored.map((r) => r.id).sort()).toEqual(kept);
    const others = await db<{ status: string }[]>`
      SELECT DISTINCT status FROM match_fetch_queue WHERE match_id NOT IN ${db(kept)}`;
    for (const r of others) expect(['SKIPPED_OLD_PATCH', 'DONE']).toContain(r.status);
    expect((await worker.progress()).latestPatchLive).toBe(true);
  });

  test('previous patch: still collected while the latest patch has no stored match on the platform', async () => {
    riot.matches.set('EUW1_7000000100', makeMatch('EUW1_7000000100', '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000100']);
    expect(await worker.processMatch(queued('EUW1_7000000100'))).toBe('added');
    const [m] = await db`SELECT patch FROM matches WHERE id = 'EUW1_7000000100'`;
    expect(m?.patch).toBe('15.21');
    expect((await queueRow('EUW1_7000000100'))?.status).toBe('DONE');
    expect((await worker.progress()).latestPatchLive).toBe(false);

    // Listings are not cut either.
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    await worker.refreshLadder();
    riot.matchIds.set(ladderPuuid(0), ['EUW1_7000000090', 'EUW1_7000000080']);
    expect(await worker.listPlayerMatches(ladderPuuid(0))).toBe(2);
  });

  test('previous patch: skipped once a match of the latest patch is stored', async () => {
    riot.matches.set('EUW1_7000000100', makeMatch('EUW1_7000000100', '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000100']);
    expect(await worker.processMatch(queued('EUW1_7000000100'))).toBe('added');
    await goLive();
    expect((await worker.progress()).latestPatchLive).toBe(true);

    riot.matches.set('EUW1_7000000060', makeMatch('EUW1_7000000060', '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000060', 'EUW1_7000000050']);
    expect(await worker.processMatch(queued('EUW1_7000000060'))).toBe('skipped');
    expect(riot.calls).toEqual(['match:EUW1_7000000060']);
    expect((await queueRow('EUW1_7000000050'))?.status).toBe('SKIPPED_OLD_PATCH');
    riot.calls = [];
    expect(await worker.processMatch(queued('EUW1_7000000050'))).toBe('skipped');
    expect(riot.calls).toEqual([]);

    // Listing stops at the first id known to be from a patch no longer collected.
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    await worker.refreshLadder();
    riot.matchIds.set(ladderPuuid(0), [
      'EUW1_7000000300',
      'EUW1_7000000200',
      'EUW1_7000000055',
      'EUW1_7000000040',
    ]);
    expect(await worker.listPlayerMatches(ladderPuuid(0))).toBe(2);
  });

  test('older than the previous patch: skipped even before the latest patch is live', async () => {
    riot.matches.set('EUW1_7000000010', makeMatch('EUW1_7000000010', '15.20.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000010']);
    expect(await worker.processMatch(queued('EUW1_7000000010'))).toBe('skipped');
    expect(riot.calls).toEqual(['match:EUW1_7000000010']);
    expect(await count(db, 'matches')).toBe(0);
    expect((await worker.progress()).latestPatchLive).toBe(false);
  });

  test('restart: whether the latest patch is live is read from the stored matches', async () => {
    const restarted = () =>
      new PlatformWorker({
        platform: 'EUW1',
        db,
        riot,
        patches,
        clock: fixedClock,
        options: { idleMs: 10 },
      });
    riot.matches.set('EUW1_7000000100', makeMatch('EUW1_7000000100', '15.21.700.1'));
    riot.matches.set('EUW1_7000000080', makeMatch('EUW1_7000000080', '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000100', 'EUW1_7000000080']);

    // No latest-patch match stored yet: a fresh worker still collects the previous patch.
    expect(await restarted().processMatch(queued('EUW1_7000000100'))).toBe('added');

    // One is stored: a fresh worker knows the patch is live without seeing it itself.
    await goLive();
    const after = restarted();
    expect(await after.processMatch(queued('EUW1_7000000080'))).toBe('skipped');
    expect((await after.progress()).latestPatchLive).toBe(true);
  });

  test('liveness is per platform', async () => {
    await db`
      INSERT INTO matches (id, platform, patch, game_version, queue_id, started_at, duration_s,
                           is_remake, is_early_surrender, winning_team)
      VALUES ('KR_7000009000', 'KR', '15.22', '15.22.715.1234', 420, now(), 1800, false, false, 100)`;
    riot.matches.set('EUW1_7000000100', makeMatch('EUW1_7000000100', '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000100']);
    expect(await worker.processMatch(queued('EUW1_7000000100'))).toBe('added');
    expect((await worker.progress()).latestPatchLive).toBe(false);
  });

  test('a new patch in Data Dragon: the former latest stays collected until the new one is live', async () => {
    await goLive();
    await upsertPatchStaticData(db, staticPatch('15.23'));
    patches.latest = '15.23';
    patches.previous = '15.22';
    patches.generation++;
    const ids = {
      prev: 'EUW1_7000000100', // 15.21
      former: 'EUW1_7000009100', // 15.22
      newest: 'EUW1_7000010000', // 15.23
      formerLate: 'EUW1_7000009200', // 15.22, below the first 15.23 one
    };
    riot.matches.set(ids.prev, makeMatch(ids.prev, '15.21.700.1'));
    riot.matches.set(ids.former, makeMatch(ids.former, '15.22.715.1234'));
    riot.matches.set(ids.newest, makeMatch(ids.newest, '15.23.100.1'));
    riot.matches.set(ids.formerLate, makeMatch(ids.formerLate, '15.22.715.1234'));
    await enqueueMatchIds(db, 'EUW1', Object.values(ids));

    expect(await worker.processMatch(queued(ids.former))).toBe('added');
    expect((await worker.progress()).latestPatchLive).toBe(false);
    expect(await worker.processMatch(queued(ids.prev))).toBe('skipped');
    expect(await worker.processMatch(queued(ids.newest))).toBe('added');
    expect((await worker.progress()).latestPatchLive).toBe(true);
    expect(await worker.processMatch(queued(ids.formerLate))).toBe('skipped');
  });

  test('COLLECT_PREVIOUS_PATCH: the previous patch stays collected after the latest is live', async () => {
    const backfill = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
      options: { idleMs: 10, collectPreviousPatch: true },
    });
    await goLive(backfill);
    expect((await backfill.progress()).latestPatchLive).toBe(true);
    riot.matches.set('EUW1_7000000100', makeMatch('EUW1_7000000100', '15.21.700.1'));
    riot.matches.set('EUW1_7000000010', makeMatch('EUW1_7000000010', '15.20.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000100', 'EUW1_7000000010']);
    expect(await backfill.processMatch(queued('EUW1_7000000100'))).toBe('added');
    expect(await backfill.processMatch(queued('EUW1_7000000010'))).toBe('skipped');
  });

  test('patch newer than Data Dragon: deferred and a patch refresh is requested', async () => {
    riot.matches.set('EUW1_7000000900', makeMatch('EUW1_7000000900', '15.23.100.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000900', 'EUW1_7000000950']);
    const q = (matchId: string) => ({ matchId, platform: 'EUW1' as const, attempts: 0 });
    expect(await worker.processMatch(q('EUW1_7000000900'))).toBe('deferred');
    expect(patches.refreshRequests).toBe(1);
    riot.calls = [];
    // Newer ids wait too, without spending a request.
    expect(await worker.processMatch(q('EUW1_7000000950'))).toBe('deferred');
    expect(riot.calls).toEqual([]);
    const rows =
      await db`SELECT status, last_error FROM match_fetch_queue WHERE match_id = 'EUW1_7000000900'`;
    expect(rows[0]?.status).toBe('PENDING');
    expect(rows[0]?.last_error).toContain('15.23');
  });

  const queueRow = async (matchId: string) => {
    const [row] = await db`
      SELECT status, attempts, transient_errors FROM match_fetch_queue WHERE match_id = ${matchId}`;
    return row;
  };
  const queued = (matchId: string) => ({ matchId, platform: 'EUW1' as const, attempts: 0 });

  test('missing match → failed attempt, FAILED on the second one', async () => {
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000777']);
    expect(await worker.processMatch(queued('EUW1_7000000777'))).toBe('failed');
    expect(await queueRow('EUW1_7000000777')).toMatchObject({ attempts: 1, status: 'PENDING' });
    expect(await worker.processMatch(queued('EUW1_7000000777'))).toBe('failed');
    expect(await queueRow('EUW1_7000000777')).toMatchObject({ attempts: 2, status: 'FAILED' });
  });

  test('deterministic errors (other 4xx, parse error) fail a match on its second attempt', async () => {
    const broken = makeMatch('EUW1_7000000601', '15.22.1.1');
    broken.match.info.participants = broken.match.info.participants.slice(0, 9);
    riot.matches.set('EUW1_7000000601', broken);
    riot.errors.set('match:EUW1_7000000602', [
      new RiotHttpError(400, 'match-v5.match', '/x'),
      new RiotHttpError(400, 'match-v5.match', '/x'),
    ]);
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000601', 'EUW1_7000000602']);
    for (const id of ['EUW1_7000000601', 'EUW1_7000000602']) {
      expect(await worker.processMatch(queued(id))).toBe('failed');
      expect(await worker.processMatch(queued(id))).toBe('failed');
      expect(await queueRow(id)).toMatchObject({
        attempts: 2,
        transient_errors: 0,
        status: 'FAILED',
      });
    }
    expect(riot.calls.filter((c) => c === 'match:EUW1_7000000601')).toHaveLength(2);
  });

  test('transient errors (5xx, 429, network) defer a match without counting attempts, up to a cap', async () => {
    const capped = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
      options: { maxTransientErrors: 4 },
    });
    riot.matches.set('EUW1_7000000700', makeMatch('EUW1_7000000700', '15.22.1.1'));
    riot.errors.set('match:EUW1_7000000700', [
      new RiotHttpError(503, 'match-v5.match', '/x'),
      new RiotHttpError(429, 'match-v5.match', '/x'),
    ]);
    riot.errors.set('timeline:EUW1_7000000700', [
      new RiotNetworkError('match-v5.timeline', '/x', new TypeError('fetch failed')),
    ]);
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000700', 'EUW1_7000000701']);
    for (let i = 0; i < 3; i++) {
      expect(await capped.processMatch(queued('EUW1_7000000700'))).toBe('retry');
    }
    expect(await queueRow('EUW1_7000000700')).toMatchObject({
      attempts: 0,
      transient_errors: 3,
      status: 'PENDING',
    });
    // Once Riot answers again, it is stored.
    expect(await capped.processMatch(queued('EUW1_7000000700'))).toBe('added');

    // Safety cap: a match that keeps failing transiently ends up FAILED.
    riot.errors.set(
      'match:EUW1_7000000701',
      Array.from({ length: 4 }, () => new RiotHttpError(500, 'match-v5.match', '/x')),
    );
    for (let i = 0; i < 3; i++) {
      expect(await capped.processMatch(queued('EUW1_7000000701'))).toBe('retry');
    }
    expect(await capped.processMatch(queued('EUW1_7000000701'))).toBe('failed');
    expect(await queueRow('EUW1_7000000701')).toMatchObject({ attempts: 0, status: 'FAILED' });
  });

  test('a loop backs off after transient errors, exponentially', async () => {
    const sleeps: number[] = [];
    const recordingClock = {
      ...fixedClock,
      sleep: (ms: number, signal?: AbortSignal) => {
        sleeps.push(ms);
        return fixedClock.sleep(ms, signal);
      },
    };
    const backoff = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: recordingClock,
      options: {
        idleMs: 10,
        transientBackoffMs: 1_000,
        heartbeatMs: 60_000,
        maxTransientBackoffMs: 3_000,
        concurrency: { listing: 0, match: 1, daily: 0, enrichment: 0 },
      },
    });
    const ids = Array.from({ length: 4 }, (_, i) => `EUW1_70000008${String(i).padStart(2, '0')}`);
    for (const id of ids) riot.errors.set(`match:${id}`, [new RiotHttpError(503, 'm', '/x')]);
    await enqueueMatchIds(db, 'EUW1', ids);
    const ac = new AbortController();
    const running = backoff.start(ac.signal);
    const backoffs = () => sleeps.filter((ms) => ms >= 1_000 && ms < 60_000);
    for (let i = 0; i < 200 && backoffs().length < 4; i++) {
      await Bun.sleep(25);
    }
    ac.abort();
    await running;
    expect(backoffs()).toEqual([1_000, 2_000, 3_000, 3_000]);
    for (const id of ids) {
      expect(await queueRow(id)).toMatchObject({
        attempts: 0,
        transient_errors: 1,
        status: 'PENDING',
      });
    }
  });

  test('daily refresh and enrichment use their priorities and store the data', async () => {
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    await worker.refreshLadder();
    await worker.dailyRefresh({ puuid: ladderPuuid(0) });
    const [p] =
      await db`SELECT masteries_refreshed_at FROM players WHERE puuid = ${ladderPuuid(0)}`;
    expect(p?.masteries_refreshed_at).not.toBeNull();
    expect(riot.calls).toContain(`mastery:${ladderPuuid(0)}:2`);
    expect(riot.calls.some((c) => c.startsWith('account:'))).toBe(false);

    riot.matches.set('EUW1_7000000500', makeMatch('EUW1_7000000500', '15.22.715.1234'));
    await worker.processMatch({ matchId: 'EUW1_7000000500', platform: 'EUW1', attempts: 0 });
    const [e] = await db<{ puuid: string }[]>`SELECT puuid FROM player_enrichment_queue LIMIT 1`;
    await worker.enrich({ puuid: e?.puuid as string, platform: 'EUW1', attempts: 0 });
    const [r] =
      await db`SELECT solo_tier, solo_division, solo_lp FROM players WHERE puuid = ${e?.puuid as string}`;
    expect(r).toEqual({ solo_tier: 'DIAMOND', solo_division: 2, solo_lp: 42 });
    expect(riot.calls).toContain(`entries:${e?.puuid}:1`);
  });

  test('worker_status: heartbeat, a rejected key is flagged until Riot answers again', async () => {
    const w = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
      options: { idleMs: 10, authErrorPauseMs: 50 },
    });
    const auth = () => new RiotAuthError(401, 'league-v4', '/x');
    riot.errors.set('league:CHALLENGER', [auth()]);
    riot.errors.set('league:GRANDMASTER', [auth()]);
    const status = async () => (await listWorkerStatus(db))[0];
    const waitFor = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await cond()); i++) await Bun.sleep(20);
    };

    const ac = new AbortController();
    const running = w.start(ac.signal);
    await waitFor(async () => (await status())?.authRejectedSince != null);
    const rejected = await status();
    expect(rejected?.authRejectedSince).toEqual(new Date(NOW));
    expect(rejected?.heartbeatAt).toEqual(new Date(NOW));
    expect(rejected?.lastError).toStartWith('ladder: Riot API rejected the key');

    // The next successful Riot response clears it.
    riot.matches.set('EUW1_7000000500', makeMatch('EUW1_7000000500', '15.22.715.1234'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000500']);
    await waitFor(async () => (await status())?.authRejectedSince === null);
    ac.abort();
    await running;
    expect(riot.calls).toContain('match:EUW1_7000000500');
    expect((await status())?.authRejectedSince).toBeNull();
    expect((await status())?.lastError).toStartWith('ladder:');
  });

  test('start(): ladder → listing → matches → enrichment, then a clean stop with a worker_runs row', async () => {
    riot.leagues.CHALLENGER.entries = ladder(2, () => 50);
    riot.matchIds.set(ladderPuuid(0), ['EUW1_7000000502', 'EUW1_7000000501']);
    riot.matchIds.set(ladderPuuid(1), ['EUW1_7000000502']);
    riot.matches.set('EUW1_7000000501', makeMatch('EUW1_7000000501', '15.21.1.1', ladderPuuid(0)));
    riot.matches.set('EUW1_7000000502', makeMatch('EUW1_7000000502', '15.22.1.1', ladderPuuid(0)));
    // The latest patch is already live on EUW1 (a stored match without participants, so nothing
    // is enqueued for enrichment): the 15.21 match is from a patch no longer collected.
    await db`
      INSERT INTO matches (id, platform, patch, game_version, queue_id, started_at, duration_s,
                           is_remake, is_early_surrender, winning_team)
      VALUES ('EUW1_7000009000', 'EUW1', '15.22', '15.22.715.1234', 420, now(), 1800, false, false, 100)`;
    const listed = async () => {
      const [row] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM matches WHERE id <> 'EUW1_7000009000'`;
      return row?.n ?? -1;
    };

    const ac = new AbortController();
    const running = worker.start(ac.signal);
    for (let i = 0; i < 200; i++) {
      const n = await count(db, 'player_enrichment_queue');
      const m = await listed();
      const [p] =
        await db`SELECT count(*)::int AS n FROM match_fetch_queue WHERE status = 'PENDING'`;
      if (m === 1 && n === 0 && p?.n === 0) break;
      await Bun.sleep(25);
    }
    ac.abort();
    await running;

    // Only the latest patch is stored: the 15.21 match is skipped before its timeline.
    const m = await listed();
    expect(m).toBe(1);
    expect(riot.calls).not.toContain('timeline:EUW1_7000000501');
    // Each match fetched once even though two players listed EUW1_7000000502.
    expect(riot.calls.filter((c) => c === 'match:EUW1_7000000502')).toHaveLength(1);
    const enrichCalls = riot.calls.filter((c) => c.startsWith('entries:'));
    expect(enrichCalls.length).toBe(9);
    const runs =
      await db`SELECT platform, finished_at, matches_added, players_polled FROM worker_runs`;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ platform: 'EUW1', matches_added: 1, players_polled: 2 });
    expect(runs[0]?.finished_at).not.toBeNull();
  });
});
