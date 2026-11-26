/**
 * Reads the stats materialized views and static tables. All lookups are on the views' unique
 * indexes (patch + role/champion prefixes), so they stay fast at ~150k matches per patch.
 * Loaders that return no `patch` column (the build's) sum their rows over the patches given, each
 * patch's rows multiplied by its weight (`PatchWeight`: the previous patch weighted by
 * `previousPatchPrior.build`): games are rounded and wins scaled to keep the weighted win rate.
 *
 * Champion ids are `smallint` columns, but requests may carry any positive integer (the desktop
 * forwards ids from the League client). Every loader drops ids outside the column range first
 * (`storedChampionIds` / `isStoredChampionId`): they match no row, as an unknown champion would,
 * instead of failing the query with "out of range for type smallint".
 */
import type { Queryable } from '@pick-league/db';
import type { CompTrait, PatchId, Platform, Position } from '@pick-league/shared';
import type { SideRow } from '../engine/draft.ts';
import type { BanRow, PatchMatchesRow } from '../engine/tierlist.ts';
import type {
  ChampionTraitRow,
  ChoiceDuoRow,
  ChoiceKind,
  ChoiceMatchupRow,
  ChoiceRow,
  ChoiceTraitRow,
  CompSide,
  CompThresholdRow,
  CompTraitRow,
  GameLengthRow,
  ItemInfo,
  ItemSwapRow,
  LanePhaseRow,
  MasteryRow,
  NameLookup,
  RoleStatRow,
  VsRow,
  WithRow,
} from '../engine/types.ts';

/** Largest value of the `smallint` champion id columns. */
export const MAX_STORED_CHAMPION_ID = 32_767;

/** Whether `id` can be a stored champion id (ids outside the column range match no row). */
export function isStoredChampionId(id: number): boolean {
  return Number.isInteger(id) && id > 0 && id <= MAX_STORED_CHAMPION_ID;
}

/** `ids` without the ones that cannot be stored (see `isStoredChampionId`). */
export function storedChampionIds(ids: readonly number[]): number[] {
  return ids.filter(isStoredChampionId);
}

export async function loadRoleStats(q: Queryable, patches: PatchId[]): Promise<RoleStatRow[]> {
  const rows = await q<
    { patch: string; champion_id: number; position: Position; games: number; wins: number }[]
  >`
    SELECT patch, champion_id, position, games, wins FROM stats_champion_roles WHERE patch IN ${q(patches)}`;
  return rows.map((r) => ({
    patch: r.patch,
    championId: r.champion_id,
    position: r.position,
    games: r.games,
    wins: r.wins,
  }));
}

/** Champions in `position` vs the given enemies (any enemy role). */
export async function loadVsByEnemies(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  enemyIdsIn: number[],
): Promise<VsRow[]> {
  const enemyIds = storedChampionIds(enemyIdsIn);
  if (enemyIds.length === 0) return [];
  const rows = await q<
    {
      patch: string;
      position: Position;
      champion_id: number;
      enemy_position: Position;
      enemy_id: number;
      games: number;
      wins: number;
    }[]
  >`
    SELECT patch, position, champion_id, enemy_position, enemy_id, games, wins
    FROM stats_champion_vs
    WHERE patch IN ${q(patches)} AND position = ${position} AND enemy_id IN ${q(enemyIds)}`;
  return rows.map((r) => ({
    patch: r.patch,
    position: r.position,
    championId: r.champion_id,
    enemyPosition: r.enemy_position,
    enemyId: r.enemy_id,
    games: r.games,
    wins: r.wins,
  }));
}

export async function loadWithByAllies(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  allyIdsIn: number[],
): Promise<WithRow[]> {
  const allyIds = storedChampionIds(allyIdsIn);
  if (allyIds.length === 0) return [];
  const rows = await q<
    {
      patch: string;
      position: Position;
      champion_id: number;
      ally_position: Position;
      ally_id: number;
      games: number;
      wins: number;
    }[]
  >`
    SELECT patch, position, champion_id, ally_position, ally_id, games, wins
    FROM stats_champion_with
    WHERE patch IN ${q(patches)} AND position = ${position} AND ally_id IN ${q(allyIds)}`;
  return rows.map((r) => ({
    patch: r.patch,
    position: r.position,
    championId: r.champion_id,
    allyPosition: r.ally_position,
    allyId: r.ally_id,
    games: r.games,
    wins: r.wins,
  }));
}

