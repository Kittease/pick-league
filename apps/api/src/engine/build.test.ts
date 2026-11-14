import { describe, expect, test } from 'bun:test';
import { buildRequestSchema } from '@pick-league/shared';
import { type BuildData, recommendBuild } from './build.ts';
import { items, lane, names, role, thresholds, traitsOf, vs } from './fixtures.ts';
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
    patch: { patches: [CUR], merged: false, currentGames: 1000 },
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
    expect(b.patchesUsed).toEqual([CUR]);
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

  describe('situational items', () => {
    /** Enemies that are AD-heavy, high CC, heal-heavy, tanky and ranged at once. */
    const enemies = [
      { championId: 16, role: 'UTILITY' },
      { championId: 19, role: 'JUNGLE' },
    ];
    const enemy = {
      physicalShare: 0.7,
      magicShare: 0.25,
      ccPerMin: 1,
      healingPerMin: 100,
      tankinessPerMin: 2000,
      isRanged: true,
    };
    const TRAITS = ['AD_HEAVY', 'HIGH_CC', 'HIGH_HEALING', 'TANKY', 'POKE_RANGED'] as const;
    const traitData = (rows: ChoiceTraitRow[]): Partial<BuildData> => ({
      championTraits: [traitsOf(CUR, 89), traitsOf(CUR, 16, enemy), traitsOf(CUR, 19, enemy)],
      compTraits: TRAITS.map((trait) => ({
        patch: CUR,
        position: 'UTILITY' as const,
        championId: 89,
        side: 'enemy' as const,
        trait,
        games: 300,
        wins: 150,
      })),
      choiceTraits: rows,
    });
    const t = (trait: ChoiceTraitRow['trait'], item: number, wins: number): ChoiceTraitRow => ({
      trait,
      kind: 'item',
      choice: String(item),
      games: 100,
      wins,
    });

    test('ranked by data-backed delta before the cap, whatever the trait order', () => {
      const b = recommendBuild(
        req({ ...LEONA, enemies: [...enemies, { championId: 412, role: 'UTILITY' }] }),
        data({
          ...traitData([
            t('AD_HEAVY', 9002, 60),
            t('HIGH_CC', 9003, 62),
            t('HIGH_HEALING', 9001, 75), // the strongest answer, late in the trait order
            t('TANKY', 9004, 64),
            t('POKE_RANGED', 9005, 66),
          ]),
          vs: [vs(CUR, 89, 412, 'UTILITY', 300, 150)],
          choiceMatchups: [
            {
              opponentId: 412,
              opponentPosition: 'UTILITY',
              kind: 'item',
              choice: '9006',
              games: 100,
              wins: 58,
            },
          ],
        }),
      );
      const situational = b?.items.situational ?? [];
      // Six data-backed answers, four kept: the largest deltas, best first.
      expect(situational.map((s) => s.itemId)).toEqual([9001, 9005, 9004, 9003]);
      expect(situational[0]?.reasons[0]).toMatchObject({
        kind: 'item_swap',
        trait: 'HIGH_HEALING',
      });
      const deltas = situational.map((s) => s.reasons[0]?.delta ?? 0);
      expect(deltas).toEqual([...deltas].sort((x, y) => y - x));
    });

    test('an item answering several traits is listed once, for the trait it helps most', () => {
      // 9002 is the best answer to AD_HEAVY (small delta) and to TANKY (large delta): TANKY ranks
      // before AD_HEAVY, so it gets 9002 (in trait order AD_HEAVY took it first), and AD_HEAVY,
      // ranked last, is past the cap.
      const b = recommendBuild(
        req({ ...LEONA, enemies }),
        data(
          traitData([
            t('AD_HEAVY', 9002, 58),
            t('HIGH_CC', 9003, 62),
            t('HIGH_HEALING', 9001, 75),
            t('TANKY', 9002, 70),
            t('POKE_RANGED', 9005, 66),
          ]),
        ),
      );
      const ids = b?.items.situational.map((s) => s.itemId);
      expect(ids).toEqual([9001, 9002, 9005, 9003]);
      expect(new Set(ids).size).toBe(ids?.length ?? 0);
      const tanky = b?.items.situational.find((s) => s.itemId === 9002);
      expect(tanky?.reasons[0]).toMatchObject({ trait: 'TANKY' });
    });

    test('ties go to the lowest item id, whatever the row order', () => {
      const rows = [t('HIGH_HEALING', 9020, 70), t('HIGH_HEALING', 9010, 70)];
      for (const order of [rows, [...rows].reverse()]) {
        const b = recommendBuild(req({ ...LEONA, enemies }), data(traitData(order)));
        expect(b?.items.situational.map((s) => s.itemId)).toEqual([9010]);
      }
    });
  });

  test('base choices: equal records go to the lowest key, whatever the row order', () => {
    const tied = [c('spells', '4,14', 500, 250), c('spells', '3,4', 500, 250)];
    const rest = data().choices.filter((ch) => ch.kind !== 'spells');
    for (const order of [tied, [...tied].reverse()]) {
      const b = recommendBuild(req(LEONA), data({ choices: [...rest, ...order] }));
      expect(b?.summonerSpells.spellIds).toEqual([4, 3]);
    }
  });

  test('tag rule fallback when the trait has no data', () => {
    const healers = {
      ...LEONA,
      enemies: [
        { championId: 16, role: 'UTILITY' },
        { championId: 19, role: 'JUNGLE' },
      ],
    };
    const championTraits = [
      traitsOf(CUR, 16, { healingPerMin: 120 }),
      traitsOf(CUR, 19, { healingPerMin: 60 }),
    ];
    // Thornmail (anti-heal) is in the core: it gets the reason, nothing is added.
    const withThornmail = recommendBuild(req(healers), data({ championTraits }));
    const thornmail = withThornmail?.items.core.find((i) => i.itemId === 3075);
    expect(thornmail?.reasons[0]).toMatchObject({ kind: 'tag_rule', trait: 'HIGH_HEALING' });
    expect(withThornmail?.items.situational).toEqual([]);

    // Without it, the anti-heal item this champion builds is suggested.
    const choices = data().choices.filter((ch) => ch.choice !== '3075');
    const b = recommendBuild(req(healers), data({ championTraits, choices }));
    const rule = b?.items.situational.find((s) => s.reasons[0]?.kind === 'tag_rule');
    expect(rule?.itemId).toBe(3011);
    expect(rule?.reasons[0]).toMatchObject({
      kind: 'tag_rule',
      delta: 0,
      games: 0,
      trait: 'HIGH_HEALING',
    });
  });

  test('says when the previous patch is added to the current one', () => {
    const b = recommendBuild(
      req(LEONA),
      data({
        previousPatch: '15.21',
        patch: { patches: [CUR, '15.21'], merged: true, currentGames: 40 },
      }),
    );
    expect(b?.patchesUsed).toEqual([CUR, '15.21']);
    expect(b?.runes.reasons[0]).toMatchObject({
      kind: 'patch_fallback',
      label: '15.22 + 15.21 data: only 40 games on 15.22',
      games: 1000,
    });
  });

  test('support quest upgrade: most successful one, with its reasons', () => {
    const quest = [c('quest_item', '3869', 600, 330), c('quest_item', '3876', 350, 160)];
    const b = recommendBuild(req(LEONA), data({ choices: [...data().choices, ...quest] }));
    expect(b?.items.questUpgrade?.itemId).toBe(3869);
    expect(b?.items.questUpgrade?.reasons).toEqual([
      {
        kind: 'base',
        label:
          'Most successful quest upgrade (Celestial Opposition): 55.0% win rate, picked in 60.0% of games (600 games)',
        delta: expect.any(Number),
        games: 600,
      },
    ]);
    expect(b?.items.questUpgrade?.reasons[0]?.delta).toBeGreaterThan(0);
    // Not in the other item lists.
    const listed = [...(b?.items.starting ?? []), ...(b?.items.core ?? [])].map((i) => i.itemId);
    expect(listed).not.toContain(3869);
  });

  test('support quest upgrade adapts to the lane opponent', () => {
    const m = (choice: string, games: number, wins: number): ChoiceMatchupRow => ({
      opponentId: 412,
      opponentPosition: 'UTILITY',
      kind: 'quest_item',
      choice,
      games,
      wins,
    });
    const quest = [c('quest_item', '3869', 600, 330), c('quest_item', '3876', 350, 160)];
    const b = recommendBuild(
      req({ ...LEONA, enemies: [{ championId: 412, role: 'UTILITY' }] }),
      data({
        choices: [...data().choices, ...quest],
        vs: [vs(CUR, 89, 412, 'UTILITY', 300, 150)],
        choiceMatchups: [m('3869', 200, 80), m('3876', 100, 70)],
      }),
    );
    expect(b?.items.questUpgrade?.itemId).toBe(3876);
    const reason = b?.items.questUpgrade?.reasons[0];
    expect(reason).toMatchObject({ kind: 'matchup', games: 100, championIds: [412] });
    expect(reason?.label).toMatch(/^\+\d+\.\d% vs Thresh with Solstice Sleigh \(100 games\)$/);
  });

  test("no quest upgrade when few of the role's games had one", () => {
    expect(recommendBuild(req(LEONA), data())?.items.questUpgrade).toBeUndefined();
    const stray = [c('quest_item', '3869', 20, 15)];
    const b = recommendBuild(req(LEONA), data({ choices: [...data().choices, ...stray] }));
    expect(b?.items.questUpgrade).toBeUndefined();
  });

  test('returns null without data', () => {
    expect(
      recommendBuild(req(LEONA), data({ baseline: { games: 0, wins: 0 }, choices: [] })),
    ).toBeNull();
  });

  test('lane phase vs the lane opponent at 10 and 15 min', () => {
    const lanePhase = [
      lane(
        CUR,
        89,
        412,
        'UTILITY',
        380,
        { gold: 400, xp: 200, cs: 2 },
        {
          games: 380,
          gold: 800,
          xp: 400,
          cs: 4,
        },
      ),
      lane(CUR, 89, 222, 'BOTTOM', 380, { gold: -900, xp: 0, cs: 0 }), // not the primary opponent
    ];
    const b = recommendBuild(
      req({
        ...LEONA,
        enemies: [
          { championId: 222, role: 'BOTTOM' },
          { championId: 412, role: 'UTILITY' },
        ],
      }),
      data({ lanePhase }),
    );
    expect(b?.lanePhase).toEqual([
      {
        kind: 'lane_phase',
        label: 'Lane at 10 min vs Thresh: +380 gold, +1.9 CS, +190 XP (bot lane 2v2, 380 matchups)',
        delta: 0,
        games: 380,
        championIds: [412],
        lane: { minute: 10, gold: 380, xp: 190, cs: 1.9, duo: true, games: 380 },
      },
      {
        kind: 'lane_phase',
        label: 'Lane at 15 min vs Thresh: +760 gold, +3.8 CS, +380 XP (bot lane 2v2, 380 matchups)',
        delta: 0,
        games: 380,
        championIds: [412],
        lane: { minute: 15, gold: 760, xp: 380, cs: 3.8, duo: true, games: 380 },
      },
    ]);
    // Guessed role: said so. No lane opponent, or no rows: no field.
    const guessed = recommendBuild(
      req({ ...LEONA, enemies: [{ championId: 412, role: null }] }),
      data({ lanePhase }),
    );
    expect(guessed?.lanePhase?.[0]?.label).toContain(
      '(bot lane 2v2, likely support, 380 matchups)',
    );
    expect(recommendBuild(req(LEONA), data({ lanePhase }))).not.toHaveProperty('lanePhase');
    expect(
      recommendBuild(req({ ...LEONA, enemies: [{ championId: 412, role: 'UTILITY' }] }), data()),
    ).not.toHaveProperty('lanePhase');
  });
});
