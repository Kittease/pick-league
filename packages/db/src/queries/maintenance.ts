import { type PatchId, type Platform, sortPatchesDesc } from '@pick-league/shared';
import { inTransaction, type Queryable } from '../client.ts';
import type { DiamondTracking, WorkerRunStats, WorkerStatus } from '../types.ts';

export interface CleanupResult {
  deletedPatches: PatchId[];
  purgedQueueRows: number;
}

/**
 * Keeps only the `keep` (default 2) newest patches: older patch rows are deleted (cascading to
 * their static data and matches with every child table), and then DONE queue rows whose match is
 * gone, and SKIPPED_OLD_PATCH / FAILED rows not updated since the oldest kept patch was detected,
 * are purged. Runs in one transaction; does nothing when no patch is too old.
 * Players left orphaned are purged separately (`purgeOrphanPlayers`).
 */
export async function deleteOldPatches(q: Queryable, keep = 2): Promise<CleanupResult> {
  return inTransaction(q, async (tx) => {
    const rows = await tx<{ id: string; detected_at: Date }[]>`SELECT id, detected_at FROM patches`;
    const sorted = sortPatchesDesc(rows.map((r) => r.id));
    const kept = sorted.slice(0, keep);
    const deletedPatches = sorted.slice(keep);
    if (deletedPatches.length === 0) return { deletedPatches, purgedQueueRows: 0 };
    await tx`DELETE FROM patches WHERE id = ANY(${deletedPatches}::text[])`;

    const oldestKept = rows
      .filter((r) => kept.includes(r.id))
      .reduce<Date | null>(
        (min, r) => (min === null || r.detected_at < min ? r.detected_at : min),
        null,
      );
    let purged = (
      await tx`
        DELETE FROM match_fetch_queue q
        WHERE q.status = 'DONE' AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = q.match_id)`
    ).count;
    if (oldestKept !== null) {
      purged += (
        await tx`
          DELETE FROM match_fetch_queue
          WHERE status IN ('SKIPPED_OLD_PATCH', 'FAILED') AND updated_at < ${oldestKept}`
      ).count;
    }
    return { deletedPatches, purgedQueueRows: purged };
  });
}

/** Number of stored matches (all patches). */
export async function countMatches(q: Queryable): Promise<number> {
  const [row] = await q<{ n: number }[]>`SELECT count(*)::int AS n FROM matches`;
  return row?.n ?? 0;
}

/**
 * Deletes the `limit` oldest stored matches (by start) of `patch`; everything of a match goes
 * with it (the foreign keys cascade, incremental stats rows included). Their DONE rows stay in
 * `match_fetch_queue`, so they are not fetched again. Returns how many were deleted.
 */
export async function deleteOldestMatchesOfPatch(
  q: Queryable,
  patch: PatchId,
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0;
  const res = await q`
    DELETE FROM matches WHERE id IN (
      SELECT id FROM matches WHERE patch = ${patch} ORDER BY started_at, id LIMIT ${limit})`;
  return res.count;
}

/**
 * Deletes non-tracked players present in no kept match (with their masteries/enrichment), in
 * batches of `batchSize` (default 1000), each in its own short transaction. Safe while matches are
 * being inserted: a player row locked by an in-flight insert is skipped (`SKIP LOCKED`, taken in
 * puuid order like the inserts), and the orphan check is repeated after locking. Returns how many
 * were deleted.
 */
