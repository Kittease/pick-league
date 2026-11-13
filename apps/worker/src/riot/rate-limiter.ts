/**
 * Per-host Riot rate limiter.
 *
 * Riot enforces an application limit per routing host (e.g. 20 req / 1 s + 100 req / 120 s) and
 * method limits per endpoint on that host. This limiter keeps a log of request start times per
 * scope ("app" + one per method) and only lets a request through when every window of both
 * scopes has room. Limits start from conservative defaults and are replaced by the values Riot
 * sends in `X-App-Rate-Limit` / `X-Method-Rate-Limit`; the `-Count` headers are used to catch up
 * with usage we didn't see (e.g. a previous process). `429` responses block a scope until
 * `Retry-After`.
 *
 * Waiting requests are served by priority (highest first, FIFO within a priority).
 */
import { abortError, type Clock } from '../clock.ts';

export interface RateLimit {
  limit: number;
  windowMs: number;
}

/** App limit of a development/personal key, per host. */
export const DEFAULT_APP_LIMITS: readonly RateLimit[] = [
  { limit: 20, windowMs: 1_000 },
  { limit: 100, windowMs: 120_000 },
];

export interface HostLimiterOptions {
  appLimits?: readonly RateLimit[];
  /**
   * Added to every window: Riot counts a request when it receives it, we count when we send it,
   * so network jitter could otherwise squeeze one request too many into a window.
   */
  marginMs?: number;
}

/** "20:1,100:120" → [{20, 1000}, {100, 120000}]. Invalid parts are ignored. */
export function parseRateLimitHeader(value: string | null | undefined): RateLimit[] {
  if (!value) return [];
  const out: RateLimit[] = [];
  for (const part of value.split(',')) {
    const [a, b] = part.trim().split(':');
    const limit = Number(a);
    const seconds = Number(b);
    if (Number.isFinite(limit) && Number.isFinite(seconds) && limit > 0 && seconds > 0) {
      out.push({ limit, windowMs: seconds * 1000 });
    }
  }
  return out;
}

class Scope {
  limits: RateLimit[];
  /** Request start times, ascending. */
  stamps: number[] = [];
  blockedUntil = 0;

  constructor(limits: readonly RateLimit[]) {
    this.limits = [...limits];
  }

  private maxSpan(margin: number): number {
    return Math.max(0, ...this.limits.map((l) => l.windowMs)) + margin;
  }

  prune(now: number, margin: number): void {
    const cutoff = now - Math.max(this.maxSpan(margin), 60_000);
    let i = 0;
    while (i < this.stamps.length && (this.stamps[i] as number) <= cutoff) i++;
    if (i > 0) this.stamps.splice(0, i);
  }

  countSince(since: number): number {
    let n = 0;
    for (let i = this.stamps.length - 1; i >= 0 && (this.stamps[i] as number) > since; i--) n++;
    return n;
  }

  /** Milliseconds until one more request fits in every window (0 = now). */
  waitMs(now: number, margin: number): number {
    let wait = Math.max(0, this.blockedUntil - now);
    for (const l of this.limits) {
      const span = l.windowMs + margin;
      const inWindow = this.countSince(now - span);
      if (inWindow < l.limit) continue;
      // The (inWindow - limit + 1)-th oldest stamp in the window must expire first.
      const first = this.stamps.length - inWindow;
      const stamp = this.stamps[first + (inWindow - l.limit)] as number;
      wait = Math.max(wait, stamp + span - now);
    }
    return wait;
  }

  record(now: number, times = 1): void {
    for (let i = 0; i < times; i++) this.stamps.push(now);
  }
}

interface Waiter {
  method: string;
  priority: number;
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

export interface HostLimiterStats {
  host: string;
  granted: number;
  grantedLastMinute: number;
  waiting: number;
  appLimits: string;
}

export class HostLimiter {
  private readonly app: Scope;
  private readonly methods = new Map<string, Scope>();
  private readonly marginMs: number;
  private waiters: Waiter[] = [];
  private seq = 0;
  private cancelTimer: (() => void) | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private granted = 0;
  /** Grants of the last minute, for requests/min reporting. */
  private recent: number[] = [];

  constructor(
    readonly host: string,
    private readonly clock: Clock,
    options: HostLimiterOptions = {},
  ) {
    this.app = new Scope(options.appLimits ?? DEFAULT_APP_LIMITS);
    this.marginMs = options.marginMs ?? 500;
  }

