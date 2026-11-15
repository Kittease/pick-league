import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  enqueueMatchIds,
  getLiveGame,
  getLiveProfiles,
  getMatchesSyncedUntil,
  listWorkerStatus,
  migrate,
  readPlayPause,
  requestLiveGame,
  requestLiveLookups,
  setClientActivity,
  upsertPatchStaticData,
} from '@pick-league/db';
import type {
  AccountDto,
  ChampionMasteryDto,
  CurrentGameInfoDto,
  LadderTier,
  LeagueEntryDto,
  LeagueListDto,
  MatchDto,
  Platform,
  StaticPatchData,
  TimelineDto,
} from '@pick-league/shared';
import { silentLogger } from '../log.ts';
import matchFixture from '../parser/fixtures/match.json';
import timelineFixture from '../parser/fixtures/timeline.json';
import type { PatchVerdict } from '../patches.ts';
import {
  type MatchIdsQuery,
  type Priority,
  type RiotApi,
  RiotAuthError,
  RiotHttpError,
  RiotNetworkError,
} from '../riot/client.ts';
import { type PatchView, PlatformWorker } from './platform-worker.ts';
import { PlayPause } from './play-pause.ts';

const URL = process.env.DATABASE_URL_TEST;
const d = URL ? describe : describe.skip;
if (!URL)
  console.warn('[worker] DATABASE_URL_TEST is not set: skipping scheduler integration tests');

