/**
 * State shared between the main process (owner) and the renderer (display), plus the typed
 * IPC bridge exposed by the preload script as `window.pickleague`.
 */

import type {
  BuildResponse,
  PicksResponse,
  Position,
  StaticDataResponse,
  StatsStatusResponse,
} from '@pick-league/shared';
import type { PickLeagueData } from '@pick-league/ui/lib/data';
import type { ApiResult, Loadable, MasteryEntry } from '@pick-league/ui/lib/types';
import type { ChampSelectView } from './champ-select.ts';
import type { FlashKey } from './spells.ts';

export type { ApiResult, Loadable, MasteryEntry };

export interface Settings {
  /** PickLeague API base URL, e.g. http://localhost:3000 or http://<vps-ip>:3000. */
  apiUrl: string;
  /** Apply runes + summoner spells automatically when the user locks in. */
  autoApply: boolean;
  /** Role used when champion select has no assigned position (blind pick, customs). */
  fallbackRole: Position;
  /** Only recommend champions the account can play. */
  ownedOnly: boolean;
  /** Zoom factor of the whole UI (1 = 100%), one of ZOOM_LEVELS. */
  zoom: number;
  /** Key Flash goes on when summoner spells are applied. */
  flashKey: FlashKey;
}

export interface LcuStatus {
  state: 'searching' | 'connected';
  /** The user's own Riot ID (never other players'). */
  account: string | null;
  message: string | null;
}

export interface ApiStatus {
  state: 'checking' | 'ok' | 'no_data' | 'down';
  url: string;
  latestPatch: string | null;
  matchCount: number | null;
  message: string | null;
}

/** Freshness of the API's stats views (GET /stats/status), polled by the main process. */
export interface StatsState {
  /** null until the first answer (or when the API does not serve /stats/status). */
  status: StatsStatusResponse | null;
  /** A refresh of the stats views is running on the API (it refreshes them on a timer). */
  refreshing: boolean;
}

export interface ApplyStatus {
  state: 'idle' | 'applying' | 'done' | 'warning' | 'error';
  /** One line per step, e.g. "Runes → PickLeague page (replaced)". */
  messages: string[];
  auto: boolean;
  championId: number | null;
  at: string | null;
}

export interface AppState {
  settings: Settings;
  lcu: LcuStatus;
  api: ApiStatus;
  stats: StatsState;
  champSelect: ChampSelectView | null;
  /**
   * The game started: `champSelect` is the champion select it came from, kept with its build
   * until the game ends. Nothing is fetched (picks) nor applied anymore.
   */
  inGame: boolean;
  /** championId → the user's mastery. */
  mastery: Record<number, MasteryEntry>;
  /** Number of champions the account can play; null when unknown. */
  availableCount: number | null;
  /** Champions the account can play (owned, rented, free rotation); null when unknown. */
  ownedChampionIds: number[] | null;
  picks: Loadable<PicksResponse>;
  build: Loadable<BuildResponse>;
  /** Champion whose build is shown; `preview` = chosen in the list, not locked in. */
  buildTarget: { championId: number; preview: boolean } | null;
  apply: ApplyStatus;
  /** Data Dragon version of the cached static data; changes → renderer re-fetches it. */
  staticVersion: string | null;
}

export const IPC = {
  state: 'pickleague:state',
  getState: 'pickleague:get-state',
  getStatic: 'pickleague:get-static',
  updateSettings: 'pickleague:update-settings',
  applyNow: 'pickleague:apply-now',
  previewBuild: 'pickleague:preview-build',
  refresh: 'pickleague:refresh',
  getWindowState: 'window:get-state',
  windowState: 'window:state',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  tierList: 'pickleague:tier-list',
  tierListChampion: 'pickleague:tier-list-champion',
  genericBuild: 'pickleague:generic-build',
  draftPicks: 'pickleague:draft-picks',
  draftBuild: 'pickleague:draft-build',
  evaluateDraft: 'pickleague:evaluate-draft',
} as const;

/** Window chrome drawn by the app itself (frameless window on Windows and Linux). */
export interface WindowState {
  /** No native title bar: the header is the drag region and shows minimize/maximize/close. */
  customControls: boolean;
  maximized: boolean;
}

/** `window.pickleague` in the renderer: the shared views' API calls (`PickLeagueData`) and more. */
export interface PickLeagueBridge extends PickLeagueData {
  getState(): Promise<AppState>;
  getStatic(): Promise<StaticDataResponse | null>;
  updateSettings(patch: Partial<Settings>): Promise<AppState>;
  applyNow(): Promise<ApplyStatus>;
  /** Show the build of a candidate before locking in (null = back to the locked champion). */
  previewBuild(championId: number | null): Promise<void>;
  /** Re-run API calls (after fixing the API URL, for instance). */
  refresh(): Promise<void>;
  /** Frameless window controls. */
  window: {
    getState(): Promise<WindowState>;
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    onState(listener: (state: WindowState) => void): () => void;
  };
  onState(listener: (state: AppState) => void): () => void;
}
