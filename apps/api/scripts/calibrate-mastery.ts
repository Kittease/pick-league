/**
 * Calibration check of the mastery term of the picks: the curve, the weight of the term and the
 * `k` of a champion's own deviation, measured on the stored matches with a time split. Statistics
 * come from every match of the previous patch and the earlier matches of the latest one; the
 * latest 20 % (`--test-share`) by start time are held out.
 *
 * Only "pre-game" participants are scored: those whose stored mastery row was fetched before
 * the game (`last_played_at`, Riot's `lastPlayTime`, is the end of the player's last game on the
 * champion: before the game's start, the points do not include it). That is what the term sees
 * in production: the user's points before champion select. The rows fetched after the game
 * (points that include the game and later ones: a player who lost their first game on a champion
 * stays under 1,000 points) are measured too, for the record: `all` is the definition of
 * stats_champion_mastery before 0035, `pre` the one since.
 *
 * Each held-out participant is one observation: logit P(win) = a + w · delta / (m (1 − m)), m the
 * training win rate of the scored population, so w = 1 is a calibrated term. With two columns,
 * the curve of all champions and the champion's own shrunk deviation get one weight each: the
 * `k` to keep is the one whose deviation weight is ~1. Read-only (one read-only transaction,
 * SELECTs only, hash joins like the view's refresh).
 *   docker compose build api && docker compose run --rm api bun run apps/api/scripts/calibrate-mastery.ts
 *   DATABASE_URL=postgres://… bun run apps/api/scripts/calibrate-mastery.ts [--patch 16.23]
 *     [--test-share 0.2] [--no-previous]
 * Without `--patch`, uses the latest patch with matches.
 */
import { createDb } from '@pick-league/db';
import type { Position } from '@pick-league/shared';
import { fitLogistic } from '../src/engine/calibration.ts';
import { ENGINE_CONFIG } from '../src/engine/config.ts';
import { buildMasteryModel, type MasteryModel } from '../src/engine/mastery.ts';
import type { MasteryRow } from '../src/engine/types.ts';

const USAGE = 'usage: calibrate-mastery.ts [--patch <id>] [--test-share <0–1>] [--no-previous]';
const K_GRID = [100, 250, 500, 1000, 2000, 4000, 8000, 16000, Number.POSITIVE_INFINITY];
const M = ENGINE_CONFIG.mastery;

