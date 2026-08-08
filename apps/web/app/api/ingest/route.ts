import { handleIngest, type CronRequest, type CronResponse } from '@archive/ingest';

/**
 * The hourly cron endpoint.
 *
 * All behaviour — auth, polling, validation, status codes — lives in
 * `@archive/ingest`. This file exists only to translate between Next's
 * `Request`/`Response` and the transport-agnostic `(req, res)` shape the
 * handler speaks, which is the same shape its tests drive it with.
 */

/** Uses node:crypto and a Postgres socket; neither exists on the edge runtime. */
export const runtime = 'nodejs';

/** A poll must never be served from a cache — every invocation hits NYCHA. */
export const dynamic = 'force-dynamic';

/**
 * Ceiling, not a target. A normal poll is a few seconds; this covers NYCHA
 * being slow while still failing rather than hanging a cron slot open.
 */
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  return invoke(request);
}

/**
 * Vercel Cron issues GET. POST is accepted so a manual re-run can use a method
 * nothing in between will cache.
 */
export function POST(request: Request): Promise<Response> {
  return invoke(request);
}

async function invoke(request: Request): Promise<Response> {
  const req: CronRequest = {
    method: request.method,
    headers: { authorization: request.headers.get('authorization') ?? undefined },
  };

  /**
   * Defaults describe a handler that returned without responding. That should
   * be impossible, but the alternative is a 200 with an empty body — a silent
   * success is the one outcome this system must never produce (invariant 7).
   */
  let status = 500;
  let body: unknown = { ok: false, error: 'handler_returned_no_response' };

  const res: CronResponse = {
    status(code) {
      status = code;
      return res;
    },
    json(payload) {
      body = payload;
    },
  };

  await handleIngest(req, res);

  // Ids are already strings by here: `jsonSafe` runs inside the handler because
  // every id in the schema is a bigint and `JSON.stringify` throws on those.
  return Response.json(body, { status });
}
