import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

/**
 * Migrations use the DIRECT connection (port 5432), never the pooler. DDL under
 * a transaction-mode pooler is not safe.
 *
 * drizzle-kit does not load .env files itself. Loading it here rather than via
 * a `node --env-file` wrapper keeps the npm scripts to a bare `drizzle-kit`
 * invocation, which is the only form that resolves correctly under pnpm's
 * per-package .bin layout.
 */
const envFile = fileURLToPath(new URL('../../.env.local', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const url = process.env['DIRECT_DATABASE_URL'];

if (!url) {
  throw new Error(
    'DIRECT_DATABASE_URL is not set. Migrations need the DIRECT Supabase connection ' +
      '(port 5432), not the pooler. Run via `pnpm db:migrate`, which loads .env.local.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
