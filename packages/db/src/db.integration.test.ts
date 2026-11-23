import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from './client.ts';
import {
  claimEnrichment,
  claimPendingMatches,
  clearListingRequest,
  clearWorkerAuthRejected,
  completeEnrichment,
  countEnrichmentQueue,
  countPendingMatchesInBand,
  countStoredGamesEndedBetween,
  DIAMOND_FETCH_RANK,
  DIAMOND_ONE_FETCH_RANK,
  deferMatch,
  deferMatchAfterError,
  deferOutsideMasterCheck,
  deleteOldPatches,
  EXTRA_FETCH_RANK,
  enqueueEnrichment,
  enqueueMatchIds,
  enqueueNewMatchIds,
  failEnrichment,
  finishListing,
  finishWorkerRun,
  getDiamondTracking,
  getLatestPatch,
  getListingSkipState,
  getMatchesSyncedUntil,
  getOutsideMasterSkipState,
  getRankRefreshedAt,
  hasPendingMatchBefore,
  insertParsedMatch,
  ladderOrder,
  listMigrationFiles,
  listPatches,
  listWorkerStatus,
  markMatchDone,
  markMatchFailed,
  markMatchSkipped,
  markWorkerAuthRejected,
  migrate,
  outsideMasterStats,
  outsideMastersToCheck,
  outsideMastersToList,
  pickProbeMatch,
  playersNeedingDailyRefresh,
  playersSeenWithMasterSince,
  playersWithListingRequested,
  purgeOrphanPlayers,
  QUEUE_BACK_RANK,
  recordListingSkipMiss,
  recordOutsideMasterCheck,
  recordWorkerError,
  replaceMasteries,
  saveDiamondTracking,
  setListingBaseline,
  setMatchesSyncedUntil,
  setOutsideMasterBaseline,
  skipPendingMatchesUpTo,
  startWorkerRun,
  syncOutsideMasters,
  touchWorkerStatus,
  trackedDiamondEntries,
  updateKnownPlayerRanks,
  updatePlayerRank,
  upsertDiamondLadder,
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

    test('0017 drops the live lookup and play pause tables', async () => {
      const tables = await db`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('live_games', 'live_player_profiles', 'live_player_masteries',
                             'client_activity')`;
      expect(tables).toHaveLength(0);
      expect(await db`SELECT 1 FROM pg_type WHERE typname = 'live_lookup_status'`).toHaveLength(0);
    });

    test('0024 marks every player already seen in a match as seen with a Master+ player', async () => {
      await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      const before = await mkdtemp(join(tmpdir(), 'pickleague-migrations-'));
      try {
        const files = await listMigrationFiles();
        for (const f of files) {
          if (f.version < '0024') await copyFile(f.path, join(before, f.name));
        }
        await migrate(db, { dir: before });
        const seenAt = new Date('2026-11-10T08:00:00Z');
        await db`
          INSERT INTO players (puuid, platform, last_seen_in_match_at) VALUES
            (${fakePuuid(1)}, 'KR', ${seenAt}), (${fakePuuid(2)}, 'KR', NULL)`;
        await db`
          INSERT INTO ladder_entries (puuid, platform, tier, league_points, wins, losses, updated_at)
          VALUES (${fakePuuid(2)}, 'KR', 'MASTER', 10, 4, 3, ${seenAt})`;

        expect((await migrate(db)).applied).toEqual(
          files.filter((f) => f.version >= '0024').map((f) => f.name),
        );
        const rows = await db`
          SELECT puuid, last_seen_with_master_at FROM players ORDER BY puuid`;
        expect([...rows]).toEqual([
          { puuid: fakePuuid(1), last_seen_with_master_at: seenAt },
          { puuid: fakePuuid(2), last_seen_with_master_at: null },
        ]);
        // Tracked players start without a baseline: their first listing is a real one.
        expect(await getListingSkipState(db, fakePuuid(2))).toEqual({
          gamesNow: 7,
          snapshotAt: seenAt,
          listedGames: null,
          listedSnapshotAt: null,
          listedAt: null,
        });
      } finally {
        await rm(before, { recursive: true, force: true });
      }
    });

    test('0031 moves the queued matches of Diamond players and outside Masters behind the new bands', async () => {
      await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      const before = await mkdtemp(join(tmpdir(), 'pickleague-migrations-'));
      try {
        const files = await listMigrationFiles();
        for (const f of files) {
          if (f.version < '0031') await copyFile(f.path, join(before, f.name));
        }
        await migrate(db, { dir: before });
        // EUW1 tracks two apex players and two Diamond players; KR has no ladder yet.
        const now = new Date('2026-11-23T08:00:00Z');
        await db`
          INSERT INTO players (puuid, platform) VALUES
            (${fakePuuid(1)}, 'EUW1'), (${fakePuuid(2)}, 'EUW1'),
            (${fakePuuid(3)}, 'EUW1'), (${fakePuuid(4)}, 'EUW1')`;
        await db`
          INSERT INTO ladder_entries
            (puuid, platform, tier, division, league_points, wins, losses, updated_at)
          VALUES
            (${fakePuuid(1)}, 'EUW1', 'CHALLENGER', NULL, 900, 5, 5, ${now}),
            (${fakePuuid(2)}, 'EUW1', 'MASTER', NULL, 100, 5, 5, ${now}),
            (${fakePuuid(3)}, 'EUW1', 'DIAMOND', 1, 80, 5, 5, ${now}),
            (${fakePuuid(4)}, 'EUW1', 'DIAMOND', 2, 70, 5, 5, ${now})`;
        // As the previous version queued them: apex players by ladder position (0, 1), Diamond
        // players after them (2, 3), an outside Master's with the ladder size (4).
        await db`
          INSERT INTO match_fetch_queue (match_id, platform, status, fetch_rank) VALUES
            ('EUW1_10', 'EUW1', 'PENDING', 0), ('EUW1_11', 'EUW1', 'PENDING', 1),
            ('EUW1_12', 'EUW1', 'PENDING', 2), ('EUW1_13', 'EUW1', 'PENDING', 3),
            ('EUW1_14', 'EUW1', 'PENDING', 4), ('EUW1_15', 'EUW1', 'PENDING', 1000000),
            ('EUW1_16', 'EUW1', 'DONE', 3), ('KR_10', 'KR', 'PENDING', 5)`;

        expect((await migrate(db)).applied).toEqual(
          files.filter((f) => f.version >= '0031').map((f) => f.name),
        );
        const rows = await db<{ match_id: string; fetch_rank: number }[]>`
          SELECT match_id, fetch_rank FROM match_fetch_queue ORDER BY match_id`;
        expect(rows.map((r) => [r.match_id, r.fetch_rank])).toEqual([
          ['EUW1_10', 0],
          ['EUW1_11', 1],
          ['EUW1_12', DIAMOND_FETCH_RANK],
          ['EUW1_13', DIAMOND_FETCH_RANK + 1],
          ['EUW1_14', DIAMOND_FETCH_RANK + 2],
          ['EUW1_15', QUEUE_BACK_RANK],
          ['EUW1_16', 3],
          ['KR_10', 5],
        ]);
        expect(await getDiamondTracking(db, 'EUW1')).toBeNull();
      } finally {
        await rm(before, { recursive: true, force: true });
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

    test('a ladder too big for one statement (bind-parameter limit) is stored whole', async () => {
      // ~9 parameters per player: 7500 players would need ~67k in one INSERT (limit 65535).
      const entries = Array.from({ length: 7500 }, (_, i) => ({
        puuid: fakePuuid(i + 1),
        tier: 'MASTER' as const,
        leaguePoints: i,
        wins: 10,
        losses: 10,
      }));
      const result = await upsertLadder(db, 'NA1', entries);
      expect(result.added).toHaveLength(7500);
      const [count] =
        await db`SELECT count(*)::int AS n FROM ladder_entries WHERE platform = 'NA1'`;
      expect(count?.n).toBe(7500);
      const [players] = await db`
        SELECT count(*)::int AS n FROM players WHERE listing_requested_at IS NOT NULL`;
      expect(players?.n).toBe(7500);
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

    const t = (min: number) => new Date(Date.UTC(2026, 10, 13, 12, min));
    const challenger = (puuid: string, wins: number) => ({
      puuid,
      tier: 'CHALLENGER' as const,
      leaguePoints: 1,
      wins,
      losses: 1,
    });
    const diamond = (puuid: string, division: number, lp: number, wins: number, seenAt?: Date) => ({
      puuid,
      tier: 'DIAMOND' as const,
      division,
      leaguePoints: lp,
      wins,
      losses: 1,
      seenAt,
    });

    test('listing baseline: kept while the player stays tracked, gone with the ladder entry', async () => {
      const a = fakePuuid(1);
      expect(await getListingSkipState(db, a)).toBeNull();
      await upsertLadder(db, 'EUW1', [challenger(a, 1)], t(0));
      expect(await getListingSkipState(db, a)).toEqual({
        gamesNow: 2,
        snapshotAt: t(0),
        listedGames: null,
        listedSnapshotAt: null,
        listedAt: null,
      });
      await setListingBaseline(db, a, { games: 2, snapshotAt: t(0), listedAt: t(1) });

      // Same wins + losses: the snapshot is still the refresh that produced them.
      await upsertLadder(db, 'EUW1', [challenger(a, 1)], t(60));
      expect((await getListingSkipState(db, a))?.snapshotAt).toEqual(t(0));
      // They changed: the snapshot moves, the baseline does not.
      await upsertLadder(db, 'EUW1', [challenger(a, 3)], t(120));
      expect(await getListingSkipState(db, a)).toEqual({
        gamesNow: 4,
        snapshotAt: t(120),
        listedGames: 2,
        listedSnapshotAt: t(0),
        listedAt: t(1),
      });

      // Off the ladder, then back: no baseline left.
      await upsertLadder(db, 'EUW1', [challenger(fakePuuid(2), 1)], t(180));
      expect(await getListingSkipState(db, a)).toBeNull();
      await setListingBaseline(db, a, { games: 4, snapshotAt: t(120), listedAt: t(181) });
      await upsertLadder(db, 'EUW1', [challenger(a, 3)], t(240));
      expect((await getListingSkipState(db, a))?.listedGames).toBeNull();
    });

    test('a ladder entry written before games_changed_at existed reads its last refresh as snapshot', async () => {
      const a = fakePuuid(1);
      await upsertLadder(db, 'EUW1', [challenger(a, 1)], t(0));
      await db`UPDATE ladder_entries SET games_changed_at = NULL`;
      expect((await getListingSkipState(db, a))?.snapshotAt).toEqual(t(0));
      // The next refresh with the same counters keeps that time.
      await upsertLadder(db, 'EUW1', [challenger(a, 1)], t(60));
      expect((await getListingSkipState(db, a))?.snapshotAt).toEqual(t(0));
    });

    test('a skipped listing clears the request unless the ladder asked again since its snapshot', async () => {
      const a = fakePuuid(1);
      await upsertLadder(db, 'EUW1', [challenger(a, 1)], t(0));
      await finishListing(db, a, t(1), t(2));
      await upsertLadder(db, 'EUW1', [challenger(a, 2)], t(60));
      // Decided on the counters of the refresh before: the newer request stays.
      await clearListingRequest(db, a, t(0));
      expect(await playersWithListingRequested(db, 'EUW1')).toEqual([a]);
      await clearListingRequest(db, a, t(60));
      expect(await playersWithListingRequested(db, 'EUW1')).toEqual([]);
      // matches_synced_until is not touched.
      expect(await getMatchesSyncedUntil(db, a)).toEqual(t(1));
    });

    test('stored games of a player are counted by end time, without remakes', async () => {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      const a = TEN[0] as string;
      const match = (id: string, startMin: number, remake = false) => {
        const m = parsedMatch(id, '15.22', TEN, t(startMin));
        m.match.durationS = 1800;
        m.match.isRemake = remake;
        return m;
      };
      await insertParsedMatch(db, match('EUW1_1', 0)); // ends at 30
      await insertParsedMatch(db, match('EUW1_2', 40)); // ends at 70
      await insertParsedMatch(db, match('EUW1_3', 80, true)); // remake, ends at 110
      await insertParsedMatch(db, parsedMatch('EUW1_4', '15.22', TEN.slice(1), t(80))); // without a
      expect(await countStoredGamesEndedBetween(db, a, t(-10), t(200))).toBe(2);
      // After the lower bound, at or before the upper one.
      expect(await countStoredGamesEndedBetween(db, a, t(30), t(70))).toBe(1);
      expect(await countStoredGamesEndedBetween(db, a, t(29), t(69))).toBe(1);
      expect(await countStoredGamesEndedBetween(db, a, t(30), t(69))).toBe(0);
      expect(await countStoredGamesEndedBetween(db, fakePuuid(99), t(-10), t(200))).toBe(0);
    });

    test('listing_skip_misses rows are stored as given', async () => {
      await recordListingSkipMiss(db, {
        puuid: fakePuuid(1),
        platform: 'KR',
        checkedAt: t(90),
        listedSnapshotAt: t(0),
        snapshotAt: t(60),
        expected: 2,
        stored: 3,
        newMatchIds: ['KR_7', 'KR_8'],
      });
      const rows = await db`
        SELECT puuid, platform, checked_at, listed_snapshot_at, snapshot_at, expected, stored,
               new_match_ids FROM listing_skip_misses`;
      expect([...rows]).toEqual([
        {
          puuid: fakePuuid(1),
          platform: 'KR',
          checked_at: t(90),
          listed_snapshot_at: t(0),
          snapshot_at: t(60),
          expected: 2,
          stored: 3,
          new_match_ids: ['KR_7', 'KR_8'],
        },
      ]);
    });

    test('Diamond players: tracked next to the apex ladder, after it, with their division', async () => {
      const [ch, d1, d2, d3, promoted] = [1, 2, 3, 4, 5].map(fakePuuid) as [
        string,
        string,
        string,
        string,
        string,
      ];
      await upsertLadder(db, 'EUW1', [challenger(ch, 1), challenger(promoted, 1)], t(0), {
        keepDiamond: true,
      });
      const first = await upsertDiamondLadder(
        db,
        'EUW1',
        [
          diamond(d2, 2, 90, 5, t(3)),
          diamond(d1, 1, 10, 5, t(2)),
          diamond(d3, 1, 50, 5, t(4)),
          // On the apex ladder: left to it.
          diamond(promoted, 1, 99, 9, t(4)),
        ],
        { now: t(5) },
      );
      expect(first.added.sort()).toEqual([d1, d2, d3]);
      expect(first.played.sort()).toEqual([d1, d2, d3]);
      const notSeen = { lastSeenWithMasterAt: null };
      expect(await ladderOrder(db, 'EUW1')).toEqual([
        { puuid: ch, tier: 'CHALLENGER', division: null, leaguePoints: 1, ...notSeen },
        { puuid: promoted, tier: 'CHALLENGER', division: null, leaguePoints: 1, ...notSeen },
        { puuid: d3, tier: 'DIAMOND', division: 1, leaguePoints: 50, ...notSeen },
        { puuid: d1, tier: 'DIAMOND', division: 1, leaguePoints: 10, ...notSeen },
        { puuid: d2, tier: 'DIAMOND', division: 2, leaguePoints: 90, ...notSeen },
      ]);
      // Each row says when the player was last seen in a Master+ game.
      await db`UPDATE players SET last_seen_with_master_at = ${t(4)} WHERE puuid = ${d2}`;
      const seen = (await ladderOrder(db, 'EUW1')).filter((r) => r.lastSeenWithMasterAt !== null);
      expect(seen.map((r) => [r.puuid, r.lastSeenWithMasterAt])).toEqual([[d2, t(4)]]);
      const [player] = await db`
        SELECT solo_tier, solo_division, solo_lp, listing_requested_at, rank_refreshed_at
        FROM players WHERE puuid = ${d2}`;
      // The request and the snapshot carry the time of the player's own page.
      expect(player).toEqual({
        solo_tier: 'DIAMOND',
        solo_division: 2,
        solo_lp: 90,
        listing_requested_at: t(3),
        rank_refreshed_at: t(3),
      });
      expect((await getListingSkipState(db, d2))?.snapshotAt).toEqual(t(3));
      expect(await trackedDiamondEntries(db, 'EUW1')).toHaveLength(3);
      expect(await playersNeedingDailyRefresh(db, 'EUW1', 10)).toHaveLength(5);

      // The apex refresh leaves the Diamond rows alone, and takes over a promoted player.
      await setListingBaseline(db, d1, { games: 6, snapshotAt: t(2), listedAt: t(6) });
      const apex = await upsertLadder(
        db,
        'EUW1',
        [challenger(ch, 1), { ...challenger(d1, 5), tier: 'MASTER' as const }],
        t(60),
        { keepDiamond: true },
      );
      expect(apex.removed).toBe(1); // `promoted` left the apex ladder
      expect(apex.played).toEqual([]);
      expect((await ladderOrder(db, 'EUW1')).map((r) => [r.puuid, r.tier, r.division])).toEqual([
        [ch, 'CHALLENGER', null],
        [d1, 'MASTER', null],
        [d3, 'DIAMOND', 1],
        [d2, 'DIAMOND', 2],
      ]);
      expect((await getListingSkipState(db, d1))?.listedGames).toBe(6);

      // Next sweep: d2 played, d3 was not seen but is kept exactly as it is; `keep: 'all'` only adds.
      const second = await upsertDiamondLadder(db, 'EUW1', [diamond(d2, 2, 95, 6, t(62))], {
        keep: [d3],
        now: t(65),
      });
      expect(second).toEqual({ played: [d2], added: [], removed: 0 });
      const kept = (await trackedDiamondEntries(db, 'EUW1')).find((r) => r.puuid === d3);
      expect(kept).toEqual({ puuid: d3, division: 1, leaguePoints: 50, seenAt: t(4) });
      const third = await upsertDiamondLadder(db, 'EUW1', [diamond(promoted, 3, 5, 1, t(70))], {
        keep: 'all',
      });
      expect(third).toMatchObject({ added: [promoted], removed: 0 });
      // A sweep without them removes the Diamond rows, never the apex ones.
      const last = await upsertDiamondLadder(db, 'EUW1', [diamond(d2, 2, 95, 6, t(122))], {
        now: t(125),
      });
      expect(last).toEqual({ played: [], added: [], removed: 2 });
      expect((await ladderOrder(db, 'EUW1')).map((r) => r.puuid)).toEqual([ch, d1, d2]);

      // Without Diamond tracking the apex refresh removes them, as any entry not listed.
      const off = await upsertLadder(db, 'EUW1', [challenger(ch, 1)], t(180));
      expect(off.removed).toBe(2);
      expect((await ladderOrder(db, 'EUW1')).map((r) => r.puuid)).toEqual([ch]);
    });

    test('players seen with a Master+ player since a date', async () => {
      await db`
        INSERT INTO players (puuid, platform, last_seen_with_master_at) VALUES
          (${fakePuuid(1)}, 'EUW1', ${t(0)}),
          (${fakePuuid(2)}, 'EUW1', ${t(-120)}),
          (${fakePuuid(3)}, 'EUW1', NULL),
          (${fakePuuid(4)}, 'KR', ${t(0)})`;
      expect(await playersSeenWithMasterSince(db, 'EUW1', t(-60))).toEqual([fakePuuid(1)]);
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

    test('enqueueNewMatchIds returns the ids that were new', async () => {
      expect(await enqueueNewMatchIds(db, 'EUW1', ['EUW1_1', 'EUW1_2', 'EUW1_2'], 4)).toEqual([
        'EUW1_1',
        'EUW1_2',
      ]);
      // Known ids are not new, also when a better-placed player moves one up.
      expect(await enqueueNewMatchIds(db, 'EUW1', ['EUW1_2', 'EUW1_3'], 1)).toEqual(['EUW1_3']);
      expect(await enqueueNewMatchIds(db, 'EUW1', [])).toEqual([]);
    });

    test('hasPendingMatchBefore: pending matches listed by better-placed players only', async () => {
      await enqueueMatchIds(db, 'EUW1', ['EUW1_1'], 5);
      await enqueueMatchIds(db, 'EUW1', ['EUW1_2']); // no rank: at the back
      await enqueueMatchIds(db, 'KR', ['KR_1'], 0);
      expect(await hasPendingMatchBefore(db, 'EUW1', 5)).toBe(false);
      expect(await hasPendingMatchBefore(db, 'EUW1', 6)).toBe(true);
      // Retried and deferred matches go to the back: nobody waits for them.
      await deferMatchAfterError(db, 'EUW1_1', 'HTTP 503');
      expect(await hasPendingMatchBefore(db, 'EUW1', 6)).toBe(false);
      await enqueueMatchIds(db, 'EUW1', ['EUW1_3'], 2);
      expect(await hasPendingMatchBefore(db, 'EUW1', 6)).toBe(true);
      await markMatchDone(db, 'EUW1_3');
      expect(await hasPendingMatchBefore(db, 'EUW1', 6)).toBe(false);
    });

    test('fetch_rank bands: apex players, then outside Masters, then Diamond players; the Diamond bands can be left out', async () => {
      await enqueueMatchIds(db, 'EUW1', ['EUW1_1'], DIAMOND_FETCH_RANK + 7);
      await enqueueMatchIds(db, 'EUW1', ['EUW1_2'], EXTRA_FETCH_RANK);
      await enqueueMatchIds(db, 'EUW1', ['EUW1_3']); // at the back
      await enqueueMatchIds(db, 'EUW1', ['EUW1_4'], 9000);
      await enqueueMatchIds(db, 'EUW1', ['EUW1_5'], DIAMOND_FETCH_RANK);
      await enqueueMatchIds(db, 'EUW1', ['EUW1_6'], DIAMOND_ONE_FETCH_RANK + 2);
      await enqueueMatchIds(db, 'KR', ['KR_1'], 0);
      expect(await claimPendingMatches(db, 'EUW1', 10)).toEqual([
        { matchId: 'EUW1_4', platform: 'EUW1', attempts: 0, fetchRank: 9000 },
        { matchId: 'EUW1_2', platform: 'EUW1', attempts: 0, fetchRank: EXTRA_FETCH_RANK },
        { matchId: 'EUW1_5', platform: 'EUW1', attempts: 0, fetchRank: DIAMOND_FETCH_RANK },
        { matchId: 'EUW1_1', platform: 'EUW1', attempts: 0, fetchRank: DIAMOND_FETCH_RANK + 7 },
        { matchId: 'EUW1_6', platform: 'EUW1', attempts: 0, fetchRank: DIAMOND_ONE_FETCH_RANK + 2 },
        { matchId: 'EUW1_3', platform: 'EUW1', attempts: 0, fetchRank: QUEUE_BACK_RANK },
      ]);
      // Not the Diamond players' turn: their matches stay, the back of the queue does not wait.
      const claimed = await claimPendingMatches(db, 'EUW1', 10, { heldFrom: DIAMOND_FETCH_RANK });
      expect(claimed.map((c) => c.matchId)).toEqual(['EUW1_4', 'EUW1_2', 'EUW1_3']);
      // The Diamond players seen in a Master+ game have work left: only the Diamond I band waits.
      const withoutOne = await claimPendingMatches(db, 'EUW1', 10, {
        heldFrom: DIAMOND_ONE_FETCH_RANK,
      });
      expect(withoutOne.map((c) => c.matchId)).toEqual([
        'EUW1_4',
        'EUW1_2',
        'EUW1_5',
        'EUW1_1',
        'EUW1_3',
      ]);

      const inBand = (from: number, below?: number, limit = 10) =>
        countPendingMatchesInBand(db, 'EUW1', { from, below }, limit);
      expect(await inBand(0, EXTRA_FETCH_RANK)).toBe(1);
      expect(await inBand(0, DIAMOND_FETCH_RANK)).toBe(2);
      expect(await inBand(EXTRA_FETCH_RANK, DIAMOND_FETCH_RANK)).toBe(1);
      expect(await inBand(0, DIAMOND_ONE_FETCH_RANK)).toBe(4);
      expect(await inBand(0, QUEUE_BACK_RANK)).toBe(5);
      expect(await inBand(QUEUE_BACK_RANK)).toBe(1);
      expect(await inBand(0, QUEUE_BACK_RANK, 3)).toBe(3);
      await markMatchDone(db, 'EUW1_4');
      expect(await inBand(0, EXTRA_FETCH_RANK)).toBe(0);
      // A match that fails leaves its band for the back of the queue.
      await markMatchFailed(db, 'EUW1_2', 'boom');
      expect(await inBand(0, DIAMOND_FETCH_RANK)).toBe(0);
      expect(await inBand(QUEUE_BACK_RANK)).toBe(2);
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
      // Events: one row for the only participant with events, as arrays in timeline order.
      expect([...(await db`SELECT * FROM participant_events`)]).toEqual([
        {
          match_id: 'EUW1_100',
          participant_id: 1,
          item_types: ['P', 'U'],
          item_ids: [1055, 1055],
          item_at_ms: [1000, 1500],
          skill_slots: [1],
        },
      ]);

      const [p] = await db`
        SELECT runes, stat_shards, final_items, gold_by_minute, cs_by_minute, position
        FROM participants WHERE match_id = 'EUW1_100' AND participant_id = 1`;
      expect(p?.runes).toEqual([8005, 9111, 9104, 8014, 8444, 8451]);
      expect(p?.final_items).toEqual([3006, 0, 0, 0, 0, 0, 3340]);
      expect(p?.gold_by_minute).toEqual([500, 900, 1400]);
      expect(p?.position).toBe('TOP');
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

    test('last_seen_with_master_at: set for all 10 by a match with a Master+ player, only by those', async () => {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      const seen = async (puuid: string) => {
        const [row] = await db<{ t: Date | null }[]>`
          SELECT last_seen_with_master_at AS t FROM players WHERE puuid = ${puuid}`;
        return row?.t ?? null;
      };
      const day = (d: number) => new Date(Date.UTC(2026, 10, d));
      const lobby = (from: number) => Array.from({ length: 10 }, (_, i) => fakePuuid(from + i));

      // Nobody known as Master or above (a tracked Diamond player does not count).
      await upsertDiamondLadder(db, 'EUW1', [
        { puuid: fakePuuid(1), tier: 'DIAMOND', division: 1, leaguePoints: 80, wins: 1, losses: 1 },
      ]);
      await insertParsedMatch(db, parsedMatch('EUW1_1', '15.22', lobby(1), day(1)));
      expect(await seen(fakePuuid(1))).toBeNull();
      expect(await seen(fakePuuid(5))).toBeNull();

      // A tracked apex player in the match: all 10 are marked with its start.
      await upsertLadder(
        db,
        'EUW1',
        [{ puuid: fakePuuid(20), tier: 'MASTER', leaguePoints: 1, wins: 1, losses: 1 }],
        new Date(),
        { keepDiamond: true },
      );
      await insertParsedMatch(db, parsedMatch('EUW1_2', '15.22', lobby(11), day(3)));
      expect(await seen(fakePuuid(11))).toEqual(day(3));
      expect(await seen(fakePuuid(20))).toEqual(day(3));
      expect(await seen(fakePuuid(1))).toBeNull();

      // A player known as Grandmaster by their stored rank (not tracked) counts too; an older
      // match never moves the date back.
      await updatePlayerRank(db, fakePuuid(5), {
        tier: 'GRANDMASTER',
        division: null,
        lp: 300,
        wins: 1,
        losses: 1,
      });
      await insertParsedMatch(db, parsedMatch('EUW1_3', '15.22', lobby(1), day(2)));
      expect(await seen(fakePuuid(1))).toEqual(day(2));
      await insertParsedMatch(db, parsedMatch('EUW1_4', '15.22', lobby(11), day(1)));
      expect(await seen(fakePuuid(11))).toEqual(day(3));
      // A Diamond rank is not enough.
      await db`INSERT INTO players (puuid, platform) VALUES (${fakePuuid(31)}, 'EUW1')`;
      await updatePlayerRank(db, fakePuuid(31), {
        tier: 'DIAMOND',
        division: 1,
        lp: 99,
        wins: 1,
        losses: 1,
      });
      await insertParsedMatch(db, parsedMatch('EUW1_5', '15.22', lobby(31), day(4)));
      expect(await seen(fakePuuid(31))).toBeNull();
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
      (bad.participants[0] as (typeof bad.participants)[number]).participantId = 2; // duplicate PK
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

      // p played champion 2 in the stored match: of a mastery answer only that row is kept.
      await replaceMasteries(db, p, [
        { championId: 2, level: 7, points: 250000, lastPlayedAt: new Date('2026-11-01T00:00:00Z') },
        { championId: 40, level: 5, points: 40000, lastPlayedAt: new Date('2026-10-01T00:00:00Z') },
      ]);
      await replaceMasteries(db, p, [
        { championId: 2, level: 8, points: 260000, lastPlayedAt: new Date('2026-11-02T00:00:00Z') },
        // Real payloads hold ids beyond Data Dragon and the smallint range (seen on KR).
        {
          championId: 60018,
          level: 1,
          points: 1429,
          lastPlayedAt: new Date('2026-10-01T00:00:00Z'),
        },
      ]);
      const masteries =
        await db`SELECT champion_id, level, points FROM champion_masteries WHERE puuid = ${p}`;
      expect([...masteries]).toEqual([{ champion_id: 2, level: 8, points: 260000 }]);

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
      // masteries never fetched
      expect(due).toEqual([{ puuid: tracked }]);
      await replaceMasteries(db, tracked, []);
      expect(await playersNeedingDailyRefresh(db, 'EUW1', 10)).toEqual([]);
    });
  });

  describe('masteries of champions with a stored game', () => {
    const mastery = (championId: number) => ({
      championId,
      level: 5,
      points: 1000 * championId,
      lastPlayedAt: new Date('2026-11-01T00:00:00Z'),
    });
    const masteryRows = async () =>
      (
        await db<{ puuid: string; champion_id: number }[]>`
          SELECT puuid, champion_id FROM champion_masteries ORDER BY puuid, champion_id`
      ).map((r) => [r.puuid, r.champion_id]);
    const queued = async () =>
      (await db<{ puuid: string }[]>`SELECT puuid FROM player_enrichment_queue ORDER BY puuid`).map(
        (r) => r.puuid,
      );
    const due = async () => (await playersNeedingDailyRefresh(db, 'EUW1', 20)).map((d) => d.puuid);
    const [tracked, other, third] = TEN as [string, string, string];

    /**
     * EUW1_1 stored (participant n plays champion n), the first of the ten tracked, and everyone's
     * masteries and rank fetched since: Riot returned their champion and champions 50 and 99.
     */
    async function firstMatchEnriched() {
      await upsertPatchStaticData(db, staticPatch('15.22'));
      await upsertLadder(db, 'EUW1', [
        { puuid: tracked, tier: 'CHALLENGER', leaguePoints: 1, wins: 1, losses: 0 },
      ]);
      expect(await insertParsedMatch(db, parsedMatch('EUW1_1', '15.22', TEN))).toEqual({
        inserted: true,
        enrichmentEnqueued: 9,
      });
      for (const [i, puuid] of TEN.entries()) {
        await replaceMasteries(db, puuid, [mastery(i + 1), mastery(50), mastery(99)]);
        if (puuid === tracked) continue;
        await updatePlayerRank(db, puuid, null);
        await completeEnrichment(db, puuid);
      }
    }

    /** A second match of the ten where the tracked player plays champion 50 and `other` 99. */
    function secondMatch(id: string) {
      const m = parsedMatch(id, '15.22', TEN, new Date('2026-11-02T12:00:00Z'));
      (m.participants[0] as (typeof m.participants)[number]).championId = 50;
      (m.participants[1] as (typeof m.participants)[number]).championId = 99;
      return m;
    }

    test('only the champions of stored games are kept from a mastery answer', async () => {
      await firstMatchEnriched();
      expect(await masteryRows()).toEqual(TEN.map((puuid, i) => [puuid, i + 1]));
      expect(await queued()).toEqual([]);
      expect(await due()).toEqual([]);
    });

    test('a first game on a champion asks for the masteries again, whatever their age', async () => {
      await firstMatchEnriched();
      // Fetched a moment ago, but two players have no row for the champion they just played.
      expect(await insertParsedMatch(db, secondMatch('EUW1_2'))).toEqual({
        inserted: true,
        enrichmentEnqueued: 1,
      });
      expect(await queued()).toEqual([other]);
      expect(await due()).toEqual([tracked]);
      // The others played a champion they have a row for: the 7-day rule applies to them.
      expect(await enqueueEnrichment(db, 'EUW1', [third])).toBe(0);

      // This time the answer has a stored game for champions 50 and 99.
      await replaceMasteries(db, tracked, [mastery(1), mastery(50), mastery(99)]);
      await replaceMasteries(db, other, [mastery(2), mastery(50), mastery(99)]);
      const rows = await masteryRows();
      expect(rows.filter(([puuid]) => puuid === tracked)).toEqual([
        [tracked, 1],
        [tracked, 50],
      ]);
      expect(rows.filter(([puuid]) => puuid === other)).toEqual([
        [other, 2],
        [other, 99],
      ]);
    });

    test('a fetch that brings no row for the champion is not asked again because of that match', async () => {
      await firstMatchEnriched();
      await insertParsedMatch(db, secondMatch('EUW1_2'));
      // Riot returns nothing for champions 50 and 99.
      await replaceMasteries(db, tracked, [mastery(1)]);
      await replaceMasteries(db, other, [mastery(2)]);
      await updatePlayerRank(db, other, null);
      await completeEnrichment(db, other);
      expect(await masteryRows()).toEqual(TEN.map((puuid, i) => [puuid, i + 1]));

      expect(await due()).toEqual([]);
      expect(await enqueueEnrichment(db, 'EUW1', TEN)).toBe(0);
      expect(await insertParsedMatch(db, secondMatch('EUW1_2'))).toEqual({
        inserted: false,
        enrichmentEnqueued: 0,
      });
      expect(await queued()).toEqual([]);
      expect(await due()).toEqual([]);
      // Another stored game on those champions asks once more.
      expect((await insertParsedMatch(db, secondMatch('EUW1_3'))).enrichmentEnqueued).toBe(1);
      expect(await due()).toEqual([tracked]);
    });

    test('a mastery answer waits for a match insert of the player in flight and sees its game', async () => {
      await firstMatchEnriched();
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let inserted = () => {};
      const insertedYet = new Promise<void>((r) => {
        inserted = r;
      });
      const insert = db.begin(async (tx) => {
        await insertParsedMatch(tx, secondMatch('EUW1_2'));
        inserted();
        await gate;
      });
      await insertedYet;
      // The answer has champion 99, on which `other`'s first game is not committed yet.
      const replaced = replaceMasteries(db, other, [mastery(2), mastery(99)]);
      await Bun.sleep(100);
      release();
      await Promise.all([insert, replaced]);
      expect((await masteryRows()).filter(([puuid]) => puuid === other)).toEqual([
        [other, 2],
        [other, 99],
      ]);
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
      expect([...(await db`SELECT match_id FROM participant_events`)]).toEqual([
        { match_id: 'EUW1_NEW' },
      ]);
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

    test('diamond tracking: the target of a platform and its history', async () => {
      expect(await getDiamondTracking(db, 'KR')).toBeNull();
      const at = new Date('2026-11-23T08:00:00Z');
      const state = {
        target: 1500,
        cycles: 'KKPPRK',
        lastCycleAt: at,
        settleCyclesLeft: 3,
        changedAt: at,
        changedFrom: 1000,
        changeReason: 'kept up for 24 cycles (11 kept, none missed)',
      };
      await saveDiamondTracking(db, 'KR', state, at);
      expect(await getDiamondTracking(db, 'KR')).toEqual(state);
      const next = { ...state, target: 1000, cycles: '', lastCycleAt: null, settleCyclesLeft: 0 };
      await saveDiamondTracking(db, 'KR', next, at);
      expect(await getDiamondTracking(db, 'KR')).toEqual(next);
      expect(await getDiamondTracking(db, 'EUW1')).toBeNull();
    });

    test('outside Masters: the Master+ players on no ladder, checked in rotation', async () => {
      const t = (hour: number) => new Date(Date.UTC(2026, 10, 13, hour));
      await db`
        INSERT INTO players (puuid, platform, solo_tier, solo_lp, matches_synced_until) VALUES
          (${fakePuuid(1)}, 'EUW1', 'MASTER', 50, ${t(1)}),
          (${fakePuuid(2)}, 'EUW1', 'GRANDMASTER', 10, NULL),
          (${fakePuuid(3)}, 'EUW1', 'MASTER', 80, ${t(5)}),
          (${fakePuuid(4)}, 'EUW1', 'DIAMOND', 99, NULL),
          (${fakePuuid(5)}, 'EUW1', 'MASTER', 90, ${t(1)}),
          (${fakePuuid(6)}, 'KR', 'MASTER', 70, NULL)`;
      // On the tracked ladder: not one of them.
      await upsertLadder(db, 'EUW1', [
        { puuid: fakePuuid(5), tier: 'MASTER', leaguePoints: 90, wins: 1, losses: 1 },
      ]);
      expect(await syncOutsideMasters(db, 'EUW1')).toEqual({ added: 3, removed: 0 });
      expect(await syncOutsideMasters(db, 'EUW1')).toEqual({ added: 0, removed: 0 });
      const toCheck = (at: Date, limit = 10) =>
        outsideMastersToCheck(db, 'EUW1', { checkedBefore: at, limit });
      // Never checked: by player id.
      expect(await toCheck(t(6))).toEqual([fakePuuid(1), fakePuuid(2), fakePuuid(3)]);
      expect(await outsideMastersToCheck(db, 'KR', { checkedBefore: t(6), limit: 10 })).toEqual([]);

      const master = (games: number) => ({
        tier: 'MASTER' as const,
        division: null,
        lp: 10,
        wins: games,
        losses: 0,
      });
      const check = (n: number, games: number, hour: number, listedSince = t(0)) =>
        recordOutsideMasterCheck(db, fakePuuid(n), master(games), {
          now: t(hour),
          listedSince,
        });
      const requested = async (n: number) =>
        (await db`SELECT listing_requested_at FROM players WHERE puuid = ${fakePuuid(n)}`)[0]
          ?.listing_requested_at as Date | null;

      // First checks: a player listed since `listedSince` only gets a starting counter; one
      // never listed, or not since, gets a listing.
      expect(await check(1, 100, 6)).toBe('first');
      expect(await requested(1)).toBeNull();
      expect(await check(2, 200, 7)).toBe('first-listing');
      expect(await requested(2)).toEqual(t(7));
      expect(await check(3, 300, 8, t(6))).toBe('first-listing');
      expect(await requested(3)).toEqual(t(8));
      // The rank the check saw is stored.
      const [rank] = await db`
        SELECT solo_tier, solo_lp, solo_wins, rank_refreshed_at FROM players
        WHERE puuid = ${fakePuuid(1)}`;
      expect(rank).toEqual({
        solo_tier: 'MASTER',
        solo_lp: 10,
        solo_wins: 100,
        rank_refreshed_at: t(6),
      });
      expect(await getRankRefreshedAt(db, fakePuuid(1))).toEqual(t(6));
      expect(await getRankRefreshedAt(db, fakePuuid(4))).toBeNull();

      // The rotation: least recently checked first, nobody again before `checkedBefore`.
      expect(await toCheck(t(9))).toEqual([fakePuuid(1), fakePuuid(2), fakePuuid(3)]);
      expect(await toCheck(t(7))).toEqual([fakePuuid(1), fakePuuid(2)]);
      expect(await toCheck(t(9), 1)).toEqual([fakePuuid(1)]);
      // A failed check sends the player to the back, counter untouched.
      await deferOutsideMasterCheck(db, fakePuuid(1), t(9));
      expect(await toCheck(t(10))).toEqual([fakePuuid(2), fakePuuid(3), fakePuuid(1)]);

      // The counter did not move: only the time of the check. It moved: a listing is requested,
      // and the check is the snapshot of the new counter.
      expect(await check(1, 100, 10)).toBe('unchanged');
      expect(await requested(1)).toBeNull();
      expect(await getOutsideMasterSkipState(db, fakePuuid(1))).toEqual({
        gamesNow: 100,
        snapshotAt: t(6),
        listedGames: null,
        listedSnapshotAt: null,
        listedAt: null,
      });
      expect(await check(1, 102, 11)).toBe('played');
      expect(await requested(1)).toEqual(t(11));
      await setOutsideMasterBaseline(db, fakePuuid(1), {
        games: 102,
        snapshotAt: t(11),
        listedAt: t(12),
      });
      expect(await getOutsideMasterSkipState(db, fakePuuid(1))).toEqual({
        gamesNow: 102,
        snapshotAt: t(11),
        listedGames: 102,
        listedSnapshotAt: t(11),
        listedAt: t(12),
      });
      // Not one of them, or never checked: nothing to read.
      expect(await getOutsideMasterSkipState(db, fakePuuid(5))).toBeNull();

      // Waiting for a listing: oldest request first.
      expect(await outsideMastersToList(db, 'EUW1', 10)).toEqual([
        fakePuuid(2),
        fakePuuid(3),
        fakePuuid(1),
      ]);
      expect(await outsideMasterStats(db, 'EUW1', t(8))).toEqual({
        followed: 3,
        checkedSince: 2,
        neverChecked: 0,
        oldestCheckAt: t(7),
        toList: 3,
      });

      // No longer Master: out, with their listing request; their new rank is stored.
      const diamond = { tier: 'DIAMOND' as const, division: 1, lp: 80, wins: 201, losses: 0 };
      expect(
        await recordOutsideMasterCheck(db, fakePuuid(2), diamond, {
          now: t(13),
          listedSince: t(0),
        }),
      ).toBe('left');
      expect(await requested(2)).toBeNull();
      expect(await outsideMastersToList(db, 'EUW1', 10)).toEqual([fakePuuid(3), fakePuuid(1)]);
      const [left] =
        await db`SELECT solo_tier, solo_division FROM players WHERE puuid = ${fakePuuid(2)}`;
      expect(left).toEqual({ solo_tier: 'DIAMOND', solo_division: 1 });
      // Unranked: out as well.
      expect(
        await recordOutsideMasterCheck(db, fakePuuid(3), null, { now: t(13), listedSince: t(0) }),
      ).toBe('left');

      // Picked up by Riot's list: the ladder follows them, their row goes with the next sync and
      // a check that was on its way changes nothing. A player who left the ladder comes in.
      await upsertLadder(db, 'EUW1', [
        { puuid: fakePuuid(1), tier: 'MASTER', leaguePoints: 95, wins: 103, losses: 0 },
      ]);
      expect(await syncOutsideMasters(db, 'EUW1')).toEqual({ added: 1, removed: 1 });
      expect(await check(1, 110, 14)).toBe('gone');
      const [kept] = await db`SELECT solo_wins FROM players WHERE puuid = ${fakePuuid(1)}`;
      expect(kept).toEqual({ solo_wins: 103 });
      expect(await toCheck(t(15))).toEqual([fakePuuid(5)]);
      expect((await outsideMasterStats(db, 'EUW1', t(8))).neverChecked).toBe(1);
    });

    test('ranks of a Diamond page: stored for the players already known, only when something changed or the rank got old', async () => {
      const t = (hour: number) => new Date(Date.UTC(2026, 10, 13, hour));
      await db`
        INSERT INTO players (puuid, platform, solo_tier, solo_division, solo_lp, solo_wins,
                             solo_losses, rank_refreshed_at) VALUES
          (${fakePuuid(1)}, 'EUW1', NULL, NULL, NULL, NULL, NULL, NULL),
          (${fakePuuid(2)}, 'EUW1', 'DIAMOND', 2, 40, 10, 5, ${t(1)}),
          (${fakePuuid(3)}, 'EUW1', 'MASTER', NULL, 12, 30, 5, ${t(1)}),
          (${fakePuuid(4)}, 'EUW1', 'EMERALD', 1, 99, 30, 5, ${t(9)}),
          (${fakePuuid(5)}, 'EUW1', 'DIAMOND', 1, 10, 1, 1, ${t(1)}),
          (${fakePuuid(6)}, 'KR', 'DIAMOND', 1, 10, 1, 1, ${t(1)})`;
      // A tracked apex player a Diamond page still names: their ladder owns their rank.
      await upsertLadder(
        db,
        'EUW1',
        [{ puuid: fakePuuid(5), tier: 'MASTER', leaguePoints: 5, wins: 2, losses: 1 }],
        t(1),
      );
      const page = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        puuid: fakePuuid(n),
        division: 2,
        leaguePoints: 40,
        wins: 10,
        losses: 5,
      }));
      // Seen at 03:00; ranks refreshed before 02:00 are touched even when nothing changed.
      expect(await updateKnownPlayerRanks(db, 'EUW1', page, t(3), t(2))).toBe(3);
      const ranks = async () =>
        Object.fromEntries(
          (
            await db<{ puuid: string; solo_tier: string; d: number | null; at: Date }[]>`
              SELECT puuid, solo_tier, solo_division AS d, rank_refreshed_at AS at FROM players
              ORDER BY puuid`
          ).map((r) => [r.puuid, [r.solo_tier, r.d, r.at]]),
        );
      expect(await ranks()).toEqual({
        // Never ranked, and a Master who dropped: stored.
        [fakePuuid(1)]: ['DIAMOND', 2, t(3)],
        [fakePuuid(3)]: ['DIAMOND', 2, t(3)],
        // Same rank, refreshed before `touchBefore`: only the time moves.
        [fakePuuid(2)]: ['DIAMOND', 2, t(3)],
        // A rank refreshed after the page was read stays.
        [fakePuuid(4)]: ['EMERALD', 1, t(9)],
        // The apex ladder's, another platform's, and a player who is not stored (not created).
        [fakePuuid(5)]: ['MASTER', null, t(1)],
        [fakePuuid(6)]: ['DIAMOND', 1, t(1)],
      });
      // An hour later nothing changed and every rank is recent: nothing is written.
      expect(await updateKnownPlayerRanks(db, 'EUW1', page, t(4), t(2))).toBe(0);
      // A player who played since: written.
      const played = page.map((e) => (e.puuid === fakePuuid(2) ? { ...e, wins: 11 } : e));
      expect(await updateKnownPlayerRanks(db, 'EUW1', played, t(5), t(2))).toBe(1);
      expect(await updateKnownPlayerRanks(db, 'EUW1', [], t(5), t(2))).toBe(0);
    });
  });
});
