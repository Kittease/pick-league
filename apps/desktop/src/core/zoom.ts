/** Zoom levels offered in Settings and stepped through with Ctrl +/- (1 = 100%). */
export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export const DEFAULT_ZOOM = 1;

/** The offered level closest to `value`; 100% when it isn't a number (old or edited settings). */
export function nearestZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ZOOM;
  let best: number = ZOOM_LEVELS[0];
  for (const z of ZOOM_LEVELS) if (Math.abs(z - value) < Math.abs(best - value)) best = z;
  return best;
}

/** What a key press does to the zoom (Electron `before-input-event` input), or null. */
export function zoomShortcut(input: {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}): 'in' | 'out' | 'reset' | null {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
  if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.code === 'NumpadSubtract') return 'out';
  // 0 by physical key: on AZERTY that key types "à".
  if (input.code === 'Digit0' || input.code === 'Numpad0') return 'reset';
  return null;
}

/** The next level up (+1) or down (-1), staying at the ends of the range. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const i = ZOOM_LEVELS.indexOf(nearestZoom(current) as (typeof ZOOM_LEVELS)[number]);
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, i + direction));
  return ZOOM_LEVELS[next] as number;
}
