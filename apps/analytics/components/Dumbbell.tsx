import type { ReactNode } from 'react';

/**
 * Rows of dots on one percentage axis (up to three series, slots 1-3), joined by a hairline: the distance between what
 * is shown and what was kept is the reading. Values beyond the axis are pinned to the edge and printed. Each dot has a
 * tooltip; the table view below carries every value.
 */
export interface DumbbellRow {
  readonly key: string;
  readonly label: ReactNode;
  readonly values: readonly (number | null)[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function ticks(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 6 || 0.1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; ; v += step) {
    out.push(Number(v.toFixed(10)));
    if (v >= hi - step * 1e-9) break;
  }
  return out;
}

export function Dumbbell({
  series,
  rows,
  clamp,
}: {
  series: readonly string[];
  rows: readonly DumbbellRow[];
  clamp?: [number, number];
}) {
  const all = rows.flatMap((r) => r.values.filter((v): v is number => v !== null));
  const lo = Math.max(Math.min(0, ...all), clamp?.[0] ?? -Infinity);
  const hi = Math.min(Math.max(0, ...all), clamp?.[1] ?? Infinity);
  const t = ticks(lo, hi);
  const t0 = t[0] ?? lo;
  const t1 = t[t.length - 1] ?? hi;
  const x = (v: number) => ((Math.min(Math.max(v, t0), t1) - t0) / (t1 - t0 || 1)) * 100;
  return (
    <div>
      <div className="legend">
        {series.map((s, i) => (
          <span key={s}>
            <i style={{ background: `var(--c${i + 1})`, height: 8, width: 8, borderRadius: 4 }} />
            {s}
          </span>
        ))}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(170px, 230px) 1fr',
          rowGap: 4,
          columnGap: 14,
        }}
      >
        {rows.map((r) => {
          const vs = r.values.filter((v): v is number => v !== null);
          return (
            <div key={r.key} style={{ display: 'contents' }}>
              <div
                style={{
                  fontSize: 13,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  alignSelf: 'center',
                }}
              >
                {r.label}
              </div>
              <div style={{ position: 'relative', height: 24 }}>
                {t.map((v) => (
                  <div
                    key={v}
                    style={{
                      position: 'absolute',
                      left: `${x(v)}%`,
                      top: 0,
                      bottom: 0,
                      width: 1,
                      background: v === 0 ? 'var(--axis)' : 'var(--grid)',
                    }}
                  />
                ))}
                {vs.length > 1 && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 11,
                      height: 2,
                      borderRadius: 2,
                      background: 'var(--axis)',
                      left: `${x(Math.min(...vs))}%`,
                      width: `${x(Math.max(...vs)) - x(Math.min(...vs))}%`,
                    }}
                  />
                )}
                {r.values.map((v, i) =>
                  v === null ? null : (
                    <span
                      key={i}
                      tabIndex={0}
                      data-tip={`${series[i] ?? ''}: ${pct(v)}${v < t0 || v > t1 ? ' (beyond the axis)' : ''}`}
                      style={{
                        position: 'absolute',
                        left: `calc(${x(v)}% - 7px)`,
                        top: 5,
                        width: 14,
                        height: 14,
                        borderRadius: 7,
                        background: `var(--c${i + 1})`,
                        border: '2px solid var(--surface)',
                        boxSizing: 'border-box',
                        cursor: 'default',
                      }}
                    />
                  ),
                )}
              </div>
            </div>
          );
        })}
        <div />
        <div style={{ position: 'relative', height: 16 }}>
          {t.map((v, i) => (
            <span
              key={v}
              style={{
                position: 'absolute',
                left: `${x(v)}%`,
                transform:
                  i === 0 ? 'none' : i === t.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                fontSize: 11,
                color: 'var(--muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {(v * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
