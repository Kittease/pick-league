import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings.ts';

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
    expect(sanitizeSettings(old)).toEqual({ ...old, zoom: 1, flashKey: 'F' });
  });

  test('the removed demo mode field of older files is ignored', () => {
    const old = { ...DEFAULT_SETTINGS, autoApply: false, mockLcu: true };
    expect(sanitizeSettings(old)).toEqual({ ...DEFAULT_SETTINGS, autoApply: false });
  });
});
