/**
 * Disk guard: when the disk runs low, the oldest games of the previous patch make room for the
 * newest ones, instead of collecting less (docs/architecture.md, "Worker").
 *
 * Postgres does not give the space of deleted rows back to the filesystem: it reuses it for the
 * rows inserted next. So free disk space does not come back when matches are deleted, and "delete
 * until there is room again" would delete everything. Instead, once free space falls under
 * `minFreeBytes`, the number of stored matches is frozen where it is: every new match then takes
 * the place of the oldest match of the previous patch, and the files stop growing. If free space
 * keeps falling anyway (WAL, a refresh's temporary files, bloat) and is still under
 * `criticalFreeBytes` at two checks in a row, the frozen number is lowered by `shrinkRatio`. Once
 * free space is back over `releaseFreeBytes` (a new patch freed room inside the files, a vacuum,
 * a larger disk), the number may grow again.
 *
 * Only the previous patch is trimmed: the latest one is what the statistics are about. If nothing
 * of it is left and the disk is still short, the guard says so and deletes nothing.
 */
import { statfsSync } from 'node:fs';
import { countMatches, type Db, deleteOldestMatchesOfPatch } from '@pick-league/db';
import { errorMessage, type Logger } from './log.ts';

const GB = 2 ** 30;

export interface DiskGuardOptions {
  /** Under this, the stored matches stop growing (default 20 GB). */
  minFreeBytes: number;
  /** Under this at two checks in a row, the frozen number is lowered (default 10 GB). */
  criticalFreeBytes: number;
  /** Over this, the stored matches may grow again (default 30 GB). */
  releaseFreeBytes: number;
  /** How much the frozen number is lowered at a time (default 5 %). */
  shrinkRatio: number;
  intervalMs: number;
  /** Matches deleted per statement. */
  batchSize: number;
}

export const DEFAULT_DISK_GUARD_OPTIONS: DiskGuardOptions = {
  minFreeBytes: 20 * GB,
  criticalFreeBytes: 10 * GB,
  releaseFreeBytes: 30 * GB,
  shrinkRatio: 0.05,
  intervalMs: 10 * 60_000,
  batchSize: 1_000,
};

/** Free bytes of the filesystem holding `path` (in the worker's container: the host disk). */
export function freeDiskBytes(path = '/'): number {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}

export interface DiskGuardTick {
  freeBytes: number;
  /** Most matches kept while the disk is low (null: not low). */
  cap: number | null;
  deleted: number;
}

export class DiskGuard {
  private readonly opts: DiskGuardOptions;
  private cap: number | null = null;
  private criticalChecks = 0;

  constructor(
    private readonly db: Db,
    private readonly patches: { readonly previous: string | null },
    private readonly freeBytes: () => number,
    private readonly log?: Logger,
    options: Partial<DiskGuardOptions> = {},
  ) {
    this.opts = { ...DEFAULT_DISK_GUARD_OPTIONS, ...options };
  }

  /** One check: freezes, lowers or releases the number of stored matches, and trims to it. */
  async tick(): Promise<DiskGuardTick> {
    const free = this.freeBytes();
    const freeGb = Math.round((free / GB) * 10) / 10;
    if (this.cap === null) {
      if (free >= this.opts.minFreeBytes) return { freeBytes: free, cap: null, deleted: 0 };
      this.cap = await countMatches(this.db);
      this.criticalChecks = 0;
      this.log?.warn('disk low: the stored matches stop growing, the oldest make room', {
        freeGb,
        matches: this.cap,
      });
    } else if (free >= this.opts.releaseFreeBytes) {
      this.log?.info('disk space back: the stored matches may grow again', {
        freeGb,
        matches: this.cap,
      });
      this.cap = null;
      return { freeBytes: free, cap: null, deleted: 0 };
    }
    this.criticalChecks = free < this.opts.criticalFreeBytes ? this.criticalChecks + 1 : 0;
    if (this.criticalChecks >= 2) {
      const lowered = Math.floor(this.cap * (1 - this.opts.shrinkRatio));
      this.log?.warn('disk still short: fewer stored matches', {
        freeGb,
        from: this.cap,
        to: lowered,
      });
      this.cap = lowered;
      this.criticalChecks = 0;
    }
    const deleted = await this.trim(this.cap, freeGb);
    return { freeBytes: free, cap: this.cap, deleted };
  }

  private async trim(cap: number, freeGb: number): Promise<number> {
    let excess = (await countMatches(this.db)) - cap;
    if (excess <= 0) return 0;
    const patch = this.patches.previous;
    let deleted = 0;
    while (excess > 0 && patch !== null) {
      const n = await deleteOldestMatchesOfPatch(
        this.db,
        patch,
        Math.min(excess, this.opts.batchSize),
      );
      if (n === 0) break;
      deleted += n;
      excess -= n;
    }
    if (deleted > 0) {
      this.log?.info('oldest matches of the previous patch deleted for room', {
        patch,
        deleted,
        matches: cap,
        freeGb,
      });
    }
    if (excess > 0) {
      this.log?.error('disk low and nothing of the previous patch left to delete', {
        patch,
        excess,
        freeGb,
      });
    }
    return deleted;
  }

  /** Checks every `intervalMs` until `signal` aborts; a failed check is logged and retried. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        this.log?.error('disk guard check failed', { error: errorMessage(err) });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.intervalMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
