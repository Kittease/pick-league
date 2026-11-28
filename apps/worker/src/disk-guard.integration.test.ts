/**
 * Disk guard against a real Postgres: the oldest games of the previous patch make room for the
 * newest ones once the disk is low. Needs DATABASE_URL_TEST.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type Db, migrate, upsertPatchStaticData } from '@pick-league/db';
import type { StaticPatchData } from '@pick-league/shared';
import { DiskGuard } from './disk-guard.ts';

const URL = process.env.DATABASE_URL_TEST;
const d = URL ? describe : describe.skip;
const GB = 2 ** 30;
const T0 = Date.UTC(2026, 10, 1);

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

d('DiskGuard (Postgres)', () => {
  let db: Db;
  let free = 50 * GB;
  let next = 0;
  const patches = { previous: '15.21' as string | null };

  /** `n` matches of `patch`, each started an hour after the one before. */
  const store = async (patch: string, n: number) => {
    for (let i = 0; i < n; i++, next++) {
      await db`
        INSERT INTO matches (id, platform, patch, game_version, queue_id, started_at, duration_s,
                             is_remake, is_early_surrender, winning_team)
        VALUES (${`EUW1_${7000000000 + next}`}, 'EUW1', ${patch}, ${`${patch}.1.1`}, 420,
                ${new Date(T0 + next * 3_600_000)}, 1800, false, false, 100)`;
    }
  };
  const ids = async (patch: string) =>
    (
      await db<{ id: string }[]>`SELECT id FROM matches WHERE patch = ${patch} ORDER BY started_at`
    ).map((r) => Number(r.id.slice(5)) - 7000000000);
  const guard = () => new DiskGuard(db, patches, () => free, undefined, { batchSize: 2 });

  beforeEach(async () => {
    await db?.end();
    db = createDb(URL as string, { max: 4 });
    await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await upsertPatchStaticData(db, staticPatch('15.21'));
    await upsertPatchStaticData(db, staticPatch('15.22'));
    free = 50 * GB;
    next = 0;
    patches.previous = '15.21';
  });

  afterAll(async () => {
    await db?.end();
  });

  test('plenty of room: nothing is touched', async () => {
    await store('15.21', 3);
    expect(await guard().tick()).toEqual({ freeBytes: 50 * GB, cap: null, deleted: 0 });
    expect(await ids('15.21')).toEqual([0, 1, 2]);
  });

  test('disk low: the stored matches stop growing, each new one replaces the oldest of the previous patch', async () => {
    await store('15.21', 4);
    await store('15.22', 2);
    const g = guard();
    free = 19 * GB;
    expect(await g.tick()).toMatchObject({ cap: 6, deleted: 0 });
    // Three new matches of the latest patch: the three oldest of the previous one leave.
    await store('15.22', 3);
    expect(await g.tick()).toMatchObject({ cap: 6, deleted: 3 });
    expect(await ids('15.21')).toEqual([3]);
    expect(await ids('15.22')).toEqual([4, 5, 6, 7, 8]);
    // Between the two thresholds it stays frozen; over the upper one the matches may grow again.
    free = 25 * GB;
    await store('15.22', 1);
    expect(await g.tick()).toMatchObject({ cap: 6, deleted: 1 });
    free = 31 * GB;
    await store('15.22', 1);
    expect(await g.tick()).toEqual({ freeBytes: 31 * GB, cap: null, deleted: 0 });
    expect(await ids('15.22')).toHaveLength(7);
  });

  test('the latest patch is never trimmed: with nothing of the previous one left, nothing is deleted', async () => {
    await store('15.21', 1);
    await store('15.22', 2);
    const g = guard();
    free = 15 * GB;
    await g.tick();
    await store('15.22', 3);
    expect(await g.tick()).toMatchObject({ cap: 3, deleted: 1 });
    expect(await ids('15.21')).toEqual([]);
    expect(await ids('15.22')).toHaveLength(5);
    patches.previous = null;
    expect(await g.tick()).toMatchObject({ deleted: 0 });
  });

  test('still short at two checks in a row: the frozen number is lowered', async () => {
    await store('15.21', 20);
    await store('15.22', 20);
    const g = guard();
    free = 9 * GB;
    expect(await g.tick()).toMatchObject({ cap: 40, deleted: 0 });
    // One critical check could be a refresh's temporary files: wait for the next one.
    expect(await g.tick()).toMatchObject({ cap: 38, deleted: 2 });
    expect(await ids('15.21')).toHaveLength(18);
  });
});
