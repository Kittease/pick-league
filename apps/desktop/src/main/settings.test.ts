import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSettingsSaver,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_API_URL,
  loadSettings,
  sanitizeSettings,
} from './settings.ts';

describe('settings file', () => {
  let dir = '';
  let path = '';
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pickleague-settings-'));
    path = join(dir, 'settings.json');
    logs.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('no file yet: the defaults, silently', async () => {
    expect(await loadSettings(path, log)).toEqual(DEFAULT_SETTINGS);
    expect(logs).toEqual([]);
  });

  test('a corrupt file is logged and kept aside before falling back to the defaults', async () => {
    const broken = '{"autoApply": false, "zoom": 1.2';
    await writeFile(path, broken);
    expect(await loadSettings(path, log)).toEqual(DEFAULT_SETTINGS);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('corrupt');
    expect(await readFile(`${path}.corrupt`, 'utf8')).toBe(broken);
  });

  test('saved settings load back', async () => {
    const save = createSettingsSaver(path);
    const settings = { ...DEFAULT_SETTINGS, autoApply: false, zoom: 1.5 };
    await save(settings);
    expect(await loadSettings(path, log)).toEqual(settings);
    expect(logs).toEqual([]);
  });

  test('the API goes through the public gateway by default', async () => {
    expect(DEFAULT_SETTINGS.apiUrl).toBe('https://pick-league.vercel.app/api/v1');
    expect(sanitizeSettings({}).apiUrl).toBe('https://pick-league.vercel.app/api/v1');
  });

  test('a file saved with the old local default moves to the gateway, other addresses stay', async () => {
    const save = createSettingsSaver(path);
    await save({ ...DEFAULT_SETTINGS, apiUrl: LEGACY_DEFAULT_API_URL, autoApply: false });
    expect(await loadSettings(path, log)).toEqual({ ...DEFAULT_SETTINGS, autoApply: false });
    await save({ ...DEFAULT_SETTINGS, apiUrl: 'http://example.test:3000' });
    expect((await loadSettings(path, log)).apiUrl).toBe('http://example.test:3000');
  });

  test('a burst of saves leaves the last settings on disk, as valid JSON', async () => {
    const save = createSettingsSaver(join(dir, 'nested', 'settings.json'));
    const zooms = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 1.75, 1.5];
    await Promise.all(zooms.map((zoom) => save({ ...DEFAULT_SETTINGS, zoom })));
    const text = await readFile(join(dir, 'nested', 'settings.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({ ...DEFAULT_SETTINGS, zoom: 1.5 });
    // No temporary file left behind.
    expect(await readdir(join(dir, 'nested'))).toEqual(['settings.json']);

    // A save after the burst is written too.
    await save({ ...DEFAULT_SETTINGS, zoom: 2 });
    expect(await loadSettings(join(dir, 'nested', 'settings.json'))).toMatchObject({ zoom: 2 });
  });
});

describe('sanitizeSettings', () => {
  test('Flash on F by default', () => {
    expect(DEFAULT_SETTINGS.flashKey).toBe('F');
    expect(sanitizeSettings({}).flashKey).toBe('F');
  });

  test('keeps a valid Flash key', () => {
    expect(sanitizeSettings({ flashKey: 'D' }).flashKey).toBe('D');
    expect(sanitizeSettings({ flashKey: 'F' }).flashKey).toBe('F');
  });

  test('an invalid Flash key falls back to the default', () => {
    expect(sanitizeSettings({ flashKey: 'd' }).flashKey).toBe('F');
    expect(sanitizeSettings({ flashKey: 4 }).flashKey).toBe('F');
  });

  test('a settings file saved before the Flash key existed still loads', () => {
    const old = {
      apiUrl: 'http://example.test:3000',
      autoApply: false,
      fallbackRole: 'TOP' as const,
      ownedOnly: false,
    };
    expect(sanitizeSettings(old)).toEqual({
      ...old,
      zoom: 1,
      flashKey: 'F',
      masteryPicks: true,
    });
  });

  test('picks are ranked for the mastery by default; a non-boolean falls back to it', () => {
    expect(DEFAULT_SETTINGS.masteryPicks).toBe(true);
    expect(sanitizeSettings({}).masteryPicks).toBe(true);
    expect(sanitizeSettings({ masteryPicks: 'no' }).masteryPicks).toBe(true);
    expect(sanitizeSettings({ masteryPicks: 0 }).masteryPicks).toBe(true);
    expect(sanitizeSettings({ masteryPicks: false }).masteryPicks).toBe(false);
  });

  test('the removed demo mode field of older files is ignored', () => {
    const old = { ...DEFAULT_SETTINGS, autoApply: false, mockLcu: true };
    expect(sanitizeSettings(old)).toEqual({ ...DEFAULT_SETTINGS, autoApply: false });
  });
});
