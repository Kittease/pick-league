'use client';

import {
  GAME_LENGTH_MINUTES,
  type GameLengthProfile,
  type Position,
  type TierListChampionResponse,
  type TierListFilters,
  type TierListRelation,
} from '@pick-league/shared';
import { usePickLeagueData } from '@pick-league/ui/components/data-provider';
import { ChampionIcon } from '@pick-league/ui/components/game-icon';
import { Notice } from '@pick-league/ui/components/notice';
import { DeltaBar, DeltaText } from '@pick-league/ui/components/reasons';
import { Button } from '@pick-league/ui/components/ui/button';
import { Skeleton } from '@pick-league/ui/components/ui/skeleton';
import {
  type ConfidenceLevel,
  MIN_CONFIDENCE_LABEL,
  meetsConfidence,
} from '@pick-league/ui/lib/confidence';
import {
  compact,
  confidenceLabel,
  deltaPoints,
  laneGoldShort,
  laneTitle,
  percent,
  ROLE_LABEL,
} from '@pick-league/ui/lib/format';
import type { StaticLookup } from '@pick-league/ui/lib/static-lookup';
import type { ApiResult } from '@pick-league/ui/lib/types';
import { cn } from '@pick-league/ui/lib/utils';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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
  const api = usePickLeagueData();
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
    void api.getTierListChampion(role, championId, { platform, rank }).then((result) => {
      const now = Date.now();
      for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
      cache.set(key, { at: now, result });
      if (alive) {
        setState(result.ok ? { status: 'ok', data: result.data } : { status: 'error', ...result });
      }
    });
    return () => {
      alive = false;
    };
  }, [key, nonce, api]);

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

/** Lane gold difference at 10 min of a matchup row ("+250g @10"), CS / XP / sample on hover. */
function LaneGoldCell({ relation: r }: { relation: TierListRelation }) {
  if (!r.lane) {
    return (
      <span
        className="text-right text-[10px] text-muted-foreground/50"
        title="No lane-phase figures: too few matchups with timeline frames, or server/rank filters"
      >
        —
      </span>
    );
  }
  const sign = Math.sign(r.lane.gold);
  const [gold, at] = laneGoldShort(r.lane).split(' ');
  return (
    <span
      className={cn(
        'num text-right text-[11px] whitespace-nowrap',
        sign > 0 ? 'text-up' : sign < 0 ? 'text-down' : 'text-muted-foreground',
      )}
      title={laneTitle(r.lane)}
    >
      {gold}
      <span className="ml-0.5 text-[9px] text-muted-foreground">{at}</span>
    </span>
  );
}

function RelationRow({
  relation: r,
  role,
  verb,
  lookup,
  showLane,
}: {
  relation: TierListRelation;
  role: Position;
  verb: 'vs' | 'with';
  lookup: StaticLookup | null;
  /** Matchups: a lane gold column (empty cell when the row has no lane figures). */
  showLane: boolean;
}) {
  const champ = lookup?.champion(r.championId);
  const name = champ?.name ?? `#${r.championId}`;
  return (
    <li
      className={cn(
        'grid items-center gap-1.5 py-0.5 text-xs',
        showLane
          ? 'grid-cols-[24px_minmax(0,1fr)_54px_28px_36px_38px_34px]'
          : 'grid-cols-[24px_minmax(0,1fr)_28px_36px_38px_34px]',
      )}
      title={`${deltaPoints(r.delta)} pts ${verb} ${name}: ${percent(r.winRate)} win rate over ${r.games} matchups (delta shrunk by sample size), ${confidenceLabel(r.confidence).toLowerCase()} confidence`}
    >
      <ChampionIcon src={champ?.iconUrl} name={name} size={24} />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate">{name}</span>
        {r.role !== role && (
          <span className="shrink-0 text-[10px] text-muted-foreground">{ROLE_LABEL[r.role]}</span>
        )}
      </span>
      {showLane && <LaneGoldCell relation={r} />}
      <DeltaBar delta={r.delta} games={r.games} />
      <DeltaText delta={r.delta} className="text-right" />
      <span className="num text-right text-[11px] text-muted-foreground">{percent(r.winRate)}</span>
      <span className="num text-right text-[10px] text-muted-foreground">{compact(r.games)}</span>
    </li>
  );
}

/**
 * One side (best or worst) of a category: its rows, a preview and "Show all". `empty` is shown
 * when the side has no row.
 */
