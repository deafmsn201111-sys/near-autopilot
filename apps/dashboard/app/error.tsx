'use client';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <h1>Can’t load this page</h1>
      <p className="lede">
        The dashboard could not get data from the autopilot API. Check that the API is running and
        that API_BASE_URL and API_TOKEN match on both sides.
      </p>
      {error.digest && <p className="muted small">Reference: {error.digest}</p>}
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </>
  );
}
