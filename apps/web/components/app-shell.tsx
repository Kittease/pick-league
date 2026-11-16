'use client';

import type { StaticDataResponse, TierListResponse } from '@pick-league/shared';
import { TooltipProvider } from '@pick-league/ui/components/ui/tooltip';
import { createStaticLookup } from '@pick-league/ui/lib/static-lookup';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ServerStatus } from '@/app/actions';
import { type DataActions, DataProvider } from './data';
import { ViewNav, viewOf } from './nav';
import { StatusHeader } from './status-header';

/** Header status refresh, as the desktop polls `GET /stats/status`. */
const STATUS_POLL_MS = 60_000;

const Views = dynamic(() => import('./views'), {
  ssr: false,
  loading: () => <div className="flex-1" />,
});

const noSubscribe = () => () => {};

/** True once rendered in the browser (false in the server's HTML and while hydrating). */
function useInBrowser(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

/** Header status, refreshed every minute while the page is visible. */
function useServerStatus(initial: ServerStatus, poll: () => Promise<ServerStatus>): ServerStatus {
  const [status, setStatus] = useState(initial);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void poll().then(
        (s) => alive && setStatus(s),
        () => {},
      );
    };
    const timer = setInterval(refresh, STATUS_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [poll]);
  return status;
}

/**
 * The app around the routes' views: header, navigation, the shared views and their data
 * (Server Actions). Rendered once by the root layout, so the views stay mounted across routes.
 */
export function AppShell({
  staticData,
  initialStatus,
  initialTierList,
  actions,
  getServerStatus,
}: {
  staticData: StaticDataResponse | null;
  initialStatus: ServerStatus;
  initialTierList: TierListResponse | null;
  actions: DataActions;
  getServerStatus: () => Promise<ServerStatus>;
}) {
  const view = viewOf(usePathname());
  const live = useInBrowser();
  const status = useServerStatus(initialStatus, getServerStatus);
  const lookup = useMemo(() => (staticData ? createStaticLookup(staticData) : null), [staticData]);
  // A new patch or stats refresh drops the views' cached answers.
  const dataKey = `${status.health?.latestPatch ?? ''}|${status.stats?.lastRefreshedAt ?? ''}|${status.health !== null}`;

  return (
    <DataProvider actions={actions} initialTierList={initialTierList}>
      <TooltipProvider>
        <StatusHeader status={status} live={live} />
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ViewNav view={view} />
          <main className="flex min-h-0 min-w-0 flex-1">
            <Views view={view} lookup={lookup} dataKey={dataKey} />
          </main>
        </div>
      </TooltipProvider>
    </DataProvider>
  );
}
