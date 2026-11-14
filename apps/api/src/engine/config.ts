/**
 * Every weight and threshold of the recommendation engine, in one place.
 *
 * Deltas are win-rate differences (0.028 = +2.8 points). Each delta is shrunk toward 0 with
 * `delta * n / (n + k)` (empirical-Bayes style), where `k` is the "prior strength" below: a delta
 * backed by `k` games keeps half of its value.
 */
import type { CompTrait, Position } from '@pick-league/shared';

export const ENGINE_CONFIG = {
  /**
   * Use the current patch alone for a champion+role when it has at least this many games, else the
   * current and previous patches combined.
   */
  patchFallbackMinGames: 150,
  /** Champions with fewer games in the role (on the patch used) are not candidates. */
  minCandidateGames: 20,

  picks: {
    /**
     * Weight of each reason kind in the score, in the user's priority order:
     * lane matchup > duo synergy > vs enemy composition > with ally composition.
     */
    weights: {
      /** Enemy in the same role (the lane opponent). */
      matchup: 1.0,
      /** Bot lane: the other enemy of the 2v2 (support vs ADC, ADC vs support). */
      laneSecondary: 0.6,
      /** Duo partner (UTILITY↔BOTTOM, MIDDLE↔JUNGLE, TOP↔JUNGLE). */
      duo: 0.8,
      /** Enemy composition traits (shared across active traits). */
      vsComp: 0.5,
      /** Ally composition traits (shared across active traits). */
      withComp: 0.35,
      /** Each non-lane enemy (pairwise). */
      otherEnemy: 0.15,
      /** Each non-duo ally (pairwise). */
      otherAlly: 0.1,
      /** Champion's own win rate in the role vs 50 %. */
      base: 0.3,
    },
    /** Shrinkage prior strength per kind (games). */
    shrinkK: {
      base: 300,
      matchup: 120,
      duo: 120,
      comp: 400,
      pair: 150,
    },
    /** Number of candidates returned by default. */
    defaultLimit: 20,
    /** A reason is listed only if its |shrunk delta| reaches this, unless it is a lane/duo reason. */
    minReasonDelta: 0.002,
  },

  /** Composition traits need at least this many known champions on that side. */
  minTraitChampions: 2,

  build: {
    /** A choice needs this many games to be recommended (else the most played one is used). */
    minChoiceGames: 10,
    /** Bonus per unit of play share when ranking choices (0.05 → a 100 % share is worth +5 points). */
    popularityWeight: 0.05,
    /** Prior strength for choice deltas. */
    shrinkK: 80,
    /** A matchup/trait-driven choice replaces the base one if its shrunk delta is higher by at least this. */
    switchMinGain: 0.015,
    /** Minimum games of a choice vs a lane opponent / trait before it can be considered. */
    minContextGames: 15,
    /** Minimum (trait-specific delta − overall delta) for a data-backed item swap. */
    swapMinGain: 0.01,
    /** Max situational items. */
    maxSituational: 4,
    /** Completed items in the core. */
    coreSize: 4,
    /** An early component is listed if bought by at least this share of players. */
    earlyItemMinShare: 0.3,
    maxEarlyItems: 4,
    /**
     * The support quest upgrade is recommended when at least this share of the champion+role's
     * games ended with one (supports; keeps a stray off-role quest out of other roles' builds).
     */
    questItemMinShare: 0.5,
    /** Tag rules only suggest items this champion+role built at least this many times. */
    tagRuleMinItemGames: 5,
    /** Minimum games of a full skill sequence to use it instead of a synthesised one. */
    minSkillSequenceGames: 3,
    /** Build confidence: games / (games + k). */
    confidenceK: 300,
  },

  /**
   * Tier list (GET /tierlist). Score = (champion win rate − role average win rate) shrunk with
   * `picks.shrinkK.base`; matchups/duos use `picks.shrinkK.matchup` / `.duo`. Champions under
   * `minCandidateGames` are left out.
   *
   * Tiers come from the score percentile within the role (midpoint rank `(i + 0.5) / n`, ties
   * share the best tier): top 10 % → S, next 20 % → A, next 35 % → B, next 20 % → C, rest → D.
   * A champion whose score is not positive (at or below the role average once shrunk) is capped
   * at B, so a weak role never gets fake S/A picks.
   */
  tierList: {
    /** Cumulative upper percentile bounds of S, A, B, C (D = the rest). */
    tierPercentiles: { S: 0.1, A: 0.3, B: 0.65, C: 0.85 },
    /** Best tier allowed for a champion with score <= 0. */
    nonPositiveBestTier: 'B',
    /**
     * A champion's matchups, duos and synergies (GET /tierlist/champion) are all listed from this
     * many games, sorted by shrunk delta (`picks.shrinkK.matchup` / `.duo` / `.pair`). The
     * shrinkage is what keeps small samples from topping the lists: a 5–0 record is worth at most
     * +2.0 points with k = 120, below a +6-point delta over 100 games (+2.7). The floor only
     * drops 1–4 game rows (pure noise). With ~50k matches over two patches, the median champion
     * gets ~15–30 lane matchups at 5 games (1–2 at 15 games).
     */
    minRelationGames: 5,
  },

  /**
   * Lane phase (`lane_phase` reasons, tier list matchups): average gold / XP / CS differences vs
   * the lane opponent at 10 and 15 min (bot lane 2v2), from stats_champion_lane_phase. They
   * explain and never score. Each average is shrunk toward 0 like the deltas, `x * n / (n + k)`.
   * A matchup's lane gold difference at 10 min varies by ~±700 gold from match to match while
   * matchups differ by a few hundred on average, so far fewer matchups are needed than for a
   * win rate (k = 120): with k = 20, 20 matchups keep half of the average, 180 keep 90 %.
   */
  lanePhase: {
    shrinkK: 20,
    /** Shown only from this many matchups with frames at that minute. */
    minGames: 20,
  },

  /** Picks confidence: weighted mean of n / (n + k) of each scored component. */
  confidenceK: {
    base: 200,
    matchup: 80,
    duo: 80,
    comp: 300,
    pair: 100,
  },
} as const;

