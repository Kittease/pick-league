/**
 * State shared between the main process (owner) and the renderer (display), plus the typed
 * IPC bridge exposed by the preload script as `window.pickleague`.
 */

import type {
  BuildResponse,
  PicksResponse,
  Position,
  StaticDataResponse,
} from '@pick-league/shared';
import type { ChampSelectView } from './champ-select.ts';

export interface Settings {
  /** PickLeague API base URL, e.g. http://localhost:3000 or http://<vps-ip>:3000. */
  apiUrl: string;
  /** Apply runes + summoner spells automatically when the user locks in. */
  autoApply: boolean;
  /** Use the scripted fake League client instead of the real one. */
  mockLcu: boolean;
  /** Role used when champion select has no assigned position (blind pick, customs). */
  fallbackRole: Position;
  /** Only recommend champions the account can play. */
  ownedOnly: boolean;
}

export interface LcuStatus {
  state: 'searching' | 'connected';
  mock: boolean;
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
  /** Settings forced by the environment (PICKLEAGUE_MOCK_LCU=1). */
  forced: { mockLcu: boolean };
  lcu: LcuStatus;
  api: ApiStatus;
  champSelect: ChampSelectView | null;
  /** championId → the user's mastery. */
  mastery: Record<number, MasteryEntry>;
  /** Number of champions the account can play; null when unknown. */
  availableCount: number | null;
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
} as const;

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
  onState(listener: (state: AppState) => void): () => void;
}
