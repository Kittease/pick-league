/**
 * Tier list of one role: every champion with enough games, scored by its shrunk win-rate delta
 * vs the role average, tiered by score percentile (see `ENGINE_CONFIG.tierList`). A champion's
 * matchups, duos and synergies come from `buildTierListChampion` (fetched when it is selected).
 */
import {
  DEFAULT_TIER_LIST_FILTERS,
  type PatchId,
  type Position,
  type Tier,
  type TierListEntry,
  type TierListFilters,
  type TierListResponse,
} from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import {
  type Blend,
  blendPatches,
  listedGames,
  mixLike,
  type PatchPair,
  patchesUsedFor,
  round,
  sampleConfidence,
  shrink,
  sumStats,
  winRate,
} from './math.ts';
import type { GamesWins, RoleStatRow } from './types.ts';

/** stats_champion_bans (stats_tierlist_bans when filtered) */
export interface BanRow {
  patch: PatchId;
  championId: number;
  /** Matches where the champion was banned (filtered: counted players whose match banned it). */
  bans: number;
}

/** stats_patch_matches (stats_tierlist_totals when filtered) */
export interface PatchMatchesRow {
  patch: PatchId;
  /** Ban rate denominator: matches (filtered: counted players). */
  matches: number;
}

export interface TierListData {
  currentPatch: PatchId;
  previousPatch: PatchId | null;
  /**
   * Champions changed (or new) on the current patch, from the game files (patch_changes): their own
   * strength takes the previous patch as a smaller prior (`previousPatchPrior.changedStrength`).
   */
  changedChampions?: ReadonlySet<number>;
  /** stats_champion_roles of the patches (at least the requested role). */
  roleStats: readonly RoleStatRow[];
  bans: readonly BanRow[];
  patchMatches: readonly PatchMatchesRow[];
}

const TL = ENGINE_CONFIG.tierList;
const K = ENGINE_CONFIG.picks.shrinkK;
const PRIOR = ENGINE_CONFIG.previousPatchPrior;

/**
 * Tier of each score (same order as `scores`, expected sorted descending), from its midpoint
 * percentile rank. Equal scores share the tier of the first one; non-positive scores are capped.
 */
export function assignTiers(scores: readonly number[]): Tier[] {
  const n = scores.length;
  const bounds: [Tier, number][] = [
    ['S', TL.tierPercentiles.S],
    ['A', TL.tierPercentiles.A],
    ['B', TL.tierPercentiles.B],
    ['C', TL.tierPercentiles.C],
  ];
  const order: Tier[] = ['S', 'A', 'B', 'C', 'D'];
  const capIndex = order.indexOf(TL.nonPositiveBestTier as Tier);
  const out: Tier[] = [];
  let firstOfTie = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && scores[i] !== scores[i - 1]) firstOfTie = i;
    const pct = (firstOfTie + 0.5) / n;
    let tier: Tier = bounds.find(([, b]) => pct <= b)?.[0] ?? 'D';
    if ((scores[i] ?? 0) <= 0 && order.indexOf(tier) < capIndex) tier = order[capIndex] as Tier;
    out.push(tier);
  }
  return out;
}

export interface ChampionBaseline {
  /** `patchesUsed` of the champion+role. */
  patches: PatchId[];
  /** Effective games (not rounded) and the blended win rate. */
  games: number;
  winRate: number;
  /** Win rate minus the role average, computed per patch then blended (not shrunk). */
  delta: number;
  blend: Blend;
}

/**
 * A champion+role's record on the two patches, the previous one as a prior worth at most
 * `previousPatchPrior.strength` games (`changedStrength` when the champion changed on the current
 * patch, see `PatchPair.changedChampions`): the same blend for its tier list entry, its detail and the
 * picks engine. The strength is measured inside each patch (vs that patch's role average), so a
 * patch where the whole role wins more does not leak into it.
 */