/** Comp-trait rows for a role (optionally one champion and one side). */
export async function loadCompTraits(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  championId?: number,
  side?: CompSide,
): Promise<CompTraitRow[]> {
  if (championId !== undefined && !isStoredChampionId(championId)) return [];
  const rows = await q<
    {
      patch: string;
      position: Position;
      champion_id: number;
      side: CompSide;
      trait: CompTrait;
      games: number;
      wins: number;
    }[]
  >`
    SELECT patch, position, champion_id, side, trait, games, wins
    FROM stats_champion_comp_traits
    WHERE patch IN ${q(patches)} AND position = ${position}
      ${championId !== undefined ? q`AND champion_id = ${championId}` : q``}
      ${side !== undefined ? q`AND side = ${side}` : q``}`;
  return rows.map((r) => ({
    patch: r.patch,
    position: r.position,
    championId: r.champion_id,
    side: r.side,
    trait: r.trait,
    games: r.games,
    wins: r.wins,
  }));
}

export async function loadChampionTraits(
  q: Queryable,
  patches: PatchId[],
  championIdsIn: number[],
): Promise<ChampionTraitRow[]> {
  const championIds = storedChampionIds(championIdsIn);
  if (championIds.length === 0) return [];
  const rows = await q<
    {
      patch: string;
      champion_id: number;
      games: number;
      physical_share: number;
      magic_share: number;
      true_share: number;
      damage_per_min: number;
      cc_per_min: number;
      healing_per_min: number;
      tankiness_per_min: number;
      attack_range: number;
      is_ranged: boolean;
    }[]
  >`
    SELECT * FROM stats_champion_traits
    WHERE patch IN ${q(patches)} AND champion_id IN ${q(championIds)}`;
  return rows.map((r) => ({
    patch: r.patch,
    championId: r.champion_id,
    games: r.games,
    physicalShare: r.physical_share,
    magicShare: r.magic_share,
    trueShare: r.true_share,
    damagePerMin: r.damage_per_min,
    ccPerMin: r.cc_per_min,
    healingPerMin: r.healing_per_min,
    tankinessPerMin: r.tankiness_per_min,
    attackRange: r.attack_range,
    isRanged: r.is_ranged,
  }));
}

export async function loadThresholds(
  q: Queryable,
  patches: PatchId[],
): Promise<CompThresholdRow[]> {
  const rows = await q<
    {
      patch: string;
      teams: number;
      physical_share: number;
      magic_share: number;
      cc_per_min: number;
      healing_per_min: number;
      tankiness_per_min: number;
      ranged: number;
      melee: number;
    }[]
  >`SELECT * FROM stats_comp_thresholds WHERE patch IN ${q(patches)}`;
  return rows.map((r) => ({
    patch: r.patch,
    teams: r.teams,
    physicalShare: r.physical_share,
    magicShare: r.magic_share,
    ccPerMin: r.cc_per_min,
    healingPerMin: r.healing_per_min,
    tankinessPerMin: r.tankiness_per_min,
    ranged: r.ranged,
    melee: r.melee,
  }));
}

/** A patch whose rows are summed with a weight (1 = fully). */
export interface PatchWeight {
  patch: PatchId;
  weight: number;
}

export async function loadChoices(
  q: Queryable,
  weights: readonly PatchWeight[],
  championId: number,
  position: Position,
): Promise<ChoiceRow[]> {
  if (!isStoredChampionId(championId) || weights.length === 0) return [];
  const rows = await q<
    { kind: ChoiceKind; choice: string; games: number; wins: number; avg_pos: number | null }[]
  >`
    -- wins scaled so that wins / games is exactly the weighted win rate after rounding the games
    SELECT s.kind, s.choice, round(sum(s.games * pw.weight))::int AS games,
           (sum(s.wins * pw.weight) * round(sum(s.games * pw.weight))
             / nullif(sum(s.games * pw.weight), 0))::float8 AS wins,
           (sum(s.avg_pos * s.games * pw.weight)
             / nullif(sum(s.games * pw.weight) FILTER (WHERE s.avg_pos IS NOT NULL), 0))::float8
             AS avg_pos
    FROM stats_choices s
    JOIN unnest(${weights.map((w) => w.patch)}::text[], ${weights.map((w) => w.weight)}::float8[])
           AS pw(patch, weight) ON pw.patch = s.patch
    WHERE s.champion_id = ${championId} AND s.position = ${position}
    GROUP BY s.kind, s.choice
    HAVING round(sum(s.games * pw.weight)) > 0`;
  return rows.map((r) => ({
    kind: r.kind,
    choice: r.choice,
    games: r.games,
    wins: r.wins,
    avgPos: r.avg_pos,
  }));
}

