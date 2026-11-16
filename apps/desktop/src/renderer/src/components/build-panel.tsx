import { BuildView } from '@pick-league/ui/components/build-view';
import { Button } from '@pick-league/ui/components/ui/button';
import { cn } from '@pick-league/ui/lib/utils';
import { CheckIcon, Loader2Icon, WandSparklesIcon } from 'lucide-react';
import type { AppState } from '../../../core/app-state.ts';
import type { StaticLookup } from '../hooks/use-app';

function ApplyBar({ state }: { state: AppState }) {
  const { apply, buildTarget, champSelect, settings } = state;
  if (state.inGame) {
    return (
      <span className="max-w-[340px] text-right text-[11px] leading-tight text-muted-foreground">
        Build as it was when champion select ended · shown until the game is over
      </span>
    );
  }
  const applying = apply.state === 'applying';
  const canApply =
    state.lcu.state === 'connected' && champSelect !== null && state.build.status === 'ok';
  return (
    <div className="flex items-center gap-3">
      <span className="max-w-[340px] text-right text-[11px] leading-tight text-muted-foreground">
        {apply.state === 'idle' &&
          (settings.autoApply
            ? buildTarget?.preview
              ? 'Runes + spells apply automatically when you lock in'
              : 'Waiting for the build to apply it'
            : 'Auto-apply is off')}
        {apply.state === 'applying' && 'Applying…'}
        {(apply.state === 'done' || apply.state === 'warning' || apply.state === 'error') && (
          <span
            className={cn(
              apply.state === 'done' && 'text-up',
              apply.state === 'warning' && 'text-gold',
              apply.state === 'error' && 'text-down',
            )}
          >
            {apply.auto ? 'Auto-applied: ' : ''}
            {apply.messages.join(' · ')}
          </span>
        )}
      </span>
      <Button
        size="sm"
        disabled={!canApply || applying}
        onClick={() => void window.pickleague.applyNow()}
      >
        {applying ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : apply.state === 'done' ? (
          <CheckIcon data-icon="inline-start" />
        ) : (
          <WandSparklesIcon data-icon="inline-start" />
        )}
        Apply runes + spells
      </Button>
    </div>
  );
}

export function BuildPanel({ state, lookup }: { state: AppState; lookup: StaticLookup | null }) {
  const { build, buildTarget } = state;
  if (!buildTarget) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted-foreground">
        <p className="max-w-sm">
          The build appears when you lock in. To look ahead, open a pick and choose “Preview build”.
        </p>
      </div>
    );
  }
  return (
    <BuildView
      championId={buildTarget.championId}
      build={build}
      lookup={lookup}
      mastery={state.mastery[buildTarget.championId]}
      badge={buildTarget.preview ? 'preview' : state.inGame ? 'in game' : 'locked in'}
      badgeTone={buildTarget.preview ? 'muted' : 'primary'}
      actions={<ApplyBar state={state} />}
      onRetry={() => void window.pickleague.refresh()}
      mySpells={state.champSelect?.mySpells ?? null}
      flashKey={state.settings.flashKey}
    />
  );
}
