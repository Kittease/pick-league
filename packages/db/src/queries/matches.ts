import type { PatchId, Platform } from '@pick-league/shared';
import { byPuuid, chunks, inTransaction, type Queryable } from '../client.ts';
import type { ParsedMatch } from '../types.ts';
import { enqueueEnrichment } from './queues.ts';

export interface InsertMatchOptions {
  /** Enqueue non-ladder participants for mastery/rank enrichment (default true). */
  enqueueEnrichment?: boolean;
  /** Freshness window of the enrichment rule (default 7 days). */
  enrichmentStaleAfterDays?: number;
  /** Also mark the match DONE in `match_fetch_queue` (default true). */
  markQueueDone?: boolean;
}

export interface InsertMatchResult {
  /** false when the match was already stored (nothing written). */
  inserted: boolean;
  /** Players enqueued for enrichment. */
  enrichmentEnqueued: number;
}

const emptyToNull = (s: string | null | undefined): string | null =>
  s === undefined || s === null || s.trim() === '' ? null : s;

/**
 * Stores a parsed match in one transaction:
 * 1. `players` rows for all 10 participants (Riot ID from the payload; the name is only
 *    overwritten by a payload at least as recent as the stored one; `last_seen_in_match_at` bumped),
 * 2. `matches`, `match_teams`, `match_bans`, `participants`, `item_events`, `skill_events`,
 * 3. optionally: enrichment enqueue + queue row marked DONE.
 *
 * Idempotent: if the match id already exists, nothing is written and `inserted` is false.
 * The match's patch must exist in `patches`.
 */
