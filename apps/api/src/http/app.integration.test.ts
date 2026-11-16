/**
 * Endpoint tests against a real Postgres seeded with synthetic matches.
 * Needs DATABASE_URL_TEST (bun run db:test:up); uses its own database `pickleague_api_test`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, type Db } from '@pick-league/db';
import type {
  ApiErrorResponse,
  BuildResponse,
  DraftEvaluationResponse,
  HealthResponse,
  PatchesResponse,
  PicksResponse,
  Position,
  StaticDataResponse,
  TierListChampionResponse,
  TierListEntry,
  TierListResponse,
} from '@pick-league/shared';
import { DUO_ROLES, ENGINE_CONFIG, LANE_ROLES } from '../engine/index.ts';
import { silentLogger } from '../logger.ts';
import { refreshStats } from '../stats/refresh.ts';
import * as repo from '../stats/repository.ts';
import { API_TEST_DATABASE_URL, resetApiTestDb, seedSyntheticPatch } from '../testing/seed.ts';
import { type GenerateOptions, generateMatches, PLANTED } from '../testing/synthetic.ts';
import { createApp } from './app.ts';
import { TtlCache } from './cache.ts';
import { TokenBucketLimiter } from './rate-limit.ts';

const CUR = '15.22';
const PREV = '15.21';
const SEEDS: Record<string, GenerateOptions> = {
  [PREV]: { patch: PREV, count: 800, seed: 11 },
  [CUR]: { patch: CUR, count: 3000, seed: 12, pickWeights: { [PLANTED.rareOnCurrent]: 0.05 } },
};

type FrameKey = 'goldByMinute' | 'xpByMinute' | 'csByMinute';

/**
 * Lane-phase averages recomputed in TypeScript from the generated frames (independent of the
 * SQL view): own lane minus the opponent's (bot lane 2v2) at 10 and 15 min, non-remakes only.
 */
function expectedLane(
  patches: readonly string[],
  championId: number,
  position: Position,
  enemyId: number,
  enemyPosition: Position,
) {
  const bot = (p: Position | null) => p === 'BOTTOM' || p === 'UTILITY';
  const inLane = (p: Position | null) => (bot(position) ? bot(p) : p === position);
  const acc = { games: 0, gold10: 0, xp10: 0, cs10: 0, games15: 0, gold15: 0 };
  for (const patch of patches) {
    for (const m of generateMatches(SEEDS[patch] as GenerateOptions)) {
      if (m.match.isRemake) continue;
      const own = m.participants.find(
        (p) => p.championId === championId && p.position === position,
      );
      const opp = m.participants.find(
        (p) => p.championId === enemyId && p.position === enemyPosition && p.teamId !== own?.teamId,
      );
      if (!own || !opp) continue;
      const total = (teamId: number, key: FrameKey, minute: number) =>
        m.participants
          .filter((p) => p.teamId === teamId && inLane(p.position))
          .reduce((s, p) => s + (p[key][minute] ?? Number.NaN), 0);
      const diff = (key: FrameKey, minute: number) =>
        total(own.teamId, key, minute) - total(opp.teamId, key, minute);
      if (Number.isNaN(diff('goldByMinute', 10))) continue;
      acc.games++;
      acc.gold10 += diff('goldByMinute', 10);
      acc.xp10 += diff('xpByMinute', 10);
      acc.cs10 += diff('csByMinute', 10);
      if (!Number.isNaN(diff('goldByMinute', 15))) {
        acc.games15++;
        acc.gold15 += diff('goldByMinute', 15);
      }
    }
  }
  return {
    games: acc.games,
    gold10: acc.gold10 / acc.games,
    xp10: acc.xp10 / acc.games,
    cs10: acc.cs10 / acc.games,
    games15: acc.games15,
    gold15: acc.gold15 / acc.games15,
  };
}

/** `x * n / (n + k)` with the lane-phase prior, as the API rounds it. */
const shrunkLane = (x: number, n: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(((x * n) / (n + ENGINE_CONFIG.lanePhase.shrinkK)) * f) / f;
};

