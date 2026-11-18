/**
 * Draft planner: a ranked solo/duo or competitive (tournament) draft simulated by hand, without
 * the League client. Pure state + rules (turn order, applying and undoing actions, moving picks
 * between roles, request bodies for the API); the renderer only displays it.
 */

import {
  type BuildRequestInput,
  type DraftRequestInput,
  type PickCandidate,
  type PicksRequestInput,
  POSITIONS,
  type Position,
} from '@pick-league/shared';

export type Team = 'blue' | 'red';
export const TEAMS: readonly Team[] = ['blue', 'red'];

export function otherTeam(team: Team): Team {
  return team === 'blue' ? 'red' : 'blue';
}

export interface DraftTurn {
  kind: 'ban' | 'pick';
  team: Team;
  /** 1-based number of this team's ban or pick (B3 = blue's third pick). */
  number: number;
}

/** Ban phase alternates Blue/Red (5 each); picks go B1, R1, R2, B2, B3, R3, R4, B4, B5, R5. */
const BAN_ORDER: readonly Team[] = Array.from({ length: 10 }, (_, i) =>
  i % 2 === 0 ? 'blue' : 'red',
);
const PICK_ORDER: readonly Team[] = [
  'blue',
  'red',
  'red',
  'blue',
  'blue',
  'red',
  'red',
  'blue',
  'blue',
  'red',
];

function numbered(kind: DraftTurn['kind'], order: readonly Team[]): DraftTurn[] {
  const seen = { blue: 0, red: 0 };
  return order.map((team) => ({ kind, team, number: ++seen[team] }));
}

/** Every turn of a ranked solo/duo draft, in order: 10 bans then 10 picks. */
export const DRAFT_TURNS: readonly DraftTurn[] = [
  ...numbered('ban', BAN_ORDER),
  ...numbered('pick', PICK_ORDER),
];

/**
 * `soloq`: ranked solo/duo (10 bans, then 10 picks). `competitive`: tournament draft, two ban
 * phases between the picks: 3 bans each (B R B R B R), picks B1 R1 R2 B2 B3 R3, 2 bans each
 * (R B R B), picks R4 B4 B5 R5.
 */
export type DraftFormat = 'soloq' | 'competitive';
export const DRAFT_FORMATS: readonly DraftFormat[] = ['soloq', 'competitive'];

/** Every turn of a competitive draft, in order (see `DraftFormat`). */
export const COMPETITIVE_TURNS: readonly DraftTurn[] = (() => {
  const seen = { ban: { blue: 0, red: 0 }, pick: { blue: 0, red: 0 } };
  const turn = (kind: DraftTurn['kind'], team: Team): DraftTurn => ({
    kind,
    team,
    number: ++seen[kind][team],
  });
  const B: Team = 'blue';
  const R: Team = 'red';
  return [
    ...[B, R, B, R, B, R].map((t) => turn('ban', t)),
    ...[B, R, R, B, B, R].map((t) => turn('pick', t)),
    ...[R, B, R, B].map((t) => turn('ban', t)),
    ...[R, B, B, R].map((t) => turn('pick', t)),
  ];
})();

/**
 * A competitive draft where red has first pick: blue's turns go to red and red's to blue (bans
 * included), e.g. picks R1 B1 B2 R2 R3 B3. Since 2026 the team choosing first takes either the
 * side or first pick, so blue side no longer always picks first.
 */
export const COMPETITIVE_TURNS_RED_FIRST: readonly DraftTurn[] = COMPETITIVE_TURNS.map((t) => ({
  ...t,
  team: otherTeam(t.team),
}));

/**
 * Every turn of a draft of that format, in order. `firstPick`: the team picking first in a
 * competitive draft (solo/duo always starts with blue).
 */
export function draftTurns(format: DraftFormat, firstPick: Team = 'blue'): readonly DraftTurn[] {
  if (format !== 'competitive') return DRAFT_TURNS;
  return firstPick === 'red' ? COMPETITIVE_TURNS_RED_FIRST : COMPETITIVE_TURNS;
}

