import { expect, test } from 'bun:test';
import { createCdragonClient, parseContentVersion } from './cdragon.ts';

test('parseContentVersion: the build is the version without its branch', () => {
  expect(parseContentVersion('16.23.8418428+branch.releases-16-23.content.release')).toEqual({
    version: '16.23.8418428+branch.releases-16-23.content.release',
    patch: '16.23',
    build: '16.23.8418428',
    buildNumber: 8418428,
  });
  expect(parseContentVersion('main')).toBeNull();
});

function fakeFetch(responses: (Response | Error)[]) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  };
  return { urls, fetch };
}

test('a missing folder is null; a server error or a network error is retried', async () => {
  const f = fakeFetch([
    new Response('', { status: 404 }),
    new Response('', { status: 503 }),
    new Error('reset'),
    Response.json({ version: '16.23.8418428+branch' }),
  ]);
  const client = createCdragonClient({ fetch: f.fetch, retryDelayMs: 0, baseUrl: 'http://cd' });
  expect(await client.contentVersion('16.24')).toBeNull();
  expect((await client.contentVersion('latest'))?.build).toBe('16.23.8418428');
  expect(f.urls).toEqual([
    'http://cd/16.24/content-metadata.json',
    'http://cd/latest/content-metadata.json',
    'http://cd/latest/content-metadata.json',
    'http://cd/latest/content-metadata.json',
  ]);
});

test('gives up after its tries; a client error is not retried', async () => {
  const f = fakeFetch([new Error('a'), new Error('b'), new Error('c')]);
  const client = createCdragonClient({ fetch: f.fetch, retryDelayMs: 0, baseUrl: 'http://cd' });
  await expect(client.championFile('16.23', 'ezreal')).rejects.toThrow('c');
  expect(f.urls[0]).toBe('http://cd/16.23/game/data/characters/ezreal/ezreal.bin.json');

  const g = fakeFetch([new Response('', { status: 403 })]);
  const other = createCdragonClient({ fetch: g.fetch, retryDelayMs: 0, baseUrl: 'http://cd' });
  await expect(other.itemsFile('16.23')).rejects.toThrow('403');
  expect(g.urls).toHaveLength(1);
});
