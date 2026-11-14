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
import { choosePatches, round, sampleConfidence, shrink, sumStats, winRate } from './math.ts';
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
  /** stats_champion_roles of the patches (at least the requested role). */
  roleStats: readonly RoleStatRow[];
  bans: readonly BanRow[];
  patchMatches: readonly PatchMatchesRow[];
}

const TL = ENGINE_CONFIG.tierList;
const K = ENGINE_CONFIG.picks.shrinkK;

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

/**
 * Patches used for a champion+role (`choosePatches`) and its games/wins summed over them: the
 * same choice for its tier list entry and its detail.
 */
export function championBaseline(
  currentPatch: PatchId,
  previousPatch: PatchId | null,
  rows: ReadonlyMap<string, GamesWins>,
  championId: number,
): { patches: PatchId[]; base: GamesWins } {
  const cur = rows.get(`${currentPatch}|${championId}`);
  const prev = previousPatch ? rows.get(`${previousPatch}|${championId}`) : undefined;
  const { patches } = choosePatches(currentPatch, previousPatch, cur?.games ?? 0, prev?.games ?? 0);
  const base = sumStats(patches.flatMap((p) => rows.get(`${p}|${championId}`) ?? []));
  return { patches, base };
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
  const { currentPatch, previousPatch } = data;
  const inRole = data.roleStats.filter((r) => r.position === role);
  const roleTotals = new Map<PatchId, GamesWins>();
  for (const p of [currentPatch, previousPatch])
    if (p) roleTotals.set(p, sumStats(inRole.filter((r) => r.patch === p)));

  const row = rowsByPatchAndChampion(inRole, role);
  const bans = new Map(data.bans.map((b) => [`${b.patch}|${b.championId}`, b.bans]));
  const matches = new Map(data.patchMatches.map((m) => [m.patch, m.matches]));

  const scored: Omit<TierListEntry, 'tier'>[] = [];
  for (const championId of new Set(inRole.map((r) => r.championId))) {
    const { patches, base } = championBaseline(currentPatch, previousPatch, row, championId);
    if (base.games < ENGINE_CONFIG.minCandidateGames) continue;
    const onEach = <T>(get: (p: PatchId) => T | undefined) => patches.flatMap((p) => get(p) ?? []);
    const baseWr = winRate(base);
    const roleTotal = sumStats(onEach((p) => roleTotals.get(p)));
    const score = shrink(baseWr - winRate(roleTotal), base.games, K.base);
    const patchMatches = onEach((p) => matches.get(p)).reduce((s, n) => s + n, 0);
    const banned = onEach((p) => bans.get(`${p}|${championId}`)).reduce((s, n) => s + n, 0);

    scored.push({
      championId,
      score: round(score, 5),
      winRate: round(baseWr),
      games: base.games,
      pickRate: roleTotal.games > 0 ? round(base.games / roleTotal.games) : 0,
      banRate: patchMatches > 0 ? round(banned / patchMatches) : 0,
      confidence: round(sampleConfidence(base.games, ENGINE_CONFIG.confidenceK.base), 3),
      patchesUsed: patches,
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
