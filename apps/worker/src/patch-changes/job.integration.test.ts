import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  getPatchChanges,
  listPatchChangeSets,
  migrate,
  newestGameBuildSnapshot,
} from '@pick-league/db';
import type { DdragonChampionFile, DdragonItemFile } from '@pick-league/shared';
import { type CdragonClient, parseContentVersion } from './cdragon.ts';
import { decodeSnapshot, PatchChangesJob } from './job.ts';

const DB_URL = process.env.DATABASE_URL_TEST;
const d = DB_URL ? describe : describe.skip;

const fixture = (patch: string, name: string): Promise<unknown> =>
  Bun.file(new URL(`./fixtures/${patch}/${name}.bin.json`, import.meta.url)).json();

const CHAMPIONS = [
  { id: 'Ezreal', key: '81', name: 'Ezreal' },
  { id: 'Azir', key: '268', name: 'Azir' },
  { id: 'Yorick', key: '83', name: 'Yorick' },
  { id: 'Sona', key: '37', name: 'Sona' },
  { id: 'Jayce', key: '126', name: 'Jayce' },
  // In 16.23 only: a new champion (its file is a copy of Azir's).
  { id: 'Fakenew', key: '999', name: 'Fake Newcomer' },
];

function championFull(): DdragonChampionFile {
  const data: DdragonChampionFile['data'] = {};
  for (const c of CHAMPIONS) {
    data[c.id] = {
      ...c,
      tags: ['Mage'],
      info: { attack: 1, defense: 1, magic: 1, difficulty: 1 },
      stats: { attackrange: 550 },
      image: { full: `${c.id}.png` },
      spells: [],
    } as unknown as DdragonChampionFile['data'][string];
  }
  return { data } as DdragonChampionFile;
}

function itemFile(): DdragonItemFile {
  const item = (name: string) => ({
    name,
    gold: { total: 3000, base: 900, purchasable: true, sell: 2000 },
    tags: ['Damage'],
    maps: { '11': true },
    stats: {},
    image: { full: 'x.png' },
  });
  return {
    data: {
      '6699': item('Voltaic Cyclosword'),
      '4015': item('Perplexity'),
      '1001': item('Boots'),
    },
  } as unknown as DdragonItemFile;
}

const ddragon = {
  getVersions: async () => ['16.23.1', '16.22.1', '16.21.1'],
  getChampionFull: async () => championFull(),
  getItems: async () => itemFile(),
};

/** Serves the fixtures as Community Dragon folders; tests override files and builds. */
class FakeCdragon implements CdragonClient {
  versions: Record<string, string> = {
    '16.22': '16.22.8348910+branch.releases-16-22.content.release',
    '16.23': '16.23.8418428+branch.releases-16-23.content.release',
    latest: '16.23.8418428+branch.releases-16-23.content.release',
  };
  overrides = new Map<string, unknown>();
  fail = false;
  fetched: string[] = [];

  async contentVersion(folder: string) {
    const v = this.versions[folder];
    return v ? parseContentVersion(v) : null;
  }
  async championFile(folder: string, alias: string) {
    if (this.fail) throw new Error('network down');
    this.fetched.push(`${folder}/${alias}`);
    const key = `${folder}/${alias}`;
    if (this.overrides.has(key)) return this.overrides.get(key);
    if (alias === 'fakenew') return folder === '16.23' ? fixture('16.23', 'azir') : null;
    return fixture(folder, alias);
  }
  async itemsFile(folder: string) {
    return fixture(folder, 'items.cdtb');
  }
}

