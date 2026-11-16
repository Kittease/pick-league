import type { DraftEvaluationResponse, Reason, TeamDamage } from '@pick-league/shared';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@pick-league/ui/components/ui/hover-card';
import { cn } from '@pick-league/ui/lib/utils';
import { Loader2Icon } from 'lucide-react';
import { compact, patchesText } from '@/lib/format';
import { damageLabel, damageShares, roundedShares } from '@/lib/outlook';
import type { Loadable } from '../../../core/app-state.ts';
import type { StaticLookup } from '../hooks/use-app';
import { ReasonList } from './reasons';

/** Draft reasons read better with their own names. */
const DRAFT_KIND_LABELS: Partial<Record<Reason['kind'], string>> = {
  base: 'Champion',
  matchup: 'Matchup',
  duo: 'Duo',
  with_comp: 'Synergy',
  side: 'Side',
};

/** Colours of the damage types (AD warm, AP violet, true neutral). */
const DAMAGE_COLOR = { physical: '#e8955a', magic: '#9b86f0', true: '#c9c9c9' } as const;

export interface OutlookSide {
  /** "Blue" / "Your team". */
  label: string;
  /** Text colour class of the side. */
  text: string;
  /** Background colour class of the side's bar. */
  bar: string;
}

/**
 * Win probability of the draft as it stands: a bar split between both sides, the reasons behind
 * it on hover (or keyboard focus). Keeps the previous figure, faded, while the next one loads.
 */
export function WinProbability({
  result,
  allies,
  enemies,
  onRetry,
  className,
}: {
  result: Loadable<DraftEvaluationResponse>;
  allies: OutlookSide;
  enemies: OutlookSide;
  onRetry?: () => void;
  className?: string;
}) {
  const data = result.status === 'idle' ? null : result.data;
  const loading = result.status === 'loading';
  if (result.status === 'error' && !data) {
    return (
      <div className={cn('flex items-center gap-2 text-[11px] text-muted-foreground', className)}>
        <span className="text-[10px] font-semibold tracking-[0.18em] uppercase">Win chance</span>
        <span>unavailable</span>
        {onRetry && (
          <button type="button" className="underline hover:text-foreground" onClick={onRetry}>
            retry
          </button>
        )}
      </div>
    );
  }
  const p = data?.winProbability ?? 0.5;
  const mine = Math.round(p * 1000) / 10;
  const theirs = Math.round((100 - mine) * 10) / 10;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={250}
        render={
          <button
            type="button"
            aria-label={`Win chance: ${allies.label} ${mine}%, ${enemies.label} ${theirs}%`}
            className={cn(
              'flex w-full items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring',
              className,
            )}
          />
        }
      >
        <span className="shrink-0 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Win chance
        </span>
        <span className={cn('num w-11 shrink-0 text-right text-xs font-semibold', allies.text)}>
          {data ? `${mine.toFixed(1)}%` : '—'}
        </span>
        <span
          className={cn(
            'relative flex h-2 min-w-16 flex-1 bg-secondary transition-opacity',
            loading && 'opacity-50',
          )}
        >
          {data && (
            <>
              <span className={cn('h-full', allies.bar)} style={{ width: `${mine}%` }} />
              <span className={cn('h-full flex-1', enemies.bar)} />
            </>
          )}
          <span className="absolute inset-y-[-3px] left-1/2 w-px bg-foreground/60" />
        </span>
        <span className={cn('num w-11 shrink-0 text-xs font-semibold', enemies.text)}>
          {data ? `${theirs.toFixed(1)}%` : '—'}
        </span>
        {loading && <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />}
      </HoverCardTrigger>
      {data && (
        <HoverCardContent className="w-[460px]" side="bottom" align="start">
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <span className={cn('text-sm font-semibold', allies.text)}>
                {allies.label} {mine.toFixed(1)}%
              </span>
              <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                win chance · patch {patchesText(data.patchesUsed)}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              From high-elo matches: each champion's strength in its role, lane matchups and duos
              (each pair once), and the side. Champions not picked yet count as average. Deltas are
              from {allies.label.toLowerCase()}'s point of view.
            </p>
            <ReasonList reasons={data.reasons} kindLabels={DRAFT_KIND_LABELS} />
          </div>
        </HoverCardContent>
      )}
    </HoverCard>
  );
}

/**
 * A team's damage split: stacked AD / AP / true bar from its champions' average damage to
 * champions per minute; per-champion figures in the tooltip.
 */
export function DamageSplit({
  damage,
  lookup,
  className,
}: {
  damage: TeamDamage | null | undefined;
  lookup: StaticLookup | null;
  className?: string;
}) {
  const shares = damageShares(damage);
  const rounded = shares ? roundedShares(shares) : null;
  const title =
    shares && damage
      ? [
          `${damageLabel(shares)} · ${compact(Math.round(shares.perMinute))} damage/min`,
          ...damage.champions.map((c) => {
            const name = lookup?.champion(c.championId)?.name ?? `#${c.championId}`;
            return `${name}: ${Math.round(c.physical)} AD · ${Math.round(c.magic)} AP · ${Math.round(c.true)} true /min`;
          }),
        ].join('\n')
      : 'No champion picked yet';
  return (
    <div className={cn('flex flex-col gap-1', className)} title={title}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Damage
        </span>
        <span className="num text-[10px] whitespace-nowrap text-muted-foreground">
          {shares ? `${compact(Math.round(shares.perMinute))}/min` : '—'}
        </span>
      </div>
      <span
        className="flex h-1.5 w-full bg-secondary"
        role="img"
        aria-label={shares ? `Damage: ${damageLabel(shares)}` : 'Damage: no champion yet'}
      >
        {shares &&
          (['physical', 'magic', 'true'] as const).map((k) => (
            <span
              key={k}
              className="h-full"
              style={{ width: `${shares[k] * 100}%`, background: DAMAGE_COLOR[k] }}
            />
          ))}
      </span>
      {rounded && (
        <span className="num text-[10px] whitespace-nowrap">
          <span style={{ color: DAMAGE_COLOR.physical }}>AD {rounded.physical}%</span>
          <span className="text-muted-foreground"> · </span>
          <span style={{ color: DAMAGE_COLOR.magic }}>AP {rounded.magic}%</span>
          <span className="text-muted-foreground"> · </span>
          <span style={{ color: DAMAGE_COLOR.true }}>true {rounded.true}%</span>
        </span>
      )}
    </div>
  );
}
