/**
 * Minimal structural types for the Vercel Node handler signature.
 *
 * `@vercel/node` would give these, but it is a dependency carried solely for two
 * interfaces, and the platform's `(req, res)` shape is stable and small enough to
 * state here. Declaring them locally also means the handler can be called
 * directly from a test with a plain object, no mocking framework involved.
 */

export interface CronRequest {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

export interface CronResponse {
  status: (code: number) => CronResponse;
  json: (body: unknown) => void;
}

/**
 * JSON-safe view of a value that may contain bigints.
 *
 * Every id in this schema is `bigint` (bigserial), and `JSON.stringify` throws on
 * those rather than coercing — so returning a result straight from `runIngest`
 * would turn a successful poll into a 500. Ids become strings, which is also the
 * right wire format: they can exceed 2^53 and a JSON number would silently lose
 * precision on the way into any consumer.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]),
    );
  }

  return value;
}

/**
 * Anything that could carry a credential, removed before a message is returned or
 * logged.
 *
 * Driver-level failures are the risk: a connection error can quote the string it
 * was given, and that string contains the database password. The handler's own
 * errors are already careful, but this is the layer where being wrong is
 * published to a log that outlives the run.
 */
export function redact(message: string): string {
  return (
    message
      .replace(/postgres(?:ql)?:\/\/[^\s]*/gi, '<redacted-connection-string>')
      /**
       * Looser than the equivalent rule in `scripts/scan-secrets.mjs`, on purpose.
       * That scanner must not cry wolf, because a scanner people disable protects
       * nothing. This is the opposite trade: a needless redaction in a log costs a
       * little debugging clarity, a missed one publishes a key.
       */
      .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '<redacted-jwt>')
      .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{4,}/g, '<redacted-key>')
  );
}
