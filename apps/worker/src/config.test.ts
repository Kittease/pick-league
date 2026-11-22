import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from './config.ts';

const VALID = {
  RIOT_API_KEY: 'RGAPI-00000000-0000-0000-0000-000000000000',
  DATABASE_URL: 'postgres://x',
};

describe('loadConfig: COLLECT_PREVIOUS_PATCH', () => {
  test('off when unset', () => {
    expect(loadConfig(VALID).collectPreviousPatch).toBe(false);
  });

  test.each(['true', '1', ' TRUE '])('on with %p', (value) => {
    expect(loadConfig({ ...VALID, COLLECT_PREVIOUS_PATCH: value }).collectPreviousPatch).toBe(true);
  });

  test.each(['false', '0', ''])('off with %p', (value) => {
    expect(loadConfig({ ...VALID, COLLECT_PREVIOUS_PATCH: value }).collectPreviousPatch).toBe(
      false,
    );
  });

  test('anything else is a configuration error', () => {
    const load = () => loadConfig({ ...VALID, COLLECT_PREVIOUS_PATCH: 'yes' });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/COLLECT_PREVIOUS_PATCH/);
  });
});

describe('loadConfig: LISTING_SKIP', () => {
  test.each([undefined, '', 'off', ' OFF '])('off with %p', (value) => {
    expect(loadConfig({ ...VALID, LISTING_SKIP: value }).listingSkip).toBe('off');
  });

  test.each([
    ['shadow', 'shadow'],
    [' Shadow ', 'shadow'],
    ['on', 'on'],
  ] as const)('%p is %p', (value, mode) => {
    expect(loadConfig({ ...VALID, LISTING_SKIP: value }).listingSkip).toBe(mode);
  });

  test('anything else is a configuration error', () => {
    const load = () => loadConfig({ ...VALID, LISTING_SKIP: 'true' });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/LISTING_SKIP/);
  });
});
