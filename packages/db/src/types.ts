/**
 * Input/output types of the query functions. Field names are camelCase versions of the
 * columns in docs/database-schema.md.
 */
import type {
  ItemEventType,
  LadderTier,
  ObjectiveType,
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

  champLevel: number;
  kills: number;
  deaths: number;
  assists: number;
  laneMinions: number;
  jungleMinions: number;
  goldEarned: number;
  goldSpent: number;
  damageToChampions: number;
  physicalDamageToChampions: number;
  magicDamageToChampions: number;
  trueDamageToChampions: number;
  damageTaken: number;
  damageSelfMitigated: number;
  damageToBuildings: number;
  damageToObjectives: number;
  healingDone: number;
  healsOnTeammates: number;
  shieldsOnTeammates: number;
  ccTimeOnOthersS: number;
  visionScore: number;
  wardsPlaced: number;
  wardsKilled: number;
  controlWardsBought: number;

  /** One value per timeline frame (index 0 = minute 0). */
  goldByMinute: number[];
  xpByMinute: number[];
  /** Lane + jungle minions. */
  csByMinute: number[];
  levelByMinute: number[];
  damageToChampionsByMinute: number[];
  positionXByMinute: number[];
  positionYByMinute: number[];
}

export interface ParsedItemEvent {
  participantId: number;
  /** Order within the participant's events, starting at 1. */
  seq: number;
  atMs: number;
  type: ItemEventType;
  /** For UNDO: the item that was undone (beforeId). */
  itemId: number;
  /** UNDO only (afterId), else null. */
  undoAfterItemId: number | null;
  /** UNDO only, else null. */
  undoGoldGain: number | null;
}

export interface ParsedSkillEvent {
  participantId: number;
  /** 1 = first skill point. */
  seq: number;
  atMs: number;
  /** 1=Q 2=W 3=E 4=R */
  skillSlot: number;
  isEvolve: boolean;
}

export interface ParsedKillEvent {
  /** Order within the match, starting at 1. */
  seq: number;
  atMs: number;
  /** 0 = executed. */
  killerParticipantId: number;
  victimParticipantId: number;
  assistParticipantIds: number[];
  positionX: number;
  positionY: number;
  bounty: number;
  shutdownBounty: number;
}

export interface ParsedObjectiveEvent {
  /** Order within the match, starting at 1. */
  seq: number;
  atMs: number;
  type: ObjectiveType;
  /** Dragon: 'FIRE_DRAGON'…; tower: 'OUTER_TURRET'… */
  subtype: string | null;
  /** Towers/plates/inhibitors: 'TOP_LANE'… */
  lane: string | null;
  /** Team that took it. */
  teamId: 100 | 200;
  /** null/0 when minions took it. */
  killerParticipantId: number | null;
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
  killEvents: ParsedKillEvent[];
  objectiveEvents: ParsedObjectiveEvent[];
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
  leaguePoints: number;
  wins: number;
  losses: number;
}

export interface LadderUpsertResult {
  /** Puuids that are new on the ladder or whose wins+losses changed → list their match ids. */
  played: string[];
  /** Subset of `played` that was not on this platform's ladder before. */
  added: string[];
  /** Number of ladder entries removed (players who dropped off). */
  removed: number;
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

export interface QueuedMatch {
  matchId: string;
  platform: Platform;
  attempts: number;
}

export interface QueuedEnrichment {
  puuid: string;
  platform: Platform;
  attempts: number;
}

export interface DailyRefreshCandidate {
  puuid: string;
  /** Riot ID older than the threshold (or never fetched) → account-v1. */
  needsAccount: boolean;
  /** Masteries older than the threshold (or never fetched) → champion-mastery-v4. */
  needsMastery: boolean;
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

// ---------------------------------------------------------------------------
// Live game lookups (live_player_profiles / live_player_masteries, 0013)
// ---------------------------------------------------------------------------

export type LiveLookupStatus = 'PENDING' | 'READY' | 'FAILED';

/** One recent ranked solo match of a looked-up player (from Riot, or from our stored matches). */
export interface LiveRecentMatch {
  matchId: string;
  championId: number;
  /** teamPosition; null when Riot couldn't infer it. */
  position: Position | null;
  win: boolean;
  /** Remakes are kept in the list (so they are not fetched again) but not counted. */
  remake: boolean;
  /** ISO-8601. */
  endedAt: string;
}

/** A player of a live game the API asks the worker to look up. */
export interface LiveLookupRequest {
  puuid: string;
  /** Champion the player has in that game: its mastery is fetched. */
  championId: number;
}

/** A PENDING lookup claimed by the worker: only the parts not up to date are fetched. */
export interface LiveLookupJob {
  puuid: string;
  platform: Platform;
  /** `request_seq` when claimed: the parts fetched now are stored with it. */
  requestSeq: number;
  needsRank: boolean;
  needsRecent: boolean;
  /** Champions whose mastery was asked for and not fetched yet. */
  masteryChampionIds: number[];
  /** Recent matches stored by a previous lookup (reused instead of fetching them again). */
  previousRecent: LiveRecentMatch[];
  attempts: number;
}

/** What the API reads back for one requested player (and the champion they play). */
export interface LiveProfile {
  puuid: string;
  platform: Platform;
  status: LiveLookupStatus;
  /** Rank fetched at least once (possibly by an earlier lookup being refreshed). */
  rankLoaded: boolean;
  /** Solo queue rank; null when unranked (or not loaded yet). */
  rank: SoloRankInput | null;
  /** Null until the recent matches are fetched. */
  recent: LiveRecentMatch[] | null;
  /** Mastery of the requested champion; null until fetched. */
  mastery: { level: number; points: number } | null;
  lastError: string | null;
}
