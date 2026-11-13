/**
 * Data Dragon client + normalisation into the static table shapes (see static-data.ts).
 * https://developer.riotgames.com/docs/lol#data-dragon
 */

import { type PatchId, patchFromDdragonVersion } from './patch.ts';
import type {
  StaticChampion,
  StaticChampionSpell,
  StaticItem,
  StaticPatchData,
  StaticRune,
  StaticRuneTree,
  StaticSummonerSpell,
} from './static-data.ts';

export const DDRAGON_BASE_URL = 'https://ddragon.leagueoflegends.com';
export const DDRAGON_DEFAULT_LOCALE = 'en_US';
/** Summoner's Rift map id in Data Dragon `maps` objects. */
export const SUMMONERS_RIFT_MAP_ID = '11';

// ---------------------------------------------------------------------------
// Raw Data Dragon shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface DdragonImage {
  full: string;
}

export interface DdragonChampionSpell {
  id: string;
  name: string;
  image: DdragonImage;
}

export interface DdragonChampion {
  /** Slug, e.g. 'MonkeyKing'. */
  id: string;
  /** Numeric id as a string, e.g. '62'. */
  key: string;
  name: string;
  tags: string[];
  info: { attack: number; defense: number; magic: number; difficulty: number };
  stats: { attackrange: number; [key: string]: number };
  image: DdragonImage;
  /** Only in championFull.json / champion/{slug}.json. */
  spells?: DdragonChampionSpell[];
}

/** championFull.json, champion.json and champion/{slug}.json share this envelope. */
export interface DdragonChampionFile {
  version: string;
  data: Record<string, DdragonChampion>;
}

export interface DdragonItem {
  name: string;
  gold: { base: number; total: number; sell: number; purchasable: boolean };
  tags: string[];
  from?: string[];
  into?: string[];
  stats: Record<string, number>;
  consumed?: boolean;
  depth?: number;
  inStore?: boolean;
  requiredChampion?: string;
  requiredAlly?: string;
  maps: Record<string, boolean>;
}

export interface DdragonItemFile {
  version: string;
  data: Record<string, DdragonItem>;
}

export interface DdragonRune {
  id: number;
  key: string;
  icon: string;
  name: string;
}

export interface DdragonRuneTree {
  id: number;
  key: string;
  icon: string;
  name: string;
  slots: { runes: DdragonRune[] }[];
}

export type DdragonRunesFile = DdragonRuneTree[];

export interface DdragonSummonerSpell {
  /** 'SummonerFlash' */
  id: string;
  /** Numeric id as a string, e.g. '4'. */
  key: string;
  name: string;
  modes: string[];
  image: DdragonImage;
}

