import 'server-only';

import { createDb, type Db } from '@archive/db/client';

/**
 * Runs one unit of read work against the archive and always closes the socket.
 *
 * **Never cache the connection across invocations.** This module previously
 * held a module-level pool, which is the mistake `packages/ingest`'s handler
 * documents at the point it avoids it: the platform may freeze the container
 * the instant a response is sent. A frozen container's sockets are dropped by
 * the pooler, and the next invocation to reuse one blocks until it times out
 * rather than failing. The symptom is exactly what it sounds like — the first
 * request is fast and later ones hang — and it is invisible locally, where a
 * single long-lived `next start` process never freezes.
 *
 * `max: 1` for the same reason the cron uses it: one request is one unit of
 * work, Supavisor already pools upstream, and a second local connection only
 * widens the window in which a socket can go stale. The dashboard's queries
 * run in a few hundred milliseconds in series, which is well inside what a
 * server-rendered page can spend.
 *
 * **Why reads do not go through Supabase's REST API.** RLS is enabled on all
 * eight tables with *zero* policies, so the `anon` key can read nothing — that
 * is the intended posture, and it is what makes a public repo safe to hold this
 * schema. Rather than punch read policies through it and then reason forever
 * about what a leaked anon key exposes, pages query Postgres directly from the
 * server. The browser never receives a database credential because the browser
 * never talks to the database. `server-only` makes that structural: importing
 * this from a client component is a build error, not a review catch.
 *
 * **Known follow-up.** `DATABASE_URL` is the same read/write credential the
 * cron uses, so a bug in a dashboard query has more authority than it needs.
 * The fix is a dedicated read-only role with `SELECT` and nothing else, and a
 * second connection string. One migration plus one env var, worth doing before
 * this is promoted anywhere.
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, client } = createDb(process.env['DATABASE_URL'], { max: 1 });
  try {
    return await fn(db);
  } finally {
    // Mirrors the cron handler exactly. Closing is not cleanup here, it is the
    // thing that stops the next invocation inheriting a dead socket.
    await client.end({ timeout: 5 });
  }
}
