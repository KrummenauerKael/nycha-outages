import { schema } from '@archive/db';
import type { Db } from '@archive/db/client';
import type {
  ChildRow,
  ImpactFigures,
  OutageObservation,
  ParseResult,
  Service,
} from '@archive/parser';

/**
 * Minimal stand-in for the drizzle client: records what would have been written
 * and returns whatever the test told it to read.
 *
 * Deliberately not a real database. What these tests pin down is which rows get
 * built, which get skipped, and what happens relative to the throw — none of
 * which needs Postgres, and all of which would be slower and flakier through it.
 * The SQL itself is proven by `pnpm db:migrate` against the live project.
 */

export interface RecordedInsert {
  table: unknown;
  rows: Record<string, unknown>[];
}

export interface RecordedUpdate {
  table: unknown;
  set: Record<string, unknown>;
}

interface QueryChain {
  where: () => QueryChain;
  orderBy: () => QueryChain;
  then: <R>(resolve: (rows: Record<string, unknown>[]) => R) => Promise<R>;
}

function query(rows: Record<string, unknown>[]): QueryChain {
  const chain: QueryChain = {
    where: () => chain,
    orderBy: () => chain,
    then: (resolve) => Promise.resolve(rows).then(resolve),
  };
  return chain;
}

export interface FakeDbOptions {
  snapshotId?: bigint;
  /** Rows a `select` from a given table should return, keyed by the table object. */
  selectRows?: Map<unknown, Record<string, unknown>[]>;
  /** Event ids the open-events raw query should report. */
  openEventIds?: bigint[];
}

export interface FakeDb {
  db: Db;
  inserts: RecordedInsert[];
  updates: RecordedUpdate[];
  committed: () => boolean;
  rowsFor: (table: unknown) => Record<string, unknown>[];
  updatesFor: (table: unknown) => RecordedUpdate[];
}

export function fakeDb(options: FakeDbOptions | bigint = {}): FakeDb {
  const opts: FakeDbOptions = typeof options === 'bigint' ? { snapshotId: options } : options;
  const snapshotId = opts.snapshotId ?? 42n;
  const selectRows = opts.selectRows ?? new Map<unknown, Record<string, unknown>[]>();
  const openEventIds = opts.openEventIds ?? [];

  const inserts: RecordedInsert[] = [];
  const updates: RecordedUpdate[] = [];
  let committed = false;
  let nextId = 1000n;

  const tx = {
    select(_fields: Record<string, unknown>) {
      return {
        from: (table: unknown) => query(selectRows.get(table) ?? []),
      };
    },

    insert(table: unknown) {
      return {
        values(rows: Record<string, unknown> | Record<string, unknown>[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          inserts.push({ table, rows: list });

          return {
            // Echoes back the requested keys per row, minting an id for each.
            // Keys match the drizzle property names used in the values objects,
            // which is what makes this work without a schema lookup.
            returning: (fields?: Record<string, unknown>) =>
              Promise.resolve(
                list.map((row) => {
                  // The snapshot's id is fixed so tests can assert on it; every
                  // other table gets a sequence.
                  const id = table === schema.snapshot ? snapshotId : nextId++;
                  const out: Record<string, unknown> = {};
                  for (const key of Object.keys(fields ?? { id: true })) {
                    out[key] = key === 'id' ? id : row[key];
                  }
                  return out;
                }),
              ),
            then: <R>(resolve: (value: undefined) => R): Promise<R> =>
              Promise.resolve(undefined).then(resolve),
          };
        },
      };
    },

    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          updates.push({ table, set: values });
          const chain = {
            where: () => chain,
            then: <R>(resolve: (value: undefined) => R): Promise<R> =>
              Promise.resolve(undefined).then(resolve),
          };
          return chain;
        },
      };
    },

    /** Only the open-events query uses raw SQL. */
    execute: () => Promise.resolve(openEventIds.map((id) => ({ event_id: id }))),
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
    updates,
    committed: () => committed,
    rowsFor: (table: unknown) => inserts.filter((i) => i.table === table).flatMap((i) => i.rows),
    updatesFor: (table: unknown) => updates.filter((u) => u.table === table),
  };
}

/** Minimal parsed row, for tests that care about identity rather than content. */
export function observation(overrides: Partial<OutageObservation> = {}): OutageObservation {
  const impact: ImpactFigures = { buildings: 1, units: 10, residents: 25 };
  const services: Service[] = ['heat'];

  return {
    category: 'heat_hot_water',
    subTable: 'current',
    rowIndex: 0,
    developmentRaw: 'SMITH',
    buildingRaw: null,
    addressRaw: '10 Catherine Slip',
    addressDisplayed: true,
    boroughRaw: 'Manhattan',
    scopeLevel: 'entire_development',
    isSectional: false,
    services,
    isPlannedByService: { heat: false },
    partialServiceByService: {},
    reportDateRaw: '8/6/2026 3:00:00 PM',
    scheduledDateRaw: null,
    status: 'IN PROGRESS',
    restorationHours: 5,
    locationRaw: null,
    impact,
    impactSource: 'row',
    children: [] as ChildRow[],
    ...overrides,
  };
}

export function parseResultOf(observations: OutageObservation[]): ParseResult {
  return {
    parserVersion: '1.0.0',
    summaries: [],
    observations,
    counts: [],
    warnings: [],
  };
}
