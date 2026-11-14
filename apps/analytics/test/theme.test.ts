import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { THEME_COLOR, THEME_SCRIPT } from '../lib/theme';

function firstPaint(saved: string | null | Error) {
  const attrs = new Map<string, string>();
  const meta = new Map<string, string>();
  const document = {
    documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) },
    querySelector: () => ({ setAttribute: (k: string, v: string) => meta.set(k, v) }),
  };
  const localStorage = {
    getItem: () => {
      if (saved instanceof Error) throw saved;
      return saved;
    },
  };
  runInNewContext(THEME_SCRIPT, { document, localStorage });
  return { theme: attrs.get('data-theme'), chrome: meta.get('content') };
}

describe('theme before first paint', () => {
  it('starts dark on a first visit, whatever the OS prefers', () => {
    expect(firstPaint(null)).toEqual({ theme: 'dark', chrome: THEME_COLOR.dark });
  });

  it('keeps a saved light choice and colours the browser chrome to match', () => {
    expect(firstPaint('light')).toEqual({ theme: 'light', chrome: THEME_COLOR.light });
  });

  it('falls back to dark on junk or blocked storage', () => {
    expect(firstPaint('neon').theme).toBe('dark');
    expect(firstPaint(new Error('private mode')).theme).toBe('dark');
  });
});
