import type {
  StaticChampionDto,
  StaticDataResponse,
  StaticItemDto,
  StaticRuneDto,
  StaticRuneTreeDto,
  StaticStatShardDto,
  StaticSummonerSpellDto,
} from '@pick-league/shared';

/** Static data (names + icon URLs) indexed by id, as the views read it. */
export interface StaticLookup {
  version: string;
  patch: string;
  /** Every champion, sorted by name. */
  champions: readonly StaticChampionDto[];
  champion(id: number | null | undefined): StaticChampionDto | undefined;
  item(id: number | null | undefined): StaticItemDto | undefined;
  rune(id: number): StaticRuneDto | undefined;
  tree(id: number): StaticRuneTreeDto | undefined;
  shard(id: number): StaticStatShardDto | undefined;
  spell(id: number): StaticSummonerSpellDto | undefined;
}

export function createStaticLookup(data: StaticDataResponse): StaticLookup {
  const by = <T extends { id: number }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const champions = by(data.champions);
  const items = by(data.items);
  const runes = by(data.runes);
  const trees = by(data.runeTrees);
  const shards = by(Object.values(data.statShards).flat());
  const spells = by(data.summonerSpells);
  return {
    version: data.ddragonVersion,
    patch: data.patch,
    champions: [...data.champions].sort((a, b) => a.name.localeCompare(b.name)),
    champion: (id) => (id ? champions.get(id) : undefined),
    item: (id) => (id ? items.get(id) : undefined),
    rune: (id) => runes.get(id),
    tree: (id) => trees.get(id),
    shard: (id) => shards.get(id),
    spell: (id) => spells.get(id),
  };
}
