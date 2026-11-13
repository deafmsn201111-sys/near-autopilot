import { beforeEach } from 'vitest';

beforeEach(() => {
  (globalThis as Record<symbol, Map<string, unknown> | undefined>)[
    Symbol.for('near-autopilot.process-state')
  ]?.clear();
});
