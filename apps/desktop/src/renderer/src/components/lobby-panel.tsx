import { LIVE_RECENT_MATCHES, type LiveTeam } from '@pick-league/shared';
import { LoaderCircleIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { compact, percent, ROLE_LABEL } from '@/lib/format';
import {
  championForm,
  FIRST_TIME_POINTS,
  isFirstTime,
  offRoleText,
  rankLabel,
  TIER_COLOR,
  winLoss,
  winRateTone,
} from '@/lib/lobby';
import { cn } from '@/lib/utils';
import type { LobbyPlayerView, LobbyView } from '../../../core/live-lobby.ts';
import type { StaticLookup } from '../hooks/use-app';
import { ChampionIcon } from './game-icon';
import { Notice } from './notice';

const GRID =
  'grid items-center gap-3 grid-cols-[minmax(150px,1.5fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_minmax(0,0.9fr)]';

const RECENT = `last ${LIVE_RECENT_MATCHES} ranked solo/duo matches`;

const COLUMNS: { label: string; title: string; right?: boolean }[] = [
  { label: 'Player', title: 'Champion and role in this match' },
  { label: 'Rank', title: 'Solo/duo rank this season' },
  { label: 'Season', title: 'Solo/duo win rate this season' },
  { label: 'On this champion', title: `Results on this champion over the ${RECENT}, and mastery` },
  { label: 'Recent', title: `Results over the ${RECENT}, and the role played most` },
];

const TONE = { up: 'text-up', down: 'text-down', neutral: 'text-foreground' } as const;

function Waiting({ className }: { className?: string }) {
  return <Skeleton className={cn('h-3 w-16', className)} />;
}

/** "—" for a player whose lookup failed or whose server is not collected. */
function Missing({ player }: { player: LobbyPlayerView }) {
  return (
    <span
      className="text-xs text-muted-foreground"
      title={player.status === 'failed' ? 'Could not be looked up' : undefined}
    >
      —
    </span>
  );
}

function Cell({ top, bottom }: { top: ReactNode; bottom?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
      <span className="truncate text-xs">{top}</span>
      {bottom !== undefined && (
        <span className="num truncate text-[10px] text-muted-foreground">{bottom}</span>
      )}
    </span>
  );
}

function Flag({ label, tip, tone }: { label: string; tip: string; tone: 'gold' | 'muted' }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'shrink-0 border px-1 text-[9px] leading-[14px] font-semibold tracking-wider uppercase',
              tone === 'gold' ? 'border-gold/50 text-gold' : 'border-border text-muted-foreground',
            )}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs whitespace-normal">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

function RankCell({ player }: { player: LobbyPlayerView }) {
  if (!player.rankLoaded)
    return player.status === 'pending' ? <Waiting /> : <Missing player={player} />;
  const rank = player.rank;
  if (!rank) return <Cell top={<span className="text-muted-foreground">Unranked</span>} />;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rotate-45"
        style={{ backgroundColor: TIER_COLOR[rank.tier] }}
      />
      <Cell top={<span className="font-medium">{rankLabel(rank)}</span>} bottom={`${rank.lp} LP`} />
    </span>
  );
}

function SeasonCell({ player }: { player: LobbyPlayerView }) {
  if (!player.rankLoaded)
    return player.status === 'pending' ? <Waiting /> : <Missing player={player} />;
  const rank = player.rank;
  if (!rank) return <Missing player={player} />;
  const games = rank.wins + rank.losses;
  return (
    <Cell
      top={
        <span className={cn('num font-medium', TONE[winRateTone(rank.wins, games)])}>
          {percent(rank.winRate, 0)}
        </span>
      }
      bottom={`${winLoss(rank.wins, rank.losses)} · ${games} matches`}
    />
  );
}

function ChampionCell({ player }: { player: LobbyPlayerView }) {
  const { recent, mastery } = player;
  if (!recent && !mastery) {
    return player.status === 'pending' ? <Waiting className="w-20" /> : <Missing player={player} />;
  }
  const form = recent ? championForm(recent) : null;
  const masteryText = mastery
    ? mastery.points > 0
      ? `Mastery ${mastery.level} · ${compact(mastery.points)} pts`
      : 'Never played'
    : null;
  return (
    <Cell
      top={
        recent ? (
          form ? (
            <span
              className={cn('num', TONE[winRateTone(recent.championWins, recent.championMatches)])}
            >
              {form}
            </span>
          ) : (
            <span className="text-muted-foreground">No recent match</span>
          )
        ) : player.status === 'pending' ? (
          <Waiting />
        ) : (
          <Missing player={player} />
        )
      }
      bottom={masteryText ?? (player.status === 'pending' ? <Waiting className="w-12" /> : '—')}
    />
  );
}

