import type { CollectionStatus } from '@pick-league/shared';

/** Collection stopped: what the header warns about (from `GET /stats/status`). */
export interface CollectionWarning {
  state: 'key_rejected' | 'stalled';
  /** Short header label. */
  label: string;
  /** What happened, one sentence. */
  title: string;
  /** What it means for the user (the server is not theirs to fix). */
  detail: string;
  /** When collection stopped (ISO): first key rejection, or last heartbeat. Null if unknown. */
  since: string | null;
}

const STALE = 'The stats may be getting stale; nothing to do on your side.';

/**
 * The warning to show for the API's collection block, or null while collecting (or when the
 * state is unknown: no worker_status rows, or an API from before the block existed).
 */
export function collectionWarning(
  collection: CollectionStatus | undefined,
): CollectionWarning | null {
  if (!collection) return null;
  const { state, platforms } = collection;
  if (state === 'key_rejected') {
    const rejected = platforms.flatMap((p) => (p.authRejectedSince ? [p.authRejectedSince] : []));
    return {
      state,
      label: 'Riot key rejected',
      title: 'Collection is stopped on the server: Riot rejected its API key.',
      detail: STALE,
      since: earliest(rejected),
    };
  }
  if (state === 'stalled') {
    return {
      state,
      label: 'Collection stopped',
      title: 'Collection is stopped on the server.',
      detail: STALE,
      since: latest(platforms.map((p) => p.heartbeatAt)),
    };
  }
  return null;
}

function earliest(isos: readonly string[]): string | null {
  return isos.reduce<string | null>(
    (a, b) => (a === null || Date.parse(b) < Date.parse(a) ? b : a),
    null,
  );
}

function latest(isos: readonly string[]): string | null {
  return isos.reduce<string | null>(
    (a, b) => (a === null || Date.parse(b) > Date.parse(a) ? b : a),
    null,
  );
}
