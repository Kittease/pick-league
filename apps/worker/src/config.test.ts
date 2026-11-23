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

describe('loadConfig: OUTSIDE_MASTER_CHECKS_PER_HOUR', () => {
  test.each([undefined, '', '1500'])('1,500 an hour with %p', (value) => {
    const config = loadConfig({ ...VALID, OUTSIDE_MASTER_CHECKS_PER_HOUR: value });
    expect(config.outsideMasterChecksPerHour).toBe(1500);
  });

  test.each([
    ['0', 0],
    [' 800 ', 800],
    ['3000', 3000],
  ])('%p is that many', (value, checks) => {
    const config = loadConfig({ ...VALID, OUTSIDE_MASTER_CHECKS_PER_HOUR: value });
    expect(config.outsideMasterChecksPerHour).toBe(checks);
  });

  test.each(['3001', '-1', '2.5', 'all', '10000'])('%p is a configuration error', (value) => {
    const load = () => loadConfig({ ...VALID, OUTSIDE_MASTER_CHECKS_PER_HOUR: value });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/OUTSIDE_MASTER_CHECKS_PER_HOUR/);
  });
});

describe('loadConfig: MASTERY_REFRESH_DAYS', () => {
  test.each([undefined, '', '3'])('3 days with %p', (value) => {
    expect(loadConfig({ ...VALID, MASTERY_REFRESH_DAYS: value }).masteryRefreshDays).toBe(3);
  });

  test('a number of days', () => {
    expect(loadConfig({ ...VALID, MASTERY_REFRESH_DAYS: ' 1 ' }).masteryRefreshDays).toBe(1);
    expect(loadConfig({ ...VALID, MASTERY_REFRESH_DAYS: '7' }).masteryRefreshDays).toBe(7);
  });

  test.each(['0', '-1', '1.5', 'daily', '1000'])('%p is a configuration error', (value) => {
    const load = () => loadConfig({ ...VALID, MASTERY_REFRESH_DAYS: value });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/MASTERY_REFRESH_DAYS/);
  });
});

describe('loadConfig: the daily pass is gone', () => {
  test('its start hour, still set in an old .env, is ignored', () => {
    const config = loadConfig({ ...VALID, UNTRACKED_MASTER_LISTING_START_HOUR: 'whatever' });
    expect(config).not.toHaveProperty('untrackedMasterListingStartHour');
  });
});
