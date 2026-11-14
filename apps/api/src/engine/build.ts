/**
 * Build recommendations, layered:
 * 1. base = best choice for champion+role (shrunk win-rate delta + popularity bonus),
 * 2. adjusted for the lane opponent (choices vs that opponent),
 * 3. adjusted for enemy composition traits (data-backed deltas, else Data Dragon tag rules).
 * Every piece carries reasons with the win-rate delta and sample size.
 */
import type {
  BuildRequest,
  BuildResponse,
  CompTrait,
  ItemsRecommendation,
  PatchId,
  Reason,
  RecommendedItem,
  RunesRecommendation,
  SkillOrderRecommendation,
  SummonerSpellsRecommendation,
} from '@pick-league/shared';
import {
  ENGINE_CONFIG,
  LANE_ROLES,
  ROLE_LABELS,
  TAG_RULES,
  type TagRule,
  TRAIT_LABELS,
} from './config.ts';
import { lanePhaseDiff, lanePhaseReason, lanePhaseRowsOf } from './lane-phase.ts';
import {
  formatDelta,
  formatGames,
  formatRate,
  type PatchChoice,
  patchesLabel,
  round,
  sampleConfidence,
  shrink,
  winRate,
} from './math.ts';
import { sideTraits } from './picks.ts';
import { assignRoles, type RoleGuess, rolePlayRates } from './roles.ts';
import { parseIntList, skillMaxOrder, synthesiseSkillSequence } from './skills.ts';
import type {
  ChampionTraitRow,
  ChoiceKind,
  ChoiceMatchupRow,
  ChoiceRow,
  ChoiceTraitRow,
  CompThresholdRow,
  CompTraitRow,
  GamesWins,
  ItemInfo,
  LanePhaseRow,
  NameLookup,
  RoleStatRow,
  VsRow,
} from './types.ts';

export interface BuildData {
  currentPatch: PatchId;
  previousPatch: PatchId | null;
  /** Patches whose stats are used (see `choosePatches`). */
  patch: PatchChoice;
  /** Champion + role on `patch.patches`. */
  baseline: GamesWins;
  /** stats_champion_roles of both patches (to guess enemy roles). */
  roleStats: readonly RoleStatRow[];
  /** stats_choices of champion + role on the patches used (summed). */
  choices: readonly ChoiceRow[];
  /** stats_choice_matchups of champion + role on the patches used (summed), vs the request's enemies. */
  choiceMatchups: readonly ChoiceMatchupRow[];
  /** stats_choice_traits of champion + role on the patches used (summed). */
  choiceTraits: readonly ChoiceTraitRow[];
  /** stats_champion_comp_traits (side enemy) of champion + role on the patches used (summed). */
  compTraits: readonly CompTraitRow[];
  /** stats_champion_vs of champion + role on the patches used (summed), vs the request's enemies. */
  vs: readonly VsRow[];
  /** stats_champion_traits of the champion, its allies and enemies (both patches). */
  championTraits: readonly ChampionTraitRow[];
  thresholds: readonly CompThresholdRow[];
  items: ReadonlyMap<number, ItemInfo>;
  /**
   * stats_champion_lane_phase of champion + role vs the request's lane opponents, per patch
   * (optional: no `lanePhase` without it).
   */
  lanePhase?: readonly LanePhaseRow[];
  names: NameLookup;
}

const B = ENGINE_CONFIG.build;

/**
 * Tie-break of every ranking below: the stats rows come in no particular order, so equal scores
 * must not depend on it (lowest choice key / item id first).
 */
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Scored {
  row: ChoiceRow;
  delta: number;
  share: number;
}

