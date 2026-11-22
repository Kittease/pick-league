import { describe, expect, test } from 'bun:test';
import type { MatchDto, TimelineDto } from '@pick-league/shared';
import matchFixture from './fixtures/match.json';
import timelineFixture from './fixtures/timeline.json';
import { MatchParseError, parseMatch } from './parse-match.ts';

const fresh = () => ({
  match: structuredClone(matchFixture) as unknown as MatchDto,
  timeline: structuredClone(timelineFixture) as unknown as TimelineDto,
});

const parse = (edit?: (m: MatchDto, t: TimelineDto) => void) => {
  const { match, timeline } = fresh();
  edit?.(match, timeline);
  return parseMatch(match, timeline);
};

describe('parseMatch: match row', () => {
  test('reads id, platform, patch, times and winner', () => {
    const { match } = parse();
    expect(match).toEqual({
      id: 'EUW1_7000000001',
      platform: 'EUW1',
      patch: '15.22',
      gameVersion: '15.22.715.1234',
      queueId: 420,
      startedAt: new Date(1762000060000),
      durationS: 1834,
      isRemake: false,
      isEarlySurrender: false,
      winningTeam: 100,
    });
  });

  test('old payloads without gameEndTimestamp have gameDuration in ms', () => {
    const { match } = parse((m) => {
      m.info.gameEndTimestamp = undefined;
      m.info.gameDuration = 1834000;
    });
    expect(match.durationS).toBe(1834);
  });

  test('remake: early surrender within the remake window', () => {
    const { match } = parse((m) => {
      m.info.gameDuration = 210;
      for (const p of m.info.participants) p.gameEndedInEarlySurrender = true;
    });
    expect(match.isRemake).toBe(true);
    expect(match.isEarlySurrender).toBe(false);
  });

  test('remake: aborted game (endOfGameResult)', () => {
    const { match } = parse((m) => {
      m.info.endOfGameResult = 'Abort_TooFewPlayers';
    });
    expect(match.isRemake).toBe(true);
  });

  test('15-minute surrender is an early surrender, not a remake', () => {
    const { match } = parse((m) => {
      m.info.gameDuration = 15 * 60 + 20;
      for (const p of m.info.participants) p.gameEndedInSurrender = true;
    });
    expect(match.isRemake).toBe(false);
    expect(match.isEarlySurrender).toBe(true);
  });

  test('late surrender is neither', () => {
    const { match } = parse((m) => {
      for (const p of m.info.participants) p.gameEndedInSurrender = true;
    });
    expect(match.isRemake).toBe(false);
    expect(match.isEarlySurrender).toBe(false);
  });

  test('winner falls back to participants when teams lack win', () => {
    const { match } = parse((m) => {
      for (const t of m.info.teams) t.win = false;
      for (const p of m.info.participants) p.win = p.teamId === 200;
    });
    expect(match.winningTeam).toBe(200);
  });
});