/** Every turn of that draft, in order. */
export function turnsOf(draft: Pick<Draft, 'format' | 'firstPick'>): readonly DraftTurn[] {
  return draftTurns(draft.format, draft.firstPick);
}

export type DraftAction =
  | { kind: 'ban'; team: Team; championId: number | null }
  | { kind: 'pick'; team: Team; role: Position; championId: number };

/**
 * The actions taken so far, one per turn of the format's turns. A pick's `role` is where the
 * champion plays now (picks can be moved between roles, see `swapRoles`).
 */
export interface Draft {
  readonly format: DraftFormat;
  /** Competitive drafts: the team with first pick (blue when absent; ignored in solo/duo). */
  readonly firstPick?: Team;
  readonly actions: readonly DraftAction[];
}

export const EMPTY_DRAFT: Draft = { format: 'soloq', actions: [] };

export function emptyDraft(format: DraftFormat, firstPick: Team = 'blue'): Draft {
  if (format === 'soloq') return EMPTY_DRAFT;
  return firstPick === 'red' ? { format, firstPick, actions: [] } : { format, actions: [] };
}

/** The turn to play, or null once the 10 picks are in. */
export function currentTurn(draft: Draft): DraftTurn | null {
  return turnsOf(draft)[draft.actions.length] ?? null;
}

export function isComplete(draft: Draft): boolean {
  return draft.actions.length >= turnsOf(draft).length;
}

/**
 * 1-based ban phase of a ban turn: always 1 in solo/duo; 1 (the first 3 bans of each team) or
 * 2 (the last 2) in a competitive draft.
 */
export function banPhase(draft: Pick<Draft, 'format'>, banNumber: number): 1 | 2 {
  return draft.format === 'competitive' && banNumber > 3 ? 2 : 1;
}

/** "B3" / "R1" for picks, "Blue ban 2" for bans. */
export function turnLabel(turn: DraftTurn): string {
  if (turn.kind === 'pick') return `${turn.team === 'blue' ? 'B' : 'R'}${turn.number}`;
  return `${turn.team === 'blue' ? 'Blue' : 'Red'} ban ${turn.number}`;
}

/** Banned or picked champions: they cannot be banned or picked again. */
export function unavailableChampionIds(draft: Draft): Set<number> {
  const ids = new Set<number>();
  for (const a of draft.actions) if (a.championId !== null) ids.add(a.championId);
  return ids;
}

function isChampionId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

/** Bans the champion on a ban turn (null = no ban); anything else leaves the draft as it is. */
export function ban(draft: Draft, championId: number | null): Draft {
  const turn = currentTurn(draft);
  if (turn?.kind !== 'ban') return draft;
  if (championId !== null) {
    if (!isChampionId(championId) || unavailableChampionIds(draft).has(championId)) return draft;
  }
  return { ...draft, actions: [...draft.actions, { kind: 'ban', team: turn.team, championId }] };
}

/**
 * Picks the champion for `role` on a pick turn; leaves the draft as it is when it is not a pick
 * turn, the champion is banned or taken, or the team is full. When the team already has a
 * champion in `role` (a flex pick placed in the wrong lane), the new champion takes `role` and
 * that champion moves to `displacedTo` (one of the team's open roles; its first open role by
 * default).
 */
export function pick(
  draft: Draft,
  championId: number,
  role: Position,
  displacedTo?: Position | null,
): Draft {
  const turn = currentTurn(draft);
  if (turn?.kind !== 'pick' || !isChampionId(championId)) return draft;
  if (unavailableChampionIds(draft).has(championId)) return draft;
  const open = openRoles(draft, turn.team);
  const first = open[0];
  if (first === undefined) return draft;
  const taken = !open.includes(role);
  const target = taken ? (displacedTo && open.includes(displacedTo) ? displacedTo : first) : role;
  const next: Draft = {
    ...draft,
    actions: [...draft.actions, { kind: 'pick', team: turn.team, role: target, championId }],
  };
  return taken ? swapRoles(next, turn.team, target, role) : next;
}

