import { ROLE_LABEL } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../../../core/app-state.ts';
import type { ChampSelectView, SelectPlayerView } from '../../../core/champ-select.ts';
import type { StaticLookup } from '../hooks/use-app';
import { ChampionIcon, GameIcon } from './game-icon';

const PHASE_LABEL: Record<string, string> = {
  PLANNING: 'Declaring',
  BAN_PICK: 'Bans & picks',
  FINALIZATION: 'Finalizing',
  GAME_STARTING: 'Game starting',
};

function PlayerRow({
  player,
  lookup,
  me,
  mastery,
  side,
}: {
  player: SelectPlayerView;
  lookup: StaticLookup | null;
  me?: boolean;
  mastery?: AppState['mastery'];
  side: 'ally' | 'enemy';
}) {
  const champ = lookup?.champion(player.championId);
  const name = champ?.name ?? (player.championId ? `#${player.championId}` : null);
  return (
    <li
      className={cn(
        'flex items-center gap-2.5 py-1.5 pr-2 pl-2.5',
        me && 'bg-primary/8 shadow-[inset_2px_0_0_var(--primary)]',
      )}
    >
      {player.championId ? (
        <ChampionIcon
          src={champ?.iconUrl}
          name={name ?? ''}
          size={30}
          mastery={me ? mastery?.[player.championId] : undefined}
          dim={player.hovering}
        />
      ) : (
        <span className="size-[30px] shrink-0 border border-dashed border-border" />
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={cn('truncate text-[13px]', !name && 'text-muted-foreground')}>
          {name ?? (side === 'enemy' ? 'Hidden' : 'Picking…')}
        </span>
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
          {me ? 'You · ' : ''}
          {player.role ? ROLE_LABEL[player.role] : side === 'enemy' ? 'Role unknown' : '—'}
          {player.hovering ? ' · hovering' : ''}
        </span>
      </span>
      {player.locked && <span className="ml-auto text-[10px] text-muted-foreground">locked</span>}
    </li>
  );
}

function BanRow({ ids, lookup }: { ids: number[]; lookup: StaticLookup | null }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ids.length === 0 && <span className="text-[11px] text-muted-foreground">none yet</span>}
      {ids.map((id) => {
        const c = lookup?.champion(id);
        return <GameIcon key={id} src={c?.iconUrl} alt={c?.name ?? `#${id}`} size={22} dim />;
      })}
    </div>
  );
}

export function ChampSelectBoard({
  view,
  lookup,
  mastery,
}: {
  view: ChampSelectView;
  lookup: StaticLookup | null;
  mastery: AppState['mastery'];
}) {
  const mine = [...view.allies, view.me].sort((a, b) => a.cellId - b.cellId);
  return (
    <aside className="flex w-[248px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-3">
      <div className="flex items-baseline justify-between px-1">
        <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {PHASE_LABEL[view.phase] ?? view.phase}
        </span>
        <span className="text-[11px]">
          <span className="text-muted-foreground">You play </span>
          <span className="font-semibold">{ROLE_LABEL[view.role]}</span>
          {view.roleAssumed && <span className="text-muted-foreground"> (assumed)</span>}
        </span>
      </div>

      <section>
        <h3 className="mb-1 px-1 text-[10px] font-semibold tracking-[0.18em] text-up uppercase">
          Your team
        </h3>
        <ul className="flex flex-col">
          {mine.map((p) => (
            <PlayerRow
              key={p.cellId}
              player={p}
              lookup={lookup}
              me={p.cellId === view.me.cellId}
              mastery={mastery}
              side="ally"
            />
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-1 px-1 text-[10px] font-semibold tracking-[0.18em] text-down uppercase">
          Enemy team
        </h3>
        <ul className="flex flex-col">
          {view.enemies.map((p) => (
            <PlayerRow key={p.cellId} player={p} lookup={lookup} side="enemy" />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 px-1">
        <h3 className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Bans
        </h3>
        <BanRow ids={view.bans.ally} lookup={lookup} />
        <BanRow ids={view.bans.enemy} lookup={lookup} />
      </section>
    </aside>
  );
}
