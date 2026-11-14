import { describe, expect, test } from 'bun:test';
import type { CollectionStatus, PlatformCollectionStatus } from '@pick-league/shared';
import { collectionWarning } from './collection';

const row = (over: Partial<PlatformCollectionStatus>): PlatformCollectionStatus => ({
  platform: 'EUW1',
  heartbeatAt: '2026-11-14T11:59:30.000Z',
  authRejectedSince: null,
  lastError: null,
  lastErrorAt: null,
  lastMatchStoredAt: '2026-11-14T11:58:00.000Z',
  ...over,
});

describe('collectionWarning', () => {
  test('nothing while collecting, when unknown, or from an API without the block', () => {
    expect(collectionWarning({ state: 'collecting', platforms: [row({})] })).toBeNull();
    expect(collectionWarning({ state: 'unknown', platforms: [] })).toBeNull();
    expect(collectionWarning(undefined)).toBeNull();
  });

  test('rejected key: since the first rejection, with the fix', () => {
    const collection: CollectionStatus = {
      state: 'key_rejected',
      platforms: [
        row({ platform: 'KR', authRejectedSince: '2026-11-14T09:00:00.000Z' }),
        row({ platform: 'EUW1' }),
        row({ platform: 'NA1', authRejectedSince: '2026-11-14T08:30:00.000Z' }),
      ],
    };
    expect(collectionWarning(collection)).toEqual({
      state: 'key_rejected',
      label: 'Riot key rejected',
      title: 'Riot rejected the API key — collection stopped.',
      fix: { text: 'Put a new key in .env, then run', command: 'docker compose up -d' },
      since: '2026-11-14T08:30:00.000Z',
    });
  });

  test('stalled worker: since the last heartbeat of any platform', () => {
    const w = collectionWarning({
      state: 'stalled',
      platforms: [
        row({ platform: 'KR', heartbeatAt: '2026-11-14T10:00:00.000Z' }),
        row({ platform: 'EUW1', heartbeatAt: '2026-11-14T10:05:00.000Z' }),
      ],
    });
    expect(w?.state).toBe('stalled');
    expect(w?.title).toBe('Collection stopped: the worker is not running.');
    expect(w?.since).toBe('2026-11-14T10:05:00.000Z');
  });

  test('since is null when no row says when it stopped', () => {
    expect(collectionWarning({ state: 'stalled', platforms: [] })?.since).toBeNull();
  });
});
