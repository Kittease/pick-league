import { describe, expect, test } from 'bun:test';
import {
  createDdragonClient,
  type DdragonChampionFile,
  DdragonHttpError,
  type DdragonItemFile,
  type DdragonRunesFile,
  type DdragonSummonerFile,
  ddragonChampionIconUrl,
  ddragonItemIconUrl,
  ddragonRuneIconUrl,
  ddragonSpellImageUrl,
  latestPatchVersions,
  normaliseChampions,
  normaliseItems,
  normaliseRunes,
  normaliseSummonerSpells,
} from './ddragon.ts';
import championFull from './fixtures/championFull.json';
import itemFile from './fixtures/item.json';
import runesFile from './fixtures/runesReforged.json';
import summonerFile from './fixtures/summoner.json';
import versions from './fixtures/versions.json';
import { STAT_SHARDS, STAT_SHARDS_BY_ID } from './static-data.ts';

const champions = championFull as unknown as DdragonChampionFile;
const items = itemFile as unknown as DdragonItemFile;
const runes = runesFile as unknown as DdragonRunesFile;
const summoners = summonerFile as unknown as DdragonSummonerFile;

describe('latestPatchVersions', () => {
  test('keeps the newest ddragon version of each distinct patch', () => {
    expect(latestPatchVersions(versions, 2)).toEqual([
      { patch: '15.22', ddragonVersion: '15.22.1' },
      { patch: '15.21', ddragonVersion: '15.21.2' },
    ]);
  });

  test('ignores non-patch entries', () => {
    expect(latestPatchVersions(['lolpatch_7.20', '15.1.1'], 5)).toEqual([
      { patch: '15.1', ddragonVersion: '15.1.1' },
    ]);
  });
});

describe('normaliseChampions', () => {
  const result = normaliseChampions(champions);

  test('maps keys, slugs and names, sorted by numeric id', () => {
    expect(result.map((c) => [c.id, c.slug, c.name])).toEqual([
      [1, 'Annie', 'Annie'],
      [62, 'MonkeyKing', 'Wukong'],
    ]);
  });

  test('keeps tags, attack range and info', () => {
    const wukong = result.find((c) => c.id === 62);
    expect(wukong?.tags).toEqual(['Fighter', 'Tank']);
    expect(wukong?.attackRange).toBe(175);
    expect(wukong?.info).toEqual({ attack: 8, defense: 5, magic: 2, difficulty: 3 });
  });

  test('numbers spells Q..R as slots 1..4', () => {
    const annie = result.find((c) => c.id === 1);
    expect(annie?.spells).toEqual([
      { slot: 1, name: 'Disintegrate', image: 'AnnieQ.png' },
      { slot: 2, name: 'Incinerate', image: 'AnnieW.png' },
      { slot: 3, name: 'Molten Shield', image: 'AnnieE.png' },
      { slot: 4, name: 'Summon: Tibbers', image: 'AnnieR.png' },
    ]);
  });
});

describe('normaliseItems', () => {
  const result = normaliseItems(items);
  const byId = new Map(result.map((i) => [i.id, i]));

  test("keeps only Summoner's Rift items", () => {
    expect(byId.has(223006)).toBe(false);
    expect(result).toHaveLength(7);
  });

  test('converts recipe links to numbers', () => {
    expect(byId.get(1001)?.buildsInto).toEqual([3006, 3111]);
    expect(byId.get(3111)?.buildsFrom).toEqual([1001, 1033]);
    // 3133 is not in the fixture: dropped
    expect(byId.get(3156)?.buildsFrom).toEqual([1033]);
  });

  test('flags boots, consumables and completed items', () => {
    expect(byId.get(1001)).toMatchObject({ isBoots: true, isCompleted: false });
    expect(byId.get(3006)).toMatchObject({ isBoots: true, isCompleted: true, goldTotal: 1100 });
    expect(byId.get(3156)).toMatchObject({ isBoots: false, isCompleted: true });
    expect(byId.get(1033)).toMatchObject({ isCompleted: false });
    expect(byId.get(2003)).toMatchObject({ isConsumable: true, isCompleted: false });
    expect(byId.get(3340)).toMatchObject({ isConsumable: false, isCompleted: false });
  });

  test('keeps stats', () => {
    expect(byId.get(3156)?.stats).toEqual({ FlatPhysicalDamageMod: 60 });
  });
});

