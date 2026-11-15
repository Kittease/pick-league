/**
 * Client activity (0014): the desktop says when the user is queued, in champion select or in
 * game; meanwhile the worker stops collecting and the API holds its stats refresh.
 */
import type { Queryable } from '../client.ts';
import type { PlayPause } from '../types.ts';

/**
 * Records a client's phase: busy for `busyForMs` from `now` (renewed by each call while the user
 * plays), or not busy (`busyForMs` null).
 */
export async function setClientActivity(
  q: Queryable,
  activity: { client: string; phase: string; busyForMs: number | null },
  now: Date = new Date(),
): Promise<void> {
  const until = activity.busyForMs === null ? null : new Date(now.getTime() + activity.busyForMs);
  await q`
    INSERT INTO client_activity (client, phase, busy_until, updated_at)
    VALUES (${activity.client}, ${activity.phase}, ${until}, ${now})
    ON CONFLICT (client) DO UPDATE SET
      phase = EXCLUDED.phase, busy_until = EXCLUDED.busy_until, updated_at = EXCLUDED.updated_at`;
}

/** Whether some client says the user is playing at `now` (the latest pause wins). */
export async function readPlayPause(q: Queryable, now: Date = new Date()): Promise<PlayPause> {
  const [row] = await q<{ phase: string; busy_until: Date }[]>`
    SELECT phase, busy_until FROM client_activity
    WHERE busy_until > ${now}
    ORDER BY busy_until DESC LIMIT 1`;
  return row
    ? { paused: true, phase: row.phase, until: row.busy_until }
    : { paused: false, phase: null, until: null };
}
