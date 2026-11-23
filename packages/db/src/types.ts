/**
 * Input/output types of the query functions. Field names are camelCase versions of the
 * columns in docs/database-schema.md.
 */
import type {
  ItemEventType,
  LadderTier,
  PatchId,
  Platform,
  Position,
  SoloTier,
} from '@pick-league/shared';

// ---------------------------------------------------------------------------
// ParsedMatch: produced by the worker's match + timeline parser, consumed by insertParsedMatch.
// ---------------------------------------------------------------------------

export interface ParsedMatchRow {
  /** 'EUW1_7234567890' */
  id: string;
  platform: Platform;
  /** Must already exist in `patches`. */
  patch: PatchId;
  gameVersion: string;
  queueId: number;
  startedAt: Date;
  durationS: number;
  isRemake: boolean;
  isEarlySurrender: boolean;
  winningTeam: 100 | 200;
}

export interface ParsedTeam {
  teamId: 100 | 200;
  win: boolean;
  firstBlood: boolean;
  firstTower: boolean;
  firstDragon: boolean;
  firstBaron: boolean;
  championKills: number;
  towerKills: number;
  inhibitorKills: number;
  dragonKills: number;
  baronKills: number;
  heraldKills: number;
  voidgrubKills: number;
  atakhanKills: number;
}

export interface ParsedBan {
  teamId: 100 | 200;
  /** 1..10 */
  pickTurn: number;
  /** -1 = no ban */
  championId: number;
}

export interface ParsedParticipant {
  /** 1..10, same ids as timeline events. */
  participantId: number;
  puuid: string;
  /** Riot ID from the match payload (null/empty → not stored). */
  riotIdGameName: string | null;
  riotIdTagLine: string | null;
  teamId: 100 | 200;
  championId: number;
  /** teamPosition; null if Riot couldn't infer it. */
  position: Position | null;
  win: boolean;

  summonerSpell1: number;
  summonerSpell2: number;
  runePrimaryTree: number;
  runeSecondaryTree: number;
  /** 6: keystone, 3 primary, 2 secondary. */
  runes: number[];
  /** 3: offense, flex, defense. */
  statShards: number[];
  /** 7: item0..item6 (6 = trinket), 0 = empty. */
  finalItems: number[];

  // End-of-game totals (what the champion trait profiles read).
  damageToChampions: number;
  physicalDamageToChampions: number;
  magicDamageToChampions: number;
  trueDamageToChampions: number;
  damageTaken: number;
  damageSelfMitigated: number;
  healingDone: number;
  ccTimeOnOthersS: number;

  /** One value per timeline frame (index 0 = minute 0): what the lane phase reads. */
  goldByMinute: number[];
  xpByMinute: number[];
  /** Lane + jungle minions. */
  csByMinute: number[];
}

/** A purchase, a sale or an undo of a participant. */
export interface ParsedItemEvent {
  participantId: number;
  /** Order within the participant's item events, starting at 1. */
  seq: number;
  atMs: number;
  type: ItemEventType;
  /** For UNDO: the item of the purchase taken back (Riot `beforeId`; 0 when a sale is undone). */
  itemId: number;
  /** UNDO only: the item a sale taken back gives back (Riot `afterId`, else 0); null otherwise. */
  undoAfterItemId: number | null;
}

/** A skill point of a participant (evolutions are not kept). */
export interface ParsedSkillEvent {
  participantId: number;
  /** 1 = first skill point. */
  seq: number;
  /** 1=Q 2=W 3=E 4=R */
  skillSlot: number;
}

/** A match + timeline reduced to the schema's fields, ready for `insertParsedMatch`. */
export interface ParsedMatch {
  match: ParsedMatchRow;
  teams: ParsedTeam[];
  bans: ParsedBan[];
  /** All 10 participants. */
  participants: ParsedParticipant[];
  itemEvents: ParsedItemEvent[];
  skillEvents: ParsedSkillEvent[];
}

// ---------------------------------------------------------------------------
// Other inputs/outputs
// ---------------------------------------------------------------------------

export interface PatchRow {
  id: PatchId;
  ddragonVersion: string;
  detectedAt: Date;
}

export interface LadderEntryInput {
  puuid: string;
  tier: LadderTier;
  /** 1..4 for DIAMOND; absent or null for the apex tiers. */
  division?: number | null;
  leaguePoints: number;
  wins: number;
  losses: number;
  /**
   * When Riot gave this entry (default: the upsert's `now`). A Diamond sweep takes minutes, so
   * each of its entries carries the time of its own page.
   */
  seenAt?: Date;
}

