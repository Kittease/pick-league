import { describe, expect, test } from 'bun:test';
import {
  buildRequestSchema,
  type PickCandidate,
  type Position,
  picksRequestSchema,
} from '@pick-league/shared';
import {
  allBans,
  ban,
  championPool,
  currentTurn,
  DRAFT_PICKS_LIMIT,
  DRAFT_TURNS,
  type Draft,
  draftBuildRequest,
  draftPicksRequest,
  EMPTY_DRAFT,
  isComplete,
  lastAction,
  openRoles,
  pick,
  pickRole,
  teamBans,
  teamPicks,
  turnLabel,
  unavailableChampionIds,
  undo,
} from './draft.ts';

/** Bans 10 fake champions (101…110), blue first. */
function afterBans(): Draft {
  let d = EMPTY_DRAFT;
  for (let i = 1; i <= 10; i++) d = ban(d, 100 + i);
  return d;
}

/** Plays picks in turn order, each as [championId, role]. */
function play(draft: Draft, picks: [number, Position][]): Draft {
  return picks.reduce((d, [id, role]) => pick(d, id, role), draft);
}

/** A full draft: blue 1–5, red 11–15, each in role order of their own picks. */
const FULL_PICKS: [number, Position][] = [
  [1, 'TOP'], // B1
  [11, 'JUNGLE'], // R1
  [12, 'MIDDLE'], // R2
  [2, 'JUNGLE'], // B2
  [3, 'MIDDLE'], // B3
  [13, 'TOP'], // R3
  [14, 'UTILITY'], // R4
  [4, 'BOTTOM'], // B4
  [5, 'UTILITY'], // B5
  [15, 'BOTTOM'], // R5
];

