import { describe, expect, test } from 'bun:test';
import { deriveChampSelect } from './champ-select.ts';
import { champSelectSession, FAKE_SUMMONER, gameflowSession, LOCKED_CHAMPION } from './fixtures.ts';
import {
  isInGamePhase,
  type Lobby,
  type LobbyEvent,
  NO_LOBBY,
  nextLobby,
  sessionFromGameflow,
} from './game-flow.ts';
import type { LcuGameflowSession } from './lcu-types.ts';

const selectSession = champSelectSession();

const phase = (p: string | null): LobbyEvent => ({ type: 'phase', phase: p });
const session = (s = selectSession): LobbyEvent => ({ type: 'session', session: s });
const ended: LobbyEvent = { type: 'session', session: null };

function run(events: LobbyEvent[], from: Lobby = NO_LOBBY): Lobby {
  return events.reduce(nextLobby, from);
}

describe('lobby tracking', () => {
  test('a champion select that ends into a game stays shown until the game is over', () => {
    let lobby = run([phase('ChampSelect'), session()]);
    expect(lobby.stage).toBe('select');
    lobby = run([phase('GameStart'), ended], lobby);
    expect(lobby).toMatchObject({ stage: 'game', session: selectSession });
    lobby = run([phase('InProgress'), phase('Reconnect'), phase('WaitingForStats')], lobby);
    lobby = run([phase('PreEndOfGame')], lobby);
    expect(lobby).toMatchObject({ stage: 'game', session: selectSession });
    expect(run([phase('EndOfGame')], lobby)).toMatchObject({ stage: 'none', session: null });
  });

  test('the session may end before the client reports the game', () => {
    const leaving = run([phase('ChampSelect'), session(), ended]);
    expect(leaving).toMatchObject({ stage: 'leaving', session: selectSession });
    expect(run([phase('GameStart')], leaving)).toMatchObject({ stage: 'game' });
  });

  test('a dodge drops the champion select', () => {
    const leaving = run([phase('ChampSelect'), session(), ended]);
    expect(run([phase('Lobby')], leaving).stage).toBe('none');
    // Someone else dodged: straight back in queue.
    expect(run([phase('Matchmaking')], leaving).stage).toBe('none');
    // No phase change at all: the controller times out.
    expect(run([{ type: 'timeout' }], leaving).stage).toBe('none');
    // Phase already back to the lobby when the session ends.
    expect(run([phase('ChampSelect'), session(), phase('Lobby'), ended]).stage).toBe('none');
  });

  test('without any phase, an ended session is dropped as before', () => {
    expect(run([session(), ended])).toMatchObject({ stage: 'none', session: null });
  });

  test('back to the lobby ends the kept game', () => {
    const game = run([phase('ChampSelect'), session(), phase('InProgress')]);
    expect(game.stage).toBe('game');
    for (const p of ['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'EndOfGame']) {
      expect(run([phase(p)], game).stage).toBe('none');
    }
  });

  test('the client closing during the game keeps it until the client is back and says', () => {
    const game = run([phase('ChampSelect'), session(), phase('GameStart')]);
    // What the source reports when the client goes away.
    const gone = run([ended, phase(null)], game);
    expect(gone).toMatchObject({ stage: 'game', session: selectSession, phase: null });
    // Back while the game still runs.
    expect(run([phase('InProgress'), ended], gone)).toMatchObject({
      stage: 'game',
      session: selectSession,
    });
    expect(run([phase('WaitingForStats')], gone).stage).toBe('game');
    // Back after the game.
    for (const p of ['None', 'Lobby', 'EndOfGame']) {
      expect(run([ended, phase(p)], gone)).toMatchObject({ stage: 'none', session: null });
    }
    // Back straight into the next champion select.
    const next = champSelectSession({ championId: 40, locked: false });
    expect(run([session(next)], gone)).toMatchObject({ stage: 'select', session: next });
  });

  test('the client closing during champion select drops it', () => {
    const select = run([phase('ChampSelect'), session()]);
    expect(run([ended, phase(null)], select).stage).toBe('none');
  });

  test('a new champion select replaces the last game', () => {
    const over = run([phase('ChampSelect'), session(), phase('InProgress'), phase('EndOfGame')]);
    const next = champSelectSession({ championId: 40, locked: false });
    expect(run([phase('ChampSelect'), session(next)], over)).toMatchObject({
      stage: 'select',
      session: next,
    });
  });

  test('a late update of the champion select keeps the game', () => {
    const game = run([phase('ChampSelect'), session(), phase('GameStart')]);
    expect(run([session(), ended], game)).toMatchObject({ stage: 'game', session: selectSession });
  });

  test('recovered teams only apply to a game in progress nobody saw the start of', () => {
    const recovered: LobbyEvent = { type: 'recovered', session: selectSession };
    expect(run([phase('InProgress'), recovered]).stage).toBe('game');
    expect(run([phase('Lobby'), recovered]).stage).toBe('none');
    const live = run([phase('ChampSelect'), session()]);
    expect(run([recovered], live)).toBe(live);
  });

  test('in-game phases', () => {
    expect(
      ['GameStart', 'InProgress', 'Reconnect', 'WaitingForStats', 'PreEndOfGame'].every(
        isInGamePhase,
      ),
    ).toBe(true);
    expect(['None', 'Lobby', 'ChampSelect', 'EndOfGame', null].some(isInGamePhase)).toBe(false);
  });
});

describe('champion select rebuilt from a game in progress', () => {
  const me = FAKE_SUMMONER;

  test('finds the user, their role, spells and every locked champion', () => {
    const s = sessionFromGameflow(gameflowSession([4, 14]), me);
    if (!s) throw new Error('not recovered');
    const view = deriveChampSelect(s, 'MIDDLE');
    expect(view).toMatchObject({
      role: 'UTILITY',
      roleAssumed: false,
      lockedIn: true,
      lockedChampionId: LOCKED_CHAMPION,
      mySpells: [4, 14],
    });
    expect(view.allies.map((a) => a.championId)).toEqual([516, 64, 103, 222]);
    expect(view.enemies.map((e) => e.championId)).toEqual([122, 254, 134, 145, 111]);
    expect([...view.allies, ...view.enemies].every((p) => p.locked && p.role !== null)).toBe(true);
    // Identities are only used to find the user's team.
    expect(JSON.stringify(s)).not.toContain('puuid');
  });

  test('the user can be on the second team', () => {
    const gameflow = gameflowSession([4, 14]);
    const swapped: LcuGameflowSession = {
      ...gameflow,
      gameData: {
        ...gameflow.gameData,
        teamOne: gameflow.gameData.teamTwo,
        teamTwo: gameflow.gameData.teamOne,
      },
    };
    const s = sessionFromGameflow(swapped, me);
    const view = s && deriveChampSelect(s, 'MIDDLE');
    expect(view?.lockedChampionId).toBe(LOCKED_CHAMPION);
    expect(view?.enemies.map((e) => e.championId)).toEqual([122, 254, 134, 145, 111]);
  });

  test('falls back to the summoner id when the client sends no puuid', () => {
    const gameflow = gameflowSession([4, 14]);
    gameflow.gameData.teamOne = gameflow.gameData.teamOne.map((p, i) => ({
      championId: p.championId,
      summonerId: i === 4 ? me.summonerId : 100 + i,
    }));
    const s = sessionFromGameflow(gameflow, { summonerId: me.summonerId });
    expect(s && deriveChampSelect(s, 'MIDDLE').lockedChampionId).toBe(LOCKED_CHAMPION);
  });

  test('null when the user is not playing (spectating)', () => {
    const other = { summonerId: 999, puuid: 'fake-puuid-someone-else' };
    expect(sessionFromGameflow(gameflowSession([4, 14]), other)).toBeNull();
  });
});
