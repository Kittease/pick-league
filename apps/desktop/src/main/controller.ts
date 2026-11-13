/**
 * Main-process orchestrator: League client events → derived champion select → API calls
 * (picks, build) → auto-apply on lock-in. Owns `AppState` and pushes every change to the UI.
 */

import type {
  BuildRequestInput,
  BuildResponse,
  PicksRequestInput,
  PicksResponse,
  StaticDataResponse,
} from '@pick-league/shared';
import type { AppState, Loadable, Settings } from '../core/app-state.ts';
import {
  availableChampionIds,
  buildBuildRequest,
  buildPicksRequest,
  deriveChampSelect,
  requestKey,
} from '../core/champ-select.ts';
import type { LcuChampSelectSession } from '../core/lcu-types.ts';
import { type ApiClient, ApiClientError } from './api-client.ts';
import { applyBuild } from './apply.ts';
import type { LcuApi } from './lcu/api.ts';
import type { LcuConnectionStatus, LcuSource } from './lcu/source.ts';
import { sanitizeSettings } from './settings.ts';

const DEBOUNCE_MS = 250;
const HEALTH_INTERVAL_MS = 20_000;

export interface ControllerDeps {
  settings: Settings;
  forcedMock: boolean;
  createSource(kind: 'real' | 'mock'): LcuSource;
  createApi(baseUrl: string): ApiClient;
  /** Static data straight from Data Dragon, used when the API is unreachable. */
  loadDdragonStatic(): Promise<StaticDataResponse>;
  saveSettings(settings: Settings): Promise<void>;
  log(message: string): void;
}

function errorInfo(e: unknown): { message: string; code: string | null } {
  if (e instanceof ApiClientError) {
    const message =
      e.code === 'NO_DATA'
        ? 'The API has no match data yet — let the worker crawl for a while.'
        : e.message;
    return { message, code: e.code };
  }
  return { message: e instanceof Error ? e.message : String(e), code: null };
}

function dataOf<T>(l: Loadable<T>): T | null {
  return l.status === 'idle' ? null : l.data;
}

