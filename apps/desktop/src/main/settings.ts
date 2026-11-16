import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

/**
 * The default API address before the desktop went through the public gateway (a local Docker
 * stack). Every settings file saved since holds it, so it is read as "the default" and moves to
 * the gateway; a local API is set with PICKLEAGUE_API_URL for the run (dev) instead.
 */
export const LEGACY_DEFAULT_API_URL = 'http://localhost:3000';

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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Settings saved at `path`; defaults when there are none yet. A file that cannot be read as
 * settings is logged and kept next to it as `<path>.corrupt` before falling back to defaults.
 */
export async function loadSettings(
  path: string,
  log: (message: string) => void = () => undefined,
): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`settings not read (${errorText(e)}), using the defaults`);
    }
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const settings = sanitizeSettings(JSON.parse(text));
    return settings.apiUrl === LEGACY_DEFAULT_API_URL
      ? { ...settings, apiUrl: DEFAULT_SETTINGS.apiUrl }
      : settings;
  } catch (e) {
    const backup = `${path}.corrupt`;
    const kept = await copyFile(path, backup).then(
      () => `kept as ${backup}`,
      (e2) => `no copy kept: ${errorText(e2)}`,
    );
    log(`settings file is corrupt (${errorText(e)}; ${kept}), using the defaults`);
    return { ...DEFAULT_SETTINGS };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replaces `path` in one step: never a half-written file, even if the app dies mid-write. */
async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  // Windows: an antivirus or indexer briefly holding the file makes the rename fail.
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
      await sleep(20 * attempt);
    }
  }
}

/**
 * Saves settings to `path`, one write at a time: a burst of saves (Ctrl + wheel zoom) ends with
 * the last settings on disk, the ones in between are skipped. Each returned promise settles once
 * its settings (or newer ones) are written; it rejects if that last write failed.
 */
export function createSettingsSaver(path: string): (settings: Settings) => Promise<void> {
  let pending: Settings | null = null;
  let flushing: Promise<void> | null = null;

  async function flush(): Promise<void> {
    let error: unknown = null;
    while (pending) {
      const next = pending;
      pending = null;
      try {
        await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
        error = null;
      } catch (e) {
        error = e;
      }
    }
    // Same synchronous step as the last `pending` check: a later save starts a new flush.
    flushing = null;
    if (error) throw error;
  }

  return (settings) => {
    pending = settings;
    flushing ??= flush();
    return flushing;
  };
}
