import { afterEach, describe, expect, test } from 'bun:test';
import {
  type BuildRequestInput,
  type BuildResponse,
  isPlayingPhase,
  type LivePlayersRequest,
  type LivePlayersResponse,
} from '@pick-league/shared';
import type { AppState } from '../core/app-state.ts';
import {
  champSelectSession,
  FAKE_SUMMONER,
  gameflowSession,
  LOCKED_CHAMPION,
} from '../core/fixtures.ts';
import type { LcuChampSelectSession, LcuGameflowPhase } from '../core/lcu-types.ts';
import type { ApiClient } from './api-client.ts';
import { Controller } from './controller.ts';
import type { LcuApi } from './lcu/api.ts';
import type { LcuListener, LcuSource } from './lcu/source.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

/** Longer than the controller's request debounce. */
const settle = () => new Promise((r) => setTimeout(r, 350));

function buildFor(req: BuildRequestInput): BuildResponse {
  return {
    championId: req.championId,
    role: req.role,
    patchesUsed: ['15.22'],
    games: 500,
    confidence: 0.8,
    items: { starting: [], early: [], core: [], situational: [] },
    runes: {
      primaryTreeId: 8200,
      secondaryTreeId: 8400,
      runeIds: [8214, 8226, 8210, 8237, 8473, 8453],
      statShardIds: [5008, 5008, 5011],
      selectedPerkIds: [8214, 8226, 8210, 8237, 8473, 8453, 5008, 5008, 5011],
      games: 400,
      winRate: 0.53,
      reasons: [],
    },
    summonerSpells: { spellIds: [4, 3], games: 400, winRate: 0.52, reasons: [] },
    skillOrder: {
      firstLevels: [1, 3, 2],
      maxOrder: [1, 3, 2],
      sequence: [],
      games: 0,
      winRate: 0,
      reasons: [],
    },
  };
}

/** A promise resolved from outside, to hold a League client call in flight. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

let current: Controller | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

/**
 * Controller wired to an in-memory API and a stand-in League client: tests push client events
 * (`lcu.session`, `lcu.phase`, `lcu.disconnect`…) and count the calls it receives.
 */
/** Every player ready (unranked, no recent match) unless `pending` lists request indexes. */
function liveAnswer(req: LivePlayersRequest, pending: number[] = []): LivePlayersResponse {
  const players = req.players.map((p, index) => ({
    index,
    team: p.team,
    championId: p.championId,
    position: p.position,
    status: pending.includes(index) ? ('pending' as const) : ('ready' as const),
    rankLoaded: !pending.includes(index),
    rank: null,
    mastery: pending.includes(index) ? null : { level: 1, points: 100 },
    recent: null,
  }));
  return {
    platform: req.platform,
    worker: 'ok',
    game: 'found',
    done: pending.length === 0,
    players,
  };
}

