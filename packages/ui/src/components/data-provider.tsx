'use client';

import type { PickLeagueData } from '@pick-league/ui/lib/data';
import { createContext, type ReactNode, useContext } from 'react';

const PickLeagueDataContext = createContext<PickLeagueData | null>(null);

/** Gives the shared views their API calls (see `PickLeagueData`). */
export function PickLeagueDataProvider({
  value,
  children,
}: {
  value: PickLeagueData;
  children: ReactNode;
}) {
  return <PickLeagueDataContext value={value}>{children}</PickLeagueDataContext>;
}

/** The API calls of the closest `PickLeagueDataProvider`. */
export function usePickLeagueData(): PickLeagueData {
  const data = useContext(PickLeagueDataContext);
  if (!data) throw new Error('usePickLeagueData: wrap the views in a <PickLeagueDataProvider>');
  return data;
}