function RelationColumn({
  side,
  list,
  empty,
  verb,
  role,
  lookup,
  showLane,
}: {
  side: 'best' | 'worst';
  list: TierListRelation[];
  empty: string;
  verb: 'vs' | 'with';
  role: Position;
  lookup: StaticLookup | null;
  showLane: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? list : list.slice(0, PREVIEW_ROWS);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span
        className={cn(
          'flex items-baseline gap-1.5 border-b border-border pb-0.5 text-[10px] font-semibold tracking-wider uppercase',
          side === 'best' ? 'text-up' : 'text-down',
        )}
      >
        {side === 'best' ? 'Best' : 'Worst'}
        <span className="num font-normal text-muted-foreground">{list.length}</span>
      </span>
      {list.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((r) => (
            <RelationRow
              key={`${r.championId}-${r.role}`}
              relation={r}
              role={role}
              verb={verb}
              lookup={lookup}
              showLane={showLane}
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
    </div>
  );
}

/**
 * Best and worst side by side once the details panel is wide enough (container ≥ 42rem, each
 * column then keeps ~10 rem for the names), stacked above it.
 */
const SIDES = 'grid items-start gap-x-6 gap-y-3 @2xl:grid-cols-2';

/** One category (matchups, duos or synergies): its best and worst lists. */
function RelationSection({
  title,
  hint,
  relations,
  verb,
  role,
  lookup,
  minConfidence,
}: {
  title: string;
  hint: string;
  /** Best first (API order). */
  relations: TierListRelation[];
  verb: 'vs' | 'with';
  role: Position;
  lookup: StaticLookup | null;
  minConfidence: ConfidenceLevel;
}) {
  const shown = relations.filter((r) => meetsConfidence(r.confidence, minConfidence));
  const best = shown.filter((r) => r.delta > 0);
  const worst = shown.filter((r) => r.delta < 0).reverse();
  // Lane figures only exist for matchups (not under server/rank filters): same columns both sides.
  const showLane = relations.some((r) => r.lane);
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex min-w-0 items-baseline gap-2 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {title}
        <span className="truncate font-normal tracking-normal normal-case">{hint}</span>
      </h3>
      {relations.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">Not enough matchups yet.</p>
      ) : shown.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">
          None at {MIN_CONFIDENCE_LABEL[minConfidence].toLowerCase()} ({relations.length} below).
        </p>
      ) : (
        <div className={SIDES}>
          <RelationColumn
            side="best"
            list={best}
            empty="None above its own win rate."
            verb={verb}
            role={role}
            lookup={lookup}
            showLane={showLane}
          />
          <RelationColumn
            side="worst"
            list={worst}
            empty="None below its own win rate."
            verb={verb}
            role={role}
            lookup={lookup}
            showLane={showLane}
          />
        </div>
      )}
    </section>
  );
}

function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-4 w-32" />
      <div className={SIDES}>
        {['best', 'worst'].map((side) => (
          <div key={side} className="flex flex-col gap-1.5">
            {Array.from({ length: 4 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const { earlyUnder, lateFrom } = GAME_LENGTH_MINUTES;

/**
 * Early / late game of the champion in its role: its win rate in short and long games vs its
 * overall win rate, compared with the other champions of the role. Explains, never scores.
 */
function GameLengthStats({ profile }: { profile: GameLengthProfile }) {
  const items = [
    {
      label: 'Early game',
      delta: profile.early,
      sub: `under ${earlyUnder} min · ${compact(profile.earlyGames)} games`,
    },
    {
      label: 'Late game',
      delta: profile.late,
      sub: `${lateFrom} min or more · ${compact(profile.lateGames)} games`,
    },
  ];
  return (
    <div
      className="flex flex-wrap gap-x-6 gap-y-2"
      title={`Win rate in games under ${earlyUnder} min / of ${lateFrom} min or more vs its overall win rate, compared with what the other champions of the role do in those games, shrunk by sample size.`}
    >
      {items.map((it) => (
        <div key={it.label} className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            {it.label}
          </span>
          <span className="num text-sm">
            {it.delta === null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <>
                <DeltaText delta={it.delta} />%
              </>
            )}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {it.delta === null ? 'too few games' : it.sub}
          </span>
        </div>
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
  minConfidence,
  apiKey,
  lookup,
}: {
  role: Position;
  championId: number;
  /** Server + rank filters of the tier list (synergies are not available with filters). */
  filters: TierListFilters;
  /** Rows under this confidence are hidden. */
  minConfidence: ConfidenceLevel;
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
      <div className="@container flex flex-col gap-5">
        <SectionSkeleton />
        <SectionSkeleton />
        <SectionSkeleton />
      </div>
    );
  }
  const d = state.data;
  const isBot = role === 'BOTTOM' || role === 'UTILITY';
  return (
    // Keyed by champion: switching champion resets "Show all". A container: the best / worst
    // columns follow the width the panel gives them.
    <div key={`${role}-${championId}`} className="@container flex flex-col gap-5">
      {d.gameLength && <GameLengthStats profile={d.gameLength} />}
      <p className="text-[11px] leading-snug text-muted-foreground">
        Deltas are points vs its own <span className="num">{percent(d.winRate)}</span> win rate,
        shrunk by sample size. Columns: delta, win rate, matchups.
        {d.matchups.some((m) => m.lane) &&
          ` Matchups also show the lane gold difference at 10 min${isBot ? ' (bot lane 2v2: with the duo partner)' : ''}; hover it for CS and XP.`}
      </p>
      <RelationSection
        title="Matchups"
        hint={isBot ? 'bot lane opponents' : 'lane opponents'}
        relations={d.matchups}
        verb="vs"
        role={role}
        lookup={lookup}
        minConfidence={minConfidence}
      />
      <RelationSection
        title="Duos"
        hint={DUO_HINT[role]}
        relations={d.duos}
        verb="with"
        role={role}
        lookup={lookup}
        minConfidence={minConfidence}
      />
      {d.synergies ? (
        <RelationSection
          title="Synergies"
          hint="other allies"
          relations={d.synergies}
          verb="with"
          role={role}
          lookup={lookup}
          minConfidence={minConfidence}
        />
      ) : (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Synergies with other allies are only available for all servers at Master+.
        </p>
      )}
    </div>
  );
}
