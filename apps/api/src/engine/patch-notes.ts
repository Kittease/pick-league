/**
 * Patch notes: is a changed value a buff or a nerf, how much, and what does it add up to for a
 * champion or an item. Pure: the rows come from `patch_changes`, the damage split from the stats.
 *
 * 1. **Direction** from what the value is: the first rule of `VALUE_RULES` whose pattern matches
 *    the value name (for a formula's generic parts — `StartValue`, `Number`, `Level1Value`… — the
 *    calculation's name, e.g. `TibbersTotalHP`) says whether higher is better. Damage, healing,
 *    shields, ratios, range, crowd control and own buff durations, speeds and stats: higher is a
 *    buff; cooldowns, costs, cast times and item prices: lower is a buff. A value nothing matches,
 *    or one present on one side only (a rework), is neutral.
 * 2. **Magnitude**: the relative change, ranks averaged: mean of (new − old) / |old|, each rank
 *    capped at ±100 % (a value from 0 counts ±100 %), signed so that positive = buff. A value 20
 *    times larger or smaller changed its unit: neutral.
 * 3. **Relevance**: an AP ratio matters as much as the champion deals magic damage, an AD ratio
 *    as much as it deals physical damage: 10 % + 90 % × that share of its damage (measured, see
 *    `stats_champion_traits`). Mana costs and minion / monster values count 0.3 / 0.5, attack range
 *    2 (a small relative change that players feel), technical values 0, the rest 1.
 * 4. **Weight** = magnitude × relevance; under 5 % it is a minor change. A change repeated in
 *    several game objects (SyndraE and SyndraE5, Qiyana's three Q elements) counts once.
 * 5. **Verdict**: buff weights summed vs nerf weights summed. Nothing above 2 % in all: adjusted;
 *    the smaller side at least half the larger: mixed; else buff or nerf. Five values or more
 *    appearing or disappearing (spell objects included): reworked.
 */
import type {
  PatchId,
  PatchNoteCategory,
  PatchNoteChange,
  PatchNoteDamageSplit,
  PatchNoteDirection,
  PatchNoteItemUser,
  PatchNoteObserved,
  PatchNoteSlot,
  PatchNoteUnit,
  PatchNoteVerdict,
  PatchNoteVerdictSummary,
  PatchValueChange,
  Position,
} from '@pick-league/shared';
import type { ChampionTraitRow, RoleStatRow } from './types.ts';

/** Which way is better for the champion; null = cannot tell. */
type Better = 'higher' | 'lower' | null;

export interface ValueRule {
  pattern: RegExp;
  category: PatchNoteCategory;
  better: Better;
  /** Fixed relevance (else 1, or the damage split for ratios). */
  relevance?: number;
  /** Fixed unit (else guessed from the name and the values, see `unitOf`). */
  unit?: PatchNoteUnit;
}

/**
 * Value-name rules, first match wins (case-insensitive unless the pattern says otherwise). Checked
 * against every value name stored for 16.20–16.23 (226 distinct names).
 */