/** Best choice of a kind: max(shrunk delta vs baseline + popularity bonus) among choices with enough games. */
export function bestChoice(
  rows: readonly ChoiceRow[],
  baseline: GamesWins,
  filter: (r: ChoiceRow) => boolean = () => true,
): Scored | null {
  const candidates = rows.filter(filter);
  if (candidates.length === 0) return null;
  const total = baseline.games > 0 ? baseline.games : candidates.reduce((s, r) => s + r.games, 0);
  const baseWr = winRate(baseline);
  const scored = candidates.map((row) => ({
    row,
    delta: shrink(winRate(row) - baseWr, row.games, B.shrinkK),
    share: total > 0 ? row.games / total : 0,
  }));
  const eligible = scored.filter((s) => s.row.games >= B.minChoiceGames);
  if (eligible.length === 0) {
    return (
      scored.sort((a, b) => b.row.games - a.row.games || byKey(a.row.choice, b.row.choice))[0] ??
      null
    );
  }
  return (
    eligible.sort(
      (a, b) =>
        b.delta + B.popularityWeight * b.share - (a.delta + B.popularityWeight * a.share) ||
        b.row.games - a.row.games ||
        byKey(a.row.choice, b.row.choice),
    )[0] ?? null
  );
}

/** A context: lane opponent or enemy trait, with the champion's overall record in it. */
interface Context {
  kind: 'matchup' | 'vs_comp';
  /** "vs Thresh" / "vs heal-heavy teams" */
  label: string;
  /** Extra detail shown next to the sample size, e.g. "likely support". */
  note?: string;
  total: GamesWins;
  rows: readonly (GamesWins & { kind: ChoiceKind; choice: string })[];
  championIds?: number[];
  trait?: CompTrait;
}

interface ContextResult {
  choice: string;
  delta: number;
  games: number;
  baseDelta: number;
  baseGames: number;
  switched: boolean;
  context: Context;
}

/** Delta of `choice` within a context vs the champion's record in that context. */
function contextDelta(
  ctx: Context,
  kind: ChoiceKind,
  choice: string,
): { delta: number; games: number } {
  const row = ctx.rows.find((r) => r.kind === kind && r.choice === choice);
  if (!row || ctx.total.games === 0) return { delta: 0, games: 0 };
  return {
    delta: shrink(winRate(row) - winRate(ctx.total), row.games, B.shrinkK),
    games: row.games,
  };
}

/** Best alternative of `kind` in the context; `switched` when it beats the base by `switchMinGain`. */
function adjustInContext(
  ctx: Context,
  kind: ChoiceKind,
  baseChoice: string,
  allowed: (choice: string) => boolean = () => true,
): ContextResult {
  const base = contextDelta(ctx, kind, baseChoice);
  let best: { choice: string; delta: number; games: number } | null = null;
  for (const r of ctx.rows) {
    if (r.kind !== kind || r.games < B.minContextGames || !allowed(r.choice)) continue;
    const d = contextDelta(ctx, kind, r.choice);
    if (
      !best ||
      d.delta > best.delta ||
      (d.delta === best.delta && byKey(r.choice, best.choice) < 0)
    )
      best = { choice: r.choice, ...d };
  }
  const switched =
    best !== null && best.choice !== baseChoice && best.delta - base.delta >= B.switchMinGain;
  const pick = switched && best ? best : { choice: baseChoice, ...base };
  return {
    choice: pick.choice,
    delta: pick.delta,
    games: pick.games,
    baseDelta: base.delta,
    baseGames: base.games,
    switched,
    context: ctx,
  };
}

/** Among several contexts, the switch with the largest gain over the base choice (if any). */
function bestSwitch(
  contexts: readonly Context[],
  kind: ChoiceKind,
  baseChoice: string,
): { choice: string; results: ContextResult[]; winner: ContextResult | null } {
  const results = contexts.map((ctx) => adjustInContext(ctx, kind, baseChoice));
  let winner: ContextResult | null = null;
  for (const r of results) {
    if (r.switched && (!winner || r.delta - r.baseDelta > winner.delta - winner.baseDelta))
      winner = r;
  }
  return { choice: winner?.choice ?? baseChoice, results, winner };
}

