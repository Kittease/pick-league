import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  type PatchChangeInput,
  type PatchChangeSetInput,
  storeGameBuild,
} from '@pick-league/db';
import type { PatchNotesResponse } from '@pick-league/shared';
import { silentLogger } from '../logger.ts';
import { refreshStats } from '../stats/refresh.ts';
import { resetApiTestDb, seedSyntheticPatch, withDatabase } from '../testing/seed.ts';
import { createApp } from './app.ts';
import { TtlCache } from './cache.ts';

const BASE_URL = process.env.DATABASE_URL_TEST;
const URL_ = BASE_URL ? withDatabase(BASE_URL, 'pickleague_api_patch_notes') : undefined;

const OLD = '15.20';
const PREV = '15.21';
const CUR = '15.22';
const EZREAL = 81;
const SYNDRA = 134;
/** In the synthetic marksmen's core kit. */
const KRAKEN = 6672;

const champion = (over: Partial<PatchChangeInput>): PatchChangeInput => ({
  kind: 'champion',
  championId: EZREAL,
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

const syndraE = (spellName: string, valueName: string, from: number[], to: number[]) =>
  champion({
    championId: SYNDRA,
    name: 'Syndra',
    slot: 'E',
    spellName,
    valueName,
    oldValues: from,
    newValues: to,
    path: `Characters/Syndra/Spells/SyndraEAbility/${spellName}/mSpell/${valueName}/values`,
  });

const kraken = (over: Partial<PatchChangeInput>): PatchChangeInput => ({
  kind: 'item',
  championId: null,
  itemId: KRAKEN,
  name: 'Kraken Slayer',
  status: 'changed',
  slot: null,
  spellName: null,
  calculation: null,
  valueName: 'price',
  oldValues: [3000],
  newValues: [3100],
  path: `Items/${KRAKEN}/price`,
  ...over,
});

const set = (
  basePatch: string,
  baseBuild: string,
  changes: PatchChangeInput[],
): PatchChangeSetInput => ({
  kind: 'patch',
  source: 'backfill',
  basePatch,
  baseBuild,
  changedChampions: new Set(changes.flatMap((c) => (c.championId ? [c.championId] : []))).size,
  changedItems: new Set(changes.flatMap((c) => (c.itemId ? [c.itemId] : []))).size,
  changes,
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

describe.skipIf(!URL_)('GET /patch-notes (Postgres)', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await resetApiTestDb(URL_);
    db = createDb(URL_ as string, { max: 4 });
    // Ezreal picked often enough on both patches for his own win rate change and build shares.
    const pickWeights = { [EZREAL]: 6 };
    await seedSyntheticPatch(db, { patch: PREV, count: 1500, seed: 31, pickWeights });
    await seedSyntheticPatch(db, { patch: CUR, count: 1500, seed: 32, pickWeights });
    await refreshStats(db, { force: true });

    await storeGameBuild(db, { ...build('15.19', 50), changeSet: null });
    await storeGameBuild(db, {
      ...build(OLD, 80),
      changeSet: set('15.19', '15.19.50', [
        champion({ valueName: 'Cooldown', oldValues: [120, 110, 100], newValues: [110, 100, 90] }),
      ]),
    });
    await storeGameBuild(db, { ...build(PREV, 100), changeSet: null });
    await storeGameBuild(db, {
      ...build(CUR, 200),
      changeSet: set(PREV, `${PREV}.100`, [
        champion({
          slot: 'W',
          spellName: 'EzrealW',
          valueName: 'APRatio',
          oldValues: [0.9, 0.9, 0.9, 0.9, 0.9],
          newValues: [1, 1, 1, 1, 1],
        }),
        champion({
          slot: 'W',
          spellName: 'EzrealW',
          calculation: 'Damage',
          valueName: 'bonusAdRatio',
          oldValues: [1],
          newValues: [1.15],
        }),
        champion({}),
        champion({
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
        syndraE('SyndraE', 'Cooldown', [15, 15, 15, 15, 15], [17, 16.5, 16, 15.5, 15]),
        syndraE('SyndraE5', 'Cooldown', [15, 15, 15, 15, 15], [17, 16.5, 16, 15.5, 15]),
        kraken({}),
      ]),
    });
    app = createApp({ db, cache: new TtlCache(60_000), limiter: null, log: silentLogger });
  }, 300_000);

  afterAll(async () => {
    await db?.end();
  });

  const get = async <T>(path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as T };
  };

  test('the latest patch: verdicts, damage split, observed win rates, item users', async () => {
    const { status, body } = await get<PatchNotesResponse>('/patch-notes?patch=latest');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      patch: CUR,
      kind: 'patch',
      source: 'backfill',
      statsPatch: CUR,
      observedPatches: { current: CUR, previous: PREV },
    });
    // Buffs first, then new, then nerfs.
    expect(body.champions.map((c) => [c.name, c.verdict])).toEqual([
      ['Ezreal', 'buff'],
      ['Newcomer', 'new'],
      ['Syndra', 'nerf'],
    ]);

    const ezreal = body.champions[0];
    expect(ezreal?.damage).toMatchObject({ source: 'stats', patch: CUR });
    expect(ezreal?.spells.map((s) => [s.slot, s.changes.map((c) => c.label)])).toEqual([
      ['W', ['AP ratio', 'Damage · bonus AD ratio']],
      ['R', ['Base damage']],
    ]);
    // The synthetic Ezreal deals physical damage: his AP ratio is a minor change.
    expect(ezreal?.spells[0]?.changes[0]).toMatchObject({ direction: 'buff', minor: true });
    expect(ezreal?.spells[0]?.changes[1]).toMatchObject({ unit: 'percent', minor: false });
    const bottom = ezreal?.observed.find((o) => o.role === 'BOTTOM');
    expect(bottom?.games).toBeGreaterThanOrEqual(body.thresholds.minObservedGames);
    expect(bottom?.previousGames).toBeGreaterThanOrEqual(body.thresholds.minObservedGames);

    const syndra = body.champions[2];
    expect(syndra?.spells[0]?.changes).toHaveLength(1);
    expect(syndra?.spells[0]?.changes[0]?.spellNames).toEqual(['SyndraE', 'SyndraE5']);
    expect(body.champions[1]?.damage.source).toBe('none');

    expect(body.items.map((i) => [i.name, i.verdict])).toEqual([['Kraken Slayer', 'nerf']]);
    const users = body.itemUsers[0];
    expect(users).toMatchObject({ itemId: KRAKEN, verdict: 'nerf' });
    const ezrealBottom = users?.users.find((u) => u.championId === EZREAL && u.role === 'BOTTOM');
    expect(ezrealBottom?.share).toBeGreaterThanOrEqual(body.thresholds.minItemShare);
    expect(users?.users.every((u) => u.share >= body.thresholds.minItemShare)).toBe(true);
  });

  test('a patch the stats no longer keep: newest stats for the split, no observed change', async () => {
    const { status, body } = await get<PatchNotesResponse>(`/patch-notes?patch=${OLD}`);
    expect(status).toBe(200);
    expect(body.observedPatches).toBeNull();
    expect(body.champions[0]).toMatchObject({
      name: 'Ezreal',
      verdict: 'buff',
      damage: { source: 'stats', patch: CUR },
      observed: [],
    });
  });

  test('unknown patch: 404; invalid query: 400', async () => {
    expect((await get(`/patch-notes?patch=${PREV}`)).status).toBe(404);
    expect((await get('/patch-notes?patch=nope')).status).toBe(400);
  });
});