describe.skipIf(!API_TEST_DATABASE_URL)('API endpoints (Postgres)', () => {
  let db: Db;
  let cache: TtlCache<unknown>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await resetApiTestDb();
    db = createDb(API_TEST_DATABASE_URL as string, { max: 8 });
    await seedSyntheticPatch(db, SEEDS[PREV] as GenerateOptions);
    await seedSyntheticPatch(db, SEEDS[CUR] as GenerateOptions);
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
    // Shrunk with k = 1,200: lane matchup effects are small.
    expect(reason?.delta).toBeGreaterThan(0.01);
    expect(reason?.games).toBeGreaterThan(50);
    expect(reason?.label).toMatch(
      /^\+\d+\.\d% vs Janna compared with other supports \(likely lane, support, [\d,]+ games\)$/,
    );
  });

  test('picks: duo synergy and previous patch added for a rare pick', async () => {
    const res = await post('/recommendations/picks', {
      role: 'UTILITY',
      allies: [{ championId: PLANTED.duo.allyId, role: 'BOTTOM' }],
    });
    const body = (await res.json()) as PicksResponse;
    const lulu = body.candidates.find((c) => c.championId === PLANTED.duo.championId);
    const duo = lulu?.reasons.find((r) => r.kind === 'duo');
    expect(duo?.delta).toBeGreaterThan(0);
    expect(body.candidates.slice(0, 2).map((c) => c.championId)).toContain(PLANTED.duo.championId);

    const braum = body.candidates.find((c) => c.championId === PLANTED.rareOnCurrent);
    expect(braum?.patchesUsed).toEqual([CUR, PREV]);
    expect(braum?.reasons[0]?.kind).toBe('patch_fallback');
  });

  test('draft: win probability, reasons and damage of a partial draft', async () => {
    const res = await post('/recommendations/draft', {
      allies: [
        { championId: PLANTED.matchup.championId, role: 'UTILITY' },
        { championId: 222, role: 'BOTTOM' },
      ],
      enemies: [{ championId: PLANTED.matchup.opponentId, role: null }],
      side: 'red',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftEvaluationResponse;
    expect(body.patch).toBe(CUR);
    expect(body.winProbability).toBeGreaterThan(0.05);
    expect(body.winProbability).toBeLessThan(0.95);
    const kinds = new Set(body.reasons.map((r) => r.kind));
    expect(kinds.has('base')).toBe(true);
    expect(kinds.has('side')).toBe(true);
    // The planted lane counter shows as a matchup in the allies' favour.
    const lane = body.reasons.find(
      (r) => r.kind === 'matchup' && r.championIds?.[1] === PLANTED.matchup.opponentId,
    );
    expect(lane?.delta).toBeGreaterThan(0);
    expect(body.damage.allies.champions).toHaveLength(2);
    const { physical, magic } = body.damage.allies;
    expect(physical + magic).toBeGreaterThan(0);
    expect(body.damage.enemies.champions.map((c) => c.championId)).toEqual([
      PLANTED.matchup.opponentId,
    ]);
    // Same draft in another order: the same answer (cache key ignores the order).
    const again = await post('/recommendations/draft', {
      allies: [
        { championId: 222, role: 'BOTTOM' },
        { championId: PLANTED.matchup.championId, role: 'UTILITY' },
      ],
      enemies: [{ championId: PLANTED.matchup.opponentId, role: null }],
      side: 'red',
    });
    expect(((await again.json()) as DraftEvaluationResponse).winProbability).toBe(
      body.winProbability,
    );
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

  test('item choices with the duo partner and with ally traits (0012 views)', async () => {
    const { championId, allyId } = PLANTED.duo;
    // Every synthetic team has all five positions: the item rows of a support, summed over its
    // bot partners, are exactly its item rows in stats_choices.
    const duos = await db<{ kind: string; choice: string; games: number; total: number | null }[]>`
      SELECT d.kind, d.choice, sum(d.games)::int AS games, max(c.games) AS total
      FROM stats_choice_duos d
      LEFT JOIN stats_choices c
        ON c.patch = d.patch AND c.champion_id = d.champion_id AND c.position = d.position
       AND c.kind = d.kind AND c.choice = d.choice
      WHERE d.patch = ${CUR} AND d.champion_id = ${championId} AND d.position = 'UTILITY'
      GROUP BY d.kind, d.choice, d.partner_position`;
    expect(duos.length).toBeGreaterThan(0);
    expect(duos.some((r) => r.kind === 'items_done')).toBe(true);
    for (const r of duos) {
      expect(['item', 'items_done']).toContain(r.kind);
      expect(r.games).toBe(r.total ?? -1);
    }
    const partners = await db<{ position: string }[]>`
      SELECT DISTINCT partner_position AS position FROM stats_choice_duos
      WHERE patch = ${CUR} AND champion_id = ${championId} AND position = 'UTILITY'`;
    expect(partners.map((p) => p.position)).toEqual(['BOTTOM']);
    const withPartner = await repo.loadChoiceDuos(db, [CUR], championId, 'UTILITY', [allyId]);
    expect(withPartner.length).toBeGreaterThan(0);

    // Ally traits: items (and the build stage), each within the champion's games with that trait and its item rows.
    const traits = await db<
      { kind: string; trait: string; games: number; item_games: number; trait_games: number }[]
    >`
      SELECT t.kind, t.trait, t.games, c.games AS item_games, ct.games AS trait_games
      FROM stats_choice_ally_traits t
      JOIN stats_choices c
        ON c.patch = t.patch AND c.champion_id = t.champion_id AND c.position = t.position
       AND c.kind = t.kind AND c.choice = t.choice
      JOIN stats_champion_comp_traits ct
        ON ct.patch = t.patch AND ct.champion_id = t.champion_id AND ct.position = t.position
       AND ct.side = 'ally' AND ct.trait = t.trait
      WHERE t.patch = ${CUR} AND t.position = 'UTILITY'`;
    expect(traits.length).toBeGreaterThan(0);
    for (const r of traits) {
      expect(['item', 'items_done']).toContain(r.kind);
      expect(r.games).toBeLessThanOrEqual(Math.min(r.item_games, r.trait_games));
    }

    // The build reads them: situational duo / ally-trait reasons name the partner / the trait.
    const res = await post('/recommendations/build', {
      championId,
      role: 'UTILITY',
      allies: [
        { championId: allyId, role: 'BOTTOM' },
        { championId: 19, role: 'JUNGLE' },
        { championId: 103, role: null },
      ],
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as BuildResponse;
    const reasons = [...b.items.core, ...b.items.situational].flatMap((i) => i.reasons);
    for (const r of reasons.filter((x) => x.kind === 'duo')) {
      expect(r.championIds).toEqual([allyId]);
    }
    for (const r of reasons.filter((x) => x.kind === 'with_comp')) {
      expect(r.trait).toBeDefined();
    }
  });

  test('build: support quest upgrade from the end-of-game inventory, supports only', async () => {
    const res = await post('/recommendations/build', { championId: 89, role: 'UTILITY' });
    const b = (await res.json()) as BuildResponse;
    // Leona (engage) ends with Celestial Opposition in 7 synthetic matches out of 8.
    expect(b.items.questUpgrade?.itemId).toBe(3869);
    const base = b.items.questUpgrade?.reasons.find((r) => r.kind === 'base');
    expect(base?.games).toBeGreaterThan(b.games / 2);
    expect(base?.label).toStartWith('Most played quest upgrade (Celestial Opposition)');
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

  test('champion ids beyond the smallint columns: 404 when requested, ignored in lists', async () => {
    for (const id of [40_000, 3_000_000_000]) {
      const build = await post('/recommendations/build', { championId: id, role: 'UTILITY' });
      expect(build.status).toBe(404);
      expect(((await build.json()) as ApiErrorResponse).error.code).toBe('NOT_FOUND');
      for (const filters of ['', '&platform=KR']) {
        const detail = await get(`/tierlist/champion?role=UTILITY&championId=${id}${filters}`);
        expect(detail.status).toBe(404);
        expect(((await detail.json()) as ApiErrorResponse).error.code).toBe('NOT_FOUND');
      }

      // Inside lists they are unknown champions: no data, no error.
      const picks = await post('/recommendations/picks', {
        role: 'UTILITY',
        allies: [{ championId: id, role: 'BOTTOM' }],
        enemies: [id, PLANTED.matchup.opponentId],
        bans: [id],
        availableChampionIds: [id, 412, 117],
      });
      expect(picks.status).toBe(200);
      const candidates = ((await picks.json()) as PicksResponse).candidates;
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) expect([412, 117]).toContain(c.championId);
      const enemyOnly = await post('/recommendations/picks', { role: 'BOTTOM', enemies: [id] });
      expect(enemyOnly.status).toBe(200);

      const withLists = await post('/recommendations/build', {
        championId: 222,
        role: 'BOTTOM',
        allies: [{ championId: id, role: 'UTILITY' }],
        enemies: [
          { championId: id, role: 'BOTTOM' },
          { championId: id, role: null },
        ],
      });
      expect(withLists.status).toBe(200);
      expect(((await withLists.json()) as BuildResponse).items.core.length).toBeGreaterThan(0);
    }
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
    // One support per team of the KR matches on CUR, remakes excluded.
    const [kr2] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM participants p JOIN matches m ON m.id = p.match_id
      WHERE m.platform = 'KR' AND m.patch = ${CUR} AND NOT m.is_remake AND p.position = 'UTILITY'`;
    expect(kr.roleGames).toBe(kr2?.n ?? -1);
    expect(kr.roleGames).toBeGreaterThan(1400);
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

    // Only the champion's rows are read: the same rows as the whole role's, filtered.
    const segment = { platform: 'KR' as const, minRankLevel: 1 };
    const patches = [CUR, PREV];
    const role = 'UTILITY';
    const sorted = (rows: object[]) => rows.map((r) => JSON.stringify(r)).sort();
    const vs = await repo.loadSegmentVsForRole(db, patches, role, LANE_ROLES[role], segment, 111);
    expect(vs.length).toBeGreaterThan(0);
    expect(sorted(vs)).toEqual(
      sorted(
        (await repo.loadSegmentVsForRole(db, patches, role, LANE_ROLES[role], segment)).filter(
          (r) => r.championId === 111,
        ),
      ),
    );
    const duos = await repo.loadSegmentWithForRole(
      db,
      patches,
      role,
      DUO_ROLES[role],
      segment,
      111,
    );
    expect(duos.length).toBeGreaterThan(0);
    expect(sorted(duos)).toEqual(
      sorted(
        (await repo.loadSegmentWithForRole(db, patches, role, DUO_ROLES[role], segment)).filter(
          (r) => r.championId === 111,
        ),
      ),
    );
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

  test('lane phase view: 2v2 bot lane and 1v1 averages from the timeline frames', async () => {
    const { championId, opponentId } = PLANTED.lane;
    const of = async (id: number, position: Position, enemyId: number, enemyPosition: Position) =>
      (await repo.loadLanePhaseOfChampion(db, [CUR], position, id, [enemyId])).find(
        (r) => r.enemyPosition === enemyPosition,
      );
    // Bot lane 2v2, with the planted lane bully.
    const leona = await of(championId, 'UTILITY', opponentId, 'UTILITY');
    const exp = expectedLane([CUR], championId, 'UTILITY', opponentId, 'UTILITY');
    expect(exp.games).toBeGreaterThan(50);
    expect(leona?.games).toBe(exp.games);
    expect(leona?.goldDiff10).toBeCloseTo(exp.gold10, 6);
    expect(leona?.xpDiff10).toBeCloseTo(exp.xp10, 6);
    expect(leona?.csDiff10).toBeCloseTo(exp.cs10, 6);
    expect(leona?.games15).toBe(exp.games15);
    expect(leona?.goldDiff15).toBeCloseTo(exp.gold15, 6);
    // Short timelines count at 10 min only.
    expect(exp.games15).toBeLessThan(exp.games);
    expect(leona?.goldDiff10).toBeGreaterThan(250);
    // The same lanes seen from the other side.
    const soraka = await of(opponentId, 'UTILITY', championId, 'UTILITY');
    expect(soraka?.games).toBe(leona?.games);
    expect(soraka?.goldDiff10).toBeCloseTo(-(leona?.goldDiff10 ?? 0), 6);
    // The enemy ADC is a bot lane opponent too (the same 2v2 difference, another condition).
    const vsAdc = await of(championId, 'UTILITY', 222, 'BOTTOM');
    const expAdc = expectedLane([CUR], championId, 'UTILITY', 222, 'BOTTOM');
    expect(vsAdc?.games).toBe(expAdc.games);
    expect(vsAdc?.goldDiff10).toBeCloseTo(expAdc.gold10, 6);
    // 1v1 top lane.
    const darius = await of(122, 'TOP', 86, 'TOP');
    const expTop = expectedLane([CUR], 122, 'TOP', 86, 'TOP');
    expect(darius?.games).toBe(expTop.games);
    expect(darius?.goldDiff10).toBeCloseTo(expTop.gold10, 6);
    expect(darius?.csDiff10).toBeCloseTo(expTop.cs10, 6);
    // Lane opponents only.
    const top = await repo.loadLanePhaseOfChampion(db, [CUR], 'TOP', 122);
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((r) => r.enemyPosition === 'TOP')).toBe(true);
    // The picks loader reads the same rows.
    const byEnemy = await repo.loadLanePhaseByEnemies(db, [CUR], 'UTILITY', [opponentId]);
    expect(
      byEnemy.find((r) => r.championId === championId && r.enemyPosition === 'UTILITY'),
    ).toEqual(leona);
  });

  test('lane phase in picks, build and the tier list champion detail', async () => {
    const { championId, opponentId } = PLANTED.lane;
    const res = await post('/recommendations/picks', {
      role: 'UTILITY',
      enemies: [opponentId],
      limit: 100,
    });
    const picks = (await res.json()) as PicksResponse;
    const leona = picks.candidates.find((c) => c.championId === championId);
    const kinds = leona?.reasons.map((r) => r.kind) ?? [];
    const lp = leona?.reasons[kinds.indexOf('matchup') + 1];
    const exp = expectedLane(
      leona?.patchesUsed ?? [],
      championId,
      'UTILITY',
      opponentId,
      'UTILITY',
    );
    expect(lp).toMatchObject({
      kind: 'lane_phase',
      delta: 0,
      games: exp.games,
      championIds: [opponentId],
    });
    expect(lp?.lane).toEqual({
      minute: 10,
      gold: shrunkLane(exp.gold10, exp.games),
      xp: shrunkLane(exp.xp10, exp.games),
      cs: shrunkLane(exp.cs10, exp.games, 1),
      duo: true,
      games: exp.games,
    });
    expect(lp?.label).toMatch(
      /^Lane at 10 min vs Soraka: \+[\d,]+ gold, .+ \(bot lane 2v2, likely support, [\d,]+ matchups\)$/,
    );
    const withLane = picks.candidates.filter((c) => c.reasons.some((r) => r.kind === 'lane_phase'));
    expect(withLane.length).toBeGreaterThan(3);

    const build = (await (
      await post('/recommendations/build', {
        championId: opponentId,
        role: 'UTILITY',
        enemies: [{ championId, role: 'UTILITY' }],
      })
    ).json()) as BuildResponse;
    expect(build.lanePhase?.map((r) => r.lane?.minute)).toEqual([10, 15]);
    const [at10, at15] = build.lanePhase ?? [];
    expect(at10?.label).toContain('vs Leona');
    expect(at10?.lane?.gold).toBeLessThan(0);
    expect(at15?.lane?.gold).toBeLessThan(0);
    expect(at15?.games).toBeLessThan(at10?.games ?? 0);
    const alone = await post('/recommendations/build', { championId: opponentId, role: 'UTILITY' });
    expect((await alone.json()) as BuildResponse).not.toHaveProperty('lanePhase');

    const url = `/tierlist/champion?role=UTILITY&championId=${opponentId}`;
    const detail = (await (await get(url)).json()) as TierListChampionResponse;
    const vsLeona = detail.matchups.find(
      (m) => m.championId === championId && m.role === 'UTILITY',
    );
    const expDetail = expectedLane(
      detail.patchesUsed,
      opponentId,
      'UTILITY',
      championId,
      'UTILITY',
    );
    expect(vsLeona?.lane).toEqual({
      minute: 10,
      gold: shrunkLane(expDetail.gold10, expDetail.games),
      xp: shrunkLane(expDetail.xp10, expDetail.games),
      cs: shrunkLane(expDetail.cs10, expDetail.games, 1),
      duo: true,
      games: expDetail.games,
    });
    expect(detail.matchups.filter((m) => m.lane).length).toBeGreaterThan(3);
    const filtered = (await (await get(`${url}&platform=KR`)).json()) as TierListChampionResponse;
    expect(filtered.matchups.length).toBeGreaterThan(0);
    expect(filtered.matchups.some((m) => m.lane)).toBe(false);
  });

  test('stats refresh is skipped when matches did not change', async () => {
    const r = await refreshStats(db);
    expect(r.reason).toBe('unchanged');
  });
});