function contextReason(res: ContextResult, what: string): Reason | null {
  if (res.games === 0) return null;
  const c = res.context;
  return {
    kind: c.kind,
    label: `${formatDelta(res.delta)} ${c.label} with ${what} (${c.note ? `${c.note}, ` : ''}${formatGames(res.games)})`,
    delta: round(res.delta),
    games: res.games,
    ...(c.championIds ? { championIds: c.championIds } : {}),
    ...(c.trait ? { trait: c.trait } : {}),
  };
}

function baseReason(s: Scored | null, what: string): Reason[] {
  if (!s) return [];
  return [
    {
      kind: 'base',
      label: `${what}: ${formatRate(winRate(s.row))} win rate, picked in ${formatRate(s.share)} of games (${formatGames(s.row.games)})`,
      delta: round(s.delta),
      games: s.row.games,
    },
  ];
}

export function recommendBuild(req: BuildRequest, data: BuildData): BuildResponse | null {
  if (data.baseline.games === 0 || data.choices.length === 0) return null;
  const role = req.role;
  const names = data.names;
  const baseline = data.baseline;
  const baseWr = winRate(baseline);
  const byKind = (kind: ChoiceKind) => data.choices.filter((c) => c.kind === kind);
  const fallback: Reason[] = data.patch.merged
    ? [
        {
          kind: 'patch_fallback',
          label: `${patchesLabel(data.patch.patches)} data: only ${formatGames(data.patch.currentGames)} on ${data.currentPatch}`,
          delta: 0,
          games: baseline.games,
        },
      ]
    : [];

  // Lane opponents and enemy traits.
  const playRates = rolePlayRates(data.roleStats);
  const enemies = assignRoles(req.enemies, playRates);
  const laneRoles = LANE_ROLES[role];
  const laneOpponents = enemies
    .filter((e) => laneRoles.includes(e.role))
    .sort((a, b) => laneRoles.indexOf(a.role) - laneRoles.indexOf(b.role));
  const matchupContexts = laneOpponents.map((o) => matchupContext(o, data, names));
  const primaryMatchup = matchupContexts[0];
  const enemyTraits = sideTraits(
    req.enemies.map((e) => e.championId),
    data,
  );
  const traitContexts = enemyTraits.map((t) => traitContext(t, data));

  const selfTraits =
    data.championTraits.find(
      (t) => t.championId === req.championId && t.patch === data.currentPatch,
    ) ?? data.championTraits.find((t) => t.championId === req.championId);
  const damage: 'physical' | 'magic' =
    (selfTraits?.physicalShare ?? 0.5) >= (selfTraits?.magicShare ?? 0.5) ? 'physical' : 'magic';

  const runes = recommendRunes(byKind, baseline, primaryMatchup, names, fallback);
  const summonerSpells = recommendSpells(
    byKind,
    baseline,
    matchupContexts,
    traitContexts,
    names,
    fallback,
  );
  const skillOrder = recommendSkills(byKind, baseline, primaryMatchup, fallback);
  const items = recommendItems({
    byKind,
    baseline,
    baseWr,
    primaryMatchup,
    traitContexts,
    enemyTraits,
    data,
    damage,
    fallback,
  });

  const lanePhase = recommendLanePhase(req, data, laneOpponents[0]);

  return {
    championId: req.championId,
    role,
    patchesUsed: data.patch.patches,
    games: baseline.games,
    confidence: round(sampleConfidence(baseline.games, B.confidenceK), 3),
    items,
    runes,
    summonerSpells,
    skillOrder,
    ...(lanePhase.length > 0 ? { lanePhase } : {}),
  };
}

/** Lane phase vs the primary lane opponent (the one the build adapts to): 10 then 15 min. */
function recommendLanePhase(
  req: BuildRequest,
  data: BuildData,
  opponent: RoleGuess | undefined,
): Reason[] {
  if (!opponent || !data.lanePhase) return [];
  const rows = lanePhaseRowsOf(data.lanePhase, req.championId, opponent.championId, opponent.role);
  const note = opponent.known ? undefined : `likely ${ROLE_LABELS[opponent.role]}`;
  return ([10, 15] as const).flatMap((minute) => {
    const diff = lanePhaseDiff(rows, data.patch.patches, minute);
    return diff
      ? [
          lanePhaseReason(
            diff,
            req.role,
            opponent.championId,
            data.names.champion(opponent.championId),
            note,
          ),
        ]
      : [];
  });
}

