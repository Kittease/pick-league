/**
 * MatchDto + TimelineDto → ParsedMatch (the schema's fields only). Pure.
 *
 * Riot payloads are not fully reliable (fields appear/disappear between patches), so every
 * numeric stat falls back to 0 and unknown timeline event types are ignored.
 */
import type {
  ParsedBan,
  ParsedItemEvent,
  ParsedKillEvent,
  ParsedMatch,
  ParsedObjectiveEvent,
  ParsedParticipant,
  ParsedSkillEvent,
  ParsedTeam,
} from '@pick-league/db';
import {
  type ItemEventType,
  isPlatform,
  isTimelineEvent,
  type MatchDto,
  type MatchParticipantDto,
  type MatchTeamDto,
  type ObjectiveType,
  type ParticipantFrameDto,
  type Platform,
  parsePosition,
  patchFromGameVersion,
  platformFromMatchId,
  type TimelineDto,
  type TimelineEventDto,
} from '@pick-league/shared';

export class MatchParseError extends Error {
  override name = 'MatchParseError';
}

/** A remake ends before this many seconds (the remake vote opens at 3:00, games end ~3:30). */
export const REMAKE_MAX_DURATION_S = 300;
/** A surrender before this many seconds counts as an early (15-minute) surrender. */
export const EARLY_SURRENDER_MAX_DURATION_S = 20 * 60;

type TeamId = 100 | 200;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const asTeamId = (v: unknown): TeamId | null => (v === 100 || v === 200 ? v : null);
const otherTeam = (t: TeamId): TeamId => (t === 100 ? 200 : 100);

/** `gameDuration` is in seconds when `gameEndTimestamp` is present (since 11.20), else in ms. */
export function durationSeconds(info: MatchDto['info']): number {
  const d = num(info.gameDuration);
  return info.gameEndTimestamp !== undefined ? Math.round(d) : Math.round(d / 1000);
}

/** Remake: aborted, or ended by the early-surrender vote within the first minutes. */
export function isRemakeMatch(info: MatchDto['info']): boolean {
  const aborted = (info.endOfGameResult ?? '').toLowerCase().startsWith('abort');
  const anyEarlySurrender = (info.participants ?? []).some(
    (p) => p.gameEndedInEarlySurrender === true,
  );
  return aborted || (anyEarlySurrender && durationSeconds(info) < REMAKE_MAX_DURATION_S);
}

export function parseMatch(match: MatchDto, timeline: TimelineDto): ParsedMatch {
  const info = match.info;
  const matchId = match.metadata?.matchId;
  if (!matchId) throw new MatchParseError('match has no metadata.matchId');
  if (timeline.metadata?.matchId && timeline.metadata.matchId !== matchId) {
    throw new MatchParseError(
      `timeline ${timeline.metadata.matchId} does not belong to match ${matchId}`,
    );
  }
  const platformId = (info.platformId ?? '').toUpperCase();
  const platform: Platform | null = isPlatform(platformId)
    ? platformId
    : platformFromMatchId(matchId);
  if (!platform) throw new MatchParseError(`unknown platform for ${matchId}`);
  if (!info.gameVersion) throw new MatchParseError(`${matchId} has no gameVersion`);
  const patch = patchFromGameVersion(info.gameVersion);

  const participantsDto = info.participants ?? [];
  if (participantsDto.length !== 10) {
    throw new MatchParseError(`${matchId} has ${participantsDto.length} participants, expected 10`);
  }
  const frames = [...(timeline.info?.frames ?? [])].sort((a, b) => a.timestamp - b.timestamp);
  if (frames.length === 0) throw new MatchParseError(`${matchId} timeline has no frames`);

  const durationS = durationSeconds(info);
  const anyEarlySurrender = participantsDto.some((p) => p.gameEndedInEarlySurrender === true);
  const anySurrender = participantsDto.some((p) => p.gameEndedInSurrender === true);
  const isRemake = isRemakeMatch(info);
  const isEarlySurrender =
    !isRemake && (anyEarlySurrender || anySurrender) && durationS < EARLY_SURRENDER_MAX_DURATION_S;

  const teams = (info.teams ?? []).flatMap((t) => parseTeam(t));
  const winningTeam: TeamId =
    teams.find((t) => t.win)?.teamId ?? asTeamId(participantsDto.find((p) => p.win)?.teamId) ?? 100;

  const participants = participantsDto.map((p) => parseParticipant(p, frames));
  const ids = new Set(participants.map((p) => p.participantId));
  if (ids.size !== 10) throw new MatchParseError(`${matchId} has duplicate participant ids`);

  const events = frames.flatMap((f) => f.events ?? []);
  const teamOf = new Map(participants.map((p) => [p.participantId, p.teamId]));

  return {
    match: {
      id: matchId,
      platform,
      patch,
      gameVersion: info.gameVersion,
      queueId: num(info.queueId),
      startedAt: new Date(num(info.gameStartTimestamp) || num(info.gameCreation)),
      durationS,
      isRemake,
      isEarlySurrender,
      winningTeam,
    },
    teams,
    bans: (info.teams ?? []).flatMap((t) => parseBans(t)),
    participants,
    itemEvents: parseItemEvents(events, ids),
    skillEvents: parseSkillEvents(events, ids),
    killEvents: parseKillEvents(events),
    objectiveEvents: parseObjectiveEvents(events, teamOf),
  };
}

