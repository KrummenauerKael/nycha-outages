import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Reader, type Tx } from '../src/client';
import { developmentTotals, durationSources, timeSeries } from '../src/metrics';
import { Seeder } from './seed';

/**
 * The metrics, against real Postgres and synthetic history.
 *
 * The archive holds hours of data, not seasons, so nothing here could be
 * verified against real collection for months. Seeding invented timelines is
 * what lets the week/month/season layer ship now and simply fill in later —
 * and it is also the only way to test cases real data may not produce for a
 * year, like an outage spanning a season boundary.
 *
 * Dates are in the past relative to collection starting 2026-08-08, so
 * `least(effective_end, now())` never clamps and the arithmetic is exact.
 * Anything ongoing is asserted as a bound, never an equality, because its
 * duration grows while the test runs.
 */

const TEST_URL = process.env['TEST_DATABASE_URL'];
const describeIfDb = TEST_URL ? describe : describe.skip;

class Rollback extends Error {}

/** 2026-01-29 12:00Z — chosen to straddle the January/February boundary. */
const JAN_29_NOON = new Date('2026-01-29T12:00:00.000Z');

describeIfDb('metrics, against real Postgres', () => {
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
        await fn(tx, new Seeder(tx));
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  /**
   * The apportionment rule, and the reason the whole slicing machinery exists.
   *
   * A 120-hour outage from 29 Jan noon runs to 3 Feb noon: 60 hours in January
   * (2.5 days) and 60 in February. Attributing all 120 to January because that
   * is where it started would name the wrong month as the bad one.
   */
  it('splits an outage across a month boundary by real overlap', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: JAN_29_NOON,
        endedAt: new Date('2026-02-03T12:00:00.000Z'),
        impactResidents: 10,
      });

      const months = await timeSeries(tx as Reader, 'month', { development: seed.development });

      expect(months).toHaveLength(2);
      expect(months[0]?.bucket).toBe('2026-01-01');
      expect(months[1]?.bucket).toBe('2026-02-01');
      expect(months[0]?.outageHours).toBeCloseTo(60, 1);
      expect(months[1]?.outageHours).toBeCloseTo(60, 1);
      // Resident-hours follow the same split: 10 residents x 60 hours.
      expect(months[0]?.residentHours).toBeCloseTo(600, 1);
      expect(months[1]?.residentHours).toBeCloseTo(600, 1);
    });
  });

  /**
   * Counts are per-bucket distinct and deliberately not additive. One outage
   * spanning two months is one outage, listed in both.
   */
  it('counts a spanning outage in both buckets without inventing a second', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: JAN_29_NOON,
        endedAt: new Date('2026-02-03T12:00:00.000Z'),
        impactResidents: 10,
      });

      const months = await timeSeries(tx as Reader, 'month', { development: seed.development });
      expect(months.map((m) => m.outages)).toEqual([1, 1]);

      const totals = await developmentTotals(tx as Reader, { development: seed.development });
      // Still one outage overall, with the full 120 hours.
      expect(totals[0]?.outages).toBe(1);
      expect(totals[0]?.outageHours).toBeCloseTo(120, 1);
    });
  });

  /** Invariant 5: NYCHA's published figure wins over what we measured. */
  it("uses NYCHA's restoration hours in preference to the observed span", async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2026-01-10T00:00:00.000Z'),
        // Observed span is 100 hours, but NYCHA said 6.
        endedAt: new Date('2026-01-14T04:00:00.000Z'),
        restorationHours: 6,
        impactResidents: 1,
      });

      const totals = await developmentTotals(tx as Reader, { development: seed.development });
      const sources = await durationSources(tx as Reader, { development: seed.development });

      expect(totals[0]?.outageHours).toBeCloseTo(6, 1);
      expect(sources.nychaReported).toBe(1);
      expect(sources.observed).toBe(0);
    });
  });

  it('measures the observed span when NYCHA published no figure', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2026-01-10T00:00:00.000Z'),
        endedAt: new Date('2026-01-12T00:00:00.000Z'),
        restorationHours: null,
        impactResidents: 1,
      });

      const totals = await developmentTotals(tx as Reader, { development: seed.development });
      const sources = await durationSources(tx as Reader, { development: seed.development });

      expect(totals[0]?.outageHours).toBeCloseTo(48, 1);
      expect(sources.observed).toBe(1);
      expect(sources.nychaReported).toBe(0);
    });
  });

  /**
   * A restoration time on an open outage is a forecast. Honouring it literally
   * would post resident-hours into weeks that have not happened, so the
   * interval is capped at now.
   */
  it('never projects an ongoing outage past the present', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
        // ~4 years. Uncapped, this would spray hours across future buckets.
        restorationHours: 35_000,
        impactResidents: 1,
      });

      const months = await timeSeries(tx as Reader, 'month', { development: seed.development });
      const last = months.at(-1);

      expect(months.every((m) => m.bucket <= '2026-09-01')).toBe(true);
      expect(last?.ongoingOutages).toBe(1);
    });
  });

  it('flags an outage with no closure as ongoing and a lower bound', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
        impactResidents: 5,
      });

      const totals = await developmentTotals(tx as Reader, { development: seed.development });
      const sources = await durationSources(tx as Reader, { development: seed.development });

      expect(totals[0]?.ongoingOutages).toBe(1);
      expect(sources.ongoing).toBe(1);
      // Started in the past and still running, so strictly positive and growing.
      expect(totals[0]?.outageHours).toBeGreaterThan(0);
    });
  });

  /**
   * The floor rule. A missing impact figure contributes nothing and is counted,
   * so a total can be honestly presented as "at least N".
   */
  it('contributes zero resident-hours for rows with no published figures', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2026-01-10T00:00:00.000Z'),
        endedAt: new Date('2026-01-11T00:00:00.000Z'),
        impactResidents: 10,
      });
      await seed.outage({
        startedAt: new Date('2026-01-10T00:00:00.000Z'),
        endedAt: new Date('2026-01-11T00:00:00.000Z'),
        impactResidents: null,
        impactSource: 'missing',
      });

      const totals = await developmentTotals(tx as Reader, { development: seed.development });

      expect(totals[0]?.outages).toBe(2);
      expect(totals[0]?.outageHours).toBeCloseTo(48, 1);
      // Only the row with a figure contributes: 10 residents x 24 hours.
      expect(totals[0]?.residentHours).toBeCloseTo(240, 1);
      expect(totals[0]?.outagesWithoutImpactFigures).toBe(1);
    });
  });

  /**
   * Season is not a calendar period. NYC's heat season runs 1 October to 31
   * May, and a winter outage must land in one season rather than being split
   * across two calendar years.
   */
  it('assigns October and the following February to the same heat season', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2025-10-05T00:00:00.000Z'),
        endedAt: new Date('2025-10-06T00:00:00.000Z'),
        impactResidents: 1,
      });
      await seed.outage({
        startedAt: new Date('2026-02-05T00:00:00.000Z'),
        endedAt: new Date('2026-02-06T00:00:00.000Z'),
        impactResidents: 1,
      });

      const seasons = await timeSeries(tx as Reader, 'season', { development: seed.development });

      expect(seasons).toHaveLength(1);
      expect(seasons[0]?.bucket).toBe('2025-26');
      expect(seasons[0]?.outages).toBe(2);
    });
  });

  it('places a July outage outside any heat season', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2026-07-05T00:00:00.000Z'),
        endedAt: new Date('2026-07-06T00:00:00.000Z'),
        impactResidents: 1,
      });

      const seasons = await timeSeries(tx as Reader, 'season', { development: seed.development });

      expect(seasons[0]?.bucket).toBe('off-season 2026');
    });
  });

  it('filters by category and by service independently', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: new Date('2026-01-10T00:00:00.000Z'),
        endedAt: new Date('2026-01-11T00:00:00.000Z'),
        category: 'heat_hot_water',
        service: 'hot_water',
        impactResidents: 1,
      });
      await seed.outage({
        startedAt: new Date('2026-01-10T00:00:00.000Z'),
        endedAt: new Date('2026-01-11T00:00:00.000Z'),
        category: 'elevator',
        service: 'elevator',
        impactResidents: 1,
      });

      const all = await developmentTotals(tx as Reader, { development: seed.development });
      const heat = await developmentTotals(tx as Reader, {
        development: seed.development,
        category: 'heat_hot_water',
      });
      const lifts = await developmentTotals(tx as Reader, {
        development: seed.development,
        service: 'elevator',
      });

      expect(all[0]?.outages).toBe(2);
      expect(heat[0]?.outages).toBe(1);
      expect(lifts[0]?.outages).toBe(1);
    });
  });

  it('restricts to a window without counting hours outside it', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: JAN_29_NOON,
        endedAt: new Date('2026-02-03T12:00:00.000Z'),
        impactResidents: 10,
      });

      const februaryOnly = await developmentTotals(tx as Reader, {
        development: seed.development,
        from: new Date('2026-02-01T00:00:00.000Z'),
      });

      // 120 hours total, 60 of them in February.
      expect(februaryOnly[0]?.outageHours).toBeCloseTo(60, 1);
    });
  });

  it('averages hours per outage within a bucket', async () => {
    await inRollback(async (tx, seed) => {
      // 24 hours and 48 hours, wholly inside January: mean 36.
      await seed.outage({
        startedAt: new Date('2026-01-10T00:00:00.000Z'),
        endedAt: new Date('2026-01-11T00:00:00.000Z'),
        impactResidents: 1,
      });
      await seed.outage({
        startedAt: new Date('2026-01-10T00:00:00.000Z'),
        endedAt: new Date('2026-01-12T00:00:00.000Z'),
        impactResidents: 1,
      });

      const months = await timeSeries(tx as Reader, 'month', { development: seed.development });

      expect(months[0]?.averageHoursPerOutage).toBeCloseTo(36, 1);
    });
  });

  /** Weeks, months and seasons must be the same hours grouped differently. */
  it('agrees across granularities on total hours', async () => {
    await inRollback(async (tx, seed) => {
      await seed.outage({
        startedAt: JAN_29_NOON,
        endedAt: new Date('2026-02-03T12:00:00.000Z'),
        impactResidents: 10,
      });

      const sum = async (g: 'week' | 'month' | 'year' | 'season') =>
        (await timeSeries(tx as Reader, g, { development: seed.development })).reduce(
          (total, bucket) => total + bucket.outageHours,
          0,
        );

      const [weeks, months, years, seasons] = await Promise.all([
        sum('week'),
        sum('month'),
        sum('year'),
        sum('season'),
      ]);

      expect(weeks).toBeCloseTo(120, 1);
      expect(months).toBeCloseTo(120, 1);
      expect(years).toBeCloseTo(120, 1);
      expect(seasons).toBeCloseTo(120, 1);
    });
  });
});
