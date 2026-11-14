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
  TierListChampionResponse,
  TierListEntry,
  TierListResponse,
} from '@pick-league/shared';
import { DUO_ROLES, LANE_ROLES } from '../engine/index.ts';
import { silentLogger } from '../logger.ts';
import { refreshStats } from '../stats/refresh.ts';
import * as repo from '../stats/repository.ts';
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
    // Synthetic players have no rank: spread them over the tiers for the tier list rank filter.
    await db`
      UPDATE players SET solo_tier = (ARRAY[
        'CHALLENGER', 'GRANDMASTER', 'GRANDMASTER', 'GRANDMASTER', 'MASTER', 'MASTER', 'MASTER',
        'MASTER', 'DIAMOND', NULL
      ])[1 + abs(hashtext(puuid)) % 10]::solo_tier`;
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

  test('build: support quest upgrade from the end-of-game inventory, supports only', async () => {
    const res = await post('/recommendations/build', { championId: 89, role: 'UTILITY' });
    const b = (await res.json()) as BuildResponse;
    // Leona (engage) ends with Celestial Opposition in 7 synthetic matches out of 8.
    expect(b.items.questUpgrade?.itemId).toBe(3869);
    const base = b.items.questUpgrade?.reasons.find((r) => r.kind === 'base');
    expect(base?.games).toBeGreaterThan(b.games / 2);
    expect(base?.label).toStartWith('Most successful quest upgrade (Celestial Opposition)');
    const listed = [...b.items.starting, ...b.items.early, ...b.items.core].map((i) => i.itemId);
    expect(listed).not.toContain(3869);

    const enchanter = await post('/recommendations/build', { championId: 117, role: 'UTILITY' });
    expect(((await enchanter.json()) as BuildResponse).items.questUpgrade?.itemId).toBe(3876);
    const adc = await post('/recommendations/build', { championId: 222, role: 'BOTTOM' });
    expect(((await adc.json()) as BuildResponse).items.questUpgrade).toBeUndefined();
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

  test('GET /tierlist: support tier list with rates and fallback', async () => {
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

  test('GET /tierlist: default filters are echoed and the filtered views agree with the unfiltered ones', async () => {
    const body = (await (await get('/tierlist?role=BOTTOM')).json()) as TierListResponse;
    expect(body.filters).toEqual({ platform: 'ALL', rank: 'MASTER' });
    const explicit = await get('/tierlist?role=BOTTOM&patch=latest&platform=ALL&rank=MASTER');
    expect(await explicit.json()).toEqual(body);

    // Every segment summed (no platform, rank level >= 0) = the unfiltered views.
    const all = { platform: null, minRankLevel: 0 };
    const patches = [CUR, PREV];
    // Key order differs between loaders: compare rows with sorted keys.
    const sorted = <T extends object>(rows: T[]) =>
      rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
    for (const role of ['BOTTOM', 'JUNGLE'] as const) {
      expect(sorted(await repo.loadSegmentRoleStats(db, patches, role, all))).toEqual(
        sorted((await repo.loadRoleStats(db, patches)).filter((r) => r.position === role)),
      );
      const champions = [
        ...new Set(
          (await repo.loadRoleStats(db, patches))
            .filter((r) => r.position === role)
            .map((r) => r.championId),
        ),
      ];
      const perChampion = async <T>(load: (id: number) => Promise<T[]>) =>
        (await Promise.all(champions.map(load))).flat();
      expect(
        sorted(await repo.loadSegmentVsForRole(db, patches, role, LANE_ROLES[role], all)),
      ).toEqual(
        sorted(
          await perChampion((id) =>
            repo.loadLaneVsOfChampion(db, patches, role, id, LANE_ROLES[role]),
          ),
        ),
      );
      expect(
        sorted(await repo.loadSegmentWithForRole(db, patches, role, DUO_ROLES[role], all)),
      ).toEqual(
        sorted(
          (await perChampion((id) => repo.loadAlliesOfChampion(db, patches, role, id))).filter(
            (r) => DUO_ROLES[role].includes(r.allyPosition),
          ),
        ),
      );
    }
    // Every player counted: weighted ban rates = banned matches / matches.
    const bans = new Map(
      (await repo.loadBans(db, patches)).map((b) => [`${b.patch}|${b.championId}`, b.bans]),
    );
    const matches = new Map((await repo.loadPatchMatches(db, patches)).map((m) => [m.patch, m]));
    const totals = await repo.loadSegmentTotals(db, patches, all);
    for (const t of totals) expect(t.matches).toBe((matches.get(t.patch)?.matches ?? 0) * 10);
    for (const b of await repo.loadSegmentBans(db, patches, all)) {
      expect(b.bans).toBe((bans.get(`${b.patch}|${b.championId}`) ?? 0) * 10);
    }
  });

  test('GET /tierlist: server filter', async () => {
    const all = (await (await get('/tierlist?role=UTILITY')).json()) as TierListResponse;
    const byServer = await Promise.all(
      (['KR', 'EUW1', 'NA1', 'VN2'] as const).map(
        async (p) =>
          (await (await get(`/tierlist?role=UTILITY&platform=${p}`)).json()) as TierListResponse,
      ),
    );
    const kr = byServer[0] as TierListResponse;
    expect(kr.filters).toEqual({ platform: 'KR', rank: 'MASTER' });
    expect(kr.roleGames).toBe(750 * 2); // one support per team, 750 KR matches on CUR
    expect(byServer.reduce((s, t) => s + t.roleGames, 0)).toBe(all.roleGames);
    expect(kr.entries.length).toBeGreaterThan(0);

    // Ban rate = KR matches of the patches used where it was banned / KR matches.
    const e = kr.entries.find((x) => x.patchesUsed.length === 1) as TierListEntry;
    const [row] = await db<{ banned: number; total: number }[]>`
      SELECT count(DISTINCT b.match_id) FILTER (WHERE b.champion_id = ${e.championId})::int AS banned,
             count(DISTINCT m.id)::int AS total
      FROM matches m LEFT JOIN match_bans b ON b.match_id = m.id
      WHERE m.platform = 'KR' AND m.patch = ${CUR} AND NOT m.is_remake`;
    expect(e.banRate).toBeCloseTo((row?.banned ?? 0) / (row?.total ?? 1), 4);
  });

  test('GET /tierlist: rank filter counts players by their current solo tier', async () => {
    const roleGames = async (tiers: string[], platform?: string) => {
      const [row] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM participants p
        JOIN matches m ON m.id = p.match_id JOIN players pl ON pl.puuid = p.puuid
        WHERE m.patch = ${CUR} AND NOT m.is_remake AND p.position = 'UTILITY'
          AND pl.solo_tier::text IN ${db(tiers)}
          ${platform ? db`AND m.platform = ${platform}` : db``}`;
      return row?.n ?? 0;
    };
    const chall = (await (
      await get('/tierlist?role=UTILITY&rank=CHALLENGER')
    ).json()) as TierListResponse;
    expect(chall.filters).toEqual({ platform: 'ALL', rank: 'CHALLENGER' });
    expect(chall.roleGames).toBe(await roleGames(['CHALLENGER']));
    const gm = (await (
      await get('/tierlist?role=UTILITY&rank=GRANDMASTER&platform=EUW1')
    ).json()) as TierListResponse;
    expect(gm.filters).toEqual({ platform: 'EUW1', rank: 'GRANDMASTER' });
    expect(gm.roleGames).toBe(await roleGames(['CHALLENGER', 'GRANDMASTER'], 'EUW1'));

    // Fewer games per champion than unfiltered, so more of them fall back to both patches.
    const all = (await (await get('/tierlist?role=UTILITY')).json()) as TierListResponse;
    for (const e of chall.entries) {
      const full = all.entries.find((x) => x.championId === e.championId);
      expect(e.games).toBeLessThan(full?.games ?? Number.POSITIVE_INFINITY);
      expect(e.banRate).toBeGreaterThanOrEqual(0);
      expect(e.banRate).toBeLessThan(1);
    }
    expect(chall.entries.filter((e) => e.patchesUsed.length > 1).length).toBeGreaterThan(
      all.entries.filter((e) => e.patchesUsed.length > 1).length,
    );

    // Ban rate = Challenger players whose match banned it / Challenger players (patches used).
    const e = chall.entries[0] as TierListEntry;
    const [row] = await db<{ banned: number; total: number }[]>`
      SELECT count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM match_bans b WHERE b.match_id = p.match_id AND b.champion_id = ${e.championId}
             ))::int AS banned,
             count(*)::int AS total
      FROM participants p
      JOIN matches m ON m.id = p.match_id JOIN players pl ON pl.puuid = p.puuid
      WHERE m.patch IN ${db(e.patchesUsed)} AND NOT m.is_remake AND pl.solo_tier = 'CHALLENGER'`;
    expect(e.banRate).toBeCloseTo((row?.banned ?? 0) / (row?.total ?? 1), 4);
  });

  test('GET /tierlist: bad filters', async () => {
    for (const qs of ['platform=EUW', 'platform=euw1', 'rank=DIAMOND', 'rank=master']) {
      const res = await get(`/tierlist?role=TOP&${qs}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe('BAD_REQUEST');
    }
  });

  test('GET /tierlist/champion: every matchup, duo and synergy, best first', async () => {
    const detail = async (championId: number) => {
      const res = await get(`/tierlist/champion?role=UTILITY&championId=${championId}`);
      expect(res.status).toBe(200);
      return (await res.json()) as TierListChampionResponse;
    };
    const naut = await detail(PLANTED.matchup.championId);
    expect(naut).toMatchObject({ role: 'UTILITY', patch: CUR, championId: 111 });
    const list = await (await get('/tierlist?role=UTILITY')).json();
    const entry = (list as TierListResponse).entries.find((e) => e.championId === 111);
    expect(naut.patchesUsed).toEqual(entry?.patchesUsed ?? []);
    expect(naut.games).toBe(entry?.games ?? 0);
    // Far more than the former top 3: every bot lane opponent of the synthetic pool.
    expect(naut.matchups.length).toBeGreaterThan(6);
    expect(new Set(naut.matchups.map((m) => m.role))).toEqual(new Set(['UTILITY', 'BOTTOM']));
    for (const rows of [naut.matchups, naut.duos, naut.synergies ?? []]) {
      const deltas = rows.map((r) => r.delta);
      expect(deltas).toEqual([...deltas].sort((a, b) => b - a));
      expect(rows.every((r) => r.games >= 5)).toBe(true);
    }
    // Synthetic matchup noise can put another support first: the planted one is near the top.
    const planted = naut.matchups.findIndex((m) => m.championId === PLANTED.matchup.opponentId);
    expect(planted).toBeGreaterThanOrEqual(0);
    expect(planted).toBeLessThan(3);
    expect(naut.matchups[planted]?.delta).toBeGreaterThan(0.03);
    expect(naut.duos.every((d) => d.role === 'BOTTOM')).toBe(true);
    expect(naut.filters).toEqual({ platform: 'ALL', rank: 'MASTER' });
    expect(naut.synergies?.length).toBeGreaterThan(0);
    expect((naut.synergies ?? []).every((s) => ['TOP', 'JUNGLE', 'MIDDLE'].includes(s.role))).toBe(
      true,
    );

    const janna = await detail(PLANTED.matchup.opponentId);
    expect(janna.matchups.at(-1)?.championId).toBe(PLANTED.matchup.championId);
    const lulu = await detail(PLANTED.duo.championId);
    expect(lulu.duos[0]).toMatchObject({ championId: PLANTED.duo.allyId, role: 'BOTTOM' });
    const braum = await detail(PLANTED.rareOnCurrent);
    expect(braum.patchesUsed).toEqual([CUR, PREV]);

    // Same query in another order: served from the same cache entry.
    const size = cache.size;
    const again = await app.request('/tierlist/champion?championId=111&role=UTILITY&patch=latest');
    expect(await again.json()).toEqual(naut);
    expect(cache.size).toBe(size);
  });

  test('GET /tierlist/champion: server and rank filters, without synergies', async () => {
    const url = '/tierlist/champion?role=UTILITY&championId=111';
    const all = (await (await get(url)).json()) as TierListChampionResponse;
    const kr = (await (await get(`${url}&platform=KR`)).json()) as TierListChampionResponse;
    expect(kr.filters).toEqual({ platform: 'KR', rank: 'MASTER' });
    expect(kr.synergies).toBeNull();
    expect(kr.games).toBeLessThan(all.games);
    expect(kr.matchups.length).toBeGreaterThan(0);
    const games = (rows: TierListChampionResponse['matchups']) =>
      rows.reduce((s, r) => s + r.games, 0);
    expect(games(kr.matchups)).toBeLessThan(games(all.matchups));
    expect(kr.duos.every((d) => d.role === 'BOTTOM')).toBe(true);
    const chall = await get(`${url}&rank=CHALLENGER`);
    expect(chall.status).toBe(200);
    expect(((await chall.json()) as TierListChampionResponse).synergies).toBeNull();
  });

  test('GET /tierlist/champion: bad query, unknown champion or patch', async () => {
    expect((await get('/tierlist/champion?role=UTILITY')).status).toBe(400);
    expect((await get('/tierlist/champion?role=UTILITY&championId=abc')).status).toBe(400);
    expect((await get('/tierlist/champion?role=SUPPORT&championId=111')).status).toBe(400);
    const unknown = await get('/tierlist/champion?role=UTILITY&championId=99999');
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ApiErrorResponse).error.code).toBe('NOT_FOUND');
    expect((await get('/tierlist/champion?role=UTILITY&championId=111&patch=9.9')).status).toBe(
      404,
    );
  });

  test('stats refresh is skipped when matches did not change', async () => {
    const r = await refreshStats(db);
    expect(r.reason).toBe('unchanged');
  });
});
