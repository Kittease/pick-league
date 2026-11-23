'use client';

import {
  type BuildResponse,
  type CoreBuild,
  type LateItem,
  type LateSwap,
  type Reason,
  type RecommendedItem,
  STAT_SHARD_ROWS,
} from '@pick-league/shared';
import { ChampionIcon, GameIcon } from '@pick-league/ui/components/game-icon';
import { Notice } from '@pick-league/ui/components/notice';
import { DeltaText, LanePhaseLine, ReasonList } from '@pick-league/ui/components/reasons';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@pick-league/ui/components/ui/hover-card';
import { Skeleton } from '@pick-league/ui/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@pick-league/ui/components/ui/tabs';
import {
  compact,
  confidenceLabel,
  lateSwapText,
  patchesText,
  percent,
  SKILL_KEY,
} from '@pick-league/ui/lib/format';
import { arrangeSpells, DEFAULT_FLASH_KEY, type FlashKey } from '@pick-league/ui/lib/spells';
import type { StaticLookup } from '@pick-league/ui/lib/static-lookup';
import type { Loadable, MasteryEntry } from '@pick-league/ui/lib/types';
import { cn } from '@pick-league/ui/lib/utils';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';

function SectionTitle({ children, meta }: { children: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline gap-3">
      <h3 className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {children}
      </h3>
      {meta && <span className="num text-[10px] text-muted-foreground/80">{meta}</span>}
    </div>
  );
}

function strongest(reasons: Reason[]): Reason | undefined {
  return [...reasons].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
}

function ItemTile({
  rec,
  lookup,
  variant = 'normal',
}: {
  rec: RecommendedItem;
  lookup: StaticLookup | null;
  variant?: 'normal' | 'situational';
}) {
  const item = lookup?.item(rec.itemId);
  const replaced = rec.replacesItemId ? lookup?.item(rec.replacesItemId) : undefined;
  const top = strongest(rec.reasons);
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            type="button"
            className={cn(
              'flex w-full items-start gap-2 p-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring',
              variant === 'situational' && 'bg-card',
            )}
          />
        }
      >
        <GameIcon src={item?.iconUrl} alt={item?.name ?? `Item ${rec.itemId}`} size={34} />
        <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
          <span className="truncate text-xs font-medium">{item?.name ?? `Item ${rec.itemId}`}</span>
          {variant === 'situational' && (
            <span className="text-[10px] text-muted-foreground">
              {replaced ? `instead of ${replaced.name}` : 'extra slot'}
            </span>
          )}
          {top && (
            <span className="line-clamp-2 text-[10px] text-muted-foreground">
              {top.delta !== 0 && <DeltaText delta={top.delta} className="mr-1" />}
              {top.label}
            </span>
          )}
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-[420px]" side="top">
        <p className="mb-2 text-xs font-semibold">{item?.name ?? `Item ${rec.itemId}`}</p>
        <ReasonList reasons={rec.reasons} />
      </HoverCardContent>
    </HoverCard>
  );
}

function ItemList({
  items,
  lookup,
  ordered,
}: {
  items: RecommendedItem[];
  lookup: StaticLookup | null;
  ordered?: boolean;
}) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">—</p>;
  return (
    <ol className="flex flex-col">
      {items.map((rec, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: duplicates allowed (2 potions)
        <li key={`${rec.itemId}-${i}`} className="flex items-center gap-1">
          {ordered && <span className="num w-3 text-[10px] text-muted-foreground">{i + 1}</span>}
          <ItemTile rec={rec} lookup={lookup} />
        </li>
      ))}
    </ol>
  );
}

function ItemGroup({
  title,
  items,
  lookup,
  ordered,
}: {
  title: string;
  items: RecommendedItem[];
  lookup: StaticLookup | null;
  ordered?: boolean;
}) {
  return (
    <div className="min-w-0">
      <SectionTitle>{title}</SectionTitle>
      <ItemList items={items} lookup={lookup} ordered={ordered} />
    </div>
  );
}

