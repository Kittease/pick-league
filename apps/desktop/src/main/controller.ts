/**
 * Main-process orchestrator: League client events → derived champion select → API calls
 * (picks, build) → auto-apply on lock-in, then the same champion select kept on screen while
 * its game is played. Owns `AppState` and pushes every change to the UI.
 */

import {
  type BuildRequestInput,
  type BuildResponse,
  buildRequestSchema,
  type DraftEvaluationResponse,
  draftRequestSchema,
  type PicksRequestInput,
  type PicksResponse,
  type Position,
  picksRequestSchema,
  type StaticDataResponse,
  type TierListChampionResponse,
  type TierListFilters,
  type TierListResponse,
} from '@pick-league/shared';
import type { ApiResult, AppState, Loadable, Settings, StatsState } from '../core/app-state.ts';
import {
  availableChampionIds,
  buildBuildRequest,
  buildPicksRequest,
  deriveChampSelect,
  requestKey,
} from '../core/champ-select.ts';
import {
  isInGamePhase,
  type Lobby,
  type LobbyEvent,
  NO_LOBBY,
  nextLobby,
  sessionFromGameflow,
} from '../core/game-flow.ts';
import { type ApiClient, ApiClientError } from './api-client.ts';
import { type ApplyResult, applyBuild } from './apply.ts';
import type { LcuApi } from './lcu/api.ts';
import type { LcuConnectionStatus, LcuSource } from './lcu/source.ts';
import { sanitizeSettings } from './settings.ts';

const DEBOUNCE_MS = 250;
const HEALTH_INTERVAL_MS = 20_000;
/** Stats freshness poll: slow in the background, fast while a refresh runs. */
const STATS_IDLE_POLL_MS = 60_000;
const STATS_ACTIVE_POLL_MS = 2_000;
/** Champion select ended but the client did not say whether a game started: give up after. */
const LEAVING_TIMEOUT_MS = 3_000;
/** A failed auto-apply (e.g. the client briefly busy) is tried again, this many times in all. */
const AUTO_APPLY_ATTEMPTS = 3;
const AUTO_APPLY_RETRY_MS = 3_000;
export interface ControllerDeps {
  settings: Settings;
  createSource(): LcuSource;
  createApi(baseUrl: string): ApiClient;
  /** Static data straight from Data Dragon, used when the API is unreachable. */
  loadDdragonStatic(): Promise<StaticDataResponse>;
  saveSettings(settings: Settings): Promise<void>;
  log(message: string): void;
  /** Delay before a failed auto-apply is tried again (tests shorten it). */
  autoApplyRetryMs?: number;
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

async function toResult<T>(call: Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await call };
  } catch (e) {
    return { ok: false, ...errorInfo(e) };
  }
}