export const VALUE_RULES: readonly ValueRule[] = [
  // File data without a gameplay meaning we can read.
  {
    pattern:
      /^(\{[0-9a-f]{8}\}|flags|AffectsTypeFlags|DimensionBehavior|DistanceType|CanMoveWhileChanneling|ProjectTargetToCastRange|arAllowMaxValueToBeOverridden|SpellCooldownOrSealedQueueThreshold|UnitsRequired|ChargeMultiplierInverse|added|removed)$/i,
    category: 'technical',
    better: null,
    relevance: 0,
  },
  { pattern: /^price$/i, category: 'price', better: 'lower', unit: 'flat' },
  // Cooldown refunds and haste before cooldowns: more of them is better.
  { pattern: /cdr|cooldownreset|refund|haste/i, category: 'cooldown', better: 'higher' },
  { pattern: /cooldown|recharge/i, category: 'cooldown', better: 'lower', unit: 'seconds' },
  {
    pattern: /^cost$|^mana(values)?$|manacost/i,
    category: 'cost',
    better: 'lower',
    relevance: 0.3,
  },
  {
    pattern: /casttime|totaltime|channelduration|channeltime|windup/i,
    category: 'castTime',
    better: 'lower',
    unit: 'seconds',
  },
  { pattern: /minion/i, category: 'minion', better: 'higher', relevance: 0.3 },
  { pattern: /monster/i, category: 'minion', better: 'higher', relevance: 0.5 },
  // The champion's own damage reduction; "reduced damage" is ambiguous (Orianna's Q falloff).
  { pattern: /damagereduction$/i, category: 'stat', better: 'higher', unit: 'percent' },
  { pattern: /reduced/i, category: 'other', better: null },
  // Not 'duRATIOn'.
  { pattern: /ratio(?!n)/i, category: 'ratio', better: 'higher' },
  {
    pattern: /multiplier|scaling|amp$|boost|increase/i,
    category: 'scaling',
    better: 'higher',
  },
  { pattern: /heal(?!th)|lifesteal|vamp|regen/i, category: 'healing', better: 'higher' },
  { pattern: /shield/i, category: 'shield', better: 'higher' },
  {
    pattern: /damage|dmg|percent(current|max|missing)?(hp|health)|healthdamage|hpdamage/i,
    category: 'damage',
    better: 'higher',
  },
  {
    pattern:
      /(stun|root|slow|sleep|fear|charm|taunt|knock|silence|snare|suppress|polymorph|blind|ground)(duration|time)|slow/i,
    category: 'cc',
    better: 'higher',
  },
  {
    pattern: /buffduration|(speed|haste|shield|invuln|untargetable|stealth|camouflage)duration/i,
    category: 'duration',
    better: 'higher',
    unit: 'seconds',
  },
  { pattern: /duration/i, category: 'duration', better: null, unit: 'seconds' },
  // Not 'Ranged' (a melee / ranged variant of another value).
  { pattern: /range(?!d)|radius|width/i, category: 'range', better: 'higher', unit: 'flat' },
  { pattern: /speed/i, category: 'speed', better: 'higher' },
  // Abbreviations are matched in capitals only ('BonusAS', 'AStoAD'; not 'Spread').
  { pattern: /^AS|AS(Ranged|Melee)?$|^MS|MS(Ranged|Melee)?$/, category: 'speed', better: 'higher' },
  {
    pattern:
      /armor|magicresist|spellblock|health|mana|attackdamage|abilitypower|lethality|penetration|crit|tenacity|mod$/i,
    category: 'stat',
    better: 'higher',
  },
  { pattern: /AD|AP|MR|HP/, category: 'stat', better: 'higher' },
];

/**
 * The calculation a value belongs to: the stored one, else (items: the row has none) the
 * `mItemCalculations/<name>` of its path.
 */
export function calculationOf(
  change: Pick<PatchValueChange, 'calculation' | 'path'>,
): string | null {
  return change.calculation ?? /mItemCalculations\/([^/]+)/.exec(change.path)?.[1] ?? null;
}

/** A formula's generic parts: their meaning is the calculation's (`TibbersTotalHP`). */
const GENERIC_VALUE =
  /^(StartValue|EndValue|Number|Level1Value|Coefficient\d*|Part\d+|BonusPerLevel.*|InitialBonusPerLevel|AdditionalBonusAtThisLevel.*|Effect\d+Amount|Value)$/i;

/** Base stats (slot `base`): all better higher; attack speed per level is in percent. */
const BASE_STAT_UNITS: Record<string, PatchNoteUnit> = { attackSpeedPerLevel: 'percentPoints' };

const NEUTRAL_RULE: ValueRule = { pattern: /.*/, category: 'other', better: null };

/** The rule of a value: by its name, else by its calculation's name for generic parts. */
export function ruleOf(
  change: Pick<PatchValueChange, 'slot' | 'valueName' | 'calculation'>,
): ValueRule {
  const { valueName, calculation, slot } = change;
  const byName = VALUE_RULES.find((r) => r.pattern.test(valueName));
  if (byName?.category === 'technical') return byName;
  if (slot === 'base') {
    if (/^attackRange$/i.test(valueName))
      return { pattern: /.*/, category: 'range', better: 'higher', relevance: 2, unit: 'flat' };
    return {
      pattern: /.*/,
      category: 'stat',
      better: 'higher',
      unit: BASE_STAT_UNITS[valueName] ?? 'flat',
    };
  }
  if (GENERIC_VALUE.test(valueName)) {
    if (calculation === null || /^\{[0-9a-f]{8}\}$/i.test(calculation)) return NEUTRAL_RULE;
    return (
      VALUE_RULES.find((r) => r.category !== 'technical' && r.pattern.test(calculation)) ??
      NEUTRAL_RULE
    );
  }
  return byName ?? NEUTRAL_RULE;
}

/** The damage type a ratio scales with: AP → magic, AD → physical, else none (health…). */
export function ratioDamageType(valueName: string): 'physical' | 'magic' | null {
  if (/AP|^ap|[a-z]Ap[A-Z]|abilitypower/.test(valueName)) return 'magic';
  if (/AD|^ad|[a-z]Ad[A-Z]|[Aa]ttack[Dd]amage/.test(valueName)) return 'physical';
  return null;
}