export function championBaseline(
  patches: PatchPair,
  rows: ReadonlyMap<string, GamesWins>,
  roleWinRate: (patch: PatchId) => number,
  championId: number,
): ChampionBaseline {
  const cur = rows.get(`${patches.current}|${championId}`);
  const prev = patches.previous ? rows.get(`${patches.previous}|${championId}`) : undefined;
  const sample = (r: GamesWins | undefined, patch: PatchId | null) =>
    r && patch !== null && r.games > 0
      ? { value: winRate(r) - roleWinRate(patch), games: r.games }
      : undefined;
  const blend = blendPatches(
    sample(cur, patches.current),
    sample(prev, patches.previous),
    patches.changedChampions?.has(championId) ? PRIOR.changedStrength : PRIOR.strength,
  );
  return {
    patches: patchesUsedFor(patches, blend.previousShare),
    games: blend.games,
    winRate: mixLike(blend, winRate(cur), winRate(prev)),
    delta: blend.value,
    blend,
  };
}

/** `${patch}|${championId}` → stats of the role's rows. */
export function rowsByPatchAndChampion(
  roleStats: readonly RoleStatRow[],
  role: Position,
): Map<string, RoleStatRow> {
  return new Map(
    roleStats.filter((r) => r.position === role).map((r) => [`${r.patch}|${r.championId}`, r]),
  );
}

/** `data` is already restricted to `filters` (the server/rank filters only change the rows). */
export function buildTierList(
  role: Position,
  data: TierListData,
  filters: TierListFilters = DEFAULT_TIER_LIST_FILTERS,
): TierListResponse {
  const { currentPatch, previousPatch, changedChampions } = data;
  const inRole = data.roleStats.filter((r) => r.position === role);
  const roleTotals = new Map<PatchId, GamesWins>();
  for (const p of [currentPatch, previousPatch])
    if (p) roleTotals.set(p, sumStats(inRole.filter((r) => r.patch === p)));

  const row = rowsByPatchAndChampion(inRole, role);
  const bans = new Map(data.bans.map((b) => [`${b.patch}|${b.championId}`, b.bans]));
  const matches = new Map(data.patchMatches.map((m) => [m.patch, m.matches]));

  const roleWinRate = (p: PatchId) => winRate(roleTotals.get(p));
  const pair: PatchPair = { current: currentPatch, previous: previousPatch, changedChampions };

  const scored: Omit<TierListEntry, 'tier'>[] = [];
  for (const championId of new Set(inRole.map((r) => r.championId))) {
    const b = championBaseline(pair, row, roleWinRate, championId);
    if (b.games < ENGINE_CONFIG.minCandidateGames) continue;
    // Rates weight the previous patch like the champion's games: its share of the role's games
    // and of the matches is counted with the same weight on both sides of the division.
    const w = b.blend.previousWeight;
    const weighted = (get: (p: PatchId) => number | undefined) =>
      (get(currentPatch) ?? 0) + (previousPatch && w > 0 ? w * (get(previousPatch) ?? 0) : 0);
    const roleGames = weighted((p) => roleTotals.get(p)?.games);
    const patchMatches = weighted((p) => matches.get(p));
    const banned = weighted((p) => bans.get(`${p}|${championId}`));

    scored.push({
      championId,
      score: round(shrink(b.delta, b.games, K.base), 5),
      winRate: round(b.winRate),
      games: listedGames(b.blend, b.patches),
      // Share of matches where the champion is picked in this role: the role's games are two per
      // match (one per team). Also right under server/rank filters, where `patchMatches` counts
      // players of every role, not matches.
      pickRate: roleGames > 0 ? round((2 * b.games) / roleGames) : 0,
      banRate: patchMatches > 0 ? round(banned / patchMatches) : 0,
      confidence: round(sampleConfidence(b.games, ENGINE_CONFIG.confidenceK.base), 3),
      patchesUsed: b.patches,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.games - a.games || a.championId - b.championId);
  const tiers = assignTiers(scored.map((e) => e.score));
  return {
    role,
    patch: currentPatch,
    filters: { ...filters },
    roleGames: roleTotals.get(currentPatch)?.games ?? 0,
    entries: scored.map((e, i) => ({ ...e, tier: tiers[i] ?? 'D' })),
  };
}
