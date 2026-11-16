import { type RovingOrientation, rovingTarget } from '@pick-league/ui/lib/roving';
import { type KeyboardEvent, useCallback, useRef, useState } from 'react';

const ATTR = 'data-roving-key';

/** Props of one item of a roving list (see `useRoving`). */
export interface RovingItemProps {
  tabIndex: number;
  'data-roving-key': string;
  onFocus: () => void;
}

/**
 * Roving tabindex for a list or grid (see `rovingTarget`): only one item is a tab stop (the
 * last one focused, else the first), arrows / Home / End move focus between items, Tab leaves
 * the list. Spread `itemProps(key)` on each item and attach `containerRef` + `onKeyDown` to an
 * element around them; `focusFirst` enters the list (Tab or ArrowDown from a search field).
 */
export function useRoving<K extends string | number>(
  keys: readonly K[],
  orientation: RovingOrientation = 'grid',
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<K | null>(null);
  const current = active !== null && keys.includes(active) ? active : (keys[0] ?? null);

  const itemProps = (key: K): RovingItemProps => ({
    tabIndex: key === current ? 0 : -1,
    'data-roving-key': String(key),
    onFocus: () => setActive(key),
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const all = [...(containerRef.current?.querySelectorAll<HTMLElement>(`[${ATTR}]`) ?? [])];
    const target = e.target instanceof Element ? e.target.closest(`[${ATTR}]`) : null;
    const index = target instanceof HTMLElement ? all.indexOf(target) : -1;
    if (index < 0) return;
    const next = rovingTarget(
      e.key,
      index,
      all.map((el) => el.getBoundingClientRect()),
      orientation,
    );
    if (next === null) return;
    e.preventDefault();
    const el = all[next];
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  };

  /** Focuses the first item (the list's own order); false when the list is empty. */
  const focusFirst = useCallback((): boolean => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[${ATTR}]`);
    if (!el) return false;
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
    return true;
  }, []);

  return { containerRef, itemProps, onKeyDown, focusFirst };
}

/**
 * Keys of a search field that move into its result list: Tab (forward) and ArrowDown. Returns
 * true when it moved (the key's default is then prevented).
 */
export function enterListFromSearch(e: KeyboardEvent, focusFirst: () => boolean): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (e.key !== 'Tab' && e.key !== 'ArrowDown') return false;
  if (!focusFirst()) return false;
  e.preventDefault();
  return true;
}