let patch: string | null = null;
let testShare = 0.2;
let previous = true;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const value = args[i + 1];
  const n = Number(value);
  if (args[i] === '--patch' && value) {
    patch = value;
    i++;
  } else if (args[i] === '--test-share' && value && n > 0 && n < 1) {
    testShare = n;
    i++;
  } else if (args[i] === '--no-previous') {
    previous = false;
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

type Source = 'pre' | 'all';
interface Group {
  test: boolean;
  pre: boolean;
  position: Position;
  championId: number;
  bucket: number;
  games: number;
  wins: number;
}

const db = createDb(url, { max: 1 });
let groups: Group[] = [];
let used: { patch: string; patches: string[]; cutoff: Date } | null = null;
try {
  used = await db.begin('read only', async (tx) => {
    // Like the view's refresh (STATS_REFRESH_ORDER): hash joins, no parallel workers.
    await tx.unsafe('SET LOCAL enable_nestloop = off');
    await tx.unsafe('SET LOCAL max_parallel_workers_per_gather = 0');
    // Patches with matches, newest first (by their latest match: '16.10' sorts before '16.9').
    const recent = await tx<{ patch: string }[]>`
      SELECT patch FROM matches GROUP BY patch ORDER BY max(started_at) DESC`;
    const chosen = patch ?? recent[0]?.patch;
    if (!chosen) return null;
    const index = recent.findIndex((r) => r.patch === chosen);
    const prev = previous && index >= 0 ? recent[index + 1]?.patch : undefined;
    const patches = prev ? [chosen, prev] : [chosen];
    const [cut] = await tx<{ cutoff: Date | null }[]>`
      SELECT percentile_disc(${1 - testShare}::float8) WITHIN GROUP (ORDER BY started_at) AS cutoff
      FROM matches WHERE patch = ${chosen} AND NOT is_remake`;
    if (!cut?.cutoff) return null;
    const rows = await tx<
      {
        test: boolean;
        pre: boolean;
        position: Position;
        champion_id: number;
        bucket: number;
        games: number;
        wins: number;
      }[]
    >`
      SELECT m.started_at >= ${cut.cutoff} AS test, cm.last_played_at < m.started_at AS pre,
             p.position, p.champion_id,
             width_bucket(cm.points, ${tx.array([...M.bucketEdges])}::int[])::int AS bucket,
             count(*)::int AS games, count(*) FILTER (WHERE p.win)::int AS wins
      FROM participants p
      JOIN matches m ON m.id = p.match_id
      JOIN champion_masteries cm ON cm.puuid = p.puuid AND cm.champion_id = p.champion_id
      WHERE m.patch IN ${tx(patches)} AND NOT m.is_remake AND p.position IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5`;
    groups = rows.map((r) => ({
      test: r.test,
      pre: r.pre,
      position: r.position,
      championId: r.champion_id,
      bucket: r.bucket,
      games: r.games,
      wins: r.wins,
    }));
    return { patch: chosen, patches, cutoff: cut.cutoff };
  });
} finally {
  await db.end();
}
if (!used) {
  console.error('no patch with matches');
  process.exit(1);
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}`;
const sum = (gs: readonly Group[], f: (g: Group) => number) => gs.reduce((s, g) => s + f(g), 0);
const of = (source: Source, test: boolean | null) =>
  groups.filter((g) => (source === 'all' || g.pre) && (test === null || g.test === test));
const asRows = (gs: readonly Group[]): MasteryRow[] =>
  gs.map((g) => ({ ...g, patch: used?.patch ?? '' }));
const BUCKETS = M.bucketEdges.length + 1;
const bucketName = (b: number) => {
  const e: readonly number[] = M.bucketEdges;
  const k = (x: number | undefined) => `${(x ?? 0) / 1000}k`;
  return b === 0
    ? `<${k(e[0])}`
    : b >= e.length
      ? `${k(e[e.length - 1])}+`
      : `${k(e[b - 1])}–${k(e[b])}`;
};

console.log(
  `patches ${used.patches.join(' + ')}; held out: matches of ${used.patch} from ${used.cutoff.toISOString()}`,
);
for (const [source, test] of [
  ['all', false],
  ['all', true],
  ['pre', false],
  ['pre', true],
] as const) {
  const gs = of(source, test);
  const games = sum(gs, (g) => g.games);
  console.log(
    `${source} ${test ? 'test ' : 'train'}: ${games} slots, win rate ${((100 * sum(gs, (g) => g.wins)) / games).toFixed(2)} %`,
  );
}

// The curve of all champions (points vs each champion's own average), every match.
console.log('\ncurve of all champions, every match (games):');
console.log(`  bucket      ${'all'.padStart(16)}  ${'pre'.padStart(16)}`);
const curves = (['all', 'pre'] as const).map((source) => {
  const gs = of(source, null);
  const model = buildMasteryModel(asRows(gs));
  return Array.from({ length: BUCKETS }, (_, b) => model.effect(-1, 'TOP', b));
});
for (let b = 0; b < BUCKETS; b++) {
  const cell = (e: { delta: number; allGames: number } | undefined) =>
    `${pct(e?.delta ?? 0)} (${e?.allGames ?? 0})`.padStart(16);
  console.log(`  ${bucketName(b).padEnd(10)}  ${cell(curves[0]?.[b])}  ${cell(curves[1]?.[b])}`);
}

/** Held-out observations of `gs` (one per game) with each column of `columns`. */
function design(
  gs: readonly Group[],
  columns: readonly ((g: Group) => number)[],
): { x: Float64Array; y: Uint8Array; p: number } {
  const n = sum(gs, (g) => g.games);
  const p = columns.length + 1;
  const x = new Float64Array(n * p);
  const y = new Uint8Array(n);
  let r = 0;
  for (const g of gs) {
    const values = columns.map((f) => f(g));
    for (let i = 0; i < g.games; i++, r++) {
      x[r * p] = 1;
      for (let j = 0; j < values.length; j++) x[r * p + j + 1] = values[j] ?? 0;
      y[r] = i < g.wins ? 1 : 0;
    }
  }
  return { x, y, p };
}

/** Mean log-loss of the fitted coefficients. */
function logLoss(x: Float64Array, y: Uint8Array, p: number, beta: readonly number[]): number {
  let s = 0;
  for (let r = 0; r < y.length; r++) {
    let z = 0;
    for (let j = 0; j < p; j++) z += (beta[j] ?? 0) * (x[r * p + j] ?? 0);
    const q = 1 / (1 + Math.exp(-z));
    s -= y[r] ? Math.log(q) : Math.log(1 - q);
  }
  return s / y.length;
}

const scored = of('pre', true);
console.log(`\nscored: ${sum(scored, (g) => g.games)} pre-game slots of the held-out matches`);
for (const source of ['all', 'pre'] as const) {
  const train = of(source, false);
  const m = sum(train, (g) => g.wins) / sum(train, (g) => g.games);
  const scale = 1 / (m * (1 - m));
  const base = design(scored, []);
  const nullFit = fitLogistic(base.x, base.p, base.y);
  const nullLoss = logLoss(base.x, base.y, base.p, nullFit.coefficients);
  console.log(
    `\nstatistics from ${source === 'all' ? 'every mastery row (before 0035)' : 'pre-game rows (0035)'}; intercept only: log-loss ${(1e4 * nullLoss).toFixed(2)}e-4`,
  );
  console.log('        k   weight ±   SE   curve  ±   SE   own dev ± SE    log-loss gain');
  for (const k of K_GRID) {
    const model: MasteryModel = buildMasteryModel(asRows(train), k);
    const curve = (g: Group) => model.effect(-1, g.position, g.bucket).delta * scale;
    const delta = (g: Group) => model.effect(g.championId, g.position, g.bucket).delta * scale;
    const one = design(scored, [delta]);
    const fit1 = fitLogistic(one.x, one.p, one.y);
    const gain = nullLoss - logLoss(one.x, one.y, one.p, fit1.coefficients);
    const f = (v: number | undefined) => (v ?? 0).toFixed(2).padStart(6);
    const se = (v: number | undefined) => (v ?? 0).toFixed(2);
    // k = Infinity: no deviation column (the delta is the curve).
    let split = '                             ';
    if (Number.isFinite(k)) {
      const two = design(scored, [curve, (g) => delta(g) - curve(g)]);
      const fit2 = fitLogistic(two.x, two.p, two.y);
      split = `${f(fit2.coefficients[1])} ± ${se(fit2.standardErrors[1])}  ${f(fit2.coefficients[2])} ± ${se(fit2.standardErrors[2])}`;
    }
    console.log(
      `${String(k).padStart(9)}   ${f(fit1.coefficients[1])} ± ${se(fit1.standardErrors[1])}  ${split}   ${(1e4 * gain).toFixed(2)}e-4`,
    );
  }
}
console.log(`\nENGINE_CONFIG.mastery: weight ${M.weight}, shrinkK ${M.shrinkK}`);
