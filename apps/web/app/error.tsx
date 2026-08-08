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
      <h1>NYCHA service interruptions</h1>
      <p>This page failed to load. Collection is unaffected.</p>
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
