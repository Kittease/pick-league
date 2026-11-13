import type {
  StaticChampionDto,
  StaticDataResponse,
  StaticItemDto,
  StaticRuneDto,
  StaticRuneTreeDto,
  StaticStatShardDto,
  StaticSummonerSpellDto,
} from '@pick-league/shared';
import { useEffect, useMemo, useState } from 'react';
import type { AppState } from '../../../core/app-state.ts';

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = window.pickleague.onState((s) => setState(s));
    void window.pickleague.getState().then((s) => {
      if (alive) setState((prev) => prev ?? s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

export interface StaticLookup {
  version: string;
  patch: string;
  champion(id: number | null | undefined): StaticChampionDto | undefined;
  item(id: number | null | undefined): StaticItemDto | undefined;
  rune(id: number): StaticRuneDto | undefined;
  tree(id: number): StaticRuneTreeDto | undefined;
  shard(id: number): StaticStatShardDto | undefined;
  spell(id: number): StaticSummonerSpellDto | undefined;
}

function lookup(data: StaticDataResponse): StaticLookup {
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
    champion: (id) => (id ? champions.get(id) : undefined),
    item: (id) => (id ? items.get(id) : undefined),
    rune: (id) => runes.get(id),
    tree: (id) => trees.get(id),
    shard: (id) => shards.get(id),
    spell: (id) => spells.get(id),
  };
}

/** Static data (names + icon URLs), re-fetched when the main process reports a new version. */
export function useStatic(version: string | null | undefined): StaticLookup | null {
  const [data, setData] = useState<StaticDataResponse | null>(null);
  useEffect(() => {
    if (!version) return;
    let alive = true;
    void window.pickleague.getStatic().then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [version]);
  return useMemo(() => (data ? lookup(data) : null), [data]);
}
