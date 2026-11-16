import { describe, expect, test } from 'bun:test';
import { clientIpFrom } from './client-ip.ts';

const h = (init: Record<string, string>) => ({
  get: (name: string) => init[name.toLowerCase()] ?? null,
});

describe('clientIpFrom', () => {
  test('takes the first X-Forwarded-For address', () => {
    expect(clientIpFrom(h({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }))).toBe(
      '203.0.113.7',
    );
  });

  test('accepts IPv6', () => {
    expect(clientIpFrom(h({ 'x-forwarded-for': ' 2001:db8::1 ' }))).toBe('2001:db8::1');
  });

  test('falls back to X-Real-IP', () => {
    expect(clientIpFrom(h({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientIpFrom(h({ 'x-forwarded-for': 'garbage', 'x-real-ip': '198.51.100.4' }))).toBe(
      '198.51.100.4',
    );
  });

  test('null without a usable address', () => {
    expect(clientIpFrom(h({}))).toBeNull();
    expect(clientIpFrom(h({ 'x-forwarded-for': 'unknown', 'x-real-ip': '' }))).toBeNull();
    expect(clientIpFrom(h({ 'x-forwarded-for': '1.2.3.4\r\nX-Evil: 1' }))).toBeNull();
  });
});
