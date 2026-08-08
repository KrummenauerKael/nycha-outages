import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Runtime client. Points at the TRANSACTION pooler (port 6543), never the
 * direct connection — that one is reserved for migrations.
 *
 * Fails loudly on a missing URL rather than defaulting to localhost, which
 * would look like a working ingest run writing to nothing.
 */
export interface DbOptions {
  /**
   * Connections in the local pool. One is right for the cron: a single
   * invocation doing a single unit of work, against a Supavisor that already
   * pools upstream. A page rendering several independent queries wants more
   * than one, or they serialise behind each other for no reason.
   */
  max?: number;
}

export function createDb(connectionString = process.env['DATABASE_URL'], options: DbOptions = {}) {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. It must point at the Supabase transaction pooler ' +
        '(port 6543). See .env.example for the required names.',
    );
  }

  const client = postgres(connectionString, {
    /**
     * Required. The transaction-mode pooler hands a different backend to each
     * transaction, so server-side prepared statements cannot survive between
     * them. Leaving this on produces intermittent "prepared statement does not
     * exist" errors under load — the worst kind, because a low-traffic cron
     * looks fine until it isn't.
     */
    prepare: false,
    /**
     * One invocation, one unit of work, by default. Supavisor already pools
     * upstream, so a second pool here would just hold connections open across a
     * run that is about to be frozen anyway.
     */
    max: options.max ?? 1,
    /** Close the socket well before the platform recycles the function. */
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return { db: drizzle({ client, schema }), client };
}

export type Db = ReturnType<typeof createDb>['db'];
