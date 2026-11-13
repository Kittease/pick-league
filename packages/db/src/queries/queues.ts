import type { Platform } from '@pick-league/shared';
import type { Queryable } from '../client.ts';
import type { QueuedEnrichment, QueuedMatch } from '../types.ts';

// ---------------------------------------------------------------------------
// match_fetch_queue
// ---------------------------------------------------------------------------

/**
 * Adds match ids to the fetch queue as PENDING. Ids already known (any status) are ignored,
 * so the same match listed by its 10 players is fetched once. Returns how many were new.
 */
export async function enqueueMatchIds(
  q: Queryable,
  platform: Platform,
  matchIds: readonly string[],
): Promise<number> {
  const unique = [...new Set(matchIds)];
  if (unique.length === 0) return 0;
  const res = await q`
    INSERT INTO match_fetch_queue ${q(unique.map((match_id) => ({ match_id, platform })))}
    ON CONFLICT (match_id) DO NOTHING`;
  return res.count;
}

/**
 * Next PENDING matches of a platform, oldest discovery first. Rows are locked with
 * `FOR UPDATE SKIP LOCKED` and their `updated_at` bumped, so concurrent claimers don't get the
 * same ids within a transaction; the status stays PENDING until marked done/skipped/failed.
 */
export async function claimPendingMatches(
  q: Queryable,
  platform: Platform,
  limit: number,
): Promise<QueuedMatch[]> {
  const rows = await q<
    { match_id: string; platform: Platform; attempts: number; discovered_at: Date }[]
  >`
    UPDATE match_fetch_queue SET updated_at = now()
    WHERE match_id IN (
      SELECT match_id FROM match_fetch_queue
      WHERE platform = ${platform} AND status = 'PENDING'
      ORDER BY discovered_at, match_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING match_id, platform, attempts, discovered_at`;
  return [...rows]
    .sort(
      (a, b) =>
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

/** The match belongs to a patch older than the previous one. */
export async function markMatchSkipped(q: Queryable, matchId: string): Promise<void> {
  await q`
    UPDATE match_fetch_queue SET status = 'SKIPPED_OLD_PATCH', updated_at = now()
    WHERE match_id = ${matchId}`;
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
      discovered_at = now(),
      updated_at = now()
    WHERE match_id = ${matchId}
    RETURNING status`;
  return row?.status ?? 'FAILED';
}

/**
 * Keeps the match PENDING but moves it to the back of the queue without counting an attempt
 * (e.g. its patch is newer than Data Dragon: retry later).
 */
export async function deferMatch(q: Queryable, matchId: string, note: string): Promise<void> {
  await q`
    UPDATE match_fetch_queue SET discovered_at = now(), updated_at = now(), last_error = ${note}
    WHERE match_id = ${matchId}`;
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
