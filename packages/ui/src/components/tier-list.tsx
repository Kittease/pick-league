'use client';

import {
  type BuildResponse,
  DEFAULT_TIER_LIST_FILTERS,
  POSITIONS,
  type Position,
  type Tier,
  type TierListEntry,
  type TierListFilters,
  type TierListPlatform,
  type TierListRank,
  type TierListResponse,
  toTierListFilters,
} from '@pick-league/shared';
import { BuildDetails } from '@pick-league/ui/components/build-view';
import { ConfidencePips } from '@pick-league/ui/components/confidence-pips';
import { usePickLeagueData } from '@pick-league/ui/components/data-provider';
import { ConfidenceFilter, FilterSelect } from '@pick-league/ui/components/filter-select';
import { ChampionIcon } from '@pick-league/ui/components/game-icon';
import { Notice } from '@pick-league/ui/components/notice';
import { DeltaText } from '@pick-league/ui/components/reasons';
import { ChampionRelations } from '@pick-league/ui/components/tier-list-relations';
import { Button } from '@pick-league/ui/components/ui/button';
import { Input } from '@pick-league/ui/components/ui/input';
import { Label } from '@pick-league/ui/components/ui/label';
import { Skeleton } from '@pick-league/ui/components/ui/skeleton';
import { Switch } from '@pick-league/ui/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@pick-league/ui/components/ui/tabs';
import { useMinConfidence } from '@pick-league/ui/hooks/use-min-confidence';
import {
  enterListFromSearch,
  type RovingItemProps,
  useRoving,
} from '@pick-league/ui/hooks/use-roving';
import { IS_MAC } from '@pick-league/ui/hooks/use-shortcuts';
import { type ConfidenceLevel, meetsConfidence } from '@pick-league/ui/lib/confidence';
import {
  compact,
  confidenceLabel,
  patchesText,
  percent,
  ROLE_LABEL,
} from '@pick-league/ui/lib/format';
import {
  type EscapeAction,
  type SearchFocus,
  shortcutLabel,
  type TierListLayer,
} from '@pick-league/ui/lib/shortcuts';
import type { FlashKey } from '@pick-league/ui/lib/spells';
import type { StaticLookup } from '@pick-league/ui/lib/static-lookup';
import type { ApiResult, MasteryEntry } from '@pick-league/ui/lib/types';
import { cn } from '@pick-league/ui/lib/utils';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  HammerIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

/** A role's tier list is re-fetched after this long (the API refreshes its stats hourly, or on demand). */
const CACHE_MS = 5 * 60_000;

type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; code: string | null; message: string };

/** The tier list's lane tab: one role, or every role at once. */
type Lane = Position | 'ALL';

/** A tier list entry with the role it was ranked in (several per champion under `ALL`). */
type RoleEntry = TierListEntry & { role: Position };

/** The tier lists of the shown lane: one role's, or the 5 roles' merged by score. */
interface LaneTierList {
  patch: string;
  filters: TierListFilters;
  entries: RoleEntry[];
}

const rowKey = (e: { role: Position; championId: number }) => `${e.role}:${e.championId}`;

/**
 * Tier list of a lane (one role, or all 5 merged: scores are deltas vs each role's average, so
 * they compare across roles) and filters, cached per role + filters for a few minutes; reset
 * when the API changes.
 */
