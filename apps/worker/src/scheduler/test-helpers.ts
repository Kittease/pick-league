/** Fakes shared by the scheduler integration tests (a fake Riot API, patches, a fixed clock). */
import type { Db } from '@pick-league/db';
import {
  type ApexLadderTier,
  type ChampionMasteryDto,
  comparePatches,
  type Division,
  type LeagueEntryDto,
  type LeagueListDto,
  type MatchDto,
  type Platform,
  type StaticPatchData,
  type TimelineDto,
} from '@pick-league/shared';
import matchFixture from '../parser/fixtures/match.json';
import timelineFixture from '../parser/fixtures/timeline.json';
import type { PatchVerdict } from '../patches.ts';
import type { MatchIdsQuery, Priority, RiotApi } from '../riot/client.ts';
import type { PatchView } from './platform-worker.ts';

export const NOW = Date.parse('2026-11-13T12:00:00Z');
export const DAY = 86_400_000;

export async function count(db: Db, table: string): Promise<number> {
  const [row] = await db.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`);
  return row?.n ?? -1;
}

export const ladderPuuid = (n: number) => `fake-ladder-puuid-${String(n).padStart(3, '0')}`;

export function staticPatch(patch: string): StaticPatchData {
  return {
    patch,
    ddragonVersion: `${patch}.1`,
    champions: [],
    items: [],
    runeTrees: [],
    runes: [],
    summonerSpells: [],
  };
}

/** A fixture match re-labelled with another id, patch and (optionally) player 1. */
export function makeMatch(id: string, gameVersion: string, player1?: string) {
  const match = structuredClone(matchFixture) as unknown as MatchDto;
  const timeline = structuredClone(timelineFixture) as unknown as TimelineDto;
  match.metadata.matchId = id;
  timeline.metadata.matchId = id;
  match.info.gameVersion = gameVersion;
  for (const p of match.info.participants) p.puuid = `${p.puuid.slice(0, 14)}-${id}`;
  if (player1 && match.info.participants[0]) match.info.participants[0].puuid = player1;
  return { match, timeline };
}

/**
 * A latest-patch fixture match with the given start, length and first participants (the other
 * participants keep puuids of their own); `remake`: ended by an early surrender vote.
 */
export function makeTimedMatch(
  id: string,
  opts: { startMs: number; durationS?: number; players?: readonly string[]; remake?: boolean },
) {
  const m = makeMatch(id, '15.22.715.1234');
  const durationS = opts.remake ? 200 : (opts.durationS ?? 1800);
  m.match.info.gameCreation = opts.startMs - 60_000;
  m.match.info.gameStartTimestamp = opts.startMs;
  m.match.info.gameDuration = durationS;
  m.match.info.gameEndTimestamp = opts.startMs + durationS * 1000;
  (opts.players ?? []).forEach((puuid, i) => {
    const p = m.match.info.participants[i];
    if (p) p.puuid = puuid;
  });
  if (opts.remake) for (const p of m.match.info.participants) p.gameEndedInEarlySurrender = true;
  return m;
}

/** The solo queue entry of a player, as league-v4 entries/by-puuid gives it. */
export function soloEntry(
  puuid: string,
  tier: LeagueEntryDto['tier'],
  games: number,
  leaguePoints = 50,
  rank: Division = 'I',
): LeagueEntryDto {
  return {
    puuid,
    queueType: 'RANKED_SOLO_5x5',
    tier,
    rank,
    leaguePoints,
    wins: games,
    losses: 0,
    hotStreak: false,
    veteran: false,
    freshBlood: false,
    inactive: false,
  };
}

/** A solo queue entry of a Diamond division page. */
export function diamondEntry(
  puuid: string,
  division: Division,
  leaguePoints: number,
  games: number,
): LeagueEntryDto {
  return {
    puuid,
    queueType: 'RANKED_SOLO_5x5',
    tier: 'DIAMOND',
    rank: division,
    leaguePoints,
    wins: games,
    losses: 10,
    hotStreak: false,
    veteran: false,
    freshBlood: false,
    inactive: false,
  };
}

export class FakeRiot implements RiotApi {
  calls: string[] = [];
  leagues: Record<ApexLadderTier, LeagueListDto> = {
    CHALLENGER: { leagueId: 'l', tier: 'CHALLENGER', name: 'n', queue: 'q', entries: [] },
    GRANDMASTER: { leagueId: 'l', tier: 'GRANDMASTER', name: 'n', queue: 'q', entries: [] },
    MASTER: { leagueId: 'l', tier: 'MASTER', name: 'n', queue: 'q', entries: [] },
  };
  /** Diamond divisions, served `diamondPageSize` entries per page. */
  diamond: Record<Division, LeagueEntryDto[]> = { I: [], II: [], III: [], IV: [] };
  diamondPageSize = 2;
  matchIds = new Map<string, string[]>();
  idQueries: MatchIdsQuery[] = [];
  matches = new Map<string, { match: MatchDto; timeline: TimelineDto }>();
  /** Errors thrown by the next calls, keyed like `calls` ('match:EUW1_1', 'league:CHALLENGER'…). */
  errors = new Map<string, Error[]>();

  private maybeThrow(call: string) {
    const err = this.errors.get(call)?.shift();
    if (err) throw err;
  }

  async getLeague(_p: Platform, tier: ApexLadderTier) {
    this.calls.push(`league:${tier}`);
    this.maybeThrow(`league:${tier}`);
    return this.leagues[tier];
  }
  async getDiamondEntries(_p: Platform, division: Division, page: number) {
    this.calls.push(`diamond:${division}:${page}`);
    this.maybeThrow(`diamond:${division}:${page}`);
    const from = (page - 1) * this.diamondPageSize;
    return this.diamond[division].slice(from, from + this.diamondPageSize);
  }
  /** When set, match-id listings wait for it (after recording the call). */
  idsGate: Promise<void> | null = null;

  async getMatchIds(_p: Platform, puuid: string, q: MatchIdsQuery) {
    this.calls.push(`ids:${puuid}:${q.start}`);
    this.maybeThrow(`ids:${puuid}:${q.start}`);
    if (this.idsGate) await this.idsGate;
    this.idQueries.push(q);
    const all = this.matchIds.get(puuid) ?? [];
    const start = q.start ?? 0;
    return all.slice(start, start + (q.count ?? 100));
  }
  /** Matches whose fetch waits for a promise (after recording the call). */
  matchGates = new Map<string, Promise<void>>();

  /** Rate-limit priority each match was asked with (undefined: the default). */
  matchPriorities = new Map<string, Priority | undefined>();

  async getMatch(_p: Platform, id: string, _signal?: AbortSignal, priority?: Priority) {
    this.calls.push(`match:${id}`);
    this.matchPriorities.set(id, priority);
    this.maybeThrow(`match:${id}`);
    await this.matchGates.get(id);
    return this.matches.get(id)?.match ?? null;
  }
  async getTimeline(_p: Platform, id: string) {
    this.calls.push(`timeline:${id}`);
    this.maybeThrow(`timeline:${id}`);
    return this.matches.get(id)?.timeline ?? null;
  }
  /** Champions of every mastery answer. */
  masteryChampionIds: number[] = [412];

  async getMasteries(
    _p: Platform,
    puuid: string,
    priority: Priority,
  ): Promise<ChampionMasteryDto[]> {
    this.calls.push(`mastery:${puuid}:${priority}`);
    this.maybeThrow(`mastery:${puuid}`);
    return this.masteryChampionIds.map((championId) => ({
      puuid,
      championId,
      championLevel: 30,
      championPoints: 400000,
      lastPlayTime: NOW - DAY,
      championPointsSinceLastLevel: 0,
      championPointsUntilNextLevel: 0,
    }));
  }
  /** Solo queue entries of given players (the others are Diamond II, 190 games). */
  leagueEntries = new Map<string, LeagueEntryDto[]>();
  /** When set, the solo queue entry requests wait for it (after recording the call). */
  entriesGate: Promise<void> | null = null;

  async getLeagueEntries(
    _p: Platform,
    puuid: string,
    priority: Priority,
  ): Promise<LeagueEntryDto[]> {
    this.calls.push(`entries:${puuid}:${priority}`);
    this.maybeThrow(`entries:${puuid}`);
    if (this.entriesGate) await this.entriesGate;
    const own = this.leagueEntries.get(puuid);
    if (own) return own;
    return [
      {
        puuid,
        queueType: 'RANKED_SOLO_5x5',
        tier: 'DIAMOND',
        rank: 'II',
        leaguePoints: 42,
        wins: 100,
        losses: 90,
        hotStreak: false,
        veteran: false,
        freshBlood: false,
        inactive: false,
      },
    ];
  }
}

export class FakePatches implements PatchView {
  ready = true;
  generation = 1;
  latest: string | null = '15.22';
  previous: string | null = '15.21';
  refreshRequests = 0;
  classify(patch: string): PatchVerdict {
    if (this.latest === null) return 'too_new';
    const c = comparePatches(patch, this.latest);
    if (c > 0) return 'too_new';
    if (c === 0) return 'keep';
    return patch === this.previous ? 'previous' : 'old';
  }
  requestRefresh() {
    this.refreshRequests++;
  }
}

export const fixedClock = {
  now: () => NOW,
  setTimer: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, Math.min(ms, 20));
    return () => clearTimeout(t);
  },
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      // Long sleeps (ladder interval) only end with the abort; short ones are shortened.
      const t = ms < 60_000 ? setTimeout(resolve, Math.min(ms, 20)) : undefined;
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('Aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }),
};
