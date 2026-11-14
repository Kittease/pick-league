/**
 * Normalised Data Dragon data → the `GET /static/:patch` response shape. Used as a fallback
 * when the API is unreachable (so champion select still shows icons).
 */

import {
  ddragonChampionIconUrl,
  ddragonItemIconUrl,
  ddragonRuneIconUrl,
  ddragonSpellImageUrl,
  STAT_SHARD_ROWS,
  STAT_SHARDS,
  type StaticDataResponse,
  type StaticPatchData,
  type StaticStatShardDto,
  type StatShardRow,
} from '@pick-league/shared';

export function staticResponseFromDdragon(data: StaticPatchData): StaticDataResponse {
  const v = data.ddragonVersion;
  const statShards = Object.fromEntries(
    STAT_SHARD_ROWS.map((row) => [
      row,
      STAT_SHARDS[row].map((s) => ({
        id: s.id,
        name: s.name,
        iconUrl: ddragonRuneIconUrl(s.icon),
      })),
    ]),
  ) as Record<StatShardRow, StaticStatShardDto[]>;
  return {
    patch: data.patch,
    ddragonVersion: v,
    champions: data.champions
      .map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        tags: c.tags,
        attackRange: c.attackRange,
        info: c.info,
        iconUrl: ddragonChampionIconUrl(v, c.slug),
        spells: c.spells.map((s) => ({
          slot: s.slot,
          name: s.name,
          iconUrl: ddragonSpellImageUrl(v, s.image),
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    items: data.items.map((i) => ({ ...i, iconUrl: ddragonItemIconUrl(v, i.id) })),
    runeTrees: data.runeTrees.map((t) => ({ ...t, iconUrl: ddragonRuneIconUrl(t.icon) })),
    runes: data.runes.map((r) => ({ ...r, iconUrl: ddragonRuneIconUrl(r.icon) })),
    statShards,
    summonerSpells: data.summonerSpells.map((s) => ({
      ...s,
      iconUrl: ddragonSpellImageUrl(v, s.image),
    })),
  };
}
