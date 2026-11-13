/** Time source + timers, injectable so the rate limiter and retries can be tested with a fake clock. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Resolves after `ms`, or rejects with an AbortError when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function sleepWith(clock: Pick<Clock, 'setTimer'>, ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      cancel();
      reject(abortError());
    };
    const cancel = clock.setTimer(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const t = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(t);
  },
  sleep(ms, signal) {
    return sleepWith(systemClock, ms, signal);
  },
};

/** Manual clock for tests: time only moves with `advance`. */
export class FakeClock implements Clock {
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  constructor(private time = 1_700_000_000_000) {}

  now(): number {
    return this.time;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.time + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleepWith(this, ms, signal);
  }

  /** Moves time forward, firing due timers in order and letting promise callbacks run between them. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await flushMicrotasks();
      const next = [...this.timers].sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next || next.at > target) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.time = Math.max(this.time, next.at);
      next.fn();
    }
    this.time = target;
    await flushMicrotasks();
  }

  pendingTimers(): number {
    return this.timers.length;
  }
}

export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
