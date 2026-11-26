/**
 * Gameplay diff of two patches' game files (Community Dragon `.bin.json`): which values of a
 * champion (spells, base stats) or of an item changed, old and new. Pure: the files are parsed
 * JSON, fetched elsewhere. See docs/architecture.md (Worker, patch changes).
 *
 * Only numbers (and booleans, as 0/1) are compared: strings are names, references, paths and
 * tooltips. Whatever does not change the game on Summoner's Rift is dropped: tool and client data,
 * other game modes (Arena = `cherry`…), recommended skill orders, bot jungle paths, skins, icons and
 * particles. Spell per-rank arrays have 7 slots: slot 0 is unused and the slots above the spell's
 * max rank are padding, so only ranks 1..max are compared and stored.
 */

export type ChangeSlot = 'Q' | 'W' | 'E' | 'R' | 'P' | 'base' | 'other';

export interface ValueChange {
  /** Champions: the ability the value belongs to (`P` passive, `base` base stats); items: null. */
  slot: ChangeSlot | null;
  /** The game object holding the value (spell `EzrealR`, `EzrealEMissile`…); null for base stats and items. */
  spellName: string | null;
  /** The spell calculation a formula part belongs to (`Damage`), else null. */
  calculation: string | null;
  /** Readable name: data value (`BaseDamage`), `Cooldown`, `Cost`, a ratio (`bonusAdRatio`)… */
  valueName: string;
  /** Per rank for a spell value (rank 1 first), else one value; null when absent on that side. */
  oldValues: number[] | null;
  newValues: number[] | null;
  /** Path in the game file, for debugging. */
  path: string;
}

export type ChangeStatus = 'changed' | 'new' | 'removed';

