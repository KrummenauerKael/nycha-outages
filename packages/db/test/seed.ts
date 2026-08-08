import type { Category, ImpactSource, ScopeLevel, Service } from '@archive/parser';
import type { Tx } from '../src/client';
import { observationService, outageEvent, outageObservation, snapshot } from '../src/schema';

/**
 * Fixture builder for the integration tests.
 *
 * Every method takes a transaction that the caller always rolls back, so this
 * can be pointed at the live archive without leaving anything behind.
 *
 * Names are scoped per instance. The archive is not empty, and the aggregate
 * queries see production rows too, so assertions have to be able to say "the
 * rows this test made" rather than "all rows".
 */
export class Seeder {
  /** Unique per instance so concurrent runs cannot collide. */
  readonly development: string;
  private hashCounter = 0;

  constructor(
    private readonly tx: Tx,
    label = 'SEED',
  ) {
    this.development = `__TEST_${label}_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  }

  /** Distinct 64-char hex, which is all the identity/content columns require. */
  private hash(): string {
    return String(this.hashCounter++).padStart(64, 'a');
  }

  async snapshot(fetchedAt: Date): Promise<bigint> {
    const [row] = await this.tx
      .insert(snapshot)
      .values({
        fetchedAt,
        url: 'https://example.invalid/test',
        httpStatus: 200,
        attempts: 1,
        sha256: this.hash(),
        countsMatched: true,
        parserVersion: 'test',
      })
      .returning({ id: snapshot.id });
    return row!.id;
  }

  async event(opts: {
    snapshotId: bigint;
    startedAt: Date;
    development?: string;
    category?: Category;
    scopeLevel?: ScopeLevel;
    borough?: string;
  }): Promise<bigint> {
    const [row] = await this.tx
      .insert(outageEvent)
      .values({
        identityHash: this.hash(),
        category: opts.category ?? 'heat_hot_water',
        subTable: 'current',
        developmentRaw: opts.development ?? this.development,
        scopeLevel: opts.scopeLevel ?? 'entire_development',
        isSectional: false,
        boroughRaw: opts.borough ?? 'TEST_BOROUGH',
        servicesKey: 'hot_water',
        firstSeenSnapshotId: opts.snapshotId,
        firstSeenAt: opts.startedAt,
        lastSeenSnapshotId: opts.snapshotId,
        lastSeenAt: opts.startedAt,
      })
      .returning({ id: outageEvent.id });
    return row!.id;
  }

  async observation(opts: {
    snapshotId: bigint;
    eventId: bigint;
    seenAt: Date;
    isPresent?: boolean;
    restorationHours?: number | null;
    impactResidents?: number | null;
    impactSource?: ImpactSource;
    status?: string | null;
  }): Promise<bigint> {
    const [row] = await this.tx
      .insert(outageObservation)
      .values({
        eventId: opts.eventId,
        contentHash: this.hash(),
        isPresent: opts.isPresent ?? true,
        firstSeenSnapshotId: opts.snapshotId,
        firstSeenAt: opts.seenAt,
        lastSeenSnapshotId: opts.snapshotId,
        lastSeenAt: opts.seenAt,
        addressDisplayed: true,
        status: opts.status ?? 'IN PROGRESS',
        restorationHours: opts.restorationHours ?? null,
        impactResidents: opts.impactResidents ?? null,
        impactSource: opts.impactSource ?? 'row',
        rowIndex: 0,
        parserVersion: 'test',
      })
      .returning({ id: outageObservation.id });
    return row!.id;
  }

  async service(
    observationId: bigint,
    service: Service,
    isPlanned: boolean | null,
    isPartialService: boolean | null = null,
  ): Promise<void> {
    await this.tx
      .insert(observationService)
      .values({ observationId, service, isPlanned, isPartialService });
  }

  /**
   * A whole outage in one call: the event, its current version, and — when
   * `endedAt` is given — the absence record that closes it.
   *
   * Omitting `endedAt` leaves the outage ongoing, which is what makes its
   * duration a lower bound rather than a measurement.
   */
  async outage(opts: {
    startedAt: Date;
    endedAt?: Date;
    restorationHours?: number | null;
    impactResidents?: number | null;
    impactSource?: ImpactSource;
    category?: Category;
    service?: Service;
    isPlanned?: boolean | null;
    development?: string;
    borough?: string;
  }): Promise<bigint> {
    const snapshotId = await this.snapshot(opts.startedAt);
    const eventId = await this.event({
      snapshotId,
      startedAt: opts.startedAt,
      ...(opts.development !== undefined && { development: opts.development }),
      ...(opts.category !== undefined && { category: opts.category }),
      ...(opts.borough !== undefined && { borough: opts.borough }),
    });

    const observationId = await this.observation({
      snapshotId,
      eventId,
      seenAt: opts.startedAt,
      restorationHours: opts.restorationHours ?? null,
      impactResidents: opts.impactResidents ?? null,
      impactSource: opts.impactSource ?? 'row',
    });

    if (opts.service) {
      /**
       * Not `?? false`. `null` is a meaningful value here — it is how NYCHA
       * publishing no planned marker is recorded, and every gas row has it —
       * and `??` would quietly convert it to `false`, seeding "unplanned" and
       * making the unmarked case impossible to test.
       */
      const isPlanned = opts.isPlanned === undefined ? false : opts.isPlanned;
      await this.service(observationId, opts.service, isPlanned);
    }

    if (opts.endedAt) {
      const closingSnapshot = await this.snapshot(opts.endedAt);
      await this.observation({
        snapshotId: closingSnapshot,
        eventId,
        seenAt: opts.endedAt,
        isPresent: false,
        impactSource: opts.impactSource ?? 'row',
      });
    }

    return eventId;
  }
}