/** Shares of the champion's damage (0–1 each). */
export interface DamageShares {
  physical: number;
  magic: number;
}

/** How much the value matters to the champion (see the module comment, step 3). */
export function relevanceOf(
  rule: ValueRule,
  valueName: string,
  damage: DamageShares | null,
): number {
  if (rule.relevance !== undefined) return rule.relevance;
  if (rule.category === 'ratio' && damage) {
    const type = ratioDamageType(valueName);
    if (type) return 0.1 + 0.9 * damage[type];
  }
  return 1;
}

/**
 * Shown in percent: ratios up to 250 %, fractions (≤ 2.5) of percent-like names and values that
 * are all fractions under 1; a percent-like name with larger values is already in percent.
 */
export function unitOf(
  rule: ValueRule,
  valueName: string,
  values: readonly number[],
): PatchNoteUnit {
  if (rule.unit) return rule.unit;
  if (values.length === 0) return 'flat';
  if (/duration|time$/i.test(valueName)) return 'seconds';
  const small = values.every((v) => Math.abs(v) <= 2.5);
  const fractional = values.some((v) => !Number.isInteger(v));
  if (/percent|pct/i.test(valueName)) return small ? 'percent' : 'percentPoints';
  if (rule.category === 'ratio') return small ? 'percent' : 'flat';
  if (
    small &&
    fractional &&
    (/multiplier|scaling|amp|boost|increase|reduction|slow|speed|mod/i.test(valueName) ||
      /AS/.test(valueName))
  )
    return 'percent';
  if (fractional && values.every((v) => Math.abs(v) < 1)) return 'percent';
  return 'flat';
}

/** A rank's value this many times larger or smaller: a change of unit, not of strength. */
export const UNIT_CHANGE = 20;

/**
 * Mean relative change over the ranks, each capped at ±1; a single value on one side is compared
 * with every rank of the other. Null when a side is missing or the unit changed.
 */
export function relativeChange(
  oldValues: readonly number[] | null,
  newValues: readonly number[] | null,
): number | null {
  if (!oldValues?.length || !newValues?.length) return null;
  const n = Math.max(oldValues.length, newValues.length);
  const at = (v: readonly number[], i: number) =>
    (v.length === 1 ? v[0] : v[i]) as number | undefined;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const o = at(oldValues, i);
    const v = at(newValues, i);
    if (o === undefined || v === undefined) continue;
    // A value 20 times larger or smaller changed its unit (Bastionbreaker's buff duration 90 →
    // 25000: seconds to milliseconds), not its strength.
    if (o !== 0 && v !== 0 && (Math.abs(v / o) >= UNIT_CHANGE || Math.abs(o / v) >= UNIT_CHANGE))
      return null;
    const r = o === 0 ? Math.sign(v) : (v - o) / Math.abs(o);
    sum += Math.max(-1, Math.min(1, r));
    count++;
  }
  return count === 0 ? null : sum / count;
}

/** Below this |weight| a change is minor. */
export const MINOR_WEIGHT = 0.05;
/** Below this total weight a champion or item is only adjusted. */
export const ADJUSTED_TOTAL = 0.02;
/** Mixed when the smaller side is at least this share of the larger. */
export const MIXED_RATIO = 0.5;
/** Reworked from this many values appearing or disappearing. */
export const REWORK_COUNT = 5;

/** Readable words of a code name: 'bonusAdRatio' → 'Bonus AD ratio'. */
export function humanize(name: string): string {
  if (/^\{[0-9a-f]{8}\}$/i.test(name)) return 'Unnamed value';
  const ACRONYMS = new Set(['AD', 'AP', 'HP', 'MR', 'AS', 'MS', 'CDR', 'AOE']);
  /** Riot's abbreviations: 'BADRatio' (bonus AD), 'RAPRatio' (the R's AP), 'DamageAPRatioTT'. */
  const WORDS: Record<string, string> = { BAD: 'bonus AD', RAP: 'AP', TT: '(tooltip)' };
  const words = name
    .replace(/_/g, ' ')
    .replace(/([A-Z]{2})to([A-Z])/g, '$1 to $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const upper = w.toUpperCase();
      if (WORDS[w] !== undefined) return WORDS[w];
      if (ACRONYMS.has(upper)) return upper;
      if (w.length > 1 && w === upper && /^[A-Z]+$/.test(w)) return w;
      return w.toLowerCase();
    });
  return capitalize(words.join(' '));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Lower-cases the first letter unless it starts an abbreviation ('AD ratio'). */
