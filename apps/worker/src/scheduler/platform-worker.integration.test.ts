import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  enqueueMatchIds,
  migrate,
  upsertPatchStaticData,
} from '@pick-league/db';
import type {
  AccountDto,
  ChampionMasteryDto,
  LadderTier,
  LeagueEntryDto,
  LeagueListDto,
  MatchDto,
  Platform,
  StaticPatchData,
  TimelineDto,
} from '@pick-league/shared';
import matchFixture from '../parser/fixtures/match.json';
import timelineFixture from '../parser/fixtures/timeline.json';
import type { PatchVerdict } from '../patches.ts';
import type { MatchIdsQuery, Priority, RiotApi } from '../riot/client.ts';
import { type PatchView, PlatformWorker } from './platform-worker.ts';

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

  async getLeague(_p: Platform, tier: LadderTier) {
    this.calls.push(`league:${tier}`);
    return this.leagues[tier];
  }
  async getMatchIds(_p: Platform, puuid: string, q: MatchIdsQuery) {
    this.calls.push(`ids:${puuid}:${q.start}`);
    this.idQueries.push(q);
    const all = this.matchIds.get(puuid) ?? [];
    const start = q.start ?? 0;
    return all.slice(start, start + (q.count ?? 100));
  }
  async getMatch(_p: Platform, id: string) {
    this.calls.push(`match:${id}`);
    return this.matches.get(id)?.match ?? null;
  }
  async getTimeline(_p: Platform, id: string) {
    this.calls.push(`timeline:${id}`);
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

  test('ladder refresh keeps only the top Master players by LP, or none with masterPlayers 0', async () => {
    const master = (lp: number) =>
      ({
        ...ladder(1, () => 30)[0],
        puuid: `fake-master-${lp}`,
        leaguePoints: lp,
      }) as LeagueListDto['entries'][number];
    riot.leagues.MASTER.entries = [master(100), master(300), master(200)];
    const top2 = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
      options: { masterPlayers: 2 },
    });
    expect(await top2.refreshLadder()).toBe(2);
    const rows = await db<{ puuid: string; tier: string }[]>`
      SELECT puuid, tier FROM ladder_entries ORDER BY puuid`;
    expect([...rows]).toEqual([
      { puuid: 'fake-master-200', tier: 'MASTER' },
      { puuid: 'fake-master-300', tier: 'MASTER' },
    ]);

    riot.calls = [];
    riot.leagues.CHALLENGER.entries = ladder(1, () => 50);
    const none = new PlatformWorker({
      platform: 'EUW1',
      db,
      riot,
      patches,
      clock: fixedClock,
      options: { masterPlayers: 0 },
    });
    await none.refreshLadder();
    expect(riot.calls).toEqual(['league:CHALLENGER', 'league:GRANDMASTER']);
    expect(await count(db, 'ladder_entries')).toBe(1);
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

  test('missing match → failed attempt', async () => {
    await enqueueMatchIds(db, 'EUW1', ['EUW1_7000000777']);
    expect(
      await worker.processMatch({ matchId: 'EUW1_7000000777', platform: 'EUW1', attempts: 0 }),
    ).toBe('failed');
    const [row] = await db`SELECT attempts, status FROM match_fetch_queue`;
    expect(row).toMatchObject({ attempts: 1, status: 'PENDING' });
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
});
