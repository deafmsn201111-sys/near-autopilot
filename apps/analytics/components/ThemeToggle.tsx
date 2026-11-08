'use client';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/**
 * Light (newsprint) / dark (fintech) theme switch. The theme is applied before paint by a tiny inline script in the
 * layout (from localStorage, else the OS preference); this button only flips it and remembers the choice. No flash,
 * no layout shift: the icon renders once the stored value is read on the client.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'dark' : 'light');
  }, []);

  const apply = (next: Theme) => {
    document.documentElement.setAttribute('data-theme', next);
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
