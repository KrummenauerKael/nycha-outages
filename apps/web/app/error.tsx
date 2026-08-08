'use client';

/**
 * The catch-all. Anything that escapes a page's own handling lands here rather
 * than on Next's default error screen.
 *
 * Deliberately says nothing technical. Next passes only an opaque `digest` to
 * this component in production — never the message — so there is no way for a
 * query, a stack, or a connection string to reach a visitor through it. The
 * digest is printed because it is the one thing that ties what someone saw to
 * a line in the server log, and it identifies nothing on its own.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <h1>NYCHA service interruption archive</h1>
      <h2>Something went wrong</h2>
      <p>
        This page failed to load. It is a fault on our side, not a statement about whether any
        building currently has heat, hot water, water, elevators, electricity or gas.
      </p>
      <p>
        The hourly collection that builds this archive runs separately from this page and is
        unaffected, so no record is being lost while this is broken.
      </p>
      <p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </p>
      {error.digest && (
        <p>
          <small>Reference: {error.digest}</small>
        </p>
      )}
    </main>
  );
}
