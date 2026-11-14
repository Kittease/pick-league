/**
 * Live game lookups (0013): the API asks for players of a game in progress, the worker fetches
 * their rank, recent ranked solo matches and champion mastery at the highest priority.
 * A part (rank, recent matches) is up to date when its `*_seq` equals `request_seq`.
 */
import type { Platform, Position, SoloTier } from '@pick-league/shared';
import { byPuuid, inTransaction, type Queryable } from '../client.ts';
import type {
  LiveLookupJob,
  LiveLookupRequest,
  LiveLookupStatus,
  LiveProfile,
  LiveRecentMatch,
  SoloRankInput,
} from '../types.ts';

/** A READY lookup is reused this long, then fetched again when asked for (30 min). */
export const LIVE_PROFILE_TTL_MS = 30 * 60_000;
/** A FAILED lookup is tried again when asked for after this (5 min). */
export const LIVE_FAILED_RETRY_MS = 5 * 60_000;

export interface RequestLiveLookupsOptions {
  ttlMs?: number;
  failedRetryMs?: number;
  now?: Date;
}

/**
 * Asks the worker to look players up (idempotent: the desktop calls it on every poll). A player
 * never looked up, a READY one older than `ttlMs` (default 30 min) and a FAILED one older than
 * `failedRetryMs` (default 5 min) become PENDING with a new `request_seq`; a PENDING one is left
 * alone. The mastery of the requested champion is asked for too: a fresh READY profile asked
 * about another champion goes back to PENDING for that mastery only.
 * Returns the puuids that now have work queued.
 */
export async function requestLiveLookups(
  q: Queryable,
  platform: Platform,
  players: readonly LiveLookupRequest[],
  options: RequestLiveLookupsOptions = {},
): Promise<string[]> {
  const unique = [...new Map(players.map((p) => [p.puuid, p])).values()].sort(byPuuid);
  if (unique.length === 0) return [];
  const now = options.now ?? new Date();
  const staleCutoff = new Date(now.getTime() - (options.ttlMs ?? LIVE_PROFILE_TTL_MS));
  const failedCutoff = new Date(now.getTime() - (options.failedRetryMs ?? LIVE_FAILED_RETRY_MS));
  return inTransaction(q, async (tx) => {
    const requested = await tx<{ puuid: string; inserted: boolean }[]>`
      INSERT INTO live_player_profiles ${tx(
        unique.map((p) => ({ puuid: p.puuid, platform, requested_at: now, updated_at: now })),
      )}
      ON CONFLICT (puuid) DO UPDATE SET
        platform = EXCLUDED.platform,
        status = 'PENDING',
        request_seq = live_player_profiles.request_seq + 1,
        requested_at = EXCLUDED.requested_at,
        attempts = 0,
        last_error = NULL,
        updated_at = EXCLUDED.updated_at
      WHERE live_player_profiles.platform <> EXCLUDED.platform
         OR (live_player_profiles.status = 'READY'
             AND LEAST(live_player_profiles.rank_fetched_at, live_player_profiles.recent_fetched_at)
                 < ${staleCutoff})
         OR (live_player_profiles.status = 'FAILED'
             AND live_player_profiles.updated_at < ${failedCutoff})
      RETURNING puuid, (xmax = 0) AS inserted`;
    const queued = new Set(requested.map((r) => r.puuid));
    // A refreshed profile asks for its masteries again (only the requested champions').
    const refreshed = requested.filter((r) => !r.inserted).map((r) => r.puuid);
    if (refreshed.length > 0) {
      await tx`DELETE FROM live_player_masteries WHERE puuid = ANY(${refreshed}::text[])`;
    }
    const added = await tx<{ puuid: string }[]>`
      INSERT INTO live_player_masteries ${tx(
        unique.map((p) => ({ puuid: p.puuid, champion_id: p.championId })),
      )}
      ON CONFLICT (puuid, champion_id) DO NOTHING
      RETURNING puuid`;
    const masteryOnly = added.map((r) => r.puuid).filter((p) => !queued.has(p));
    if (masteryOnly.length > 0) {
      const reopened = await tx<{ puuid: string }[]>`
        UPDATE live_player_profiles SET status = 'PENDING', updated_at = ${now}
        WHERE puuid = ANY(${masteryOnly}::text[]) AND status = 'READY'
        RETURNING puuid`;
      for (const r of reopened) queued.add(r.puuid);
    }
    return [...queued].sort();
  });
}

