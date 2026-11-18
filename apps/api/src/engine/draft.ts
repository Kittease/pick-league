/**
 * Draft evaluation: win probability and damage profile of a draft in any state (draft planner,
 * champion select). Same deltas as the picks engine, summed per team:
 *
 *   P(allies win) = 0.5 + side edge
 *                 + baseWeight × (Σ allies' strength − Σ enemies' strength)
 *                 + pairWeight × (Σ ally–enemy pairs + Σ ally pairs − Σ enemy pairs)
 *
 * A champion's strength is its shrunk win rate in its role vs the role average. A pair counts
 * once, averaged over both points of view: an ally–enemy pair is (ally vs enemy − enemy vs ally)
 * / 2, a pair of teammates (a with b + b with a) / 2, each delta measured like in the picks
 * engine (against what the role usually gets vs/with that champion). Champions not picked yet
 * count as average. The weights come from a held-out fit (see `ENGINE_CONFIG.draft`).
 */
import type {
  DraftEvaluationResponse,
  DraftRequest,
  DraftSide,
  PatchId,
  Position,
  Reason,
  TeamDamage,
} from '@pick-league/shared';
import { DUO_ROLES, ENGINE_CONFIG, LANE_ROLES, ROLE_LABELS } from './config.ts';
import { indexGameLength, teamGameLength } from './game-length.ts';
import {
  blendPatches,
  formatDelta,
  formatGames,
  formatRate,
  listedGames,
  type PatchPair,
  type PatchSample,
  patchesLabel,
  round,
  shownGames,
  shrink,
  sumStats,
  winRate,
} from './math.ts';
import { assignRoles, type RoleGuess, rolePlayRates } from './roles.ts';
import { championBaseline, rowsByPatchAndChampion } from './tierlist.ts';
import type {
  ChampionTraitRow,
  GameLengthRow,
  GamesWins,
  NameLookup,
  RoleStatRow,
  VsRow,
  WithRow,
} from './types.ts';

/** stats_side_wins: results of a side (team 100 = blue, 200 = red) on a patch. */
export interface SideRow extends GamesWins {
  patch: PatchId;
  side: DraftSide;
}

export interface DraftData {
  currentPatch: PatchId;
  previousPatch: PatchId | null;
  /** stats_champion_roles of both patches (all champions, all roles). */
  roleStats: readonly RoleStatRow[];
  /** stats_champion_vs for the pairs of `draftPairs` (every champion of each role). */
  vs: readonly VsRow[];
  /** stats_champion_with for the pairs of `draftPairs` (every champion of each role). */
  with: readonly WithRow[];
  /** stats_champion_traits of the drafted champions. */
  championTraits: readonly ChampionTraitRow[];
  sides: readonly SideRow[];
  names: NameLookup;
  /**
   * stats_champion_game_length of the patches (every role, all summed): adds each team's early /
   * late profile (`gameLength`). It explains and never changes the probability.
   */
  gameLength?: readonly GameLengthRow[];
}

const D = ENGINE_CONFIG.draft;
const K = ENGINE_CONFIG.picks.shrinkK;
const PRIOR = ENGINE_CONFIG.previousPatchPrior;

export interface DraftRoles {
  allies: RoleGuess[];
  enemies: RoleGuess[];
}

/** Roles of both teams: given ones kept, unknown ones guessed from play rates. */
export function draftRoles(req: DraftRequest, roleStats: readonly RoleStatRow[]): DraftRoles {
  const rates = rolePlayRates(roleStats);
  return { allies: assignRoles(req.allies, rates), enemies: assignRoles(req.enemies, rates) };
}

/** A pair to read: champions of `position` vs/with `otherId` playing `otherPosition`. */
export interface PairKey {
  position: Position;
  otherId: number;
  otherPosition: Position;
}

