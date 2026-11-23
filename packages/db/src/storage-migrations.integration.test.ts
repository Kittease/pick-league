/**
 * The storage migrations (0025 and later) applied to a database that already holds matches in the
 * layout of 0024: events as rows in item_events / skill_events. Needs DATABASE_URL_TEST.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from './client.ts';
import { listMigrationFiles, migrate } from './index.ts';
import { fakePuuid, TEST_DATABASE_URL, testDb } from './test-helpers.ts';

const PATCH = '15.22';
const MATCH = 'KR_7000000001';
const REMAKE = 'KR_7000000002';

// Items of the patch: [id, completed, boots, consumable, tags, builds_from].
const ITEMS: [number, boolean, boolean, boolean, string[], number[]][] = [
  [1001, false, true, false, ['Boots'], []],
  [1036, false, false, false, ['Damage'], []],
  [1055, false, false, false, ['Lane'], []],
  [2003, false, false, true, ['Consumable'], []],
  [3340, false, false, false, ['Trinket'], []],
  [3006, true, true, false, ['Boots'], [1001]],
  [3047, true, true, false, ['Boots'], [1001]],
  [3031, true, false, false, ['Damage'], [1036]],
  [3036, true, false, false, ['Damage'], [1036]],
  [3071, true, false, false, ['Damage'], [1036]],
  [3072, true, false, false, ['Damage'], [1036]],
  [3078, true, false, false, ['Damage'], [1036]],
  [3867, false, false, false, ['GoldPer'], []],
  [3869, false, false, false, ['GoldPer'], [3867]], // a support quest upgrade
];

type OldItemEvent = [seq: number, atMs: number, type: string, itemId: number, after?: number];

/** Item events of the first match, per participant id, as rows of the old item_events. */
const ITEM_EVENTS: Record<number, OldItemEvent[]> = {
  // Starter with a potion taken back, early items, five completed items, boots after the first
  // one, then a boots swap at full build and a sale taken back. seq has gaps (rows deleted by
  // 0021) and one DESTROYED row was left behind.
  1: [
    [1, 2_000, 'PURCHASED', 3340],
    [2, 5_000, 'PURCHASED', 1055],
    [3, 6_000, 'PURCHASED', 2003],
    [4, 7_000, 'PURCHASED', 2003],
    [5, 8_000, 'UNDO', 2003, 0],
    [7, 240_000, 'PURCHASED', 1001],
    [8, 250_000, 'DESTROYED', 2003],
    [9, 300_000, 'PURCHASED', 1036],
    [10, 600_000, 'PURCHASED', 3031],
    [11, 700_000, 'PURCHASED', 3006],
    [14, 900_000, 'PURCHASED', 3036],
    [15, 1_100_000, 'PURCHASED', 3071],
    [16, 1_300_000, 'PURCHASED', 3072],
    [17, 1_500_000, 'PURCHASED', 3078],
    [20, 1_800_000, 'SOLD', 3006],
    [21, 1_801_200, 'PURCHASED', 3047],
    [22, 1_900_000, 'SOLD', 3031],
    [23, 1_900_800, 'UNDO', 0, 3031],
  ],
  // Only a leftover DESTROYED row (and an evolution below): no event to keep.
  4: [[1, 400_000, 'DESTROYED', 1036]],
  // A support who bought a quest upgrade and sold it before the end.
  5: [[1, 900_000, 'PURCHASED', 3869]],
};

type OldSkillEvent = [seq: number, slot: number, isEvolve?: boolean];

const SKILL_EVENTS: Record<number, OldSkillEvent[]> = {
  1: [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 1],
    [5, 1],
    [6, 4],
    [7, 4, true],
    [8, 1],
    [9, 3],
    [10, 1],
    [11, 3],
  ],
  2: [
    [1, 2],
    [2, 1],
    [3, 3],
  ],
  4: [[1, 4, true]],
};

