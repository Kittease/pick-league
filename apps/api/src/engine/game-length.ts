/**
 * Early / late game profile: how a champion+role does in games under 25 min and of 32 min or more
 * compared with its other games, net of what the whole role does in those games
 * (stats_champion_game_length). The rows of every patch given are summed. It explains a champion
 * or a draft and never changes a score.
 */
import type { GameLengthProfile, Position, TeamGameLength } from '@pick-league/shared';
import { ENGINE_CONFIG } from './config.ts';
import { round, shrink } from './math.ts';
import type { GameLengthRow, GamesWins } from './types.ts';

const GL = ENGINE_CONFIG.gameLength;

/** Games / wins per bucket (0 = under 25 min, 1 = 25 to under 32 min, 2 = 32 min or more). */
type Buckets = [GamesWins, GamesWins, GamesWins];

export interface GameLengthIndex {
  /** Per `position|championId`. */
  champions: Map<string, Buckets>;
  /** Per position: every champion of the role. */
  roles: Map<Position, Buckets>;
}

/** No "-0" in responses. */
const noNegativeZero = (x: number) => (x === 0 ? 0 : x);

const emptyBuckets = (): Buckets => [
  { games: 0, wins: 0 },
  { games: 0, wins: 0 },
  { games: 0, wins: 0 },
];

const championKey = (role: Position, championId: number) => `${role}|${championId}`;

/** Sums `rows` (every patch given) per champion+role and per role. */
export function indexGameLength(rows: readonly GameLengthRow[]): GameLengthIndex {
  const champions = new Map<string, Buckets>();
  const roles = new Map<Position, Buckets>();
  for (const r of rows) {
    const key = championKey(r.position, r.championId);
    const own = champions.get(key) ?? emptyBuckets();
    champions.set(key, own);
    const role = roles.get(r.position) ?? emptyBuckets();
    roles.set(r.position, role);
    for (const b of [own[r.bucket], role[r.bucket]]) {
      b.games += r.games;
      b.wins += r.wins;
    }
  }
  return { champions, roles };
}

const total = (b: Buckets): GamesWins => ({
  games: b[0].games + b[1].games + b[2].games,
  wins: b[0].wins + b[1].wins + b[2].wins,
});

/**
 * Delta of `bucket`: (champion − role) win rate in the bucket minus (champion − role) overall,
 * shrunk on the effective sample of "the bucket vs the champion's other games". Null under
 * `gameLength.minGames` games in the bucket, or with no other games to compare with.
 */
function bucketDelta(own: Buckets, role: Buckets, bucket: 0 | 2): number | null {
  const n = own[bucket].games;
  const all = total(own);
  const roleAll = total(role);
  const rn = role[bucket].games;
  if (n < GL.minGames || all.games - n <= 0 || rn === 0) return null;
  const raw =
    own[bucket].wins / n -
    role[bucket].wins / rn -
    (all.wins / all.games - roleAll.wins / roleAll.games);
  const nEff = 1 / (1 / n + 1 / (all.games - n));
  return noNegativeZero(round(shrink(raw, nEff, GL.shrinkK), 4));
}

/** Early / late profile of `championId` in `role`; null without rows or when both deltas are null. */
export function championGameLength(
  index: GameLengthIndex,
  role: Position,
  championId: number,
): GameLengthProfile | null {
  const own = index.champions.get(championKey(role, championId));
  const roleBuckets = index.roles.get(role);
  if (!own || !roleBuckets) return null;
  const early = bucketDelta(own, roleBuckets, 0);
  const late = bucketDelta(own, roleBuckets, 2);
  if (early === null && late === null) return null;
  return { early, late, earlyGames: own[0].games, lateGames: own[2].games };
}

/** Sum of the team members' early / late deltas (a missing value counts 0). */
export function teamGameLength(
  index: GameLengthIndex,
  team: readonly { championId: number; role: Position }[],
): TeamGameLength {
  let early = 0;
  let late = 0;
  let champions = 0;
  for (const m of team) {
    const profile = championGameLength(index, m.role, m.championId);
    if (!profile) continue;
    champions += 1;
    early += profile.early ?? 0;
    late += profile.late ?? 0;
  }
  return {
    early: noNegativeZero(round(early, 4)),
    late: noNegativeZero(round(late, 4)),
    champions,
  };
}
