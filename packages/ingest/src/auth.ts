import { createHash, timingSafeEqual } from 'node:crypto';
import type { CronRequest } from './http';

/**
 * Shared-secret check for the cron endpoint.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on every scheduled
 * invocation, using whatever value the project's `CRON_SECRET` env var holds — it
 * does not generate one, so an unset variable means unsigned requests. The
 * GitHub Actions backstop sends the identical header.
 *
 * The route is a public URL that writes to the archive, so this is the only thing
 * standing between the internet and an unbounded number of polls against NYCHA
 * from our User-Agent. It fails closed.
 */
export type AuthResult = 'ok' | 'unconfigured' | 'denied';

export function checkAuth(req: CronRequest, env: NodeJS.ProcessEnv = process.env): AuthResult {
  const secret = env['CRON_SECRET'];

  // Fail closed. An unset secret must never mean "allow everyone" — that is how a
  // misconfigured deploy turns into an open endpoint that crawls a public agency.
  if (!secret) return 'unconfigured';

  const header = req.headers['authorization'];
  if (typeof header !== 'string') return 'denied';

  /**
   * Hashed before comparison so both sides are always 32 bytes.
   * `timingSafeEqual` throws on length mismatch, and that throw is itself an
   * oracle for the secret's length — hashing removes the length signal entirely
   * while keeping the comparison constant-time.
   */
  const presented = createHash('sha256').update(header, 'utf8').digest();
  const expected = createHash('sha256').update(`Bearer ${secret}`, 'utf8').digest();

  return timingSafeEqual(presented, expected) ? 'ok' : 'denied';
}
