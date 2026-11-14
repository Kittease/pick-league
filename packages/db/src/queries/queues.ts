import type { Platform } from '@pick-league/shared';
import type { Queryable } from '../client.ts';
import type { QueuedEnrichment, QueuedMatch } from '../types.ts';

// ---------------------------------------------------------------------------
// match_fetch_queue
// ---------------------------------------------------------------------------

/**
 * `fetch_rank` of retried and deferred matches (and of matches queued without a rank): after
 * every match listed by a tracked player.
 */
export const QUEUE_BACK_RANK = 1_000_000;

/**
 * Adds match ids to the fetch queue as PENDING, fetched in `fetchRank` order (the lister's ladder
 * position: lower first). Ids already known are not added again, so the same match listed by its
 * 10 players is fetched once; a PENDING one that was never retried or deferred moves up to
 * `fetchRank` if that is better. Returns how many were new.
 */
export async function enqueueMatchIds(
  q: Queryable,
  platform: Platform,
  matchIds: readonly string[],
  fetchRank: number = QUEUE_BACK_RANK,
): Promise<number> {
  const unique = [...new Set(matchIds)];
  if (unique.length === 0) return 0;
  const rank = Math.min(Math.max(Math.trunc(fetchRank), 0), QUEUE_BACK_RANK);
  const rows = await q<{ inserted: boolean }[]>`
    INSERT INTO match_fetch_queue ${q(
      unique.map((match_id) => ({ match_id, platform, fetch_rank: rank })),
    )}
    ON CONFLICT (match_id) DO UPDATE SET fetch_rank = EXCLUDED.fetch_rank
      WHERE match_fetch_queue.status = 'PENDING'
        AND match_fetch_queue.last_error IS NULL
        AND EXCLUDED.fetch_rank < match_fetch_queue.fetch_rank
    RETURNING (xmax = 0) AS inserted`;
  return rows.filter((r) => r.inserted).length;
}

/**
 * Next PENDING matches of a platform: lowest `fetch_rank` first (top of the ladder), then oldest
 * discovery. Rows are locked with
 * `FOR UPDATE SKIP LOCKED` and their `updated_at` bumped, so concurrent claimers don't get the
 * same ids within a transaction; the status stays PENDING until marked done/skipped/failed.
 */
export async function claimPendingMatches(
  q: Queryable,
  platform: Platform,
  limit: number,
): Promise<QueuedMatch[]> {
  const rows = await q<
    {
      match_id: string;
      platform: Platform;
      attempts: number;
      fetch_rank: number;
      discovered_at: Date;
    }[]
  >`
    UPDATE match_fetch_queue SET updated_at = now()
    WHERE match_id IN (
      SELECT match_id FROM match_fetch_queue
      WHERE platform = ${platform} AND status = 'PENDING'
      ORDER BY fetch_rank, discovered_at, match_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING match_id, platform, attempts, fetch_rank, discovered_at`;
  return [...rows]
    .sort(
      (a, b) =>
        a.fetch_rank - b.fetch_rank ||
        a.discovered_at.getTime() - b.discovered_at.getTime() ||
        a.match_id.localeCompare(b.match_id),
    )
    .map((r) => ({ matchId: r.match_id, platform: r.platform, attempts: r.attempts }));
}

export async function markMatchDone(q: Queryable, matchId: string): Promise<void> {
  await q`
    UPDATE match_fetch_queue SET status = 'DONE', last_error = NULL, updated_at = now()
    WHERE match_id = ${matchId}`;
}

/**
 * The match belongs to a patch older than the latest one (not collected). Returns false when the
 * row was no longer PENDING (e.g. already skipped in bulk by `skipPendingMatchesUpTo`).
 */
export async function markMatchSkipped(q: Queryable, matchId: string): Promise<boolean> {
  const res = await q`
    UPDATE match_fetch_queue SET status = 'SKIPPED_OLD_PATCH', updated_at = now()
    WHERE match_id = ${matchId} AND status = 'PENDING'`;
  return res.count > 0;
}

/** Numeric part of a queued match id ('EUW1_7234567890' → 7234567890), NULL if not numeric. */
const gameIdExpr = (q: Queryable) =>
  q`(CASE WHEN split_part(match_id, '_', 2) ~ '^[0-9]{1,15}$'
          THEN split_part(match_id, '_', 2)::bigint END)`;

