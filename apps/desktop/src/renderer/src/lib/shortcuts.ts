import type { View } from './views';

/**
 * Keyboard shortcuts of the renderer. Zoom (Ctrl/Cmd +, −, 0, wheel) and reload/devtools are
 * handled by the main process.
 */
export type Shortcut = 'escape' | 'focus-search';

/** The parts of a `KeyboardEvent` the mapping reads (a plain object in tests). */
export interface KeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  /** Mid IME composition: the key belongs to the IME. */
  isComposing?: boolean;
}

/** macOS uses Cmd where the other systems use Ctrl. */
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

/** Label of a shortcut on the search letter `letter`: "Ctrl+K", or "⌘K" on macOS. */
export function shortcutLabel(letter: string, mac: boolean): string {
  return mac ? `⌘${letter.toUpperCase()}` : `Ctrl+${letter.toUpperCase()}`;
}

/** Latin letter of a key; the physical key when the layout types something else (Cyrillic…). */
function letterOf(e: KeyInput): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(e.code);
  return physical?.[1] ? physical[1].toLowerCase() : null;
}

/**
 * Shortcut of a key press, or null. Escape without modifiers; Ctrl+K / Ctrl+F (Cmd on macOS,
 * where Ctrl+K stays the text fields' own shortcut) without Shift or Alt (AltGr = Ctrl+Alt on
 * Windows types characters). Ignored once another handler took the key (`defaultPrevented`:
 * Base UI closing a popup) and during IME composition.
 */
export function shortcutOf(e: KeyInput, mac: boolean): Shortcut | null {
  if (e.defaultPrevented || e.isComposing) return null;
  if (e.key === 'Escape') {
    return e.ctrlKey || e.metaKey || e.altKey || e.shiftKey ? null : 'escape';
  }
  const primary = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  if (!primary || other || e.altKey || e.shiftKey) return null;
  const letter = letterOf(e);
  return letter === 'k' || letter === 'f' ? 'focus-search' : null;
}

/** Where focus is relative to the tier list's search field. */
export type SearchFocus = 'none' | 'empty' | 'filled';

/** What the tier list shows on top of its table. */
export type TierListLayer = 'list' | 'details' | 'build';

export type EscapeAction =
  | 'clear-search'
  | 'blur-search'
  | 'close-build'
  | 'close-details'
  | 'show-tier-list';

/**
 * What Escape does, one step per press: in the search field it clears the text, then leaves the
 * field; then it closes the generic build page (back to the champion's details), then the
 * details panel. From the champion select view it goes back to the tier list. Null: nothing to
 * do (the key is left alone), always in the draft planner (see `draftEscapeAction`).
 */
export function escapeAction(ctx: {
  view: View;
  search: SearchFocus;
  tierList: TierListLayer;
}): EscapeAction | null {
  if (ctx.view === 'draft') return null;
  if (ctx.view === 'select') return 'show-tier-list';
  if (ctx.search === 'filled') return 'clear-search';
  if (ctx.search === 'empty') return 'blur-search';
  if (ctx.tierList === 'build') return 'close-build';
  if (ctx.tierList === 'details') return 'close-details';
  return null;
}

export type DraftEscapeAction = 'clear-search' | 'blur-search' | 'close-build';

/**
 * Escape in the draft planner: clears its search text, then leaves the field, then closes the
 * build shown (back to the champion grid). Never undoes a draft action.
 */
export function draftEscapeAction(ctx: {
  search: SearchFocus;
  buildOpen: boolean;
}): DraftEscapeAction | null {
  if (ctx.search === 'filled') return 'clear-search';
  if (ctx.search === 'empty') return 'blur-search';
  return ctx.buildOpen ? 'close-build' : null;
}
