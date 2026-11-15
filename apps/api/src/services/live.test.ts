import { describe, expect, test } from 'bun:test';
import type { LiveProfile, LiveRecentMatch, WorkerStatus } from '@pick-league/db';
import type { LivePlayerRequest, Position } from '@pick-league/shared';
import {
  liveGameState,
  liveWorkerState,
  matchParticipant,
  summarizeRecent,
  toLivePlayerResult,
} from './live.ts';

let seq = 0;
const match = (
  championId: number,
  position: Position | null,
  win: boolean,
  remake = false,
): LiveRecentMatch => ({
  matchId: `EUW1_${++seq}`,
  championId,
  position,
  win,
  remake,
  endedAt: '2026-11-13T12:00:00.000Z',
});

describe('summarizeRecent', () => {
  const recent = [
    match(412, 'UTILITY', true),
    match(412, 'UTILITY', false),
    match(89, 'UTILITY', true),
    match(412, 'UTILITY', true),
    match(103, 'MIDDLE', false),
    match(111, 'UTILITY', true),
    match(412, 'UTILITY', true, true), // remake: not counted
    match(12, null, false),
  ];

  test('win rate overall and on the champion, roles most played first, remakes left out', () => {
    expect(summarizeRecent(recent, 412, 'UTILITY')).toEqual({
      matches: 7,
      wins: 4,
      championMatches: 3,
      championWins: 2,
      roles: [
        { position: 'UTILITY', matches: 5 },
        { position: 'MIDDLE', matches: 1 },
      ],
      mainRole: 'UTILITY',
      offRole: false,
    });
  });

  test('off-role: the position played now is rare in their recent matches', () => {
    expect(summarizeRecent(recent, 412, 'TOP').offRole).toBe(true);
    // 1 of 6 known positions is under 20 %.
    expect(summarizeRecent(recent, 103, 'MIDDLE').offRole).toBe(true);
    const flex = [...recent, match(103, 'MIDDLE', true)];
    // 2 of 7 is not.
    expect(summarizeRecent(flex, 103, 'MIDDLE').offRole).toBe(false);
  });

  test('off-role unknown without a position now or with too few known positions', () => {
    expect(summarizeRecent(recent, 412, null).offRole).toBeNull();
    const few = recent.slice(0, 4);
    expect(summarizeRecent(few, 412, 'TOP')).toMatchObject({
      matches: 4,
      mainRole: 'UTILITY',
      offRole: null,
    });
    expect(summarizeRecent([], 412, 'TOP')).toEqual({
      matches: 0,
      wins: 0,
      championMatches: 0,
      championWins: 0,
      roles: [],
      mainRole: null,
      offRole: null,
    });
  });
});

describe('toLivePlayerResult', () => {
  const req: LivePlayerRequest = {
    championId: 412,
    position: 'UTILITY',
    team: 'enemy',
  };
  const profile: LiveProfile = {
    puuid: 'fake-live-puuid-1',
    platform: 'EUW1',
    status: 'PENDING',
    rankLoaded: true,
    rank: { tier: 'EMERALD', division: 3, lp: 55, wins: 30, losses: 10 },
    recent: null,
    mastery: null,
    lastError: null,
  };

  test('a pending player shows what is in, without the puuid', () => {
    const r = toLivePlayerResult(req, 3, profile);
    expect(r).toEqual({
      index: 3,
      team: 'enemy',
      championId: 412,
      position: 'UTILITY',
      status: 'pending',
      rankLoaded: true,
      rank: { tier: 'EMERALD', division: 3, lp: 55, wins: 30, losses: 10, winRate: 0.75 },
      mastery: null,
      recent: null,
    });
    expect(JSON.stringify(r)).not.toContain('puuid');
  });

  test('ready once everything is in; unranked; failed; unsupported', () => {
    const ready = toLivePlayerResult(req, 0, {
      ...profile,
      status: 'READY',
      rank: null,
      recent: [match(412, 'UTILITY', true)],
      mastery: { level: 0, points: 0 },
    });
    expect(ready).toMatchObject({
      status: 'ready',
      rankLoaded: true,
      rank: null,
      mastery: { level: 0, points: 0 },
      recent: { matches: 1, championWins: 1, offRole: null },
    });
    expect(toLivePlayerResult(req, 0, { ...profile, status: 'FAILED' }).status).toBe('failed');
    expect(toLivePlayerResult(req, 0, undefined, 'unsupported')).toMatchObject({
      status: 'unsupported',
      rankLoaded: false,
      rank: null,
    });
    expect(toLivePlayerResult(req, 0, undefined).status).toBe('pending');
    expect(toLivePlayerResult(req, 0, undefined, 'failed').status).toBe('failed');
    expect(toLivePlayerResult(req, 0, undefined, 'hidden').status).toBe('hidden');
  });
});

