/**
 * Build recommendations, layered:
 * 1. base = best choice for champion+role (shrunk win-rate delta + popularity bonus),
 * 2. adjusted for the lane opponent (choices vs that opponent),
 * 3. adjusted for enemy composition traits (data-backed deltas, else Data Dragon tag rules),
 * 4. situational items also answer the own team: duo partner and ally composition traits
 *    (data-backed deltas only).
 * Every piece carries reasons with the win-rate delta and sample size.
 */
import type {
  BuildRequest,
  BuildResponse,
  CompTrait,
  CoreBuild,
  ItemsRecommendation,
  PatchId,
  Reason,
  RecommendedItem,
  RunesRecommendation,
  SkillOrderRecommendation,
  SummonerSpellsRecommendation,
} from '@pick-league/shared';
import {
  DUO_ROLES,
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
  formatMatches,
  formatRate,
  type PatchChoice,
  patchesLabel,
  round,
  sampleConfidence,
  shrink,
  sumStats,
  winRate,
} from './math.ts';
import { sideTraits } from './picks.ts';
import { assignRoles, type RoleGuess, rolePlayRates } from './roles.ts';
import { parseIntList, skillMaxOrder, synthesiseSkillSequence } from './skills.ts';
import type {
  ChampionTraitRow,
  ChoiceDuoRow,
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
  WithRow,
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
  /** stats_choice_duos of champion + role on the patches used (summed), with the request's allies. */
  choiceDuos: readonly ChoiceDuoRow[];
  /** stats_choice_ally_traits of champion + role on the patches used (summed). */
  choiceAllyTraits: readonly ChoiceTraitRow[];
  /** stats_champion_comp_traits (both sides) of champion + role on the patches used (summed). */
  compTraits: readonly CompTraitRow[];
  /** stats_champion_vs of champion + role on the patches used (summed), vs the request's enemies. */
  vs: readonly VsRow[];
  /** stats_champion_with of champion + role on the patches used (summed), with the request's allies. */
  with: readonly WithRow[];
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

type ShrinkKey = keyof typeof B.shrinkK;

/** Prior strength of a choice kind (or a rune/core step). */
export function kOf(kind: ChoiceKind | ShrinkKey): number {
  return (B.shrinkK as Record<string, number>)[kind] ?? B.shrinkK.default;
}

interface Scored {
  row: ChoiceRow;
  delta: number;
  share: number;
}

/**
 * Best choice among `rows` (filtered): max(shrunk delta + popularity bonus) among choices with
 * enough games. Delta and share are relative to the candidates pooled, i.e. the games where that
 * choice exists: a 3-item path is compared with the other 3-item paths (games that reached 3
 * items win far more than average), not with every game of the champion.
 */
export function bestChoice(
  rows: readonly ChoiceRow[],
  k: number,
  filter: (r: ChoiceRow) => boolean = () => true,
): Scored | null {
  const candidates = rows.filter(filter);
  if (candidates.length === 0) return null;
  const pooled = sumStats(candidates);
  const refWr = winRate(pooled);
  const scored = candidates.map((row) => ({
    row,
    delta: shrink(winRate(row) - refWr, row.games, k),
    share: pooled.games > 0 ? row.games / pooled.games : 0,
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

/**
 * A context: lane opponent or enemy trait, or (situational items only) duo partner or ally trait,
 * with the champion's overall record in it.
 */
interface Context {
  kind: 'matchup' | 'vs_comp' | 'duo' | 'with_comp';
  /** "vs Thresh" / "vs heal-heavy teams" / "with Jinx" / "with AP-heavy allies" */
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

/**
 * Delta of `choice` within a context vs the other choices of its kind there (the games of that
 * kind in the context: every game for spells, games with completed boots for boots…).
 */
function contextDelta(
  ctx: Context,
  kind: ChoiceKind,
  choice: string,
): { delta: number; games: number } {
  const row = ctx.rows.find((r) => r.kind === kind && r.choice === choice);
  const pooled = sumStats(ctx.rows.filter((r) => r.kind === kind));
  if (!row || pooled.games === 0) return { delta: 0, games: 0 };
  return {
    delta: shrink(winRate(row) - winRate(pooled), row.games, kOf(kind)),
    games: row.games,
  };
}

/**
 * Games and wins of the players who completed at least `avgPos` items (interpolated between the
 * two whole counts around it), from the `items_done` rows of a context: the fair comparison for
 * an item usually bought at that point of the build. Players who complete more items win far
 * more (≈ 37 % with one item, 61 % with five on 16.22), so an item compared with every game
 * looked better the later it is bought. Null without `items_done` rows (stats predating 0015).
 */
export function stageReference(
  rows: readonly (GamesWins & { kind: ChoiceKind; choice: string })[],
  avgPos: number,
): GamesWins | null {
  const done = rows.filter((r) => r.kind === 'items_done');
  if (done.length === 0) return null;
  const atLeast = (n: number) => sumStats(done.filter((r) => Number(r.choice) >= n));
  const lo = Math.max(0, Math.floor(avgPos));
  const f = Math.max(0, avgPos - lo);
  const a = atLeast(lo);
  const b = atLeast(Math.min(lo + 1, 6));
  return { games: (1 - f) * a.games + f * b.games, wins: (1 - f) * a.wins + f * b.wins };
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
  const fallback: Reason[] =
    data.patch.previousWeight > 0
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
  // Own team (situational items only): duo partner(s) and ally composition traits.
  const duoRoles = DUO_ROLES[role];
  const duoContexts = assignRoles(req.allies, playRates, [role])
    .filter((a) => duoRoles.includes(a.role))
    .sort((a, b) => duoRoles.indexOf(a.role) - duoRoles.indexOf(b.role))
    .map((a) => duoContext(a, data, names));
  const allyTraitContexts = sideTraits(
    req.allies.map((a) => a.championId),
    data,
  ).map((t) => allyTraitContext(t, data));

  const selfTraits =
    data.championTraits.find(
      (t) => t.championId === req.championId && t.patch === data.currentPatch,
    ) ?? data.championTraits.find((t) => t.championId === req.championId);
  const damage: 'physical' | 'magic' =
    (selfTraits?.physicalShare ?? 0.5) >= (selfTraits?.magicShare ?? 0.5) ? 'physical' : 'magic';

  const runes = recommendRunes(byKind, primaryMatchup, names, fallback);
  const summonerSpells = recommendSpells(byKind, matchupContexts, traitContexts, names, fallback);
  const skillOrder = recommendSkills(byKind, primaryMatchup, fallback);
  const items = recommendItems({
    byKind,
    baseline,
    baseWr,
    primaryMatchup,
    traitContexts,
    allyContexts: [...duoContexts, ...allyTraitContexts],
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
    const diff = lanePhaseDiff(
      rows,
      {
        current: data.currentPatch,
        previous: data.patch.previousWeight > 0 ? data.previousPatch : null,
      },
      minute,
    );
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

function duoContext(a: RoleGuess, data: BuildData, names: NameLookup): Context {
  const total =
    data.with.find((w) => w.allyId === a.championId && w.allyPosition === a.role) ??
    ({ games: 0, wins: 0 } as GamesWins);
  return {
    kind: 'duo',
    label: `with ${names.champion(a.championId)}`,
    ...(a.known ? {} : { note: `likely ${ROLE_LABELS[a.role]}` }),
    total,
    rows: data.choiceDuos.filter(
      (r) => r.partnerId === a.championId && r.partnerPosition === a.role,
    ),
    championIds: [a.championId],
  };
}

function allyTraitContext(trait: CompTrait, data: BuildData): Context {
  const total = data.compTraits.find((r) => r.side === 'ally' && r.trait === trait) ?? {
    games: 0,
    wins: 0,
  };
  return {
    kind: 'with_comp',
    label: `with ${TRAIT_LABELS[trait]} allies`,
    total,
    rows: data.choiceAllyTraits.filter((r) => r.trait === trait),
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

/** Rows grouped by a derived key, games and wins summed (rows whose key is null are left out). */
function groupChoices(
  rows: readonly ChoiceRow[],
  keyOf: (r: ChoiceRow) => string | null,
): ChoiceRow[] {
  const out = new Map<string, ChoiceRow>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key === null) continue;
    const seen = out.get(key);
    out.set(
      key,
      seen
        ? { ...seen, games: seen.games + r.games, wins: seen.wins + r.wins }
        : { kind: r.kind, choice: key, games: r.games, wins: r.wins, avgPos: null },
    );
  }
  return [...out.values()];
}

/**
 * The page is built step by step, each step among the pages of the chosen keystone: whole pages
 * (with shards) are too fragmented to pick at once (the most successful one was usually a page
 * seen in a few dozen games). Keystone (primary tree included) first, possibly adapted to the
 * lane opponent; then the secondary tree with its two runes, each primary minor rune (no
 * measurable difference on 16.22: popularity decides) and each stat shard.
 */
function recommendRunes(
  byKind: (k: ChoiceKind) => ChoiceRow[],
  matchup: Context | undefined,
  names: NameLookup,
  fallback: Reason[],
): RunesRecommendation {
  const pages = byKind('rune_page').flatMap((row) => {
    const page = parseRunePage(row.choice);
    return page && page.runeIds.length === 6 && page.statShardIds.length === 3
      ? [{ row, page }]
      : [];
  });
  const keystoneRows = groupChoices(
    pages.map((p) => p.row),
    (r) => {
      const page = parseRunePage(r.choice);
      return page ? `${page.primaryTreeId}|${page.runeIds[0]}` : null;
    },
  );
  let keystone = bestChoice(keystoneRows, kOf('keystone'));
  const keystoneId = (s: Scored | null) => Number(s?.row.choice.split('|')[1] ?? 0);
  const reasons: Reason[] = [
    ...fallback,
    ...baseReason(keystone, `Most successful keystone (${names.rune(keystoneId(keystone))})`),
  ];
  if (keystone && matchup) {
    const res = adjustInContext(matchup, 'keystone', String(keystoneId(keystone)));
    if (res.switched) {
      const alt = bestChoice(
        keystoneRows,
        kOf('keystone'),
        (r) => r.choice.split('|')[1] === res.choice,
      );
      if (alt) keystone = alt;
    }
    const reason = contextReason(res, names.rune(Number(res.choice)));
    if (reason) reasons.unshift(reason);
  }
  const [primaryTree = '0', keystoneKey = '0'] = keystone?.row.choice.split('|') ?? [];
  const mine = pages.filter(
    (p) =>
      String(p.page.primaryTreeId) === primaryTree && String(p.page.runeIds[0]) === keystoneKey,
  );
  const step = (key: (p: ParsedPage) => string, k: number, among = mine) =>
    bestChoice(
      groupChoices(
        among.map((p) => p.row),
        (r) => {
          const page = parseRunePage(r.choice);
          return page ? key(page) : null;
        },
      ),
      k,
    )?.row.choice ?? null;
  const secondary = step(
    (p) => `${p.secondaryTreeId}|${p.runeIds[4]},${p.runeIds[5]}`,
    kOf('runeSecondary'),
  );
  const minors = [1, 2, 3].map((i) => step((p) => String(p.runeIds[i]), kOf('runeMinor')));
  const shards = [0, 1, 2].map((i) => step((p) => String(p.statShardIds[i]), kOf('runeShard')));
  const [secondaryTree, secondaryRunes = ''] = secondary?.split('|') ?? [];
  const runeIds = keystone
    ? [Number(keystoneKey), ...minors.map(Number), ...parseIntList(secondaryRunes)]
    : [];
  const statShardIds = keystone ? shards.map(Number) : [];
  if (keystone && mine.length > 0) {
    reasons.push({
      kind: 'popularity',
      label: `Secondary tree, minor runes and shards: most successful in each slot among the ${formatGames(keystone.row.games)} with ${names.rune(Number(keystoneKey))}`,
      delta: 0,
      games: keystone.row.games,
    });
  }
  return {
    primaryTreeId: Number(primaryTree),
    secondaryTreeId: Number(secondaryTree ?? 0),
    runeIds,
    statShardIds,
    selectedPerkIds: [...runeIds, ...statShardIds],
    games: keystone?.row.games ?? 0,
    winRate: round(winRate(keystone?.row)),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Summoner spells
// ---------------------------------------------------------------------------

const FLASH = 4;

function recommendSpells(
  byKind: (k: ChoiceKind) => ChoiceRow[],
  matchups: readonly Context[],
  traits: readonly Context[],
  names: NameLookup,
  fallback: Reason[],
): SummonerSpellsRecommendation {
  const rows = byKind('spells');
  const base = bestChoice(rows, kOf('spells'));
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
  matchup: Context | undefined,
  fallback: Reason[],
): SkillOrderRecommendation {
  const reasons: Reason[] = [...fallback];
  const first = bestChoice(byKind('skill_first3'), kOf('skill_first3'));
  const max = bestChoice(byKind('skill_max'), kOf('skill_max'));
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
  /** Duo partner(s), then active ally traits: data-backed situational items only. */
  allyContexts: readonly Context[];
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
  const { byKind, baseline, baseWr, primaryMatchup, traitContexts, allyContexts } = input;
  const { data, damage, fallback } = input;
  const names = data.names;
  const itemRows = byKind('item');
  const itemRow = new Map(itemRows.map((r) => [Number(r.choice), r]));
  const isBoots = (id: number) => data.items.get(id)?.isBoots ?? false;

  /**
   * Delta of building an item (its row `r` among `rows`) vs not building it, among the players
   * at the same point of their build (`stageReference` at the item's usual slot); among every
   * game of `total` when the stats have no `items_done` rows. Null without a comparison group.
   */
  const builtDelta = (
    r: GamesWins,
    id: number,
    rows: Context['rows'],
    total: GamesWins,
  ): number | null => {
    const avgPos = itemRow.get(id)?.avgPos ?? null;
    const pool = (avgPos !== null ? stageReference(rows, avgPos) : null) ?? total;
    const restGames = pool.games - r.games;
    if (restGames < 1) return null;
    const restWr = Math.min(1, Math.max(0, (pool.wins - r.wins) / restGames));
    return shrink(winRate(r) - restWr, r.games, kOf('item'));
  };
  const hasStages = data.choices.some((r) => r.kind === 'items_done');
  // Overall delta of building an item vs not building it.
  const itemDelta = (id: number): number => {
    const r = itemRow.get(id);
    return r ? (builtDelta(r, id, data.choices, baseline) ?? 0) : 0;
  };
  const itemReason = (id: number): Reason[] => {
    const r = itemRow.get(id);
    if (!r) return [];
    const share = baseline.games > 0 ? r.games / baseline.games : 0;
    const delta = itemDelta(id);
    return [
      {
        kind: 'popularity',
        label: hasStages
          ? `Built in ${formatRate(share)} of games, ${formatDelta(delta)} vs players at the same point of their build (${formatGames(r.games)})`
          : `Built in ${formatRate(share)} of games, ${formatRate(winRate(r))} win rate (${formatGames(r.games)})`,
        delta: round(hasStages ? delta : shrink(winRate(r) - baseWr, r.games, kOf('item'))),
        games: r.games,
        itemId: id,
      },
    ];
  };

  // Starting items.
  const starterBase = bestChoice(byKind('starter'), kOf('starter'));
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

  // Core: the first three items one at a time among the games with 3 completed items (first
  // item, then the second after it, then the third), since whole 3-item paths are too
  // fragmented to pick at once; completed with the most built items.
  const paths = byKind('core3').filter((r) => parseIntList(r.choice).length === 3);
  const coreIds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const among = paths.filter((r) => {
      const ids = parseIntList(r.choice);
      return coreIds.every((id, j) => ids[j] === id);
    });
    const next = bestChoice(
      groupChoices(among, (r) => String(parseIntList(r.choice)[i])),
      i === 0 ? kOf('coreFirst') : kOf('coreNext'),
    );
    if (!next) break;
    coreIds.push(Number(next.row.choice));
  }
  const allPaths = sumStats(paths);
  const scorePath = (row: ChoiceRow): Scored => ({
    row,
    delta: shrink(winRate(row) - winRate(allPaths), row.games, kOf('coreNext')),
    share: allPaths.games > 0 ? row.games / allPaths.games : 0,
  });
  const pathRow = paths.find((r) => r.choice === coreIds.join(','));
  const core3: Scored | null = pathRow && allPaths.games > 0 ? scorePath(pathRow) : null;

  // Core builds: the 3-item paths with enough matches, ranked like every other choice (shrunk
  // win-rate delta vs all paths plus a popularity bonus), each with a genuinely different item
  // set from the ones before it (a different first item, or at least 2 other items). Without
  // such a path, the item-by-item pick above stands alone.
  const A = B.altCores;
  const differs = (a: readonly number[], b: readonly number[]) => {
    const missing = a.filter((id) => !b.includes(id)).length;
    return missing > 0 && (a[0] !== b[0] || missing >= 2);
  };
  const candidates = paths
    .filter((r) => r.games >= A.minGames)
    .map(scorePath)
    .filter((s) => s.delta >= A.minDelta)
    .sort(
      (a, b) =>
        b.delta + B.popularityWeight * b.share - (a.delta + B.popularityWeight * a.share) ||
        b.row.games - a.row.games ||
        byKey(a.row.choice, b.row.choice),
    );
  const chosen: { path: number[]; scored: Scored | null }[] = [];
  for (const s of candidates) {
    if (chosen.length >= A.max) break;
    const path = parseIntList(s.row.choice);
    if (chosen.every((c) => differs(path, c.path))) chosen.push({ path, scored: s });
  }
  if (chosen.length === 0) chosen.push({ path: [...coreIds], scored: core3 });
  coreIds.splice(0, coreIds.length, ...(chosen[0]?.path ?? []));

  /** A path completed to the core size with the most built (non-boots) items bought after it. */
  const fillCore = (path: readonly number[]): number[] => {
    const ids = [...path];
    const extra = itemRows
      .filter((r) => !ids.includes(Number(r.choice)) && !isBoots(Number(r.choice)))
      .filter((r) => (r.avgPos ?? 0) >= path.length - 0.5)
      .sort((a, b) => b.games - a.games || Number(a.choice) - Number(b.choice));
    for (const r of extra) {
      if (ids.length >= B.coreSize) break;
      ids.push(Number(r.choice));
    }
    return ids;
  };
  coreIds.push(...fillCore(coreIds).slice(coreIds.length));

  const pathName = (path: readonly number[]) => path.map((id) => names.item(id)).join(' + ');
  const firstPath = chosen[0]?.path ?? [];
  const firstScored = chosen[0]?.scored ?? null;
  const buildReasons = (path: readonly number[], s: Scored | null, index: number): Reason[] => {
    if (!s) return [...fallback];
    const record = `${formatRate(winRate(s.row))} win rate, taken in ${formatRate(s.share)} of matches with three completed items (${formatMatches(s.row.games)})`;
    if (index === 0) {
      return [
        ...fallback,
        {
          kind: 'base',
          label: `Most successful first three items: ${record}`,
          delta: round(s.delta),
          games: s.row.games,
        },
      ];
    }
    const added = path.filter((id) => !firstPath.includes(id));
    const dropped = firstPath.filter((id) => !path.includes(id));
    const what =
      path[0] !== firstPath[0]
        ? `Starts with ${names.item(path[0] ?? 0)} instead of ${names.item(firstPath[0] ?? 0)}`
        : `${pathName(added)} instead of ${pathName(dropped)}`;
    const reasons: Reason[] = [
      ...fallback,
      { kind: 'base', label: `${what}: ${record}`, delta: round(s.delta), games: s.row.games },
    ];
    if (firstScored) {
      const gap = s.delta - firstScored.delta;
      const ratio = s.row.games / Math.max(1, firstScored.row.games);
      const popularity =
        ratio >= 1.1
          ? `${ratio.toFixed(1)}× as popular`
          : ratio <= 1 / 1.1
            ? `${(1 / ratio).toFixed(1)}× less popular`
            : 'as popular';
      reasons.push({
        kind: 'popularity',
        label: `vs core build 1: ${formatRate(winRate(s.row))} vs ${formatRate(winRate(firstScored.row))} win rate, ${popularity} (${formatMatches(s.row.games)} vs ${formatMatches(firstScored.row.games)})`,
        delta: round(gap),
        games: s.row.games,
      });
    }
    return reasons;
  };
  const coreBuilds: CoreBuild[] = chosen.map(({ path, scored }, index) => {
    const ids = index === 0 ? coreIds : fillCore(path);
    return {
      items: ids.map((itemId) => ({ itemId, reasons: itemReason(itemId) })),
      games: scored?.row.games ?? 0,
      winRate: round(winRate(scored?.row)),
      share: round(scored?.share ?? 0),
      reasons: buildReasons(path, scored, index),
    };
  });

  // Boots, adjusted for the lane opponent and enemy traits, inserted at their usual slot of
  // every core build.
  const bootsRows = byKind('boots');
  const bootsBase = bestChoice(bootsRows, kOf('boots'));
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
    for (const build of coreBuilds) {
      const slot = Math.max(0, Math.min(build.items.length, Math.round(row.avgPos ?? 1)));
      build.items.splice(slot, 0, { itemId: Number(bootsKey), reasons: [...reasons] });
    }
  }
  const core = coreBuilds[0]?.items ?? [];

  // Support quest upgrade, adjusted for the lane opponent and enemy traits like boots.
  const questRows = byKind('quest_item');
  const questGames = questRows.reduce((s, r) => s + r.games, 0);
  const questBase =
    baseline.games > 0 && questGames / baseline.games >= B.questItemMinShare
      ? bestChoice(questRows, kOf('quest_item'))
      : null;
  let questUpgrade: RecommendedItem | undefined;
  if (questBase) {
    const reasons: Reason[] = [
      ...baseReason(
        questBase,
        // With no measurable difference between upgrades (infinite k) popularity decides, and
        // no context ever switches it.
        `${Number.isFinite(kOf('quest_item')) ? 'Most successful' : 'Most played'} quest upgrade (${names.item(Number(questBase.row.choice))})`,
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
  /**
   * Delta of building a (non-boots) item vs not building it within the context, when the item
   * has the games there and beats its overall delta by `swapMinGain`; null otherwise.
   */
  const contextGain = (ctx: Context, r: Context['rows'][number]): number | null => {
    const id = Number(r.choice);
    if (r.kind !== 'item' || r.games < B.minContextGames || isBoots(id)) return null;
    const delta = builtDelta(r, id, ctx.rows, ctx.total);
    if (delta === null) return null;
    return delta > 0 && delta - itemDelta(id) >= B.swapMinGain ? delta : null;
  };
  const dataSwap = (ctx: Context): { itemId: number; delta: number; games: number } | null => {
    let best: { itemId: number; delta: number; games: number } | null = null;
    for (const r of ctx.rows) {
      const id = Number(r.choice);
      const delta = taken.has(id) ? null : contextGain(ctx, r);
      if (delta === null) continue;
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

  // A core item that does notably better with the own team (duo partner, active ally trait) says
  // so, for the context where it gains most (same test as a situational swap).
  for (const item of coreBuilds.flatMap((b) => b.items)) {
    let best: { ctx: Context; delta: number; games: number } | null = null;
    for (const ctx of allyContexts) {
      const r = ctx.rows.find((x) => x.kind === 'item' && Number(x.choice) === item.itemId);
      const delta = r ? contextGain(ctx, r) : null;
      if (r && delta !== null && (!best || delta > best.delta))
        best = { ctx, delta, games: r.games };
    }
    if (!best) continue;
    item.reasons.unshift({
      kind: best.ctx.kind,
      label: `${formatDelta(best.delta)} ${best.ctx.label} when built (${formatGames(best.games)})`,
      delta: round(best.delta),
      games: best.games,
      itemId: item.itemId,
      ...(best.ctx.championIds ? { championIds: best.ctx.championIds } : {}),
      ...(best.ctx.trait ? { trait: best.ctx.trait } : {}),
    });
  }

  // A core build whose first three items include one doing notably better vs the lane opponent
  // says so (same test as a situational swap), for the item that gains most.
  if (primaryMatchup) {
    for (const [index, build] of coreBuilds.entries()) {
      const path = chosen[index]?.path ?? [];
      let best: { itemId: number; delta: number; games: number } | null = null;
      for (const id of path) {
        const r = primaryMatchup.rows.find((x) => x.kind === 'item' && Number(x.choice) === id);
        const delta = r ? contextGain(primaryMatchup, r) : null;
        if (r && delta !== null && (!best || delta > best.delta))
          best = { itemId: id, delta, games: r.games };
      }
      if (!best) continue;
      const note = primaryMatchup.note ? `${primaryMatchup.note}, ` : '';
      build.reasons.unshift({
        kind: 'matchup',
        label: `${formatDelta(best.delta)} ${primaryMatchup.label} when ${names.item(best.itemId)} is built (${note}${formatMatches(best.games)})`,
        delta: round(best.delta),
        games: best.games,
        itemId: best.itemId,
        ...(primaryMatchup.championIds ? { championIds: primaryMatchup.championIds } : {}),
      });
    }
  }

  // One answer per context (lane opponent, active enemy traits, duo partners, active ally
  // traits), ranked before the cap: contexts with a data-backed swap by its delta (largest
  // first), then the tag-rule ones (enemy traits only) in trait order. They are answered in that
  // order, so an item answering several contexts goes to the one it helps most, and an item is
  // only marked `taken` when it is returned.
  const contexts = [...(primaryMatchup ? [primaryMatchup] : []), ...traitContexts, ...allyContexts];
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
      if (ctx.kind === 'matchup' || ctx.kind === 'duo') {
        addSituational(swap.itemId, replaces, {
          kind: ctx.kind,
          label: `${formatDelta(swap.delta)} ${ctx.label} when built (${formatGames(swap.games)})`,
          delta: round(swap.delta),
          games: swap.games,
          ...(ctx.championIds ? { championIds: ctx.championIds } : {}),
        });
      } else {
        addSituational(swap.itemId, replaces, {
          kind: ctx.kind === 'with_comp' ? 'with_comp' : 'item_swap',
          label: `${formatDelta(swap.delta)} ${ctx.label} when built${replaces !== null ? ` instead of ${names.item(replaces)}` : ''} (${formatGames(swap.games)})`,
          delta: round(swap.delta),
          games: swap.games,
          trait: ctx.trait as CompTrait,
        });
      }
      continue;
    }
    // No data-backed answer: Data Dragon tag rules, for enemy traits only.
    if (ctx.kind !== 'vs_comp') continue;
    const trait = ctx.trait as CompTrait;
    // Fallback: Data Dragon tag rules, restricted to items this champion+role actually builds.
    // A core item that already answers the trait gets the reason even when the list is full.
    const told = new Set<CoreBuild>();
    for (const rule of TAG_RULES) {
      if (rule.trait !== trait || (rule.damage && rule.damage !== damage)) continue;
      // Said once per core build that has one; situational items follow core build 1.
      for (const build of coreBuilds) {
        if (told.has(build)) continue;
        const inBuild = build.items.find((c) =>
          itemMatchesRule(c.itemId, data.items.get(c.itemId), rule),
        );
        inBuild?.reasons.unshift({
          kind: 'tag_rule',
          label: `Enemy team is ${TRAIT_LABELS[trait]}: ${names.item(inBuild.itemId)} already ${rule.why}`,
          delta: 0,
          games: 0,
          itemId: inBuild.itemId,
          trait,
        });
        if (inBuild) told.add(build);
      }
      if (core.some((c) => itemMatchesRule(c.itemId, data.items.get(c.itemId), rule))) break;
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
    // Clients that only know one core build: build 1, its path reasons on its first item.
    core: core.map((item) =>
      item.itemId === coreIds[0]
        ? {
            ...item,
            reasons: [
              ...fallback,
              ...baseReason(core3, 'Most successful first three items'),
              ...item.reasons,
            ],
          }
        : item,
    ),
    coreBuilds,
    situational,
    ...(questUpgrade ? { questUpgrade } : {}),
  };
}
