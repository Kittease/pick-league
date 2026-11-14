import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Db } from './client.ts';
import {
  claimEnrichment,
  claimPendingMatches,
  clearWorkerAuthRejected,
  completeEnrichment,
  countEnrichmentQueue,
  deferMatch,
  deferMatchAfterError,
  deleteOldPatches,
  enqueueEnrichment,
  enqueueMatchIds,
  failEnrichment,
  finishListing,
  finishWorkerRun,
  getLatestPatch,
  getMatchesSyncedUntil,
  insertParsedMatch,
  listMigrationFiles,
  listPatches,
  listWorkerStatus,
  markMatchDone,
  markMatchFailed,
  markMatchSkipped,
  markWorkerAuthRejected,
  migrate,
  pickProbeMatch,
  playersNeedingDailyRefresh,
  playersWithListingRequested,
  purgeOrphanPlayers,
  recordWorkerError,
  replaceMasteries,
  setMatchesSyncedUntil,
  skipPendingMatchesUpTo,
  startWorkerRun,
  touchWorkerStatus,
  updatePlayerRank,
  updatePlayerRiotId,
  upsertLadder,
  upsertPatchStaticData,
} from './index.ts';
import {
  fakePuuid,
  parsedMatch,
  resetDb,
  staticPatch,
  TEST_DATABASE_URL,
  testDb,
} from './test-helpers.ts';

const TEN = Array.from({ length: 10 }, (_, i) => fakePuuid(i + 1));