/** One match of ten participants and a remake, written as the worker did until 0024. */
async function populateOldLayout(db: Db): Promise<void> {
  await db`INSERT INTO patches (id, ddragon_version) VALUES (${PATCH}, ${`${PATCH}.1`})`;
  await db`INSERT INTO champions (patch, id, slug, name, tags, attack_range, info)
           SELECT ${PATCH}, n, 'Champ' || n, 'Champ ' || n, '{}', 550, '{}' FROM generate_series(1, 10) n`;
  for (const [id, completed, boots, consumable, tags, from] of ITEMS) {
    await db`
      INSERT INTO items (patch, id, name, gold_total, tags, builds_from, builds_into,
                         is_boots, is_completed, is_consumable, stats)
      VALUES (${PATCH}, ${id}, ${`Item ${id}`}, 1000, ${tags}, ${from}::int[],
              ${id === 3867 ? [3869] : []}::int[], ${boots}, ${completed}, ${consumable}, '{}')`;
  }
  await db`INSERT INTO players (puuid, platform)
           SELECT 'test-puuid-' || lpad(n::text, 4, '0'), 'KR' FROM generate_series(1, 10) n`;
  for (const [id, remake] of [
    [MATCH, false],
    [REMAKE, true],
  ] as const) {
    await db`
      INSERT INTO matches (id, platform, patch, game_version, queue_id, started_at, duration_s,
                           is_remake, is_early_surrender, winning_team)
      VALUES (${id}, 'KR', ${PATCH}, ${`${PATCH}.1.1`}, 420, '2026-11-01T12:00:00Z',
              ${remake ? 200 : 2000}, ${remake}, ${remake}, 100)`;
    // Participant n plays champion n; 5 and 10 are the supports, 10 ends with the quest upgrade.
    await db`
      INSERT INTO participants (
        match_id, participant_id, puuid, team_id, champion_id, position, win,
        summoner_spell_1, summoner_spell_2, rune_primary_tree, rune_secondary_tree,
        runes, stat_shards, final_items,
        champ_level, kills, deaths, assists, lane_minions, jungle_minions, gold_earned, gold_spent,
        damage_to_champions, physical_damage_to_champions, magic_damage_to_champions,
        true_damage_to_champions, damage_taken, damage_self_mitigated, damage_to_buildings,
        damage_to_objectives, healing_done, heals_on_teammates, shields_on_teammates,
        cc_time_on_others_s, vision_score, wards_placed, wards_killed, control_wards_bought,
        gold_by_minute, xp_by_minute, cs_by_minute, level_by_minute,
        damage_to_champions_by_minute, position_x_by_minute, position_y_by_minute)
      SELECT ${id}, n, 'test-puuid-' || lpad(n::text, 4, '0'), CASE WHEN n <= 5 THEN 100 ELSE 200 END,
        n, (ARRAY['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'])[1 + (n - 1) % 5]::"position", n <= 5,
        4, 14, 8000, 8400, '{8005,9111,9104,8014,8444,8451}', '{5008,5008,5011}',
        CASE WHEN n = 10 THEN '{3869,0,0,0,0,0,3340}'::int[] ELSE '{0,0,0,0,0,0,3340}'::int[] END,
        15, 3, 2, 7, 150, 10, 11000, 10500,
        15000, 9000, 5000, 1000, 18000, 9000, 2000, 4000, 1500, 0, 0, 20, 25, 10, 3, 2,
        (SELECT array_agg(500 * g + 10 * n ORDER BY g) FROM generate_series(1, 12) g),
        (SELECT array_agg(280 * (g - 1) ORDER BY g) FROM generate_series(1, 12) g),
        (SELECT array_agg((6 * (g - 1))::smallint ORDER BY g) FROM generate_series(1, 12) g),
        '{1,2}', '{0,120}', '{554,3000}', '{581,9000}'
      FROM generate_series(1, 10) n`;
  }
  for (const [participantId, events] of Object.entries(ITEM_EVENTS)) {
    for (const [seq, atMs, type, itemId, after] of events) {
      await db`
        INSERT INTO item_events (match_id, participant_id, seq, at_ms, type, item_id,
                                 undo_after_item_id, undo_gold_gain)
        VALUES (${MATCH}, ${Number(participantId)}, ${seq}, ${atMs}, ${type}::item_event_type,
                ${itemId}, ${after ?? null}, ${type === 'UNDO' ? 50 : null})`;
    }
  }
  for (const [participantId, events] of Object.entries(SKILL_EVENTS)) {
    for (const [seq, slot, isEvolve] of events) {
      await db`
        INSERT INTO skill_events (match_id, participant_id, seq, at_ms, skill_slot, is_evolve)
        VALUES (${MATCH}, ${Number(participantId)}, ${seq}, ${seq * 60_000}, ${slot},
                ${isEvolve === true})`;
    }
  }
  // The remake has events too: they are moved like the others (and read by no view).
  await db`INSERT INTO item_events (match_id, participant_id, seq, at_ms, type, item_id)
           VALUES (${REMAKE}, 1, 1, 2000, 'PURCHASED', 1055)`;
  // Masteries as the worker stored them: every champion of a mastery answer. Player n played
  // champion n; player 3 was never fetched, player 11 is in no stored match.
  await db`INSERT INTO players (puuid, platform) VALUES (${fakePuuid(11)}, 'KR')`;
  for (const [player, championId, points] of [
    [1, 1, 250_000],
    [1, 2, 9_000],
    [1, 60018, 1_429],
    [2, 2, 40_000],
    [2, 1, 100],
    [11, 5, 77_000],
  ] as const) {
    await db`
      INSERT INTO champion_masteries (puuid, champion_id, level, points, last_played_at)
      VALUES (${fakePuuid(player)}, ${championId}, 5, ${points}, '2026-11-01T00:00:00Z')`;
  }
}