function useTierList(lane: Lane, filters: TierListFilters, apiKey: string) {
  const api = usePickLeagueData();
  const cache = useRef(new Map<string, { at: number; result: ApiResult<TierListResponse> }>());
  const [state, setState] = useState<Loaded<LaneTierList>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const lastKey = useRef(apiKey);
  const shown = useRef('');
  const { platform, rank } = filters;
  const key = `${lane}|${platform}|${rank}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce re-runs the fetch on retry
  useEffect(() => {
    if (lastKey.current !== apiKey) {
      cache.current.clear();
      lastKey.current = apiKey;
    }
    const roles: readonly Position[] = lane === 'ALL' ? POSITIONS : [lane];
    const fresh = (role: Position) => {
      const hit = cache.current.get(`${role}|${platform}|${rank}`);
      return hit?.result.ok && Date.now() - hit.at < CACHE_MS ? hit.result : null;
    };
    const merge = (results: ApiResult<TierListResponse>[]): Loaded<LaneTierList> => {
      const failed = results.find((r) => !r.ok);
      if (failed && !failed.ok)
        return { status: 'error', code: failed.code, message: failed.message };
      const lists = results.flatMap((r) => (r.ok ? [r.data] : []));
      const entries = lists
        .flatMap((l) => l.entries.map((e) => ({ ...e, role: l.role })))
        .sort((a, b) => b.score - a.score);
      return {
        status: 'ok',
        data: { patch: lists[0]?.patch ?? '', filters: { platform, rank }, entries },
      };
    };
    const cached = roles.map(fresh);
    if (cached.every((r) => r !== null)) {
      shown.current = key;
      setState(merge(cached as ApiResult<TierListResponse>[]));
      return;
    }
    let alive = true;
    // Same list re-fetched (stats refreshed): keep showing the old one until the new one lands.
    setState((prev) =>
      prev.status === 'ok' && shown.current === key ? prev : { status: 'loading' },
    );
    void Promise.all(
      roles.map(
        (role, i) =>
          cached[i] ??
          api.getTierList(role, { platform, rank }).then((result) => {
            cache.current.set(`${role}|${platform}|${rank}`, { at: Date.now(), result });
            return result;
          }),
      ),
    ).then((results) => {
      if (!alive) return;
      shown.current = key;
      setState(merge(results));
    });
    return () => {
      alive = false;
    };
  }, [key, apiKey, nonce, api]);

  const retry = useCallback(() => {
    const roles: readonly Position[] = lane === 'ALL' ? POSITIONS : [lane];
    for (const role of roles) cache.current.delete(`${role}|${platform}|${rank}`);
    setNonce((n) => n + 1);
  }, [lane, platform, rank]);
  return { state, retry };
}

const PLATFORM_LABEL: Record<TierListPlatform, string> = {
  ALL: 'All servers',
  KR: 'KR',
  EUW1: 'EUW',
  NA1: 'NA',
  VN2: 'VN',
};

const RANK_LABEL: Record<TierListRank, string> = {
  DIAMOND: 'Diamond+',
  MASTER: 'Master+',
  GRANDMASTER: 'Grandmaster+',
  CHALLENGER: 'Challenger only',
};

const FILTERS_STORAGE_KEY = 'pickleague.tierListFilters';

/** Server + rank filters, remembered in this renderer's local storage (not in the settings). */
function useTierListFilters() {
  const [filters, setFilters] = useState<TierListFilters>(() => {
    try {
      return toTierListFilters(JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) ?? 'null'));
    } catch {
      return { ...DEFAULT_TIER_LIST_FILTERS };
    }
  });
  const update = useCallback((patch: Partial<TierListFilters>) => {
    setFilters((prev) => {
      const next = toTierListFilters({ ...prev, ...patch });
      try {
        localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable: the choice only lasts for this session.
      }
      return next;
    });
  }, []);
  return [filters, update] as const;
}

const TIER_STYLE: Record<Tier, string> = {
  S: 'bg-gold text-[#1b1406]',
  A: 'bg-up text-[#06201a]',
  B: 'bg-foreground/75 text-background',
  C: 'bg-secondary text-foreground',
  D: 'bg-down/25 text-down',
};

function TierBadge({ tier, size = 'md' }: { tier: Tier; size?: 'md' | 'lg' }) {
  return (
    <span
      title={`Tier ${tier}`}
      className={cn(
        'grid shrink-0 place-items-center font-semibold',
        size === 'md' ? 'size-6 text-xs' : 'size-8 text-base',
        TIER_STYLE[tier],
      )}
    >
      {tier}
    </span>
  );
}

type SortKey = 'score' | 'name' | 'winRate' | 'games' | 'pickRate' | 'banRate' | 'confidence';

const COLUMNS: {
  key: SortKey;
  label: string;
  title: string;
  align: 'left' | 'right';
  /** Hidden in the narrow layout (details panel open). */
  optional?: boolean;
}[] = [
  {
    key: 'score',
    label: 'Tier',
    title: 'Tier and score: win-rate delta vs the role average (points), shrunk by sample size',
    align: 'left',
  },
  { key: 'name', label: 'Champion', title: 'Name', align: 'left' },
  { key: 'winRate', label: 'Win', title: 'Win rate in this role', align: 'right' },
  { key: 'games', label: 'Games', title: 'Games in this role', align: 'right' },
  {
    key: 'pickRate',
    label: 'Pick',
    title: "Share of the role's games",
    align: 'right',
    optional: true,
  },
  { key: 'banRate', label: 'Ban', title: 'Share of matches where it is banned', align: 'right' },
  {
    key: 'confidence',
    label: 'Conf.',
    title: 'Confidence from sample size',
    align: 'right',
    optional: true,
  },
];

/**
 * Full table, or the compact one next to the details panel: no pick rate / confidence, tighter
 * columns, sized for the table's fixed width (`COMPACT_TABLE`).
 */
const gridClass = (narrow: boolean) =>
  narrow
    ? 'grid items-center gap-2 grid-cols-[60px_minmax(0,1fr)_48px_40px_44px]'
    : 'grid items-center gap-3 grid-cols-[64px_minmax(0,1fr)_64px_60px_56px_56px_44px] max-sm:gap-2 max-sm:grid-cols-[60px_minmax(0,1fr)_48px_40px_44px]';

/** Optional columns are left out on phones too (the full table is too wide there). */
const OPTIONAL_CELL = 'max-sm:hidden';

/** Table width while a champion's details are open; the panel takes the rest (all of it on phones). */
const COMPACT_TABLE = 'w-[400px] max-w-[45%] shrink-0 max-md:hidden';

function SortHeader({
  sort,
  onSort,
  narrow,
  count,
}: {
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
  narrow: boolean;
  /** Champions shown once the filters apply, in the name column's label; null while loading. */
  count: number | null;
}) {
  return (
    <div
      className={cn(
        gridClass(narrow),
        'border-b border-border px-3 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase',
      )}
    >
      {COLUMNS.filter((c) => !narrow || !c.optional).map((c) => {
        const active = sort.key === c.key;
        const Arrow = sort.desc ? ArrowDownIcon : ArrowUpIcon;
        return (
          <button
            key={c.key}
            type="button"
            title={c.title}
            onClick={() => onSort(c.key)}
            className={cn(
              'flex items-center gap-1 uppercase outline-none hover:text-foreground focus-visible:text-foreground',
              c.align === 'right' && 'justify-end',
              c.optional && OPTIONAL_CELL,
              active && 'text-foreground',
            )}
          >
            {c.key === 'name' && count !== null ? (
              <span className="num">
                {count} {count === 1 ? 'champion' : 'champions'}
              </span>
            ) : (
              c.label
            )}
            {active && <Arrow className="size-3" />}
          </button>
        );
      })}
    </div>
  );
}

function EntryRow({
  entry,
  name,
  roleLabel,
  lookup,
  mastery,
  selected,
  onSelect,
  narrow,
  focus,
}: {
  entry: TierListEntry;
  name: string;
  /** Every lane shown: the entry's role, under the name. */
  roleLabel?: string;
  lookup: StaticLookup | null;
  mastery: Record<number, MasteryEntry> | undefined;
  selected: boolean;
  onSelect: () => void;
  narrow: boolean;
  /** Arrow-key navigation between rows (one tab stop for the whole list). */
  focus: RovingItemProps;
}) {
  return (
    <button
      type="button"
      {...focus}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        gridClass(narrow),
        'w-full border-b border-border px-3 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent/60',
        selected && 'bg-card shadow-[inset_2px_0_0_var(--primary)]',
      )}
    >
      <span className="flex items-center gap-2">
        <TierBadge tier={entry.tier} />
        <DeltaText delta={entry.score} className="text-[11px]" />
      </span>
      <span className="flex min-w-0 items-center gap-3">
        <ChampionIcon
          src={lookup?.champion(entry.championId)?.iconUrl}
          name={name}
          size={32}
          mastery={mastery?.[entry.championId]}
        />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-medium">{name}</span>
          {roleLabel && (
            <span className="truncate text-[10px] text-muted-foreground">{roleLabel}</span>
          )}
        </span>
      </span>
      <span
        className={cn(
          'num text-right text-xs',
          entry.winRate >= 0.5 ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {percent(entry.winRate)}
      </span>
      <span className="num text-right text-xs text-muted-foreground">{compact(entry.games)}</span>
      {!narrow && (
        <span className={cn('num text-right text-xs text-muted-foreground', OPTIONAL_CELL)}>
          {percent(entry.pickRate)}
        </span>
      )}
      <span className="num text-right text-xs text-muted-foreground">{percent(entry.banRate)}</span>
      {!narrow && (
        <span className={cn('flex justify-end', OPTIONAL_CELL)}>
          <ConfidencePips confidence={entry.confidence} />
        </span>
      )}
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <span className="num text-sm">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function DetailPanel({
  entry,
  role,
  lookup,
  mastery,
  filters,
  minConfidence,
  apiKey,
  onClose,
  onViewBuild,
}: {
  entry: TierListEntry;
  role: Position;
  lookup: StaticLookup | null;
  mastery: Record<number, MasteryEntry> | undefined;
  filters: TierListFilters;
  minConfidence: ConfidenceLevel;
  /** Identity of the API data (URL, patch, last stats refresh). */
  apiKey: string;
  onClose: () => void;
  onViewBuild: () => void;
}) {
  const champ = lookup?.champion(entry.championId);
  const name = champ?.name ?? `#${entry.championId}`;
  const previous = entry.patchesUsed[1];
  return (
    <aside className="@container flex min-w-0 flex-1 flex-col border-l border-border bg-card/40 max-md:border-l-0">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <ChampionIcon
          src={champ?.iconUrl}
          name={name}
          size={44}
          mastery={mastery?.[entry.championId]}
        />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-lg font-semibold">{name}</span>
          <span className="text-[11px] text-muted-foreground">
            {ROLE_LABEL[role]} · <DeltaText delta={entry.score} /> pts vs role average
          </span>
        </div>
        <TierBadge tier={entry.tier} size="lg" />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
          aria-label="Close details"
          title="Close details (Esc)"
          className="ml-auto"
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-5xl flex-col gap-5 p-4">
          <div className="grid grid-cols-3 gap-x-3 gap-y-3 @xl:grid-cols-6">
            <Stat label="Win rate" value={percent(entry.winRate)} />
            <Stat label="Games" value={compact(entry.games)} />
            <Stat
              label="Confidence"
              value={<ConfidencePips confidence={entry.confidence} />}
              sub={confidenceLabel(entry.confidence)}
            />
            <Stat label="Pick rate" value={percent(entry.pickRate)} />
            <Stat label="Ban rate" value={percent(entry.banRate)} />
            <Stat
              label="Patch"
              value={patchesText(entry.patchesUsed)}
              sub={previous ? `${previous} counts as a prior` : undefined}
            />
          </div>
          <Button size="sm" variant="outline" onClick={onViewBuild} className="self-start">
            <HammerIcon data-icon="inline-start" />
            View build
          </Button>
          <ChampionRelations
            role={role}
            championId={entry.championId}
            filters={filters}
            minConfidence={minConfidence}
            apiKey={apiKey}
            lookup={lookup}
          />
        </div>
      </div>
    </aside>
  );
}

