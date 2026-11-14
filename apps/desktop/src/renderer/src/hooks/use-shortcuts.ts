import { useEffect, useRef } from 'react';
import { isMacPlatform, type Shortcut, shortcutOf } from '@/lib/shortcuts';

/** Popups that handle Escape (and keep keyboard focus) themselves: dialogs, sheets, selects, menus. */
const OVERLAY = ':is([role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"])';

function overlayOpen(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest(OVERLAY)) return true;
  return document.querySelector(`${OVERLAY}:not([data-closed])`) !== null;
}

export const IS_MAC = isMacPlatform(
  typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent,
);

/**
 * App-wide shortcuts. `onShortcut` returns true when it used the key (its default action is
 * then prevented). Nothing happens while a popup is open or focused: whether one is open is read
 * before any handler runs (capture), and a key a handler already used (Base UI closing a popup
 * calls `preventDefault`) is skipped.
 */
export function useShortcuts(onShortcut: (shortcut: Shortcut) => boolean) {
  const handler = useRef(onShortcut);
  handler.current = onShortcut;
  useEffect(() => {
    const blocked = new WeakSet<KeyboardEvent>();
    const capture = (e: KeyboardEvent) => {
      if (overlayOpen(e.target)) blocked.add(e);
    };
    const bubble = (e: KeyboardEvent) => {
      if (blocked.has(e)) return;
      const shortcut = shortcutOf(e, IS_MAC);
      if (shortcut && handler.current(shortcut)) e.preventDefault();
    };
    window.addEventListener('keydown', capture, true);
    window.addEventListener('keydown', bubble);
    return () => {
      window.removeEventListener('keydown', capture, true);
      window.removeEventListener('keydown', bubble);
    };
  }, []);
}
