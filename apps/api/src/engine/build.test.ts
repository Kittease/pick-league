import { describe, expect, test } from 'bun:test';
import { buildRequestSchema } from '@pick-league/shared';
import { type BuildData, recommendBuild } from './build.ts';
import { items, names, role, thresholds, traitsOf, vs } from './fixtures.ts';
import type { ChoiceKind, ChoiceMatchupRow, ChoiceRow, ChoiceTraitRow } from './types.ts';

const CUR = '15.22';
const PAGE_AFTERSHOCK = '8400|8300|8439,8401,8473,8242,8345,8347|5007,5010,5011';
const PAGE_GLACIAL = '8300|8400|8351,8306,8345,8347,8473,8242|5007,5010,5011';

const c = (
  kind: ChoiceKind,
  choice: string,
  games: number,
  wins: number,
  avgPos: number | null = null,
): ChoiceRow => ({
  kind,
  choice,
  games,
  wins,
  avgPos,
});

/** Leona support: 1,000 games, 50 % win rate. */
function data(overrides: Partial<BuildData> = {}): BuildData {
  return {
    currentPatch: CUR,
    previousPatch: null,
    patch: { patch: CUR, games: 1000, fellBack: false, currentGames: 1000 },
    baseline: { games: 1000, wins: 500 },
    roleStats: [
      role(CUR, 89, 'UTILITY', 1000, 500),
      role(CUR, 412, 'UTILITY', 1000, 500),
      role(CUR, 222, 'BOTTOM', 1000, 500),
      role(CUR, 16, 'UTILITY', 1000, 500),
      role(CUR, 19, 'JUNGLE', 1000, 500),
    ],
    choices: [
      c('rune_page', PAGE_AFTERSHOCK, 700, 350),
      c('rune_page', PAGE_GLACIAL, 300, 150),
      c('keystone', '8439', 700, 350),
      c('keystone', '8351', 300, 150),
      c('spells', '4,14', 700, 360),
      c('spells', '3,4', 300, 140),
      c('starter', '2003,2003,3865', 1000, 500),
      c('boots', '3047', 600, 300, 1.2),
      c('boots', '3111', 400, 200, 1),
      c('core3', '3190,3050,3109', 400, 220),
      c('core3', '3050,3190,3109', 300, 150),
      c('item', '3190', 1000, 500, 1.4),
      c('item', '3050', 1000, 500, 1.6),
      c('item', '3109', 800, 400, 3),
      c('item', '3075', 600, 300, 3.8),
      c('item', '3065', 300, 150, 4.2),
      c('item', '3011', 60, 30, 4),
      c('early_item', '1001', 900, 450, 1),
      c('early_item', '3067', 500, 250, 2),
      c('skill_first3', '3,1,2', 700, 350),
      c('skill_max', '3,2,1', 900, 450),
      c('skill_seq', '3,1,2,3,3,4,3,3,2,2,4,2,2,1,1,4,1,1', 50, 25),
    ],
    choiceMatchups: [],
    choiceTraits: [],
    compTraits: [],
    vs: [],
    championTraits: [traitsOf(CUR, 89, { physicalShare: 0.3, magicShare: 0.65 })],
    thresholds: [thresholds(CUR)],
    items,
    names,
    ...overrides,
  };
}

const req = (body: unknown) => buildRequestSchema.parse(body);
const LEONA = { championId: 89, role: 'UTILITY' };

