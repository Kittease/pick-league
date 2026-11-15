import { useSyncExternalStore } from 'react';
import { type ConfidenceLevel, DEFAULT_MIN_CONFIDENCE, toConfidenceLevel } from '@/lib/confidence';

const STORAGE_KEY = 'pickleague.minConfidence';

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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Minimum confidence of the champions shown, one choice for the tier list (and its matchups),
 * the champion select picks and the draft planner; remembered in this renderer's local storage.
 */
export function useMinConfidence() {
  return [useSyncExternalStore(subscribe, get), set] as const;
}