export async function loadChoiceMatchups(
  q: Queryable,
  weights: readonly PatchWeight[],
  championId: number,
  position: Position,
  opponentIdsIn: number[],
): Promise<ChoiceMatchupRow[]> {
  const opponentIds = storedChampionIds(opponentIdsIn);
  if (!isStoredChampionId(championId) || opponentIds.length === 0 || weights.length === 0) {
    return [];
  }
  const rows = await q<
    {
      opponent_id: number;
      opponent_position: Position;
      kind: ChoiceKind;
      choice: string;
      games: number;
      wins: number;
    }[]
  >`
    SELECT s.opponent_id, s.opponent_position, s.kind, s.choice,
           round(sum(s.games * pw.weight))::int AS games,
           (sum(s.wins * pw.weight) * round(sum(s.games * pw.weight))
             / nullif(sum(s.games * pw.weight), 0))::float8 AS wins
    FROM stats_choice_matchups s
    JOIN unnest(${weights.map((w) => w.patch)}::text[], ${weights.map((w) => w.weight)}::float8[])
           AS pw(patch, weight) ON pw.patch = s.patch
    WHERE s.champion_id = ${championId} AND s.position = ${position}
      AND s.opponent_id IN ${q(opponentIds)}
    GROUP BY s.opponent_id, s.opponent_position, s.kind, s.choice
    HAVING round(sum(s.games * pw.weight)) > 0`;
  return rows.map((r) => ({
    opponentId: r.opponent_id,
    opponentPosition: r.opponent_position,
    kind: r.kind,
    choice: r.choice,
    games: r.games,
    wins: r.wins,
  }));
}

export async function loadChoiceTraits(
  q: Queryable,
  weights: readonly PatchWeight[],
  championId: number,
  position: Position,
  traits: CompTrait[],
): Promise<ChoiceTraitRow[]> {
  if (!isStoredChampionId(championId) || traits.length === 0 || weights.length === 0) return [];
  const rows = await q<
    { trait: CompTrait; kind: ChoiceKind; choice: string; games: number; wins: number }[]
  >`
    SELECT s.trait, s.kind, s.choice, round(sum(s.games * pw.weight))::int AS games,
           (sum(s.wins * pw.weight) * round(sum(s.games * pw.weight))
             / nullif(sum(s.games * pw.weight), 0))::float8 AS wins
    FROM stats_choice_traits s
    JOIN unnest(${weights.map((w) => w.patch)}::text[], ${weights.map((w) => w.weight)}::float8[])
           AS pw(patch, weight) ON pw.patch = s.patch
    WHERE s.champion_id = ${championId} AND s.position = ${position}
      AND s.trait IN ${q(traits)}
    GROUP BY s.trait, s.kind, s.choice
    HAVING round(sum(s.games * pw.weight)) > 0`;
  return rows.map((r) => ({
    trait: r.trait,
    kind: r.kind,
    choice: r.choice,
    games: r.games,
    wins: r.wins,
  }));
}

/** Item choices of champion + role with the given duo partners (stats_choice_duos, summed). */
export async function loadChoiceDuos(
  q: Queryable,
  weights: readonly PatchWeight[],
  championId: number,
  position: Position,
  partnerIdsIn: number[],
): Promise<ChoiceDuoRow[]> {
  const partnerIds = storedChampionIds(partnerIdsIn);
  if (!isStoredChampionId(championId) || partnerIds.length === 0 || weights.length === 0) {
    return [];
  }
  const rows = await q<
    {
      partner_id: number;
      partner_position: Position;
      kind: ChoiceKind;
      choice: string;
      games: number;
      wins: number;
    }[]
  >`
    SELECT s.partner_id, s.partner_position, s.kind, s.choice,
           round(sum(s.games * pw.weight))::int AS games,
           (sum(s.wins * pw.weight) * round(sum(s.games * pw.weight))
             / nullif(sum(s.games * pw.weight), 0))::float8 AS wins
    FROM stats_choice_duos s
    JOIN unnest(${weights.map((w) => w.patch)}::text[], ${weights.map((w) => w.weight)}::float8[])
           AS pw(patch, weight) ON pw.patch = s.patch
    WHERE s.champion_id = ${championId} AND s.position = ${position}
      AND s.partner_id IN ${q(partnerIds)}
    GROUP BY s.partner_id, s.partner_position, s.kind, s.choice
    HAVING round(sum(s.games * pw.weight)) > 0`;
  return rows.map((r) => ({
    partnerId: r.partner_id,
    partnerPosition: r.partner_position,
    kind: r.kind,
    choice: r.choice,
    games: r.games,
    wins: r.wins,
  }));
}