/** Duo partners per role. */
export const DUO_ROLES: Record<Position, readonly Position[]> = {
  TOP: ['JUNGLE'],
  JUNGLE: ['MIDDLE', 'TOP'],
  MIDDLE: ['JUNGLE'],
  BOTTOM: ['UTILITY'],
  UTILITY: ['BOTTOM'],
};

/** Roles of the same lane on the enemy side (bot lane is a 2v2). */
export const LANE_ROLES: Record<Position, readonly Position[]> = {
  TOP: ['TOP'],
  JUNGLE: ['JUNGLE'],
  MIDDLE: ['MIDDLE'],
  BOTTOM: ['BOTTOM', 'UTILITY'],
  UTILITY: ['UTILITY', 'BOTTOM'],
};

export const ROLE_LABELS: Record<Position, string> = {
  TOP: 'top',
  JUNGLE: 'jungle',
  MIDDLE: 'mid',
  BOTTOM: 'ADC',
  UTILITY: 'support',
};

export const TRAIT_LABELS: Record<CompTrait, string> = {
  AD_HEAVY: 'AD-heavy',
  AP_HEAVY: 'AP-heavy',
  HIGH_CC: 'high-CC',
  HIGH_HEALING: 'heal-heavy',
  TANKY: 'tanky',
  POKE_RANGED: 'ranged/poke',
  MELEE_HEAVY: 'melee-heavy',
};

/**
 * Data Dragon has no "Grievous Wounds" tag: anti-heal items are listed by id (current and
 * recent ids). Used by the tag-rule fallback only.
 */
export const ANTI_HEAL_ITEM_IDS: readonly number[] = [
  3123, // Executioner's Calling
  3033, // Mortal Reminder
  6609, // Chempunk Chainsword
  3916, // Oblivion Orb
  3165, // Morellonomicon
  3011, // Chemtech Putrifier
  3076, // Bramble Vest
  3075, // Thornmail
];

/** Cleanse-type items (no Data Dragon tag either). */
export const QSS_ITEM_IDS: readonly number[] = [3140, 3139, 6035];

/** Item tag-rule fallback: which items answer which enemy trait. */
export interface TagRule {
  trait: CompTrait;
  /** Human explanation, e.g. "applies Grievous Wounds". */
  why: string;
  /** Data Dragon tags that qualify an item (any of). */
  tags?: readonly string[];
  /** Explicit item ids that qualify. */
  itemIds?: readonly number[];
  /** Only for champions dealing mostly this damage type. */
  damage?: 'physical' | 'magic';
}

export const TAG_RULES: readonly TagRule[] = [
  { trait: 'HIGH_HEALING', why: 'applies Grievous Wounds', itemIds: ANTI_HEAL_ITEM_IDS },
  { trait: 'AD_HEAVY', why: 'armor vs physical damage', tags: ['Armor'] },
  { trait: 'AP_HEAVY', why: 'magic resist vs magic damage', tags: ['SpellBlock'] },
  {
    trait: 'HIGH_CC',
    why: 'tenacity/cleanse vs crowd control',
    tags: ['Tenacity'],
    itemIds: QSS_ITEM_IDS,
  },
  {
    trait: 'TANKY',
    why: 'armor penetration vs tanks',
    tags: ['ArmorPenetration'],
    damage: 'physical',
  },
  {
    trait: 'TANKY',
    why: 'magic penetration vs tanks',
    tags: ['MagicPenetration'],
    damage: 'magic',
  },
];

export type EngineConfig = typeof ENGINE_CONFIG;
