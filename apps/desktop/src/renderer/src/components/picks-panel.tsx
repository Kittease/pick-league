import type { PickCandidate, PicksResponse } from '@pick-league/shared';
import { Button } from '@pick-league/ui/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@pick-league/ui/components/ui/collapsible';
import { Skeleton } from '@pick-league/ui/components/ui/skeleton';
import { useMinConfidence } from '@pick-league/ui/hooks/use-min-confidence';
import { type RovingItemProps, useRoving } from '@pick-league/ui/hooks/use-roving';
import {
  type ConfidenceLevel,
  confidenceLevel,
  MIN_CONFIDENCE_LABEL,
  meetsConfidence,
} from '@pick-league/ui/lib/confidence';
import {
  compact,
  confidenceLabel,
  patchesText,
  percent,
  ROLE_LABEL,
} from '@pick-league/ui/lib/format';
import { cn } from '@pick-league/ui/lib/utils';
import { ChevronDownIcon, HammerIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppState } from '../../../core/app-state.ts';
import type { StaticLookup } from '../hooks/use-app';
import { ConfidenceFilter } from './filter-select';
import { ChampionIcon } from './game-icon';
import { Notice } from './notice';
import { DeltaText, ReasonHeadline, ReasonList, ReasonStrip } from './reasons';

const PIPS: Record<ConfidenceLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

export function ConfidencePips({ confidence }: { confidence: number }) {
  const filled = PIPS[confidenceLevel(confidence)];
  return (
    <span className="flex gap-0.5" title={`${confidenceLabel(confidence)} confidence`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn('h-2.5 w-1', i <= filled ? 'bg-foreground/70' : 'bg-secondary')}
        />
      ))}
    </span>
  );
}

function CandidateRow({
  rank,
  candidate,
  lookup,
  mastery,
  currentPatch,
  previewing,
  defaultOpen,
  focus,
}: {
  rank: number;
  candidate: PickCandidate;
  lookup: StaticLookup | null;
  mastery: AppState['mastery'];
  currentPatch: string;
  previewing: boolean;
  defaultOpen: boolean;
  /** Arrow-key navigation between rows (one tab stop for the whole list). */
  focus: RovingItemProps;
}) {
  // The top pick stays expanded until the user toggles it themselves.
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? defaultOpen;
  const champ = lookup?.champion(candidate.championId);
  const name = champ?.name ?? `#${candidate.championId}`;
  const merged = candidate.patchesUsed.length > 1;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('border-b border-border', open && 'bg-card')}
    >
      <CollapsibleTrigger
        {...focus}
        className="grid w-full grid-cols-[22px_44px_1fr_64px_80px_60px_16px] items-center gap-3 px-3 py-2 text-left hover:bg-accent/60 focus-visible:outline-1 focus-visible:outline-ring"
      >
        <span className="num text-[11px] text-muted-foreground">{rank}</span>
        <ChampionIcon
          src={champ?.iconUrl}
          name={name}
          size={40}
          mastery={mastery[candidate.championId]}
        />
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            {merged && (
              <span
                className="text-[10px] text-gold"
                title={`Too few matchups on ${currentPatch} alone: both patches combined`}
              >
                {patchesText(candidate.patchesUsed)} data
              </span>
            )}
          </span>
          {!open && <ReasonHeadline reasons={candidate.reasons} />}
          <ReasonStrip reasons={candidate.reasons} />
        </span>
        <span className="flex flex-col items-end leading-tight">
          <DeltaText delta={candidate.score} className="text-sm font-semibold" />
          <span className="text-[10px] text-muted-foreground">score</span>
        </span>
        <span className="flex flex-col items-end leading-tight">
          <span className="num text-xs">{percent(candidate.winRate)}</span>
          <span className="num text-[10px] text-muted-foreground">
            {compact(candidate.games)} games
          </span>
        </span>
        <span className="flex justify-end">
          <ConfidencePips confidence={candidate.confidence} />
        </span>
        <ChevronDownIcon
          className={cn(
            'size-3.5 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 pr-3 pb-3 pl-[81px]">
          <ReasonList reasons={candidate.reasons} />
          <div className="flex items-center gap-3">
            <Button
              size="xs"
              variant={previewing ? 'secondary' : 'outline'}
              onClick={() =>
                void window.pickleague.previewBuild(previewing ? null : candidate.championId)
              }
            >
              <HammerIcon data-icon="inline-start" />
              {previewing ? 'Hide build preview' : 'Preview build'}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {confidenceLabel(candidate.confidence)} confidence · patch{' '}
              {patchesText(candidate.patchesUsed)}
            </span>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function PicksPanel({ state, lookup }: { state: AppState; lookup: StaticLookup | null }) {
  const { picks, champSelect } = state;
  const data: PicksResponse | null = picks.status === 'idle' ? null : picks.data;
  const previewId = state.buildTarget?.preview ? state.buildTarget.championId : null;
  const [minConfidence] = useMinConfidence();
  // Each keeps its rank in the API's order: hidden candidates leave gaps in the numbers.
  const shown = useMemo(
    () =>
      (data?.candidates ?? [])
        .map((candidate, i) => ({ candidate, rank: i + 1 }))
        .filter(({ candidate }) => meetsConfidence(candidate.confidence, minConfidence)),
    [data, minConfidence],
  );
  const ids = shown.map(({ candidate }) => candidate.championId);
  const roving = useRoving(ids, 'vertical');
  const hidden = (data?.candidates.length ?? 0) - shown.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-semibold tracking-[0.18em] text-foreground uppercase">
          Best {champSelect ? ROLE_LABEL[champSelect.role] : ''} picks
        </span>
        {data && <span>patch {data.patch}</span>}
        {state.settings.ownedOnly && state.availableCount !== null && (
          <span>· from your {state.availableCount} champions</span>
        )}
        {hidden > 0 && <span>· {hidden} below the confidence filter</span>}
        <span className="ml-auto hidden xl:inline">
          score = sum of win-rate deltas (points), shrunk by sample size
        </span>
        <span className="ml-auto xl:ml-0">
          <ConfidenceFilter />
        </span>
      </div>

      {picks.status === 'error' && (
        <Notice
          tone={picks.code === 'NO_DATA' ? 'warn' : 'bad'}
          title={picks.code === 'NO_DATA' ? 'No data yet' : 'Recommendations unavailable'}
          message={picks.message}
          action={{ label: 'Retry', onClick: () => void window.pickleague.refresh() }}
        />
      )}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the rows (roving tabindex), the rows themselves are buttons */}
      <div
        ref={roving.containerRef}
        onKeyDown={roving.onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {!data && picks.status === 'loading' && (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        {data && data.candidates.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">
            No candidate left for this role — everything is banned, picked or not owned.
          </p>
        )}
        {data && data.candidates.length > 0 && shown.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">
            No candidate reaches {MIN_CONFIDENCE_LABEL[minConfidence].toLowerCase()} — lower the
            confidence filter to see all {data.candidates.length}.
          </p>
        )}
        {data &&
          shown.map(({ candidate: c, rank }, i) => (
            <CandidateRow
              key={c.championId}
              rank={rank}
              candidate={c}
              lookup={lookup}
              mastery={state.mastery}
              currentPatch={data.patch}
              previewing={previewId === c.championId}
              defaultOpen={i === 0}
              focus={roving.itemProps(c.championId)}
            />
          ))}
      </div>
    </div>
  );
}
