/**
 * HTTP contract between apps/api (server) and apps/desktop (client).
 *
 * Rules both sides rely on:
 * - JSON everywhere, `Content-Type: application/json`. CORS is open.
 * - Champion ids are Riot numeric ids (e.g. 266), item/rune/spell ids are numeric Data Dragon ids.
 * - Rates are fractions in [0, 1] (0.513 = 51.3 %); deltas are win-rate differences (+0.028 = +2.8 points).
 * - Timestamps are ISO-8601 strings.
 * - Errors: any non-2xx response has an `ApiErrorResponse` body.
 * - This module is runtime-agnostic (no Bun/Node APIs) so the Electron renderer can import it.
 */

import { z } from 'zod';
import { POSITIONS, type Position } from './domain.ts';
import type { PatchId } from './patch.ts';
import { PLATFORMS, type Platform } from './platform.ts';
import type {
  ChampionInfo,
  StaticItem,
  StaticRune,
  StaticRuneTree,
  StaticSummonerSpell,
  StatShardRow,
} from './static-data.ts';

export const API_DEFAULT_PORT = 3000;
export const API_DEFAULT_URL = `http://localhost:${API_DEFAULT_PORT}`;

export const API_ROUTES = {
  health: '/health',
  patches: '/patches',
  /** `patch` = a patch id ('15.22') or 'latest'. */
  static: (patch: PatchId | 'latest') => `/static/${patch}`,
  picks: '/recommendations/picks',
  build: '/recommendations/build',
  statsStatus: '/stats/status',
  statsRefresh: '/stats/refresh',
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  /** 400: invalid body/params (details = zod issues). */
  'BAD_REQUEST',
  /** 404: unknown route, unknown patch, unknown champion. */
  'NOT_FOUND',
  /** 429: per-IP rate limit; see `Retry-After` header. */
  'RATE_LIMITED',
  /** 503: the database has no usable data yet (no patch / no matches ingested). */
  'NO_DATA',
  /** 500 */
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

export const REASON_KINDS = [
  /** Champion's own baseline (win rate / most common winning choice for champion+role). */
  'base',
  /** Lane matchup vs. the enemy in the same role (or a known enemy when roles are unknown). */
  'matchup',
  /** Synergy with the duo ally (UTILITY↔BOTTOM, MIDDLE↔JUNGLE, TOP↔JUNGLE). */
  'duo',
  /** Against an enemy composition trait (e.g. "vs AD-heavy"). */
  'vs_comp',
  /** With an ally composition trait. */
  'with_comp',
  /** Build: an item replaced by another, backed by match data. */
  'item_swap',
  /** Build: adaptation from Data Dragon item tags when samples are too small (delta = 0, games = 0). */
  'tag_rule',
  /** How often high-elo players make this choice (delta = 0 unless meaningful). */
  'popularity',
  /** Previous patch data added to the current one because the current has too few games. */
  'patch_fallback',
] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

/** Composition traits computed from match data (see architecture.md "Engine"). */
export const COMP_TRAITS = [
  'AD_HEAVY',
  'AP_HEAVY',
  'HIGH_CC',
  'HIGH_HEALING',
  'TANKY',
  'POKE_RANGED',
  'MELEE_HEAVY',
] as const;
export type CompTrait = (typeof COMP_TRAITS)[number];

export interface Reason {
  kind: ReasonKind;
  /** Human-readable, ready to display, e.g. "+2.8% vs Nautilus (bot lane, 412 games)". */
  label: string;
  /** Win-rate delta after shrinkage (0.028 = +2.8 points). 0 when not applicable. */
  delta: number;
  /** Sample size behind the delta. 0 when not applicable. */
  games: number;
  /** Other champion(s) involved (matchup opponent, duo partner…) — lets the UI show icons. */
  championIds?: number[];
  /** Item involved (the recommended one for item_swap/tag_rule). */
  itemId?: number;
  /** item_swap: the base-build item this one replaces. */
  replacesItemId?: number;
  /** vs_comp / with_comp / tag_rule: the trait that triggered the reason. */
  trait?: CompTrait;
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  /** true when the API is up and the database answered. */
  ok: boolean;
  /** Database reachable. */
  db: boolean;
  /** Newest kept patch, null before the first Data Dragon ingest. */
  latestPatch: PatchId | null;
  /** Matches stored across kept patches. */
  matchCount: number;
}

// ---------------------------------------------------------------------------
// GET /stats/status and POST /stats/refresh
// ---------------------------------------------------------------------------

/** Freshness of the stats views the recommendations are computed from. */
export interface StatsStatusResponse {
  /** A refresh is running (on any API instance sharing the database). */
  refreshing: boolean;
  /** End of the last successful refresh; null before the first one. */
  lastRefreshedAt: string | null;
  lastRefreshDurationMs: number | null;
  /** Matches stored when the last successful refresh started (what the stats include). */
  matchesIncluded: number;
  /** Matches stored now. */
  matchesStored: number;
  /** `max(0, matchesStored - matchesIncluded)`: games a refresh would add. */
  pendingMatches: number;
}

export const STATS_REFRESH_SKIP_REASONS = [
  /** The stats already include every stored match. */
  'up_to_date',
  /** A refresh is running (timer or another request); poll `GET /stats/status`. */
  'already_running',
  /** The previous refresh finished too recently; see `retryAfterSeconds`. */
  'cooldown',
] as const;
export type StatsRefreshSkipReason = (typeof STATS_REFRESH_SKIP_REASONS)[number];

/**
 * `POST /stats/refresh` (no body). 202 `{ started: true }` when a background refresh was started,
 * else 200 with the reason. The refresh itself takes seconds to minutes: poll `GET /stats/status`.
 */
export type StatsRefreshResponse =
  | { started: true }
  | { started: false; reason: StatsRefreshSkipReason; retryAfterSeconds?: number };

// ---------------------------------------------------------------------------
// GET /patches
// ---------------------------------------------------------------------------

export interface PatchSummary {
  patch: PatchId;
  ddragonVersion: string;
  detectedAt: string;
  /** Total matches of this patch (all platforms). */
  matchCount: number;
  /** Every crawled platform is present (0 when none). */
  matchCountByPlatform: Record<Platform, number>;
}

export interface PatchesResponse {
  /** Kept patches, newest first (at most 2). */
  patches: PatchSummary[];
}

// ---------------------------------------------------------------------------
// GET /static/:patch
// ---------------------------------------------------------------------------

export interface StaticChampionSpellDto {
  /** 1=Q 2=W 3=E 4=R */
  slot: number;
  name: string;
  iconUrl: string;
}

export interface StaticChampionDto {
  id: number;
  slug: string;
  name: string;
  tags: string[];
  attackRange: number;
  info: ChampionInfo;
  iconUrl: string;
  /** Q, W, E, R. */
  spells: StaticChampionSpellDto[];
}

export interface StaticItemDto extends StaticItem {
  iconUrl: string;
}

export interface StaticRuneTreeDto extends StaticRuneTree {
  iconUrl: string;
}

export interface StaticRuneDto extends StaticRune {
  iconUrl: string;
}

export interface StaticStatShardDto {
  id: number;
  name: string;
  iconUrl: string;
}

export interface StaticSummonerSpellDto extends StaticSummonerSpell {
  iconUrl: string;
}

/** Everything the desktop needs to render names and icons for one patch. Image URLs are Data Dragon CDN URLs. */
export interface StaticDataResponse {
  patch: PatchId;
  ddragonVersion: string;
  /** Sorted by name. */
  champions: StaticChampionDto[];
  items: StaticItemDto[];
  runeTrees: StaticRuneTreeDto[];
  runes: StaticRuneDto[];
  /** Options per row, in display order. */
  statShards: Record<StatShardRow, StaticStatShardDto[]>;
  summonerSpells: StaticSummonerSpellDto[];
}

// ---------------------------------------------------------------------------
// Request schemas (zod v4) — the API validates bodies with these.
// ---------------------------------------------------------------------------

export const positionSchema = z.enum(POSITIONS);
export const championIdSchema = z.number().int().positive();
export const patchIdSchema = z.string().regex(/^\d+\.\d+$/, 'expected a patch id like "15.22"');

/** A teammate in champion select. `championId` null = not picked/hovered yet; `role` null = unknown. */
export const pickAllySchema = z.object({
  championId: championIdSchema.nullable(),
  role: positionSchema.nullable(),
});

export const picksRequestSchema = z.object({
  /** Role the user is picking for. */
  role: positionSchema,
  /** The user's 4 teammates (the user excluded), in any order. */
  allies: z.array(pickAllySchema).max(4).default([]),
  /** Enemy champions (roles are unknown during champ select); null = not picked yet. */
  enemies: z.array(championIdSchema.nullable()).max(5).default([]),
  /** All bans of both teams; excluded from candidates. */
  bans: z.array(championIdSchema).max(10).default([]),
  /** If given, candidates are restricted to these (e.g. the user's owned champions). */
  availableChampionIds: z.array(championIdSchema).optional(),
  /** Max candidates returned (default 20). */
  limit: z.number().int().min(1).max(100).optional(),
  /** Force a patch instead of the automatic current/previous fallback. */
  patch: patchIdSchema.optional(),
});

/** Parsed body of `POST /recommendations/picks` (defaults applied). */
export type PicksRequest = z.infer<typeof picksRequestSchema>;
/** What a client may send (defaulted fields optional). */
export type PicksRequestInput = z.input<typeof picksRequestSchema>;

export const buildParticipantSchema = z.object({
  championId: championIdSchema,
  role: positionSchema.nullable(),
});

export const buildRequestSchema = z.object({
  /** The champion the user picked. */
  championId: championIdSchema,
  role: positionSchema,
  /** Picked teammates (the user excluded). */
  allies: z.array(buildParticipantSchema).max(4).default([]),
  /** Picked enemies; `role` null when unknown (the API then guesses the lane opponent). */
  enemies: z.array(buildParticipantSchema).max(5).default([]),
  patch: patchIdSchema.optional(),
});

/** Parsed body of `POST /recommendations/build` (defaults applied). */
export type BuildRequest = z.infer<typeof buildRequestSchema>;
export type BuildRequestInput = z.input<typeof buildRequestSchema>;

// ---------------------------------------------------------------------------
// POST /recommendations/picks
// ---------------------------------------------------------------------------

export interface PickCandidate {
  championId: number;
  /** Sum of shrunk win-rate deltas (higher = better); candidates are sorted by it, descending. */
  score: number;
  /** 0..1, derived from sample sizes. */
  confidence: number;
  /**
   * Patches whose data was used for this champion, newest first: the current one, plus the
   * previous one when the current has too few games of champion+role.
   */
  patchesUsed: PatchId[];
  /** Games of champion+role on `patchesUsed`. */
  games: number;
  /** Baseline win rate of champion+role on `patchesUsed`. */
  winRate: number;
  /** Ordered by importance (matchup, duo, vs_comp, with_comp, …). */
  reasons: Reason[];
}

export interface PicksResponse {
  role: Position;
  /** Current patch at request time (candidates may add the previous one, see `PickCandidate.patchesUsed`). */
  patch: PatchId;
  candidates: PickCandidate[];
}

// ---------------------------------------------------------------------------
// POST /recommendations/build
// ---------------------------------------------------------------------------

export interface RecommendedItem {
  itemId: number;
  /** Situational items: the core item it would replace, null if it is an addition. */
  replacesItemId?: number | null;
  reasons: Reason[];
}

export interface ItemsRecommendation {
  /** Starting purchase, e.g. [World Atlas, Health Potion x2] → item ids, duplicates allowed. */
  starting: RecommendedItem[];
  /** Early purchases before the first completed item (components, boots), in buy order. */
  early: RecommendedItem[];
  /** Completed items in buy order (boots included at their usual slot). */
  core: RecommendedItem[];
  /** Adaptations to this game's enemies/allies. */
  situational: RecommendedItem[];
}

export interface RunesRecommendation {
  primaryTreeId: number;
  secondaryTreeId: number;
  /** 6 ids: keystone, 3 primary, 2 secondary (same order as Riot's perks). */
  runeIds: number[];
  /** 3 ids: offense, flex, defense. */
  statShardIds: number[];
  /** LCU-ready `selectedPerkIds`: `[...runeIds, ...statShardIds]` (9 ids). */
  selectedPerkIds: number[];
  games: number;
  winRate: number;
  reasons: Reason[];
}

export interface SummonerSpellsRecommendation {
  /** Two spell ids, most common D/F order (the desktop puts Flash on the user's chosen key). */
  spellIds: [number, number];
  games: number;
  winRate: number;
  reasons: Reason[];
}

export interface SkillOrderRecommendation {
  /** Skill slots (1=Q 2=W 3=E 4=R) taken at levels 1, 2, 3. */
  firstLevels: number[];
  /** Basic abilities in max order, e.g. [1, 3, 2] = max Q, then E, then W. */
  maxOrder: number[];
  /** Full level 1..18 sequence when available (may be shorter). */
  sequence: number[];
  games: number;
  winRate: number;
  reasons: Reason[];
}

export interface BuildResponse {
  championId: number;
  role: Position;
  /** Patches whose data was used, newest first (see `PickCandidate.patchesUsed`). */
  patchesUsed: PatchId[];
  /** Games of champion+role on `patchesUsed`. */
  games: number;
  /** 0..1 */
  confidence: number;
  items: ItemsRecommendation;
  runes: RunesRecommendation;
  summonerSpells: SummonerSpellsRecommendation;
  skillOrder: SkillOrderRecommendation;
}

// ---------------------------------------------------------------------------
// GET /tierlist?role=UTILITY&patch=latest
// (kept in its own block: route, query schema and response types)
// ---------------------------------------------------------------------------

export const TIER_LIST_ROUTE = '/tierlist';

export const TIERS = ['S', 'A', 'B', 'C', 'D'] as const;
export type Tier = (typeof TIERS)[number];

/** Server filter of the tier list: one platform, or 'ALL' (default). */
export const TIER_LIST_PLATFORMS = ['ALL', ...PLATFORMS] as const;
export type TierListPlatform = (typeof TIER_LIST_PLATFORMS)[number];

/**
 * Rank filter of the tier list, on each counted player's current solo tier (not the tier at match
 * time): 'MASTER' = Master+ (default, every player: the matches come from Master+ ladders),
 * 'GRANDMASTER' = Grandmaster and Challenger players, 'CHALLENGER' = Challenger players only.
 */
export const TIER_LIST_RANKS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'] as const;
export type TierListRank = (typeof TIER_LIST_RANKS)[number];

export interface TierListFilters {
  platform: TierListPlatform;
  rank: TierListRank;
}

export const DEFAULT_TIER_LIST_FILTERS: TierListFilters = { platform: 'ALL', rank: 'MASTER' };

/** Filters from untrusted input (IPC, local storage): unknown values fall back to the defaults. */
export function toTierListFilters(value: unknown): TierListFilters {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const pick = <T extends string>(list: readonly T[], x: unknown, fallback: T): T =>
    list.includes(x as T) ? (x as T) : fallback;
  return {
    platform: pick(TIER_LIST_PLATFORMS, v.platform, DEFAULT_TIER_LIST_FILTERS.platform),
    rank: pick(TIER_LIST_RANKS, v.rank, DEFAULT_TIER_LIST_FILTERS.rank),
  };
}

/**
 * Query string of `GET /tierlist`. `patch` = a patch id or 'latest' (default). `platform` and
 * `rank` filter the counted players (defaults: every server, Master+ = no rank filter).
 */
export const tierListQuerySchema = z.object({
  role: positionSchema,
  patch: z.union([z.literal('latest'), patchIdSchema]).default('latest'),
  platform: z.enum(TIER_LIST_PLATFORMS).default('ALL'),
  rank: z.enum(TIER_LIST_RANKS).default('MASTER'),
});
export type TierListQuery = z.infer<typeof tierListQuerySchema>;
export type TierListQueryInput = z.input<typeof tierListQuerySchema>;

/** A lane opponent or a duo partner of a tier list entry. */
export interface TierListRelation {
  championId: number;
  /** Role of the opponent / partner (bot lane opponents can be BOTTOM or UTILITY). */
  role: Position;
  /** Win-rate delta vs the entry's own baseline, shrunk by sample size like the picks engine. */
  delta: number;
  /** Raw win rate of the entry in those games. */
  winRate: number;
  games: number;
}

export interface TierListEntry {
  championId: number;
  tier: Tier;
  /** Shrunk win-rate delta vs the role average (higher = better); entries are sorted by it. */
  score: number;
  /** Win rate of champion+role on `patchesUsed`. */
  winRate: number;
  /** Games of champion+role on `patchesUsed`. */
  games: number;
  /** Share of the role's games on `patchesUsed` played by this champion (~1 summed over a role). */
  pickRate: number;
  /**
   * Share of matches of `patchesUsed` where this champion was banned (by either team). With a rank
   * filter: share of the counted players' matches (a match counts once per counted player in it).
   */
  banRate: number;
  /** 0..1, derived from the sample size. */
  confidence: number;
  /** Current patch, plus the previous one when the current has too few games (like the picks engine). */
  patchesUsed: PatchId[];
  /** Up to 3 best lane opponents, best first (positive deltas only). */
  bestMatchups: TierListRelation[];
  /** Up to 3 worst lane opponents, worst first (negative deltas only). */
  worstMatchups: TierListRelation[];
  /** Up to 3 best duo partners (UTILITY↔BOTTOM, MIDDLE↔JUNGLE, TOP↔JUNGLE), positive deltas only. */
  bestDuos: TierListRelation[];
}

export interface TierListResponse {
  role: Position;
  /** Requested patch ('latest' resolved to the current patch). */
  patch: PatchId;
  /** Filters applied (defaults filled in). Every count and rate below is restricted to them. */
  filters: TierListFilters;
  /** Games played in this role on `patch` (one per team per match) by the counted players. */
  roleGames: number;
  /** Sorted by score, descending. */
  entries: TierListEntry[];
}
