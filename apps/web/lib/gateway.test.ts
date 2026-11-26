import { describe, expect, test } from 'bun:test';
import { MAX_REQUEST_BODY_BYTES } from '@pick-league/shared';
import { errorBody, gatewayAnswer, gatewayRoute, readCapped } from './gateway.ts';

const seg = (path: string) => path.split('/').filter(Boolean);

describe('gatewayRoute', () => {
  test('allows the public GET routes with their query', () => {
    expect(gatewayRoute('GET', seg('health'), '')).toEqual({
      method: 'GET',
      path: '/health',
      maxAge: 60,
    });
    expect(gatewayRoute('GET', seg('patches'), '')?.path).toBe('/patches');
    expect(gatewayRoute('GET', seg('stats/status'), '')?.path).toBe('/stats/status');
    expect(gatewayRoute('GET', seg('tierlist'), '?role=MIDDLE&platform=KR')).toEqual({
      method: 'GET',
      path: '/tierlist?role=MIDDLE&platform=KR',
      maxAge: 600,
    });
    expect(
      gatewayRoute('GET', seg('tierlist/champion'), '?role=UTILITY&championId=111')?.path,
    ).toBe('/tierlist/champion?role=UTILITY&championId=111');
  });

  test('allows the patch changes and patch notes with their query', () => {
    expect(gatewayRoute('GET', seg('patch-changes/index'), '')).toEqual({
      method: 'GET',
      path: '/patch-changes/index',
      maxAge: 600,
    });
    expect(gatewayRoute('GET', seg('patch-changes'), '?patch=16.23')?.path).toBe(
      '/patch-changes?patch=16.23',
    );
    expect(gatewayRoute('GET', seg('patch-notes'), '?patch=16.23&build=16.23.8418428')?.path).toBe(
      '/patch-notes?patch=16.23&build=16.23.8418428',
    );
    expect(gatewayRoute('POST', seg('patch-notes'), '')).toBeNull();
  });

  test('allows static data of the latest patch or a patch id only', () => {
    expect(gatewayRoute('GET', seg('static/latest'), '')?.path).toBe('/static/latest');
    expect(gatewayRoute('GET', seg('static/16.22'), '')?.maxAge).toBe(21600);
    expect(gatewayRoute('GET', seg('static/abc'), '')).toBeNull();
    expect(gatewayRoute('GET', seg('static'), '')).toBeNull();
    expect(gatewayRoute('GET', ['static', '16.22', 'x'], '')).toBeNull();
  });

  test('allows the recommendation POSTs without their query', () => {
    expect(gatewayRoute('POST', seg('recommendations/picks'), '?x=1')).toEqual({
      method: 'POST',
      path: '/recommendations/picks',
      maxAge: null,
    });
    expect(gatewayRoute('POST', seg('recommendations/build'), '')?.path).toBe(
      '/recommendations/build',
    );
    expect(gatewayRoute('POST', seg('recommendations/draft'), '')?.path).toBe(
      '/recommendations/draft',
    );
  });

  test('rejects other paths and wrong methods', () => {
    expect(gatewayRoute('GET', [], '')).toBeNull();
    expect(gatewayRoute('GET', seg('admin'), '')).toBeNull();
    expect(gatewayRoute('GET', seg('recommendations/picks'), '')).toBeNull();
    expect(gatewayRoute('POST', seg('health'), '')).toBeNull();
    expect(gatewayRoute('DELETE', seg('patches'), '')).toBeNull();
    expect(gatewayRoute('GET', ['..', 'health'], '')).toBeNull();
    expect(gatewayRoute('GET', ['health%2F..'], '')).toBeNull();
    expect(gatewayRoute('GET', ['stats/status'], '')).toBeNull();
  });
});

describe('gatewayAnswer', () => {
  const get = { method: 'GET', path: '/tierlist?role=MIDDLE', maxAge: 600 } as const;
  const post = { method: 'POST', path: '/recommendations/picks', maxAge: null } as const;

  test('passes a successful GET through with a CDN lifetime', () => {
    const a = gatewayAnswer(get, { status: 200, retryAfter: null, text: '{"role":"MIDDLE"}' });
    expect(a.status).toBe(200);
    expect(a.body).toBe('{"role":"MIDDLE"}');
    expect(a.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=600, stale-while-revalidate=600',
    );
  });

  test('never caches POSTs or errors, and keeps Retry-After', () => {
    expect(gatewayAnswer(post, { status: 200, retryAfter: null, text: '{}' }).headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const limited = gatewayAnswer(get, {
      status: 429,
      retryAfter: '12',
      text: errorBody('RATE_LIMITED', 'slow down'),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers['Retry-After']).toBe('12');
    expect(limited.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(limited.body)).toEqual({
      error: { code: 'RATE_LIMITED', message: 'slow down' },
    });
  });

  test('turns a non-JSON upstream answer into a 502', () => {
    const a = gatewayAnswer(get, { status: 200, retryAfter: null, text: '<html>' });
    expect(a.status).toBe(502);
    expect(JSON.parse(a.body).error.code).toBe('INTERNAL');
  });
});

describe('readCapped', () => {
  const stream = (...parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });

  test('reads a body under the cap', async () => {
    const r = await readCapped(stream('{"a":', '1}'), MAX_REQUEST_BODY_BYTES);
    expect(r.ok && new TextDecoder().decode(r.bytes)).toBe('{"a":1}');
  });

  test('gives up past the cap', async () => {
    expect((await readCapped(stream('x'.repeat(40), 'y'.repeat(40)), 64)).ok).toBe(false);
  });

  test('an absent body is empty', async () => {
    const r = await readCapped(null, 64);
    expect(r.ok && r.bytes.byteLength).toBe(0);
  });
});
