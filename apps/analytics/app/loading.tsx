const Bar = ({ w, h = 14 }: { w: number | string; h?: number }) => (
  <div className="skeleton" style={{ width: w, height: h }} />
);

/**
 * First read (#256): the portfolio's own shape — context strip, summary, analysis, holdings — so nothing jumps when the
 * data lands, and nothing pretends to be a value.
 */
export default function Loading() {
  return (
    <div className="sk" aria-busy="true" aria-live="polite">
      <span className="sr-only">Reading the portfolio…</span>
      <div className="sk-ctx">
        <Bar w={120} h={24} />
        <Bar w="min(420px, 60%)" />
      </div>
      <div className="sum sk-sum">
        <div>
          <Bar w={90} h={13} />
          <Bar w="min(260px, 80%)" h={48} />
          <Bar w="min(200px, 70%)" />
          <Bar w="100%" h={8} />
        </div>
        <div>
          <Bar w={90} h={13} />
          <Bar w={140} h={30} />
          <Bar w="80%" />
        </div>
        <div>
          <Bar w={90} h={13} />
          <Bar w={110} h={28} />
          <Bar w="100%" h={8} />
        </div>
      </div>
      <section className="ds-panel sk-panel">
        <div className="sk-row">
          <Bar w={100} h={19} />
          <Bar w={150} h={36} />
        </div>
        <div className="sk-verdict">
          <div className="skeleton" style={{ width: 48, height: 48, borderRadius: 12 }} />
          <div className="sk-col">
            <Bar w="min(420px, 90%)" h={24} />
            <Bar w="min(320px, 70%)" />
          </div>
        </div>
        <Bar w="min(360px, 100%)" h={36} />
        <div className="sk-finds">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 96, borderRadius: 12 }} />
          ))}
        </div>
      </section>
      <section className="ds-panel sk-panel">
        <Bar w={140} h={19} />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="sk-hold">
            <div className="skeleton" style={{ width: 36, height: 36, borderRadius: '50%' }} />
            <Bar w="40%" />
            <Bar w={80} />
          </div>
        ))}
      </section>
    </div>
  );
}
