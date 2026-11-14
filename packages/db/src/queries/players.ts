import type { Platform } from '@pick-league/shared';
import { byPuuid, inTransaction, type Queryable } from '../client.ts';
import type {
  DailyRefreshCandidate,
  LadderEntryInput,
  LadderUpsertResult,
  MasteryInput,
  SoloRankInput,
} from '../types.ts';

/**
 * Upserts the full Challenger + Grandmaster ladder of one platform (pass both tiers in a
 * single call): `players` rows (with solo rank from the ladder) and `ladder_entries`.
 * Entries of this platform missing from `entries` are removed (players dropped off the ladder;
 * their `players` row is kept). Never call it with a partial ladder.
 *
 * Returns who "played": new on the ladder, or wins+losses changed since the previous call. Their
 * `listing_requested_at` is set to `now` (durable: survives a worker restart until
 * `finishListing` clears it).
 */
export async function upsertLadder(
  q: Queryable,
  platform: Platform,
  entries: readonly LadderEntryInput[],
  now: Date = new Date(),
): Promise<LadderUpsertResult> {
  // Riot may list a player twice during tier transitions: keep the last occurrence. Sorted so
  // that concurrent upserts of the same players lock them in one order (no deadlock).
  const unique = [...new Map(entries.map((e) => [e.puuid, e])).values()].sort(byPuuid);
  return inTransaction(q, async (tx) => {
    const previous = await tx<{ puuid: string; games: number }[]>`
      SELECT puuid, wins + losses AS games FROM ladder_entries WHERE platform = ${platform}`;
    const prevGames = new Map(previous.map((r) => [r.puuid, r.games]));

    const played: string[] = [];
    const added: string[] = [];
    for (const e of unique) {
      const before = prevGames.get(e.puuid);
      if (before === undefined) {
        added.push(e.puuid);
        played.push(e.puuid);
      } else if (before !== e.wins + e.losses) {
        played.push(e.puuid);
      }
    }

    if (unique.length > 0) {
      const playedSet = new Set(played);
      await tx`
        INSERT INTO players ${tx(
          unique.map((e) => ({
            puuid: e.puuid,
            platform,
            solo_tier: e.tier,
            solo_division: null,
            solo_lp: e.leaguePoints,
            solo_wins: e.wins,
            solo_losses: e.losses,
            rank_refreshed_at: now,
            listing_requested_at: playedSet.has(e.puuid) ? now : null,
          })),
        )}
        ON CONFLICT (puuid) DO UPDATE SET
          solo_tier = EXCLUDED.solo_tier,
          solo_division = NULL,
          solo_lp = EXCLUDED.solo_lp,
          solo_wins = EXCLUDED.solo_wins,
          solo_losses = EXCLUDED.solo_losses,
          rank_refreshed_at = EXCLUDED.rank_refreshed_at,
          listing_requested_at = COALESCE(EXCLUDED.listing_requested_at, players.listing_requested_at)`;

      await tx`
        INSERT INTO ladder_entries ${tx(
          unique.map((e) => ({
            puuid: e.puuid,
            platform,
            tier: e.tier,
            league_points: e.leaguePoints,
            wins: e.wins,
            losses: e.losses,
            updated_at: now,
          })),
        )}
        ON CONFLICT (puuid) DO UPDATE SET
          platform = EXCLUDED.platform,
          tier = EXCLUDED.tier,
          league_points = EXCLUDED.league_points,
          wins = EXCLUDED.wins,
          losses = EXCLUDED.losses,
          updated_at = EXCLUDED.updated_at`;
    }

    const keep = unique.map((e) => e.puuid);
    const removed = await tx`
      DELETE FROM ladder_entries
      WHERE platform = ${platform} AND NOT (puuid = ANY(${keep}::text[]))`;

    return { played, added, removed: removed.count };
  });
}

/** `players.matches_synced_until` (null = never listed: start from the previous patch / 14 days ago). */
export async function getMatchesSyncedUntil(q: Queryable, puuid: string): Promise<Date | null> {
  const [row] = await q<{ matches_synced_until: Date | null }[]>`
    SELECT matches_synced_until FROM players WHERE puuid = ${puuid}`;
  return row?.matches_synced_until ?? null;
}

/** Sets the `startTime` of the next match-id listing for this player. */
export async function setMatchesSyncedUntil(
  q: Queryable,
  puuid: string,
  until: Date,
): Promise<void> {
  await q`UPDATE players SET matches_synced_until = ${until} WHERE puuid = ${puuid}`;
}

/**
 * A match-id listing that started at `startedAt` finished: sets `matches_synced_until` and clears
 * the listing request, unless a newer one arrived after the listing started (the player played
 * again meanwhile: listed again).
 */
export async function finishListing(
  q: Queryable,
  puuid: string,
  syncedUntil: Date,
  startedAt: Date,
): Promise<void> {
  await q`
    UPDATE players SET
      matches_synced_until = ${syncedUntil},
      listing_requested_at = CASE WHEN listing_requested_at <= ${startedAt}
        THEN NULL ELSE listing_requested_at END
    WHERE puuid = ${puuid}`;
}

