import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AppState } from '../../core/app-state.ts';
import { BuildPanel } from './components/build-panel';
import { ChampSelectBoard } from './components/champ-select-board';
import { type DraftHandle, DraftPlanner } from './components/draft-planner';
import { LobbyPanel } from './components/lobby-panel';
import { PicksPanel } from './components/picks-panel';
import { StatusBar } from './components/status-bar';
import { type TierListHandle, TierListPage } from './components/tier-list';
import { useAutoView, ViewNav } from './components/view-nav';
import { type StaticLookup, useAppState, useStatic } from './hooks/use-app';
import { useShortcuts } from './hooks/use-shortcuts';
import { draftEscapeAction, escapeAction } from './lib/shortcuts';

type Tab = 'picks' | 'build' | 'lobby';

function Waiting({ state }: { state: AppState }) {
  const connected = state.lcu.state === 'connected';
  return (
    <main className="grid flex-1 place-items-center p-8">
      <div className="flex max-w-md flex-col gap-3">
        <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {connected ? 'Out of champion select' : 'League client'}
        </span>
        <h1 className="text-2xl font-semibold">
          {connected ? 'Queue up — picks show here in champ select.' : 'Open League of Legends.'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {connected
            ? 'When champion select starts, you get ranked picks for your role with the reasons behind them, then your build once you lock in.'
            : 'The helper finds the client by itself and reconnects if it restarts.'}
        </p>
        {state.api.state === 'down' && (
          <p className="text-sm text-down">
            The API at <span className="num">{state.api.url}</span> isn't answering — check the
            address in settings or start it with <span className="num">docker compose up -d</span>.
          </p>
        )}
      </div>
    </main>
  );
}

function ChampSelect({ state, lookup }: { state: AppState; lookup: StaticLookup | null }) {
  const view = state.champSelect;
  const [tab, setTab] = useState<Tab>('picks');
  const locked = view?.lockedIn ?? false;
  const target = state.buildTarget;

  // Lock-in → show the build; a new preview request → show the build too.
  const lastLocked = useRef(false);
  const lastPreview = useRef<number | null>(null);
  useEffect(() => {
    if (locked && !lastLocked.current) setTab('build');
    lastLocked.current = locked;
  }, [locked]);
  useEffect(() => {
    const preview = target?.preview ? target.championId : null;
    if (preview !== null && preview !== lastPreview.current) setTab('build');
    lastPreview.current = preview;
  }, [target]);
  // The match has started (the lobby lookup only begins then): show the players. The build was
  // on screen through champion select and the loading screen, and stays one click away.
  const lobbyStarted = state.lobby !== null;
  const lastLobby = useRef(false);
  useEffect(() => {
    if (lobbyStarted && !lastLobby.current) setTab('lobby');
    lastLobby.current = lobbyStarted;
  }, [lobbyStarted]);

  if (!view) return null;
  // In game: no picks, nothing to apply; the build and the players of the match.
  const inGame = state.inGame;
  const shown: Tab = inGame
    ? tab === 'lobby'
      ? 'lobby'
      : 'build'
    : tab === 'picks'
      ? 'picks'
      : 'build';
  const lobbyLoading = state.lobby?.state === 'loading';
  return (
    <div className="flex min-h-0 flex-1">
      <ChampSelectBoard view={view} lookup={lookup} mastery={state.mastery} inGame={inGame} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Tabs value={shown} onValueChange={(v) => setTab(v as Tab)} className="gap-0 px-3 pt-2">
          <TabsList variant="line">
            {!inGame && <TabsTrigger value="picks">Picks</TabsTrigger>}
            <TabsTrigger value="build">
              Build
              {!inGame && target && !target.preview && (
                <span className="size-1.5 rounded-full bg-primary" />
              )}
            </TabsTrigger>
            {inGame && (
              <TabsTrigger value="lobby">
                Lobby
                {lobbyLoading && (
                  <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                )}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
        {shown === 'picks' ? (
          <PicksPanel state={state} lookup={lookup} />
        ) : shown === 'lobby' ? (
          <LobbyPanel lobby={state.lobby} lookup={lookup} />
        ) : (
          <BuildPanel state={state} lookup={lookup} />
        )}
      </main>
    </div>
  );
}

export function App() {
  const state = useAppState();
  const lookup = useStatic(state?.staticVersion);
  const { view, setView, setBusy } = useAutoView(Boolean(state?.champSelect));

  // Escape steps back (search text, build page, details, champion select → tier list); Ctrl/Cmd+K
  // or F jumps to the tier list search. See `escapeAction` for the order. The draft planner
  // keeps both to itself (`draftEscapeAction`, its own search).
  const tierList = useRef<TierListHandle>(null);
  const draft = useRef<DraftHandle>(null);
  useShortcuts((shortcut) => {
    const list = tierList.current;
    if (!state || !list) return false;
    if (view === 'draft') {
      const planner = draft.current;
      if (!planner) return false;
      if (shortcut === 'focus-search') {
        planner.focusSearch();
        return true;
      }
      const action = draftEscapeAction(planner.escapeState());
      if (action === null) return false;
      planner.escape(action);
      return true;
    }
    if (shortcut === 'focus-search') {
      setView('tierlist');
      list.focusSearch();
      return true;
    }
    const action = escapeAction({ view, ...list.escapeState() });
    if (action === null) return false;
    if (action === 'show-tier-list') setView('tierlist');
    else list.escape(action);
    return true;
  });

  // Toast each finished apply once.
  const lastApplyAt = useRef<string | null>(null);
  useEffect(() => {
    const apply = state?.apply;
    if (!apply?.at || apply.at === lastApplyAt.current) return;
    lastApplyAt.current = apply.at;
    const text = apply.messages.join(' · ');
    const title = apply.auto ? 'Applied on lock-in' : 'Applied';
    if (apply.state === 'done') toast.success(title, { description: text });
    else if (apply.state === 'warning') toast.warning('Partly applied', { description: text });
    else if (apply.state === 'error') toast.error('Not applied', { description: text });
  }, [state?.apply]);

  if (!state) return <div className="h-full bg-background" />;
  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-background text-foreground">
        <StatusBar state={state} />
        <div className="flex min-h-0 flex-1">
          <ViewNav
            view={view}
            onChange={setView}
            liveSelect={state.champSelect !== null}
            inGame={state.inGame}
          />
          {/* Kept mounted so role, filters and selection survive a trip to champ select. */}
          <div className={view === 'tierlist' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}>
            <TierListPage
              state={state}
              lookup={lookup}
              onBusyChange={setBusy}
              handleRef={tierList}
            />
          </div>
          {/* Kept mounted too: the draft survives a trip to the other views. */}
          <div className={view === 'draft' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}>
            <DraftPlanner state={state} lookup={lookup} handleRef={draft} />
          </div>
          {view === 'select' && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {state.champSelect ? (
                <ChampSelect state={state} lookup={lookup} />
              ) : (
                <Waiting state={state} />
              )}
            </div>
          )}
        </div>
      </div>
      <Toaster theme="dark" position="bottom-right" />
    </TooltipProvider>
  );
}
