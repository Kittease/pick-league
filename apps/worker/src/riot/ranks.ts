import type { SoloRankInput } from '@pick-league/db';
import {
  divisionToNumber,
  isSoloTier,
  type LeagueEntryDto,
  RANKED_SOLO_QUEUE,
} from '@pick-league/shared';

/** Solo queue entry of a league-v4 `entries/by-puuid` answer; null when unranked. */
export function toSoloRank(entries: readonly LeagueEntryDto[]): SoloRankInput | null {
  const solo = entries.find((e) => e.queueType === RANKED_SOLO_QUEUE);
  if (!solo || !isSoloTier(solo.tier)) return null;
  return {
    tier: solo.tier,
    division: divisionToNumber(solo.tier, solo.rank),
    lp: solo.leaguePoints ?? 0,
    wins: solo.wins ?? 0,
    losses: solo.losses ?? 0,
  };
}
