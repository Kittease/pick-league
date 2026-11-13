import { describe, expect, test } from 'bun:test';
import { picksRequestSchema } from '@pick-league/shared';
import {
  availableChampionIds,
  buildBuildRequest,
  buildPicksRequest,
  deriveChampSelect,
  lcuPositionToPosition,
  localLockedChampion,
} from './champ-select.ts';
import type {
  LcuChampSelectAction,
  LcuChampSelectPlayer,
  LcuChampSelectSession,
} from './lcu-types.ts';

function player(cellId: number, over: Partial<LcuChampSelectPlayer> = {}): LcuChampSelectPlayer {
  return {
    cellId,
    championId: 0,
    championPickIntent: 0,
    assignedPosition: '',
    spell1Id: 0,
    spell2Id: 0,
    team: cellId < 5 ? 1 : 2,
    ...over,
  };
}

function action(over: Partial<LcuChampSelectAction>): LcuChampSelectAction {
  return {
    id: 1,
    actorCellId: 0,
    championId: 0,
    completed: false,
    isAllyAction: true,
    isInProgress: false,
    type: 'pick',
    ...over,
  };
}

function session(over: Partial<LcuChampSelectSession> = {}): LcuChampSelectSession {
  return {
    gameId: 1,
    localPlayerCellId: 4,
    myTeam: [
      player(0, { assignedPosition: 'top', championId: 516 }),
      player(1, { assignedPosition: 'jungle', championPickIntent: 64 }),
      player(2, { assignedPosition: 'middle' }),
      player(3, { assignedPosition: 'bottom', championId: 222 }),
      player(4, {
        assignedPosition: 'utility',
        championPickIntent: 267,
        spell1Id: 14,
        spell2Id: 4,
      }),
    ],
    theirTeam: [player(5, { championId: 122 }), player(6), player(7), player(8), player(9)],
    actions: [
      [
        action({ id: 1, actorCellId: 0, type: 'ban', championId: 53, completed: true }),
        action({
          id: 2,
          actorCellId: 5,
          type: 'ban',
          championId: 412,
          completed: true,
          isAllyAction: false,
        }),
      ],
      [action({ id: 3, actorCellId: 0, championId: 516, completed: true })],
      [action({ id: 4, actorCellId: 5, championId: 122, completed: true, isAllyAction: false })],
      [action({ id: 5, actorCellId: 3, championId: 222, isInProgress: true })],
    ],
    bans: { myTeamBans: [53], theirTeamBans: [412], numBans: 10 },
    timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 20_000 },
    ...over,
  };
}

describe('lcuPositionToPosition', () => {
  test('maps LCU positions to API positions', () => {
    expect(lcuPositionToPosition('utility')).toBe('UTILITY');
    expect(lcuPositionToPosition('middle')).toBe('MIDDLE');
    expect(lcuPositionToPosition('bottom')).toBe('BOTTOM');
    expect(lcuPositionToPosition('')).toBeNull();
    expect(lcuPositionToPosition('NONE')).toBeNull();
  });
});

describe('deriveChampSelect', () => {
  test('splits me, allies and enemies with hover/locked state', () => {
    const view = deriveChampSelect(session(), 'MIDDLE');
    expect(view.role).toBe('UTILITY');
    expect(view.roleAssumed).toBe(false);
    expect(view.me).toMatchObject({ cellId: 4, championId: 267, hovering: true, locked: false });
    expect(view.allies.map((a) => a.cellId)).toEqual([0, 1, 2, 3]);
    expect(view.allies[0]).toMatchObject({ championId: 516, locked: true, role: 'TOP' });
    expect(view.allies[1]).toMatchObject({ championId: 64, hovering: true, locked: false });
    expect(view.allies[2]).toMatchObject({ championId: null, hovering: false });
    expect(view.enemies[0]).toMatchObject({ championId: 122, locked: true, role: null });
    expect(view.enemies[1]?.championId).toBeNull();
    expect(view.bans).toEqual({ ally: [53], enemy: [412] });
    expect(view.mySpells).toEqual([14, 4]);
    expect(view.lockedIn).toBe(false);
  });

  test('falls back to the configured role when no position is assigned', () => {
    const s = session();
    s.myTeam = s.myTeam.map((p) => ({ ...p, assignedPosition: '' }));
    const view = deriveChampSelect(s, 'UTILITY');
    expect(view.role).toBe('UTILITY');
    expect(view.roleAssumed).toBe(true);
  });

  test('collects bans from completed ban actions when the bans arrays are empty', () => {
    const view = deriveChampSelect(
      session({ bans: { myTeamBans: [], theirTeamBans: [], numBans: 10 } }),
      'UTILITY',
    );
    expect(view.bans).toEqual({ ally: [53], enemy: [412] });
  });
});

