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
import {
  type GenerateOptions,
  generateMatches,
  PLANTED,
  syntheticStaticData,
} from '../testing/synthetic.ts';
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
/** Games of a champion+role on the current and previous patches (stats_champion_roles). */
async function roleGamesOf(
  q: Db,
  championId: number,
  position = 'UTILITY',
): Promise<{ cur: number; prev: number }> {
  const rows = await q<{ patch: string; games: number }[]>`
    SELECT patch, games FROM stats_champion_roles
    WHERE champion_id = ${championId} AND position = ${position} AND patch IN ${q([CUR, PREV])}`;
  const of = (patch: string) => rows.find((r) => r.patch === patch)?.games ?? 0;
  return { cur: of(CUR), prev: of(PREV) };
}

/** Share of the effective games that comes from the previous patch, with a prior capped at `cap`. */
const previousShare = ({ cur, prev }: { cur: number; prev: number }, cap: number) => {
  const fromPrev = prev > 0 ? Math.min(1, cap / prev) * prev : 0;
  return cur + fromPrev > 0 ? fromPrev / (cur + fromPrev) : 0;
};

const shrunkLane = (x: number, n: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(((x * n) / (n + ENGINE_CONFIG.lanePhase.shrinkK)) * f) / f;
};

type GamesWinsCount = { games: number; wins: number };

/**
 * Early / late profile of every champion of `position`, recomputed in TypeScript from the
 * generated matches of both patches (independent of the SQL view and of the engine module).
 */
function expectedGameLength(position: Position) {
  const bucketOf = (s: number) => (s < 1500 ? 0 : s < 1920 ? 1 : 2);
  const empty = (): GamesWinsCount[] => [0, 1, 2].map(() => ({ games: 0, wins: 0 }));
  const own = new Map<number, GamesWinsCount[]>();
  const role = empty();
  for (const patch of [CUR, PREV]) {
    for (const m of generateMatches(SEEDS[patch] as GenerateOptions)) {
      if (m.match.isRemake) continue;
      const b = bucketOf(m.match.durationS);
      for (const p of m.participants) {
        if (p.position !== position) continue;
        const c = own.get(p.championId) ?? empty();
        own.set(p.championId, c);
        for (const acc of [c[b], role[b]] as GamesWinsCount[]) {
          acc.games++;
          if (p.win) acc.wins++;
        }
      }
    }
  }
  const { shrinkK, minGames } = ENGINE_CONFIG.gameLength;
  const sum = (x: GamesWinsCount[]) => ({
    games: x.reduce((s, y) => s + y.games, 0),
    wins: x.reduce((s, y) => s + y.wins, 0),
  });
  const R = sum(role);
  const out = new Map<
    number,
    { early: number | null; late: number | null; earlyGames: number; lateGames: number }
  >();
  for (const [championId, c] of own) {
    const N = sum(c);
    const value = (b: 0 | 2) => {
      const n = (c[b] as GamesWinsCount).games;
      const rb = role[b] as GamesWinsCount;
      if (n < minGames || N.games - n <= 0 || rb.games === 0) return null;
      const raw =
        (c[b] as GamesWinsCount).wins / n -
        rb.wins / rb.games -
        (N.wins / N.games - R.wins / R.games);
      const nEff = 1 / (1 / n + 1 / (N.games - n));
      const v = Math.round(((raw * nEff) / (nEff + shrinkK)) * 1e4) / 1e4;
      return v === 0 ? 0 : v;
    };
    out.set(championId, {
      early: value(0),
      late: value(2),
      earlyGames: (c[0] as GamesWinsCount).games,
      lateGames: (c[2] as GamesWinsCount).games,
    });
  }
  return out;
}

/**
 * Late-game swaps replayed in TypeScript from the generated item events (independent of the SQL
 * view and of the engine module): per `position|championId`, per `sold|bought`, the participants
 * who made the swap and the sum of the times (ms) of their first one.
 */
