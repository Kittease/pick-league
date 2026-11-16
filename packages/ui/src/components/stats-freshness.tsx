'use client';

import type { StatsStatusResponse } from '@pick-league/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@pick-league/ui/components/ui/tooltip';
import { type CollectionWarning, collectionWarning } from '@pick-league/ui/lib/collection';
import { compact, timeAgo } from '@pick-league/ui/lib/format';
import { cn } from '@pick-league/ui/lib/utils';
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
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

/** Header badge: collection stopped, and since when. */
function CollectionBadge({ warning, now }: { warning: CollectionWarning; now: number }) {
  const ago = stoppedAgo(warning, now);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="flex shrink-0 items-center gap-1 font-semibold text-down" />}
      >
        <TriangleAlertIcon className="size-3.5" />
        {warning.label}
        {ago && <span className="hidden font-normal lg:inline">· {ago}</span>}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-sm whitespace-normal">
        <WarningText warning={warning} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Header item: how fresh the API's stats are (the API refreshes them every hour). `status`: the
 * API's `GET /stats/status` answer, null while unknown or when the API is not reachable (nothing
 * shown then); `refreshing`: a refresh of the stats is running.
 */
export function StatsFreshness({
  status,
  refreshing = false,
}: {
  status: StatsStatusResponse | null;
  refreshing?: boolean;
}) {
  const warning = warningOf(status);
  const now = useNow(30_000);

  if (!status) return null;
  const pending = status.pendingMatches;
  const label = refreshing
    ? 'updating…'
    : status.lastRefreshedAt
      ? timeAgo(status.lastRefreshedAt, now)
      : 'not computed yet';
  const tip = refreshing
    ? 'The API is recomputing its stats; recommendations reload when it is done.'
    : pending > 0
      ? `${pending.toLocaleString()} new matches are included at the next hourly refresh.`
      : 'The stats include every stored match. The API refreshes them every hour.';

  return (
    <span className="flex shrink-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0 items-center gap-2" />}>
          <span className="text-muted-foreground">Stats</span>
          <span className={cn(refreshing && 'text-primary')}>
            {!refreshing && status.lastRefreshedAt && (
              <span className="hidden text-muted-foreground lg:inline">updated </span>
            )}
            {label}
          </span>
          {refreshing && <RefreshCwIcon className="size-3.5 animate-spin text-primary" />}
          {!refreshing && pending > 0 && (
            <span className="num whitespace-nowrap bg-gold/15 px-1.5 py-px text-[10px] font-semibold text-gold">
              +{compact(pending)} new
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom">{tip}</TooltipContent>
      </Tooltip>
      {warning && <CollectionBadge warning={warning} now={now} />}
    </span>
  );
}
