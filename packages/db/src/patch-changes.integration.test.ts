import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Db } from './client.ts';
import {
  changedChampionIds,
  type GameBuildInput,
  getGameBuild,
  getPatchChanges,
  hasPatchDiff,
  listPatchChangeSets,
  newestGameBuildSnapshot,
  type PatchChangeInput,
  storeGameBuild,
} from './queries/patch-changes.ts';
import { resetDb, TEST_DATABASE_URL, testDb } from './test-helpers.ts';

const change = (over: Partial<PatchChangeInput> = {}): PatchChangeInput => ({
  kind: 'champion',
  championId: 81,
  itemId: null,
  name: 'Ezreal',
  status: 'changed',
  slot: 'R',
  spellName: 'EzrealR',
  calculation: null,
  valueName: 'BaseDamage',
  oldValues: [350, 550, 750],
  newValues: [350, 600, 850],
  path: 'Characters/Ezreal/Spells/EzrealRAbility/EzrealR/mSpell/DataValues/BaseDamage/values',
  ...over,
});

const build = (
  patch: string,
  buildNumber: number,
  changeSet: GameBuildInput['changeSet'] = null,
): GameBuildInput => ({
  build: `${patch}.${buildNumber}`,
  patch,
  buildNumber,
  version: `${patch}.${buildNumber}+branch.releases.content.release`,
  champions: 172,
  items: 428,
  snapshot: new Uint8Array([patch.length, buildNumber % 256]),
  changeSet,
});

describe.skipIf(!TEST_DATABASE_URL)('patch changes (Postgres)', () => {
  let db: Db;
  beforeEach(async () => {
    const admin = testDb();
    await resetDb(admin);
    await admin.end();
    db = testDb();
  });
  afterEach(async () => {
    await db.end();
  });

  test('stores a build with its diff, once; reads the sets, the changes and the changed champions', async () => {
    expect(await storeGameBuild(db, build('16.22', 100))).toBe(true);
    const patchSet = {
      kind: 'patch' as const,
      source: 'live' as const,
      basePatch: '16.22',
      baseBuild: '16.22.100',
      changedChampions: 2,
      changedItems: 1,
      changes: [
        change(),
        change({ valueName: 'RAPRatio', oldValues: [1.1], newValues: [1.2] }),
        change({
          championId: 799,
          name: 'Newcomer',
          status: 'new',
          slot: null,
          spellName: null,
          valueName: null,
          oldValues: null,
          newValues: null,
          path: null,
        }),
        change({
          kind: 'item',
          championId: null,
          itemId: 6699,
          name: 'Voltaic Cyclosword',
          slot: null,
          spellName: null,
          valueName: 'PercentCurrentHPMelee',
          oldValues: [9],
          newValues: [8],
        }),
      ],
    };
    expect(await storeGameBuild(db, build('16.23', 200, patchSet))).toBe(true);
    expect(await storeGameBuild(db, build('16.23', 200, patchSet))).toBe(false);
    const hotfix = {
      kind: 'hotfix' as const,
      source: 'live' as const,
      basePatch: '16.23',
      baseBuild: '16.23.200',
      changedChampions: 0,
      changedItems: 0,
      changes: [],
    };
    await storeGameBuild(db, build('16.23', 300, hotfix));

    expect(await hasPatchDiff(db, '16.23')).toBe(true);
    expect(await hasPatchDiff(db, '16.22')).toBe(false);
    const sets = await listPatchChangeSets(db);
    expect(sets.map((s) => [s.build, s.kind, s.changedChampions])).toEqual([
      ['16.23.200', 'patch', 2],
      ['16.23.300', 'hotfix', 0],
    ]);
    const rows = await getPatchChanges(db, (sets[0] as { id: number }).id);
    expect(rows.map((r) => [r.ord, r.name, r.valueName, r.newValues])).toEqual([
      [0, 'Ezreal', 'BaseDamage', [350, 600, 850]],
      [1, 'Ezreal', 'RAPRatio', [1.2]],
      [2, 'Newcomer', null, null],
      [3, 'Voltaic Cyclosword', 'PercentCurrentHPMelee', [8]],
    ]);
    expect(await changedChampionIds(db, ['16.23', '16.22'])).toEqual(
      new Map([['16.23', [81, 799]]]),
    );

    // Only the newest build of a patch keeps its snapshot.
    expect((await getGameBuild(db, '16.23.200'))?.hasSnapshot).toBe(false);
    expect((await newestGameBuildSnapshot(db, '16.23'))?.build.build).toBe('16.23.300');
    expect((await newestGameBuildSnapshot(db, '16.22'))?.snapshot).toEqual(
      new Uint8Array([5, 100]),
    );
  });

  test('a build read as a base gets its own diff later', async () => {
    await storeGameBuild(db, build('16.22', 100));
    const set = {
      kind: 'patch' as const,
      source: 'backfill' as const,
      basePatch: '16.21',
      baseBuild: '16.21.50',
      changedChampions: 1,
      changedItems: 0,
      changes: [change()],
    };
    expect(await storeGameBuild(db, build('16.22', 100, set))).toBe(true);
    expect(await storeGameBuild(db, build('16.22', 100, set))).toBe(false);
    expect((await listPatchChangeSets(db)).map((s) => [s.build, s.source])).toEqual([
      ['16.22.100', 'backfill'],
    ]);
  });

  test('keeps 6 patches of change sets, and snapshots of the 2 newest', async () => {
    for (let minor = 15; minor <= 23; minor++) await storeGameBuild(db, build(`16.${minor}`, 1));
    const patches = await db<{ patch: string; has: boolean }[]>`
      SELECT patch, snapshot IS NOT NULL AS has FROM game_builds ORDER BY build_number, patch`;
    expect(patches.map((p) => p.patch).sort()).toEqual([
      '16.18',
      '16.19',
      '16.20',
      '16.21',
      '16.22',
      '16.23',
    ]);
    expect(patches.filter((p) => p.has).map((p) => p.patch)).toEqual(['16.22', '16.23']);
  });
});
