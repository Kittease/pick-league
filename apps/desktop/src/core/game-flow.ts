/**
 * Pure lobby tracking: champion select session + gameflow phase → which champion select the
 * app shows. A champion select that ends into a game stays on screen (marked "in game") until
 * the game is over, even while the client is closed; a dodged one is dropped as soon as it ends.
 */

import type {
  LcuChampSelectAction,
  LcuChampSelectPlayer,
  LcuChampSelectSession,
  LcuCurrentSummoner,
  LcuGameflowPhase,
  LcuGameflowPlayer,
  LcuGameflowSession,
} from './lcu-types.ts';

const IN_GAME_PHASES = new Set<LcuGameflowPhase>([
  'GameStart',
  'InProgress',
  'Reconnect',
  'WaitingForStats',
  'PreEndOfGame',
]);

/** From the game launch until its end-of-game screen. */
export function isInGamePhase(phase: LcuGameflowPhase | null): boolean {
  return phase !== null && IN_GAME_PHASES.has(phase);
}

/**
 * - `none`: nothing to show.
 * - `select`: champion select running (`session` is live).
 * - `leaving`: the session just ended while the client still says ChampSelect — game starting
 *   or dodge, the next phase tells; the last session stays shown meanwhile.
 * - `game`: game in progress; `session` is the champion select it came from.
 */
export type LobbyStage = 'none' | 'select' | 'leaving' | 'game';

export interface Lobby {
  stage: LobbyStage;
  /** Shown champion select; null only in `none`. */
  session: LcuChampSelectSession | null;
  /** Latest gameflow phase; null = unknown (not reported, client gone). */
  phase: LcuGameflowPhase | null;
}

export type LobbyEvent =
  | { type: 'session'; session: LcuChampSelectSession | null }
  | { type: 'phase'; phase: LcuGameflowPhase | null }
  /** `leaving` lasted too long without a phase change: treat it as a dodge. */
  | { type: 'timeout' }
  /** Teams read from the game in progress (app started in game). */
  | { type: 'recovered'; session: LcuChampSelectSession };

export const NO_LOBBY: Lobby = { stage: 'none', session: null, phase: null };

function cleared(lobby: Lobby): Lobby {
  return { ...lobby, stage: 'none', session: null };
}

export function nextLobby(lobby: Lobby, event: LobbyEvent): Lobby {
  switch (event.type) {
    case 'timeout':
      return lobby.stage === 'leaving' ? cleared(lobby) : lobby;
    case 'recovered':
      return lobby.stage === 'none' && isInGamePhase(lobby.phase)
        ? { ...lobby, stage: 'game', session: event.session }
        : lobby;
    case 'session': {
      const { session } = event;
      if (session) {
        // A late update of the champion select a game just came from is not a new one.
        return { ...lobby, session, stage: isInGamePhase(lobby.phase) ? 'game' : 'select' };
      }
      if (lobby.stage !== 'select') return lobby;
      // Champion select is over; the phase tells whether a game started (it may lag behind).
      if (isInGamePhase(lobby.phase)) return { ...lobby, stage: 'game' };
      if (lobby.phase === 'ChampSelect') return { ...lobby, stage: 'leaving' };
      return cleared(lobby);
    }
    case 'phase': {
      const next = { ...lobby, phase: event.phase };
      if (isInGamePhase(event.phase)) {
        return lobby.stage === 'select' || lobby.stage === 'leaving'
          ? { ...next, stage: 'game' }
          : next;
      }
      // While the session is live, its end decides (a dodge ends it too).
      if (lobby.stage === 'select') return next;
      if (lobby.stage === 'leaving' && event.phase === 'ChampSelect') return next;
      // Client gone during the game (League can close it while playing): the game goes on,
      // the phase the client reports once it is back tells whether it is over.
      if (lobby.stage === 'game' && event.phase === null) return next;
      // Game over, dodge, back to the lobby, client gone.
      return cleared(next);
    }
  }
}

function asPlayer(p: LcuGameflowPlayer, cellId: number, team: number): LcuChampSelectPlayer {
  return {
    cellId,
    championId: p.championId || 0,
    championPickIntent: 0,
    assignedPosition: (p.selectedPosition ?? '').toLowerCase(),
    spell1Id: 0,
    spell2Id: 0,
    team,
  };
}

function isMe(p: { puuid?: string; summonerId?: number }, me: LcuCurrentSummoner): boolean {
  if (p.puuid && me.puuid) return p.puuid === me.puuid;
  return Boolean(p.summonerId && me.summonerId && p.summonerId === me.summonerId);
}

/**
 * Champion select rebuilt from a game in progress (`/lol-gameflow/v1/session`): every pick
 * locked, no bans. Player identities are only used to find the user's team and are not kept.
 * Null when the user is not one of the players (spectating) or the client sent no teams.
 */
export function sessionFromGameflow(
  gameflow: LcuGameflowSession,
  me: LcuCurrentSummoner,
): LcuChampSelectSession | null {
  const { teamOne = [], teamTwo = [] } = gameflow.gameData ?? {};
  const [mine, theirs] = teamOne.some((p) => isMe(p, me))
    ? [teamOne, teamTwo]
    : teamTwo.some((p) => isMe(p, me))
      ? [teamTwo, teamOne]
      : [null, null];
  if (!mine || !theirs) return null;
  const localCell = mine.findIndex((p) => isMe(p, me));
  const myTeam = mine.map((p, i) => asPlayer(p, i, 1));
  const theirTeam = theirs.map((p, i) => asPlayer(p, mine.length + i, 2));
  const selection = gameflow.gameData.playerChampionSelections?.find((s) => isMe(s, me));
  const local = myTeam[localCell];
  if (local && selection)
    [local.spell1Id, local.spell2Id] = [selection.spell1Id, selection.spell2Id];

  let actionId = 1;
  const picks: LcuChampSelectAction[] = [...myTeam, ...theirTeam]
    .filter((p) => p.championId > 0)
    .map((p) => ({
      id: actionId++,
      actorCellId: p.cellId,
      championId: p.championId,
      completed: true,
      isAllyAction: p.team === 1,
      isInProgress: false,
      type: 'pick',
    }));
  return {
    gameId: gameflow.gameData.gameId,
    localPlayerCellId: localCell,
    myTeam,
    theirTeam,
    actions: [picks],
    bans: { myTeamBans: [], theirTeamBans: [], numBans: 0 },
    timer: { phase: 'GAME_STARTING', adjustedTimeLeftInPhase: 0 },
  };
}