/** The vs / with rows the evaluation needs (both points of view of every pair). */
export function draftPairs(roles: DraftRoles): { vs: PairKey[]; with: PairKey[] } {
  const vs: PairKey[] = [];
  const withKeys: PairKey[] = [];
  const key = (x: RoleGuess, o: RoleGuess): PairKey => ({
    position: x.role,
    otherId: o.championId,
    otherPosition: o.role,
  });
  for (const a of roles.allies) {
    for (const e of roles.enemies) vs.push(key(a, e), key(e, a));
  }
  for (const team of [roles.allies, roles.enemies]) {
    for (const x of team) for (const o of team) if (x !== o) withKeys.push(key(x, o));
  }
  return { vs, with: withKeys };
}

interface Drafted extends RoleGuess {
  /** `patchesUsed` of the champion+role. */
  patches: PatchId[];
  /** Effective games of the champion+role (previous patch as a capped prior), not rounded. */
  games: number;
  /** Real games of the champion+role on the patches listed (shown in the label). */
  listedGames: number;
  /** Blended win rate (for the label). */
  winRate: number;
  /** Win rate minus the role average, per patch then blended (not shrunk). */
  delta: number;
  /** Role probability factor, as in the picks engine. */
  factor: number;
}

export function evaluateDraft(
  req: DraftRequest,
  data: DraftData,
  roles: DraftRoles = draftRoles(req, data.roleStats),
): DraftEvaluationResponse {
  const names = data.names;
  const roleRow = new Map<string, RoleStatRow>();
  for (const r of data.roleStats) roleRow.set(`${r.patch}|${r.championId}|${r.position}`, r);
  const baselineOn = (championId: number, role: Position, patch: PatchId) =>
    roleRow.get(`${patch}|${championId}|${role}`);
  const roleAverage = memo((key) => {
    const [role, patch] = key.split('|');
    return winRate(
      sumStats(data.roleStats.filter((r) => r.position === role && r.patch === patch)),
    );
  });
  const patchPair: PatchPair = { current: data.currentPatch, previous: data.previousPatch };
  const inRole = new Map<Position, ReturnType<typeof rowsByPatchAndChampion>>();
  const rowsOfRole = (role: Position) => {
    const rows = inRole.get(role) ?? rowsByPatchAndChampion(data.roleStats, role);
    inRole.set(role, rows);
    return rows;
  };

  const drafted = (g: RoleGuess): Drafted => {
    const b = championBaseline(
      patchPair,
      rowsOfRole(g.role),
      (patch) => roleAverage(`${g.role}|${patch}`),
      g.championId,
    );
    return {
      ...g,
      patches: b.patches,
      games: b.games,
      listedGames: listedGames(b.blend, b.patches),
      winRate: b.winRate,
      delta: b.delta,
      factor: 0.5 + 0.5 * g.probability,
    };
  };
  const allies = roles.allies.map(drafted);
  const enemies = roles.enemies.map(drafted);
  const patchesUsed = [
    ...new Set([data.currentPatch, ...[...allies, ...enemies].flatMap((d) => d.patches)]),
  ].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  // What the role usually gets vs/with a champion on one patch (games-weighted over every
  // champion of the role, each against its own baseline on that patch).
  const usual = memo((key) => {
    const [side, position, otherId, otherPosition, patch] = key.split('|');
    const perChampion = new Map<number, GamesWins>();
    const rows: readonly (GamesWins & {
      patch: PatchId;
      position: Position;
      championId: number;
    })[] =
      side === 'vs'
        ? data.vs.filter((r) => r.enemyId === Number(otherId) && r.enemyPosition === otherPosition)
        : data.with.filter((r) => r.allyId === Number(otherId) && r.allyPosition === otherPosition);
    for (const r of rows) {
      if (r.position !== position || r.patch !== patch) continue;
      const s = perChampion.get(r.championId) ?? { games: 0, wins: 0 };
      perChampion.set(r.championId, { games: s.games + r.games, wins: s.wins + r.wins });
    }
    let games = 0;
    let sum = 0;
    for (const [championId, s] of perChampion) {
      const base = baselineOn(championId, position as Position, patch as PatchId);
      if (!base || base.games === 0) continue;
      sum += (winRate(s) - winRate(base)) * s.games;
      games += s.games;
    }
    return games > 0 ? sum / games : 0;
  });

  /** Shrunk delta of `x` vs (enemy) or with (ally) `o`, and its sample. */
  const pair = (x: Drafted, o: Drafted, enemy: boolean): { delta: number; games: number } => {
    if (x.games === 0) return { delta: 0, games: 0 };
    const rows: readonly (GamesWins & { patch: PatchId })[] = enemy
      ? data.vs.filter(
          (r) =>
            r.position === x.role &&
            r.championId === x.championId &&
            r.enemyId === o.championId &&
            r.enemyPosition === o.role,
        )
      : data.with.filter(
          (r) =>
            r.position === x.role &&
            r.championId === x.championId &&
            r.allyId === o.championId &&
            r.allyPosition === o.role,
        );
    // Per patch: vs x's own baseline and what the role usually gets on that patch, then blended.
    const sample = (patch: PatchId | null): PatchSample | undefined => {
      if (patch === null) return undefined;
      const stats = sumStats(rows.filter((r) => r.patch === patch));
      const own = baselineOn(x.championId, x.role, patch);
      if (stats.games === 0 || !own || own.games === 0) return undefined;
      const typical = usual(
        `${enemy ? 'vs' : 'with'}|${x.role}|${o.championId}|${o.role}|${patch}`,
      );
      return { value: winRate(stats) - winRate(own) - typical, games: stats.games };
    };
    const blend = blendPatches(sample(data.currentPatch), sample(data.previousPatch), PRIOR.pair);
    if (blend.games === 0) return { delta: 0, games: 0 };
    const k = enemy
      ? o.role === x.role
        ? K.matchup
        : LANE_ROLES[x.role].includes(o.role)
          ? K.laneSecondary
          : K.otherEnemy
      : DUO_ROLES[x.role].includes(o.role)
        ? K.duo
        : K.otherAlly;
    return { delta: shrink(blend.value, blend.games, k), games: shownGames(blend.games) };
  };

  const reasons: Reason[] = [];
  let edge = 0;
  const add = (delta: number, reason: Omit<Reason, 'delta'> & { label: string }) => {
    edge += delta;
    reasons.push({ ...reason, delta: round(delta) });
  };

  // Side.
  // Side: both kept patches summed, unweighted (the side edge does not depend on champion balance,
  // and a new patch's first matches alone would give a wild, unshrunk edge).
  if (req.side) {
    const rows = data.sides.filter(
      (s) =>
        s.side === req.side &&
        s.games > 0 &&
        (s.patch === data.currentPatch || s.patch === data.previousPatch),
    );
    const onSide = sumStats(rows);
    const patches = [data.currentPatch, data.previousPatch].filter(
      (p): p is PatchId => p !== null && rows.some((r) => r.patch === p),
    );
    if (onSide.games > 0) {
      const shift = winRate(onSide) - 0.5;
      add(shift, {
        kind: 'side',
        label: `${formatDelta(shift)} ${req.side === 'blue' ? 'Blue' : 'Red'} side: wins ${formatRate(winRate(onSide))} of matches on ${patchesLabel(patches)} (${formatGames(onSide.games)})`,
        games: onSide.games,
      });
    }
  }

  // Each champion's own strength.
  const name = (d: Drafted) => names.champion(d.championId);
  const where = (d: Drafted) => `${d.known ? '' : 'likely '}${ROLE_LABELS[d.role]}`;
  for (const [team, sign] of [
    [allies, 1],
    [enemies, -1],
  ] as const) {
    for (const d of team) {
      if (d.games === 0) continue;
      const strength = shrink(d.delta, d.games, K.base);
      add(sign * D.baseWeight * d.factor * strength, {
        kind: 'base',
        label: `${formatDelta(sign * D.baseWeight * d.factor * strength)} ${sign < 0 ? 'enemy ' : ''}${name(d)}: ${formatRate(d.winRate)} win rate as ${where(d)} (${formatGames(d.listedGames)})`,
        games: d.listedGames,
        championIds: [d.championId],
      });
    }
  }

  // Ally–enemy pairs, each once.
  for (const a of allies) {
    for (const e of enemies) {
      const mine = pair(a, e, true);
      const theirs = pair(e, a, true);
      const games = Math.max(mine.games, theirs.games);
      if (games === 0) continue;
      const delta = D.pairWeight * a.factor * e.factor * ((mine.delta - theirs.delta) / 2);
      const lane =
        a.role === e.role ? 'lane' : LANE_ROLES[a.role].includes(e.role) ? 'bot lane' : null;
      add(delta, {
        kind: 'matchup',
        label: `${formatDelta(delta)} ${name(a)} vs ${name(e)} (${lane ? `${lane}, ` : ''}${formatGames(games)})`,
        games,
        championIds: [a.championId, e.championId],
      });
    }
  }

  // Pairs of teammates, each once: allies' synergies help, enemies' hurt.
  for (const [team, sign] of [
    [allies, 1],
    [enemies, -1],
  ] as const) {
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        const x = team[i] as Drafted;
        const y = team[j] as Drafted;
        const one = pair(x, y, false);
        const two = pair(y, x, false);
        const games = Math.max(one.games, two.games);
        if (games === 0) continue;
        const duo = DUO_ROLES[x.role].includes(y.role);
        const delta = sign * D.pairWeight * x.factor * y.factor * ((one.delta + two.delta) / 2);
        add(delta, {
          kind: duo ? 'duo' : 'with_comp',
          label: `${formatDelta(delta)} ${sign < 0 ? 'enemy ' : ''}${name(x)} + ${name(y)} (${duo ? 'duo, ' : ''}${formatGames(games)})`,
          games,
          championIds: [x.championId, y.championId],
        });
      }
    }
  }

  const probability = Math.min(D.maxProbability, Math.max(D.minProbability, 0.5 + edge));
  const shown = reasons
    .filter((r) => r.kind === 'base' || r.kind === 'side' || Math.abs(r.delta) >= D.minReasonDelta)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, D.maxReasons);

  return {
    patch: data.currentPatch,
    patchesUsed,
    winProbability: round(probability, 4),
    reasons: shown,
    damage: {
      allies: teamDamage(allies, data),
      enemies: teamDamage(enemies, data),
    },
    ...(data.gameLength ? { gameLength: draftGameLength(data.gameLength, roles) } : {}),
  };
}