  /**
   * Resolves when a request for `method` may be sent now (the slot is already counted).
   * Higher `priority` is served first. Rejects with an AbortError if `signal` aborts first.
   */
  acquire(method: string, priority: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        method,
        priority,
        seq: this.seq++,
        resolve,
        reject,
        signal,
        onAbort: undefined,
      };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(abortError());
          this.pump();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }

  /** Learns limits and server-side counts from a response's headers. */
  observe(method: string, headers: Headers): void {
    const now = this.clock.now();
    const appLimits = parseRateLimitHeader(headers.get('x-app-rate-limit'));
    if (appLimits.length > 0) this.app.limits = appLimits;
    this.syncCounts(this.app, parseRateLimitHeader(headers.get('x-app-rate-limit-count')), now);

    const methodLimits = parseRateLimitHeader(headers.get('x-method-rate-limit'));
    if (methodLimits.length > 0) this.methodScope(method).limits = methodLimits;
    const methodCounts = parseRateLimitHeader(headers.get('x-method-rate-limit-count'));
    if (methodCounts.length > 0) this.syncCounts(this.methodScope(method), methodCounts, now);
    this.pump();
  }

  /** Blocks the whole host (`method` = null) or one method until `untilMs`. */
  block(method: string | null, untilMs: number): void {
    const scope = method === null ? this.app : this.methodScope(method);
    scope.blockedUntil = Math.max(scope.blockedUntil, untilMs);
    this.pump();
  }

  stats(): HostLimiterStats {
    const now = this.clock.now();
    this.recent = this.recent.filter((t) => t > now - 60_000);
    return {
      host: this.host,
      granted: this.granted,
      grantedLastMinute: this.recent.length,
      waiting: this.waiters.length,
      appLimits: this.app.limits.map((l) => `${l.limit}:${l.windowMs / 1000}`).join(','),
    };
  }

  /** Rejects every waiting request (shutdown). */
  close(): void {
    const waiters = this.waiters;
    this.waiters = [];
    this.cancelTimer?.();
    this.cancelTimer = null;
    for (const w of waiters) {
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      w.reject(abortError());
    }
  }

  private methodScope(method: string): Scope {
    let scope = this.methods.get(method);
    if (!scope) {
      scope = new Scope([]);
      this.methods.set(method, scope);
    }
    return scope;
  }

  /** If Riot counted more requests in a window than we did, record the difference now. */
  private syncCounts(scope: Scope, counts: RateLimit[], now: number): void {
    for (const c of counts) {
      // In a count header, `limit` is the count.
      const local = scope.countSince(now - c.windowMs - this.marginMs);
      if (c.limit > local) scope.record(now, c.limit - local);
    }
  }

  private pump(): void {
    const now = this.clock.now();
    this.app.prune(now, this.marginMs);
    for (const s of this.methods.values()) s.prune(now, this.marginMs);

    this.waiters.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    let nextWait = Number.POSITIVE_INFINITY;
    const remaining: Waiter[] = [];
    let appBlocked = false;
    for (const w of this.waiters) {
      if (appBlocked) {
        remaining.push(w);
        continue;
      }
      const appWait = this.app.waitMs(now, this.marginMs);
      if (appWait > 0) {
        // The host budget is shared: nobody else may go before the best-priority waiter.
        appBlocked = true;
        nextWait = Math.min(nextWait, appWait);
        remaining.push(w);
        continue;
      }
      const scope = this.methodScope(w.method);
      const methodWait = scope.waitMs(now, this.marginMs);
      if (methodWait > 0) {
        // Only this method is exhausted: lower priorities on other methods may proceed.
        nextWait = Math.min(nextWait, methodWait);
        remaining.push(w);
        continue;
      }
      this.app.record(now);
      scope.record(now);
      this.granted++;
      this.recent.push(now);
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      w.resolve();
    }
    this.waiters = remaining;

    if (remaining.length === 0 || !Number.isFinite(nextWait)) {
      this.cancelTimer?.();
      this.cancelTimer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      return;
    }
    const at = now + nextWait;
    if (this.cancelTimer && this.timerAt <= at) return;
    this.cancelTimer?.();
    this.timerAt = at;
    this.cancelTimer = this.clock.setTimer(() => {
      this.cancelTimer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      this.pump();
    }, nextWait);
  }
}