function expectedSwaps(patches: readonly string[]) {
  const completed = new Set(
    syntheticStaticData(CUR)
      .items.filter((i) => i.isCompleted)
      .map((i) => i.id),
  );
  const out = new Map<string, Map<string, { games: number; atMs: number }>>();
  let undoneSales = 0;
  for (const patch of patches) {
    for (const m of generateMatches(SEEDS[patch] as GenerateOptions)) {
      if (m.match.isRemake) continue;
      for (const p of m.participants) {
        if (p.position === null) continue;
        const events = m.itemEvents
          .filter((e) => e.participantId === p.participantId)
          .sort((x, y) => x.seq - y.seq);
        const bought = new Set<number>();
        const counted = new Set<string>();
        events.forEach((e, i) => {
          if (e.type === 'PURCHASED' && completed.has(e.itemId)) bought.add(e.itemId);
          if (e.type !== 'SOLD' || !completed.has(e.itemId) || bought.size < 6) return;
          const next = events[i + 1];
          const after = events[i + 2];
          if (next?.type === 'UNDO') undoneSales++;
          if (next?.type !== 'PURCHASED' || !completed.has(next.itemId)) return;
          if (next.itemId === e.itemId || next.atMs - e.atMs > 60_000) return;
          if (after?.type === 'UNDO' && after.itemId === next.itemId) return;
          const pair = `${e.itemId}|${next.itemId}`;
          if (counted.has(pair)) return;
          counted.add(pair);
          const key = `${p.position}|${p.championId}`;
          const pairs = out.get(key) ?? new Map<string, { games: number; atMs: number }>();
          out.set(key, pairs);
          const acc = pairs.get(pair) ?? { games: 0, atMs: 0 };
          pairs.set(pair, acc);
          acc.games++;
          acc.atMs += e.atMs;
        });
      }
    }
  }
  return { byChampion: out, undoneSales };
}

/**
 * The swaps of a champion + role as the build shows them (thresholds of `ENGINE_CONFIG`): one at a
 * time, the most frequent whose sold item is one of `shownItemIds` (the build's core items; every
 * item when omitted) or was bought by a swap picked before.
 */
function shownSwaps(
  patches: readonly string[],
  championId: number,
  position: Position,
  shownItemIds?: readonly number[],
) {
  const pairs = expectedSwaps(patches).byChampion.get(`${position}|${championId}`) ?? new Map();
  const candidates = [...pairs]
    .map(([pair, acc]) => {
      const [sellItemId = 0, buyItemId = 0] = pair.split('|').map(Number);
      return { sellItemId, buyItemId, games: acc.games, minute: acc.atMs / acc.games / 60_000 };
    })
    .filter((x) => x.games >= ENGINE_CONFIG.lateSwaps.minGames)
    .sort((x, y) => y.games - x.games || x.sellItemId - y.sellItemId || x.buyItemId - y.buyItemId);
  if (!shownItemIds) return candidates.slice(0, ENGINE_CONFIG.lateSwaps.maxShown);
  const known = new Set(shownItemIds);
  const shown: typeof candidates = [];
  while (shown.length < ENGINE_CONFIG.lateSwaps.maxShown) {
    const next = candidates.find(
      (x) => (known.has(x.sellItemId) || BOOTS.has(x.sellItemId)) && !shown.includes(x),
    );
    if (!next) break;
    shown.push(next);
    known.add(next.buyItemId);
  }
  return shown;
}

/** The boots of the synthetic loadouts: a pair of boots is always a known item for the swaps. */
const BOOTS = new Set([3006, 3020, 3047, 3111, 3158]);

