'use client';
import { useMemo, useRef, useState, type PointerEvent } from 'react';

/**
 * Line chart with a crosshair: a vertical hairline snaps to the nearest time, one tooltip lists every series there.
 * Values lead, names follow; series are keyed with a short line in their colour. A table view sits under the chart,
 * so no value depends on hovering. One y-axis only: series must share a unit.
 */
export interface Series {
  readonly name: string;
  /** Categorical slot 1-3 (fixed order: blue, orange, aqua). */
  readonly slot: 1 | 2 | 3;
  readonly points: readonly { readonly t: number; readonly v: number | null }[];
}

type Unit = 'pct' | 'usd' | 'price' | 'bps' | 'ratio';

/** A labelled horizontal reference: a limit or a threshold, drawn dashed in axis ink (never a series colour). */
export interface RefLine {
  readonly v: number;
  readonly label: string;
}

const fmt = (v: number, unit: Unit) =>
  unit === 'bps'
    ? `${Math.round(v)} bps`
    : unit === 'ratio'
      ? v.toFixed(2)
      : unit === 'pct'
        ? `${(v * 100).toFixed(2)}%`
        : unit === 'usd'
          ? Math.abs(v) >= 1e6
            ? `$${(v / 1e6).toFixed(2)}M`
            : Math.abs(v) >= 1e4
              ? `$${(v / 1e3).toFixed(0)}K`
              : `$${v.toFixed(0)}`
          : `$${v < 10 ? v.toFixed(4) : v.toFixed(2)}`;

const when = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function ticks(min: number, max: number, n = 4): number[] {
  if (min === max) return [min];
  const raw = (max - min) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; ; v += step) {
    out.push(v);
    if (v >= max - step * 1e-9) break;
  }
  return out;
}

export function LineChart({
  series,
  unit,
  height = 240,
  zeroBased = false,
  refs = [],
  tableView = true,
  width = 900,
}: {
  series: readonly Series[];
  unit: Unit;
  height?: number;
  zeroBased?: boolean;
  refs?: readonly RefLine[];
  /** Small multiples may leave the table out when one shared table sits next to them. */
  tableView?: boolean;
  /** viewBox width: set it near the rendered width so axis text keeps its size in small multiples. */
  width?: number;
}) {
  const W = width;
  const H = height;
  const pad = { l: 64, r: 16, t: 12, b: 28 };
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { times, x, y, yt, t0, t1 } = useMemo(() => {
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort(
      (a, b) => a - b,
    );
    const vals = [
      ...series.flatMap((s) => s.points.flatMap((p) => (p.v === null ? [] : [p.v]))),
      ...refs.map((r) => r.v),
    ];
    const lo = Math.min(zeroBased ? 0 : Infinity, ...vals);
    const hi = Math.max(zeroBased ? 0 : -Infinity, ...vals);
    const yt = ticks(lo, hi === lo ? lo + (Math.abs(lo) || 1) * 0.01 : hi);
    const y0 = yt[0] ?? lo;
    const y1 = yt[yt.length - 1] ?? hi;
    const t0 = times[0] ?? 0;
    const t1 = times[times.length - 1] ?? 1;
    return {
      times,
      t0,
      t1,
      yt,
      x: (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r),
      y: (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b),
    };
  }, [series, refs, zeroBased, W, H, pad.l, pad.r, pad.t, pad.b]);

  if (times.length < 2)
    return <p className="note">Not enough history to draw a line ({times.length} point).</p>;

  const path = (s: Series) => {
    let d = '';
    let pen = false;
    for (const p of s.points) {
      if (p.v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const t = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    let best = times[0] ?? 0;
    for (const c of times) if (Math.abs(c - t) < Math.abs(best - t)) best = c;
    setHover(best);
  };
  const at = (s: Series, t: number) => s.points.find((p) => p.t === t)?.v ?? null;
  // Narrow charts (small multiples) get three time labels, so they never run into each other.
  const fractions = W < 600 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const xTicks = fractions.map((f) => t0 + f * (t1 - t0));
  const left = hover === null ? 0 : (x(hover) / W) * 100;

  return (
    <div className="chart" ref={ref}>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: `var(--c${s.slot})` }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={series.map((s) => s.name).join(', ')}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <g className="grid">
          {yt.map((v) => (
            <line key={v} x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
          ))}
        </g>
        <g className="axis">
          {yt.map((v) => (
            <text key={v} x={pad.l - 8} y={y(v) + 4} textAnchor="end">
              {fmt(v, unit)}
            </text>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={t}
              x={x(t)}
              y={H - 8}
              textAnchor={i === 0 ? 'start' : i === fractions.length - 1 ? 'end' : 'middle'}
            >
              {t1 - t0 < 3 * 86_400_000
                ? new Date(t).toISOString().slice(5, 16).replace('T', ' ')
                : new Date(t).toISOString().slice(5, 10)}
            </text>
          ))}
        </g>
        <g className="refs">
          {refs.map((r) => (
            <g key={r.label}>
              <line x1={pad.l} x2={W - pad.r} y1={y(r.v)} y2={y(r.v)} />
              <text x={W - pad.r - 4} y={y(r.v) - 5} textAnchor="end">
                {r.label}
              </text>
            </g>
          ))}
        </g>
        {series.map((s) => (
          <path
            key={s.name}
            className="series"
            d={path(s)}
            style={{ stroke: `var(--c${s.slot})` }}
          />
        ))}
        {hover !== null && (
          <>
            <line className="cross" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} />
            {series.map((s) => {
              const v = at(s, hover);
              return v === null ? null : (
                <circle
                  key={s.name}
                  className="dot"
                  cx={x(hover)}
                  cy={y(v)}
                  r={4.5}
                  style={{ fill: `var(--c${s.slot})` }}
                />
              );
            })}
          </>
        )}
      </svg>
      {hover !== null && (
        <div
          className="tip"
          style={left > 60 ? { right: `${100 - left + 2}%` } : { left: `${left + 2}%` }}
        >
          <div className="t">{when(hover)}</div>
          {series.map((s) => {
            const v = at(s, hover);
            return (
              <div className="r" key={s.name}>
                <span className="k" style={{ background: `var(--c${s.slot})` }} />
                <b>{v === null ? '—' : fmt(v, unit)}</b>
                <span className="dim">{s.name}</span>
              </div>
            );
          })}
        </div>
      )}
      {tableView && (
        <details className="table-view">
          <summary>Table view ({times.length} points)</summary>
          <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto', marginTop: 6 }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  {series.map((s) => (
                    <th key={s.name} className="num">
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...times].reverse().map((t) => (
                  <tr key={t}>
                    <td>{when(t)}</td>
                    {series.map((s) => {
                      const v = at(s, t);
                      return (
                        <td key={s.name} className="num">
                          {v === null ? '—' : fmt(v, unit)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