function matchupContext(o: RoleGuess, data: BuildData, names: NameLookup): Context {
  const total =
    data.vs.find((v) => v.enemyId === o.championId && v.enemyPosition === o.role) ??
    ({ games: 0, wins: 0 } as GamesWins);
  return {
    kind: 'matchup',
    label: `vs ${names.champion(o.championId)}`,
    ...(o.known ? {} : { note: `likely ${ROLE_LABELS[o.role]}` }),
    total,
    rows: data.choiceMatchups.filter(
      (r) => r.opponentId === o.championId && r.opponentPosition === o.role,
    ),
    championIds: [o.championId],
  };
}

function traitContext(trait: CompTrait, data: BuildData): Context {
  const total = data.compTraits.find((r) => r.side === 'enemy' && r.trait === trait) ?? {
    games: 0,
    wins: 0,
  };
  return {
    kind: 'vs_comp',
    label: `vs ${TRAIT_LABELS[trait]} teams`,
    total,
    rows: data.choiceTraits.filter((r) => r.trait === trait),
    trait,
  };
}

// ---------------------------------------------------------------------------
// Runes
// ---------------------------------------------------------------------------

interface ParsedPage {
  primaryTreeId: number;
  secondaryTreeId: number;
  runeIds: number[];
  statShardIds: number[];
}

export function parseRunePage(key: string): ParsedPage | null {
  const [p, s, runes, shards] = key.split('|');
  if (!p || !s || runes === undefined || shards === undefined) return null;
  return {
    primaryTreeId: Number(p),
    secondaryTreeId: Number(s),
    runeIds: parseIntList(runes),
    statShardIds: parseIntList(shards),
  };
}

