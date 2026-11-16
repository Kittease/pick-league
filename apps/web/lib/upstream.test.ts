import { describe, expect, test } from 'bun:test';
import { upstreamConfig, upstreamHeaders } from './upstream.ts';

describe('upstreamConfig', () => {
  test('reads and normalises the environment', () => {
    expect(upstreamConfig({ API_URL: ' https://api.example.test/ ', API_TOKEN: 'secret' })).toEqual(
      { url: 'https://api.example.test', token: 'secret' },
    );
    expect(upstreamConfig({ API_URL: 'http://localhost:3000' })).toEqual({
      url: 'http://localhost:3000',
      token: null,
    });
    expect(upstreamConfig({})).toBeNull();
  });
});

describe('upstreamHeaders', () => {
  const config = { url: 'https://api.example.test', token: 'secret' };

  test('sends the token and the visitor IP', () => {
    expect(upstreamHeaders(config, '203.0.113.7', true)).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer secret',
      'X-Client-IP': '203.0.113.7',
      'Content-Type': 'application/json',
    });
  });

  test('omits what is unknown', () => {
    expect(upstreamHeaders({ ...config, token: null }, null, false)).toEqual({
      Accept: 'application/json',
    });
  });
});
