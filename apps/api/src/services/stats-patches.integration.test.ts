/**
 * Which patch the stats are served from while the newest kept patch has no matches yet (Data
 * Dragon ahead of the servers). Needs DATABASE_URL_TEST (bun run db:test:up); uses its own
 * database so it never races the other API tests.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, type Db, upsertPatchStaticData } from '@pick-league/db';
import { picksRequestSchema, tierListQuerySchema } from '@pick-league/shared';
import { refreshStats } from '../stats/refresh.ts';
import { resetApiTestDb, seedSyntheticPatch, withDatabase } from '../testing/seed.ts';
import { syntheticStaticData } from '../testing/synthetic.ts';
import { health, patches, staticData } from './meta.ts';
import { picks } from './recommendations.ts';
import { tierList } from './tierlist.ts';

const BASE = process.env.DATABASE_URL_TEST;
const URL_ = BASE ? withDatabase(BASE, 'pickleague_api_patches_test') : undefined;

describe.skipIf(!URL_)('stats patches: newest patch without matches (Postgres)', () => {
  let db: Db;
  const supportTierList = (patch = 'latest') =>
    tierList(db, tierListQuerySchema.parse({ role: 'UTILITY', patch }));

  beforeAll(async () => {
    await resetApiTestDb(URL_);
    db = createDb(URL_ as string, { max: 4 });
    await seedSyntheticPatch(db, { patch: '15.22', count: 300, seed: 21 });
    // Data Dragon already has the next patch; no server plays it yet.
    await upsertPatchStaticData(db, syntheticStaticData('15.23'));
    await refreshStats(db, { force: true });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
  });

  test('the stats, the header and the recommendations stay on the patch with matches', async () => {
    expect(await health(db)).toMatchObject({
      ok: true,
      latestPatch: '15.22',
      patchMatchCount: 300,
      matchCount: 300,
    });

    const tiers = await supportTierList();
    expect(tiers.patch).toBe('15.22');
    expect(tiers.roleGames).toBeGreaterThan(0);

    const res = await picks(
      db,
      picksRequestSchema.parse({ role: 'UTILITY', allies: [], enemies: [], bans: [] }),
    );
    expect(res.patch).toBe('15.22');
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(c.reasons.some((r) => r.kind === 'patch_fallback')).toBe(false);
    }

    // Static data and the patch list still show the newest ingested patch.
    expect((await staticData(db, 'latest')).patch).toBe('15.23');
    const list = (await patches(db)).patches;
    expect(list.map((p) => [p.patch, p.matchCount])).toEqual([
      ['15.23', 0],
      ['15.22', 300],
    ]);
  });

  test('matches of the new patch stored but the stats not refreshed yet: unchanged', async () => {
    await seedSyntheticPatch(db, { patch: '15.23', count: 40, seed: 22 });
    expect((await health(db)).latestPatch).toBe('15.22');
  });

  test('after the refresh the new patch is current', async () => {
    await refreshStats(db, { force: true });
    expect(await health(db)).toMatchObject({
      ok: true,
      latestPatch: '15.23',
      patchMatchCount: 40,
      matchCount: 340,
    });
    expect((await supportTierList()).patch).toBe('15.23');
  }, 120_000);

  test('a forced patch is unchanged', async () => {
    expect((await supportTierList('15.22')).patch).toBe('15.22');
    await expect(supportTierList('14.1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
