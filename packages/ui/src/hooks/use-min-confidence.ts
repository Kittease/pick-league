import {
  type ConfidenceLevel,
  DEFAULT_MIN_CONFIDENCE,
  toConfidenceLevel,
} from '@pick-league/ui/lib/confidence';
import { useSyncExternalStore } from 'react';

// v2: the default became High; a choice saved under the old key (often the old Low default) is dropped.
const STORAGE_KEY = 'pickleague.minConfidence.v2';

function load(): ConfidenceLevel {
  try {
    return toConfidenceLevel(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_MIN_CONFIDENCE;
  }
}

let current: ConfidenceLevel | null = null;
const listeners = new Set<() => void>();

function get(): ConfidenceLevel {
  current ??= load();
  return current;
}

function set(level: ConfidenceLevel): void {
  current = level;
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Storage unavailable: the choice only lasts for this session.
  }
  for (const listener of listeners) listener();
}

/** Server render (Next.js): no storage there, the default until the client hydrates. */
function getServer(): ConfidenceLevel {
  return DEFAULT_MIN_CONFIDENCE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Minimum confidence of the champions shown, one choice for the tier list (and its matchups),
 * the champion select picks and the draft planner; remembered in this browser's local storage.
 */
export function useMinConfidence() {
  return [useSyncExternalStore(subscribe, get, getServer), set] as const;
}