function setup(
  options: {
    lcu?: Partial<LcuApi>;
    live?: (req: LivePlayersRequest, n: number) => Promise<LivePlayersResponse>;
  } = {},
) {
  const calls = { picks: 0, build: 0, draft: 0, spells: 0, applies: 0 };
  /** Bodies of POST /live/players, in order. */
  const live: LivePlayersRequest[] = [];
  /** Phases sent to PUT /client/activity, in order. */
  const activity: string[] = [];
  const api: ApiClient = {
    baseUrl: 'http://api.test',
    health: async () => ({ ok: true, db: true, latestPatch: '15.22', matchCount: 10 }),
    staticData: async () => Promise.reject(new Error('no static data in tests')),
    picks: async (req) => {
      calls.picks++;
      return { role: req.role, patch: '15.22', candidates: [] };
    },
    build: async (req) => {
      calls.build++;
      return buildFor(req);
    },
    draft: async (req) => {
      calls.draft++;
      const none = { physical: 0, magic: 0, true: 0, champions: [] };
      return {
        patch: '15.22',
        patchesUsed: ['15.22'],
        winProbability: req.side === 'red' ? 0.52 : 0.48,
        reasons: [],
        damage: { allies: none, enemies: none },
      };
    },
    statsStatus: async () => Promise.reject(new Error('no stats in tests')),
    statsRefresh: async () => Promise.reject(new Error('no stats in tests')),
    tierList: async () => Promise.reject(new Error('no tier list in tests')),
    tierListChampion: async () => Promise.reject(new Error('no tier list in tests')),
    livePlayers: async (req) => {
      live.push(req);
      return options.live ? options.live(req, live.length) : liveAnswer(req);
    },
    clientActivity: async (req) => {
      activity.push(req.phase);
      return { paused: isPlayingPhase(req.phase) };
    },
  };
  const lcu: LcuApi = {
    getChampSelectSession: async () => null,
    getGameflowPhase: async () => null,
    getGameflowSession: async () => gameflowSession([14, 4]),
    getOwnedChampions: async () => [],
    getMastery: async () => [],
    getCurrentSummoner: async () => FAKE_SUMMONER,
    getPlatformHints: async () => ({ platformId: 'EUW1', region: 'EUW' }),
    getPerkPages: async () => {
      calls.applies++;
      return [];
    },
    getPerkInventory: async () => ({ ownedPageCount: 2 }),
    createPerkPage: async (page) => ({ ...page, id: 99, isEditable: true, isDeletable: true }),
    replacePerkPage: async () => undefined,
    setCurrentPerkPage: async () => undefined,
    patchMySelection: async () => {
      calls.spells++;
    },
    ...options.lcu,
  };
  let listener: LcuListener | null = null;
  const source: LcuSource = {
    start(l) {
      listener = l;
      l.onStatus({ state: 'connected', api: lcu });
    },
    stop() {},
  };
  const controller = new Controller({
    settings: { ...DEFAULT_SETTINGS, ownedOnly: false },
    createSource: () => source,
    createApi: () => api,
    loadDdragonStatic: async () => Promise.reject(new Error('offline')),
    saveSettings: async () => undefined,
    log: () => undefined,
    autoApplyRetryMs: 20,
    lobbyPollMs: 20,
    activityRenewMs: 30,
  });
  current = controller;
  controller.start();
  const lcuEvents = {
    session: (s: LcuChampSelectSession | null) => listener?.onSession(s),
    phase: (p: LcuGameflowPhase | null) => listener?.onPhase(p),
    /** What the real source reports when the client closes. */
    disconnect: () => {
      listener?.onSession(null);
      listener?.onPhase(null);
      listener?.onStatus({ state: 'searching', message: 'League client disconnected' });
    },
    /** Reconnected client, then its current phase (no champion select). */
    reconnect: (phase: LcuGameflowPhase) => {
      listener?.onStatus({ state: 'connected', api: lcu });
      listener?.onPhase(phase);
      listener?.onSession(null);
    },
  };
  const state = (): AppState => controller.getState();
  return { controller, calls, live, activity, lcu: lcuEvents, state };
}

