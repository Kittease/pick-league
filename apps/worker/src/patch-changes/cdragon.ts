/**
 * Community Dragon client: the game files of a patch folder (`<major.minor>`, or `latest`) and
 * their build. Its own small fetch with timeouts and retries, outside the Riot rate limiter.
 */
import type { PatchId } from '@pick-league/shared';

export const CDRAGON_BASE_URL = 'https://raw.communitydragon.org';

/** A build of the game files: `16.23.8418428+branch.releases-16-23.content.release`. */
export interface ContentVersion {
  /** As read. */
  version: string;
  patch: PatchId;
  /** '16.23.8418428' (the matches' game_version 16.23.841.8428 without its last dot). */
  build: string;
  buildNumber: number;
}

/** Parses `content-metadata.json`'s version; null when it is not `major.minor.build…`. */
export function parseContentVersion(version: string): ContentVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  const patch = `${Number(m[1])}.${Number(m[2])}`;
  return { version, patch, build: `${patch}.${m[3]}`, buildNumber: Number(m[3]) };
}

export interface CdragonClientOptions {
  /** Defaults to global fetch; inject a fake in tests. */
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  baseUrl?: string;
  /** Per request (default 60 s; the items file is ~16 MB). */
  timeoutMs?: number;
  /** Tries per request on a network error, a timeout or a 5xx (default 3). */
  tries?: number;
  /** Before the n-th retry: n × this (default 5 s). */
  retryDelayMs?: number;
}

export class CdragonHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Community Dragon request failed: ${status} ${url}`);
    this.name = 'CdragonHttpError';
  }
}

export interface CdragonClient {
  /** The build of a folder (`16.23`, `latest`); null when the folder does not exist (yet). */
  contentVersion(folder: string): Promise<ContentVersion | null>;
  /** `<alias>.bin.json` of a champion (alias = Data Dragon id lowercased); null when absent. */
  championFile(folder: string, alias: string): Promise<unknown | null>;
  /** `items.cdtb.bin.json`. */
  itemsFile(folder: string): Promise<unknown>;
}

export function createCdragonClient(options: CdragonClientOptions = {}): CdragonClient {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const base = options.baseUrl ?? CDRAGON_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const tries = options.tries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 5_000;

  /** The parsed JSON, or null on 404. */
  async function getJson(path: string): Promise<unknown | null> {
    const url = `${base}/${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) await Bun.sleep((attempt - 1) * retryDelayMs);
      try {
        const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 404) return null;
        if (!res.ok) {
          lastError = new CdragonHttpError(url, res.status);
          if (res.status >= 500 || res.status === 429) continue;
          throw lastError;
        }
        return await res.json();
      } catch (err) {
        if (err instanceof CdragonHttpError) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  return {
    async contentVersion(folder) {
      const body = await getJson(`${folder}/content-metadata.json`);
      if (body === null) return null;
      const version = (body as { version?: unknown }).version;
      return typeof version === 'string' ? parseContentVersion(version) : null;
    },
    championFile: (folder, alias) =>
      getJson(`${folder}/game/data/characters/${alias}/${alias}.bin.json`),
    async itemsFile(folder) {
      const body = await getJson(`${folder}/game/items.cdtb.bin.json`);
      if (body === null)
        throw new CdragonHttpError(`${base}/${folder}/game/items.cdtb.bin.json`, 404);
      return body;
    },
  };
}
