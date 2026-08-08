import 'server-only';

import { createDb, type Db } from '@archive/db/client';

/**
 * The dashboard's database handle. Server-side only, always.
 *
 * **Why reads do not go through Supabase's REST API.** RLS is enabled on all
 * eight tables with *zero* policies, which means the `anon` key can read
 * nothing — that is the intended posture, not an oversight, and it is what
 * makes a public repo safe to hold this schema. Rather than punch read policies
 * through it and then have to reason forever about what a leaked anon key
 * exposes, pages query Postgres directly from the server with the credentials
 * the ingest already needs. The browser never receives a database credential
 * because the browser never talks to the database.
 *
 * `server-only` makes that structural: importing this from a client component
 * is a build error, not a code review catch.
 *
 * **Known follow-up.** `DATABASE_URL` is the same read/write credential the
 * cron uses, so a bug in a dashboard query has more authority than it needs.
 * The fix is a dedicated read-only role with `SELECT` and nothing else, and a
 * second connection string for it. Deferred rather than forgotten: it is one
 * migration plus one env var, and worth doing before the app is public.
 */
let cached: Db | undefined;

export function readDb(): Db {
  /**
   * Cached across invocations on purpose. A warm serverless container reuses
   * this, and postgres.js closes idle sockets on its own timeout, so the pool
   * does not outlive its usefulness.
   *
   * Three connections, not one: a page renders several independent queries and
   * a single-connection pool would run them one after another.
   */
  cached ??= createDb(process.env['DATABASE_URL'], { max: 3 }).db;
  return cached;
}
