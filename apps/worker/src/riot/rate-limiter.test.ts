import { describe, expect, test } from 'bun:test';
import { FakeClock, flushMicrotasks } from '../clock.ts';
import { HostLimiter, parseRateLimitHeader } from './rate-limiter.ts';

function track(
  limiter: HostLimiter,
  method: string,
  priority: number,
  log: string[],
  label: string,
) {
  return limiter.acquire(method, priority).then(() => {
    log.push(label);
  });
}

describe('parseRateLimitHeader', () => {
  test('parses Riot limit headers', () => {
    expect(parseRateLimitHeader('20:1,100:120')).toEqual([
      { limit: 20, windowMs: 1000 },
      { limit: 100, windowMs: 120000 },
    ]);
    expect(parseRateLimitHeader('2000:10')).toEqual([{ limit: 2000, windowMs: 10000 }]);
    expect(parseRateLimitHeader('garbage, 3:x')).toEqual([]);
    expect(parseRateLimitHeader(null)).toEqual([]);
  });
});

describe('HostLimiter', () => {
  test('lets requests through up to the short window, then waits for it to expire', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, {
      appLimits: [{ limit: 3, windowMs: 1000 }],
      marginMs: 0,
    });
    const log: string[] = [];
    for (let i = 0; i < 5; i++) track(limiter, 'm', 1, log, `r${i}`);
    await flushMicrotasks();
    expect(log).toEqual(['r0', 'r1', 'r2']);
    await clock.advance(999);
    expect(log).toHaveLength(3);
    await clock.advance(1);
    expect(log).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  test('respects the long window too (sliding)', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, {
      appLimits: [
        { limit: 20, windowMs: 1_000 },
        { limit: 100, windowMs: 120_000 },
      ],
      marginMs: 0,
    });
    let granted = 0;
    for (let i = 0; i < 150; i++) limiter.acquire('m', 1).then(() => granted++);
    await flushMicrotasks();
    expect(granted).toBe(20);
    await clock.advance(10_000);
    expect(granted).toBe(100);
    await clock.advance(100_000);
    expect(granted).toBe(100);
    // The first 20 were sent at t=0: they expire at t=120s.
    await clock.advance(10_000);
    expect(granted).toBe(120);
  });

  test('serves the highest priority first, FIFO within a priority', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, {
      appLimits: [{ limit: 1, windowMs: 1000 }],
      marginMs: 0,
    });
    const log: string[] = [];
    track(limiter, 'm', 1, log, 'first');
    await flushMicrotasks();
    track(limiter, 'enrich', 1, log, 'low-a');
    track(limiter, 'match', 3, log, 'mid');
    track(limiter, 'enrich', 1, log, 'low-b');
    track(limiter, 'ladder', 5, log, 'high');
    for (let i = 0; i < 5; i++) await clock.advance(1000);
    expect(log).toEqual(['first', 'high', 'mid', 'low-a', 'low-b']);
  });

  test('a method limit blocks only that method; lower priorities on other methods proceed', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, {
      appLimits: [{ limit: 100, windowMs: 1000 }],
      marginMs: 0,
    });
    limiter.observe('slow', new Headers({ 'x-method-rate-limit': '1:10' }));
    const log: string[] = [];
    track(limiter, 'slow', 5, log, 'slow-1');
    track(limiter, 'slow', 5, log, 'slow-2');
    track(limiter, 'fast', 1, log, 'fast');
    await flushMicrotasks();
    expect(log).toEqual(['slow-1', 'fast']);
    await clock.advance(10_000);
    expect(log).toEqual(['slow-1', 'fast', 'slow-2']);
  });

  test('adapts to the app limit announced by Riot', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, { marginMs: 0 });
    limiter.observe('m', new Headers({ 'x-app-rate-limit': '2:1' }));
    let granted = 0;
    for (let i = 0; i < 5; i++) limiter.acquire('m', 1).then(() => granted++);
    await flushMicrotasks();
    expect(granted).toBe(2);
    expect(limiter.stats().appLimits).toBe('2:1');
  });

  test('catches up with usage Riot counted but we did not (count headers)', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, {
      appLimits: [{ limit: 10, windowMs: 10_000 }],
      marginMs: 0,
    });
    limiter.observe(
      'm',
      new Headers({ 'x-app-rate-limit': '10:10', 'x-app-rate-limit-count': '9:10' }),
    );
    let granted = 0;
    for (let i = 0; i < 3; i++) limiter.acquire('m', 1).then(() => granted++);
    await flushMicrotasks();
    expect(granted).toBe(1);
    await clock.advance(10_000);
    expect(granted).toBe(3);
  });

  test('warm-up: one request at a time until Riot reports its counts', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, {
      appLimits: [{ limit: 100, windowMs: 120_000 }],
      marginMs: 0,
      warmUpProbeMs: 20_000,
    });
    let granted = 0;
    for (let i = 0; i < 5; i++) limiter.acquire('m', 1).then(() => granted++);
    await flushMicrotasks();
    expect(granted).toBe(1);
    // A previous process used the whole budget: nothing more until it expires.
    limiter.observe(
      'm',
      new Headers({ 'x-app-rate-limit': '100:120', 'x-app-rate-limit-count': '100:120' }),
    );
    await flushMicrotasks();
    expect(granted).toBe(1);
    await clock.advance(120_000);
    expect(granted).toBe(5);
  });

  test('warm-up: sends another probe when the first one gets no response', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, { marginMs: 0, warmUpProbeMs: 20_000 });
    let granted = 0;
    for (let i = 0; i < 3; i++) limiter.acquire('m', 1).then(() => granted++);
    await flushMicrotasks();
    expect(granted).toBe(1);
    await clock.advance(19_999);
    expect(granted).toBe(1);
    await clock.advance(1);
    expect(granted).toBe(2);
    limiter.observe('m', new Headers({ 'x-app-rate-limit': '20:1,100:120' }));
    await flushMicrotasks();
    expect(granted).toBe(3);
  });

  test('block() holds every request until the given time (429 Retry-After)', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, { marginMs: 0 });
    limiter.block(null, clock.now() + 5000);
    let granted = 0;
    limiter.acquire('m', 1).then(() => granted++);
    await clock.advance(4999);
    expect(granted).toBe(0);
    await clock.advance(1);
    expect(granted).toBe(1);
  });

  test('aborted waiters leave the queue', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, {
      appLimits: [{ limit: 1, windowMs: 1000 }],
      marginMs: 0,
    });
    await limiter.acquire('m', 1);
    const ac = new AbortController();
    const p = limiter.acquire('m', 1, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('Aborted');
    expect(limiter.stats().waiting).toBe(0);
  });

  test('margin widens every window', async () => {
    const clock = new FakeClock();
    const limiter = new HostLimiter('h', clock, {
      appLimits: [{ limit: 1, windowMs: 1000 }],
      marginMs: 500,
    });
    let granted = 0;
    for (let i = 0; i < 2; i++) limiter.acquire('m', 1).then(() => granted++);
    await clock.advance(1000);
    expect(granted).toBe(1);
    await clock.advance(500);
    expect(granted).toBe(2);
  });
});
