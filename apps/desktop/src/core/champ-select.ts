/**
 * Pure champion-select logic: LCU session → what the UI shows and what we ask the API.
 * Runtime-agnostic (used by the main process and its tests).
 */

import type {
  BuildRequestInput,
  DraftRequestInput,
  DraftSide,
  PicksRequestInput,
  Position,
} from '@pick-league/shared';
import type {
  LcuChampSelectAction,
  LcuChampSelectPlayer,
  LcuChampSelectSession,
  LcuOwnedChampion,
} from './lcu-types.ts';

const LCU_POSITIONS: Record<string, Position> = {
  top: 'TOP',
  jungle: 'JUNGLE',
  middle: 'MIDDLE',
  mid: 'MIDDLE',
  bottom: 'BOTTOM',
  bot: 'BOTTOM',
  utility: 'UTILITY',
  support: 'UTILITY',
};

/** LCU `assignedPosition` ('utility') → API position ('UTILITY'); null when unassigned. */
export function lcuPositionToPosition(value: string | null | undefined): Position | null {
  if (!value) return null;
  return LCU_POSITIONS[value.toLowerCase()] ?? null;
}

export interface SelectPlayerView {
  cellId: number;
  /** Locked or hovered champion; null = nothing yet. */
  championId: number | null;
  /** true when `championId` is only hovered / declared, not locked. */
  hovering: boolean;
  locked: boolean;
  role: Position | null;
}

export interface ChampSelectView {
  phase: string;
  /** The role we recommend for. */
  role: Position;
  /** true when the client gave no assigned position (blind pick…) and `role` is the fallback. */
  roleAssumed: boolean;
  me: SelectPlayerView;
  /** The 4 teammates (the user excluded), in cell order. */
  allies: SelectPlayerView[];
  enemies: SelectPlayerView[];
  bans: { ally: number[]; enemy: number[] };
  /** The local player's pick action is completed. */
  lockedIn: boolean;
  lockedChampionId: number | null;
  /** Current summoner spells of the local player [D, F]. */
  mySpells: [number, number];
  /** Side of the user's team (LCU team 1 = blue, 2 = red); null when unknown. */
  side?: DraftSide | null;
}

function allActions(session: LcuChampSelectSession): LcuChampSelectAction[] {
  return session.actions.flat();
}

function completedPickByCell(session: LcuChampSelectSession): Map<number, number> {
  const out = new Map<number, number>();
  for (const a of allActions(session)) {
    if (a.type === 'pick' && a.completed && a.championId > 0) out.set(a.actorCellId, a.championId);
  }
  return out;
}

/**
 * Lock-in detection: the local player's pick action is completed.
 * Returns the locked champion id, or null while not locked in.
 */
export function localLockedChampion(session: LcuChampSelectSession): number | null {
  const action = allActions(session).find(
    (a) =>
      a.type === 'pick' &&
      a.actorCellId === session.localPlayerCellId &&
      a.completed &&
      a.championId > 0,
  );
  return action?.championId ?? null;
}

function playerView(
  p: LcuChampSelectPlayer,
  locked: Map<number, number>,
  revealOnlyLocked: boolean,
): SelectPlayerView {
  const lockedId = locked.get(p.cellId);
  if (lockedId !== undefined) {
    return {
      cellId: p.cellId,
      championId: lockedId,
      hovering: false,
      locked: true,
      role: lcuPositionToPosition(p.assignedPosition),
    };
  }
  const shown = p.championId > 0 ? p.championId : revealOnlyLocked ? 0 : p.championPickIntent;
  return {
    cellId: p.cellId,
    championId: shown > 0 ? shown : null,
    // Enemies only ever expose locked champions; a non-zero id there counts as locked.
    hovering: shown > 0 && !revealOnlyLocked,
    locked: shown > 0 && revealOnlyLocked,
    role: lcuPositionToPosition(p.assignedPosition),
  };
}

function uniquePositive(ids: Iterable<number>): number[] {
  return [...new Set([...ids].filter((id) => Number.isInteger(id) && id > 0))];
}

