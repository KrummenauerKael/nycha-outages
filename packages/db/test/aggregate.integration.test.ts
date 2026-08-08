import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Reader, type Tx } from '../src/client';
import { aggregate, filterOptions, timeSeries } from '../src/metrics';
import { Seeder } from './seed';

/**
 * The flexible query layer — arbitrary grouping, sorting and filtering.
 *
 * Every dimension and every sort field is exercised because both reach SQL as
 * identifiers rather than as bound parameters. They are mapped through closed
 * unions so caller input cannot become SQL, but that also means a typo in a
 * whitelist map is a runtime syntax error that typechecking cannot see. This
 * suite is what makes those maps safe to extend.
 */

const TEST_URL = process.env['TEST_DATABASE_URL'];
const describeIfDb = TEST_URL ? describe : describe.skip;

class Rollback extends Error {}

const DAY = new Date('2026-01-10T00:00:00.000Z');
const NEXT_DAY = new Date('2026-01-11T00:00:00.000Z');

const DIMENSIONS = ['development', 'borough', 'category', 'service', 'scopeLevel'] as const;
const SORT_FIELDS = [
  'label',
  'outages',
  'outageHours',
  'residentHours',
  'averageHoursPerOutage',
  'outagesWithoutImpactFigures',
  'ongoingOutages',
] as const;