function parseTeam(t: MatchTeamDto): ParsedTeam[] {
  const teamId = asTeamId(t.teamId);
  if (teamId === null) return [];
  const o = t.objectives ?? ({} as MatchTeamDto['objectives']);
  return [
    {
      teamId,
      win: t.win === true,
      firstBlood: o.champion?.first === true,
      firstTower: o.tower?.first === true,
      firstDragon: o.dragon?.first === true,
      firstBaron: o.baron?.first === true,
      championKills: num(o.champion?.kills),
      towerKills: num(o.tower?.kills),
      inhibitorKills: num(o.inhibitor?.kills),
      dragonKills: num(o.dragon?.kills),
      baronKills: num(o.baron?.kills),
      heraldKills: num(o.riftHerald?.kills),
      voidgrubKills: num(o.horde?.kills),
      atakhanKills: num(o.atakhan?.kills),
    },
  ];
}

function parseBans(t: MatchTeamDto): ParsedBan[] {
  const teamId = asTeamId(t.teamId);
  if (teamId === null) return [];
  return (t.bans ?? []).map((b) => ({
    teamId,
    pickTurn: num(b.pickTurn),
    championId: typeof b.championId === 'number' ? b.championId : -1,
  }));
}

function parseRunes(p: MatchParticipantDto) {
  const styles = p.perks?.styles ?? [];
  const primary = styles.find((s) => s.description === 'primaryStyle') ?? styles[0];
  const secondary = styles.find((s) => s.description === 'subStyle') ?? styles[1];
  const perks = (s: typeof primary, n: number) => {
    const list = (s?.selections ?? []).map((sel) => num(sel.perk)).slice(0, n);
    while (list.length < n) list.push(0);
    return list;
  };
  const shards = p.perks?.statPerks;
  return {
    runePrimaryTree: num(primary?.style),
    runeSecondaryTree: num(secondary?.style),
    runes: [...perks(primary, 4), ...perks(secondary, 2)],
    statShards: [num(shards?.offense), num(shards?.flex), num(shards?.defense)],
  };
}

