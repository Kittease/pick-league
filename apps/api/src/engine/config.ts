/**
 * Every weight and threshold of the recommendation engine, in one place.
 *
 * Deltas are win-rate differences (0.028 = +2.8 points). Each delta is shrunk toward 0 with
 * `delta * n / (n + k)` (empirical-Bayes style), where `k` is the "prior strength" below: a delta
 * backed by `k` games keeps half of its value.
 *
 * The `k` values come from the data (patch 16.22, ~122k matches, Nov 2026): for each kind of delta,
 * the spread that is real (variance of the observed deltas minus their binomial noise, τ²) gives
 * `k = p(1 − p) / τ²`. A held-out check (stats from 80 % of the matches, scored on the other 20 %)
 * found the resulting pick score predicts wins ~4× better than the previous hand-set one.
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
     * Score = sum of weight × shrunk delta: an estimate of the candidate's win-rate difference.
     * With the `k` below calibrated on the data, every weight is 1: the held-out fit put the
     * champion's own strength and the lane matchup at ~1 and no other weighting did reliably
     * better. The champion's own strength is the largest real effect (±3.3 points between the
     * champions of a role), lane matchups come next (±1.4), then duo synergy (±1.1) and the other
     * pairs (≤ ±0.7). Reasons are still listed lane > duo > comp > base.
     */
    weights: {
      /** Enemy in the same role (the lane opponent). */
      matchup: 1,
      /** Bot lane: the other enemy of the 2v2 (support vs ADC, ADC vs support). */
      laneSecondary: 1,
      /** Duo partner (UTILITY↔BOTTOM, MIDDLE↔JUNGLE, TOP↔JUNGLE). */
      duo: 1,
      /** Enemy composition traits (shared across active traits). */
      vsComp: 1,
      /** Ally composition traits (shared across active traits). */
      withComp: 1,
      /** Each non-lane enemy (pairwise). */
      otherEnemy: 1,
      /** Each non-duo ally (pairwise). */
      otherAlly: 1,
      /** Champion's own win rate in the role vs the role average. */
      base: 1,
    },
    /**
     * Shrinkage prior strength per kind (games). Pair deltas (matchup, duo, other enemies and
     * allies) are measured against what the role usually does vs/with that champion (the other
     * champion's own strength is the same for every candidate), so these `k` fit that interaction
     * alone: it is small, hence the large values.
     */
    shrinkK: {
      base: 250,
      matchup: 1200,
      laneSecondary: 2500,
      duo: 1600,
      otherEnemy: 5000,
      otherAlly: 4700,
      /** No measurable effect of enemy traits on 16.22, a small one for ally traits (k ≈ 2,800). */
      comp: 3000,
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
    /**
     * Prior strength for choice deltas, per kind (measured on 16.22). Each choice is compared
     * with the other choices of its kind, i.e. the games where that kind exists (a 3-item path
     * only exists in games with 3 completed items), not with every game of the champion.
     */
    shrinkK: {
      keystone: 700,
      /** Secondary tree + its two runes, given the keystone. */
      runeSecondary: 1000,
      /** Primary minor runes given the keystone: no measurable difference, popularity decides. */
      runeMinor: 9000,
      /** Stat shards, given the keystone. */
      runeShard: 2000,
      spells: 800,
      starter: 1200,
      boots: 300,
      /** First completed item (among games with 3 completed items). */
      coreFirst: 1200,
      /** Second and third completed items, given the previous ones. */
      coreNext: 250,
      skill_first3: 450,
      skill_max: 300,
      /** Items vs players at the same point of their build (see `stageReference`). */
      item: 200,
      early_item: 450,
      /** Support quest upgrades: no measurable difference, popularity decides. */
      quest_item: Number.POSITIVE_INFINITY,
      /** Anything else. */
      default: 400,
    },
    /** A matchup/trait-driven choice replaces the base one if its shrunk delta is higher by at least this. */
    switchMinGain: 0.01,
    /** Minimum games of a choice vs a lane opponent / trait before it can be considered. */
    minContextGames: 15,
    /** Minimum (trait-specific delta − overall delta) for a data-backed item swap. */
    swapMinGain: 0.01,
    /** Max situational items. */
    maxSituational: 4,
    /** Completed items in the core. */
    coreSize: 4,
    /**
     * Core builds: 3-item paths ranked like `bestChoice` (shrunk delta among the 3-item paths +
     * popularity bonus), each with a different item set from the ones before it (a different
     * first item or at least 2 different items). Without a qualifying path, the first three
     * items are picked one at a time.
     */
    altCores: {
      /** Core builds returned at most, the most successful one included. */
      max: 3,
      /** Matches a path needs to be offered as a core build. */
      minGames: 20,
      /** Shrunk win-rate delta vs every 3-item path a core build needs at least. */
      minDelta: -0.01,
    },
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
   * `picks.shrinkK.base`; matchups/duos/synergies use `tierList.shrinkK`. Champions under
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
     * many games, sorted by shrunk delta (`shrinkK` below). The shrinkage is what keeps small
     * samples from topping the lists: a 5–0 record is worth at most +0.5 points with k = 550,
     * below a +6-point delta over 300 games (+2.1). The floor only drops 1–4 game rows.
     */
    minRelationGames: 5,
    /**
     * Prior strength of the listed relations. Unlike the picks score, these deltas keep the other
     * champion's own strength ("Leona vs Thresh" includes Thresh being strong), so their real
     * spread is larger and `k` smaller (measured on 16.22).
     */
    shrinkK: { matchup: 550, duo: 650, synergy: 900 },
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

  /**
   * Early / late game profile (tier list champion details, draft evaluation): a champion's win
   * rate in games under 25 min and of 32 min or more vs its overall win rate, compared with the
   * role (stats_champion_game_length). Explains and never scores. Each delta is shrunk toward 0
   * on the effective sample of "the bucket vs the champion's other games",
   * 1 / (1 / n_bucket + 1 / n_other): on 16.22 the real spread between champions is 3.0 points
   * for short games and 2.75 for long ones (k ≈ 270 and ≈ 330 effective games).
   */
  gameLength: {
    shrinkK: 300,
    /** A delta is shown only from this many games of champion+role in the bucket. */
    minGames: 100,
  },

  /**
   * Draft evaluation (POST /recommendations/draft): the picks engine's deltas summed per team.
   * Weights from a held-out logistic fit on 16.22 (25k test matches): summed champion strengths
   * came out at ~0.92 of a calibrated win-rate difference and pair terms at ~0.62 (noisier), so
   * they are scaled down to match; the resulting probabilities matched the observed results
   * bucket by bucket (e.g. predicted 45.3 % → 44.8 % won, 59.3 % → 56.5 %).
   */
  draft: {
    baseWeight: 0.9,
    pairWeight: 0.6,
    /** The probability stays within these bounds (a draft never decides a match alone). */
    minProbability: 0.05,
    maxProbability: 0.95,
    /** Pair reasons under this |delta| are left out (each champion's strength is always listed). */
    minReasonDelta: 0.002,
    maxReasons: 14,
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

/** "compared with other supports" */
export const ROLE_PLURALS: Record<Position, string> = {
  TOP: 'top laners',
  JUNGLE: 'junglers',
  MIDDLE: 'mid laners',
  BOTTOM: 'ADCs',
  UTILITY: 'supports',
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
