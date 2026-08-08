import type { Category, ImpactSource, ScopeLevel, Service, SubTable } from '@archive/parser';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import { observationService, outageEvent, outageObservation, snapshot } from './schema';

/**
 * Read layer for the dashboard.
 *
 * Everything here is read-only and derives from the observation timeline rather
 * than from any denormalised "current state" table, because there isn't one and
 * shouldn't be: the archive's value is the history, and a cached present tense
 * would be one more thing to keep true.
 *
 * Three rules the ingest side enforces and every query here has to respect:
 *
 * - **Invariant 2.** Planned and unplanned are per service, not per row, and
 *   are never aggregated together. One outage can be planned for heat and
 *   unplanned for elevator, so any count that mixes them is meaningless. The
 *   flags live on `observation_service` and the grouping functions below split
 *   on them rather than summing across.
 * - **Invariant 5.** `restoration_hours` is NYCHA's own figure and is
 *   authoritative. Nothing here derives a duration from the gap between
 *   observations, and nothing assumes a 24-hour ceiling — 533 has been seen.
 * - **Absence is a fact.** An outage ending is recorded as an observation with
 *   `is_present = false`, not as a missing row, so "currently out" is the
 *   latest version being present rather than the absence of a newer one.
 *
 * Deliberately absent: cumulative resident-hours. That metric is the point of
 * the whole archive and it needs its definition settled in the open — which
 * observation bounds a period, how a revised impact figure is apportioned,
 * what a `missing` impact source contributes. Guessing at it here and having
 * the dashboard quietly render the guess is the one failure mode worth
 * designing against.
 */

/** The most recent version of each event, by insertion order within the event. */
function latestObservation(db: Db) {
  return db.$with('latest_observation').as(
    db
      .select({
        id: outageObservation.id,
        eventId: outageObservation.eventId,
        isPresent: outageObservation.isPresent,
        status: outageObservation.status,
        restorationHours: outageObservation.restorationHours,
        impactBuildings: outageObservation.impactBuildings,
        impactUnits: outageObservation.impactUnits,
        impactResidents: outageObservation.impactResidents,
        impactSource: outageObservation.impactSource,
        firstSeenAt: outageObservation.firstSeenAt,
        lastSeenAt: outageObservation.lastSeenAt,
        rank: sql<number>`row_number() over (
          partition by ${outageObservation.eventId}
          order by ${outageObservation.firstSeenAt} desc, ${outageObservation.id} desc
        )`.as('rank'),
      })
      .from(outageObservation),
  );
}

export interface ServiceFlags {
  service: Service;
  /** Null for gas, which publishes no planned marker at all. */
  isPlanned: boolean | null;
  /** Real signal, elevator and electric only. */
  isPartialService: boolean | null;
}

export interface CurrentOutage {
  eventId: bigint;
  category: Category;
  subTable: SubTable;
  development: string;
  building: string | null;
  address: string | null;
  borough: string | null;
  scopeLevel: ScopeLevel;
  isSectional: boolean;
  status: string | null;
  /** NYCHA's own figure. Never derived here. May exceed 24. */
  restorationHours: number | null;
  impactBuildings: number | null;
  impactUnits: number | null;
  impactResidents: number | null;
  impactSource: ImpactSource;
  firstSeenAt: Date;
  lastSeenAt: Date;
  services: ServiceFlags[];
}

export interface CurrentOutageFilter {
  category?: Category;
  /** Matched exactly against `development_raw`; entity resolution is #8. */
  development?: string;
  limit?: number;
}

/**
 * Every outage whose latest version is still present, newest activity first.
 *
 * Services are fetched separately and stitched in rather than aggregated in
 * SQL. One extra round trip, and the per-service planned/partial flags stay
 * plainly visible instead of being folded into a JSON blob that a later reader
 * could mistake for row-level state.
 */