interface ProfileRow {
  puuid: string;
  platform: Platform;
  status: LiveLookupStatus;
  rank_fetched_at: Date | null;
  solo_tier: SoloTier | null;
  solo_division: number | null;
  solo_lp: number | null;
  solo_wins: number | null;
  solo_losses: number | null;
  recent_fetched_at: Date | null;
  recent: LiveRecentMatch[] | null;
  last_error: string | null;
  level: number | null;
  points: number | null;
  mastery_fetched_at: Date | null;
}

/**
 * Profiles of the requested players with the mastery of the champion each one plays (players
 * never requested are missing from the result). Order of the result is not specified.
 */
export async function getLiveProfiles(
  q: Queryable,
  players: readonly LiveLookupRequest[],
): Promise<LiveProfile[]> {
  if (players.length === 0) return [];
  const puuids = players.map((p) => p.puuid);
  const champions = players.map((p) => p.championId);
  const rows = await q<ProfileRow[]>`
    SELECT p.puuid, p.platform, p.status, p.rank_fetched_at, p.solo_tier, p.solo_division,
           p.solo_lp, p.solo_wins, p.solo_losses, p.recent_fetched_at, p.recent, p.last_error,
           m.level, m.points, m.fetched_at AS mastery_fetched_at
    FROM unnest(${puuids}::text[], ${champions}::int[]) AS r(puuid, champion_id)
    JOIN live_player_profiles p ON p.puuid = r.puuid
    LEFT JOIN live_player_masteries m ON m.puuid = r.puuid AND m.champion_id = r.champion_id`;
  return rows.map((r) => ({
    puuid: r.puuid,
    platform: r.platform,
    status: r.status,
    rankLoaded: r.rank_fetched_at !== null,
    rank:
      r.solo_tier === null
        ? null
        : {
            tier: r.solo_tier,
            division: r.solo_division,
            lp: r.solo_lp ?? 0,
            wins: r.solo_wins ?? 0,
            losses: r.solo_losses ?? 0,
          },
    recent: r.recent_fetched_at === null ? null : (r.recent ?? []),
    mastery: r.mastery_fetched_at === null ? null : { level: r.level ?? 0, points: r.points ?? 0 },
    lastError: r.last_error,
  }));
}

/**
 * PENDING lookups of a platform, oldest request first, with what each still needs. Not locked:
 * the worker keeps the ones in flight aside itself.
 */
export async function claimLiveLookups(
  q: Queryable,
  platform: Platform,
  limit: number,
): Promise<LiveLookupJob[]> {
  const rows = await q<
    {
      puuid: string;
      platform: Platform;
      request_seq: number;
      rank_seq: number | null;
      recent_seq: number | null;
      recent: LiveRecentMatch[] | null;
      attempts: number;
      masteries: number[];
    }[]
  >`
    SELECT p.puuid, p.platform, p.request_seq, p.rank_seq, p.recent_seq, p.recent, p.attempts,
           COALESCE(
             array_agg(m.champion_id ORDER BY m.champion_id)
               FILTER (WHERE m.champion_id IS NOT NULL AND m.fetched_at IS NULL),
             '{}'
           ) AS masteries
    FROM live_player_profiles p
    LEFT JOIN live_player_masteries m ON m.puuid = p.puuid
    WHERE p.platform = ${platform} AND p.status = 'PENDING'
    GROUP BY p.puuid
    ORDER BY p.requested_at, p.puuid
    LIMIT ${limit}`;
  return rows.map((r) => ({
    puuid: r.puuid,
    platform: r.platform,
    requestSeq: r.request_seq,
    needsRank: r.rank_seq !== r.request_seq,
    needsRecent: r.recent_seq !== r.request_seq,
    masteryChampionIds: r.masteries.map(Number),
    previousRecent: r.recent ?? [],
    attempts: r.attempts,
  }));
}

/** Stores the solo queue rank (null = unranked) fetched for request `seq`. */
export async function storeLiveRank(
  q: Queryable,
  puuid: string,
  seq: number,
  rank: SoloRankInput | null,
  now: Date = new Date(),
): Promise<void> {
  await q`
    UPDATE live_player_profiles SET
      rank_seq = ${seq},
      rank_fetched_at = ${now},
      solo_tier = ${rank?.tier ?? null},
      solo_division = ${rank?.division ?? null},
      solo_lp = ${rank?.lp ?? null},
      solo_wins = ${rank?.wins ?? null},
      solo_losses = ${rank?.losses ?? null},
      updated_at = ${now}
    WHERE puuid = ${puuid}`;
}

