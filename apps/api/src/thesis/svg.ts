/**
 * Static SVG charts for THESIS.md (rendered by GitHub and any browser). Deterministic output: no randomness, fixed
 * number formatting. Each mark carries a <title> (native tooltip); exact values are in the CSV and the tables of
 * THESIS.md (the table view). Colors: the first three categorical slots of the reference palette, in fixed order,
 * light and dark steps; text in text tokens, never in a series color.
 */
export const SERIES = [
  { light: '#2a78d6', dark: '#3987e5' }, // 1 blue
  { light: '#eb6834', dark: '#d95926' }, // 2 orange
  { light: '#1baf7a', dark: '#199e70' }, // 3 aqua
] as const;

const STYLE = `<style>
.s{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;${SERIES.map((c, i) => `--c${i + 1}:${c.light};`).join('')}}
@media (prefers-color-scheme: dark){.s{--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;${SERIES.map((c, i) => `--c${i + 1}:${c.dark};`).join('')}}}
.s text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink2);font-size:12px}
.s .t{fill:var(--ink);font-size:15px;font-weight:600}.s .st{fill:var(--ink2);font-size:12px}
.s .ax{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.s .g{stroke:var(--grid);stroke-width:1}.s .z{stroke:var(--axis);stroke-width:1}
.s .lnk{stroke:var(--axis);stroke-width:2;stroke-linecap:round}
.s .m{stroke:var(--surface);stroke-width:2}
</style>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

function niceTicks(min: number, max: number, count = 6): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  // From the step at or below min up to the first step at or above max: every value sits inside the axis.
  for (let v = Math.floor(min / step) * step; ; v += step) {
    out.push(Number(v.toFixed(10)));
    if (v >= max - step * 1e-9) break;
  }
  return out;
}

function legend(items: readonly string[], x: number, y: number): string {
  let cx = x;
  return items
    .map((label, i) => {
      const g = `<circle cx="${cx + 5}" cy="${y - 4}" r="5" fill="var(--c${i + 1})"/><text x="${cx + 15}" y="${y}">${esc(label)}</text>`;
      cx += 26 + label.length * 6.6;
      return g;
    })
    .join('');
}

export interface DumbbellRow {
  readonly label: string;
  /** One value per series; null = not available (drawn as nothing). */
  readonly values: readonly (number | null)[];
  /** Tooltip suffix (e.g. TVL). */
  readonly note?: string;
}

/** Rows of dots on one percentage axis, one dot per series, joined by a hairline: the gap is the story. */
export function dumbbell(o: {
  title: string;
  subtitle: string;
  series: readonly string[];
  rows: readonly DumbbellRow[];
  /** Clamp the axis so one outlier does not flatten the rest; clamped dots are drawn at the edge with an arrow. */
  clamp?: [number, number];
}): string {
  const W = 860;
  const left = 190;
  const right = 40;
  const top = 86;
  const rowH = 26;
  const H = top + o.rows.length * rowH + 44;
  const all = o.rows.flatMap((r) => r.values.filter((v): v is number => v !== null));
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  if (o.clamp) {
    lo = Math.max(lo, o.clamp[0]);
    hi = Math.min(hi, o.clamp[1]);
  }
  const ticks = niceTicks(lo, hi);
  const t0 = ticks[0] ?? lo;
  const t1 = ticks[ticks.length - 1] ?? hi;
  const x = (v: number) =>
    left + ((Math.min(Math.max(v, t0), t1) - t0) / (t1 - t0)) * (W - left - right);
  const parts: string[] = [];
  parts.push(`<text class="t" x="20" y="28">${esc(o.title)}</text>`);
  parts.push(`<text class="st" x="20" y="48">${esc(o.subtitle)}</text>`);
  parts.push(legend(o.series, left, 72));
  for (const t of ticks) {
    const cls = t === 0 ? 'z' : 'g';
    parts.push(
      `<line class="${cls}" x1="${x(t).toFixed(1)}" y1="${top - 8}" x2="${x(t).toFixed(1)}" y2="${top + o.rows.length * rowH}"/>`,
    );
    parts.push(
      `<text class="ax" x="${x(t).toFixed(1)}" y="${top + o.rows.length * rowH + 18}" text-anchor="middle">${pct(t, 0)}</text>`,
    );
  }
  o.rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    parts.push(`<text x="${left - 12}" y="${y + 4}" text-anchor="end">${esc(r.label)}</text>`);
    const vs = r.values.filter((v): v is number => v !== null);
    if (vs.length > 1)
      parts.push(
        `<line class="lnk" x1="${x(Math.min(...vs)).toFixed(1)}" y1="${y}" x2="${x(Math.max(...vs)).toFixed(1)}" y2="${y}"/>`,
      );
    r.values.forEach((v, s) => {
      if (v === null) return;
      const clipped = v < t0 || v > t1;
      const tip = `${r.label} - ${o.series[s] ?? ''}: ${pct(v)}${clipped ? ' (beyond the axis)' : ''}${r.note ? ` - ${r.note}` : ''}`;
      parts.push(
        `<circle class="m" cx="${x(v).toFixed(1)}" cy="${y}" r="5" fill="var(--c${s + 1})"><title>${esc(tip)}</title></circle>`,
      );
      if (clipped)
        parts.push(
          `<text class="ax" x="${(x(v) + (v > t1 ? 8 : -8)).toFixed(1)}" y="${y + 4}" text-anchor="${v > t1 ? 'start' : 'end'}">${pct(v, 0)}</text>`,
        );
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" class="s" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.title)}">${STYLE}<rect width="${W}" height="${H}" fill="var(--surface)"/>${parts.join('')}</svg>\n`;
}

