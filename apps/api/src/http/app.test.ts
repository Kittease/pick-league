/** Request limits enforced before any database access (no Postgres needed). */
import { describe, expect, test } from 'bun:test';
import type { Db } from '@pick-league/db';
import {
  type ApiErrorResponse,
  MAX_AVAILABLE_CHAMPION_IDS,
  MAX_REQUEST_BODY_BYTES,
} from '@pick-league/shared';
import { silentLogger } from '../logger.ts';
import { createApp } from './app.ts';
import { TtlCache } from './cache.ts';

/** Any query fails: these requests must be refused before reaching the database. */
const db = new Proxy({} as Db, {
  get: () => {
    throw new Error('the database must not be used');
  },
});
const app = createApp({ db, cache: new TtlCache(60_000), limiter: null, log: silentLogger });

const errorCode = async (res: Response) => ((await res.json()) as ApiErrorResponse).error.code;

describe('request limits', () => {
  const big = JSON.stringify({ role: 'UTILITY', pad: 'x'.repeat(MAX_REQUEST_BODY_BYTES) });

  test('POST bodies over the limit get 413 PAYLOAD_TOO_LARGE', async () => {
    for (const path of ['/recommendations/picks', '/recommendations/build']) {
      const res = await app.request(path, {
        method: 'POST',
        body: big,
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(413);
      expect(await errorCode(res)).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  test('a streamed body without Content-Length is cut at the limit too', async () => {
    const bytes = new TextEncoder().encode(big);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.slice(i, i + 8192));
        controller.close();
      },
    });
    const res = await app.request('/recommendations/picks', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('PAYLOAD_TOO_LARGE');
  });

  test('POST /live/players is validated before any database access', async () => {
    const player = (n: number) => ({
      puuid: `fake-live-puuid-${n}`,
      championId: 412,
      position: null,
      team: 'ally',
    });
    for (const body of [
      { platform: 'EUW1', players: [] },
      { platform: 'EUW1', players: Array.from({ length: 11 }, (_, i) => player(i)) },
      { platform: 'EUW1', players: [player(1), player(1)] },
      { platform: 'OC1', players: [player(1)] },
      'not json',
    ]) {
      const res = await app.request('/live/players', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('BAD_REQUEST');
    }
    const tooBig = await app.request('/live/players', {
      method: 'POST',
      body: big,
      headers: { 'content-type': 'application/json' },
    });
    expect(tooBig.status).toBe(413);
  });

  test('availableChampionIds is capped', async () => {
    const ids = Array.from({ length: MAX_AVAILABLE_CHAMPION_IDS + 1 }, (_, i) => i + 1);
    const res = await app.request('/recommendations/picks', {
      method: 'POST',
      body: JSON.stringify({ role: 'UTILITY', availableChampionIds: ids }),
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.stringify({ availableChampionIds: ids }).length).toBeLessThan(
      MAX_REQUEST_BODY_BYTES,
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('BAD_REQUEST');
  });
});
