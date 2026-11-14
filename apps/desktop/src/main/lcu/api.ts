/**
 * Typed LCU endpoints. Reads: champion select, gameflow, owned champions, mastery, current
 * summoner, platform/region, rune pages. Writes are limited to the PickLeague rune page and the
 * local player's summoner spells — the helper never picks, bans, locks in, accepts or reveals
 * other players' identities (the puuids of a game in progress only go to the user's own API).
 */

import type {
  LcuChampionMastery,
  LcuChampSelectSession,
  LcuCurrentSummoner,
  LcuGameflowPhase,
  LcuGameflowSession,
  LcuMySelectionPatch,
  LcuOwnedChampion,
  LcuPerkInventory,
  LcuPerkPage,
  LcuPerkPageInput,
  LcuPlatformHints,
} from '../../core/lcu-types.ts';

export type LcuMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

/** Sends one request to the client; resolves with the parsed JSON body (undefined if empty). */
export type LcuTransport = (method: LcuMethod, path: string, body?: unknown) => Promise<unknown>;

export class LcuHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`LCU ${method} ${path} → ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'LcuHttpError';
  }
}

export const CHAMP_SELECT_SESSION_PATH = '/lol-champ-select/v1/session';
export const GAMEFLOW_PHASE_PATH = '/lol-gameflow/v1/gameflow-phase';
export const GAMEFLOW_SESSION_PATH = '/lol-gameflow/v1/session';
export const PLATFORM_ID_PATH = '/lol-platform-config/v1/namespaces/LoginDataPacket/platformId';
export const REGION_LOCALE_PATH = '/riotclient/region-locale';

export interface LcuApi {
  getChampSelectSession(): Promise<LcuChampSelectSession | null>;
  getGameflowPhase(): Promise<LcuGameflowPhase | null>;
  getGameflowSession(): Promise<LcuGameflowSession | null>;
  getOwnedChampions(): Promise<LcuOwnedChampion[]>;
  getMastery(): Promise<LcuChampionMastery[]>;
  getCurrentSummoner(): Promise<LcuCurrentSummoner | null>;
  /** The account's platform id and region (either null when the client does not serve it). */
  getPlatformHints(): Promise<LcuPlatformHints>;
  getPerkPages(): Promise<LcuPerkPage[]>;
  getPerkInventory(): Promise<LcuPerkInventory>;
  createPerkPage(page: LcuPerkPageInput): Promise<LcuPerkPage>;
  replacePerkPage(id: number, page: LcuPerkPageInput): Promise<void>;
  setCurrentPerkPage(id: number): Promise<void>;
  patchMySelection(patch: LcuMySelectionPatch): Promise<void>;
}

async function orNullOn404<T>(p: Promise<unknown>): Promise<T | null> {
  try {
    return ((await p) as T | undefined) ?? null;
  } catch (e) {
    if (e instanceof LcuHttpError && e.status === 404) return null;
    throw e;
  }
}

export function createLcuApi(send: LcuTransport): LcuApi {
  return {
    getChampSelectSession: () => orNullOn404(send('GET', CHAMP_SELECT_SESSION_PATH)),
    async getGameflowPhase() {
      const phase = await orNullOn404(send('GET', GAMEFLOW_PHASE_PATH));
      return typeof phase === 'string' ? phase : null;
    },
    getGameflowSession: () => orNullOn404(send('GET', GAMEFLOW_SESSION_PATH)),
    async getOwnedChampions() {
      const list = await send('GET', '/lol-champions/v1/owned-champions-minimal');
      return Array.isArray(list) ? (list as LcuOwnedChampion[]) : [];
    },
    async getMastery() {
      const res = await send('GET', '/lol-champion-mastery/v1/local-player/champion-mastery');
      if (Array.isArray(res)) return res as LcuChampionMastery[];
      // Some client versions wrap the list.
      const wrapped = (res as { masteries?: unknown } | null)?.masteries;
      return Array.isArray(wrapped) ? (wrapped as LcuChampionMastery[]) : [];
    },
    getCurrentSummoner: () => orNullOn404(send('GET', '/lol-summoner/v1/current-summoner')),
    async getPlatformHints() {
      const text = (v: PromiseSettledResult<unknown>, pick: (x: unknown) => unknown) => {
        const s = v.status === 'fulfilled' ? pick(v.value) : null;
        return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
      };
      const [platformId, regionLocale] = await Promise.allSettled([
        send('GET', PLATFORM_ID_PATH),
        send('GET', REGION_LOCALE_PATH),
      ]);
      return {
        platformId: text(platformId, (x) => x),
        region: text(regionLocale, (x) => (x as { region?: unknown } | null)?.region),
      };
    },
    async getPerkPages() {
      const pages = await send('GET', '/lol-perks/v1/pages');
      return Array.isArray(pages) ? (pages as LcuPerkPage[]) : [];
    },
    async getPerkInventory() {
      return (await send('GET', '/lol-perks/v1/inventory')) as LcuPerkInventory;
    },
    async createPerkPage(page) {
      return (await send('POST', '/lol-perks/v1/pages', page)) as LcuPerkPage;
    },
    async replacePerkPage(id, page) {
      await send('PUT', `/lol-perks/v1/pages/${id}`, { ...page, id });
    },
    async setCurrentPerkPage(id) {
      await send('PUT', '/lol-perks/v1/currentpage', id);
    },
    async patchMySelection(patch) {
      await send('PATCH', `${CHAMP_SELECT_SESSION_PATH}/my-selection`, patch);
    },
  };
}
