import {
  type DraftEvaluationResponse,
  GAME_LENGTH_MINUTES,
  type TeamDamage,
  type TeamGameLength,
} from '@pick-league/shared';
import { deltaPoints } from './format';

export interface DamageShares {
  physical: number;
  magic: number;
  true: number;
  /** Damage to champions per minute of the whole team. */
  perMinute: number;
}

/** Share of each damage type in a team's damage; null before any champion with data. */
export function damageShares(team: TeamDamage | null | undefined): DamageShares | null {
  if (!team) return null;
  const total = team.physical + team.magic + team.true;
  if (total <= 0) return null;
  return {
    physical: team.physical / total,
    magic: team.magic / total,
    true: team.true / total,
    perMinute: total,
  };
}

/** Whole-number percentages that add up to 100 (largest remainders get the rounding). */
export function roundedShares(s: DamageShares): { physical: number; magic: number; true: number } {
  const keys = ['physical', 'magic', 'true'] as const;
  const raw = keys.map((k) => s[k] * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, rest: v - Math.floor(v) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return { physical: floors[0] ?? 0, magic: floors[1] ?? 0, true: floors[2] ?? 0 };
}

/** "AD 62% · AP 33% · true 5%" */
export function damageLabel(s: DamageShares): string {
  const r = roundedShares(s);
  return `AD ${r.physical}% · AP ${r.magic}% · true ${r.true}%`;
}

/** A team's early or late sum worth naming (1.5 points). */
export const GAME_LENGTH_NOTABLE = 0.015;
/** Gap between the teams' late-minus-early leans that makes a takeaway (4 points). */
export const GAME_LENGTH_CLEAR = 0.04;

export type DraftGameLength = NonNullable<DraftEvaluationResponse['gameLength']>;

const pointsPct = (x: number) => `${deltaPoints(x)}%`;

/** "Stronger early (+2.4%) — falls off late (-1.8%)", "No clear early or late lean", or "—". */
export function teamGameLengthText(t: TeamGameLength | null | undefined): string {
  if (!t || t.champions === 0) return '—';
  const early =
    t.early >= GAME_LENGTH_NOTABLE
      ? `Stronger early (${pointsPct(t.early)})`
      : t.early <= -GAME_LENGTH_NOTABLE
        ? `Weaker early (${pointsPct(t.early)})`
        : null;
  const late =
    t.late >= GAME_LENGTH_NOTABLE
      ? `scales late (${pointsPct(t.late)})`
      : t.late <= -GAME_LENGTH_NOTABLE
        ? `falls off late (${pointsPct(t.late)})`
        : null;
  if (!early && !late) return 'No clear early or late lean';
  return `${early ?? 'Even early'} — ${late ?? 'even late'}`;
}

/** Tooltip of a team's game-length line. */
export function gameLengthTitle(t: TeamGameLength | null | undefined): string {
  const n = t?.champions ?? 0;
  return (
    "Sum of this team's champions: how much better or worse each does in games under " +
    `${GAME_LENGTH_MINUTES.earlyUnder} min and of ${GAME_LENGTH_MINUTES.lateFrom} min or more ` +
    `than usual, compared with its role (${n} ${n === 1 ? 'champion' : 'champions'} with enough ` +
    'games). Not part of the win chance.'
  );
}

/**
 * Which team gains from a long game: the allies' late-minus-early lean against the enemies'.
 * Even until both teams have a champion with a profile.
 */
export function gameLengthVerdict(g: DraftGameLength): 'allies_scale' | 'enemies_scale' | 'even' {
  if (g.allies.champions < 1 || g.enemies.champions < 1) return 'even';
  const swing = g.allies.late - g.enemies.late - (g.allies.early - g.enemies.early);
  if (swing >= GAME_LENGTH_CLEAR) return 'allies_scale';
  if (swing <= -GAME_LENGTH_CLEAR) return 'enemies_scale';
  return 'even';
}

/**
 * One-line takeaway, null when neither team clearly outscales. `own`: the allies are the user's
 * team (champion select); otherwise both sides are named by their labels (draft planner).
 */
export function gameLengthTakeaway(
  g: DraftGameLength | null | undefined,
  allies: string,
  enemies: string,
  own: boolean,
): string | null {
  if (!g) return null;
  const verdict = gameLengthVerdict(g);
  if (verdict === 'even') return null;
  if (own)
    return verdict === 'allies_scale' ? 'You outscale: play for late' : 'They outscale: end early';
  return verdict === 'allies_scale'
    ? `${allies} outscales: ${enemies} wants a short game`
    : `${enemies} outscales: ${allies} wants a short game`;
}
