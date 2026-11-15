import type { LanePhaseDiff, Reason } from '@pick-league/shared';
import {
  compact,
  deltaPoints,
  deltaSign,
  lanePhaseParts,
  laneTitle,
  REASON_KIND_LABEL,
  sampleWeight,
} from '@/lib/format';
import { cn } from '@/lib/utils';

/** Scale of the diverging bar: ±5 points fills one half. */
const FULL_SCALE = 0.05;

/**
 * Diverging bar centred on zero: teal to the right for a win-rate gain, coral to the left for
 * a loss. Opacity follows the sample size so thin evidence reads as thin.
 */
export function DeltaBar({
  delta,
  games,
  className,
}: {
  delta: number;
  games: number;
  className?: string;
}) {
  const half = Math.min(1, Math.abs(delta) / FULL_SCALE) * 50;
  const up = delta >= 0;
  return (
    <span className={cn('relative block h-1.5 w-full bg-secondary', className)} aria-hidden>
      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-muted-foreground/40" />
      {delta !== 0 && (
        <span
          className={cn('absolute inset-y-0', up ? 'left-1/2 bg-up' : 'right-1/2 bg-down')}
          style={{ width: `${half}%`, opacity: sampleWeight(games) }}
        />
      )}
    </span>
  );
}

export function DeltaText({ delta, className }: { delta: number; className?: string }) {
  const sign = deltaSign(delta);
  return (
    <span
      className={cn(
        'num tabular-nums',
        sign > 0 ? 'text-up' : sign < 0 ? 'text-down' : 'text-muted-foreground',
        className,
      )}
    >
      {deltaPoints(delta)}
    </span>
  );
}

/**
 * Lane-phase figures, "−420 gold · −8 CS · −310 XP at 10 min": gold coloured by side, "2v2" for
 * the bot lane (own + duo partner vs both enemy bot laners). The tooltip has the sample.
 */
export function LanePhaseLine({
  lane,
  title,
  className,
}: {
  lane: LanePhaseDiff;
  /** Tooltip (default: every number and the sample). */
  title?: string;
  className?: string;
}) {
  const { gold, rest } = lanePhaseParts(lane);
  const sign = Math.sign(Math.round(lane.gold));
  return (
    <span className={cn('num', className)} title={title ?? laneTitle(lane)}>
      <span
        className={cn(
          'font-medium',
          sign > 0 ? 'text-up' : sign < 0 ? 'text-down' : 'text-muted-foreground',
        )}
      >
        {gold}
      </span>
      <span className="text-foreground/80">{rest}</span>
      {lane.duo && (
        <span className="ml-1.5 border border-border px-1 align-[1px] text-[9px] text-muted-foreground">
          2v2
        </span>
      )}
    </span>
  );
}

/**
 * One row per reason: kind, readable label, delta bar, games. Lane-phase reasons show their
 * figures instead of the label (kept as the tooltip) and only their sample (they do not score).
 */
export function ReasonList({
  reasons,
  className,
  kindLabels,
}: {
  reasons: Reason[];
  className?: string;
  /** Overrides of the kind labels (e.g. "Champion" for a draft's `base` reasons). */
  kindLabels?: Partial<Record<Reason['kind'], string>>;
}) {
  if (reasons.length === 0) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>No reason given by the API.</p>
    );
  }
  return (
    <ul className={cn('flex flex-col gap-1.5', className)}>
      {reasons.map((r, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: reasons have no id and never reorder
          key={i}
          className="grid grid-cols-[92px_1fr_96px] items-center gap-3 text-xs"
        >
          <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            {kindLabels?.[r.kind] ?? REASON_KIND_LABEL[r.kind] ?? r.kind}
          </span>
          {r.kind === 'lane_phase' && r.lane ? (
            <LanePhaseLine lane={r.lane} title={r.label} className="line-clamp-2" />
          ) : (
            <span className="line-clamp-2 text-foreground/90" title={r.label}>
              {r.label}
            </span>
          )}
          <span className="flex items-center gap-2">
            {r.kind === 'lane_phase' ? (
              <span className="num ml-12 w-12 text-right text-[10px] text-muted-foreground">
                n={compact(r.games)}
              </span>
            ) : r.delta !== 0 || r.games > 0 ? (
              <>
                <DeltaBar delta={r.delta} games={r.games} className="w-10" />
                <span className="num w-12 text-right text-[10px] text-muted-foreground">
                  {r.games > 0 ? `n=${compact(r.games)}` : '—'}
                </span>
              </>
            ) : (
              <span className="text-[10px] text-muted-foreground">rule</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The two weightiest reasons on one line, so a collapsed pick still says why. */
export function ReasonHeadline({ reasons }: { reasons: Reason[] }) {
  const top = reasons
    .filter((r) => r.delta !== 0)
    .sort(
      (a, b) =>
        Math.abs(b.delta) * sampleWeight(b.games) - Math.abs(a.delta) * sampleWeight(a.games),
    )
    .slice(0, 2);
  if (top.length === 0) return null;
  return (
    <span className="truncate text-[11px] text-muted-foreground">
      {top.map((r, i) => (
        <span key={r.label}>
          {i > 0 && <span className="mx-1.5 text-border">/</span>}
          {r.label}
        </span>
      ))}
    </span>
  );
}

/** Thin strip summarising every reason of a candidate: one segment per reason. */
export function ReasonStrip({ reasons }: { reasons: Reason[] }) {
  const scored = reasons.filter((r) => r.delta !== 0);
  if (scored.length === 0) return <span className="block h-1.5" />;
  return (
    <span className="flex h-1.5 w-full gap-px" aria-hidden>
      {scored.map((r, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          key={i}
          title={r.label}
          className={cn('h-full', r.delta > 0 ? 'bg-up' : 'bg-down')}
          style={{ flex: Math.max(0.15, Math.abs(r.delta) * 100), opacity: sampleWeight(r.games) }}
        />
      ))}
    </span>
  );
}