/** The core builds of a build (an API predating them only sends `core`). */
function coreBuildsOf(build: BuildResponse): CoreBuild[] {
  const builds = build.items.coreBuilds;
  return builds && builds.length > 0
    ? builds
    : [{ items: build.items.core, games: 0, winRate: 0, share: 0, reasons: [] }];
}

function coreBuildMeta(b: CoreBuild): string | undefined {
  return b.games > 0
    ? `${percent(b.winRate)} wr · ${compact(b.games)} matches · ${percent(b.share)} of 3-item paths`
    : undefined;
}

/** Core items in buy order; tabs to switch between core builds when there are several. */
function CoreBuilds({
  builds,
  active,
  onSelect,
  lookup,
}: {
  builds: CoreBuild[];
  active: number;
  onSelect: (index: number) => void;
  lookup: StaticLookup | null;
}) {
  const current = builds[active];
  if (!current) return null;
  if (builds.length === 1) {
    return <ItemGroup title="Core · buy order" items={current.items} lookup={lookup} ordered />;
  }
  return (
    <div className="min-w-0">
      <Tabs value={active} onValueChange={(v) => onSelect(Number(v))} className="mb-2 gap-0">
        <TabsList variant="line" className="h-auto w-full p-0">
          {builds.map((b, i) => (
            <TabsTrigger
              // biome-ignore lint/suspicious/noArrayIndexKey: builds are ranked, the index is their id
              key={i}
              value={i}
              className="flex-col gap-0 px-1.5 py-1 text-[10px]"
              title={coreBuildMeta(b)}
            >
              <span>Core {i + 1}</span>
              <span className="num font-normal tracking-normal text-muted-foreground normal-case">
                {b.games > 0 ? `${percent(b.winRate)} wr` : '—'}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <ItemList items={current.items} lookup={lookup} ordered />
    </div>
  );
}

/**
 * Late game, one strip under the item columns: the items players most often complete after the
 * core ("Then"), and the swaps they make once the build is full ("Swapped at full build": sold
 * item → item bought in its place). Both explain and never score. A swap only sells an item shown
 * above or in "Then", a pair of boots, or the item a swap before it bought, so the strip reads left
 * to right. Nothing is shown without either (an API predating them sends neither).
 */
function LateGame({
  late,
  swaps,
  lookup,
}: {
  late: LateItem[] | undefined;
  swaps: LateSwap[] | undefined;
  lookup: StaticLookup | null;
}) {
  const items = late ?? [];
  const pairs = swaps ?? [];
  if (items.length === 0 && pairs.length === 0) return null;
  return (
    <section>
      <SectionTitle>Late game</SectionTitle>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        {items.length > 0 && (
          <div className="min-w-0">
            <p className="mb-1 text-[10px] text-muted-foreground">Then, most often</p>
            <ul className="flex flex-wrap gap-1">
              {items.map((rec) => {
                const item = lookup?.item(rec.itemId);
                const name = item?.name ?? `Item ${rec.itemId}`;
                return (
                  <li key={rec.itemId}>
                    <HoverCard>
                      <HoverCardTrigger
                        render={
                          <button
                            type="button"
                            className="flex items-center gap-2 bg-card py-1 pr-2.5 pl-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring"
                          />
                        }
                      >
                        <GameIcon src={item?.iconUrl} alt={name} size={28} />
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className="max-w-36 truncate text-xs font-medium">{name}</span>
                          <span className="num text-[10px] text-muted-foreground">
                            built by {percent(rec.share, 0)}
                          </span>
                        </span>
                      </HoverCardTrigger>
                      <HoverCardContent className="w-[420px]" side="top">
                        <p className="mb-2 text-xs font-semibold">{name}</p>
                        <ReasonList reasons={rec.reasons} />
                      </HoverCardContent>
                    </HoverCard>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {pairs.length > 0 && (
          <div className="min-w-0">
            <p className="mb-1 text-[10px] text-muted-foreground">Swapped at full build</p>
            <ul className="flex flex-wrap gap-1">
              {pairs.map((swap) => {
                const sold = lookup?.item(swap.sellItemId);
                const bought = lookup?.item(swap.buyItemId);
                const soldName = sold?.name ?? `Item ${swap.sellItemId}`;
                const boughtName = bought?.name ?? `Item ${swap.buyItemId}`;
                return (
                  <li
                    key={`${swap.sellItemId}-${swap.buyItemId}`}
                    className="flex items-center gap-1.5 bg-card py-1 pr-2.5 pl-1"
                    title={`${soldName} sold, ${boughtName} bought in its place: ${swap.games.toLocaleString('en-US')} games, around minute ${Math.round(swap.minute)} on average`}
                  >
                    <GameIcon src={sold?.iconUrl} alt={soldName} size={28} />
                    <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
                    <GameIcon src={bought?.iconUrl} alt={boughtName} size={28} />
                    <span className="num ml-0.5 text-[10px] whitespace-nowrap text-muted-foreground">
                      {lateSwapText(swap)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function Runes({ build, lookup }: { build: BuildResponse; lookup: StaticLookup | null }) {
  const r = build.runes;
  const primary = lookup?.tree(r.primaryTreeId);
  const secondary = lookup?.tree(r.secondaryTreeId);
  const [keystone, ...minors] = r.runeIds;
  const rune = (id: number, size: number) => {
    const x = lookup?.rune(id);
    return <GameIcon key={id} src={x?.iconUrl} alt={x?.name ?? `Rune ${id}`} size={size} round />;
  };
  const keystoneName = keystone ? lookup?.rune(keystone)?.name : undefined;
  return (
    <section>
      <SectionTitle meta={`${percent(r.winRate)} wr · ${compact(r.games)} games`}>
        Runes
      </SectionTitle>
      <div className="mb-3 flex items-center gap-4 max-md:flex-wrap">
        <div className="flex items-center gap-2">
          <GameIcon src={primary?.iconUrl} alt={primary?.name ?? 'Primary tree'} size={20} round />
          {keystone && rune(keystone, 44)}
          <span className="flex flex-col leading-tight">
            <span className="text-xs font-semibold">{keystoneName ?? 'Keystone'}</span>
            <span className="text-[10px] text-muted-foreground">
              {primary?.name} + {secondary?.name}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {minors.slice(0, 3).map((id) => rune(id, 26))}
        </div>
        <span className="h-6 w-px bg-border" />
        <div className="flex items-center gap-1.5">
          <GameIcon
            src={secondary?.iconUrl}
            alt={secondary?.name ?? 'Secondary tree'}
            size={16}
            round
          />
          {minors.slice(3).map((id) => rune(id, 24))}
        </div>
        <span className="h-6 w-px bg-border" />
        <div className="flex items-center gap-1">
          {r.statShardIds.map((id, i) => {
            const s = lookup?.shard(id);
            const row = STAT_SHARD_ROWS[i] ?? `extra${id}`;
            return (
              <GameIcon
                key={row}
                src={s?.iconUrl}
                alt={`${s?.name ?? `Shard ${id}`} (${row})`}
                size={18}
                round
              />
            );
          })}
        </div>
      </div>
      <ReasonList reasons={r.reasons} />
    </section>
  );
}

function Spells({
  build,
  lookup,
  mySpells,
  flashKey,
}: {
  build: BuildResponse;
  lookup: StaticLookup | null;
  mySpells: [number, number] | null;
  flashKey: FlashKey;
}) {
  const s = build.summonerSpells;
  // Same D/F order as applying them (no current spells outside champion select).
  const ordered = arrangeSpells(s.spellIds, mySpells ?? [0, 0], flashKey);
  return (
    <section>
      <SectionTitle meta={`${percent(s.winRate)} wr · ${compact(s.games)} games`}>
        Summoner spells
      </SectionTitle>
      <div className="mb-3 flex items-center gap-3">
        {ordered.map((id, i) => {
          const sp = lookup?.spell(id);
          return (
            <span key={id} className="flex items-center gap-2">
              <span className="relative">
                <GameIcon src={sp?.iconUrl} alt={sp?.name ?? `Spell ${id}`} size={34} />
                <span className="num absolute -bottom-1 -left-1 bg-background px-1 text-[10px] font-semibold">
                  {i === 0 ? 'D' : 'F'}
                </span>
              </span>
              <span className="text-xs">{sp?.name ?? id}</span>
            </span>
          );
        })}
      </div>
      <ReasonList reasons={s.reasons} />
    </section>
  );
}

function SkillOrder({ build }: { build: BuildResponse }) {
  const s = build.skillOrder;
  const levels = s.sequence.length > 0 ? s.sequence : s.firstLevels;
  return (
    <section>
      <SectionTitle meta={`${percent(s.winRate)} wr · ${compact(s.games)} games`}>
        Skill order
      </SectionTitle>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        {s.maxOrder.map((slot, i) => (
          <span key={slot} className="flex items-center gap-1.5">
            {i > 0 && <ArrowRightIcon className="size-3 text-muted-foreground" />}
            <span className="num">{SKILL_KEY[slot]}</span>
          </span>
        ))}
        <span className="ml-2 text-[11px] font-normal text-muted-foreground">
          start {s.firstLevels.map((k) => SKILL_KEY[k]).join(' ')}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-[14px_repeat(18,minmax(0,1fr))] gap-px">
        {[1, 2, 3, 4].map((slot) => (
          <div key={slot} className="contents">
            <span className="num text-[10px] leading-4 text-muted-foreground">
              {SKILL_KEY[slot]}
            </span>
            {Array.from({ length: 18 }, (_, lvl) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid
                key={lvl}
                className={cn(
                  'num h-4 text-center text-[9px] leading-4',
                  levels[lvl] === slot
                    ? slot === 4
                      ? 'bg-gold text-[#1b1406]'
                      : 'bg-foreground/80 text-background'
                    : 'bg-secondary/70',
                )}
              >
                {levels[lvl] === slot ? lvl + 1 : ''}
              </span>
            ))}
          </div>
        ))}
      </div>
      <ReasonList reasons={s.reasons} />
    </section>
  );
}

/**
 * How the lane phase goes vs the lane opponent the build adapts to: gold / CS / XP difference at
 * 10 and 15 min (bot lane 2v2). Explains the matchup, changes nothing in the build.
 */
function LanePhase({ build, lookup }: { build: BuildResponse; lookup: StaticLookup | null }) {
  const reasons = (build.lanePhase ?? []).filter((r) => r.lane);
  const first = reasons[0];
  if (!first) return null;
  const opponentId = first.championIds?.[0];
  const champ = opponentId !== undefined ? lookup?.champion(opponentId) : undefined;
  const name = champ?.name ?? (opponentId !== undefined ? `#${opponentId}` : 'lane opponent');
  return (
    <section>
      <SectionTitle meta={`${compact(first.games)} matchups`}>Lane phase</SectionTitle>
      <div className="flex items-center gap-3">
        <ChampionIcon src={champ?.iconUrl} name={name} size={30} />
        <span className="text-xs text-muted-foreground">vs {name}</span>
        <span className="flex flex-col gap-0.5 text-xs">
          {reasons.map(
            (r) => r.lane && <LanePhaseLine key={r.lane.minute} lane={r.lane} title={r.label} />,
          )}
        </span>
      </div>
    </section>
  );
}

/**
 * A build with its header (champion, badge, patch + sample), error and loading states: the live
 * champion select one (desktop) or any other given build (draft planner).
 */
export function BuildView({
  championId,
  build,
  lookup,
  mastery,
  badge,
  badgeTone,
  leading,
  actions,
  onRetry,
  mySpells = null,
  flashKey = DEFAULT_FLASH_KEY,
}: {
  championId: number;
  build: Loadable<BuildResponse>;
  lookup: StaticLookup | null;
  mastery?: MasteryEntry;
  /** Short uppercase label next to the name ("locked in", "preview"…). */
  badge: string;
  badgeTone: 'primary' | 'muted';
  /** Before the champion icon (e.g. a back button). */
  leading?: React.ReactNode;
  /** Right end of the header (e.g. the Apply button). */
  actions?: React.ReactNode;
  onRetry: () => void;
  /** The user's current spells (champion select), so spells without Flash keep their key. */
  mySpells?: [number, number] | null;
  /** Key Flash goes on (desktop setting; F by default). */
  flashKey?: FlashKey;
}) {
  const data = build.status === 'idle' ? null : build.data;
  const champ = lookup?.champion(championId);
  const name = champ?.name ?? `#${championId}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 max-md:flex-wrap">
        {leading}
        <ChampionIcon src={champ?.iconUrl} name={name} size={44} mastery={mastery} />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">{name}</span>
            <span
              className={cn(
                'text-[10px] font-semibold tracking-wider uppercase',
                badgeTone === 'muted' ? 'text-muted-foreground' : 'text-primary',
              )}
            >
              {badge}
            </span>
          </span>
          {data && (
            <span className="num truncate text-[11px] text-muted-foreground">
              patch {patchesText(data.patchesUsed)} · {compact(data.games)} games ·{' '}
              {confidenceLabel(data.confidence).toLowerCase()} confidence
            </span>
          )}
        </div>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>

      {build.status === 'error' && (
        <Notice
          tone={build.code === 'NO_DATA' ? 'warn' : 'bad'}
          title="Build unavailable"
          message={build.message}
          action={{ label: 'Retry', onClick: onRetry }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!data && build.status === 'loading' && (
          <div className="grid grid-cols-4 gap-3 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        )}
        {data && (
          <BuildDetails build={data} lookup={lookup} mySpells={mySpells} flashKey={flashKey} />
        )}
      </div>
    </div>
  );
}

/** Items, runes, spells and skill order of a build, each with its reasons. */
export function BuildDetails({
  build,
  lookup,
  mySpells = null,
  flashKey = DEFAULT_FLASH_KEY,
}: {
  build: BuildResponse;
  lookup: StaticLookup | null;
  /** The user's current spells (champion select), so spells without Flash keep their key. */
  mySpells?: [number, number] | null;
  /** Key Flash goes on (desktop setting; F by default). */
  flashKey?: FlashKey;
}) {
  const builds = coreBuildsOf(build);
  // The picked core build, back to the first one when another champion/role is shown.
  const key = `${build.championId}-${build.role}`;
  const [picked, setPicked] = useState({ key, index: 0 });
  const active = picked.key === key ? Math.min(picked.index, builds.length - 1) : 0;
  const current = builds[active];
  return (
    <div className="flex flex-col gap-6 p-4">
      <LanePhase build={build} lookup={lookup} />
      <section className="grid grid-cols-[1fr_1fr_1.3fr_1.3fr] gap-4 max-md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <ItemGroup title="Starting" items={build.items.starting} lookup={lookup} />
          {build.items.questUpgrade && (
            <ItemGroup title="Quest upgrade" items={[build.items.questUpgrade]} lookup={lookup} />
          )}
        </div>
        <ItemGroup title="Early" items={build.items.early} lookup={lookup} ordered />
        <CoreBuilds
          builds={builds}
          active={active}
          onSelect={(index) => setPicked({ key, index })}
          lookup={lookup}
        />
        <div className="min-w-0">
          <SectionTitle>Situational</SectionTitle>
          <div className="flex flex-col gap-1">
            {build.items.situational.length === 0 && (
              <p className="text-xs text-muted-foreground">No adaptation needed.</p>
            )}
            {build.items.situational.map((rec) => (
              <ItemTile key={rec.itemId} rec={rec} lookup={lookup} variant="situational" />
            ))}
          </div>
        </div>
      </section>
      <LateGame late={build.items.late} swaps={build.items.lateSwaps} lookup={lookup} />
      {current && current.reasons.length > 0 && (
        <section>
          <SectionTitle meta={coreBuildMeta(current)}>
            {builds.length > 1 ? `Core build ${active + 1} of ${builds.length}` : 'Core build'}
          </SectionTitle>
          <ReasonList reasons={current.reasons} />
        </section>
      )}
      <div className="grid grid-cols-2 gap-6 max-md:grid-cols-1">
        <Runes build={build} lookup={lookup} />
        <div className="flex flex-col gap-6">
          <Spells build={build} lookup={lookup} mySpells={mySpells} flashKey={flashKey} />
          <SkillOrder build={build} />
        </div>
      </div>
    </div>
  );
}
