/** Structured JSON logs, one object per line on stdout. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createLogger(
  level: LogLevel = 'info',
  base: LogFields = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const min = LOG_LEVELS.indexOf(level);
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (LOG_LEVELS.indexOf(lvl) < min) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...base, ...fields }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, write),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
