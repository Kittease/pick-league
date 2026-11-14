/**
 * Whether the worker is still collecting matches, from its `worker_status` rows (one per
 * platform loop): served in `GET /stats/status` so the desktop can say when a rejected Riot key
 * or a stopped worker silently froze the stats.
 */
import type { Queryable } from '@pick-league/db';
import {
  COLLECTION_STALL_MS,
  type CollectionState,
  type CollectionStatus,
  type Platform,
  type PlatformCollectionStatus,
} from '@pick-league/shared';

/**
 * `key_rejected` when Riot rejects the key on any platform, `stalled` when no platform
 * heartbeated within `COLLECTION_STALL_MS` of `now` (the worker is down), `unknown` without
 * rows (the worker never ran or predates `worker_status`), else `collecting`.
 */
export function collectionState(
  platforms: readonly Pick<PlatformCollectionStatus, 'heartbeatAt' | 'authRejectedSince'>[],
  now: Date,
): CollectionState {
  if (platforms.length === 0) return 'unknown';
  if (platforms.some((p) => p.authRejectedSince !== null)) return 'key_rejected';
  const lastHeartbeat = Math.max(...platforms.map((p) => Date.parse(p.heartbeatAt)));
  return now.getTime() - lastHeartbeat > COLLECTION_STALL_MS ? 'stalled' : 'collecting';
}

/** One round trip: every `worker_status` row with its platform's newest stored match. */
export async function readCollectionStatus(q: Queryable): Promise<CollectionStatus> {
  const rows = await q<
    {
      db_now: Date;
      platform: Platform;
      heartbeat_at: Date;
      auth_rejected_since: Date | null;
      last_error: string | null;
      last_error_at: Date | null;
      last_match: Date | null;
    }[]
  >`
    SELECT now() AS db_now, ws.platform, ws.heartbeat_at, ws.auth_rejected_since,
      ws.last_error, ws.last_error_at, m.last_match
    FROM worker_status ws
    LEFT JOIN (
      SELECT platform, max(fetched_at) AS last_match FROM matches GROUP BY platform
    ) m ON m.platform = ws.platform
    ORDER BY ws.platform`;
  const platforms = rows.map(
    (r): PlatformCollectionStatus => ({
      platform: r.platform,
      heartbeatAt: r.heartbeat_at.toISOString(),
      authRejectedSince: r.auth_rejected_since?.toISOString() ?? null,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at?.toISOString() ?? null,
      lastMatchStoredAt: r.last_match?.toISOString() ?? null,
    }),
  );
  // Staleness by the database clock, as the refresh cooldown.
  const now = rows[0]?.db_now ?? new Date();
  return { state: collectionState(platforms, now), platforms };
}
