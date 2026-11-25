import { describe, expect, test } from 'bun:test';
import { createLcuApi, LcuHttpError, type LcuTransport } from './api.ts';

/** A client answering each GET path from `routes` (404 for the others). */
function client(routes: Record<string, unknown | Error>): LcuTransport {
  return async (method, path) => {
    const answer = routes[path];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new LcuHttpError(method, path, 404, '');
    return answer;
  };
}

const CHAT = '/lol-chat/v1/me';
const PACKET = '/lol-platform-config/v1/namespaces/LoginDataPacket/platformId';

describe('getPlatformId', () => {
  test("reads the chat's platform id, upper-cased", async () => {
    const api = createLcuApi(client({ [CHAT]: { platformId: 'euw1' }, [PACKET]: 'KR' }));
    expect(await api.getPlatformId()).toBe('EUW1');
  });

  test('falls back to the login packet, then to null', async () => {
    expect(await createLcuApi(client({ [PACKET]: 'NA1' })).getPlatformId()).toBe('NA1');
    expect(
      await createLcuApi(client({ [CHAT]: { platformId: '' }, [PACKET]: 'VN2' })).getPlatformId(),
    ).toBe('VN2');
    expect(await createLcuApi(client({})).getPlatformId()).toBeNull();
    expect(
      await createLcuApi(
        client({ [CHAT]: new Error('socket hang up'), [PACKET]: { unexpected: true } }),
      ).getPlatformId(),
    ).toBeNull();
  });
});