function badDraftRequest(what: 'picks' | 'build' | 'evaluation'): ApiResult<never> {
  return { ok: false, code: 'BAD_REQUEST', message: `Invalid draft ${what} request` };
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
  private lobby: Lobby = NO_LOBBY;
  private leavingTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;
  private available: number[] | null = null;
  private staticData: StaticDataResponse | null = null;
  private staticLoading: Promise<void> | null = null;
  /** Increments for every champion select (session appears). */
  private selectSeq = 0;
  /** `selectSeq` whose locked champion's build was applied (auto or by hand). */
  private autoAppliedSeq = -1;
  /** Auto-apply runs started in the current champion select. */
  private autoApplyAttempts = 0;
  private autoApplyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The apply in progress; only one at a time. */
  private applying: Promise<void> | null = null;
  private previewChampionId: number | null = null;
  private picksKey = '';
  private buildKey = '';
  private picksTimer: ReturnType<typeof setTimeout> | null = null;
  private buildTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ControllerDeps) {
    this.api = deps.createApi(deps.settings.apiUrl);
    this.state = {
      settings: deps.settings,
      lcu: { state: 'searching', account: null, message: null },
      api: {
        state: 'checking',
        url: this.api.baseUrl,
        latestPatch: null,
        matchCount: null,
        message: null,
      },
      stats: { status: null, refreshing: false },
      champSelect: null,
      inGame: false,
      mastery: {},
      availableCount: null,
      ownedChampionIds: null,
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
    void this.pollStats();
  }

  stop(): void {
    this.source?.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.statsTimer) clearTimeout(this.statsTimer);
    if (this.picksTimer) clearTimeout(this.picksTimer);
    if (this.buildTimer) clearTimeout(this.buildTimer);
    if (this.leavingTimer) clearTimeout(this.leavingTimer);
    this.cancelAutoApplyRetry();
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
      this.patch({ stats: { status: null, refreshing: false } });
      void this.pollStats();
      this.refetch();
    }
    if (next.fallbackRole !== prev.fallbackRole || next.ownedOnly !== prev.ownedOnly) {
      if (this.lobby.stage === 'select') this.showSelect(false);
    }
    this.emit();
    return this.state;
  }

  async applyNow(): Promise<AppState['apply']> {
    await this.runApply(false);
    return this.state.apply;
  }

  previewBuild(championId: number | null): void {
    if (this.state.inGame) return;
    this.previewChampionId = championId;
    this.scheduleBuild(true);
  }

  refresh(): void {
    void this.checkHealth();
    if (!this.staticData) void this.ensureStatic();
    this.refetch();
  }

  // ---------------------------------------------------------------------------
  // Tier list (one-off calls, not part of AppState)
  // ---------------------------------------------------------------------------

  tierList(role: Position, filters?: TierListFilters): Promise<ApiResult<TierListResponse>> {
    return toResult(this.api.tierList(role, filters));
  }

  tierListChampion(
    role: Position,
    championId: number,
    filters?: TierListFilters,
  ): Promise<ApiResult<TierListChampionResponse>> {
    return toResult(this.api.tierListChampion(role, championId, filters));
  }

  genericBuild(championId: number, role: Position): Promise<ApiResult<BuildResponse>> {
    return toResult(this.api.build({ championId, role, allies: [], enemies: [] }));
  }

  // ---------------------------------------------------------------------------
  // Draft planner (one-off calls with bodies built by the renderer: validated first)
  // ---------------------------------------------------------------------------

  async draftPicks(request: unknown): Promise<ApiResult<PicksResponse>> {
    const parsed = picksRequestSchema.safeParse(request);
    if (!parsed.success) return badDraftRequest('picks');
    return toResult(this.api.picks(parsed.data));
  }

  async draftBuild(request: unknown): Promise<ApiResult<BuildResponse>> {
    const parsed = buildRequestSchema.safeParse(request);
    if (!parsed.success) return badDraftRequest('build');
    return toResult(this.api.build(parsed.data));
  }

  /** Win probability and damage split of a draft (draft planner or champion select). */
  async evaluateDraft(request: unknown): Promise<ApiResult<DraftEvaluationResponse>> {
    const parsed = draftRequestSchema.safeParse(request);
    if (!parsed.success) return badDraftRequest('evaluation');
    return toResult(this.api.draft(parsed.data));
  }

  // ---------------------------------------------------------------------------
  // League client
  // ---------------------------------------------------------------------------

  private startSource(): void {
    if (this.source) return;
    const source = this.deps.createSource();
    this.source = source;
    source.start({
      onStatus: (status) => this.onLcuStatus(status),
      onSession: (session) => this.dispatch({ type: 'session', session }),
      onPhase: (phase) => this.dispatch({ type: 'phase', phase }),
    });
  }

  private onLcuStatus(status: LcuConnectionStatus): void {
    if (status.state === 'searching') {
      this.lcuApi = null;
      this.patch({ lcu: { state: 'searching', account: null, message: status.message } });
      return;
    }
    const wasConnected = this.lcuApi !== null;
    this.lcuApi = status.api;
    this.patch({ lcu: { ...this.state.lcu, state: 'connected', message: null } });
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
      this.patch({ availableCount: this.available.length, ownedChampionIds: this.available });
    }
    if (mastery.status === 'fulfilled') {
      const map: AppState['mastery'] = {};
      for (const m of mastery.value) {
        map[m.championId] = { level: m.championLevel, points: m.championPoints };
      }
      this.patch({ mastery: map });
    }
    if (this.lobby.stage === 'select') this.schedulePicks();
  }

  /** Applies a League client event to the lobby, then shows what it says. */
  private dispatch(event: LobbyEvent): void {
    const prev = this.lobby;
    const next = nextLobby(prev, event);
    this.lobby = next;
    if (next.stage !== 'leaving' && this.leavingTimer) {
      clearTimeout(this.leavingTimer);
      this.leavingTimer = null;
    } else if (next.stage === 'leaving' && !this.leavingTimer) {
      this.leavingTimer = setTimeout(() => {
        this.leavingTimer = null;
        this.dispatch({ type: 'timeout' });
      }, LEAVING_TIMEOUT_MS);
    }
    // A game is running but we did not see its champion select (app started in game).
    if (event.type === 'phase' && next.stage === 'none' && isInGamePhase(next.phase)) {
      void this.recoverGame();
    }

    if (next.stage === 'none') {
      if (prev.stage !== 'none') this.clearSelect();
    } else if (next.stage === 'select') {
      // `leaving` → `select`: the same champion select carries on.
      if (next.session !== prev.session) {
        this.showSelect(prev.stage === 'none' || prev.stage === 'game');
      }
    } else if (next.stage === 'game') {
      if (prev.stage !== 'game' || next.session !== prev.session) {
        this.showGame(prev.stage !== 'game');
      }
    }
    // `leaving`: the last champion select stays as it is until the next phase tells.
  }

  private showSelect(isNew: boolean): void {
    const session = this.lobby.session;
    if (!session) return;
    if (isNew) {
      this.selectSeq++;
      this.autoApplyAttempts = 0;
      this.cancelAutoApplyRetry();
      this.previewChampionId = null;
      this.patch({
        apply: { state: 'idle', messages: [], auto: false, championId: null, at: null },
      });
      // Owned champions / mastery may have changed since the last game.
      void this.loadAccount();
    }
    const view = deriveChampSelect(session, this.state.settings.fallbackRole);
    this.patch({ champSelect: view, inGame: false });
    this.schedulePicks();
    this.scheduleBuild();
  }

  /** Game started: keep its champion select and the locked champion's build, stop the picks. */
  private showGame(entering: boolean): void {
    const session = this.lobby.session;
    if (!session) return;
    if (entering) {
      if (this.picksTimer) clearTimeout(this.picksTimer);
      this.picksKey = '';
      this.previewChampionId = null;
      this.cancelAutoApplyRetry();
    }
    const view = deriveChampSelect(session, this.state.settings.fallbackRole);
    this.patch({ champSelect: view, inGame: true, picks: { status: 'idle' } });
    // Same request as the last build of champion select → nothing is fetched again.
    this.scheduleBuild();
  }

  private clearSelect(): void {
    this.picksKey = '';
    this.buildKey = '';
    this.previewChampionId = null;
    this.cancelAutoApplyRetry();
    this.patch({
      champSelect: null,
      inGame: false,
      picks: { status: 'idle' },
      build: { status: 'idle' },
      buildTarget: null,
    });
  }

  /** Teams of the game in progress, read from the client when its champion select was missed. */
  private async recoverGame(): Promise<void> {
    const api = this.lcuApi;
    if (!api || this.recovering) return;
    this.recovering = true;
    try {
      const [gameflow, me] = await Promise.all([
        api.getGameflowSession(),
        api.getCurrentSummoner(),
      ]);
      const session = gameflow && me ? sessionFromGameflow(gameflow, me) : null;
      if (session && api === this.lcuApi) {
        this.deps.log('game in progress: teams read from the League client');
        this.dispatch({ type: 'recovered', session });
      }
    } catch (e) {
      this.deps.log(`game in progress not read: ${errorInfo(e).message}`);
    } finally {
      this.recovering = false;
    }
  }

  // ---------------------------------------------------------------------------
  // API calls
  // ---------------------------------------------------------------------------

  private refetch(): void {
    if (this.state.inGame) {
      // The build stays as it was at the end of champion select; only a failed one is retried.
      if (this.state.build.status !== 'error') return;
      this.buildKey = '';
      this.scheduleBuild();
      return;
    }
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

  private scheduleStatsPoll(delayMs: number): void {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => void this.pollStats(), delayMs);
  }

  /** Reads /stats/status; re-fetches picks/build when the API finished a refresh. */
  private async pollStats(): Promise<void> {
    const api = this.api;
    const prev = this.state.stats;
    try {
      const status = await api.statsStatus();
      if (api !== this.api) return;
      const refreshed =
        prev.status !== null && status.lastRefreshedAt !== prev.status.lastRefreshedAt;
      this.patch({ stats: { status, refreshing: status.refreshing } });
      // New stats on the API (its response cache was cleared).
      if (refreshed) {
        this.deps.log(`stats refreshed on the API (${status.matchesIncluded} matches)`);
        this.refetch();
      }
      this.scheduleStatsPoll(status.refreshing ? STATS_ACTIVE_POLL_MS : STATS_IDLE_POLL_MS);
    } catch {
      if (api !== this.api) return;
      // API down or too old to serve /stats/status: keep the last known value, retry later.
      if (prev.refreshing) this.patchStats({ refreshing: false });
      this.scheduleStatsPoll(STATS_IDLE_POLL_MS);
    }
  }

  private patchStats(partial: Partial<StatsState>): void {
    this.patch({ stats: { ...this.state.stats, ...partial } });
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
    if (!view || this.state.inGame) return;
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
    const buildTarget = { championId: targetId, preview: lockedId === null };
    if (key === this.buildKey) {
      // Same request, e.g. the previewed champion just got locked in: the build (loaded or on
      // its way) is the right one, only its target changed.
      const shown = this.state.buildTarget;
      if (shown?.championId !== targetId || shown.preview !== buildTarget.preview) {
        this.patch({ buildTarget });
      }
      this.maybeAutoApply();
      return;
    }
    this.buildKey = key;
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

  /**
   * Once per champion select, as soon as the locked champion's build is known (never in game).
   * A failed run is tried again a few times while the user stays locked in.
   */
  private maybeAutoApply(): void {
    const view = this.state.champSelect;
    const build = this.state.build;
    if (!this.state.settings.autoApply || !view?.lockedIn || this.state.inGame) return;
    if (build.status !== 'ok' || build.data.championId !== view.lockedChampionId) return;
    if (this.autoAppliedSeq === this.selectSeq) return;
    // One apply at a time; a failed one waits for its retry, and not forever.
    if (this.applying || this.autoApplyRetryTimer) return;
    if (this.autoApplyAttempts >= AUTO_APPLY_ATTEMPTS) return;
    this.autoApplyAttempts++;
    void this.runApply(true);
  }

  private scheduleAutoApplyRetry(): void {
    this.cancelAutoApplyRetry();
    if (this.autoApplyAttempts >= AUTO_APPLY_ATTEMPTS) return;
    this.autoApplyRetryTimer = setTimeout(() => {
      this.autoApplyRetryTimer = null;
      this.maybeAutoApply();
    }, this.deps.autoApplyRetryMs ?? AUTO_APPLY_RETRY_MS);
  }

  private cancelAutoApplyRetry(): void {
    if (this.autoApplyRetryTimer) clearTimeout(this.autoApplyRetryTimer);
    this.autoApplyRetryTimer = null;
  }

  /** Single flight: a request made while an apply runs gets that apply's outcome. */
  private runApply(auto: boolean): Promise<void> {
    if (this.applying) return this.applying;
    const run = this.applyOnce(auto).finally(() => {
      this.applying = null;
      // An auto-apply skipped while this one ran (it may have been a preview's build).
      this.maybeAutoApply();
    });
    this.applying = run;
    return run;
  }

  private async applyOnce(auto: boolean): Promise<void> {
    const seq = this.selectSeq;
    const build = dataOf(this.state.build);
    const view = this.state.champSelect;
    const api = this.lcuApi;
    const championId = build?.championId ?? null;
    if (!api || !view || !build || this.state.inGame) {
      this.patch({
        apply: {
          state: 'error',
          messages: [
            !api
              ? 'League client not connected'
              : !view || this.state.inGame
                ? 'Not in champion select'
                : 'No build loaded yet',
          ],
          auto,
          championId,
          at: new Date().toISOString(),
        },
      });
      if (auto) this.scheduleAutoApplyRetry();
      return;
    }
    this.patch({ apply: { state: 'applying', messages: [], auto, championId, at: null } });
    const result = await applyBuild(api, build, view.mySpells, this.state.settings.flashKey).catch(
      (e): ApplyResult => ({ state: 'error', messages: [`Not applied: ${errorInfo(e).message}`] }),
    );
    this.deps.log(`apply (${auto ? 'auto' : 'manual'}): ${result.messages.join(' | ')}`);
    if (seq !== this.selectSeq) return; // a newer champion select started meanwhile
    this.patch({ apply: { ...result, auto, championId, at: new Date().toISOString() } });
    if (result.state !== 'error') {
      // The locked champion's build is in the client: nothing left to auto-apply.
      if (view.lockedIn && championId === view.lockedChampionId) this.autoAppliedSeq = seq;
    } else if (auto) {
      this.scheduleAutoApplyRetry();
    }
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