/**
 * Swaps the champions the team has in roles `a` and `b` (or moves one to the other role when
 * that one is empty), at any time: flex picks are often placed before their lane is known. Not
 * a turn of the draft: `undo` does not revert it.
 */
export function swapRoles(draft: Draft, team: Team, a: Position, b: Position): Draft {
  if (a === b) return draft;
  let changed = false;
  const actions = draft.actions.map((x): DraftAction => {
    if (x.kind !== 'pick' || x.team !== team || (x.role !== a && x.role !== b)) return x;
    changed = true;
    return { ...x, role: x.role === a ? b : a };
  });
  return changed ? { ...draft, actions } : draft;
}

/** Steps back one action (the moves between roles made since stay). */
export function undo(draft: Draft): Draft {
  return draft.actions.length === 0 ? draft : { ...draft, actions: draft.actions.slice(0, -1) };
}

/** The last action taken, if any (what `undo` removes). */
export function lastAction(draft: Draft): DraftAction | null {
  return draft.actions.at(-1) ?? null;
}

/** The team's bans in order, null for a skipped one (only the turns already played). */
export function teamBans(draft: Draft, team: Team): (number | null)[] {
  return draft.actions.flatMap((a) => (a.kind === 'ban' && a.team === team ? [a.championId] : []));
}

export interface DraftPick {
  championId: number;
  /** 1-based pick number within the team (B1…B5). */
  number: number;
}

/** The team's picks by role. */
export function teamPicks(draft: Draft, team: Team): Partial<Record<Position, DraftPick>> {
  const picks: Partial<Record<Position, DraftPick>> = {};
  let number = 0;
  for (const a of draft.actions) {
    if (a.kind !== 'pick' || a.team !== team) continue;
    picks[a.role] = { championId: a.championId, number: ++number };
  }
  return picks;
}

/** Roles the team has not picked for yet, in the usual order (Top → Support). */
export function openRoles(draft: Draft, team: Team): Position[] {
  const picks = teamPicks(draft, team);
  return POSITIONS.filter((p) => !picks[p]);
}

/**
 * Role the team picks for next: `preferred` (the role the user chose for it) when still open,
 * or when taken with `allowTaken` (the pick then moves that role's champion, see `pick`); else
 * its first open role; null when the team is full.
 */
export function pickRole(
  draft: Draft,
  team: Team,
  preferred: Position | null | undefined,
  allowTaken = false,
): Position | null {
  const open = openRoles(draft, team);
  if (open.length === 0) return null;
  if (preferred && (allowTaken || open.includes(preferred))) return preferred;
  return open[0] ?? null;
}

/** The team's champion in `role`, which a pick for that role would move: null when it is open. */
export function displacedBy(draft: Draft, team: Team, role: Position): DraftPick | null {
  return teamPicks(draft, team)[role] ?? null;
}

/** All bans of both teams (skipped ones left out). */
export function allBans(draft: Draft): number[] {
  return draft.actions.flatMap((a) =>
    a.kind === 'ban' && a.championId !== null ? [a.championId] : [],
  );
}

/** Max candidates asked for: enough to rank nearly every champion of a role. */
export const DRAFT_PICKS_LIMIT = 100;

/**
 * Body of `POST /recommendations/picks` for `team` picking `role`: its 4 other roles as allies
 * (null = not picked yet), the other team's picks as enemies, every ban. When the team already
 * has a champion in `role`, that champion counts in the role it would move to (`displacedTo`,
 * else the first open role, as `pick` does). Null when the team is full.
 */
