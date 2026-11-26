'use client';

import type {
  PatchNoteChange,
  PatchNoteDamageSplit,
  PatchNotesChampion,
  PatchNotesItem,
  PatchNotesItemUsers,
  PatchNotesResponse,
  PatchNoteVerdict,
} from '@pick-league/shared';
import { usePickLeagueData } from '@pick-league/ui/components/data-provider';
import { ChampionIcon, GameIcon } from '@pick-league/ui/components/game-icon';
import { Notice } from '@pick-league/ui/components/notice';
import { DeltaText } from '@pick-league/ui/components/reasons';
import { Label } from '@pick-league/ui/components/ui/label';
import { Skeleton } from '@pick-league/ui/components/ui/skeleton';
import { Switch } from '@pick-league/ui/components/ui/switch';
import { useApiCall } from '@pick-league/ui/hooks/use-api-call';
import { compact, percent, ROLE_LABEL } from '@pick-league/ui/lib/format';
import {
  anchors,
  type ChampionItemLink,
  changeKey,
  changeText,
  itemsByChampion,
  type PatchNotesSelection,
  patchSelection,
  plural,
  type SelectorPatch,
  SLOT_LABEL,
  sameSelection,
  selectorPatches,
  shortDate,
  spellSlotNumber,
  technicalCount,
  VERDICT_LABEL,
  verdictTone,
  visibleChanges,
} from '@pick-league/ui/lib/patch-notes';
import type { StaticLookup } from '@pick-league/ui/lib/static-lookup';
import { cn } from '@pick-league/ui/lib/utils';
import { ArrowDownIcon, ArrowUpIcon, CornerDownRightIcon } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';

const TONE_TEXT = {
  up: 'text-up',
  down: 'text-down',
  gold: 'text-gold',
  muted: 'text-muted-foreground',
} as const;

const TONE_BORDER = {
  up: 'border-up/50',
  down: 'border-down/50',
  gold: 'border-gold/50',
  muted: 'border-border',
} as const;

function VerdictBadge({ verdict, className }: { verdict: PatchNoteVerdict; className?: string }) {
  const tone = verdictTone(verdict);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center border px-1.5 py-px text-[10px] font-semibold tracking-widest uppercase',
        TONE_TEXT[tone],
        TONE_BORDER[tone],
        className,
      )}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

function HotfixBadge() {
  return (
    <span className="border border-gold/50 px-1 text-[9px] font-semibold tracking-widest text-gold uppercase">
      Hotfix
    </span>
  );
}

/** Scrolls the page's own scroller to an entry (no URL hash: the desktop has no router). */
function useJump() {
  const scroller = useRef<HTMLDivElement>(null);
  const jump = useCallback((id: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('ring-1', 'ring-primary');
    setTimeout(() => el.classList.remove('ring-1', 'ring-primary'), 1200);
  }, []);
  return { scroller, jump };
}

