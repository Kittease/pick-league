/**
 * Riot API response shapes (DTOs) — only the fields PickLeague reads, with Riot's names.
 * Riot may add fields at any time: never rely on exhaustiveness of these objects.
 */

// ---------------------------------------------------------------------------
// league-v4
// ---------------------------------------------------------------------------

/** Entry of `GET /lol/league/v4/{challenger|grandmaster|master}leagues/by-queue/{queue}`. */
export interface LeagueItemDto {
  puuid: string;
  /** Deprecated by Riot, may be absent. */
  summonerId?: string;
  leaguePoints: number;
  /** Division ('I') — meaningless for apex tiers. */
  rank: string;
  wins: number;
  losses: number;
  veteran: boolean;
  inactive: boolean;
  freshBlood: boolean;
  hotStreak: boolean;
}

/** `GET /lol/league/v4/{challenger|grandmaster|master}leagues/by-queue/RANKED_SOLO_5x5`. */
export interface LeagueListDto {
  leagueId: string;
  /** 'CHALLENGER' | 'GRANDMASTER' | 'MASTER' */
  tier: string;
  name: string;
  queue: string;
  entries: LeagueItemDto[];
}

/** Element of `GET /lol/league/v4/entries/by-puuid/{puuid}` (an array, one per queue). */
export interface LeagueEntryDto {
  leagueId?: string;
  puuid: string;
  summonerId?: string;
  /** 'RANKED_SOLO_5x5' | 'RANKED_FLEX_SR' | ... */
  queueType: string;
  /** 'IRON' ... 'CHALLENGER' */
  tier: string;
  /** 'I' | 'II' | 'III' | 'IV' */
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak: boolean;
  veteran: boolean;
  freshBlood: boolean;
  inactive: boolean;
}

// ---------------------------------------------------------------------------
// champion-mastery-v4
// ---------------------------------------------------------------------------

/** Element of `GET /lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}`. */
export interface ChampionMasteryDto {
  puuid: string;
  championId: number;
  championLevel: number;
  championPoints: number;
  /** Epoch milliseconds. */
  lastPlayTime: number;
  championPointsSinceLastLevel: number;
  championPointsUntilNextLevel: number;
  tokensEarned?: number;
  chestGranted?: boolean;
}

// ---------------------------------------------------------------------------
// account-v1
// ---------------------------------------------------------------------------

/** `GET /riot/account/v1/accounts/by-puuid/{puuid}` */
export interface AccountDto {
  puuid: string;
  /** Absent if the account has no Riot ID. */
  gameName?: string;
  tagLine?: string;
}

// ---------------------------------------------------------------------------
// match-v5: match
// ---------------------------------------------------------------------------

/** `GET /lol/match/v5/matches/by-puuid/{puuid}/ids` */
export type MatchIdsDto = string[];

export interface MatchDto {
  metadata: MatchMetadataDto;
  info: MatchInfoDto;
}

export interface MatchMetadataDto {
  dataVersion: string;
  /** 'EUW1_7234567890' */
  matchId: string;
  /** PUUIDs in participant order. */
  participants: string[];
}

export interface MatchInfoDto {
  /** e.g. 'GameComplete'; absent in older payloads. */
  endOfGameResult?: string;
  /** Epoch ms. */
  gameCreation: number;
  /** Seconds (since patch 11.20, always when `gameEndTimestamp` is present). */
  gameDuration: number;
  /** Epoch ms. */
  gameEndTimestamp?: number;
  gameId: number;
  gameMode: string;
  /** Epoch ms. */
  gameStartTimestamp: number;
  gameType: string;
  /** '15.22.715.1234' */
  gameVersion: string;
  mapId: number;
  /** 'EUW1' */
  platformId: string;
  queueId: number;
  participants: MatchParticipantDto[];
  teams: MatchTeamDto[];
}

export interface PerkSelectionDto {
  perk: number;
  var1: number;
  var2: number;
  var3: number;
}

export interface PerkStyleDto {
  /** 'primaryStyle' (4 selections) | 'subStyle' (2 selections) */
  description: 'primaryStyle' | 'subStyle' | string;
  /** Rune tree id, e.g. 8000. */
  style: number;
  selections: PerkSelectionDto[];
}

export interface PerkStatsDto {
  offense: number;
  flex: number;
  defense: number;
}

export interface PerksDto {
  statPerks: PerkStatsDto;
  styles: PerkStyleDto[];
}

export interface MatchParticipantDto {
  participantId: number;
  puuid: string;
  /** Riot ID (may be empty string). */
  riotIdGameName?: string;
  riotIdTagline?: string;
  teamId: number;
  championId: number;
  championName: string;
  /** 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY' | '' */
  teamPosition: string;
  individualPosition: string;
  win: boolean;

  summoner1Id: number;
  summoner2Id: number;
  perks: PerksDto;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;

