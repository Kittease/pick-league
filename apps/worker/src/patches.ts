/**
 * Patch maintenance: Data Dragon is the source of truth for which patches exist. At startup and
 * hourly (or sooner when a match from an unknown newer patch shows up), the 2 newest patches get
 * their static data ingested if missing, and older patches are deleted (cascading to matches).
 */
import {
  type Db,
  deleteOldPatches,
  listPatches,
  purgeOrphanPlayers,
  upsertPatchStaticData,
} from '@pick-league/db';
import { comparePatches, type DdragonClient, type PatchId } from '@pick-league/shared';
import { type Clock, isAbortError, systemClock } from './clock.ts';
import { errorMessage, type Logger, silentLogger } from './log.ts';

/**
 * Where a match's patch stands for collection: only the latest patch is fetched. The previous one
 * stays in the database (fetched while it was the latest) but is no longer collected.
 */
export type PatchVerdict = 'keep' | 'old' | 'too_new';

export const KEPT_PATCHES = 2;

export interface PatchTrackerOptions {
  clock?: Clock;
  log?: Logger;
  /** Regular check interval (default 1 h). */
  intervalMs?: number;
  /** Minimum delay between two early checks triggered by `requestRefresh` (default 10 min). */
  minRefreshGapMs?: number;
}

export class PatchTracker {
  /** Newest patch of Data Dragon (null until the first successful refresh). */
  latest: PatchId | null = null;
  /** The patch before it. */
  previous: PatchId | null = null;
  /** Bumped whenever the kept patches change. */
  generation = 0;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  /** The last cleanup failed: the next refresh comes sooner. */
  private cleanupFailed = false;
  /** Orphan players may exist (an old patch was deleted, or the process just started). */
  private orphanPurgePending = true;
  private running: Promise<void> | null = null;
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(
    private readonly db: Db,
    private readonly ddragon: Pick<DdragonClient, 'getLatestPatchVersions' | 'getStaticPatchData'>,
    private readonly options: PatchTrackerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? silentLogger;
  }

  get ready(): boolean {
    return this.latest !== null;
  }

  classify(patch: PatchId): PatchVerdict {
    if (this.latest === null) return 'too_new';
    const c = comparePatches(patch, this.latest);
    return c > 0 ? 'too_new' : c < 0 ? 'old' : 'keep';
  }

  /**
   * Checks Data Dragon, ingests missing patches, switches to the new latest patch, then deletes old
   * ones (a cleanup failure is logged, not thrown). Concurrent calls share one run.
   */
  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.doRefresh().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /** Asks for an early refresh (e.g. a match from a newer patch), at most every `minRefreshGapMs`. */
  requestRefresh(): void {
    const gap = this.options.minRefreshGapMs ?? 10 * 60_000;
    if (this.running || this.clock.now() - this.lastRefreshAt < gap) return;
    this.refresh().catch((err) =>
      this.log.error('patch refresh failed', { error: errorMessage(err) }),
    );
  }

  /** Refreshes now (retrying every minute until it works), then every `intervalMs` until aborted. */
  async run(signal: AbortSignal): Promise<void> {
    const interval = this.options.intervalMs ?? 3_600_000;
    while (!signal.aborted) {
      let wait = interval;
      try {
        await this.refresh();
        if (this.cleanupFailed) wait = Math.min(wait, 5 * 60_000);
      } catch (err) {
        this.log.error('patch refresh failed', { error: errorMessage(err) });
        wait = this.ready ? 5 * 60_000 : 60_000;
      }
      try {
        await this.clock.sleep(wait, signal);
      } catch (err) {
        if (isAbortError(err)) return;
        throw err;
      }
    }
  }

  private async doRefresh(): Promise<void> {
    this.lastRefreshAt = this.clock.now();
    const versions = await this.ddragon.getLatestPatchVersions(KEPT_PATCHES);
    if (versions.length === 0) throw new Error('Data Dragon returned no patch version');
    const stored = new Map((await listPatches(this.db)).map((p) => [p.id, p.ddragonVersion]));
    const ingested: PatchId[] = [];
    for (const v of versions) {
      if (stored.get(v.patch) === v.ddragonVersion) continue;
      const data = await this.ddragon.getStaticPatchData(v.ddragonVersion);
      await upsertPatchStaticData(this.db, data);
      ingested.push(v.patch);
      this.log.info('patch static data ingested', {
        patch: v.patch,
        ddragonVersion: v.ddragonVersion,
        champions: data.champions.length,
        items: data.items.length,
      });
    }
    // The new patch is usable as soon as its static data is in: cleanup must not hold it back.
    const latest = versions[0]?.patch ?? null;
    const previous = versions[1]?.patch ?? null;
    if (latest !== this.latest || previous !== this.previous) {
      this.latest = latest;
      this.previous = previous;
      this.generation++;
      this.log.info('kept patches', { latest, previous });
    }
    if (ingested.length === 0) this.log.debug('patches up to date', { latest, previous });
    this.cleanupFailed = !(await this.cleanup());
  }

  /**
   * Deletes patches older than the kept ones (with their matches), then the players left orphaned
   * (only after a deletion, and once at startup). Failures are logged and retried at the next
   * refresh (5 min later): returns false then.
   */
  private async cleanup(): Promise<boolean> {
    try {
      const res = await deleteOldPatches(this.db, KEPT_PATCHES);
      if (res.deletedPatches.length > 0) {
        this.orphanPurgePending = true;
        this.log.info('old patches deleted', { ...res });
      }
    } catch (err) {
      this.log.error('old patch cleanup failed, will retry', { error: errorMessage(err) });
      return false;
    }
    if (!this.orphanPurgePending) return true;
    try {
      const deletedPlayers = await purgeOrphanPlayers(this.db);
      this.orphanPurgePending = false;
      if (deletedPlayers > 0) this.log.info('orphan players deleted', { deletedPlayers });
      return true;
    } catch (err) {
      this.log.error('orphan player purge failed, will retry', { error: errorMessage(err) });
      return false;
    }
  }
}
