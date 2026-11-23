import type { LadderTier, Platform } from '@pick-league/shared';
import { byPuuid, chunks, inTransaction, type Queryable } from '../client.ts';
import type {
  DailyRefreshCandidate,
  LadderEntryInput,
  LadderOrderRow,
  LadderUpsertResult,
  ListingSkipMissInput,
  ListingSkipState,
  MasteryInput,
  SoloRankInput,
  SweptRankInput,
  TrackedDiamondEntry,
} from '../types.ts';

/**
 * Riot may list a player twice during tier transitions: keep the last occurrence. Sorted so that
 * concurrent upserts of the same players lock them in one order (no deadlock).
 */
function uniqueByPuuid(entries: readonly LadderEntryInput[]): LadderEntryInput[] {
  return [...new Map(entries.map((e) => [e.puuid, e])).values()].sort(byPuuid);
}

/**
 * Upserts the `players` rows (with the solo rank of the entry) and the `ladder_entries` rows of
 * `unique` (sorted by puuid). Who "played": not in `prevGames`, or wins+losses differ from it;
 * their `listing_requested_at` and the entry's `games_changed_at` are set to when the entry was
 * seen. The listing baseline (`listed_*`) of a player who stays tracked is left as it is.
 */
async function writeLadderEntries(
  tx: Queryable,
  platform: Platform,
  unique: readonly LadderEntryInput[],
  prevGames: ReadonlyMap<string, number>,
  now: Date,
): Promise<{ played: string[]; added: string[] }> {
  const played: string[] = [];
  const added: string[] = [];
  for (const e of unique) {
    const before = prevGames.get(e.puuid);
    if (before === undefined) {
      added.push(e.puuid);
      played.push(e.puuid);
    } else if (before !== e.wins + e.losses) {
      played.push(e.puuid);
    }
  }

  // In slices: a whole ladder (7000+ players) is over Postgres' bind-parameter limit at once.
  const playedSet = new Set(played);
  for (const chunk of chunks(unique)) {
    await tx`
      INSERT INTO players ${tx(
        chunk.map((e) => ({
          puuid: e.puuid,
          platform,
          solo_tier: e.tier,
          solo_division: e.division ?? null,
          solo_lp: e.leaguePoints,
          solo_wins: e.wins,
          solo_losses: e.losses,
          rank_refreshed_at: e.seenAt ?? now,
          listing_requested_at: playedSet.has(e.puuid) ? (e.seenAt ?? now) : null,
        })),
      )}
      ON CONFLICT (puuid) DO UPDATE SET
        solo_tier = EXCLUDED.solo_tier,
        solo_division = EXCLUDED.solo_division,
        solo_lp = EXCLUDED.solo_lp,
        solo_wins = EXCLUDED.solo_wins,
        solo_losses = EXCLUDED.solo_losses,
        rank_refreshed_at = EXCLUDED.rank_refreshed_at,
        listing_requested_at = COALESCE(EXCLUDED.listing_requested_at, players.listing_requested_at)`;

    await tx`
      INSERT INTO ladder_entries ${tx(
        chunk.map((e) => ({
          puuid: e.puuid,
          platform,
          tier: e.tier,
          division: e.division ?? null,
          league_points: e.leaguePoints,
          wins: e.wins,
          losses: e.losses,
          updated_at: e.seenAt ?? now,
          games_changed_at: e.seenAt ?? now,
        })),
      )}
      ON CONFLICT (puuid) DO UPDATE SET
        platform = EXCLUDED.platform,
        tier = EXCLUDED.tier,
        division = EXCLUDED.division,
        league_points = EXCLUDED.league_points,
        games_changed_at = CASE
          WHEN ladder_entries.wins + ladder_entries.losses = EXCLUDED.wins + EXCLUDED.losses
            THEN COALESCE(ladder_entries.games_changed_at, ladder_entries.updated_at)
          ELSE EXCLUDED.games_changed_at END,
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        updated_at = EXCLUDED.updated_at`;
  }
  return { played, added };
}

/**
 * Upserts the tracked apex ladder of one platform (Challenger, Grandmaster and the tracked Master
 * players, in a single call): `players` rows (with solo rank from the ladder) and `ladder_entries`.
 * Entries of this platform missing from `entries` are removed (players dropped off the ladder;
 * their `players` row is kept). Never call it with a partial ladder.
 *
 * With `keepDiamond` (Diamond tracking is on), the platform's DIAMOND rows missing from `entries`
 * are left alone: they belong to `upsertDiamondLadder`. A Diamond row whose player is in `entries`
 * becomes an apex row.
 *
 * Returns who "played": new on the ladder, or wins+losses changed since the previous call. Their
 * `listing_requested_at` is set to `now` (durable: survives a worker restart until
 * `finishListing` clears it).
 */
