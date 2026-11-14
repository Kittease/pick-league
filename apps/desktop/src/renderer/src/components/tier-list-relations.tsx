import type {
  Position,
  TierListChampionResponse,
  TierListFilters,
  TierListRelation,
} from '@pick-league/shared';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { compact, deltaPoints, percent, ROLE_LABEL } from '@/lib/format';
import type { ApiResult } from '../../../core/app-state.ts';
import type { StaticLookup } from '../hooks/use-app';
import { ChampionIcon } from './game-icon';
import { Notice } from './notice';
import { DeltaBar, DeltaText } from './reasons';

/** A champion's relations are re-fetched after this long (like the tier list). */
const CACHE_MS = 5 * 60_000;
/** Rows shown per list before "Show all". */
const PREVIEW_ROWS = 6;

type Loaded =
  | { status: 'loading' }
  | { status: 'ok'; data: TierListChampionResponse }
  | { status: 'error'; code: string | null; message: string };

/** Kept across selections (and panel close/re-open); the key includes the API identity. */
const cache = new Map<string, { at: number; result: ApiResult<TierListChampionResponse> }>();

/** Matchups, duos and synergies of the selected champion, cached for a few minutes. */
function useTierListChampion(
  role: Position,
  championId: number,
  filters: TierListFilters,
  apiKey: string,
) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const { platform, rank } = filters;
  const key = `${apiKey}|${role}|${championId}|${platform}|${rank}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce re-runs the fetch on retry
  useEffect(() => {
    const hit = cache.get(key);
    if (hit?.result.ok && Date.now() - hit.at < CACHE_MS) {
      setState({ status: 'ok', data: hit.result.data });
      return;
    }
    let alive = true;
    // Same champion re-fetched (stats refreshed): keep showing the old lists until the new ones land.
    setState((prev) =>
      prev.status === 'ok' && prev.data.role === role && prev.data.championId === championId
        ? prev
        : { status: 'loading' },
    );
    void window.pickleague
      .getTierListChampion(role, championId, { platform, rank })
      .then((result) => {
        const now = Date.now();
        for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
        cache.set(key, { at: now, result });
        if (alive) {
          setState(
            result.ok ? { status: 'ok', data: result.data } : { status: 'error', ...result },
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [key, nonce]);

  const retry = useCallback(() => {
    cache.delete(key);
    setNonce((n) => n + 1);
  }, [key]);
  return { state, retry };
}

const DUO_HINT: Record<Position, string> = {
  TOP: 'with the jungler',
  JUNGLE: 'with mid and top',
  MIDDLE: 'with the jungler',
  BOTTOM: 'with the support',
  UTILITY: 'with the ADC',
};

function RelationRow({
  relation: r,
  role,
  verb,
  lookup,
}: {
  relation: TierListRelation;
  role: Position;
  verb: 'vs' | 'with';
  lookup: StaticLookup | null;
}) {
  const champ = lookup?.champion(r.championId);
  const name = champ?.name ?? `#${r.championId}`;
  return (
    <li
      className="grid grid-cols-[24px_minmax(0,1fr)_28px_36px_38px_34px] items-center gap-1.5 py-0.5 text-xs"
      title={`${deltaPoints(r.delta)} pts ${verb} ${name}: ${percent(r.winRate)} win rate over ${r.games} matchups (delta shrunk by sample size)`}
    >
      <ChampionIcon src={champ?.iconUrl} name={name} size={24} />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate">{name}</span>
        {r.role !== role && (
          <span className="shrink-0 text-[10px] text-muted-foreground">{ROLE_LABEL[r.role]}</span>
        )}
      </span>
      <DeltaBar delta={r.delta} games={r.games} />
      <DeltaText delta={r.delta} className="text-right" />
      <span className="num text-right text-[11px] text-muted-foreground">{percent(r.winRate)}</span>
      <span className="num text-right text-[10px] text-muted-foreground">{compact(r.games)}</span>
    </li>
  );
}