describe('controller: champion select → game', () => {
  test('keeps the locked build through the game without refetching or applying again', async () => {
    const { controller, calls, lcu, state } = setup();
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    expect(state().build).toMatchObject({
      status: 'ok',
      data: { championId: LOCKED_CHAMPION },
    });
    expect(state().apply.state).toBe('done');
    const before = { ...calls };

    lcu.phase('GameStart');
    lcu.session(null);
    await settle();
    expect(state()).toMatchObject({
      inGame: true,
      champSelect: { lockedChampionId: LOCKED_CHAMPION },
      picks: { status: 'idle' },
      build: { status: 'ok', data: { championId: LOCKED_CHAMPION } },
      buildTarget: { championId: LOCKED_CHAMPION, preview: false },
    });

    // Stats refresh / Retry, previews and the Apply button do nothing in game.
    controller.refresh();
    controller.previewBuild(40);
    const apply = await controller.applyNow();
    lcu.phase('InProgress');
    await settle();
    expect(calls).toEqual(before);
    expect(apply.state).toBe('error');
    expect(state().build.status).toBe('ok');

    lcu.phase('EndOfGame');
    expect(state()).toMatchObject({ inGame: false, champSelect: null, build: { status: 'idle' } });
  });

  test('the client closed during the game: the build stays until the client says it is over', async () => {
    const { calls, lcu, state } = setup();
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    lcu.phase('GameStart');
    lcu.session(null);
    await settle();
    const before = { ...calls };

    lcu.disconnect();
    await settle();
    const kept = {
      inGame: true,
      champSelect: { lockedChampionId: LOCKED_CHAMPION },
      build: { status: 'ok', data: { championId: LOCKED_CHAMPION } },
      buildTarget: { championId: LOCKED_CHAMPION, preview: false },
    };
    expect(state()).toMatchObject({ lcu: { state: 'searching' }, ...kept });

    lcu.reconnect('InProgress');
    await settle();
    expect(state()).toMatchObject({ lcu: { state: 'connected' }, ...kept });
    expect(calls).toEqual(before);

    lcu.disconnect();
    lcu.reconnect('EndOfGame');
    expect(state()).toMatchObject({ inGame: false, champSelect: null, build: { status: 'idle' } });
  });

  test('a dodge drops the champion select as soon as the client leaves it', async () => {
    const { lcu, state } = setup();
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    lcu.session(null);
    // The client has not said where it goes yet: nothing changes.
    expect(state().champSelect).not.toBeNull();
    lcu.phase('Lobby');
    expect(state()).toMatchObject({ inGame: false, champSelect: null, build: { status: 'idle' } });
  });

  test('started in game: reads the teams from the client, fetches the build, applies nothing', async () => {
    const { calls, lcu, state } = setup();
    lcu.phase('InProgress');
    lcu.session(null);
    await settle();
    expect(state()).toMatchObject({
      inGame: true,
      champSelect: { lockedChampionId: LOCKED_CHAMPION, role: 'UTILITY', mySpells: [14, 4] },
      build: { status: 'ok', data: { championId: LOCKED_CHAMPION } },
      apply: { state: 'idle' },
    });
    expect(calls).toEqual({ picks: 0, build: 1, draft: 0, spells: 0, applies: 0 });
  });
});

describe('controller: lobby lookup', () => {
  test('never in champion select nor the loading screen; once in progress, polled until done', async () => {
    const { live, lcu, state } = setup({
      live: async (req, n) => liveAnswer(req, n < 3 ? [7, 8] : []),
    });
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    lcu.phase('GameStart');
    lcu.session(null);
    await settle();
    expect(live).toHaveLength(0);
    expect(state().lobby).toBeNull();

    lcu.phase('InProgress');
    await settle();
    expect(live.length).toBe(3);
    expect(live[0]?.platform).toBe('EUW1');
    expect(live[0]?.players).toHaveLength(10);
    // The game is found from the user's own Riot ID: no player id is sent.
    expect(live[0]).toMatchObject({ gameId: 1, me: { gameName: 'FakePlayer', tagLine: 'TEST' } });
    expect(JSON.stringify(live)).not.toContain(FAKE_SUMMONER.puuid as string);
    // Done: no more requests.
    await settle();
    expect(live.length).toBe(3);
    const lobby = state().lobby;
    expect(lobby).toMatchObject({ state: 'done', platform: 'EUW1', worker: 'ok' });
    expect(lobby?.allies.find((p) => p.me)?.championId).toBe(LOCKED_CHAMPION);
    expect(
      [...(lobby?.allies ?? []), ...(lobby?.enemies ?? [])].every((p) => p.status === 'ready'),
    ).toBe(true);
    // The renderer state never carries a puuid.
    expect(JSON.stringify(state())).not.toContain('puuid');

    lcu.phase('EndOfGame');
    expect(state().lobby).toBeNull();
  });

  test('stops asking when the game ends, even if players are still pending', async () => {
    const { live, lcu, state } = setup({ live: async (req) => liveAnswer(req, [0]) });
    lcu.phase('InProgress');
    lcu.session(null);
    await settle();
    expect(state().lobby?.state).toBe('loading');
    const asked = live.length;
    expect(asked).toBeGreaterThan(1);
    lcu.phase('Lobby');
    expect(state().lobby).toBeNull();
    await settle();
    expect(live.length).toBeLessThanOrEqual(asked + 1);
    const after = live.length;
    await settle();
    expect(live.length).toBe(after);
  });

  test('a server PickLeague does not collect: shown as such, the API is not asked', async () => {
    const { live, lcu, state } = setup({
      lcu: { getPlatformHints: async () => ({ platformId: 'EUN1', region: 'EUNE' }) },
    });
    lcu.phase('InProgress');
    lcu.session(null);
    await settle();
    expect(live).toHaveLength(0);
    expect(state().lobby).toMatchObject({ state: 'unsupported', platform: null });
    expect(state().lobby?.message).toContain('EUNE');
  });
});

