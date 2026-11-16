import {
  type BuildResponse,
  type Reason,
  type RecommendedItem,
  STAT_SHARD_ROWS,
} from '@pick-league/shared';
import { Button } from '@pick-league/ui/components/ui/button';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@pick-league/ui/components/ui/hover-card';
import { Skeleton } from '@pick-league/ui/components/ui/skeleton';
import { cn } from '@pick-league/ui/lib/utils';
import { ArrowRightIcon, CheckIcon, Loader2Icon, WandSparklesIcon } from 'lucide-react';
import { compact, confidenceLabel, patchesText, percent, SKILL_KEY } from '@/lib/format';
import type { AppState, Loadable, MasteryEntry } from '../../../core/app-state.ts';
import { arrangeSpells, type FlashKey } from '../../../core/spells.ts';
import type { StaticLookup } from '../hooks/use-app';
import { ChampionIcon, GameIcon } from './game-icon';
import { Notice } from './notice';
import { DeltaText, LanePhaseLine, ReasonList } from './reasons';

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
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">—</p>
      ) : (
        <ol className="flex flex-col">
          {items.map((rec, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: duplicates allowed (2 potions)
            <li key={`${rec.itemId}-${i}`} className="flex items-center gap-1">
              {ordered && (
                <span className="num w-3 text-[10px] text-muted-foreground">{i + 1}</span>
              )}
              <ItemTile rec={rec} lookup={lookup} />
            </li>
          ))}
        </ol>
      )}
    </div>
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
      <div className="mb-3 flex items-center gap-4">
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

/**
 * A build with its header (champion, badge, patch + sample), error and loading states: the live
 * champion select one (`BuildPanel`) or any other given build (draft planner).
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
  mySpells,
  flashKey,
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
  mySpells: [number, number] | null;
  flashKey: FlashKey;
}) {
  const data = build.status === 'idle' ? null : build.data;
  const champ = lookup?.champion(championId);
  const name = champ?.name ?? `#${championId}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
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
  mySpells,
  flashKey,
}: {
  build: BuildResponse;
  lookup: StaticLookup | null;
  mySpells: [number, number] | null;
  flashKey: FlashKey;
}) {
  return (
    <div className="flex flex-col gap-6 p-4">
      <LanePhase build={build} lookup={lookup} />
      <section className="grid grid-cols-[1fr_1fr_1.3fr_1.3fr] gap-4">
        <div className="flex min-w-0 flex-col gap-4">
          <ItemGroup title="Starting" items={build.items.starting} lookup={lookup} />
          {build.items.questUpgrade && (
            <ItemGroup title="Quest upgrade" items={[build.items.questUpgrade]} lookup={lookup} />
          )}
        </div>
        <ItemGroup title="Early" items={build.items.early} lookup={lookup} ordered />
        <ItemGroup title="Core · buy order" items={build.items.core} lookup={lookup} ordered />
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
      <div className="grid grid-cols-2 gap-6">
        <Runes build={build} lookup={lookup} />
        <div className="flex flex-col gap-6">
          <Spells build={build} lookup={lookup} mySpells={mySpells} flashKey={flashKey} />
          <SkillOrder build={build} />
        </div>
      </div>
    </div>
  );
}
