import { describe, expect, test } from 'bun:test';
import {
  buildRequestSchema,
  draftRequestSchema,
  type PickCandidate,
  type Position,
  picksRequestSchema,
} from '@pick-league/shared';
import {
  allBans,
  ban,
  banPhase,
  COMPETITIVE_TURNS,
  COMPETITIVE_TURNS_RED_FIRST,
  championPool,
  currentTurn,
  DRAFT_PICKS_LIMIT,
  DRAFT_TURNS,
  type Draft,
  displacedBy,
  draftBuildRequest,
  draftEvaluationRequest,
  draftPicksRequest,
  draftTurns,
  EMPTY_DRAFT,
  emptyDraft,
  isComplete,
  lastAction,
  openRoles,
  pick,
  pickRole,
  swapRoles,
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

  test('a role the team already has: the new pick takes it, its champion moves to an open role', () => {
    const d = play(afterBans(), [[1, 'TOP']]);
    expect(teamPicks(pick(d, 11, 'TOP'), 'red').TOP?.championId).toBe(11);
    const blueAgain = play(d, [
      [11, 'JUNGLE'],
      [12, 'MIDDLE'],
    ]);
    // B1 was a flex pick: B2 takes top, B1 goes to the first open role (jungle)…
    const moved = pick(blueAgain, 2, 'TOP');
    expect(teamPicks(moved, 'blue')).toEqual({
      TOP: { championId: 2, number: 2 },
      JUNGLE: { championId: 1, number: 1 },
    });
    // …or to the open role asked for.
    expect(teamPicks(pick(blueAgain, 2, 'TOP', 'MIDDLE'), 'blue').MIDDLE?.championId).toBe(1);
    // Undo removes the new pick; the moved champion stays where it went.
    expect(teamPicks(undo(moved), 'blue')).toEqual({ JUNGLE: { championId: 1, number: 1 } });
  });

  test('swapRoles moves picks between roles at any time, not a turn', () => {
    const done = play(afterBans(), FULL_PICKS);
    const swapped = swapRoles(done, 'blue', 'TOP', 'JUNGLE');
    expect(teamPicks(swapped, 'blue').TOP?.championId).toBe(2);
    expect(teamPicks(swapped, 'blue').JUNGLE?.championId).toBe(1);
    expect(teamPicks(swapped, 'red')).toEqual(teamPicks(done, 'red'));
    expect(swapped.actions).toHaveLength(done.actions.length);
    // To an empty role: a move.
    const early = play(afterBans(), [[1, 'TOP']]);
    expect(teamPicks(swapRoles(early, 'blue', 'TOP', 'BOTTOM'), 'blue')).toEqual({
      BOTTOM: { championId: 1, number: 1 },
    });
    expect(swapRoles(early, 'blue', 'TOP', 'TOP')).toBe(early);
    expect(swapRoles(early, 'red', 'TOP', 'MIDDLE')).toBe(early);
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

  test('a role the team already has: its champion counts in the role it would move to', () => {
    const d = play(afterBans(), [[1, 'TOP']]);
    const request = draftPicksRequest(d, 'blue', 'TOP', 10, 'MIDDLE');
    expect(request?.allies).toContainEqual({ championId: 1, role: 'MIDDLE' });
    expect(request?.allies).not.toContainEqual({ championId: 1, role: 'TOP' });
    expect(draftPicksRequest(d, 'blue', 'TOP')?.allies).toContainEqual({
      championId: 1,
      role: 'JUNGLE',
    });
  });

  test('null once the team is full', () => {
    const done = play(afterBans(), FULL_PICKS);
    expect(draftPicksRequest(done, 'blue', 'TOP')).toBeNull();
  });
});

describe('draft: competitive format', () => {
  test('3 bans each, picks B1 R1 R2 B2 B3 R3, 2 bans each (red first), picks R4 B4 B5 R5', () => {
    expect(draftTurns('competitive')).toBe(COMPETITIVE_TURNS);
    const label = (t: { kind: string; team: string; number: number }) =>
      t.kind === 'pick'
        ? turnLabel(t as Parameters<typeof turnLabel>[0])
        : `${t.team[0]}${t.number}`;
    expect(COMPETITIVE_TURNS.map(label)).toEqual([
      'b1',
      'r1',
      'b2',
      'r2',
      'b3',
      'r3',
      'B1',
      'R1',
      'R2',
      'B2',
      'B3',
      'R3',
      'r4',
      'b4',
      'r5',
      'b5',
      'R4',
      'B4',
      'B5',
      'R5',
    ]);
    expect(banPhase({ format: 'competitive' }, 3)).toBe(1);
    expect(banPhase({ format: 'competitive' }, 4)).toBe(2);
    expect(banPhase({ format: 'soloq' }, 5)).toBe(1);
  });

  test('red first pick: every blue turn goes to red and back (R1 B1 B2 R2 …)', () => {
    expect(draftTurns('competitive', 'red')).toBe(COMPETITIVE_TURNS_RED_FIRST);
    expect(draftTurns('soloq', 'red')).toBe(DRAFT_TURNS);
    const picks = COMPETITIVE_TURNS_RED_FIRST.filter((t) => t.kind === 'pick').map(turnLabel);
    expect(picks).toEqual(['R1', 'B1', 'B2', 'R2', 'R3', 'B3', 'B4', 'R4', 'R5', 'B5']);
    expect(COMPETITIVE_TURNS_RED_FIRST[0]).toEqual({ kind: 'ban', team: 'red', number: 1 });

    let d = emptyDraft('competitive', 'red');
    expect(currentTurn(d)).toEqual({ kind: 'ban', team: 'red', number: 1 });
    for (let i = 1; i <= 6; i++) d = ban(d, 100 + i);
    expect(currentTurn(d)).toEqual({ kind: 'pick', team: 'red', number: 1 });
    expect(d.firstPick).toBe('red');
    expect(emptyDraft('competitive')).toEqual({ format: 'competitive', actions: [] });
  });

  test('a competitive draft plays to the end with the same rules', () => {
    let d = emptyDraft('competitive');
    expect(d.format).toBe('competitive');
    for (let i = 1; i <= 6; i++) d = ban(d, 100 + i);
    expect(currentTurn(d)).toEqual({ kind: 'pick', team: 'blue', number: 1 });
    d = play(d, [
      [1, 'TOP'],
      [11, 'JUNGLE'],
      [12, 'MIDDLE'],
      [2, 'JUNGLE'],
      [3, 'MIDDLE'],
      [13, 'TOP'],
    ]);
    expect(currentTurn(d)).toEqual({ kind: 'ban', team: 'red', number: 4 });
    for (let i = 7; i <= 10; i++) d = ban(d, 100 + i);
    expect(teamBans(d, 'red')).toEqual([102, 104, 106, 107, 109]);
    d = play(d, [
      [14, 'UTILITY'],
      [4, 'BOTTOM'],
      [5, 'UTILITY'],
      [15, 'BOTTOM'],
    ]);
    expect(isComplete(d)).toBe(true);
    expect(d.format).toBe('competitive');
    expect(undo(d).format).toBe('competitive');
  });
});

describe('draft: evaluation request', () => {
  test("the team's picks as allies, the other team's as enemies, roles and side included", () => {
    const d = play(afterBans(), FULL_PICKS.slice(0, 3));
    const blue = draftRequestSchema.parse(draftEvaluationRequest(d));
    expect(blue).toEqual({
      allies: [{ championId: 1, role: 'TOP' }],
      enemies: [
        { championId: 11, role: 'JUNGLE' },
        { championId: 12, role: 'MIDDLE' },
      ],
      side: 'blue',
    });
    expect(draftEvaluationRequest(d, 'red')).toMatchObject({ side: 'red', allies: blue.enemies });
    expect(draftEvaluationRequest(EMPTY_DRAFT)).toEqual({ allies: [], enemies: [], side: 'blue' });
  });

  test('a competitive draft sends no side: the side edge only describes ranked matchmaking', () => {
    let d = emptyDraft('competitive');
    for (let i = 1; i <= 6; i++) d = ban(d, 100 + i);
    d = play(d, FULL_PICKS.slice(0, 3));
    const blue = draftRequestSchema.parse(draftEvaluationRequest(d));
    expect(blue).toEqual({
      allies: [{ championId: 1, role: 'TOP' }],
      enemies: [
        { championId: 11, role: 'JUNGLE' },
        { championId: 12, role: 'MIDDLE' },
      ],
      side: null,
    });
    expect(draftEvaluationRequest(d, 'red').side).toBeNull();
    expect(draftEvaluationRequest(emptyDraft('competitive', 'red')).side).toBeNull();
    // Ranked solo/duo keeps its side.
    expect(draftEvaluationRequest(afterBans(), 'red').side).toBe('red');
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

  test('candidates `keep` rejects join the rest, without renumbering the others', () => {
    const cands = [
      { ...candidate(4, 0.03), confidence: 0.2 },
      candidate(2, 0.02),
      { ...candidate(1, 0.01), confidence: 0.9 },
    ];
    const pool = championPool(champions, new Set(), cands, '', (c) => c.confidence >= 0.4);
    expect(ids(pool)).toEqual({
      ranked: [
        [2, 2],
        [1, 3],
      ],
      rest: [3, 4, 5],
    });
  });

  test('without recommendations (ban phase, API down) every available champion is in the rest', () => {
    expect(ids(championPool(champions, new Set([1]), null, ''))).toEqual({
      ranked: [],
      rest: [2, 3, 4, 5],
    });
  });
});

describe('draft: choosing a role the team already has', () => {
  test('pickRole keeps a taken role only when asked to, while the team has an open role', () => {
    const d = play(afterBans(), [[1, 'TOP']]);
    expect(pickRole(d, 'blue', 'TOP')).toBe('JUNGLE');
    expect(pickRole(d, 'blue', 'TOP', true)).toBe('TOP');
    expect(displacedBy(d, 'blue', 'TOP')).toEqual({ championId: 1, number: 1 });
    expect(displacedBy(d, 'blue', 'MIDDLE')).toBeNull();
    const done = play(afterBans(), FULL_PICKS);
    expect(pickRole(done, 'blue', 'TOP', true)).toBeNull();
  });
});
