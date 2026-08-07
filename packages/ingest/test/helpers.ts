import type { Db } from '@archive/db/client';

/**
 * Minimal stand-in for the drizzle client: records what would have been inserted
 * and hands back a fixed snapshot id.
 *
 * Deliberately not a real database. What these tests need to pin down is which
 * rows get built and in what order relative to the throw — none of which needs
 * Postgres, and all of which would be slower and flakier through it. The SQL
 * itself is already proven by `pnpm db:migrate` against the live project.
 */

export interface RecordedInsert {
  table: unknown;
  rows: Record<string, unknown>[];
}

export interface FakeDb {
  db: Db;
  inserts: RecordedInsert[];
  committed: () => boolean;
  rowsFor: (table: unknown) => Record<string, unknown>[];
}

export function fakeDb(snapshotId = 42n): FakeDb {
  const inserts: RecordedInsert[] = [];
  let committed = false;

  const tx = {
    insert(table: unknown) {
      return {
        values(rows: Record<string, unknown> | Record<string, unknown>[]) {
          inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });

          // Awaitable, and also chainable into .returning() — both forms are used.
          return {
            returning: (): Promise<{ id: bigint }[]> => Promise.resolve([{ id: snapshotId }]),
            then: <T>(resolve: (value: undefined) => T): Promise<T> =>
              Promise.resolve(undefined).then(resolve),
          };
        },
      };
    },
  };

  const db = {
    transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
      const result = await callback(tx);
      committed = true;
      return result;
    },
  };

  return {
    db: db as unknown as Db,
    inserts,
    committed: () => committed,
    rowsFor: (table: unknown) => inserts.filter((i) => i.table === table).flatMap((i) => i.rows),
  };
}
