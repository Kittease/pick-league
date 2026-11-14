import { describe, expect, test } from 'bun:test';
import type { MatchDto } from '@pick-league/shared';
import matchFixture from '../parser/fixtures/match.json';
import { recentMatchOf, redactPuuid } from './live-lookup.ts';

const PUUID = 'fake-live/puuid+1';

function fixture(): MatchDto {
  const match = structuredClone(matchFixture) as unknown as MatchDto;
  const p = match.info.participants[3];
  if (p) p.puuid = PUUID;
  return match;
}

describe('recentMatchOf', () => {
  test("summarises the player's champion, position and result", () => {
    const match = fixture();
    const p = match.info.participants[3];
    const m = recentMatchOf(match, PUUID);
    expect(m).toEqual({
      matchId: match.metadata.matchId,
      championId: p?.championId as number,
      position: (p?.teamPosition || null) as never,
      win: p?.win as boolean,
      remake: false,
      endedAt: new Date(match.info.gameEndTimestamp as number).toISOString(),
    });
  });

  test('null when the player is not in the match; no position and remakes are kept as such', () => {
    const match = fixture();
    expect(recentMatchOf(match, 'fake-someone-else')).toBeNull();
    for (const p of match.info.participants) {
      p.teamPosition = '';
      p.gameEndedInEarlySurrender = true;
    }
    match.info.gameDuration = 200;
    expect(recentMatchOf(match, PUUID)).toMatchObject({ position: null, remake: true });
  });
});

describe('redactPuuid', () => {
  test('removes the raw and the URL-encoded puuid', () => {
    const encoded = encodeURIComponent(PUUID);
    expect(redactPuuid(`HTTP 400 (/by-puuid/${encoded}) for ${PUUID}`, PUUID)).toBe(
      'HTTP 400 (/by-puuid/<puuid>) for <puuid>',
    );
    expect(redactPuuid('nothing to hide', PUUID)).toBe('nothing to hide');
  });
});
