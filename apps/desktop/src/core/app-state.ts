/**
 * State shared between the main process (owner) and the renderer (display), plus the typed
 * IPC bridge exposed by the preload script as `window.pickleague`.
 */

import type {
  BuildRequestInput,
  BuildResponse,
  PicksRequestInput,
  PicksResponse,
  Position,
  StaticDataResponse,
  StatsRefreshSkipReason,
  StatsStatusResponse,
  TierListChampionResponse,
  TierListFilters,
  TierListResponse,
} from '@pick-league/shared';
import type { ChampSelectView } from './champ-select.ts';
import type { LobbyView } from './live-lobby.ts';
import type { FlashKey } from './spells.ts';

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
  /** A refresh is running (reported by the API, or just requested from here). */
  refreshing: boolean;
  /** Outcome of the last refresh requested from this app, once it is over (toasted once per `at`). */
  lastManual: {
    at: string;
    result: 'done' | 'failed';
    /** Matches the refresh added to the stats. */
    added: number;
  } | null;
}

/** Immediate answer to the Refresh button. */
export type StatsRefreshOutcome =
  | { kind: 'started' }
  | { kind: 'skipped'; reason: StatsRefreshSkipReason; retryAfterSeconds?: number }
  | { kind: 'error'; message: string };

export type Loadable<T> =
  | { status: 'idle' }
  | { status: 'loading'; data: T | null }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string; code: string | null; data: T | null };

export interface ApplyStatus {
  state: 'idle' | 'applying' | 'done' | 'warning' | 'error';
  /** One line per step, e.g. "Runes → PickLeague page (replaced)". */
  messages: string[];
  auto: boolean;
  championId: number | null;
  at: string | null;
}

export interface MasteryEntry {
  level: number;
  points: number;
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
  /**
   * Rank, recent form and mastery of the players of the game in progress (only once it has
   * started, never in champion select). Players by champion and role: no names, no puuids.
   * Null outside a game.
   */
  lobby: LobbyView | null;
  /**
   * The API confirmed the user is playing (queue → end of game): the worker only looks the
   * players of the game up and the stats refresh waits for the end of the game.
   */
  collectionPaused: boolean;
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
  refreshStats: 'pickleague:refresh-stats',
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
} as const;

/** Window chrome drawn by the app itself (frameless window on Windows and Linux). */
export interface WindowState {
  /** No native title bar: the header is the drag region and shows minimize/maximize/close. */
  customControls: boolean;
  maximized: boolean;
}

/** Result of a one-off API call made for the renderer (errors are plain data over IPC). */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string | null; message: string };

/** `window.pickleague` in the renderer. */
export interface PickLeagueBridge {
  getState(): Promise<AppState>;
  getStatic(): Promise<StaticDataResponse | null>;
  updateSettings(patch: Partial<Settings>): Promise<AppState>;
  applyNow(): Promise<ApplyStatus>;
  /** Show the build of a candidate before locking in (null = back to the locked champion). */
  previewBuild(championId: number | null): Promise<void>;
  /** Re-run API calls (after fixing the API URL, for instance). */
  refresh(): Promise<void>;
  /** Asks the API to include every stored match in its stats now; progress arrives in `stats`. */
  refreshStats(): Promise<StatsRefreshOutcome>;
  /** Frameless window controls. */
  window: {
    getState(): Promise<WindowState>;
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    onState(listener: (state: WindowState) => void): () => void;
  };
  /** Tier list of a role (latest patch), filtered by server and rank (default: all, Master+). */
  getTierList(role: Position, filters?: TierListFilters): Promise<ApiResult<TierListResponse>>;
  /** Matchups, duos and synergies of a tier list champion (fetched when it is selected). */
  getTierListChampion(
    role: Position,
    championId: number,
    filters?: TierListFilters,
  ): Promise<ApiResult<TierListChampionResponse>>;
  /** Build of a champion in a role with no allies/enemies (tier list "View build"). */
  getGenericBuild(championId: number, role: Position): Promise<ApiResult<BuildResponse>>;
  /** Draft planner: pick recommendations for a simulated draft (no League client involved). */
  draftPicks(request: PicksRequestInput): Promise<ApiResult<PicksResponse>>;
  /** Draft planner: build of a drafted champion against the simulated teams. */
  draftBuild(request: BuildRequestInput): Promise<ApiResult<BuildResponse>>;
  onState(listener: (state: AppState) => void): () => void;
}
