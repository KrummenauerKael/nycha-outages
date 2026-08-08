import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Reader, type Tx } from '../src/client';
import {
  archiveHealth,
  currentCountsByService,
  currentLoadByDevelopment,
  currentOutages,
  eventTimeline,
} from '../src/queries';
import { observationService, outageEvent, outageObservation, snapshot } from '../src/schema';

/**
 * Integration tests for the read layer, against real Postgres.
 *
 * **Why these exist.** Every other test in this repo is pure — dependencies are
 * injected and no connection is ever opened. On the day the archive went live,
 * three bugs shipped past a fully green suite, and all three lived in exactly
 * the seam those tests cannot reach:
 *
 *   1. `createDb` throwing past its own error handling (an empty-bodied 500)
 *   2. the same throw in a page, bypassing its error state
 *   3. `sql<Date>` returning the driver's raw string, so `.toISOString()` threw
 *
 * The third is the one that matters here, and it is the reason these run
 * against a real database with the real driver rather than a mock or an
 * in-memory Postgres. `sql<T>` is a **type assertion with no runtime effect**;
 * whether a value arrives as a `Date` or a `string` is decided by
 * postgres.js + drizzle's decoders, so only postgres.js can prove it. A
 * different driver would pass these tests while production still broke.
 *
 * **Safety.** Every test runs inside a transaction that is always rolled back,
 * so pointing `TEST_DATABASE_URL` at the live archive leaves nothing behind.
 * The variable is deliberately separate from `DATABASE_URL`: running the suite
 * should never touch the archive by accident, only by explicit instruction.
 */

const TEST_URL = process.env['TEST_DATABASE_URL'];

/** Thrown to roll back. Never escapes `inRollback`. */
class Rollback extends Error {}

/**
 * Scopes assertions to rows this run created.
 *
 * The archive is not empty — the aggregate queries see production rows too — so
 * a fixture development name has to be unique per run or the counts below would
 * describe whatever NYCHA published this hour.
 */
