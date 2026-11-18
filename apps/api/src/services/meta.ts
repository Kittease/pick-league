/** /health, /patches and /static/:patch. */
import { listPatches, type Queryable } from '@pick-league/db';
import {
  ddragonChampionIconUrl,
  ddragonItemIconUrl,
  ddragonRuneIconUrl,
  ddragonSpellImageUrl,
  type HealthResponse,
  type PatchesResponse,
  PLATFORMS,
  type Platform,
  STAT_SHARD_ROWS,
  STAT_SHARDS,
  type StaticDataResponse,
  type StaticStatShardDto,
  type StatShardRow,
} from '@pick-league/shared';
import { ApiError } from '../errors.ts';
import { pickStatsPatches, statsPatches } from './stats-patches.ts';

export async function health(q: Queryable): Promise<HealthResponse> {
  try {
    const kept = (await listPatches(q)).map((p) => p.id);
    // The stats views being unreadable must not make the API unhealthy: the newest patch then.
    const stats = await statsPatches(q, kept).catch(() => pickStatsPatches(kept, []));
    const current = stats?.current ?? null;
    const [row] = await q<{ n: number; onPatch: number }[]>`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE patch = ${current ?? ''})::int AS "onPatch"
      FROM matches`;
    return {
      ok: true,
      db: true,
      latestPatch: current,
      matchCount: row?.n ?? 0,
      patchMatchCount: row?.onPatch ?? 0,
    };
  } catch {
    return { ok: false, db: false, latestPatch: null, matchCount: 0, patchMatchCount: 0 };
  }
}

export async function patches(q: Queryable): Promise<PatchesResponse> {
  const [kept, counts] = await Promise.all([
    listPatches(q),
    q<{ patch: string; platform: Platform; n: number }[]>`
      SELECT patch, platform, count(*)::int AS n FROM matches GROUP BY patch, platform`,
  ]);
  return {
    patches: kept.map((p) => {
      const byPlatform = Object.fromEntries(PLATFORMS.map((pl) => [pl, 0])) as Record<
        Platform,
        number
      >;
      for (const c of counts) if (c.patch === p.id) byPlatform[c.platform] = c.n;
      return {
        patch: p.id,
        ddragonVersion: p.ddragonVersion,
        detectedAt: p.detectedAt.toISOString(),
        matchCount: Object.values(byPlatform).reduce((s, n) => s + n, 0),
        matchCountByPlatform: byPlatform,
      };
    }),
  };
}

export async function staticData(q: Queryable, patchParam: string): Promise<StaticDataResponse> {
  const kept = await listPatches(q);
  const patch = patchParam === 'latest' ? kept[0] : kept.find((p) => p.id === patchParam);
  if (!patch) {
    if (patchParam === 'latest') throw new ApiError('NO_DATA', 'No patch ingested yet');
    throw new ApiError('NOT_FOUND', `Unknown patch ${patchParam}`);
  }
  const v = patch.ddragonVersion;
  const [champions, spells, items, trees, runes, summoners] = await Promise.all([
    q<
      {
        id: number;
        slug: string;
        name: string;
        tags: string[];
        attack_range: number;
        info: { attack: number; defense: number; magic: number; difficulty: number };
      }[]
    >`SELECT id, slug, name, tags, attack_range, info FROM champions WHERE patch = ${patch.id} ORDER BY name`,
    q<{ champion_id: number; slot: number; name: string; image: string }[]>`
      SELECT champion_id, slot, name, image FROM champion_spells WHERE patch = ${patch.id} ORDER BY champion_id, slot`,
    q<
      {
        id: number;
        name: string;
        gold_total: number;
        tags: string[];
        builds_from: number[];
        builds_into: number[];
        is_boots: boolean;
        is_completed: boolean;
        is_consumable: boolean;
        stats: Record<string, number>;
      }[]
    >`SELECT id, name, gold_total, tags, builds_from, builds_into, is_boots, is_completed, is_consumable, stats
      FROM items WHERE patch = ${patch.id} ORDER BY id`,
    q<{ id: number; name: string; icon: string }[]>`
      SELECT id, name, icon FROM rune_trees WHERE patch = ${patch.id} ORDER BY id`,
    q<{ id: number; tree_id: number; row: number; name: string; icon: string }[]>`
      SELECT id, tree_id, row, name, icon FROM runes WHERE patch = ${patch.id} ORDER BY tree_id, row, id`,
    q<{ id: number; name: string; image: string }[]>`
      SELECT id, name, image FROM summoner_spells WHERE patch = ${patch.id} ORDER BY id`,
  ]);
  const spellsByChampion = new Map<number, { slot: number; name: string; image: string }[]>();
  for (const s of spells) {
    const list = spellsByChampion.get(s.champion_id) ?? [];
    list.push(s);
    spellsByChampion.set(s.champion_id, list);
  }
  const shard = (row: StatShardRow): StaticStatShardDto[] =>
    STAT_SHARDS[row].map((s) => ({ id: s.id, name: s.name, iconUrl: ddragonRuneIconUrl(s.icon) }));

  return {
    patch: patch.id,
    ddragonVersion: v,
    champions: champions.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      tags: c.tags,
      attackRange: c.attack_range,
      info: c.info,
      iconUrl: ddragonChampionIconUrl(v, c.slug),
      spells: (spellsByChampion.get(c.id) ?? []).map((s) => ({
        slot: s.slot,
        name: s.name,
        iconUrl: ddragonSpellImageUrl(v, s.image),
      })),
    })),
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      goldTotal: i.gold_total,
      tags: i.tags,
      buildsFrom: i.builds_from,
      buildsInto: i.builds_into,
      isBoots: i.is_boots,
      isCompleted: i.is_completed,
      isConsumable: i.is_consumable,
      stats: i.stats,
      iconUrl: ddragonItemIconUrl(v, i.id),
    })),
    runeTrees: trees.map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.icon,
      iconUrl: ddragonRuneIconUrl(t.icon),
    })),
    runes: runes.map((r) => ({
      id: r.id,
      treeId: r.tree_id,
      row: r.row,
      name: r.name,
      icon: r.icon,
      iconUrl: ddragonRuneIconUrl(r.icon),
    })),
    statShards: Object.fromEntries(STAT_SHARD_ROWS.map((row) => [row, shard(row)])) as Record<
      StatShardRow,
      StaticStatShardDto[]
    >,
    summonerSpells: summoners.map((s) => ({
      id: s.id,
      name: s.name,
      image: s.image,
      iconUrl: ddragonSpellImageUrl(v, s.image),
    })),
  };
}