d('PatchChangesJob (Postgres)', () => {
  let db: Db;
  let cdragon: FakeCdragon;
  let job: PatchChangesJob;

  beforeEach(async () => {
    db = db ?? createDb(DB_URL as string, { max: 4 });
    await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    cdragon = new FakeCdragon();
    job = new PatchChangesJob(db, cdragon, ddragon, { concurrency: 2 });
  });
  afterAll(async () => {
    await db?.end();
  });

  const rowsOf = async (build: string) => {
    const set = (await listPatchChangeSets(db)).find((s) => s.build === build);
    if (!set) throw new Error(`no set for ${build}`);
    return (await getPatchChanges(db, set.id)).map((r) => [r.name, r.status, r.valueName]);
  };

  test('the first build of a patch is diffed against the previous patch, read from its folder', async () => {
    expect(await job.checkLatest()).toBe('stored');
    const sets = await listPatchChangeSets(db);
    expect(sets.map((s) => [s.build, s.kind, s.source, s.baseBuild])).toEqual([
      ['16.23.8418428', 'patch', 'live', '16.22.8348910'],
    ]);
    expect(sets[0]).toMatchObject({ changedChampions: 3, changedItems: 2 });
    expect(await rowsOf('16.23.8418428')).toEqual([
      ['Azir', 'changed', 'attackRange'],
      ['Ezreal', 'changed', 'APRatio'],
      ['Ezreal', 'changed', 'bonusAdRatio'],
      ['Ezreal', 'changed', 'BaseDamage'],
      ['Ezreal', 'changed', 'RAPRatio'],
      ['Ezreal', 'changed', 'bonusAdRatio'],
      ['Fake Newcomer', 'new', null],
      ['Perplexity', 'changed', 'percentBaseMPRegenMod'],
      ['Voltaic Cyclosword', 'changed', 'PercentCurrentHPMelee'],
      ['Voltaic Cyclosword', 'changed', 'PercentCurrentHPRanged'],
    ]);
    // Both builds keep their snapshot (newest of the 2 newest patches).
    const snap = await newestGameBuildSnapshot(db, '16.23');
    expect(Object.keys(decodeSnapshot(snap?.snapshot as Uint8Array)?.champions ?? {})).toHaveLength(
      6,
    );
    expect(await newestGameBuildSnapshot(db, '16.22')).not.toBeNull();

    cdragon.fetched = [];
    expect(await job.checkLatest()).toBe('known');
    expect(cdragon.fetched).toEqual([]);
  });

  test('a later build is a hotfix diff against the build before, stored even when empty', async () => {
    await job.checkLatest();
    const azir = (await fixture('16.23', 'azir')) as Record<string, Record<string, unknown>>;
    const root = azir['Characters/Azir/CharacterRecords/Root'] as Record<string, unknown>;
    root.attackRangeModifiable = { baseValue: 575, __type: 'ModifiableFloat' };
    cdragon.overrides.set('16.23/azir', azir);
    cdragon.versions['16.23'] = '16.23.8500000+branch.releases-16-23.content.release';
    cdragon.versions.latest = cdragon.versions['16.23'];
    expect(await job.checkLatest()).toBe('stored');

    cdragon.versions['16.23'] = '16.23.8600000+branch.releases-16-23.content.release';
    cdragon.versions.latest = cdragon.versions['16.23'];
    expect(await job.checkLatest()).toBe('stored');

    const sets = await listPatchChangeSets(db);
    expect(sets.map((s) => [s.build, s.kind, s.baseBuild, s.changedChampions])).toEqual([
      ['16.23.8418428', 'patch', '16.22.8348910', 3],
      ['16.23.8500000', 'hotfix', '16.23.8418428', 1],
      ['16.23.8600000', 'hotfix', '16.23.8500000', 0],
    ]);
    expect(await rowsOf('16.23.8500000')).toEqual([['Azir', 'changed', 'attackRange']]);
  });

  test('waits while the patch folder or Data Dragon is behind', async () => {
    cdragon.versions.latest = '16.24.8500000+branch.releases-16-24.content.release';
    expect(await job.checkLatest()).toBe('waiting'); // no 16.24 folder
    cdragon.versions['16.24'] = cdragon.versions.latest;
    expect(await job.checkLatest()).toBe('waiting'); // no 16.24 in Data Dragon
    expect(await listPatchChangeSets(db)).toEqual([]);
  });

  test('a failed download stores nothing', async () => {
    cdragon.fail = true;
    await expect(job.checkLatest()).rejects.toThrow('network down');
    expect(await listPatchChangeSets(db)).toEqual([]);
  });

  test('the backfill stores final-build patch diffs, once; the live check then knows the build', async () => {
    await job.backfill(['16.23']);
    await job.backfill(['16.23']);
    const sets = await listPatchChangeSets(db);
    expect(sets.map((s) => [s.build, s.kind, s.source, s.changedChampions])).toEqual([
      ['16.23.8418428', 'patch', 'backfill', 3],
    ]);
    expect(await job.checkLatest()).toBe('known');
  });
});
