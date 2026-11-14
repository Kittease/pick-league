/**
 * Test fixtures: League client payloads with made-up players. The local player is the support
 * (cell 4) of the blue side; every other pick is locked.
 */

import type {
  LcuChampSelectAction,
  LcuChampSelectPlayer,
  LcuChampSelectSession,
  LcuCurrentSummoner,
  LcuGameflowSession,
} from './lcu-types.ts';

export const LOCAL_CELL = 4;
export const LOCKED_CHAMPION = 267;
export const ALLY_PICKS = [516, 64, 103, 222];
export const ENEMY_PICKS = [122, 254, 134, 145, 111];
const POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility'];
const LOCAL_PUUID = 'fake-puuid-local';

export const FAKE_SUMMONER: LcuCurrentSummoner = {
  summonerId: 1,
  puuid: LOCAL_PUUID,
  gameName: 'FakePlayer',
  tagLine: 'TEST',
};

export interface LocalPick {
  /** Hovered or locked champion; 0 = none yet. */
  championId: number;
  locked: boolean;
}

/** Champion select where the local player hovers or locks `me.championId`. */
export function champSelectSession(
  me: LocalPick = { championId: LOCKED_CHAMPION, locked: true },
  spells: [number, number] = [14, 4],
): LcuChampSelectSession {
  const player = (cellId: number, championId: number): LcuChampSelectPlayer => ({
    cellId,
    championId,
    championPickIntent: 0,
    assignedPosition: cellId < 5 ? (POSITIONS[cellId] ?? '') : '',
    spell1Id: cellId === LOCAL_CELL ? spells[0] : 0,
    spell2Id: cellId === LOCAL_CELL ? spells[1] : 0,
    team: cellId < 5 ? 1 : 2,
  });
  const myTeam = [...ALLY_PICKS, me.championId].map((id, cell) => player(cell, id));
  const theirTeam = ENEMY_PICKS.map((id, i) => player(5 + i, id));
  const pick = (p: LcuChampSelectPlayer): LcuChampSelectAction => {
    const local = p.cellId === LOCAL_CELL;
    return {
      id: p.cellId + 1,
      actorCellId: p.cellId,
      championId: p.championId,
      completed: !local || me.locked,
      isAllyAction: p.team === 1,
      isInProgress: local && !me.locked,
      type: 'pick',
    };
  };
  return {
    gameId: 1,
    localPlayerCellId: LOCAL_CELL,
    myTeam,
    theirTeam,
    actions: [...myTeam, ...theirTeam].map((p) => [pick(p)]),
    bans: { myTeamBans: [], theirTeamBans: [], numBans: 0 },
    timer: { phase: me.locked ? 'FINALIZATION' : 'BAN_PICK', adjustedTimeLeftInPhase: 30_000 },
  };
}

/** `/lol-gameflow/v1/session` of the game that follows; `spells` = the local player's [D, F]. */
export function gameflowSession(spells: [number, number]): LcuGameflowSession {
  const team = (ids: number[], first: number) =>
    ids.map((championId, i) => ({
      championId,
      selectedPosition: (POSITIONS[i] ?? '').toUpperCase(),
      puuid: first + i === LOCAL_CELL ? LOCAL_PUUID : `fake-puuid-${first + i}`,
    }));
  return {
    phase: 'InProgress',
    gameData: {
      gameId: 1,
      teamOne: team([...ALLY_PICKS, LOCKED_CHAMPION], 0),
      teamTwo: team(ENEMY_PICKS, 5),
      playerChampionSelections: [
        {
          championId: LOCKED_CHAMPION,
          puuid: LOCAL_PUUID,
          spell1Id: spells[0],
          spell2Id: spells[1],
        },
      ],
    },
  };
}
