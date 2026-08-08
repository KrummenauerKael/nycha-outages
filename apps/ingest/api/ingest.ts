import { handleIngest } from '../src/handler.js';
import type { CronRequest, CronResponse } from '../src/http.js';

/**
 * Vercel Function entry point. Everything is in `src/handler.ts` so it can be
 * called from a test without a server.
 *
 * Files under `api/` each become a route, which is why the helpers live in `src/`.
 */
export default function handler(req: CronRequest, res: CronResponse): Promise<void> {
  return handleIngest(req, res);
}
