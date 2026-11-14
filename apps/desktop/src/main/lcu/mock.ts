/**
 * Fake League client for development and demos: replays `mockSessionAt` / `mockPhaseAt` (champion
 * select, then the game) in a loop and serves fake owned champions, mastery and rune pages
 * through the same `LcuApi` as the real client.
 */

import { isInGamePhase } from '../../core/game-flow.ts';
import type {
  LcuChampSelectSession,
  LcuGameflowPhase,
  LcuMySelectionPatch,
  LcuPerkPage,
  LcuPerkPageInput,
} from '../../core/lcu-types.ts';
import {
  MOCK_INITIAL_SPELLS,
  MOCK_LOCAL_CELL,
  MOCK_LOOP_MS,
  mockCurrentSummoner,
  mockGameflowSession,
  mockMastery,
  mockOwnedChampions,
  mockPhaseAt,
  mockSessionAt,
} from '../../core/mock-script.ts';
import {
  CHAMP_SELECT_SESSION_PATH,
  createLcuApi,
  GAMEFLOW_PHASE_PATH,
  GAMEFLOW_SESSION_PATH,
  LcuHttpError,
  type LcuTransport,
} from './api.ts';
import type { LcuSource } from './source.ts';

const TICK_MS = 400;

export interface MockLcuOptions {
  /** Called for every write so the dev console shows what would reach the real client. */
  log?: (message: string) => void;
}

export function createMockLcuSource(options: MockLcuOptions = {}): LcuSource {
  const log = options.log ?? (() => undefined);
  let timer: ReturnType<typeof setInterval> | null = null;
  let loopStart = 0;
  let loopIndex = 0;
  let spells: [number, number] = [...MOCK_INITIAL_SPELLS];
  let lastJson = '';
  let lastPhase: LcuGameflowPhase | null = null;
  let nextPageId = 100;
  const pages: LcuPerkPage[] = [
    {
      id: 1,
      name: 'My Aery page',
      isEditable: true,
      isDeletable: true,
      current: true,
      primaryStyleId: 8200,
      subStyleId: 8300,
      selectedPerkIds: [8214, 8226, 8210, 8237, 8345, 8347, 5008, 5008, 5011],
    },
    {
      id: 2,
      name: 'Guardian',
      isEditable: true,
      isDeletable: true,
      current: false,
      primaryStyleId: 8400,
      subStyleId: 8300,
      selectedPerkIds: [8465, 8463, 8473, 8453, 8345, 8347, 5008, 5008, 5011],
    },
  ];
  const ownedPageCount = 3;

  /** Time into the current loop. */
  function elapsed(): number {
    const sinceStart = Date.now() - loopStart;
    const loop = Math.floor(sinceStart / MOCK_LOOP_MS);
    if (loop !== loopIndex) {
      loopIndex = loop;
      spells = [...MOCK_INITIAL_SPELLS]; // new champion select, fresh selection
    }
    return sinceStart % MOCK_LOOP_MS;
  }

  function currentSession(): LcuChampSelectSession | null {
    const session = mockSessionAt(elapsed());
    if (!session) return null;
    const me = session.myTeam.find((p) => p.cellId === MOCK_LOCAL_CELL);
    if (me) [me.spell1Id, me.spell2Id] = spells;
    return session;
  }

  function savePage(input: LcuPerkPageInput, id: number): LcuPerkPage {
    if (input.current) for (const p of pages) p.current = false;
    const page: LcuPerkPage = { ...input, id, isEditable: true, isDeletable: true };
    const i = pages.findIndex((p) => p.id === id);
    if (i >= 0) pages[i] = page;
    else pages.push(page);
    return page;
  }

  const transport: LcuTransport = async (method, path, body) => {
    const route = `${method} ${path}`;
    switch (route) {
      case `GET ${CHAMP_SELECT_SESSION_PATH}`: {
        const s = currentSession();
        if (!s) throw new LcuHttpError(method, path, 404, 'No active delegate');
        return s;
      }
      case `GET ${GAMEFLOW_PHASE_PATH}`:
        return mockPhaseAt(elapsed());
      case `GET ${GAMEFLOW_SESSION_PATH}`: {
        if (!isInGamePhase(mockPhaseAt(elapsed()))) {
          throw new LcuHttpError(method, path, 404, 'No game in progress');
        }
        return mockGameflowSession(spells);
      }
      case 'GET /lol-champions/v1/owned-champions-minimal':
        return mockOwnedChampions();
      case 'GET /lol-champion-mastery/v1/local-player/champion-mastery':
        return mockMastery();
      case 'GET /lol-summoner/v1/current-summoner':
        return mockCurrentSummoner();
      case 'GET /lol-perks/v1/pages':
        return pages.map((p) => ({ ...p }));
      case 'GET /lol-perks/v1/inventory':
        return { ownedPageCount };
      case 'POST /lol-perks/v1/pages': {
        if (pages.filter((p) => p.isDeletable).length >= ownedPageCount) {
          throw new LcuHttpError(method, path, 400, 'Max pages reached');
        }
        log(`[mock-lcu] create rune page ${JSON.stringify(body)}`);
        return savePage(body as LcuPerkPageInput, nextPageId++);
      }
      case 'PUT /lol-perks/v1/currentpage': {
        for (const p of pages) p.current = p.id === body;
        return undefined;
      }
      case `PATCH ${CHAMP_SELECT_SESSION_PATH}/my-selection`: {
        if (!currentSession()) throw new LcuHttpError(method, path, 404, 'No active delegate');
        const patch = body as LcuMySelectionPatch;
        spells = [patch.spell1Id, patch.spell2Id];
        log(`[mock-lcu] summoner spells → ${JSON.stringify(patch)}`);
        return undefined;
      }
    }
    const put = /^PUT \/lol-perks\/v1\/pages\/(\d+)$/.exec(route);
    if (put) {
      const id = Number(put[1]);
      if (!pages.some((p) => p.id === id)) throw new LcuHttpError(method, path, 404, 'No page');
      log(`[mock-lcu] replace rune page ${id} ${JSON.stringify(body)}`);
      savePage(body as LcuPerkPageInput, id);
      return undefined;
    }
    throw new LcuHttpError(method, path, 404, 'Not mocked');
  };

  return {
    kind: 'mock',
    start(listener) {
      if (timer) return;
      loopStart = Date.now();
      loopIndex = 0;
      lastJson = '';
      lastPhase = null;
      listener.onStatus({ state: 'connected', api: createLcuApi(transport) });
      const tick = () => {
        // Phase first: when champion select ends, the game has already started.
        const phase = mockPhaseAt(elapsed());
        if (phase !== lastPhase) {
          lastPhase = phase;
          listener.onPhase(phase);
        }
        const session = currentSession();
        const json = JSON.stringify(session);
        if (json === lastJson) return;
        lastJson = json;
        listener.onSession(session);
      };
      tick();
      timer = setInterval(tick, TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
