/** Main views of the window: champion select (or the screen waiting for it) and the tier list. */
export type View = 'select' | 'tierlist';

/**
 * View after a champion select starts or ends, or `view` unchanged. The app only moves on these
 * two edges: a champion select starting shows it (unless the user is reading a champion in the
 * tier list: `busy`), its end (after the game it led to) shows the tier list. In between, the
 * view stays wherever the user put it (nav, Escape), so leaving a running champion select is
 * never undone until the next one starts.
 */
export function autoView(
  view: View,
  change: { wasInSelect: boolean; inSelect: boolean; busy: boolean },
): View {
  const { wasInSelect, inSelect, busy } = change;
  if (inSelect === wasInSelect) return view;
  if (!inSelect) return 'tierlist';
  return view === 'tierlist' && busy ? view : 'select';
}
