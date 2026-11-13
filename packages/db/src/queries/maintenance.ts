import { type PatchId, type Platform, sortPatchesDesc } from '@pick-league/shared';
import { inTransaction, type Queryable } from '../client.ts';
import type { WorkerRunStats } from '../types.ts';

export interface CleanupResult {
  deletedPatches: PatchId[];
  deletedPlayers: number;
  purgedQueueRows: number;
}

/**
 * Keeps only the `keep` (default 2) newest patches: older patch rows are deleted (cascading to
 * their static data and matches with every child table), then:
 * - non-tracked players present in no kept match are deleted (with their masteries/enrichment),
 * - DONE queue rows whose match is gone, and SKIPPED_OLD_PATCH / FAILED rows not updated since
 *   the oldest kept patch was detected, are purged.
 * Runs in one transaction.
 */
export async function deleteOldPatches(q: Queryable, keep = 2): Promise<CleanupResult> {
  return inTransaction(q, async (tx) => {
    const rows = await tx<{ id: string; detected_at: Date }[]>`SELECT id, detected_at FROM patches`;
    const sorted = sortPatchesDesc(rows.map((r) => r.id));
    const kept = sorted.slice(0, keep);
    const deletedPatches = sorted.slice(keep);
    if (deletedPatches.length > 0) {
      await tx`DELETE FROM patches WHERE id = ANY(${deletedPatches}::text[])`;
    }

    const players = await tx`
      DELETE FROM players p
      WHERE NOT EXISTS (SELECT 1 FROM ladder_entries le WHERE le.puuid = p.puuid)
        AND NOT EXISTS (SELECT 1 FROM participants pa WHERE pa.puuid = p.puuid)`;

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
    if (oldestKept !== null && deletedPatches.length > 0) {
      purged += (
        await tx`
          DELETE FROM match_fetch_queue
          WHERE status IN ('SKIPPED_OLD_PATCH', 'FAILED') AND updated_at < ${oldestKept}`
      ).count;
    }

    return { deletedPatches, deletedPlayers: players.count, purgedQueueRows: purged };
  });
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
