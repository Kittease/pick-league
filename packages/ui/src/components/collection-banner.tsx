'use client';

import type { StatsStatusResponse } from '@pick-league/shared';
import { type CollectionWarning, collectionWarning } from '@pick-league/ui/lib/collection';
import { timeAgo } from '@pick-league/ui/lib/format';
import { TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Re-renders every `ms` so relative times stay current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Collection stopped (rejected Riot key, worker down), when the API answered and says so. */
function warningOf(status: StatsStatusResponse | null): CollectionWarning | null {
  return status ? collectionWarning(status.collection) : null;
}

function stoppedAgo(warning: CollectionWarning, now: number): string | null {
  return warning.since ? `stopped ${timeAgo(warning.since, now)}` : null;
}

function WarningText({ warning }: { warning: CollectionWarning }) {
  return (
    <>
      <span className="font-semibold">{warning.title}</span>{' '}
      <span className="text-foreground/80">{warning.detail}</span>
    </>
  );
}

/**
 * Full-width line under the header while collection is stopped (nothing otherwise). `status`:
 * the API's `GET /stats/status` answer, null while unknown or when the API is not reachable.
 */
export function CollectionBanner({ status }: { status: StatsStatusResponse | null }) {
  const warning = warningOf(status);
  const now = useNow(30_000);
  if (!warning) return null;
  const ago = stoppedAgo(warning, now);
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-down/40 bg-down/10 px-4 py-1.5 text-xs text-down"
    >
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        <WarningText warning={warning} />
      </span>
      {ago && <span className="ml-auto shrink-0 text-muted-foreground">Collection {ago}</span>}
    </div>
  );
}