const uncapitalize = (s: string) =>
  /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);

function labelOf(valueName: string, calc: string | null): string {
  const value = humanize(valueName);
  if (!calc || /^\{[0-9a-f]{8}\}$/i.test(calc)) return value;
  return `${humanize(calc)} · ${uncapitalize(value)}`;
}

/** Classifies one stored change for a champion with this damage split (null: unknown). */
export function classifyChange(
  change: PatchValueChange,
  damage: DamageShares | null,
): Omit<PatchNoteChange, 'spellNames'> {
  const calculation = calculationOf(change);
  const rule = ruleOf({ ...change, calculation });
  const rel = relativeChange(change.oldValues, change.newValues);
  const signed = rel === null || rule.better === null ? 0 : rule.better === 'higher' ? rel : -rel;
  const relevance = relevanceOf(rule, change.valueName, damage);
  const weight = signed * relevance;
  const direction: PatchNoteDirection = signed > 0 ? 'buff' : signed < 0 ? 'nerf' : 'neutral';
  const values = [...(change.oldValues ?? []), ...(change.newValues ?? [])];
  return {
    label: labelOf(change.valueName, calculation),
    calculation,
    valueName: change.valueName,
    oldValues: change.oldValues,
    newValues: change.newValues,
    unit: unitOf(rule, change.valueName, values),
    category: rule.category,
    direction,
    magnitude: signed,
    relevance,
    weight,
    minor: direction !== 'neutral' && Math.abs(weight) < MINOR_WEIGHT,
  };
}

const sameValues = (a: readonly number[] | null, b: readonly number[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]));

/**
 * Classifies a champion's (or item's) changes, the same change in several game objects merged
 * into one (its `spellNames` listing them), in the stored order.
 */
export function classifyChanges(
  changes: readonly PatchValueChange[],
  damage: DamageShares | null,
): (PatchNoteChange & { slot: string | null })[] {
  const out: (PatchNoteChange & { slot: string | null })[] = [];
  for (const c of changes) {
    const twin = out.find(
      (o) =>
        o.slot === c.slot &&
        o.calculation === calculationOf(c) &&
        o.valueName === c.valueName &&
        o.valueName !== 'added' &&
        o.valueName !== 'removed' &&
        sameValues(o.oldValues, c.oldValues) &&
        sameValues(o.newValues, c.newValues),
    );
    if (twin) {
      if (c.spellName && !twin.spellNames.includes(c.spellName)) twin.spellNames.push(c.spellName);
      continue;
    }
    out.push({
      slot: c.slot,
      spellNames: c.spellName ? [c.spellName] : [],
      ...classifyChange(c, damage),
    });
  }
  return out;
}

/** Overall verdict of classified changes (see the module comment, step 5). */
export function verdictOf(
  status: 'changed' | 'new' | 'removed',
  changes: readonly PatchNoteChange[],
): PatchNoteVerdictSummary {
  let buffWeight = 0;
  let nerfWeight = 0;
  for (const c of changes) {
    if (c.weight > 0) buffWeight += c.weight;
    else nerfWeight -= c.weight;
  }
  const score = buffWeight - nerfWeight;
  const reworkedValues = changes.filter((c) => c.oldValues === null || c.newValues === null).length;
  let verdict: PatchNoteVerdict;
  if (status !== 'changed') verdict = status;
  else if (reworkedValues >= REWORK_COUNT) verdict = 'reworked';
  else if (buffWeight + nerfWeight < ADJUSTED_TOTAL) verdict = 'adjusted';
  else if (Math.min(buffWeight, nerfWeight) >= MIXED_RATIO * Math.max(buffWeight, nerfWeight))
    verdict = 'mixed';
  else verdict = buffWeight > nerfWeight ? 'buff' : 'nerf';
  return { verdict, score, buffWeight, nerfWeight };
}

const SLOT_ORDER: readonly PatchNoteSlot[] = ['P', 'Q', 'W', 'E', 'R', 'base', 'other'];

