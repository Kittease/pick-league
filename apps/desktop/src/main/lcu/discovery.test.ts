import { describe, expect, test } from 'bun:test';
import { parseCommandLine, parseInstallDirectory, parseLockfile } from './discovery.ts';

const MAC_LINE =
  '/Applications/League of Legends.app/Contents/LoL/LeagueClient.app/Contents/LoL/LeagueClientUx --riotclient-auth-token=AAA --riotclient-app-port=50001 --app-port=54321 --remoting-auth-token=fake_Token-123 --install-directory=/Applications/League of Legends.app/Contents/LoL';

const WIN_LINE =
  '"C:/Riot Games/League of Legends/LeagueClientUx.exe" "--remoting-auth-token=fakeToken456" "--app-port=61234" "--install-directory=C:/Riot Games/League of Legends/"';

describe('parseCommandLine', () => {
  test('macOS/Linux ps output', () => {
    expect(parseCommandLine(MAC_LINE)).toEqual({ port: 54321, token: 'fake_Token-123' });
  });

  test('Windows quoted arguments', () => {
    expect(parseCommandLine(WIN_LINE)).toEqual({ port: 61234, token: 'fakeToken456' });
  });

  test('does not confuse --riotclient-app-port with --app-port', () => {
    expect(
      parseCommandLine('LeagueClientUx --riotclient-app-port=1 --remoting-auth-token=x'),
    ).toBeNull();
  });

  test('null without credentials', () => {
    expect(parseCommandLine('LeagueClientUx --headless')).toBeNull();
  });
});

describe('parseInstallDirectory', () => {
  test('quoted path with spaces', () => {
    expect(parseInstallDirectory(WIN_LINE)).toBe('C:/Riot Games/League of Legends/');
  });

  test('unquoted path with spaces from ps', () => {
    expect(parseInstallDirectory(MAC_LINE)).toBe(
      '/Applications/League of Legends.app/Contents/LoL',
    );
  });
});

describe('parseLockfile', () => {
  test('LeagueClient:pid:port:password:protocol', () => {
    expect(parseLockfile('LeagueClient:1234:54321:fakePassword:https\n')).toEqual({
      port: 54321,
      token: 'fakePassword',
    });
  });

  test('null on garbage', () => {
    expect(parseLockfile('nope')).toBeNull();
  });
});
