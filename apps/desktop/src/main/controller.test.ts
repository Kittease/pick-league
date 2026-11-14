import { afterEach, describe, expect, test } from 'bun:test';
import type { BuildRequestInput, BuildResponse } from '@pick-league/shared';
import type { AppState } from '../core/app-state.ts';
import type { LcuChampSelectSession, LcuGameflowPhase } from '../core/lcu-types.ts';
import {
  MOCK_LOCKED_CHAMPION,
  MOCK_TIMINGS,
  mockCurrentSummoner,
  mockGameflowSession,
  mockSessionAt,
} from '../core/mock-script.ts';
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

function setup() {
  const calls = { picks: 0, build: 0, spells: 0 };
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
    statsStatus: async () => Promise.reject(new Error('no stats in tests')),
    statsRefresh: async () => Promise.reject(new Error('no stats in tests')),
    tierList: async () => Promise.reject(new Error('no tier list in tests')),
    tierListChampion: async () => Promise.reject(new Error('no tier list in tests')),
  };
  const lcu: LcuApi = {
    getChampSelectSession: async () => null,
    getGameflowPhase: async () => null,
    getGameflowSession: async () => mockGameflowSession([14, 4]),
    getOwnedChampions: async () => [],
    getMastery: async () => [],
    getCurrentSummoner: async () => mockCurrentSummoner(),
    getPerkPages: async () => [],
    getPerkInventory: async () => ({ ownedPageCount: 2 }),
    createPerkPage: async (page) => ({ ...page, id: 99, isEditable: true, isDeletable: true }),
    replacePerkPage: async () => undefined,
    setCurrentPerkPage: async () => undefined,
    patchMySelection: async () => {
      calls.spells++;
    },
  };
  let listener: LcuListener | null = null;
  const source: LcuSource = {
    kind: 'mock',
    start(l) {
      listener = l;
      l.onStatus({ state: 'connected', api: lcu });
    },
    stop() {},
  };
  const controller = new Controller({
    settings: { ...DEFAULT_SETTINGS, ownedOnly: false },
    forcedMock: true,
    createSource: () => source,
    createApi: () => api,
    loadDdragonStatic: async () => Promise.reject(new Error('offline')),
    saveSettings: async () => undefined,
    log: () => undefined,
  });
  controller.start();
  const lcuEvents = {
    session: (s: LcuChampSelectSession | null) => listener?.onSession(s),
    phase: (p: LcuGameflowPhase | null) => listener?.onPhase(p),
  };
  const state = (): AppState => controller.getState();
  return { controller, calls, lcu: lcuEvents, state };
}

let current: Controller | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

describe('controller: champion select → game', () => {
  test('keeps the locked build through the game without refetching or applying again', async () => {
    const { controller, calls, lcu, state } = setup();
    current = controller;
    lcu.phase('ChampSelect');
    lcu.session(mockSessionAt(MOCK_TIMINGS.finalization));
    await settle();
    expect(state().build).toMatchObject({
      status: 'ok',
      data: { championId: MOCK_LOCKED_CHAMPION },
    });
    expect(state().apply.state).toBe('done');
    const before = { ...calls };

    lcu.phase('GameStart');
    lcu.session(null);
    await settle();
    expect(state()).toMatchObject({
      inGame: true,
      champSelect: { lockedChampionId: MOCK_LOCKED_CHAMPION },
      picks: { status: 'idle' },
      build: { status: 'ok', data: { championId: MOCK_LOCKED_CHAMPION } },
      buildTarget: { championId: MOCK_LOCKED_CHAMPION, preview: false },
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

  test('a dodge drops the champion select as soon as the client leaves it', async () => {
    const { controller, lcu, state } = setup();
    current = controller;
    lcu.phase('ChampSelect');
    lcu.session(mockSessionAt(MOCK_TIMINGS.finalization));
    await settle();
    lcu.session(null);
    // The client has not said where it goes yet: nothing changes.
    expect(state().champSelect).not.toBeNull();
    lcu.phase('Lobby');
    expect(state()).toMatchObject({ inGame: false, champSelect: null, build: { status: 'idle' } });
  });

  test('started in game: reads the teams from the client, fetches the build, applies nothing', async () => {
    const { controller, calls, lcu, state } = setup();
    current = controller;
    lcu.phase('InProgress');
    lcu.session(null);
    await settle();
    expect(state()).toMatchObject({
      inGame: true,
      champSelect: { lockedChampionId: MOCK_LOCKED_CHAMPION, role: 'UTILITY', mySpells: [14, 4] },
      build: { status: 'ok', data: { championId: MOCK_LOCKED_CHAMPION } },
      apply: { state: 'idle' },
    });
    expect(calls).toEqual({ picks: 0, build: 1, spells: 0 });
  });
});
