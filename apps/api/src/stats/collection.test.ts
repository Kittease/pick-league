import { describe, expect, test } from 'bun:test';
import { collectionState, publicError } from './collection.ts';

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

describe('publicError', () => {
  /** Shaped like a Riot player id (78 URL-safe characters), obviously fake. */
  const FAKE_ID = `FAKE-PLAYER-ID_${'x'.repeat(63)}`;

  test('null and ordinary messages pass through', () => {
    expect(FAKE_ID).toHaveLength(78);
    expect(publicError(null)).toBeNull();
    expect(publicError('transient: 503 from match-v5')).toBe('transient: 503 from match-v5');
    // Match ids, endpoint names and what the worker already redacted stay readable.
    const worker =
      'match: VN2_1633474238 Riot API match-v5.match network error (/lol/match/v5/matches/VN2_1633474238)';
    expect(publicError(worker)).toBe(worker);
    const redacted =
      'enrichment: Riot API league-v4.entries-by-puuid failed with HTTP 503 (/lol/league/v4/entries/by-puuid/<puuid>)';
    expect(publicError(redacted)).toBe(redacted);
  });

  test('a player id in a Riot path is replaced', () => {
    const served = publicError(
      `listing: Riot API match-v5.ids-by-puuid network error (/lol/match/v5/matches/by-puuid/${FAKE_ID}/ids?queue=420&count=100)`,
    );
    expect(served).toBe(
      'listing: Riot API match-v5.ids-by-puuid network error (/lol/match/v5/matches/by-puuid/<redacted>/ids?queue=420&count=100)',
    );
  });

  test('an id cut short after by-puuid/ and an id outside a path are replaced too', () => {
    expect(
      publicError(`enrichment: failed (/riot/account/v1/accounts/by-puuid/${FAKE_ID.slice(0, 20)}`),
    ).toBe('enrichment: failed (/riot/account/v1/accounts/by-puuid/<redacted>');
    expect(publicError(`daily: no account for ${FAKE_ID}`)).toBe(
      'daily: no account for <redacted>',
    );
  });

  test('long messages are cut to 300 characters, ids removed first', () => {
    const long = publicError(`match: ${'failed again, '.repeat(40)}`);
    expect(long).toHaveLength(300);
    expect(long?.endsWith('…')).toBe(true);
    // An id straddling the limit must not survive as a fragment.
    const straddling = publicError(
      `match: ${'error '.repeat(42)}by-puuid/${FAKE_ID} then more text`,
    );
    expect(straddling).toContain('by-puuid/<redacted>');
    expect(straddling).not.toContain('FAKE');
    expect(straddling).not.toContain('xxxx');
  });
});