describe('matchParticipant', () => {
  const participants = [
    { teamId: 100, championId: 412, puuid: 'fake-api-puuid-1' },
    { teamId: 200, championId: 89, puuid: 'fake-api-puuid-2' },
    // Blind pick: the same champion on both teams.
    { teamId: 100, championId: 21, puuid: 'fake-api-puuid-3' },
    { teamId: 200, championId: 21, puuid: 'fake-api-puuid-4' },
  ];

  test('same champion, on the user team for an ally and the other one for an enemy', () => {
    expect(matchParticipant({ team: 'ally', championId: 412 }, participants, 100)?.puuid).toBe(
      'fake-api-puuid-1',
    );
    expect(matchParticipant({ team: 'enemy', championId: 89 }, participants, 100)?.puuid).toBe(
      'fake-api-puuid-2',
    );
    expect(matchParticipant({ team: 'enemy', championId: 21 }, participants, 100)?.puuid).toBe(
      'fake-api-puuid-4',
    );
    expect(matchParticipant({ team: 'ally', championId: 21 }, participants, 200)?.puuid).toBe(
      'fake-api-puuid-4',
    );
  });

  test('not in the game, on the wrong team, or ambiguous without the user team: null', () => {
    expect(matchParticipant({ team: 'ally', championId: 99 }, participants, 100)).toBeNull();
    expect(matchParticipant({ team: 'ally', championId: 89 }, participants, 100)).toBeNull();
    expect(matchParticipant({ team: 'ally', championId: 21 }, participants, null)).toBeNull();
    expect(matchParticipant({ team: 'ally', championId: 89 }, participants, null)?.puuid).toBe(
      'fake-api-puuid-2',
    );
  });
});

describe('liveGameState', () => {
  const game = {
    platform: 'EUW1' as const,
    gameId: 1,
    participants: null,
    myTeamId: null,
    lastError: null,
  };
  test('finding, found, not found, failed', () => {
    expect(liveGameState({ ...game, status: 'PENDING' })).toBe('finding');
    expect(liveGameState({ ...game, status: 'READY' })).toBe('found');
    expect(
      liveGameState({ ...game, status: 'FAILED', lastError: 'not_found: Riot does not show it' }),
    ).toBe('not_found');
    expect(liveGameState({ ...game, status: 'FAILED', lastError: 'transient: HTTP 503' })).toBe(
      'failed',
    );
  });
});

describe('liveWorkerState', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const row = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({
    platform: 'EUW1',
    heartbeatAt: new Date(now.getTime() - 30_000),
    authRejectedSince: null,
    lastError: null,
    lastErrorAt: null,
    ...over,
  });

  test('ok, stalled, key rejected, or not a platform the worker runs', () => {
    expect(liveWorkerState([row()], 'EUW1', now)).toBe('ok');
    expect(liveWorkerState([row()], 'KR', now)).toBe('unsupported');
    expect(liveWorkerState([], 'EUW1', now)).toBe('unsupported');
    expect(
      liveWorkerState([row({ heartbeatAt: new Date(now.getTime() - 4 * 60_000) })], 'EUW1', now),
    ).toBe('stalled');
    expect(liveWorkerState([row({ authRejectedSince: now })], 'EUW1', now)).toBe('key_rejected');
  });
});