/**
 * Tracked (ladder) players of a platform with a pending listing request, oldest request first
 * (requests survive restarts: see `upsertLadder`).
 */
export async function playersWithListingRequested(
  q: Queryable,
  platform: Platform,
  limit = 10_000,
): Promise<string[]> {
  const rows = await q<{ puuid: string }[]>`
    SELECT p.puuid FROM players p
    JOIN ladder_entries le USING (puuid)
    WHERE le.platform = ${platform} AND p.listing_requested_at IS NOT NULL
    ORDER BY p.listing_requested_at, p.puuid
    LIMIT ${limit}`;
  return rows.map((r) => r.puuid);
}

/** Stores the Riot ID from account-v1. */
export async function updatePlayerRiotId(
  q: Queryable,
  puuid: string,
  gameName: string | null,
  tagLine: string | null,
  now: Date = new Date(),
): Promise<void> {
  await q`
    UPDATE players SET game_name = ${gameName}, tag_line = ${tagLine}, name_updated_at = ${now}
    WHERE puuid = ${puuid}`;
}

/** Stores the solo-queue rank from league-v4 entries/by-puuid (null = unranked in solo queue). */
export async function updatePlayerRank(
  q: Queryable,
  puuid: string,
  rank: SoloRankInput | null,
  now: Date = new Date(),
): Promise<void> {
  await q`
    UPDATE players SET
      solo_tier = ${rank?.tier ?? null},
      solo_division = ${rank?.division ?? null},
      solo_lp = ${rank?.lp ?? null},
      solo_wins = ${rank?.wins ?? null},
      solo_losses = ${rank?.losses ?? null},
      rank_refreshed_at = ${now}
    WHERE puuid = ${puuid}`;
}

/**
 * Replaces all masteries of a player and sets `masteries_refreshed_at`. The player row must exist.
 */
export async function replaceMasteries(
  q: Queryable,
  puuid: string,
  masteries: readonly MasteryInput[],
  now: Date = new Date(),
): Promise<void> {
  await inTransaction(q, async (tx) => {
    await tx`DELETE FROM champion_masteries WHERE puuid = ${puuid}`;
    const unique = [...new Map(masteries.map((m) => [m.championId, m])).values()];
    if (unique.length > 0) {
      await tx`INSERT INTO champion_masteries ${tx(
        unique.map((m) => ({
          puuid,
          champion_id: m.championId,
          level: m.level,
          points: m.points,
          last_played_at: m.lastPlayedAt,
        })),
      )}`;
    }
    await tx`UPDATE players SET masteries_refreshed_at = ${now} WHERE puuid = ${puuid}`;
  });
}

/**
 * Tracked (ladder) players of a platform whose Riot ID or masteries are older than
 * `olderThanHours` (default 24) or were never fetched. Oldest first.
 */
export async function playersNeedingDailyRefresh(
  q: Queryable,
  platform: Platform,
  limit: number,
  olderThanHours = 24,
  now: Date = new Date(),
): Promise<DailyRefreshCandidate[]> {
  const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000);
  const rows = await q<{ puuid: string; needs_account: boolean; needs_mastery: boolean }[]>`
    SELECT p.puuid,
           (p.name_updated_at IS NULL OR p.name_updated_at < ${cutoff}) AS needs_account,
           (p.masteries_refreshed_at IS NULL OR p.masteries_refreshed_at < ${cutoff}) AS needs_mastery
    FROM ladder_entries le
    JOIN players p USING (puuid)
    WHERE le.platform = ${platform}
      AND (p.name_updated_at IS NULL OR p.name_updated_at < ${cutoff}
           OR p.masteries_refreshed_at IS NULL OR p.masteries_refreshed_at < ${cutoff})
    ORDER BY LEAST(COALESCE(p.name_updated_at, '-infinity'), COALESCE(p.masteries_refreshed_at, '-infinity')),
             p.puuid
    LIMIT ${limit}`;
  return rows.map((r) => ({
    puuid: r.puuid,
    needsAccount: r.needs_account,
    needsMastery: r.needs_mastery,
  }));
}

/**
 * Tracked (ladder) players of a platform whose match ids were never listed
 * (`matches_synced_until` IS NULL), e.g. after a restart interrupted the first listing.
 */
export async function trackedPlayersNeverListed(
  q: Queryable,
  platform: Platform,
  limit = 10_000,
): Promise<string[]> {
  const rows = await q<{ puuid: string }[]>`
    SELECT le.puuid FROM ladder_entries le
    JOIN players p USING (puuid)
    WHERE le.platform = ${platform} AND p.matches_synced_until IS NULL
    ORDER BY le.league_points DESC, le.puuid
    LIMIT ${limit}`;
  return rows.map((r) => r.puuid);
}