export async function upsertLadder(
  q: Queryable,
  platform: Platform,
  entries: readonly LadderEntryInput[],
  now: Date = new Date(),
  options: { keepDiamond?: boolean } = {},
): Promise<LadderUpsertResult> {
  const unique = uniqueByPuuid(entries);
  return inTransaction(q, async (tx) => {
    const previous = await tx<{ puuid: string; games: number }[]>`
      SELECT puuid, wins + losses AS games FROM ladder_entries WHERE platform = ${platform}`;
    const prevGames = new Map(previous.map((r) => [r.puuid, r.games]));
    const { played, added } = await writeLadderEntries(tx, platform, unique, prevGames, now);

    const keep = unique.map((e) => e.puuid);
    const removed = await tx`
      DELETE FROM ladder_entries
      WHERE platform = ${platform} AND NOT (puuid = ANY(${keep}::text[]))
        ${options.keepDiamond ? tx`AND tier <> 'DIAMOND'` : tx``}`;

    return { played, added, removed: removed.count };
  });
}

/**
 * Upserts the tracked Diamond players of one platform after a complete sweep (`entries`, all of
 * tier DIAMOND with a division). Entries whose player has an apex row are ignored (the apex ladder
 * owns them). The platform's other DIAMOND rows are removed, except those of `keep`, left exactly
 * as they are (tracked players the sweep did not see); `keep: 'all'` removes nothing (players
 * added between two sweeps). Apex rows are never touched.
 *
 * Returns who "played" like `upsertLadder`; their request carries the time of their own entry.
 */
export async function upsertDiamondLadder(
  q: Queryable,
  platform: Platform,
  entries: readonly LadderEntryInput[],
  options: { keep?: readonly string[] | 'all'; now?: Date } = {},
): Promise<LadderUpsertResult> {
  const now = options.now ?? new Date();
  return inTransaction(q, async (tx) => {
    const previous = await tx<{ puuid: string; diamond: boolean; games: number }[]>`
      SELECT puuid, tier = 'DIAMOND' AS diamond, wins + losses AS games
      FROM ladder_entries WHERE platform = ${platform}`;
    const apex = new Set(previous.filter((r) => !r.diamond).map((r) => r.puuid));
    const prevGames = new Map(previous.map((r) => [r.puuid, r.games]));
    const unique = uniqueByPuuid(entries).filter((e) => e.tier === 'DIAMOND' && !apex.has(e.puuid));
    const { played, added } = await writeLadderEntries(tx, platform, unique, prevGames, now);

    let removed = 0;
    if (options.keep !== 'all') {
      const keep = [...unique.map((e) => e.puuid), ...(options.keep ?? [])];
      const res = await tx`
        DELETE FROM ladder_entries
        WHERE platform = ${platform} AND tier = 'DIAMOND' AND NOT (puuid = ANY(${keep}::text[]))`;
      removed = res.count;
    }
    return { played, added, removed };
  });
}

/**
 * The tracked ladder of a platform from the top down: Challenger, Grandmaster, Master, each by LP
 * (most first), then the tracked Diamond players by division (I first) then LP. Each row with
 * when the player was last seen in a Master+ game.
 */
export async function ladderOrder(q: Queryable, platform: Platform): Promise<LadderOrderRow[]> {
  const rows = await q<
    {
      puuid: string;
      tier: LadderTier;
      division: number | null;
      league_points: number;
      last_seen_with_master_at: Date | null;
    }[]
  >`
    SELECT le.puuid, le.tier, le.division, le.league_points, p.last_seen_with_master_at
    FROM ladder_entries le JOIN players p USING (puuid)
    WHERE le.platform = ${platform}
    ORDER BY le.tier, le.division NULLS FIRST, le.league_points DESC, le.puuid`;
  return rows.map((r) => ({
    puuid: r.puuid,
    tier: r.tier,
    division: r.division,
    leaguePoints: r.league_points,
    lastSeenWithMasterAt: r.last_seen_with_master_at,
  }));
}

