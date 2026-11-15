import { describe, expect, test } from 'bun:test';
import {
  isPlayingPhase,
  livePlayersRequestSchema,
  tierListQuerySchema,
  toTierListFilters,
} from './api-contract.ts';

describe('live players request', () => {
  const player = (n: number) => ({
    championId: 412 + n,
    position: 'UTILITY',
    team: n < 5 ? 'ally' : 'enemy',
  });
  const game = { gameId: 7001, me: { gameName: 'FakePlayer', tagLine: 'TEST' } };

  test('accepts up to 10 players of a crawled platform, the game and the user Riot ID', () => {
    const players = Array.from({ length: 10 }, (_, i) => player(i));
    const parsed = livePlayersRequestSchema.parse({ platform: 'EUW1', ...game, players });
    expect(parsed.players).toHaveLength(10);
    expect(
      livePlayersRequestSchema.safeParse({
        platform: 'KR',
        ...game,
        players: [{ ...player(1), position: null }],
      }).success,
    ).toBe(true);
    // The same champion on both teams (blind pick) is fine.
    expect(
      livePlayersRequestSchema.safeParse({
        platform: 'EUW1',
        ...game,
        players: [player(1), { ...player(1), team: 'enemy' }],
      }).success,
    ).toBe(true);
  });

  test('rejects bad platforms, games, Riot IDs, sizes, duplicates and malformed players', () => {
    const valid = (body: Record<string, unknown>) =>
      livePlayersRequestSchema.safeParse({ platform: 'EUW1', ...game, ...body }).success;
    expect(valid({ platform: 'EUW', players: [player(1)] })).toBe(false);
    expect(valid({ gameId: 0, players: [player(1)] })).toBe(false);
    expect(valid({ gameId: 1.5, players: [player(1)] })).toBe(false);
    expect(valid({ me: { gameName: 'FakePlayer' }, players: [player(1)] })).toBe(false);
    expect(valid({ me: { gameName: ' ', tagLine: 'TEST' }, players: [player(1)] })).toBe(false);
    expect(valid({ players: [] })).toBe(false);
    expect(valid({ players: Array.from({ length: 11 }, (_, i) => player(i)) })).toBe(false);
    expect(valid({ players: [player(1), player(1)] })).toBe(false);
    expect(valid({ players: [{ ...player(1), team: 'blue' }] })).toBe(false);
    expect(valid({ players: [{ ...player(1), championId: 0 }] })).toBe(false);
    expect(valid({ players: [{ ...player(1), position: 'SUPPORT' }] })).toBe(false);
  });
});

describe('playing phases', () => {
  test('from queue start to the end of the game', () => {
    for (const phase of [
      'Matchmaking',
      'ReadyCheck',
      'ChampSelect',
      'GameStart',
      'InProgress',
      'Reconnect',
    ])
      expect(isPlayingPhase(phase)).toBe(true);
    for (const phase of [
      null,
      undefined,
      'None',
      'Lobby',
      'WaitingForStats',
      'PreEndOfGame',
      'EndOfGame',
    ])
      expect(isPlayingPhase(phase)).toBe(false);
  });
});

describe('tier list filters', () => {
  test('query defaults to every server and Master+', () => {
    expect(tierListQuerySchema.parse({ role: 'UTILITY' })).toEqual({
      role: 'UTILITY',
      patch: 'latest',
      platform: 'ALL',
      rank: 'MASTER',
    });
    expect(
      tierListQuerySchema.parse({ role: 'TOP', platform: 'VN2', rank: 'CHALLENGER' }),
    ).toMatchObject({ platform: 'VN2', rank: 'CHALLENGER' });
    expect(tierListQuerySchema.safeParse({ role: 'TOP', platform: 'EUW' }).success).toBe(false);
    expect(tierListQuerySchema.safeParse({ role: 'TOP', rank: 'DIAMOND' }).success).toBe(false);
  });

  test('untrusted filters fall back to the defaults field by field', () => {
    expect(toTierListFilters({ platform: 'KR', rank: 'GRANDMASTER' })).toEqual({
      platform: 'KR',
      rank: 'GRANDMASTER',
    });
    expect(toTierListFilters({ platform: 'OC1', rank: 'CHALLENGER' })).toEqual({
      platform: 'ALL',
      rank: 'CHALLENGER',
    });
    expect(toTierListFilters(null)).toEqual({ platform: 'ALL', rank: 'MASTER' });
    expect(toTierListFilters('KR')).toEqual({ platform: 'ALL', rank: 'MASTER' });
  });
});