  champLevel: number;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  goldEarned: number;
  goldSpent: number;
  totalDamageDealtToChampions: number;
  physicalDamageDealtToChampions: number;
  magicDamageDealtToChampions: number;
  trueDamageDealtToChampions: number;
  totalDamageTaken: number;
  damageSelfMitigated: number;
  damageDealtToBuildings: number;
  damageDealtToObjectives: number;
  totalHeal: number;
  totalHealsOnTeammates: number;
  totalDamageShieldedOnTeammates: number;
  timeCCingOthers: number;
  visionScore: number;
  wardsPlaced: number;
  wardsKilled: number;
  visionWardsBoughtInGame: number;

  /** True for remakes. */
  gameEndedInEarlySurrender: boolean;
  gameEndedInSurrender: boolean;
  teamEarlySurrendered: boolean;
}

export interface BanDto {
  /** -1 = no ban */
  championId: number;
  pickTurn: number;
}

export interface ObjectiveDto {
  first: boolean;
  kills: number;
}

export interface ObjectivesDto {
  baron: ObjectiveDto;
  champion: ObjectiveDto;
  dragon: ObjectiveDto;
  /** Voidgrubs. */
  horde?: ObjectiveDto;
  inhibitor: ObjectiveDto;
  riftHerald: ObjectiveDto;
  tower: ObjectiveDto;
  /** Present since patch 25.S1.1 (Atakhan). */
  atakhan?: ObjectiveDto;
}

export interface MatchTeamDto {
  /** 100 | 200 */
  teamId: number;
  win: boolean;
  bans: BanDto[];
  objectives: ObjectivesDto;
}

// ---------------------------------------------------------------------------
// match-v5: timeline
// ---------------------------------------------------------------------------

export interface TimelineDto {
  metadata: MatchMetadataDto;
  info: TimelineInfoDto;
}

export interface TimelineInfoDto {
  /** Usually 60000. */
  frameInterval: number;
  frames: TimelineFrameDto[];
  gameId: number;
  participants: { participantId: number; puuid: string }[];
}

export interface TimelineFrameDto {
  /** ms since game start. */
  timestamp: number;
  /** Keyed by participant id as a string: '1'..'10'. */
  participantFrames: Record<string, ParticipantFrameDto>;
  events: TimelineEventDto[];
}

export interface PositionDto {
  x: number;
  y: number;
}

export interface ParticipantFrameDto {
  participantId: number;
  currentGold: number;
  totalGold: number;
  xp: number;
  level: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
  position: PositionDto;
  damageStats: {
    totalDamageDoneToChampions: number;
    [key: string]: number;
  };
}

interface EventBase {
  /** ms since game start. */
  timestamp: number;
}

export interface ItemPurchasedEventDto extends EventBase {
  type: 'ITEM_PURCHASED';
  participantId: number;
  itemId: number;
}

export interface ItemSoldEventDto extends EventBase {
  type: 'ITEM_SOLD';
  participantId: number;
  itemId: number;
}

export interface ItemDestroyedEventDto extends EventBase {
  type: 'ITEM_DESTROYED';
  participantId: number;
  itemId: number;
}

export interface ItemUndoEventDto extends EventBase {
  type: 'ITEM_UNDO';
  participantId: number;
  /** Item the undo reverted (0 when undoing a sell). */
  beforeId: number;
  /** Item restored by the undo (0 when undoing a purchase). */
  afterId: number;
  goldGain: number;
}

export interface SkillLevelUpEventDto extends EventBase {
  type: 'SKILL_LEVEL_UP';
  participantId: number;
  /** 1=Q 2=W 3=E 4=R */
  skillSlot: number;
  /** 'NORMAL' | 'EVOLVE' */
  levelUpType: string;
}

/** Any other event (CHAMPION_KILL, BUILDING_KILL, WARD_PLACED, LEVEL_UP, GAME_END, ...): kept loosely typed. */
export interface OtherTimelineEventDto extends EventBase {
  type: string;
  [key: string]: unknown;
}

export type KnownTimelineEventDto =
  | ItemPurchasedEventDto
  | ItemSoldEventDto
  | ItemDestroyedEventDto
  | ItemUndoEventDto
  | SkillLevelUpEventDto;

export type TimelineEventDto = KnownTimelineEventDto | OtherTimelineEventDto;

export type TimelineEventType = KnownTimelineEventDto['type'];

export type TimelineEventOf<T extends TimelineEventType> = Extract<
  KnownTimelineEventDto,
  { type: T }
>;

/**
 * Narrows a timeline event to a known type. Needed because the catch-all member
 * (`type: string`) prevents plain `event.type === '...'` narrowing.
 */
export function isTimelineEvent<T extends TimelineEventType>(
  event: TimelineEventDto,
  type: T,
): event is TimelineEventOf<T> {
  return event.type === type;
}