/** The tracked Diamond players of a platform (any order), with when a sweep last saw them. */
export async function trackedDiamondEntries(
  q: Queryable,
  platform: Platform,
): Promise<TrackedDiamondEntry[]> {
  const rows = await q<
    { puuid: string; division: number | null; league_points: number; updated_at: Date }[]
  >`
    SELECT puuid, division, league_points, updated_at FROM ladder_entries
    WHERE platform = ${platform} AND tier = 'DIAMOND'`;
  return rows.map((r) => ({
    puuid: r.puuid,
    division: r.division ?? 4,
    leaguePoints: r.league_points,
    seenAt: r.updated_at,
  }));
}

/**
 * Players of a platform seen in a stored match with a Master+ player since `since`
 * (`players.last_seen_with_master_at`).
 */
export async function playersSeenWithMasterSince(
  q: Queryable,
  platform: Platform,
  since: Date,
): Promise<string[]> {
  const rows = await q<{ puuid: string }[]>`
    SELECT puuid FROM players
    WHERE platform = ${platform} AND last_seen_with_master_at >= ${since}`;
  return rows.map((r) => r.puuid);
}

// ---------------------------------------------------------------------------
// Listing skip rule (LISTING_SKIP)
// ---------------------------------------------------------------------------

/** Ladder counters and listing baseline of a tracked player; null when not tracked. */
export async function getListingSkipState(
  q: Queryable,
  puuid: string,
): Promise<ListingSkipState | null> {
  const [row] = await q<
    {
      games_now: number;
      snapshot_at: Date;
      listed_games: number | null;
      listed_snapshot_at: Date | null;
      listed_at: Date | null;
    }[]
  >`
    SELECT wins + losses AS games_now, COALESCE(games_changed_at, updated_at) AS snapshot_at,
           listed_games, listed_snapshot_at, listed_at
    FROM ladder_entries WHERE puuid = ${puuid}`;
  if (!row) return null;
  return {
    gamesNow: row.games_now,
    snapshotAt: row.snapshot_at,
    listedGames: row.listed_games,
    listedSnapshotAt: row.listed_snapshot_at,
    listedAt: row.listed_at,
  };
}

/**
 * Stored non-remake matches the player took part in that ended (`started_at + duration_s`) after
 * `after` and at or before `until`.
 */