export async function currentOutages(
  db: Db,
  filter: CurrentOutageFilter = {},
): Promise<CurrentOutage[]> {
  const latest = latestObservation(db);

  const conditions = [eq(latest.rank, 1), eq(latest.isPresent, true)];
  if (filter.category) conditions.push(eq(outageEvent.category, filter.category));
  if (filter.development) conditions.push(eq(outageEvent.developmentRaw, filter.development));

  const rows = await db
    .with(latest)
    .select({
      eventId: outageEvent.id,
      observationId: latest.id,
      category: outageEvent.category,
      subTable: outageEvent.subTable,
      development: outageEvent.developmentRaw,
      building: outageEvent.buildingRaw,
      address: outageEvent.addressRaw,
      borough: outageEvent.boroughRaw,
      scopeLevel: outageEvent.scopeLevel,
      isSectional: outageEvent.isSectional,
      status: latest.status,
      restorationHours: latest.restorationHours,
      impactBuildings: latest.impactBuildings,
      impactUnits: latest.impactUnits,
      impactResidents: latest.impactResidents,
      impactSource: latest.impactSource,
      firstSeenAt: outageEvent.firstSeenAt,
      lastSeenAt: outageEvent.lastSeenAt,
    })
    .from(latest)
    .innerJoin(outageEvent, eq(outageEvent.id, latest.eventId))
    .where(and(...conditions))
    .orderBy(desc(outageEvent.lastSeenAt))
    .limit(filter.limit ?? 500);

  if (rows.length === 0) return [];

  const services = await servicesFor(
    db,
    rows.map((r) => r.observationId),
  );

  return rows.map(({ observationId, ...row }) => ({
    ...row,
    services: services.get(observationId) ?? [],
  }));
}

/** Per-service flags for a set of observations, keyed by observation id. */
async function servicesFor(db: Db, observationIds: bigint[]): Promise<Map<bigint, ServiceFlags[]>> {
  const rows = await db
    .select({
      observationId: observationService.observationId,
      service: observationService.service,
      isPlanned: observationService.isPlanned,
      isPartialService: observationService.isPartialService,
    })
    .from(observationService)
    .where(inArray(observationService.observationId, observationIds))
    .orderBy(asc(observationService.service));

  const byObservation = new Map<bigint, ServiceFlags[]>();
  for (const { observationId, ...flags } of rows) {
    const existing = byObservation.get(observationId);
    if (existing) existing.push(flags);
    else byObservation.set(observationId, [flags]);
  }
  return byObservation;
}

export interface ServiceBreakdown {
  service: Service;
  /**
   * Split, never summed. `null` counts rows where NYCHA published no marker —
   * every gas row, and any row where the marker was absent. Folding those into
   * either bucket would invent a fact.
   */
  planned: number;
  unplanned: number;
  unmarked: number;
}

/**
 * How many outages are currently open per service, split by planned status.
 *
 * The unit is the event, not the row: an outage affecting heat and hot water
 * counts once under each. Summing this column would double count, which is why
 * there is no total here for a caller to reach for by accident.
 */
export async function currentCountsByService(db: Db): Promise<ServiceBreakdown[]> {
  const latest = latestObservation(db);

  const rows = await db
    .with(latest)
    .select({
      service: observationService.service,
      planned: sql<number>`count(*) filter (where ${observationService.isPlanned} is true)::int`,
      unplanned: sql<number>`count(*) filter (where ${observationService.isPlanned} is false)::int`,
      unmarked: sql<number>`count(*) filter (where ${observationService.isPlanned} is null)::int`,
    })
    .from(latest)
    .innerJoin(observationService, eq(observationService.observationId, latest.id))
    .where(and(eq(latest.rank, 1), eq(latest.isPresent, true)))
    .groupBy(observationService.service)
    .orderBy(asc(observationService.service));

  return rows;
}

export interface DevelopmentLoad {
  development: string;
  borough: string | null;
  openOutages: number;
  /**
   * Summed across currently-open events at this development. Rows whose
   * `impact_source` is `missing` contribute nothing, so this is a floor, not a
   * measured total — `withoutImpactFigures` says how many rows were silent.
   */
  residentsAffected: number;
  withoutImpactFigures: number;
}

/**
 * Currently-open outages grouped by development, worst first.
 *
 * Deliberately not deduplicated across the sub-table split: one place can
 * legitimately appear as several events (see the note on `outage_event`), and
 * collapsing them here would need the entity resolution that is deliverable 8.
 */
