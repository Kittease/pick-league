/**
 * Calibration check: re-measures the picks engine's shrinkage constants on the stored matches.
 * Statistics come from the matches of the patch started before a cutoff, the engine's components
 * are rebuilt on the later ones (the last 20 % by start time, `--test-share`) and a logistic fit
 * gives each one's weight for a grid of `k`: the `k` to keep is the one whose weight is ~1.
 * Predicting later matches is what the engine does in production; `--split hash` holds out
 * 1 match in `--test-every` (5) by a hash of its id instead, which flatters the engine (matches of
 * the same day and players on both sides: slope 0.98 on 16.22, against 0.92 replaying 16.23 day
 * by day). Read-only (one read-only transaction, SELECTs only).
 *   docker compose build api && docker compose run --rm api bun run apps/api/scripts/calibrate.ts --patch 16.22
 *   DATABASE_URL=postgres://… bun run apps/api/scripts/calibrate.ts [--patch 16.22]
 *     [--split time|hash] [--test-share 0.2] [--test-every 5]
 * Without `--patch`, uses the patch with the most matches.
 */
import { createDb } from '@pick-league/db';
import type { Position } from '@pick-league/shared';
import {
  type CalibrationKind,
  calibrate,
  DEFAULT_HOLD_OUT,
  type HoldOut,
  MatchCollector,
} from '../src/engine/calibration.ts';
import { ENGINE_CONFIG } from '../src/engine/config.ts';

const USAGE =
  'usage: calibrate.ts [--patch <id>] [--split time|hash] [--test-share <0–1>] [--test-every <n>]';
const K_GRID = [300, 600, 900, 1200, 1600, 2500, 4000, 6000, 10000];

let patch: string | null = null;
let split: HoldOut['by'] = DEFAULT_HOLD_OUT.by;
let testShare = DEFAULT_HOLD_OUT.by === 'time' ? DEFAULT_HOLD_OUT.testShare : 0.2;
let testEvery = 5;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const value = args[i + 1];
  const n = Number(value);
  if (args[i] === '--patch' && value) {
    patch = value;
    i++;
  } else if (args[i] === '--split' && (value === 'time' || value === 'hash')) {
    split = value;
    i++;
  } else if (args[i] === '--test-share' && value && n > 0 && n < 1) {
    testShare = n;
    i++;
  } else if (args[i] === '--test-every' && value && Number.isInteger(n) && n >= 2) {
    testEvery = n;
    i++;
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
const holdOut: HoldOut = split === 'time' ? { by: 'time', testShare } : { by: 'hash', testEvery };

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const K = ENGINE_CONFIG.picks.shrinkK;
const shrinkK: Record<CalibrationKind, number> = {
  base: K.base,
  lane: K.matchup,
  laneSecondary: K.laneSecondary,
  otherEnemy: K.otherEnemy,
  duo: K.duo,
  otherAlly: K.otherAlly,
};

const db = createDb(url, { max: 1 });
try {
  const collector = new MatchCollector();
  const used = await db.begin('read only', async (tx) => {
    const chosen =
      patch ??
      (
        await tx<{ patch: string }[]>`
        SELECT patch FROM stats_patch_matches ORDER BY matches DESC, patch DESC LIMIT 1`
      )[0]?.patch;
    if (!chosen) return null;
    const rows = tx<
      {
        match_id: string;
        team_id: number;
        champion_id: number;
        position: Position | null;
        win: boolean;
        started_at: Date;
      }[]
    >`
      SELECT p.match_id, p.team_id, p.champion_id, p.position, p.win, m.started_at
      FROM stats_tierlist_participants p
      JOIN matches m ON m.id = p.match_id
      WHERE p.patch = ${chosen}`;
    for await (const batch of rows.cursor(20000)) {
      for (const r of batch) {
        collector.add(r.match_id, r.team_id, r.champion_id, r.position, r.win, r.started_at);
      }
    }
    return chosen;
  });
  if (!used) {
    console.error('no patch in stats_patch_matches');
    process.exit(1);
  }

  const matches = collector.finish(holdOut);
  console.log(`patch ${used}`);
  console.log(`matches kept ${matches.count}, dropped ${matches.dropped} (roles incomplete)`);
  console.log(
    holdOut.by === 'time'
      ? `held out: the last ${Math.round(100 * holdOut.testShare)} % by start time, from ${new Date(matches.cutoff ?? 0).toISOString()}`
      : `held out: 1 match in ${holdOut.testEvery} by a hash of its id (random split: flatters the engine)`,
  );
  if (matches.count === 0) process.exit(1);
  const result = calibrate(matches, {
    kGrid: K_GRID,
    config: {
      shrinkK,
      baseWeight: ENGINE_CONFIG.draft.baseWeight,
      pairWeight: ENGINE_CONFIG.draft.pairWeight,
    },
  });
  console.log(`train ${result.trainMatches}, test ${result.testMatches}`);
  for (const kind of result.kinds) {
    console.log(
      `\n${kind.kind}${kind.kind === 'base' ? '' : ' (next to base at its configured k)'}`,
    );
    console.log('       k   weight ±   SE');
    for (const row of kind.rows) {
      console.log(
        `${String(row.k).padStart(8)}   ${row.weight.toFixed(2).padStart(6)} ± ${row.standardError.toFixed(2)}`,
      );
    }
    console.log(`weight closest to 1 at k = ${kind.bestK} (ENGINE_CONFIG: ${shrinkK[kind.kind]})`);
  }
  console.log(
    `\nsummed score with ENGINE_CONFIG (draft weights ${ENGINE_CONFIG.draft.baseWeight} / ${ENGINE_CONFIG.draft.pairWeight}): slope ${result.summed.slope.toFixed(2)} ± ${result.summed.standardError.toFixed(2)} (1 = calibrated)`,
  );
  console.log(
    'Composition traits are not part of this check (picks.shrinkK.comp is not measured here).',
  );
} finally {
  await db.end();
}
