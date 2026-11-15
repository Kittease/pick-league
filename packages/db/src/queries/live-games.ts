/**
 * Live games (0014): the user's game in progress, found by the worker through the user's Riot ID
 * (account-v1) and spectator-v5, whose participants carry the Riot API puuids the player lookups
 * (live.ts) need. The League client's own player ids are not the API's.
 */
import type { Platform } from '@pick-league/shared';
import type { Queryable } from '../client.ts';
import type { LiveGame, LiveGameJob, LiveGameParticipant, LiveLookupStatus } from '../types.ts';

/** A FAILED game is tried again when asked about after this (1 min). */
export const LIVE_GAME_FAILED_RETRY_MS = 60_000;

export interface LiveGameRequest {
  platform: Platform;
  gameId: number;
  /** The user's own Riot ID. */
  gameName: string;
  tagLine: string;
}

/**
 * Asks the worker to find a game (idempotent: the desktop asks on every poll). A game never
 * asked about becomes PENDING; a FAILED one last updated before `failedRetryMs` (default 1 min)
 * becomes PENDING again with its attempts reset; a PENDING or READY one is left alone. Returns
 * the game as it is now.
 */
export async function requestLiveGame(
  q: Queryable,
  game: LiveGameRequest,
  options: { now?: Date; failedRetryMs?: number } = {},
): Promise<LiveGame> {
  const now = options.now ?? new Date();
  const failedCutoff = new Date(
    now.getTime() - (options.failedRetryMs ?? LIVE_GAME_FAILED_RETRY_MS),
  );
  const [row] = await q<GameRow[]>`
    INSERT INTO live_games (platform, game_id, game_name, tag_line, requested_at, updated_at)
    VALUES (${game.platform}, ${game.gameId}, ${game.gameName}, ${game.tagLine}, ${now}, ${now})
    ON CONFLICT (platform, game_id) DO UPDATE SET
      game_name = EXCLUDED.game_name,
      tag_line = EXCLUDED.tag_line,
      requested_at = GREATEST(live_games.requested_at, EXCLUDED.requested_at),
      status = CASE WHEN live_games.status = 'FAILED' AND live_games.updated_at < ${failedCutoff}
                    THEN 'PENDING'::live_lookup_status ELSE live_games.status END,
      attempts = CASE WHEN live_games.status = 'FAILED' AND live_games.updated_at < ${failedCutoff}
                      THEN 0 ELSE live_games.attempts END,
      updated_at = CASE WHEN live_games.status = 'FAILED' AND live_games.updated_at < ${failedCutoff}
                        THEN EXCLUDED.updated_at ELSE live_games.updated_at END
    RETURNING platform, game_id, status, participants, my_team_id, last_error`;
  if (!row) throw new Error('live game request returned no row');
  return toLiveGame(row);
}

interface GameRow {
  platform: Platform;
  game_id: string | number;
  status: LiveLookupStatus;
  participants: LiveGameParticipant[] | null;
  my_team_id: number | null;
  last_error: string | null;
}

function toLiveGame(r: GameRow): LiveGame {
  return {
    platform: r.platform,
    gameId: Number(r.game_id),
    status: r.status,
    participants: r.participants,
    myTeamId: r.my_team_id,
    lastError: r.last_error,
  };
}

export async function getLiveGame(
  q: Queryable,
  platform: Platform,
  gameId: number,
): Promise<LiveGame | null> {
  const [r] = await q<GameRow[]>`
    SELECT platform, game_id, status, participants, my_team_id, last_error
    FROM live_games WHERE platform = ${platform} AND game_id = ${gameId}`;
  return r ? toLiveGame(r) : null;
}

/** PENDING games of a platform, oldest request first (not locked: see `claimLiveLookups`). */
export async function claimLiveGames(
  q: Queryable,
  platform: Platform,
  limit: number,
): Promise<LiveGameJob[]> {
  const rows = await q<
    { game_id: string | number; game_name: string; tag_line: string; attempts: number }[]
  >`
    SELECT game_id, game_name, tag_line, attempts FROM live_games
    WHERE platform = ${platform} AND status = 'PENDING'
    ORDER BY requested_at, game_id
    LIMIT ${limit}`;
  return rows.map((r) => ({
    platform,
    gameId: Number(r.game_id),
    gameName: r.game_name,
    tagLine: r.tag_line,
    attempts: r.attempts,
  }));
}

/** The game was found: its participants and the user's team (null when not among them). */
export async function storeLiveGame(
  q: Queryable,
  platform: Platform,
  gameId: number,
  participants: readonly LiveGameParticipant[],
  myTeamId: number | null,
  now: Date = new Date(),
): Promise<void> {
  const json = participants.map((p) => ({
    teamId: p.teamId,
    championId: p.championId,
    puuid: p.puuid,
  }));
  await q`
    UPDATE live_games SET
      status = 'READY', participants = ${q.json(json)}, my_team_id = ${myTeamId},
      attempts = 0, last_error = NULL, updated_at = ${now}
    WHERE platform = ${platform} AND game_id = ${gameId} AND status = 'PENDING'`;
}

/**
 * Records a failed attempt: PENDING until `maxAttempts`, then FAILED with the error ('not_found:
 * …' when Riot has no such game). Returns the resulting status.
 */
export async function failLiveGame(
  q: Queryable,
  platform: Platform,
  gameId: number,
  error: string,
  maxAttempts: number,
  now: Date = new Date(),
): Promise<LiveLookupStatus> {
  const [row] = await q<{ status: LiveLookupStatus }[]>`
    UPDATE live_games SET
      attempts = LEAST(attempts + 1, 32767),
      last_error = ${error.slice(0, 500)},
      status = CASE WHEN attempts + 1 >= ${maxAttempts}
                    THEN 'FAILED'::live_lookup_status ELSE 'PENDING'::live_lookup_status END,
      updated_at = ${now}
    WHERE platform = ${platform} AND game_id = ${gameId} AND status = 'PENDING'
    RETURNING status`;
  return row?.status ?? 'FAILED';
}

/** Deletes games last asked about before `before`. Returns how many. */
export async function purgeLiveGames(q: Queryable, before: Date): Promise<number> {
  const res = await q`DELETE FROM live_games WHERE requested_at < ${before}`;
  return res.count;
}
