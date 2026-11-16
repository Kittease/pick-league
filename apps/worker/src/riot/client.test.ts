import { describe, expect, test } from 'bun:test';
import { FakeClock, flushMicrotasks } from '../clock.ts';
import { createLogger } from '../log.ts';
import {
  PRIORITY,
  RiotAuthError,
  RiotClient,
  RiotHttpError,
  RiotNetworkError,
  redactPuuid,
} from './client.ts';

const KEY = 'RGAPI-00000000-0000-0000-0000-000000000000';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(handler: Handler, opts: { appLimit?: string } = {}) {
  const clock = new FakeClock();
  const calls: { url: string; init: RequestInit; at: number }[] = [];
  const client = new RiotClient({
    apiKey: KEY,
    clock,
    limiter: {
      marginMs: 0,
      appLimits: opts.appLimit ? [{ limit: 1, windowMs: 1000 }] : undefined,
    },
    fetch: async (url, init) => {
      calls.push({ url, init, at: clock.now() });
      return handler(url, init);
    },
  });
  return { clock, calls, client };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('RiotClient', () => {
  test('routes each endpoint to the right host and sends the key in a header only', async () => {
    const { client, calls } = setup(() => json({ entries: [] }));
    await client.getLeague('EUW1', 'CHALLENGER');
    await client.getMatchIds('EUW1', 'fake-puuid', { startTime: 1700000000 });
    await client.getAccount('VN2', 'fake-puuid', PRIORITY.DAILY_REFRESH);
    await client.getMatch('VN2', 'VN2_123');
    const urls = calls.map((c) => c.url);
    expect(urls[0]).toBe(
      'https://euw1.api.riotgames.com/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5',
    );
    expect(urls[1]).toStartWith(
      'https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/fake-puuid/ids?',
    );
    expect(urls[1]).toContain('queue=420');
    expect(urls[1]).toContain('type=ranked');
    expect(urls[1]).toContain('startTime=1700000000');
    expect(urls[2]).toStartWith('https://asia.api.riotgames.com/riot/account/v1/');
    expect(urls[3]).toStartWith('https://sea.api.riotgames.com/lol/match/v5/matches/VN2_123');
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      expect((c.init.headers as Record<string, string>)['X-Riot-Token']).toBe(KEY);
    }
    expect(client.requestsFor('EUW1')).toBe(2);
  });

  test('puuids never reach an error message or a log line', async () => {
    const puuid = 'fake-puuid/with+special=chars';
    const encoded = encodeURIComponent(puuid);
    const lines: string[] = [];
    const log = createLogger('debug', {}, (line) => lines.push(line));
    const errors: Error[] = [];
    const call = async (status: number | 'network', run: (c: RiotClient) => Promise<unknown>) => {
      const clock = new FakeClock();
      const client = new RiotClient({
        apiKey: KEY,
        clock,
        log,
        limiter: { marginMs: 0 },
        fetch: async (url) => {
          if (status === 'network') throw new TypeError(`Unable to connect: ${url}`);
          return new Response('', { status });
        },
      });
      const done = run(client).catch((e: Error) => errors.push(e));
      for (let i = 0; i < 10; i++) await clock.advance(10_000);
      await done;
    };
    await call(400, (c) => c.getMatchIds('EUW1', puuid, {}));
    await call(400, (c) => c.getAccount('EUW1', puuid, PRIORITY.DAILY_REFRESH));
    await call(503, (c) => c.getMasteries('EUW1', puuid, PRIORITY.DAILY_REFRESH));
    await call(403, (c) => c.getLeagueEntries('EUW1', puuid, PRIORITY.ENRICHMENT));
    await call('network', (c) => c.getAccount('EUW1', puuid, PRIORITY.DAILY_REFRESH));
    expect(errors).toHaveLength(5);
    expect(errors[0]).toBeInstanceOf(RiotHttpError);
    expect((errors[0] as RiotHttpError).path).toStartWith(
      '/lol/match/v5/matches/by-puuid/<puuid>/ids?',
    );
    expect(errors[0]?.message).toContain('by-puuid/<puuid>/ids');
    expect(errors[4]).toBeInstanceOf(RiotNetworkError);
    expect(errors[4]?.message).toContain('/riot/account/v1/accounts/by-puuid/<puuid>');
    expect(lines.length).toBeGreaterThan(0);
    for (const text of [
      ...errors.map((e) => `${e.message} ${(e as RiotHttpError).path}`),
      ...lines,
    ]) {
      expect(text).not.toContain(puuid);
      expect(text).not.toContain(encoded);
    }
  });

  test('redactPuuid removes the raw and the URL-encoded puuid', () => {
    const puuid = 'fake-puuid/with+special=chars';
    const encoded = encodeURIComponent(puuid);
    expect(redactPuuid(`HTTP 400 (/by-puuid/${encoded}) for ${puuid}`, puuid)).toBe(
      'HTTP 400 (/by-puuid/<puuid>) for <puuid>',
    );
    expect(redactPuuid('nothing to hide', puuid)).toBe('nothing to hide');
  });

  test('404 resolves to null', async () => {
    const { client } = setup(() => new Response('{}', { status: 404 }));
    expect(await client.getMatch('EUW1', 'EUW1_1')).toBeNull();
  });

  test('429 with Retry-After blocks the host, then retries', async () => {
    let n = 0;
    const { client, clock, calls } = setup(() =>
      n++ === 0
        ? new Response('', {
            status: 429,
            headers: { 'retry-after': '3', 'x-rate-limit-type': 'application' },
          })
        : json({ ok: true }),
    );
    let result: unknown;
    client.getMatch('EUW1', 'EUW1_1').then((r) => {
      result = r;
    });
    // Another request on the same host must also wait for the block.
    let other: unknown;
    client.getTimeline('EUW1', 'EUW1_1').then((r) => {
      other = r;
    });
    await flushMicrotasks(50);
    expect(calls).toHaveLength(2);
    await clock.advance(2999);
    expect(result).toBeUndefined();
    await clock.advance(1);
    await flushMicrotasks(50);
    expect(result).toEqual({ ok: true });
    expect(other).toEqual({ ok: true });
    expect(client.hostStats()[0]?.rateLimited).toBe(1);
  });

  test('429 without Retry-After (service limit) backs off exponentially', async () => {
    let n = 0;
    const { client, clock, calls } = setup(() =>
      n++ < 2 ? new Response('', { status: 429 }) : json([]),
    );
    let done = false;
    client.getMatch('EUW1', 'EUW1_1').then(() => {
      done = true;
    });
    await flushMicrotasks(50);
    expect(calls).toHaveLength(1);
    await clock.advance(1000);
    await flushMicrotasks(50);
    expect(calls).toHaveLength(2);
    await clock.advance(1999);
    expect(calls).toHaveLength(2);
    await clock.advance(1);
    await flushMicrotasks(50);
    expect(calls).toHaveLength(3);
    expect(done).toBe(true);
  });

  test('5xx is retried with backoff, then fails', async () => {
    const { client, clock, calls } = setup(() => new Response('', { status: 503 }));
    let error: unknown;
    client.getMatch('EUW1', 'EUW1_1').catch((e) => {
      error = e;
    });
    for (let i = 0; i < 10; i++) await clock.advance(10_000);
    expect(calls).toHaveLength(5);
    expect(error).toBeInstanceOf(RiotHttpError);
    expect((error as RiotHttpError).status).toBe(503);
  });

  test('network errors are retried, then fail as RiotNetworkError', async () => {
    const { client, clock, calls } = setup(() => {
      throw new TypeError('fetch failed');
    });
    let error: unknown;
    client.getMatch('EUW1', 'EUW1_1').catch((e) => {
      error = e;
    });
    for (let i = 0; i < 10; i++) await clock.advance(10_000);
    expect(calls).toHaveLength(5);
    expect(error).toBeInstanceOf(RiotNetworkError);
    expect((error as Error).message).toContain('fetch failed');
  });

  test('5xx then success', async () => {
    let n = 0;
    const { client, clock } = setup(() =>
      n++ === 0 ? new Response('', { status: 500 }) : json({ fine: 1 }),
    );
    let result: unknown;
    client.getMatch('EUW1', 'EUW1_1').then((r) => {
      result = r;
    });
    await clock.advance(1000);
    await flushMicrotasks(50);
    expect(result).toEqual({ fine: 1 });
  });

  test('403 is an auth error and is not retried', async () => {
    const { client, calls } = setup(() => new Response('', { status: 403 }));
    await expect(client.getMatch('EUW1', 'EUW1_1')).rejects.toBeInstanceOf(RiotAuthError);
    expect(calls).toHaveLength(1);
  });

  test('adapts to rate-limit headers', async () => {
    const { client, clock, calls } = setup(() =>
      json([], { 'x-app-rate-limit': '1:5', 'x-app-rate-limit-count': '1:5' }),
    );
    await client.getMasteries('EUW1', 'p', PRIORITY.ENRICHMENT);
    client.getMasteries('EUW1', 'p', PRIORITY.ENRICHMENT);
    await flushMicrotasks(50);
    expect(calls).toHaveLength(1);
    await clock.advance(5000);
    await flushMicrotasks(50);
    expect(calls).toHaveLength(2);
  });

  test('waiting requests go out by priority', async () => {
    const { client, clock, calls } = setup(() => json([]), { appLimit: '1:1' });
    await client.getMasteries('EUW1', 'first', PRIORITY.ENRICHMENT);
    client.getMasteries('EUW1', 'enrich', PRIORITY.ENRICHMENT);
    client.getLeagueEntries('EUW1', 'daily', PRIORITY.DAILY_REFRESH);
    client.getLeague('EUW1', 'GRANDMASTER');
    for (let i = 0; i < 4; i++) await clock.advance(1000);
    expect(calls.map((c) => c.url.split('/').slice(-1)[0])).toEqual([
      'first',
      'RANKED_SOLO_5x5',
      'daily',
      'enrich',
    ]);
  });
});
