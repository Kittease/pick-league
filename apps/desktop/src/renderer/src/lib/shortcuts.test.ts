import { describe, expect, test } from 'bun:test';
import { escapeAction, isMacPlatform, type KeyInput, shortcutLabel, shortcutOf } from './shortcuts';

function key(k: string, mods: Partial<KeyInput> = {}): KeyInput {
  const code = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k;
  return {
    key: k,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...mods,
  };
}

describe('shortcutOf', () => {
  test('Ctrl+K and Ctrl+F focus the search on Windows / Linux', () => {
    expect(shortcutOf(key('k', { ctrlKey: true }), false)).toBe('focus-search');
    expect(shortcutOf(key('f', { ctrlKey: true }), false)).toBe('focus-search');
    expect(shortcutOf(key('K', { ctrlKey: true }), false)).toBe('focus-search');
    expect(shortcutOf(key('k', { metaKey: true }), false)).toBeNull();
  });

  test('Cmd+K and Cmd+F on macOS, where Ctrl+K is left to text fields', () => {
    expect(shortcutOf(key('k', { metaKey: true }), true)).toBe('focus-search');
    expect(shortcutOf(key('f', { metaKey: true }), true)).toBe('focus-search');
    expect(shortcutOf(key('k', { ctrlKey: true }), true)).toBeNull();
    expect(shortcutOf(key('k', { ctrlKey: true, metaKey: true }), true)).toBeNull();
  });

  test('extra modifiers, other letters and bare letters are ignored', () => {
    expect(shortcutOf(key('k', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    // AltGr on Windows reports Ctrl+Alt.
    expect(shortcutOf(key('k', { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(shortcutOf(key('k', { ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(shortcutOf(key('j', { ctrlKey: true }), false)).toBeNull();
    expect(shortcutOf(key('k'), false)).toBeNull();
    expect(shortcutOf(key('f'), true)).toBeNull();
  });

  test('a non-Latin layout uses the physical key', () => {
    expect(shortcutOf({ ...key('k', { ctrlKey: true }), key: 'л' }, false)).toBe('focus-search');
    expect(shortcutOf({ ...key('f', { ctrlKey: true }), key: 'а' }, false)).toBe('focus-search');
    expect(shortcutOf({ ...key('j', { ctrlKey: true }), key: 'о' }, false)).toBeNull();
  });

  test('Escape only without modifiers', () => {
    expect(shortcutOf(key('Escape'), false)).toBe('escape');
    expect(shortcutOf(key('Escape'), true)).toBe('escape');
    expect(shortcutOf(key('Escape', { shiftKey: true }), false)).toBeNull();
    expect(shortcutOf(key('Escape', { ctrlKey: true }), false)).toBeNull();
    expect(shortcutOf(key('Escape', { metaKey: true }), true)).toBeNull();
  });

  test('keys another handler took, or typed into an IME, are ignored', () => {
    expect(shortcutOf(key('Escape', { defaultPrevented: true }), false)).toBeNull();
    expect(shortcutOf(key('k', { ctrlKey: true, defaultPrevented: true }), false)).toBeNull();
    expect(shortcutOf(key('Escape', { isComposing: true }), false)).toBeNull();
  });
});

test('isMacPlatform and shortcutLabel', () => {
  expect(isMacPlatform('MacIntel')).toBe(true);
  expect(isMacPlatform('Win32')).toBe(false);
  expect(isMacPlatform('Linux x86_64')).toBe(false);
  expect(shortcutLabel('k', false)).toBe('Ctrl+K');
  expect(shortcutLabel('k', true)).toBe('⌘K');
});

describe('escapeAction', () => {
  test('from champion select: back to the tier list', () => {
    expect(escapeAction({ view: 'select', search: 'none', tierList: 'list' })).toBe(
      'show-tier-list',
    );
    expect(escapeAction({ view: 'select', search: 'none', tierList: 'details' })).toBe(
      'show-tier-list',
    );
  });

  test('in the search field: clear the text, then leave the field', () => {
    expect(escapeAction({ view: 'tierlist', search: 'filled', tierList: 'details' })).toBe(
      'clear-search',
    );
    expect(escapeAction({ view: 'tierlist', search: 'empty', tierList: 'details' })).toBe(
      'blur-search',
    );
  });

  test('then the build page, then the details panel, then nothing', () => {
    expect(escapeAction({ view: 'tierlist', search: 'none', tierList: 'build' })).toBe(
      'close-build',
    );
    expect(escapeAction({ view: 'tierlist', search: 'none', tierList: 'details' })).toBe(
      'close-details',
    );
    expect(escapeAction({ view: 'tierlist', search: 'none', tierList: 'list' })).toBeNull();
  });
});
