export type Theme = 'light' | 'dark';

/** Browser chrome colour per theme: `--bg-page` of each token block, as hex because theme-color is not CSS. */
export const THEME_COLOR: Record<Theme, string> = { dark: '#0f1013', light: '#f8f9fb' };

/** Runs before first paint: a saved choice wins, otherwise dark (the primary theme, never the OS preference). */
export const THEME_SCRIPT = `(function(){var c=${JSON.stringify(THEME_COLOR)},t='dark';try{var s=localStorage.getItem('theme');if(s==='light'||s==='dark')t=s;}catch(e){}document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',c[t]);})();`;

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}
