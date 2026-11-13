/**
 * Finds the running League client: port + auth token from the `LeagueClientUx` process
 * command line, falling back to the `lockfile` in the install directory.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LcuCredentials {
  port: number;
  token: string;
}

/**
 * Value of `--name=value` in a command line. Handles `"--name=value"` and `--name="value"`
 * (Windows) and unquoted values containing spaces (`ps` output), which end at the next ` --`.
 */
function argValue(commandLine: string, name: string): string | null {
  const patterns = [
    new RegExp(`"--${name}=([^"]*)"`),
    new RegExp(`(?:^|\\s)--${name}="([^"]*)"`),
    new RegExp(`(?:^|\\s)--${name}=(.*?)(?=\\s+"?--|"|$)`),
  ];
  for (const re of patterns) {
    const m = re.exec(commandLine);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Credentials from a `LeagueClientUx` command line, or null if it lacks them. */
export function parseCommandLine(commandLine: string): LcuCredentials | null {
  const port = Number(argValue(commandLine, 'app-port'));
  const token = argValue(commandLine, 'remoting-auth-token');
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || !token) return null;
  return { port, token };
}

/** `--install-directory=` of the client, used to locate the lockfile. */
export function parseInstallDirectory(commandLine: string): string | null {
  return argValue(commandLine, 'install-directory');
}

/** Lockfile content `LeagueClient:<pid>:<port>:<password>:https`. */
export function parseLockfile(content: string): LcuCredentials | null {
  const parts = content.trim().split(':');
  if (parts.length < 5) return null;
  const port = Number(parts[2]);
  const token = parts[3];
  if (!Number.isInteger(port) || port <= 0 || !token) return null;
  return { port, token };
}

/** Command lines of running `LeagueClientUx` processes (empty when none / on failure). */
async function clientCommandLines(): Promise<string[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process -Filter "Name = \'LeagueClientUx.exe\'" | Select-Object -ExpandProperty CommandLine',
        ],
        { windowsHide: true, timeout: 10_000 },
      );
      return stdout.split(/\r?\n/).filter((l) => l.includes('--app-port'));
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-ww', '-o', 'args='], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .filter((l) => l.includes('LeagueClientUx') && l.includes('--app-port'));
  } catch {
    return [];
  }
}

/** Common install directories, per OS. */
export function lockfileCandidates(installDirs: readonly string[] = []): string[] {
  const dirs = [...installDirs];
  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E']) {
      dirs.push(`${drive}:\\Riot Games\\League of Legends`);
      dirs.push(`${drive}:\\Program Files\\Riot Games\\League of Legends`);
    }
  } else if (process.platform === 'darwin') {
    dirs.push('/Applications/League of Legends.app/Contents/LoL');
  } else {
    const home = homedir();
    dirs.push(join(home, 'Games/league-of-legends/drive_c/Riot Games/League of Legends'));
    dirs.push(join(home, '.wine/drive_c/Riot Games/League of Legends'));
  }
  return dirs.map((d) => join(d, 'lockfile'));
}

/** Credentials of the running client, or null when it isn't running. */
export async function discoverLcu(): Promise<LcuCredentials | null> {
  const lines = await clientCommandLines();
  for (const line of lines) {
    const creds = parseCommandLine(line);
    if (creds) return creds;
  }
  const installDirs = lines.flatMap((l) => parseInstallDirectory(l) ?? []);
  for (const path of lockfileCandidates(installDirs)) {
    try {
      const creds = parseLockfile(await readFile(path, 'utf8'));
      if (creds) return creds;
    } catch {
      // not there
    }
  }
  return null;
}
