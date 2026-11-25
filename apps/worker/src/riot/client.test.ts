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
    await client.getMasteries('VN2', 'fake-puuid', PRIORITY.DAILY_REFRESH);
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
    expect(urls[2]).toStartWith('https://vn2.api.riotgames.com/lol/champion-mastery/v4/');
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
    await call(400, (c) => c.getMasteries('EUW1', puuid, PRIORITY.DAILY_REFRESH));
    await call(503, (c) => c.getMasteries('EUW1', puuid, PRIORITY.DAILY_REFRESH));
    await call(403, (c) => c.getLeagueEntries('EUW1', puuid, PRIORITY.ENRICHMENT));
    await call('network', (c) => c.getMasteries('EUW1', puuid, PRIORITY.DAILY_REFRESH));
    expect(errors).toHaveLength(5);
    expect(errors[0]).toBeInstanceOf(RiotHttpError);
    expect((errors[0] as RiotHttpError).path).toStartWith(
      '/lol/match/v5/matches/by-puuid/<puuid>/ids?',
    );
    expect(errors[0]?.message).toContain('by-puuid/<puuid>/ids');
    expect(errors[4]).toBeInstanceOf(RiotNetworkError);
    expect(errors[4]?.message).toContain(
      '/lol/champion-mastery/v4/champion-masteries/by-puuid/<puuid>',
    );
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

  test('match host: the three tiers in order, listings before matches for the tracked players', async () => {
    const { client, clock, calls } = setup(() => json([]), { appLimit: '1:1' });
    await client.getMatch('EUW1', 'EUW1_1');
    // Asked for in the reverse order.
    client.getMatch('EUW1', 'EUW1_11', undefined, PRIORITY.DIAMOND_ONE_MATCH);
    client.getMatchIds('EUW1', 'diamond-one', { priority: PRIORITY.DIAMOND_ONE_MATCH_IDS });
    client.getMatch('EUW1', 'EUW1_9', undefined, PRIORITY.DIAMOND_MATCH);
    client.getMatchIds('EUW1', 'diamond', { priority: PRIORITY.DIAMOND_MATCH_IDS });
    client.getMatchIds('EUW1', 'outside', { priority: PRIORITY.EXTRA_MATCH_IDS });
    client.getMatch('EUW1', 'EUW1_5', undefined, PRIORITY.EXTRA_MATCH);
    client.getTimeline('EUW1', 'EUW1_2');
    client.getMatch('EUW1', 'EUW1_3');
    client.getMatchIds('EUW1', 'apex', {});
    for (let i = 0; i < 10; i++) await clock.advance(1000);
    expect(calls.map((c) => c.url.split('/matches/')[1]?.split('?')[0])).toEqual([
      'EUW1_1',
      'by-puuid/apex/ids',
      'EUW1_2/timeline',
      'EUW1_3',
      'EUW1_5',
      'by-puuid/outside/ids',
      // The Diamond players seen in a Master+ game, then the other Diamond I players.
      'by-puuid/diamond/ids',
      'EUW1_9',
      'by-puuid/diamond-one/ids',
      'EUW1_11',
    ]);
  });

  test('platform host: ladder lists, Diamond pages, mastery refresh, enrichment, checks of outside Masters', async () => {
    const { client, clock, calls } = setup(() => json([]), { appLimit: '1:1' });
    await client.getMasteries('EUW1', 'first', PRIORITY.ENRICHMENT);
    // Asked for in the reverse order.
    client.getLeagueEntries('EUW1', 'enrich-rank', PRIORITY.ENRICHMENT);
    client.getMasteries('EUW1', 'refresh', PRIORITY.DAILY_REFRESH);
    client.getLeagueEntries('EUW1', 'outside-check', PRIORITY.OUTSIDE_MASTER_CHECK);
    client.getDiamondEntries('EUW1', 'I', 1);
    client.getLeague('EUW1', 'MASTER');
    // A list and a page asked for later still go before what was already waiting.
    client.getLeague('EUW1', 'CHALLENGER');
    client.getDiamondEntries('EUW1', 'I', 2);
    for (let i = 0; i < 7; i++) await clock.advance(1000);
    expect(calls.map((c) => c.url.split('/').slice(-1)[0])).toEqual([
      'first',
      'RANKED_SOLO_5x5',
      'RANKED_SOLO_5x5',
      'I?page=1',
      'I?page=2',
      'refresh',
      'enrich-rank',
      'outside-check',
    ]);
  });

  test('a Diamond division page is asked on the platform host, by division and page', async () => {
    const { client, calls } = setup(() => json([]));
    expect(await client.getDiamondEntries('KR', 'II', 3)).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://kr.api.riotgames.com/lol/league/v4/entries/RANKED_SOLO_5x5/DIAMOND/II?page=3',
    ]);
  });

  test('a missing Diamond page is an error, not the end of the division', async () => {
    const { client } = setup(() => new Response('{}', { status: 404 }));
    await expect(client.getDiamondEntries('KR', 'I', 1)).rejects.toThrow(RiotHttpError);
  });

  test('Diamond pages go out after the apex ladders and before masteries and rank lookups', async () => {
    const { client, clock, calls } = setup(() => json([]), { appLimit: '1:1' });
    await client.getMasteries('EUW1', 'first', PRIORITY.ENRICHMENT);
    client.getMasteries('EUW1', 'enrich', PRIORITY.ENRICHMENT);
    client.getMasteries('EUW1', 'daily', PRIORITY.DAILY_REFRESH);
    client.getDiamondEntries('EUW1', 'I', 1);
    client.getLeague('EUW1', 'MASTER');
    for (let i = 0; i < 5; i++) await clock.advance(1000);
    expect(calls.map((c) => c.url.split('/').slice(-1)[0])).toEqual([
      'first',
      'RANKED_SOLO_5x5',
      'I?page=1',
      'daily',
      'enrich',
    ]);
  });
});
