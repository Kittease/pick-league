import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { API_DEFAULT_URL, isPosition } from '@pick-league/shared';
import type { Settings } from '../core/app-state.ts';
import { isFlashKey } from '../core/spells.ts';
import { DEFAULT_ZOOM, nearestZoom } from '../core/zoom.ts';

export const DEFAULT_SETTINGS: Settings = {
  apiUrl: API_DEFAULT_URL,
  autoApply: true,
  fallbackRole: 'UTILITY',
  ownedOnly: true,
  zoom: DEFAULT_ZOOM,
  flashKey: 'F',
};

/** Keeps known keys with the right type; anything else falls back to the defaults. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof Settings) =>
    typeof r[k] === 'boolean' ? (r[k] as boolean) : (DEFAULT_SETTINGS[k] as boolean);
  const apiUrl =
    typeof r.apiUrl === 'string' && /^https?:\/\/\S+$/.test(r.apiUrl.trim())
      ? r.apiUrl.trim().replace(/\/+$/, '')
      : DEFAULT_SETTINGS.apiUrl;
  return {
    apiUrl,
    autoApply: bool('autoApply'),
    ownedOnly: bool('ownedOnly'),
    fallbackRole: isPosition(r.fallbackRole) ? r.fallbackRole : DEFAULT_SETTINGS.fallbackRole,
    zoom: nearestZoom(r.zoom),
    flashKey: isFlashKey(r.flashKey) ? r.flashKey : DEFAULT_SETTINGS.flashKey,
  };
}

export async function loadSettings(path: string): Promise<Settings> {
  try {
    return sanitizeSettings(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
