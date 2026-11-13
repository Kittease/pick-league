import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
    toast('Already up to date', { description: 'The stats include every stored game.' });
  else if (out.kind === 'skipped' && out.reason === 'cooldown')
    toast.warning('Refreshed moments ago', {
      description: `Try again in ${out.retryAfterSeconds ?? 60} s.`,
    });
}

/** Header item: how fresh the API's stats are + a button to include the newest games. */
export function StatsFreshness({ state }: { state: AppState }) {
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
            ? `${lastManual.added.toLocaleString()} new games included — recommendations updated.`
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
      ? `Include ${pending.toLocaleString()} new games in the stats`
      : 'Stats include every stored game — check again';

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
    </span>
  );
}
