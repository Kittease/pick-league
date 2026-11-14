import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AppState } from '../../core/app-state.ts';
import { BuildPanel } from './components/build-panel';
import { ChampSelectBoard } from './components/champ-select-board';
import { PicksPanel } from './components/picks-panel';
import { StatusBar } from './components/status-bar';
import { TierListPage } from './components/tier-list';
import { useAutoView, ViewNav } from './components/view-nav';
import { type StaticLookup, useAppState, useStatic } from './hooks/use-app';

type Tab = 'picks' | 'build';

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
            : 'The helper finds the client by itself and reconnects if it restarts. No League at hand? Turn on demo mode in settings.'}
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

  if (!view) return null;
  // In game only the build is left: no picks, nothing to apply.
  const inGame = state.inGame;
  return (
    <div className="flex min-h-0 flex-1">
      <ChampSelectBoard view={view} lookup={lookup} mastery={state.mastery} inGame={inGame} />
      <main className="flex min-w-0 flex-1 flex-col">
        {!inGame && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-0 px-3 pt-2">
            <TabsList variant="line">
              <TabsTrigger value="picks">Picks</TabsTrigger>
              <TabsTrigger value="build">
                Build
                {target && !target.preview && <span className="size-1.5 rounded-full bg-primary" />}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {tab === 'picks' && !inGame ? (
          <PicksPanel state={state} lookup={lookup} />
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
            <TierListPage state={state} lookup={lookup} onBusyChange={setBusy} />
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