describe('recommendBuild', () => {
  test('base build: runes, spells, skills, items in buy order with boots at their slot', () => {
    const b = recommendBuild(req(LEONA), data());
    expect(b).not.toBeNull();
    if (!b) return;
    expect(b.patchUsed).toBe(CUR);
    expect(b.runes.runeIds[0]).toBe(8439);
    expect(b.runes.selectedPerkIds).toHaveLength(9);
    expect(b.summonerSpells.spellIds).toEqual([4, 14]);
    expect(b.skillOrder).toMatchObject({ firstLevels: [3, 1, 2], maxOrder: [3, 2, 1] });
    expect(b.skillOrder.sequence).toHaveLength(18);
    expect(b.items.starting.map((i) => i.itemId)).toEqual([2003, 2003, 3865]);
    expect(b.items.early.map((i) => i.itemId)).toEqual([1001, 3067]);
    expect(b.items.core.map((i) => i.itemId)).toEqual([3190, 3047, 3050, 3109, 3075]);
    for (const piece of [b.runes, b.summonerSpells, b.skillOrder, ...b.items.core]) {
      expect(piece.reasons.length).toBeGreaterThan(0);
    }
    expect(b.items.situational).toEqual([]);
  });

  test('keystone adapts to the lane opponent', () => {
    const m = (choice: string, games: number, wins: number): ChoiceMatchupRow => ({
      opponentId: 412,
      opponentPosition: 'UTILITY',
      kind: 'keystone',
      choice,
      games,
      wins,
    });
    const b = recommendBuild(
      req({ ...LEONA, enemies: [{ championId: 412, role: 'UTILITY' }] }),
      data({
        vs: [vs(CUR, 89, 412, 'UTILITY', 300, 150)],
        choiceMatchups: [m('8439', 200, 80), m('8351', 100, 70)],
      }),
    );
    expect(b?.runes.runeIds[0]).toBe(8351);
    expect(b?.runes.primaryTreeId).toBe(8300);
    const reason = b?.runes.reasons[0];
    expect(reason).toMatchObject({ kind: 'matchup', games: 100, championIds: [412] });
    expect(reason?.label).toMatch(/^\+\d+\.\d% vs Thresh with Glacial Augment \(100 games\)$/);
  });

  test('data-backed item swap vs an enemy trait', () => {
    const t = (choice: string, games: number, wins: number): ChoiceTraitRow => ({
      trait: 'HIGH_HEALING',
      kind: 'item',
      choice,
      games,
      wins,
    });
    const b = recommendBuild(
      req({
        ...LEONA,
        enemies: [
          { championId: 16, role: 'UTILITY' },
          { championId: 19, role: 'JUNGLE' },
        ],
      }),
      data({
        championTraits: [
          traitsOf(CUR, 89),
          traitsOf(CUR, 16, { healingPerMin: 120 }),
          traitsOf(CUR, 19, { healingPerMin: 60 }),
        ],
        compTraits: [
          {
            patch: CUR,
            position: 'UTILITY',
            championId: 89,
            side: 'enemy',
            trait: 'HIGH_HEALING',
            games: 300,
            wins: 150,
          },
        ],
        choiceTraits: [t('3011', 60, 45), t('3109', 240, 110), t('3075', 200, 100)],
      }),
    );
    const swap = b?.items.situational[0];
    expect(swap?.itemId).toBe(3011);
    expect(swap?.replacesItemId).toBe(3109);
    expect(swap?.reasons[0]).toMatchObject({
      kind: 'item_swap',
      trait: 'HIGH_HEALING',
      games: 60,
      itemId: 3011,
    });
    expect(swap?.reasons[0]?.label).toContain('vs heal-heavy teams when built instead of');
  });

  test('tag rule fallback when the trait has no data', () => {
    const b = recommendBuild(
      req({
        ...LEONA,
        enemies: [
          { championId: 16, role: 'UTILITY' },
          { championId: 19, role: 'JUNGLE' },
        ],
      }),
      data({
        championTraits: [
          traitsOf(CUR, 16, { healingPerMin: 120 }),
          traitsOf(CUR, 19, { healingPerMin: 60 }),
        ],
      }),
    );
    const rule = b?.items.situational.find((s) => s.reasons[0]?.kind === 'tag_rule');
    // Thornmail is already in the core: the other anti-heal item this champion builds.
    expect(rule?.itemId).toBe(3011);
    expect(rule?.reasons[0]).toMatchObject({
      kind: 'tag_rule',
      delta: 0,
      games: 0,
      trait: 'HIGH_HEALING',
    });
  });

  test('returns null without data', () => {
    expect(
      recommendBuild(req(LEONA), data({ baseline: { games: 0, wins: 0 }, choices: [] })),
    ).toBeNull();
  });
});
