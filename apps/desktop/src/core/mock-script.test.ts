import { describe, expect, test } from 'bun:test';
import { availableChampionIds, deriveChampSelect, localLockedChampion } from './champ-select.ts';
import {
  MOCK_LOCKED_CHAMPION,
  MOCK_TIMINGS,
  mockMastery,
  mockOwnedChampions,
  mockSessionAt,
} from './mock-script.ts';

describe('mock champion select script', () => {
  test('starts in planning with the local player hovering Nami as support', () => {
    const s = mockSessionAt(1_500);
    expect(s?.timer.phase).toBe('PLANNING');
    const view = s && deriveChampSelect(s, 'MIDDLE');
    expect(view?.role).toBe('UTILITY');
    expect(view?.me).toMatchObject({ championId: MOCK_LOCKED_CHAMPION, hovering: true });
    expect(view?.bans).toEqual({ ally: [], enemy: [] });
  });

  test('bans are revealed after the ban phase', () => {
    const s = mockSessionAt(MOCK_TIMINGS.bansDone);
    const view = s && deriveChampSelect(s, 'UTILITY');
    expect(view?.bans.ally).toHaveLength(5);
    expect(view?.bans.enemy).toHaveLength(5);
  });

  test('enemy hovers are never exposed, only locked enemy picks', () => {
    const start = MOCK_TIMINGS.pickStart(1); // first enemy pick (cell 5) hovering
    const hovering = mockSessionAt(start + 100);
    expect(hovering && deriveChampSelect(hovering, 'UTILITY').enemies[0]?.championId).toBeNull();
    const locked = mockSessionAt(start + 2_600);
    expect(locked && deriveChampSelect(locked, 'UTILITY').enemies[0]).toMatchObject({
      championId: 122,
      locked: true,
    });
  });

  test('the local player locks in exactly at localLock, before the last enemy pick', () => {
    const before = mockSessionAt(MOCK_TIMINGS.localLock - 1);
    const after = mockSessionAt(MOCK_TIMINGS.localLock);
    expect(before && localLockedChampion(before)).toBeNull();
    expect(after && localLockedChampion(after)).toBe(MOCK_LOCKED_CHAMPION);
    const view = after && deriveChampSelect(after, 'UTILITY');
    expect(view?.enemies[4]?.championId).toBeNull();
  });

  test('ends with every pick locked in finalization, then no session', () => {
    const s = mockSessionAt(MOCK_TIMINGS.finalization);
    expect(s?.timer.phase).toBe('FINALIZATION');
    const view = s && deriveChampSelect(s, 'UTILITY');
    expect([...(view?.allies ?? []), ...(view?.enemies ?? [])].every((p) => p.locked)).toBe(true);
    expect(mockSessionAt(MOCK_TIMINGS.end)).toBeNull();
  });

  test('fake account owns Nami and has mastery on it', () => {
    expect(availableChampionIds(mockOwnedChampions())).toContain(MOCK_LOCKED_CHAMPION);
    expect(
      mockMastery().find((m) => m.championId === MOCK_LOCKED_CHAMPION)?.championLevel,
    ).toBeGreaterThan(0);
  });
});
