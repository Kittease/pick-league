'use client';

import { cn } from '@pick-league/ui/lib/utils';
import { LayoutGridIcon, ListOrderedIcon } from 'lucide-react';
import Link from 'next/link';

/** The web app's views, one route each. */
export type WebView = 'tierlist' | 'draft';

export const VIEW_HREF: Record<WebView, string> = { tierlist: '/', draft: '/draft' };

export function viewOf(pathname: string): WebView {
  return pathname.replace(/\/+$/, '') === VIEW_HREF.draft ? 'draft' : 'tierlist';
}

const ITEMS: { view: WebView; label: string; Icon: typeof ListOrderedIcon }[] = [
  { view: 'tierlist', label: 'Tier list', Icon: ListOrderedIcon },
  { view: 'draft', label: 'Draft', Icon: LayoutGridIcon },
];

/**
 * Switches between the tier list and the draft planner: the desktop's slim left rail from
 * tablet width up, a bottom bar on phones.
 */
export function ViewNav({ view }: { view: WebView }) {
  return (
    <nav
      aria-label="Views"
      className="order-last flex shrink-0 border-t border-border md:order-first md:w-14 md:flex-col md:border-t-0 md:border-r md:py-1"
    >
      {ITEMS.map(({ view: v, label, Icon }) => {
        const active = v === view;
        return (
          <Link
            key={v}
            href={VIEW_HREF[v]}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex flex-1 flex-col items-center gap-1 px-0.5 py-2 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground md:flex-none md:py-2.5',
              active &&
                'bg-card text-foreground shadow-[inset_0_2px_0_var(--primary)] md:shadow-[inset_2px_0_0_var(--primary)]',
            )}
          >
            <Icon className="size-4" />
            <span className="leading-tight">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
