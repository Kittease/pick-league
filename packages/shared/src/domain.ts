/** Core League of Legends domain constants, mirroring the Postgres enums. */

/** Riot `teamPosition` values (Postgres enum `position`). */
export const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
export type Position = (typeof POSITIONS)[number];

export function isPosition(value: unknown): value is Position {
  return typeof value === 'string' && (POSITIONS as readonly string[]).includes(value);
}

/**
 * Riot's match payload uses `teamPosition` = '' when it could not infer it.
 * Returns null for anything that isn't a known position.
 */
export function parsePosition(value: string | null | undefined): Position | null {
  return isPosition(value) ? value : null;
}

/** Apex ladders: each one is a single league-v4 list (`challengerleagues`, …). */
export const APEX_LADDER_TIERS = ['CHALLENGER', 'GRANDMASTER', 'MASTER'] as const;
export type ApexLadderTier = (typeof APEX_LADDER_TIERS)[number];

/**
 * Tiers of the players the worker tracks (Postgres enum `ladder_tier`, in its order): the apex
 * ladders, then Diamond (tracked only with `DIAMOND_MAX_TRACKED`, with a division).
 */
export const LADDER_TIERS = [...APEX_LADDER_TIERS, 'DIAMOND'] as const;
export type LadderTier = (typeof LADDER_TIERS)[number];

/** Riot division strings, best first (index + 1 = the division number stored). */
export const DIVISIONS = ['I', 'II', 'III', 'IV'] as const;
export type Division = (typeof DIVISIONS)[number];

/** Solo-queue tiers, lowest first (Postgres enum `solo_tier`). */
export const SOLO_TIERS = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'EMERALD',
  'DIAMOND',
  'MASTER',
  'GRANDMASTER',
  'CHALLENGER',
] as const;
export type SoloTier = (typeof SOLO_TIERS)[number];

export function isSoloTier(value: unknown): value is SoloTier {
  return typeof value === 'string' && (SOLO_TIERS as readonly string[]).includes(value);
}

/** Tiers without divisions. */
export const APEX_TIERS: readonly SoloTier[] = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];

/** Riot division string ('I'..'IV') → 1..4. Returns null for apex tiers or unknown values. */
export function divisionToNumber(tier: SoloTier, rank: string | undefined): number | null {
  if (APEX_TIERS.includes(tier)) return null;
  const map: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };
  return rank !== undefined ? (map[rank] ?? null) : null;
}

export const RANKED_SOLO_QUEUE = 'RANKED_SOLO_5x5';
export const RANKED_SOLO_QUEUE_ID = 420;

export const TEAM_IDS = [100, 200] as const;
export type TeamId = (typeof TEAM_IDS)[number];

/** Skill slots used in `skill_events` and champion spells: 1=Q 2=W 3=E 4=R. */
export const SKILL_SLOTS = [1, 2, 3, 4] as const;
export type SkillSlot = (typeof SKILL_SLOTS)[number];
export const SKILL_KEYS: Record<SkillSlot, 'Q' | 'W' | 'E' | 'R'> = {
  1: 'Q',
  2: 'W',
  3: 'E',
  4: 'R',
};

/** Item events the worker stores. The database enum also has 'DESTROYED', no longer stored. */
export const ITEM_EVENT_TYPES = ['PURCHASED', 'SOLD', 'UNDO'] as const;
export type ItemEventType = (typeof ITEM_EVENT_TYPES)[number];

export const FETCH_STATUSES = ['PENDING', 'DONE', 'SKIPPED_OLD_PATCH', 'FAILED'] as const;
export type FetchStatus = (typeof FETCH_STATUSES)[number];
