import type { Logger } from '@near-autopilot/core';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

/** Structured JSON-lines logger for the pipeline (stdout). */
export function createJsonLogger(
  minLevel: string,
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  const threshold = Math.max(0, LEVELS.indexOf(minLevel as Level));
  const emit =
    (level: Level) =>
    (message: string, fields?: Record<string, unknown>): void => {
      if (LEVELS.indexOf(level) < threshold || minLevel === 'silent') return;
      write(JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields }));
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
