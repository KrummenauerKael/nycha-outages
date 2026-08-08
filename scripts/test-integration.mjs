import { spawnSync } from 'node:child_process';

/**
 * Runs the suite with a database attached, so the read-layer integration tests
 * stop skipping.
 *
 * `TEST_DATABASE_URL` is a separate variable from `DATABASE_URL` on purpose:
 * `pnpm test` must never touch a real database by accident, only because
 * someone ran this script. Falling back to `DATABASE_URL` here is safe because
 * every one of those tests runs inside a transaction that is always rolled
 * back — and one of them asserts exactly that.
 *
 * Invoked as `node --env-file=.env.local scripts/test-integration.mjs`, so the
 * connection string never appears in a shell command or a process listing.
 */
process.env.TEST_DATABASE_URL ??= process.env.DATABASE_URL;

if (!process.env.TEST_DATABASE_URL) {
  console.error('Neither TEST_DATABASE_URL nor DATABASE_URL is set. Nothing to connect to.');
  process.exit(1);
}

/**
 * Defence in depth, after this bit already went wrong once.
 *
 * With DATABASE_URL left in the environment, any code path that reaches for it
 * ambiently — a default parameter, a forgotten fallback — connects to the live
 * archive from inside a test run. That happened: a handler test ran a real poll
 * against NYCHA and wrote a snapshot. The handler no longer falls back, but
 * removing the variable means the next such mistake fails loudly instead of
 * quietly succeeding against production.
 *
 * Only TEST_DATABASE_URL survives, and only the integration tests read it.
 */
delete process.env.DATABASE_URL;

const result = spawnSync('vitest', ['run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

process.exit(result.status ?? 1);