/**
 * Marks every PENDING match of a platform whose game id is at most `maxGameId` as
 * SKIPPED_OLD_PATCH, in one statement (game ids grow with time on a platform, so they are all
 * older than a match already known to be from an older patch). Returns how many were skipped.
 */
export async function skipPendingMatchesUpTo(
  q: Queryable,
  platform: Platform,
  maxGameId: number,
): Promise<number> {
  const res = await q`
    UPDATE match_fetch_queue SET status = 'SKIPPED_OLD_PATCH', updated_at = now()
    WHERE platform = ${platform} AND status = 'PENDING' AND ${gameIdExpr(q)} <= ${maxGameId}::bigint`;
  return res.count;
}

export interface ProbeQuery {
  /** Only ids strictly above this game id. */
  aboveGameId: number;
  /** Only ids strictly below this game id (null = no upper bound). */
  belowGameId: number | null;
  /** Match ids not to return (in flight, deferred). */
  exclude: readonly string[];
  /** 'highest' game id, or the 'median' one of the range. */
  pick: 'highest' | 'median';
}

/**
 * One PENDING match of a platform chosen by game id within a range (not claimed): used to find
 * where the latest patch starts in the backlog with few requests. Null when the range is empty.
 */
export async function pickProbeMatch(
  q: Queryable,
  platform: Platform,
  probe: ProbeQuery,
): Promise<QueuedMatch | null> {
  const order = probe.pick === 'highest' ? q`gid DESC` : q`gid`;
  const offset = probe.pick === 'highest' ? q`0` : q`(SELECT count(*) FROM candidates) / 2`;
  const [row] = await q<{ match_id: string; platform: Platform; attempts: number }[]>`
    WITH candidates AS (
      SELECT match_id, platform, attempts, gid FROM (
        SELECT match_id, platform, attempts, ${gameIdExpr(q)} AS gid
        FROM match_fetch_queue
        WHERE platform = ${platform} AND status = 'PENDING'
          AND NOT (match_id = ANY(${[...probe.exclude]}::text[]))
      ) s
      WHERE gid > ${probe.aboveGameId}::bigint
        AND (${probe.belowGameId}::bigint IS NULL OR gid < ${probe.belowGameId}::bigint)
    )
    SELECT match_id, platform, attempts FROM candidates
    ORDER BY ${order}, match_id
    OFFSET ${offset} LIMIT 1`;
  return row ? { matchId: row.match_id, platform: row.platform, attempts: row.attempts } : null;
}

/**
 * Records a failed attempt. The match stays PENDING (retried later, moved to the back of the
 * queue) until `maxAttempts` (default 5) is reached, then becomes FAILED.
 * Returns the resulting status.
 */
export async function markMatchFailed(
  q: Queryable,
  matchId: string,
  error: string,
  maxAttempts = 5,
): Promise<'PENDING' | 'FAILED'> {
  const [row] = await q<{ status: 'PENDING' | 'FAILED' }[]>`
    UPDATE match_fetch_queue SET
      attempts = attempts + 1,
      last_error = ${error.slice(0, 2000)},
      status = CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'FAILED'::fetch_status ELSE 'PENDING'::fetch_status END,
      fetch_rank = ${QUEUE_BACK_RANK},
      discovered_at = now(),
      updated_at = now()
    WHERE match_id = ${matchId} AND status = 'PENDING'
    RETURNING status`;
  return row?.status ?? 'FAILED';
}

/**
 * Keeps the match PENDING but moves it to the back of the queue without counting an attempt
 * (e.g. its patch is newer than Data Dragon: retry later).
 */
export async function deferMatch(q: Queryable, matchId: string, note: string): Promise<void> {
  await q`
    UPDATE match_fetch_queue SET
      fetch_rank = ${QUEUE_BACK_RANK}, discovered_at = now(), updated_at = now(), last_error = ${note}
    WHERE match_id = ${matchId} AND status = 'PENDING'`;
}

/**
 * A transient error (Riot 429/5xx, network, database connection) hit this match: it stays
 * PENDING and moves to the back of the queue without counting an attempt, unless it already had
 * `maxTransientErrors` (default 10) of them (safety cap: then FAILED). Returns the resulting status.
 */