export function deriveChampSelect(
  session: LcuChampSelectSession,
  fallbackRole: Position,
): ChampSelectView {
  const locked = completedPickByCell(session);
  const meRaw = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
  const me: SelectPlayerView = meRaw
    ? playerView(meRaw, locked, false)
    : {
        cellId: session.localPlayerCellId,
        championId: null,
        hovering: false,
        locked: false,
        role: null,
      };
  const allies = session.myTeam
    .filter((p) => p.cellId !== session.localPlayerCellId)
    .map((p) => playerView(p, locked, false));
  const enemies = session.theirTeam.map((p) => playerView(p, locked, true));

  const actions = allActions(session);
  const bannedBy = (ally: boolean) =>
    actions
      .filter((a) => a.type === 'ban' && a.completed && a.isAllyAction === ally)
      .map((a) => a.championId);

  const lockedChampionId = localLockedChampion(session);
  return {
    phase: session.timer.phase,
    role: me.role ?? fallbackRole,
    roleAssumed: me.role === null,
    me,
    allies,
    enemies,
    bans: {
      ally: uniquePositive([...session.bans.myTeamBans, ...bannedBy(true)]),
      enemy: uniquePositive([...session.bans.theirTeamBans, ...bannedBy(false)]),
    },
    lockedIn: lockedChampionId !== null,
    lockedChampionId,
    mySpells: [meRaw?.spell1Id ?? 0, meRaw?.spell2Id ?? 0],
    side: meRaw?.team === 1 ? 'blue' : meRaw?.team === 2 ? 'red' : null,
  };
}

/** Champions the user can pick: owned, free rotation, or rented. */
export function availableChampionIds(owned: readonly LcuOwnedChampion[]): number[] {
  return uniquePositive(
    owned
      .filter(
        (c) =>
          c.ownership?.owned === true ||
          c.ownership?.rental?.rented === true ||
          c.freeToPlay === true,
      )
      .map((c) => c.id),
  );
}

export const DEFAULT_PICKS_LIMIT = 20;

/** Body of `POST /recommendations/picks` for the current state of champion select. */
export function buildPicksRequest(
  view: ChampSelectView,
  available: readonly number[] | null,
  limit = DEFAULT_PICKS_LIMIT,
): PicksRequestInput {
  const request: PicksRequestInput = {
    role: view.role,
    allies: view.allies.slice(0, 4).map((a) => ({ championId: a.championId, role: a.role })),
    enemies: view.enemies.slice(0, 5).map((e) => e.championId),
    bans: uniquePositive([...view.bans.ally, ...view.bans.enemy]).slice(0, 10),
    limit,
  };
  if (available && available.length > 0)
    request.availableChampionIds = [...available].sort((a, b) => a - b);
  return request;
}

/**
 * Body of `POST /recommendations/build` for `championId` (defaults to the locked champion).
 * Returns null when there is no champion to build.
 */
export function buildBuildRequest(
  view: ChampSelectView,
  championId?: number | null,
): BuildRequestInput | null {
  const id = championId ?? view.lockedChampionId;
  if (!id) return null;
  const known = (players: SelectPlayerView[]) =>
    players.flatMap((p) => (p.championId ? [{ championId: p.championId, role: p.role }] : []));
  return {
    championId: id,
    role: view.role,
    allies: known(view.allies).slice(0, 4),
    enemies: known(view.enemies).slice(0, 5),
  };
}

/**
 * Body of `POST /recommendations/draft` for the current state of champion select: the user and
 * the teammates as allies (the user in the role recommended for), the enemies (roles unknown
 * unless the client gives them), the side. Hovered champions count: the draft as it stands.
 */
export function buildDraftRequest(view: ChampSelectView): DraftRequestInput {
  const known = (players: SelectPlayerView[]) =>
    players.flatMap((p) => (p.championId ? [{ championId: p.championId, role: p.role }] : []));
  const me = view.me.championId ? [{ championId: view.me.championId, role: view.role }] : [];
  return {
    allies: [...me, ...known(view.allies)].slice(0, 5),
    enemies: known(view.enemies).slice(0, 5),
    side: view.side ?? null,
  };
}

/** Stable key used to skip identical consecutive API requests. */
export function requestKey(request: unknown): string {
  return JSON.stringify(request);
}
