import { describe, expect, test } from 'bun:test';
import { encodeItemEvent } from './matches.ts';

describe('encodeItemEvent', () => {
  test('purchases and sales keep their item', () => {
    expect(encodeItemEvent({ type: 'PURCHASED', itemId: 3031, undoAfterItemId: null })).toEqual({
      type: 'P',
      itemId: 3031,
    });
    expect(encodeItemEvent({ type: 'SOLD', itemId: 1055, undoAfterItemId: null })).toEqual({
      type: 'S',
      itemId: 1055,
    });
  });

  test('an undo says what it takes back: a purchase (U) or a sale (u), with the item', () => {
    // Riot: beforeId = the item bought, afterId = 0.
    expect(encodeItemEvent({ type: 'UNDO', itemId: 2003, undoAfterItemId: 0 })).toEqual({
      type: 'U',
      itemId: 2003,
    });
    // Riot: beforeId = 0, afterId = the item given back.
    expect(encodeItemEvent({ type: 'UNDO', itemId: 0, undoAfterItemId: 1055 })).toEqual({
      type: 'u',
      itemId: 1055,
    });
  });

  test('an undo with neither or both ids is the undo of a purchase of its beforeId', () => {
    expect(encodeItemEvent({ type: 'UNDO', itemId: 0, undoAfterItemId: 0 })).toEqual({
      type: 'U',
      itemId: 0,
    });
    expect(encodeItemEvent({ type: 'UNDO', itemId: 0, undoAfterItemId: null })).toEqual({
      type: 'U',
      itemId: 0,
    });
    expect(encodeItemEvent({ type: 'UNDO', itemId: 3031, undoAfterItemId: 1055 })).toEqual({
      type: 'U',
      itemId: 3031,
    });
  });
});
