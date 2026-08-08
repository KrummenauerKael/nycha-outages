import { createDb } from '@archive/db/client';
import { DuplicateIdentityError, IngestValidationError, runIngest, type IngestResult } from './run';
import { checkAuth } from './auth';
import { jsonSafe, redact, type CronRequest, type CronResponse } from './http';

/**
 * The cron endpoint. One poll per invocation, nothing else.
 *
 * All the behaviour lives in `@archive/ingest`; this decides who may call, opens
 * and closes the connection, and turns the outcome into a status code. Keeping it
 * this thin is deliberate — an HTTP handler is the least testable place in the
 * system and the hardest to run locally.
 *
 * A validation failure returns 500 on purpose. The snapshot was committed and the
 * data is safe, but the run must show as failed in both Vercel's cron log and the
 * Actions run, because invariant 3 is only useful if someone finds out.
 */
export interface HandlerDeps {
  /** Injected in tests. Defaults to a real poll against NYCHA. */
  ingest?: () => Promise<IngestResult>;
  env?: NodeJS.ProcessEnv;
}

export async function handleIngest(
  req: CronRequest,
  res: CronResponse,
  deps: HandlerDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;

  // Vercel Cron issues GET. POST is accepted so the Actions backstop and a manual
  // re-run can use a method that is not cached by anything in between.
  if (req.method !== undefined && req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const auth = checkAuth(req, env);
  if (auth !== 'ok') {
    // 503, not 401, when the secret is missing: the caller did nothing wrong and
    // retrying will not help until the project is configured. Distinguishing them
    // is also what makes a broken deploy visible instead of looking like an
    // attacker being turned away.
    if (auth === 'unconfigured') {
      res.status(503).json({ error: 'cron_secret_not_configured' });
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (deps.ingest) {
    await respond(res, deps.ingest);
    return;
  }

  /**
   * Connecting is configuration, not work, so its failure is reported the same
   * way a missing secret is: 503, named, and distinct from an ingest that ran
   * and failed.
   *
   * This is inside a try because `createDb` throws synchronously on a missing
   * `DATABASE_URL`. Left uncaught it escaped the route entirely and the caller
   * received a 500 with an empty body — no error name, no message, nothing in
   * the cron log to say the deploy was misconfigured rather than NYCHA being
   * down. That is precisely the ambiguity invariant 7 exists to prevent.
   */
  /**
   * Read and checked before `createDb` is called, never handed to it as a
   * possibly-undefined argument.
   *
   * `createDb(connectionString = process.env['DATABASE_URL'])` has a default
   * parameter, and a default parameter fires on `undefined`. So
   * `createDb(env['DATABASE_URL'])` with an injected env that lacks the key
   * does not fail — it silently falls back to the ambient environment. A test
   * that believed it was isolated opened a connection to the live archive and
   * ran a real poll against NYCHA. Injected configuration has to be
   * authoritative, or injecting it proves nothing.
   */
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) {
    res.status(503).json({
      ok: false,
      error: 'database_not_configured',
      message: 'DATABASE_URL is not set.',
    });
    return;
  }

  let connection: ReturnType<typeof createDb>;
  try {
    connection = createDb(databaseUrl);
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: 'database_not_configured',
      message: redact(error instanceof Error ? error.message : String(error)),
    });
    return;
  }

  const { db, client } = connection;
  try {
    await respond(res, () => runIngest({ db }));
  } finally {
    // One invocation, one connection. The platform may freeze this container
    // immediately after the response, so the socket is closed explicitly rather
    // than left for a GC that may never run.
    await client.end({ timeout: 5 });
  }
}

async function respond(res: CronResponse, ingest: () => Promise<IngestResult>): Promise<void> {
  try {
    const result = await ingest();
    res.status(200).json(jsonSafe({ ok: true, ...result }));
  } catch (error) {
    if (error instanceof IngestValidationError) {
      res.status(500).json(
        jsonSafe({
          ok: false,
          error: 'counts_mismatch',
          snapshotId: error.snapshotId,
          detail: error.detail,
          note: 'Snapshot committed and retained; observation timeline deliberately not written.',
        }),
      );
      return;
    }

    if (error instanceof DuplicateIdentityError) {
      res.status(500).json(
        jsonSafe({
          ok: false,
          error: 'duplicate_identity',
          snapshotId: error.snapshotId,
          duplicates: error.duplicates,
          note: 'Snapshot committed and retained; observation timeline deliberately not written.',
        }),
      );
      return;
    }

    res.status(500).json({
      ok: false,
      error: 'ingest_failed',
      message: redact(error instanceof Error ? error.message : String(error)),
    });
  }
}
