import type { Db } from '@archive/db/client';

/**
 * The transaction handle drizzle hands to a `db.transaction` callback.
 *
 * Derived from `Db` rather than imported, because drizzle does not export it
 * under a stable name and writing it out by hand would drift from the client.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
