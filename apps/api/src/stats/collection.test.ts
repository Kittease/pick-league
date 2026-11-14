import { describe, expect, test } from 'bun:test';
import { collectionState } from './collection.ts';

const NOW = new Date('2026-11-14T12:00:00.000Z');
/** ISO time `minutes` before NOW. */
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe('collectionState', () => {
  test('unknown without any worker_status row', () => {
    expect(collectionState([], NOW)).toBe('unknown');
  });

  test('collecting while some platform heartbeated within 3 minutes', () => {
    expect(collectionState([{ heartbeatAt: ago(0.5), authRejectedSince: null }], NOW)).toBe(
      'collecting',
    );
    // A platform dropped from PLATFORMS keeps an old row: the live ones still count.
    expect(
      collectionState(
        [
          { heartbeatAt: ago(600), authRejectedSince: null },
          { heartbeatAt: ago(2.9), authRejectedSince: null },
        ],
        NOW,
      ),
    ).toBe('collecting');
  });

  test('stalled once every heartbeat is older than 3 minutes', () => {
    expect(
      collectionState(
        [
          { heartbeatAt: ago(3.1), authRejectedSince: null },
          { heartbeatAt: ago(10), authRejectedSince: null },
        ],
        NOW,
      ),
    ).toBe('stalled');
  });

  test('key_rejected as soon as one platform has its key rejected, even if stalled', () => {
    const live = { heartbeatAt: ago(0.2), authRejectedSince: null };
    expect(collectionState([live, { heartbeatAt: ago(0.1), authRejectedSince: ago(5) }], NOW)).toBe(
      'key_rejected',
    );
    expect(collectionState([{ heartbeatAt: ago(30), authRejectedSince: ago(40) }], NOW)).toBe(
      'key_rejected',
    );
  });
});