function recommendRunes(
  byKind: (k: ChoiceKind) => ChoiceRow[],
  baseline: GamesWins,
  matchup: Context | undefined,
  names: NameLookup,
  fallback: Reason[],
): RunesRecommendation {
  const pages = byKind('rune_page');
  let chosen = bestChoice(pages, baseline);
  const keystoneOf = (r: ChoiceRow) => parseRunePage(r.choice)?.runeIds[0];
  const reasons: Reason[] = [
    ...fallback,
    ...baseReason(
      chosen,
      `Most successful page (${names.rune(keystoneOf(chosen?.row ?? (pages[0] as ChoiceRow)) ?? 0)})`,
    ),
  ];
  if (chosen && matchup) {
    const baseKeystone = String(keystoneOf(chosen.row) ?? '');
    const res = adjustInContext(matchup, 'keystone', baseKeystone);
    if (res.switched) {
      const alt = bestChoice(pages, baseline, (r) => String(keystoneOf(r)) === res.choice);
      if (alt) chosen = alt;
    }
    const reason = contextReason(res, names.rune(Number(res.choice)));
    if (reason) reasons.unshift(reason);
  }
  const page = chosen ? parseRunePage(chosen.row.choice) : null;
  const runeIds = page?.runeIds ?? [];
  const statShardIds = page?.statShardIds ?? [];
  return {
    primaryTreeId: page?.primaryTreeId ?? 0,
    secondaryTreeId: page?.secondaryTreeId ?? 0,
    runeIds,
    statShardIds,
    selectedPerkIds: [...runeIds, ...statShardIds],
    games: chosen?.row.games ?? 0,
    winRate: round(winRate(chosen?.row)),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Summoner spells
// ---------------------------------------------------------------------------

const FLASH = 4;

function recommendSpells(
  byKind: (k: ChoiceKind) => ChoiceRow[],
  baseline: GamesWins,
  matchups: readonly Context[],
  traits: readonly Context[],
  names: NameLookup,
  fallback: Reason[],
): SummonerSpellsRecommendation {
  const rows = byKind('spells');
  const base = bestChoice(rows, baseline);
  const pairName = (key: string) =>
    parseIntList(key)
      .map((id) => names.summonerSpell(id))
      .join(' + ');
  const baseChoice = base?.row.choice ?? '';
  const reasons: Reason[] = [
    ...fallback,
    ...baseReason(base, `Most successful spells (${pairName(baseChoice)})`),
  ];
  let choice = baseChoice;
  if (choice) {
    const sw = bestSwitch([...matchups.slice(0, 1), ...traits], 'spells', choice);
    choice = sw.choice;
    const shown = sw.winner ? [sw.winner] : sw.results.filter((r) => r.context.kind === 'matchup');
    const extra = shown.flatMap((r) => {
      const reason = contextReason(r, pairName(r.choice));
      return reason ? [reason] : [];
    });
    reasons.unshift(...extra);
  }
  const ids = parseIntList(choice);
  const ordered = ids.includes(FLASH) ? [FLASH, ...ids.filter((i) => i !== FLASH)] : ids;
  const row = rows.find((r) => r.choice === choice);
  return {
    spellIds: [ordered[0] ?? 0, ordered[1] ?? 0],
    games: row?.games ?? 0,
    winRate: round(winRate(row)),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Skill order
// ---------------------------------------------------------------------------

const SKILL_KEYS = ['', 'Q', 'W', 'E', 'R'];
const skillName = (list: readonly number[], sep: string) =>
  list.map((s) => SKILL_KEYS[s] ?? '?').join(sep);

function recommendSkills(
  byKind: (k: ChoiceKind) => ChoiceRow[],
  baseline: GamesWins,
  matchup: Context | undefined,
  fallback: Reason[],
): SkillOrderRecommendation {
  const reasons: Reason[] = [...fallback];
  const first = bestChoice(byKind('skill_first3'), baseline);
  const max = bestChoice(byKind('skill_max'), baseline);
  let firstKey = first?.row.choice ?? '';
  let maxKey = max?.row.choice ?? '';
  reasons.push(...baseReason(max, `Max ${skillName(parseIntList(maxKey), ' > ')}`));
  reasons.push(...baseReason(first, `Start ${skillName(parseIntList(firstKey), '-')}`));
  if (matchup) {
    if (maxKey) {
      const res = adjustInContext(matchup, 'skill_max', maxKey);
      maxKey = res.choice;
      const r = contextReason(res, `max ${skillName(parseIntList(res.choice), ' > ')}`);
      if (r) reasons.unshift(r);
    }
    if (firstKey) {
      const res = adjustInContext(matchup, 'skill_first3', firstKey);
      if (res.switched) {
        firstKey = res.choice;
        const r = contextReason(res, `start ${skillName(parseIntList(res.choice), '-')}`);
        if (r) reasons.unshift(r);
      }
    }
  }
  const firstLevels = parseIntList(firstKey);
  const maxOrder = parseIntList(maxKey);
  const seqRow = byKind('skill_seq')
    .filter((r) => r.games >= B.minSkillSequenceGames)
    .filter((r) => {
      const seq = parseIntList(r.choice);
      return (
        firstLevels.every((s, i) => seq[i] === s) &&
        skillMaxOrder(seq)?.join(',') === maxOrder.join(',')
      );
    })
    .sort((a, b) => b.games - a.games || byKey(a.choice, b.choice))[0];
  const sequence =
    seqRow !== undefined
      ? parseIntList(seqRow.choice)
      : firstLevels.length === 3 && maxOrder.length === 3
        ? synthesiseSkillSequence(firstLevels, maxOrder)
        : [];
  const maxRow = byKind('skill_max').find((r) => r.choice === maxKey);
  return {
    firstLevels,
    maxOrder,
    sequence,
    games: maxRow?.games ?? 0,
    winRate: round(winRate(maxRow)),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

interface ItemsInput {
  byKind: (k: ChoiceKind) => ChoiceRow[];
  baseline: GamesWins;
  baseWr: number;
  primaryMatchup: Context | undefined;
  traitContexts: readonly Context[];
  enemyTraits: readonly CompTrait[];
  data: BuildData;
  damage: 'physical' | 'magic';
  fallback: Reason[];
}

/** Whether a (non-boots) item satisfies a tag rule (by explicit id or Data Dragon tag). */
function itemMatchesRule(id: number, info: ItemInfo | undefined, rule: TagRule): boolean {
  if (!info || info.isBoots) return false;
  return (
    (rule.itemIds?.includes(id) ?? false) ||
    (rule.tags?.some((t) => info.tags.includes(t)) ?? false)
  );
}

function recommendItems(input: ItemsInput): ItemsRecommendation {
  const { byKind, baseline, baseWr, primaryMatchup, traitContexts, data, damage, fallback } = input;
  const names = data.names;
  const itemRows = byKind('item');
  const itemRow = new Map(itemRows.map((r) => [Number(r.choice), r]));
  const isBoots = (id: number) => data.items.get(id)?.isBoots ?? false;

  // Overall delta of building an item vs not building it.
  const itemDelta = (id: number): number => {
    const r = itemRow.get(id);
    if (!r) return 0;
    const rest = { games: baseline.games - r.games, wins: baseline.wins - r.wins };
    return rest.games > 0 ? shrink(winRate(r) - winRate(rest), r.games, B.shrinkK) : 0;
  };
  const itemReason = (id: number): Reason[] => {
    const r = itemRow.get(id);
    if (!r) return [];
    const share = baseline.games > 0 ? r.games / baseline.games : 0;
    return [
      {
        kind: 'popularity',
        label: `Built in ${formatRate(share)} of games, ${formatRate(winRate(r))} win rate (${formatGames(r.games)})`,
        delta: round(shrink(winRate(r) - baseWr, r.games, B.shrinkK)),
        games: r.games,
        itemId: id,
      },
    ];
  };

  // Starting items.
  const starterBase = bestChoice(byKind('starter'), baseline);
  let starterKey = starterBase?.row.choice ?? '';
  const starterReasons: Reason[] = [...baseReason(starterBase, 'Most successful start')];
  if (primaryMatchup && starterKey) {
    const res = adjustInContext(primaryMatchup, 'starter', starterKey);
    starterKey = res.choice;
    const what = parseIntList(res.choice)
      .map((id) => names.item(id))
      .join(' + ');
    const r = contextReason(res, what);
    if (r) starterReasons.unshift(r);
  }
  const starting: RecommendedItem[] = parseIntList(starterKey).map((itemId) => ({
    itemId,
    reasons: starterReasons,
  }));

  // Core: best first-3 path, completed with the most built items.
  const core3 = bestChoice(byKind('core3'), baseline);
  const coreIds = core3 ? parseIntList(core3.row.choice) : [];
  const extra = itemRows
    .filter((r) => !coreIds.includes(Number(r.choice)) && !isBoots(Number(r.choice)))
    .filter((r) => (r.avgPos ?? 0) >= coreIds.length - 0.5)
    .sort((a, b) => b.games - a.games || Number(a.choice) - Number(b.choice));
  for (const r of extra) {
    if (coreIds.length >= B.coreSize) break;
    coreIds.push(Number(r.choice));
  }
  const core: RecommendedItem[] = coreIds.map((itemId, i) => ({
    itemId,
    reasons: [
      ...(i === 0 ? [...fallback, ...baseReason(core3, 'Most successful first three items')] : []),
      ...itemReason(itemId),
    ],
  }));

  // Boots, adjusted for the lane opponent and enemy traits, inserted at their usual slot.
  const bootsRows = byKind('boots');
  const bootsBase = bestChoice(bootsRows, baseline);
  if (bootsBase) {
    const reasons: Reason[] = [
      ...baseReason(
        bootsBase,
        `Most successful boots (${names.item(Number(bootsBase.row.choice))})`,
      ),
    ];
    const sw = bestSwitch(
      [...(primaryMatchup ? [primaryMatchup] : []), ...traitContexts],
      'boots',
      bootsBase.row.choice,
    );
    const bootsKey = sw.choice;
    if (sw.winner) {
      const r = contextReason(sw.winner, names.item(Number(sw.winner.choice)));
      if (r) reasons.unshift(r);
    }
    const row = bootsRows.find((r) => r.choice === bootsKey) ?? bootsBase.row;
    const slot = Math.max(0, Math.min(core.length, Math.round(row.avgPos ?? 1)));
    core.splice(slot, 0, { itemId: Number(bootsKey), reasons });
  }

  // Support quest upgrade, adjusted for the lane opponent and enemy traits like boots.
  const questRows = byKind('quest_item');
  const questGames = questRows.reduce((s, r) => s + r.games, 0);
  const questBase =
    baseline.games > 0 && questGames / baseline.games >= B.questItemMinShare
      ? bestChoice(questRows, baseline)
      : null;
  let questUpgrade: RecommendedItem | undefined;
  if (questBase) {
    const reasons: Reason[] = [
      ...baseReason(
        questBase,
        `Most successful quest upgrade (${names.item(Number(questBase.row.choice))})`,
      ),
    ];
    const sw = bestSwitch(
      [...(primaryMatchup ? [primaryMatchup] : []), ...traitContexts],
      'quest_item',
      questBase.row.choice,
    );
    if (sw.winner) {
      const r = contextReason(sw.winner, names.item(Number(sw.winner.choice)));
      if (r) reasons.unshift(r);
    }
    questUpgrade = { itemId: Number(sw.choice), reasons };
  }

  // Early components.
  const early: RecommendedItem[] = byKind('early_item')
    .filter((r) => baseline.games > 0 && r.games / baseline.games >= B.earlyItemMinShare)
    .sort((a, b) => (a.avgPos ?? 0) - (b.avgPos ?? 0) || Number(a.choice) - Number(b.choice))
    .slice(0, B.maxEarlyItems)
    .map((r) => ({
      itemId: Number(r.choice),
      reasons: [
        {
          kind: 'popularity',
          label: `Bought before the first item in ${formatRate(r.games / baseline.games)} of games (${formatGames(r.games)})`,
          delta: 0,
          games: r.games,
          itemId: Number(r.choice),
        },
      ],
    }));

  // Situational items.
  const taken = new Set(core.map((c) => c.itemId));
  const situational: RecommendedItem[] = [];
  const coreNonBoots = coreIds.filter((id) => !isBoots(id));
  /** Core item (not the first) doing worst in the context: the one a situational item replaces. */
  // Core items that already answer an active enemy trait (e.g. anti-heal vs healing) are kept.
  const answersActiveTrait = (id: number) =>
    TAG_RULES.some(
      (rule) =>
        input.enemyTraits.includes(rule.trait) &&
        (!rule.damage || rule.damage === damage) &&
        itemMatchesRule(id, data.items.get(id), rule),
    );
  const weakestCore = (ctx: Context | null): number | null => {
    const pool = coreNonBoots.slice(1).filter((id) => !answersActiveTrait(id));
    if (pool.length === 0) return null;
    if (!ctx) return pool[pool.length - 1] ?? null;
    return pool.reduce((worst, id) =>
      contextDelta(ctx, 'item', String(id)).delta < contextDelta(ctx, 'item', String(worst)).delta
        ? id
        : worst,
    );
  };
  const dataSwap = (ctx: Context): { itemId: number; delta: number; games: number } | null => {
    let best: { itemId: number; delta: number; games: number } | null = null;
    for (const r of ctx.rows) {
      const id = Number(r.choice);
      if (r.kind !== 'item' || r.games < B.minContextGames || taken.has(id) || isBoots(id))
        continue;
      const rest = { games: ctx.total.games - r.games, wins: ctx.total.wins - r.wins };
      if (rest.games <= 0) continue;
      const delta = shrink(winRate(r) - winRate(rest), r.games, B.shrinkK);
      if (delta <= 0 || delta - itemDelta(id) < B.swapMinGain) continue;
      if (!best || delta > best.delta || (delta === best.delta && id < best.itemId))
        best = { itemId: id, delta, games: r.games };
    }
    return best;
  };
  const addSituational = (itemId: number, replaces: number | null, reason: Reason) => {
    taken.add(itemId);
    situational.push({
      itemId,
      replacesItemId: replaces,
      reasons: [
        { ...reason, itemId, ...(replaces !== null ? { replacesItemId: replaces } : {}) },
        ...itemReason(itemId),
      ],
    });
  };

  // One answer per context (lane opponent, active enemy traits), ranked before the cap: contexts
  // with a data-backed swap by its delta (largest first), then the tag-rule ones in trait order.
  // They are answered in that order, so an item answering several contexts goes to the one it
  // helps most, and an item is only marked `taken` when it is returned.
  const contexts = [...(primaryMatchup ? [primaryMatchup] : []), ...traitContexts];
  const ranked = contexts
    .map((ctx, order) => ({ ctx, order, delta: dataSwap(ctx)?.delta ?? null }))
    .sort((a, b) => {
      if (a.delta !== null && b.delta !== null) return b.delta - a.delta || a.order - b.order;
      if (a.delta !== null || b.delta !== null) return a.delta !== null ? -1 : 1;
      return a.order - b.order;
    });
  const full = () => situational.length >= B.maxSituational;
  for (const { ctx } of ranked) {
    const swap = dataSwap(ctx);
    if (swap) {
      if (full()) continue;
      const replaces = weakestCore(ctx);
      if (ctx.kind === 'matchup') {
        addSituational(swap.itemId, replaces, {
          kind: 'matchup',
          label: `${formatDelta(swap.delta)} ${ctx.label} when built (${formatGames(swap.games)})`,
          delta: round(swap.delta),
          games: swap.games,
          ...(ctx.championIds ? { championIds: ctx.championIds } : {}),
        });
      } else {
        addSituational(swap.itemId, replaces, {
          kind: 'item_swap',
          label: `${formatDelta(swap.delta)} ${ctx.label} when built${replaces !== null ? ` instead of ${names.item(replaces)}` : ''} (${formatGames(swap.games)})`,
          delta: round(swap.delta),
          games: swap.games,
          trait: ctx.trait as CompTrait,
        });
      }
      continue;
    }
    if (ctx.kind === 'matchup') continue;
    const trait = ctx.trait as CompTrait;
    // Fallback: Data Dragon tag rules, restricted to items this champion+role actually builds.
    // A core item that already answers the trait gets the reason even when the list is full.
    for (const rule of TAG_RULES) {
      if (rule.trait !== trait || (rule.damage && rule.damage !== damage)) continue;
      const inCore = core.find((c) => itemMatchesRule(c.itemId, data.items.get(c.itemId), rule));
      if (inCore) {
        inCore.reasons.unshift({
          kind: 'tag_rule',
          label: `Enemy team is ${TRAIT_LABELS[trait]}: ${names.item(inCore.itemId)} already ${rule.why}`,
          delta: 0,
          games: 0,
          itemId: inCore.itemId,
          trait,
        });
        break;
      }
      if (full()) break;
      const candidate = itemRows
        .map((r) => Number(r.choice))
        .filter((id) => !taken.has(id) && (itemRow.get(id)?.games ?? 0) >= B.tagRuleMinItemGames)
        .filter((id) => itemMatchesRule(id, data.items.get(id), rule))
        .sort((a, b) => (itemRow.get(b)?.games ?? 0) - (itemRow.get(a)?.games ?? 0) || a - b)[0];
      if (candidate === undefined) continue;
      const replaces = weakestCore(null);
      addSituational(candidate, replaces, {
        kind: 'tag_rule',
        label: `Enemy team is ${TRAIT_LABELS[trait]}: ${names.item(candidate)} (${rule.why})`,
        delta: 0,
        games: 0,
        trait,
      });
      break;
    }
  }

  return {
    starting,
    early,
    core,
    situational,
    ...(questUpgrade ? { questUpgrade } : {}),
  };
}
