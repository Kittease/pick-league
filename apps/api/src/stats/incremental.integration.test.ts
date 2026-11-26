/**
 * The incremental stats tables (0030_incremental_stats.sql) against a full recomputation.
 *
 * Two databases get the same matches and the same changes: the reference stops at migration 0029,
 * where every stats view is a materialized view recomputed from all the matches, and is refreshed
 * view by view as the API did then; the other is refreshed by `refreshStats`. After every step
 * each stats relation must hold the same rows in both. A migration that changes what a view holds
 * on purpose has to move the reference (`REFERENCE_BEFORE`) with it, or compare what the old view
 * held (`stats_side_wins`, per platform since 0034, is summed over the platforms;
 * `stats_champion_mastery`, pre-game masteries only since 0035, is the query of 0035 on the
 * reference's tables).
 * Needs DATABASE_URL_TEST; uses its own two databases.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  type Db,
  deleteOldPatches,
  listMigrationFiles,
  migrate,
  upsertPatchStaticData,
} from '@pick-league/db';
import { resetApiTestDb, seedSyntheticPatch, withDatabase } from '../testing/seed.ts';
import { syntheticStaticData } from '../testing/synthetic.ts';
import { refreshStats, STATS_INCREMENTAL_TABLES, STATS_REFRESH_LOCK_KEY } from './refresh.ts';

const BASE = process.env.DATABASE_URL_TEST;
const URL_ = BASE ? withDatabase(BASE, 'pickleague_api_incremental_test') : undefined;
const REFERENCE_URL = BASE ? withDatabase(BASE, 'pickleague_api_incremental_ref') : undefined;

/** The reference applies the migrations before this one. */
const REFERENCE_BEFORE = '0030';

/** The refresh of the reference: every materialized view of 0029, dependencies first. */
const REFERENCE_VIEWS = [
  'stats_champion_traits',
  'stats_team_comp',
  'stats_comp_thresholds',
  'stats_participants',
  'stats_quest_items',
  'stats_champion_roles',
  'stats_champion_vs',
  'stats_champion_with',
  'stats_champion_comp_traits',
  'stats_choices',
  'stats_choice_matchups',
  'stats_choice_traits',
  'stats_choice_duos',
  'stats_choice_ally_traits',
  'stats_champion_lane_phase',
  'stats_patch_matches',
  'stats_champion_bans',
  'stats_side_wins',
  'stats_champion_mastery',
  'stats_tierlist_participants',
  'stats_champion_game_length',
  'stats_item_swaps',
  'stats_tierlist_roles',
  'stats_tierlist_vs',
  'stats_tierlist_with',
  'stats_tierlist_bans',
  'stats_tierlist_totals',
];

/**
 * What is compared: every view the API serves and the intermediate ones both layouts have.
 * stats_participants had its composition traits as columns: stats_participant_traits has the
 * same columns now.
 */
const COMPARED: Record<string, { reference: string; current: string }> = {
  ...Object.fromEntries(
    REFERENCE_VIEWS.filter((v) => v !== 'stats_participants').map((v) => [
      v,
      { reference: v, current: v },
    ]),
  ),
  stats_participants: { reference: 'stats_participants', current: 'stats_participant_traits' },
  // Per platform since 0034: summed over the platforms, the rows of 0016.
  stats_side_wins: {
    reference: 'stats_side_wins',
    current: `(SELECT patch, team_id, sum(games)::int AS games, sum(wins)::int AS wins
               FROM stats_side_wins GROUP BY patch, team_id)`,
  },
  // Masteries fetched before the game only since 0035: the reference's view counts every row,
  // so its side is the query of 0035 on its tables.
  stats_champion_mastery: {
    reference: `(SELECT m.patch, p.position, p.champion_id,
                        width_bucket(cm.points, ARRAY[5000, 20000, 50000, 100000, 200000, 500000])
                          ::smallint AS bucket,
                        count(*)::int AS games, count(*) FILTER (WHERE p.win)::int AS wins
                 FROM participants p
                 JOIN matches m ON m.id = p.match_id
                 JOIN champion_masteries cm
                   ON cm.puuid = p.puuid AND cm.champion_id = p.champion_id
                 WHERE NOT m.is_remake AND p.position IS NOT NULL
                   AND cm.last_played_at < m.started_at
                 GROUP BY 1, 2, 3, 4)`,
    current: 'stats_champion_mastery',
  },
};

