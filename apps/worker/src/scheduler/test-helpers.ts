/** Fakes shared by the scheduler integration tests (a fake Riot API, patches, a fixed clock). */
import type { Db } from '@pick-league/db';
import {
  type ApexLadderTier,
  type ChampionMasteryDto,
  comparePatches,
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

export class FakeRiot implements RiotApi {
  calls: string[] = [];
  leagues: Record<ApexLadderTier, LeagueListDto> = {
    CHALLENGER: { leagueId: 'l', tier: 'CHALLENGER', name: 'n', queue: 'q', entries: [] },
    GRANDMASTER: { leagueId: 'l', tier: 'GRANDMASTER', name: 'n', queue: 'q', entries: [] },
    MASTER: { leagueId: 'l', tier: 'MASTER', name: 'n', queue: 'q', entries: [] },
  };
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
  async getMatch(_p: Platform, id: string) {
    this.calls.push(`match:${id}`);
    this.maybeThrow(`match:${id}`);
    return this.matches.get(id)?.match ?? null;
  }
  async getTimeline(_p: Platform, id: string) {
    this.calls.push(`timeline:${id}`);
    this.maybeThrow(`timeline:${id}`);
    return this.matches.get(id)?.timeline ?? null;
  }
  async getMasteries(
    _p: Platform,
    puuid: string,
    priority: Priority,
  ): Promise<ChampionMasteryDto[]> {
    this.calls.push(`mastery:${puuid}:${priority}`);
    return [
      {
        puuid,
        championId: 412,
        championLevel: 30,
        championPoints: 400000,
        lastPlayTime: NOW - DAY,
        championPointsSinceLastLevel: 0,
        championPointsUntilNextLevel: 0,
      },
    ];
  }
  async getLeagueEntries(
    _p: Platform,
    puuid: string,
    priority: Priority,
  ): Promise<LeagueEntryDto[]> {
    this.calls.push(`entries:${puuid}:${priority}`);
    this.maybeThrow(`entries:${puuid}`);
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