describe('lock-in detection', () => {
  test('not locked while the local pick action is only in progress', () => {
    const s = session();
    s.actions.push([action({ id: 9, actorCellId: 4, championId: 267, isInProgress: true })]);
    expect(localLockedChampion(s)).toBeNull();
  });

  test('locked once the local pick action is completed', () => {
    const s = session();
    s.actions.push([action({ id: 9, actorCellId: 4, championId: 267, completed: true })]);
    expect(localLockedChampion(s)).toBe(267);
    const view = deriveChampSelect(s, 'UTILITY');
    expect(view.lockedIn).toBe(true);
    expect(view.lockedChampionId).toBe(267);
    expect(view.me.locked).toBe(true);
  });

  test("another player's completed pick does not count", () => {
    expect(localLockedChampion(session())).toBeNull();
  });

  test('a completed ban by the local player is not a lock-in', () => {
    const s = session();
    s.actions.push([
      action({ id: 9, actorCellId: 4, championId: 25, completed: true, type: 'ban' }),
    ]);
    expect(localLockedChampion(s)).toBeNull();
  });
});

describe('availableChampionIds', () => {
  test('owned, rented and free-to-play champions are available', () => {
    expect(
      availableChampionIds([
        { id: 1, ownership: { owned: true } },
        { id: 2, ownership: { owned: false, rental: { rented: true } } },
        { id: 3, freeToPlay: true, ownership: { owned: false } },
        { id: 4, ownership: { owned: false } },
        { id: -1, ownership: { owned: true } },
      ]),
    ).toEqual([1, 2, 3]);
  });
});

describe('buildPicksRequest', () => {
  test('maps the session to a valid picks request', () => {
    const view = deriveChampSelect(session(), 'UTILITY');
    const request = buildPicksRequest(view, [267, 40, 117]);
    expect(request).toEqual({
      role: 'UTILITY',
      allies: [
        { championId: 516, role: 'TOP' },
        { championId: 64, role: 'JUNGLE' },
        { championId: null, role: 'MIDDLE' },
        { championId: 222, role: 'BOTTOM' },
      ],
      enemies: [122, null, null, null, null],
      bans: [53, 412],
      availableChampionIds: [40, 117, 267],
      limit: 20,
    });
    expect(picksRequestSchema.safeParse(request).success).toBe(true);
  });

  test('omits availableChampionIds when owned champions are unknown', () => {
    const view = deriveChampSelect(session(), 'UTILITY');
    expect(buildPicksRequest(view, null).availableChampionIds).toBeUndefined();
    expect(buildPicksRequest(view, []).availableChampionIds).toBeUndefined();
  });
});

describe('buildBuildRequest', () => {
  test('null until a champion is locked or chosen', () => {
    expect(buildBuildRequest(deriveChampSelect(session(), 'UTILITY'))).toBeNull();
  });

  test('uses the locked champion and only known allies/enemies', () => {
    const s = session();
    s.actions.push([action({ id: 9, actorCellId: 4, championId: 267, completed: true })]);
    expect(buildBuildRequest(deriveChampSelect(s, 'UTILITY'))).toEqual({
      championId: 267,
      role: 'UTILITY',
      allies: [
        { championId: 516, role: 'TOP' },
        { championId: 64, role: 'JUNGLE' },
        { championId: 222, role: 'BOTTOM' },
      ],
      enemies: [{ championId: 122, role: null }],
    });
  });

  test('can preview another champion', () => {
    expect(buildBuildRequest(deriveChampSelect(session(), 'UTILITY'), 40)?.championId).toBe(40);
  });
});