export interface LadderUpsertResult {
  /** Puuids that are new on the ladder or whose wins+losses changed → list their match ids. */
  played: string[];
  /** Subset of `played` that was not on this platform's ladder before. */
  added: string[];
  /** Number of ladder entries removed (players who dropped off). */
  removed: number;
}

/** A row of the tracked ladder, in ladder order (`ladderOrder`). */
export interface LadderOrderRow {
  puuid: string;
  tier: LadderTier;
  /** 1..4 for DIAMOND, null for the apex tiers. */
  division: number | null;
  leaguePoints: number;
  /** `players.last_seen_with_master_at`. */
  lastSeenWithMasterAt: Date | null;
}

/** A tracked Diamond player as stored (`trackedDiamondEntries`). */
export interface TrackedDiamondEntry {
  puuid: string;
  division: number;
  leaguePoints: number;
  /** When a complete sweep last saw the player. */
  seenAt: Date;
}

/**
 * What the listing skip rule reads about a tracked player (`getListingSkipState`) or an outside
 * Master (`getOutsideMasterSkipState`).
 */
export interface ListingSkipState {
  /** Current wins + losses: on the ladder, or at the player's last check. */
  gamesNow: number;
  /** The ladder refresh, or the check, that first saw them. */
  snapshotAt: Date;
  /** Baseline set by the last real listing (all null before the first one). */
  listedGames: number | null;
  listedSnapshotAt: Date | null;
  listedAt: Date | null;
}

/** A `listing_skip_misses` row (LISTING_SKIP=shadow). */
export interface ListingSkipMissInput {
  puuid: string;
  platform: Platform;
  checkedAt: Date;
  listedSnapshotAt: Date;
  snapshotAt: Date;
  expected: number;
  stored: number;
  newMatchIds: readonly string[];
}

export interface MasteryInput {
  championId: number;
  level: number;
  points: number;
  lastPlayedAt: Date;
}

export interface SoloRankInput {
  tier: SoloTier;
  /** 1..4, null for Master+. */
  division: number | null;
  lp: number;
  wins: number;
  losses: number;
}

/** A Diamond player's rank as a sweep page gave it (`updateKnownPlayerRanks`). */
export interface SweptRankInput {
  puuid: string;
  /** 1..4 */
  division: number;
  leaguePoints: number;
  wins: number;
  losses: number;
}

/** Outcome of a check of an outside Master (`recordOutsideMasterCheck`). */
export type OutsideMasterCheck =
  | 'unchanged'
  | 'played'
  | 'first'
  | 'first-listing'
  | 'left'
  | 'gone';

/** The outside Masters of a platform (`outsideMasterStats`). */
export interface OutsideMasterStats {
  /** Players followed (rows of `outside_masters`). */
  followed: number;
  /** Of them, checked since the given time. */
  checkedSince: number;
  /** Not checked yet. */
  neverChecked: number;
  /** The oldest last check among those checked; null when none was. */
  oldestCheckAt: Date | null;
  /** Waiting for a match-id listing. */
  toList: number;
}

export interface QueuedMatch {
  matchId: string;
  platform: Platform;
  attempts: number;
  /** `match_fetch_queue.fetch_rank` when claimed (absent: taken as an apex player's match). */
  fetchRank?: number;
}

/** A `diamond_tracking` row: the Diamond target of a platform and how it has kept up. */
export interface DiamondTracking {
  /** Diamond players to track (at most `DIAMOND_MAX_TRACKED`). */
  target: number;
  /**
   * Outcome of the ladder cycles since the target last changed, oldest first, one letter each:
   * K kept up, W waiting for patch data, M missed.
   */
  cycles: string;
  /** Start of the last cycle in `cycles`. */
  lastCycleAt: Date | null;
  /** Cycles left to absorb a burst (growth step, long stop) before they count. */
  settleCyclesLeft: number;
  /** Last change of the target. */
  changedAt: Date | null;
  changedFrom: number | null;
  changeReason: string | null;
}

export interface QueuedEnrichment {
  puuid: string;
  platform: Platform;
  attempts: number;
}

/** A tracked player whose masteries are due for their periodic refresh (champion-mastery-v4). */
export interface DailyRefreshCandidate {
  puuid: string;
}

export interface WorkerRunStats {
  requestsMade: number;
  playersPolled: number;
  matchesAdded: number;
  error?: string | null;
}

/** A `worker_status` row: health of one platform loop. */
export interface WorkerStatus {
  platform: Platform;
  /** Updated at least once a minute while the platform's loop runs. */
  heartbeatAt: Date;
  /** Riot rejects the API key (401/403) since then; null once a request succeeds again. */
  authRejectedSince: Date | null;
  /** Last non-abort error, 'kind: message' (at most 500 characters). */
  lastError: string | null;
  lastErrorAt: Date | null;
}
