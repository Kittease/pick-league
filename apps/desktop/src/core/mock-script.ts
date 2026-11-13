/**
 * Scripted champion select for the mock LCU (`PICKLEAGUE_MOCK_LCU=1` or the dev toggle).
 * Pure: `mockSessionAt(ms)` is the session `ms` after the mock queue popped (null = not in
 * champion select). The local player is the support (cell 4) of the blue side, hovers Nami
 * during planning, sees bans and picks progress, then locks in Nami before the last enemy pick.
 */

import type {
  LcuChampionMastery,
  LcuChampSelectAction,
  LcuChampSelectPlayer,
  LcuChampSelectSession,
  LcuCurrentSummoner,
  LcuOwnedChampion,
} from './lcu-types.ts';

export const MOCK_LOCAL_CELL = 4;
export const MOCK_LOCKED_CHAMPION = 267; // Nami
export const MOCK_INITIAL_SPELLS: [number, number] = [14, 4]; // Ignite on D, Flash on F

const POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility'] as const;

/** Champion ids per cell (0-4 allies, 5-9 enemies). */
const PICKS: Record<number, number> = {
  0: 516, // Ornn
  1: 64, // Lee Sin
  2: 103, // Ahri
  3: 222, // Jinx
  4: MOCK_LOCKED_CHAMPION,
  5: 122, // Darius
  6: 254, // Vi
  7: 134, // Syndra
  8: 145, // Kai'Sa
  9: 111, // Nautilus
};
/** Ally hover shown before each ally locks (cell → champion). */
const ALLY_HOVERS: Record<number, number> = { 0: 516, 1: 64, 2: 103, 3: 222, 4: 40 /* Janna */ };
const ALLY_BANS = [53, 555, 157, 238, 777]; // Blitzcrank, Pyke, Yasuo, Zed, Yone
const ENEMY_BANS = [412, 141, 11, 25, 99]; // Thresh, Kayn, Master Yi, Morgana, Lux

const STEP = 2_500;
/** Pick order: cell ids. The user (4) locks before the last enemy (9). */
const PICK_ORDER = [0, 5, 6, 1, 2, 7, 8, 3, 4, 9];

export const MOCK_TIMINGS = {
  planningEnd: 5_000,
  bansDone: 5_000 + STEP,
  /** Each pick: hover at `start`, lock at `start + STEP`. */
  pickStart: (index: number) => 5_000 + 2 * STEP + index * 2 * STEP,
  get localLock(): number {
    return this.pickStart(PICK_ORDER.indexOf(MOCK_LOCAL_CELL)) + STEP;
  },
  get finalization(): number {
    return this.pickStart(PICK_ORDER.length) + STEP;
  },
  get end(): number {
    return this.finalization + 30_000;
  },
};

/** Gap without champion select between two mock loops. */
export const MOCK_IDLE_MS = 6_000;

function player(cellId: number, team: number): LcuChampSelectPlayer {
  const local = cellId === MOCK_LOCAL_CELL;
  return {
    cellId,
    championId: 0,
    championPickIntent: 0,
    assignedPosition: team === 1 ? (POSITIONS[cellId] ?? '') : '',
    spell1Id: local ? MOCK_INITIAL_SPELLS[0] : 0,
    spell2Id: local ? MOCK_INITIAL_SPELLS[1] : 0,
    team,
  };
}

