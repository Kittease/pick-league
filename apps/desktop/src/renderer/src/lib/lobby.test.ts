import { expect, test } from 'bun:test';
import type { LiveRecentStats } from '@pick-league/shared';
import type { LobbyPlayerView } from '../../../core/live-lobby.ts';
import { championForm, isFirstTime, offRoleText, rankLabel, winRateTone } from './lobby';

const recent = (over: Partial<LiveRecentStats> = {}): LiveRecentStats => ({
  matches: 9,
  wins: 5,
  championMatches: 3,
  championWins: 2,
  roles: [
    { position: 'MIDDLE', matches: 6 },
    { position: 'TOP', matches: 3 },
  ],
  mainRole: 'MIDDLE',
  offRole: true,
  ...over,
});

const player = (over: Partial<LobbyPlayerView> = {}): LobbyPlayerView => ({
  team: 'enemy',
  me: false,
  championId: 412,
  position: 'UTILITY',
  status: 'ready',
  rankLoaded: true,
  rank: null,
  mastery: { level: 5, points: 30_000 },
  recent: recent(),
  ...over,
});

test('rank label: division below Master only', () => {
  const base = { lp: 10, wins: 1, losses: 1, winRate: 0.5 };
  expect(rankLabel({ ...base, tier: 'EMERALD', division: 3 })).toBe('Emerald 3');
  expect(rankLabel({ ...base, tier: 'GRANDMASTER', division: null })).toBe('Grandmaster');
});

test('win rate tone needs a few matches', () => {
  expect(winRateTone(3, 4)).toBe('neutral');
  expect(winRateTone(6, 10)).toBe('up');
  expect(winRateTone(4, 10)).toBe('down');
  expect(winRateTone(5, 10)).toBe('neutral');
});

test('champion form over the recent matches', () => {
  expect(championForm(recent())).toBe('2W 1L · 67%');
  expect(championForm(recent({ championMatches: 0, championWins: 0 }))).toBeNull();
});

test('off-role text says where they usually play', () => {
  expect(offRoleText(player())).toBe('Usually Mid (6 of 9 recent matches), 0 as Support');
  expect(offRoleText(player({ recent: recent({ offRole: false }) }))).toBeNull();
  expect(offRoleText(player({ recent: null }))).toBeNull();
});

test('first time: almost no mastery and no recent ranked match on it', () => {
  const none = recent({ championMatches: 0, championWins: 0 });
  expect(isFirstTime(player({ mastery: { level: 0, points: 0 }, recent: none }))).toBe(true);
  expect(isFirstTime(player({ mastery: { level: 1, points: 400 }, recent: recent() }))).toBe(false);
  expect(isFirstTime(player({ mastery: { level: 9, points: 90_000 }, recent: none }))).toBe(false);
  expect(isFirstTime(player({ mastery: null, recent: none }))).toBe(false);
});
