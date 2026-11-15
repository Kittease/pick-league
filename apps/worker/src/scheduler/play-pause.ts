/**
 * Collection pause while the user plays (docs/architecture.md, "Playing"): the desktop marks the
 * user busy (`client_activity`) from queue start to the end of the game. Meanwhile:
 * - no collection request goes to Riot, queued ones included (`RiotClient.holdBelow`): live
 *   lookups get the whole rate limit when the game starts;
 * - the collection loops claim no new work (no database load while the game runs).
 * Live lookups are not paused. One instance is shared by every platform.
 */
import { type Db, readPlayPause } from '@pick-league/db';
import { abortError, type Clock, isAbortError } from '../clock.ts';
import { errorMessage, type Logger } from '../log.ts';

export interface PlayPauseDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  /** Called on each change: true = hold collection requests. */
  onChange?(paused: boolean): void;
  /** How often `client_activity` is read (default 2 s). */
  pollMs?: number;
}

export class PlayPause {
  private pausedNow = false;
  private waiters: (() => void)[] = [];

  constructor(private readonly deps: PlayPauseDeps) {}

  get paused(): boolean {
    return this.pausedNow;
  }

  /** Reads the pause once and applies a change. A failed read keeps the current state. */
  async check(): Promise<boolean> {
    try {
      const pause = await readPlayPause(this.deps.db, new Date(this.deps.clock.now()));
      this.set(pause.paused, pause.phase);
    } catch (err) {
      this.deps.log.warn('play pause not read', { error: errorMessage(err) });
    }
    return this.pausedNow;
  }

  /** Resolves at once when not paused, else when the pause ends (rejects on abort). */
  async wait(signal: AbortSignal): Promise<void> {
    if (!this.pausedNow) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(abortError());
      };
      const done = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(done);
    });
  }

  /** Reads the pause every `pollMs` until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    const pollMs = this.deps.pollMs ?? 2_000;
    while (!signal.aborted) {
      await this.check();
      try {
        await this.deps.clock.sleep(pollMs, signal);
      } catch (err) {
        if (isAbortError(err)) break;
        throw err;
      }
    }
    this.set(false, null);
  }

  private set(paused: boolean, phase: string | null): void {
    if (paused === this.pausedNow) return;
    this.pausedNow = paused;
    if (paused) {
      this.deps.log.info('user playing: collection paused (live lookups only)', { phase });
    } else {
      this.deps.log.info('user done playing: collection resumed');
    }
    this.deps.onChange?.(paused);
    if (!paused) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
  }
}
