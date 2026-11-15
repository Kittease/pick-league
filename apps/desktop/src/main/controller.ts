/**
 * Main-process orchestrator: League client events → derived champion select → API calls
 * (picks, build) → auto-apply on lock-in, then the same champion select kept on screen while
 * its game is played. Owns `AppState` and pushes every change to the UI.
 */

import {
  type BuildRequestInput,
  type BuildResponse,
  buildRequestSchema,
  CLIENT_ACTIVITY_RENEW_MS,
  isPlayingPhase,
  type LiveGameState,
  type LivePlayersResponse,
  type LiveWorkerState,
  type PicksRequestInput,
  type PicksResponse,
  PLATFORMS,
  type Platform,
  type Position,
  picksRequestSchema,
  type StaticDataResponse,
  type TierListChampionResponse,
  type TierListFilters,
  type TierListResponse,
} from '@pick-league/shared';
import type {
  ApiResult,
  AppState,
  Loadable,
  Settings,
  StatsRefreshOutcome,
  StatsState,
} from '../core/app-state.ts';
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
import {
  canLookUpLobby,
  type LiveLobbyRequest,
  type LobbyState,
  lobbyRequestFromGameflow,
  lobbyView,
  platformFromLcu,
} from '../core/live-lobby.ts';
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
/** Lobby lookup: the API is asked again this often until every player is in… */
const LOBBY_POLL_MS = 3_000;
/** …for at most this long (the worker is slow or down). */
const LOBBY_MAX_MS = 5 * 60_000;

const GAME_MESSAGE: Record<LiveGameState, string | null> = {
  finding: null,
  found: null,
  not_found:
    "Riot's spectator API does not show this match, so its players cannot be looked up (custom matches and some queues are not shown).",
  failed: 'Riot kept failing to find this match: asked again in a minute.',
  unsupported: null,
};

const WORKER_MESSAGE: Record<LiveWorkerState, string | null> = {
  ok: null,
  stalled: 'The PickLeague worker is not running: the players are looked up once it is back.',
  key_rejected: 'Riot rejects the API key of the worker: the players cannot be looked up.',
  unsupported: 'The PickLeague worker does not collect your server (see PLATFORMS in its .env).',
};

/** Lookup of the game in progress (players by team, champion and role: no player id). */
interface LobbyLookup {
  request: LiveLobbyRequest;
  platform: Platform;
  startedAt: number;
  response: LivePlayersResponse | null;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** Every player is in, or there is no point asking again. */
  finished: boolean;
}

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
  /** Lobby lookup poll period and limit (tests shorten them). */
  lobbyPollMs?: number;
  lobbyMaxMs?: number;
  /** How often a pause is renewed while the user plays (tests shorten it). */
  activityRenewMs?: number;
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

