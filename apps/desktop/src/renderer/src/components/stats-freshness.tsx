import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type CollectionWarning, collectionWarning } from '@/lib/collection';
import { compact, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../../../core/app-state.ts';

/** Re-renders every `ms` so relative times stay current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

async function requestRefresh() {
  const out = await window.pickleague.refreshStats();
  if (out.kind === 'error') toast.error('Refresh failed', { description: out.message });
  else if (out.kind === 'skipped' && out.reason === 'up_to_date')
    toast('Already up to date', { description: 'The stats include every stored match.' });
  else if (out.kind === 'skipped' && out.reason === 'playing')
    toast('Runs after your match', {
      description: 'The refresh is heavy: it waits until the match is over.',
    });
  else if (out.kind === 'skipped' && out.reason === 'cooldown')
    toast.warning('Refreshed moments ago', {
      description: `Try again in ${out.retryAfterSeconds ?? 60} s.`,
    });
}

/** Collection stopped (rejected Riot key, worker down), when the API is up and says so. */
function warningOf(state: AppState): CollectionWarning | null {
  if (state.api.state !== 'ok') return null;
  return collectionWarning(state.stats.status?.collection);
}

function stoppedAgo(warning: CollectionWarning, now: number): string | null {
  return warning.since ? `stopped ${timeAgo(warning.since, now)}` : null;
}

function WarningText({ warning }: { warning: CollectionWarning }) {
  return (
    <>
      <span className="font-semibold">{warning.title}</span>{' '}
      <span className="text-foreground/80">
        {warning.fix.text} <span className="num">{warning.fix.command}</span>.
      </span>
    </>
  );
}

/** Full-width line under the header while collection is stopped (nothing otherwise). */
export function CollectionBanner({ state }: { state: AppState }) {
  const warning = warningOf(state);
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

/** Header item: how fresh the API's stats are + a button to include the newest matches. */
export function StatsFreshness({ state }: { state: AppState }) {
  const warning = warningOf(state);
  const { status, refreshing, lastManual } = state.stats;
  const now = useNow(30_000);

  // Toast each finished manual refresh once.
  const [toastedAt, setToastedAt] = useState<string | null>(lastManual?.at ?? null);
  useEffect(() => {
    if (!lastManual || lastManual.at === toastedAt) return;
    setToastedAt(lastManual.at);
    if (lastManual.result === 'done')
      toast.success('Stats refreshed', {
        description:
          lastManual.added > 0
            ? `${lastManual.added.toLocaleString()} new matches included — recommendations updated.`
            : 'Recommendations updated.',
      });
    else toast.error('Refresh did not complete', { description: 'Check the API logs.' });
  }, [lastManual, toastedAt]);

  if (state.api.state !== 'ok' || !status) return null;
  const pending = status.pendingMatches;
  const label = refreshing
    ? 'updating…'
    : status.lastRefreshedAt
      ? timeAgo(status.lastRefreshedAt, now)
      : 'not computed yet';
  const tip = refreshing
    ? 'The API is recomputing its stats; recommendations reload when it is done.'
    : pending > 0
      ? `Include ${pending.toLocaleString()} new matches in the stats`
      : 'Stats include every stored match — check again';

  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="text-muted-foreground">Stats</span>
      <span className={cn(refreshing && 'text-primary')}>
        {!refreshing && status.lastRefreshedAt && (
          <span className="hidden text-muted-foreground lg:inline">updated </span>
        )}
        {label}
      </span>
      {!refreshing && pending > 0 && (
        <span className="num whitespace-nowrap bg-gold/15 px-1.5 py-px text-[10px] font-semibold text-gold">
          +{compact(pending)} new
        </span>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh stats"
              disabled={refreshing}
              onClick={() => void requestRefresh()}
            />
          }
        >
          <RefreshCwIcon className={cn(refreshing && 'animate-spin')} />
        </TooltipTrigger>
        <TooltipContent side="bottom">{tip}</TooltipContent>
      </Tooltip>
      {warning && <CollectionBadge warning={warning} now={now} />}
    </span>
  );
}