function RecentCell({ player }: { player: LobbyPlayerView }) {
  const recent = player.recent;
  if (!recent) {
    return player.status === 'pending' ? <Waiting className="w-20" /> : <Missing player={player} />;
  }
  if (recent.matches === 0) {
    return <Cell top={<span className="text-muted-foreground">No recent match</span>} />;
  }
  return (
    <Cell
      top={
        <span className={cn('num', TONE[winRateTone(recent.wins, recent.matches)])}>
          {winLoss(recent.wins, recent.matches - recent.wins)} ·{' '}
          {percent(recent.wins / recent.matches, 0)}
        </span>
      }
      bottom={recent.mainRole ? `Mostly ${ROLE_LABEL[recent.mainRole]}` : undefined}
    />
  );
}

function PlayerRow({ player, lookup }: { player: LobbyPlayerView; lookup: StaticLookup | null }) {
  const champ = lookup?.champion(player.championId);
  const name = champ?.name ?? `#${player.championId}`;
  const offRole = offRoleText(player);
  return (
    <div
      className={cn(
        GRID,
        'border-b border-border px-3 py-1.5',
        player.me && 'bg-primary/8 shadow-[inset_2px_0_0_var(--primary)]',
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <ChampionIcon src={champ?.iconUrl} name={name} size={32} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] font-medium">{name}</span>
          <span className="truncate text-[10px] tracking-wider text-muted-foreground uppercase">
            {player.me ? 'You · ' : ''}
            {player.position ? ROLE_LABEL[player.position] : 'Role unknown'}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 flex-col items-end gap-0.5">
          {offRole && <Flag label="Off-role" tip={offRole} tone="gold" />}
          {isFirstTime(player) && (
            <Flag
              label="First time"
              tip={`Under ${compact(FIRST_TIME_POINTS)} mastery points, and not played in their ${RECENT}.`}
              tone="muted"
            />
          )}
        </span>
      </span>
      <RankCell player={player} />
      <SeasonCell player={player} />
      <ChampionCell player={player} />
      <RecentCell player={player} />
    </div>
  );
}

function TeamTable({
  team,
  players,
  lookup,
}: {
  team: LiveTeam;
  players: LobbyPlayerView[];
  lookup: StaticLookup | null;
}) {
  if (players.length === 0) return null;
  return (
    <section>
      <div
        className={cn(
          GRID,
          'border-b border-border px-3 pt-3 pb-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase',
        )}
      >
        {COLUMNS.map((c, i) => (
          <span
            key={c.label}
            title={c.title}
            className={cn(
              i === 0 && 'tracking-[0.18em]',
              i === 0 && (team === 'ally' ? 'text-up' : 'text-down'),
            )}
          >
            {i === 0 ? (team === 'ally' ? 'Your team' : 'Enemy team') : c.label}
          </span>
        ))}
      </div>
      {players.map((p) => (
        // Players have no identity in the view: a champion appears once per team.
        <PlayerRow key={p.championId} player={p} lookup={lookup} />
      ))}
    </section>
  );
}

function LobbyNotice({ lobby }: { lobby: LobbyView }) {
  const retry = { label: 'Retry', onClick: () => void window.pickleague.refresh() };
  if (lobby.state === 'unsupported') {
    return (
      <Notice
        tone="warn"
        title="Server not collected"
        message={lobby.message ?? 'PickLeague does not collect your server.'}
      />
    );
  }
  if (lobby.state === 'error') {
    return (
      <Notice
        tone="bad"
        title="Lobby lookup failed"
        message={lobby.message ?? 'The API did not answer.'}
        action={retry}
      />
    );
  }
  if (lobby.state === 'timeout') {
    return (
      <Notice
        tone="warn"
        title="Some players are missing"
        message={lobby.message ?? 'Stopped waiting for the worker.'}
        action={retry}
      />
    );
  }
  if (lobby.message)
    return <Notice tone="warn" title="Worker unavailable" message={lobby.message} />;
  return null;
}

export function LobbyPanel({
  lobby,
  lookup,
}: {
  lobby: LobbyView | null;
  lookup: StaticLookup | null;
}) {
  if (!lobby) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Players are looked up once the match has started — never during champion select, where Riot
        keeps them hidden. Their rank, form and mastery show here as soon as the loading screen is
        over.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-semibold tracking-[0.18em] text-foreground uppercase">
          Live match
        </span>
        {lobby.platform && <span className="num">{lobby.platform}</span>}
        <span>recent = {RECENT}</span>
        {lobby.state === 'loading' && (
          <span className="ml-auto flex items-center gap-1.5">
            <LoaderCircleIcon className="size-3 animate-spin" />
            Ranks first; recent matches can take a minute or two
          </span>
        )}
      </div>
      <LobbyNotice lobby={lobby} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <TeamTable team="ally" players={lobby.allies} lookup={lookup} />
        <TeamTable team="enemy" players={lobby.enemies} lookup={lookup} />
      </div>
    </div>
  );
}