export function draftPicksRequest(
  draft: Draft,
  team: Team,
  role: Position,
  limit = DRAFT_PICKS_LIMIT,
  displacedTo?: Position | null,
): PicksRequestInput | null {
  const mine = { ...teamPicks(draft, team) };
  const open = openRoles(draft, team);
  const first = open[0];
  if (first === undefined) return null;
  const occupant = mine[role];
  if (occupant) {
    mine[displacedTo && open.includes(displacedTo) ? displacedTo : first] = occupant;
    delete mine[role];
  }
  const theirs = teamPicks(draft, otherTeam(team));
  return {
    role,
    allies: POSITIONS.filter((p) => p !== role).map((p) => ({
      championId: mine[p]?.championId ?? null,
      role: p,
    })),
    enemies: POSITIONS.flatMap((p) => {
      const id = theirs[p]?.championId;
      return id ? [id] : [];
    }),
    bans: allBans(draft),
    limit,
  };
}

/**
 * Body of `POST /recommendations/build` for the champion `team` picked for `role`, with its
 * picked teammates and the other team's picks, all with their roles. Null when that slot is
 * empty.
 */
export function draftBuildRequest(
  draft: Draft,
  team: Team,
  role: Position,
): BuildRequestInput | null {
  const mine = teamPicks(draft, team);
  const self = mine[role];
  if (!self) return null;
  const theirs = teamPicks(draft, otherTeam(team));
  const known = (picks: Partial<Record<Position, DraftPick>>, skip: Position | null) =>
    POSITIONS.flatMap((p) => {
      const id = p === skip ? undefined : picks[p]?.championId;
      return id ? [{ championId: id, role: p }] : [];
    });
  return {
    championId: self.championId,
    role,
    allies: known(mine, role),
    enemies: known(theirs, null),
  };
}

/**
 * Body of `POST /recommendations/draft` from `team`'s point of view: its picks and the other
 * team's, all with their roles, at any point of the draft. A ranked solo/duo draft also sends the
 * team's side (blue or red). A competitive draft sends none: the side edge is measured on ranked
 * matches, where matchmaking decides which side gets the stronger players, and says nothing about
 * a tournament game.
 */
export function draftEvaluationRequest(draft: Draft, team: Team = 'blue'): DraftRequestInput {
  const known = (t: Team) => {
    const picks = teamPicks(draft, t);
    return POSITIONS.flatMap((p) => {
      const id = picks[p]?.championId;
      return id ? [{ championId: id, role: p }] : [];
    });
  };
  return {
    allies: known(team),
    enemies: known(otherTeam(team)),
    side: draft.format === 'competitive' ? null : team,
  };
}

/** "Kai'Sa" → "kaisa": search ignores case, spaces and punctuation. */
function searchable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export interface RankedChampion<C> {
  champion: C;
  candidate: PickCandidate;
  /** 1-based rank among the champions still available (search and `keep` do not renumber). */
  rank: number;
}

/**
 * The champion grid: champions still available whose name matches `query`, split into those the
 * API ranked (by its order: best score first) and the rest (no recommendation: too little data
 * in that role; or one `keep` rejects, e.g. under the confidence filter), in `champions` order.
 */
export function championPool<C extends { id: number; name: string }>(
  champions: readonly C[],
  unavailable: ReadonlySet<number>,
  candidates: readonly PickCandidate[] | null,
  query: string,
  keep: (candidate: PickCandidate) => boolean = () => true,
): { ranked: RankedChampion<C>[]; rest: C[] } {
  const q = searchable(query);
  const byId = new Map(champions.map((c) => [c.id, c]));
  const matches = (c: C) => !q || searchable(c.name).includes(q);
  const ranked: RankedChampion<C>[] = [];
  const seen = new Set<number>();
  const rankedIds = new Set<number>();
  for (const candidate of candidates ?? []) {
    const champion = byId.get(candidate.championId);
    if (!champion || unavailable.has(champion.id) || seen.has(champion.id)) continue;
    seen.add(champion.id);
    if (!keep(candidate)) continue;
    rankedIds.add(champion.id);
    if (matches(champion)) ranked.push({ champion, candidate, rank: seen.size });
  }
  const rest = champions.filter(
    (c) => !unavailable.has(c.id) && !rankedIds.has(c.id) && matches(c),
  );
  return { ranked, rest };
}
