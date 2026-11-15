import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MIN_CONFIDENCE_LABEL } from '@/lib/confidence';
import { useMinConfidence } from '../hooks/use-min-confidence';

/** A compact select of a filter (server, rank, confidence), its options in `labels` order. */
export function FilterSelect<T extends string>({
  label,
  value,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      items={labels}
      onValueChange={(v) => {
        if (typeof v === 'string' && v in labels) onChange(v as T);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} title={label} className="h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        {(Object.keys(labels) as T[]).map((k) => (
          <SelectItem key={k} value={k} className="text-xs">
            {labels[k]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The shared minimum-confidence filter (`useMinConfidence`). */
export function ConfidenceFilter() {
  const [minConfidence, setMinConfidence] = useMinConfidence();
  return (
    <FilterSelect
      label="Minimum confidence (from sample size)"
      value={minConfidence}
      labels={MIN_CONFIDENCE_LABEL}
      onChange={setMinConfidence}
    />
  );
}