const DEV = `__TEST_DEV_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

/**
 * Far enough forward that `max(fetched_at)` is certainly ours, which makes the
 * `lastFetchedAt` assertion exact instead of a delta. Rolled back regardless.
 */
const FUTURE = new Date('2099-01-01T00:00:00.000Z');

const describeIfDb = TEST_URL ? describe : describe.skip;

if (!TEST_URL) {
  console.warn(
    '\n  SKIPPED: read-layer integration tests need TEST_DATABASE_URL.\n' +
      '  Safe to point at the live archive — every test rolls back.\n' +
      '  pnpm test:integration loads it from .env.local.\n',
  );
}

describeIfDb('read layer, against real Postgres', () => {
  let db: ReturnType<typeof createDb>['db'];
  let client: ReturnType<typeof createDb>['client'];

  beforeAll(() => {
    ({ db, client } = createDb(TEST_URL));
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  /** Runs `fn` in a transaction and always rolls it back. */
  async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  let hashCounter = 0;
  const hash = (): string => String(hashCounter++).padStart(64, 'f');

  async function seedSnapshot(tx: Tx, fetchedAt = FUTURE): Promise<bigint> {
    const [row] = await tx
      .insert(snapshot)
      .values({
        fetchedAt,
        url: 'https://example.invalid/test',
        httpStatus: 200,
        attempts: 1,
        sha256: hash(),
        countsMatched: true,
        parserVersion: 'test',
      })
      .returning({ id: snapshot.id });
    return row!.id;
  }

  interface EventSpec {
    snapshotId: bigint;
    development?: string;
    category?: 'heat_hot_water' | 'elevator' | 'electric' | 'gas';
    scopeLevel?: 'entire_development' | 'building' | 'sectional' | 'unspecified';
  }

  async function seedEvent(tx: Tx, spec: EventSpec): Promise<bigint> {
    const [row] = await tx
      .insert(outageEvent)
      .values({
        identityHash: hash(),
        category: spec.category ?? 'heat_hot_water',
        subTable: 'current',
        developmentRaw: spec.development ?? DEV,
        scopeLevel: spec.scopeLevel ?? 'entire_development',
        isSectional: false,
        boroughRaw: 'TEST_BOROUGH',
        servicesKey: 'hot_water',
        firstSeenSnapshotId: spec.snapshotId,
        firstSeenAt: FUTURE,
        lastSeenSnapshotId: spec.snapshotId,
        lastSeenAt: FUTURE,
      })
      .returning({ id: outageEvent.id });
    return row!.id;
  }

  interface ObservationSpec {
    snapshotId: bigint;
    eventId: bigint;
    isPresent?: boolean;
    seenAt?: Date;
    restorationHours?: number | null;
    impactResidents?: number | null;
    impactSource?: 'row' | 'children_rollup' | 'missing';
    status?: string | null;
  }

  async function seedObservation(tx: Tx, spec: ObservationSpec): Promise<bigint> {
    const seenAt = spec.seenAt ?? FUTURE;
    const [row] = await tx
      .insert(outageObservation)
      .values({
        eventId: spec.eventId,
        contentHash: hash(),
        isPresent: spec.isPresent ?? true,
        firstSeenSnapshotId: spec.snapshotId,
        firstSeenAt: seenAt,
        lastSeenSnapshotId: spec.snapshotId,
        lastSeenAt: seenAt,
        addressDisplayed: true,
        status: spec.status ?? 'IN PROGRESS',
        restorationHours: spec.restorationHours ?? null,
        impactResidents: spec.impactResidents ?? null,
        impactSource: spec.impactSource ?? 'row',
        rowIndex: 0,
        parserVersion: 'test',
      })
      .returning({ id: outageObservation.id });
    return row!.id;
  }

  async function seedService(
    tx: Tx,
    observationId: bigint,
    service: 'heat' | 'hot_water' | 'water' | 'elevator' | 'electric' | 'gas',
    isPlanned: boolean | null,
  ): Promise<void> {
    await tx.insert(observationService).values({ observationId, service, isPlanned });
  }

  /**
   * The regression that took the dashboard down minutes after the first
   * snapshot. Asserting `instanceof Date` rather than a value, because the
   * declared type said Date and the driver produced a string — and TypeScript
   * cannot see the difference.
   */
  it('returns real Date objects from aggregates, not driver strings', async () => {
    await inRollback(async (tx) => {
      await seedSnapshot(tx);
      const health = await archiveHealth(tx as Reader);

      expect(health.lastFetchedAt).toBeInstanceOf(Date);
      expect(health.firstFetchedAt).toBeInstanceOf(Date);
      // The operation the page actually performs, and the one that threw.
      expect(() => health.lastFetchedAt?.toISOString()).not.toThrow();
      expect(health.lastFetchedAt?.toISOString()).toBe(FUTURE.toISOString());
      expect(health.snapshots).toBeGreaterThan(0);
      expect(typeof health.snapshots).toBe('number');
    });
  });

  it('reports an unmatched-count snapshot in countMismatches', async () => {
    await inRollback(async (tx) => {
      const before = await archiveHealth(tx as Reader);
      await tx.insert(snapshot).values({
        fetchedAt: FUTURE,
        url: 'https://example.invalid/test',
        httpStatus: 200,
        attempts: 1,
        sha256: hash(),
        countsMatched: false,
        parserVersion: 'test',
      });
      const after = await archiveHealth(tx as Reader);

      expect(after.countMismatches).toBe(before.countMismatches + 1);
    });
  });

  it('returns an open outage with its per-service flags', async () => {
    await inRollback(async (tx) => {
      const snapshotId = await seedSnapshot(tx);
      const eventId = await seedEvent(tx, { snapshotId });
      const observationId = await seedObservation(tx, {
        snapshotId,
        eventId,
        restorationHours: 533,
        impactResidents: 120,
      });
      await seedService(tx, observationId, 'hot_water', false);

      const rows = await currentOutages(tx as Reader, { development: DEV });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        development: DEV,
        category: 'heat_hot_water',
        // Invariant 5: read, never derived, and no 24-hour ceiling.
        restorationHours: 533,
        impactResidents: 120,
      });
      expect(rows[0]?.firstSeenAt).toBeInstanceOf(Date);
      expect(rows[0]?.services).toEqual([
        { service: 'hot_water', isPlanned: false, isPartialService: null },
      ]);
    });
  });

  /**
   * Absence is a version, not a missing row. If this regresses, every outage
   * ever recorded stays "currently open" forever and the dashboard becomes a
   * monotonically growing lie.
   */
  it('excludes an event whose latest version records absence', async () => {
    await inRollback(async (tx) => {
      const snapshotId = await seedSnapshot(tx);
      const eventId = await seedEvent(tx, { snapshotId });
      await seedObservation(tx, {
        snapshotId,
        eventId,
        seenAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      await seedObservation(tx, {
        snapshotId,
        eventId,
        isPresent: false,
        seenAt: new Date('2099-01-02T00:00:00.000Z'),
      });

      const rows = await currentOutages(tx as Reader, { development: DEV });

      expect(rows).toHaveLength(0);
    });
  });

  it('reads the latest version, not the first', async () => {
    await inRollback(async (tx) => {
      const snapshotId = await seedSnapshot(tx);
      const eventId = await seedEvent(tx, { snapshotId });
      await seedObservation(tx, {
        snapshotId,
        eventId,
        status: 'OLD',
        impactResidents: 10,
        seenAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      const newer = await seedObservation(tx, {
        snapshotId,
        eventId,
        status: 'CURRENT',
        impactResidents: 999,
        seenAt: new Date('2099-01-03T00:00:00.000Z'),
      });
      await seedService(tx, newer, 'water', true);

      const rows = await currentOutages(tx as Reader, { development: DEV });

      expect(rows[0]?.status).toBe('CURRENT');
      // NYCHA revises impact figures mid-outage; the revision must win.
      expect(rows[0]?.impactResidents).toBe(999);
    });
  });

  /**
   * Invariant 2. A regression that folded unmarked rows into either bucket
   * would silently attribute a planned status to all 58 gas rows.
   */
  it('splits planned, unplanned and unmarked without merging them', async () => {
    await inRollback(async (tx) => {
      const before = new Map(
        (await currentCountsByService(tx as Reader)).map((r) => [r.service, r]),
      );

      const snapshotId = await seedSnapshot(tx);
      for (const flag of [true, false, null] as const) {
        const eventId = await seedEvent(tx, { snapshotId });
        const observationId = await seedObservation(tx, { snapshotId, eventId });
        await seedService(tx, observationId, 'elevator', flag);
      }

      const after = new Map(
        (await currentCountsByService(tx as Reader)).map((r) => [r.service, r]),
      );
      const b = before.get('elevator') ?? { planned: 0, unplanned: 0, unmarked: 0 };
      const a = after.get('elevator');

      expect(a?.planned).toBe(b.planned + 1);
      expect(a?.unplanned).toBe(b.unplanned + 1);
      // The one a careless `coalesce` would destroy.
      expect(a?.unmarked).toBe(b.unmarked + 1);
    });
  });

  it('sums residents per development and counts rows with no figures', async () => {
    await inRollback(async (tx) => {
      const snapshotId = await seedSnapshot(tx);

      for (const residents of [100, 250]) {
        const eventId = await seedEvent(tx, { snapshotId });
        await seedObservation(tx, { snapshotId, eventId, impactResidents: residents });
      }
      const silentEvent = await seedEvent(tx, { snapshotId });
      await seedObservation(tx, {
        snapshotId,
        eventId: silentEvent,
        impactResidents: null,
        impactSource: 'missing',
      });

      const rows = await currentLoadByDevelopment(tx as Reader, 5000);
      const mine = rows.find((r) => r.development === DEV);

      expect(mine).toBeDefined();
      expect(mine?.openOutages).toBe(3);
      // A floor, not a total — the silent row contributes nothing.
      expect(mine?.residentsAffected).toBe(350);
      expect(mine?.withoutImpactFigures).toBe(1);
      expect(mine?.borough).toBe('TEST_BOROUGH');
    });
  });

  it('returns an event timeline oldest first, ending with the absence', async () => {
    await inRollback(async (tx) => {
      const snapshotId = await seedSnapshot(tx);
      const eventId = await seedEvent(tx, { snapshotId });
      await seedObservation(tx, {
        snapshotId,
        eventId,
        status: 'FIRST',
        seenAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      await seedObservation(tx, {
        snapshotId,
        eventId,
        status: 'SECOND',
        seenAt: new Date('2099-01-02T00:00:00.000Z'),
      });
      await seedObservation(tx, {
        snapshotId,
        eventId,
        isPresent: false,
        seenAt: new Date('2099-01-03T00:00:00.000Z'),
      });

      const timeline = await eventTimeline(tx as Reader, eventId);

      expect(timeline.map((v) => v.status)).toEqual(['FIRST', 'SECOND', 'IN PROGRESS']);
      expect(timeline.at(-1)?.isPresent).toBe(false);
      expect(timeline[0]?.firstSeenAt).toBeInstanceOf(Date);
    });
  });

  /**
   * Proves the rollback works. If this ever fails, every test above has been
   * writing into whatever database TEST_DATABASE_URL points at.
   */
  it('leaves nothing behind', async () => {
    await inRollback(async (tx) => {
      const snapshotId = await seedSnapshot(tx);
      await seedEvent(tx, { snapshotId });
    });

    const leaked = await currentOutages(db, { development: DEV });
    expect(leaked).toHaveLength(0);
  });
});
