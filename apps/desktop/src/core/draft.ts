/**
 * Draft planner: a ranked solo/duo draft simulated by hand, without the League client. Pure
 * state + rules (turn order, applying and undoing actions, request bodies for the API); the
 * renderer only displays it.
 */

import {
  type BuildRequestInput,
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

/** Every turn of the draft, in order: 10 bans then 10 picks. */
export const DRAFT_TURNS: readonly DraftTurn[] = [
  ...numbered('ban', BAN_ORDER),
  ...numbered('pick', PICK_ORDER),
];

export type DraftAction =
  | { kind: 'ban'; team: Team; championId: number | null }
  | { kind: 'pick'; team: Team; role: Position; championId: number };

/** The actions taken so far, one per turn of `DRAFT_TURNS`. */
export interface Draft {
  readonly actions: readonly DraftAction[];
}

export const EMPTY_DRAFT: Draft = { actions: [] };

/** The turn to play, or null once the 10 picks are in. */
export function currentTurn(draft: Draft): DraftTurn | null {
  return DRAFT_TURNS[draft.actions.length] ?? null;
}

export function isComplete(draft: Draft): boolean {
  return draft.actions.length >= DRAFT_TURNS.length;
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
  return { actions: [...draft.actions, { kind: 'ban', team: turn.team, championId }] };
}

/**
 * Picks the champion for `role` on a pick turn; leaves the draft as it is when it is not a pick
 * turn, the champion is banned or taken, or the team already has that role.
 */
export function pick(draft: Draft, championId: number, role: Position): Draft {
  const turn = currentTurn(draft);
  if (turn?.kind !== 'pick' || !isChampionId(championId)) return draft;
  if (unavailableChampionIds(draft).has(championId)) return draft;
  if (!openRoles(draft, turn.team).includes(role)) return draft;
  return { actions: [...draft.actions, { kind: 'pick', team: turn.team, role, championId }] };
}

/** Steps back one action. */
export function undo(draft: Draft): Draft {
  return draft.actions.length === 0 ? draft : { actions: draft.actions.slice(0, -1) };
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
 * Role the team picks for next: `preferred` (the role the user last chose for it) when still
 * open, else its first open role; null when the team is full.
 */
export function pickRole(
  draft: Draft,
  team: Team,
  preferred: Position | null | undefined,
): Position | null {
  const open = openRoles(draft, team);
  if (preferred && open.includes(preferred)) return preferred;
  return open[0] ?? null;
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
 * (null = not picked yet), the other team's picks as enemies, every ban. Null when the team
 * already has that role.
 */
export function draftPicksRequest(
  draft: Draft,
  team: Team,
  role: Position,
  limit = DRAFT_PICKS_LIMIT,
): PicksRequestInput | null {
  const mine = teamPicks(draft, team);
  if (mine[role]) return null;
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

/** "Kai'Sa" → "kaisa": search ignores case, spaces and punctuation. */
function searchable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export interface RankedChampion<C> {
  champion: C;
  candidate: PickCandidate;
  /** 1-based rank among the champions still available (search does not renumber). */
  rank: number;
}

/**
 * The champion grid: champions still available whose name matches `query`, split into those the
 * API ranked (by its order: best score first) and the rest (no recommendation: too little data
 * in that role), in `champions` order.
 */
export function championPool<C extends { id: number; name: string }>(
  champions: readonly C[],
  unavailable: ReadonlySet<number>,
  candidates: readonly PickCandidate[] | null,
  query: string,
): { ranked: RankedChampion<C>[]; rest: C[] } {
  const q = searchable(query);
  const byId = new Map(champions.map((c) => [c.id, c]));
  const matches = (c: C) => !q || searchable(c.name).includes(q);
  const ranked: RankedChampion<C>[] = [];
  const rankedIds = new Set<number>();
  for (const candidate of candidates ?? []) {
    const champion = byId.get(candidate.championId);
    if (!champion || unavailable.has(champion.id) || rankedIds.has(champion.id)) continue;
    rankedIds.add(champion.id);
    if (matches(champion)) ranked.push({ champion, candidate, rank: rankedIds.size });
  }
  const rest = champions.filter(
    (c) => !unavailable.has(c.id) && !rankedIds.has(c.id) && matches(c),
  );
  return { ranked, rest };
}
