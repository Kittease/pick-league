/**
 * Helpers for integration tests against a real Postgres (`DATABASE_URL_TEST`).
 * Not exported from the package entry point.
 */
import type { StaticPatchData } from '@pick-league/shared';
import { createDb, type Db } from './client.ts';
import { migrate } from './migrate.ts';
import type { ParsedMatch, ParsedParticipant } from './types.ts';

export const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST;

if (!TEST_DATABASE_URL) {
  console.warn(
    '[db] DATABASE_URL_TEST is not set: skipping Postgres integration tests (run `bun run db:test:up`).',
  );
}

export function testDb(): Db {
  if (!TEST_DATABASE_URL) throw new Error('DATABASE_URL_TEST is not set');
  return createDb(TEST_DATABASE_URL, { max: 4 });
}

/** Drops everything in the public schema, then applies all migrations. */
export async function resetDb(db: Db): Promise<void> {
  await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}

export function staticPatch(patch: string, ddragonVersion = `${patch}.1`): StaticPatchData {
  return {
    patch,
    ddragonVersion,
    champions: [
      {
        id: 1,
        slug: 'Annie',
        name: 'Annie',
        tags: ['Mage'],
        attackRange: 625,
        info: { attack: 2, defense: 3, magic: 10, difficulty: 6 },
        spells: [
          { slot: 1, name: 'Q', image: 'AnnieQ.png' },
          { slot: 2, name: 'W', image: 'AnnieW.png' },
          { slot: 3, name: 'E', image: 'AnnieE.png' },
          { slot: 4, name: 'R', image: 'AnnieR.png' },
        ],
      },
    ],
    items: [
      {
        id: 1001,
        name: 'Boots',
        goldTotal: 300,
        tags: ['Boots'],
        buildsFrom: [],
        buildsInto: [3006],
        isBoots: true,
        isCompleted: false,
        isConsumable: false,
        stats: { FlatMovementSpeedMod: 25 },
      },
    ],
    runeTrees: [{ id: 8000, name: 'Precision', icon: 'p.png' }],
    runes: [{ id: 8005, treeId: 8000, row: 0, name: 'Press the Attack', icon: 'pta.png' }],
    summonerSpells: [{ id: 4, name: 'Flash', image: 'SummonerFlash.png' }],
  };
}

/** Obviously fake puuid. */
export const fakePuuid = (n: number) => `test-puuid-${String(n).padStart(4, '0')}`;

function participant(id: number, puuid: string): ParsedParticipant {
  const teamId = id <= 5 ? 100 : 200;
  const positions = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
  return {
    participantId: id,
    puuid,
    riotIdGameName: `Fake Player ${id}`,
    riotIdTagLine: 'TEST',
    teamId,
    championId: id,
    position: positions[(id - 1) % 5] ?? null,
    win: teamId === 100,
    summonerSpell1: 4,
    summonerSpell2: 14,
    runePrimaryTree: 8000,
    runeSecondaryTree: 8400,
    runes: [8005, 9111, 9104, 8014, 8444, 8451],
    statShards: [5008, 5008, 5011],
    finalItems: [3006, 0, 0, 0, 0, 0, 3340],
    champLevel: 14,
    kills: 3,
    deaths: 2,
    assists: 7,
    laneMinions: 150,
    jungleMinions: 10,
    goldEarned: 11000,
    goldSpent: 10500,
    damageToChampions: 15000,
    physicalDamageToChampions: 9000,
    magicDamageToChampions: 5000,
    trueDamageToChampions: 1000,
    damageTaken: 18000,
    damageSelfMitigated: 9000,
    damageToBuildings: 2000,
    damageToObjectives: 4000,
    healingDone: 1500,
    healsOnTeammates: 0,
    shieldsOnTeammates: 0,
    ccTimeOnOthersS: 20,
    visionScore: 25,
    wardsPlaced: 10,
    wardsKilled: 3,
    controlWardsBought: 2,
    goldByMinute: [500, 900, 1400],
    xpByMinute: [0, 280, 700],
    csByMinute: [0, 6, 14],
    levelByMinute: [1, 2, 3],
    damageToChampionsByMinute: [0, 120, 300],
    positionXByMinute: [554, 3000, 5000],
    positionYByMinute: [581, 9000, 11000],
  };
}

/** A minimal but complete parsed match; participants use `puuids[0..9]`. */
export function parsedMatch(
  id: string,
  patch: string,
  puuids: readonly string[],
  startedAt = new Date('2026-11-01T12:00:00Z'),
): ParsedMatch {
  return {
    match: {
      id,
      platform: 'EUW1',
      patch,
      gameVersion: `${patch}.715.1234`,
      queueId: 420,
      startedAt,
      durationS: 1800,
      isRemake: false,
      isEarlySurrender: false,
      winningTeam: 100,
    },
    teams: [100, 200].map((teamId) => ({
      teamId: teamId as 100 | 200,
      win: teamId === 100,
      firstBlood: teamId === 100,
      firstTower: teamId === 100,
      firstDragon: teamId === 200,
      firstBaron: teamId === 100,
      championKills: 20,
      towerKills: 8,
      inhibitorKills: 1,
      dragonKills: 2,
      baronKills: 1,
      heraldKills: 1,
      voidgrubKills: 3,
      atakhanKills: 0,
    })),
    bans: Array.from({ length: 10 }, (_, i) => ({
      teamId: (i < 5 ? 100 : 200) as 100 | 200,
      pickTurn: i + 1,
      championId: i === 9 ? -1 : 100 + i,
    })),
    participants: puuids.slice(0, 10).map((p, i) => participant(i + 1, p)),
    itemEvents: [
      {
        participantId: 1,
        seq: 1,
        atMs: 1000,
        type: 'PURCHASED',
        itemId: 1055,
        undoAfterItemId: null,
      },
      {
        participantId: 1,
        seq: 2,
        atMs: 1500,
        type: 'UNDO',
        itemId: 1055,
        undoAfterItemId: 0,
      },
    ],
    skillEvents: [{ participantId: 1, seq: 1, skillSlot: 1 }],
  };
}