export interface EntityChanges<K> {
  key: K;
  status: ChangeStatus;
  /** Empty for a new or removed entity. */
  changes: ValueChange[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** Game modes whose overrides live next to the Summoner's Rift values. */
const MODE_NAMES = [
  'cherry',
  'strawberry',
  'kiwi',
  'ultbook',
  'brawl',
  'urf',
  'aram',
  'arena',
  'swarm',
  'nexusblitz',
  'oneforall',
  'tutorial',
  'doombots',
];
const MODE_PREFIX = new RegExp(`^(${MODE_NAMES.join('|')})`, 'i');

/** Keys whose subtree never changes the game on Summoner's Rift (exact, case-insensitive). */
const NOISE_KEYS = new Set(
  [
    '__type',
    'characterToolData',
    'mClientData',
    'mItemDataClient',
    'DataValuesModeOverride',
    'RecSpellRankUpInfos',
    'JunglePath',
    'tooltipOnly',
    'SkinFilter',
    'skinIds',
    'mEducationToolData',
    'healthBarHeight',
    'selectionHeight',
    'selectionRadius',
    'mVFXResourceResolver',
    'mFloatVarsDecimals',
    'mPrecision',
    'mDisplayAsPercent',
    'mSimpleTooltipCalculationDisplay',
    'mItemGroups',
    'mItemAdviceAttributes',
    'mItemCalloutSpectator',
    'epicness',
    'LastMajorChangeMajorPatchVersion',
    'LastMajorChangeMinorPatchVersion',
    'mMinimapIconRotation',
    'mUseMinimapTargeting',
    'RemoveOnPopCharacterData',
    'RemoveOnPushCharacterData',
    'bHaveHitBone',
    'bHaveHitEffect',
    'outlineBBoxExpansion',
  ].map((k) => k.toLowerCase()),
);

/** Key fragments of presentation-only data (icons, particles, sounds, animations, skins). */
const NOISE_FRAGMENTS =
  /icon|particle|vfx|sound|animation|skin\d|portrait|material|cherry|tooltip|display/i;

function isNoiseKey(key: string): boolean {
  const lower = key.toLowerCase();
  return NOISE_KEYS.has(lower) || MODE_NAMES.includes(lower) || NOISE_FRAGMENTS.test(key);
}

const isObject = (x: Json | undefined): x is JsonObject =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** Stat ids of the game's formula parts (`mStat`, absent = 0). */
const STAT_NAMES: Record<number, string> = {
  0: 'Ap',
  1: 'Armor',
  2: 'Ad',
  3: 'AttackSpeed',
  5: 'Mr',
  6: 'MoveSpeed',
  7: 'CritChance',
  8: 'CritDamage',
  10: 'AbilityHaste',
  11: 'Health',
  12: 'CurrentHealth',
  13: 'MissingHealth',
  15: 'LifeSteal',
  19: 'MagicPenFlat',
  22: 'Lethality',
  28: 'AttackRange',
};

/** `bonusAdRatio`, `apRatio`, `baseHealthRatio`… from a formula part's stat and formula (0 total, 1 base, 2 bonus). */
export function ratioName(stat: number, formula: number): string {
  const name = STAT_NAMES[stat] ?? `Stat${stat}`;
  if (formula === 1) return `base${name}Ratio`;
  if (formula === 2) return `bonus${name}Ratio`;
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}Ratio`;
}

/** Rounds the game's float32 values (1.100000023841858 → 1.1). */
function clean(x: number): number {
  return Number(x.toPrecision(7));
}

/** `mStartValue` → `StartValue`; `attackRangeModifiable` → `attackRange`. */
function readable(key: string): string {
  const k = /^m[A-Z]/.test(key) ? key.slice(1) : key;
  return k.replace(/Modifiable$/, '');
}

/**
 * One compared value: its values as in the file, its readable name, its spell calculation if any,
 * and 1 when the values are a spell's per-rank array (sliced to the ranks when diffed, with the
 * newer build's max rank: a spell moved to another ability keeps comparable values).
 */
export type SnapshotLeaf = [
  values: number[],
  valueName: string,
  calculation?: string | null,
  perRank?: 1,
];
/** Values of one object by stable path. */
export type Leaves = Record<string, SnapshotLeaf>;

interface WalkContext {
  /** Inside a spell: its 7- and 6-slot arrays are per rank. */
  spell: boolean;
  calculation: string | null;
  /** Appended to the value names (`Level6` inside a level breakpoint). */
  nameSuffix: string;
}

const HASH_KEY = /^\{[0-9a-f]{8}\}$/;

/**
 * A spell's per-rank values, rank 1 first: 7-slot arrays (data values, cooldowns) start with an
 * unused slot 0, 6-slot arrays (costs) start at rank 1; slots above the max rank are padding.
 */
function perRank(nums: number[], maxRank: number): number[] {
  if (nums.length === 7) return nums.slice(1, maxRank + 1);
  if (nums.length === 6) return nums.slice(0, maxRank);
  return nums;
}

/** A leaf's compared values: a per-rank array sliced to ranks 1..maxRank. */
function leafValues(leaf: SnapshotLeaf, maxRank: number | null): number[] {
  return leaf[3] === 1 && maxRank !== null ? perRank(leaf[0], maxRank) : leaf[0];
}

/**
 * Flattens an object into numeric leaves keyed by a stable path: named lists (spell data values,
 * item data values) and formula parts are keyed by name rather than position, so an inserted entry
 * does not shift the others.
 */
function flatten(root: JsonObject, spell: boolean): Leaves {
  const leaves: Leaves = {};
  const add = (
    path: string,
    values: number[],
    valueName: string,
    ctx: WalkContext,
    ranked = false,
  ) => {
    const leaf: SnapshotLeaf = [values.map(clean), `${valueName}${ctx.nameSuffix}`];
    if (ctx.calculation !== null || ranked) leaf.push(ctx.calculation);
    if (ranked) leaf.push(1);
    leaves[path] = leaf;
  };

  const walk = (node: Json, path: string, name: string, ctx: WalkContext): void => {
    if (typeof node === 'number' || typeof node === 'boolean') {
      add(path, [Number(node)], name, ctx);
      return;
    }
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((v) => typeof v === 'number')) {
        // A spell's per-rank array: slot 0 unused, ranks 1..max.
        const ranked = ctx.spell && (node.length === 7 || node.length === 6);
        add(path, node as number[], name, ctx, ranked);
        return;
      }
      const used = new Map<string, number>();
      node.forEach((item, i) => {
        if (!isObject(item)) return;
        let key = String(i);
        let childName = name;
        const named = typeof item.name === 'string' ? item.name : item.mName;
        if (typeof item.mLevel === 'number') {
          // a level breakpoint: keyed and named by its level
          walk(item, `${path}/level${item.mLevel}`, name, {
            ...ctx,
            nameSuffix: `Level${item.mLevel}`,
          });
          return;
        }
        if (typeof named === 'string') {
          if (MODE_PREFIX.test(named)) return;
          key = named;
          childName = named;
        } else if (typeof item.__type === 'string' && item.__type.endsWith('CalculationPart')) {
          ({ key, name: childName } = formulaPartKey(item, i));
        }
        const n = used.get(key) ?? 0;
        used.set(key, n + 1);
        if (n > 0) key = `${key}#${n}`;
        walk(item, `${path}/${key}`, childName, ctx);
      });
      return;
    }
    if (!isObject(node)) return;
    const hasValues = Array.isArray(node.values);
    for (const [key, value] of Object.entries(node)) {
      if (isNoiseKey(key)) continue;
      // a per-rank container's hashed default (its rank 1 value again)
      if (hasValues && HASH_KEY.test(key)) continue;
      if (key === 'mLevel' && ctx.nameSuffix) continue;
      let childName = name;
      if (key === 'values' || key === 'value' || key === 'baseValue' || key === 'mValue') {
        // the value of its parent: keep the parent's name
      } else if (
        key === 'mCoefficient' &&
        typeof node.__type === 'string' &&
        node.__type.endsWith('CalculationPart')
      ) {
        // a stat ratio: its name comes from the part (see formulaPartKey)
      } else if (key === 'mSpellCalculations' && isObject(value)) {
        for (const [calc, part] of Object.entries(value)) {
          if (/tooltip/i.test(calc)) continue; // shown, not used
          walk(part, `${path}/${key}/${calc}`, calc, { ...ctx, calculation: calc });
        }
        continue;
      } else if (key === 'cooldownTime' || key === 'Cooldown') {
        childName = 'Cooldown';
      } else if (key === 'mana' || key === 'manaValues' || key === 'ManaCost') {
        childName = 'Cost';
      } else if (key === 'mEffectAmount') {
        if (Array.isArray(value)) {
          value.forEach((effect, i) => {
            walk(effect, `${path}/${key}[${i}]`, `Effect${i + 1}Amount`, ctx);
          });
        }
        continue;
      } else if (key === 'mStat' || key === 'mStatFormula') {
        continue; // folded into the ratio's name
      } else if (key === 'mFormulaParts' || key === 'mSubparts') {
        // keyed lists: keep the current name until a part names itself
      } else {
        childName = readable(key);
      }
      walk(value, `${path}/${key}`, childName, ctx);
    }
  };

  walk(root, '', '', { spell, calculation: null, nameSuffix: '' });
  return leaves;
}

