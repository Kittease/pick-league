/** Per-key (client IP) token bucket. */
export interface RateLimitOptions {
  /** Bucket size: requests allowed in a burst. */
  burst: number;
  /** Sustained rate: tokens added per minute. */
  perMinute: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until one token is available (when refused). */
  retryAfterS: number;
  remaining: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly now: () => number;
  private readonly perMs: number;

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now;
    this.perMs = options.perMinute / 60_000;
  }

  take(key: string): RateLimitDecision {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.options.burst, updatedAt: now };
    b.tokens = Math.min(this.options.burst, b.tokens + (now - b.updatedAt) * this.perMs);
    b.updatedAt = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterS: 0, remaining: Math.floor(b.tokens) };
    }
    const retryAfterS = this.perMs > 0 ? Math.ceil((1 - b.tokens) / this.perMs / 1000) : 60;
    return { allowed: false, retryAfterS: Math.max(1, retryAfterS), remaining: 0 };
  }

  /** Drops full buckets (idle clients) to bound memory. */
  sweep(): void {
    const now = this.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.updatedAt) * this.perMs >= this.options.burst)
        this.buckets.delete(key);
    }
  }
}