/** One category (matchups, duos or synergies): best / worst tabs, a preview and "Show all". */
function RelationSection({
  title,
  hint,
  relations,
  verb,
  role,
  lookup,
}: {
  title: string;
  hint: string;
  /** Best first (API order). */
  relations: TierListRelation[];
  verb: 'vs' | 'with';
  role: Position;
  lookup: StaticLookup | null;
}) {
  const [side, setSide] = useState<'best' | 'worst'>('best');
  const [expanded, setExpanded] = useState(false);
  const best = relations.filter((r) => r.delta > 0);
  const worst = relations.filter((r) => r.delta < 0).reverse();
  const list = side === 'best' ? best : worst;
  const shown = expanded ? list : list.slice(0, PREVIEW_ROWS);
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-baseline gap-2 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {title}
          <span className="truncate font-normal tracking-normal normal-case">{hint}</span>
        </h3>
        <Tabs
          value={side}
          onValueChange={(v) => {
            setSide(v as 'best' | 'worst');
            setExpanded(false);
          }}
          className="gap-0"
        >
          <TabsList variant="line" className="h-7 p-0" aria-label={`${title}: best or worst`}>
            <TabsTrigger value="best" className="px-1.5 py-0.5 text-[10px]">
              Best <span className="num text-muted-foreground">{best.length}</span>
            </TabsTrigger>
            <TabsTrigger value="worst" className="px-1.5 py-0.5 text-[10px]">
              Worst <span className="num text-muted-foreground">{worst.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {list.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">
          {relations.length === 0
            ? 'Not enough matchups yet.'
            : side === 'best'
              ? 'None above its own win rate.'
              : 'None below its own win rate.'}
        </p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((r) => (
            <RelationRow
              key={`${r.championId}-${r.role}`}
              relation={r}
              role={role}
              verb={verb}
              lookup={lookup}
            />
          ))}
        </ul>
      )}
      {list.length > PREVIEW_ROWS && (
        <Button
          size="xs"
          variant="ghost"
          className="self-start text-muted-foreground"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? (
            <ChevronUpIcon data-icon="inline-start" />
          ) : (
            <ChevronDownIcon data-icon="inline-start" />
          )}
          {expanded ? 'Show fewer' : `Show all ${list.length}`}
        </Button>
      )}
    </section>
  );
}

function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-4 w-32" />
      {Array.from({ length: 4 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}

/**
 * Lane matchups, duo partners and other allies of a tier list champion, fetched when it is
 * selected. Every row: shrunk win-rate delta, raw win rate and sample size.
 */
export function ChampionRelations({
  role,
  championId,
  filters,
  apiKey,
  lookup,
}: {
  role: Position;
  championId: number;
  /** Server + rank filters of the tier list (synergies are not available with filters). */
  filters: TierListFilters;
  /** Changes with the API URL, patch or a stats refresh: drops the cached lists. */
  apiKey: string;
  lookup: StaticLookup | null;
}) {
  const { state, retry } = useTierListChampion(role, championId, filters, apiKey);
  if (state.status === 'error') {
    return (
      <Notice
        className="m-0"
        tone={state.code === 'NO_DATA' ? 'warn' : 'bad'}
        title="Matchups unavailable"
        message={state.message}
        action={{ label: 'Retry', onClick: retry }}
      />
    );
  }
  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-5">
        <SectionSkeleton />
        <SectionSkeleton />
        <SectionSkeleton />
      </div>
    );
  }
  const d = state.data;
  const isBot = role === 'BOTTOM' || role === 'UTILITY';
  return (
    // Keyed by champion: switching champion resets the tabs and "Show all".
    <div key={`${role}-${championId}`} className="flex flex-col gap-5">
      <p className="text-[11px] leading-snug text-muted-foreground">
        Deltas are points vs its own <span className="num">{percent(d.winRate)}</span> win rate,
        shrunk by sample size. Columns: delta, win rate, matchups.
      </p>
      <RelationSection
        title="Matchups"
        hint={isBot ? 'bot lane opponents' : 'lane opponents'}
        relations={d.matchups}
        verb="vs"
        role={role}
        lookup={lookup}
      />
      <RelationSection
        title="Duos"
        hint={DUO_HINT[role]}
        relations={d.duos}
        verb="with"
        role={role}
        lookup={lookup}
      />
      {d.synergies ? (
        <RelationSection
          title="Synergies"
          hint="other allies"
          relations={d.synergies}
          verb="with"
          role={role}
          lookup={lookup}
        />
      ) : (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Synergies with other allies are only available for all servers at Master+.
        </p>
      )}
    </div>
  );
}