describe('normaliseRunes', () => {
  const { runeTrees, runes: list } = normaliseRunes(runes);

  test('extracts trees', () => {
    expect(runeTrees.map((t) => [t.id, t.name])).toEqual([
      [8000, 'Precision'],
      [8400, 'Resolve'],
    ]);
  });

  test('assigns tree and row (0 = keystone)', () => {
    expect(list.find((r) => r.id === 8005)).toMatchObject({ treeId: 8000, row: 0 });
    expect(list.find((r) => r.id === 9101)).toMatchObject({ treeId: 8000, row: 1 });
    expect(list.find((r) => r.id === 8439)).toMatchObject({ treeId: 8400, row: 0 });
  });
});

describe('normaliseSummonerSpells', () => {
  test('maps numeric keys and image files', () => {
    expect(normaliseSummonerSpells(summoners)).toEqual([
      { id: 4, name: 'Flash', image: 'SummonerFlash.png' },
      { id: 7, name: 'Heal', image: 'SummonerHeal.png' },
      { id: 14, name: 'Ignite', image: 'SummonerDot.png' },
    ]);
  });
});

describe('stat shards', () => {
  test('three rows of three options', () => {
    expect(STAT_SHARDS.offense.map((s) => s.id)).toEqual([5008, 5005, 5007]);
    expect(STAT_SHARDS.flex.map((s) => s.id)).toEqual([5008, 5010, 5001]);
    expect(STAT_SHARDS.defense.map((s) => s.id)).toEqual([5011, 5013, 5001]);
    expect(STAT_SHARDS_BY_ID.size).toBe(7);
  });
});

describe('CDN URLs', () => {
  test('build Data Dragon URLs', () => {
    expect(ddragonChampionIconUrl('15.22.1', 'MonkeyKing')).toBe(
      'https://ddragon.leagueoflegends.com/cdn/15.22.1/img/champion/MonkeyKing.png',
    );
    expect(ddragonItemIconUrl('15.22.1', 3006)).toBe(
      'https://ddragon.leagueoflegends.com/cdn/15.22.1/img/item/3006.png',
    );
    expect(ddragonSpellImageUrl('15.22.1', 'SummonerFlash.png')).toBe(
      'https://ddragon.leagueoflegends.com/cdn/15.22.1/img/spell/SummonerFlash.png',
    );
    expect(ddragonRuneIconUrl('perk-images/Styles/7201_Precision.png')).toBe(
      'https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/7201_Precision.png',
    );
  });
});

describe('createDdragonClient', () => {
  const routes: Record<string, unknown> = {
    '/api/versions.json': versions,
    '/cdn/15.22.1/data/en_US/championFull.json': championFull,
    '/cdn/15.22.1/data/en_US/item.json': itemFile,
    '/cdn/15.22.1/data/en_US/runesReforged.json': runesFile,
    '/cdn/15.22.1/data/en_US/summoner.json': summonerFile,
  };
  const requested: string[] = [];
  const client = createDdragonClient({
    baseUrl: 'https://ddragon.test',
    fetch: async (url) => {
      requested.push(url);
      const path = url.replace('https://ddragon.test', '');
      const body = routes[path];
      return body === undefined ? new Response('not found', { status: 404 }) : Response.json(body);
    },
  });

  test('resolves the latest patches', async () => {
    expect(await client.getLatestPatchVersions(1)).toEqual([
      { patch: '15.22', ddragonVersion: '15.22.1' },
    ]);
  });

  test('fetches and normalises a whole patch', async () => {
    const data = await client.getStaticPatchData('15.22.1');
    expect(data.patch).toBe('15.22');
    expect(data.ddragonVersion).toBe('15.22.1');
    expect(data.champions).toHaveLength(2);
    expect(data.items).toHaveLength(7);
    expect(data.runeTrees).toHaveLength(2);
    expect(data.runes).toHaveLength(4);
    expect(data.summonerSpells).toHaveLength(3);
    expect(requested).toContain('https://ddragon.test/cdn/15.22.1/data/en_US/championFull.json');
  });

  test('throws DdragonHttpError on non-2xx', async () => {
    await expect(client.getItems('0.0.0')).rejects.toBeInstanceOf(DdragonHttpError);
  });
});