describeIfDb('aggregate, every dimension and sort', () => {
  let db: ReturnType<typeof createDb>['db'];
  let client: ReturnType<typeof createDb>['client'];

  beforeAll(() => {
    ({ db, client } = createDb(TEST_URL));
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  async function inRollback(fn: (tx: Tx, seed: Seeder) => Promise<void>): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        await fn(tx, new Seeder(tx, 'AGG'));
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  it('runs for every dimension', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: DAY,
        endedAt: NEXT_DAY,
        service: 'elevator',
        category: 'elevator',
        impactResidents: 7,
      });

      for (const dimension of DIMENSIONS) {
        const rows = await aggregate(tx as Reader, { dimension, limit: 5 });
        for (const row of rows) {
          expect(typeof row.label, `dimension ${dimension}`).toBe('string');
        }
      }
    });
  });

  it('runs for every sort field in both directions', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({ startedAt: DAY, endedAt: NEXT_DAY, impactResidents: 7 });

      for (const field of SORT_FIELDS) {
        for (const direction of ['asc', 'desc'] as const) {
          const rows = await aggregate(tx as Reader, {
            dimension: 'development',
            sort: { field, direction },
            limit: 5,
          });
          expect(Array.isArray(rows), `${field} ${direction}`).toBe(true);
        }
      }
    });
  });

  it('actually orders by the requested field and direction', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: DAY,
        endedAt: NEXT_DAY,
        impactResidents: 5,
        development: `${seed.development}_LOW`,
      });
      await seed.outage({
        startedAt: DAY,
        endedAt: NEXT_DAY,
        impactResidents: 500,
        development: `${seed.development}_HIGH`,
      });

      const filter = { from: DAY, to: NEXT_DAY };
      const desc = await aggregate(tx as Reader, {
        dimension: 'development',
        filter,
        sort: { field: 'residentHours', direction: 'desc' },
        limit: 500,
      });
      const asc = await aggregate(tx as Reader, {
        dimension: 'development',
        filter,
        sort: { field: 'residentHours', direction: 'asc' },
        limit: 500,
      });

      const mineDesc = desc.filter((r) => r.label.startsWith(seed.development));
      const mineAsc = asc.filter((r) => r.label.startsWith(seed.development));

      expect(mineDesc[0]?.label).toBe(`${seed.development}_HIGH`);
      expect(mineAsc[0]?.label).toBe(`${seed.development}_LOW`);
    });
  });

  it('paginates without overlapping', async () => {
    await inRollback(async (tx, seed) => {
      for (const n of [1, 2, 3]) {
        await seed.outage({
          startedAt: DAY,
          endedAt: NEXT_DAY,
          impactResidents: n * 10,
          development: `${seed.development}_${n}`,
        });
      }

      const common = {
        dimension: 'development',
        filter: { from: DAY, to: NEXT_DAY },
        sort: { field: 'label', direction: 'asc' },
        limit: 1,
      } as const;

      const first = await aggregate(tx as Reader, { ...common, offset: 0 });
      const second = await aggregate(tx as Reader, { ...common, offset: 1 });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0]?.label).not.toBe(second[0]?.label);
    });
  });

  /**
   * Invariant 2. An outage planned for heat and unplanned for elevator is the
   * case that breaks a naive "has a planned service AND has an elevator
   * service" filter — it would report planned elevator work that never existed.
   */
  it('applies service and planned status to the same service row', async () => {
    await inRollback(async (tx, seed) => {
      const snapshotId = await seed.snapshot(DAY);
      const eventId = await seed.event({ snapshotId, startedAt: DAY });
      const observationId = await seed.observation({ snapshotId, eventId, seenAt: DAY });
      await seed.service(observationId, 'heat', true);
      await seed.service(observationId, 'elevator', false);

      const plannedLift = await aggregate(tx as Reader, {
        dimension: 'development',
        filter: { development: seed.development, service: 'elevator', isPlanned: true },
        limit: 5,
      });
      const unplannedLift = await aggregate(tx as Reader, {
        dimension: 'development',
        filter: { development: seed.development, service: 'elevator', isPlanned: false },
        limit: 5,
      });

      expect(plannedLift).toHaveLength(0);
      expect(unplannedLift).toHaveLength(1);
    });
  });

  it('filters to rows NYCHA published no planned marker for', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: DAY,
        endedAt: NEXT_DAY,
        service: 'gas',
        isPlanned: null,
        impactResidents: 1,
      });

      const unmarked = await aggregate(tx as Reader, {
        dimension: 'development',
        filter: { development: seed.development, isPlanned: null },
        limit: 5,
      });

      expect(unmarked).toHaveLength(1);
    });
  });

  it('filters to ongoing outages only', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({ startedAt: new Date('2026-08-01T00:00:00.000Z'), impactResidents: 1 });
      await seed.outage({ startedAt: DAY, endedAt: NEXT_DAY, impactResidents: 1 });

      const ongoing = await aggregate(tx as Reader, {
        dimension: 'development',
        filter: { development: seed.development, ongoingOnly: true },
        limit: 5,
      });

      expect(ongoing[0]?.outages).toBe(1);
      expect(ongoing[0]?.ongoingOutages).toBe(1);
    });
  });

  it('filters by borough and by scope level', async () => {
    await inRollback(async (tx, seed) => {
      const snapshotId = await seed.snapshot(DAY);
      const eventId = await seed.event({
        snapshotId,
        startedAt: DAY,
        borough: `${seed.development}_BORO`,
        scopeLevel: 'sectional',
      });
      await seed.observation({ snapshotId, eventId, seenAt: DAY, impactResidents: 3 });

      const byBorough = await aggregate(tx as Reader, {
        dimension: 'development',
        filter: { borough: `${seed.development}_BORO` },
        limit: 5,
      });
      const bySectional = await aggregate(tx as Reader, {
        dimension: 'development',
        filter: { development: seed.development, scopeLevel: 'sectional' },
        limit: 5,
      });
      const byBuilding = await aggregate(tx as Reader, {
        dimension: 'development',
        filter: { development: seed.development, scopeLevel: 'building' },
        limit: 5,
      });

      expect(byBorough).toHaveLength(1);
      expect(bySectional).toHaveLength(1);
      expect(byBuilding).toHaveLength(0);
    });
  });

  it('reverses the time series when asked', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2026-01-05T00:00:00.000Z'),
        endedAt: new Date('2026-01-06T00:00:00.000Z'),
        impactResidents: 1,
      });
      await seed.outage({
        startedAt: new Date('2026-03-05T00:00:00.000Z'),
        endedAt: new Date('2026-03-06T00:00:00.000Z'),
        impactResidents: 1,
      });

      const asc = await timeSeries(tx as Reader, 'month', { development: seed.development }, 'asc');
      const desc = await timeSeries(
        tx as Reader,
        'month',
        { development: seed.development },
        'desc',
      );

      expect(asc.map((b) => b.bucket)).toEqual(['2026-01-01', '2026-03-01']);
      expect(desc.map((b) => b.bucket)).toEqual(['2026-03-01', '2026-01-01']);
    });
  });

  it('offers only filter values that exist in the data', async () => {
    const options = await filterOptions(db);

    expect(options.developments.length).toBeGreaterThan(0);
    expect(options.services.length).toBeGreaterThan(0);
    for (const list of Object.values(options)) {
      expect(list.every((value: string) => value.length > 0)).toBe(true);
    }
  });
});
