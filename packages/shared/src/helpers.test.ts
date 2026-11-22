import { describe, expect, test } from 'bun:test';
import { buildRequestSchema, picksRequestSchema } from './api-contract.ts';
import { divisionToNumber, parsePosition } from './domain.ts';
import {
  comparePatches,
  latestPatch,
  patchFromDdragonVersion,
  patchFromGameVersion,
  sortPatchesDesc,
} from './patch.ts';
import {
  MATCH_CLUSTER,
  matchBaseUrl,
  parsePlatformList,
  platformBaseUrl,
  platformFromMatchId,
} from './platform.ts';
import { isTimelineEvent, type TimelineEventDto } from './riot-dto.ts';

describe('platform routing', () => {
  test('match clusters', () => {
    expect(MATCH_CLUSTER).toEqual({ KR: 'asia', EUW1: 'europe', NA1: 'americas', VN2: 'sea' });
  });

  test('hosts', () => {
    expect(platformBaseUrl('EUW1')).toBe('https://euw1.api.riotgames.com');
    expect(matchBaseUrl('VN2')).toBe('https://sea.api.riotgames.com');
  });

  test('parsePlatformList', () => {
    expect(parsePlatformList(undefined)).toEqual(['KR', 'EUW1', 'NA1', 'VN2']);
    expect(parsePlatformList(' euw1, kr ,EUW1')).toEqual(['EUW1', 'KR']);
    expect(() => parsePlatformList('EUW1,OC1')).toThrow(/OC1/);
  });

  test('platformFromMatchId', () => {
    expect(platformFromMatchId('EUW1_1234567890')).toBe('EUW1');
    expect(platformFromMatchId('OC1_1')).toBeNull();
  });
});

describe('patch helpers', () => {
  test('patchFromGameVersion', () => {
    expect(patchFromGameVersion('15.22.715.1234')).toBe('15.22');
    expect(patchFromGameVersion('15.3.1.1')).toBe('15.3');
    expect(() => patchFromGameVersion('garbage')).toThrow();
  });

  test('patchFromDdragonVersion', () => {
    expect(patchFromDdragonVersion('15.22.1')).toBe('15.22');
    expect(() => patchFromDdragonVersion('lolpatch_7.20')).toThrow();
  });

  test('comparePatches is numeric', () => {
    expect(comparePatches('15.9', '15.10')).toBeLessThan(0);
    expect(comparePatches('16.1', '15.24')).toBeGreaterThan(0);
    expect(comparePatches('15.22', '15.22')).toBe(0);
    expect(sortPatchesDesc(['15.9', '15.10', '14.24'])).toEqual(['15.10', '15.9', '14.24']);
    expect(latestPatch([])).toBeNull();
  });
});

describe('domain helpers', () => {
  test('parsePosition', () => {
    expect(parsePosition('UTILITY')).toBe('UTILITY');
    expect(parsePosition('')).toBeNull();
    expect(parsePosition('Invalid')).toBeNull();
  });

  test('divisionToNumber', () => {
    expect(divisionToNumber('DIAMOND', 'II')).toBe(2);
    expect(divisionToNumber('CHALLENGER', 'I')).toBeNull();
  });
});

describe('timeline event narrowing', () => {
  test('isTimelineEvent narrows known types', () => {
    const events: TimelineEventDto[] = [
      { type: 'ITEM_PURCHASED', timestamp: 1000, participantId: 3, itemId: 1055 },
      { type: 'WARD_PLACED', timestamp: 2000, creatorId: 3 },
    ];
    const purchases = events.filter((e) => isTimelineEvent(e, 'ITEM_PURCHASED'));
    expect(purchases.map((e) => e.itemId)).toEqual([1055]);
  });
});

describe('request schemas', () => {
  test('picks: applies defaults', () => {
    const parsed = picksRequestSchema.parse({ role: 'UTILITY' });
    expect(parsed).toEqual({ role: 'UTILITY', allies: [], enemies: [], bans: [] });
  });

  test('picks: accepts a full champion select', () => {
    const parsed = picksRequestSchema.safeParse({
      role: 'UTILITY',
      allies: [
        { championId: 222, role: 'BOTTOM' },
        { championId: null, role: null },
      ],
      enemies: [89, null],
      bans: [157, 238],
      availableChampionIds: [12, 40, 412],
      limit: 10,
      patch: '15.22',
    });
    expect(parsed.success).toBe(true);
  });

  test('picks: rejects bad roles, ids and oversized teams', () => {
    expect(picksRequestSchema.safeParse({ role: 'SUPPORT' }).success).toBe(false);
    expect(picksRequestSchema.safeParse({ role: 'TOP', bans: [-1] }).success).toBe(false);
    expect(picksRequestSchema.safeParse({ role: 'TOP', enemies: [1, 2, 3, 4, 5, 6] }).success).toBe(
      false,
    );
    expect(picksRequestSchema.safeParse({ role: 'TOP', patch: '15.22.1' }).success).toBe(false);
  });

  test('build: requires championId and role', () => {
    expect(buildRequestSchema.safeParse({ role: 'UTILITY' }).success).toBe(false);
    const parsed = buildRequestSchema.parse({
      championId: 412,
      role: 'UTILITY',
      enemies: [{ championId: 89, role: null }],
    });
    expect(parsed.allies).toEqual([]);
    expect(parsed.enemies).toEqual([{ championId: 89, role: null }]);
  });
});