/** A formula part's stable key and readable name: `bonusAdRatio` for a stat ratio, the data value it reads otherwise. */
function formulaPartKey(part: JsonObject, index: number): { key: string; name: string } {
  if (typeof part.mCoefficient === 'number' || 'mStat' in part || 'mStatFormula' in part) {
    const stat = typeof part.mStat === 'number' ? part.mStat : 0;
    const formula = typeof part.mStatFormula === 'number' ? part.mStatFormula : 0;
    if (typeof part.mDataValue === 'string') {
      const name = `${part.mDataValue}:${ratioName(stat, formula)}`;
      return { key: name, name };
    }
    const name = ratioName(stat, formula);
    return { key: name, name };
  }
  if (typeof part.mDataValue === 'string')
    return { key: `dv:${part.mDataValue}`, name: part.mDataValue };
  return { key: String(index), name: String(part.__type ?? index) };
}

const isZero = (values: number[]) => values.length === 1 && values[0] === 0;

function sameValues(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Changed leaves of one object: old and new flattened the same way. */
function diffLeaves(
  oldLeaves: Leaves,
  newLeaves: Leaves,
  pathPrefix: string,
  slot: ChangeSlot | null,
  spellName: string | null,
  maxRank: number | null,
): ValueChange[] {
  const out: ValueChange[] = [];
  const keys = new Set([...Object.keys(oldLeaves), ...Object.keys(newLeaves)]);
  for (const key of keys) {
    const leafA = oldLeaves[key];
    const leafB = newLeaves[key];
    const a = leafA && leafValues(leafA, maxRank);
    const b = leafB && leafValues(leafB, maxRank);
    if (a && b && sameValues(a, b)) continue;
    // A value left out of the file is the type's default: 0 (or false).
    if (!a && b && isZero(b)) continue;
    if (!b && a && isZero(a)) continue;
    const leaf = (leafB ?? leafA) as SnapshotLeaf;
    const valueName = leaf[1] || key.split('/').pop() || key;
    // A field known only by its hash that appears or disappears: the file's layout, not a value.
    if ((!a || !b) && HASH_KEY.test(valueName)) continue;
    out.push({
      slot,
      spellName,
      calculation: leaf[2] ?? null,
      valueName,
      oldValues: a ?? null,
      newValues: b ?? null,
      path: `${pathPrefix}${key}`,
    });
  }
  return withoutMoves(out);
}

/**
 * Drops a value that only moved inside its object (an unnamed list entry at another position):
 * a removed and an added value with the same name and values cancel out.
 */
function withoutMoves(changes: ValueChange[]): ValueChange[] {
  const key = (c: ValueChange, values: number[] | null) =>
    JSON.stringify([c.calculation, c.valueName, values]);
  const added = new Map<string, number>();
  for (const c of changes) {
    if (c.oldValues === null)
      added.set(key(c, c.newValues), (added.get(key(c, c.newValues)) ?? 0) + 1);
  }
  const cancelled = new Map<string, number>();
  const kept = changes.filter((c) => {
    if (c.newValues !== null || c.oldValues === null) return true;
    const k = key(c, c.oldValues);
    const left = added.get(k) ?? 0;
    if (left === 0) return true;
    added.set(k, left - 1);
    cancelled.set(k, (cancelled.get(k) ?? 0) + 1);
    return false;
  });
  return kept.filter((c) => {
    if (c.oldValues !== null) return true;
    const k = key(c, c.newValues);
    const left = cancelled.get(k) ?? 0;
    if (left === 0) return true;
    cancelled.set(k, left - 1);
    return false;
  });
}

/** Drops a value stored twice (`cooldownTime` and `Cooldown.values`) with the same change. */
function dedupe(changes: ValueChange[]): ValueChange[] {
  const seen = new Set<string>();
  return changes.filter((c) => {
    const k = JSON.stringify([
      c.slot,
      c.spellName,
      c.calculation,
      c.valueName,
      c.oldValues,
      c.newValues,
    ]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const SLOTS = ['Q', 'W', 'E', 'R'] as const;
const DEFAULT_MAX_RANK: Record<ChangeSlot, number> = {
  Q: 5,
  W: 5,
  E: 5,
  R: 3,
  P: 6,
  base: 6,
  other: 6,
};

interface ChampionLayout {
  rootKey: string;
  /** Slot of each spell object of the file. */
  slotOf(key: string): ChangeSlot;
  maxRank: Record<ChangeSlot, number>;
}

function findRoot(file: JsonObject, alias: string): string | null {
  const roots = Object.keys(file).filter(
    (k) => k.endsWith('/CharacterRecords/Root') && isObject(file[k]),
  );
  return (
    roots.find((k) => k.split('/')[1]?.toLowerCase() === alias.toLowerCase()) ?? roots[0] ?? null
  );
}

function levelCount(spell: Json | undefined): number | null {
  if (!isObject(spell) || !isObject(spell.mSpell)) return null;
  const client = spell.mSpell.mClientData;
  const tooltip = isObject(client) ? client.mTooltipData : undefined;
  const lists = isObject(tooltip) ? tooltip.mLists : undefined;
  const levelUp = isObject(lists) ? lists.LevelUp : undefined;
  const n = isObject(levelUp) ? levelUp.levelCount : undefined;
  return typeof n === 'number' && n >= 1 && n <= 6 ? n : null;
}

function championLayout(file: JsonObject, alias: string): ChampionLayout | null {
  const rootKey = findRoot(file, alias);
  if (rootKey === null) return null;
  const root = file[rootKey] as JsonObject;
  const strings = (x: Json | undefined): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
  const abilities = new Set(strings(root.mAbilities));
  const spells = strings(root.spells);
  const maxRank = { ...DEFAULT_MAX_RANK };
  /** [exact spell path or ability prefix, slot] */
  const owners: { path: string; prefix: boolean; slot: ChangeSlot }[] = [];
  spells.slice(0, 4).forEach((spellPath, i) => {
    const slot = SLOTS[i] as ChangeSlot;
    owners.push({ path: spellPath, prefix: false, slot });
    const ability = spellPath.slice(0, spellPath.lastIndexOf('/'));
    if (abilities.has(ability)) {
      owners.push({ path: `${ability}/`, prefix: true, slot });
      abilities.delete(ability);
    }
    const n = levelCount(file[spellPath]);
    if (n !== null) maxRank[slot] = n;
  });
  const passivePath = root.mCharacterPassiveSpell;
  if (typeof passivePath === 'string') owners.push({ path: passivePath, prefix: false, slot: 'P' });
  // The other abilities (a transformed form's spells, the passive): by name, else by type.
  for (const ability of abilities) {
    const obj = file[ability];
    const letter = /([QWER])Ability$/.exec(ability)?.[1] as ChangeSlot | undefined;
    const type = isObject(obj) ? obj.mType : undefined;
    const slot: ChangeSlot = letter ?? (type === 3 ? 'P' : type === 2 ? 'R' : 'other');
    owners.push({ path: `${ability}/`, prefix: true, slot });
  }
  const passiveName = typeof root.passiveSpell === 'string' ? root.passiveSpell : null;
  return {
    rootKey,
    maxRank,
    slotOf(key) {
      for (const o of owners) {
        if (o.prefix ? key.startsWith(o.path) : key === o.path) return o.slot;
      }
      const obj = file[key];
      if (passiveName && isObject(obj) && obj.mScriptName === passiveName) return 'P';
      return 'other';
    },
  };
}

/** One spell object of a champion: where it is in the file, its slot and its values. */
export interface SpellSnapshot {
  key: string;
  name: string;
  slot: ChangeSlot;
  /** Of its ability (from the file's tooltip data, else 5 for Q/W/E, 3 for R, 6 otherwise). */
  maxRank: number;
  leaves: Leaves;
}

/** What the diff compares of one champion file: base stats and spells by script name. */
export interface ChampionSnapshot {
  rootKey: string;
  base: Leaves;
  /**
   * By script name: an object moved or renamed in the file (Lux's `LuxRMis` moved under its
   * ability, Veigar's missile keyed by a hash) is still the same spell.
   */
  spells: Record<string, SpellSnapshot>;
}

/**
 * The gameplay values of one champion file (`<alias>.bin.json`), compact enough to be stored and
 * diffed against a later build without the file.
 */
export function extractChampion(alias: string, file: unknown): ChampionSnapshot {
  if (!isObject(file as Json)) throw new Error(`${alias}: not a game file`);
  const f = file as JsonObject;
  const layout = championLayout(f, alias);
  if (!layout) throw new Error(`${alias}: no character record`);
  const spells: Record<string, SpellSnapshot> = {};
  for (const [key, value] of Object.entries(f)) {
    if (!isObject(value) || value.__type !== 'SpellObject' || !isObject(value.mSpell)) continue;
    const last = key.slice(key.lastIndexOf('/') + 1);
    const script = value.mScriptName ?? value.ObjectName;
    const name = typeof script === 'string' && script !== '' ? script : last;
    if (NOISE_FRAGMENTS.test(name) || MODE_PREFIX.test(name)) continue;
    const slot = layout.slotOf(key);
    spells[spells[name] ? key : name] = {
      key,
      name,
      slot,
      maxRank: layout.maxRank[slot],
      leaves: flatten(value.mSpell, true),
    };
  }
  return {
    rootKey: layout.rootKey,
    base: flatten(f[layout.rootKey] as JsonObject, false),
    spells,
  };
}

const SLOT_ORDER: Record<ChangeSlot, number> = { base: 0, P: 1, Q: 2, W: 3, E: 4, R: 5, other: 6 };

/**
 * Gameplay changes of one champion between two builds (see `extractChampion`). `before` null: the
 * champion is new. Returns null when nothing changed.
 */
export function diffChampionSnapshots(
  alias: string,
  before: ChampionSnapshot | null,
  after: ChampionSnapshot,
): EntityChanges<string> | null {
  if (!before) return { key: alias, status: 'new', changes: [] };
  const changes = diffLeaves(before.base, after.base, after.rootKey, 'base', null, null);
  for (const id of new Set([...Object.keys(before.spells), ...Object.keys(after.spells)])) {
    const a = before.spells[id];
    const b = after.spells[id];
    const entry = (b ?? a) as SpellSnapshot;
    if (!a || !b) {
      // A whole spell object added or removed: one row, not one per value.
      changes.push({
        slot: entry.slot,
        spellName: entry.name,
        calculation: null,
        valueName: a ? 'removed' : 'added',
        oldValues: null,
        newValues: null,
        path: entry.key,
      });
      continue;
    }
    changes.push(...diffLeaves(a.leaves, b.leaves, `${b.key}/mSpell`, b.slot, b.name, b.maxRank));
  }
  const out = dedupe(changes).sort(
    (x, y) =>
      SLOT_ORDER[x.slot as ChangeSlot] - SLOT_ORDER[y.slot as ChangeSlot] ||
      (x.spellName ?? '').localeCompare(y.spellName ?? '') ||
      x.path.localeCompare(y.path),
  );
  return out.length > 0 ? { key: alias, status: 'changed', changes: out } : null;
}

/** `diffChampionSnapshots` on two files (`oldFile` null: the champion is new). */
export function diffChampion(
  alias: string,
  oldFile: unknown,
  newFile: unknown,
): EntityChanges<string> | null {
  const after = extractChampion(alias, newFile);
  return diffChampionSnapshots(alias, oldFile ? extractChampion(alias, oldFile) : null, after);
}

/** Items are Summoner's Rift (and other normal maps) items below this id; mode copies (Arena 22xxxx, 44xxxx…) above. */
export const MAX_ITEM_ID = 100_000;

/** Values of the items worth comparing, by item id. */
export type ItemsSnapshot = Record<string, Leaves>;

/** The `ItemData` objects of `items.cdtb.bin.json` worth comparing, flattened, by item id. */
export function extractItems(file: unknown): ItemsSnapshot {
  const out: ItemsSnapshot = {};
  if (!isObject(file as Json)) throw new Error('items: not a game file');
  for (const value of Object.values(file as JsonObject)) {
    if (!isObject(value) || value.__type !== 'ItemData') continue;
    const id = value.itemID;
    if (typeof id !== 'number' || id <= 0 || id >= MAX_ITEM_ID) continue;
    out[String(id)] = flatten(value, false);
  }
  return out;
}

/** Gameplay changes of the items between two builds (see `extractItems`), by item id. */
export function diffItems(before: ItemsSnapshot, after: ItemsSnapshot): EntityChanges<number>[] {
  const out: EntityChanges<number>[] = [];
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map(Number)
    .sort((x, y) => x - y);
  for (const id of ids) {
    const a = before[String(id)];
    const b = after[String(id)];
    if (!a) {
      out.push({ key: id, status: 'new', changes: [] });
      continue;
    }
    if (!b) {
      out.push({ key: id, status: 'removed', changes: [] });
      continue;
    }
    const changes = diffLeaves(a, b, `Items/${id}`, null, null, null).sort((x, y) =>
      x.path.localeCompare(y.path),
    );
    if (changes.length > 0) out.push({ key: id, status: 'changed', changes });
  }
  return out;
}
