import { type PatchId, type StaticPatchData, sortPatchesDesc } from '@pick-league/shared';
import { inTransaction, type Queryable } from '../client.ts';
import type { PatchRow } from '../types.ts';

/**
 * Inserts the patch (or updates its Data Dragon version, e.g. 15.22.1 → 15.22.2) and replaces
 * all of its static data (champions + spells, items, rune trees + runes, summoner spells)
 * in one transaction. Idempotent.
 */
export async function upsertPatchStaticData(q: Queryable, data: StaticPatchData): Promise<void> {
  await inTransaction(q, async (tx) => {
    await tx`
      INSERT INTO patches (id, ddragon_version)
      VALUES (${data.patch}, ${data.ddragonVersion})
      ON CONFLICT (id) DO UPDATE SET ddragon_version = EXCLUDED.ddragon_version`;

    await tx`DELETE FROM champions WHERE patch = ${data.patch}`;
    await tx`DELETE FROM items WHERE patch = ${data.patch}`;
    await tx`DELETE FROM rune_trees WHERE patch = ${data.patch}`;
    await tx`DELETE FROM summoner_spells WHERE patch = ${data.patch}`;

    const patch = data.patch;
    if (data.champions.length > 0) {
      await tx`INSERT INTO champions ${tx(
        data.champions.map((c) => ({
          patch,
          id: c.id,
          slug: c.slug,
          name: c.name,
          tags: c.tags,
          attack_range: c.attackRange,
          info: tx.json({ ...c.info }),
        })),
      )}`;
      const spells = data.champions.flatMap((c) =>
        c.spells.map((s) => ({
          patch,
          champion_id: c.id,
          slot: s.slot,
          name: s.name,
          image: s.image,
        })),
      );
      if (spells.length > 0) await tx`INSERT INTO champion_spells ${tx(spells)}`;
    }
    if (data.items.length > 0) {
      await tx`INSERT INTO items ${tx(
        data.items.map((i) => ({
          patch,
          id: i.id,
          name: i.name,
          gold_total: i.goldTotal,
          tags: i.tags,
          builds_from: i.buildsFrom,
          builds_into: i.buildsInto,
          is_boots: i.isBoots,
          is_completed: i.isCompleted,
          is_consumable: i.isConsumable,
          stats: tx.json(i.stats),
        })),
      )}`;
    }
    if (data.runeTrees.length > 0) {
      await tx`INSERT INTO rune_trees ${tx(data.runeTrees.map((t) => ({ patch, id: t.id, name: t.name, icon: t.icon })))}`;
    }
    if (data.runes.length > 0) {
      await tx`INSERT INTO runes ${tx(
        data.runes.map((r) => ({
          patch,
          id: r.id,
          tree_id: r.treeId,
          row: r.row,
          name: r.name,
          icon: r.icon,
        })),
      )}`;
    }
    if (data.summonerSpells.length > 0) {
      await tx`INSERT INTO summoner_spells ${tx(
        data.summonerSpells.map((s) => ({ patch, id: s.id, name: s.name, image: s.image })),
      )}`;
    }
  });
}

/** Kept patches, newest first. */
export async function listPatches(q: Queryable): Promise<PatchRow[]> {
  const rows = await q<{ id: string; ddragon_version: string; detected_at: Date }[]>`
    SELECT id, ddragon_version, detected_at FROM patches`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return sortPatchesDesc(rows.map((r) => r.id)).map((id) => {
    const r = byId.get(id) as (typeof rows)[number];
    return { id: r.id, ddragonVersion: r.ddragon_version, detectedAt: r.detected_at };
  });
}

/** Newest kept patch, or null when none was ingested yet. */
export async function getLatestPatch(q: Queryable): Promise<PatchRow | null> {
  return (await listPatches(q))[0] ?? null;
}

export async function patchExists(q: Queryable, patch: PatchId): Promise<boolean> {
  const [row] = await q`SELECT 1 FROM patches WHERE id = ${patch}`;
  return row !== undefined;
}
