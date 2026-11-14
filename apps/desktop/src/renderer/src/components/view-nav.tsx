import { ListOrderedIcon, SwordsIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type View = 'select' | 'tierlist';

/**
 * Current view: the tier list out of champion select, champion select as soon as it starts —
 * unless the user is looking at a champion in the tier list (`setBusy(true)`): then the nav
 * only shows a live dot and the user switches when ready. Back to the tier list when it ends
 * (after the game it led to).
 */
export function useAutoView(inSelect: boolean) {
  const [view, setView] = useState<View>(inSelect ? 'select' : 'tierlist');
  const busy = useRef(false);
  const prev = useRef(inSelect);
  useEffect(() => {
    if (inSelect === prev.current) return;
    prev.current = inSelect;
    if (inSelect) setView((v) => (v === 'tierlist' && busy.current ? v : 'select'));
    else setView('tierlist');
  }, [inSelect]);
  const setBusy = useCallback((b: boolean) => {
    busy.current = b;
  }, []);
  return { view, setView, setBusy };
}

const ITEMS: { view: View; label: string; Icon: typeof SwordsIcon }[] = [
  { view: 'select', label: 'Champ select', Icon: SwordsIcon },
  { view: 'tierlist', label: 'Tier list', Icon: ListOrderedIcon },
];

/** Slim left rail switching between the champion select view and the tier list. */
export function ViewNav({
  view,
  onChange,
  liveSelect,
  inGame,
}: {
  view: View;
  onChange: (view: View) => void;
  /** Champion select is running (or its game): a dot on its item. */
  liveSelect: boolean;
  inGame: boolean;
}) {
  return (
    <nav aria-label="Views" className="flex w-14 shrink-0 flex-col border-r border-border py-1">
      {ITEMS.map(({ view: v, label, Icon }) => {
        const active = v === view;
        return (
          <button
            key={v}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onChange(v)}
            className={cn(
              'relative flex flex-col items-center gap-1 px-0.5 py-2.5 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground',
              active && 'bg-card text-foreground shadow-[inset_2px_0_0_var(--primary)]',
            )}
          >
            <Icon className="size-4" />
            <span className="leading-tight">{label}</span>
            {v === 'select' && liveSelect && (
              <span
                title={inGame ? 'Game in progress' : 'Champion select in progress'}
                className="absolute top-2 right-2.5 size-1.5 animate-pulse rounded-full bg-up"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