/** Changes grouped by slot, in slot order (an unknown slot counts as `other`). */
export function groupBySlot(
  changes: readonly (PatchNoteChange & { slot: string | null })[],
): { slot: PatchNoteSlot; changes: PatchNoteChange[] }[] {
  const groups = new Map<PatchNoteSlot, PatchNoteChange[]>();
  for (const { slot, ...change } of changes) {
    const key = (SLOT_ORDER as readonly string[]).includes(slot ?? '')
      ? (slot as PatchNoteSlot)
      : 'other';
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  return SLOT_ORDER.flatMap((slot) => {
    const list = groups.get(slot);
    return list ? [{ slot, changes: list }] : [];
  });
}

/** Alphabetical by name (accents and case ignored), so a champion or an item is easy to find. */
export function compareNames(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

/** Thresholds of the stats shown next to the changes. */
export const PATCH_NOTES_CONFIG = {
  /** A measured damage split needs this many games of the champion (else the next source). */
  minTraitGames: 100,
  /** "Builds it": completed (or started with) in at least this share of its games… */
  minItemShare: 0.15,
  /** …of a champion + role with at least this many games on the patch. */
  minRoleGames: 500,
  /** Observed win rate change: at least this many games of the role on each patch… */
  minObservedGames: 500,
  /** …in a main role: at least this share of the champion's games on the patch. */
  mainRoleShare: 0.1,
} as const;

/**
 * The damage split of a champion: the first trait row (in the order given: the patch's own, then
 * the newest kept) with enough games, else Data Dragon's attack / magic ratings, else half and
 * half.
 */
export function damageSplitOf(
  traits: readonly ChampionTraitRow[],
  rating: { attack: number; magic: number } | undefined,
): PatchNoteDamageSplit {
  const row = traits.find((t) => t.games >= PATCH_NOTES_CONFIG.minTraitGames);
  if (row) {
    return {
      physical: row.physicalShare,
      magic: row.magicShare,
      true: row.trueShare,
      source: 'stats',
      patch: row.patch,
      games: row.games,
    };
  }
  if (rating && rating.attack + rating.magic > 0) {
    const total = rating.attack + rating.magic;
    return {
      physical: rating.attack / total,
      magic: rating.magic / total,
      true: 0,
      source: 'ddragon',
      patch: null,
      games: 0,
    };
  }
  return { physical: 0.5, magic: 0.5, true: 0, source: 'none', patch: null, games: 0 };
}

/**
 * A champion's win rate in its main roles on `current` vs `previous`, each centred on its role's
 * average on that patch (the whole role's wins / games), with enough games on both patches.
 * Biggest role first.
 */
export function observedChanges(
  championId: number,
  roleStats: readonly RoleStatRow[],
  current: PatchId,
  previous: PatchId,
): PatchNoteObserved[] {
  const roleAverage = new Map<string, { games: number; wins: number }>();
  for (const r of roleStats) {
    const key = `${r.patch}|${r.position}`;
    const acc = roleAverage.get(key) ?? { games: 0, wins: 0 };
    acc.games += r.games;
    acc.wins += r.wins;
    roleAverage.set(key, acc);
  }
  const avg = (patch: PatchId, role: Position) => {
    const a = roleAverage.get(`${patch}|${role}`);
    return a && a.games > 0 ? a.wins / a.games : 0.5;
  };
  const own = roleStats.filter((r) => r.championId === championId);
  const total = own.filter((r) => r.patch === current).reduce((s, r) => s + r.games, 0);
  const { minObservedGames, mainRoleShare } = PATCH_NOTES_CONFIG;
  const out: PatchNoteObserved[] = [];
  for (const cur of own) {
    if (cur.patch !== current || cur.games < Math.max(minObservedGames, mainRoleShare * total))
      continue;
    const prev = own.find((r) => r.patch === previous && r.position === cur.position);
    if (!prev || prev.games < minObservedGames) continue;
    const winRate = cur.wins / cur.games;
    const previousWinRate = prev.wins / prev.games;
    out.push({
      role: cur.position,
      delta: winRate - avg(current, cur.position) - (previousWinRate - avg(previous, cur.position)),
      winRate,
      previousWinRate,
      games: cur.games,
      previousGames: prev.games,
    });
  }
  return out.sort((a, b) => b.games - a.games);
}

/** Who builds each item: champion + roles at `minItemShare` or more, most frequent first. */
export function itemUsersOf(
  rows: readonly {
    itemId: number;
    championId: number;
    position: Position;
    games: number;
    roleGames: number;
  }[],
): Map<number, PatchNoteItemUser[]> {
  const out = new Map<number, PatchNoteItemUser[]>();
  for (const r of rows) {
    if (r.roleGames <= 0) continue;
    const share = Math.min(1, r.games / r.roleGames);
    if (share < PATCH_NOTES_CONFIG.minItemShare) continue;
    const list = out.get(r.itemId) ?? [];
    list.push({ championId: r.championId, role: r.position, share, games: r.games });
    out.set(r.itemId, list);
  }
  for (const list of out.values())
    list.sort((a, b) => b.share - a.share || a.championId - b.championId);
  return out;
}