type Checksums = Record<string, { rows: number; checksum: string }>;

async function checksums(db: Db, side: 'reference' | 'current'): Promise<Checksums> {
  const out: Checksums = {};
  for (const [name, source] of Object.entries(COMPARED)) {
    const [row] = await db.unsafe<{ rows: number; checksum: string }[]>(
      `SELECT count(*)::int AS rows,
              COALESCE(sum(hashtextextended(v::text, 0)), 0)::text AS checksum
       FROM ${source[side]} v`,
    );
    if (row) out[name] = { rows: row.rows, checksum: row.checksum };
  }
  return out;
}

/** The incremental tables themselves, to compare two states of the same database. */
async function tableChecksums(db: Db): Promise<Checksums> {
  const out: Checksums = {};
  for (const table of STATS_INCREMENTAL_TABLES) {
    const [row] = await db.unsafe<{ rows: number; checksum: string }[]>(
      `SELECT count(*)::int AS rows,
              COALESCE(sum(hashtextextended(t::text, 0)), 0)::text AS checksum
       FROM ${table} t`,
    );
    if (row) out[table] = { rows: row.rows, checksum: row.checksum };
  }
  return out;
}

describe.skipIf(!URL_)('incremental stats tables vs a full recomputation (Postgres)', () => {
  let db: Db;
  let reference: Db;
  let batch = 0;

  const both = async (change: (target: Db) => Promise<unknown>) => {
    await change(reference);
    await change(db);
  };

  /**
   * Adds matches to both databases, with what the generator never produces: participants without
   * a position, two players on one position, participants without events, a quest upgrade sold
   * before the end, players of every rank.
   */
  const addMatches = async (patch: string, count: number) => {
    const idPrefix = `SYN_INC_${++batch}`;
    const like = `${idPrefix}\\_%`;
    await both(async (target) => {
      await seedSyntheticPatch(target, { patch, count, seed: 500 + batch, idPrefix });
      await target`
        UPDATE participants SET position = NULL
        WHERE match_id LIKE ${like} AND abs(hashtext(match_id || participant_id)) % 25 = 0`;
      await target`
        UPDATE participants SET position = 'BOTTOM'
        WHERE match_id LIKE ${like} AND position = 'UTILITY'
          AND abs(hashtext('two' || match_id || participant_id)) % 20 = 0`;
      await target`
        DELETE FROM participant_events
        WHERE match_id LIKE ${like} AND abs(hashtext('none' || match_id || participant_id)) % 40 = 0`;
      await target`
        UPDATE participant_events pe SET
          item_types = pe.item_types || ARRAY['P', 'S']::"char"[],
          item_ids = pe.item_ids || ARRAY[p.final_items[1], p.final_items[1]],
          item_at_ms = pe.item_at_ms || ARRAY[1250000, 1300000]
        FROM participants p
        WHERE p.match_id = pe.match_id AND p.participant_id = pe.participant_id
          AND pe.match_id LIKE ${like} AND p.position = 'UTILITY'
          AND abs(hashtext('sold' || pe.match_id || pe.participant_id)) % 5 = 0`;
      await target`
        UPDATE participants p SET final_items = array_replace(p.final_items, p.final_items[1], 0)
        WHERE p.match_id LIKE ${like} AND p.position = 'UTILITY'
          AND abs(hashtext('sold' || p.match_id || p.participant_id)) % 5 = 0`;
      await target`
        UPDATE players SET solo_tier = (ARRAY['CHALLENGER', 'GRANDMASTER', 'MASTER', 'DIAMOND', NULL])[
          1 + abs(hashtext(puuid)) % 5]::solo_tier
        WHERE puuid LIKE ${`synthetic-puuid-${like}`}`;
      await target`
        INSERT INTO champion_masteries (puuid, champion_id, level, points, last_played_at)
        SELECT p.puuid, p.champion_id, 5, abs(hashtext('points' || p.puuid)) % 700000,
               -- Half fetched before the games (counted by the mastery view), half after.
               CASE WHEN abs(hashtext('before' || p.puuid)) % 2 = 0
                    THEN timestamptz '2020-01-01' ELSE now() END
        FROM participants p
        WHERE p.match_id LIKE ${like} AND abs(hashtext('mastery' || p.puuid)) % 2 = 0`;
    });
    return like;
  };

  const refreshReference = async () => {
    for (const view of REFERENCE_VIEWS) {
      await reference.unsafe(`REFRESH MATERIALIZED VIEW ${view}`);
    }
  };

  /** Refreshes both, and expects every compared relation to hold the same rows. */
  const refreshAndCompare = async (options: Parameters<typeof refreshStats>[1] = {}) => {
    const [result] = await Promise.all([
      refreshStats(db, { force: true, ...options }),
      refreshReference(),
    ]);
    const [current, expected] = await Promise.all([
      checksums(db, 'current'),
      checksums(reference, 'reference'),
    ]);
    expect(current).toEqual(expected);
    return result;
  };

  beforeAll(async () => {
    await resetApiTestDb(URL_);
    db = createDb(URL_ as string, { max: 8 });

    // The reference: the same server, migrated up to 0029.
    await resetApiTestDb(REFERENCE_URL);
    reference = createDb(REFERENCE_URL as string, { max: 8 });
    const before = await mkdtemp(join(tmpdir(), 'pickleague-reference-'));
    try {
      for (const f of await listMigrationFiles()) {
        if (f.version < REFERENCE_BEFORE) await copyFile(f.path, join(before, f.name));
      }
      await reference.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await migrate(reference, { dir: before });
    } finally {
      await rm(before, { recursive: true, force: true });
    }

    await addMatches('15.21', 90);
    await addMatches('15.22', 130);
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await reference?.end();
  });

  test('the first refresh computes every match, and the compared relations are not trivial', async () => {
    const result = await refreshAndCompare();
    expect(result.matchesComputed).toBe(220);
    expect(result.matchesRecomputed).toBe(0);
    for (const table of STATS_INCREMENTAL_TABLES) expect(result.views).toHaveProperty(table);

    const sums = await checksums(db, 'current');
    for (const [name, sum] of Object.entries(sums)) {
      expect(`${name}: ${sum.rows > 0}`).toBe(`${name}: true`);
    }
    // Remakes are recorded as computed and have no row; every other match has its participants.
    const [counts] = await db<{ marked: number; remakes: number; with_rows: number }[]>`
      SELECT (SELECT count(*)::int FROM stats_matches) AS marked,
             (SELECT count(*)::int FROM matches WHERE is_remake) AS remakes,
             (SELECT count(DISTINCT match_id)::int FROM stats_participants) AS with_rows`;
    expect(counts?.marked).toBe(220);
    expect(counts?.with_rows).toBe(220 - (counts?.remakes ?? 0));
  }, 120_000);

  test('new matches are added to the tables, a few per call or all at once', async () => {
    await addMatches('15.22', 40);
    const tablesBefore = await tableChecksums(db);
    const some = await refreshAndCompare({ batchMatches: 15 });
    expect(some.matchesComputed).toBe(40);
    // Rows were added: none of the rows of the matches already there was touched.
    const [kept] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stats_participants WHERE match_id NOT LIKE ${'SYN_INC_3\\_%'}`;
    expect(kept?.n).toBe(tablesBefore.stats_participants?.rows);

    await addMatches('15.21', 25);
    await addMatches('15.22', 35);
    expect((await refreshAndCompare()).matchesComputed).toBe(60);
  }, 120_000);

  test('the composition traits follow the thresholds of the patch', async () => {
    // Matches of one composition only move the percentiles the traits are compared with: the
    // traits of the teams already there change, with no change to their own rows.
    const thresholds = async () =>
      (await db`SELECT * FROM stats_comp_thresholds ORDER BY patch`).map((r) => ({ ...r }));
    const traits = async () =>
      (
        await db<{ checksum: string }[]>`
          SELECT sum(hashtextextended(t::text, 0))::text AS checksum
          FROM stats_participant_traits t WHERE t.match_id LIKE ${'SYN_INC_1\\_%'}`
      )[0]?.checksum;
    const [thresholdsBefore, traitsBefore, tablesBefore] = [
      await thresholds(),
      await traits(),
      await tableChecksums(db),
    ];
    const idPrefix = `SYN_INC_${++batch}`;
    await both((target) =>
      seedSyntheticPatch(target, {
        patch: '15.21',
        count: 60,
        seed: 900,
        idPrefix,
        // Tanks and enchanters only, as far as the pool allows.
        pickWeights: { 54: 50, 516: 50, 32: 50, 113: 50, 16: 50, 40: 50, 267: 50, 117: 50 },
      }),
    );
    await refreshAndCompare();
    expect(await thresholds()).not.toEqual(thresholdsBefore);
    expect(await traits()).not.toBe(traitsBefore);
    const [rowsOfFirstBatch] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stats_participants`;
    expect(rowsOfFirstBatch?.n).toBeGreaterThan(tablesBefore.stats_participants?.rows ?? 0);
  }, 120_000);

  test('a rank that changes without any new match moves the tier list segments', async () => {
    await both(
      (target) => target`
        UPDATE players SET solo_tier = (CASE WHEN solo_tier = 'CHALLENGER' THEN 'MASTER'
                                             WHEN solo_tier IS NULL THEN 'GRANDMASTER'
                                             ELSE 'CHALLENGER' END)::solo_tier
        WHERE abs(hashtext('rank' || puuid)) % 4 = 0`,
    );
    const roles = async () =>
      (
        await db<{ checksum: string }[]>`
          SELECT sum(hashtextextended(t::text, 0))::text AS checksum FROM stats_tierlist_roles t`
      )[0]?.checksum;
    const before = await roles();
    expect((await refreshAndCompare()).matchesComputed).toBe(0);
    expect(await roles()).not.toBe(before);
  }, 120_000);

  test('items imported again: the matches of that patch are computed again, only if a flag changed', async () => {
    // A new Data Dragon version of 15.22 with the same items: nothing to do.
    await both((target) => upsertPatchStaticData(target, syntheticStaticData('15.22', '15.22.2')));
    const same = await refreshAndCompare();
    expect(same.matchesRecomputed).toBe(0);
    expect(same.matchesComputed).toBe(0);

    // Another one where a completed item is a component, a pair of boots is no longer boots, an
    // item is gone and a quest upgrade builds into something: builds, quest items and swaps of
    // 15.22 change, 15.21 is left alone.
    const [onPatch] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM matches WHERE patch = '15.22'`;
    const changed = syntheticStaticData('15.22', '15.22.3');
    const completed = changed.items.filter((i) => i.isCompleted && !i.isBoots);
    const boots = changed.items.filter((i) => i.isCompleted && i.isBoots);
    const upgrade = changed.items.find((i) => i.id === 3876);
    if (!completed[0] || !completed[1] || !boots[0] || !upgrade) throw new Error('synthetic items');
    completed[0].isCompleted = false;
    boots[0].isBoots = false;
    upgrade.buildsInto = [1];
    changed.items.splice(changed.items.indexOf(completed[1]), 1);
    const tablesBefore = await tableChecksums(db);
    await both((target) => upsertPatchStaticData(target, changed));
    const result = await refreshAndCompare();
    expect(result.matchesRecomputed).toBe(onPatch?.n ?? -1);
    expect(result.matchesComputed).toBe(onPatch?.n ?? -1);
    const tablesAfter = await tableChecksums(db);
    expect(tablesAfter.stats_matches).toEqual(tablesBefore.stats_matches);
    expect(tablesAfter.stats_participants?.checksum).not.toBe(
      tablesBefore.stats_participants?.checksum,
    );
    expect(tablesAfter.stats_quest_items?.rows).toBeLessThan(
      tablesBefore.stats_quest_items?.rows ?? 0,
    );

    // Back to the first items, with new matches in the same refresh.
    await both((target) => upsertPatchStaticData(target, syntheticStaticData('15.22', '15.22.4')));
    await addMatches('15.22', 20);
    const back = await refreshAndCompare();
    expect(back.matchesRecomputed).toBe(onPatch?.n ?? -1);
    expect(back.matchesComputed).toBe((onPatch?.n ?? 0) + 20);
    expect((await tableChecksums(db)).stats_quest_items?.rows).toBeGreaterThan(
      tablesAfter.stats_quest_items?.rows ?? 0,
    );
  }, 180_000);

  test('a refresh that fails keeps what it had computed and the next one goes on', async () => {
    await addMatches('15.22', 30);
    const failure = await refreshStats(db, {
      force: true,
      batchMatches: 10,
      views: [{ incremental: true }, { view: 'stats_no_such_view', concurrent: false }],
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    const [pending] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM matches m
      WHERE NOT EXISTS (SELECT 1 FROM stats_matches s WHERE s.match_id = m.id)`;
    expect(pending?.n).toBe(0);
    // The tables were complete, the views were not refreshed: the next refresh only has those.
    expect((await refreshAndCompare()).matchesComputed).toBe(0);

    // A call of the function that fails leaves nothing behind (one transaction per call).
    await addMatches('15.22', 30);
    const timedOut = await refreshStats(db, { force: true, statementTimeout: '1ms' }).catch(
      (err: unknown) => err,
    );
    expect((timedOut as Error).message).toContain('statement timeout');
    const [left] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM matches m
      WHERE NOT EXISTS (SELECT 1 FROM stats_matches s WHERE s.match_id = m.id)`;
    expect(left?.n).toBe(30);
    expect((await refreshAndCompare()).matchesComputed).toBe(30);
  }, 120_000);

  test('a match deleted while the tables are filled leaves no row behind', async () => {
    const like = await addMatches('15.22', 6);
    const ids = (
      await db<{ id: string }[]>`
      SELECT id FROM matches WHERE id LIKE ${like} AND NOT is_remake ORDER BY id`
    ).map((r) => r.id);
    const [beingDeleted, deletedDuring] = ids;
    if (!beingDeleted || !deletedDuring) throw new Error('six new matches');
    const rowsOf = async (matchId: string) =>
      (
        await db<{ n: number }[]>`
          SELECT ((SELECT count(*) FROM stats_matches WHERE match_id = ${matchId})
                + (SELECT count(*) FROM stats_participants WHERE match_id = ${matchId})
                + (SELECT count(*) FROM stats_quest_items WHERE match_id = ${matchId})
                + (SELECT count(*) FROM stats_lanes WHERE match_id = ${matchId})
                + (SELECT count(*) FROM stats_participant_swaps WHERE match_id = ${matchId})
                 )::int AS n`
      )[0]?.n;

    const deleter = await db.reserve();
    const filler = await db.reserve();
    try {
      // A deletion in progress: the call does not wait for it, it leaves that match alone.
      await deleter.unsafe('BEGIN');
      await deleter`DELETE FROM matches WHERE id = ${beingDeleted}`;
      await filler.unsafe('BEGIN');
      const steps = await filler<{ step: string; row_count: string }[]>`
        SELECT step, row_count FROM pl_stats_fill(1000)`;
      expect(Number(steps.find((s) => s.step === 'stats_matches')?.row_count)).toBe(5);

      // A match the call took cannot be deleted before the call commits; the deletion then
      // takes the rows that were just computed.
      let deleted = false;
      const deletion = db`DELETE FROM matches WHERE id = ${deletedDuring}`.then(() => {
        deleted = true;
      });
      await Bun.sleep(300);
      expect(deleted).toBe(false);
      await filler.unsafe('COMMIT');
      await deletion;
      expect(await rowsOf(deletedDuring)).toBe(0);

      // The first deletion is given up: its match is still to compute.
      await deleter.unsafe('ROLLBACK');
      expect(await rowsOf(beingDeleted)).toBe(0);
    } finally {
      await deleter.unsafe('ROLLBACK').catch(() => {});
      await filler.unsafe('ROLLBACK').catch(() => {});
      deleter.release();
      filler.release();
    }
    await reference`DELETE FROM matches WHERE id = ${deletedDuring}`;
    expect((await refreshAndCompare()).matchesComputed).toBe(1);
    expect(await rowsOf(beingDeleted)).toBeGreaterThan(5);
  }, 120_000);

  test('deleting a patch deletes the rows of its matches', async () => {
    await both((target) => upsertPatchStaticData(target, syntheticStaticData('15.23')));
    await addMatches('15.23', 50);
    await refreshAndCompare();
    const [before] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stats_participants WHERE patch = '15.21'`;
    expect(before?.n).toBeGreaterThan(0);

    // The worker's cleanup: the two newest patches are kept.
    await both(async (target) =>
      expect((await deleteOldPatches(target, 2)).deletedPatches).toEqual(['15.21']),
    );
    const [after] = await db<Record<string, number>[]>`
      SELECT (SELECT count(*)::int FROM matches) AS matches,
             (SELECT count(*)::int FROM stats_matches) AS marked,
             (SELECT count(*)::int FROM stats_participants WHERE patch = '15.21') AS participants,
             (SELECT count(*)::int FROM stats_lanes WHERE patch = '15.21') AS lanes,
             (SELECT count(*)::int FROM stats_participant_swaps WHERE patch = '15.21') AS swaps,
             (SELECT count(*)::int FROM stats_quest_items q
              WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = q.match_id)) AS quest_items,
             (SELECT count(*)::int FROM stats_patch_items WHERE patch = '15.21') AS signatures`;
    expect(after).toEqual({
      matches: after?.marked ?? -1,
      marked: after?.matches ?? -1,
      participants: 0,
      lanes: 0,
      swaps: 0,
      quest_items: 0,
      signatures: 0,
    });
    expect((await refreshAndCompare()).matchesComputed).toBe(0);
  }, 120_000);

  test('a forced rebuild computes the same tables and the same views', async () => {
    const tablesBefore = await tableChecksums(db);
    const viewsBefore = await checksums(db, 'current');
    const [stored] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM matches`;

    const result = await refreshAndCompare({ rebuild: true, force: false, batchMatches: 70 });
    expect(result.reason).toBe('refreshed');
    expect(result.matchesComputed).toBe(stored?.n ?? -1);
    expect(await tableChecksums(db)).toEqual(tablesBefore);
    expect(await checksums(db, 'current')).toEqual(viewsBefore);
  }, 180_000);

  test('migrations that empty the tables take the same lock as the refresh', async () => {
    // 0030_incremental_stats.sql waits for a refresh in progress with this key.
    const [migration] = (await listMigrationFiles()).filter((f) => f.version === '0030');
    const sql = await Bun.file(migration?.path ?? '').text();
    expect(sql).toContain(`pg_advisory_xact_lock(${STATS_REFRESH_LOCK_KEY})`);
  });
});
