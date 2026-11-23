import { APEX_TIERS, type Platform } from '@pick-league/shared';
import { inTransaction, type Queryable } from '../client.ts';
import type {
  ListingSkipState,
  OutsideMasterCheck,
  OutsideMasterStats,
  SoloRankInput,
} from '../types.ts';
import { updatePlayerRank } from './players.ts';

// ---------------------------------------------------------------------------
// outside_masters: the Master+ players outside Riot's ladder lists, followed by a check of their
// own solo queue entry (league-v4 entries/by-puuid, platform host).
// ---------------------------------------------------------------------------

/**
 * Brings `outside_masters` of a platform in line with `players` and `ladder_entries`: a row for
 * every player whose stored solo rank is Master or above and who has no ladder row (seen in a
 * stored match and ranked by enrichment, or dropped off Riot's list), none for the others (ranked
 * lower since, or on a tracked ladder now: the ladder follows them). Existing rows are left as
 * they are. One scan of the platform's players.
 */
export async function syncOutsideMasters(
  q: Queryable,
  platform: Platform,
): Promise<{ added: number; removed: number }> {
  return inTransaction(q, async (tx) => {
    const removed = await tx`
      DELETE FROM outside_masters om USING players p
      WHERE om.platform = ${platform} AND p.puuid = om.puuid
        AND (p.solo_tier IS NULL OR p.solo_tier < 'MASTER'
             OR EXISTS (SELECT 1 FROM ladder_entries le WHERE le.puuid = om.puuid))`;
    const added = await tx`
      INSERT INTO outside_masters (puuid, platform)
      SELECT p.puuid, p.platform FROM players p
      WHERE p.platform = ${platform} AND p.solo_tier >= 'MASTER'
        AND NOT EXISTS (SELECT 1 FROM ladder_entries le WHERE le.puuid = p.puuid)
        AND NOT EXISTS (SELECT 1 FROM outside_masters om WHERE om.puuid = p.puuid)
      ORDER BY p.puuid
      ON CONFLICT (puuid) DO NOTHING`;
    return { added: added.count, removed: removed.count };
  });
}

/**
 * The next outside Masters of a platform to check: those never checked first, then the least
 * recently checked, leaving out those checked after `checkedBefore`.
 */
export async function outsideMastersToCheck(
  q: Queryable,
  platform: Platform,
  opts: { checkedBefore: Date; limit: number },
): Promise<string[]> {
  const rows = await q<{ puuid: string }[]>`
    SELECT puuid FROM outside_masters
    WHERE platform = ${platform} AND (checked_at IS NULL OR checked_at <= ${opts.checkedBefore})
    ORDER BY checked_at NULLS FIRST, puuid
    LIMIT ${opts.limit}`;
  return rows.map((r) => r.puuid);
}

/**
 * Stores the answer of a check of an outside Master, received at `now`: `rank` is their solo
 * queue entry (null: unranked). In one transaction the player's stored rank is refreshed, and:
 *
 * - 'left': they are no longer Master or above: their row is removed, with a listing request
 *   still waiting;
 * - 'gone': they have no row any more (a ladder follows them since): nothing else changes;
 * - 'first': first check, and their match ids were listed at or after `listedSince`: the counter
 *   is the starting point, nothing is listed;
 * - 'first-listing': first check of a player never listed, or not since `listedSince`: a listing
 *   is requested;
 * - 'played': wins + losses differ from the last check: a listing is requested
 *   (`players.listing_requested_at` = `now`), and `now` is the snapshot of the new counter;
 * - 'unchanged': nothing but the time of the check.
 */
export async function recordOutsideMasterCheck(
  q: Queryable,
  puuid: string,
  rank: SoloRankInput | null,
  opts: { now: Date; listedSince: Date },
): Promise<OutsideMasterCheck> {
  const { now } = opts;
  return inTransaction(q, async (tx) => {
    // The player's row first, like every writer of `players` and its children.
    const [player] = await tx<{ matches_synced_until: Date | null }[]>`
      SELECT matches_synced_until FROM players WHERE puuid = ${puuid} FOR UPDATE`;
    if (!player) return 'gone';
    const [row] = await tx<{ games: number | null }[]>`
      SELECT games FROM outside_masters WHERE puuid = ${puuid} FOR UPDATE`;
    // On a ladder now: the ladder's own, at least as recent, rank stays.
    if (!row) return 'gone';
    await updatePlayerRank(tx, puuid, rank, now);
    if (rank === null || !APEX_TIERS.includes(rank.tier)) {
      await tx`DELETE FROM outside_masters WHERE puuid = ${puuid}`;
      await tx`UPDATE players SET listing_requested_at = NULL WHERE puuid = ${puuid}`;
      return 'left';
    }
    const games = rank.wins + rank.losses;
    if (row.games === games) {
      await tx`UPDATE outside_masters SET checked_at = ${now} WHERE puuid = ${puuid}`;
      return 'unchanged';
    }
    await tx`
      UPDATE outside_masters SET games = ${games}, checked_at = ${now}, games_changed_at = ${now}
      WHERE puuid = ${puuid}`;
    const first = row.games === null;
    const synced = player.matches_synced_until;
    if (first && synced !== null && synced >= opts.listedSince) return 'first';
    await tx`UPDATE players SET listing_requested_at = ${now} WHERE puuid = ${puuid}`;
    return first ? 'first-listing' : 'played';
  });
}

