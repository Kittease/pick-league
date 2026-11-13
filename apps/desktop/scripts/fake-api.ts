/**
 * Dev-only fake PickLeague API: serves contract-shaped responses (see
 * packages/shared/src/api-contract.ts) with deterministic, made-up numbers, so the desktop app
 * can be run end to end without Postgres, the worker or the real API.
 *
 *   bun run scripts/fake-api.ts            # http://localhost:3000
 *   PORT=3100 bun run scripts/fake-api.ts
 *   FAKE_API_NO_DATA=1 …                   # every recommendation answers 503 NO_DATA
 *   FAKE_API_REFRESH_MS=8000 …             # duration of a simulated stats refresh (default 6 s)
 *
 * Static data comes from the live Data Dragon CDN (needs network). Numbers are NOT real stats.
 */

import {
  API_ROUTES,
  type ApiErrorCode,
  type BuildResponse,
  buildRequestSchema,
  createDdragonClient,
  type HealthResponse,
  type PickCandidate,
  type PicksResponse,
  type Position,
  picksRequestSchema,
  type Reason,
  type RecommendedItem,
  type StaticDataResponse,
  type StatsRefreshResponse,
  type StatsStatusResponse,
} from '@pick-league/shared';
import { staticResponseFromDdragon } from '../src/core/static-from-ddragon.ts';

const PORT = Number(process.env.PORT ?? 3000);
const NO_DATA = process.env.FAKE_API_NO_DATA === '1';
const LATENCY_MS = Number(process.env.FAKE_API_LATENCY_MS ?? 250);

const REFRESH_MS = Number(process.env.FAKE_API_REFRESH_MS ?? 6_000);
const REFRESH_COOLDOWN_MS = 20_000;

/**
 * Simulated stats freshness: the "worker" stores ~1 game every 2 s, the stats include what was
 * stored when the last refresh started (40 min ago at startup).
 */
const stats = {
  stored: 48_213,
  included: 47_871,
  lastRefreshedAt: new Date(Date.now() - 40 * 60_000),
  lastDurationMs: 41_250,
  refreshingUntil: 0,
};
setInterval(() => {
  stats.stored += 1;
}, 2_000);

function statsStatus(): StatsStatusResponse {
  const now = Date.now();
  if (stats.refreshingUntil && now >= stats.refreshingUntil) {
    stats.refreshingUntil = 0;
    stats.lastRefreshedAt = new Date(now);
    stats.lastDurationMs = REFRESH_MS;
  }
  return {
    refreshing: stats.refreshingUntil > 0,
    lastRefreshedAt: stats.lastRefreshedAt.toISOString(),
    lastRefreshDurationMs: stats.lastDurationMs,
    matchesIncluded: stats.included,
    matchesStored: stats.stored,
    pendingMatches: Math.max(0, stats.stored - stats.included),
  };
}

function statsRefresh(): { status: number; body: StatsRefreshResponse } {
  const s = statsStatus();
  if (s.refreshing) return { status: 200, body: { started: false, reason: 'already_running' } };
  if (s.pendingMatches === 0)
    return { status: 200, body: { started: false, reason: 'up_to_date' } };
  const since = Date.now() - stats.lastRefreshedAt.getTime();
  if (since < REFRESH_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((REFRESH_COOLDOWN_MS - since) / 1000);
    return { status: 200, body: { started: false, reason: 'cooldown', retryAfterSeconds } };
  }
  stats.included = stats.stored;
  stats.refreshingUntil = Date.now() + REFRESH_MS;
  console.log(`[fake-api] stats refresh started (${REFRESH_MS} ms)`);
  return { status: 202, body: { started: true } };
}

const ddragon = createDdragonClient();
let staticCache: Promise<StaticDataResponse> | null = null;
function getStatic(): Promise<StaticDataResponse> {
  staticCache ??= (async () => {
    const [latest] = await ddragon.getLatestPatchVersions(1);
    if (!latest) throw new Error('Data Dragon returned no versions');
    console.log(`[fake-api] static data from Data Dragon ${latest.ddragonVersion}`);
    return staticResponseFromDdragon(await ddragon.getStaticPatchData(latest.ddragonVersion));
  })();
  staticCache.catch(() => {
    staticCache = null;
  });
  return staticCache;
}

