import { cn } from '@pick-league/ui/lib/utils';
import type { MasteryEntry } from '../../../core/app-state.ts';

interface GameIconProps {
  src: string | undefined;
  alt: string;
  size?: number;
  className?: string;
  /** Rounded (runes, trees) instead of square (champions, items, spells). */
  round?: boolean;
  dim?: boolean;
}

/** Data Dragon icon with a neutral placeholder while static data is missing. */
export function GameIcon({ src, alt, size = 32, className, round, dim }: GameIconProps) {
  const style = { width: size, height: size };
  if (!src) {
    return (
      <span
        role="img"
        aria-label={alt}
        title={alt}
        style={style}
        className={cn(
          'grid shrink-0 place-items-center bg-secondary text-[9px] text-muted-foreground',
          round && 'rounded-full',
          className,
        )}
      >
        ?
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      title={alt}
      draggable={false}
      style={style}
      className={cn(
        'shrink-0 bg-secondary object-cover',
        round && 'rounded-full bg-transparent',
        dim && 'opacity-40 grayscale',
        className,
      )}
    />
  );
}

/** The user's own mastery level, pinned on the champion icon's corner. */
export function MasteryBadge({ mastery }: { mastery: MasteryEntry | undefined }) {
  if (!mastery || mastery.level <= 0) return null;
  const tier = mastery.level >= 10 ? 'high' : mastery.level >= 5 ? 'mid' : 'low';
  return (
    <span
      title={`Your mastery: level ${mastery.level} · ${mastery.points.toLocaleString()} pts`}
      className={cn(
        'num absolute -right-1.5 -bottom-1.5 min-w-[18px] px-1 text-center text-[10px] leading-[16px] font-semibold ring-2 ring-background',
        tier === 'high' && 'bg-gold text-[#1b1406]',
        tier === 'mid' && 'bg-[#8fa6b3] text-[#0f1519]',
        tier === 'low' && 'bg-secondary text-muted-foreground',
      )}
    >
      {mastery.level}
    </span>
  );
}

export function ChampionIcon({
  src,
  name,
  size = 40,
  mastery,
  className,
  dim,
}: {
  src: string | undefined;
  name: string;
  size?: number;
  mastery?: MasteryEntry | undefined;
  className?: string;
  dim?: boolean;
}) {
  return (
    <span className={cn('relative inline-block shrink-0', className)}>
      <GameIcon src={src} alt={name} size={size} dim={dim} />
      <MasteryBadge mastery={mastery} />
    </span>
  );
}
