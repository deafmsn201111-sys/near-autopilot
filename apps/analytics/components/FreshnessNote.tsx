import { freshness } from '../lib/series';

const hhmm = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;

/** How old the stored data is and when the collector runs next. Read from the stored cycles only. */
export async function FreshnessNote() {
  const { data } = await freshness();
  if (!data) return null;
  const age = data.dataAsOf
    ? Math.max(0, Math.round((Date.parse(data.now) - Date.parse(data.dataAsOf)) / 60_000))
    : null;
  return (
    <div className="freshness" role="status">
      <span>
        Data as of <b>{data.dataAsOf ? hhmm(data.dataAsOf) : '—'}</b>
        {age !== null && <span className="dim"> ({age} min ago)</span>}
      </span>
      <span className="dim">
        {data.running
          ? 'Collector cycle running now'
          : data.nextRunAt
            ? `Next collection ≈ ${hhmm(data.nextRunAt)}`
            : 'No collection yet'}
        {` · every ${Math.round(data.intervalSeconds / 60)} min`}
      </span>
    </div>
  );
}
