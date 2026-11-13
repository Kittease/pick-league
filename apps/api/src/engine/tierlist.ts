/**
 * Tier list of one role: every champion with enough games, scored by its shrunk win-rate delta
 * vs the role average, tiered by score percentile (see `ENGINE_CONFIG.tierList`), with its best
 * and worst lane matchups and best duo partners.
 */
import type {
  PatchId,
  Position,
  Tier,
  TierListEntry,
  TierListRelation,
  TierListResponse,
} from '@pick-league/shared';
import { DUO_ROLES, ENGINE_CONFIG, LANE_ROLES } from './config.ts';
import { choosePatch, round, sampleConfidence, shrink, sumStats, winRate } from './math.ts';
import type { GamesWins, RoleStatRow, VsRow, WithRow } from './types.ts';

/** stats_champion_bans */
export interface BanRow {
  patch: PatchId;
  championId: number;
  /** Matches where the champion was banned. */
  bans: number;
}

/** stats_patch_matches */
export interface PatchMatchesRow {
  patch: PatchId;
  matches: number;
}

export interface TierListData {
  currentPatch: PatchId;
  previousPatch: PatchId | null;
  /** stats_champion_roles of the patches (at least the requested role). */
  roleStats: readonly RoleStatRow[];
  /** stats_champion_vs with position = role (lane opponents are filtered here). */
  vs: readonly VsRow[];
  /** stats_champion_with with position = role (duo partners are filtered here). */
  with: readonly WithRow[];
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

function relations<R extends GamesWins>(
  rows: readonly R[],
  baseWr: number,
  k: number,
  idOf: (r: R) => number,
  roleOf: (r: R) => Position,
): TierListRelation[] {
  return rows
    .filter((r) => r.games >= TL.minRelationGames)
    .map((r) => ({
      championId: idOf(r),
      role: roleOf(r),
      delta: round(shrink(winRate(r) - baseWr, r.games, k)),
      winRate: round(winRate(r)),
      games: r.games,
    }));
}

export function buildTierList(role: Position, data: TierListData): TierListResponse {
  const { currentPatch, previousPatch } = data;
  const inRole = data.roleStats.filter((r) => r.position === role);
  const rolePatch = (patch: PatchId) => sumStats(inRole.filter((r) => r.patch === patch));
  const roleTotals = new Map<PatchId, GamesWins>();
  for (const p of [currentPatch, previousPatch]) if (p) roleTotals.set(p, rolePatch(p));

  const row = new Map(inRole.map((r) => [`${r.patch}|${r.championId}`, r]));
  const bans = new Map(data.bans.map((b) => [`${b.patch}|${b.championId}`, b.bans]));
  const matches = new Map(data.patchMatches.map((m) => [m.patch, m.matches]));
  const laneRoles = LANE_ROLES[role];
  const duoRoles = DUO_ROLES[role];

  const scored: Omit<TierListEntry, 'tier'>[] = [];
  for (const championId of new Set(inRole.map((r) => r.championId))) {
    const cur = row.get(`${currentPatch}|${championId}`);
    const prev = previousPatch ? row.get(`${previousPatch}|${championId}`) : undefined;
    const pc = choosePatch(currentPatch, previousPatch, cur?.games ?? 0, prev?.games ?? 0);
    const base = pc.fellBack ? prev : cur;
    if (!base || base.games < ENGINE_CONFIG.minCandidateGames) continue;
    const patch = pc.patch;
    const baseWr = winRate(base);
    const roleTotal = roleTotals.get(patch) ?? { games: 0, wins: 0 };
    const score = shrink(baseWr - winRate(roleTotal), base.games, K.base);
    const patchMatches = matches.get(patch) ?? 0;

    const matchups = relations(
      data.vs.filter(
        (r) =>
          r.patch === patch && r.championId === championId && laneRoles.includes(r.enemyPosition),
      ),
      baseWr,
      K.matchup,
      (r) => r.enemyId,
      (r) => r.enemyPosition,
    );
    const duos = relations(
      data.with.filter(
        (r) =>
          r.patch === patch && r.championId === championId && duoRoles.includes(r.allyPosition),
      ),
      baseWr,
      K.duo,
      (r) => r.allyId,
      (r) => r.allyPosition,
    );
    const byDelta = (a: TierListRelation, b: TierListRelation) =>
      b.delta - a.delta || b.games - a.games || a.championId - b.championId;
    const best = matchups.filter((m) => m.delta > 0).sort(byDelta);
    const worst = matchups
      .filter((m) => m.delta < 0)
      .sort((a, b) => byDelta(b, a))
      .slice(0, TL.relationsShown);

    scored.push({
      championId,
      score: round(score, 5),
      winRate: round(baseWr),
      games: base.games,
      pickRate: roleTotal.games > 0 ? round(base.games / roleTotal.games) : 0,
      banRate:
        patchMatches > 0 ? round((bans.get(`${patch}|${championId}`) ?? 0) / patchMatches) : 0,
      confidence: round(sampleConfidence(base.games, ENGINE_CONFIG.confidenceK.base), 3),
      patchUsed: patch,
      bestMatchups: best.slice(0, TL.relationsShown),
      worstMatchups: worst,
      bestDuos: duos
        .filter((d) => d.delta > 0)
        .sort(byDelta)
        .slice(0, TL.relationsShown),
    });
  }

  scored.sort((a, b) => b.score - a.score || b.games - a.games || a.championId - b.championId);
  const tiers = assignTiers(scored.map((e) => e.score));
  return {
    role,
    patch: currentPatch,
    roleGames: roleTotals.get(currentPatch)?.games ?? 0,
    entries: scored.map((e, i) => ({ ...e, tier: tiers[i] ?? 'D' })),
  };
}
