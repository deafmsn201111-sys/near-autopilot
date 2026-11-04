import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '../src/logger';

const emitted = (level: string): string[] => {
  const lines: string[] = [];
  const log = createJsonLogger(level, (l) => lines.push(l));
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  return lines.map((l) => (JSON.parse(l) as { level: string }).level);
};

describe('createJsonLogger', () => {
  it('maps every LOG_LEVEL the config accepts to the right threshold', () => {
    expect(emitted('trace')).toEqual(['debug', 'info', 'warn', 'error']);
    expect(emitted('debug')).toEqual(['debug', 'info', 'warn', 'error']);
    expect(emitted('info')).toEqual(['info', 'warn', 'error']);
    expect(emitted('warn')).toEqual(['warn', 'error']);
    expect(emitted('error')).toEqual(['error']);
    expect(emitted('fatal')).toEqual(['error']);
    expect(emitted('silent')).toEqual([]);
  });

  it('falls back to info, not to the most verbose level, for unknown values', () => {
    expect(emitted('loud')).toEqual(['info', 'warn', 'error']);
  });
});
