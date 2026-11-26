import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, type Db, type PatchChangeInput, storeGameBuild } from '@pick-league/db';
import type { PatchChangesIndexResponse, PatchChangesResponse } from '@pick-league/shared';
import { silentLogger } from '../logger.ts';
import { patchContext } from '../services/recommendations.ts';
import { resetApiTestDb, withDatabase } from '../testing/seed.ts';
import { createApp } from './app.ts';
import { TtlCache } from './cache.ts';

const BASE_URL = process.env.DATABASE_URL_TEST;
const URL_ = BASE_URL ? withDatabase(BASE_URL, 'pickleague_api_patch_changes') : undefined;

const CUR = '15.22';
const PREV = '15.21';

const row = (over: Partial<PatchChangeInput>): PatchChangeInput => ({
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

const build = (patch: string, n: number) => ({
  build: `${patch}.${n}`,
  patch,
  buildNumber: n,
  version: `${patch}.${n}+branch.releases.content.release`,
  champions: 172,
  items: 428,
  snapshot: null,
});

describe.skipIf(!URL_)('GET /patch-changes (Postgres)', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await resetApiTestDb(URL_);
    db = createDb(URL_ as string, { max: 4 });
    await db`INSERT INTO patches (id, ddragon_version) VALUES (${PREV}, '15.21.1'), (${CUR}, '15.22.1')`;
    await storeGameBuild(db, { ...build(PREV, 100), changeSet: null });
    await storeGameBuild(db, {
      ...build(CUR, 200),
      changeSet: {
        kind: 'patch',
        source: 'live',
        basePatch: PREV,
        baseBuild: `${PREV}.100`,
        changedChampions: 2,
        changedItems: 1,
        changes: [
          row({}),
          row({
            calculation: 'Damage',
            valueName: 'bonusAdRatio',
            oldValues: [1],
            newValues: [1.1],
          }),
          row({
            championId: 999,
            name: 'Newcomer',
            status: 'new',
            slot: null,
            spellName: null,
            valueName: null,
            oldValues: null,
            newValues: null,
            path: null,
          }),
          row({
            kind: 'item',
            championId: null,
            itemId: 6699,
            name: 'Voltaic Cyclosword',
            slot: null,
            spellName: null,
            valueName: 'PercentCurrentHPMelee',
            oldValues: [9],
            newValues: [8],
            path: 'Items/6699/mDataValues/PercentCurrentHPMelee/mValue',
          }),
        ],
      },
    });
    await storeGameBuild(db, {
      ...build(CUR, 300),
      changeSet: {
        kind: 'hotfix',
        source: 'live',
        basePatch: CUR,
        baseBuild: `${CUR}.200`,
        changedChampions: 0,
        changedItems: 0,
        changes: [],
      },
    });
    app = createApp({ db, cache: new TtlCache(60_000), limiter: null, log: silentLogger });
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  const get = async <T>(path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as T };
  };

  test('the index lists each patch with its patch diff and its hotfixes', async () => {
    const { status, body } = await get<PatchChangesIndexResponse>('/patch-changes/index');
    expect(status).toBe(200);
    expect(
      body.patches.map((p) => [
        p.patch,
        p.sets.map((s) => [s.build, s.kind, s.source, s.gameplayChanged]),
      ]),
    ).toEqual([
      [
        CUR,
        [
          [`${CUR}.200`, 'patch', 'live', true],
          [`${CUR}.300`, 'hotfix', 'live', false],
        ],
      ],
    ]);
    expect(Number.isNaN(Date.parse(body.patches[0]?.sets[0]?.detectedAt ?? ''))).toBe(false);
  });

  test('the latest patch diff, grouped by champion and item', async () => {
    const { status, body } = await get<PatchChangesResponse>('/patch-changes?patch=latest');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      patch: CUR,
      build: `${CUR}.200`,
      kind: 'patch',
      basePatch: PREV,
      baseBuild: `${PREV}.100`,
      changedChampions: 2,
      changedItems: 1,
    });
    expect(body.champions.map((c) => [c.championId, c.name, c.status, c.changes.length])).toEqual([
      [81, 'Ezreal', 'changed', 2],
      [999, 'Newcomer', 'new', 0],
    ]);
    expect(body.champions[0]?.changes[1]).toEqual({
      slot: 'R',
      spellName: 'EzrealR',
      calculation: 'Damage',
      valueName: 'bonusAdRatio',
      oldValues: [1],
      newValues: [1.1],
      path: 'Characters/Ezreal/Spells/EzrealRAbility/EzrealR/mSpell/DataValues/BaseDamage/values',
    });
    expect(body.items).toEqual([
      {
        itemId: 6699,
        name: 'Voltaic Cyclosword',
        status: 'changed',
        changes: [
          {
            slot: null,
            spellName: null,
            calculation: null,
            valueName: 'PercentCurrentHPMelee',
            oldValues: [9],
            newValues: [8],
            path: 'Items/6699/mDataValues/PercentCurrentHPMelee/mValue',
          },
        ],
      },
    ]);
    expect(body.hotfixes.map((h) => h.build)).toEqual([`${CUR}.300`]);
    expect((await get(`/patch-changes?patch=${CUR}`)).body).toEqual(body);
  });

  test('one build: an empty hotfix', async () => {
    const { body } = await get<PatchChangesResponse>(
      `/patch-changes?patch=${CUR}&build=${CUR}.300`,
    );
    expect(body).toMatchObject({
      kind: 'hotfix',
      gameplayChanged: false,
      champions: [],
      items: [],
    });
  });

  test('unknown patch or build: 404; invalid query: 400', async () => {
    expect((await get(`/patch-changes?patch=${PREV}`)).status).toBe(404);
    expect((await get(`/patch-changes?patch=${CUR}&build=${CUR}.999`)).status).toBe(404);
    expect((await get('/patch-changes?build=latest')).status).toBe(400);
  });

  test("the engine's patch context carries the current patch's changed champions", async () => {
    const ctx = await patchContext(db);
    expect(ctx.current).toBe(CUR);
    expect([...ctx.changedChampions]).toEqual([81, 999]);
    expect([...(await patchContext(db, CUR)).changedChampions]).toEqual([]);
  });
});