const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 86_400_000;
async function count(db: Db, table: string): Promise<number> {
  const [row] = await db.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`);
  return row?.n ?? -1;
}

const ladderPuuid = (n: number) => `fake-ladder-puuid-${String(n).padStart(3, '0')}`;

function staticPatch(patch: string): StaticPatchData {
  return {
    patch,
    ddragonVersion: `${patch}.1`,
    champions: [],
    items: [],
    runeTrees: [],
    runes: [],
    summonerSpells: [],
  };
}

/** A fixture match re-labelled with another id, patch and (optionally) player 1. */
function makeMatch(id: string, gameVersion: string, player1?: string) {
  const match = structuredClone(matchFixture) as unknown as MatchDto;
  const timeline = structuredClone(timelineFixture) as unknown as TimelineDto;
  match.metadata.matchId = id;
  timeline.metadata.matchId = id;
  match.info.gameVersion = gameVersion;
  for (const p of match.info.participants) p.puuid = `${p.puuid.slice(0, 14)}-${id}`;
  if (player1 && match.info.participants[0]) match.info.participants[0].puuid = player1;
  return { match, timeline };
}

class FakeRiot implements RiotApi {
  calls: string[] = [];
  leagues: Record<LadderTier, LeagueListDto> = {
    CHALLENGER: { leagueId: 'l', tier: 'CHALLENGER', name: 'n', queue: 'q', entries: [] },
    GRANDMASTER: { leagueId: 'l', tier: 'GRANDMASTER', name: 'n', queue: 'q', entries: [] },
    MASTER: { leagueId: 'l', tier: 'MASTER', name: 'n', queue: 'q', entries: [] },
  };
  matchIds = new Map<string, string[]>();
  idQueries: MatchIdsQuery[] = [];
  matches = new Map<string, { match: MatchDto; timeline: TimelineDto }>();
  /** Errors thrown by the next calls, keyed like `calls` ('match:EUW1_1', 'league:CHALLENGER'…). */
  errors = new Map<string, Error[]>();

  private maybeThrow(call: string) {
    const err = this.errors.get(call)?.shift();
    if (err) throw err;
  }

  async getLeague(_p: Platform, tier: LadderTier) {
    this.calls.push(`league:${tier}`);
    this.maybeThrow(`league:${tier}`);
    return this.leagues[tier];
  }
  /** When set, match-id listings wait for it (after recording the call). */
  idsGate: Promise<void> | null = null;

  async getMatchIds(_p: Platform, puuid: string, q: MatchIdsQuery) {
    this.calls.push(`ids:${puuid}:${q.start}`);
    this.maybeThrow(`ids:${puuid}:${q.start}`);
    if (this.idsGate) await this.idsGate;
    this.idQueries.push(q);
    const all = this.matchIds.get(puuid) ?? [];
    const start = q.start ?? 0;
    return all.slice(start, start + (q.count ?? 100));
  }
  /** Priority each match was fetched with (undefined = the client's default). */
  matchPriorities = new Map<string, Priority | undefined>();
  async getMatch(_p: Platform, id: string, _signal?: AbortSignal, priority?: Priority) {
    this.calls.push(`match:${id}`);
    this.matchPriorities.set(id, priority);
    this.maybeThrow(`match:${id}`);
    return this.matches.get(id)?.match ?? null;
  }
  async getTimeline(_p: Platform, id: string) {
    this.calls.push(`timeline:${id}`);
    this.maybeThrow(`timeline:${id}`);
    return this.matches.get(id)?.timeline ?? null;
  }
  async getAccount(_p: Platform, puuid: string, priority: Priority): Promise<AccountDto | null> {
    this.calls.push(`account:${puuid}:${priority}`);
    return { puuid, gameName: 'Fake Name', tagLine: 'FAKE' };
  }
  async getMasteries(
    _p: Platform,
    puuid: string,
    priority: Priority,
  ): Promise<ChampionMasteryDto[]> {
    this.calls.push(`mastery:${puuid}:${priority}`);
    return [
      {
        puuid,
        championId: 412,
        championLevel: 30,
        championPoints: 400000,
        lastPlayTime: NOW - DAY,
        championPointsSinceLastLevel: 0,
        championPointsUntilNextLevel: 0,
      },
    ];
  }
  async getLeagueEntries(
    _p: Platform,
    puuid: string,
    priority: Priority,
  ): Promise<LeagueEntryDto[]> {
    this.calls.push(`entries:${puuid}:${priority}`);
    this.maybeThrow(`entries:${puuid}`);
    return [
      {
        puuid,
        queueType: 'RANKED_SOLO_5x5',
        tier: 'DIAMOND',
        rank: 'II',
        leaguePoints: 42,
        wins: 100,
        losses: 90,
        hotStreak: false,
        veteran: false,
        freshBlood: false,
        inactive: false,
      },
    ];
  }
  /** The game spectator-v5 shows for the fake user (null = 404). */
  activeGame: CurrentGameInfoDto | null = null;
  async getAccountByRiotId(
    _p: Platform,
    gameName: string,
    tagLine: string,
    priority: Priority,
  ): Promise<AccountDto | null> {
    this.calls.push(`riot-id:${gameName}#${tagLine}:${priority}`);
    if (gameName !== 'FakePlayer') return null;
    return { puuid: 'fake-api-me', gameName, tagLine };
  }
  async getActiveGame(
    _p: Platform,
    puuid: string,
    priority: Priority,
  ): Promise<CurrentGameInfoDto | null> {
    this.calls.push(`active-game:${puuid}:${priority}`);
    this.maybeThrow('active-game');
    return this.activeGame;
  }
  async getChampionMastery(
    _p: Platform,
    puuid: string,
    championId: number,
    priority: Priority,
  ): Promise<ChampionMasteryDto | null> {
    this.calls.push(`champion-mastery:${puuid}:${championId}:${priority}`);
    if (championId !== 412) return null;
    return {
      puuid,
      championId,
      championLevel: 12,
      championPoints: 123_456,
      lastPlayTime: NOW - DAY,
      championPointsSinceLastLevel: 0,
      championPointsUntilNextLevel: 0,
    };
  }
}

class FakePatches implements PatchView {
  ready = true;
  generation = 1;
  refreshRequests = 0;
  classify(patch: string): PatchVerdict {
    if (patch === '15.22') return 'keep';
    return patch === '15.23' ? 'too_new' : 'old';
  }
  requestRefresh() {
    this.refreshRequests++;
  }
}