/** One series of dots: x on a log scale (TVL), y a percentage. */
export function scatterLogX(o: {
  title: string;
  subtitle: string;
  xLabel: string;
  yLabel: string;
  points: readonly { x: number; y: number; label: string }[];
  /** Points labelled directly (the extremes the text talks about). */
  labelled: readonly string[];
}): string {
  const W = 860;
  const H = 480;
  const left = 70;
  const right = 40;
  const top = 92;
  const bottom = 60;
  const xs = o.points.map((p) => Math.log10(p.x));
  const ys = o.points.map((p) => p.y);
  const xl = Math.floor(Math.min(...xs));
  const xh = Math.ceil(Math.max(...xs));
  const yt = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys));
  const y0 = yt[0] ?? 0;
  const y1 = yt[yt.length - 1] ?? 1;
  const X = (v: number) => left + ((Math.log10(v) - xl) / (xh - xl || 1)) * (W - left - right);
  const Y = (v: number) => top + (1 - (v - y0) / (y1 - y0)) * (H - top - bottom);
  const parts: string[] = [];
  parts.push(`<text class="t" x="20" y="28">${esc(o.title)}</text>`);
  parts.push(`<text class="st" x="20" y="48">${esc(o.subtitle)}</text>`);
  for (const t of yt) {
    parts.push(
      `<line class="${t === 0 ? 'z' : 'g'}" x1="${left}" y1="${Y(t).toFixed(1)}" x2="${W - right}" y2="${Y(t).toFixed(1)}"/>`,
    );
    parts.push(
      `<text class="ax" x="${left - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${pct(t, 0)}</text>`,
    );
  }
  for (let e = xl; e <= xh; e += 1) {
    const v = 10 ** e;
    parts.push(
      `<line class="g" x1="${X(v).toFixed(1)}" y1="${top}" x2="${X(v).toFixed(1)}" y2="${H - bottom}"/>`,
    );
    parts.push(
      `<text class="ax" x="${X(v).toFixed(1)}" y="${H - bottom + 18}" text-anchor="middle">$${v >= 1e6 ? `${v / 1e6}M` : `${v / 1e3}K`}</text>`,
    );
  }
  parts.push(
    `<text class="ax" x="${(left + W - right) / 2}" y="${H - 16}" text-anchor="middle">${esc(o.xLabel)}</text>`,
  );
  parts.push(`<text class="ax" x="16" y="${top - 14}">${esc(o.yLabel)}</text>`);
  for (const p of o.points) {
    parts.push(
      `<circle class="m" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="5" fill="var(--c1)"><title>${esc(
        `${p.label}: TVL $${Math.round(p.x)
          .toString()
          .replace(/\B(?=(\d{3})+(?!\d))/g, ',')}, ${pct(p.y)}`,
      )}</title></circle>`,
    );
    if (o.labelled.includes(p.label))
      parts.push(
        `<text x="${(X(p.x) + 9).toFixed(1)}" y="${(Y(p.y) + 4).toFixed(1)}">${esc(p.label)}</text>`,
      );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" class="s" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.title)}">${STYLE}<rect width="${W}" height="${H}" fill="var(--surface)"/>${parts.join('')}</svg>\n`;
}