/** Item choices of champion + role when the allies have a trait (stats_choice_ally_traits, summed). */
export async function loadChoiceAllyTraits(
  q: Queryable,
  weights: readonly PatchWeight[],
  championId: number,
  position: Position,
  traits: CompTrait[],
): Promise<ChoiceTraitRow[]> {
  if (!isStoredChampionId(championId) || traits.length === 0 || weights.length === 0) return [];
  const rows = await q<
    { trait: CompTrait; kind: ChoiceKind; choice: string; games: number; wins: number }[]
  >`
    SELECT s.trait, s.kind, s.choice, round(sum(s.games * pw.weight))::int AS games,
           (sum(s.wins * pw.weight) * round(sum(s.games * pw.weight))
             / nullif(sum(s.games * pw.weight), 0))::float8 AS wins
    FROM stats_choice_ally_traits s
    JOIN unnest(${weights.map((w) => w.patch)}::text[], ${weights.map((w) => w.weight)}::float8[])
           AS pw(patch, weight) ON pw.patch = s.patch
    WHERE s.champion_id = ${championId} AND s.position = ${position}
      AND s.trait IN ${q(traits)}
    GROUP BY s.trait, s.kind, s.choice
    HAVING round(sum(s.games * pw.weight)) > 0`;
  return rows.map((r) => ({
    trait: r.trait,
    kind: r.kind,
    choice: r.choice,
    games: r.games,
    wins: r.wins,
  }));
}

/**
 * stats_champion_with of one champion + role with the given allies, summed over the weighted
 * patches (index stats_champion_with_champion).
 */
export async function loadWithForChampion(
  q: Queryable,
  weights: readonly PatchWeight[],
  championId: number,
  position: Position,
  allyIdsIn: number[],
): Promise<WithRow[]> {
  const allyIds = storedChampionIds(allyIdsIn);
  if (!isStoredChampionId(championId) || allyIds.length === 0 || weights.length === 0) return [];
  const rows = await q<{ ally_position: Position; ally_id: number; games: number; wins: number }[]>`
    SELECT s.ally_position, s.ally_id, round(sum(s.games * pw.weight))::int AS games,
           (sum(s.wins * pw.weight) * round(sum(s.games * pw.weight))
             / nullif(sum(s.games * pw.weight), 0))::float8 AS wins
    FROM stats_champion_with s
    JOIN unnest(${weights.map((w) => w.patch)}::text[], ${weights.map((w) => w.weight)}::float8[])
           AS pw(patch, weight) ON pw.patch = s.patch
    WHERE s.champion_id = ${championId} AND s.position = ${position}
      AND s.ally_id IN ${q(allyIds)}
    GROUP BY s.ally_position, s.ally_id
    HAVING round(sum(s.games * pw.weight)) > 0`;
  return rows.map((r) => ({
    patch: weights[0]?.patch as PatchId, // summed over the patches: labelled with the newest
    position,
    championId,
    allyPosition: r.ally_position,
    allyId: r.ally_id,
    games: r.games,
    wins: r.wins,
  }));
}

export async function loadVsForChampion(
  q: Queryable,
  weights: readonly PatchWeight[],
  championId: number,
  position: Position,
  enemyIdsIn: number[],
): Promise<VsRow[]> {
  const enemyIds = storedChampionIds(enemyIdsIn);
  if (!isStoredChampionId(championId) || enemyIds.length === 0 || weights.length === 0) return [];
  const rows = await q<
    { enemy_position: Position; enemy_id: number; games: number; wins: number }[]
  >`
    SELECT s.enemy_position, s.enemy_id, round(sum(s.games * pw.weight))::int AS games,
           (sum(s.wins * pw.weight) * round(sum(s.games * pw.weight))
             / nullif(sum(s.games * pw.weight), 0))::float8 AS wins
    FROM stats_champion_vs s
    JOIN unnest(${weights.map((w) => w.patch)}::text[], ${weights.map((w) => w.weight)}::float8[])
           AS pw(patch, weight) ON pw.patch = s.patch
    WHERE s.position = ${position} AND s.champion_id = ${championId}
      AND s.enemy_id IN ${q(enemyIds)}
    GROUP BY s.enemy_position, s.enemy_id
    HAVING round(sum(s.games * pw.weight)) > 0`;
  return rows.map((r) => ({
    patch: weights[0]?.patch as PatchId, // summed over the patches: labelled with the newest
    position,
    championId,
    enemyPosition: r.enemy_position,
    enemyId: r.enemy_id,
    games: r.games,
    wins: r.wins,
  }));
}

interface LanePhaseDbRow {
  patch: string;
  position: Position;
  champion_id: number;
  enemy_position: Position;
  enemy_id: number;
  games: number;
  gold_diff_10: number;
  xp_diff_10: number;
  cs_diff_10: number;
  games_15: number;
  gold_diff_15: number | null;
  xp_diff_15: number | null;
  cs_diff_15: number | null;
}