/** Session `elapsedMs` into the scripted champion select; null once it is over. */
export function mockSessionAt(elapsedMs: number): LcuChampSelectSession | null {
  if (elapsedMs < 0 || elapsedMs >= MOCK_TIMINGS.end) return null;
  const t = elapsedMs;
  const myTeam = [0, 1, 2, 3, 4].map((c) => player(c, 1));
  const theirTeam = [5, 6, 7, 8, 9].map((c) => player(c, 2));
  const byCell = (cell: number) => (cell < 5 ? myTeam[cell] : theirTeam[cell - 5]);

  let actionId = 1;
  const banActions: LcuChampSelectAction[] = [...ALLY_BANS, ...ENEMY_BANS].map((championId, i) => {
    const ally = i < 5;
    const done = t >= MOCK_TIMINGS.bansDone;
    return {
      id: actionId++,
      actorCellId: i,
      championId: done ? championId : 0,
      completed: done,
      isAllyAction: ally,
      isInProgress: t >= MOCK_TIMINGS.planningEnd && !done,
      type: 'ban',
    };
  });

  // Planning: the user declares Nami.
  if (t >= 1_000) {
    const me = byCell(MOCK_LOCAL_CELL);
    if (me) me.championPickIntent = MOCK_LOCKED_CHAMPION;
  }

  const pickActions: LcuChampSelectAction[] = PICK_ORDER.map((cell, index) => {
    const start = MOCK_TIMINGS.pickStart(index);
    const hovering = t >= start && t < start + STEP;
    const done = t >= start + STEP;
    const ally = cell < 5;
    const p = byCell(cell);
    const champion = PICKS[cell] ?? 0;
    if (p && ally && hovering) {
      // The user changes their mind live: hovers Janna, then locks Nami.
      p.championId =
        cell === MOCK_LOCAL_CELL && t < start + STEP / 2 ? (ALLY_HOVERS[cell] ?? 0) : champion;
    }
    if (p && done) p.championId = champion;
    return {
      id: actionId++,
      actorCellId: cell,
      championId: (ally && hovering) || done ? (p?.championId ?? champion) : 0,
      completed: done,
      isAllyAction: ally,
      isInProgress: hovering,
      type: 'pick',
    };
  });

  const bansDone = t >= MOCK_TIMINGS.bansDone;
  const phase =
    t < MOCK_TIMINGS.planningEnd
      ? 'PLANNING'
      : t < MOCK_TIMINGS.finalization
        ? 'BAN_PICK'
        : 'FINALIZATION';
  return {
    gameId: 0,
    localPlayerCellId: MOCK_LOCAL_CELL,
    myTeam,
    theirTeam,
    actions: [banActions, ...pickActions.map((a) => [a])],
    bans: {
      myTeamBans: bansDone ? [...ALLY_BANS] : [],
      theirTeamBans: bansDone ? [...ENEMY_BANS] : [],
      numBans: 10,
    },
    timer: { phase, adjustedTimeLeftInPhase: 30_000 },
  };
}

/** Owned champions: most supports, minus a few to show the "owned only" filter. */
const OWNED = [
  12, 16, 26, 37, 40, 43, 44, 53, 63, 89, 99, 111, 117, 143, 201, 223, 235, 267, 350, 412, 432, 497,
  526, 555, 902, 25, 3, 50, 74, 161, 103, 222, 64, 516,
];
const FREE_ROTATION = [910]; // Hwei

export function mockOwnedChampions(): LcuOwnedChampion[] {
  return [
    ...OWNED.map((id) => ({
      id,
      freeToPlay: false,
      ownership: { owned: true, rental: { rented: false } },
    })),
    ...FREE_ROTATION.map((id) => ({
      id,
      freeToPlay: true,
      ownership: { owned: false, rental: { rented: false } },
    })),
  ];
}

const MASTERY: [number, number][] = [
  [267, 42], // Nami
  [40, 23], // Janna
  [117, 15], // Lulu
  [201, 11], // Braum
  [350, 8], // Yuumi
  [16, 7], // Soraka
  [37, 6], // Sona
  [412, 9], // Thresh
  [111, 5], // Nautilus
  [89, 4], // Leona
  [43, 3], // Karma
  [526, 2], // Rell
  [902, 1], // Milio
];

export function mockMastery(): LcuChampionMastery[] {
  return MASTERY.map(([championId, championLevel]) => ({
    championId,
    championLevel,
    championPoints: championLevel * 11_000 + (championId % 7) * 1_000,
  }));
}

export function mockCurrentSummoner(): LcuCurrentSummoner {
  return { summonerId: 1, gameName: 'MockSupport', tagLine: 'DEV' };
}
