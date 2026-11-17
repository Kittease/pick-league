import { CollectionBanner } from '@pick-league/ui/components/collection-banner';
import { compact } from '@pick-league/ui/lib/format';
import { cn } from '@pick-league/ui/lib/utils';
import type { AppState } from '../../../core/app-state.ts';
import { SettingsSheet } from './settings-sheet';
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
  // Collection warnings only while the API answers.
  const statsStatus = api.state === 'ok' ? state.stats.status : null;
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
    <>
      <header
        className={cn(
          'flex h-11 shrink-0 items-center gap-3.5 border-b border-border pl-4 text-xs whitespace-nowrap',
          chrome?.customControls ? 'app-drag pr-0' : 'pr-4',
        )}
      >
        <span className="shrink-0 font-semibold tracking-[0.2em] uppercase">PickLeague</span>

        <span className="h-4 w-px shrink-0 bg-border" />

        <span className="flex min-w-0 items-center gap-2" title={lcu.message ?? undefined}>
          <Dot tone={lcuTone} />
          <span className="hidden text-muted-foreground lg:inline">League</span>
          <span className="truncate">
            {lcu.state === 'connected'
              ? (lcu.account ?? 'connected')
              : (lcu.message ?? 'searching…')}
          </span>
        </span>

        <span className="flex min-w-0 shrink-0 items-center gap-2" title={api.message ?? api.url}>
          <Dot tone={apiTone} />
          <span className="text-muted-foreground">API</span>
          <span className="truncate">
            {api.state === 'ok'
              ? `patch ${api.latestPatch} · ${compact(api.patchMatchCount ?? api.matchCount ?? 0)} matches`
              : api.state === 'checking'
                ? 'checking…'
                : (api.message ?? 'unreachable')}
          </span>
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-3">
          <span className="hidden text-muted-foreground xl:inline">
            Auto-apply {state.settings.autoApply ? 'on' : 'off'}
          </span>
          <SettingsSheet state={state} />
        </span>
        {chrome?.customControls && <WindowControls maximized={chrome.maximized} />}
      </header>
      <CollectionBanner status={statsStatus} />
    </>
  );
}
