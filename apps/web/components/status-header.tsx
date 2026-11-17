'use client';

import { CollectionBanner } from '@pick-league/ui/components/collection-banner';
import { compact } from '@pick-league/ui/lib/format';
import { cn } from '@pick-league/ui/lib/utils';
import type { ServerStatus } from '@/app/actions';

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' }) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        tone === 'ok' && 'bg-up',
        tone === 'warn' && 'bg-gold',
        tone === 'bad' && 'bg-down',
      )}
    />
  );
}

/**
 * The desktop's header without what needs the League client: the current patch and its match
 * count, and the line under it while collection is stopped. That line's relative time only
 * renders in the browser (`live`), so the server's HTML never disagrees with it.
 */
export function StatusHeader({ status, live }: { status: ServerStatus; live: boolean }) {
  const { health, stats } = status;
  const tone = !health ? 'bad' : health.latestPatch ? 'ok' : 'warn';
  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-3.5 border-b border-border px-4 text-xs whitespace-nowrap">
        <span className="shrink-0 font-semibold tracking-[0.2em] uppercase">PickLeague</span>

        <span className="h-4 w-px shrink-0 bg-border" />

        <span className="flex min-w-0 items-center gap-2">
          <Dot tone={tone} />
          <span className="hidden text-muted-foreground sm:inline">API</span>
          <span className="truncate">
            {!health
              ? 'unreachable'
              : health.latestPatch
                ? `patch ${health.latestPatch} · ${compact(health.patchMatchCount ?? health.matchCount)} matches`
                : 'no data yet'}
          </span>
        </span>
      </header>
      {live && <CollectionBanner status={stats} />}
    </>
  );
}