function parseParticipant(
  p: MatchParticipantDto,
  frames: TimelineDto['info']['frames'],
): ParsedParticipant {
  const teamId = asTeamId(p.teamId);
  if (teamId === null) throw new MatchParseError(`participant ${p.participantId} has no team`);
  if (!p.puuid) throw new MatchParseError(`participant ${p.participantId} has no puuid`);
  const perMinute = participantFrames(p.participantId, frames);
  return {
    participantId: p.participantId,
    puuid: p.puuid,
    riotIdGameName: p.riotIdGameName || null,
    riotIdTagLine: p.riotIdTagline || null,
    teamId,
    championId: num(p.championId),
    position: parsePosition(p.teamPosition),
    win: p.win === true,
    summonerSpell1: num(p.summoner1Id),
    summonerSpell2: num(p.summoner2Id),
    ...parseRunes(p),
    finalItems: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map(num),
    champLevel: num(p.champLevel),
    kills: num(p.kills),
    deaths: num(p.deaths),
    assists: num(p.assists),
    laneMinions: num(p.totalMinionsKilled),
    jungleMinions: num(p.neutralMinionsKilled),
    goldEarned: num(p.goldEarned),
    goldSpent: num(p.goldSpent),
    damageToChampions: num(p.totalDamageDealtToChampions),
    physicalDamageToChampions: num(p.physicalDamageDealtToChampions),
    magicDamageToChampions: num(p.magicDamageDealtToChampions),
    trueDamageToChampions: num(p.trueDamageDealtToChampions),
    damageTaken: num(p.totalDamageTaken),
    damageSelfMitigated: num(p.damageSelfMitigated),
    damageToBuildings: num(p.damageDealtToBuildings),
    damageToObjectives: num(p.damageDealtToObjectives),
    healingDone: num(p.totalHeal),
    healsOnTeammates: num(p.totalHealsOnTeammates),
    shieldsOnTeammates: num(p.totalDamageShieldedOnTeammates),
    ccTimeOnOthersS: num(p.timeCCingOthers),
    visionScore: num(p.visionScore),
    wardsPlaced: num(p.wardsPlaced),
    wardsKilled: num(p.wardsKilled),
    controlWardsBought: num(p.visionWardsBoughtInGame),
    ...perMinute,
  };
}

/** One value per frame; a frame missing this participant repeats the previous value. */
function participantFrames(participantId: number, frames: TimelineDto['info']['frames']) {
  const out = {
    goldByMinute: [] as number[],
    xpByMinute: [] as number[],
    csByMinute: [] as number[],
    levelByMinute: [] as number[],
    damageToChampionsByMinute: [] as number[],
    positionXByMinute: [] as number[],
    positionYByMinute: [] as number[],
  };
  let last: ParticipantFrameDto | undefined;
  for (const f of frames) {
    const pf = f.participantFrames?.[String(participantId)] ?? last;
    last = pf;
    out.goldByMinute.push(num(pf?.totalGold));
    out.xpByMinute.push(num(pf?.xp));
    out.csByMinute.push(num(pf?.minionsKilled) + num(pf?.jungleMinionsKilled));
    out.levelByMinute.push(num(pf?.level));
    out.damageToChampionsByMinute.push(num(pf?.damageStats?.totalDamageDoneToChampions));
    out.positionXByMinute.push(num(pf?.position?.x));
    out.positionYByMinute.push(num(pf?.position?.y));
  }
  return out;
}

const ITEM_EVENT_TYPES: Record<string, ItemEventType> = {
  ITEM_PURCHASED: 'PURCHASED',
  ITEM_SOLD: 'SOLD',
  ITEM_DESTROYED: 'DESTROYED',
  ITEM_UNDO: 'UNDO',
};

function parseItemEvents(events: TimelineEventDto[], ids: Set<number>): ParsedItemEvent[] {
  const seq = new Map<number, number>();
  const out: ParsedItemEvent[] = [];
  for (const e of events) {
    const type = ITEM_EVENT_TYPES[e.type];
    if (!type) continue;
    const ev = e as unknown as Record<string, unknown>;
    const participantId = num(ev.participantId);
    if (!ids.has(participantId)) continue;
    const n = (seq.get(participantId) ?? 0) + 1;
    seq.set(participantId, n);
    if (type === 'UNDO') {
      out.push({
        participantId,
        seq: n,
        atMs: num(e.timestamp),
        type,
        itemId: num(ev.beforeId),
        undoAfterItemId: num(ev.afterId),
        undoGoldGain: num(ev.goldGain),
      });
    } else {
      out.push({
        participantId,
        seq: n,
        atMs: num(e.timestamp),
        type,
        itemId: num(ev.itemId),
        undoAfterItemId: null,
        undoGoldGain: null,
      });
    }
  }
  return out;
}

