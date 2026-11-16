import { describe, expect, test } from 'bun:test';
import { toApiResult, transportFailure } from './api-result.ts';

describe('toApiResult', () => {
  test('a 2xx JSON body is the data', () => {
    expect(toApiResult(200, '{"ok":true}')).toEqual({ ok: true, data: { ok: true } });
  });

  test('an error body gives its code and message', () => {
    expect(toApiResult(404, '{"error":{"code":"NOT_FOUND","message":"unknown champion"}}')).toEqual(
      { ok: false, code: 'NOT_FOUND', message: 'unknown champion' },
    );
  });

  test('an error without the usual body still says something', () => {
    expect(toApiResult(500, '{}')).toEqual({ ok: false, code: null, message: 'API error 500' });
  });

  test('non-JSON or empty answers are bad responses', () => {
    expect(toApiResult(200, '<html>')).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
    expect(toApiResult(200, '')).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
  });
});

describe('transportFailure', () => {
  test('tells a timeout from an unreachable server', () => {
    const timeout = new Error('t');
    timeout.name = 'TimeoutError';
    expect(transportFailure(timeout)).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(transportFailure(new TypeError('fetch failed'))).toMatchObject({
      ok: false,
      code: 'UNREACHABLE',
    });
  });
});
