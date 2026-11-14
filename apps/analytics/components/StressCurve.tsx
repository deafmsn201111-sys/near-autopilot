/**
 * Health factor against a uniform fall of every collateral price, one line per demo portfolio. The marked points are
 * exactly the engine's stored stress scenarios (0 % is the current position); nothing between them is computed here,
 * the segments only join them. The risk bands are dashed reference lines in axis ink; series hold categorical slots 1
 * and 2 in a fixed order. Every point has a tooltip, and the same numbers are in the table under the chart.
 */
export interface StressSeries {
  readonly name: string;
  readonly slot: 1 | 2 | 3;
  /** drop: 0..1 (0.3 = collateral prices -30 %), hf: health factor. */
  readonly points: readonly { readonly drop: number; readonly hf: number }[];
  /** Fall at which the position becomes liquidatable (HF < 1), if known. */
  readonly liquidationAt: number | null;
}

export function StressCurve({
  series,
  bands,
}: {
  series: readonly StressSeries[];
  bands: readonly { v: number; label: string }[];
}) {
  const W = 900;
  const H = 280;
  const pad = { l: 56, r: 24, t: 14, b: 34 };
  const maxDrop = Math.max(0.5, ...series.flatMap((s) => s.points.map((p) => p.drop)));
  const hfs = [...series.flatMap((s) => s.points.map((p) => p.hf)), ...bands.map((b) => b.v)];
  const lo = Math.min(0.5, ...hfs);
  const hi = Math.max(...hfs) * 1.04;
  const x = (d: number) => pad.l + (d / maxDrop) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const yTicks = [0.5, 1, 1.5, 2, 2.5, 3].filter((v) => v >= lo && v <= hi);
  const xTicks = [0, 0.1, 0.2, 0.3, 0.4, 0.5].filter((d) => d <= maxDrop);
  const pctLabel = (d: number) => (d === 0 ? 'now' : `−${Math.round(d * 100)}%`);
  return (
    <div className="chart">
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: `var(--series-${s.slot})` }} />
            {s.name}
            {s.liquidationAt !== null && (
              <span className="dim">
                {' '}
                · liquidatable after −{(s.liquidationAt * 100).toFixed(1)}%
              </span>
            )}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Health factor of each demo portfolio as collateral prices fall"
      >
        <g className="grid">
          {yTicks.map((v) => (
            <line key={v} x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
          ))}
        </g>
        <g className="axis">
          {yTicks.map((v) => (
            <text key={v} x={pad.l - 8} y={y(v) + 4} textAnchor="end">
              {v.toFixed(1)}
            </text>
          ))}
          {xTicks.map((d) => (
            <text key={d} x={x(d)} y={H - 12} textAnchor={d === 0 ? 'start' : 'middle'}>
              {pctLabel(d)}
            </text>
          ))}
          <text x={W - pad.r} y={H - 0} textAnchor="end">
            fall of every collateral price
          </text>
        </g>
        <g className="refs">
          {bands.map((b) => (
            <g key={b.label}>
              <line x1={pad.l} x2={W - pad.r} y1={y(b.v)} y2={y(b.v)} />
              <text x={W - pad.r - 4} y={y(b.v) - 5} textAnchor="end">
                {b.label}
              </text>
            </g>
          ))}
        </g>
        {series.map((s) => (
          <g key={s.name}>
            <path
              className="series"
              style={{ stroke: `var(--series-${s.slot})` }}
              d={s.points
                .map((p, i) => `${i ? 'L' : 'M'}${x(p.drop).toFixed(1)},${y(p.hf).toFixed(1)}`)
                .join('')}
            />
            {s.points.map((p) => (
              <g key={p.drop}>
                <circle
                  className="dot"
                  cx={x(p.drop)}
                  cy={y(p.hf)}
                  r={4.5}
                  style={{ fill: `var(--series-${s.slot})` }}
                />
                {/* the hit target is larger than the mark */}
                <circle cx={x(p.drop)} cy={y(p.hf)} r={12} fill="transparent">
                  <title>{`${s.name}: collateral ${pctLabel(p.drop)} → HF ${p.hf.toFixed(3)}`}</title>
                </circle>
              </g>
            ))}
          </g>
        ))}
      </svg>
      <details className="table-view">
        <summary>Table view</summary>
        <div className="table-wrap" style={{ marginTop: 6 }}>
          <table>
            <thead>
              <tr>
                <th>Collateral prices</th>
                {series.map((s) => (
                  <th key={s.name} className="num">
                    {s.name} HF
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...new Set(series.flatMap((s) => s.points.map((p) => p.drop)))]
                .sort((a, b) => a - b)
                .map((d) => (
                  <tr key={d}>
                    <td>{pctLabel(d)}</td>
                    {series.map((s) => {
                      const p = s.points.find((q) => q.drop === d);
                      return (
                        <td key={s.name} className="num">
                          {p ? p.hf.toFixed(3) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
