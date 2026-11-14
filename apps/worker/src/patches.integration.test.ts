import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type Db, listPatches, migrate, upsertPatchStaticData } from '@pick-league/db';
import type { PatchVersion, StaticPatchData } from '@pick-league/shared';
import { PatchTracker } from './patches.ts';

const URL = process.env.DATABASE_URL_TEST;
const d = URL ? describe : describe.skip;

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

class FakeDdragon {
  versions: PatchVersion[] = [];
  async getLatestPatchVersions(count = 2) {
    return this.versions.slice(0, count);
  }
  async getStaticPatchData(version: string) {
    return staticPatch(version.split('.').slice(0, 2).join('.'));
  }
}

const patchIds = async (db: Db) => (await listPatches(db)).map((p) => p.id);

d('PatchTracker (Postgres)', () => {
  let db: Db;
  let ddragon: FakeDdragon;

  beforeEach(async () => {
    await db?.end();
    db = createDb(URL as string, { max: 4 });
    await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await upsertPatchStaticData(db, staticPatch('15.21'));
    await upsertPatchStaticData(db, staticPatch('15.22'));
    ddragon = new FakeDdragon();
    ddragon.versions = [
      { patch: '15.22', ddragonVersion: '15.22.1' },
      { patch: '15.21', ddragonVersion: '15.21.1' },
    ];
  });

  afterAll(async () => {
    await db?.end();
  });

  test('a new patch is collected even when deleting the old one fails, and cleanup is retried', async () => {
    const tracker = new PatchTracker(db, ddragon);
    await tracker.refresh();
    expect([tracker.latest, tracker.generation]).toEqual(['15.22', 1]);

    // Deleting a patch fails (e.g. a lock timeout during a busy insert).
    await db.unsafe(`
      CREATE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'cleanup blocked'; END $$;
      CREATE TRIGGER fail_delete BEFORE DELETE ON patches FOR EACH ROW EXECUTE FUNCTION fail_delete();`);
    ddragon.versions.unshift({ patch: '15.23', ddragonVersion: '15.23.1' });
    await tracker.refresh();
    expect([tracker.latest, tracker.previous, tracker.generation]).toEqual(['15.23', '15.22', 2]);
    expect(tracker.classify('15.22')).toBe('old');
    expect(await patchIds(db)).toEqual(['15.23', '15.22', '15.21']);

    await db.unsafe('DROP TRIGGER fail_delete ON patches');
    await tracker.refresh();
    expect(await patchIds(db)).toEqual(['15.23', '15.22']);
    expect(tracker.generation).toBe(2);
  });
});