describe('controller: auto-apply', () => {
  test('previewing a champion, then locking it in, applies its build once', async () => {
    const { controller, calls, lcu, state } = setup();
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession({ championId: LOCKED_CHAMPION, locked: false }));
    controller.previewBuild(LOCKED_CHAMPION);
    await settle();
    expect(state()).toMatchObject({
      build: { status: 'ok', data: { championId: LOCKED_CHAMPION } },
      buildTarget: { championId: LOCKED_CHAMPION, preview: true },
      apply: { state: 'idle' },
    });

    lcu.session(champSelectSession({ championId: LOCKED_CHAMPION, locked: true }));
    await settle();
    expect(state()).toMatchObject({
      buildTarget: { championId: LOCKED_CHAMPION, preview: false },
      apply: { state: 'done', auto: true, championId: LOCKED_CHAMPION },
    });
    // Same request: the previewed build is reused, and applied exactly once.
    expect(calls.build).toBe(1);
    expect(calls.applies).toBe(1);
    lcu.session(champSelectSession({ championId: LOCKED_CHAMPION, locked: true }));
    await settle();
    expect(calls.applies).toBe(1);
  });

  test('the Apply button during an auto-apply waits for it instead of writing again', async () => {
    const held = gate();
    let applies = 0;
    const { controller, lcu, state } = setup({
      lcu: {
        getPerkPages: async () => {
          applies++;
          await held.opened;
          return [];
        },
      },
    });
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    expect(state().apply).toMatchObject({ state: 'applying', auto: true });

    const manual = controller.applyNow();
    held.open();
    expect(await manual).toMatchObject({ state: 'done', auto: true });
    await settle();
    expect(applies).toBe(1);
  });

  test("a previous champion select's apply result does not show in the next one", async () => {
    const held = gate();
    const { lcu, state } = setup({
      lcu: {
        getPerkPages: async () => {
          await held.opened;
          return [];
        },
      },
    });
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    expect(state().apply.state).toBe('applying');

    // Someone dodges, the next champion select starts before the client answers.
    lcu.session(null);
    lcu.phase('Lobby');
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession({ championId: 40, locked: false }));
    held.open();
    await settle();
    expect(state()).toMatchObject({
      champSelect: { lockedIn: false },
      apply: { state: 'idle', championId: null },
    });
  });

  test('a failed auto-apply is tried again until it works', async () => {
    let applies = 0;
    const { lcu, state } = setup({
      lcu: {
        getPerkPages: async () => {
          applies++;
          if (applies < 3) throw new Error('client busy');
          return [];
        },
      },
    });
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    expect(state().apply).toMatchObject({ state: 'done', auto: true });
    expect(applies).toBe(3);
    lcu.session(champSelectSession());
    await settle();
    expect(applies).toBe(3);
  });

  test('a failing auto-apply gives up after three attempts', async () => {
    let applies = 0;
    const { lcu, state } = setup({
      lcu: {
        getPerkPages: async () => {
          applies++;
          throw new Error('client busy');
        },
      },
    });
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    expect(state().apply).toMatchObject({ state: 'error', auto: true });
    expect(applies).toBe(3);
    lcu.session(champSelectSession());
    await settle();
    expect(applies).toBe(3);
  });

  test('a failed auto-apply is not tried again once the game started', async () => {
    const held = gate();
    let applies = 0;
    const { lcu, state } = setup({
      lcu: {
        getPerkPages: async () => {
          applies++;
          await held.opened;
          throw new Error('client busy');
        },
      },
    });
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    await settle();
    lcu.phase('GameStart');
    held.open();
    await settle();
    expect(state()).toMatchObject({ inGame: true, apply: { state: 'error' } });
    expect(applies).toBe(1);
  });
});

