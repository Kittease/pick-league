import {
  type BuildResponse,
  POSITIONS,
  type Position,
  type Tier,
  type TierListEntry,
  type TierListRelation,
  type TierListResponse,
} from '@pick-league/shared';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  HammerIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  compact,
  confidenceLabel,
  deltaPoints,
  patchesText,
  percent,
  ROLE_LABEL,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ApiResult, AppState, Settings } from '../../../core/app-state.ts';
import type { StaticLookup } from '../hooks/use-app';
import { BuildDetails } from './build-panel';
import { ChampionIcon } from './game-icon';
import { Notice } from './notice';
import { ConfidencePips } from './picks-panel';
import { DeltaBar, DeltaText } from './reasons';

/** A role's tier list is re-fetched after this long (the API refreshes its stats every ~15 min). */
const CACHE_MS = 5 * 60_000;

type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; code: string | null; message: string };

/** Tier list of a role, cached per role for a few minutes; reset when the API changes. */
function useTierList(role: Position, apiKey: string) {
  const cache = useRef(new Map<Position, { at: number; result: ApiResult<TierListResponse> }>());
  const [state, setState] = useState<Loaded<TierListResponse>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const lastKey = useRef(apiKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce re-runs the fetch on retry
  useEffect(() => {
    if (lastKey.current !== apiKey) {
      cache.current.clear();
      lastKey.current = apiKey;
    }
    const hit = cache.current.get(role);
    if (hit?.result.ok && Date.now() - hit.at < CACHE_MS) {
      setState({ status: 'ok', data: hit.result.data });
      return;
    }
    let alive = true;
    // Same role re-fetched (stats refreshed): keep showing the old list until the new one lands.
    setState((prev) =>
      prev.status === 'ok' && prev.data.role === role ? prev : { status: 'loading' },
    );
    void window.pickleague.getTierList(role).then((result) => {
      if (!alive) return;
      cache.current.set(role, { at: Date.now(), result });
      setState(result.ok ? { status: 'ok', data: result.data } : { status: 'error', ...result });
    });
    return () => {
      alive = false;
    };
  }, [role, apiKey, nonce]);

  const retry = useCallback(() => {
    cache.current.delete(role);
    setNonce((n) => n + 1);
  }, [role]);
  return { state, retry };
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
    title: 'Tier and score (win-rate delta vs role average)',
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

/** Full table, or the narrow one (no pick rate / confidence) next to the details panel. */
const gridClass = (narrow: boolean) =>
  cn(
    'grid items-center gap-3',
    narrow
      ? 'grid-cols-[60px_minmax(0,1fr)_52px_44px_48px]'
      : 'grid-cols-[64px_minmax(0,1fr)_64px_60px_56px_56px_44px]',
  );

function SortHeader({
  sort,
  onSort,
  narrow,
}: {
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
  narrow: boolean;
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
              active && 'text-foreground',
            )}
          >
            {c.label}
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
  lookup,
  mastery,
  currentPatch,
  selected,
  onSelect,
  narrow,
}: {
  entry: TierListEntry;
  name: string;
  lookup: StaticLookup | null;
  mastery: AppState['mastery'];
  currentPatch: string;
  selected: boolean;
  onSelect: () => void;
  narrow: boolean;
}) {
  const merged = entry.patchesUsed.length > 1;
  return (
    <button
      type="button"
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
          mastery={mastery[entry.championId]}
        />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-medium">{name}</span>
          {merged && (
            <span
              className="truncate text-[10px] text-gold"
              title={`Too few matchups on ${currentPatch} alone: both patches combined`}
            >
              {patchesText(entry.patchesUsed)} data
            </span>
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
        <span className="num text-right text-xs text-muted-foreground">
          {percent(entry.pickRate)}
        </span>
      )}
      <span className="num text-right text-xs text-muted-foreground">{percent(entry.banRate)}</span>
      {!narrow && (
        <span className="flex justify-end">
          <ConfidencePips confidence={entry.confidence} />
        </span>
      )}
    </button>
  );
}