export async function insertParsedMatch(
  q: Queryable,
  parsed: ParsedMatch,
  options: InsertMatchOptions = {},
): Promise<InsertMatchResult> {
  const m = parsed.match;
  return inTransaction(q, async (tx) => {
    const created = await tx`
      INSERT INTO matches ${tx({
        id: m.id,
        platform: m.platform,
        patch: m.patch,
        game_version: m.gameVersion,
        queue_id: m.queueId,
        started_at: m.startedAt,
        duration_s: m.durationS,
        is_remake: m.isRemake,
        is_early_surrender: m.isEarlySurrender,
        winning_team: m.winningTeam,
      })}
      ON CONFLICT (id) DO NOTHING`;
    if (created.count === 0) {
      if (options.markQueueDone !== false) {
        await tx`UPDATE match_fetch_queue SET status = 'DONE', updated_at = now() WHERE match_id = ${m.id}`;
      }
      return { inserted: false, enrichmentEnqueued: 0 };
    }

    // Sorted: concurrent upserts of the same players must lock them in one order (no deadlock).
    const players = [...new Map(parsed.participants.map((p) => [p.puuid, p])).values()].sort(
      byPuuid,
    );
    if (players.length > 0) {
      await tx`
        INSERT INTO players ${tx(
          players.map((p) => {
            const gameName = emptyToNull(p.riotIdGameName);
            return {
              puuid: p.puuid,
              platform: m.platform,
              game_name: gameName,
              tag_line: gameName === null ? null : emptyToNull(p.riotIdTagLine),
              name_updated_at: gameName === null ? null : m.startedAt,
              last_seen_in_match_at: m.startedAt,
            };
          }),
        )}
        ON CONFLICT (puuid) DO UPDATE SET
          game_name = CASE WHEN EXCLUDED.game_name IS NOT NULL
              AND EXCLUDED.name_updated_at >= COALESCE(players.name_updated_at, '-infinity')
            THEN EXCLUDED.game_name ELSE players.game_name END,
          tag_line = CASE WHEN EXCLUDED.game_name IS NOT NULL
              AND EXCLUDED.name_updated_at >= COALESCE(players.name_updated_at, '-infinity')
            THEN EXCLUDED.tag_line ELSE players.tag_line END,
          name_updated_at = CASE WHEN EXCLUDED.game_name IS NOT NULL
              AND EXCLUDED.name_updated_at >= COALESCE(players.name_updated_at, '-infinity')
            THEN EXCLUDED.name_updated_at ELSE players.name_updated_at END,
          last_seen_in_match_at = GREATEST(players.last_seen_in_match_at, EXCLUDED.last_seen_in_match_at)`;
    }

    if (parsed.teams.length > 0) {
      await tx`INSERT INTO match_teams ${tx(
        parsed.teams.map((t) => ({
          match_id: m.id,
          team_id: t.teamId,
          win: t.win,
          first_blood: t.firstBlood,
          first_tower: t.firstTower,
          first_dragon: t.firstDragon,
          first_baron: t.firstBaron,
          champion_kills: t.championKills,
          tower_kills: t.towerKills,
          inhibitor_kills: t.inhibitorKills,
          dragon_kills: t.dragonKills,
          baron_kills: t.baronKills,
          herald_kills: t.heraldKills,
          voidgrub_kills: t.voidgrubKills,
          atakhan_kills: t.atakhanKills,
        })),
      )}`;
    }

    if (parsed.bans.length > 0) {
      await tx`INSERT INTO match_bans ${tx(
        parsed.bans.map((b) => ({
          match_id: m.id,
          team_id: b.teamId,
          pick_turn: b.pickTurn,
          champion_id: b.championId,
        })),
      )}`;
    }

    if (parsed.participants.length > 0) {
      await tx`INSERT INTO participants ${tx(
        parsed.participants.map((p) => ({
          match_id: m.id,
          participant_id: p.participantId,
          puuid: p.puuid,
          team_id: p.teamId,
          champion_id: p.championId,
          position: p.position,
          win: p.win,
          summoner_spell_1: p.summonerSpell1,
          summoner_spell_2: p.summonerSpell2,
          rune_primary_tree: p.runePrimaryTree,
          rune_secondary_tree: p.runeSecondaryTree,
          runes: tx.array(p.runes, 21),
          stat_shards: tx.array(p.statShards, 21),
          final_items: tx.array(p.finalItems, 23),
          champ_level: p.champLevel,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          lane_minions: p.laneMinions,
          jungle_minions: p.jungleMinions,
          gold_earned: p.goldEarned,
          gold_spent: p.goldSpent,
          damage_to_champions: p.damageToChampions,
          physical_damage_to_champions: p.physicalDamageToChampions,
          magic_damage_to_champions: p.magicDamageToChampions,
          true_damage_to_champions: p.trueDamageToChampions,
          damage_taken: p.damageTaken,
          damage_self_mitigated: p.damageSelfMitigated,
          damage_to_buildings: p.damageToBuildings,
          damage_to_objectives: p.damageToObjectives,
          healing_done: p.healingDone,
          heals_on_teammates: p.healsOnTeammates,
          shields_on_teammates: p.shieldsOnTeammates,
          cc_time_on_others_s: p.ccTimeOnOthersS,
          vision_score: p.visionScore,
          wards_placed: p.wardsPlaced,
          wards_killed: p.wardsKilled,
          control_wards_bought: p.controlWardsBought,
          gold_by_minute: tx.array(p.goldByMinute, 23),
          xp_by_minute: tx.array(p.xpByMinute, 23),
          cs_by_minute: tx.array(p.csByMinute, 21),
          level_by_minute: tx.array(p.levelByMinute, 21),
          damage_to_champions_by_minute: tx.array(p.damageToChampionsByMinute, 23),
          position_x_by_minute: tx.array(p.positionXByMinute, 21),
          position_y_by_minute: tx.array(p.positionYByMinute, 21),
        })),
      )}`;
    }

    // Large child tables: chunk to stay far below the 65535 bind-parameter limit.
    for (const chunk of chunks(parsed.itemEvents, 2000)) {
      await tx`INSERT INTO item_events ${tx(
        chunk.map((e) => ({
          match_id: m.id,
          participant_id: e.participantId,
          seq: e.seq,
          at_ms: e.atMs,
          type: e.type,
          item_id: e.itemId,
          undo_after_item_id: e.undoAfterItemId,
          undo_gold_gain: e.undoGoldGain,
        })),
      )}`;
    }
    for (const chunk of chunks(parsed.skillEvents, 2000)) {
      await tx`INSERT INTO skill_events ${tx(
        chunk.map((e) => ({
          match_id: m.id,
          participant_id: e.participantId,
          seq: e.seq,
          at_ms: e.atMs,
          skill_slot: e.skillSlot,
          is_evolve: e.isEvolve,
        })),
      )}`;
    }

    let enrichmentEnqueued = 0;
    if (options.enqueueEnrichment !== false) {
      enrichmentEnqueued = await enqueueEnrichment(
        tx,
        m.platform,
        players.map((p) => p.puuid),
        options.enrichmentStaleAfterDays,
      );
    }
    if (options.markQueueDone !== false) {
      await tx`
        UPDATE match_fetch_queue SET status = 'DONE', last_error = NULL, updated_at = now()
        WHERE match_id = ${m.id}`;
    }
    return { inserted: true, enrichmentEnqueued };
  });
}

/** Whether a match is already stored. */
export async function matchExists(q: Queryable, matchId: string): Promise<boolean> {
  const [row] = await q`SELECT 1 FROM matches WHERE id = ${matchId}`;
  return row !== undefined;
}

/** Whether a match of `patch` is stored for `platform`: the patch is live there. */
export async function platformHasMatchOnPatch(
  q: Queryable,
  platform: Platform,
  patch: PatchId,
): Promise<boolean> {
  const [row] = await q`
    SELECT 1 FROM matches WHERE patch = ${patch} AND platform = ${platform} LIMIT 1`;
  return row !== undefined;
}