describe('draft: turn order', () => {
  test('10 alternating bans then picks B1 R1 R2 B2 B3 R3 R4 B4 B5 R5', () => {
    expect(DRAFT_TURNS).toHaveLength(20);
    const bans = DRAFT_TURNS.slice(0, 10);
    expect(bans.every((t) => t.kind === 'ban')).toBe(true);
    expect(bans.map((t) => t.team)).toEqual([
      'blue',
      'red',
      'blue',
      'red',
      'blue',
      'red',
      'blue',
      'red',
      'blue',
      'red',
    ]);
    expect(bans.map((t) => t.number)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    const picks = DRAFT_TURNS.slice(10);
    expect(picks.every((t) => t.kind === 'pick')).toBe(true);
    expect(picks.map(turnLabel)).toEqual([
      'B1',
      'R1',
      'R2',
      'B2',
      'B3',
      'R3',
      'R4',
      'B4',
      'B5',
      'R5',
    ]);
  });

  test('labels bans by team and number', () => {
    expect(turnLabel({ kind: 'ban', team: 'red', number: 4 })).toBe('Red ban 4');
  });

  test('the draft starts on blue ban 1 and ends after R5', () => {
    expect(currentTurn(EMPTY_DRAFT)).toEqual({ kind: 'ban', team: 'blue', number: 1 });
    expect(currentTurn(afterBans())).toEqual({ kind: 'pick', team: 'blue', number: 1 });
    const done = play(afterBans(), FULL_PICKS);
    expect(done.actions).toHaveLength(20);
    expect(isComplete(done)).toBe(true);
    expect(currentTurn(done)).toBeNull();
    expect(isComplete(afterBans())).toBe(false);
  });
});

describe('draft: bans', () => {
  test('bans go to the team on turn, and can be skipped', () => {
    let d = ban(EMPTY_DRAFT, 7);
    d = ban(d, null);
    d = ban(d, 8);
    expect(teamBans(d, 'blue')).toEqual([7, 8]);
    expect(teamBans(d, 'red')).toEqual([null]);
    expect(allBans(d)).toEqual([7, 8]);
    expect(currentTurn(d)).toEqual({ kind: 'ban', team: 'red', number: 2 });
  });

  test('a champion already banned, or an invalid id, is refused', () => {
    const d = ban(EMPTY_DRAFT, 7);
    expect(ban(d, 7)).toBe(d);
    expect(ban(d, 0)).toBe(d);
    expect(ban(d, -3)).toBe(d);
    expect(ban(d, 1.5)).toBe(d);
  });

  test('no ban outside the ban phase', () => {
    const d = afterBans();
    expect(ban(d, 50)).toBe(d);
    expect(ban(d, null)).toBe(d);
  });
});

describe('draft: picks', () => {
  test('no pick during the ban phase', () => {
    expect(pick(EMPTY_DRAFT, 1, 'TOP')).toBe(EMPTY_DRAFT);
  });

  test('picks go to the team on turn, in the chosen role', () => {
    const d = play(afterBans(), FULL_PICKS.slice(0, 4));
    expect(teamPicks(d, 'blue')).toEqual({
      TOP: { championId: 1, number: 1 },
      JUNGLE: { championId: 2, number: 2 },
    });
    expect(teamPicks(d, 'red')).toEqual({
      JUNGLE: { championId: 11, number: 1 },
      MIDDLE: { championId: 12, number: 2 },
    });
    expect(openRoles(d, 'blue')).toEqual(['MIDDLE', 'BOTTOM', 'UTILITY']);
    expect(currentTurn(d)).toEqual({ kind: 'pick', team: 'blue', number: 3 });
  });

  test('banned, already picked (by either team) or invalid champions are refused', () => {
    const d = play(afterBans(), [[1, 'TOP']]);
    expect(pick(d, 101, 'TOP')).toBe(d); // banned
    expect(pick(d, 1, 'TOP')).toBe(d); // blue's pick, red on turn
    expect(pick(d, 0, 'TOP')).toBe(d);
    expect(unavailableChampionIds(d)).toEqual(
      new Set([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 1]),
    );
  });

  test('skipped bans do not make anything unavailable', () => {
    const d = ban(ban(EMPTY_DRAFT, null), 9);
    expect(unavailableChampionIds(d)).toEqual(new Set([9]));
  });

  test("a role the team already has is refused, the other team's is not", () => {
    const d = play(afterBans(), [[1, 'TOP']]);
    expect(teamPicks(pick(d, 11, 'TOP'), 'red').TOP?.championId).toBe(11);
    const blueAgain = play(d, [
      [11, 'JUNGLE'],
      [12, 'MIDDLE'],
    ]);
    expect(pick(blueAgain, 2, 'TOP')).toBe(blueAgain);
  });

  test('nothing more once the draft is complete', () => {
    const done = play(afterBans(), FULL_PICKS);
    expect(pick(done, 99, 'TOP')).toBe(done);
    expect(ban(done, 99)).toBe(done);
  });
});

describe('draft: undo', () => {
  test('steps back one action at a time, down to the empty draft', () => {
    const d = play(afterBans(), FULL_PICKS.slice(0, 2));
    const back = undo(d);
    expect(lastAction(d)).toEqual({ kind: 'pick', team: 'red', role: 'JUNGLE', championId: 11 });
    expect(teamPicks(back, 'red')).toEqual({});
    expect(currentTurn(back)).toEqual({ kind: 'pick', team: 'red', number: 1 });
    // Back into the ban phase: red's last ban is open again.
    expect(currentTurn(undo(undo(back)))).toEqual({ kind: 'ban', team: 'red', number: 5 });
    expect(teamBans(undo(undo(back)), 'red')).toEqual([102, 104, 106, 108]);
    let e: Draft = d;
    for (let i = 0; i < 12; i++) e = undo(e);
    expect(e.actions).toHaveLength(0);
    expect(undo(EMPTY_DRAFT)).toBe(EMPTY_DRAFT);
    expect(lastAction(EMPTY_DRAFT)).toBeNull();
  });

  test('an undone champion is available again', () => {
    const d = undo(play(afterBans(), [[1, 'TOP']]));
    expect(unavailableChampionIds(d).has(1)).toBe(false);
    expect(teamPicks(pick(d, 1, 'MIDDLE'), 'blue').MIDDLE?.championId).toBe(1);
  });
});

describe('draft: role on turn', () => {
  test("the user's last choice while open, else the first open role", () => {
    const d = play(afterBans(), [[1, 'TOP']]);
    expect(pickRole(d, 'blue', null)).toBe('JUNGLE');
    expect(pickRole(d, 'blue', 'UTILITY')).toBe('UTILITY');
    expect(pickRole(d, 'blue', 'TOP')).toBe('JUNGLE');
    expect(pickRole(d, 'red', undefined)).toBe('TOP');
  });

  test('null once the team has its 5 roles', () => {
    const done = play(afterBans(), FULL_PICKS);
    expect(openRoles(done, 'red')).toEqual([]);
    expect(pickRole(done, 'red', 'TOP')).toBeNull();
  });
});

describe('draft: picks request', () => {
  test('team on turn: other roles as allies, enemy picks, all bans', () => {
    let d = ban(EMPTY_DRAFT, 101);
    d = ban(d, null);
    for (let i = 3; i <= 10; i++) d = ban(d, 100 + i);
    d = play(d, FULL_PICKS.slice(0, 4)); // B1 top, R1 jungle, R2 mid, B2 jungle
    const request = draftPicksRequest(d, 'blue', 'MIDDLE');
    expect(request).toEqual({
      role: 'MIDDLE',
      allies: [
        { championId: 1, role: 'TOP' },
        { championId: 2, role: 'JUNGLE' },
        { championId: null, role: 'BOTTOM' },
        { championId: null, role: 'UTILITY' },
      ],
      enemies: [11, 12],
      bans: [101, 103, 104, 105, 106, 107, 108, 109, 110],
      limit: DRAFT_PICKS_LIMIT,
    });
    expect(picksRequestSchema.safeParse(request).success).toBe(true);
  });

  test('an empty draft gives a valid request', () => {
    const request = draftPicksRequest(EMPTY_DRAFT, 'red', 'UTILITY', 30);
    expect(request?.enemies).toEqual([]);
    expect(request?.bans).toEqual([]);
    expect(request?.limit).toBe(30);
    expect(picksRequestSchema.safeParse(request).success).toBe(true);
  });

  test('null for a role the team already has', () => {
    const d = play(afterBans(), [[1, 'TOP']]);
    expect(draftPicksRequest(d, 'blue', 'TOP')).toBeNull();
  });
});

describe('draft: build request', () => {
  test('the slot champion with its teammates and the enemies, roles included', () => {
    const done = play(afterBans(), FULL_PICKS);
    const request = draftBuildRequest(done, 'red', 'UTILITY');
    expect(request).toEqual({
      championId: 14,
      role: 'UTILITY',
      allies: [
        { championId: 13, role: 'TOP' },
        { championId: 11, role: 'JUNGLE' },
        { championId: 12, role: 'MIDDLE' },
        { championId: 15, role: 'BOTTOM' },
      ],
      enemies: [
        { championId: 1, role: 'TOP' },
        { championId: 2, role: 'JUNGLE' },
        { championId: 3, role: 'MIDDLE' },
        { championId: 4, role: 'BOTTOM' },
        { championId: 5, role: 'UTILITY' },
      ],
    });
    expect(buildRequestSchema.safeParse(request).success).toBe(true);
  });

  test('mid-draft: only the picks made so far', () => {
    const d = play(afterBans(), FULL_PICKS.slice(0, 3));
    expect(draftBuildRequest(d, 'blue', 'TOP')).toEqual({
      championId: 1,
      role: 'TOP',
      allies: [],
      enemies: [
        { championId: 11, role: 'JUNGLE' },
        { championId: 12, role: 'MIDDLE' },
      ],
    });
  });

  test('null for an empty slot', () => {
    expect(draftBuildRequest(afterBans(), 'blue', 'TOP')).toBeNull();
  });
});

describe('draft: champion pool', () => {
  const champions = [
    { id: 1, name: 'Alpha' },
    { id: 2, name: "Bel'Tor" },
    { id: 3, name: 'Gamma Ray' },
    { id: 4, name: 'Delta' },
    { id: 5, name: 'Epsilon' },
  ];
  const candidate = (championId: number, score: number): PickCandidate => ({
    championId,
    score,
    confidence: 0.5,
    patchesUsed: ['16.22'],
    games: 300,
    winRate: 0.51,
    reasons: [],
  });
  const ids = (pool: ReturnType<typeof championPool>) => ({
    ranked: pool.ranked.map((r) => [r.champion.id, r.rank]),
    rest: pool.rest.map((c) => c.id),
  });

  test('ranked champions in API order, then the others in name order', () => {
    const pool = championPool(champions, new Set(), [candidate(4, 0.03), candidate(2, 0.01)], '');
    expect(ids(pool)).toEqual({
      ranked: [
        [4, 1],
        [2, 2],
      ],
      rest: [1, 3, 5],
    });
    expect(pool.ranked[0]?.candidate.score).toBe(0.03);
  });

  test('banned and picked champions are left out, also from stale candidates', () => {
    const pool = championPool(
      champions,
      new Set([4, 5]),
      [candidate(4, 0.03), candidate(2, 0.01), candidate(99, 0.02)],
      '',
    );
    expect(ids(pool)).toEqual({ ranked: [[2, 1]], rest: [1, 3] });
  });

  test('search ignores case, spaces and punctuation, and keeps the ranks', () => {
    const cands = [candidate(1, 0.03), candidate(2, 0.01)];
    expect(ids(championPool(champions, new Set(), cands, 'beltor'))).toEqual({
      ranked: [[2, 2]],
      rest: [],
    });
    expect(ids(championPool(champions, new Set(), cands, ' GAMMAR'))).toEqual({
      ranked: [],
      rest: [3],
    });
  });

  test('without recommendations (ban phase, API down) every available champion is in the rest', () => {
    expect(ids(championPool(champions, new Set([1]), null, ''))).toEqual({
      ranked: [],
      rest: [2, 3, 4, 5],
    });
  });
});
