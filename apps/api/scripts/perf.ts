/**
 * Perf check: seeds synthetic matches into a dedicated database, refreshes the stats views and
 * times recommendation requests.
 *   DATABASE_URL_TEST=postgres://postgres:postgres@localhost:55432/pickleague_test \
 *   PERF_MATCHES=20000 bun run --filter @pick-league/api perf
 * Uses the database `pickleague_api_perf` (recreated) on the server of DATABASE_URL_TEST.
 */
import { createDb } from '@pick-league/db';
import { POSITIONS } from '@pick-league/shared';
import { createApp } from '../src/http/app.ts';
import { TtlCache } from '../src/http/cache.ts';
import { silentLogger } from '../src/logger.ts';
import { refreshStats } from '../src/stats/refresh.ts';
import { resetApiTestDb, seedSyntheticPatch, withDatabase } from '../src/testing/seed.ts';
import { SYNTH_CHAMPIONS } from '../src/testing/synthetic.ts';

const base = process.env.DATABASE_URL_TEST;
if (!base) {
  console.error('DATABASE_URL_TEST is not set');
  process.exit(1);
}
const url = withDatabase(base, 'pickleague_api_perf');
const total = Number(process.env.PERF_MATCHES ?? 20_000);

const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = performance.now();
  const r = await fn();
  console.log(`${label}: ${Math.round(performance.now() - t)} ms`);
  return r;
};

await resetApiTestDb(url);
const db = createDb(url, { max: 12 });
await time(`seed ${total} matches`, async () => {
  await seedSyntheticPatch(db, { patch: '15.21', count: Math.round(total * 0.25), seed: 1 }, 12);
  await seedSyntheticPatch(db, { patch: '15.22', count: Math.round(total * 0.75), seed: 2 }, 12);
});
const first = await time('first refresh (force)', () => refreshStats(db, { force: true }));
console.log('per view (ms):', first.views);
await time('second refresh (unchanged, skipped)', () => refreshStats(db));

const app = createApp({ db, cache: new TtlCache(0), limiter: null, log: silentLogger });
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const durations: number[] = [];
const measure = async (path: string, body: unknown) => {
  const t = performance.now();
  const res = await post(path, body);
  if (res.status !== 200) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  await res.json();
  durations.push(performance.now() - t);
};

const byRole = (role: string) => SYNTH_CHAMPIONS.filter((c) => c.role === role).map((c) => c.id);
for (let i = 0; i < 5; i++) {
  for (const role of POSITIONS) {
    const enemies = POSITIONS.map((r) => byRole(r)[(i + 1) % 6] as number);
    const allies = POSITIONS.filter((r) => r !== role).map((r) => ({
      championId: byRole(r)[i % 6] as number,
      role: r,
    }));
    await measure('/recommendations/picks', { role, allies, enemies, bans: [] });
    await measure('/recommendations/build', {
      championId: byRole(role)[i % 6],
      role,
      allies,
      enemies: enemies.map((championId) => ({ championId, role: null })),
    });
  }
}
durations.sort((a, b) => a - b);
const pct = (p: number) => Math.round(durations[Math.floor((durations.length - 1) * p)] ?? 0);
console.log(
  `${durations.length} uncached requests: p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${pct(1)} ms`,
);
await db.end();