const fixedClock = {
  now: () => NOW,
  setTimer: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, Math.min(ms, 20));
    return () => clearTimeout(t);
  },
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      // Long sleeps (ladder interval) only end with the abort; short ones are shortened.
      const t = ms < 60_000 ? setTimeout(resolve, Math.min(ms, 20)) : undefined;
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('Aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }),
};

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
      UNION ALL SELECT 'kill_events', count(*)::int FROM kill_events
      UNION ALL SELECT 'objective_events', count(*)::int FROM objective_events
      UNION ALL SELECT 'match_bans', count(*)::int FROM match_bans
      UNION ALL SELECT 'enrichment', count(*)::int FROM player_enrichment_queue`;
    expect(Object.fromEntries(counts.map((c) => [c.t, c.n]))).toEqual({
      participants: 10,
      item_events: 8,
      skill_events: 4,
      kill_events: 2,
      objective_events: 11,
      match_bans: 10,
      enrichment: 10,
    });
    const [q] = await db`SELECT status FROM match_fetch_queue WHERE match_id = 'EUW1_7000000500'`;
    expect(q?.status).toBe('DONE');
  });

  test('previous patch: skipped, and older ids are skipped without fetching nor listing', async () => {
    riot.matches.set('EUW1_7000000100', makeMatch('EUW1_7000000100', '15.21.700.1'));
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000100', 'EUW1_7000000050']);
    const q = (matchId: string) => ({ matchId, platform: 'EUW1' as const, attempts: 0 });
    expect(await worker.processMatch(q('EUW1_7000000100'))).toBe('skipped');
    riot.calls = [];
    expect(await worker.processMatch(q('EUW1_7000000050'))).toBe('skipped');
    expect(riot.calls).toEqual([]);
    const statuses = await db`SELECT status FROM match_fetch_queue ORDER BY match_id`;
    expect(statuses.map((s) => s.status)).toEqual(['SKIPPED_OLD_PATCH', 'SKIPPED_OLD_PATCH']);

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
    expect(await count(db, 'matches')).toBe(4);
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
        // Its 1 s poll would read as a backoff here.
        live: { pollMs: 60_000 },
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
    await worker.dailyRefresh({ puuid: ladderPuuid(0), needsAccount: true, needsMastery: true });
    const [p] =
      await db`SELECT game_name, masteries_refreshed_at FROM players WHERE puuid = ${ladderPuuid(0)}`;
    expect(p?.game_name).toBe('Fake Name');
    expect(p?.masteries_refreshed_at).not.toBeNull();
    expect(riot.calls).toContain(`account:${ladderPuuid(0)}:2`);

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

    const ac = new AbortController();
    const running = worker.start(ac.signal);
    for (let i = 0; i < 200; i++) {
      const n = await count(db, 'player_enrichment_queue');
      const m = await count(db, 'matches');
      const [p] =
        await db`SELECT count(*)::int AS n FROM match_fetch_queue WHERE status = 'PENDING'`;
      if (m === 1 && n === 0 && p?.n === 0) break;
      await Bun.sleep(25);
    }
    ac.abort();
    await running;

    // Only the latest patch is stored: the 15.21 match is skipped before its timeline.
    const m = await count(db, 'matches');
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

  describe('live games', () => {
    const me = { platform: 'EUW1' as const, gameName: 'FakePlayer', tagLine: 'TEST' };

    test("found from the user's Riot ID (spectator-v5), its players queued and looked up", async () => {
      riot.activeGame = {
        gameId: 9001,
        participants: [
          { teamId: 200, championId: 412, puuid: 'fake-api-me' },
          { teamId: 200, championId: 21, puuid: 'fake-api-ally' },
          { teamId: 100, championId: 89, puuid: 'fake-api-enemy' },
          { teamId: 100, championId: 1, puuid: null, bot: true },
          // Hidden by Riot: kept without an id, never looked up.
          { teamId: 100, championId: 2, puuid: null, bot: false },
        ],
      };
      await requestLiveGame(db, { ...me, gameId: 9001 });
      await worker.processLiveLookups();
      expect(riot.calls).toEqual(['riot-id:FakePlayer#TEST:6', 'active-game:fake-api-me:6']);
      expect(await getLiveGame(db, 'EUW1', 9001)).toMatchObject({
        status: 'READY',
        myTeamId: 200,
        participants: [
          { teamId: 200, championId: 412, puuid: 'fake-api-me' },
          { teamId: 200, championId: 21, puuid: 'fake-api-ally' },
          { teamId: 100, championId: 89, puuid: 'fake-api-enemy' },
          { teamId: 100, championId: 2, puuid: null },
        ],
      });
      // Every participant queued at once, with the champion they play; looked up next.
      expect(
        (await db`SELECT puuid FROM live_player_profiles ORDER BY puuid`).map((r) => r.puuid),
      ).toEqual(['fake-api-ally', 'fake-api-enemy', 'fake-api-me']);
      riot.calls = [];
      expect(await worker.processLiveLookups()).toBe(3);
      expect(riot.calls).toContain('champion-mastery:fake-api-enemy:89:6');

      // Another game of the same user: the account is not asked for again.
      riot.calls = [];
      riot.activeGame = { ...riot.activeGame, gameId: 9002 };
      await requestLiveGame(db, { ...me, gameId: 9002 });
      await worker.processLiveLookups();
      expect(riot.calls[0]).toBe('active-game:fake-api-me:6');
    });

    test('not shown by Riot: asked again, then not found; unknown Riot ID: not found', async () => {
      const w = new PlatformWorker({
        platform: 'EUW1',
        db,
        riot,
        patches,
        clock: fixedClock,
        options: { idleMs: 10, live: { gameNotFoundRetryMs: 0, gameNotFoundAttempts: 2 } },
      });
      await requestLiveGame(db, { ...me, gameId: 9003 });
      await w.processLiveLookups();
      expect(await getLiveGame(db, 'EUW1', 9003)).toMatchObject({ status: 'PENDING' });
      await w.processLiveLookups();
      expect(await getLiveGame(db, 'EUW1', 9003)).toMatchObject({
        status: 'FAILED',
        lastError: 'not_found: Riot does not show this game',
      });

      await requestLiveGame(db, { ...me, gameName: 'Nobody', gameId: 9004 });
      await w.processLiveLookups();
      expect((await getLiveGame(db, 'EUW1', 9004))?.lastError).toStartWith('not_found');
    });
  });

  describe('paused while the user plays', () => {
    test('collection loops wait, live lookups go on, resumed after the game', async () => {
      const pause = new PlayPause({ db, clock: fixedClock, log: silentLogger });
      const w = new PlatformWorker({
        platform: 'EUW1',
        db,
        riot,
        patches,
        clock: fixedClock,
        pause,
        options: { idleMs: 10, live: { pollMs: 10 } },
      });
      await setClientActivity(
        db,
        { client: 'desktop', phase: 'InProgress', busyForMs: 90_000 },
        new Date(NOW),
      );
      expect(await pause.check()).toBe(true);
      await requestLiveLookups(db, 'EUW1', [{ puuid: 'fake-live-puuid-1', championId: 412 }]);
      const ac = new AbortController();
      const run = w.start(ac.signal);
      for (let i = 0; i < 100; i++) {
        const [p] = await getLiveProfiles(db, [{ puuid: 'fake-live-puuid-1', championId: 412 }]);
        if (p?.status === 'READY') break;
        await Bun.sleep(20);
      }
      // The live lookup ran; the ladder was not even read.
      expect(riot.calls.some((c) => c.startsWith('entries:fake-live-puuid-1'))).toBe(true);
      expect(riot.calls.some((c) => c.startsWith('league:'))).toBe(false);

      await setClientActivity(
        db,
        { client: 'desktop', phase: 'EndOfGame', busyForMs: null },
        new Date(NOW),
      );
      expect(await pause.check()).toBe(false);
      for (let i = 0; i < 100 && !riot.calls.some((c) => c.startsWith('league:')); i++) {
        await Bun.sleep(20);
      }
      expect(riot.calls.some((c) => c.startsWith('league:'))).toBe(true);
      ac.abort();
      await run;
    });

    test('the pause ends by itself when the desktop stops renewing it', async () => {
      await setClientActivity(
        db,
        { client: 'desktop', phase: 'ChampSelect', busyForMs: 90_000 },
        new Date(NOW),
      );
      expect((await readPlayPause(db, new Date(NOW + 60_000))).paused).toBe(true);
      expect((await readPlayPause(db, new Date(NOW + 91_000))).paused).toBe(false);
    });
  });

  describe('live lookups', () => {
    const LIVE = 'fake-live-puuid-1';
    const DUO = 'fake-live-puuid-2';
    const fixtureChampion = (matchFixture as unknown as MatchDto).info.participants[0]
      ?.championId as number;

    test('rank and mastery, then recent matches: stored ones reused, none added to the stats', async () => {
      // One of the player's recent matches is already stored by the crawler.
      riot.matches.set('EUW1_7000000500', makeMatch('EUW1_7000000500', '15.22.715.1234', LIVE));
      await worker.processMatch({ matchId: 'EUW1_7000000500', platform: 'EUW1', attempts: 0 });
      riot.calls = [];
      // Another one is not (and from an older patch: any patch is fine for a lookup).
      const fetched = makeMatch('EUW1_7000000600', '15.21.1.1', LIVE);
      const duoSeat = fetched.match.info.participants[1];
      if (duoSeat) duoSeat.puuid = DUO;
      riot.matches.set('EUW1_7000000600', fetched);
      riot.matchIds.set(LIVE, ['EUW1_7000000600', 'EUW1_7000000500']);
      riot.matchIds.set(DUO, ['EUW1_7000000600']);

      await requestLiveLookups(db, 'EUW1', [
        { puuid: LIVE, championId: 412 },
        { puuid: DUO, championId: 12 },
      ]);
      expect(await worker.processLiveLookups()).toBe(2);

      expect([...riot.calls].sort()).toEqual(
        [
          `entries:${LIVE}:6`,
          `champion-mastery:${LIVE}:412:6`,
          `ids:${LIVE}:0`,
          'match:EUW1_7000000600',
          `entries:${DUO}:6`,
          `champion-mastery:${DUO}:12:6`,
          `ids:${DUO}:0`,
        ].sort(),
      );
      // The duo partner's match was fetched once, for both of them.
      expect(riot.matchPriorities.get('EUW1_7000000600')).toBe(6);
      expect(riot.idQueries.map((q) => [q.count, q.priority])).toEqual([
        [10, 6],
        [10, 6],
      ]);
      expect(await count(db, 'matches')).toBe(1);
      expect(await count(db, 'participants')).toBe(10);
      expect(await count(db, 'match_fetch_queue')).toBe(0);
      expect((await db`SELECT 1 FROM players WHERE puuid LIKE 'fake-live-%'`).length).toBe(1);

      const profiles = await getLiveProfiles(db, [
        { puuid: LIVE, championId: 412 },
        { puuid: DUO, championId: 12 },
      ]);
      const live = profiles.find((p) => p.puuid === LIVE);
      expect(live).toMatchObject({
        status: 'READY',
        rankLoaded: true,
        rank: { tier: 'DIAMOND', division: 2, lp: 42, wins: 100, losses: 90 },
        mastery: { level: 12, points: 123_456 },
      });
      expect(live?.recent?.map((m) => [m.matchId, m.championId, m.position, m.remake])).toEqual([
        ['EUW1_7000000600', fixtureChampion, 'TOP', false],
        ['EUW1_7000000500', fixtureChampion, 'TOP', false],
      ]);
      expect(profiles.find((p) => p.puuid === DUO)).toMatchObject({
        status: 'READY',
        mastery: { level: 0, points: 0 },
        recent: [expect.objectContaining({ matchId: 'EUW1_7000000600', position: 'JUNGLE' })],
      });

      // Asked again within 30 minutes: nothing is fetched.
      riot.calls = [];
      await requestLiveLookups(db, 'EUW1', [{ puuid: LIVE, championId: 412 }], {
        now: new Date(NOW),
      });
      expect(await worker.processLiveLookups()).toBe(0);
      expect(riot.calls).toEqual([]);
    });

    test('errors: retried, then FAILED with a message that does not contain the puuid', async () => {
      const w = new PlatformWorker({
        platform: 'EUW1',
        db,
        riot,
        patches,
        clock: fixedClock,
        options: { idleMs: 10, live: { retryMs: 0 } },
      });
      const badRequest = () =>
        new RiotHttpError(
          400,
          'league-v4.entries-by-puuid',
          `/lol/league/v4/entries/by-puuid/${LIVE}`,
        );
      riot.errors.set(`entries:${LIVE}`, [badRequest(), badRequest()]);
      await requestLiveLookups(db, 'EUW1', [{ puuid: LIVE, championId: 412 }]);

      await w.processLiveLookups();
      let [p] = await getLiveProfiles(db, [{ puuid: LIVE, championId: 412 }]);
      // The mastery fetched alongside is kept; the lookup waits for its retry.
      expect(p).toMatchObject({ status: 'PENDING', mastery: { level: 12, points: 123_456 } });

      await w.processLiveLookups();
      [p] = await getLiveProfiles(db, [{ puuid: LIVE, championId: 412 }]);
      expect(p?.status).toBe('FAILED');
      expect(p?.lastError).toContain('/by-puuid/<puuid>');
      expect(p?.lastError).not.toContain(LIVE);
      // Only the rank was asked for again.
      expect(riot.calls.filter((c) => c.startsWith('champion-mastery:'))).toHaveLength(1);
      for (let i = 0; i < 50 && !(await listWorkerStatus(db))[0]?.lastError; i++) {
        await Bun.sleep(10);
      }
      const status = (await listWorkerStatus(db))[0];
      expect(status?.lastError).toStartWith('lookup:');
      expect(status?.lastError).not.toContain(LIVE);
    });

    test('an auth error keeps the lookup pending and pauses the worker', async () => {
      riot.errors.set(`entries:${LIVE}`, [new RiotAuthError(401, 'league-v4', '/x')]);
      await requestLiveLookups(db, 'EUW1', [{ puuid: LIVE, championId: 412 }]);
      await worker.processLiveLookups();
      const [p] = await getLiveProfiles(db, [{ puuid: LIVE, championId: 412 }]);
      expect(p).toMatchObject({ status: 'PENDING', lastError: null });
      for (let i = 0; i < 50 && !(await listWorkerStatus(db))[0]?.authRejectedSince; i++) {
        await Bun.sleep(10);
      }
      expect((await listWorkerStatus(db))[0]?.authRejectedSince).toEqual(new Date(NOW));
    });

    test('start(): a lookup requested while the worker runs is done without waiting', async () => {
      riot.matchIds.set(LIVE, ['EUW1_7000000600']);
      riot.matches.set('EUW1_7000000600', makeMatch('EUW1_7000000600', '15.22.1.1', LIVE));
      const w = new PlatformWorker({
        platform: 'EUW1',
        db,
        riot,
        patches,
        clock: fixedClock,
        options: { idleMs: 10, concurrency: { listing: 0, match: 0, daily: 0, enrichment: 0 } },
      });
      const ac = new AbortController();
      const running = w.start(ac.signal);
      await requestLiveLookups(db, 'EUW1', [{ puuid: LIVE, championId: 412 }]);
      const ready = async () =>
        (await getLiveProfiles(db, [{ puuid: LIVE, championId: 412 }]))[0]?.status === 'READY';
      for (let i = 0; i < 200 && !(await ready()); i++) await Bun.sleep(20);
      ac.abort();
      await running;
      expect(await ready()).toBe(true);
      expect((await w.progress()).liveReady).toBe(1);
    });
  });
});