function badDraftRequest(what: 'picks' | 'build'): ApiResult<never> {
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
  /** A refresh requested from this app is in progress (→ `stats.lastManual` when it ends). */
  private manualRefresh: { includedBefore: number } | null = null;
  /** Lookup of the players of the game in progress (one per game). */
  private lobbyLookup: LobbyLookup | null = null;
  private lobbyStarting = false;
  /** Phase last sent to `PUT /client/activity` (null = nothing sent to this API yet). */
  private activityPhase: string | null = null;
  /** Renews the pause while the user plays. */
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private activityError: string | null = null;

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
      stats: { status: null, refreshing: false, lastManual: null },
      champSelect: null,
      inGame: false,
      lobby: null,
      collectionPaused: false,
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
    this.stopLobbyLookup();
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
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
      this.activityPhase = null;
      this.syncActivity();
      this.manualRefresh = null;
      this.patch({ stats: { status: null, refreshing: false, lastManual: null } });
      void this.pollStats();
      this.refetch();
      this.restartLobbyPolling();
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
    const lobby = this.state.lobby?.state;
    if (lobby === 'error' || lobby === 'timeout') this.restartLobbyPolling();
  }

  /** Asks the API to include every stored match in its stats, then follows the refresh. */
  async refreshStats(): Promise<StatsRefreshOutcome> {
    const api = this.api;
    const before = this.state.stats.status;
    try {
      const res = await api.statsRefresh();
      if (api !== this.api) return { kind: 'error', message: 'API address changed' };
      if (res.started || res.reason === 'already_running') {
        this.manualRefresh ??= { includedBefore: before?.matchesIncluded ?? 0 };
        this.patchStats({ refreshing: true });
        this.scheduleStatsPoll(STATS_ACTIVE_POLL_MS);
        return res.started ? { kind: 'started' } : { kind: 'skipped', reason: 'already_running' };
      }
      void this.pollStats();
      return {
        kind: 'skipped',
        reason: res.reason,
        ...(res.retryAfterSeconds ? { retryAfterSeconds: res.retryAfterSeconds } : {}),
      };
    } catch (e) {
      return { kind: 'error', message: errorInfo(e).message };
    }
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
      this.syncActivity();
      return;
    }
    const wasConnected = this.lcuApi !== null;
    this.lcuApi = status.api;
    this.patch({ lcu: { ...this.state.lcu, state: 'connected', message: null } });
    if (!wasConnected) void this.loadAccount();
    this.syncLobbyLookup();
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
    this.syncLobbyLookup();
    this.syncActivity();
  }

  // ---------------------------------------------------------------------------
  // Client activity (collection paused while the user plays)
  // ---------------------------------------------------------------------------

  /** The League client phase as the API should know it ('None' without a client). */
  private currentPhase(): string {
    return (this.lcuApi && this.lobby.phase) || 'None';
  }

  /**
   * Tells the API each phase change; while the user plays (queue → end of game) the call is
   * renewed every `CLIENT_ACTIVITY_RENEW_MS`, so the pause ends by itself if the app goes away.
   */
  private syncActivity(): void {
    const phase = this.currentPhase();
    if (phase !== this.activityPhase) void this.sendActivity(phase);
    const playing = isPlayingPhase(phase);
    if (playing && !this.activityTimer) {
      this.activityTimer = setInterval(
        () => void this.sendActivity(this.currentPhase()),
        this.deps.activityRenewMs ?? CLIENT_ACTIVITY_RENEW_MS,
      );
    } else if (!playing && this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private async sendActivity(phase: string): Promise<void> {
    const api = this.api;
    this.activityPhase = phase;
    try {
      const res = await api.clientActivity({ phase });
      if (api !== this.api) return;
      this.activityError = null;
      if (res.paused !== this.state.collectionPaused) this.patch({ collectionPaused: res.paused });
    } catch (e) {
      if (api !== this.api) return;
      // Sent again on the next renewal / phase change.
      if (this.activityPhase === phase) this.activityPhase = null;
      const message = errorInfo(e).message;
      if (message !== this.activityError) this.deps.log(`client activity not sent: ${message}`);
      this.activityError = message;
      if (this.state.collectionPaused) this.patch({ collectionPaused: false });
    }
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
    this.stopLobbyLookup();
    this.patch({
      champSelect: null,
      inGame: false,
      lobby: null,
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
  // Lobby lookup (players of the game in progress)
  // ---------------------------------------------------------------------------

  /**
   * Once the game is running (never in champion select), looks its players up once; asks the API
   * again until every player is in; stops when the game ends.
   */
  private syncLobbyLookup(): void {
    if (this.lobby.stage !== 'game') {
      this.stopLobbyLookup();
      if (this.state.lobby) this.patch({ lobby: null });
      return;
    }
    if (!canLookUpLobby(this.lobby.phase)) return;
    const lookup = this.lobbyLookup;
    if (!lookup) {
      void this.startLobbyLookup();
    } else if (!lookup.finished && !lookup.timer && !lookup.inFlight) {
      // Back in game after the client was gone: carry on asking.
      void this.pollLobby();
    }
  }

  private async startLobbyLookup(): Promise<void> {
    const api = this.lcuApi;
    if (!api || this.lobbyStarting) return;
    this.lobbyStarting = true;
    try {
      const [gameflow, me, hints] = await Promise.all([
        api.getGameflowSession(),
        api.getCurrentSummoner(),
        api.getPlatformHints(),
      ]);
      if (api !== this.lcuApi || this.lobby.stage !== 'game' || this.lobbyLookup) return;
      // The guard is applied again on what the client says now (never champion select).
      const request =
        gameflow && me ? lobbyRequestFromGameflow(gameflow, me, this.lobby.phase) : null;
      if (!request) return; // tried again on the next client event
      const platform = platformFromLcu(hints);
      if (!platform) {
        const server = hints.region ?? hints.platformId ?? 'unknown';
        this.lobbyLookup = null;
        this.patch({
          lobby: lobbyView(
            request,
            null,
            null,
            'unsupported',
            `Players are looked up on ${PLATFORMS.join(', ')} only (your server: ${server}).`,
          ),
        });
        return;
      }
      this.lobbyLookup = {
        request,
        platform,
        startedAt: Date.now(),
        response: null,
        timer: null,
        inFlight: false,
        finished: false,
      };
      this.deps.log(`game in progress: looking up ${request.players.length} players`);
      this.patch({ lobby: lobbyView(request, platform, null, 'loading') });
      void this.pollLobby();
    } catch (e) {
      this.deps.log(`lobby lookup not started: ${errorInfo(e).message}`);
    } finally {
      this.lobbyStarting = false;
    }
  }

  private async pollLobby(): Promise<void> {
    const lookup = this.lobbyLookup;
    if (!lookup || lookup.finished || lookup.inFlight) return;
    if (lookup.timer) clearTimeout(lookup.timer);
    lookup.timer = null;
    // Game over screen or client gone: resumed by `syncLobbyLookup` if the game is back.
    if (!canLookUpLobby(this.lobby.phase)) return;
    const showLobby = (state: LobbyState, message: string | null) =>
      this.patch({
        lobby: lobbyView(lookup.request, lookup.platform, lookup.response, state, message),
      });
    if (Date.now() - lookup.startedAt > (this.deps.lobbyMaxMs ?? LOBBY_MAX_MS)) {
      lookup.finished = true;
      showLobby('timeout', 'Stopped waiting: the worker did not look every player up in time.');
      return;
    }
    lookup.inFlight = true;
    const api = this.api;
    try {
      const res = await api.livePlayers({
        platform: lookup.platform,
        gameId: lookup.request.gameId,
        me: lookup.request.me,
        players: lookup.request.players,
      });
      if (lookup !== this.lobbyLookup || api !== this.api) return;
      lookup.response = res;
      lookup.finished = res.done;
      showLobby(
        res.worker === 'unsupported' ? 'unsupported' : res.done ? 'done' : 'loading',
        WORKER_MESSAGE[res.worker] ?? GAME_MESSAGE[res.game],
      );
    } catch (e) {
      if (lookup !== this.lobbyLookup || api !== this.api) return;
      const info = errorInfo(e);
      // An API without /live/players (older version) or refusing the request: no point retrying.
      if (info.code === 'NOT_FOUND' || info.code === 'BAD_REQUEST') lookup.finished = true;
      showLobby('error', info.message);
    } finally {
      lookup.inFlight = false;
    }
    if (lookup === this.lobbyLookup && !lookup.finished) {
      lookup.timer = setTimeout(
        () => void this.pollLobby(),
        this.deps.lobbyPollMs ?? LOBBY_POLL_MS,
      );
    }
  }

  /** New API address, Retry after an error or a timeout: ask again from now. */
  private restartLobbyPolling(): void {
    const lookup = this.lobbyLookup;
    if (!lookup) return;
    lookup.startedAt = Date.now();
    lookup.finished = false;
    void this.pollLobby();
  }

  private stopLobbyLookup(): void {
    if (this.lobbyLookup?.timer) clearTimeout(this.lobbyLookup.timer);
    this.lobbyLookup = null;
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
      let lastManual = prev.lastManual;
      if (this.manualRefresh && !status.refreshing) {
        lastManual = {
          at: new Date().toISOString(),
          result: refreshed ? 'done' : 'failed',
          added: Math.max(0, status.matchesIncluded - this.manualRefresh.includedBefore),
        };
        this.manualRefresh = null;
      }
      this.patch({ stats: { status, refreshing: status.refreshing, lastManual } });
      // New stats on the API (manual or timer refresh, its response cache was cleared).
      if (refreshed) {
        this.deps.log(`stats refreshed on the API (${status.matchesIncluded} matches)`);
        this.refetch();
      }
      this.scheduleStatsPoll(status.refreshing ? STATS_ACTIVE_POLL_MS : STATS_IDLE_POLL_MS);
    } catch {
      if (api !== this.api) return;
      // API down or too old to serve /stats/status: keep the last known value, retry later.
      if (this.manualRefresh) {
        this.manualRefresh = null;
        this.patchStats({
          refreshing: false,
          lastManual: { at: new Date().toISOString(), result: 'failed', added: 0 },
        });
      } else if (prev.refreshing) this.patchStats({ refreshing: false });
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
