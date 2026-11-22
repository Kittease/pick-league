/**
 * stats_item_swaps (0022_item_swaps.sql): the rules of a late-game swap, on hand-written item
 * events. Needs DATABASE_URL_TEST (bun run db:test:up); uses its own database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createDb,
  type Db,
  insertParsedMatch,
  type ParsedItemEvent,
  type ParsedMatch,
  upsertPatchStaticData,
} from '@pick-league/db';
import { resetApiTestDb, withDatabase } from '../testing/seed.ts';
import { generateMatches, syntheticStaticData } from '../testing/synthetic.ts';
import { refreshStats, STATS_REFRESH_ORDER } from './refresh.ts';
import { loadItemSwaps } from './repository.ts';

const BASE = process.env.DATABASE_URL_TEST;
const URL_ = BASE
  ? withDatabase(BASE, process.env.API_SWAPS_TEST_DATABASE ?? 'pickleague_api_swaps_test')
  : undefined;
const PATCH = '15.22';

// Synthetic items: two pairs of completed boots, completed items, a component, a consumable.
const STEELCAPS = 3047;
const MERCS = 3111;
const BOOTS_COMPONENT = 1001;
const POTION = 2003;
const VISAGE = 3065;
const DEATHCAP = 3089;
/** Five completed items; with the boots, a full build. */
const CORE = [3078, 3053, 6333, 3071, VISAGE] as const;

const MIN = 60_000;

type Step =
  | { type: 'PURCHASED' | 'SOLD'; itemId: number; atMs: number }
  /** UNDO of a purchase (`itemId`) or of a sale (`saleOf`). */
  | { type: 'UNDO'; itemId: number; saleOf?: number; atMs: number };

const buy = (itemId: number, atMs: number): Step => ({ type: 'PURCHASED', itemId, atMs });
const sell = (itemId: number, atMs: number): Step => ({ type: 'SOLD', itemId, atMs });
const undoPurchase = (itemId: number, atMs: number): Step => ({ type: 'UNDO', itemId, atMs });
const undoSale = (saleOf: number, atMs: number): Step => ({
  type: 'UNDO',
  itemId: 0,
  saleOf,
  atMs,
});

/** Boots component, first item, Steelcaps, then the rest of `core`: done by minute 26. */
function build(core: readonly number[] = CORE): Step[] {
  const [first, ...rest] = core;
  return [
    buy(BOOTS_COMPONENT, 4 * MIN),
    buy(first as number, 8 * MIN),
    buy(STEELCAPS, 10 * MIN),
    ...rest.map((id, i) => buy(id, (14 + 4 * i) * MIN)),
  ];
}

/** Events of one participant; `seqStep` > 1 leaves gaps in `seq` (only its order counts). */
function eventsOf(participantId: number, steps: Step[], seqStep = 1): ParsedItemEvent[] {
  return steps.map((s, i) => ({
    participantId,
    seq: 1 + i * seqStep,
    atMs: s.atMs,
    type: s.type,
    itemId: s.itemId,
    undoAfterItemId: s.type === 'UNDO' ? (s.saleOf ?? 0) : null,
  }));
}

interface Scenario {
  what: string;
  steps: Step[];
  seqStep?: number;
  /** Swaps the view must count: sold, bought, minute of the (first) sale. */
  swaps: [sold: number, bought: number, minute: number][];
}

const T = 30 * MIN;

