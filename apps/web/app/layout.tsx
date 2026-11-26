import { DEFAULT_TIER_LIST_FILTERS } from '@pick-league/shared';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { getStaticData, getTierList } from '@/lib/queries';
import {
  draftBuild,
  draftPicks,
  evaluateDraft,
  getGenericBuild,
  getPatchNotes,
  getPatchNotesIndex,
  getServerStatus,
  getTierList as getTierListAction,
  getTierListChampion,
} from './actions';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'PickLeague', template: '%s · PickLeague' },
  description:
    'League of Legends tier list, matchups and draft planner from high-elo ranked games, with the reasons behind every pick and build.',
};

export const viewport: Viewport = { themeColor: '#0f1519', colorScheme: 'dark' };

const RIOT_NOTICE =
  "PickLeague isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.";

/** Role the tier list shows first (the shared view's default). */
const FIRST_ROLE = 'MIDDLE';

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered on the server for every route: static data (names + icons), the header status and
  // the tier list's first role, from the server's data cache (see lib/queries.ts).
  const [staticData, status, tierList] = await Promise.all([
    getStaticData(),
    getServerStatus(),
    getTierList({ role: FIRST_ROLE, patch: 'latest', ...DEFAULT_TIER_LIST_FILTERS }),
  ]);

  return (
    <html lang="en" className="dark">
      <body className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <AppShell
          staticData={staticData.ok ? staticData.data : null}
          initialStatus={status}
          initialTierList={tierList.ok ? tierList.data : null}
          actions={{
            getTierList: getTierListAction,
            getTierListChampion,
            getGenericBuild,
            draftPicks,
            draftBuild,
            evaluateDraft,
            getPatchNotesIndex,
            getPatchNotes,
          }}
          getServerStatus={getServerStatus}
        />
        {children}
        <footer className="shrink-0 border-t border-border px-4 py-1 text-[10px] leading-snug text-muted-foreground">
          <p className="max-md:hidden">{RIOT_NOTICE}</p>
          {/* Phones: the notice folds into one line, the screen is too short for four. */}
          <details className="md:hidden">
            <summary className="cursor-pointer">
              PickLeague isn't endorsed by Riot Games · legal notice
            </summary>
            <p className="pt-1">{RIOT_NOTICE}</p>
          </details>
        </footer>
      </body>
    </html>
  );
}