export class Controller {
  private state: AppState;
  private listeners = new Set<(s: AppState) => void>();
  private source: LcuSource | null = null;
  private lcuApi: LcuApi | null = null;
  private api: ApiClient;
  private session: LcuChampSelectSession | null = null;
  private available: number[] | null = null;
  private staticData: StaticDataResponse | null = null;
  private staticLoading: Promise<void> | null = null;
  /** Increments for every champion select (session appears). */
  private selectSeq = 0;
  private autoAppliedSeq = -1;
  private previewChampionId: number | null = null;
  private picksKey = '';
  private buildKey = '';
  private picksTimer: ReturnType<typeof setTimeout> | null = null;
  private buildTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ControllerDeps) {
    this.api = deps.createApi(deps.settings.apiUrl);
    this.state = {
      settings: deps.settings,
      forced: { mockLcu: deps.forcedMock },
      lcu: { state: 'searching', mock: false, account: null, message: null },
      api: {
        state: 'checking',
        url: this.api.baseUrl,
        latestPatch: null,
        matchCount: null,
        message: null,
      },
      champSelect: null,
      mastery: {},
      availableCount: null,
      picks: { status: 'idle' },
      build: { status: 'idle' },
      buildTarget: null,
      apply: { state: 'idle', messages: [], auto: false, championId: null, at: null },
      staticVersion: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API (IPC)
  // ---------------------------------------------------------------------------

  start(): void {
    this.startSource();
    void this.checkHealth();
    this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    void this.ensureStatic();
  }

  stop(): void {
    this.source?.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.picksTimer) clearTimeout(this.picksTimer);
    if (this.buildTimer) clearTimeout(this.buildTimer);
  }

  getState(): AppState {
    return this.state;
  }

  onChange(listener: (s: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getStatic(): Promise<StaticDataResponse | null> {
    await this.ensureStatic();
    return this.staticData;
  }

  async updateSettings(patch: Partial<Settings>): Promise<AppState> {
    const prev = this.state.settings;
    const next = sanitizeSettings({ ...prev, ...patch });
    this.state = { ...this.state, settings: next };
    await this.deps.saveSettings(next).catch((e) => this.deps.log(`settings not saved: ${e}`));

    if (next.apiUrl !== prev.apiUrl) {
      this.api = this.deps.createApi(next.apiUrl);
      this.staticData = null;
      this.patch({
        api: { ...this.state.api, state: 'checking', url: this.api.baseUrl, message: null },
        staticVersion: null,
      });
      void this.checkHealth();
      void this.ensureStatic();
      this.refetch();
    }
    if (next.mockLcu !== prev.mockLcu && !this.state.forced.mockLcu) this.startSource();
    if (next.fallbackRole !== prev.fallbackRole || next.ownedOnly !== prev.ownedOnly) {
      this.onSession(this.session);
    }
    this.emit();
    return this.state;
  }

  async applyNow(): Promise<AppState['apply']> {
    await this.runApply(false);
    return this.state.apply;
  }

  previewBuild(championId: number | null): void {
    this.previewChampionId = championId;
    this.scheduleBuild(true);
  }

  refresh(): void {
    void this.checkHealth();
    if (!this.staticData) void this.ensureStatic();
    this.refetch();
  }

  // ---------------------------------------------------------------------------
  // League client
  // ---------------------------------------------------------------------------

  private startSource(): void {
    this.source?.stop();
    this.lcuApi = null;
    this.onSession(null);
    const kind = this.state.forced.mockLcu || this.state.settings.mockLcu ? 'mock' : 'real';
    this.patch({
      lcu: { state: 'searching', mock: kind === 'mock', account: null, message: null },
    });
    const source = this.deps.createSource(kind);
    this.source = source;
    source.start({
      onStatus: (status) => {
        if (this.source === source) this.onLcuStatus(status, kind === 'mock');
      },
      onSession: (session) => {
        if (this.source === source) this.onSession(session);
      },
    });
  }

  private onLcuStatus(status: LcuConnectionStatus, mock: boolean): void {
    if (status.state === 'searching') {
      this.lcuApi = null;
      this.patch({ lcu: { state: 'searching', mock, account: null, message: status.message } });
      return;
    }
    const wasConnected = this.lcuApi !== null;
    this.lcuApi = status.api;
    this.patch({ lcu: { ...this.state.lcu, state: 'connected', mock, message: null } });
    if (!wasConnected) void this.loadAccount();
  }

  private async loadAccount(): Promise<void> {
    const api = this.lcuApi;
    if (!api) return;
    const [summoner, owned, mastery] = await Promise.allSettled([
      api.getCurrentSummoner(),
      api.getOwnedChampions(),
      api.getMastery(),
    ]);
    if (api !== this.lcuApi) return;
    if (summoner.status === 'fulfilled' && summoner.value) {
      const s = summoner.value;
      const account = s.gameName ? `${s.gameName}#${s.tagLine ?? ''}` : (s.displayName ?? null);
      this.patch({ lcu: { ...this.state.lcu, account } });
    }
    if (owned.status === 'fulfilled') {
      this.available = availableChampionIds(owned.value);
      this.patch({ availableCount: this.available.length });
    }
    if (mastery.status === 'fulfilled') {
      const map: AppState['mastery'] = {};
      for (const m of mastery.value) {
        map[m.championId] = { level: m.championLevel, points: m.championPoints };
      }
      this.patch({ mastery: map });
    }
    if (this.session) this.schedulePicks();
  }

  private onSession(session: LcuChampSelectSession | null): void {
    const wasInSelect = this.session !== null;
    this.session = session;
    if (!session) {
      if (wasInSelect || this.state.champSelect) {
        this.picksKey = '';
        this.buildKey = '';
        this.previewChampionId = null;
        this.patch({
          champSelect: null,
          picks: { status: 'idle' },
          build: { status: 'idle' },
          buildTarget: null,
        });
      }
      return;
    }
    if (!wasInSelect) {
      this.selectSeq++;
      this.previewChampionId = null;
      this.patch({
        apply: { state: 'idle', messages: [], auto: false, championId: null, at: null },
      });
      // Owned champions / mastery may have changed since the last game.
      void this.loadAccount();
    }
    const view = deriveChampSelect(session, this.state.settings.fallbackRole);
    this.patch({ champSelect: view });
    this.schedulePicks();
    this.scheduleBuild();
  }

  // ---------------------------------------------------------------------------
  // API calls
  // ---------------------------------------------------------------------------

  private refetch(): void {
    this.picksKey = '';
    this.buildKey = '';
    this.schedulePicks();
    this.scheduleBuild();
  }

  private async checkHealth(): Promise<void> {
    const api = this.api;
    try {
      const h = await api.health();
      if (api !== this.api) return;
      const hasData = h.ok && h.latestPatch !== null && h.matchCount > 0;
      this.patch({
        api: {
          state: hasData ? 'ok' : h.ok ? 'no_data' : 'down',
          url: api.baseUrl,
          latestPatch: h.latestPatch,
          matchCount: h.matchCount,
          message: hasData
            ? null
            : h.ok
              ? 'No match data yet'
              : h.db
                ? 'API not ready'
                : 'API cannot reach its database',
        },
      });
      if (this.state.picks.status === 'error') this.refetch();
    } catch (e) {
      if (api !== this.api) return;
      this.patch({
        api: {
          state: 'down',
          url: api.baseUrl,
          latestPatch: null,
          matchCount: null,
          message: errorInfo(e).message,
        },
      });
    }
  }

  private ensureStatic(): Promise<void> {
    if (this.staticData) return Promise.resolve();
    if (this.staticLoading) return this.staticLoading;
    const api = this.api;
    this.staticLoading = (async () => {
      let data: StaticDataResponse | null = null;
      try {
        data = await api.staticData('latest');
      } catch (e) {
        this.deps.log(`static data from API failed (${errorInfo(e).message}), using Data Dragon`);
        try {
          data = await this.deps.loadDdragonStatic();
        } catch (e2) {
          this.deps.log(`Data Dragon static data failed: ${errorInfo(e2).message}`);
        }
      }
      if (data && api === this.api) {
        this.staticData = data;
        this.patch({ staticVersion: data.ddragonVersion });
      }
    })().finally(() => {
      this.staticLoading = null;
    });
    return this.staticLoading;
  }

  private schedulePicks(): void {
    if (this.picksTimer) clearTimeout(this.picksTimer);
    this.picksTimer = setTimeout(() => void this.fetchPicks(), DEBOUNCE_MS);
  }

  private async fetchPicks(): Promise<void> {
    const view = this.state.champSelect;
    if (!view) return;
    const request: PicksRequestInput = buildPicksRequest(
      view,
      this.state.settings.ownedOnly ? this.available : null,
    );
    const key = requestKey(request);
    if (key === this.picksKey) return;
    this.picksKey = key;
    const previous = dataOf(this.state.picks);
    this.patch({ picks: { status: 'loading', data: previous } });
    try {
      const data: PicksResponse = await this.api.picks(request);
      if (key !== this.picksKey) return;
      this.patch({ picks: { status: 'ok', data } });
    } catch (e) {
      if (key !== this.picksKey) return;
      this.picksKey = ''; // retry on the next change / refresh
      this.patch({ picks: { status: 'error', ...errorInfo(e), data: previous } });
    }
  }

  private scheduleBuild(immediate = false): void {
    if (this.buildTimer) clearTimeout(this.buildTimer);
    this.buildTimer = setTimeout(() => void this.fetchBuild(), immediate ? 0 : DEBOUNCE_MS);
  }

  private async fetchBuild(): Promise<void> {
    const view = this.state.champSelect;
    const lockedId = view?.lockedChampionId ?? null;
    const targetId = lockedId ?? this.previewChampionId;
    const request: BuildRequestInput | null = view ? buildBuildRequest(view, targetId) : null;
    if (!request || targetId === null) {
      this.buildKey = '';
      if (this.state.buildTarget) this.patch({ build: { status: 'idle' }, buildTarget: null });
      return;
    }
    const key = requestKey(request);
    if (key === this.buildKey) return;
    this.buildKey = key;
    const buildTarget = { championId: targetId, preview: lockedId === null };
    const previous = dataOf(this.state.build);
    const keep = previous?.championId === targetId ? previous : null;
    this.patch({ build: { status: 'loading', data: keep }, buildTarget });
    try {
      const data: BuildResponse = await this.api.build(request);
      if (key !== this.buildKey) return;
      this.patch({ build: { status: 'ok', data } });
      this.maybeAutoApply();
    } catch (e) {
      if (key !== this.buildKey) return;
      this.buildKey = '';
      this.patch({ build: { status: 'error', ...errorInfo(e), data: keep } });
    }
  }

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  /** Once per champion select, as soon as the locked champion's build is known. */
  private maybeAutoApply(): void {
    const view = this.state.champSelect;
    const build = this.state.build;
    if (!this.state.settings.autoApply || !view?.lockedIn) return;
    if (build.status !== 'ok' || build.data.championId !== view.lockedChampionId) return;
    if (this.autoAppliedSeq === this.selectSeq) return;
    this.autoAppliedSeq = this.selectSeq;
    void this.runApply(true);
  }

  private async runApply(auto: boolean): Promise<void> {
    const build = dataOf(this.state.build);
    const view = this.state.champSelect;
    const api = this.lcuApi;
    const championId = build?.championId ?? null;
    if (!api || !view || !build) {
      this.patch({
        apply: {
          state: 'error',
          messages: [
            !api
              ? 'League client not connected'
              : !view
                ? 'Not in champion select'
                : 'No build loaded yet',
          ],
          auto,
          championId,
          at: new Date().toISOString(),
        },
      });
      return;
    }
    this.patch({ apply: { state: 'applying', messages: [], auto, championId, at: null } });
    const result = await applyBuild(api, build, view.mySpells);
    this.deps.log(`apply (${auto ? 'auto' : 'manual'}): ${result.messages.join(' | ')}`);
    this.patch({ apply: { ...result, auto, championId, at: new Date().toISOString() } });
  }

  // ---------------------------------------------------------------------------

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}