export async function deferMatchAfterError(
  q: Queryable,
  matchId: string,
  error: string,
  maxTransientErrors = 10,
): Promise<'PENDING' | 'FAILED'> {
  const [row] = await q<{ status: 'PENDING' | 'FAILED' }[]>`
    UPDATE match_fetch_queue SET
      transient_errors = LEAST(transient_errors + 1, 32767),
      last_error = ${error.slice(0, 2000)},
      status = CASE WHEN transient_errors + 1 >= ${maxTransientErrors} THEN 'FAILED'::fetch_status ELSE 'PENDING'::fetch_status END,
      fetch_rank = ${QUEUE_BACK_RANK},
      discovered_at = now(),
      updated_at = now()
    WHERE match_id = ${matchId} AND status = 'PENDING'
    RETURNING status`;
  return row?.status ?? 'FAILED';
}

export async function countPendingMatches(q: Queryable, platform: Platform): Promise<number> {
  const [row] = await q<{ n: number }[]>`
    SELECT count(*)::int AS n FROM match_fetch_queue
    WHERE platform = ${platform} AND status = 'PENDING'`;
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// player_enrichment_queue (lowest priority: mastery + rank of non-ladder players)
// ---------------------------------------------------------------------------

/**
 * Enqueues players for mastery + rank enrichment, skipping tracked ladder players, players
 * already queued, and players whose masteries AND rank were refreshed less than
 * `staleAfterDays` (default 7) ago. Players must exist. Returns how many were enqueued.
 */
export async function enqueueEnrichment(
  q: Queryable,
  platform: Platform,
  puuids: readonly string[],
  staleAfterDays = 7,
  now: Date = new Date(),
): Promise<number> {
  const unique = [...new Set(puuids)];
  if (unique.length === 0) return 0;
  const cutoff = new Date(now.getTime() - staleAfterDays * 86_400_000);
  const res = await q`
    INSERT INTO player_enrichment_queue (puuid, platform, enqueued_at)
    SELECT p.puuid, ${platform}::platform, ${now}
    FROM players p
    WHERE p.puuid = ANY(${unique}::text[])
      AND NOT EXISTS (SELECT 1 FROM ladder_entries le WHERE le.puuid = p.puuid)
      AND (p.masteries_refreshed_at IS NULL OR p.masteries_refreshed_at < ${cutoff}
           OR p.rank_refreshed_at IS NULL OR p.rank_refreshed_at < ${cutoff})
    ORDER BY p.puuid
    ON CONFLICT (puuid) DO NOTHING`;
  return res.count;
}

/** Oldest queued enrichments of a platform (rows stay queued until completed/failed). */
export async function claimEnrichment(
  q: Queryable,
  platform: Platform,
  limit: number,
): Promise<QueuedEnrichment[]> {
  const rows = await q<{ puuid: string; platform: Platform; attempts: number }[]>`
    SELECT puuid, platform, attempts FROM player_enrichment_queue
    WHERE platform = ${platform}
    ORDER BY enqueued_at, puuid
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED`;
  return rows.map((r) => ({ puuid: r.puuid, platform: r.platform, attempts: r.attempts }));
}

/** Removes the player from the queue (call after storing masteries + rank). */
export async function completeEnrichment(q: Queryable, puuid: string): Promise<void> {
  await q`DELETE FROM player_enrichment_queue WHERE puuid = ${puuid}`;
}

/**
 * Records a failed attempt and moves the player to the back of the queue; drops the row once
 * `maxAttempts` (default 3) is reached. Returns true if the row was dropped.
 */
export async function failEnrichment(
  q: Queryable,
  puuid: string,
  error: string,
  maxAttempts = 3,
): Promise<boolean> {
  const [row] = await q<{ attempts: number }[]>`
    UPDATE player_enrichment_queue SET
      attempts = attempts + 1, last_error = ${error.slice(0, 2000)}, enqueued_at = now()
    WHERE puuid = ${puuid}
    RETURNING attempts`;
  if (row && row.attempts >= maxAttempts) {
    await completeEnrichment(q, puuid);
    return true;
  }
  return false;
}

export async function countEnrichmentQueue(q: Queryable, platform: Platform): Promise<number> {
  const [row] = await q<{ n: number }[]>`
    SELECT count(*)::int AS n FROM player_enrichment_queue WHERE platform = ${platform}`;
  return row?.n ?? 0;
}