function parseSkillEvents(events: TimelineEventDto[], ids: Set<number>): ParsedSkillEvent[] {
  const seq = new Map<number, number>();
  const out: ParsedSkillEvent[] = [];
  for (const e of events) {
    if (!isTimelineEvent(e, 'SKILL_LEVEL_UP')) continue;
    if (!ids.has(e.participantId)) continue;
    const slot = num(e.skillSlot);
    if (slot < 1 || slot > 4) continue;
    const n = (seq.get(e.participantId) ?? 0) + 1;
    seq.set(e.participantId, n);
    out.push({
      participantId: e.participantId,
      seq: n,
      atMs: num(e.timestamp),
      skillSlot: slot,
      isEvolve: e.levelUpType === 'EVOLVE',
    });
  }
  return out;
}

function parseKillEvents(events: TimelineEventDto[]): ParsedKillEvent[] {
  const out: ParsedKillEvent[] = [];
  for (const e of events) {
    if (!isTimelineEvent(e, 'CHAMPION_KILL')) continue;
    out.push({
      seq: out.length + 1,
      atMs: num(e.timestamp),
      killerParticipantId: num(e.killerId),
      victimParticipantId: num(e.victimId),
      assistParticipantIds: (e.assistingParticipantIds ?? []).map(num),
      positionX: num(e.position?.x),
      positionY: num(e.position?.y),
      bounty: num(e.bounty),
      shutdownBounty: num(e.shutdownBounty),
    });
  }
  return out;
}

const MONSTER_TYPES: Record<string, ObjectiveType> = {
  DRAGON: 'DRAGON',
  BARON_NASHOR: 'BARON',
  RIFTHERALD: 'RIFT_HERALD',
  HORDE: 'VOIDGRUB',
  ATAKHAN: 'ATAKHAN',
};

function parseObjectiveEvents(
  events: TimelineEventDto[],
  teamOf: Map<number, TeamId>,
): ParsedObjectiveEvent[] {
  const out: ParsedObjectiveEvent[] = [];
  const push = (e: Omit<ParsedObjectiveEvent, 'seq'>) => out.push({ seq: out.length + 1, ...e });
  const killer = (id: unknown) => (num(id) > 0 ? num(id) : null);

  for (const e of events) {
    if (isTimelineEvent(e, 'ELITE_MONSTER_KILL')) {
      let type = MONSTER_TYPES[e.monsterType];
      if (!type) continue;
      const subtype = e.monsterSubType || null;
      if (type === 'DRAGON' && subtype === 'ELDER_DRAGON') type = 'ELDER_DRAGON';
      const teamId = asTeamId(e.killerTeamId) ?? teamOf.get(num(e.killerId)) ?? null;
      if (teamId === null) continue;
      push({
        atMs: num(e.timestamp),
        type,
        subtype,
        lane: null,
        teamId,
        killerParticipantId: killer(e.killerId),
      });
    } else if (isTimelineEvent(e, 'BUILDING_KILL')) {
      const type: ObjectiveType | null =
        e.buildingType === 'TOWER_BUILDING'
          ? 'TOWER'
          : e.buildingType === 'INHIBITOR_BUILDING'
            ? 'INHIBITOR'
            : null;
      const owner = asTeamId(e.teamId);
      if (!type || owner === null) continue;
      push({
        atMs: num(e.timestamp),
        type,
        subtype: type === 'TOWER' ? e.towerType || null : null,
        lane: e.laneType || null,
        teamId: otherTeam(owner),
        killerParticipantId: killer(e.killerId),
      });
    } else if (isTimelineEvent(e, 'TURRET_PLATE_DESTROYED')) {
      const owner = asTeamId(e.teamId);
      if (owner === null) continue;
      push({
        atMs: num(e.timestamp),
        type: 'TURRET_PLATE',
        subtype: null,
        lane: e.laneType || null,
        teamId: otherTeam(owner),
        killerParticipantId: killer(e.killerId),
      });
    }
  }
  return out;
}