/** Participants 1..10 of the first match. */
const FIRST: Scenario[] = [
  {
    what: 'sale then purchase at full build, the last events of the game',
    steps: [...build(), sell(STEELCAPS, T), buy(MERCS, T + 1200)],
    swaps: [[STEELCAPS, MERCS, 30]],
  },
  {
    what: 'sale taken back (UNDO)',
    steps: [...build(), sell(STEELCAPS, T), undoSale(STEELCAPS, T + 900)],
    swaps: [],
  },
  {
    what: 'only 5 completed items bought before the sale',
    steps: [...build(CORE.slice(0, 4)), sell(STEELCAPS, T), buy(MERCS, T + 1200)],
    swaps: [],
  },
  {
    what: 'purchase undone right after',
    steps: [...build(), sell(STEELCAPS, T), buy(MERCS, T + 1200), undoPurchase(MERCS, T + 3000)],
    swaps: [],
  },
  {
    what: 'the same pair twice and its reverse: each once, at the first time',
    steps: [
      ...build(),
      sell(STEELCAPS, T),
      buy(MERCS, T + 1000),
      sell(MERCS, 33 * MIN),
      buy(STEELCAPS, 33 * MIN + 2000),
      sell(STEELCAPS, 36 * MIN),
      buy(MERCS, 36 * MIN + 1000),
    ],
    swaps: [
      [STEELCAPS, MERCS, 30],
      [MERCS, STEELCAPS, 33],
    ],
  },
  {
    what: 'purchase 61 s after the sale',
    steps: [...build(), sell(STEELCAPS, T), buy(MERCS, T + 61_000)],
    swaps: [],
  },
  {
    what: 'purchase exactly 60 s after the sale',
    steps: [...build(), sell(STEELCAPS, T), buy(MERCS, T + 60_000)],
    swaps: [[STEELCAPS, MERCS, 30]],
  },
  {
    what: 'the event after the sale buys a component',
    steps: [...build(), sell(STEELCAPS, T), buy(BOOTS_COMPONENT, T + 500), buy(MERCS, T + 1200)],
    swaps: [],
  },
  {
    what: '6 completed purchases but 5 distinct items',
    steps: [
      ...build(CORE.slice(0, 4)),
      buy(CORE[0], 27 * MIN),
      sell(STEELCAPS, T),
      buy(MERCS, T + 1200),
    ],
    swaps: [],
  },
  {
    what: 'the same item bought back, then a component sold for a completed item',
    steps: [
      ...build(),
      sell(STEELCAPS, T),
      buy(STEELCAPS, T + 1200),
      sell(BOOTS_COMPONENT, 31 * MIN),
      buy(DEATHCAP, 31 * MIN + 1000),
    ],
    swaps: [],
  },
];

/** Participants 1..6 of the second match (the others buy nothing). */
const SECOND: Scenario[] = [
  {
    what: 'same champion + role as the first match: summed',
    steps: [...build(), sell(STEELCAPS, 32 * MIN), buy(MERCS, 32 * MIN + 1200)],
    swaps: [[STEELCAPS, MERCS, 32]],
  },
  {
    what: 'sale taken back, then the real swap',
    steps: [
      ...build(),
      sell(STEELCAPS, T),
      undoSale(STEELCAPS, T + 900),
      sell(STEELCAPS, 31 * MIN),
      buy(MERCS, 31 * MIN + 1500),
    ],
    swaps: [[STEELCAPS, MERCS, 31]],
  },
  {
    what: 'participant without a position',
    steps: [...build(), sell(STEELCAPS, T), buy(MERCS, T + 1200)],
    swaps: [],
  },
  {
    what: 'gaps in seq between the sale and the purchase',
    steps: [...build(), sell(STEELCAPS, T), buy(MERCS, T + 1200)],
    seqStep: 3,
    swaps: [[STEELCAPS, MERCS, 30]],
  },
  {
    what: 'not boots, and followed by another purchase',
    steps: [
      ...build(),
      sell(VISAGE, 35 * MIN),
      buy(DEATHCAP, 35 * MIN + 1500),
      buy(POTION, 36 * MIN),
    ],
    swaps: [[VISAGE, DEATHCAP, 35]],
  },
  {
    what: 'a swap before the build is full, another one after',
    steps: [
      ...build(CORE.slice(0, 4)),
      sell(STEELCAPS, 27 * MIN),
      buy(MERCS, 27 * MIN + 1000),
      buy(VISAGE, 29 * MIN),
      sell(MERCS, 34 * MIN),
      buy(STEELCAPS, 34 * MIN + 1000),
    ],
    swaps: [[MERCS, STEELCAPS, 34]],
  },
];

/** Participant 1 of the third match, a remake. */
const REMAKE: Scenario = {
  what: 'remake',
  steps: [...build(), sell(STEELCAPS, T), buy(MERCS, T + 1200)],
  swaps: [],
};

