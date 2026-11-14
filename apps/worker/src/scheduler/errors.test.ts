import { describe, expect, test } from 'bun:test';
import { abortError } from '../clock.ts';
import { MatchParseError } from '../parser/parse-match.ts';
import { RiotAuthError, RiotHttpError, RiotNetworkError } from '../riot/client.ts';
import { classifyError } from './errors.ts';

const withCode = (code: string, name = 'Error') =>
  Object.assign(new Error(`boom ${code}`), { code, name });

describe('classifyError', () => {
  test('Riot errors by status', () => {
    expect(classifyError(new RiotAuthError(403, 'm', '/p'))).toBe('auth');
    for (const s of [429, 500, 503, 408]) {
      expect(classifyError(new RiotHttpError(s, 'm', '/p'))).toBe('transient');
    }
    for (const s of [400, 404, 415]) {
      expect(classifyError(new RiotHttpError(s, 'm', '/p'))).toBe('deterministic');
    }
    expect(classifyError(new RiotNetworkError('m', '/p', new TypeError('fetch failed')))).toBe(
      'transient',
    );
  });

  test('parse errors, aborts, timeouts', () => {
    expect(classifyError(new MatchParseError('no participants'))).toBe('deterministic');
    expect(classifyError(abortError())).toBe('abort');
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(classifyError(timeout)).toBe('transient');
  });

  test('database connection and lock errors are transient, others unknown', () => {
    expect(classifyError(withCode('CONNECTION_CLOSED'))).toBe('transient');
    expect(classifyError(withCode('ECONNREFUSED'))).toBe('transient');
    expect(classifyError(withCode('57P01', 'PostgresError'))).toBe('transient');
    expect(classifyError(withCode('40P01', 'PostgresError'))).toBe('transient');
    expect(classifyError(withCode('08006', 'PostgresError'))).toBe('transient');
    expect(classifyError(withCode('23505', 'PostgresError'))).toBe('unknown');
    expect(classifyError(new TypeError('x is undefined'))).toBe('unknown');
    expect(classifyError('a string')).toBe('unknown');
  });
});
