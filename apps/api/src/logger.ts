import type { Logger } from '@near-autopilot/core';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

/**
 * Index into LEVELS of the lowest level emitted for each LOG_LEVEL accepted by the config schema. `trace` logs
 * everything; `fatal` (no fatal method on the port) keeps only errors; `silent` nothing. Unknown values fall back
 * to `info` rather than to the most verbose level.
 */
const THRESHOLDS: Readonly<Record<string, number>> = {
  trace: 0,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 3,
  silent: LEVELS.length,
};

/** Structured JSON-lines logger for the pipeline (stdout). */
export function createJsonLogger(
  minLevel: string,
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  const threshold = THRESHOLDS[minLevel] ?? 1;
  const emit =
    (level: Level) =>
    (message: string, fields?: Record<string, unknown>): void => {
      if (LEVELS.indexOf(level) < threshold) return;
      write(JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields }));
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