export async function countStoredGamesEndedBetween(
  q: Queryable,
  puuid: string,
  after: Date,
  until: Date,
): Promise<number> {
  const [row] = await q<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM participants pa
    JOIN matches m ON m.id = pa.match_id
    WHERE pa.puuid = ${puuid}
      AND NOT m.is_remake
      AND m.started_at + make_interval(secs => m.duration_s) > ${after}
      AND m.started_at + make_interval(secs => m.duration_s) <= ${until}`;
  return row?.n ?? 0;
}

/**
 * A real listing of a tracked player succeeded: the baseline of the skip rule becomes the ladder
 * counters the listing was decided on (`games` at `snapshotAt`) and when it ran. Nothing happens
 * when the player is no longer tracked.
 */
export async function setListingBaseline(
  q: Queryable,
  puuid: string,
  baseline: { games: number; snapshotAt: Date; listedAt: Date },
): Promise<void> {
  await q`
    UPDATE ladder_entries SET
      listed_games = ${baseline.games},
      listed_snapshot_at = ${baseline.snapshotAt},
      listed_at = ${baseline.listedAt}
    WHERE puuid = ${puuid}`;
}

/**
 * A listing was skipped (the player's new games are all stored already): clears the listing
 * request without touching `matches_synced_until`, unless the ladder asked again after
 * `snapshotAt`, the refresh the skip was decided on (the player played again meanwhile).
 */
export async function clearListingRequest(
  q: Queryable,
  puuid: string,
  snapshotAt: Date,
): Promise<void> {
  await q`
    UPDATE players SET listing_requested_at = NULL
    WHERE puuid = ${puuid} AND listing_requested_at <= ${snapshotAt}`;
}

/** LISTING_SKIP=shadow: a listing the rule would have skipped queued new match ids. */
export async function recordListingSkipMiss(
  q: Queryable,
  miss: ListingSkipMissInput,
): Promise<void> {
  await q`
    INSERT INTO listing_skip_misses
      (puuid, platform, checked_at, listed_snapshot_at, snapshot_at, expected, stored, new_match_ids)
    VALUES (${miss.puuid}, ${miss.platform}, ${miss.checkedAt}, ${miss.listedSnapshotAt},
            ${miss.snapshotAt}, ${miss.expected}, ${miss.stored}, ${[...miss.newMatchIds]}::text[])`;
}

/** `players.matches_synced_until` (null = never listed: start from the previous patch / 14 days ago). */
export async function getMatchesSyncedUntil(q: Queryable, puuid: string): Promise<Date | null> {
  const [row] = await q<{ matches_synced_until: Date | null }[]>`
    SELECT matches_synced_until FROM players WHERE puuid = ${puuid}`;
  return row?.matches_synced_until ?? null;
}

/** Sets the `startTime` of the next match-id listing for this player. */
export async function setMatchesSyncedUntil(
  q: Queryable,
  puuid: string,
  until: Date,
): Promise<void> {
  await q`UPDATE players SET matches_synced_until = ${until} WHERE puuid = ${puuid}`;
}

/**
 * A match-id listing that started at `startedAt` finished: sets `matches_synced_until` and clears
 * the listing request, unless a newer one arrived after the listing started (the player played
 * again meanwhile: listed again).
 */
export async function finishListing(
  q: Queryable,
  puuid: string,
  syncedUntil: Date,
  startedAt: Date,
): Promise<void> {
  await q`
    UPDATE players SET
      matches_synced_until = ${syncedUntil},
      listing_requested_at = CASE WHEN listing_requested_at <= ${startedAt}
        THEN NULL ELSE listing_requested_at END
    WHERE puuid = ${puuid}`;
}

/**
 * Tracked (ladder) players of a platform with a pending listing request, oldest request first
 * (requests survive restarts: see `upsertLadder`).
 */
export async function playersWithListingRequested(
  q: Queryable,
  platform: Platform,
  limit = 10_000,
): Promise<string[]> {
  const rows = await q<{ puuid: string }[]>`
    SELECT p.puuid FROM players p
    JOIN ladder_entries le USING (puuid)
    WHERE le.platform = ${platform} AND p.listing_requested_at IS NOT NULL
    ORDER BY p.listing_requested_at, p.puuid
    LIMIT ${limit}`;
  return rows.map((r) => r.puuid);
}

/** Stores the solo-queue rank from league-v4 entries/by-puuid (null = unranked in solo queue). */
export async function updatePlayerRank(
  q: Queryable,
  puuid: string,
  rank: SoloRankInput | null,
  now: Date = new Date(),
): Promise<void> {
  await q`
    UPDATE players SET
      solo_tier = ${rank?.tier ?? null},
      solo_division = ${rank?.division ?? null},
      solo_lp = ${rank?.lp ?? null},
      solo_wins = ${rank?.wins ?? null},
      solo_losses = ${rank?.losses ?? null},
      rank_refreshed_at = ${now}
    WHERE puuid = ${puuid}`;
}

/** When a player's stored solo rank was last refreshed; null when never (or no such player). */
export async function getRankRefreshedAt(q: Queryable, puuid: string): Promise<Date | null> {
  const [row] = await q<{ rank_refreshed_at: Date | null }[]>`
    SELECT rank_refreshed_at FROM players WHERE puuid = ${puuid}`;
  return row?.rank_refreshed_at ?? null;
}

/**
 * Stores the Diamond rank of the players of a sweep page who are already known (`players` rows of
 * the platform): division, LP, wins and losses as the page gave them at `seenAt`. Players the
 * page names that are not stored are ignored (nothing is created), and so are tracked apex
 * players (their ladder owns their rank) and players whose rank was refreshed after `seenAt`.
 * To keep the hourly write small, a player whose stored rank already says the same is only
 * touched when it was last refreshed before `touchBefore`. Rows are locked in puuid order, like
 * every multi-player write. Returns how many were written.
 */
export async function updateKnownPlayerRanks(
  q: Queryable,
  platform: Platform,
  entries: readonly SweptRankInput[],
  seenAt: Date,
  touchBefore: Date,
): Promise<number> {
  const unique = [...new Map(entries.map((e) => [e.puuid, e])).values()];
  if (unique.length === 0) return 0;
  const res = await q`
    WITH e AS (
      SELECT * FROM unnest(
        ${unique.map((e) => e.puuid)}::text[],
        ${unique.map((e) => e.division)}::int[],
        ${unique.map((e) => e.leaguePoints)}::int[],
        ${unique.map((e) => e.wins)}::int[],
        ${unique.map((e) => e.losses)}::int[]
      ) AS t(puuid, division, lp, wins, losses)
    ), due AS (
      SELECT p.puuid FROM players p JOIN e USING (puuid)
      WHERE p.platform = ${platform}
        AND (p.rank_refreshed_at IS NULL OR p.rank_refreshed_at < ${seenAt})
        AND (p.rank_refreshed_at IS NULL OR p.rank_refreshed_at < ${touchBefore}
             OR p.solo_tier IS DISTINCT FROM 'DIAMOND'
             OR p.solo_division IS DISTINCT FROM e.division
             OR p.solo_lp IS DISTINCT FROM e.lp
             OR p.solo_wins IS DISTINCT FROM e.wins
             OR p.solo_losses IS DISTINCT FROM e.losses)
        AND NOT EXISTS (SELECT 1 FROM ladder_entries le
                        WHERE le.puuid = p.puuid AND le.tier <> 'DIAMOND')
      ORDER BY p.puuid
      FOR UPDATE OF p
    )
    UPDATE players p SET
      solo_tier = 'DIAMOND',
      solo_division = e.division,
      solo_lp = e.lp,
      solo_wins = e.wins,
      solo_losses = e.losses,
      rank_refreshed_at = ${seenAt}
    FROM e, due
    WHERE p.puuid = due.puuid AND e.puuid = p.puuid`;
  return res.count;
}

/**
 * Replaces the masteries of a player and sets `masteries_refreshed_at`. Of `masteries` (a whole
 * champion-mastery-v4 answer) only the rows for champions the player has a stored game on (a
 * `participants` row) are kept: the stats read nothing else. A first game on another champion,
 * stored later, asks for the masteries again (`insertParsedMatch`). The player row must exist.
 */
export async function replaceMasteries(
  q: Queryable,
  puuid: string,
  masteries: readonly MasteryInput[],
  now: Date = new Date(),
): Promise<void> {
  await inTransaction(q, async (tx) => {
    // First, so that this waits for a match insert of this player in flight (it holds the player's
    // row until it commits) and the statements below see its participant rows.
    await tx`UPDATE players SET masteries_refreshed_at = ${now} WHERE puuid = ${puuid}`;
    await tx`DELETE FROM champion_masteries WHERE puuid = ${puuid}`;
    const played = new Set(
      (
        await tx<{ champion_id: number }[]>`
          SELECT DISTINCT champion_id FROM participants WHERE puuid = ${puuid}`
      ).map((r) => r.champion_id),
    );
    const kept = [...new Map(masteries.map((m) => [m.championId, m])).values()].filter((m) =>
      played.has(m.championId),
    );
    if (kept.length > 0) {
      await tx`INSERT INTO champion_masteries ${tx(
        kept.map((m) => ({
          puuid,
          champion_id: m.championId,
          level: m.level,
          points: m.points,
          last_played_at: m.lastPlayedAt,
        })),
      )}`;
    }
  });
}

/**
 * Tracked (ladder) players of a platform whose masteries are older than `olderThanHours`
 * (default 24; the worker passes its mastery refresh interval) or were never fetched. Oldest
 * first.
 */
export async function playersNeedingDailyRefresh(
  q: Queryable,
  platform: Platform,
  limit: number,
  olderThanHours = 24,
  now: Date = new Date(),
): Promise<DailyRefreshCandidate[]> {
  const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000);
  return await q<DailyRefreshCandidate[]>`
    SELECT p.puuid
    FROM ladder_entries le
    JOIN players p USING (puuid)
    WHERE le.platform = ${platform}
      AND (p.masteries_refreshed_at IS NULL OR p.masteries_refreshed_at < ${cutoff})
    ORDER BY COALESCE(p.masteries_refreshed_at, '-infinity'), p.puuid
    LIMIT ${limit}`;
}

/**
 * Tracked (ladder) players of a platform whose match ids were never listed
 * (`matches_synced_until` IS NULL), e.g. after a restart interrupted the first listing. In no
 * useful order: the worker lists them by ladder position.
 */
export async function trackedPlayersNeverListed(
  q: Queryable,
  platform: Platform,
  limit = 10_000,
): Promise<string[]> {
  const rows = await q<{ puuid: string }[]>`
    SELECT le.puuid FROM ladder_entries le
    JOIN players p USING (puuid)
    WHERE le.platform = ${platform} AND p.matches_synced_until IS NULL
    ORDER BY le.league_points DESC, le.puuid
    LIMIT ${limit}`;
  return rows.map((r) => r.puuid);
}
