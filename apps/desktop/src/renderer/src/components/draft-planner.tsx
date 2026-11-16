import { type PickCandidate, POSITIONS, type Position } from '@pick-league/shared';
import { Button } from '@pick-league/ui/components/ui/button';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@pick-league/ui/components/ui/hover-card';
import { Input } from '@pick-league/ui/components/ui/input';
import { Label } from '@pick-league/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@pick-league/ui/components/ui/select';
import { Skeleton } from '@pick-league/ui/components/ui/skeleton';
import { Switch } from '@pick-league/ui/components/ui/switch';
import { apiDataKey, useApiCall } from '@pick-league/ui/hooks/use-api-call';
import { useMinConfidence } from '@pick-league/ui/hooks/use-min-confidence';
import {
  enterListFromSearch,
  type RovingItemProps,
  useRoving,
} from '@pick-league/ui/hooks/use-roving';
import { IS_MAC } from '@pick-league/ui/hooks/use-shortcuts';
import { meetsConfidence } from '@pick-league/ui/lib/confidence';
import {
  ban,
  banPhase,
  championPool,
  currentTurn,
  type Draft,
  type DraftFormat,
  type DraftTurn,
  displacedBy,
  draftBuildRequest,
  draftEvaluationRequest,
  draftPicksRequest,
  emptyDraft,
  isComplete,
  lastAction,
  openRoles,
  pick,
  pickRole,
  type RankedChampion,
  swapRoles,
  type Team,
  teamBans,
  teamPicks,
  turnLabel,
  unavailableChampionIds,
  undo,
} from '@pick-league/ui/lib/draft';
import {
  compact,
  confidenceLabel,
  patchesText,
  percent,
  ROLE_LABEL,
} from '@pick-league/ui/lib/format';
import {
  type DraftEscapeAction,
  type SearchFocus,
  shortcutLabel,
} from '@pick-league/ui/lib/shortcuts';
import { cn } from '@pick-league/ui/lib/utils';
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  BanIcon,
  HammerIcon,
  Loader2Icon,
  RotateCcwIcon,
  SearchIcon,
  Undo2Icon,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type RefObject,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AppState } from '../../../core/app-state.ts';
import type { StaticLookup } from '../hooks/use-app';
import { BuildView } from './build-panel';
import { DamageSplit, type OutlookSide, WinProbability } from './draft-outlook';
import { ConfidenceFilter } from './filter-select';
import { ChampionIcon, GameIcon } from './game-icon';
import { Notice } from './notice';
import { ConfidencePips } from './picks-panel';
import { DeltaText, ReasonList } from './reasons';

const TEAM_LABEL: Record<Team, string> = { blue: 'Blue', red: 'Red' };
const TEAM_TEXT: Record<Team, string> = { blue: 'text-[#5ba4e5]', red: 'text-[#e2555f]' };
const TEAM_BAR: Record<Team, string> = { blue: 'bg-[#5ba4e5]', red: 'bg-[#e2555f]' };
const OUTLOOK: Record<Team, OutlookSide> = {
  blue: { label: 'Blue', text: TEAM_TEXT.blue, bar: TEAM_BAR.blue },
  red: { label: 'Red', text: TEAM_TEXT.red, bar: TEAM_BAR.red },
};