const toLanePhaseRow = (r: LanePhaseDbRow): LanePhaseRow => ({
  patch: r.patch,
  position: r.position,
  championId: r.champion_id,
  enemyPosition: r.enemy_position,
  enemyId: r.enemy_id,
  games: r.games,
  goldDiff10: r.gold_diff_10,
  xpDiff10: r.xp_diff_10,
  csDiff10: r.cs_diff_10,
  games15: r.games_15,
  goldDiff15: r.gold_diff_15,
  xpDiff15: r.xp_diff_15,
  csDiff15: r.cs_diff_15,
});

/**
 * Lane-phase rows (stats_champion_lane_phase, per patch) of every champion in `position` vs
 * the given enemies (picks: candidates vs the lane opponent). Unique index prefix
 * (patch, position, enemy_id).
 */
export async function loadLanePhaseByEnemies(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  enemyIdsIn: number[],
): Promise<LanePhaseRow[]> {
  const enemyIds = storedChampionIds(enemyIdsIn);
  if (enemyIds.length === 0) return [];
  const rows = await q<LanePhaseDbRow[]>`
    SELECT * FROM stats_champion_lane_phase
    WHERE patch IN ${q(patches)} AND position = ${position} AND enemy_id IN ${q(enemyIds)}`;
  return rows.map(toLanePhaseRow);
}

/**
 * Lane-phase rows (per patch) of one champion in `position`, vs every lane opponent or only
 * `enemyIds` (build). Index stats_champion_lane_phase_champion (patch, champion_id, position).
 */
export async function loadLanePhaseOfChampion(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  championId: number,
  enemyIdsIn?: number[],
): Promise<LanePhaseRow[]> {
  const enemyIds = enemyIdsIn && storedChampionIds(enemyIdsIn);
  if (!isStoredChampionId(championId) || enemyIds?.length === 0) return [];
  const rows = await q<LanePhaseDbRow[]>`
    SELECT * FROM stats_champion_lane_phase
    WHERE patch IN ${q(patches)} AND champion_id = ${championId} AND position = ${position}
      ${enemyIds ? q`AND enemy_id IN ${q(enemyIds)}` : q``}`;
  return rows.map(toLanePhaseRow);
}

/**
 * Late-game swaps of champion + role (stats_item_swaps, 0022) per patch: completed item sold at
 * full build → completed item bought in its place.
 */
export async function loadItemSwaps(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  championId: number,
): Promise<ItemSwapRow[]> {
  if (!isStoredChampionId(championId)) return [];
  const rows = await q<
    {
      patch: string;
      sold_item_id: number;
      bought_item_id: number;
      games: number;
      minute_sum: number;
    }[]
  >`
    SELECT patch, sold_item_id, bought_item_id, games, minute_sum FROM stats_item_swaps
    WHERE patch IN ${q(patches)} AND position = ${position} AND champion_id = ${championId}`;
  return rows.map((r) => ({
    patch: r.patch,
    soldItemId: r.sold_item_id,
    boughtItemId: r.bought_item_id,
    games: r.games,
    minuteSum: r.minute_sum,
  }));
}

export async function loadItems(q: Queryable, patch: PatchId): Promise<Map<number, ItemInfo>> {
  const rows = await q<
    { id: number; name: string; tags: string[]; is_boots: boolean; is_completed: boolean }[]
  >`SELECT id, name, tags, is_boots, is_completed FROM items WHERE patch = ${patch}`;
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, name: r.name, tags: r.tags, isBoots: r.is_boots, isCompleted: r.is_completed },
    ]),
  );
}

/** Display names, newest patch first (an id missing from it falls back to older patches). */
export async function loadNames(q: Queryable, patches: PatchId[]): Promise<NameLookup> {
  const [champions, items, runes, spells] = await Promise.all([
    q<
      { patch: string; id: number; name: string }[]
    >`SELECT patch, id, name FROM champions WHERE patch IN ${q(patches)}`,
    q<
      { patch: string; id: number; name: string }[]
    >`SELECT patch, id, name FROM items WHERE patch IN ${q(patches)}`,
    q<
      { patch: string; id: number; name: string }[]
    >`SELECT patch, id, name FROM runes WHERE patch IN ${q(patches)}`,
    q<
      { patch: string; id: number; name: string }[]
    >`SELECT patch, id, name FROM summoner_spells WHERE patch IN ${q(patches)}`,
  ]);
  const index = (rows: { patch: string; id: number; name: string }[]) => {
    const m = new Map<number, string>();
    for (const p of [...patches].reverse())
      for (const r of rows) if (r.patch === p) m.set(r.id, r.name);
    return m;
  };
  const c = index(champions);
  const i = index(items);
  const r = index(runes);
  const s = index(spells);
  return {
    champion: (id) => c.get(id) ?? `Champion ${id}`,
    item: (id) => i.get(id) ?? `Item ${id}`,
    rune: (id) => r.get(id) ?? `Rune ${id}`,
    summonerSpell: (id) => s.get(id) ?? `Spell ${id}`,
  };
}

