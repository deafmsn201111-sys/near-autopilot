import type { ReactNode } from 'react';

/**
 * Ranked horizontal bars around one zero baseline (diverging: blue = gain, red = loss, never a third hue). Thin bars,
 * 4px rounded data-end, the value at the tip, the full figure in the tooltip. Values stay readable without hovering.
 */
export function DivergingBars({
  rows,
  format,
}: {
  rows: readonly { key: string; label: ReactNode; value: number | null; tip?: string }[];
  format: (v: number) => string;
}) {
  const vals = rows.flatMap((r) => (r.value === null ? [] : [Math.abs(r.value)]));
  const max = Math.max(...vals, 1e-9);
  const hasNeg = rows.some((r) => (r.value ?? 0) < 0);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((r) => {
        const w = r.value === null ? 0 : (Math.abs(r.value) / max) * (hasNeg ? 50 : 100);
        const neg = (r.value ?? 0) < -0.005;
        return (
          <div
            key={r.key}
            data-tip={r.tip ?? (r.value === null ? 'not available' : format(r.value))}
            tabIndex={0}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(160px, 260px) 1fr 90px',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                fontSize: 13,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.label}
            </div>
            <div style={{ position: 'relative', height: 14 }}>
              {hasNeg && (
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: -2,
                    bottom: -2,
                    width: 1,
                    background: 'var(--line-strong)',
                  }}
                />
              )}
              {r.value !== null && (
                <div
                  style={{
                    position: 'absolute',
                    top: 3,
                    height: 8,
                    width: `${w}%`,
                    left: neg ? `${50 - w}%` : hasNeg ? '50%' : 0,
                    background: neg ? 'var(--liq)' : 'var(--series-1)',
                    borderRadius: neg ? '4px 0 0 4px' : '0 4px 4px 0',
                  }}
                />
              )}
            </div>
            <div
              className={`num ${r.value === null ? 'dim' : neg ? 'neg' : ''}`}
              style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}
            >
              {r.value === null ? 'n/a' : format(r.value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
