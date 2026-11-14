'use client';
import { useEffect, useState } from 'react';
import { applyTheme, type Theme } from '../lib/theme';

/**
 * Dark / light switch. THEME_SCRIPT applies the theme before paint; this button flips it and remembers the choice.
 * The icon renders once the applied theme is read on the client, so there is no flash or layout shift.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'light' ? 'light' : 'dark');
  }, []);

  const apply = (next: Theme) => {
    applyTheme(next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* private mode: the choice just does not persist */
    }
    setTheme(next);
  };

  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to the ${next} theme`}
      data-tip={`${next === 'dark' ? 'Dark' : 'Light'} theme`}
      onClick={() => apply(next)}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}