export async function currentLoadByDevelopment(db: Db, limit = 100): Promise<DevelopmentLoad[]> {
  const latest = latestObservation(db);

  return db
    .with(latest)
    .select({
      development: outageEvent.developmentRaw,
      borough: sql<string | null>`max(${outageEvent.boroughRaw})`,
      openOutages: sql<number>`count(*)::int`,
      residentsAffected: sql<number>`coalesce(sum(${latest.impactResidents}), 0)::int`,
      withoutImpactFigures: sql<number>`count(*) filter (where ${latest.impactSource} = 'missing')::int`,
    })
    .from(latest)
    .innerJoin(outageEvent, eq(outageEvent.id, latest.eventId))
    .where(and(eq(latest.rank, 1), eq(latest.isPresent, true)))
    .groupBy(outageEvent.developmentRaw)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}

export interface TimelineVersion {
  observationId: bigint;
  isPresent: boolean;
  status: string | null;
  restorationHours: number | null;
  impactBuildings: number | null;
  impactUnits: number | null;
  impactResidents: number | null;
  impactSource: ImpactSource;
  firstSeenAt: Date;
  lastSeenAt: Date;
  parserVersion: string;
  services: ServiceFlags[];
}

/**
 * Every version of one event, oldest first.
 *
 * This is the archive's actual product in miniature — what NYCHA said, when
 * they said it, and when they stopped saying it. A final entry with
 * `isPresent: false` is the outage ending; its absence means still open.
 */
export async function eventTimeline(db: Db, eventId: bigint): Promise<TimelineVersion[]> {
  const rows = await db
    .select({
      observationId: outageObservation.id,
      isPresent: outageObservation.isPresent,
      status: outageObservation.status,
      restorationHours: outageObservation.restorationHours,
      impactBuildings: outageObservation.impactBuildings,
      impactUnits: outageObservation.impactUnits,
      impactResidents: outageObservation.impactResidents,
      impactSource: outageObservation.impactSource,
      firstSeenAt: outageObservation.firstSeenAt,
      lastSeenAt: outageObservation.lastSeenAt,
      parserVersion: outageObservation.parserVersion,
    })
    .from(outageObservation)
    .where(eq(outageObservation.eventId, eventId))
    .orderBy(asc(outageObservation.firstSeenAt), asc(outageObservation.id));

  if (rows.length === 0) return [];

  const services = await servicesFor(
    db,
    rows.map((r) => r.observationId),
  );

  return rows.map((row) => ({ ...row, services: services.get(row.observationId) ?? [] }));
}

export interface ArchiveHealth {
  snapshots: number;
  firstFetchedAt: Date | null;
  lastFetchedAt: Date | null;
  /** Snapshots where NYCHA's printed count disagreed with ours (invariant 3). */
  countMismatches: number;
  /** Still holding raw HTML — bounded by the retention window, not forever. */
  rawRetained: number;
}

/**
 * Whether the archive is actually archiving.
 *
 * Worth surfacing in the UI rather than keeping as an ops detail: a dataset
 * whose credibility rests on unbroken hourly coverage should show its own gaps.
 * `lastFetchedAt` drifting past an hour means collection has stopped, and that
 * is the single most important thing this application can tell anyone.
 */
export async function archiveHealth(db: Db): Promise<ArchiveHealth> {
  const [row] = await db
    .select({
      snapshots: sql<number>`count(*)::int`,
      firstFetchedAt: sql<Date | null>`min(${snapshot.fetchedAt})`,
      lastFetchedAt: sql<Date | null>`max(${snapshot.fetchedAt})`,
      countMismatches: sql<number>`count(*) filter (where ${snapshot.countsMatched} is false)::int`,
      rawRetained: sql<number>`count(*) filter (where ${snapshot.rawDiscardedAt} is null and ${snapshot.storageKey} is not null)::int`,
    })
    .from(snapshot);

  return (
    row ?? {
      snapshots: 0,
      firstFetchedAt: null,
      lastFetchedAt: null,
      countMismatches: 0,
      rawRetained: 0,
    }
  );
}
