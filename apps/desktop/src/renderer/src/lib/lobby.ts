/** Display helpers of the in-game lobby (players by champion and role: no names). */
import type { LiveRank, LiveRecentStats, SoloTier } from '@pick-league/shared';
import type { LobbyPlayerView } from '../../../core/live-lobby.ts';
import { percent, ROLE_LABEL } from './format';

const TIER_LABEL: Record<SoloTier, string> = {
  IRON: 'Iron',
  BRONZE: 'Bronze',
  SILVER: 'Silver',
  GOLD: 'Gold',
  PLATINUM: 'Platinum',
  EMERALD: 'Emerald',
  DIAMOND: 'Diamond',
  MASTER: 'Master',
  GRANDMASTER: 'Grandmaster',
  CHALLENGER: 'Challenger',
};

/** Swatch color of each tier (close to the in-client emblems). */
export const TIER_COLOR: Record<SoloTier, string> = {
  IRON: '#6b625d',
  BRONZE: '#8c5a3c',
  SILVER: '#8e9ba6',
  GOLD: '#c89b3c',
  PLATINUM: '#4fa3a5',
  EMERALD: '#2fa36b',
  DIAMOND: '#6f7fe0',
  MASTER: '#a35bd6',
  GRANDMASTER: '#d6454a',
  CHALLENGER: '#e8c15a',
};

/** "Emerald 3", "Master" (no division above Diamond). */
export function rankLabel(rank: LiveRank): string {
  const tier = TIER_LABEL[rank.tier];
  return rank.division ? `${tier} ${rank.division}` : tier;
}

/** "30W 10L". */
export function winLoss(wins: number, losses: number): string {
  return `${wins}W ${losses}L`;
}

/** Win rate color: clearly above / below even, else neutral (needs a few matches to mean much). */
export function winRateTone(wins: number, matches: number): 'up' | 'down' | 'neutral' {
  if (matches < 5) return 'neutral';
  const rate = wins / matches;
  return rate >= 0.55 ? 'up' : rate < 0.45 ? 'down' : 'neutral';
}

/** "2W 1L · 67%" on the champion over the recent matches; null without any. */
export function championForm(recent: LiveRecentStats): string | null {
  const n = recent.championMatches;
  if (n === 0) return null;
  return `${winLoss(recent.championWins, n - recent.championWins)} · ${percent(recent.championWins / n, 0)}`;
}

/** Off-role explanation: "Usually Mid (6 of 9 recent matches), 0 as Support". */
export function offRoleText(player: LobbyPlayerView): string | null {
  const recent = player.recent;
  if (!recent?.offRole || !recent.mainRole) return null;
  const known = recent.roles.reduce((s, r) => s + r.matches, 0);
  const main = recent.roles[0]?.matches ?? 0;
  const now = player.position
    ? (recent.roles.find((r) => r.position === player.position)?.matches ?? 0)
    : 0;
  const here = player.position ? `, ${now} as ${ROLE_LABEL[player.position]}` : '';
  return `Usually ${ROLE_LABEL[recent.mainRole]} (${main} of ${known} recent matches)${here}`;
}

/** Fewer mastery points than this and no recent ranked match on it: likely a first time. */
export const FIRST_TIME_POINTS = 1_000;

export function isFirstTime(player: LobbyPlayerView): boolean {
  return (
    player.mastery !== null &&
    player.mastery.points < FIRST_TIME_POINTS &&
    player.recent !== null &&
    player.recent.championMatches === 0
  );
}
