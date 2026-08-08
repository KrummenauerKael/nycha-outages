import { handleIngest } from './handler.js';
import type { CronRequest, CronResponse } from './http.js';

/**
 * Vercel Function entry point — the source for the bundle, not the deployed
 * file. `pnpm build` bundles this into `api/ingest.js`, which is what Vercel
 * actually serves; `api/` holds only generated output and is gitignored.
 *
 * The bundle is not an optimisation, it is required. Workspace packages export
 * TypeScript source (`./src/index.ts`) and their internal imports use the
 * NodeNext `.js` specifier convention for files that only exist as `.ts`. Node
 * can run neither. If Vercel's dependency tracer were left to ship these files
 * as-is, the function would deploy successfully and then fail on first
 * invocation with ERR_MODULE_NOT_FOUND. Bundling resolves both at build time.
 *
 * Everything real is in `src/handler.ts` so it stays callable from a test
 * without a server.
 */
export default function handler(req: CronRequest, res: CronResponse): Promise<void> {
  return handleIngest(req, res);
}