/** The format chosen last time (per viewer convenience; solo/duo when unavailable). */
const FORMAT_KEY = 'pickleague.draftFormat';
function loadFormat(): DraftFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'competitive' ? 'competitive' : 'soloq';
  } catch {
    return 'soloq';
  }
}
function saveFormat(format: DraftFormat): void {
  try {
    localStorage.setItem(FORMAT_KEY, format);
  } catch {
    // Storage unavailable: the format is only kept for this session.
  }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

interface Slot {
  team: Team;
  role: Position;
}

function BanSlots({
  team,
  draft,
  turn,
  lookup,
}: {
  team: Team;
  draft: Draft;
  turn: DraftTurn | null;
  lookup: StaticLookup | null;
}) {
  const bans = teamBans(draft, team);
  return (
    <div className="flex gap-1 px-1">
      {Array.from({ length: 5 }, (_, i) => {
        const id = bans[i];
        const active = turn?.kind === 'ban' && turn.team === team && turn.number === i + 1;
        // Competitive: a gap between the first and second ban phase.
        const gap = draft.format === 'competitive' && i === 3 ? 'ml-1.5' : undefined;
        if (id === undefined) {
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots
              key={i}
              title={active ? 'Banning now' : `Ban ${i + 1}`}
              className={cn(
                'size-[26px] shrink-0 border border-dashed border-border',
                active && 'animate-pulse border-primary',
                gap,
              )}
            />
          );
        }
        if (id === null) {
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots
              key={i}
              title="No ban"
              className={cn(
                'grid size-[26px] shrink-0 place-items-center bg-secondary text-muted-foreground',
                gap,
              )}
            >
              <BanIcon className="size-3" />
            </span>
          );
        }
        const c = lookup?.champion(id);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots
          <span key={i} className={cn('shrink-0', gap)}>
            <GameIcon src={c?.iconUrl} alt={c?.name ?? `#${id}`} size={26} dim />
          </span>
        );
      })}
    </div>
  );
}

/**
 * Moves a picked champion to another role of its team (swapping with the champion there, if
 * any): flex picks are often placed before their lane is known.
 */
