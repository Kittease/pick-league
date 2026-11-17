import { describe, expect, test } from 'bun:test';
import { buildRequestSchema } from '@pick-league/shared';
import { type BuildData, recommendBuild } from './build.ts';
import { items, lane, names, role, thresholds, traitsOf, vs, withAlly } from './fixtures.ts';
import type {
  ChoiceDuoRow,
  ChoiceKind,
  ChoiceMatchupRow,
  ChoiceRow,
  ChoiceTraitRow,
} from './types.ts';

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
    choiceDuos: [],
    choiceAllyTraits: [],
    compTraits: [],
    vs: [],
    with: [],
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

  test('rune page built slot by slot: a rare lucky variant does not win', () => {
    // Same page with another first shard: 20 wins in 25 games.
    const lucky = '8400|8300|8439,8401,8473,8242,8345,8347|5008,5010,5011';
    const b = recommendBuild(
      req(LEONA),
      data({
        choices: [
          ...data().choices.filter((r) => r.kind !== 'rune_page'),
          c('rune_page', PAGE_AFTERSHOCK, 700, 350),
          c('rune_page', lucky, 25, 20),
          c('rune_page', PAGE_GLACIAL, 300, 150),
        ],
      }),
    );
    expect(b?.runes).toMatchObject({
      primaryTreeId: 8400,
      secondaryTreeId: 8300,
      runeIds: [8439, 8401, 8473, 8242, 8345, 8347],
      statShardIds: [5007, 5010, 5011],
      // Stats of the keystone (every Aftershock page).
      games: 725,
    });
    expect(b?.runes.reasons.map((r) => r.kind)).toEqual(['base', 'popularity']);
  });

  test('core build 1 is the best ranked 3-item path, never one with too few matches', () => {
    const b = recommendBuild(
      req(LEONA),
      data({
        choices: [
          ...data().choices.filter((r) => r.kind !== 'core3'),
          c('core3', '3190,3050,3065', 13, 12), // 92 % on 13 matches: below altCores.minGames
          c('core3', '3190,3050,3109', 300, 165),
          c('core3', '3075,3050,3065', 400, 216),
        ],
      }),
    );
    const first = b?.items.coreBuilds[0];
    expect(first?.games).toBeGreaterThanOrEqual(300);
    const nonBoots = b?.items.core.map((i) => i.itemId).filter((id) => id !== 3047);
    expect(nonBoots?.slice(0, 3)).not.toEqual([3190, 3050, 3065]);
    expect(b?.items.core.map((i) => i.itemId)).toEqual(first?.items.map((i) => i.itemId) ?? []);
  });

  test('without a path with enough matches, the first three items are picked one at a time', () => {
    const b = recommendBuild(
      req(LEONA),
      data({
        choices: [
          ...data().choices.filter((r) => r.kind !== 'core3'),
          c('core3', '3190,3050,3065', 3, 2),
          c('core3', '3190,3050,3109', 15, 9),
          c('core3', '3075,3050,3065', 10, 5),
        ],
      }),
    );
    expect(b?.items.coreBuilds).toHaveLength(1);
    const nonBoots = b?.items.core.map((i) => i.itemId).filter((id) => id !== 3047);
    expect(nonBoots?.slice(0, 3)).toEqual([3190, 3050, 3109]);
  });

  describe('core builds', () => {
    const withPaths = (...paths: ChoiceRow[]) =>
      data({ choices: [...data().choices.filter((r) => r.kind !== 'core3'), ...paths] });
    const paths = [
      c('core3', '3190,3050,3109', 400, 220),
      c('core3', '3050,3190,3109', 300, 150), // permutation of build 1
      c('core3', '3190,3050,3075', 100, 55), // same first item, one item differs
      c('core3', '3075,3050,3065', 200, 112),
      c('core3', '3050,3109,3065', 150, 84),
      c('core3', '3109,3190,3050', 60, 33), // permutation of build 1
      c('core3', '3065,3075,3011', 15, 8), // too few matches
    ];
    const firstThree = (items: { itemId: number }[]) =>
      items
        .map((i) => i.itemId)
        .filter((id) => id !== 3047)
        .slice(0, 3);

    test('alternatives: other item sets with enough matches, best first, each filled with boots', () => {
      const b = recommendBuild(req(LEONA), withPaths(...paths));
      const builds = b?.items.coreBuilds ?? [];
      expect(builds.map((x) => firstThree(x.items))).toEqual([
        [3190, 3050, 3109],
        [3075, 3050, 3065],
        [3050, 3109, 3065],
      ]);
      expect(b?.items.core.map((i) => i.itemId)).toEqual(
        builds[0]?.items.map((i) => i.itemId) ?? [],
      );
      // Build 1's record: on the build, and on the first core item for one-build clients.
      expect(builds[0]?.items[0]?.reasons.some((r) => r.kind === 'base')).toBe(false);
      expect(b?.items.core[0]?.reasons[0]?.label).toMatch(/^Most successful first three items: /);
      for (const build of builds) {
        expect(build.items).toHaveLength(5);
        expect(build.items.map((i) => i.itemId)).toContain(3047);
        expect(build.reasons.length).toBeGreaterThan(0);
      }
      expect(builds[1]?.items.map((i) => i.itemId)).toEqual([3075, 3047, 3050, 3065, 3109]);
      expect(builds[1]).toMatchObject({ games: 200, winRate: 0.56 });
      expect(builds[1]?.share).toBeCloseTo(200 / 1225, 4);
      expect(builds[0]?.reasons[0]?.label).toMatch(
        /^Most successful first three items: 55\.0% win rate, taken in 32\.7% of matches with three completed items \(400 matches\)$/,
      );
      expect(builds[1]?.reasons[0]).toMatchObject({ kind: 'base', games: 200 });
      expect(builds[1]?.reasons[0]?.label).toMatch(
        /^Starts with Thornmail instead of Locket of the Iron Solari: 56\.0% win rate/,
      );
      expect(builds[1]?.reasons[1]).toMatchObject({ kind: 'popularity', games: 200 });
      expect(builds[1]?.reasons[1]?.label).toBe(
        'vs core build 1: 56.0% vs 55.0% win rate, 2.0× less popular (200 matches vs 400 matches)',
      );
    });

    test('the same first item counts as different with at least two other items', () => {
      const b = recommendBuild(
        req(LEONA),
        withPaths(paths[0] as ChoiceRow, c('core3', '3190,3075,3065', 200, 112)),
      );
      const second = b?.items.coreBuilds[1];
      expect(second && firstThree(second.items)).toEqual([3190, 3075, 3065]);
      expect(second?.reasons[0]?.label).toMatch(
        /^Thornmail \+ Spirit Visage instead of Zeke's Convergence \+ Knight's Vow: /,
      );
    });

    test('no alternative when the data does not support one', () => {
      // Only a permutation of build 1.
      expect(recommendBuild(req(LEONA), data())?.items.coreBuilds).toHaveLength(1);
      // A path doing clearly worse than the other 3-item paths.
      const worse = recommendBuild(
        req(LEONA),
        withPaths(paths[0] as ChoiceRow, c('core3', '3075,3050,3065', 300, 120)),
      );
      expect(worse?.items.coreBuilds).toHaveLength(1);
    });

    test('a build whose items do notably better vs the lane opponent says so', () => {
      const b = recommendBuild(req({ ...LEONA, enemies: [{ championId: 412, role: 'UTILITY' }] }), {
        ...withPaths(...paths),
        vs: [vs(CUR, 89, 412, 'UTILITY', 300, 150)],
        // Thornmail: 75 % vs Thresh when built.
        choiceMatchups: [
          {
            opponentId: 412,
            opponentPosition: 'UTILITY',
            kind: 'item',
            choice: '3075',
            games: 60,
            wins: 45,
          },
        ],
      });
      const [first, second] = b?.items.coreBuilds ?? [];
      expect(first?.reasons.some((r) => r.kind === 'matchup')).toBe(false);
      expect(second?.reasons[0]).toMatchObject({
        kind: 'matchup',
        itemId: 3075,
        championIds: [412],
        games: 60,
      });
      expect(second?.reasons[0]?.label).toMatch(
        /^\+\d+\.\d% vs Thresh when Thornmail is built \(60 matches\)$/,
      );
    });
  });

  describe('items compared with players at the same point of their build', () => {
    const done = (choice: string, games: number, wins: number) =>
      c('items_done', choice, games, wins);
    // Leona: players with 4+ items win 65 %; Chemtech Putrifier is a 4th item (50 % overall).
    const choices = [
      ...data().choices.filter((r) => r.kind !== 'item' || r.choice !== '3011'),
      c('item', '3011', 60, 30, 4),
      done('1', 200, 70),
      done('2', 300, 140),
      done('3', 300, 160),
      done('4', 150, 95),
      done('5', 50, 35),
    ];
    const t = (kind: ChoiceKind, choice: string, games: number, wins: number): ChoiceTraitRow => ({
      trait: 'HIGH_HEALING',
      kind,
      choice,
      games,
      wins,
    });
    const healing = (ctxDone: ChoiceTraitRow[]) =>
      recommendBuild(
        req({
          ...LEONA,
          enemies: [
            { championId: 16, role: 'UTILITY' },
            { championId: 19, role: 'JUNGLE' },
          ],
        }),
        data({
          choices,
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
          // 75 % when built vs heal-heavy teams.
          choiceTraits: [t('item', '3011', 60, 45), ...ctxDone],
        }),
      );

    test('no swap when the item only wins as much as players that far into their build', () => {
      // Vs heal-heavy teams, players with 4+ items win 77.5 %.
      const b = healing([t('items_done', '1', 220, 88), t('items_done', '4', 80, 62)]);
      expect(b?.items.situational.map((s) => s.itemId)).not.toContain(3011);
    });

    test('a swap when it beats them', () => {
      // Vs heal-heavy teams, players with 4+ items win 62.5 %.
      const b = healing([t('items_done', '1', 140, 50), t('items_done', '4', 160, 100)]);
      const swap = b?.items.situational.find((s) => s.itemId === 3011);
      expect(swap?.reasons[0]).toMatchObject({ kind: 'item_swap', games: 60 });
    });

    test('item reasons say how the item does vs that stage', () => {
      const b = recommendBuild(req(LEONA), data({ choices }));
      const item = b?.items.core.find((i) => i.itemId === 3109);
      expect(item?.reasons.at(-1)?.label).toMatch(
        /^Built in 80\.0% of games, [+−]?\d+\.\d% vs players at the same point of their build \(800 games\)$/,
      );
    });
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

  describe('situational items from the own team', () => {
    /** Jinx (bot duo partner) + Lee Sin: an AP-heavy pair (and neither ranged- nor melee-heavy). */
    const allies = [
      { championId: 222, role: 'BOTTOM' },
      { championId: 64, role: 'JUNGLE' },
    ];
    const apAlly = { physicalShare: 0.3, magicShare: 0.7 };
    /** Soraka + Warwick: a heal-heavy enemy pair. */
    const enemies = [
      { championId: 16, role: 'UTILITY' },
      { championId: 19, role: 'JUNGLE' },
    ];
    const championTraits = [
      traitsOf(CUR, 89),
      traitsOf(CUR, 222, apAlly),
      traitsOf(CUR, 64, { ...apAlly, isRanged: false }),
      traitsOf(CUR, 16, { healingPerMin: 120 }),
      traitsOf(CUR, 19, { healingPerMin: 60, isRanged: false }),
    ];
    const compTrait = (side: 'enemy' | 'ally', trait: ChoiceTraitRow['trait']) => ({
      patch: CUR,
      position: 'UTILITY' as const,
      championId: 89,
      side,
      trait,
      games: 300,
      wins: 150,
    });
    /** Leona with Jinx: 300 games, 50 %. */
    const withJinx = [withAlly(CUR, 89, 222, 'BOTTOM', 300, 150)];
    const duo = (item: number, games: number, wins: number): ChoiceDuoRow => ({
      partnerId: 222,
      partnerPosition: 'BOTTOM',
      kind: 'item',
      choice: String(item),
      games,
      wins,
    });
    const trait = (
      t: ChoiceTraitRow['trait'],
      item: number,
      games: number,
      wins: number,
    ): ChoiceTraitRow => ({ trait: t, kind: 'item', choice: String(item), games, wins });

    test('an item that works with the duo partner, with a duo reason', () => {
      const b = recommendBuild(
        req({ ...LEONA, allies }),
        data({ championTraits, with: withJinx, choiceDuos: [duo(9007, 100, 70)] }),
      );
      expect(b?.items.situational.map((s) => s.itemId)).toEqual([9007]);
      const reason = b?.items.situational[0]?.reasons[0];
      expect(reason).toMatchObject({ kind: 'duo', championIds: [222], games: 100, itemId: 9007 });
      expect(reason?.delta).toBeGreaterThan(0);
      expect(reason?.label).toMatch(/^\+\d+\.\d% with Jinx when built \(100 games\)$/);
    });

    test('a guessed duo partner (role unknown) counts too', () => {
      const b = recommendBuild(
        req({ ...LEONA, allies: [{ championId: 222, role: null }] }),
        data({ with: withJinx, choiceDuos: [duo(9007, 100, 70)] }),
      );
      expect(b?.items.situational[0]?.reasons[0]).toMatchObject({
        kind: 'duo',
        championIds: [222],
      });
    });

    test('an item that works with an ally composition trait, with a with_comp reason', () => {
      const b = recommendBuild(
        req({ ...LEONA, allies }),
        data({
          championTraits,
          compTraits: [compTrait('ally', 'AP_HEAVY')],
          choiceAllyTraits: [trait('AP_HEAVY', 9008, 100, 70), trait('MELEE_HEAVY', 9009, 100, 90)],
        }),
      );
      // MELEE_HEAVY is not a trait of these allies: its rows are ignored.
      expect(b?.items.situational.map((s) => s.itemId)).toEqual([9008]);
      const swap = b?.items.situational[0];
      expect(swap?.replacesItemId).not.toBeNull();
      expect(swap?.reasons[0]).toMatchObject({ kind: 'with_comp', trait: 'AP_HEAVY', games: 100 });
      expect(swap?.reasons[0]?.label).toMatch(
        /^\+\d+\.\d% with AP-heavy allies when built instead of .+ \(100 games\)$/,
      );
    });

    test('ally and enemy contexts are ranked together by delta', () => {
      const run = (duoWins: number, enemyWins: number) =>
        recommendBuild(
          req({ ...LEONA, allies, enemies }),
          data({
            championTraits,
            compTraits: [compTrait('enemy', 'HIGH_HEALING')],
            choiceTraits: [trait('HIGH_HEALING', 9001, 100, enemyWins)],
            with: withJinx,
            choiceDuos: [duo(9007, 100, duoWins)],
          }),
        )?.items.situational.map((s) => [s.itemId, s.reasons[0]?.kind]);
      expect(run(75, 65)).toEqual([
        [9007, 'duo'],
        [9001, 'item_swap'],
      ]);
      expect(run(65, 75)).toEqual([
        [9001, 'item_swap'],
        [9007, 'duo'],
      ]);
    });

    test('an item answering an enemy and an ally context goes to the one it helps most', () => {
      const b = recommendBuild(
        req({ ...LEONA, allies, enemies }),
        data({
          championTraits,
          compTraits: [compTrait('enemy', 'HIGH_HEALING')],
          choiceTraits: [trait('HIGH_HEALING', 9001, 100, 65)],
          with: withJinx,
          choiceDuos: [duo(9001, 100, 75)],
        }),
      );
      const listed = b?.items.situational.filter((s) => s.itemId === 9001) ?? [];
      expect(listed).toHaveLength(1);
      expect(listed[0]?.reasons[0]).toMatchObject({ kind: 'duo', championIds: [222] });
    });

    test('no ally swap without enough games or gain, and no tag rule for allies', () => {
      const run = (rows: ChoiceDuoRow[], extra: Partial<BuildData> = {}) =>
        recommendBuild(
          req({ ...LEONA, allies }),
          data({
            championTraits,
            compTraits: [compTrait('ally', 'AP_HEAVY')],
            with: withJinx,
            choiceDuos: rows,
            ...extra,
          }),
        )?.items.situational;
      // Under minContextGames (15), however good.
      expect(run([duo(9007, 14, 14)])).toEqual([]);
      // Gain under swapMinGain (0.01): 51 % with Jinx vs 49.5 % without, shrunk.
      expect(run([duo(9007, 100, 51)])).toEqual([]);
      // Good with Jinx, but no better than overall (+13 points either way).
      const strong = [...data().choices, c('item', '9008', 200, 130, 4.5)];
      expect(run([duo(9008, 100, 66)], { choices: strong })).toEqual([]);
    });

    test('a core item that does notably better with the duo partner says so', () => {
      // Knight's Vow (core) with Jinx: 67 % vs 33 % without her.
      const b = recommendBuild(
        req({ ...LEONA, allies }),
        data({ championTraits, with: withJinx, choiceDuos: [duo(3109, 150, 100)] }),
      );
      expect(b?.items.situational).toEqual([]);
      const knightsVow = b?.items.core.find((i) => i.itemId === 3109);
      expect(knightsVow?.reasons[0]).toMatchObject({
        kind: 'duo',
        championIds: [222],
        games: 150,
        itemId: 3109,
      });
      expect(knightsVow?.reasons[0]?.label).toMatch(/^\+\d+\.\d% with Jinx when built/);
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

  test('support quest upgrade: the most played one (no measurable difference), with its reasons', () => {
    // The less played upgrade wins more, but upgrades show no real difference: popularity decides.
    const quest = [c('quest_item', '3869', 600, 300), c('quest_item', '3876', 350, 200)];
    const b = recommendBuild(req(LEONA), data({ choices: [...data().choices, ...quest] }));
    expect(b?.items.questUpgrade?.itemId).toBe(3869);
    expect(b?.items.questUpgrade?.reasons).toEqual([
      {
        kind: 'base',
        label:
          'Most played quest upgrade (Celestial Opposition): 50.0% win rate, picked in 63.2% of games (600 games)',
        delta: 0,
        games: 600,
      },
    ]);
    // Not in the other item lists.
    const listed = [...(b?.items.starting ?? []), ...(b?.items.core ?? [])].map((i) => i.itemId);
    expect(listed).not.toContain(3869);
  });

  test('support quest upgrade does not switch with the lane opponent', () => {
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
    expect(b?.items.questUpgrade?.itemId).toBe(3869);
    expect(b?.items.questUpgrade?.reasons.map((r) => r.kind)).toEqual(['base']);
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