function GenericBuild({
  championId,
  role,
  lookup,
  mastery,
  onBack,
  refreshKey,
  flashKey,
}: {
  championId: number;
  role: Position;
  lookup: StaticLookup | null;
  mastery: Record<number, MasteryEntry> | undefined;
  flashKey: FlashKey | undefined;
  onBack: () => void;
  /** Changes when the API's stats were refreshed: re-fetch the build. */
  refreshKey: string;
}) {
  const api = usePickLeagueData();
  const [state, setState] = useState<Loaded<BuildResponse>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce and refreshKey re-run the fetch
  useEffect(() => {
    let alive = true;
    setState((prev) =>
      prev.status === 'ok' && prev.data.championId === championId && prev.data.role === role
        ? prev
        : { status: 'loading' },
    );
    void api.getGenericBuild(championId, role).then((r) => {
      if (alive) setState(r.ok ? { status: 'ok', data: r.data } : { status: 'error', ...r });
    });
    return () => {
      alive = false;
    };
  }, [championId, role, nonce, refreshKey, api]);
  const champ = lookup?.champion(championId);
  const name = champ?.name ?? `#${championId}`;
  const data = state.status === 'ok' ? state.data : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 max-md:flex-wrap">
        <Button size="sm" variant="ghost" onClick={onBack} title="Back to the tier list (Esc)">
          <ArrowLeftIcon data-icon="inline-start" />
          Tier list
        </Button>
        <span className="h-6 w-px bg-border" />
        <ChampionIcon src={champ?.iconUrl} name={name} size={40} mastery={mastery?.[championId]} />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">{name}</span>
            <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              {ROLE_LABEL[role]} · generic build
            </span>
          </span>
          <span className="num text-[11px] text-muted-foreground">
            {data
              ? `patch ${patchesText(data.patchesUsed)} · ${compact(data.games)} games · ${confidenceLabel(data.confidence).toLowerCase()} confidence · no allies or enemies taken into account`
              : 'Most common winning build, without game context'}
          </span>
        </div>
      </div>
      {state.status === 'error' && (
        <Notice
          tone={state.code === 'NO_DATA' ? 'warn' : 'bad'}
          title="Build unavailable"
          message={state.message}
          action={{ label: 'Retry', onClick: () => setNonce((n) => n + 1) }}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === 'loading' && (
          <div className="grid grid-cols-4 gap-3 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        )}
        {data && <BuildDetails build={data} lookup={lookup} mySpells={null} flashKey={flashKey} />}
      </div>
    </div>
  );
}

function sortValue(e: TierListEntry, key: SortKey, name: string): number | string {
  return key === 'name' ? name : e[key];
}

/** What the app's keyboard shortcuts drive in the tier list. */
export interface TierListHandle {
  /** What Escape would close here. */
  escapeState(): { search: SearchFocus; tierList: TierListLayer };
  /** Runs an Escape step (`escapeAction`) that belongs to the tier list. */
  escape(action: Exclude<EscapeAction, 'show-tier-list'>): void;
  /** Focuses the search field and selects its text (once the tier list is visible). */
  focusSearch(): void;
}

const SEARCH_PLACEHOLDER = `Search champion (${shortcutLabel('k', IS_MAC)})`;

/**
 * Tier list of a role with server / rank / confidence filters, a champion's details (matchups,
 * duos, synergies) and its generic build. API calls go through `PickLeagueDataProvider`.
 */
export function TierListPage({
  lookup,
  dataKey = '',
  initialRole = 'MIDDLE',
  mastery,
  ownedChampionIds,
  flashKey,
  onBusyChange,
  handleRef,
}: {
  lookup: StaticLookup | null;
  /**
   * Identity of the API data (e.g. API URL, patch, last stats refresh): a new value drops the
   * cached tier lists and re-fetches the shown ones.
   */
  dataKey?: string;
  /** Role shown first. */
  initialRole?: Position;
  /** The user's mastery per champion (League client only): badges on the icons when given. */
  mastery?: Record<number, MasteryEntry>;
  /** Champions the user can play (League client only): an "Owned only" switch when given. */
  ownedChampionIds?: readonly number[] | null;
  /** Key Flash goes on in the build's spells (F by default). */
  flashKey?: FlashKey;
  /** True while the user is looking at a champion (details or build open). */
  onBusyChange?: (busy: boolean) => void;
  /** Filled with what the keyboard shortcuts drive. */
  handleRef?: RefObject<TierListHandle | null>;
}) {
  const [lane, setLane] = useState<Lane>(initialRole);
  const [search, setSearch] = useState('');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'score', desc: true });
  /** Selected row (`rowKey`), and the champion + role whose build is open. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [buildOf, setBuildOf] = useState<RoleEntry | null>(null);
  // A new API, patch or stats refresh (manual or background) drops the cached tier lists.
  const apiKey = dataKey;
  const [filters, setFilters] = useTierListFilters();
  const [minConfidence] = useMinConfidence();
  const { state: tl, retry } = useTierList(lane, filters, apiKey);

  useEffect(() => {
    onBusyChange?.(selectedKey !== null || buildOf !== null);
  }, [selectedKey, buildOf, onBusyChange]);

  const data = tl.status === 'ok' ? tl.data : null;
  const owned = useMemo(
    () => (ownedChampionIds ? new Set(ownedChampionIds) : null),
    [ownedChampionIds],
  );
  const nameOf = useCallback((id: number) => lookup?.champion(id)?.name ?? `#${id}`, [lookup]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const list = data.entries.filter(
      (e) =>
        (!q || nameOf(e.championId).toLowerCase().includes(q)) &&
        (!ownedOnly || !owned || owned.has(e.championId)) &&
        meetsConfidence(e.confidence, minConfidence),
    );
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      const va = sortValue(a, sort.key, nameOf(a.championId));
      const vb = sortValue(b, sort.key, nameOf(b.championId));
      const cmp =
        typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * dir || b.score - a.score;
    });
  }, [data, search, ownedOnly, owned, minConfidence, sort, nameOf]);

  const selected = data?.entries.find((e) => rowKey(e) === selectedKey) ?? null;
  const rowIds = useMemo(() => rows.map(rowKey), [rows]);
  const championCount = useMemo(() => new Set(rows.map((e) => e.championId)).size, [rows]);
  const roving = useRoving(rowIds, 'vertical');

  const narrow = selected !== null;

  // Ctrl+K: the field may not be focusable yet (tier list hidden behind champion select, or the
  // build page shown); it is then focused after the render that shows it.
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef(false);
  const focusPending = useCallback(() => {
    const input = searchRef.current;
    if (!pendingFocus.current || !input) return;
    input.focus();
    if (document.activeElement !== input) return;
    pendingFocus.current = false;
    input.select();
  }, []);
  useEffect(focusPending);

  const layer: TierListLayer = buildOf !== null ? 'build' : narrow ? 'details' : 'list';
  useImperativeHandle(
    handleRef,
    () => ({
      escapeState: () => {
        const input = searchRef.current;
        const focused = input !== null && document.activeElement === input;
        const search: SearchFocus = !focused ? 'none' : input.value ? 'filled' : 'empty';
        return { search, tierList: layer };
      },
      escape: (action) => {
        if (action === 'clear-search') setSearch('');
        else if (action === 'blur-search') searchRef.current?.blur();
        else if (action === 'close-build') setBuildOf(null);
        else setSelectedKey(null);
      },
      focusSearch: () => {
        pendingFocus.current = true;
        setBuildOf(null);
        focusPending();
      },
    }),
    [layer, focusPending],
  );

  if (buildOf !== null) {
    return (
      <GenericBuild
        championId={buildOf.championId}
        role={buildOf.role}
        lookup={lookup}
        mastery={mastery}
        onBack={() => setBuildOf(null)}
        refreshKey={apiKey}
        flashKey={flashKey}
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Role and filters span the whole page: they apply to the table and to the details. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 pt-2 pb-1">
        <Tabs
          value={lane}
          onValueChange={(v) => {
            setLane(v as Lane);
            setSelectedKey(null);
          }}
          className="gap-0"
        >
          <TabsList variant="line">
            <TabsTrigger value="ALL" className="px-2.5">
              All
            </TabsTrigger>
            {POSITIONS.map((p) => (
              <TabsTrigger key={p} value={p} className="px-2.5">
                {ROLE_LABEL[p]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3">
          <FilterSelect
            label="Server"
            value={filters.platform}
            labels={PLATFORM_LABEL}
            onChange={(platform) => setFilters({ platform })}
          />
          <FilterSelect
            label="Players' current solo rank. Diamond+ keeps every player of the stored matches (Master+ lobbies and the games of tracked Diamond players)"
            value={filters.rank}
            labels={RANK_LABEL}
            onChange={(rank) => setFilters({ rank })}
          />
          <ConfidenceFilter />
        </div>
        <div className="ml-auto flex items-center gap-4">
          {owned && (
            <span className="flex items-center gap-2">
              <Switch id="tier-owned" checked={ownedOnly} onCheckedChange={setOwnedOnly} />
              <Label htmlFor="tier-owned" className="text-xs">
                Owned only
              </Label>
            </span>
          )}
          <span className="flex items-center gap-2">
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Tab / ArrowDown: into the list, on the first champion; arrows move from there.
                if (enterListFromSearch(e, roving.focusFirst)) return;
                // Enter opens the first champion shown.
                const first = rows[0];
                if (e.key === 'Enter' && first && search.trim()) setSelectedKey(rowKey(first));
              }}
              placeholder={SEARCH_PLACEHOLDER}
              aria-label="Search champion"
              aria-keyshortcuts={IS_MAC ? 'Meta+K Meta+F' : 'Control+K Control+F'}
              className="h-8 w-48 text-xs md:text-xs"
            />
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <section className={cn('flex min-w-0 flex-col', narrow ? COMPACT_TABLE : 'flex-1')}>
          {tl.status === 'error' && (
            <Notice
              tone={tl.code === 'NO_DATA' ? 'warn' : 'bad'}
              title={tl.code === 'NO_DATA' ? 'No data yet' : 'Tier list unavailable'}
              message={tl.message}
              action={{ label: 'Retry', onClick: retry }}
            />
          )}

          {tl.status !== 'error' && (
            <SortHeader
              sort={sort}
              onSort={(key) =>
                setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))
              }
              narrow={narrow}
              count={data ? championCount : null}
            />
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the rows (roving tabindex), the rows themselves are buttons */}
          <div
            ref={roving.containerRef}
            onKeyDown={roving.onKeyDown}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {tl.status === 'loading' && (
              <div className="flex flex-col gap-1.5 p-3">
                {Array.from({ length: 10 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            )}
            {data && rows.length === 0 && (
              <p className="p-6 text-sm text-muted-foreground">
                {data.entries.length === 0
                  ? filters.platform === 'ALL' && filters.rank === 'DIAMOND'
                    ? `No champion has enough games in ${lane === 'ALL' ? 'any role' : 'this role'} yet.`
                    : `No champion has enough games in ${lane === 'ALL' ? 'any role' : 'this role'} with this server and rank yet.`
                  : 'No champion matches the filters.'}
              </p>
            )}
            {data &&
              rows.map((e) => (
                <EntryRow
                  key={rowKey(e)}
                  entry={e}
                  name={nameOf(e.championId)}
                  roleLabel={lane === 'ALL' ? ROLE_LABEL[e.role] : undefined}
                  lookup={lookup}
                  mastery={mastery}
                  narrow={narrow}
                  selected={rowKey(e) === selectedKey}
                  onSelect={() => setSelectedKey(rowKey(e) === selectedKey ? null : rowKey(e))}
                  focus={roving.itemProps(rowKey(e))}
                />
              ))}
          </div>
        </section>
        {selected && data && (
          <DetailPanel
            entry={selected}
            role={selected.role}
            lookup={lookup}
            mastery={mastery}
            filters={filters}
            minConfidence={minConfidence}
            apiKey={apiKey}
            onClose={() => setSelectedKey(null)}
            onViewBuild={() => setBuildOf(selected)}
          />
        )}
      </div>
    </div>
  );
}