describe('parseMatch: teams and bans', () => {
  test('team objectives incl. voidgrubs (horde) and atakhan', () => {
    const { teams } = parse();
    expect(teams).toEqual([
      {
        teamId: 100,
        win: true,
        firstBlood: true,
        firstTower: true,
        firstDragon: false,
        firstBaron: true,
        championKills: 28,
        towerKills: 9,
        inhibitorKills: 1,
        dragonKills: 2,
        baronKills: 1,
        heraldKills: 1,
        voidgrubKills: 4,
        atakhanKills: 1,
      },
      {
        teamId: 200,
        win: false,
        firstBlood: false,
        firstTower: false,
        firstDragon: true,
        firstBaron: false,
        championKills: 15,
        towerKills: 3,
        inhibitorKills: 0,
        dragonKills: 3,
        baronKills: 0,
        heraldKills: 0,
        voidgrubKills: 2,
        atakhanKills: 0,
      },
    ]);
  });

  test('missing horde/atakhan objectives count as 0', () => {
    const { teams } = parse((m) => {
      for (const t of m.info.teams) {
        t.objectives.horde = undefined;
        t.objectives.atakhan = undefined;
      }
    });
    expect(teams.map((t) => [t.voidgrubKills, t.atakhanKills])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  test('bans keep pick turn and -1 for no ban', () => {
    const { bans } = parse();
    expect(bans).toHaveLength(10);
    expect(bans[0]).toEqual({ teamId: 100, pickTurn: 1, championId: 101 });
    expect(bans[2]).toEqual({ teamId: 100, pickTurn: 3, championId: -1 });
    expect(bans[9]).toEqual({ teamId: 200, pickTurn: 10, championId: 110 });
  });
});

describe('parseMatch: participants', () => {
  test('10 participants with identity, loadout and stats', () => {
    const { participants } = parse();
    expect(participants).toHaveLength(10);
    const p1 = participants[0];
    expect(p1).toMatchObject({
      participantId: 1,
      puuid: expect.stringContaining('fake-puuid-01'),
      riotIdGameName: 'Fake Player 1',
      riotIdTagLine: 'FAKE',
      teamId: 100,
      championId: 266,
      position: 'TOP',
      win: true,
      summonerSpell1: 4,
      summonerSpell2: 14,
      runePrimaryTree: 8000,
      runeSecondaryTree: 8400,
      runes: [8010, 9111, 9104, 8299, 8444, 8453],
      statShards: [5005, 5008, 5011],
      finalItems: [3078, 3047, 6610, 0, 1036, 0, 3340],
      damageToChampions: 19000,
      physicalDamageToChampions: 15000,
      magicDamageToChampions: 3000,
      trueDamageToChampions: 1000,
      damageTaken: 22000,
      damageSelfMitigated: 12000,
      healingDone: 3000,
      ccTimeOnOthersS: 20,
    });
  });

  test('empty teamPosition → null; empty Riot ID → null', () => {
    const { participants } = parse();
    expect(participants[8]?.position).toBeNull();
    expect(participants[9]?.riotIdGameName).toBeNull();
    expect(participants[9]?.riotIdTagLine).toBeNull();
  });

  test('per-minute arrays: one value per frame', () => {
    const { participants } = parse();
    const p2 = participants[1];
    expect(p2?.goldByMinute).toEqual([502, 902, 1302, 1702]);
    expect(p2?.xpByMinute).toEqual([2, 302, 602, 902]);
    expect(p2?.csByMinute).toEqual([0, 4, 8, 12]);
  });

  test('a frame missing a participant repeats its previous values', () => {
    const { participants } = parse();
    // Participant 7 is absent from the minute-2 frame.
    expect(participants[6]?.goldByMinute).toEqual([507, 907, 907, 1707]);
  });

  test('missing stats default to 0', () => {
    const { participants } = parse((m) => {
      const p = m.info.participants[0] as unknown as Record<string, unknown>;
      delete p.totalHeal;
      delete p.timeCCingOthers;
      delete p.item5;
    });
    expect(participants[0]?.healingDone).toBe(0);
    expect(participants[0]?.ccTimeOnOthersS).toBe(0);
    expect(participants[0]?.finalItems[5]).toBe(0);
  });

  test('perk styles are found by description, not by order', () => {
    const { participants } = parse((m) => {
      m.info.participants[0]?.perks.styles.reverse();
    });
    expect(participants[0]?.runes).toEqual([8010, 9111, 9104, 8299, 8444, 8453]);
    expect(participants[0]?.runePrimaryTree).toBe(8000);
  });
});

describe('parseMatch: timeline events', () => {
  test('item events in order per participant, with UNDO fields', () => {
    const { itemEvents } = parse();
    const p1 = itemEvents.filter((e) => e.participantId === 1);
    expect(p1).toEqual([
      {
        participantId: 1,
        seq: 1,
        atMs: 1500,
        type: 'PURCHASED',
        itemId: 1055,
        undoAfterItemId: null,
      },
      {
        participantId: 1,
        seq: 2,
        atMs: 1700,
        type: 'PURCHASED',
        itemId: 2003,
        undoAfterItemId: null,
      },
      {
        participantId: 1,
        seq: 3,
        atMs: 2000,
        type: 'UNDO',
        itemId: 2003,
        undoAfterItemId: 0,
      },
      {
        participantId: 1,
        seq: 4,
        atMs: 2100,
        type: 'PURCHASED',
        itemId: 3340,
        undoAfterItemId: null,
      },
      {
        participantId: 1,
        seq: 5,
        atMs: 111000,
        type: 'SOLD',
        itemId: 1055,
        undoAfterItemId: null,
      },
      {
        participantId: 1,
        seq: 6,
        atMs: 112500,
        type: 'UNDO',
        itemId: 0,
        undoAfterItemId: 1055,
      },
    ]);
    // ITEM_DESTROYED events (participant 3 used a biscuit) are not kept.
    expect(itemEvents.some((e) => e.participantId === 3)).toBe(false);
    // participantId 0 events are dropped.
    expect(itemEvents.some((e) => e.participantId === 0)).toBe(false);
  });

  test('skill points in order per participant; evolutions and invalid slots dropped', () => {
    const { skillEvents } = parse();
    expect(skillEvents).toEqual([
      { participantId: 1, seq: 1, skillSlot: 1 },
      { participantId: 6, seq: 1, skillSlot: 3 },
      { participantId: 1, seq: 2, skillSlot: 3 },
    ]);
  });

  test('unknown event types are ignored', () => {
    const before = parse();
    const after = parse((_, t) => {
      t.info.frames[1]?.events.push({ type: 'SOME_NEW_EVENT', timestamp: 70000, foo: 1 });
    });
    expect(after).toEqual(before);
  });
});

describe('parseMatch: invalid payloads', () => {
  test('rejects a timeline of another match', () => {
    expect(() =>
      parse((_, t) => {
        t.metadata.matchId = 'EUW1_1';
      }),
    ).toThrow(MatchParseError);
  });

  test('rejects a match without 10 participants', () => {
    expect(() =>
      parse((m) => {
        m.info.participants.pop();
      }),
    ).toThrow(MatchParseError);
  });

  test('rejects a timeline without frames', () => {
    expect(() =>
      parse((_, t) => {
        t.info.frames = [];
      }),
    ).toThrow(MatchParseError);
  });
});