/** Item ids a build response shows before its swaps: the core builds and the late items. */
const coreItemIds = (b: BuildResponse) =>
  [b.items.core, ...b.items.coreBuilds.map((c) => c.items), b.items.late]
    .flat()
    .map((item) => item.itemId);

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
    // Mastery of the champion each synthetic player played: seven levels spread by a hash; the
    // planted effect is that Leona's losers are beginners. Braum's players have no mastery row.
    await db`
      INSERT INTO champion_masteries (puuid, champion_id, level, points, last_played_at)
      SELECT p.puuid, p.champion_id, 5,
             CASE WHEN p.champion_id = 89 AND NOT p.win THEN 1000
                  ELSE (ARRAY[2000, 12000, 30000, 70000, 150000, 300000, 900000])
                         [1 + abs(hashtext(p.puuid)) % 7] END,
             now()
      FROM participants p
      WHERE p.champion_id <> 201`;
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
      patchMatchCount: 3000,
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

  test('unknown route, no CORS', async () => {
    const res = await get('/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErrorResponse).error.code).toBe('NOT_FOUND');
    const pre = await app.request('/recommendations/picks', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
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
    // Shrunk with k = 600: lane matchup effects are small.
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
    // The patch reason follows the previous patch's share of his effective games.
    const games = await roleGamesOf(db, PLANTED.rareOnCurrent);
    const share = previousShare(games, ENGINE_CONFIG.previousPatchPrior.strength);
    expect(games.prev).toBeGreaterThan(0);
    expect(braum?.reasons[0]?.kind === 'patch_fallback').toBe(
      share >= ENGINE_CONFIG.previousPatchPrior.reasonShare,
    );
  });

  test('build: both patches summed through the weighted loaders', async () => {
    const championId = PLANTED.runeMatchup.championId;
    const games = await roleGamesOf(db, championId);
    expect(games.cur).toBeGreaterThan(0);
    expect(games.prev).toBeGreaterThan(0);
    expect(games.prev).toBeLessThan(ENGINE_CONFIG.previousPatchPrior.build);
    const res = await post('/recommendations/build', {
      championId,
      role: 'UTILITY',
      allies: [],
      enemies: [],
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as BuildResponse;
    // Weight 1 under the cap: the two patches' games summed.
    expect(b.games).toBe(games.cur + games.prev);
    const starter = b.items.starting[0];
    expect(starter).toBeDefined();
    const starterGames = Math.max(...(starter?.reasons ?? []).map((r) => r.games));
    expect(starterGames).toBeGreaterThan(0);
    expect(starterGames).toBeLessThanOrEqual(b.games);
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
    // With the platform, the side edge is that platform's (not served from the cache above).
    const sideLabel = async (platform: string) => {
      const r = await post('/recommendations/draft', {
        allies: [],
        enemies: [],
        side: 'red',
        platform,
      });
      return r.status === 200
        ? ((await r.json()) as DraftEvaluationResponse).reasons.find((x) => x.kind === 'side')
            ?.label
        : r.status;
    };
    expect(body.reasons.find((r) => r.kind === 'side')?.label).toMatch(/ of matches on /);
    expect(await sideLabel('EUW1')).toMatch(/ of EUW1 matches on /);
    expect(await sideLabel('OC1')).toBe(400);
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
    const games = await roleGamesOf(db, PLANTED.runeMatchup.championId);
    expect(b.patchesUsed).toEqual(
      previousShare(games, ENGINE_CONFIG.previousPatchPrior.build) >= 0.1 ? [CUR, PREV] : [CUR],
    );
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
    const withPartner = await repo.loadChoiceDuos(
      db,
      [{ patch: CUR, weight: 1 }],
      championId,
      'UTILITY',
      [allyId],
    );
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
    for (const e of body.entries) {
      expect(e.banRate).toBeGreaterThan(0);
      expect(e.banRate).toBeLessThan(1);
      expect(e.confidence).toBeGreaterThan(0);
    }
    // Every previous-patch record is under the cap here (weight 1): games are the plain sum over
    // the patches the champion has games on, and the pick rate is two players per role per match:
    // games over half the role's games of those patches.
    const [roleTotals] = await db<{ cur: number; prev: number }[]>`
      SELECT coalesce(sum(games) FILTER (WHERE patch = ${CUR}), 0)::int AS cur,
             coalesce(sum(games) FILTER (WHERE patch = ${PREV}), 0)::int AS prev
      FROM stats_champion_roles WHERE position = 'UTILITY'`;
    for (const e of body.entries) {
      const g = await roleGamesOf(db, e.championId);
      expect(g.prev).toBeLessThan(ENGINE_CONFIG.previousPatchPrior.strength);
      expect(e.games).toBe(g.cur + g.prev);
      const roleGames = (roleTotals?.cur ?? 0) + (g.prev > 0 ? (roleTotals?.prev ?? 0) : 0);
      expect(e.pickRate).toBeCloseTo((2 * e.games) / roleGames, 3);
    }

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
    expect(body.filters).toEqual({ platform: 'ALL', rank: 'DIAMOND' });
    const explicit = await get('/tierlist?role=BOTTOM&patch=latest&platform=ALL&rank=DIAMOND');
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
    expect(kr.filters).toEqual({ platform: 'KR', rank: 'DIAMOND' });
    // One support per team of the KR matches on CUR, remakes excluded.
    const [kr2] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM participants p JOIN matches m ON m.id = p.match_id
      WHERE m.platform = 'KR' AND m.patch = ${CUR} AND NOT m.is_remake AND p.position = 'UTILITY'`;
    expect(kr.roleGames).toBe(kr2?.n ?? -1);
    expect(kr.roleGames).toBeGreaterThan(1400);
    expect(byServer.reduce((s, t) => s + t.roleGames, 0)).toBe(all.roleGames);
    expect(kr.entries.length).toBeGreaterThan(0);

    // Ban rate = KR matches of the patches used where it was banned / KR matches (both patches
    // fully weighted: every previous record is under the cap here).
    const e = kr.entries.find((x) => x.patchesUsed.length === 2) as TierListEntry;
    expect(e).toBeDefined();
    const [row] = await db<{ banned: number; total: number }[]>`
      SELECT count(DISTINCT b.match_id) FILTER (WHERE b.champion_id = ${e.championId})::int AS banned,
             count(DISTINCT m.id)::int AS total
      FROM matches m LEFT JOIN match_bans b ON b.match_id = m.id
      WHERE m.platform = 'KR' AND m.patch IN ${db(e.patchesUsed)} AND NOT m.is_remake`;
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
    // Master+ is a filter of its own: Diamond players and players without a rank are left out.
    const master = (await (
      await get('/tierlist?role=UTILITY&rank=MASTER')
    ).json()) as TierListResponse;
    expect(master.filters).toEqual({ platform: 'ALL', rank: 'MASTER' });
    expect(master.roleGames).toBe(await roleGames(['CHALLENGER', 'GRANDMASTER', 'MASTER']));
    expect(master.roleGames).toBeGreaterThan(gm.roleGames);

    // Fewer games per champion than unfiltered; the previous patch is still listed for some.
    const all = (await (await get('/tierlist?role=UTILITY')).json()) as TierListResponse;
    for (const e of chall.entries) {
      const full = all.entries.find((x) => x.championId === e.championId);
      expect(e.games).toBeLessThan(full?.games ?? Number.POSITIVE_INFINITY);
      expect(e.banRate).toBeGreaterThanOrEqual(0);
      expect(e.banRate).toBeLessThan(1);
    }
    expect(chall.entries.some((e) => e.patchesUsed.length > 1)).toBe(true);

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
    for (const qs of ['platform=EUW', 'platform=euw1', 'rank=EMERALD', 'rank=master']) {
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
    expect(naut.filters).toEqual({ platform: 'ALL', rank: 'DIAMOND' });
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
    expect(kr.filters).toEqual({ platform: 'KR', rank: 'DIAMOND' });
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

  test('game length view: every positioned participant of a non-remake match, once', async () => {
    const [a] = await db<{ games: number }[]>`
      SELECT sum(games)::int AS games FROM stats_champion_game_length`;
    const [b] = await db<{ games: number }[]>`
      SELECT sum(games)::int AS games FROM stats_champion_roles`;
    expect(a?.games).toBeGreaterThan(0);
    expect(a?.games).toBe(b?.games as number);
  });

  test('GET /tierlist/champion: early / late game profile, unfiltered only', async () => {
    const expected = expectedGameLength('UTILITY');
    const [championId, profile] = [...expected].sort(
      ([, x], [, y]) => y.earlyGames + y.lateGames - (x.earlyGames + x.lateGames),
    )[0] as [number, NonNullable<ReturnType<typeof expected.get>>];
    // Not vacuous: the busiest support has enough long games for a late value.
    expect(profile.late).toBeNumber();
    const url = `/tierlist/champion?role=UTILITY&championId=${championId}`;
    const res = await get(url);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as TierListChampionResponse;
    expect(detail.gameLength?.earlyGames).toBe(profile.earlyGames);
    expect(detail.gameLength?.lateGames).toBe(profile.lateGames);
    for (const key of ['early', 'late'] as const) {
      const want = profile[key];
      if (want === null) expect(detail.gameLength?.[key]).toBeNull();
      else expect(detail.gameLength?.[key] as number).toBeCloseTo(want, 4);
    }
    const filtered = (await (await get(`${url}&platform=KR`)).json()) as TierListChampionResponse;
    expect(filtered).not.toHaveProperty('gameLength');
  });

  test('draft: early / late profile of each team', async () => {
    const allies = [
      { championId: PLANTED.matchup.championId, role: 'UTILITY' as const },
      { championId: 222, role: 'BOTTOM' as const },
    ];
    const res = await post('/recommendations/draft', {
      allies,
      enemies: [{ championId: PLANTED.matchup.opponentId, role: null }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftEvaluationResponse;
    const g = body.gameLength;
    expect(g?.allies.champions).toBeLessThanOrEqual(2);
    expect(g?.enemies.champions).toBeLessThanOrEqual(1);
    const support = expectedGameLength('UTILITY').get(allies[0]?.championId as number);
    const bottom = expectedGameLength('BOTTOM').get(222);
    expect(g?.allies.early as number).toBeCloseTo((support?.early ?? 0) + (bottom?.early ?? 0), 4);
  });

  test('item swaps view: the swaps replayed from the generated events, per patch', async () => {
    for (const patch of [CUR, PREV]) {
      const { byChampion, undoneSales } = expectedSwaps([patch]);
      // Not vacuous: sales taken back exist and are not swaps.
      expect(undoneSales).toBeGreaterThan(50);
      const want = [...byChampion]
        .flatMap(([key, pairs]) =>
          [...pairs].map(([pair, acc]) => `${key}|${pair}|${acc.games}|${acc.atMs}`),
        )
        .sort();
      expect(want.length).toBeGreaterThan(20);
      const rows = await db<
        {
          position: string;
          champion_id: number;
          sold_item_id: number;
          bought_item_id: number;
          games: number;
          minute_sum: number;
        }[]
      >`SELECT * FROM stats_item_swaps WHERE patch = ${patch}`;
      const got = rows
        .map(
          (r) =>
            `${r.position}|${r.champion_id}|${r.sold_item_id}|${r.bought_item_id}|${r.games}|${Math.round(r.minute_sum * 60_000)}`,
        )
        .sort();
      expect(got).toEqual(want);
    }
  });

  test('build: late-game swaps of the champion, both patches summed, most frequent first', async () => {
    const championId = PLANTED.runeMatchup.championId;
    const body = { championId, role: 'UTILITY', allies: [], enemies: [] };
    const b = (await (await post('/recommendations/build', body)).json()) as BuildResponse;
    // Only swaps selling an item of the core builds shown, or bought by a swap before.
    const want = shownSwaps([CUR, PREV], championId, 'UTILITY', coreItemIds(b));
    // Not vacuous: Leona's supports swap their boots both ways, and the previous patch counts.
    expect(want.length).toBeGreaterThanOrEqual(2);
    expect(want[0]?.games).toBeGreaterThan(shownSwaps([CUR], championId, 'UTILITY')[0]?.games ?? 0);
    expect(b.items.lateSwaps.map(({ minute: _, ...x }) => x)).toEqual(
      want.map(({ minute: _, ...x }) => x),
    );
    for (const [i, swap] of b.items.lateSwaps.entries()) {
      // The contract: the pair, its games and its minute, nothing to score with.
      expect(Object.keys(swap).sort()).toEqual(['buyItemId', 'games', 'minute', 'sellItemId']);
      expect(swap.minute).toBeCloseTo(want[i]?.minute ?? Number.NaN, 1);
      expect(swap.minute).toBe(Math.round(swap.minute * 10) / 10);
    }
    // The draft only matters through the core builds it shows; a forced patch reads that patch
    // only.
    const drafted = (await (
      await post('/recommendations/build', {
        ...body,
        enemies: [{ championId: PLANTED.runeMatchup.opponentId, role: 'UTILITY' }],
      })
    ).json()) as BuildResponse;
    expect(drafted.items.lateSwaps.map((x) => [x.sellItemId, x.buyItemId, x.games])).toEqual(
      shownSwaps([CUR, PREV], championId, 'UTILITY', coreItemIds(drafted)).map((x) => [
        x.sellItemId,
        x.buyItemId,
        x.games,
      ]),
    );
    const forced = (await (
      await post('/recommendations/build', { ...body, patch: PREV })
    ).json()) as BuildResponse;
    expect(forced.items.lateSwaps.map((x) => [x.sellItemId, x.buyItemId, x.games])).toEqual(
      shownSwaps([PREV], championId, 'UTILITY', coreItemIds(forced)).map((x) => [
        x.sellItemId,
        x.buyItemId,
        x.games,
      ]),
    );
  });

  test('build: no late-game swaps for a champion with too few of them', async () => {
    const championId = PLANTED.rareOnCurrent;
    expect(shownSwaps([CUR], championId, 'UTILITY')).toEqual([]);
    const res = await post('/recommendations/build', {
      championId,
      role: 'UTILITY',
      allies: [],
      enemies: [],
      patch: CUR,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as BuildResponse).items.lateSwaps).toEqual([]);
  });

  test("mastery view: games by the player's mastery of the champion", async () => {
    const rows = await repo.loadMasteryRows(db, [CUR]);
    const leona = rows.filter((r) => r.championId === 89 && r.position === 'UTILITY');
    const [expected] = await db<{ games: number; wins: number }[]>`
      SELECT count(*)::int AS games, count(*) FILTER (WHERE p.win)::int AS wins
      FROM participants p
      JOIN matches m ON m.id = p.match_id
      JOIN champion_masteries cm ON cm.puuid = p.puuid AND cm.champion_id = p.champion_id
      WHERE m.patch = ${CUR} AND NOT m.is_remake AND p.champion_id = 89
        AND p.position = 'UTILITY' AND cm.points < 5000`;
    const bucket0 = leona.find((r) => r.bucket === 0);
    expect(expected?.games).toBeGreaterThan(0);
    expect(bucket0).toMatchObject({ games: expected?.games, wins: expected?.wins });
    // Every Leona player has a mastery row: her buckets add up to her games.
    const roleStats = await repo.loadRoleStats(db, [CUR]);
    const leonaGames = roleStats.find(
      (r) => r.championId === 89 && r.position === 'UTILITY',
    )?.games;
    expect(leona.reduce((s, r) => s + r.games, 0)).toBe(leonaGames ?? -1);
    // Braum's players have no mastery row: left out.
    const all = await repo.loadMasteryRows(db, [CUR, PREV]);
    expect(all.some((r) => r.championId === PLANTED.rareOnCurrent)).toBe(false);
    for (const r of all) {
      expect(r.bucket).toBeGreaterThanOrEqual(0);
      expect(r.bucket).toBeLessThanOrEqual(6);
      expect(r.wins).toBeLessThanOrEqual(r.games);
    }
  });

  test("picks: the player's mastery moves the ranking, with a reason", async () => {
    const body = { role: 'UTILITY', enemies: [], bans: [], limit: 100 };
    const pick = async (extra: object) =>
      (await (await post('/recommendations/picks', { ...body, ...extra })).json()) as PicksResponse;
    const masteryOf = (r: PicksResponse, id: number) =>
      r.candidates.find((c) => c.championId === id)?.reasons.filter((x) => x.kind === 'mastery');

    const without = await pick({});
    expect(without.candidates.some((c) => c.reasons.some((r) => r.kind === 'mastery'))).toBe(false);

    const sizeBefore = cache.size;
    const low = await pick({ masteries: [{ championId: 89, points: 1000 }] });
    const high = await pick({ masteries: [{ championId: 89, points: 900_000 }] });
    expect(cache.size).toBe(sizeBefore + 2);

    const lowReasons = masteryOf(low, 89) ?? [];
    const highReasons = masteryOf(high, 89) ?? [];
    expect(lowReasons).toHaveLength(1);
    expect(highReasons).toHaveLength(1);
    const lowDelta = lowReasons[0]?.delta ?? Number.NaN;
    const highDelta = highReasons[0]?.delta ?? Number.NaN;
    expect(lowDelta).toBeLessThan(0);
    expect(highDelta - lowDelta).toBeGreaterThan(0.02);
    // Leona support has well over 100 games under 5k points on the seed: her own sample.
    expect(lowReasons[0]?.games).toBeGreaterThanOrEqual(ENGINE_CONFIG.mastery.minChampionGames);
    expect(lowReasons[0]?.label).toMatch(
      /^−\d+\.\d% at your mastery \(1k points\): Leona players with under 5k points vs Leona's average \([\d,]+ games\)$/,
    );

    // Braum has no mastery rows of his own: the curve of every champion.
    const braum = masteryOf(low, PLANTED.rareOnCurrent);
    expect(braum).toHaveLength(1);
    expect(braum?.[0]?.label).toMatch(
      /^[+−]?\d+\.\d% at your mastery \(no points yet\): players with under 5k points on their champion vs its average \(all champions, [\d,]+ games\)$/,
    );

    // The mastery term is added to the score as is.
    for (const answer of [low, high]) {
      for (const c of answer.candidates) {
        const before = without.candidates.find((x) => x.championId === c.championId);
        if (!before) continue;
        const delta = c.reasons.find((r) => r.kind === 'mastery')?.delta ?? Number.NaN;
        expect(c.score - before.score).toBeCloseTo(delta, 3);
      }
    }
  });

  test('stats refresh is skipped when matches did not change', async () => {
    const r = await refreshStats(db);
    expect(r.reason).toBe('unchanged');
  });
});
