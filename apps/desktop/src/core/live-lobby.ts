/**
 * Pure side of the lobby lookup: rank, recent form and mastery of the 10 players of the game in
 * progress, fetched through the user's own API (the worker asks Riot).
 *
 * Only once the game has started: never in champion select, where Riot hides who the players
 * are (the helper never reveals hidden identities). No player id is sent: the League client's are
 * not the Riot API's. The API gets the game id, the user's own Riot ID (the worker finds the game
 * through it, spectator-v5) and the players by team, champion and role; the UI gets `LobbyView`.
 */

import {
  isPosition,
  type LiveGameState,
  type LiveLookupStatus,
  type LivePlayerRequest,
  type LivePlayersResponse,
  type LiveRank,
  type LiveRecentStats,
  type LiveTeam,
  type LiveWorkerState,
  type Platform,
  POSITIONS,
  type Position,
  type RiotId,
} from '@pick-league/shared';
import { isMe } from './game-flow.ts';
import type {
  LcuCurrentSummoner,
  LcuGameflowPhase,
  LcuGameflowPlayer,
  LcuGameflowSession,
  LcuPlatformHints,
} from './lcu-types.ts';

/**
 * Phases where the lobby may be looked up: the game is running. Not champion select (hidden
 * identities), not the loading screen before it, not the end of the game.
 */
const LOOKUP_PHASES = new Set<LcuGameflowPhase>(['InProgress', 'Reconnect']);

export function canLookUpLobby(phase: LcuGameflowPhase | null | undefined): boolean {
  return phase != null && LOOKUP_PHASES.has(phase);
}

/** League client region / platform id → a platform PickLeague collects (null for the others). */
const PLATFORM_OF: Record<string, Platform> = {
  EUW: 'EUW1',
  EUW1: 'EUW1',
  NA: 'NA1',
  NA1: 'NA1',
  KR: 'KR',
  VN: 'VN2',
  VN2: 'VN2',
};

/** The user's platform: the client's platform id first, else its region. */
export function platformFromLcu(hints: LcuPlatformHints): Platform | null {
  for (const raw of [hints.platformId, hints.region]) {
    const key = raw?.trim().toUpperCase();
    const platform = key ? PLATFORM_OF[key] : undefined;
    if (platform) return platform;
  }
  return null;
}

/** What the main process sends to the API for one game. */
export interface LiveLobbyRequest {
  gameId: number;
  /** The user's own Riot ID: the worker finds the game through it. */
  me: RiotId;
  /** Players with a champion (each champion once per team), the user's team first. */
  players: LivePlayerRequest[];
  /** Index of the user in `players`; -1 when not among them. */
  meIndex: number;
}

function toRequest(p: LcuGameflowPlayer, team: LiveTeam): LivePlayerRequest | null {
  if (!(p.championId > 0)) return null;
  const position = (p.selectedPosition ?? '').toUpperCase();
  return {
    championId: p.championId,
    position: isPosition(position) ? position : null,
    team,
  };
}

/**
 * The players to look up, from `/lol-gameflow/v1/session`. Null unless both the tracked phase and
 * the session say the game is running (`canLookUpLobby`), when the user is not one of the
 * players (spectating), has no Riot ID, or when no player can be looked up.
 */
export function lobbyRequestFromGameflow(
  gameflow: LcuGameflowSession,
  me: LcuCurrentSummoner,
  phase: LcuGameflowPhase | null,
): LiveLobbyRequest | null {
  if (!canLookUpLobby(phase) || !canLookUpLobby(gameflow.phase)) return null;
  const gameName = me.gameName?.trim();
  const tagLine = me.tagLine?.trim();
  if (!gameName || !tagLine) return null;
  const { teamOne = [], teamTwo = [] } = gameflow.gameData ?? {};
  const [mine, theirs] = teamOne.some((p) => isMe(p, me))
    ? [teamOne, teamTwo]
    : teamTwo.some((p) => isMe(p, me))
      ? [teamTwo, teamOne]
      : [null, null];
  if (!mine || !theirs) return null;
  let meIndex = -1;
  const players: LivePlayerRequest[] = [];
  for (const [list, team] of [
    [mine, 'ally'],
    [theirs, 'enemy'],
  ] as const) {
    for (const p of list) {
      const req = toRequest(p, team);
      // A champion twice in a team cannot be told apart (never in draft queues): left out.
      if (!req || players.some((o) => o.team === team && o.championId === req.championId)) continue;
      if (team === 'ally' && isMe(p, me)) meIndex = players.length;
      players.push(req);
    }
  }
  if (players.length === 0 || players.length > 10) return null;
  const gameId = gameflow.gameData.gameId;
  if (!Number.isSafeInteger(gameId) || gameId <= 0) return null;
  return { gameId, me: { gameName, tagLine }, players, meIndex };
}

export interface LobbyPlayerView {
  team: LiveTeam;
  /** The user. */
  me: boolean;
  championId: number;
  position: Position | null;
  status: LiveLookupStatus;
  rankLoaded: boolean;
  rank: LiveRank | null;
  mastery: { level: number; points: number } | null;
  recent: LiveRecentStats | null;
}

/**
 * - `loading`: asking the API until every player is in.
 * - `done`: every player is ready or failed.
 * - `error`: the API did not answer (still retried while the game runs).
 * - `timeout`: gave up waiting (the worker is slow or down).
 * - `unsupported`: the user's server is not collected by PickLeague / the worker.
 */
export type LobbyState = 'loading' | 'done' | 'error' | 'timeout' | 'unsupported';

/** The lobby lookup as the UI sees it (no puuids). */
export interface LobbyView {
  state: LobbyState;
  message: string | null;
  platform: Platform | null;
  worker: LiveWorkerState | null;
  /** Finding the game on Riot's side (null before the first answer). */
  game: LiveGameState | null;
  allies: LobbyPlayerView[];
  enemies: LobbyPlayerView[];
}

const positionOrder = (p: Position | null) =>
  p === null ? POSITIONS.length : POSITIONS.indexOf(p);

/**
 * The view of a lookup: each requested player with what the API answered so far (pending
 * without an answer), teams in scoreboard order (top → support, unknown roles last).
 */
export function lobbyView(
  request: LiveLobbyRequest,
  platform: Platform | null,
  response: LivePlayersResponse | null,
  state: LobbyState,
  message: string | null = null,
): LobbyView {
  const players = request.players.map((p, index): LobbyPlayerView & { index: number } => {
    const answer = response?.players.find((r) => r.index === index);
    return {
      index,
      team: p.team,
      me: index === request.meIndex,
      championId: p.championId,
      position: p.position,
      status: answer?.status ?? (state === 'unsupported' ? 'unsupported' : 'pending'),
      rankLoaded: answer?.rankLoaded ?? false,
      rank: answer?.rank ?? null,
      mastery: answer?.mastery ?? null,
      recent: answer?.recent ?? null,
    };
  });
  const team = (t: LiveTeam): LobbyPlayerView[] =>
    players
      .filter((p) => p.team === t)
      .sort((a, b) => positionOrder(a.position) - positionOrder(b.position) || a.index - b.index)
      .map(({ index: _, ...p }) => p);
  return {
    state,
    message,
    platform,
    worker: response?.worker ?? null,
    game: response?.game ?? null,
    allies: team('ally'),
    enemies: team('enemy'),
  };
}
