'use client';

import type { TierListResponse } from '@pick-league/shared';
import { DEFAULT_TIER_LIST_FILTERS } from '@pick-league/shared';
import { PickLeagueDataProvider } from '@pick-league/ui/components/data-provider';
import type { PickLeagueData } from '@pick-league/ui/lib/data';
import { type ReactNode, useMemo, useRef } from 'react';

/** The Server Actions the shared views call (`PickLeagueData`, passed from a Server Component). */
export type DataActions = PickLeagueData;

/**
 * Gives the shared views their API calls: the Server Actions, behind a value that stays the same
 * for the page's life (a new identity would make the views re-fetch). `initialTierList`, rendered
 * on the server, answers the tier list's first request when it asks for that same list.
 */
export function DataProvider({
  actions,
  initialTierList,
  children,
}: {
  actions: DataActions;
  initialTierList: TierListResponse | null;
  children: ReactNode;
}) {
  const latest = useRef(actions);
  latest.current = actions;
  const initial = useRef(initialTierList);

  const value = useMemo<PickLeagueData>(
    () => ({
      getTierList: (role, filters = DEFAULT_TIER_LIST_FILTERS) => {
        const first = initial.current;
        initial.current = null;
        if (
          first &&
          first.role === role &&
          first.filters.platform === filters.platform &&
          first.filters.rank === filters.rank
        ) {
          return Promise.resolve({ ok: true, data: first });
        }
        return latest.current.getTierList(role, filters);
      },
      getTierListChampion: (role, championId, filters) =>
        latest.current.getTierListChampion(role, championId, filters),
      getGenericBuild: (championId, role) => latest.current.getGenericBuild(championId, role),
      draftPicks: (request) => latest.current.draftPicks(request),
      draftBuild: (request) => latest.current.draftBuild(request),
      evaluateDraft: (request) => latest.current.evaluateDraft(request),
      getPatchNotesIndex: () => latest.current.getPatchNotesIndex(),
      getPatchNotes: (patch, build) => latest.current.getPatchNotes(patch, build),
    }),
    [],
  );

  return <PickLeagueDataProvider value={value}>{children}</PickLeagueDataProvider>;
}
