import { describe, expect, test } from 'bun:test';
import { DEFAULT_ZOOM, nearestZoom, stepZoom, ZOOM_LEVELS, zoomShortcut } from './zoom.ts';

describe('nearestZoom', () => {
  test('keeps an offered level', () => {
    for (const z of ZOOM_LEVELS) expect(nearestZoom(z)).toBe(z);
  });

  test('snaps anything else to the closest level, within the range', () => {
    expect(nearestZoom(1.3)).toBe(1.25);
    expect(nearestZoom(0.1)).toBe(0.8);
    expect(nearestZoom(9)).toBe(2);
  });

  test('falls back to 100% for missing or invalid values', () => {
    expect(nearestZoom(undefined)).toBe(DEFAULT_ZOOM);
    expect(nearestZoom('2')).toBe(DEFAULT_ZOOM);
    expect(nearestZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
    expect(DEFAULT_ZOOM).toBe(1);
  });
});

describe('zoomShortcut', () => {
  const press = (key: string, code: string, mods: { meta?: boolean; alt?: boolean } = {}) => ({
    type: 'keyDown',
    key,
    code,
    control: !mods.meta,
    meta: mods.meta ?? false,
    alt: mods.alt ?? false,
  });

  test('Ctrl/Cmd + = or + zooms in, - zooms out (main row and numpad)', () => {
    expect(zoomShortcut(press('=', 'Equal'))).toBe('in');
    expect(zoomShortcut(press('+', 'Equal'))).toBe('in');
    expect(zoomShortcut(press('+', 'NumpadAdd'))).toBe('in');
    expect(zoomShortcut(press('=', 'Equal', { meta: true }))).toBe('in');
    expect(zoomShortcut(press('-', 'Minus'))).toBe('out');
    expect(zoomShortcut(press('-', 'NumpadSubtract'))).toBe('out');
  });

  test('Ctrl + 0 resets, by physical key (AZERTY types "à" there)', () => {
    expect(zoomShortcut(press('0', 'Digit0'))).toBe('reset');
    expect(zoomShortcut(press('à', 'Digit0'))).toBe('reset');
    expect(zoomShortcut(press('0', 'Numpad0'))).toBe('reset');
  });

  test('ignores other keys, key-ups, AltGr and keys without Ctrl/Cmd', () => {
    expect(zoomShortcut(press('r', 'KeyR'))).toBeNull();
    expect(zoomShortcut({ ...press('=', 'Equal'), type: 'keyUp' })).toBeNull();
    expect(zoomShortcut(press('=', 'Equal', { alt: true }))).toBeNull();
    expect(zoomShortcut({ ...press('=', 'Equal'), control: false })).toBeNull();
  });
});

describe('stepZoom', () => {
  test('moves to the next level up or down', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.25, -1)).toBe(1.1);
  });

  test('stays at the ends of the range', () => {
    const min = 0.8;
    const max = 2;
    expect(stepZoom(min, -1)).toBe(min);
    expect(stepZoom(max, 1)).toBe(max);
  });

  test('steps from the nearest level when the current one is off the list', () => {
    expect(stepZoom(1.3, 1)).toBe(1.5);
  });
});