/** Stores the mastery of one champion (level 0 / 0 points when never played). */
export async function storeLiveMastery(
  q: Queryable,
  puuid: string,
  championId: number,
  mastery: { level: number; points: number },
  now: Date = new Date(),
): Promise<void> {
  await q`
    UPDATE live_player_masteries SET
      level = ${mastery.level}, points = ${mastery.points}, fetched_at = ${now}
    WHERE puuid = ${puuid} AND champion_id = ${championId}`;
}

/** Stores the recent matches (newest first) fetched for request `seq`. */
export async function storeLiveRecent(
  q: Queryable,
  puuid: string,
  seq: number,
  recent: readonly LiveRecentMatch[],
  now: Date = new Date(),
): Promise<void> {
  const json = recent.map((m) => ({ ...m }));
  await q`
    UPDATE live_player_profiles SET
      recent_seq = ${seq},
      recent_fetched_at = ${now},
      recent = ${q.json(json)},
      updated_at = ${now}
    WHERE puuid = ${puuid}`;
}

/**
 * Marks the lookup READY when every part is up to date (a request or a mastery added meanwhile
 * keeps it PENDING: it is claimed again for what is missing). Returns whether it is READY.
 */
export async function finishLiveLookup(
  q: Queryable,
  puuid: string,
  now: Date = new Date(),
): Promise<boolean> {
  const res = await q`
    UPDATE live_player_profiles p SET
      status = 'READY', attempts = 0, last_error = NULL, updated_at = ${now}
    WHERE p.puuid = ${puuid} AND p.status = 'PENDING'
      AND p.rank_seq = p.request_seq AND p.recent_seq = p.request_seq
      AND NOT EXISTS (
        SELECT 1 FROM live_player_masteries m WHERE m.puuid = p.puuid AND m.fetched_at IS NULL
      )`;
  return res.count > 0;
}

/**
 * Records a failed attempt: the lookup stays PENDING until `maxAttempts` (default 3), then
 * becomes FAILED with the error. Returns the resulting status.
 */
export async function failLiveLookup(
  q: Queryable,
  puuid: string,
  error: string,
  maxAttempts = 3,
  now: Date = new Date(),
): Promise<LiveLookupStatus> {
  const [row] = await q<{ status: LiveLookupStatus }[]>`
    UPDATE live_player_profiles SET
      attempts = LEAST(attempts + 1, 32767),
      last_error = ${error.slice(0, 500)},
      status = CASE WHEN attempts + 1 >= ${maxAttempts}
                    THEN 'FAILED'::live_lookup_status ELSE 'PENDING'::live_lookup_status END,
      updated_at = ${now}
    WHERE puuid = ${puuid} AND status = 'PENDING'
    RETURNING status`;
  return row?.status ?? 'FAILED';
}

/** Deletes lookups last requested before `before` (with their masteries). Returns how many. */
export async function purgeLiveLookups(q: Queryable, before: Date): Promise<number> {
  const res = await q`DELETE FROM live_player_profiles WHERE requested_at < ${before}`;
  return res.count;
}

/**
 * Recent matches of a player already stored in `matches` / `participants` (high-elo ladder
 * data), among `matchIds`: the worker reuses them instead of asking Riot.
 */
export async function storedRecentMatches(
  q: Queryable,
  puuid: string,
  matchIds: readonly string[],
): Promise<LiveRecentMatch[]> {
  if (matchIds.length === 0) return [];
  const rows = await q<
    {
      match_id: string;
      champion_id: number;
      position: Position | null;
      win: boolean;
      is_remake: boolean;
      ended_at: Date;
    }[]
  >`
    SELECT pa.match_id, pa.champion_id, pa.position, pa.win, m.is_remake,
           m.started_at + make_interval(secs => m.duration_s) AS ended_at
    FROM participants pa
    JOIN matches m ON m.id = pa.match_id
    WHERE pa.puuid = ${puuid} AND pa.match_id = ANY(${[...matchIds]}::text[])`;
  return rows.map((r) => ({
    matchId: r.match_id,
    championId: r.champion_id,
    position: r.position,
    win: r.win,
    remake: r.is_remake,
    endedAt: r.ended_at.toISOString(),
  }));
}