/** Everything in the public schema, as text, to compare two databases. */
async function schemaOf(db: Db) {
  return {
    columns: [
      ...(await db`
        SELECT c.relname, c.relkind::text, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
               a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_value
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm')
          AND c.relname <> 'schema_migrations'
        ORDER BY c.relname, a.attnum`),
    ],
    indexes: [
      ...(await db`SELECT tablename, indexname, indexdef FROM pg_indexes
                   WHERE schemaname = 'public' ORDER BY indexname`),
    ],
    constraints: [
      ...(await db`
        SELECT conrelid::regclass::text AS on_table, conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    ],
    views: [
      ...(await db`
        SELECT c.relname, pg_get_viewdef(c.oid) AS def FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') ORDER BY 1`),
    ],
    functions: [
      ...(await db`SELECT proname, pg_get_functiondef(oid) AS def FROM pg_proc
                   WHERE pronamespace = 'public'::regnamespace ORDER BY 1`),
    ],
    enums: [
      ...(await db`
        SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typnamespace = 'public'::regnamespace GROUP BY 1 ORDER BY 1`),
    ],
  };
}

/**
 * The stats views the storage migrations rewrite or change the source of, read whole.
 * `participants`: the materialized view stats_participants until 0029, since 0030 the plain view
 * with the same columns (the table and the composition traits it no longer holds).
 */
async function rewrittenViews(db: Db, participants = 'stats_participant_traits') {
  return {
    participants: [
      ...(await db.unsafe(`SELECT * FROM ${participants} ORDER BY match_id, participant_id`)),
    ],
    questItems: [...(await db`SELECT * FROM stats_quest_items ORDER BY match_id, participant_id`)],
    swaps: [...(await db`SELECT * FROM stats_item_swaps ORDER BY 1, 2, 3, 4, 5`)],
    choices: [...(await db`SELECT * FROM stats_choices ORDER BY 1, 2, 3, 4, 5`)],
    mastery: [...(await db`SELECT * FROM stats_champion_mastery ORDER BY 1, 2, 3, 4`)],
    lanePhase: [...(await db`SELECT * FROM stats_champion_lane_phase ORDER BY 1, 2, 3, 4, 5`)],
  };
}

describe.skipIf(!TEST_DATABASE_URL)('storage migrations on a populated database', () => {
  let db: Db;
  let before: string;

  // A schema migrated up to 0024 and a new pool (see db.integration.test.ts).
  beforeEach(async () => {
    before = await mkdtemp(join(tmpdir(), 'pickleague-migrations-'));
    for (const f of await listMigrationFiles()) {
      if (f.version < '0025') await copyFile(f.path, join(before, f.name));
    }
    const admin = testDb();
    await admin.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(admin, { dir: before });
    await admin.end();
    db = testDb();
  });
  afterEach(async () => {
    await db.end();
    await rm(before, { recursive: true, force: true });
  });

  test('events become arrays, unread masteries and columns go, and the stats keep their rows', async () => {
    await populateOldLayout(db);
    // The stats as the previous version computed them (the views the rewritten ones read first).
    for (const view of [
      'stats_champion_traits',
      'stats_team_comp',
      'stats_comp_thresholds',
      'stats_participants',
      'stats_quest_items',
      'stats_tierlist_participants',
      'stats_item_swaps',
      'stats_choices',
      'stats_champion_mastery',
      'stats_champion_lane_phase',
    ]) {
      await db.unsafe(`REFRESH MATERIALIZED VIEW ${view}`);
    }
    const old = await rewrittenViews(db, 'stats_participants');
    const [counts] = await db`
      SELECT (SELECT count(*)::int FROM (
                SELECT match_id, participant_id FROM item_events WHERE type <> 'DESTROYED'
                UNION
                SELECT match_id, participant_id FROM skill_events WHERE NOT is_evolve) x
             ) AS participants_with_events`;

    const files = await listMigrationFiles();
    expect((await migrate(db)).applied).toEqual(
      files.filter((f) => f.version >= '0025').map((f) => f.name),
    );

    // One row per participant with events, in seq order; DESTROYED rows and evolutions are gone.
    const events = await db`SELECT * FROM participant_events ORDER BY match_id, participant_id`;
    expect(events).toHaveLength(counts?.participants_with_events);
    expect([...events]).toEqual([
      {
        match_id: MATCH,
        participant_id: 1,
        item_types: [...'PPPPUPPPPPPPPSPSu'],
        item_ids: [
          3340, 1055, 2003, 2003, 2003, 1001, 1036, 3031, 3006, 3036, 3071, 3072, 3078, 3006, 3047,
          3031, 3031,
        ],
        item_at_ms: [
          2_000, 5_000, 6_000, 7_000, 8_000, 240_000, 300_000, 600_000, 700_000, 900_000, 1_100_000,
          1_300_000, 1_500_000, 1_800_000, 1_801_200, 1_900_000, 1_900_800,
        ],
        skill_slots: [1, 2, 3, 1, 1, 4, 1, 3, 1, 3],
      },
      {
        match_id: MATCH,
        participant_id: 2,
        item_types: [],
        item_ids: [],
        item_at_ms: [],
        skill_slots: [2, 1, 3],
      },
      {
        match_id: MATCH,
        participant_id: 5,
        item_types: ['P'],
        item_ids: [3869],
        item_at_ms: [900_000],
        skill_slots: [],
      },
      {
        match_id: REMAKE,
        participant_id: 1,
        item_types: ['P'],
        item_ids: [1055],
        item_at_ms: [2_000],
        skill_slots: [],
      },
    ]);

    // The rewritten views hold what the old ones held, row for row.
    const now = await rewrittenViews(db);
    expect(now).toEqual(old);
    expect(now.participants).toHaveLength(10);
    expect(now.participants[0]).toMatchObject({
      match_id: MATCH,
      participant_id: 1,
      starter: '1055,2003',
      early: [1001, 1036],
      core: [3031, 3036, 3071, 3072, 3078],
      boots: 3006,
      boots_pos: 1,
      skill_first3: '1,2,3',
      skill_max: '1,3,2',
      skill_seq: '1,2,3,1,1,4,1,3,1,3',
    });
    expect(now.participants[2]).toMatchObject({
      participant_id: 3,
      starter: null,
      early: null,
      core: null,
      boots: null,
      boots_pos: null,
      skill_first3: null,
      skill_max: null,
      skill_seq: null,
    });
    expect(now.questItems).toEqual([
      { match_id: MATCH, participant_id: 5, item_id: 3869 }, // bought, no longer in the inventory
      { match_id: MATCH, participant_id: 10, item_id: 3869 }, // in the end-of-game inventory
    ]);
    expect(now.swaps).toEqual([
      {
        patch: PATCH,
        position: 'TOP',
        champion_id: 1,
        sold_item_id: 3006,
        bought_item_id: 3047,
        games: 1,
        minute_sum: 30,
      },
    ]);

    // 0030: the per-participant rows are tables, filled by the migration from what the views
    // held. The remake has no row anywhere and is left to the first refresh.
    expect([...(await db`SELECT match_id FROM stats_matches`)]).toEqual([{ match_id: MATCH }]);
    expect([...(await db`SELECT * FROM stats_patch_items`)]).toEqual([
      { patch: PATCH, signature: expect.stringMatching(/^[0-9a-f]{32}$/) },
    ]);
    // Every lane of the match is complete: 1v1 in the three solo lanes, 2v2 in the bot lane.
    expect([...(await db`SELECT * FROM stats_lanes ORDER BY lane`)]).toEqual([
      {
        match_id: MATCH,
        lane: 'BOT',
        patch: PATCH,
        blue_ids: [4, 5],
        blue_positions: ['BOTTOM', 'UTILITY'],
        red_ids: [9, 10],
        red_positions: ['BOTTOM', 'UTILITY'],
        has_15: false,
        gold_10: -100, // blue minus red at 10 min: (4 + 5 - 9 - 10) x 10 gold
        xp_10: 0,
        cs_10: 0,
        gold_15: null,
        xp_15: null,
        cs_15: null,
      },
      ...[
        ['JUNGLE', 2, 7],
        ['MIDDLE', 3, 8],
        ['TOP', 1, 6],
      ].map(([lane, blue, red]) => ({
        match_id: MATCH,
        lane,
        patch: PATCH,
        blue_ids: [blue],
        blue_positions: [lane],
        red_ids: [red],
        red_positions: [lane],
        has_15: false,
        gold_10: -50,
        xp_10: 0,
        cs_10: 0,
        gold_15: null,
        xp_15: null,
        cs_15: null,
      })),
    ]);
    expect([...(await db`SELECT * FROM stats_participant_swaps`)]).toEqual([
      {
        match_id: MATCH,
        participant_id: 1,
        patch: PATCH,
        position: 'TOP',
        champion_id: 1,
        sold_item_id: 3006,
        bought_item_id: 3047,
        at_ms: 1_800_000,
      },
    ]);

    // A refresh, as the API runs it: the remake is taken, nothing else changes. Then every match
    // computed again from nothing gives the same rows.
    const fill = async () =>
      Object.fromEntries(
        (
          await db<{ step: string; row_count: string }[]>`
            SELECT step, row_count FROM pl_stats_fill(1000)`
        ).map((r) => [r.step, Number(r.row_count)]),
      );
    const refreshViews = async () => {
      await db.unsafe('REFRESH MATERIALIZED VIEW stats_team_traits');
      for (const view of [
        'stats_choices',
        'stats_item_swaps',
        'stats_champion_mastery',
        'stats_champion_lane_phase',
      ]) {
        await db.unsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      }
    };
    expect(await fill()).toEqual({
      stats_patch_items: 0,
      stats_matches: 1,
      stats_participants: 0,
      stats_quest_items: 0,
      stats_lanes: 0,
      stats_participant_swaps: 0,
    });
    await refreshViews();
    expect(await rewrittenViews(db)).toEqual(old);
    await db.unsafe('TRUNCATE stats_matches CASCADE');
    expect([...(await db`SELECT 1 FROM stats_participants`)]).toEqual([]);
    expect(await fill()).toEqual({
      stats_patch_items: 0,
      stats_matches: 2,
      stats_participants: 10,
      stats_quest_items: 2,
      stats_lanes: 4,
      stats_participant_swaps: 1,
    });
    await refreshViews();
    expect(await rewrittenViews(db)).toEqual(old);
    expect(now.mastery).toEqual([
      { patch: PATCH, position: 'TOP', champion_id: 1, bucket: 5, games: 1, wins: 1 },
      { patch: PATCH, position: 'JUNGLE', champion_id: 2, bucket: 2, games: 1, wins: 1 },
    ]);

    // Masteries: only the rows of champions the player has a stored game on are left, as they were.
    expect([
      ...(await db`
        SELECT puuid, champion_id, level, points, last_played_at FROM champion_masteries
        ORDER BY puuid, champion_id`),
    ]).toEqual([
      {
        puuid: fakePuuid(1),
        champion_id: 1,
        level: 5,
        points: 250_000,
        last_played_at: new Date('2026-11-01T00:00:00Z'),
      },
      {
        puuid: fakePuuid(2),
        champion_id: 2,
        level: 5,
        points: 40_000,
        last_played_at: new Date('2026-11-01T00:00:00Z'),
      },
    ]);

    // participants: the columns nothing read are gone, the others kept their values, and the
    // views that read them still refresh.
    const columns = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'participants' ORDER BY ordinal_position`;
    expect(columns.map((c) => c.column_name)).toEqual([
      'match_id',
      'participant_id',
      'puuid',
      'team_id',
      'champion_id',
      'position',
      'win',
      'summoner_spell_1',
      'summoner_spell_2',
      'rune_primary_tree',
      'rune_secondary_tree',
      'runes',
      'stat_shards',
      'final_items',
      'damage_to_champions',
      'physical_damage_to_champions',
      'magic_damage_to_champions',
      'true_damage_to_champions',
      'damage_taken',
      'damage_self_mitigated',
      'healing_done',
      'cc_time_on_others_s',
      'gold_by_minute',
      'xp_by_minute',
      'cs_by_minute',
    ]);
    const [kept] = await db`
      SELECT puuid, final_items, damage_to_champions, physical_damage_to_champions,
             magic_damage_to_champions, true_damage_to_champions, damage_taken,
             damage_self_mitigated, healing_done, cc_time_on_others_s,
             gold_by_minute, xp_by_minute, cs_by_minute
      FROM participants WHERE match_id = ${MATCH} AND participant_id = 10`;
    expect(kept).toEqual({
      puuid: fakePuuid(10),
      final_items: [3869, 0, 0, 0, 0, 0, 3340],
      damage_to_champions: 15000,
      physical_damage_to_champions: 9000,
      magic_damage_to_champions: 5000,
      true_damage_to_champions: 1000,
      damage_taken: 18000,
      damage_self_mitigated: 9000,
      healing_done: 1500,
      cc_time_on_others_s: 20,
      gold_by_minute: Array.from({ length: 12 }, (_, minute) => 500 * (minute + 1) + 100),
      xp_by_minute: Array.from({ length: 12 }, (_, minute) => 280 * minute),
      cs_by_minute: Array.from({ length: 12 }, (_, minute) => 6 * minute),
    });
    for (const view of ['stats_champion_traits', 'stats_champion_lane_phase']) {
      await db.unsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
    }

    // The old tables are gone, and deleting a match still takes its events with it.
    const [gone] = await db`
      SELECT to_regclass('item_events') AS item_events, to_regclass('skill_events') AS skill_events,
             to_regtype('item_event_type') AS item_event_type`;
    expect(gone).toEqual({ item_events: null, skill_events: null, item_event_type: null });
    await db`DELETE FROM matches WHERE id = ${MATCH}`;
    expect([...(await db`SELECT match_id FROM participant_events`)]).toEqual([
      { match_id: REMAKE },
    ]);
  }, 60_000);

  test('0026 refuses to drop the event tables when a match was stored after 0025', async () => {
    await populateOldLayout(db);
    const files = await listMigrationFiles();
    const upTo0025 = await mkdtemp(join(tmpdir(), 'pickleague-migrations-'));
    try {
      for (const f of files) {
        if (f.version < '0026') await copyFile(f.path, join(upTo0025, f.name));
      }
      expect((await migrate(db, { dir: upTo0025 })).applied).toEqual([
        '0025_participant_events.sql',
      ]);
    } finally {
      await rm(upTo0025, { recursive: true, force: true });
    }
    // A worker of the previous version stores a match: its events only go to the old tables.
    await db`
      INSERT INTO matches (id, platform, patch, game_version, queue_id, started_at, duration_s,
                           is_remake, is_early_surrender, winning_team)
      VALUES ('KR_7000000003', 'KR', ${PATCH}, ${`${PATCH}.1.1`}, 420, now(), 1800, false, false, 100)`;

    await expect(migrate(db)).rejects.toThrow(/stored after migration 0025/);
    const [state] = await db`
      SELECT to_regclass('item_events') IS NOT NULL AS item_events,
             (SELECT max(version) FROM schema_migrations) AS last`;
    expect(state).toEqual({ item_events: true, last: '0025' });

    // The way out the error gives: copy the events again.
    await db.unsafe(
      "DROP TABLE participant_events; DELETE FROM schema_migrations WHERE version = '0025'",
    );
    expect((await migrate(db)).applied).toEqual(
      files.filter((f) => f.version >= '0025').map((f) => f.name),
    );
    expect((await db`SELECT 1 FROM participant_events`).length).toBe(4);
  }, 60_000);

  test('a populated database and an empty one end with the same schema', async () => {
    await populateOldLayout(db);
    await migrate(db);
    const populated = await schemaOf(db);
    // Nothing keeps a name of the transition (*_0026, *_0030, *_old).
    const names = [
      ...populated.columns.map((c) => c.relname),
      ...populated.indexes.map((i) => i.indexname),
      ...populated.constraints.map((c) => c.conname),
      ...populated.functions.map((f) => f.proname),
    ];
    expect(names.filter((n) => /_(\d{4}|old)(_|$)/.test(n))).toEqual([]);
    // The stats layer of 0030: the per-participant rows are tables, each hanging from stats_matches.
    const kinds = Object.fromEntries(populated.columns.map((c) => [c.relname, c.relkind]));
    expect(kinds).toMatchObject({
      stats_matches: 'r',
      stats_patch_items: 'r',
      stats_participants: 'r',
      stats_quest_items: 'r',
      stats_lanes: 'r',
      stats_participant_swaps: 'r',
      stats_team_traits: 'm',
      stats_participant_traits: 'v',
      stats_participant_choices: 'v',
      stats_choices: 'm',
      stats_champion_lane_phase: 'm',
      stats_item_swaps: 'm',
    });
    expect(
      populated.constraints
        .filter((c) => c.def.includes('REFERENCES stats_matches'))
        .map((c) => `${c.on_table}: ${c.def}`)
        .sort(),
    ).toEqual(
      ['stats_lanes', 'stats_participant_swaps', 'stats_participants', 'stats_quest_items']
        .map(
          (t) =>
            `${t}: FOREIGN KEY (match_id) REFERENCES stats_matches(match_id) ON DELETE CASCADE`,
        )
        .sort(),
    );

    await db.end();
    db = testDb();
    await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    expect(await schemaOf(db)).toEqual(populated);
  }, 60_000);
});
