/**
 * Endpoint tests against a real Postgres seeded with synthetic matches.
 * Needs DATABASE_URL_TEST (bun run db:test:up); uses its own database `pickleague_api_test`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, type Db } from '@pick-league/db';
import type {
  ApiErrorResponse,
  BuildResponse,
  HealthResponse,
  PatchesResponse,
  PicksResponse,
  StaticDataResponse,
  TierListResponse,
} from '@pick-league/shared';
import { silentLogger } from '../logger.ts';
import { refreshStats } from '../stats/refresh.ts';
import { API_TEST_DATABASE_URL, resetApiTestDb, seedSyntheticPatch } from '../testing/seed.ts';
import { PLANTED } from '../testing/synthetic.ts';
import { createApp } from './app.ts';
import { TtlCache } from './cache.ts';
import { TokenBucketLimiter } from './rate-limit.ts';

const CUR = '15.22';
const PREV = '15.21';

describe.skipIf(!API_TEST_DATABASE_URL)('API endpoints (Postgres)', () => {
  let db: Db;
  let cache: TtlCache<unknown>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await resetApiTestDb();
    db = createDb(API_TEST_DATABASE_URL as string, { max: 8 });
    await seedSyntheticPatch(db, { patch: PREV, count: 800, seed: 11 });
    await seedSyntheticPatch(db, {
      patch: CUR,
      count: 3000,
      seed: 12,
      pickWeights: { [PLANTED.rareOnCurrent]: 0.05 },
    });
    await refreshStats(db, { force: true });
    cache = new TtlCache(60_000);
    app = createApp({ db, cache, limiter: null, log: silentLogger });
  }, 180_000);

  afterAll(async () => {
    await db?.end();
  });

  const get = (path: string) => app.request(path);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });

  test('GET /health', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect((await res.json()) as HealthResponse).toEqual({
      ok: true,
      db: true,
      latestPatch: CUR,
      matchCount: 3800,
    });
  });

  test('GET /patches', async () => {
    const body = (await (await get('/patches')).json()) as PatchesResponse;
    expect(body.patches.map((p) => p.patch)).toEqual([CUR, PREV]);
    const cur = body.patches[0];
    expect(cur?.matchCount).toBe(3000);
    expect(cur?.matchCountByPlatform).toEqual({ KR: 750, EUW1: 750, NA1: 750, VN2: 750 });
  });

  test('GET /static/latest and /static/:patch', async () => {
    const res = await get('/static/latest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as StaticDataResponse;
    expect(body.patch).toBe(CUR);
    const names = body.champions.map((c) => c.name);
    expect(names).toEqual([...names].sort());
    const leona = body.champions.find((c) => c.id === 89);
    expect(leona?.iconUrl).toBe(
      'https://ddragon.leagueoflegends.com/cdn/15.22.1/img/champion/Leona.png',
    );
    expect(leona?.spells).toHaveLength(4);
    expect(body.statShards.offense.length).toBe(3);
    expect(body.items.find((i) => i.id === 3075)?.iconUrl).toContain('/img/item/3075.png');
    expect((await get(`/static/${PREV}`)).status).toBe(200);
    const missing = await get('/static/9.9');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiErrorResponse).error.code).toBe('NOT_FOUND');
  });

  test('unknown route and CORS', async () => {
    const res = await get('/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErrorResponse).error.code).toBe('NOT_FOUND');
    const pre = await app.request('/recommendations/picks', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('POST /recommendations/picks validates the body', async () => {
    const bad = await post('/recommendations/picks', { role: 'SUPPORT' });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as ApiErrorResponse;
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(Array.isArray(body.error.details)).toBe(true);
    const notJson = await post('/recommendations/picks', '{nope');
    expect(notJson.status).toBe(400);
  });

  test('picks: the planted lane counter ranks first, with a data-backed reason', async () => {
    const res = await post('/recommendations/picks', {
      role: 'UTILITY',
      enemies: [PLANTED.matchup.opponentId, null, null],
      bans: [89],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PicksResponse;
    expect(body.role).toBe('UTILITY');
    expect(body.patch).toBe(CUR);
    const ids = body.candidates.map((c) => c.championId);
    expect(ids[0]).toBe(PLANTED.matchup.championId);
    expect(ids).not.toContain(89);
    expect(ids).not.toContain(PLANTED.matchup.opponentId);
    const reason = body.candidates[0]?.reasons.find((r) => r.kind === 'matchup');
    expect(reason?.delta).toBeGreaterThan(0.03);
    expect(reason?.games).toBeGreaterThan(50);
    expect(reason?.label).toMatch(/^\+\d+\.\d% vs Janna \(likely lane, support, [\d,]+ games\)$/);
  });

  test('picks: duo synergy and previous patch added for a rare pick', async () => {
    const res = await post('/recommendations/picks', {
      role: 'UTILITY',
      allies: [{ championId: PLANTED.duo.allyId, role: 'BOTTOM' }],
    });
    const body = (await res.json()) as PicksResponse;
    const lulu = body.candidates.find((c) => c.championId === PLANTED.duo.championId);
    const duo = lulu?.reasons.find((r) => r.kind === 'duo');
    expect(duo?.delta).toBeGreaterThan(0.03);
    expect(body.candidates.slice(0, 2).map((c) => c.championId)).toContain(PLANTED.duo.championId);

    const braum = body.candidates.find((c) => c.championId === PLANTED.rareOnCurrent);
    expect(braum?.patchesUsed).toEqual([CUR, PREV]);
    expect(braum?.reasons[0]?.kind).toBe('patch_fallback');
  });

  test('picks: availableChampionIds and limit', async () => {
    const res = await post('/recommendations/picks', {
      role: 'UTILITY',
      availableChampionIds: [412, 117, 40],
      limit: 2,
    });
    const body = (await res.json()) as PicksResponse;
    expect(body.candidates).toHaveLength(2);
    for (const c of body.candidates) expect([412, 117, 40]).toContain(c.championId);
  });

  test('build: full build with reasons; keystone adapts to the planted rune matchup', async () => {
    const res = await post('/recommendations/build', {
      championId: PLANTED.runeMatchup.championId,
      role: 'UTILITY',
      allies: [{ championId: 222, role: 'BOTTOM' }],
      enemies: [{ championId: PLANTED.runeMatchup.opponentId, role: 'UTILITY' }],
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as BuildResponse;
    expect(b.patchesUsed).toEqual([CUR]);
    expect(b.games).toBeGreaterThan(200);
    expect(b.runes.runeIds[0]).toBe(PLANTED.runeMatchup.keystone);
    expect(b.runes.selectedPerkIds).toHaveLength(9);
    const matchup = b.runes.reasons.find((r) => r.kind === 'matchup');
    expect(matchup?.delta).toBeGreaterThan(0);
    expect(b.summonerSpells.spellIds[0]).toBe(4);
    expect(b.skillOrder.firstLevels).toHaveLength(3);
    expect(b.skillOrder.maxOrder).toHaveLength(3);
    expect(b.items.starting.map((i) => i.itemId).sort()).toEqual([2003, 2003, 3865]);
    expect(b.items.core.length).toBeGreaterThanOrEqual(4);
    expect(b.items.core.some((i) => [3047, 3111, 3158].includes(i.itemId))).toBe(true);
    for (const piece of [
      b.runes,
      b.summonerSpells,
      b.skillOrder,
      ...b.items.core,
      ...b.items.starting,
    ]) {
      expect(piece.reasons.length).toBeGreaterThan(0);
    }
  });

  test('build: anti-heal suggested vs a heal-heavy composition', async () => {
    const res = await post('/recommendations/build', {
      championId: 222,
      role: 'BOTTOM',
      enemies: [
        { championId: 16, role: 'UTILITY' },
        { championId: 19, role: 'JUNGLE' },
        { championId: 360, role: null },
      ],
    });
    const b = (await res.json()) as BuildResponse;
    // Mortal Reminder (anti-heal) either in the core with a reason, or as a situational item.
    const antiHeal = [...b.items.core, ...b.items.situational].find((s) => s.itemId === 3033);
    expect(antiHeal).toBeDefined();
    const reason = antiHeal?.reasons.find((r) => r.trait === 'HIGH_HEALING');
    expect(['item_swap', 'tag_rule']).toContain(reason?.kind as string);
    // It is never what a situational item replaces.
    expect(b.items.situational.map((s) => s.replacesItemId)).not.toContain(3033);
  });

  test('build: unknown champion → 404, no games in role → 503', async () => {
    const unknown = await post('/recommendations/build', { championId: 9999, role: 'TOP' });
    expect(unknown.status).toBe(404);
    const noData = await post('/recommendations/build', { championId: 222, role: 'TOP' });
    expect(noData.status).toBe(503);
    expect(((await noData.json()) as ApiErrorResponse).error.code).toBe('NO_DATA');
  });

  test('cache key ignores list order', async () => {
    const a = { role: 'MIDDLE', enemies: [122, 64], bans: [1, 103] };
    const b = { role: 'MIDDLE', enemies: [64, 122], bans: [103, 1] };
    await post('/recommendations/picks', a);
    const size = cache.size;
    const res = await post('/recommendations/picks', b);
    expect(res.status).toBe(200);
    expect(cache.size).toBe(size);
  });

  test('rate limit returns RATE_LIMITED with Retry-After', async () => {
    const limited = createApp({
      db,
      cache: new TtlCache(1000),
      limiter: new TokenBucketLimiter({ burst: 2, perMinute: 1 }),
      log: silentLogger,
    });
    expect((await limited.request('/patches')).status).toBe(200);
    expect((await limited.request('/patches')).status).toBe(200);
    const res = await limited.request('/patches');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(((await res.json()) as ApiErrorResponse).error.code).toBe('RATE_LIMITED');
    expect((await limited.request('/health')).status).toBe(200);
  });

  test('GET /tierlist: support tier list with matchups, duos, rates and fallback', async () => {
    const res = await get('/tierlist?role=UTILITY');
    expect(res.status).toBe(200);
    const body = (await res.json()) as TierListResponse;
    expect(body.role).toBe('UTILITY');
    expect(body.patch).toBe(CUR);
    expect(body.roleGames).toBeGreaterThan(5000);
    const ids = body.entries.map((e) => e.championId);
    expect(new Set(ids)).toEqual(new Set([412, 89, 111, 117, 40, 16, 267, 201]));
    const scores = body.entries.map((e) => e.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(body.entries[0]?.tier).toBe('S');
    expect(new Set(body.entries.map((e) => e.tier)).size).toBeGreaterThanOrEqual(3);

    const naut = body.entries.find((e) => e.championId === PLANTED.matchup.championId);
    // Synthetic matchup noise can put another support first: the planted one is in the top 3.
    const planted = naut?.bestMatchups.find((m) => m.championId === PLANTED.matchup.opponentId);
    expect(planted?.delta).toBeGreaterThan(0.03);
    expect(planted?.games).toBeGreaterThanOrEqual(15);
    const janna = body.entries.find((e) => e.championId === PLANTED.matchup.opponentId);
    expect(janna?.worstMatchups[0]?.championId).toBe(PLANTED.matchup.championId);
    const lulu = body.entries.find((e) => e.championId === PLANTED.duo.championId);
    expect(lulu?.bestDuos[0]?.championId).toBe(PLANTED.duo.allyId);
    expect(lulu?.bestDuos[0]?.role).toBe('BOTTOM');

    const braum = body.entries.find((e) => e.championId === PLANTED.rareOnCurrent);
    expect(braum?.patchesUsed).toEqual([CUR, PREV]);
    const current = body.entries.filter((e) => e.patchesUsed.length === 1);
    for (const e of body.entries) {
      expect(e.banRate).toBeGreaterThan(0);
      expect(e.banRate).toBeLessThan(1);
      expect(e.confidence).toBeGreaterThan(0);
    }
    expect(current.reduce((s, e) => s + e.pickRate, 0)).toBeCloseTo(
      current.reduce((s, e) => s + e.games, 0) / body.roleGames,
      2,
    );

    const again = await app.request('/tierlist?role=UTILITY&patch=latest');
    expect(await again.json()).toEqual(body);
  });

  test('GET /tierlist: forced patch, bad role, unknown patch', async () => {
    const prev = (await (
      await get(`/tierlist?role=BOTTOM&patch=${PREV}`)
    ).json()) as TierListResponse;
    expect(prev.patch).toBe(PREV);
    expect(prev.entries.every((e) => e.patchesUsed.join() === PREV)).toBe(true);
    const bad = await get('/tierlist?role=SUPPORT');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiErrorResponse).error.code).toBe('BAD_REQUEST');
    expect((await get('/tierlist')).status).toBe(400);
    expect((await get('/tierlist?role=TOP&patch=9.9')).status).toBe(404);
  });

  test('stats refresh is skipped when matches did not change', async () => {
    const r = await refreshStats(db);
    expect(r.reason).toBe('unchanged');
  });
});
