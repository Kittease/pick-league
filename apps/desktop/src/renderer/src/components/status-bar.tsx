import { compact } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../../../core/app-state.ts';
import { SettingsSheet } from './settings-sheet';
import { StatsFreshness } from './stats-freshness';
import { useWindowState, WindowControls } from './window-controls';

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 rounded-full',
        tone === 'ok' && 'bg-up',
        tone === 'warn' && 'bg-gold',
        tone === 'bad' && 'bg-down',
        tone === 'idle' && 'animate-pulse bg-muted-foreground',
      )}
    />
  );
}

export function StatusBar({ state }: { state: AppState }) {
  const { lcu, api } = state;
  const chrome = useWindowState();
  const lcuTone = lcu.state === 'connected' ? 'ok' : 'idle';
  const apiTone =
    api.state === 'ok'
      ? 'ok'
      : api.state === 'no_data'
        ? 'warn'
        : api.state === 'down'
          ? 'bad'
          : 'idle';
  return (
    <header
      className={cn(
        'flex h-11 shrink-0 items-center gap-3.5 border-b border-border pl-4 text-xs whitespace-nowrap',
        chrome?.customControls ? 'app-drag pr-0' : 'pr-4',
      )}
    >
      <span className="flex shrink-0 items-baseline gap-1.5">
        <span className="font-semibold tracking-[0.2em] uppercase">PickLeague</span>
        <span className="hidden text-[10px] text-muted-foreground xl:inline">support desk</span>
      </span>

      <span className="h-4 w-px shrink-0 bg-border" />

      <span className="flex min-w-0 items-center gap-2" title={lcu.message ?? undefined}>
        <Dot tone={lcuTone} />
        <span className="hidden text-muted-foreground lg:inline">League</span>
        <span className="truncate">
          {lcu.state === 'connected' ? (lcu.account ?? 'connected') : (lcu.message ?? 'searching…')}
        </span>
        {lcu.mock && (
          <span className="bg-primary/15 px-1.5 py-px text-[10px] font-semibold tracking-wider text-primary uppercase">
            mock
          </span>
        )}
      </span>

      <span className="flex min-w-0 shrink-0 items-center gap-2" title={api.message ?? api.url}>
        <Dot tone={apiTone} />
        <span className="text-muted-foreground">API</span>
        <span className="truncate">
          {api.state === 'ok'
            ? `patch ${api.latestPatch} · ${compact(api.matchCount ?? 0)} matches`
            : api.state === 'checking'
              ? 'checking…'
              : (api.message ?? 'unreachable')}
        </span>
      </span>

      <StatsFreshness state={state} />

      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className="hidden text-muted-foreground xl:inline">
          Auto-apply {state.settings.autoApply ? 'on' : 'off'}
        </span>
        <SettingsSheet state={state} />
      </span>
      {chrome?.customControls && <WindowControls maximized={chrome.maximized} />}
    </header>
  );
}