/**
 * A check failed: the player goes to the back of the rotation as they are (counter untouched), so
 * one player Riot does not answer for never holds the others.
 */
export async function deferOutsideMasterCheck(
  q: Queryable,
  puuid: string,
  now: Date = new Date(),
): Promise<void> {
  await q`UPDATE outside_masters SET checked_at = ${now} WHERE puuid = ${puuid}`;
}

/**
 * Outside Masters of a platform waiting for a match-id listing (their counter moved, or first
 * check of a player not listed lately), oldest request first.
 */
export async function outsideMastersToList(
  q: Queryable,
  platform: Platform,
  limit: number,
): Promise<string[]> {
  const rows = await q<{ puuid: string }[]>`
    SELECT om.puuid FROM players p
    JOIN outside_masters om USING (puuid)
    WHERE om.platform = ${platform} AND p.listing_requested_at IS NOT NULL
    ORDER BY p.listing_requested_at, om.puuid
    LIMIT ${limit}`;
  return rows.map((r) => r.puuid);
}

/**
 * Counter and listing baseline of an outside Master, as the skip rule reads them; null when the
 * player is not one or was never checked.
 */
export async function getOutsideMasterSkipState(
  q: Queryable,
  puuid: string,
): Promise<ListingSkipState | null> {
  const [row] = await q<
    {
      games: number | null;
      games_changed_at: Date | null;
      listed_games: number | null;
      listed_snapshot_at: Date | null;
      listed_at: Date | null;
    }[]
  >`
    SELECT games, games_changed_at, listed_games, listed_snapshot_at, listed_at
    FROM outside_masters WHERE puuid = ${puuid}`;
  if (!row || row.games === null || row.games_changed_at === null) return null;
  return {
    gamesNow: row.games,
    snapshotAt: row.games_changed_at,
    listedGames: row.listed_games,
    listedSnapshotAt: row.listed_snapshot_at,
    listedAt: row.listed_at,
  };
}

/** `setListingBaseline` for an outside Master (nothing happens when they are no longer one). */
export async function setOutsideMasterBaseline(
  q: Queryable,
  puuid: string,
  baseline: { games: number; snapshotAt: Date; listedAt: Date },
): Promise<void> {
  await q`
    UPDATE outside_masters SET
      listed_games = ${baseline.games},
      listed_snapshot_at = ${baseline.snapshotAt},
      listed_at = ${baseline.listedAt}
    WHERE puuid = ${puuid}`;
}

/** The outside Masters of a platform for the `progress` log. */
export async function outsideMasterStats(
  q: Queryable,
  platform: Platform,
  checkedSince: Date,
): Promise<OutsideMasterStats> {
  const [row] = await q<
    {
      followed: number;
      checked: number;
      never_checked: number;
      oldest_check_at: Date | null;
      to_list: number;
    }[]
  >`
    SELECT count(*)::int AS followed,
           count(*) FILTER (WHERE om.games IS NOT NULL AND om.checked_at >= ${checkedSince})::int
             AS checked,
           count(*) FILTER (WHERE om.games IS NULL)::int AS never_checked,
           min(om.checked_at) FILTER (WHERE om.games IS NOT NULL) AS oldest_check_at,
           count(*) FILTER (WHERE p.listing_requested_at IS NOT NULL)::int AS to_list
    FROM outside_masters om JOIN players p USING (puuid)
    WHERE om.platform = ${platform}`;
  return {
    followed: row?.followed ?? 0,
    checkedSince: row?.checked ?? 0,
    neverChecked: row?.never_checked ?? 0,
    oldestCheckAt: row?.oldest_check_at ?? null,
    toList: row?.to_list ?? 0,
  };
}
