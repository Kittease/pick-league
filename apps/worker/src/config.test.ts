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

describe('loadConfig: DIAMOND_MAX_TRACKED', () => {
  test.each([undefined, '', '0'])('none with %p', (value) => {
    expect(loadConfig({ ...VALID, DIAMOND_MAX_TRACKED: value }).diamondMaxTracked).toBe(0);
  });

  test('a number of players', () => {
    expect(loadConfig({ ...VALID, DIAMOND_MAX_TRACKED: ' 5000 ' }).diamondMaxTracked).toBe(5000);
  });

  test.each(['-1', '2.5', 'all', '1e4'])('%p is a configuration error', (value) => {
    const load = () => loadConfig({ ...VALID, DIAMOND_MAX_TRACKED: value });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/DIAMOND_MAX_TRACKED/);
  });
});

describe('loadConfig: UNTRACKED_MASTER_LISTING_START_HOUR', () => {
  test.each([undefined, '', '4'])('4 in the morning with %p', (value) => {
    const config = loadConfig({ ...VALID, UNTRACKED_MASTER_LISTING_START_HOUR: value });
    expect(config.untrackedMasterListingStartHour).toBe(4);
  });

  test.each([
    ['0', 0],
    [' 3 ', 3],
    ['23', 23],
  ])('%p is that hour', (value, hour) => {
    const config = loadConfig({ ...VALID, UNTRACKED_MASTER_LISTING_START_HOUR: value });
    expect(config.untrackedMasterListingStartHour).toBe(hour);
  });

  test.each(['24', '-1', '3.5', '4am', '100'])('%p is a configuration error', (value) => {
    const load = () => loadConfig({ ...VALID, UNTRACKED_MASTER_LISTING_START_HOUR: value });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/UNTRACKED_MASTER_LISTING_START_HOUR/);
  });
});