describe.skipIf(!URL_)('stats_item_swaps (Postgres)', () => {
  let db: Db;
  const matches = generateMatches({ patch: PATCH, count: 3, seed: 7, idPrefix: 'SYN_SWAPS' });
  const [first, second, third] = matches as [ParsedMatch, ParsedMatch, ParsedMatch];
  const plan: [ParsedMatch, Scenario[]][] = [
    [first, FIRST],
    [second, SECOND],
    [third, [REMAKE]],
  ];

  /** Expected view rows, from the scenarios: `position|champion|sold|bought` → games, minutes. */
  const expected = () => {
    const rows = new Map<string, { games: number; minuteSum: number }>();
    for (const [match, scenarios] of plan) {
      for (const [i, scenario] of scenarios.entries()) {
        const p = match.participants[i];
        for (const [sold, bought, minute] of scenario.swaps) {
          const key = `${p?.position}|${p?.championId}|${sold}|${bought}`;
          const row = rows.get(key) ?? { games: 0, minuteSum: 0 };
          rows.set(key, row);
          row.games += 1;
          row.minuteSum += minute;
        }
      }
    }
    return rows;
  };

  const viewRows = async () => {
    const rows = await db<
      {
        patch: string;
        position: string;
        champion_id: number;
        sold_item_id: number;
        bought_item_id: number;
        games: number;
        minute_sum: number;
      }[]
    >`SELECT * FROM stats_item_swaps`;
    expect(new Set(rows.map((r) => r.patch))).toEqual(new Set([PATCH]));
    return new Map(
      rows.map((r) => [
        `${r.position}|${r.champion_id}|${r.sold_item_id}|${r.bought_item_id}`,
        { games: r.games, minuteSum: r.minute_sum },
      ]),
    );
  };

  beforeAll(async () => {
    await resetApiTestDb(URL_);
    db = createDb(URL_ as string, { max: 4 });
    await upsertPatchStaticData(db, syntheticStaticData(PATCH));

    for (const m of matches) {
      m.match.isRemake = false;
      m.match.isEarlySurrender = false;
      m.match.durationS = 2400;
    }
    third.match.isRemake = true;
    // Same champion + role in the first two matches; one participant without a position.
    const [a, b, noPosition] = [
      first.participants[0],
      second.participants[0],
      second.participants[2],
    ];
    if (!a || !b || !noPosition) throw new Error('synthetic matches have 10 participants');
    b.championId = a.championId;
    b.position = a.position;
    noPosition.position = null;
    for (const [match, scenarios] of plan) {
      match.itemEvents = scenarios.flatMap((s, i) => eventsOf(i + 1, s.steps, s.seqStep));
      await insertParsedMatch(db, match, { enqueueEnrichment: false, markQueueDone: false });
    }
    await refreshStats(db, { force: true });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
  });

  test('refreshed concurrently, after the participants it reads', () => {
    const names = STATS_REFRESH_ORDER.map((s) => s.view);
    const step = STATS_REFRESH_ORDER.find((s) => s.view === 'stats_item_swaps');
    expect(step?.concurrent).toBe(true);
    expect(names.indexOf('stats_item_swaps')).toBeGreaterThan(
      names.indexOf('stats_tierlist_participants'),
    );
  });

  test('every scenario: what counts as a swap and what does not', async () => {
    const want = expected();
    // The scenarios cover both outcomes, and the two matches of one champion + role are summed.
    const a = first.participants[0];
    expect(want.get(`${a?.position}|${a?.championId}|${STEELCAPS}|${MERCS}`)).toEqual({
      games: 2,
      minuteSum: 62,
    });
    expect([...FIRST, ...SECOND].filter((s) => s.swaps.length === 0).length).toBeGreaterThan(5);
    expect(await viewRows()).toEqual(want);
  });

  test('a second refresh (concurrent, on a populated view) gives the same rows', async () => {
    const before = await viewRows();
    expect((await refreshStats(db, { force: true })).views).toHaveProperty('stats_item_swaps');
    expect(await viewRows()).toEqual(before);
  });

  test('the loader returns the rows of one champion + role', async () => {
    const a = first.participants[0];
    if (!a?.position) throw new Error('participant 1 has a position');
    const prefix = `${a.position}|${a.championId}|`;
    const want = [...expected()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, row]) => {
        const [sold = 0, bought = 0] = key.slice(prefix.length).split('|').map(Number);
        return { patch: PATCH, soldItemId: sold, boughtItemId: bought, ...row };
      });
    const got = await loadItemSwaps(db, [PATCH], a.position, a.championId);
    const byPair = (x: { soldItemId?: number; boughtItemId?: number }) =>
      `${x.soldItemId}|${x.boughtItemId}`;
    expect(got.sort((x, y) => byPair(x).localeCompare(byPair(y)))).toEqual(
      want.sort((x, y) => byPair(x).localeCompare(byPair(y))),
    );
    expect(got).toContainEqual({
      patch: PATCH,
      soldItemId: STEELCAPS,
      boughtItemId: MERCS,
      games: 2,
      minuteSum: 62,
    });
    expect(await loadItemSwaps(db, ['15.21'], a.position, a.championId)).toEqual([]);
    // An id beyond the smallint column matches nothing instead of failing the query.
    expect(await loadItemSwaps(db, [PATCH], a.position, 1_000_000)).toEqual([]);
  });
});