export interface DdragonSummonerFile {
  version: string;
  data: Record<string, DdragonSummonerSpell>;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface PatchVersion {
  patch: PatchId;
  ddragonVersion: string;
}

/**
 * From `api/versions.json` (newest first), returns the `count` newest distinct patches with
 * the newest Data Dragon version of each. Non-patch entries (e.g. 'lolpatch_7.20') are ignored.
 */
export function latestPatchVersions(versions: readonly string[], count = 2): PatchVersion[] {
  const out: PatchVersion[] = [];
  for (const v of versions) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) continue;
    const patch = patchFromDdragonVersion(v);
    if (out.some((p) => p.patch === patch)) continue;
    out.push({ patch, ddragonVersion: v });
    if (out.length >= count) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * championFull.json (or a merge of champion/{slug}.json files) → StaticChampion[] sorted by id.
 * Champions without `spells` (plain champion.json) get an empty `spells` array.
 */
export function normaliseChampions(file: DdragonChampionFile): StaticChampion[] {
  return Object.values(file.data)
    .map((c): StaticChampion => {
      const spells: StaticChampionSpell[] = (c.spells ?? []).slice(0, 4).map((s, i) => ({
        slot: i + 1,
        name: s.name,
        image: s.image.full,
      }));
      return {
        id: Number(c.key),
        slug: c.id,
        name: c.name,
        tags: [...c.tags],
        attackRange: Math.round(c.stats.attackrange),
        info: {
          attack: c.info.attack,
          defense: c.info.defense,
          magic: c.info.magic,
          difficulty: c.info.difficulty,
        },
        spells,
      };
    })
    .sort((a, b) => a.id - b.id);
}

/** Items that are consumables per Data Dragon. */
function isConsumableItem(item: DdragonItem): boolean {
  return item.consumed === true || item.tags.includes('Consumable');
}

/**
 * item.json → StaticItem[] (Summoner's Rift items only, sorted by id).
 *
 * `isCompleted` heuristic: not a consumable/trinket and either
 * - finished boots (Boots tag, depth ≥ 2), or
 * - an item that builds into nothing and costs ≥ 1000 gold (legendaries).
 * `buildsInto` is restricted to ids that exist in the filtered set.
 */
export function normaliseItems(file: DdragonItemFile): StaticItem[] {
  const entries = Object.entries(file.data).filter(
    ([, item]) => item.maps[SUMMONERS_RIFT_MAP_ID] === true,
  );
  const ids = new Set(entries.map(([id]) => Number(id)));
  return entries
    .map(([id, item]): StaticItem => {
      const buildsFrom = (item.from ?? []).map(Number).filter((n) => ids.has(n));
      const buildsInto = (item.into ?? []).map(Number).filter((n) => ids.has(n));
      const isBoots = item.tags.includes('Boots');
      const isConsumable = isConsumableItem(item);
      const isTrinket = item.tags.includes('Trinket');
      const isCompleted =
        !isConsumable &&
        !isTrinket &&
        ((isBoots && (item.depth ?? 1) >= 2) ||
          (buildsInto.length === 0 && item.gold.total >= 1000));
      return {
        id: Number(id),
        name: item.name,
        goldTotal: item.gold.total,
        tags: [...item.tags],
        buildsFrom,
        buildsInto,
        isBoots,
        isCompleted,
        isConsumable,
        stats: { ...item.stats },
      };
    })
    .sort((a, b) => a.id - b.id);
}

/** runesReforged.json → trees + runes (row 0 = keystones). */
export function normaliseRunes(file: DdragonRunesFile): {
  runeTrees: StaticRuneTree[];
  runes: StaticRune[];
} {
  const runeTrees: StaticRuneTree[] = [];
  const runes: StaticRune[] = [];
  for (const tree of file) {
    runeTrees.push({ id: tree.id, name: tree.name, icon: tree.icon });
    tree.slots.forEach((slot, row) => {
      for (const r of slot.runes) {
        runes.push({ id: r.id, treeId: tree.id, row, name: r.name, icon: r.icon });
      }
    });
  }
  runeTrees.sort((a, b) => a.id - b.id);
  runes.sort((a, b) => a.id - b.id);
  return { runeTrees, runes };
}

/** summoner.json → StaticSummonerSpell[] (all modes, sorted by id). */
export function normaliseSummonerSpells(file: DdragonSummonerFile): StaticSummonerSpell[] {
  return Object.values(file.data)
    .map((s) => ({ id: Number(s.key), name: s.name, image: s.image.full }))
    .sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// CDN URLs
// ---------------------------------------------------------------------------

/** Square champion icon: `.../cdn/15.22.1/img/champion/MonkeyKing.png` */
export function ddragonChampionIconUrl(version: string, slug: string): string {
  return `${DDRAGON_BASE_URL}/cdn/${version}/img/champion/${slug}.png`;
}

/** Champion splash art (unversioned). */
export function ddragonChampionSplashUrl(slug: string, skin = 0): string {
  return `${DDRAGON_BASE_URL}/cdn/img/champion/splash/${slug}_${skin}.jpg`;
}

/** Champion loading-screen art (unversioned). */
export function ddragonChampionLoadingUrl(slug: string, skin = 0): string {
  return `${DDRAGON_BASE_URL}/cdn/img/champion/loading/${slug}_${skin}.jpg`;
}

/** Champion ability or summoner spell icon from its image file name ('AatroxQ.png', 'SummonerFlash.png'). */
export function ddragonSpellImageUrl(version: string, image: string): string {
  return `${DDRAGON_BASE_URL}/cdn/${version}/img/spell/${image}`;
}

export function ddragonItemIconUrl(version: string, itemId: number): string {
  return `${DDRAGON_BASE_URL}/cdn/${version}/img/item/${itemId}.png`;
}

/** Rune, rune tree or stat shard icon from its `icon` path (unversioned). */
export function ddragonRuneIconUrl(icon: string): string {
  return `${DDRAGON_BASE_URL}/cdn/img/${icon}`;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export interface DdragonClientOptions {
  /** Defaults to global fetch; inject a fake in tests. */
  fetch?: (url: string) => Promise<Response>;
  baseUrl?: string;
  locale?: string;
}

export interface DdragonClient {
  /** `api/versions.json`, newest first. */
  getVersions(): Promise<string[]>;
  /** Newest patches (default 2) with their Data Dragon version. */
  getLatestPatchVersions(count?: number): Promise<PatchVersion[]>;
  getChampionFull(version: string): Promise<DdragonChampionFile>;
  getItems(version: string): Promise<DdragonItemFile>;
  getRunes(version: string): Promise<DdragonRunesFile>;
  getSummonerSpells(version: string): Promise<DdragonSummonerFile>;
  /** Fetches and normalises everything for one Data Dragon version (4 requests). */
  getStaticPatchData(version: string): Promise<StaticPatchData>;
}

export class DdragonHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Data Dragon request failed: ${status} ${url}`);
    this.name = 'DdragonHttpError';
  }
}

export function createDdragonClient(options: DdragonClientOptions = {}): DdragonClient {
  const doFetch = options.fetch ?? ((url: string) => fetch(url));
  const base = options.baseUrl ?? DDRAGON_BASE_URL;
  const locale = options.locale ?? DDRAGON_DEFAULT_LOCALE;

  async function getJson<T>(path: string): Promise<T> {
    const url = `${base}${path}`;
    const res = await doFetch(url);
    if (!res.ok) throw new DdragonHttpError(url, res.status);
    return (await res.json()) as T;
  }

  const client: DdragonClient = {
    getVersions: () => getJson<string[]>('/api/versions.json'),
    async getLatestPatchVersions(count = 2) {
      return latestPatchVersions(await client.getVersions(), count);
    },
    getChampionFull: (v) => getJson(`/cdn/${v}/data/${locale}/championFull.json`),
    getItems: (v) => getJson(`/cdn/${v}/data/${locale}/item.json`),
    getRunes: (v) => getJson(`/cdn/${v}/data/${locale}/runesReforged.json`),
    getSummonerSpells: (v) => getJson(`/cdn/${v}/data/${locale}/summoner.json`),
    async getStaticPatchData(version) {
      const [champions, items, runes, spells] = await Promise.all([
        client.getChampionFull(version),
        client.getItems(version),
        client.getRunes(version),
        client.getSummonerSpells(version),
      ]);
      return {
        patch: patchFromDdragonVersion(version),
        ddragonVersion: version,
        champions: normaliseChampions(champions),
        items: normaliseItems(items),
        ...normaliseRunes(runes),
        summonerSpells: normaliseSummonerSpells(spells),
      };
    },
  };
  return client;
}
