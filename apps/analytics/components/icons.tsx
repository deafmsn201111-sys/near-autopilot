import type { ReactNode } from 'react';

const icon = (name: string, d: ReactNode) => (
  <svg data-icon={name} viewBox="0 0 24 24" aria-hidden="true">
    {d}
  </svg>
);

export const TREND_UP = icon('trend-up', <path d="m22 7-8.5 8.5-5-5L2 17M16 7h6v6" />);
export const TREND_DOWN = icon('trend-down', <path d="m22 17-8.5-8.5-5 5L2 7M16 17h6v-6" />);
export const ALERT = icon(
  'alert',
  <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" />,
);
export const CHECK = icon('check', <path d="M20 6 9 17l-5-5" />);
export const ALERT_CIRCLE = icon(
  'alert-circle',
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </>,
);
export const MINUS = icon('minus', <path d="M5 12h14" />);