function RoleSwap({
  team,
  role,
  name,
  picks,
  lookup,
  onSwap,
}: {
  team: Team;
  role: Position;
  name: string;
  picks: Partial<Record<Position, { championId: number }>>;
  lookup: StaticLookup | null;
  onSwap: (from: Position, to: Position) => void;
}) {
  const labels = Object.fromEntries(POSITIONS.map((p) => [p, ROLE_LABEL[p]])) as Record<
    Position,
    string
  >;
  return (
    <Select
      value={role}
      items={labels}
      onValueChange={(v) => {
        if (typeof v === 'string' && v in labels && v !== role) onSwap(role, v as Position);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Move ${name} (${TEAM_LABEL[team]} ${ROLE_LABEL[role]}) to another role`}
        title="Move to another role (flex pick)"
        className="h-7 shrink-0 gap-1 border-b-transparent px-1.5 text-muted-foreground hover:text-foreground data-[size=sm]:h-7 [&>svg:last-child]:hidden"
      >
        <ArrowLeftRightIcon className="size-3" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="end">
        {POSITIONS.map((p) => {
          const there = p === role ? undefined : picks[p];
          const other = there
            ? (lookup?.champion(there.championId)?.name ?? `#${there.championId}`)
            : null;
          return (
            <SelectItem key={p} value={p} className="text-xs">
              {ROLE_LABEL[p]}
              {p === role ? (
                <span className="text-muted-foreground">current</span>
              ) : other ? (
                <span className="text-muted-foreground">swap with {other}</span>
              ) : null}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function TeamColumn({
  team,
  draft,
  turn,
  role,
  buildOf,
  lookup,
  damage,
  onChooseRole,
  onShowBuild,
  onSwap,
}: {
  team: Team;
  draft: Draft;
  turn: DraftTurn | null;
  /** Role picked for on this turn (null when it is not this team's pick). */
  role: Position | null;
  buildOf: Slot | null;
  lookup: StaticLookup | null;
  /** The team's damage split (from the draft evaluation). */
  damage: Parameters<typeof DamageSplit>[0]['damage'];
  onChooseRole: (role: Position) => void;
  onShowBuild: (slot: Slot) => void;
  onSwap: (from: Position, to: Position) => void;
}) {
  const picks = teamPicks(draft, team);
  const onTurn = turn?.team === team;
  const picking = onTurn && turn?.kind === 'pick';
  return (
    <aside
      className={cn(
        'flex w-[200px] shrink-0 flex-col gap-3 overflow-y-auto border-border py-2',
        team === 'blue' ? 'border-r' : 'border-l',
      )}
    >
      <div className="flex items-center gap-2 px-3">
        <span className={cn('h-3 w-1', TEAM_BAR[team])} />
        <span
          className={cn('text-[10px] font-semibold tracking-[0.18em] uppercase', TEAM_TEXT[team])}
        >
          {TEAM_LABEL[team]} side
        </span>
        {onTurn && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {turn?.kind === 'ban' ? 'banning' : 'picking'}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-2">
        <span className="px-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Bans
        </span>
        <BanSlots team={team} draft={draft} turn={turn} lookup={lookup} />
      </div>
      <ul className="flex flex-col">
        {POSITIONS.map((p) => {
          const slot = picks[p];
          const champ = lookup?.champion(slot?.championId);
          const name = slot ? (champ?.name ?? `#${slot.championId}`) : null;
          const active = picking && role === p;
          const shown = buildOf?.team === team && buildOf.role === p;
          const canChoose = !slot && picking;
          return (
            <li
              key={p}
              className={cn(
                'flex items-center pr-1.5',
                (active || shown) && 'bg-card shadow-[inset_2px_0_0_var(--primary)]',
              )}
            >
              <button
                type="button"
                disabled={!slot && !canChoose}
                onClick={() => (slot ? onShowBuild({ team, role: p }) : onChooseRole(p))}
                title={
                  slot
                    ? `${name}: build for this match`
                    : canChoose
                      ? `Pick for ${ROLE_LABEL[p]}`
                      : undefined
                }
                className={cn(
                  'group flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-1 pl-3 text-left outline-none',
                  (slot || canChoose) && 'hover:bg-accent/60 focus-visible:bg-accent/60',
                )}
              >
                {slot ? (
                  <ChampionIcon src={champ?.iconUrl} name={name ?? ''} size={34} />
                ) : (
                  <span
                    className={cn(
                      'size-[34px] shrink-0 border border-dashed border-border',
                      active && 'animate-pulse border-primary',
                    )}
                  />
                )}
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className={cn('truncate text-[13px]', !slot && 'text-muted-foreground')}>
                    {name ?? (active ? 'Picking…' : '—')}
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] tracking-wider text-muted-foreground uppercase">
                    {ROLE_LABEL[p]}
                    {slot && (
                      <span className="num normal-case">
                        {turnLabel({ kind: 'pick', team, number: slot.number })}
                      </span>
                    )}
                    {slot && (
                      <HammerIcon className="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                    )}
                  </span>
                </span>
              </button>
              {slot && name && (
                <RoleSwap
                  team={team}
                  role={p}
                  name={name}
                  picks={picks}
                  lookup={lookup}
                  onSwap={onSwap}
                />
              )}
            </li>
          );
        })}
      </ul>
      <DamageSplit damage={damage} lookup={lookup} className="mt-auto px-3" />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Champion grid
// ---------------------------------------------------------------------------

const TILE =
  'relative flex min-w-0 flex-col items-center gap-1 px-1 pt-1.5 pb-1 outline-none hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring';

interface PoolChampion {
  id: number;
  name: string;
  iconUrl: string;
}

function CandidateDetails({
  name,
  ranked,
  heading,
}: {
  name: string;
  ranked: RankedChampion<PoolChampion>;
  heading: string;
}) {
  const c: PickCandidate = ranked.candidate;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">{name}</span>
        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          #{ranked.rank} · {heading}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span>
          <DeltaText delta={c.score} className="font-semibold" />{' '}
          <span className="text-muted-foreground">score</span>
        </span>
        <span className="num">{percent(c.winRate)} win</span>
        <span className="num text-muted-foreground">{compact(c.games)} matches</span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ConfidencePips confidence={c.confidence} />
          {confidenceLabel(c.confidence).toLowerCase()} confidence
        </span>
        <span className="num text-muted-foreground">patch {patchesText(c.patchesUsed)}</span>
      </div>
      <ReasonList reasons={c.reasons} />
    </div>
  );
}

function RankedTile({
  ranked,
  heading,
  stale,
  onChoose,
  focus,
}: {
  ranked: RankedChampion<PoolChampion>;
  heading: string;
  /** The ranking is being updated for the new draft state. */
  stale: boolean;
  onChoose: () => void;
  focus: RovingItemProps;
}) {
  const { champion, candidate, rank } = ranked;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={350}
        render={<button type="button" onClick={onChoose} className={TILE} {...focus} />}
      >
        <GameIcon src={champion.iconUrl} alt={champion.name} size={44} />
        <span className="num absolute top-1 left-1 bg-background/85 px-1 text-[9px] leading-[14px] text-muted-foreground">
          {rank}
        </span>
        <span className="w-full truncate text-center text-[11px] leading-tight">
          {champion.name}
        </span>
        <DeltaText
          delta={candidate.score}
          className={cn('text-[10px] leading-none font-semibold', stale && 'opacity-40')}
        />
      </HoverCardTrigger>
      <HoverCardContent className="w-[440px]" side="right" align="start">
        <CandidateDetails name={champion.name} ranked={ranked} heading={heading} />
      </HoverCardContent>
    </HoverCard>
  );
}

function PlainTile({
  champion,
  dim,
  title,
  onChoose,
  focus,
}: {
  champion: PoolChampion;
  dim: boolean;
  title: string;
  onChoose: () => void;
  focus: RovingItemProps;
}) {
  return (
    <button
      type="button"
      {...focus}
      onClick={onChoose}
      title={title}
      className={cn(TILE, dim && 'opacity-45 hover:opacity-100 focus-visible:opacity-100')}
    >
      <GameIcon src={champion.iconUrl} alt={champion.name} size={44} />
      <span className="w-full truncate text-center text-[11px] leading-tight">{champion.name}</span>
    </button>
  );
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(70px,1fr))] gap-0.5';

function GridSkeleton() {
  return (
    <div className={cn(GRID, 'p-2')}>
      {Array.from({ length: 24 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
        <Skeleton key={i} className="m-1 h-[64px]" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** What the app's keyboard shortcuts drive in the draft planner. */
export interface DraftHandle {
  escapeState(): { search: SearchFocus; buildOpen: boolean };
  escape(action: DraftEscapeAction): void;
  /** Focuses the champion search (back from a build to the grid). */
  focusSearch(): void;
}

const NO_PREFERENCE: Record<Team, Position | null> = { blue: null, red: null };
const SEARCH_PLACEHOLDER = `Search champion (${shortcutLabel('k', IS_MAC)})`;

/**
 * Draft planner: a ranked solo/duo or competitive draft played by hand (no League client
 * needed). The team on turn bans, then picks for a role, from a grid ordered by the pick
 * recommendations for that team and role; the win chance and each team's damage split follow
 * the draft; any drafted champion shows its build against the drafted teams.
 */
export function DraftPlanner({
  state,
  lookup,
  handleRef,
}: {
  state: AppState;
  lookup: StaticLookup | null;
  handleRef?: RefObject<DraftHandle | null>;
}) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(loadFormat()));
  /**
   * Role the user chose per team for its next pick (may be one it already has: the pick then
   * moves that champion to an open role); cleared after each pick.
   */
  const [preferred, setPreferred] = useState(NO_PREFERENCE);
  const [buildOf, setBuildOf] = useState<Slot | null>(null);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const apiKey = apiDataKey(state);

  const turn = currentTurn(draft);
  const complete = isComplete(draft);
  const pickTeam = turn?.kind === 'pick' ? turn.team : null;
  const role = pickTeam ? pickRole(draft, pickTeam, preferred[pickTeam], true) : null;
  // A pick for a role the team already has moves that champion to the first open role.
  const displaced = pickTeam && role ? displacedBy(draft, pickTeam, role) : null;
  const displacedTo = pickTeam && displaced ? (openRoles(draft, pickTeam)[0] ?? null) : null;

  const picksRequest = useMemo(
    () => (pickTeam && role ? draftPicksRequest(draft, pickTeam, role) : null),
    [draft, pickTeam, role],
  );
  const { result: picks, retry: retryPicks } = useApiCall(
    picksRequest,
    (r) => window.pickleague.draftPicks(r),
    apiKey,
    true,
  );
  const buildRequest = useMemo(
    () => (buildOf ? draftBuildRequest(draft, buildOf.team, buildOf.role) : null),
    [draft, buildOf],
  );
  const { result: build, retry: retryBuild } = useApiCall(
    buildRequest,
    (r) => window.pickleague.draftBuild(r),
    apiKey,
    false,
  );
  // Win chance (blue's point of view) and damage split of the draft as it stands.
  const evaluationRequest = useMemo(() => draftEvaluationRequest(draft, 'blue'), [draft]);
  const { result: evaluation, retry: retryEvaluation } = useApiCall(
    evaluationRequest,
    (r) => window.pickleague.evaluateDraft(r),
    apiKey,
    true,
  );
  const evaluated = evaluation.status === 'idle' ? null : evaluation.data;
  // A slot emptied by Undo / Reset closes its build.
  const shownBuild = buildOf && buildRequest ? { ...buildOf, request: buildRequest } : null;
  const buildOpen = shownBuild !== null;

  const candidates = pickTeam && picks.status !== 'idle' ? (picks.data?.candidates ?? null) : null;
  const unavailable = useMemo(() => unavailableChampionIds(draft), [draft]);
  const [minConfidence] = useMinConfidence();
  const pool = useMemo(
    () =>
      championPool(lookup?.champions ?? [], unavailable, candidates, search, (c) =>
        meetsConfidence(c.confidence, minConfidence),
      ),
    [lookup, unavailable, candidates, search, minConfidence],
  );
  const poolIds = useMemo(
    () => [...pool.ranked.map((r) => r.champion.id), ...pool.rest.map((c) => c.id)],
    [pool],
  );
  const roving = useRoving(poolIds, 'grid');

  const act = (next: Draft) => {
    if (next === draft) return;
    setDraft(next);
    setSearch('');
  };
  const choose = (championId: number) => {
    if (turn?.kind === 'ban') act(ban(draft, championId));
    else if (role && pickTeam) {
      act(pick(draft, championId, role));
      setPreferred((p) => ({ ...p, [pickTeam]: null }));
    }
  };
  const stepBack = () => {
    const last = lastAction(draft);
    // The undone pick's role is chosen again for that team.
    if (last?.kind === 'pick') setPreferred((p) => ({ ...p, [last.team]: last.role }));
    setDraft(undo(draft));
  };
  const reset = (format: DraftFormat = draft.format) => {
    setDraft(emptyDraft(format));
    setPreferred(NO_PREFERENCE);
    setBuildOf(null);
    setSearch('');
  };
  const changeFormat = (competitive: boolean) => {
    const format: DraftFormat = competitive ? 'competitive' : 'soloq';
    saveFormat(format);
    reset(format);
  };
  const chooseRole = (team: Team, r: Position) => {
    setPreferred((p) => ({ ...p, [team]: r }));
    setBuildOf(null);
  };
  const swap = (team: Team, from: Position, to: Position) => {
    setDraft((d) => swapRoles(d, team, from, to));
    // The build shown follows its champion.
    setBuildOf((b) => {
      if (b?.team !== team) return b;
      if (b.role === from) return { team, role: to };
      return b.role === to ? { team, role: from } : b;
    });
  };
  const showBuild = (slot: Slot) =>
    setBuildOf((prev) => (prev?.team === slot.team && prev.role === slot.role ? null : slot));

  useImperativeHandle(
    handleRef,
    () => ({
      escapeState: () => {
        const input = searchRef.current;
        const focused = input !== null && document.activeElement === input;
        const s: SearchFocus = !focused ? 'none' : input.value ? 'filled' : 'empty';
        return { search: s, buildOpen };
      },
      escape: (action) => {
        if (action === 'clear-search') setSearch('');
        else if (action === 'blur-search') searchRef.current?.blur();
        else setBuildOf(null);
      },
      focusSearch: () => {
        setBuildOf(null);
        const input = searchRef.current;
        input?.focus();
        input?.select();
      },
    }),
    [buildOpen],
  );

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Tab / ArrowDown: into the grid, on the first champion; arrows move from there.
    if (enterListFromSearch(e, roving.focusFirst)) return;
    // Enter takes the first champion shown.
    if (e.key !== 'Enter') return;
    const first = pool.ranked[0]?.champion ?? pool.rest[0];
    if (first && search.trim()) choose(first.id);
  };

  const heading = pickTeam && role ? `${TEAM_LABEL[pickTeam]} ${ROLE_LABEL[role]}` : '';
  const competitive = draft.format === 'competitive';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2">
        <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Draft planner
        </span>
        <TurnStatus turn={turn} draft={draft} />
        {/* DOM order = Tab order: the search comes last, so Tab from it goes to the grid. */}
        <div className="ml-auto flex items-center gap-2">
          <span
            className="flex items-center gap-2"
            title="Tournament draft: 3 bans each, picks B1 R1 R2 B2 B3 R3, 2 bans each, picks R4 B4 B5 R5. Changing it starts a new draft."
          >
            <Switch
              id="draft-competitive"
              checked={competitive}
              onCheckedChange={changeFormat}
              aria-label="Competitive draft"
            />
            <Label htmlFor="draft-competitive" className="text-xs">
              Competitive
            </Label>
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={stepBack}
            disabled={draft.actions.length === 0}
            title="Step back one action"
          >
            <Undo2Icon data-icon="inline-start" />
            Undo
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => reset()}
            disabled={draft.actions.length === 0}
            title="Start a new draft"
          >
            <RotateCcwIcon data-icon="inline-start" />
            Reset
          </Button>
          <span className="flex items-center gap-2">
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              value={search}
              disabled={complete}
              onChange={(e) => {
                setSearch(e.target.value);
                setBuildOf(null);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder={SEARCH_PLACEHOLDER}
              aria-label="Search champion"
              aria-keyshortcuts={IS_MAC ? 'Meta+K Meta+F' : 'Control+K Control+F'}
              className="h-8 w-44 text-xs md:text-xs"
            />
          </span>
        </div>
      </div>

      <div className="border-b border-border px-3 py-1.5">
        <WinProbability
          result={evaluation}
          allies={OUTLOOK.blue}
          enemies={OUTLOOK.red}
          onRetry={retryEvaluation}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <TeamColumn
          team="blue"
          draft={draft}
          turn={turn}
          role={pickTeam === 'blue' ? role : null}
          buildOf={shownBuild}
          lookup={lookup}
          damage={evaluated?.damage.allies}
          onChooseRole={(r) => chooseRole('blue', r)}
          onShowBuild={showBuild}
          onSwap={(from, to) => swap('blue', from, to)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {shownBuild ? (
            <BuildView
              championId={shownBuild.request.championId}
              build={build}
              lookup={lookup}
              mastery={state.mastery[shownBuild.request.championId]}
              badge={`${TEAM_LABEL[shownBuild.team]} ${ROLE_LABEL[shownBuild.role]} · ${complete ? 'draft' : 'draft so far'}`}
              badgeTone="muted"
              leading={
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setBuildOf(null)}
                    title="Back to the draft (Esc)"
                  >
                    <ArrowLeftIcon data-icon="inline-start" />
                    Draft
                  </Button>
                  <span className="h-6 w-px bg-border" />
                </>
              }
              onRetry={retryBuild}
              mySpells={null}
              flashKey={state.settings.flashKey}
            />
          ) : complete ? (
            <div className="grid flex-1 place-items-center p-8 text-center">
              <div className="flex max-w-sm flex-col gap-2">
                <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  Draft complete
                </span>
                <p className="text-sm text-muted-foreground">
                  Click any of the 10 champions to see its build for this match: items, runes,
                  spells and skill order against the drafted enemies. A flex pick in the wrong lane?
                  Move it with the ⇄ button next to it.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                {turn?.kind === 'ban' ? (
                  <>
                    <span>
                      Click a champion to ban it for{' '}
                      <span className={TEAM_TEXT[turn.team]}>{TEAM_LABEL[turn.team]}</span>
                    </span>
                    <Button size="xs" variant="outline" onClick={() => act(ban(draft, null))}>
                      <BanIcon data-icon="inline-start" />
                      No ban
                    </Button>
                  </>
                ) : (
                  pickTeam && (
                    <RolePicker
                      team={pickTeam}
                      draft={draft}
                      role={role}
                      lookup={lookup}
                      displaced={displaced?.championId ?? null}
                      displacedTo={displacedTo}
                      onChoose={(r) => chooseRole(pickTeam, r)}
                    />
                  )
                )}
                {pickTeam && picks.status === 'loading' && (
                  <Loader2Icon className="size-3.5 animate-spin" aria-label="Updating" />
                )}
                {pickTeam && picks.status === 'ok' && (
                  <span className="num">patch {picks.data.patch}</span>
                )}
                {pickTeam && (
                  <span className="ml-auto hidden xl:inline">
                    score = sum of win-rate deltas (points), shrunk by sample size
                  </span>
                )}
                {pickTeam && (
                  <span className="ml-auto xl:ml-0">
                    <ConfidenceFilter />
                  </span>
                )}
              </div>

              {pickTeam && picks.status === 'error' && (
                <Notice
                  tone={picks.code === 'NO_DATA' ? 'warn' : 'bad'}
                  title={picks.code === 'NO_DATA' ? 'No data yet' : 'Recommendations unavailable'}
                  message={picks.message}
                  action={{ label: 'Retry', onClick: retryPicks }}
                />
              )}

              <div className="min-h-0 flex-1 overflow-y-auto">
                {!lookup ? (
                  <GridSkeleton />
                ) : (
                  <ChampionGrid
                    pool={pool}
                    banning={turn?.kind === 'ban'}
                    heading={heading}
                    loadingFirst={pickTeam !== null && picks.status === 'loading' && !candidates}
                    stale={picks.status === 'loading'}
                    role={role}
                    filtered={minConfidence !== 'LOW' && candidates !== null}
                    onChoose={choose}
                    roving={roving}
                  />
                )}
              </div>
            </>
          )}
        </main>

        <TeamColumn
          team="red"
          draft={draft}
          turn={turn}
          role={pickTeam === 'red' ? role : null}
          buildOf={shownBuild}
          lookup={lookup}
          damage={evaluated?.damage.enemies}
          onChooseRole={(r) => chooseRole('red', r)}
          onShowBuild={showBuild}
          onSwap={(from, to) => swap('red', from, to)}
        />
      </div>
    </div>
  );
}

function TurnStatus({ turn, draft }: { turn: DraftTurn | null; draft: Draft }) {
  if (!turn) {
    return <span className="text-sm font-semibold">Draft complete</span>;
  }
  const phase =
    turn.kind === 'pick'
      ? 'pick phase'
      : draft.format === 'competitive'
        ? `ban phase ${banPhase(draft, turn.number)}`
        : 'ban phase';
  return (
    <span className="flex items-baseline gap-2">
      <span className={cn('text-sm font-semibold', TEAM_TEXT[turn.team])}>
        {turn.kind === 'pick'
          ? `${turnLabel(turn)} · ${TEAM_LABEL[turn.team]} picks`
          : `${turnLabel(turn)} of 5`}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {phase}
        {draft.format === 'competitive' ? ' · competitive' : ''}
      </span>
    </span>
  );
}

/**
 * Role the team on turn picks for. A role it already has can be chosen too (flex pick placed in
 * the wrong lane): the new pick takes it and the champion there moves to the first open role.
 */
function RolePicker({
  team,
  draft,
  role,
  lookup,
  displaced,
  displacedTo,
  onChoose,
}: {
  team: Team;
  draft: Draft;
  role: Position | null;
  lookup: StaticLookup | null;
  /** Champion the pick would move out of `role`. */
  displaced: number | null;
  displacedTo: Position | null;
  onChoose: (role: Position) => void;
}) {
  const picks = teamPicks(draft, team);
  const name = (id: number) => lookup?.champion(id)?.name ?? `#${id}`;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span>
        <span className={TEAM_TEXT[team]}>{TEAM_LABEL[team]}</span> picks for
      </span>
      <span className="flex items-center" role="radiogroup" aria-label="Role picked for">
        {POSITIONS.map((p) => {
          const taken = picks[p];
          return (
            <Button
              key={p}
              size="xs"
              variant={p === role ? 'secondary' : 'ghost'}
              role="radio"
              aria-checked={p === role}
              onClick={() => onChoose(p)}
              title={
                taken
                  ? `${name(taken.championId)} plays ${ROLE_LABEL[p]}: picking for it moves them to an open role`
                  : undefined
              }
              className={cn(
                'px-2',
                p === role && 'text-foreground',
                taken && p !== role && 'text-muted-foreground/60',
              )}
            >
              {ROLE_LABEL[p]}
            </Button>
          );
        })}
      </span>
      {displaced !== null && displacedTo && (
        <span className="text-gold">
          {name(displaced)} moves to {ROLE_LABEL[displacedTo]}
        </span>
      )}
    </span>
  );
}

function ChampionGrid({
  pool,
  banning,
  heading,
  loadingFirst,
  stale,
  role,
  filtered,
  onChoose,
  roving,
}: {
  pool: { ranked: RankedChampion<PoolChampion>[]; rest: PoolChampion[] };
  banning: boolean;
  /** "Blue Mid": who the ranking is for. */
  heading: string;
  /** The first ranking of this turn is on its way: nothing to sort by yet. */
  loadingFirst: boolean;
  stale: boolean;
  role: Position | null;
  /** The confidence filter hides some recommendations: they are in the rest. */
  filtered: boolean;
  onChoose: (championId: number) => void;
  /** Arrow-key navigation over every tile (one tab stop for the whole grid). */
  roving: Pick<ReturnType<typeof useRoving<number>>, 'containerRef' | 'itemProps' | 'onKeyDown'>;
}) {
  if (loadingFirst) return <GridSkeleton />;
  const empty = pool.ranked.length === 0 && pool.rest.length === 0;
  if (empty) {
    return <p className="p-6 text-sm text-muted-foreground">No champion matches the search.</p>;
  }
  const verb = banning ? 'Ban' : 'Pick';
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the tiles (roving tabindex), the tiles themselves are buttons
    <div ref={roving.containerRef} onKeyDown={roving.onKeyDown} className="flex flex-col gap-2 p-2">
      {pool.ranked.length > 0 && (
        <>
          <div className="flex items-baseline gap-2 px-1">
            <span className="text-[10px] font-semibold tracking-[0.18em] uppercase">
              Best picks · {heading}
            </span>
            <span className="text-[10px] text-muted-foreground">
              hover or focus for the reasons · arrows to move
            </span>
          </div>
          <div className={GRID}>
            {pool.ranked.map((r) => (
              <RankedTile
                key={r.champion.id}
                ranked={r}
                heading={heading}
                stale={stale}
                onChoose={() => onChoose(r.champion.id)}
                focus={roving.itemProps(r.champion.id)}
              />
            ))}
          </div>
        </>
      )}
      {pool.rest.length > 0 && (
        <>
          {!banning && (
            <div className="px-1 pt-2 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              {filtered
                ? `Below the confidence filter or not enough data${role ? ` in ${ROLE_LABEL[role]}` : ''}`
                : pool.ranked.length > 0
                  ? `Not enough data${role ? ` in ${ROLE_LABEL[role]}` : ''}`
                  : 'No recommendation available'}
            </div>
          )}
          <div className={GRID}>
            {pool.rest.map((c) => (
              <PlainTile
                key={c.id}
                champion={c}
                dim={!banning && pool.ranked.length > 0}
                title={`${verb} ${c.name}`}
                onChoose={() => onChoose(c.id)}
                focus={roving.itemProps(c.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
