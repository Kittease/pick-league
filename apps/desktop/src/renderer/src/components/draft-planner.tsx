import { type PickCandidate, POSITIONS, type Position } from '@pick-league/shared';
import {
  ArrowLeftIcon,
  BanIcon,
  HammerIcon,
  Loader2Icon,
  RotateCcwIcon,
  SearchIcon,
  Undo2Icon,
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
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { compact, confidenceLabel, patchesText, percent, ROLE_LABEL } from '@/lib/format';
import { type DraftEscapeAction, type SearchFocus, shortcutLabel } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import type { ApiResult, AppState, Loadable } from '../../../core/app-state.ts';
import {
  ban,
  championPool,
  currentTurn,
  type Draft,
  type DraftTurn,
  draftBuildRequest,
  draftPicksRequest,
  EMPTY_DRAFT,
  isComplete,
  lastAction,
  pick,
  pickRole,
  type RankedChampion,
  type Team,
  teamBans,
  teamPicks,
  turnLabel,
  unavailableChampionIds,
  undo,
} from '../../../core/draft.ts';
import type { StaticLookup } from '../hooks/use-app';
import { IS_MAC } from '../hooks/use-shortcuts';
import { BuildView } from './build-panel';
import { ChampionIcon, GameIcon } from './game-icon';
import { Notice } from './notice';
import { ConfidencePips } from './picks-panel';
import { DeltaText, ReasonList } from './reasons';

/** Draft changes made in quick succession only ask the API once they settle. */
const DEBOUNCE_MS = 250;
/** Answers kept per call kind, so undo / redo of the same state is instant. */
const CACHE_LIMIT = 60;

const TEAM_LABEL: Record<Team, string> = { blue: 'Blue', red: 'Red' };
const TEAM_TEXT: Record<Team, string> = { blue: 'text-[#5ba4e5]', red: 'text-[#e2555f]' };
const TEAM_BAR: Record<Team, string> = { blue: 'bg-[#5ba4e5]', red: 'bg-[#e2555f]' };

/**
 * One-off API call for a request built from the draft: debounced, stale answers dropped, answers
 * cached per request (cleared when the API data changes). `keepWhileLoading` keeps showing the
 * previous answer until the new one lands.
 */
function useDraftCall<Req, Res>(
  request: Req | null,
  call: (request: Req) => Promise<ApiResult<Res>>,
  apiKey: string,
  keepWhileLoading: boolean,
): { result: Loadable<Res>; retry: () => void } {
  const key = request === null ? null : JSON.stringify(request);
  const latest = useRef({ request, call });
  latest.current = { request, call };
  const cache = useRef(new Map<string, Res>());
  const lastApiKey = useRef(apiKey);
  const [result, setResult] = useState<Loadable<Res>>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the request is read through `latest` (its key is the dependency); nonce re-runs the call on retry
  useEffect(() => {
    if (lastApiKey.current !== apiKey) {
      cache.current.clear();
      lastApiKey.current = apiKey;
    }
    const { request: body, call: send } = latest.current;
    if (key === null || body === null) {
      setResult({ status: 'idle' });
      return;
    }
    const hit = cache.current.get(key);
    if (hit) {
      setResult({ status: 'ok', data: hit });
      return;
    }
    setResult((prev) => ({
      status: 'loading',
      data: keepWhileLoading && prev.status !== 'idle' ? prev.data : null,
    }));
    let alive = true;
    const timer = setTimeout(() => {
      void send(body).then((r) => {
        if (!alive) return;
        if (!r.ok) {
          setResult({ status: 'error', code: r.code, message: r.message, data: null });
          return;
        }
        cache.current.set(key, r.data);
        const oldest = cache.current.keys().next();
        if (cache.current.size > CACHE_LIMIT && !oldest.done) cache.current.delete(oldest.value);
        setResult({ status: 'ok', data: r.data });
      });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, apiKey, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { result, retry };
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
        if (id === undefined) {
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots
              key={i}
              title={active ? 'Banning now' : `Ban ${i + 1}`}
              className={cn(
                'size-[26px] shrink-0 border border-dashed border-border',
                active && 'animate-pulse border-primary',
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
              className="grid size-[26px] shrink-0 place-items-center bg-secondary text-muted-foreground"
            >
              <BanIcon className="size-3" />
            </span>
          );
        }
        const c = lookup?.champion(id);
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots
        return <GameIcon key={i} src={c?.iconUrl} alt={c?.name ?? `#${id}`} size={26} dim />;
      })}
    </div>
  );
}

function TeamColumn({
  team,
  draft,
  turn,
  role,
  buildOf,
  lookup,
  onChooseRole,
  onShowBuild,
}: {
  team: Team;
  draft: Draft;
  turn: DraftTurn | null;
  /** Role picked for on this turn (null when it is not this team's pick). */
  role: Position | null;
  buildOf: Slot | null;
  lookup: StaticLookup | null;
  onChooseRole: (role: Position) => void;
  onShowBuild: (slot: Slot) => void;
}) {
  const picks = teamPicks(draft, team);
  const onTurn = turn?.team === team;
  const picking = onTurn && turn?.kind === 'pick';
  return (
    <aside
      className={cn(
        'flex w-[188px] shrink-0 flex-col gap-3 overflow-y-auto border-border py-2',
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
            <li key={p}>
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
                  'group flex w-full items-center gap-2.5 px-3 py-1.5 text-left outline-none',
                  (slot || canChoose) && 'hover:bg-accent/60 focus-visible:bg-accent/60',
                  (active || shown) && 'bg-card shadow-[inset_2px_0_0_var(--primary)]',
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
                  <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                    {ROLE_LABEL[p]}
                  </span>
                </span>
                {slot && (
                  <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                    <HammerIcon className="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                    <span className="num text-[10px]">
                      {turnLabel({ kind: 'pick', team, number: slot.number })}
                    </span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
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
}: {
  ranked: RankedChampion<PoolChampion>;
  heading: string;
  /** The ranking is being updated for the new draft state. */
  stale: boolean;
  onChoose: () => void;
}) {
  const { champion, candidate, rank } = ranked;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={350}
        render={<button type="button" onClick={onChoose} className={TILE} />}
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
}: {
  champion: PoolChampion;
  dim: boolean;
  title: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
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
 * Draft planner: a ranked solo/duo draft played by hand (no League client needed). The team on
 * turn bans, then picks for a role, from a grid ordered by the pick recommendations for that
 * team and role; any drafted champion shows its build against the drafted teams.
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
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /** Role last chosen per team; the first open one when it is taken. */
  const [preferred, setPreferred] = useState(NO_PREFERENCE);
  const [buildOf, setBuildOf] = useState<Slot | null>(null);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // A new API, patch or stats refresh drops the cached answers.
  const lastRefreshedAt = state.stats.status?.lastRefreshedAt ?? null;
  const apiKey = `${state.api.url}|${state.api.latestPatch}|${state.api.state === 'ok'}|${lastRefreshedAt}`;

  const turn = currentTurn(draft);
  const complete = isComplete(draft);
  const pickTeam = turn?.kind === 'pick' ? turn.team : null;
  const role = pickTeam ? pickRole(draft, pickTeam, preferred[pickTeam]) : null;

  const picksRequest = useMemo(
    () => (pickTeam && role ? draftPicksRequest(draft, pickTeam, role) : null),
    [draft, pickTeam, role],
  );
  const { result: picks, retry: retryPicks } = useDraftCall(
    picksRequest,
    (r) => window.pickleague.draftPicks(r),
    apiKey,
    true,
  );
  const buildRequest = useMemo(
    () => (buildOf ? draftBuildRequest(draft, buildOf.team, buildOf.role) : null),
    [draft, buildOf],
  );
  const { result: build, retry: retryBuild } = useDraftCall(
    buildRequest,
    (r) => window.pickleague.draftBuild(r),
    apiKey,
    false,
  );
  // A slot emptied by Undo / Reset closes its build.
  const shownBuild = buildOf && buildRequest ? { ...buildOf, request: buildRequest } : null;
  const buildOpen = shownBuild !== null;

  const candidates = pickTeam && picks.status !== 'idle' ? (picks.data?.candidates ?? null) : null;
  const unavailable = useMemo(() => unavailableChampionIds(draft), [draft]);
  const pool = useMemo(
    () => championPool(lookup?.champions ?? [], unavailable, candidates, search),
    [lookup, unavailable, candidates, search],
  );

  const act = (next: Draft) => {
    if (next === draft) return;
    setDraft(next);
    setSearch('');
  };
  const choose = (championId: number) => {
    if (turn?.kind === 'ban') act(ban(draft, championId));
    else if (role) act(pick(draft, championId, role));
  };
  const stepBack = () => {
    const last = lastAction(draft);
    // The undone pick's role is chosen again for that team.
    if (last?.kind === 'pick') setPreferred((p) => ({ ...p, [last.team]: last.role }));
    setDraft(undo(draft));
  };
  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setPreferred(NO_PREFERENCE);
    setBuildOf(null);
    setSearch('');
  };
  const chooseRole = (team: Team, r: Position) => {
    setPreferred((p) => ({ ...p, [team]: r }));
    setBuildOf(null);
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

  const heading = pickTeam && role ? `${TEAM_LABEL[pickTeam]} ${ROLE_LABEL[role]}` : '';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2">
        <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Draft planner
        </span>
        <TurnStatus turn={turn} />
        <div className="ml-auto flex items-center gap-2">
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
              onKeyDown={(e) => {
                // Enter takes the first champion shown.
                if (e.key !== 'Enter') return;
                const first = pool.ranked[0]?.champion ?? pool.rest[0];
                if (first && search.trim()) choose(first.id);
              }}
              placeholder={SEARCH_PLACEHOLDER}
              aria-label="Search champion"
              aria-keyshortcuts={IS_MAC ? 'Meta+K Meta+F' : 'Control+K Control+F'}
              className="h-8 w-44 text-xs md:text-xs"
            />
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
            onClick={reset}
            disabled={draft.actions.length === 0}
            title="Start a new draft"
          >
            <RotateCcwIcon data-icon="inline-start" />
            Reset
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <TeamColumn
          team="blue"
          draft={draft}
          turn={turn}
          role={pickTeam === 'blue' ? role : null}
          buildOf={shownBuild}
          lookup={lookup}
          onChooseRole={(r) => chooseRole('blue', r)}
          onShowBuild={showBuild}
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
                  spells and skill order against the drafted enemies.
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
                    onChoose={choose}
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
          onChooseRole={(r) => chooseRole('red', r)}
          onShowBuild={showBuild}
        />
      </div>
    </div>
  );
}

function TurnStatus({ turn }: { turn: DraftTurn | null }) {
  if (!turn) {
    return <span className="text-sm font-semibold">Draft complete</span>;
  }
  return (
    <span className="flex items-baseline gap-2">
      <span className={cn('text-sm font-semibold', TEAM_TEXT[turn.team])}>
        {turn.kind === 'pick'
          ? `${turnLabel(turn)} · ${TEAM_LABEL[turn.team]} picks`
          : `${turnLabel(turn)} of 5`}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {turn.kind === 'ban' ? 'ban phase' : 'pick phase'}
      </span>
    </span>
  );
}

function RolePicker({
  team,
  draft,
  role,
  onChoose,
}: {
  team: Team;
  draft: Draft;
  role: Position | null;
  onChoose: (role: Position) => void;
}) {
  const picks = teamPicks(draft, team);
  return (
    <span className="flex items-center gap-2">
      <span>
        <span className={TEAM_TEXT[team]}>{TEAM_LABEL[team]}</span> picks for
      </span>
      <span className="flex items-center" role="radiogroup" aria-label="Role picked for">
        {POSITIONS.map((p) => (
          <Button
            key={p}
            size="xs"
            variant={p === role ? 'secondary' : 'ghost'}
            role="radio"
            aria-checked={p === role}
            disabled={picks[p] !== undefined}
            onClick={() => onChoose(p)}
            className={cn('px-2', p === role && 'text-foreground')}
          >
            {ROLE_LABEL[p]}
          </Button>
        ))}
      </span>
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
  onChoose,
}: {
  pool: { ranked: RankedChampion<PoolChampion>[]; rest: PoolChampion[] };
  banning: boolean;
  /** "Blue Mid": who the ranking is for. */
  heading: string;
  /** The first ranking of this turn is on its way: nothing to sort by yet. */
  loadingFirst: boolean;
  stale: boolean;
  role: Position | null;
  onChoose: (championId: number) => void;
}) {
  if (loadingFirst) return <GridSkeleton />;
  const empty = pool.ranked.length === 0 && pool.rest.length === 0;
  if (empty) {
    return <p className="p-6 text-sm text-muted-foreground">No champion matches the search.</p>;
  }
  const verb = banning ? 'Ban' : 'Pick';
  return (
    <div className="flex flex-col gap-2 p-2">
      {pool.ranked.length > 0 && (
        <>
          <div className="flex items-baseline gap-2 px-1">
            <span className="text-[10px] font-semibold tracking-[0.18em] uppercase">
              Best picks · {heading}
            </span>
            <span className="text-[10px] text-muted-foreground">hover for the reasons</span>
          </div>
          <div className={GRID}>
            {pool.ranked.map((r) => (
              <RankedTile
                key={r.champion.id}
                ranked={r}
                heading={heading}
                stale={stale}
                onChoose={() => onChoose(r.champion.id)}
              />
            ))}
          </div>
        </>
      )}
      {pool.rest.length > 0 && (
        <>
          {!banning && (
            <div className="px-1 pt-2 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              {pool.ranked.length > 0
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
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