/** Each team's early / late profile, champions in their given or guessed roles. */
function draftGameLength(
  rows: readonly GameLengthRow[],
  roles: DraftRoles,
): NonNullable<DraftEvaluationResponse['gameLength']> {
  const index = indexGameLength(rows);
  return {
    allies: teamGameLength(index, roles.allies),
    enemies: teamGameLength(index, roles.enemies),
  };
}

/**
 * A team's average damage to champions per minute by type: each champion's damage per minute
 * split by its damage shares (all roles, current patch, else the previous one).
 */
export function teamDamage(
  team: readonly { championId: number }[],
  data: Pick<DraftData, 'championTraits' | 'currentPatch' | 'previousPatch'>,
): TeamDamage {
  const champions = team.flatMap((m) => {
    const of = (patch: PatchId | null) =>
      data.championTraits.find((t) => t.championId === m.championId && t.patch === patch);
    const cur = of(data.currentPatch);
    const row = cur && cur.games > 0 ? cur : (of(data.previousPatch) ?? cur);
    if (!row) return [];
    return [
      {
        championId: m.championId,
        physical: round(row.damagePerMin * row.physicalShare, 1),
        magic: round(row.damagePerMin * row.magicShare, 1),
        true: round(row.damagePerMin * row.trueShare, 1),
      },
    ];
  });
  const total = (k: 'physical' | 'magic' | 'true') =>
    round(
      champions.reduce((s, c) => s + c[k], 0),
      1,
    );
  return { physical: total('physical'), magic: total('magic'), true: total('true'), champions };
}

function memo<T>(fn: (key: string) => T): (key: string) => T {
  const cache = new Map<string, T>();
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key));
    return cache.get(key) as T;
  };
}
