import type { StaticDataResponse } from '@pick-league/shared';
import { createStaticLookup, type StaticLookup } from '@pick-league/ui/lib/static-lookup';
import { useEffect, useMemo, useState } from 'react';
import type { AppState } from '../../../core/app-state.ts';

export type { StaticLookup };

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = window.pickleague.onState((s) => setState(s));
    void window.pickleague.getState().then((s) => {
      if (alive) setState((prev) => prev ?? s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/** Static data (names + icon URLs), re-fetched when the main process reports a new version. */
export function useStatic(version: string | null | undefined): StaticLookup | null {
  const [data, setData] = useState<StaticDataResponse | null>(null);
  useEffect(() => {
    if (!version) return;
    let alive = true;
    void window.pickleague.getStatic().then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [version]);
  return useMemo(() => (data ? createStaticLookup(data) : null), [data]);
}
