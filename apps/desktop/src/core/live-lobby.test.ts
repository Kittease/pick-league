import { describe, expect, test } from 'bun:test';
import type { LivePlayersResponse } from '@pick-league/shared';
import {
  ALLY_PICKS,
  ENEMY_PICKS,
  FAKE_SUMMONER,
  gameflowSession,
  LOCKED_CHAMPION,
} from './fixtures.ts';
import type { LcuGameflowSession } from './lcu-types.ts';
import {
  canLookUpLobby,
  lobbyRequestFromGameflow,
  lobbyView,
  platformFromLcu,
} from './live-lobby.ts';

describe('only once the game has started', () => {
  test('never in champion select, the loading screen or after the game', () => {
    for (const phase of ['InProgress', 'Reconnect']) expect(canLookUpLobby(phase)).toBe(true);
    for (const phase of [
      null,
      undefined,
      'None',
      'Lobby',
      'Matchmaking',
      'ReadyCheck',
      'ChampSelect',
      'GameStart',
      'WaitingForStats',
      'PreEndOfGame',
      'EndOfGame',
    ]) {
      expect(canLookUpLobby(phase)).toBe(false);
    }
  });

  test('no request unless both the tracked phase and the gameflow session say in progress', () => {
    const game = gameflowSession([14, 4]);
    expect(lobbyRequestFromGameflow(game, FAKE_SUMMONER, 'InProgress')).not.toBeNull();
    expect(lobbyRequestFromGameflow(game, FAKE_SUMMONER, 'ChampSelect')).toBeNull();
    expect(lobbyRequestFromGameflow(game, FAKE_SUMMONER, 'GameStart')).toBeNull();
    expect(lobbyRequestFromGameflow(game, FAKE_SUMMONER, null)).toBeNull();
    const select: LcuGameflowSession = { ...game, phase: 'ChampSelect' };
    expect(lobbyRequestFromGameflow(select, FAKE_SUMMONER, 'InProgress')).toBeNull();
  });
});

describe('lobby request', () => {
  test("the user's team first, positions from the client, the user marked", () => {
    const req = lobbyRequestFromGameflow(gameflowSession([14, 4]), FAKE_SUMMONER, 'InProgress');
    expect(req?.gameId).toBe(1);
    expect(req?.players.map((p) => p.championId)).toEqual([
      ...ALLY_PICKS,
      LOCKED_CHAMPION,
      ...ENEMY_PICKS,
    ]);
    const roles = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
    expect(req?.players.map((p) => `${p.team} ${p.position}`)).toEqual([
      ...roles.map((r) => `ally ${r}`),
      ...roles.map((r) => `enemy ${r}`),
    ]);
    expect(req?.meIndex).toBe(4);
    expect(req?.players[4]?.puuid).toBe(FAKE_SUMMONER.puuid as string);
  });

  test('the user on the red side; players without puuid or champion and unknown roles', () => {
    const game = gameflowSession([14, 4]);
    const flipped: LcuGameflowSession = {
      ...game,
      gameData: {
        ...game.gameData,
        teamOne: game.gameData.teamTwo,
        teamTwo: game.gameData.teamOne,
      },
    };
    const blue = flipped.gameData.teamOne;
    if (blue[0]) blue[0] = { ...blue[0], puuid: undefined };
    if (blue[1]) blue[1] = { ...blue[1], championId: 0 };
    if (blue[2]) blue[2] = { ...blue[2], selectedPosition: 'NONE' };
    const req = lobbyRequestFromGameflow(flipped, FAKE_SUMMONER, 'Reconnect');
    expect(req?.players).toHaveLength(8);
    expect(req?.players.slice(0, 5).every((p) => p.team === 'ally')).toBe(true);
    expect(req?.meIndex).toBe(4);
    expect(req?.players.find((p) => p.championId === ENEMY_PICKS[2])?.position).toBeNull();
  });

  test('spectating (the user is not playing): nothing to look up', () => {
    const someoneElse = { ...FAKE_SUMMONER, puuid: 'fake-puuid-other', summonerId: 99 };
    expect(
      lobbyRequestFromGameflow(gameflowSession([14, 4]), someoneElse, 'InProgress'),
    ).toBeNull();
  });
});

describe('platform from the League client', () => {
  test('platform id first, else region; servers PickLeague does not collect → null', () => {
    expect(platformFromLcu({ platformId: 'EUW1', region: 'EUW' })).toBe('EUW1');
    expect(platformFromLcu({ platformId: null, region: 'EUW' })).toBe('EUW1');
    expect(platformFromLcu({ platformId: null, region: 'na' })).toBe('NA1');
    expect(platformFromLcu({ platformId: 'kr', region: null })).toBe('KR');
    expect(platformFromLcu({ platformId: null, region: 'VN' })).toBe('VN2');
    expect(platformFromLcu({ platformId: 'VN2', region: null })).toBe('VN2');
    expect(platformFromLcu({ platformId: 'EUN1', region: 'EUNE' })).toBeNull();
    expect(platformFromLcu({ platformId: '', region: ' ' })).toBeNull();
    expect(platformFromLcu({ platformId: null, region: null })).toBeNull();
  });
});

describe('lobby view', () => {
  const req = lobbyRequestFromGameflow(gameflowSession([14, 4]), FAKE_SUMMONER, 'InProgress');
  if (!req) throw new Error('fixture');

  test('before any answer: every player pending, by champion and role, no puuid', () => {
    const view = lobbyView(req, 'EUW1', null, 'loading');
    expect(view.allies.map((p) => p.position)).toEqual([
      'TOP',
      'JUNGLE',
      'MIDDLE',
      'BOTTOM',
      'UTILITY',
    ]);
    expect(view.allies[4]).toEqual({
      team: 'ally',
      me: true,
      championId: LOCKED_CHAMPION,
      position: 'UTILITY',
      status: 'pending',
      rankLoaded: false,
      rank: null,
      mastery: null,
      recent: null,
    });
    expect(view.enemies).toHaveLength(5);
    expect(JSON.stringify(view)).not.toContain('puuid');
  });

  test('answers are matched by index; teams sorted top → support, unknown roles last', () => {
    const shuffled = {
      ...req,
      players: [
        { ...(req.players[9] as (typeof req.players)[0]), position: null },
        ...req.players.slice(5, 9),
      ],
      meIndex: -1,
    };
    const response: LivePlayersResponse = {
      platform: 'EUW1',
      worker: 'ok',
      done: false,
      players: [
        {
          index: 1,
          team: 'enemy',
          championId: ENEMY_PICKS[0] as number,
          position: 'TOP',
          status: 'ready',
          rankLoaded: true,
          rank: null,
          mastery: { level: 4, points: 20_000 },
          recent: null,
        },
      ],
    };
    const view = lobbyView(shuffled, 'EUW1', response, 'loading');
    expect(view.worker).toBe('ok');
    expect(view.allies).toEqual([]);
    expect(view.enemies.map((p) => p.championId)).toEqual(ENEMY_PICKS);
    expect(view.enemies.map((p) => p.status)).toEqual([
      'ready',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(view.enemies[0]).toMatchObject({ rankLoaded: true, mastery: { level: 4 } });
    expect(view.enemies[4]?.position).toBeNull();
  });

  test('unsupported server: every player unsupported', () => {
    const view = lobbyView(req, null, null, 'unsupported', 'not collected');
    expect([...view.allies, ...view.enemies].every((p) => p.status === 'unsupported')).toBe(true);
    expect(view.message).toBe('not collected');
  });
});
