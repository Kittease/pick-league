/**
 * POST /live/players: asks the worker to find the user's game, then to look its players up (the
 * only things the API writes besides its stats views and the client activity), and answers with
 * what is already in. The worker holds the Riot key; the desktop repeats the request until
 * `done`. Players are matched to the game's participants (Riot API puuids, from spectator-v5)
 * by team and champion: the League client's player ids are not the API's.
 */
import {
  getLiveProfiles,
  type LiveGame,
  type LiveGameParticipant,
  type LiveLookupRequest,
  type LiveProfile,
  type LiveRecentMatch,
  listWorkerStatus,
  type Queryable,
  requestLiveGame,
  requestLiveLookups,
  type WorkerStatus,
} from '@pick-league/db';
import {
  COLLECTION_STALL_MS,
  LIVE_OFF_ROLE_MAX_SHARE,
  LIVE_OFF_ROLE_MIN_MATCHES,
  type LiveGameState,
  type LiveLookupStatus,
  type LivePlayerRequest,
  type LivePlayerResult,
  type LivePlayersRequest,
  type LivePlayersResponse,
  type LiveRank,
  type LiveRecentStats,
  type LiveWorkerState,
  type Platform,
  POSITIONS,
  type Position,
} from '@pick-league/shared';

/** Whether the worker can serve this platform's lookups (from its `worker_status` row). */
export function liveWorkerState(
  rows: readonly WorkerStatus[],
  platform: Platform,
  now: Date,
): LiveWorkerState {
  const row = rows.find((r) => r.platform === platform);
  if (!row) return 'unsupported';
  if (row.authRejectedSince) return 'key_rejected';
  if (now.getTime() - row.heartbeatAt.getTime() > COLLECTION_STALL_MS) return 'stalled';
  return 'ok';
}

/** Recent form of a player playing `championId` at `position` now (remakes left out). */
export function summarizeRecent(
  recent: readonly LiveRecentMatch[],
  championId: number,
  position: Position | null,
): LiveRecentStats {
  const counted = recent.filter((m) => !m.remake);
  const onChampion = counted.filter((m) => m.championId === championId);
  const byRole = new Map<Position, number>();
  for (const m of counted)
    if (m.position) byRole.set(m.position, (byRole.get(m.position) ?? 0) + 1);
  const roles = [...byRole]
    .map(([p, matches]) => ({ position: p, matches }))
    .sort(
      (a, b) =>
        b.matches - a.matches || POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position),
    );
  const known = roles.reduce((s, r) => s + r.matches, 0);
  return {
    matches: counted.length,
    wins: counted.filter((m) => m.win).length,
    championMatches: onChampion.length,
    championWins: onChampion.filter((m) => m.win).length,
    roles,
    mainRole: roles[0]?.position ?? null,
    offRole:
      position === null || known < LIVE_OFF_ROLE_MIN_MATCHES
        ? null
        : (byRole.get(position) ?? 0) / known < LIVE_OFF_ROLE_MAX_SHARE,
  };
}

function toRank(rank: LiveProfile['rank']): LiveRank | null {
  if (!rank) return null;
  const games = rank.wins + rank.losses;
  return { ...rank, winRate: games > 0 ? rank.wins / games : 0 };
}

/** What the game search says, for the answer. */
export function liveGameState(game: LiveGame): LiveGameState {
  if (game.status === 'READY') return 'found';
  if (game.status === 'PENDING') return 'finding';
  return game.lastError?.startsWith('not_found') ? 'not_found' : 'failed';
}

/**
 * The participant a requested player is: same champion, on the user's team for an ally and on
 * the other one for an enemy. Null when there is no such participant (or several).
 */
export function matchParticipant(
  req: Pick<LivePlayerRequest, 'team' | 'championId'>,
  participants: readonly LiveGameParticipant[],
  myTeamId: number | null,
): LiveGameParticipant | null {
  const found = participants.filter(
    (p) =>
      p.championId === req.championId &&
      (myTeamId === null || (req.team === 'ally') === (p.teamId === myTeamId)),
  );
  return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * One player of the answer (never with the puuid). Without a profile: `missing` says why
 * (the game is still being found, it was not found, the player is not in it).
 */
export function toLivePlayerResult(
  req: LivePlayerRequest,
  index: number,
  profile: LiveProfile | undefined,
  missing: 'pending' | 'failed' | 'unsupported' | 'hidden' = 'pending',
): LivePlayerResult {
  const base = {
    index,
    team: req.team,
    championId: req.championId,
    position: req.position,
  };
  if (!profile) {
    return {
      ...base,
      status: missing,
      rankLoaded: false,
      rank: null,
      mastery: null,
      recent: null,
    };
  }
  const status: LiveLookupStatus =
    profile.status === 'FAILED'
      ? 'failed'
      : profile.status === 'READY' && profile.mastery !== null && profile.recent !== null
        ? 'ready'
        : 'pending';
  return {
    ...base,
    status,
    rankLoaded: profile.rankLoaded,
    rank: toRank(profile.rank),
    mastery: profile.mastery,
    recent: profile.recent ? summarizeRecent(profile.recent, req.championId, req.position) : null,
  };
}

export async function livePlayers(
  db: Queryable,
  req: LivePlayersRequest,
  now: Date = new Date(),
): Promise<LivePlayersResponse> {
  const worker = liveWorkerState(await listWorkerStatus(db), req.platform, now);
  if (worker === 'unsupported') {
    // No worker runs this platform: nothing is queued (it would never be fetched).
    return {
      platform: req.platform,
      worker,
      game: 'unsupported',
      done: true,
      players: req.players.map((p, i) => toLivePlayerResult(p, i, undefined, 'unsupported')),
    };
  }
  const game = await requestLiveGame(
    db,
    {
      platform: req.platform,
      gameId: req.gameId,
      gameName: req.me.gameName,
      tagLine: req.me.tagLine,
    },
    { now },
  );
  const gameState = liveGameState(game);
  if (gameState !== 'found') {
    const missing = gameState === 'finding' ? 'pending' : 'failed';
    return {
      platform: req.platform,
      worker,
      game: gameState,
      done: missing === 'failed',
      players: req.players.map((p, i) => toLivePlayerResult(p, i, undefined, missing)),
    };
  }
  const participants = req.players.map((p) =>
    matchParticipant(p, game.participants ?? [], game.myTeamId),
  );
  const asks: LiveLookupRequest[] = participants.flatMap((p) =>
    p?.puuid ? [{ puuid: p.puuid, championId: p.championId }] : [],
  );
  await requestLiveLookups(db, req.platform, asks, { now });
  const profiles = new Map((await getLiveProfiles(db, asks)).map((p) => [p.puuid, p]));
  const players = req.players.map((p, i) => {
    const participant = participants[i];
    // Not in the game Riot shows (champion changed, wrong team): nothing to look up.
    if (!participant) return toLivePlayerResult(p, i, undefined, 'failed');
    // Riot hides who they are: never looked up.
    if (!participant.puuid) return toLivePlayerResult(p, i, undefined, 'hidden');
    return toLivePlayerResult(p, i, profiles.get(participant.puuid));
  });
  return {
    platform: req.platform,
    worker,
    game: gameState,
    done: players.every((p) => p.status !== 'pending'),
    players,
  };
}
