/**
 * Reads the stats materialized views and static tables. All lookups are on the views' unique
 * indexes (patch + role/champion prefixes), so they stay fast at ~150k matches per patch.
 * Loaders that return no `patch` column sum their rows over the patches given (see `choosePatches`).
 */
import type { Queryable } from '@pick-league/db';
import type { CompTrait, PatchId, Platform, Position } from '@pick-league/shared';
import type { BanRow, PatchMatchesRow } from '../engine/tierlist.ts';
import type {
  ChampionTraitRow,
  ChoiceKind,
  ChoiceMatchupRow,
  ChoiceRow,
  ChoiceTraitRow,
  CompSide,
  CompThresholdRow,
  CompTraitRow,
  ItemInfo,
  NameLookup,
  RoleStatRow,
  VsRow,
  WithRow,
} from '../engine/types.ts';

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
  enemyIds: number[],
): Promise<VsRow[]> {
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
  allyIds: number[],
): Promise<WithRow[]> {
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
  championIds: number[],
): Promise<ChampionTraitRow[]> {
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

export async function loadChoices(
  q: Queryable,
  patches: PatchId[],
  championId: number,
  position: Position,
): Promise<ChoiceRow[]> {
  const rows = await q<
    { kind: ChoiceKind; choice: string; games: number; wins: number; avg_pos: number | null }[]
  >`
    SELECT kind, choice, sum(games)::int AS games, sum(wins)::int AS wins,
           (sum(avg_pos * games) / nullif(sum(games) FILTER (WHERE avg_pos IS NOT NULL), 0))::float8
             AS avg_pos
    FROM stats_choices
    WHERE patch IN ${q(patches)} AND champion_id = ${championId} AND position = ${position}
    GROUP BY kind, choice`;
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
  patches: PatchId[],
  championId: number,
  position: Position,
  opponentIds: number[],
): Promise<ChoiceMatchupRow[]> {
  if (opponentIds.length === 0) return [];
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
    SELECT opponent_id, opponent_position, kind, choice,
           sum(games)::int AS games, sum(wins)::int AS wins
    FROM stats_choice_matchups
    WHERE patch IN ${q(patches)} AND champion_id = ${championId} AND position = ${position}
      AND opponent_id IN ${q(opponentIds)}
    GROUP BY opponent_id, opponent_position, kind, choice`;
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
  patches: PatchId[],
  championId: number,
  position: Position,
  traits: CompTrait[],
): Promise<ChoiceTraitRow[]> {
  if (traits.length === 0) return [];
  const rows = await q<
    { trait: CompTrait; kind: ChoiceKind; choice: string; games: number; wins: number }[]
  >`
    SELECT trait, kind, choice, sum(games)::int AS games, sum(wins)::int AS wins
    FROM stats_choice_traits
    WHERE patch IN ${q(patches)} AND champion_id = ${championId} AND position = ${position}
      AND trait IN ${q(traits)}
    GROUP BY trait, kind, choice`;
  return rows.map((r) => ({
    trait: r.trait,
    kind: r.kind,
    choice: r.choice,
    games: r.games,
    wins: r.wins,
  }));
}

export async function loadVsForChampion(
  q: Queryable,
  patches: PatchId[],
  championId: number,
  position: Position,
  enemyIds: number[],
): Promise<VsRow[]> {
  if (enemyIds.length === 0) return [];
  const rows = await q<
    { enemy_position: Position; enemy_id: number; games: number; wins: number }[]
  >`
    SELECT enemy_position, enemy_id, sum(games)::int AS games, sum(wins)::int AS wins
    FROM stats_champion_vs
    WHERE patch IN ${q(patches)} AND position = ${position} AND champion_id = ${championId}
      AND enemy_id IN ${q(enemyIds)}
    GROUP BY enemy_position, enemy_id`;
  return rows.map((r) => ({
    patch: patches[0] as PatchId, // summed over `patches`: labelled with the newest
    position,
    championId,
    enemyPosition: r.enemy_position,
    enemyId: r.enemy_id,
    games: r.games,
    wins: r.wins,
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
  const [row] =
    await q`SELECT 1 FROM champions WHERE patch IN ${q(patches)} AND id = ${championId} LIMIT 1`;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Tier list
// ---------------------------------------------------------------------------

/** Every champion in `position` vs enemies in `enemyPositions` (lane opponents). */
export async function loadVsForRole(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  enemyPositions: readonly Position[],
): Promise<VsRow[]> {
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
    SELECT patch, champion_id, enemy_position, enemy_id, games, wins FROM stats_champion_vs
    WHERE patch IN ${q(patches)} AND position = ${position}
      AND enemy_position IN ${q([...enemyPositions])}`;
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

/** Every champion in `position` with allies in `allyPositions` (duo partners). */
export async function loadWithForRole(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  allyPositions: readonly Position[],
): Promise<WithRow[]> {
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
    SELECT patch, champion_id, ally_position, ally_id, games, wins FROM stats_champion_with
    WHERE patch IN ${q(patches)} AND position = ${position}
      AND ally_position IN ${q([...allyPositions])}`;
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
  /** 0 = every player, 1 = Grandmaster+, 2 = Challenger (see stats_tierlist_participants). */
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

/** Every champion in `position` vs lane opponents in `enemyPositions`. */
export async function loadSegmentVsForRole(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  enemyPositions: readonly Position[],
  segment: TierListSegment,
): Promise<VsRow[]> {
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

/** Every champion in `position` with duo partners in `allyPositions`. */
export async function loadSegmentWithForRole(
  q: Queryable,
  patches: PatchId[],
  position: Position,
  allyPositions: readonly Position[],
  segment: TierListSegment,
): Promise<WithRow[]> {
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