export async function championExists(
  q: Queryable,
  patches: PatchId[],
  championId: number,
): Promise<boolean> {
  if (!isStoredChampionId(championId)) return false;
  const [row] =
    await q`SELECT 1 FROM champions WHERE patch IN ${q(patches)} AND id = ${championId} LIMIT 1`;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Tier list
// ---------------------------------------------------------------------------

/** One champion in `position` vs enemies in `enemyPositions` (lane opponents), per patch. */
export async function loadLaneVsOfChampion(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  championId: number,
  enemyPositions: readonly Position[],
): Promise<VsRow[]> {
  if (!isStoredChampionId(championId)) return [];
  const rows = await q<
    { patch: string; enemy_position: Position; enemy_id: number; games: number; wins: number }[]
  >`
    SELECT patch, enemy_position, enemy_id, games, wins FROM stats_champion_vs
    WHERE patch IN ${q(patches)} AND champion_id = ${championId} AND position = ${position}
      AND enemy_position IN ${q([...enemyPositions])}`;
  return rows.map((r) => ({
    patch: r.patch,
    position,
    championId,
    enemyPosition: r.enemy_position,
    enemyId: r.enemy_id,
    games: r.games,
    wins: r.wins,
  }));
}

/** One champion in `position` with every ally (all roles), per patch. */
export async function loadAlliesOfChampion(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  championId: number,
): Promise<WithRow[]> {
  if (!isStoredChampionId(championId)) return [];
  const rows = await q<
    { patch: string; ally_position: Position; ally_id: number; games: number; wins: number }[]
  >`
    SELECT patch, ally_position, ally_id, games, wins FROM stats_champion_with
    WHERE patch IN ${q(patches)} AND position = ${position} AND champion_id = ${championId}`;
  return rows.map((r) => ({
    patch: r.patch,
    position,
    championId,
    allyPosition: r.ally_position,
    allyId: r.ally_id,
    games: r.games,
    wins: r.wins,
  }));
}

export async function loadBans(q: Queryable, patches: PatchId[]): Promise<BanRow[]> {
  const rows = await q<{ patch: string; champion_id: number; bans: number }[]>`
    SELECT patch, champion_id, bans FROM stats_champion_bans WHERE patch IN ${q(patches)}`;
  return rows.map((r) => ({ patch: r.patch, championId: r.champion_id, bans: r.bans }));
}

export async function loadPatchMatches(
  q: Queryable,
  patches: PatchId[],
): Promise<PatchMatchesRow[]> {
  const rows = await q<{ patch: string; matches: number }[]>`
    SELECT patch, matches FROM stats_patch_matches WHERE patch IN ${q(patches)}`;
  return rows.map((r) => ({ patch: r.patch, matches: r.matches }));
}

// ---------------------------------------------------------------------------
// Tier list filtered by server and rank (0006_tierlist_filters.sql): rows of the matching
// (platform, rank_level) segments summed per key. Same shapes as the unfiltered loaders above.
// ---------------------------------------------------------------------------

/** Segments to sum: one platform (null = every server) and the minimum player rank level. */
export interface TierListSegment {
  platform: Platform | null;
  /** 0 = every player, 1 = Master+, 2 = Grandmaster+, 3 = Challenger (see stats_tierlist_participants). */
  minRankLevel: number;
}

const inSegment = (q: Queryable, s: TierListSegment) =>
  q`${s.platform ? q`AND platform = ${s.platform}` : q``} AND rank_level >= ${s.minRankLevel}`;

/** Champion + role baselines of one role. */
export async function loadSegmentRoleStats(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  segment: TierListSegment,
): Promise<RoleStatRow[]> {
  const rows = await q<{ patch: string; champion_id: number; games: number; wins: number }[]>`
    SELECT patch, champion_id, sum(games)::int AS games, sum(wins)::int AS wins
    FROM stats_tierlist_roles
    WHERE patch IN ${q(patches)} AND position = ${position} ${inSegment(q, segment)}
    GROUP BY patch, champion_id`;
  return rows.map((r) => ({
    patch: r.patch,
    championId: r.champion_id,
    position,
    games: r.games,
    wins: r.wins,
  }));
}

/** Every champion in `position` (or only `championId`) vs lane opponents in `enemyPositions`. */
export async function loadSegmentVsForRole(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  enemyPositions: readonly Position[],
  segment: TierListSegment,
  championId?: number,
): Promise<VsRow[]> {
  if (championId !== undefined && !isStoredChampionId(championId)) return [];
  const rows = await q<
    {
      patch: string;
      champion_id: number;
      enemy_position: Position;
      enemy_id: number;
      games: number;
      wins: number;
    }[]
  >`
    SELECT patch, champion_id, enemy_position, enemy_id,
           sum(games)::int AS games, sum(wins)::int AS wins
    FROM stats_tierlist_vs
    WHERE patch IN ${q(patches)} AND position = ${position}
      AND enemy_position IN ${q([...enemyPositions])} ${inSegment(q, segment)}
      ${championId !== undefined ? q`AND champion_id = ${championId}` : q``}
    GROUP BY patch, champion_id, enemy_position, enemy_id`;
  return rows.map((r) => ({
    patch: r.patch,
    position,
    championId: r.champion_id,
    enemyPosition: r.enemy_position,
    enemyId: r.enemy_id,
    games: r.games,
    wins: r.wins,
  }));
}

/** Every champion in `position` (or only `championId`) with duo partners in `allyPositions`. */
export async function loadSegmentWithForRole(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  allyPositions: readonly Position[],
  segment: TierListSegment,
  championId?: number,
): Promise<WithRow[]> {
  if (championId !== undefined && !isStoredChampionId(championId)) return [];
  const rows = await q<
    {
      patch: string;
      champion_id: number;
      ally_position: Position;
      ally_id: number;
      games: number;
      wins: number;
    }[]
  >`
    SELECT patch, champion_id, ally_position, ally_id,
           sum(games)::int AS games, sum(wins)::int AS wins
    FROM stats_tierlist_with
    WHERE patch IN ${q(patches)} AND position = ${position}
      AND ally_position IN ${q([...allyPositions])} ${inSegment(q, segment)}
      ${championId !== undefined ? q`AND champion_id = ${championId}` : q``}
    GROUP BY patch, champion_id, ally_position, ally_id`;
  return rows.map((r) => ({
    patch: r.patch,
    position,
    championId: r.champion_id,
    allyPosition: r.ally_position,
    allyId: r.ally_id,
    games: r.games,
    wins: r.wins,
  }));
}

/** Ban counts weighted per counted player (`bans` / `loadSegmentTotals` = ban rate). */
export async function loadSegmentBans(
  q: Queryable,
  patches: PatchId[],
  segment: TierListSegment,
): Promise<BanRow[]> {
  const rows = await q<{ patch: string; champion_id: number; bans: number }[]>`
    SELECT patch, champion_id, sum(participants)::int AS bans FROM stats_tierlist_bans
    WHERE patch IN ${q(patches)} ${inSegment(q, segment)}
    GROUP BY patch, champion_id`;
  return rows.map((r) => ({ patch: r.patch, championId: r.champion_id, bans: r.bans }));
}

/** Counted players per patch (ban rate denominator, returned as `matches`). */
export async function loadSegmentTotals(
  q: Queryable,
  patches: PatchId[],
  segment: TierListSegment,
): Promise<PatchMatchesRow[]> {
  const rows = await q<{ patch: string; participants: number }[]>`
    SELECT patch, sum(participants)::int AS participants FROM stats_tierlist_totals
    WHERE patch IN ${q(patches)} ${inSegment(q, segment)}
    GROUP BY patch`;
  return rows.map((r) => ({ patch: r.patch, matches: r.participants }));
}

/**
 * stats_champion_vs rows of every champion of `position` vs `otherId` playing `otherPosition`,
 * for each pair asked (the draft evaluation: both points of view of each ally–enemy pair).
 */
export async function loadVsPairs(
  q: Queryable,
  patches: PatchId[],
  pairs: readonly { position: Position; otherId: number; otherPosition: Position }[],
): Promise<VsRow[]> {
  const kept = uniquePairs(pairs.filter((p) => isStoredChampionId(p.otherId)));
  if (kept.length === 0) return [];
  const rows = await q<
    {
      patch: string;
      position: Position;
      champion_id: number;
      enemy_position: Position;
      enemy_id: number;
      games: number;
      wins: number;
    }[]
  >`
    SELECT v.patch, v.position, v.champion_id, v.enemy_position, v.enemy_id, v.games, v.wins
    FROM unnest(${kept.map((p) => p.position)}::text[], ${kept.map((p) => p.otherId)}::int[],
                ${kept.map((p) => p.otherPosition)}::text[]) AS c(position, other_id, other_position)
    JOIN stats_champion_vs v
      ON v.patch IN ${q(patches)} AND v.position = c.position::"position"
     AND v.enemy_id = c.other_id AND v.enemy_position = c.other_position::"position"`;
  return rows.map((r) => ({
    patch: r.patch,
    position: r.position,
    championId: r.champion_id,
    enemyPosition: r.enemy_position,
    enemyId: r.enemy_id,
    games: r.games,
    wins: r.wins,
  }));
}

/** stats_champion_with rows of every champion of `position` with `otherId` playing `otherPosition`. */
export async function loadWithPairs(
  q: Queryable,
  patches: PatchId[],
  pairs: readonly { position: Position; otherId: number; otherPosition: Position }[],
): Promise<WithRow[]> {
  const kept = uniquePairs(pairs.filter((p) => isStoredChampionId(p.otherId)));
  if (kept.length === 0) return [];
  const rows = await q<
    {
      patch: string;
      position: Position;
      champion_id: number;
      ally_position: Position;
      ally_id: number;
      games: number;
      wins: number;
    }[]
  >`
    SELECT w.patch, w.position, w.champion_id, w.ally_position, w.ally_id, w.games, w.wins
    FROM unnest(${kept.map((p) => p.position)}::text[], ${kept.map((p) => p.otherId)}::int[],
                ${kept.map((p) => p.otherPosition)}::text[]) AS c(position, other_id, other_position)
    JOIN stats_champion_with w
      ON w.patch IN ${q(patches)} AND w.position = c.position::"position"
     AND w.ally_id = c.other_id AND w.ally_position = c.other_position::"position"`;
  return rows.map((r) => ({
    patch: r.patch,
    position: r.position,
    championId: r.champion_id,
    allyPosition: r.ally_position,
    allyId: r.ally_id,
    games: r.games,
    wins: r.wins,
  }));
}

function uniquePairs<T extends { position: Position; otherId: number; otherPosition: Position }>(
  pairs: readonly T[],
): T[] {
  const seen = new Map<string, T>();
  for (const p of pairs) seen.set(`${p.position}|${p.otherId}|${p.otherPosition}`, p);
  return [...seen.values()];
}

/** Results per side and platform (stats_side_wins, 0034): team 100 = blue, 200 = red. */
export async function loadSideWins(q: Queryable, patches: PatchId[]): Promise<SideRow[]> {
  const rows = await q<
    { patch: string; platform: Platform; team_id: number; games: number; wins: number }[]
  >`
    SELECT patch, platform, team_id, games, wins FROM stats_side_wins
    WHERE patch IN ${q(patches)}`;
  return rows.flatMap((r) =>
    r.team_id === 100 || r.team_id === 200
      ? [
          {
            patch: r.patch,
            platform: r.platform,
            side: r.team_id === 100 ? ('blue' as const) : ('red' as const),
            games: r.games,
            wins: r.wins,
          },
        ]
      : [],
  );
}

/**
 * Results by game length (stats_champion_game_length, 0019) per patch, of every role or only
 * `position`: bucket 0 = under 25 min, 1 = 25 to under 32 min, 2 = 32 min or more.
 */
export async function loadGameLength(
  q: Queryable,
  patches: PatchId[],
  position?: Position,
): Promise<GameLengthRow[]> {
  const rows = await q<
    {
      patch: string;
      position: Position;
      champion_id: number;
      bucket: number;
      games: number;
      wins: number;
    }[]
  >`
    SELECT patch, position, champion_id, bucket, games, wins FROM stats_champion_game_length
    WHERE patch IN ${q(patches)} ${position ? q`AND position = ${position}` : q``}`;
  return rows.flatMap((r) =>
    r.bucket === 0 || r.bucket === 1 || r.bucket === 2
      ? [
          {
            patch: r.patch,
            position: r.position,
            championId: r.champion_id,
            bucket: r.bucket,
            games: r.games,
            wins: r.wins,
          },
        ]
      : [],
  );
}

/** Mastery rows (stats_champion_mastery, 0018 / 0035) of every champion and role on `patches`. */
export async function loadMasteryRows(q: Queryable, patches: PatchId[]): Promise<MasteryRow[]> {
  const rows = await q<
    {
      patch: string;
      position: Position;
      champion_id: number;
      bucket: number;
      games: number;
      wins: number;
    }[]
  >`
    SELECT patch, position, champion_id, bucket, games, wins
    FROM stats_champion_mastery WHERE patch IN ${q(patches)}`;
  return rows.map((r) => ({
    patch: r.patch,
    position: r.position,
    championId: r.champion_id,
    bucket: r.bucket,
    games: r.games,
    wins: r.wins,
  }));
}
