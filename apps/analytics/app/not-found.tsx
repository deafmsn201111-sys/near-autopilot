import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="state empty-state">
      <div className="state-icon" aria-hidden="true">
        ?
      </div>
      <div>
        <b>Nothing here.</b>
        <p>This page or item does not exist, or it is no longer in the latest data.</p>
        <div style={{ marginTop: 10 }}>
          <Link className="btn secondary" href="/">
            Back to the overview
          </Link>
        </div>
      </div>
    </div>
  );
}