describe('controller: draft planner', () => {
  test('forwards a valid picks request, without any champion select', async () => {
    const { controller, calls } = setup();
    const result = await controller.draftPicks({
      role: 'MIDDLE',
      allies: [{ championId: 1, role: 'TOP' }],
      enemies: [11],
      bans: [101],
      limit: 100,
    });
    expect(result).toEqual({ ok: true, data: { role: 'MIDDLE', patch: '15.22', candidates: [] } });
    expect(calls.picks).toBe(1);
  });

  test('forwards a valid build request', async () => {
    const { controller, calls } = setup();
    const result = await controller.draftBuild({
      championId: 14,
      role: 'UTILITY',
      allies: [{ championId: 15, role: 'BOTTOM' }],
      enemies: [{ championId: 4, role: 'BOTTOM' }],
    });
    expect(result.ok && result.data.championId).toBe(14);
    expect(calls.build).toBe(1);
  });

  test('forwards a valid draft evaluation request', async () => {
    const { controller, calls } = setup();
    const result = await controller.evaluateDraft({
      allies: [{ championId: 14, role: 'UTILITY' }],
      enemies: [{ championId: 4, role: null }],
      side: 'red',
    });
    expect(result.ok && result.data.winProbability).toBe(0.52);
    expect(calls.draft).toBe(1);
    for (const bad of [null, { side: 'green' }, { allies: [{ championId: 0, role: null }] }]) {
      expect(await controller.evaluateDraft(bad)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    }
    expect(calls.draft).toBe(1);
  });

  test('refuses malformed bodies from the renderer without calling the API', async () => {
    const { controller, calls } = setup();
    for (const bad of [null, 'MIDDLE', { role: 'MID' }, { role: 'TOP', enemies: [-1] }]) {
      expect(await controller.draftPicks(bad)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    }
    for (const bad of [undefined, { role: 'TOP' }, { championId: 1.5, role: 'TOP' }]) {
      expect(await controller.draftBuild(bad)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    }
    expect(calls.picks).toBe(0);
    expect(calls.build).toBe(0);
  });
});

describe('controller: collection paused while the user plays', () => {
  test('from queue start to the end of the game, renewed meanwhile, then released', async () => {
    const { activity, lcu, state } = setup();
    lcu.phase('Lobby');
    await settle();
    expect(activity.at(-1)).toBe('Lobby');
    expect(state().collectionPaused).toBe(false);

    lcu.phase('Matchmaking');
    await settle();
    expect(state().collectionPaused).toBe(true);
    lcu.phase('ChampSelect');
    lcu.session(champSelectSession());
    lcu.phase('InProgress');
    lcu.session(null);
    const sent = activity.length;
    await new Promise((r) => setTimeout(r, 100));
    // Renewed while in game (every 30 ms here).
    expect(activity.length).toBeGreaterThan(sent + 1);
    expect(activity.at(-1)).toBe('InProgress');
    expect(state().collectionPaused).toBe(true);

    lcu.phase('EndOfGame');
    await settle();
    expect(state().collectionPaused).toBe(false);
    const ended = activity.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(activity.length).toBe(ended);
    expect(activity.at(-1)).toBe('EndOfGame');
  });

  test('the League client closing in game ends the pause', async () => {
    const { activity, lcu, state } = setup();
    lcu.phase('InProgress');
    await settle();
    expect(state().collectionPaused).toBe(true);
    lcu.disconnect();
    await settle();
    expect(activity.at(-1)).toBe('None');
    expect(state().collectionPaused).toBe(false);
  });
});
