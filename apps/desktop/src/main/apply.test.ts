import { describe, expect, test } from 'bun:test';
import type { BuildResponse } from '@pick-league/shared';
import type { LcuPerkPage } from '../core/lcu-types.ts';
import { applyBuild } from './apply.ts';
import type { LcuApi } from './lcu/api.ts';

const build = {
  championId: 267,
  role: 'UTILITY',
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
} satisfies BuildResponse;

function fakeLcu(pages: LcuPerkPage[], ownedPageCount: number) {
  const calls: string[] = [];
  const api: LcuApi = {
    getChampSelectSession: async () => null,
    getGameflowPhase: async () => null,
    getGameflowSession: async () => null,
    getOwnedChampions: async () => [],
    getMastery: async () => [],
    getCurrentSummoner: async () => null,
    getPlatformHints: async () => ({ platformId: null, region: null }),
    getPerkPages: async () => pages,
    getPerkInventory: async () => ({ ownedPageCount }),
    async createPerkPage(page) {
      calls.push(`create ${page.name}`);
      return { ...page, id: 99, isEditable: true, isDeletable: true };
    },
    async replacePerkPage(id, page) {
      calls.push(`replace ${id} ${page.name}`);
    },
    async setCurrentPerkPage(id) {
      calls.push(`current ${id}`);
    },
    async patchMySelection(patch) {
      calls.push(`spells ${patch.spell1Id},${patch.spell2Id}`);
    },
  };
  return { api, calls };
}

const userPage = (id: number): LcuPerkPage => ({
  id,
  name: `Page ${id}`,
  isEditable: true,
  isDeletable: true,
  current: false,
  primaryStyleId: 8000,
  subStyleId: 8100,
  selectedPerkIds: [],
});

describe('applyBuild', () => {
  test('creates the PickLeague page and puts Flash on F', async () => {
    const { api, calls } = fakeLcu([userPage(1)], 2);
    const result = await applyBuild(api, build, [14, 4], 'F');
    expect(result.state).toBe('done');
    expect(calls).toEqual(['create PickLeague', 'current 99', 'spells 3,4']);
    expect(result.messages).toContain('Summoner spells set (Flash on F)');
  });

  test('moves Flash to D when D is chosen', async () => {
    const { api, calls } = fakeLcu([userPage(1)], 2);
    const result = await applyBuild(api, build, [14, 4], 'D');
    expect(calls).toEqual(['create PickLeague', 'current 99', 'spells 4,3']);
    expect(result.messages).toContain('Summoner spells set (Flash on D)');
  });

  test('leaves the spells alone when Flash is already on the chosen key', async () => {
    const { api, calls } = fakeLcu([userPage(1), { ...userPage(2), name: 'PickLeague' }], 2);
    const result = await applyBuild(api, build, [4, 3], 'D');
    expect(calls).toEqual(['replace 2 PickLeague', 'current 2']);
    expect(result.messages).toContain('Summoner spells already set');
  });

  test('never deletes user pages: warns when no slot is free, still sets spells', async () => {
    const { api, calls } = fakeLcu([userPage(1), userPage(2)], 2);
    const result = await applyBuild(api, build, [14, 4], 'F');
    expect(result.state).toBe('warning');
    expect(calls).toEqual(['spells 3,4']);
  });
});
