import type { NextConfig } from 'next';

/**
 * `transpilePackages` is load-bearing, not a nicety.
 *
 * Every workspace package exports TypeScript source (`./src/index.ts`) rather
 * than built JS, and their internal imports use the NodeNext `.js` specifier
 * convention for files that only ever exist as `.ts`. Node can run neither.
 * Listing them here is what makes Next compile them as first-party source and
 * resolve those specifiers.
 *
 * Dropping a name from this list does not fail the build — it produces a
 * deployment that fails at runtime instead, which is exactly how the previous
 * `apps/ingest` setup would have broken. Any new `@archive/*` dependency must
 * be added here.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@archive/config', '@archive/db', '@archive/ingest', '@archive/parser'],

  typedRoutes: true,
};

export default nextConfig;
