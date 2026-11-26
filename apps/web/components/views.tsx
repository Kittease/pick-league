'use client';

import { type DraftHandle, DraftPlanner } from '@pick-league/ui/components/draft-planner';
import { PatchNotesPage } from '@pick-league/ui/components/patch-notes';
import { type TierListHandle, TierListPage } from '@pick-league/ui/components/tier-list';
import { useShortcuts } from '@pick-league/ui/hooks/use-shortcuts';
import { draftEscapeAction, escapeAction } from '@pick-league/ui/lib/shortcuts';
import type { StaticLookup } from '@pick-league/ui/lib/static-lookup';
import { useRef, useState } from 'react';
import type { WebView } from './nav';

/**
 * The tier list, the draft planner and the patch notes. Each mounts on its first visit and then stays mounted
 * (hidden on the other route), so role, filters, selection and the draft in progress survive
 * a trip to the other page, as in the desktop app. Rendered in the browser only: the shared
 * views read local storage and the platform (shortcut labels) on their first render.
 */
export default function Views({
  view,
  lookup,
  dataKey,
}: {
  view: WebView;
  lookup: StaticLookup | null;
  dataKey: string;
}) {
  const [visited, setVisited] = useState<ReadonlySet<WebView>>(() => new Set([view]));
  if (!visited.has(view)) setVisited(new Set([...visited, view]));

  // Escape steps back (search text, build page, details); Ctrl/Cmd+K or F focuses the search
  // of the shown view. See `escapeAction` / `draftEscapeAction`.
  const tierList = useRef<TierListHandle>(null);
  const draft = useRef<DraftHandle>(null);
  useShortcuts((shortcut) => {
    if (view === 'patches') return false;
    if (view === 'draft') {
      const planner = draft.current;
      if (!planner) return false;
      if (shortcut === 'focus-search') {
        planner.focusSearch();
        return true;
      }
      const action = draftEscapeAction(planner.escapeState());
      if (action === null) return false;
      planner.escape(action);
      return true;
    }
    const list = tierList.current;
    if (!list) return false;
    if (shortcut === 'focus-search') {
      list.focusSearch();
      return true;
    }
    const action = escapeAction({ view, ...list.escapeState() });
    if (action === null || action === 'show-tier-list') return false;
    list.escape(action);
    return true;
  });

  return (
    <>
      {visited.has('tierlist') && (
        <div className={view === 'tierlist' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}>
          <TierListPage lookup={lookup} dataKey={dataKey} handleRef={tierList} />
        </div>
      )}
      {visited.has('draft') && (
        <div className={view === 'draft' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}>
          <DraftPlanner lookup={lookup} dataKey={dataKey} handleRef={draft} />
        </div>
      )}
      {visited.has('patches') && (
        <div className={view === 'patches' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}>
          <PatchNotesPage lookup={lookup} dataKey={dataKey} />
        </div>
      )}
    </>
  );
}
