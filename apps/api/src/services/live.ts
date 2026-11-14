/**
 * POST /live/players: queues live game lookups for the worker (the only thing the API writes
 * besides its stats views) and answers with what is already in. The worker holds the Riot key;
 * the desktop repeats the request until `done`.
 */
import {
  getLiveProfiles,
  type LiveProfile,
  type LiveRecentMatch,
  listWorkerStatus,
  type Queryable,
  requestLiveLookups,
  type WorkerStatus,
} from '@pick-league/db';
import {
  COLLECTION_STALL_MS,
  LIVE_OFF_ROLE_MAX_SHARE,
  LIVE_OFF_ROLE_MIN_MATCHES,
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

/** One player of the answer (never with the puuid). */
export function toLivePlayerResult(
  req: LivePlayerRequest,
  index: number,
  profile: LiveProfile | undefined,
  unsupported = false,
): LivePlayerResult {
  const base = {
    index,
    team: req.team,
    championId: req.championId,
    position: req.position,
  };
  if (unsupported || !profile) {
    return {
      ...base,
      status: unsupported ? 'unsupported' : 'pending',
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
      done: true,
      players: req.players.map((p, i) => toLivePlayerResult(p, i, undefined, true)),
    };
  }
  const asks = req.players.map((p) => ({ puuid: p.puuid, championId: p.championId }));
  await requestLiveLookups(db, req.platform, asks, { now });
  const profiles = new Map((await getLiveProfiles(db, asks)).map((p) => [p.puuid, p]));
  const players = req.players.map((p, i) => toLivePlayerResult(p, i, profiles.get(p.puuid)));
  return {
    platform: req.platform,
    worker,
    done: players.every((p) => p.status !== 'pending'),
    players,
  };
}