/** Deterministic pseudo-random in [0, 1). */
function rand(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

const round = (n: number, digits = 4) => Number(n.toFixed(digits));
const delta = (...seed: number[]) => round((rand(...seed) - 0.42) * 0.06);
const games = (...seed: number[]) => 40 + Math.floor(rand(...seed, 7) * 900);
const pct = (d: number) => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`;

const ROLE_TAGS: Record<Position, string[]> = {
  TOP: ['Fighter', 'Tank'],
  JUNGLE: ['Fighter', 'Assassin'],
  MIDDLE: ['Mage', 'Assassin'],
  BOTTOM: ['Marksman'],
  UTILITY: ['Support'],
};
const DUO: Partial<Record<Position, Position>> = {
  UTILITY: 'BOTTOM',
  BOTTOM: 'UTILITY',
  MIDDLE: 'JUNGLE',
  JUNGLE: 'MIDDLE',
  TOP: 'JUNGLE',
};
const ROLE_LABEL: Record<Position, string> = {
  TOP: 'top',
  JUNGLE: 'jungle',
  MIDDLE: 'mid',
  BOTTOM: 'bot',
  UTILITY: 'support',
};

function previousPatch(patch: string): string {
  const [major = 0, minor = 1] = patch.split('.').map(Number);
  return minor > 1 ? `${major}.${minor - 1}` : `${major - 1}.24`;
}

function patchOf(s: StaticDataResponse): string {
  return s.patch;
}

async function picks(body: unknown): Promise<PicksResponse> {
  const req = picksRequestSchema.parse(body);
  const s = await getStatic();
  const name = new Map(s.champions.map((c) => [c.id, c.name]));
  const taken = new Set<number>([
    ...req.bans,
    ...req.allies.flatMap((a) => (a.championId ? [a.championId] : [])),
    ...req.enemies.flatMap((e) => (e ? [e] : [])),
  ]);
  const available = req.availableChampionIds ? new Set(req.availableChampionIds) : null;
  const tags = ROLE_TAGS[req.role];
  const enemies = req.enemies.filter((e): e is number => e !== null);
  const duoRole = DUO[req.role];
  const duo = req.allies.find((a) => a.role === duoRole && a.championId)?.championId ?? null;
  // Lane opponent guess: the last enemy picked (roles are unknown in champion select).
  const laneEnemy = enemies.at(-1) ?? null;

  const candidates: PickCandidate[] = s.champions
    .filter((c) => c.tags.some((t) => tags.includes(t)))
    .filter((c) => !taken.has(c.id) && (!available || available.has(c.id)))
    .map((c) => {
      const reasons: Reason[] = [];
      if (laneEnemy) {
        const d = delta(c.id, laneEnemy, 1);
        const n = games(c.id, laneEnemy);
        reasons.push({
          kind: 'matchup',
          label: `${pct(d)} vs ${name.get(laneEnemy)} (${ROLE_LABEL[req.role]} lane, ${n} games)`,
          delta: d,
          games: n,
          championIds: [laneEnemy],
        });
      }
      if (duo) {
        const d = delta(c.id, duo, 2);
        const n = games(c.id, duo, 2);
        reasons.push({
          kind: 'duo',
          label: `${pct(d)} with ${name.get(duo)} (${n} games together)`,
          delta: d,
          games: n,
          championIds: [duo],
        });
      }
      if (enemies.length >= 2) {
        const d = delta(c.id, enemies.length, 3);
        const n = games(c.id, 3);
        const trait = rand(enemies.reduce((a, b) => a + b, 0)) > 0.5 ? 'AD_HEAVY' : 'HIGH_CC';
        reasons.push({
          kind: 'vs_comp',
          label: `${pct(d)} vs ${trait === 'AD_HEAVY' ? 'AD-heavy' : 'high-CC'} enemy team (${n} games)`,
          delta: d,
          games: n,
          trait,
        });
      }
      const allies = req.allies.filter((a) => a.championId).length;
      if (allies >= 2) {
        const d = delta(c.id, allies, 4);
        const n = games(c.id, 4);
        reasons.push({
          kind: 'with_comp',
          label: `${pct(d)} with a tanky front line (${n} games)`,
          delta: d,
          games: n,
          trait: 'TANKY',
        });
      }
      const baseGames = games(c.id, 9) * 3;
      const winRate = round(0.47 + rand(c.id, 5) * 0.07);
      reasons.push({
        kind: 'base',
        label: `${(winRate * 100).toFixed(1)}% win rate as ${ROLE_LABEL[req.role]} (${baseGames} games)`,
        delta: 0,
        games: baseGames,
      });
      const shrunk = reasons.reduce((sum, r) => sum + r.delta * (r.games / (r.games + 200)), 0);
      return {
        championId: c.id,
        score: round(shrunk + (winRate - 0.5) * 0.5),
        confidence: round(Math.min(1, baseGames / 2000)),
        patchUsed: baseGames < 300 ? previousPatch(patchOf(s)) : patchOf(s),
        games: baseGames,
        winRate,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, req.limit ?? 20);
  return { role: req.role, patch: patchOf(s), candidates };
}

function findItem(s: StaticDataResponse, ...names: string[]): number | null {
  for (const n of names) {
    const item = s.items.find((i) => i.name.toLowerCase() === n.toLowerCase());
    if (item) return item.id;
  }
  return null;
}

async function build(body: unknown): Promise<BuildResponse> {
  const req = buildRequestSchema.parse(body);
  const s = await getStatic();
  const champ = s.champions.find((c) => c.id === req.championId);
  if (!champ) throw new HttpError(404, 'NOT_FOUND', `Unknown champion ${req.championId}`);
  const name = new Map(s.champions.map((c) => [c.id, c.name]));
  const itemName = new Map(s.items.map((i) => [i.id, i.name]));
  const enemyNames = req.enemies.map((e) => name.get(e.championId)).filter(Boolean);
  const id = req.championId;
  const n = (k: number) => games(id, k) * 2;

  const item = (itemId: number | null, reasons: Reason[], replaces?: number | null) =>
    itemId === null
      ? []
      : [{ itemId, reasons, ...(replaces !== undefined ? { replacesItemId: replaces } : {}) }];
  const popular = (itemId: number | null, k: number, extra = ''): Reason[] => {
    const g = n(k);
    const share = Math.round(40 + rand(id, k) * 55);
    return [
      {
        kind: 'popularity',
        label: `${share}% of high-elo ${champ.name} buy it${extra} (${g} games)`,
        delta: 0,
        games: g,
        itemId: itemId ?? undefined,
      },
    ];
  };

  const atlas = findItem(s, 'World Atlas');
  const potion = findItem(s, 'Health Potion');
  const ward = findItem(s, 'Control Ward');
  const boots = findItem(s, 'Boots');
  const lucidity = findItem(s, 'Ionian Boots of Lucidity', 'Boots of Swiftness');
  const coreNames = [
    ['Moonstone Renewer', 'Echoes of Helia'],
    ['Redemption'],
    ['Mikael’s Blessing', "Mikael's Blessing", 'Staff of Flowing Water'],
    ['Ardent Censer', 'Dawncore'],
  ];
  const core: RecommendedItem[] = [
    ...coreNames.flatMap((names, i) => {
      const itemId = findItem(s, ...names);
      const reasons = popular(itemId, 10 + i);
      if (i === 0 && itemId) {
        const d = delta(id, itemId);
        reasons.push({
          kind: 'base',
          label: `${pct(Math.abs(d))} win rate when rushed first (${n(30)} games)`,
          delta: Math.abs(d),
          games: n(30),
          itemId,
        });
      }
      return item(itemId, reasons);
    }),
  ];
  // Boots at their usual slot (2nd).
  core.splice(1, 0, ...item(lucidity, popular(lucidity, 20, ' as 2nd item')));

  const situational: RecommendedItem[] = [];
  const antiHeal = findItem(s, 'Chemtech Putrifier', 'Oblivion Orb');
  if (antiHeal) {
    const d = round(0.012 + rand(id, 40) * 0.02);
    situational.push({
      itemId: antiHeal,
      replacesItemId: core[3]?.itemId ?? null,
      reasons: [
        {
          kind: 'item_swap',
          label: `${pct(d)} vs high-healing teams when built instead of ${itemName.get(core[3]?.itemId ?? 0) ?? 'a core item'} (${n(41)} games)`,
          delta: d,
          games: n(41),
          itemId: antiHeal,
          replacesItemId: core[3]?.itemId,
          trait: 'HIGH_HEALING',
        },
      ],
    });
  }
  const mercs = findItem(s, "Mercury's Treads");
  if (mercs) {
    situational.push({
      itemId: mercs,
      replacesItemId: lucidity,
      reasons: [
        {
          kind: 'tag_rule',
          label: `Tenacity + magic resist vs heavy crowd control${enemyNames.length ? ` (${enemyNames.slice(0, 2).join(', ')})` : ''}`,
          delta: 0,
          games: 0,
          itemId: mercs,
          replacesItemId: lucidity ?? undefined,
          trait: 'HIGH_CC',
        },
      ],
    });
  }
  const locket = findItem(s, 'Locket of the Iron Solari');
  if (locket) {
    const d = round(0.008 + rand(id, 42) * 0.015);
    situational.push({
      itemId: locket,
      replacesItemId: null,
      reasons: [
        {
          kind: 'vs_comp',
          label: `${pct(d)} vs burst-heavy teams as 4th item (${n(43)} games)`,
          delta: d,
          games: n(43),
          itemId: locket,
          trait: 'AP_HEAVY',
        },
      ],
    });
  }

  const tree = (tid: number) => s.runes.filter((r) => r.treeId === tid);
  const pickRow = (tid: number, row: number, prefer?: number) => {
    const runes = tree(tid).filter((r) => r.row === row);
    return (runes.find((r) => r.id === prefer) ?? runes[0])?.id ?? 0;
  };
  const primary = 8200; // Sorcery
  const secondary = 8400; // Resolve
  const runeIds = [
    pickRow(primary, 0, 8214), // Summon Aery
    pickRow(primary, 1, 8226), // Manaflow Band
    pickRow(primary, 2, 8210), // Transcendence
    pickRow(primary, 3, 8237), // Scorch
    pickRow(secondary, 2, 8473), // Bone Plating
    pickRow(secondary, 3, 8453), // Revitalize
  ];
  const statShardIds = [5008, 5008, 5011];
  const laneEnemy = req.enemies.at(-1)?.championId;

  const maxOrder = [1, 2, 3].sort((a, b) => rand(id, a) - rand(id, b));
  const sequence: number[] = [];
  const points: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let level = 1; level <= 18; level++) {
    let slot: number;
    if ([6, 11, 16].includes(level)) slot = 4;
    else if (level <= 3) slot = maxOrder[level - 1] ?? 1;
    else slot = maxOrder.find((k) => (points[k] ?? 0) < 5) ?? 1;
    points[slot] = (points[slot] ?? 0) + 1;
    sequence.push(slot);
  }

  const patchUsed = patchOf(s);
  return {
    championId: id,
    role: req.role,
    patchUsed,
    games: n(1) * 3,
    confidence: round(Math.min(1, (n(1) * 3) / 2000)),
    items: {
      starting: [
        ...item(atlas, popular(atlas, 50, ' first')),
        ...item(potion, popular(potion, 51, ' with World Atlas')),
      ],
      early: [
        ...item(ward, popular(ward, 52, ' on first back')),
        ...item(boots, popular(boots, 53, ' on first back')),
      ],
      core,
      situational,
    },
    runes: {
      primaryTreeId: primary,
      secondaryTreeId: secondary,
      runeIds,
      statShardIds,
      selectedPerkIds: [...runeIds, ...statShardIds],
      games: n(60),
      winRate: round(0.5 + rand(id, 61) * 0.04),
      reasons: [
        {
          kind: 'popularity',
          label: `Most played page on ${champ.name} ${ROLE_LABEL[req.role]} (${Math.round(30 + rand(id, 62) * 40)}% of ${n(60)} games)`,
          delta: 0,
          games: n(60),
        },
        ...(laneEnemy
          ? [
              {
                kind: 'matchup' as const,
                label: `Bone Plating secondary: ${pct(0.014)} vs ${name.get(laneEnemy)} (${games(id, laneEnemy)} games)`,
                delta: 0.014,
                games: games(id, laneEnemy),
                championIds: [laneEnemy],
              },
            ]
          : []),
      ],
    },
    summonerSpells: {
      spellIds: [4, 3],
      games: n(70),
      winRate: round(0.5 + rand(id, 71) * 0.03),
      reasons: [
        {
          kind: 'popularity',
          label: `Flash + Exhaust in ${Math.round(55 + rand(id, 72) * 35)}% of ${n(70)} games`,
          delta: 0,
          games: n(70),
        },
        ...(enemyNames.length
          ? [
              {
                kind: 'vs_comp' as const,
                label: `${pct(0.011)} with Exhaust vs dive threats (${n(73)} games)`,
                delta: 0.011,
                games: n(73),
                trait: 'MELEE_HEAVY' as const,
              },
            ]
          : []),
      ],
    },
    skillOrder: {
      firstLevels: sequence.slice(0, 3),
      maxOrder,
      sequence,
      games: n(80),
      winRate: round(0.5 + rand(id, 81) * 0.03),
      reasons: [
        {
          kind: 'popularity',
          label: `Most common order in ${n(80)} games`,
          delta: 0,
          games: n(80),
        },
      ],
    },
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    await Bun.sleep(LATENCY_MS);
    try {
      if (route === `GET ${API_ROUTES.health}`) {
        const s = await getStatic().catch(() => null);
        const health: HealthResponse = {
          ok: true,
          db: true,
          latestPatch: s?.patch ?? null,
          matchCount: NO_DATA ? 0 : stats.stored,
        };
        return json(health);
      }
      if (route === `GET ${API_ROUTES.statsStatus}`) return json(statsStatus());
      if (route === `POST ${API_ROUTES.statsRefresh}`) {
        const { status, body } = statsRefresh();
        return json(body, status);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/static/')) {
        return json(await getStatic());
      }
      if (
        request.method === 'POST' &&
        (route.endsWith(API_ROUTES.picks) || route.endsWith(API_ROUTES.build))
      ) {
        if (NO_DATA) throw new HttpError(503, 'NO_DATA', 'No match data ingested yet');
        const body = await request.json();
        const res = route.endsWith(API_ROUTES.picks) ? await picks(body) : await build(body);
        return json(res);
      }
      throw new HttpError(404, 'NOT_FOUND', `No route ${route}`);
    } catch (e) {
      if (e instanceof HttpError)
        return json({ error: { code: e.code, message: e.message } }, e.status);
      if (e && typeof e === 'object' && 'issues' in e) {
        console.warn(`[fake-api] 400 ${route}`, (e as { issues: unknown }).issues);
        return json(
          {
            error: {
              code: 'BAD_REQUEST',
              message: 'Invalid body',
              details: (e as { issues: unknown }).issues,
            },
          },
          400,
        );
      }
      console.error('[fake-api] 500', e);
      return json({ error: { code: 'INTERNAL', message: String(e) } }, 500);
    }
  },
});

console.log(`[fake-api] listening on http://localhost:${PORT}${NO_DATA ? ' (NO_DATA mode)' : ''}`);
