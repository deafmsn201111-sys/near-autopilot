/**
 * A word-sized trend line for a table cell: one 1.5px line in the first categorical hue, no axes. The change over
 * the window is printed next to it in text ink (never the series colour), and the first / last / low / high values
 * are in the tooltip, so nothing depends on reading the line. Gaps (null) break the line; they are not bridged.
 */
export interface SparkPoint {
  readonly t: number;
  readonly v: number | null;
}

export function Sparkline({
  points,
  format,
  label,
  change = 'pct',
}: {
  points: readonly SparkPoint[];
  format: (v: number) => string;
  /** What the line shows, for the tooltip, e.g. "price, 24 h". */
  label: string;
  /**
   * How the change over the window is printed: relative (%), in percentage points (for rates such as an APR, where a
   * relative change would mislead), or not at all.
   */
  change?: 'pct' | 'pp' | 'none';
}) {
  const vals = points.flatMap((p) => (p.v === null ? [] : [{ t: p.t, v: p.v }]));
  if (vals.length < 2) return <span className="dim spark-empty">no history</span>;
  const W = 72;
  const H = 24;
  const lo = Math.min(...vals.map((p) => p.v));
  const hi = Math.max(...vals.map((p) => p.v));
  const t0 = vals[0]?.t ?? 0;
  const t1 = vals[vals.length - 1]?.t ?? 1;
  const x = (t: number) => 1 + ((t - t0) / (t1 - t0 || 1)) * (W - 2);
  const y = (v: number) => (hi === lo ? H / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (H - 4));
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.v === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    pen = true;
  }
  const first = vals[0]?.v ?? 0;
  const last = vals[vals.length - 1]?.v ?? 0;
  // A change that rounds to zero is printed unsigned: "−0.00" would claim a direction the data does not show.
  const signed = (v: number, unit: string) => {
    const r = Math.abs(v).toFixed(2);
    return Number(r) === 0 ? `0.00${unit}` : `${v > 0 ? '+' : '−'}${r}${unit}`;
  };
  const delta =
    change === 'none'
      ? null
      : change === 'pp'
        ? signed((last - first) * 100, ' pp')
        : first === 0
          ? null
          : signed(((last - first) / first) * 100, '%');
  const tip = [
    label,
    `first ${format(first)}  ·  last ${format(last)}`,
    `low ${format(lo)}  ·  high ${format(hi)}`,
    `${vals.length} observations`,
  ].join('\n');
  return (
    <span className="spark" data-tip={tip} tabIndex={0}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
        <path d={d} />
        <circle cx={x(t1)} cy={y(last)} r={2} />
      </svg>
      {delta && <span className="spark-delta">{delta}</span>}
    </span>
  );
}