function JumpLink({
  to,
  jump,
  children,
  className,
}: {
  to: string;
  jump: (id: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={`#${to}`}
      onClick={(e) => {
        e.preventDefault();
        jump(to);
      }}
      className={cn('underline-offset-2 hover:underline', className)}
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

function PatchSelector({
  entries,
  selected,
  onSelect,
}: {
  entries: SelectorPatch[];
  selected: PatchNotesSelection | null;
  onSelect: (s: PatchNotesSelection) => void;
}) {
  return (
    <nav aria-label="Patches" className="flex flex-col gap-0.5 p-2">
      {entries.map((entry, i) => {
        const own = patchSelection(entry);
        const active = sameSelection(selected, own);
        return (
          <div key={entry.patch} className="flex flex-col">
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(own)}
              className={cn(
                'flex flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-accent',
                active && 'bg-card shadow-[inset_2px_0_0_var(--primary)]',
              )}
            >
              <span className="flex w-full items-baseline gap-2">
                <span className="text-sm font-semibold">Patch {entry.patch}</span>
                {i === 0 && (
                  <span className="text-[9px] font-semibold tracking-widest text-primary uppercase">
                    Latest
                  </span>
                )}
              </span>
              {entry.diff && (
                <span className="text-[11px] text-muted-foreground">
                  {plural(entry.diff.changedChampions, 'champion')} ·{' '}
                  {plural(entry.diff.changedItems, 'item')}
                  {entry.diff.source === 'backfill' ? ' · final build' : ''}
                </span>
              )}
            </button>
            {entry.hotfixes.map((h) => {
              const sel = { patch: entry.patch, build: h.build };
              const on = sameSelection(selected, sel);
              return (
                <button
                  key={h.build}
                  type="button"
                  aria-current={on ? 'true' : undefined}
                  onClick={() => onSelect(sel)}
                  className={cn(
                    'ml-3 flex items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-accent',
                    on && 'bg-card shadow-[inset_2px_0_0_var(--primary)]',
                  )}
                  title={`Build ${h.build}`}
                >
                  <CornerDownRightIcon className="size-3 text-muted-foreground" />
                  <HotfixBadge />
                  <span>{shortDate(h.detectedAt)}</span>
                  <span className="text-muted-foreground">
                    · {h.changedChampions + h.changedItems} changed
                  </span>
                </button>
              );
            })}
            {entry.quietHotfixes > 0 && (
              <span className="ml-8 px-2 py-0.5 text-[10px] text-muted-foreground/70">
                {entry.quietHotfixes} {entry.quietHotfixes === 1 ? 'build' : 'builds'} without
                gameplay change
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

function ChangeRow({ change }: { change: PatchNoteChange }) {
  const { from, to } = changeText(change);
  const title = [
    change.valueName,
    change.spellNames.length > 0 ? change.spellNames.join(', ') : null,
    change.direction !== 'neutral'
      ? `${change.magnitude > 0 ? '+' : ''}${(change.magnitude * 100).toFixed(1)}% × relevance ${change.relevance.toFixed(2)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-0.5 text-[13px]',
        change.minor && 'opacity-70',
      )}
      title={title}
    >
      <span className="min-w-0">
        <span className="text-foreground/90">{change.label}</span>{' '}
        <span className="num text-muted-foreground">{from}</span>
        <span className="text-muted-foreground"> → </span>
        <span className="num">{to}</span>
      </span>
      <DirectionMark change={change} />
    </li>
  );
}

function DirectionMark({ change }: { change: PatchNoteChange }) {
  if (change.direction === 'neutral') {
    return (
      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">Changed</span>
    );
  }
  const up = change.direction === 'buff';
  const Icon = up ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[10px] font-semibold tracking-wide uppercase',
        up ? 'text-up' : 'text-down',
      )}
    >
      <Icon className="size-3" />
      {up ? 'Buff' : 'Nerf'}
      {change.minor && (
        <span className="font-normal text-muted-foreground normal-case"> minor</span>
      )}
    </span>
  );
}

function DamageSplit({ damage }: { damage: PatchNoteDamageSplit }) {
  const source =
    damage.source === 'stats'
      ? `Measured on patch ${damage.patch} (${compact(damage.games)} games)`
      : damage.source === 'ddragon'
        ? "Estimated from Data Dragon's attack / magic ratings"
        : 'Unknown: counted half AD, half AP';
  const parts = [
    ['AD', damage.physical, 'bg-[#f0a35f]'],
    ['AP', damage.magic, 'bg-[#6fa8ff]'],
    ['True', damage.true, 'bg-foreground/60'],
  ] as const;
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      title={`Damage split: ${source}. Ratios are weighed by it.`}
    >
      <span className="flex h-1.5 w-16 overflow-hidden bg-secondary">
        {parts.map(([k, v, bg]) => (
          <span key={k} className={bg} style={{ width: `${v * 100}%` }} />
        ))}
      </span>
      <span className="num">
        {parts
          .filter(([, v]) => v >= 0.05)
          .map(([k, v]) => `${k} ${Math.round(v * 100)}`)
          .join(' · ')}
        {damage.source !== 'stats' && ' (est.)'}
      </span>
    </span>
  );
}

function ChampionCard({
  champion,
  lookup,
  notes,
  items,
  showTechnical,
  jump,
}: {
  champion: PatchNotesChampion;
  lookup: StaticLookup | null;
  notes: PatchNotesResponse;
  items: ChampionItemLink[];
  showTechnical: boolean;
  jump: (id: string) => void;
}) {
  const info = lookup?.champion(champion.championId);
  const spells = visibleChanges(champion.spells, showTechnical);
  return (
    <article
      id={anchors.champion(champion.championId)}
      className="scroll-mt-3 border border-border bg-card p-3"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ChampionIcon src={info?.iconUrl} name={champion.name} size={36} />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="font-semibold">{champion.name}</span>
            <VerdictBadge verdict={champion.verdict} />
          </span>
          <DamageSplit damage={champion.damage} />
        </div>
      </header>

      {notes.observedPatches && (
        <div className="mt-2 text-xs text-muted-foreground">
          {champion.observed.length > 0 ? (
            <span className="flex flex-wrap gap-x-3 gap-y-0.5">
              <span>Observed since {notes.observedPatches.previous}:</span>
              {champion.observed.map((o) => (
                <span
                  key={o.role}
                  title={`${percent(o.previousWinRate)} → ${percent(o.winRate)} win rate (${o.previousGames.toLocaleString()} → ${o.games.toLocaleString()} games), centred on the role's average`}
                >
                  {ROLE_LABEL[o.role]} <DeltaText delta={o.delta} /> pts{' '}
                  <span className="text-muted-foreground/70">({compact(o.games)} games)</span>
                </span>
              ))}
            </span>
          ) : (
            <span>
              Observed win rate: not enough games yet in a main role (
              {notes.thresholds.minObservedGames} per patch).
            </span>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>Builds changed items:</span>
          {items.map((l) => (
            <JumpLink
              key={l.itemId}
              to={anchors.itemUsers(l.itemId)}
              jump={jump}
              className={TONE_TEXT[verdictTone(l.verdict)]}
            >
              {l.name} ({VERDICT_LABEL[l.verdict].toLowerCase()}, {ROLE_LABEL[l.role]}{' '}
              {Math.round(l.share * 100)}%)
            </JumpLink>
          ))}
        </div>
      )}

      {champion.status !== 'changed' && (
        <p className="mt-2 text-xs text-muted-foreground">
          {champion.status === 'new'
            ? 'New champion in the game files.'
            : 'Removed from the game files.'}
        </p>
      )}

      {spells.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {spells.map((group) => {
            const n = spellSlotNumber(group.slot);
            const spell = n === null ? undefined : info?.spells.find((s) => s.slot === n);
            return (
              <section key={group.slot} className="flex gap-2">
                {spell ? (
                  <GameIcon src={spell.iconUrl} alt={spell.name} size={22} className="mt-0.5" />
                ) : (
                  <span className="mt-0.5 grid size-[22px] shrink-0 place-items-center bg-secondary text-[9px] font-semibold text-muted-foreground">
                    {group.slot === 'base' ? 'Stat' : group.slot === 'P' ? 'P' : '…'}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {SLOT_LABEL[group.slot]}
                    {spell && <span className="normal-case"> · {spell.name}</span>}
                  </h4>
                  <ul>
                    {group.changes.map((c) => (
                      <ChangeRow key={changeKey(c)} change={c} />
                    ))}
                  </ul>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </article>
  );
}

function ItemCard({
  item,
  lookup,
  users,
  showTechnical,
  jump,
}: {
  item: PatchNotesItem;
  lookup: StaticLookup | null;
  users: number;
  showTechnical: boolean;
  jump: (id: string) => void;
}) {
  const info = lookup?.item(item.itemId);
  const changes = showTechnical
    ? item.changes
    : item.changes.filter((c) => c.category !== 'technical');
  return (
    <article
      id={anchors.item(item.itemId)}
      className="scroll-mt-3 border border-border bg-card p-3"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GameIcon src={info?.iconUrl} alt={item.name} size={32} />
        <span className="font-semibold">{item.name}</span>
        <VerdictBadge verdict={item.verdict} />
        <JumpLink
          to={anchors.itemUsers(item.itemId)}
          jump={jump}
          className="ml-auto text-xs text-muted-foreground"
        >
          {users > 0
            ? `Built by ${users} champion ${users === 1 ? 'role' : 'roles'} ↓`
            : 'Who builds it ↓'}
        </JumpLink>
      </header>
      {changes.length > 0 && (
        <ul className="mt-2">
          {changes.map((c) => (
            <ChangeRow key={changeKey(c)} change={c} />
          ))}
        </ul>
      )}
    </article>
  );
}

function ItemUsersCard({
  entry,
  lookup,
  changedChampions,
  notes,
  jump,
}: {
  entry: PatchNotesItemUsers;
  lookup: StaticLookup | null;
  changedChampions: Map<number, PatchNotesChampion>;
  notes: PatchNotesResponse;
  jump: (id: string) => void;
}) {
  const info = lookup?.item(entry.itemId);
  return (
    <article
      id={anchors.itemUsers(entry.itemId)}
      className="scroll-mt-3 border border-border bg-card p-3"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GameIcon src={info?.iconUrl} alt={entry.name} size={28} />
        <JumpLink to={anchors.item(entry.itemId)} jump={jump} className="font-semibold">
          {entry.name}
        </JumpLink>
        <VerdictBadge verdict={entry.verdict} />
      </header>
      {entry.users.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {notes.statsPatch
            ? `No champion completes it in ${Math.round(notes.thresholds.minItemShare * 100)}% of its games or more (patch ${notes.statsPatch}).`
            : 'No build stats yet.'}
        </p>
      ) : (
        <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1.5">
          {entry.users.map((u) => {
            const champ = lookup?.champion(u.championId);
            const changed = changedChampions.get(u.championId);
            const name = champ?.name ?? changed?.name ?? `#${u.championId}`;
            const body = (
              <>
                <ChampionIcon src={champ?.iconUrl} name={name} size={24} />
                <span className="min-w-0 flex-1 truncate">
                  {name} <span className="text-muted-foreground">{ROLE_LABEL[u.role]}</span>
                </span>
                <span
                  className="num text-muted-foreground"
                  title={`${u.games.toLocaleString()} games`}
                >
                  {Math.round(u.share * 100)}%
                </span>
              </>
            );
            return (
              <li key={`${u.championId}-${u.role}`} className="text-xs">
                {changed ? (
                  <JumpLink
                    to={anchors.champion(u.championId)}
                    jump={jump}
                    className="flex items-center gap-1.5 bg-secondary/60 px-1.5 py-1"
                  >
                    {body}
                    <VerdictBadge verdict={changed.verdict} className="px-1 text-[8px]" />
                  </JumpLink>
                ) : (
                  <span
                    className="flex items-center gap-1.5 px-1.5 py-1"
                    title="Not changed itself this patch: only its item is"
                  >
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SectionTitle({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <h2
      id={id}
      className="mt-6 mb-2 scroll-mt-3 text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase"
    >
      {title} <span className="num">({count})</span>
    </h2>
  );
}

function Explanation({ notes }: { notes: PatchNotesResponse }) {
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">How buffs and nerfs are judged</summary>
      <div className="mt-1 flex max-w-3xl flex-col gap-1 leading-relaxed">
        <p>
          Values come from the game files. Higher damage, healing, shields, ratios, range, crowd
          control, speeds and stats are buffs; lower cooldowns, costs and cast times too. Values we
          cannot read with confidence show as “changed”.
        </p>
        <p>
          Each change weighs its relative size (ranks averaged) times how much it matters to the
          champion: an AP ratio counts as much as the champion deals magic damage, an AD ratio as
          much as it deals physical damage (10% + 90% × that share); mana costs and minion values
          count less, attack range double. Under 5% it is minor. A champion is a buff or a nerf when
          one side clearly outweighs the other, mixed when both are close.
        </p>
        {notes.observedPatches && (
          <p>
            Observed: the champion's win rate in its main roles on {notes.observedPatches.current}{' '}
            minus {notes.observedPatches.previous}, each relative to its role's average, with at
            least {notes.thresholds.minObservedGames} games on each patch.
          </p>
        )}
        {notes.statsPatch && (
          <p>
            Item users: champion + roles completing (or starting with) the item in at least{' '}
            {Math.round(notes.thresholds.minItemShare * 100)}% of their games on patch{' '}
            {notes.statsPatch}, with {notes.thresholds.minRoleGames}+ games.
          </p>
        )}
      </div>
    </details>
  );
}

function PatchNotesContent({
  notes,
  lookup,
  jump,
}: {
  notes: PatchNotesResponse;
  lookup: StaticLookup | null;
  jump: (id: string) => void;
}) {
  const [showTechnical, setShowTechnical] = useState(false);
  const technical = useMemo(() => technicalCount(notes), [notes]);
  const links = useMemo(() => itemsByChampion(notes.itemUsers), [notes]);
  const changedChampions = useMemo(
    () => new Map(notes.champions.map((c) => [c.championId, c])),
    [notes],
  );
  const usersOf = useMemo(
    () => new Map(notes.itemUsers.map((i) => [i.itemId, i.users.length])),
    [notes],
  );
  const hotfix = notes.kind === 'hotfix';

  return (
    <div className="mx-auto flex max-w-5xl flex-col px-4 py-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">Patch {notes.patch}</h1>
          {hotfix && <HotfixBadge />}
          {hotfix && (
            <span className="text-sm text-muted-foreground">{shortDate(notes.detectedAt)}</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {hotfix
            ? `Mid-patch hotfix: build ${notes.build}, changes since build ${notes.baseBuild}.`
            : `Changes since patch ${notes.basePatch}.`}{' '}
          {plural(notes.changedChampions, 'champion')}, {plural(notes.changedItems, 'item')}.
        </p>
        {notes.source === 'backfill' && (
          <p className="text-xs text-gold">
            Read from the patch's final build ({notes.build}): it includes the mid-patch hotfixes.
          </p>
        )}
        {!hotfix && notes.hotfixes.some((h) => h.gameplayChanged) && (
          <p className="text-xs text-gold">
            This patch also had{' '}
            {notes.hotfixes.filter((h) => h.gameplayChanged).length === 1
              ? 'a hotfix'
              : `${notes.hotfixes.filter((h) => h.gameplayChanged).length} hotfixes`}{' '}
            with gameplay changes: see them under the patch in the list.
          </p>
        )}
        <Explanation notes={notes} />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <JumpLink to="pn-champions" jump={jump} className="text-muted-foreground">
            Champions ({notes.champions.length})
          </JumpLink>
          <JumpLink to="pn-items" jump={jump} className="text-muted-foreground">
            Items ({notes.items.length})
          </JumpLink>
          <JumpLink to="pn-item-users" jump={jump} className="text-muted-foreground">
            Item changes by champion ({notes.itemUsers.length})
          </JumpLink>
          {technical > 0 && (
            <Label className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <Switch size="sm" checked={showTechnical} onCheckedChange={setShowTechnical} />
              Show technical values ({technical})
            </Label>
          )}
        </div>
      </header>

      <SectionTitle id="pn-champions" title="Champions" count={notes.champions.length} />
      {notes.champions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No champion changed.</p>
      ) : (
        <div className="grid gap-2 xl:grid-cols-2">
          {notes.champions.map((c) => (
            <ChampionCard
              key={c.championId}
              champion={c}
              lookup={lookup}
              notes={notes}
              items={links.get(c.championId) ?? []}
              showTechnical={showTechnical}
              jump={jump}
            />
          ))}
        </div>
      )}

      <SectionTitle id="pn-items" title="Items" count={notes.items.length} />
      {notes.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No item changed.</p>
      ) : (
        <div className="grid gap-2 xl:grid-cols-2">
          {notes.items.map((i) => (
            <ItemCard
              key={i.itemId}
              item={i}
              lookup={lookup}
              users={usersOf.get(i.itemId) ?? 0}
              showTechnical={showTechnical}
              jump={jump}
            />
          ))}
        </div>
      )}

      <SectionTitle
        id="pn-item-users"
        title="Item changes by champion"
        count={notes.itemUsers.length}
      />
      {notes.itemUsers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No item changed.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Champions that build a changed item, even when they were not changed themselves.
          </p>
          {notes.itemUsers.map((entry) => (
            <ItemUsersCard
              key={entry.itemId}
              entry={entry}
              lookup={lookup}
              changedChampions={changedChampions}
              notes={notes}
              jump={jump}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Patch notes: every champion and item value a patch (or a mid-patch hotfix) changed, read from
 * the game files, each judged buff or nerf and weighed for the champion; the newest patch first.
 */
export function PatchNotesPage({
  lookup,
  dataKey,
}: {
  lookup: StaticLookup | null;
  dataKey: string;
}) {
  const api = usePickLeagueData();
  const { scroller, jump } = useJump();
  const { result: index, retry: retryIndex } = useApiCall(
    true,
    () => api.getPatchNotesIndex(),
    dataKey,
    true,
  );
  const entries = useMemo(
    () => (index.status === 'ok' ? selectorPatches(index.data) : []),
    [index],
  );
  const [picked, setPicked] = useState<PatchNotesSelection | null>(null);
  const first = entries[0];
  const selected = picked ?? (first ? patchSelection(first) : null);
  const { result: notes, retry } = useApiCall(
    selected,
    (s) => api.getPatchNotes(s.patch, s.build),
    dataKey,
    true,
  );
  const select = (s: PatchNotesSelection) => {
    setPicked(s);
    scroller.current?.scrollTo({ top: 0 });
  };

  if (index.status === 'error') {
    return (
      <div className="flex-1">
        <Notice
          tone="bad"
          title="Patch notes unavailable"
          message={index.message}
          action={{ label: 'Retry', onClick: retryIndex }}
        />
      </div>
    );
  }
  if (index.status === 'ok' && entries.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground">
        No patch changes recorded yet.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <aside className="max-h-44 shrink-0 overflow-y-auto border-b border-border md:max-h-none md:w-60 md:border-r md:border-b-0">
        {index.status === 'ok' ? (
          <PatchSelector entries={entries} selected={selected} onSelect={select} />
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        )}
      </aside>
      <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {notes.status === 'error' && (
          <Notice
            tone={notes.code === 'NOT_FOUND' ? 'warn' : 'bad'}
            title="Patch notes unavailable"
            message={notes.message}
            action={{ label: 'Retry', onClick: retry }}
          />
        )}
        {(notes.status === 'ok' || (notes.status === 'loading' && notes.data)) && notes.data && (
          <div className={cn(notes.status === 'loading' && 'opacity-60')}>
            <PatchNotesContent notes={notes.data} lookup={lookup} jump={jump} />
          </div>
        )}
        {(notes.status === 'idle' || (notes.status === 'loading' && !notes.data)) && (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
