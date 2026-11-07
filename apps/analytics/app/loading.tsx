/** Skeleton while a page reads the API: the layout keeps its shape, nothing pretends to be a value. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton" style={{ width: 280, height: 28, marginBottom: 10 }} />
      <div className="skeleton" style={{ width: '60%', height: 14, marginBottom: 24 }} />
      <div className="kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card">
            <div className="skeleton" style={{ width: '50%', height: 12, marginBottom: 12 }} />
            <div className="skeleton" style={{ width: '70%', height: 26 }} />
          </div>
        ))}
      </div>
      <div className="card" style={{ marginTop: 20 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" style={{ height: 14, margin: '10px 0' }} />
        ))}
      </div>
    </div>
  );
}