describe.skipIf(!TEST_DATABASE_URL)('@pick-league/db (Postgres)', () => {
  let db: Db;

  // Each test gets a freshly migrated schema and a new pool: dropping the schema recreates the
  // enum types with new OIDs, which pooled connections would otherwise have cached.
  beforeEach(async () => {
    const admin = testDb();
    await resetDb(admin);
    await admin.end();
    db = testDb();
  });
  afterEach(async () => {
    await db.end();
  });

  describe('migrate', () => {
    test('is idempotent and safe to run concurrently', async () => {
      await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      const other = testDb();
      try {
        const [a, b] = await Promise.all([migrate(db), migrate(other)]);
        const files = await listMigrationFiles();
        expect([...a.applied, ...b.applied].sort()).toEqual(files.map((f) => f.name));
        expect((await migrate(db)).applied).toEqual([]);
        const rows = await db`SELECT version FROM schema_migrations ORDER BY version`;
        expect(rows.map((r) => r.version)).toEqual(files.map((f) => f.version));
      } finally {
        await other.end();
      }
    });
  });

  describe('patches + static data', () => {
    test('upsert is idempotent and lists newest first', async () => {
      await upsertPatchStaticData(db, staticPatch('15.9'));
      await upsertPatchStaticData(db, staticPatch('15.10'));
      await upsertPatchStaticData(db, staticPatch('15.10', '15.10.2'));
      const patches = await listPatches(db);
      expect(patches.map((p) => [p.id, p.ddragonVersion])).toEqual([
        ['15.10', '15.10.2'],
        ['15.9', '15.9.1'],
      ]);
      expect((await getLatestPatch(db))?.id).toBe('15.10');
      const [spells] =
        await db`SELECT count(*)::int AS n FROM champion_spells WHERE patch = '15.10'`;
      expect(spells?.n).toBe(4);
      const [item] = await db`SELECT builds_into, stats FROM items WHERE patch = '15.10'`;
      expect(item?.builds_into).toEqual([3006]);
      expect(item?.stats).toEqual({ FlatMovementSpeedMod: 25 });
    });
  });

  describe('ladder', () => {
    test('detects new players and players whose games changed, removes dropped ones', async () => {
      const a = fakePuuid(1);
      const b = fakePuuid(2);
      const c = fakePuuid(3);
      const first = await upsertLadder(db, 'KR', [
        { puuid: a, tier: 'CHALLENGER', leaguePoints: 1500, wins: 100, losses: 80 },
        { puuid: b, tier: 'GRANDMASTER', leaguePoints: 700, wins: 50, losses: 40 },
      ]);
      expect(first.played.sort()).toEqual([a, b]);
      expect(first.added.sort()).toEqual([a, b]);

      const second = await upsertLadder(db, 'KR', [
        { puuid: a, tier: 'CHALLENGER', leaguePoints: 1520, wins: 101, losses: 80 },
        { puuid: c, tier: 'GRANDMASTER', leaguePoints: 650, wins: 10, losses: 5 },
      ]);
      expect(second.played.sort()).toEqual([a, c]);
      expect(second.added).toEqual([c]);
      expect(second.removed).toBe(1);

      const [player] = await db`SELECT solo_tier, solo_lp FROM players WHERE puuid = ${a}`;
      expect(player).toEqual({ solo_tier: 'CHALLENGER', solo_lp: 1520 });
      // dropped player keeps its players row
      expect((await db`SELECT 1 FROM players WHERE puuid = ${b}`).length).toBe(1);
    });

    test('matches_synced_until round-trips', async () => {
      const a = fakePuuid(1);
      await upsertLadder(db, 'EUW1', [
        { puuid: a, tier: 'CHALLENGER', leaguePoints: 1, wins: 1, losses: 1 },
      ]);
      expect(await getMatchesSyncedUntil(db, a)).toBeNull();
      const until = new Date('2026-11-10T00:00:00Z');
      await setMatchesSyncedUntil(db, a, until);
      expect(await getMatchesSyncedUntil(db, a)).toEqual(until);
    });

    test('listing requests are stored, kept until a later listing finishes, then cleared', async () => {
      const [a, b, c] = [fakePuuid(1), fakePuuid(2), fakePuuid(3)] as [string, string, string];
      const entry = (puuid: string, wins: number) => ({
        puuid,
        tier: 'CHALLENGER' as const,
        leaguePoints: 1,
        wins,
        losses: 1,
      });
      const t = (min: number) => new Date(Date.UTC(2026, 10, 13, 12, min));
      await upsertLadder(db, 'EUW1', [entry(a, 1), entry(b, 1)], t(0));
      expect(await playersWithListingRequested(db, 'EUW1')).toEqual([a, b]);

      // a's listing started after the request: cleared.
      await finishListing(db, a, t(1), t(2));
      expect(await getMatchesSyncedUntil(db, a)).toEqual(t(1));
      // b played again while its listing (started at 5) ran: the newer request is kept.
      await upsertLadder(db, 'EUW1', [entry(a, 1), entry(b, 2), entry(c, 1)], t(10));
      await finishListing(db, b, t(4), t(5));
      expect(await playersWithListingRequested(db, 'EUW1')).toEqual([b, c]);
      // An unchanged ladder neither adds nor drops requests; other platforms are separate.
      await upsertLadder(db, 'EUW1', [entry(a, 1), entry(b, 2), entry(c, 1)], t(20));
      expect(await playersWithListingRequested(db, 'EUW1')).toEqual([b, c]);
      expect(await playersWithListingRequested(db, 'KR')).toEqual([]);
    });
  });

  describe('match fetch queue', () => {
    test('enqueue ignores duplicates; claim/done/skip/fail/defer', async () => {
      expect(await enqueueMatchIds(db, 'EUW1', ['EUW1_1', 'EUW1_2', 'EUW1_2'])).toBe(2);
      expect(await enqueueMatchIds(db, 'EUW1', ['EUW1_2', 'EUW1_3'])).toBe(1);
      await enqueueMatchIds(db, 'KR', ['KR_1']);

      const claimed = await claimPendingMatches(db, 'EUW1', 10);
      expect(claimed.map((c) => c.matchId)).toEqual(['EUW1_1', 'EUW1_2', 'EUW1_3']);

      await markMatchDone(db, 'EUW1_1');
      await markMatchSkipped(db, 'EUW1_2');
      await deferMatch(db, 'EUW1_3', 'patch newer than Data Dragon');
      expect((await claimPendingMatches(db, 'EUW1', 10)).map((c) => c.matchId)).toEqual(['EUW1_3']);

      for (let i = 0; i < 4; i++) {
        expect(await markMatchFailed(db, 'EUW1_3', 'boom', 5)).toBe('PENDING');
      }
      expect(await markMatchFailed(db, 'EUW1_3', 'boom', 5)).toBe('FAILED');
      expect(await claimPendingMatches(db, 'EUW1', 10)).toEqual([]);
      expect(await claimPendingMatches(db, 'KR', 10)).toHaveLength(1);
      // Rows no longer PENDING are left alone.
      expect(await markMatchSkipped(db, 'EUW1_2')).toBe(false);
      await markMatchFailed(db, 'EUW1_1', 'late failure');
      const [done] = await db`SELECT status FROM match_fetch_queue WHERE match_id = 'EUW1_1'`;
      expect(done?.status).toBe('DONE');
    });

    test('claims follow the ladder rank of the best lister; retried matches go to the back', async () => {
      expect(await enqueueMatchIds(db, 'EUW1', ['EUW1_1'], 500)).toBe(1);
      expect(await enqueueMatchIds(db, 'EUW1', ['EUW1_2', 'EUW1_3'], 20)).toBe(2);
      expect(await enqueueMatchIds(db, 'EUW1', ['EUW1_4'])).toBe(1); // no rank: at the back
      // A better-placed player lists EUW1_1 too: it moves up (not counted as new).
      expect(await enqueueMatchIds(db, 'EUW1', ['EUW1_1'], 3)).toBe(0);
      // A worse-placed one changes nothing.
      expect(await enqueueMatchIds(db, 'EUW1', ['EUW1_2'], 900)).toBe(0);
      const order = async () => (await claimPendingMatches(db, 'EUW1', 10)).map((c) => c.matchId);
      expect(await order()).toEqual(['EUW1_1', 'EUW1_2', 'EUW1_3', 'EUW1_4']);

      await deferMatch(db, 'EUW1_1', 'patch newer than Data Dragon');
      expect(await order()).toEqual(['EUW1_2', 'EUW1_3', 'EUW1_4', 'EUW1_1']);
      // A deferred match stays at the back even when a top player lists it again.
      await enqueueMatchIds(db, 'EUW1', ['EUW1_1'], 0);
      expect(await order()).toEqual(['EUW1_2', 'EUW1_3', 'EUW1_4', 'EUW1_1']);
    });

    test('transient errors defer without counting attempts, up to a cap', async () => {
      await enqueueMatchIds(db, 'EUW1', ['EUW1_1', 'EUW1_2']);
      for (let i = 0; i < 2; i++) {
        expect(await deferMatchAfterError(db, 'EUW1_1', 'http 503', 3)).toBe('PENDING');
      }
      const [row] = await db`
        SELECT attempts, transient_errors, last_error FROM match_fetch_queue WHERE match_id = 'EUW1_1'`;
      expect(row).toEqual({ attempts: 0, transient_errors: 2, last_error: 'http 503' });
      // Moved behind EUW1_2.
      expect((await claimPendingMatches(db, 'EUW1', 10)).map((c) => c.matchId)).toEqual([
        'EUW1_2',
        'EUW1_1',
      ]);
      expect(await deferMatchAfterError(db, 'EUW1_1', 'http 503', 3)).toBe('FAILED');
    });

    test('bulk skip by game id, and probes by game id within a range', async () => {
      const ids = [10, 20, 30, 40, 50].map((n) => `EUW1_${n}`);
      await enqueueMatchIds(db, 'EUW1', [...ids, 'EUW1_x']);
      await enqueueMatchIds(db, 'KR', ['KR_5']);
      const probe = (
        above: number,
        below: number | null,
        pick: 'highest' | 'median',
        exclude: string[] = [],
      ) =>
        pickProbeMatch(db, 'EUW1', { aboveGameId: above, belowGameId: below, pick, exclude }).then(
          (m) => m?.matchId ?? null,
        );
      expect(await probe(0, null, 'highest')).toBe('EUW1_50');
      expect(await probe(0, null, 'median')).toBe('EUW1_30');
      expect(await probe(10, 40, 'median')).toBe('EUW1_30');
      expect(await probe(10, 40, 'highest')).toBe('EUW1_30');
      expect(await probe(0, null, 'highest', ['EUW1_50'])).toBe('EUW1_40');
      expect(await probe(40, 50, 'median')).toBeNull();

      expect(await skipPendingMatchesUpTo(db, 'EUW1', 30)).toBe(3);
      const pending = await db<{ match_id: string }[]>`
        SELECT match_id FROM match_fetch_queue WHERE status = 'PENDING' ORDER BY match_id`;
      expect(pending.map((r) => r.match_id)).toEqual(['EUW1_40', 'EUW1_50', 'EUW1_x', 'KR_5']);
      expect(await probe(0, null, 'median')).toBe('EUW1_50');
    });
  });

  describe('insertParsedMatch', () => {
    test('stores the match, all children and the 10 players in one go', async () => {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      await enqueueMatchIds(db, 'EUW1', ['EUW1_100']);
      // participant 1 is a tracked ladder player: not enqueued for enrichment
      await upsertLadder(db, 'EUW1', [
        { puuid: TEN[0] as string, tier: 'CHALLENGER', leaguePoints: 1, wins: 1, losses: 0 },
      ]);

      const res = await insertParsedMatch(db, parsedMatch('EUW1_100', '15.22', TEN));
      expect(res).toEqual({ inserted: true, enrichmentEnqueued: 9 });

      const count = async (table: string) =>
        (await db.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n;
      expect(await count('matches')).toBe(1);
      expect(await count('match_teams')).toBe(2);
      expect(await count('match_bans')).toBe(10);
      expect(await count('participants')).toBe(10);
      expect(await count('players')).toBe(10);
      expect(await count('item_events')).toBe(2);
      expect(await count('skill_events')).toBe(1);
      expect(await count('kill_events')).toBe(1);
      expect(await count('objective_events')).toBe(1);

      const [p] = await db`
        SELECT runes, stat_shards, final_items, gold_by_minute, position_x_by_minute, position
        FROM participants WHERE match_id = 'EUW1_100' AND participant_id = 1`;
      expect(p?.runes).toEqual([8005, 9111, 9104, 8014, 8444, 8451]);
      expect(p?.final_items).toEqual([3006, 0, 0, 0, 0, 0, 3340]);
      expect(p?.gold_by_minute).toEqual([500, 900, 1400]);
      expect(p?.position).toBe('TOP');
      const [k] = await db`SELECT assist_participant_ids FROM kill_events`;
      expect(k?.assist_participant_ids).toEqual([2, 3]);
      const [player] =
        await db`SELECT game_name, tag_line FROM players WHERE puuid = ${TEN[4] as string}`;
      expect(player).toEqual({ game_name: 'Fake Player 5', tag_line: 'TEST' });
      const [queued] = await db`SELECT status FROM match_fetch_queue WHERE match_id = 'EUW1_100'`;
      expect(queued?.status).toBe('DONE');

      expect(await insertParsedMatch(db, parsedMatch('EUW1_100', '15.22', TEN))).toEqual({
        inserted: false,
        enrichmentEnqueued: 0,
      });
    });

    test('older payloads do not overwrite a newer Riot ID', async () => {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      const newer = parsedMatch('EUW1_2', '15.22', TEN, new Date('2026-11-05T00:00:00Z'));
      const older = parsedMatch('EUW1_1', '15.22', TEN, new Date('2026-11-01T00:00:00Z'));
      for (const p of older.participants) p.riotIdGameName = 'Old Name';
      await insertParsedMatch(db, newer);
      await insertParsedMatch(db, older);
      const [row] =
        await db`SELECT game_name, last_seen_in_match_at FROM players WHERE puuid = ${TEN[0] as string}`;
      expect(row?.game_name).toBe('Fake Player 1');
      expect(row?.last_seen_in_match_at).toEqual(new Date('2026-11-05T00:00:00Z'));
    });

    test('concurrent inserts and ladder upserts sharing players do not deadlock', async () => {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      const pool = Array.from({ length: 12 }, (_, i) => fakePuuid(i + 1));
      // Every match lists an overlapping set of players in a different order (as the platform
      // loops do when they ingest at the same time).
      const matches = Array.from({ length: 24 }, (_, i) => {
        const rotated = [...pool.slice(i % 12), ...pool.slice(0, i % 12)].slice(0, 10);
        return parsedMatch(`EUW1_${500 + i}`, '15.22', i % 2 ? rotated.reverse() : rotated);
      });
      const ladder = (reverse: boolean) =>
        upsertLadder(
          db,
          'EUW1',
          (reverse ? [...pool].reverse() : pool).map((puuid) => ({
            puuid,
            tier: 'CHALLENGER' as const,
            leaguePoints: 1,
            wins: 1,
            losses: 1,
          })),
        );
      await ladder(false);
      await Promise.all([
        ...matches.map((m) => insertParsedMatch(db, m)),
        ladder(true),
        ladder(false),
      ]);
      expect((await db`SELECT 1 FROM matches`).length).toBe(24);
    });

    test('rolls back everything when a child insert fails', async () => {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      const bad = parsedMatch('EUW1_3', '15.22', TEN);
      bad.skillEvents.push({ ...(bad.skillEvents[0] as (typeof bad.skillEvents)[number]) }); // duplicate PK
      await expect(insertParsedMatch(db, bad)).rejects.toThrow();
      expect((await db`SELECT 1 FROM matches`).length).toBe(0);
      expect((await db`SELECT 1 FROM players`).length).toBe(0);
    });
  });

  describe('players enrichment', () => {
    test('mastery, rank, Riot ID, enrichment queue and daily refresh', async () => {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      await insertParsedMatch(db, parsedMatch('EUW1_1', '15.22', TEN), {
        enqueueEnrichment: false,
      });
      const p = TEN[1] as string;
      expect(await enqueueEnrichment(db, 'EUW1', [p, p])).toBe(1);
      expect(await enqueueEnrichment(db, 'EUW1', [p])).toBe(0);
      expect((await claimEnrichment(db, 'EUW1', 5)).map((e) => e.puuid)).toEqual([p]);

      await replaceMasteries(db, p, [
        {
          championId: 12,
          level: 7,
          points: 250000,
          lastPlayedAt: new Date('2026-11-01T00:00:00Z'),
        },
        { championId: 40, level: 5, points: 40000, lastPlayedAt: new Date('2026-10-01T00:00:00Z') },
      ]);
      await replaceMasteries(db, p, [
        {
          championId: 12,
          level: 8,
          points: 260000,
          lastPlayedAt: new Date('2026-11-02T00:00:00Z'),
        },
        // Real payloads hold ids beyond Data Dragon and the smallint range (seen on KR).
        {
          championId: 60018,
          level: 1,
          points: 1429,
          lastPlayedAt: new Date('2026-10-01T00:00:00Z'),
        },
      ]);
      const masteries =
        await db`SELECT champion_id, level FROM champion_masteries WHERE puuid = ${p} ORDER BY champion_id`;
      expect(masteries.map((m) => [m.champion_id, m.level])).toEqual([
        [12, 8],
        [60018, 1],
      ]);

      await updatePlayerRank(db, p, {
        tier: 'MASTER',
        division: null,
        lp: 120,
        wins: 60,
        losses: 50,
      });
      await completeEnrichment(db, p);
      expect(await countEnrichmentQueue(db, 'EUW1')).toBe(0);
      // fresh masteries + rank → not re-enqueued within 7 days
      expect(await enqueueEnrichment(db, 'EUW1', [p])).toBe(0);

      const q = TEN[2] as string;
      await enqueueEnrichment(db, 'EUW1', [q]);
      expect(await failEnrichment(db, q, 'err', 2)).toBe(false);
      expect(await failEnrichment(db, q, 'err', 2)).toBe(true);
      expect(await countEnrichmentQueue(db, 'EUW1')).toBe(0);

      // daily refresh only concerns tracked ladder players
      const tracked = TEN[3] as string;
      await upsertLadder(db, 'EUW1', [
        { puuid: tracked, tier: 'GRANDMASTER', leaguePoints: 1, wins: 1, losses: 1 },
      ]);
      const due = await playersNeedingDailyRefresh(db, 'EUW1', 10);
      // name came from the match payload (2026-11-01), masteries never fetched
      expect(due).toEqual([{ puuid: tracked, needsAccount: true, needsMastery: true }]);
      await updatePlayerRiotId(db, tracked, 'Fake Renamed', 'TEST');
      await replaceMasteries(db, tracked, []);
      expect(await playersNeedingDailyRefresh(db, 'EUW1', 10)).toEqual([]);
    });
  });

  describe('cleanup + worker runs', () => {
    test('keeps 2 patches, cascades matches and removes orphan non-tracked players', async () => {
      for (const patch of ['15.20', '15.21', '15.22']) {
        await upsertPatchStaticData(db, staticPatch(patch));
      }
      const oldPlayers = Array.from({ length: 10 }, (_, i) => fakePuuid(100 + i));
      await insertParsedMatch(db, parsedMatch('EUW1_OLD', '15.20', oldPlayers));
      await insertParsedMatch(db, parsedMatch('EUW1_NEW', '15.22', TEN));
      await upsertLadder(db, 'EUW1', [
        { puuid: oldPlayers[0] as string, tier: 'CHALLENGER', leaguePoints: 1, wins: 1, losses: 1 },
      ]);
      await enqueueMatchIds(db, 'EUW1', ['EUW1_OLD']);
      await markMatchDone(db, 'EUW1_OLD');

      const res = await deleteOldPatches(db, 2);
      expect(res.deletedPatches).toEqual(['15.20']);
      expect(res.purgedQueueRows).toBe(1);
      expect((await listPatches(db)).map((p) => p.id)).toEqual(['15.22', '15.21']);
      expect((await db`SELECT id FROM matches`).map((r) => r.id)).toEqual(['EUW1_NEW']);
      expect((await db`SELECT 1 FROM item_events WHERE match_id = 'EUW1_OLD'`).length).toBe(0);
      expect(await deleteOldPatches(db, 2)).toEqual({ deletedPatches: [], purgedQueueRows: 0 });

      expect(await purgeOrphanPlayers(db, { batchSize: 4 })).toBe(9);
      expect((await db`SELECT 1 FROM players`).length).toBe(11);
      expect(await purgeOrphanPlayers(db)).toBe(0);
    });

    test('orphan purge skips players an in-flight match insert is writing', async () => {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      const orphans = Array.from({ length: 12 }, (_, i) => fakePuuid(200 + i));
      await insertParsedMatch(db, parsedMatch('EUW1_GONE', '15.22', orphans.slice(0, 10)));
      await insertParsedMatch(db, parsedMatch('EUW1_GONE2', '15.22', orphans.slice(2, 12)));
      await db`DELETE FROM matches`;

      // A match insert reusing 10 of the orphans is in flight (its transaction holds their rows).
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let inserted = () => {};
      const insertedYet = new Promise<void>((r) => {
        inserted = r;
      });
      const insert = db.begin(async (tx) => {
        await insertParsedMatch(tx, parsedMatch('EUW1_NEW', '15.22', orphans.slice(0, 10)));
        inserted();
        await gate;
      });
      await insertedYet;
      // Does not wait for the insert, and leaves its players alone.
      expect(await purgeOrphanPlayers(db, { batchSize: 1 })).toBe(2);
      release();
      await insert;
      expect((await db`SELECT 1 FROM players`).length).toBe(10);
      expect((await db`SELECT 1 FROM participants`).length).toBe(10);
    });

    test('worker runs', async () => {
      const id = await startWorkerRun(db, 'NA1');
      await finishWorkerRun(db, id, { requestsMade: 42, playersPolled: 3, matchesAdded: 7 });
      const [row] =
        await db`SELECT requests_made, matches_added, finished_at FROM worker_runs WHERE id = ${id}`;
      expect(row?.requests_made).toBe(42);
      expect(row?.matches_added).toBe(7);
      expect(row?.finished_at).toBeInstanceOf(Date);
    });

    test('worker status: heartbeat, auth rejection, last error', async () => {
      const t = (min: number) => new Date(Date.UTC(2026, 10, 13, 12, min));
      await touchWorkerStatus(db, 'KR', t(0));
      await markWorkerAuthRejected(db, 'KR', t(1));
      await markWorkerAuthRejected(db, 'KR', t(2));
      await recordWorkerError(db, 'KR', `ladder: ${'x'.repeat(600)}`, t(3));
      await touchWorkerStatus(db, 'EUW1', t(4));
      let [kr, euw] = await listWorkerStatus(db);
      expect(kr).toMatchObject({ platform: 'KR', heartbeatAt: t(3), authRejectedSince: t(1) });
      expect(kr?.lastError).toHaveLength(500);
      expect(kr?.lastErrorAt).toEqual(t(3));
      expect(euw).toEqual({
        platform: 'EUW1',
        heartbeatAt: t(4),
        authRejectedSince: null,
        lastError: null,
        lastErrorAt: null,
      });
      await clearWorkerAuthRejected(db, 'KR');
      [kr] = await listWorkerStatus(db);
      expect(kr?.authRejectedSince).toBeNull();
    });
  });
});