function RelationList({
  title,
  hint,
  relations,
  lookup,
  role,
  verb,
}: {
  title: string;
  hint: string;
  relations: TierListRelation[];
  lookup: StaticLookup | null;
  role: Position;
  verb: 'vs' | 'with';
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-baseline gap-2 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {title}
        <span className="font-normal tracking-normal normal-case">{hint}</span>
      </h3>
      {relations.length === 0 ? (
        <p className="text-xs text-muted-foreground">Not enough games yet.</p>
      ) : (
        <ul className="flex flex-col">
          {relations.map((r) => {
            const champ = lookup?.champion(r.championId);
            const name = champ?.name ?? `#${r.championId}`;
            return (
              <li
                key={`${r.championId}-${r.role}`}
                className="grid grid-cols-[28px_minmax(0,1fr)_40px_44px_44px] items-center gap-2 py-1 text-xs"
                title={`${deltaPoints(r.delta)} pts ${verb} ${name} (${percent(r.winRate)} win rate in ${r.games} games, shrunk by sample size)`}
              >
                <ChampionIcon src={champ?.iconUrl} name={name} size={26} />
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate">
                    <span className="text-muted-foreground">{verb} </span>
                    {name}
                  </span>
                  {r.role !== role && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {ROLE_LABEL[r.role]}
                    </span>
                  )}
                </span>
                <DeltaBar delta={r.delta} games={r.games} />
                <DeltaText delta={r.delta} className="text-right" />
                <span className="num text-right text-[10px] text-muted-foreground">
                  n={compact(r.games)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
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
  currentPatch,
  lookup,
  mastery,
  onClose,
  onViewBuild,
}: {
  entry: TierListEntry;
  role: Position;
  currentPatch: string;
  lookup: StaticLookup | null;
  mastery: AppState['mastery'];
  onClose: () => void;
  onViewBuild: () => void;
}) {
  const champ = lookup?.champion(entry.championId);
  const name = champ?.name ?? `#${entry.championId}`;
  const merged = entry.patchesUsed.length > 1;
  const isBot = role === 'BOTTOM' || role === 'UTILITY';
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-card/40">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <ChampionIcon
          src={champ?.iconUrl}
          name={name}
          size={44}
          mastery={mastery[entry.championId]}
        />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-lg font-semibold">{name}</span>
          <span className="text-[11px] text-muted-foreground">
            {ROLE_LABEL[role]} · <DeltaText delta={entry.score} /> pts vs role average
          </span>
        </div>
        <TierBadge tier={entry.tier} size="lg" />
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close details">
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 p-4">
          <div className="grid grid-cols-3 gap-x-3 gap-y-3">
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
              value={
                <span className={cn(merged && 'text-gold')}>{patchesText(entry.patchesUsed)}</span>
              }
              sub={merged ? `too few matchups on ${currentPatch} alone` : undefined}
            />
          </div>
          <RelationList
            title="Best matchups"
            hint={isBot ? 'bot lane, deltas vs its own win rate' : 'deltas vs its own win rate'}
            relations={entry.bestMatchups}
            lookup={lookup}
            role={role}
            verb="vs"
          />
          <RelationList
            title="Worst matchups"
            hint="avoid into"
            relations={entry.worstMatchups}
            lookup={lookup}
            role={role}
            verb="vs"
          />
          <RelationList
            title="Best duos"
            hint="pick with"
            relations={entry.bestDuos}
            lookup={lookup}
            role={role}
            verb="with"
          />
          <Button size="sm" variant="outline" onClick={onViewBuild} className="self-start">
            <HammerIcon data-icon="inline-start" />
            View build
          </Button>
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
  mastery: AppState['mastery'];
  flashKey: Settings['flashKey'];
  onBack: () => void;
  /** Changes when the API's stats were refreshed: re-fetch the build. */
  refreshKey: string;
}) {
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
    void window.pickleague.getGenericBuild(championId, role).then((r) => {
      if (alive) setState(r.ok ? { status: 'ok', data: r.data } : { status: 'error', ...r });
    });
    return () => {
      alive = false;
    };
  }, [championId, role, nonce, refreshKey]);
  const champ = lookup?.champion(championId);
  const name = champ?.name ?? `#${championId}`;
  const data = state.status === 'ok' ? state.data : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Tier list
        </Button>
        <span className="h-6 w-px bg-border" />
        <ChampionIcon src={champ?.iconUrl} name={name} size={40} mastery={mastery[championId]} />
        <div className="flex flex-col leading-tight">
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

export function TierListPage({
  state,
  lookup,
  onBusyChange,
}: {
  state: AppState;
  lookup: StaticLookup | null;
  /** True while the user is looking at a champion (details or build open). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [role, setRole] = useState<Position>(state.settings.fallbackRole);
  const [search, setSearch] = useState('');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'score', desc: true });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [buildOf, setBuildOf] = useState<number | null>(null);
  // A new API, patch or stats refresh (manual or background) drops the cached tier lists.
  const lastRefreshedAt = state.stats.status?.lastRefreshedAt ?? null;
  const apiKey = `${state.api.url}|${state.api.latestPatch}|${state.api.state === 'ok'}|${lastRefreshedAt}`;
  const { state: tl, retry } = useTierList(role, apiKey);

  useEffect(() => {
    onBusyChange?.(selectedId !== null || buildOf !== null);
  }, [selectedId, buildOf, onBusyChange]);

  const data = tl.status === 'ok' ? tl.data : null;
  const owned = useMemo(
    () => (state.ownedChampionIds ? new Set(state.ownedChampionIds) : null),
    [state.ownedChampionIds],
  );
  const nameOf = useCallback((id: number) => lookup?.champion(id)?.name ?? `#${id}`, [lookup]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const list = data.entries.filter(
      (e) =>
        (!q || nameOf(e.championId).toLowerCase().includes(q)) &&
        (!ownedOnly || !owned || owned.has(e.championId)),
    );
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      const va = sortValue(a, sort.key, nameOf(a.championId));
      const vb = sortValue(b, sort.key, nameOf(b.championId));
      const cmp =
        typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * dir || b.score - a.score;
    });
  }, [data, search, ownedOnly, owned, sort, nameOf]);

  const selected = data?.entries.find((e) => e.championId === selectedId) ?? null;

  const narrow = selected !== null;

  if (buildOf !== null) {
    return (
      <GenericBuild
        championId={buildOf}
        role={role}
        lookup={lookup}
        mastery={state.mastery}
        onBack={() => setBuildOf(null)}
        refreshKey={apiKey}
        flashKey={state.settings.flashKey}
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 pt-2 pb-1">
          <Tabs
            value={role}
            onValueChange={(v) => {
              setRole(v as Position);
              setSelectedId(null);
            }}
            className="gap-0"
          >
            <TabsList variant="line">
              {POSITIONS.map((p) => (
                <TabsTrigger key={p} value={p} className="px-2.5">
                  {ROLE_LABEL[p]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="ml-auto flex items-center gap-4">
            <span className="flex items-center gap-2">
              <SearchIcon className="size-3.5 text-muted-foreground" />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search champion"
                aria-label="Search champion"
                className="h-8 w-40 text-xs md:text-xs"
              />
            </span>
            {owned && (
              <span className="flex items-center gap-2">
                <Switch id="tier-owned" checked={ownedOnly} onCheckedChange={setOwnedOnly} />
                <Label htmlFor="tier-owned" className="text-xs">
                  Owned only
                </Label>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-baseline gap-3 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-semibold tracking-[0.18em] text-foreground uppercase">
            {ROLE_LABEL[role]} tier list
          </span>
          {data && (
            <span className="num">
              patch {data.patch} · {compact(data.roleGames)} matchups · {data.entries.length}{' '}
              champions
            </span>
          )}
          <span className="ml-auto hidden lg:inline">
            score = win-rate delta vs role average (points), shrunk by sample size
          </span>
        </div>

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
          />
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
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
                ? 'No champion has enough games in this role yet.'
                : 'No champion matches the filters.'}
            </p>
          )}
          {data &&
            rows.map((e) => (
              <EntryRow
                key={e.championId}
                entry={e}
                name={nameOf(e.championId)}
                lookup={lookup}
                mastery={state.mastery}
                currentPatch={data.patch}
                narrow={narrow}
                selected={e.championId === selectedId}
                onSelect={() => setSelectedId(e.championId === selectedId ? null : e.championId)}
              />
            ))}
        </div>
      </section>
      {selected && data && (
        <DetailPanel
          entry={selected}
          role={role}
          currentPatch={data.patch}
          lookup={lookup}
          mastery={state.mastery}
          onClose={() => setSelectedId(null)}
          onViewBuild={() => setBuildOf(selected.championId)}
        />
      )}
    </div>
  );
}
