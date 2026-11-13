/** JSON-lines logger on stdout. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = console.log,
): Logger {
  const at =
    (l: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (ORDER[l] < ORDER[level]) return;
      write(JSON.stringify({ ts: new Date().toISOString(), level: l, app: 'api', msg, ...fields }));
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = createLogger('error', () => {});