export async function purgeOrphanPlayers(
  q: Queryable,
  options: { batchSize?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 1000;
  let deleted = 0;
  let after = '';
  for (;;) {
    const batch = await inTransaction(q, async (tx) => {
      const locked = await tx<{ puuid: string }[]>`
        SELECT p.puuid FROM players p
        WHERE p.puuid > ${after}
          AND NOT EXISTS (SELECT 1 FROM ladder_entries le WHERE le.puuid = p.puuid)
          AND NOT EXISTS (SELECT 1 FROM participants pa WHERE pa.puuid = p.puuid)
        ORDER BY p.puuid
        LIMIT ${batchSize}
        FOR UPDATE OF p SKIP LOCKED`;
      if (locked.length === 0) return { scanned: 0, last: after, deleted: 0 };
      const ids = locked.map((r) => r.puuid);
      // New statement, new snapshot: a match committed since the lock query now counts.
      const res = await tx`
        DELETE FROM players p
        WHERE p.puuid = ANY(${ids}::text[])
          AND NOT EXISTS (SELECT 1 FROM ladder_entries le WHERE le.puuid = p.puuid)
          AND NOT EXISTS (SELECT 1 FROM participants pa WHERE pa.puuid = p.puuid)`;
      return { scanned: ids.length, last: ids[ids.length - 1] as string, deleted: res.count };
    });
    deleted += batch.deleted;
    if (batch.scanned < batchSize) return deleted;
    after = batch.last;
  }
}

/** Opens a `worker_runs` row; returns its id. */
export async function startWorkerRun(q: Queryable, platform: Platform): Promise<number> {
  const [row] = await q<{ id: string }[]>`
    INSERT INTO worker_runs (platform) VALUES (${platform}) RETURNING id`;
  if (!row) throw new Error('worker_runs insert returned no row');
  return Number(row.id);
}

/** Closes a `worker_runs` row with its counters (and error, if the cycle failed). */
export async function finishWorkerRun(
  q: Queryable,
  id: number,
  stats: WorkerRunStats,
  now: Date = new Date(),
): Promise<void> {
  await q`
    UPDATE worker_runs SET
      finished_at = ${now},
      requests_made = ${stats.requestsMade},
      players_polled = ${stats.playersPolled},
      matches_added = ${stats.matchesAdded},
      error = ${stats.error ?? null}
    WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// worker_status (one row per platform loop)
// ---------------------------------------------------------------------------

/** Heartbeat of a platform loop (creates its row). */
export async function touchWorkerStatus(
  q: Queryable,
  platform: Platform,
  now: Date = new Date(),
): Promise<void> {
  await q`
    INSERT INTO worker_status (platform, heartbeat_at) VALUES (${platform}, ${now})
    ON CONFLICT (platform) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`;
}

/** Riot rejected the key (401/403): keeps the time of the first rejection. */
export async function markWorkerAuthRejected(
  q: Queryable,
  platform: Platform,
  now: Date = new Date(),
): Promise<void> {
  await q`
    INSERT INTO worker_status (platform, heartbeat_at, auth_rejected_since)
    VALUES (${platform}, ${now}, ${now})
    ON CONFLICT (platform) DO UPDATE SET
      heartbeat_at = EXCLUDED.heartbeat_at,
      auth_rejected_since = COALESCE(worker_status.auth_rejected_since, EXCLUDED.auth_rejected_since)`;
}

/** Riot accepted the key again. */
export async function clearWorkerAuthRejected(q: Queryable, platform: Platform): Promise<void> {
  await q`
    UPDATE worker_status SET auth_rejected_since = NULL
    WHERE platform = ${platform} AND auth_rejected_since IS NOT NULL`;
}

/** Last non-abort error of a platform loop ('kind: message'), truncated to 500 characters. */
export async function recordWorkerError(
  q: Queryable,
  platform: Platform,
  error: string,
  now: Date = new Date(),
): Promise<void> {
  const text = error.slice(0, 500);
  await q`
    INSERT INTO worker_status (platform, heartbeat_at, last_error, last_error_at)
    VALUES (${platform}, ${now}, ${text}, ${now})
    ON CONFLICT (platform) DO UPDATE SET
      heartbeat_at = EXCLUDED.heartbeat_at,
      last_error = EXCLUDED.last_error,
      last_error_at = EXCLUDED.last_error_at`;
}

/** Every platform's status row. */
export async function listWorkerStatus(q: Queryable): Promise<WorkerStatus[]> {
  const rows = await q<
    {
      platform: Platform;
      heartbeat_at: Date;
      auth_rejected_since: Date | null;
      last_error: string | null;
      last_error_at: Date | null;
    }[]
  >`
    SELECT platform, heartbeat_at, auth_rejected_since, last_error, last_error_at
    FROM worker_status ORDER BY platform`;
  return rows.map((r) => ({
    platform: r.platform,
    heartbeatAt: r.heartbeat_at,
    authRejectedSince: r.auth_rejected_since,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
  }));
}

// ---------------------------------------------------------------------------
// diamond_tracking (the Diamond target of each platform)
// ---------------------------------------------------------------------------

/** The Diamond target of a platform and how it has kept up; null before the worker first wrote it. */
export async function getDiamondTracking(
  q: Queryable,
  platform: Platform,
): Promise<DiamondTracking | null> {
  const [row] = await q<
    {
      target: number;
      cycles: string;
      last_cycle_at: Date | null;
      settle_cycles_left: number;
      changed_at: Date | null;
      changed_from: number | null;
      change_reason: string | null;
      shrunk_at: Date | null;
    }[]
  >`
    SELECT target, cycles, last_cycle_at, settle_cycles_left, changed_at, changed_from,
           change_reason, shrunk_at
    FROM diamond_tracking WHERE platform = ${platform}`;
  if (!row) return null;
  return {
    target: row.target,
    cycles: row.cycles,
    lastCycleAt: row.last_cycle_at,
    settleCyclesLeft: row.settle_cycles_left,
    changedAt: row.changed_at,
    changedFrom: row.changed_from,
    changeReason: row.change_reason,
    shrunkAt: row.shrunk_at,
  };
}

export async function saveDiamondTracking(
  q: Queryable,
  platform: Platform,
  state: DiamondTracking,
  now: Date = new Date(),
): Promise<void> {
  const row = {
    platform,
    target: state.target,
    cycles: state.cycles,
    last_cycle_at: state.lastCycleAt,
    settle_cycles_left: state.settleCyclesLeft,
    changed_at: state.changedAt,
    changed_from: state.changedFrom,
    change_reason: state.changeReason,
    shrunk_at: state.shrunkAt,
    updated_at: now,
  };
  await q`
    INSERT INTO diamond_tracking ${q(row)}
    ON CONFLICT (platform) DO UPDATE SET
      target = EXCLUDED.target,
      cycles = EXCLUDED.cycles,
      last_cycle_at = EXCLUDED.last_cycle_at,
      settle_cycles_left = EXCLUDED.settle_cycles_left,
      changed_at = EXCLUDED.changed_at,
      changed_from = EXCLUDED.changed_from,
      change_reason = EXCLUDED.change_reason,
      shrunk_at = EXCLUDED.shrunk_at,
      updated_at = EXCLUDED.updated_at`;
}
