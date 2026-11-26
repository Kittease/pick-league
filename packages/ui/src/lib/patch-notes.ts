/** Pure view logic of the patch notes page: the selector's entries and the values' formatting. */
import type {
  PatchChangeSetSummary,
  PatchChangesIndexResponse,
  PatchNoteChange,
  PatchNoteSlot,
  PatchNotesItemUsers,
  PatchNotesResponse,
  PatchNoteUnit,
  PatchNoteVerdict,
  Position,
} from '@pick-league/shared';

/** What the page shows: a patch's diff (`build` undefined) or one of its builds. */
export interface PatchNotesSelection {
  patch: string;
  build?: string;
}

export interface SelectorHotfix {
  build: string;
  detectedAt: string;
  changedChampions: number;
  changedItems: number;
}

export interface SelectorPatch {
  patch: string;
  /** The patch diff's summary, null when the worker only saw the patch's hotfixes. */
  diff: PatchChangeSetSummary | null;
  /** Hotfixes that changed gameplay, in build order. */
  hotfixes: SelectorHotfix[];
  /** Hotfix builds without any gameplay change (hidden, counted). */
  quietHotfixes: number;
}

/** The selector: newest patch first, each with its gameplay hotfixes and a count of the others. */
export function selectorPatches(index: PatchChangesIndexResponse, limit = 6): SelectorPatch[] {
  return index.patches.slice(0, limit).map(({ patch, sets }) => {
    const hotfixes = sets.filter((s) => s.kind === 'hotfix');
    return {
      patch,
      diff: sets.find((s) => s.kind === 'patch') ?? null,
      hotfixes: hotfixes
        .filter((s) => s.gameplayChanged)
        .map((s) => ({
          build: s.build,
          detectedAt: s.detectedAt,
          changedChampions: s.changedChampions,
          changedItems: s.changedItems,
        })),
      quietHotfixes: hotfixes.filter((s) => !s.gameplayChanged).length,
    };
  });
}

/** The selection for a patch entry: its diff, else its first gameplay hotfix. */
export function patchSelection(entry: SelectorPatch): PatchNotesSelection {
  if (entry.diff || entry.hotfixes.length === 0) return { patch: entry.patch };
  return { patch: entry.patch, build: entry.hotfixes[0]?.build };
}

export const sameSelection = (a: PatchNotesSelection | null, b: PatchNotesSelection) =>
  a !== null && a.patch === b.patch && (a.build ?? null) === (b.build ?? null);

/** "1 champion", "13 champions". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Nov 21" (UTC: every viewer sees the same day as the worker's logs). */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** At most `digits` decimals, trailing zeros dropped: 16.5, 0.67, 350. */
function trim(x: number, digits: number): string {
  return String(Number(x.toFixed(digits)));
}

/** One value in its unit: 1.15 → "115%", 9 → "9%" (percent points), 16.5 → "16.5s", 350. */
export function formatValue(value: number, unit: PatchNoteUnit): string {
  switch (unit) {
    case 'percent':
      return `${trim(value * 100, 2)}%`;
    case 'percentPoints':
      return `${trim(value, 2)}%`;
    case 'seconds':
      return `${trim(value, 2)}s`;
    default:
      return trim(value, 2);
  }
}

/** Per-rank values: "350 / 550 / 750", one value when every rank has it; "—" when absent. */
export function formatValues(values: readonly number[] | null, unit: PatchNoteUnit): string {
  if (!values || values.length === 0) return '—';
  const first = values[0] as number;
  if (values.every((v) => v === first)) return formatValue(first, unit);
  return values.map((v) => formatValue(v, unit)).join(' / ');
}

/** A change's identity in its list (value, calculation, game objects and values). */
export function changeKey(
  c: Pick<PatchNoteChange, 'valueName' | 'calculation' | 'spellNames' | 'oldValues' | 'newValues'>,
): string {
  return [c.valueName, c.calculation, c.spellNames.join(','), c.oldValues, c.newValues].join('|');
}

/** "350 / 550 / 750 → 350 / 600 / 850". */
export function changeText(change: Pick<PatchNoteChange, 'oldValues' | 'newValues' | 'unit'>) {
  return {
    from: formatValues(change.oldValues, change.unit),
    to: formatValues(change.newValues, change.unit),
  };
}

export const SLOT_LABEL: Record<PatchNoteSlot, string> = {
  P: 'Passive',
  Q: 'Q',
  W: 'W',
  E: 'E',
  R: 'R',
  base: 'Base stats',
  other: 'Other',
};

/** Data Dragon spell slot (1 = Q … 4 = R) of a key, null for passive / base / other. */
export function spellSlotNumber(slot: PatchNoteSlot): number | null {
  const i = ['Q', 'W', 'E', 'R'].indexOf(slot);
  return i < 0 ? null : i + 1;
}

export const VERDICT_LABEL: Record<PatchNoteVerdict, string> = {
  buff: 'Buff',
  nerf: 'Nerf',
  mixed: 'Mixed',
  adjusted: 'Adjusted',
  reworked: 'Reworked',
  new: 'New',
  removed: 'Removed',
};

/** Colour family of a verdict. */
export function verdictTone(verdict: PatchNoteVerdict): 'up' | 'down' | 'gold' | 'muted' {
  if (verdict === 'buff') return 'up';
  if (verdict === 'nerf') return 'down';
  if (verdict === 'mixed' || verdict === 'reworked' || verdict === 'new') return 'gold';
  return 'muted';
}

/** In-page anchors of the three sections' entries. */
export const anchors = {
  champion: (id: number) => `pn-champion-${id}`,
  item: (id: number) => `pn-item-${id}`,
  itemUsers: (id: number) => `pn-item-users-${id}`,
};

/** A changed item one champion builds often (for its links to the third section). */
export interface ChampionItemLink {
  itemId: number;
  name: string;
  verdict: PatchNoteVerdict;
  role: Position;
  share: number;
}

/** For each champion, the changed items it builds (third section), most built first. */
export function itemsByChampion(
  itemUsers: readonly PatchNotesItemUsers[],
): Map<number, ChampionItemLink[]> {
  const out = new Map<number, ChampionItemLink[]>();
  for (const item of itemUsers) {
    for (const u of item.users) {
      const list = out.get(u.championId) ?? [];
      const known = list.find((l) => l.itemId === item.itemId);
      if (known) {
        if (u.share > known.share) Object.assign(known, { role: u.role, share: u.share });
        continue;
      }
      list.push({
        itemId: item.itemId,
        name: item.name,
        verdict: item.verdict,
        role: u.role,
        share: u.share,
      });
      out.set(u.championId, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => b.share - a.share);
  return out;
}

/** Hides technical changes (and spell groups left empty) unless asked. */
export function visibleChanges<T extends { changes: PatchNoteChange[] }>(
  groups: readonly T[],
  showTechnical: boolean,
): T[] {
  if (showTechnical) return [...groups];
  return groups
    .map((g) => ({ ...g, changes: g.changes.filter((c) => c.category !== 'technical') }))
    .filter((g) => g.changes.length > 0);
}

/** Number of technical changes in a response (the toggle's label). */
export function technicalCount(notes: PatchNotesResponse): number {
  let n = 0;
  for (const c of notes.champions)
    for (const s of c.spells) n += s.changes.filter((x) => x.category === 'technical').length;
  for (const i of notes.items) n += i.changes.filter((x) => x.category === 'technical').length;
  return n;
}
