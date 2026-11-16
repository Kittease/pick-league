import { type ConfidenceLevel, confidenceLevel } from '@pick-league/ui/lib/confidence';
import { confidenceLabel } from '@pick-league/ui/lib/format';
import { cn } from '@pick-league/ui/lib/utils';

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
